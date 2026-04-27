/**
 * Recovery tests for AgentSessionManager._doSendAndStream — specifically the
 * "retry-doubles-output" guard (lettabot-y4j).
 *
 * Background: when the SDK returns `{ type: 'result', success: false }`,
 * _doSendAndStream may auto-recover by closing the session, opening a fresh
 * conversation, and retrying the message. That recovery is ONLY safe if no
 * user-visible content (assistant / tool_call / tool_result / reasoning)
 * was already yielded — otherwise the caller (WS gateway) has already
 * forwarded that content to the client, and the retry produces a SECOND
 * complete answer, which renders as a doubled bubble.
 *
 * These tests pin the contract:
 *   1. NO retry when content was already delivered
 *   2. YES retry when nothing was delivered
 *   3. tool_call also counts as delivered content
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
import {
  ensureNoToolApprovals,
  recoverOrphanedConversationApproval,
  cancelRuns,
  getLatestRunError,
} from '../tools/letta-api.js';
import { AgentSessionManager } from './agent-session-manager.js';

interface MockSession {
  initialize: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  recoverPendingApprovals: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  agentId: string;
  conversationId: string;
}

function makeMockSession(events: SDKMessage[], conversationId: string): MockSession {
  return {
    initialize: vi.fn(async () => ({
      type: 'init' as const,
      agentId: 'agent-test',
      sessionId: 'sess-test',
      conversationId,
      model: 'test-model',
      tools: [],
    })),
    send: vi.fn(async (_message: unknown) => undefined),
    stream: vi.fn(() => (async function* () {
      for (const ev of events) yield ev;
    })()),
    close: vi.fn(() => undefined),
    recoverPendingApprovals: vi.fn(async () => ({
      recovered: false,
      unsupported: true,
      detail: 'mock',
    })),
    abort: vi.fn(async () => undefined),
    agentId: 'agent-test',
    conversationId,
  };
}

async function collectStream(gen: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
  const out: SDKMessage[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('AgentSessionManager — retry-doubles-output guard (lettabot-y4j)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let mgr: AgentSessionManager;
  const connId = 'conn-test';
  const agentId = 'agent-test';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lettabot-asm-recovery-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    vi.resetAllMocks();
    // Restore default no-op behaviour for letta-api mocks reset above.
    vi.mocked(ensureNoToolApprovals).mockResolvedValue(undefined);
    vi.mocked(recoverOrphanedConversationApproval).mockResolvedValue(undefined as never);
    vi.mocked(cancelRuns).mockResolvedValue(undefined as never);
    vi.mocked(getLatestRunError).mockResolvedValue(null);
    mgr = new AgentSessionManager({
      conversationStorePath: join(dataDir, 'gateway-conversations.json'),
    });
  });

  afterEach(async () => {
    await mgr.shutdown();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('does NOT retry on result.success=false when assistant content was already delivered', async () => {
    // First (failing) session yields assistant content, then a failed result.
    const failingSession = makeMockSession(
      [
        { type: 'assistant', content: 'partial answer ', uuid: 'a1' },
        { type: 'assistant', content: 'continuing...', uuid: 'a2' },
        {
          type: 'result',
          success: false,
          error: 'error',
          conversationId: 'conv-bad',
          durationMs: 100,
        },
      ],
      'conv-bad',
    );

    // Second session would be created on recovery — if recovery runs,
    // the test will see THIS session's content too (the bug).
    const recoverySession = makeMockSession(
      [
        { type: 'assistant', content: 'second full answer', uuid: 'b1' },
        {
          type: 'result',
          success: true,
          conversationId: 'conv-good',
          durationMs: 100,
        },
      ],
      'conv-good',
    );

    // No persisted conversation → first open() and any recovery open() both
    // call createSession (never resumeSession). Provide both in order.
    vi.mocked(createSession)
      .mockReturnValueOnce(failingSession as never)
      .mockReturnValueOnce(recoverySession as never);

    await mgr.open(connId, agentId);
    const events = await collectStream(mgr.sendAndStream(connId, 'hi'));

    // Content from the FIRST session must be present
    const assistantContents = events
      .filter((e): e is Extract<SDKMessage, { type: 'assistant' }> => e.type === 'assistant')
      .map((e) => e.content);
    expect(assistantContents).toEqual(['partial answer ', 'continuing...']);

    // Recovery session must NEVER be opened/streamed — that's the whole point.
    expect(recoverySession.send).not.toHaveBeenCalled();
    expect(recoverySession.stream).not.toHaveBeenCalled();

    // Final yielded result is the failed one, passed through
    const result = events.find((e) => e.type === 'result');
    expect(result).toBeDefined();
    expect((result as { success: boolean }).success).toBe(false);
  });

  it('DOES retry on result.success=false when nothing was delivered', async () => {
    // First session yields ONLY a failed result (no content).
    const failingSession = makeMockSession(
      [
        {
          type: 'result',
          success: false,
          error: 'error',
          conversationId: 'conv-bad',
          durationMs: 100,
        },
      ],
      'conv-bad',
    );

    // Second (recovery) session yields a successful response.
    const recoverySession = makeMockSession(
      [
        { type: 'assistant', content: 'recovered answer', uuid: 'r1' },
        {
          type: 'result',
          success: true,
          conversationId: 'conv-good',
          durationMs: 100,
        },
      ],
      'conv-good',
    );

    vi.mocked(createSession)
      .mockReturnValueOnce(failingSession as never)
      .mockReturnValueOnce(recoverySession as never);

    await mgr.open(connId, agentId);
    const events = await collectStream(mgr.sendAndStream(connId, 'hi'));

    // createSession called twice — first on open, second on recovery re-open.
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(2);
    // Recovery session WAS streamed
    expect(recoverySession.send).toHaveBeenCalledTimes(1);
    expect(recoverySession.stream).toHaveBeenCalledTimes(1);

    // Final result is the successful retry
    const assistantContents = events
      .filter((e): e is Extract<SDKMessage, { type: 'assistant' }> => e.type === 'assistant')
      .map((e) => e.content);
    expect(assistantContents).toEqual(['recovered answer']);

    const result = events.find((e) => e.type === 'result');
    expect(result).toBeDefined();
    expect((result as { success: boolean }).success).toBe(true);
  });

  it('does NOT retry when a tool_call was already delivered before the failed result', async () => {
    // tool_call counts as delivered content (channels render it as a snapshot).
    const failingSession = makeMockSession(
      [
        {
          type: 'tool_call',
          toolCallId: 't1',
          toolName: 'read_file',
          toolInput: { path: 'a.txt' },
          rawArguments: '{"path":"a.txt"}',
          uuid: 'tc1',
        },
        {
          type: 'result',
          success: false,
          error: 'error',
          conversationId: 'conv-bad',
          durationMs: 100,
        },
      ],
      'conv-bad',
    );

    const recoverySession = makeMockSession(
      [
        { type: 'assistant', content: 'should not be seen', uuid: 'b1' },
        {
          type: 'result',
          success: true,
          conversationId: 'conv-good',
          durationMs: 100,
        },
      ],
      'conv-good',
    );

    vi.mocked(createSession)
      .mockReturnValueOnce(failingSession as never)
      .mockReturnValueOnce(recoverySession as never);

    await mgr.open(connId, agentId);
    const events = await collectStream(mgr.sendAndStream(connId, 'hi'));

    // Recovery must not run after a tool_call was delivered
    expect(recoverySession.send).not.toHaveBeenCalled();
    expect(recoverySession.stream).not.toHaveBeenCalled();

    // The tool_call IS in the output, the recovery assistant is NOT
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    const assistants = events.filter((e) => e.type === 'assistant');
    expect(assistants).toHaveLength(0);

    const result = events.find((e) => e.type === 'result');
    expect((result as { success: boolean }).success).toBe(false);
  });
});
