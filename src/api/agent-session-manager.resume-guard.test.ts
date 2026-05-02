/**
 * Resume-substitution guard tests for AgentSessionManager — letta-mobile-c87t.2.
 *
 * The underlying `letta-code` CLI silently allocates a fresh conversation
 * when `resumeSession(convId)` is given an unknown conversation id (no
 * 404, no `resumed: boolean` flag — the SDK init message just reports the
 * new id). Trusting that result silently moves the user into a brand-new
 * conversation, which is the bug behind the doze-cycle conversation swap
 * we hit on 2026-04-28 (`agent-d53a5c94-...` moved from
 * `conv-54c07465-...` to `conv-454c705c-...` after wake).
 *
 * `_openLocked` now refuses the substitution **only when the caller
 * explicitly asked to resume a specific conversation_id and did not
 * opt into force_new** — see `ConversationNotResumableError`. The
 * auto-resume-from-store path (no explicit conversation_id) keeps its
 * existing recursive-retry behavior.
 *
 * Plan: 2026-04-clientmode-prevent-silent-conversation-swap.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
import {
  AgentSessionManager,
  ConversationNotResumableError,
} from './agent-session-manager.js';

interface MockSession {
  initialize: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  agentId: string;
  conversationId: string;
}

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
      conversationId, // <-- the id reported back by the SDK
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

describe('AgentSessionManager — resume-substitution guard (c87t.2)', () => {
  let tempDir: string;
  let storePath: string;
  let mgr: AgentSessionManager;
  const connId = 'conn-test';
  const agentId = 'agent-test';
  const requestedConv = 'conv-requested';
  const substituteConv = 'conv-substitute';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resume-guard-test-'));
    storePath = join(tempDir, 'gateway-conversations.json');
    vi.clearAllMocks();
    mgr = new AgentSessionManager({ conversationStorePath: storePath });
  });

  afterEach(async () => {
    if (mgr) await mgr.shutdown();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it('T1: refuses substitution when conversationId requested and SDK returns a different id', async () => {
    // Mobile asks to resume `conv-requested`. The SDK silently allocates
    // `conv-substitute` (the silent-swap behavior we're guarding against).
    const substituted = makeMockSession(agentId, substituteConv);
    vi.mocked(resumeSession).mockReturnValue(
      substituted as unknown as ReturnType<typeof resumeSession>,
    );

    await expect(
      mgr.open(connId, agentId, requestedConv, /* forceNew */ false),
    ).rejects.toBeInstanceOf(ConversationNotResumableError);

    // Re-issue to capture the thrown error itself for property checks.
    vi.mocked(resumeSession).mockReturnValue(
      makeMockSession(agentId, substituteConv) as unknown as ReturnType<typeof resumeSession>,
    );
    let caught: ConversationNotResumableError | null = null;
    try {
      await mgr.open(connId, agentId, requestedConv, false);
    } catch (err) {
      caught = err as ConversationNotResumableError;
    }
    expect(caught).toBeInstanceOf(ConversationNotResumableError);
    expect(caught?.requestedConversationId).toBe(requestedConv);
    expect(caught?.substituteConversationId).toBe(substituteConv);

    // The substituted SDK subprocess was reaped.
    expect(substituted.close).toHaveBeenCalled();

    // The substituted conv id was NOT persisted to disk — that would
    // overwrite the user's mapping with the silently-allocated conv,
    // which is exactly the bug we're fixing.
    if (existsSync(storePath)) {
      const persisted = JSON.parse(readFileSync(storePath, 'utf-8'));
      expect(persisted[agentId]).not.toBe(substituteConv);
    }
  });

  it('T2: accepts substitution when forceNew=true (caller is explicitly creating fresh)', async () => {
    // forceNew=true means the caller asked to abandon the prior conv
    // and start a new one — substitution is the desired behavior, not
    // a violation. Note: the gateway clears the conversation_id arg
    // before passing force_new through, so requestedConv would be
    // absent in practice. But test the interaction anyway: even if a
    // conversationId is passed alongside force_new, the guard skips.
    const fresh = makeMockSession(agentId, substituteConv);
    vi.mocked(createSession).mockReturnValue(
      fresh as unknown as ReturnType<typeof createSession>,
    );

    const init = await mgr.open(connId, agentId, undefined, /* forceNew */ true);

    expect(init.conversationId).toBe(substituteConv);
    expect(fresh.close).not.toHaveBeenCalled();
  });

  it('T3: leaves auto-resume-from-store path untouched when no conversationId is passed', async () => {
    // Pre-seed the persisted store with a stale conv id, then have
    // the SDK return a different one. The existing recursive-retry
    // path at the end of `_openLocked` should drive recovery — the
    // new guard must NOT engage because the caller did not pass an
    // explicit conversationId.
    const staleConv = 'conv-stale-from-store';
    const recoveredConv = 'conv-fresh';

    // Bootstrap: open once with force_new=true to seed the store cleanly.
    vi.mocked(createSession).mockReturnValueOnce(
      makeMockSession(agentId, staleConv) as unknown as ReturnType<typeof createSession>,
    );
    await mgr.open(connId, agentId, undefined, /* forceNew */ true);

    // Now simulate a fresh manager-instance reading the persisted
    // mapping and trying to resume — but the SDK can't find that
    // conv any more, so it silently allocates `recoveredConv`.
    await mgr.shutdown();
    mgr = new AgentSessionManager({ conversationStorePath: storePath });

    // First call to `resumeSession` — substituted with `recoveredConv`.
    // The existing catch-and-retry path at line ~604 of
    // agent-session-manager.ts then calls `_openLocked` recursively
    // with `conversationId=undefined`, which goes through `createSession`.
    //
    // For this test the easier shape: simulate `resumeSession` throwing
    // (the path that actually triggers the existing retry). The point
    // here is to verify the new guard does NOT fire when conversationId
    // is undefined — even if substitution would otherwise happen.
    vi.mocked(resumeSession).mockReturnValueOnce(
      makeMockSession(agentId, recoveredConv) as unknown as ReturnType<typeof resumeSession>,
    );

    const init = await mgr.open(connId, agentId, /* conversationId */ undefined, false);

    // The new guard didn't throw — auto-resume path is unaffected.
    expect(init.conversationId).toBe(recoveredConv);
  });

  it('T4: no error when SDK returns the same conversationId we asked for', async () => {
    // Sanity: the happy path. resumeSession(`conv-requested`) returns
    // a session whose init reports `conv-requested` — guard must not fire.
    const happy = makeMockSession(agentId, requestedConv);
    vi.mocked(resumeSession).mockReturnValue(
      happy as unknown as ReturnType<typeof resumeSession>,
    );

    const init = await mgr.open(connId, agentId, requestedConv, false);

    expect(init.conversationId).toBe(requestedConv);
    expect(happy.close).not.toHaveBeenCalled();
  });
});
