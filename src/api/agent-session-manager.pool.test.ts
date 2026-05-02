/**
 * Per-(connectionId, agentId) session pool tests for AgentSessionManager
 * (letta-mobile-w2hx.3).
 *
 * Pins the new pool semantics:
 *   1. Reuse: re-opening the SAME agentId on the SAME connection reuses
 *      the warm SDK Session (no second `createSession`/`initialize` call).
 *   2. Multiplex: a single connection can hold sessions for multiple agents
 *      simultaneously; each `open` flips the active pointer.
 *   3. LRU: when the pool exceeds `maxAgentsPerConnection`, the LRU non-busy
 *      entry is evicted (its subprocess is closed) before a new one is added.
 *   4. Per-agent isolation: opening a different agent does NOT close the
 *      previous one — its subprocess stays warm in the pool.
 *   5. forceNew bypasses the cache and creates a fresh subprocess.
 *   6. close(connectionId) reaps EVERY agent's subprocess in the pool.
 *   7. Idle sweep evicts old non-busy entries from any pool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@letta-ai/letta-code-sdk', () => ({
  createAgent: vi.fn(),
  createSession: vi.fn(),
  resumeSession: vi.fn(),
}));

vi.mock('../tools/letta-api.js', () => ({
  ensureNoToolApprovals: vi.fn().mockResolvedValue(undefined),
  recoverOrphanedConversationApproval: vi.fn().mockResolvedValue(undefined),
  cancelRuns: vi.fn().mockResolvedValue(undefined),
  getLatestRunError: vi.fn().mockResolvedValue(null),
}));

import { createSession, resumeSession } from '@letta-ai/letta-code-sdk';
import type { SDKMessage } from '@letta-ai/letta-code-sdk';
import { AgentSessionManager } from './agent-session-manager.js';

interface MockSession {
  initialize: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  agentId: string;
  conversationId: string;
}

/**
 * Make a stub Session whose `initialize` resolves synchronously and whose
 * `stream` yields a single `result` event. The stub records every method
 * call so tests can assert reuse vs. fresh-spawn.
 */
function makeMockSession(agentId: string, conversationId: string): MockSession {
  const events: SDKMessage[] = [
    {
      type: 'result',
      success: true,
      conversationId,
      durationMs: 1,
    } as unknown as SDKMessage,
  ];
  return {
    initialize: vi.fn(async () => ({
      type: 'init' as const,
      agentId,
      sessionId: `sess-${agentId}`,
      conversationId,
      model: 'test-model',
      tools: [],
    })),
    send: vi.fn(async () => undefined),
    stream: vi.fn(() => (async function* () {
      for (const ev of events) yield ev;
    })()),
    close: vi.fn(() => undefined),
    abort: vi.fn(async () => undefined),
    agentId,
    conversationId,
  };
}

describe('AgentSessionManager — per-agent pool (w2hx.3)', () => {
  let tempDir: string;
  let storePath: string;
  let mgr: AgentSessionManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pool-test-'));
    storePath = join(tempDir, 'gateway-conversations.json');
    vi.clearAllMocks();

    // Default: createSession returns a unique stub per call so tests can
    // distinguish "fresh spawn" from "reused from cache". Each test that
    // needs deterministic identity overrides this in-test.
    let counter = 0;
    vi.mocked(createSession).mockImplementation(((agentId?: string) => {
      if (!agentId) throw new Error('test bug: createSession called without agentId');
      counter += 1;
      const id = agentId ?? 'agent-default';
      return makeMockSession(id, `conv-${id}-${counter}`) as unknown as ReturnType<typeof createSession>;
    }) as typeof createSession);
    vi.mocked(resumeSession).mockImplementation(((conversationId: string, opts?: unknown) => {
      // resumeSession needs to know which agent — derive from the most
      // recent createSession agentId, or default. Tests that exercise
      // resume override this directly.
      void opts;
      return makeMockSession('agent-test', conversationId) as unknown as ReturnType<typeof resumeSession>;
    }) as typeof resumeSession);
  });

  afterEach(async () => {
    if (mgr) await mgr.shutdown();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it('reuses a warm session when the same agentId is re-opened on the same connection', async () => {
    mgr = new AgentSessionManager({
      conversationStorePath: storePath,
      sweepIntervalMs: 60_000,
    });

    const init1 = await mgr.open('conn-1', 'agent-A');
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(init1.conversationId).toMatch(/^conv-agent-A-/);

    // Re-opening the same agent on the same connection MUST NOT spawn a
    // second SDK subprocess — that's the whole point of the pool.
    const init2 = await mgr.open('conn-1', 'agent-A');
    expect(createSession).toHaveBeenCalledTimes(1);
    // Same init message echoed back so the gateway can re-emit `session_init`.
    expect(init2.conversationId).toBe(init1.conversationId);
    expect(init2.sessionId).toBe(init1.sessionId);

    expect(mgr.poolSize('conn-1')).toBe(1);
    expect(mgr.size).toBe(1);
  });

  it('multiplexes multiple agents on a single connection without tearing down the previous one', async () => {
    mgr = new AgentSessionManager({
      conversationStorePath: storePath,
      maxAgentsPerConnection: 4,
      sweepIntervalMs: 60_000,
    });

    const sessionsByAgent = new Map<string, MockSession>();
    vi.mocked(createSession).mockImplementation(((agentId?: string) => {
      if (!agentId) throw new Error('test bug: createSession called without agentId');
      const s = makeMockSession(agentId, `conv-${agentId}`);
      sessionsByAgent.set(agentId, s);
      return s as unknown as ReturnType<typeof createSession>;
    }) as typeof createSession);

    await mgr.open('conn-1', 'agent-A');
    await mgr.open('conn-1', 'agent-B');
    await mgr.open('conn-1', 'agent-C');

    // Two distinct subprocesses still alive; previous one was NOT closed
    // when we switched agents (this is the bug fix vs. the legacy
    // 1-session-per-conn model where every session_start tore down the
    // previous SDK subprocess).
    expect(sessionsByAgent.get('agent-A')!.close).not.toHaveBeenCalled();
    expect(sessionsByAgent.get('agent-B')!.close).not.toHaveBeenCalled();
    expect(sessionsByAgent.get('agent-C')!.close).not.toHaveBeenCalled();

    expect(mgr.poolSize('conn-1')).toBe(3);
    // Active is the most recently opened.
    expect(mgr.getInfo('conn-1')?.agentId).toBe('agent-C');
  });

  it('flips the active pointer back to a cached agent on re-select (warm switch)', async () => {
    mgr = new AgentSessionManager({
      conversationStorePath: storePath,
      sweepIntervalMs: 60_000,
    });

    await mgr.open('conn-1', 'agent-A');
    await mgr.open('conn-1', 'agent-B');
    expect(mgr.getInfo('conn-1')?.agentId).toBe('agent-B');

    // Re-select A: subprocess for A is reused, subprocess for B stays warm.
    await mgr.open('conn-1', 'agent-A');
    expect(mgr.getInfo('conn-1')?.agentId).toBe('agent-A');
    expect(mgr.poolSize('conn-1')).toBe(2);
    // Only two createSession calls total (one per unique agent).
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('evicts the LRU non-busy entry when the per-connection cap is exceeded', async () => {
    mgr = new AgentSessionManager({
      conversationStorePath: storePath,
      maxAgentsPerConnection: 2,
      sweepIntervalMs: 60_000,
    });

    const sessionsByAgent = new Map<string, MockSession>();
    vi.mocked(createSession).mockImplementation(((agentId?: string) => {
      if (!agentId) throw new Error('test bug: createSession called without agentId');
      const s = makeMockSession(agentId, `conv-${agentId}`);
      sessionsByAgent.set(agentId, s);
      return s as unknown as ReturnType<typeof createSession>;
    }) as typeof createSession);

    await mgr.open('conn-1', 'agent-A');
    await mgr.open('conn-1', 'agent-B');
    expect(mgr.poolSize('conn-1')).toBe(2);

    // agent-C overflow → A (LRU) gets evicted.
    await mgr.open('conn-1', 'agent-C');
    expect(mgr.poolSize('conn-1')).toBe(2);
    expect(sessionsByAgent.get('agent-A')!.close).toHaveBeenCalledTimes(1);
    expect(sessionsByAgent.get('agent-B')!.close).not.toHaveBeenCalled();
    expect(sessionsByAgent.get('agent-C')!.close).not.toHaveBeenCalled();

    // Re-opening A must spawn a brand-new SDK subprocess (the cached
    // one was evicted and reaped). The conversation store remembers
    // A's last conv, so this goes through `resumeSession`, not
    // `createSession` — what we care about is that *some* fresh
    // subprocess was created, not which factory function produced it.
    await mgr.open('conn-1', 'agent-A');
    const totalSpawns =
      vi.mocked(createSession).mock.calls.length +
      vi.mocked(resumeSession).mock.calls.length;
    expect(totalSpawns).toBe(4); // A, B, C, A-resumed
  });

  it('LRU recency follows reuse — re-opened agent moves to MRU, not the original insertion order', async () => {
    mgr = new AgentSessionManager({
      conversationStorePath: storePath,
      maxAgentsPerConnection: 2,
      sweepIntervalMs: 60_000,
    });

    const sessionsByAgent = new Map<string, MockSession>();
    vi.mocked(createSession).mockImplementation(((agentId?: string) => {
      if (!agentId) throw new Error('test bug: createSession called without agentId');
      const s = makeMockSession(agentId, `conv-${agentId}`);
      sessionsByAgent.set(agentId, s);
      return s as unknown as ReturnType<typeof createSession>;
    }) as typeof createSession);

    await mgr.open('conn-1', 'agent-A');
    await mgr.open('conn-1', 'agent-B');
    // Touch A — should make A the MRU, leaving B as LRU.
    await mgr.open('conn-1', 'agent-A');

    // Adding C now should evict B, NOT A (A was just touched).
    await mgr.open('conn-1', 'agent-C');
    expect(sessionsByAgent.get('agent-B')!.close).toHaveBeenCalledTimes(1);
    expect(sessionsByAgent.get('agent-A')!.close).not.toHaveBeenCalled();
    expect(sessionsByAgent.get('agent-C')!.close).not.toHaveBeenCalled();
  });

  it('forceNew=true closes the cached session and spawns a fresh subprocess', async () => {
    mgr = new AgentSessionManager({
      conversationStorePath: storePath,
      sweepIntervalMs: 60_000,
    });

    const sessions: MockSession[] = [];
    vi.mocked(createSession).mockImplementation(((agentId?: string) => {
      if (!agentId) throw new Error('test bug: createSession called without agentId');
      const s = makeMockSession(agentId, `conv-${sessions.length}`);
      sessions.push(s);
      return s as unknown as ReturnType<typeof createSession>;
    }) as typeof createSession);

    await mgr.open('conn-1', 'agent-A');
    expect(sessions).toHaveLength(1);

    await mgr.open('conn-1', 'agent-A', undefined, true /* forceNew */);
    expect(sessions).toHaveLength(2);
    // First subprocess was closed.
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    // Pool still has exactly one entry for agent-A (the new one).
    expect(mgr.poolSize('conn-1')).toBe(1);
  });

  it('close(connectionId) reaps every agent in the pool, not just the active one', async () => {
    mgr = new AgentSessionManager({
      conversationStorePath: storePath,
      maxAgentsPerConnection: 4,
      sweepIntervalMs: 60_000,
    });

    const sessionsByAgent = new Map<string, MockSession>();
    vi.mocked(createSession).mockImplementation(((agentId?: string) => {
      if (!agentId) throw new Error('test bug: createSession called without agentId');
      const s = makeMockSession(agentId, `conv-${agentId}`);
      sessionsByAgent.set(agentId, s);
      return s as unknown as ReturnType<typeof createSession>;
    }) as typeof createSession);

    await mgr.open('conn-1', 'agent-A');
    await mgr.open('conn-1', 'agent-B');
    await mgr.open('conn-1', 'agent-C');
    expect(mgr.poolSize('conn-1')).toBe(3);

    await mgr.close('conn-1');
    expect(sessionsByAgent.get('agent-A')!.close).toHaveBeenCalledTimes(1);
    expect(sessionsByAgent.get('agent-B')!.close).toHaveBeenCalledTimes(1);
    expect(sessionsByAgent.get('agent-C')!.close).toHaveBeenCalledTimes(1);
    expect(mgr.poolSize('conn-1')).toBe(0);
    expect(mgr.has('conn-1')).toBe(false);
    expect(mgr.size).toBe(0);
  });

  it('isolates pools across connections — closing one connection does not touch the other', async () => {
    mgr = new AgentSessionManager({
      conversationStorePath: storePath,
      sweepIntervalMs: 60_000,
    });

    // Track every SDK Session ever spawned, regardless of factory.
    // After the first connection persists agent-A's conversation, the
    // second connection's open() will go through `resumeSession`, not
    // `createSession`.
    const allSpawned: MockSession[] = [];
    let callIdx = 0;
    vi.mocked(createSession).mockImplementation(((agentId?: string) => {
      if (!agentId) throw new Error('test bug: createSession called without agentId');
      callIdx += 1;
      const s = makeMockSession(agentId, `conv-${agentId}#${callIdx}`);
      allSpawned.push(s);
      return s as unknown as ReturnType<typeof createSession>;
    }) as typeof createSession);
    vi.mocked(resumeSession).mockImplementation((conversationId: string) => {
      callIdx += 1;
      const s = makeMockSession('agent-A', conversationId);
      allSpawned.push(s);
      return s as unknown as ReturnType<typeof resumeSession>;
    });

    await mgr.open('conn-1', 'agent-A');
    await mgr.open('conn-2', 'agent-A');
    expect(mgr.size).toBe(2);
    // Two distinct subprocesses spawned across the two connections.
    expect(allSpawned).toHaveLength(2);

    await mgr.close('conn-1');
    expect(mgr.poolSize('conn-1')).toBe(0);
    expect(mgr.poolSize('conn-2')).toBe(1);
    expect(mgr.has('conn-2')).toBe(true);

    // Exactly one subprocess closed (conn-1's). conn-2's stays warm.
    const closedCount = allSpawned.filter((s) => s.close.mock.calls.length > 0).length;
    expect(closedCount).toBe(1);
  });

  it('idle sweep evicts old non-busy entries from any pool', async () => {
    vi.useFakeTimers();
    try {
      mgr = new AgentSessionManager({
        conversationStorePath: storePath,
        idleTimeoutMs: 1000,
        sweepIntervalMs: 100,
      });

      const sessionsByAgent = new Map<string, MockSession>();
      vi.mocked(createSession).mockImplementation(((agentId?: string) => {
        if (!agentId) throw new Error('test bug: createSession called without agentId');
        const s = makeMockSession(agentId, `conv-${agentId}`);
        sessionsByAgent.set(agentId, s);
        return s as unknown as ReturnType<typeof createSession>;
      }) as typeof createSession);

      await mgr.open('conn-1', 'agent-A');
      await mgr.open('conn-1', 'agent-B');
      expect(mgr.poolSize('conn-1')).toBe(2);

      // Advance past idleTimeoutMs and tick the sweep timer.
      vi.advanceTimersByTime(2000);
      // Allow microtask queue to drain (sweep is sync but logs/flush may chain).
      await Promise.resolve();

      expect(sessionsByAgent.get('agent-A')!.close).toHaveBeenCalledTimes(1);
      expect(sessionsByAgent.get('agent-B')!.close).toHaveBeenCalledTimes(1);
      expect(mgr.poolSize('conn-1')).toBe(0);
      expect(mgr.has('conn-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getInfo / has reflect the active agent only', async () => {
    mgr = new AgentSessionManager({
      conversationStorePath: storePath,
      sweepIntervalMs: 60_000,
    });

    expect(mgr.has('conn-1')).toBe(false);
    expect(mgr.getInfo('conn-1')).toBeNull();

    await mgr.open('conn-1', 'agent-A');
    expect(mgr.has('conn-1')).toBe(true);
    expect(mgr.getInfo('conn-1')?.agentId).toBe('agent-A');

    await mgr.open('conn-1', 'agent-B');
    expect(mgr.getInfo('conn-1')?.agentId).toBe('agent-B');

    // Re-select A → active flips back without spawning anything new.
    await mgr.open('conn-1', 'agent-A');
    expect(mgr.getInfo('conn-1')?.agentId).toBe('agent-A');
  });

  it('does not reuse a cached session when caller requests a different conversationId', async () => {
    mgr = new AgentSessionManager({
      conversationStorePath: storePath,
      sweepIntervalMs: 60_000,
    });

    // First open — fresh conversation
    await mgr.open('conn-1', 'agent-A');
    expect(createSession).toHaveBeenCalledTimes(1);

    // Caller asks for a SPECIFIC different conversationId — must NOT
    // reuse the cached session bound to a different conv. This becomes
    // a `resumeSession` call.
    const resumed = makeMockSession('agent-A', 'conv-explicit');
    vi.mocked(resumeSession).mockReturnValueOnce(resumed as unknown as ReturnType<typeof resumeSession>);

    await mgr.open('conn-1', 'agent-A', 'conv-explicit');
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(resumeSession).toHaveBeenCalledWith('conv-explicit', expect.anything());
    expect(mgr.getInfo('conn-1')?.conversationId).toBe('conv-explicit');
    // The cached entry was discarded and the explicitly-resumed one
    // took its slot.
    expect(mgr.poolSize('conn-1')).toBe(1);
  });
});
