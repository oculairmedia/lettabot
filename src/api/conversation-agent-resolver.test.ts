/**
 * Tests for the ConversationAgentResolver.
 *
 * We inject a mock Letta SDK client to avoid network. The resolver maintains
 * an LRU+TTL cache, coalesces in-flight requests, and negative-caches 404s.
 *
 * Part of letta-mobile-w2hx.12.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConversationAgentResolver,
  getSharedResolver,
  _setSharedResolverForTest,
} from './conversation-agent-resolver.js';

interface MockClient {
  conversations: {
    retrieve: ReturnType<typeof vi.fn>;
  };
}

function makeClient(): MockClient {
  return {
    conversations: {
      retrieve: vi.fn(),
    },
  };
}

describe('ConversationAgentResolver', () => {
  let client: MockClient;
  let now: number;
  const tick = (ms: number) => {
    now += ms;
  };

  beforeEach(() => {
    client = makeClient();
    now = 1_000_000;
  });

  function makeResolver(overrides: { ttlMs?: number; negativeTtlMs?: number; maxEntries?: number } = {}) {
    return new ConversationAgentResolver({
      client: client as never,
      ttlMs: overrides.ttlMs ?? 60_000,
      negativeTtlMs: overrides.negativeTtlMs ?? 5_000,
      maxEntries: overrides.maxEntries ?? 3,
      now: () => now,
    });
  }

  it('resolves conv -> agent via the SDK on cold miss', async () => {
    client.conversations.retrieve.mockResolvedValueOnce({ id: 'conv-1', agent_id: 'agent-A' });
    const r = makeResolver();

    const got = await r.resolve('conv-1');

    expect(got).toBe('agent-A');
    expect(client.conversations.retrieve).toHaveBeenCalledTimes(1);
    expect(client.conversations.retrieve).toHaveBeenCalledWith('conv-1');
    expect(r.stats()).toMatchObject({ size: 1, hits: 0, misses: 1, negativeHits: 0 });
  });

  it('returns the cached agent_id without re-fetching on hot path', async () => {
    client.conversations.retrieve.mockResolvedValueOnce({ id: 'conv-1', agent_id: 'agent-A' });
    const r = makeResolver();

    await r.resolve('conv-1');
    const second = await r.resolve('conv-1');

    expect(second).toBe('agent-A');
    expect(client.conversations.retrieve).toHaveBeenCalledTimes(1);
    expect(r.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('refetches after TTL expiry', async () => {
    client.conversations.retrieve
      .mockResolvedValueOnce({ id: 'conv-1', agent_id: 'agent-A' })
      .mockResolvedValueOnce({ id: 'conv-1', agent_id: 'agent-A' });

    const r = makeResolver({ ttlMs: 1_000 });
    await r.resolve('conv-1');

    tick(1_500);

    await r.resolve('conv-1');
    expect(client.conversations.retrieve).toHaveBeenCalledTimes(2);
  });

  it('negative-caches 404 with a shorter TTL', async () => {
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    client.conversations.retrieve.mockRejectedValueOnce(notFound);

    const r = makeResolver({ negativeTtlMs: 1_000 });
    const first = await r.resolve('conv-missing');
    expect(first).toBeNull();

    // Hot-path negative hit
    const second = await r.resolve('conv-missing');
    expect(second).toBeNull();
    expect(client.conversations.retrieve).toHaveBeenCalledTimes(1);
    expect(r.stats().negativeHits).toBe(1);

    // After negative-TTL elapses we refetch
    client.conversations.retrieve.mockResolvedValueOnce({ id: 'conv-missing', agent_id: 'agent-X' });
    tick(2_000);
    const third = await r.resolve('conv-missing');
    expect(third).toBe('agent-X');
    expect(client.conversations.retrieve).toHaveBeenCalledTimes(2);
  });

  it('propagates non-404 transport errors and does not poison the cache', async () => {
    const transportErr = Object.assign(new Error('boom'), { status: 503 });
    client.conversations.retrieve.mockRejectedValueOnce(transportErr);

    const r = makeResolver();
    await expect(r.resolve('conv-flaky')).rejects.toThrow('boom');
    expect(r.stats().size).toBe(0);

    // Next call retries
    client.conversations.retrieve.mockResolvedValueOnce({ id: 'conv-flaky', agent_id: 'agent-Z' });
    const second = await r.resolve('conv-flaky');
    expect(second).toBe('agent-Z');
    expect(client.conversations.retrieve).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent in-flight lookups to one HTTP call', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    client.conversations.retrieve.mockReturnValueOnce(
      new Promise((res) => {
        resolveFn = res;
      }),
    );

    const r = makeResolver();
    const a = r.resolve('conv-1');
    const b = r.resolve('conv-1');
    const c = r.resolve('conv-1');

    expect(client.conversations.retrieve).toHaveBeenCalledTimes(1);
    resolveFn({ id: 'conv-1', agent_id: 'agent-A' });

    const [aR, bR, cR] = await Promise.all([a, b, c]);
    expect(aR).toBe('agent-A');
    expect(bR).toBe('agent-A');
    expect(cR).toBe('agent-A');
  });

  it('treats missing agent_id as null (defensive)', async () => {
    client.conversations.retrieve.mockResolvedValueOnce({ id: 'conv-1' });
    const r = makeResolver();
    const got = await r.resolve('conv-1');
    expect(got).toBeNull();
  });

  it('evicts LRU entries when over maxEntries', async () => {
    client.conversations.retrieve.mockImplementation((id: string) =>
      Promise.resolve({ id, agent_id: `agent-${id}` }),
    );
    const r = makeResolver({ maxEntries: 3 });

    await r.resolve('c1');
    await r.resolve('c2');
    await r.resolve('c3');
    expect(r.stats().size).toBe(3);

    // Touch c1 so c2 becomes the LRU
    await r.resolve('c1');

    // Insert c4 -> should evict c2
    await r.resolve('c4');
    expect(r.stats().size).toBe(3);
    expect(r.stats().evictions).toBe(1);

    // c2 is gone -> next resolve hits the SDK again
    client.conversations.retrieve.mockClear();
    await r.resolve('c2');
    expect(client.conversations.retrieve).toHaveBeenCalledWith('c2');
  });

  it('LRU touch on hit moves entry to most-recent', async () => {
    client.conversations.retrieve.mockImplementation((id: string) =>
      Promise.resolve({ id, agent_id: `agent-${id}` }),
    );
    const r = makeResolver({ maxEntries: 2 });

    await r.resolve('a'); // [a]
    await r.resolve('b'); // [a, b]
    await r.resolve('a'); // [b, a]
    await r.resolve('c'); // evicts b -> [a, c]

    expect(r.stats().size).toBe(2);
    expect(r.stats().evictions).toBe(1);

    // a is still cached
    client.conversations.retrieve.mockClear();
    await r.resolve('a');
    expect(client.conversations.retrieve).not.toHaveBeenCalled();
  });

  it('prime() pre-populates the cache so resolve() does not call the SDK', async () => {
    const r = makeResolver();
    r.prime('conv-1', 'agent-A');

    const got = await r.resolve('conv-1');
    expect(got).toBe('agent-A');
    expect(client.conversations.retrieve).not.toHaveBeenCalled();
    expect(r.stats()).toMatchObject({ size: 1, hits: 1, misses: 0 });
  });

  it('invalidate() drops a cached entry', async () => {
    client.conversations.retrieve.mockResolvedValue({ id: 'conv-1', agent_id: 'agent-A' });
    const r = makeResolver();

    await r.resolve('conv-1');
    r.invalidate('conv-1');

    await r.resolve('conv-1');
    expect(client.conversations.retrieve).toHaveBeenCalledTimes(2);
  });

  it('clear() resets cache and stats', async () => {
    client.conversations.retrieve.mockResolvedValue({ id: 'conv-1', agent_id: 'agent-A' });
    const r = makeResolver();

    await r.resolve('conv-1');
    await r.resolve('conv-1');
    expect(r.stats()).toMatchObject({ size: 1, hits: 1, misses: 1 });

    r.clear();
    expect(r.stats()).toMatchObject({ size: 0, hits: 0, misses: 0, negativeHits: 0, evictions: 0 });
  });

  it('rejects empty conversationId', async () => {
    const r = makeResolver();
    await expect(r.resolve('')).rejects.toThrow(/required/);
  });
});

describe('getSharedResolver', () => {
  beforeEach(() => {
    _setSharedResolverForTest(null);
  });

  it('returns a singleton across calls', () => {
    const a = getSharedResolver();
    const b = getSharedResolver();
    expect(a).toBe(b);
  });

  it('test helper resets the singleton', () => {
    const a = getSharedResolver();
    _setSharedResolverForTest(null);
    const b = getSharedResolver();
    expect(a).not.toBe(b);
  });
});
