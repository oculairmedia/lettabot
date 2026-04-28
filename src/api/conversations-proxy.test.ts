/**
 * Tests for the conversations REST proxy.
 *
 * These mock the Letta SDK at the module boundary so we don't hit the network
 * or require a running Letta server. We verify auth, routing, and shape of
 * the proxied responses.
 *
 * Part of letta-mobile-w2hx.11.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as http from 'http';

// Mock the Letta SDK before importing the proxy
const mockList = vi.fn();
const mockCreate = vi.fn();
const mockRetrieve = vi.fn();
const mockMessagesList = vi.fn();

vi.mock('@letta-ai/letta-client', () => {
  class Letta {
    conversations: {
      list: typeof mockList;
      create: typeof mockCreate;
      retrieve: typeof mockRetrieve;
      messages: { list: typeof mockMessagesList };
    };
    constructor() {
      this.conversations = {
        list: mockList,
        create: mockCreate,
        retrieve: mockRetrieve,
        messages: { list: mockMessagesList },
      };
    }
  }
  return { Letta };
});

const { tryHandleConversationsProxy } = await import('./conversations-proxy.js');

const TEST_API_KEY = 'test-key-12345';

interface CapturedRes {
  status?: number;
  headers?: Record<string, string | number | string[] | undefined>;
  body: string;
}

function makeRes(): { res: http.ServerResponse; captured: CapturedRes } {
  const captured: CapturedRes = { body: '' };
  const res = {
    writeHead: (status: number, headers?: Record<string, string | number | string[] | undefined>) => {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    end: (chunk?: string) => {
      if (chunk) captured.body = chunk;
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

function makeReq(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return {
    method,
    url,
    headers: { host: 'localhost', ...headers },
  } as unknown as http.IncomingMessage;
}

beforeEach(() => {
  mockList.mockReset();
  mockCreate.mockReset();
  mockRetrieve.mockReset();
  mockMessagesList.mockReset();
});

describe('conversations-proxy', () => {
  describe('routing match', () => {
    it('returns false for unrelated paths', async () => {
      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('GET', '/health'),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(handled).toBe(false);
      expect(captured.body).toBe('');
    });

    it('falls through (returns false) for GET /api/v1/conversations without agent_id', async () => {
      // Legacy ?agent=botName path falls through to server.ts handler.
      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations?agent=LettaBot', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(handled).toBe(false);
      expect(captured.body).toBe('');
    });
  });

  describe('auth', () => {
    it('rejects without api key', async () => {
      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations?agent_id=agent-x'),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(handled).toBe(true);
      expect(captured.status).toBe(401);
      expect(JSON.parse(captured.body).error).toBe('Unauthorized');
    });

    it('rejects wrong api key', async () => {
      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations?agent_id=agent-x', {
          'x-api-key': 'wrong-key',
        }),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(handled).toBe(true);
      expect(captured.status).toBe(401);
    });

    it('accepts Authorization: Bearer', async () => {
      mockList.mockResolvedValueOnce([]);
      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations?agent_id=agent-x', {
          authorization: `Bearer ${TEST_API_KEY}`,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(handled).toBe(true);
      expect(captured.status).toBe(200);
    });
  });

  describe('GET /api/v1/conversations?agent_id=X', () => {
    it('returns list of conversations', async () => {
      mockList.mockResolvedValueOnce([
        {
          id: 'conv-aaa',
          agent_id: 'agent-x',
          created_at: '2026-04-27T00:00:00Z',
          updated_at: '2026-04-27T01:00:00Z',
          last_message_at: '2026-04-27T01:00:00Z',
          summary: 'Test chat',
          in_context_message_ids: ['msg-1', 'msg-2'],
        },
        {
          id: 'conv-bbb',
          agent_id: 'agent-x',
          created_at: '2026-04-26T00:00:00Z',
          updated_at: '2026-04-26T01:00:00Z',
          last_message_at: null,
          summary: null,
          in_context_message_ids: [],
        },
      ]);

      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations?agent_id=agent-x', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );

      expect(handled).toBe(true);
      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body);
      expect(body.conversations).toHaveLength(2);
      expect(body.conversations[0].id).toBe('conv-aaa');
      expect(body.conversations[0].agent_id).toBe('agent-x');
      expect(body.conversations[0].summary).toBe('Test chat');
      expect(body.conversations[1].summary).toBeNull();
      expect(mockList).toHaveBeenCalledWith({
        agent_id: 'agent-x',
        limit: 50,
        order: 'desc',
        order_by: 'last_run_completion',
      });
    });

    it('respects limit + order params', async () => {
      mockList.mockResolvedValueOnce([]);
      const { res } = makeRes();
      await tryHandleConversationsProxy(
        makeReq(
          'GET',
          '/api/v1/conversations?agent_id=agent-x&limit=10&order=asc&order_by=created_at',
          { 'x-api-key': TEST_API_KEY },
        ),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(mockList).toHaveBeenCalledWith({
        agent_id: 'agent-x',
        limit: 10,
        order: 'asc',
        order_by: 'created_at',
      });
    });

    it('caps limit at 200', async () => {
      mockList.mockResolvedValueOnce([]);
      const { res } = makeRes();
      await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations?agent_id=agent-x&limit=10000', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    });

    it('rejects invalid order_by', async () => {
      mockList.mockResolvedValueOnce([]);
      const { res } = makeRes();
      await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations?agent_id=agent-x&order_by=hax', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ order_by: 'last_run_completion' }),
      );
    });
  });

  describe('POST /api/v1/conversations?agent_id=X', () => {
    it('creates a conversation and returns it', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'conv-new',
        agent_id: 'agent-x',
        created_at: '2026-04-27T05:00:00Z',
        updated_at: '2026-04-27T05:00:00Z',
        summary: null,
      });

      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('POST', '/api/v1/conversations?agent_id=agent-x', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );

      expect(handled).toBe(true);
      expect(captured.status).toBe(201);
      const body = JSON.parse(captured.body);
      expect(body.id).toBe('conv-new');
      expect(body.agent_id).toBe('agent-x');
      expect(mockCreate).toHaveBeenCalledWith({ agent_id: 'agent-x' });
    });
  });

  describe('GET /api/v1/conversations/:id', () => {
    it('retrieves a single conversation', async () => {
      mockRetrieve.mockResolvedValueOnce({
        id: 'conv-aaa',
        agent_id: 'agent-x',
        created_at: '2026-04-27T00:00:00Z',
        updated_at: '2026-04-27T01:00:00Z',
        last_message_at: '2026-04-27T01:00:00Z',
        summary: 'Test',
        in_context_message_ids: ['msg-1'],
      });

      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations/conv-aaa', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );

      expect(handled).toBe(true);
      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body);
      expect(body.id).toBe('conv-aaa');
      expect(body.agent_id).toBe('agent-x');
      expect(mockRetrieve).toHaveBeenCalledWith('conv-aaa');
    });

    it('rejects malformed conversation id', async () => {
      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations/not-a-conv-id', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(handled).toBe(true);
      expect(captured.status).toBe(400);
      expect(mockRetrieve).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/conversations/:id/messages', () => {
    it('lists messages with default params', async () => {
      mockMessagesList.mockResolvedValueOnce([
        { id: 'msg-1', role: 'user', content: 'hello' },
        { id: 'msg-2', role: 'assistant', content: 'hi there' },
      ]);

      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations/conv-aaa/messages', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );

      expect(handled).toBe(true);
      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body);
      expect(body.messages).toHaveLength(2);
      expect(mockMessagesList).toHaveBeenCalledWith('conv-aaa', { limit: 100, order: 'asc' });
    });

    it('passes through pagination cursors', async () => {
      mockMessagesList.mockResolvedValueOnce([]);
      const { res } = makeRes();
      await tryHandleConversationsProxy(
        makeReq(
          'GET',
          '/api/v1/conversations/conv-aaa/messages?limit=20&after=msg-5&before=msg-50&order=desc',
          { 'x-api-key': TEST_API_KEY },
        ),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(mockMessagesList).toHaveBeenCalledWith('conv-aaa', {
        limit: 20,
        order: 'desc',
        after: 'msg-5',
        before: 'msg-50',
      });
    });

    it('handles SDK returning {items: [...]} shape', async () => {
      mockMessagesList.mockResolvedValueOnce({ items: [{ id: 'msg-1' }] });
      const { res, captured } = makeRes();
      await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations/conv-aaa/messages', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );
      const body = JSON.parse(captured.body);
      expect(body.messages).toHaveLength(1);
    });

    it('handles SDK returning async iterable', async () => {
      const items = [{ id: 'msg-1' }, { id: 'msg-2' }];
      mockMessagesList.mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {
          for (const it of items) yield it;
        },
      });
      const { res, captured } = makeRes();
      await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations/conv-aaa/messages', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );
      const body = JSON.parse(captured.body);
      expect(body.messages).toHaveLength(2);
    });
  });

  describe('error handling', () => {
    it('propagates Letta API errors with status', async () => {
      const err = Object.assign(new Error('Conversation not found'), { status: 404 });
      mockRetrieve.mockRejectedValueOnce(err);

      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations/conv-missing', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );

      expect(handled).toBe(true);
      expect(captured.status).toBe(404);
      expect(JSON.parse(captured.body).error).toBe('Conversation not found');
    });

    it('falls back to 500 for errors without status', async () => {
      mockList.mockRejectedValueOnce(new Error('boom'));
      const { res, captured } = makeRes();
      await tryHandleConversationsProxy(
        makeReq('GET', '/api/v1/conversations?agent_id=agent-x', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(captured.status).toBe(500);
    });
  });

  describe('method handling', () => {
    it('rejects PUT/DELETE with 405', async () => {
      const { res, captured } = makeRes();
      const handled = await tryHandleConversationsProxy(
        makeReq('DELETE', '/api/v1/conversations?agent_id=agent-x', {
          'x-api-key': TEST_API_KEY,
        }),
        res,
        { apiKey: TEST_API_KEY },
      );
      expect(handled).toBe(true);
      expect(captured.status).toBe(405);
    });
  });
});
