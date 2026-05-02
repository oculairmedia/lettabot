import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer } from './server.js';
import type { AgentRouter } from '../core/interfaces.js';

const TEST_API_KEY = 'test-key-12345';
const TEST_PORT = 0; // Let OS assign a free port

function createMockRouter(overrides: Partial<AgentRouter> = {}): AgentRouter {
  return {
    deliverToChannel: vi.fn().mockResolvedValue('msg-1'),
    sendToAgent: vi.fn().mockResolvedValue('Agent says hello'),
    streamToAgent: vi.fn().mockReturnValue((async function* () {
      yield { type: 'reasoning', content: 'thinking...' };
      yield { type: 'assistant', content: 'Hello ' };
      yield { type: 'assistant', content: 'world' };
      yield { type: 'result', success: true };
    })()),
    getAgentNames: vi.fn().mockReturnValue(['LettaBot']),
    ...overrides,
  };
}

function getPort(server: http.Server): number {
  const addr = server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('Server not listening');
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('POST /api/v1/chat', () => {
  let server: http.Server;
  let port: number;
  let router: AgentRouter;

  beforeAll(async () => {
    router = createMockRouter();
    server = createApiServer(router, {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    // Wait for server to start listening
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 401 without api key', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"hi"}', {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong api key', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"hi"}', {
      'content-type': 'application/json',
      'x-api-key': 'wrong-key',
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 without Content-Type application/json', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', 'hello', {
      'content-type': 'text/plain',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('application/json');
  });

  it('returns 400 with invalid JSON', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', 'not json', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Invalid JSON');
  });

  it('returns 400 without message field', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"agent":"LettaBot"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('message');
  });

  it('returns 404 for unknown agent name', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"hi","agent":"unknown"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain('Agent not found');
    expect(JSON.parse(res.body).error).toContain('LettaBot');
  });

  it('returns sync JSON response by default', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Hello"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.success).toBe(true);
    expect(parsed.response).toBe('Agent says hello');
    expect(parsed.agentName).toBe('LettaBot');
    expect(router.sendToAgent).toHaveBeenCalledWith(
      undefined,
      'Hello',
      { type: 'webhook', outputMode: 'silent' },
    );
  });

  it('routes to named agent', async () => {
    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Hi","agent":"LettaBot"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    expect(router.sendToAgent).toHaveBeenCalledWith(
      'LettaBot',
      'Hi',
      { type: 'webhook', outputMode: 'silent' },
    );
  });

  it('returns SSE stream when Accept: text/event-stream', async () => {
    // Need a fresh mock since the generator is consumed once
    (router as any).streamToAgent = vi.fn().mockReturnValue((async function* () {
      yield { type: 'reasoning', content: 'thinking...' };
      yield { type: 'assistant', content: 'Hello ' };
      yield { type: 'assistant', content: 'world' };
      yield { type: 'result', success: true };
    })());

    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Stream test"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
      'accept': 'text/event-stream',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');

    // Parse SSE events
    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.replace('data: ', '')));

    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('reasoning');
    expect(events[1].type).toBe('assistant');
    expect(events[1].content).toBe('Hello ');
    expect(events[2].type).toBe('assistant');
    expect(events[2].content).toBe('world');
    expect(events[3].type).toBe('result');
    expect(events[3].success).toBe(true);
  });

  it('handles stream errors gracefully', async () => {
    (router as any).streamToAgent = vi.fn().mockReturnValue((async function* () {
      yield { type: 'assistant', content: 'partial' };
      throw new Error('connection lost');
    })());

    const res = await request(port, 'POST', '/api/v1/chat', '{"message":"Error test"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
      'accept': 'text/event-stream',
    });
    expect(res.status).toBe(200);

    const events = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.replace('data: ', '')));

    // Should have the partial chunk + error event
    expect(events.find((e: any) => e.type === 'assistant')).toBeTruthy();
    expect(events.find((e: any) => e.type === 'error')).toBeTruthy();
    expect(events.find((e: any) => e.type === 'error').error).toBe('connection lost');
  });
});

describe('POST /api/v1/chat/async', () => {
  let server: http.Server;
  let port: number;
  let router: AgentRouter;

  beforeAll(async () => {
    router = createMockRouter();
    server = createApiServer(router, {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reuses shared validation: content-type guard', async () => {
    const res = await request(port, 'POST', '/api/v1/chat/async', 'hello', {
      'content-type': 'text/plain',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('application/json');
  });

  it('reuses shared validation: missing message', async () => {
    const res = await request(port, 'POST', '/api/v1/chat/async', '{"agent":"LettaBot"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('message');
  });

  it('reuses shared validation: unknown agent', async () => {
    const res = await request(port, 'POST', '/api/v1/chat/async', '{"message":"hi","agent":"unknown"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain('Agent not found');
    expect(JSON.parse(res.body).error).toContain('LettaBot');
  });

  it('returns 202 and queues background delivery', async () => {
    (router as any).sendToAgent = vi.fn().mockResolvedValue('done');

    const res = await request(port, 'POST', '/api/v1/chat/async', '{"message":"queue me"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.status).toBe('queued');
    expect(body.agentName).toBe('LettaBot');
    expect((router as any).sendToAgent).toHaveBeenCalledWith(
      undefined,
      'queue me',
      { type: 'webhook', outputMode: 'silent' },
    );

  });
});

describe('POST /api/v1/heartbeat', () => {
  let server: http.Server;
  let port: number;
  let triggerFn: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    triggerFn = vi.fn().mockResolvedValue(undefined);
    const triggers = new Map<string, () => Promise<void>>();
    triggers.set('LettaBot', triggerFn as unknown as () => Promise<void>);
    server = createApiServer(createMockRouter(), {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
      heartbeatTriggers: triggers,
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 401 without api key', async () => {
    const res = await request(port, 'POST', '/api/v1/heartbeat', '', {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(401);
  });

  it('triggers heartbeat for default agent with empty body', async () => {
    const res = await request(port, 'POST', '/api/v1/heartbeat', '', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.agent).toBe('LettaBot');
    expect(triggerFn).toHaveBeenCalled();
  });

  it('triggers heartbeat for named agent', async () => {
    triggerFn.mockClear();
    const res = await request(port, 'POST', '/api/v1/heartbeat', '{"agent":"LettaBot"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.agent).toBe('LettaBot');
    expect(triggerFn).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(port, 'POST', '/api/v1/heartbeat', '{"agent":"UnknownBot"}', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain('Agent not found');
    expect(JSON.parse(res.body).error).toContain('LettaBot');
  });
});

describe('POST /api/v1/heartbeat (no triggers configured)', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createApiServer(createMockRouter(), {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 404 when no heartbeat services are configured', async () => {
    const res = await request(port, 'POST', '/api/v1/heartbeat', '', {
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain('No heartbeat services configured');
  });
});

describe('GET /api/v1/status', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createApiServer(createMockRouter(), {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
      stores: new Map([
        ['LettaBot', {
          getInfo: () => ({
            agentId: 'agent-1',
            conversationId: 'conv-store',
            conversations: {},
            baseUrl: 'http://localhost:8283',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: '2026-01-01T00:00:00.000Z',
          }),
        } as any],
      ]),
      gatewayAgentDetails: () => [{
        id: 'agent-1',
        name: 'agent-1',
        status: 'tracked',
        conversation_id: 'conv-gateway',
        default_working_directory: '/tmp/lettabot',
      }],
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('merges gateway location metadata into store-backed agent details', async () => {
    const res = await request(port, 'GET', '/api/v1/status');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.agent_details).toHaveLength(1);
    expect(body.agent_details[0]).toMatchObject({
      id: 'agent-1',
      name: 'LettaBot',
      default_working_directory: '/tmp/lettabot',
      conversation_id: 'conv-gateway',
    });
  });
});

describe('GET /api/v1/filesystem/browse', () => {
  let server: http.Server;
  let port: number;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lettabot-fs-browse-'));
    await mkdir(join(tempDir, 'alpha'));
    await mkdir(join(tempDir, 'Beta'));
    await writeFile(join(tempDir, 'note.txt'), 'not a directory');
    await symlink(join(tempDir, 'alpha'), join(tempDir, 'alpha-link'));

    server = createApiServer(createMockRouter(), {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  it('requires the API key', async () => {
    const res = await request(port, 'GET', `/api/v1/filesystem/browse?path=${encodeURIComponent(tempDir)}`);
    expect(res.status).toBe(401);
  });

  it('lists server-side child directories and omits files', async () => {
    const res = await request(port, 'GET', `/api/v1/filesystem/browse?path=${encodeURIComponent(tempDir)}`, undefined, {
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.path).toBe(tempDir);
    expect(body.parent).toBeTruthy();
    expect(body.entries.map((entry: { name: string }) => entry.name)).toEqual(['alpha', 'alpha-link', 'Beta']);
    expect(body.entries.find((entry: { name: string }) => entry.name === 'note.txt')).toBeUndefined();
    expect(body.entries.find((entry: { name: string; isSymlink: boolean }) => entry.name === 'alpha-link')?.isSymlink).toBe(true);
  });

  it('rejects non-directory paths', async () => {
    const filePath = join(tempDir, 'note.txt');
    const res = await request(port, 'GET', `/api/v1/filesystem/browse?path=${encodeURIComponent(filePath)}`, undefined, {
      'x-api-key': TEST_API_KEY,
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /portal', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createApiServer(createMockRouter(), {
      port: TEST_PORT,
      apiKey: TEST_API_KEY,
      host: '127.0.0.1',
    });
    await new Promise<void>((resolve) => {
      if (server.listening) { resolve(); return; }
      server.once('listening', resolve);
    });
    port = getPort(server);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the pairing portal HTML without requiring an API key', async () => {
    const res = await request(port, 'GET', '/portal');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>LettaBot Portal</title>');
  });
});
