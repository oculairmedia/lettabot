/**
 * End-to-end harness for the WS gateway: drive a scripted SDK delta
 * sequence through the real WsGateway with a real ws client and a
 * real http.Server, and assert the byte-level frame sequence the
 * client receives matches a golden fixture.
 *
 * This is the missing layer between the unit-level
 * partial-json-snapshot-emitter and bot-stream-coalescer tests and
 * the manual mobile verification on the Pixel 2XL — a regression in
 * the gateway's wire-up (wrong dedup key, terminal-frame ordering,
 * coalescer interaction) would slip past CI without it.
 *
 * Spec: lettabot-uww.7. Also serves as the deterministic repro
 * fixture for lettabot-ded ("fake WS stream → 1 bubble per id") and
 * lettabot-sad ("tool_call snapshot duplication" — AC #2).
 *
 * The fakeAgentSessionManager replaces the live SDK so no Letta
 * server is required and presend fetches never fire. Goldens run
 * with COALESCE=off + PARTIAL_JSON=on so each snapshot emerges 1:1
 * to the wire (deterministic ordering); the COALESCE=on path is
 * covered in lettabot-uww.8.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import type {
  SDKInitMessage,
  SDKMessage,
  SDKToolCallMessage,
  SDKResultMessage,
  SendMessage,
} from '@letta-ai/letta-code-sdk';

import { WsGateway } from './ws-gateway.js';
import type { AgentSessionManager } from './agent-session-manager.js';

// --- fake session manager ---------------------------------------------------

/**
 * Minimal stand-in for AgentSessionManager that yields a scripted
 * sequence of SDK events from sendAndStream() and never touches the
 * Letta SDK or the network. Cast to AgentSessionManager via the
 * gateway's `sessionManager` constructor option.
 */
/** Sentinel that asks the fake to throw mid-stream, simulating an SDK error. */
type ThrowSentinel = { __throw: string };
/** Sentinel that asks the fake to await a test-controlled gate before continuing. */
type PauseSentinel = { __pause: Promise<void> };
type ScriptStep = SDKMessage | ThrowSentinel | PauseSentinel;

function isThrowSentinel(step: ScriptStep): step is ThrowSentinel {
  return typeof step === 'object' && step !== null && '__throw' in step;
}

function isPauseSentinel(step: ScriptStep): step is PauseSentinel {
  return typeof step === 'object' && step !== null && '__pause' in step;
}

class FakeAgentSessionManager {
  private scripts = new Map<string, ScriptStep[]>();
  private opened = new Map<
    string,
    {
      agentId: string;
      conversationId: string | null;
      /** Mirrors the real manager's busy/ready transition so getInfo tests pass. */
      state: 'ready' | 'busy' | 'error' | 'closed' | 'initializing';
    }
  >();
  /**
   * Connection IDs flagged as aborted/closed. The generator checks this
   * between yields and returns early so abort/disconnect from the test
   * driver actually halts the stream (mirroring the real SDK's
   * session.abort() throwing into the iterator).
   */
  private aborted = new Set<string>();

  /** Queue the SDK event sequence the next sendAndStream() call will yield. */
  queueScript(connectionId: string, events: ScriptStep[]): void {
    this.scripts.set(connectionId, events);
  }

  async open(
    connectionId: string,
    agentId: string,
    conversationId?: string,
  ): Promise<SDKInitMessage> {
    const convId = conversationId ?? `conv-${connectionId.slice(0, 8)}`;
    this.opened.set(connectionId, { agentId, conversationId: convId, state: 'ready' });
    this.aborted.delete(connectionId);
    return {
      type: 'init',
      agentId,
      sessionId: `sess-${connectionId.slice(0, 8)}`,
      conversationId: convId,
      model: 'fake-model',
      tools: [],
    };
  }

  async *sendAndStream(
    connectionId: string,
    _message: SendMessage,
  ): AsyncGenerator<SDKMessage> {
    // Mark busy on entry so getInfo() reflects the in-flight state and
    // the gateway's busy-reject logic (lettabot-wsh.2) is exercisable.
    const info = this.opened.get(connectionId);
    if (info) info.state = 'busy';
    try {
      const script = this.scripts.get(connectionId) ?? [];
      for (const step of script) {
        if (this.aborted.has(connectionId)) return;
        if (isThrowSentinel(step)) {
          throw new Error(step.__throw);
        }
        if (isPauseSentinel(step)) {
          // Hold the stream open until the test resolves the gate. Lets
          // the test interleave control frames (session_start, abort)
          // while sendAndStream is provably mid-flight.
          await step.__pause;
          continue;
        }
        // Synthetic conversation_swap: mirror the real manager's behavior
        // of updating the session's conversationId so subsequent
        // getInfo() lookups (used by the gateway to enrich outbound
        // frames with conversation_id) see the new id. (lettabot-flk.5)
        const stepType = (step as unknown as { type?: string }).type;
        if (stepType === 'conversation_swap') {
          const swap = step as unknown as { newConversationId: string };
          const cur = this.opened.get(connectionId);
          if (cur) cur.conversationId = swap.newConversationId;
        }
        yield step;
        // Yield to the event loop between events so the test driver can
        // interleave control frames (abort, close) before the next yield.
        // Cost is sub-ms per event; existing tests with 4-5 events stay
        // well under their <5s budget.
        await new Promise<void>((r) => setImmediate(r));
      }
    } finally {
      const info2 = this.opened.get(connectionId);
      if (info2) info2.state = 'ready';
    }
  }

  has(connectionId: string): boolean {
    return this.opened.has(connectionId);
  }

  async close(connectionId: string): Promise<void> {
    this.aborted.add(connectionId);
    this.opened.delete(connectionId);
    this.scripts.delete(connectionId);
  }

  async abort(connectionId: string): Promise<void> {
    this.aborted.add(connectionId);
  }

  getInfo(connectionId: string) {
    const info = this.opened.get(connectionId);
    if (!info) return null;
    return { agentId: info.agentId, conversationId: info.conversationId, state: info.state };
  }

  get size(): number {
    return this.opened.size;
  }

  async shutdown(): Promise<void> {
    this.opened.clear();
    this.scripts.clear();
  }

  async abortByAgentId(_agentId: string): Promise<number> { return 0; }
  listTrackedAgentIds(): string[] { return []; }
  removeOrphanedAgents(_agentIds: string[]): string[] { return []; }
}

// --- harness ---------------------------------------------------------------

interface HarnessCtx {
  port: number;
  apiKey: string;
  fake: FakeAgentSessionManager;
  gateway: WsGateway;
  server: Server;
  stop: () => Promise<void>;
}

async function startHarness(opts: {
  coalesce: boolean;
  partialJson: boolean;
  /** Override ping interval (ms). Default keeps pings out of the test window. */
  pingIntervalMs?: number;
  /** Override idle timeout (ms). 0 disables; default is far past test end. */
  idleTimeoutMs?: number;
  /** Inject a stubbed conversation resolver (protocol v2 tests). */
  conversationResolver?: ConstructorParameters<typeof WsGateway>[0]['conversationResolver'];
}): Promise<HarnessCtx> {
  process.env.LETTABOT_COALESCE_ENABLED = opts.coalesce ? '1' : '0';
  process.env.LETTABOT_PARTIAL_JSON_ENABLED = opts.partialJson ? '1' : '0';

  const apiKey = 'test-api-key';
  const fake = new FakeAgentSessionManager();
  const gateway = new WsGateway({
    apiKey,
    sessionManager: fake as unknown as AgentSessionManager,
    conversationResolver: opts.conversationResolver,
    pingIntervalMs: opts.pingIntervalMs ?? 60_000, // long; we close before pings fire
    idleTimeoutMs: opts.idleTimeoutMs ?? 60_000, // long; idle reaper opt-in per test
  });

  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const handled = gateway.handleUpgrade(req, socket, head);
    if (!handled) socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const stop = async () => {
    await gateway.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { port, apiKey, fake, gateway, server, stop };
}

interface ServerFrame {
  type: string;
  event?: string;
  status?: 'running' | 'completed';
  tool_call_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  request_id?: string;
  [key: string]: unknown;
}

async function connectClient(
  ctx: HarnessCtx,
  opts: { progressive?: boolean } = {},
): Promise<WebSocket> {
  const path = opts.progressive
    ? '/api/v1/agent-gateway?progressive_tool_calls=1'
    : '/api/v1/agent-gateway';
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}${path}`, {
    headers: { 'X-Api-Key': ctx.apiKey },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

/**
 * Drive a scripted turn through the gateway and collect every server
 * frame until a `result` frame arrives. Returns the parsed frames in
 * arrival order.
 */
async function runScriptedTurn(
  ctx: HarnessCtx,
  script: SDKMessage[],
  opts: { agentId?: string; requestId?: string; messageContent?: string; progressive?: boolean } = {},
): Promise<ServerFrame[]> {
  const ws = await connectClient(ctx, { progressive: opts.progressive });
  try {
    const frames: ServerFrame[] = [];
    let resolveTurn!: () => void;
    const turnDone = new Promise<void>((r) => (resolveTurn = r));

    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      frames.push(frame);
      if (frame.type === 'result') resolveTurn();
    });

    const agentId = opts.agentId ?? 'agent-test-1';
    const requestId = opts.requestId ?? 'req-1';
    const content = opts.messageContent ?? 'Hello';

    // Send session_start, wait for session_init, then queue the script
    // and send the message. We queue against the connId derived after
    // the gateway emits session_init so that sendAndStream sees the
    // right script for this connection.
    ws.send(JSON.stringify({ type: 'session_start', agent_id: agentId }));

    const sessionInit = await new Promise<ServerFrame>((resolve) => {
      const onInit = (data: unknown) => {
        const f = JSON.parse(String(data)) as ServerFrame;
        if (f.type === 'session_init') {
          ws.off('message', onInit as never);
          resolve(f);
        }
      };
      ws.on('message', onInit as never);
    });
    expect(sessionInit.type).toBe('session_init');

    // The gateway tracks the script by connectionId, but we don't have
    // it client-side. Workaround: queue against every active opened
    // session (there is exactly one in the harness).
    const connIds = Array.from((ctx.fake as unknown as { opened: Map<string, unknown> }).opened.keys());
    expect(connIds).toHaveLength(1);
    ctx.fake.queueScript(connIds[0]!, script);

    ws.send(JSON.stringify({ type: 'message', content, request_id: requestId }));

    await turnDone;
    return frames;
  } finally {
    ws.close();
    await new Promise<void>((r) => ws.once('close', () => r()));
  }
}

// --- fixture builders ------------------------------------------------------

/**
 * Build a sequence of SDKToolCallMessage events that progressively
 * extend `rawArguments` for a single tool_call_id, simulating how
 * the SDK streams tool argument tokens in. The final event is a
 * `result` so the gateway closes out the turn.
 */
function scriptToolCallStream(opts: {
  toolCallId: string;
  toolName: string;
  argChunks: string[];
  resultMessage?: Partial<SDKResultMessage>;
}): SDKMessage[] {
  const { toolCallId, toolName, argChunks } = opts;
  const events: SDKMessage[] = [];

  let accumulated = '';
  for (const chunk of argChunks) {
    accumulated += chunk;
    // Send each progressive snapshot as a fresh tool_call event.
    // toolInput is the SDK's best-effort parse; we leave it empty
    // and rely on rawArguments for the gateway-side parser.
    const ev: SDKToolCallMessage = {
      type: 'tool_call',
      toolCallId,
      toolName,
      toolInput: {},
      rawArguments: accumulated,
      uuid: `uuid-${toolCallId}-${events.length}`,
    };
    events.push(ev);
  }

  // A non-tool_call event after the stream forces flushPendingToolCalls
  // and the terminal `completed` snapshot.
  const result: SDKResultMessage = {
    type: 'result',
    success: true,
    durationMs: 100,
    conversationId: null,
    ...opts.resultMessage,
  };
  events.push(result);

  return events;
}

// --- env restore ----------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const TOUCHED_KEYS = ['LETTABOT_COALESCE_ENABLED', 'LETTABOT_PARTIAL_JSON_ENABLED'] as const;

beforeEach(() => {
  for (const k of TOUCHED_KEYS) SAVED_ENV[k] = process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

// --- tests ----------------------------------------------------------------

describe('ws-gateway e2e: partial-JSON tool_call streaming', () => {
  it('emits progressive tool_call snapshots for a single-arg tool (Read) when client opts in', async () => {
    const ctx = await startHarness({ coalesce: false, partialJson: true });
    try {
      const script = scriptToolCallStream({
        toolCallId: 'tc-read-1',
        toolName: 'Read',
        // chunked progression of {"file_path":"/opt/stacks/lettabot/src/api/ws-gateway.ts"}
        argChunks: [
          '{"file_p',
          'ath":"/opt/sta',
          'cks/lettabot/src/api/ws-',
          'gateway.ts"}',
        ],
      });

      const frames = await runScriptedTurn(ctx, script, { progressive: true });

      // Filter to just the tool_call frames for the assertion target.
      const toolCalls = frames.filter(
        (f) => f.type === 'stream' && f.event === 'tool_call',
      );

      // Every snapshot keeps the same id (the dedup key for clients).
      for (const tc of toolCalls) {
        expect(tc.tool_call_id).toBe('tc-read-1');
        expect(tc.tool_name).toBe('Read');
        expect(tc.request_id).toBe('req-1');
      }

      // ≥1 running, exactly 1 completed (the terminal frame).
      const running = toolCalls.filter((tc) => tc.status === 'running');
      const completed = toolCalls.filter((tc) => tc.status === 'completed');
      expect(running.length).toBeGreaterThanOrEqual(1);
      expect(completed).toHaveLength(1);

      // Final tool_input is the fully parsed object.
      expect(completed[0]!.tool_input).toEqual({
        file_path: '/opt/stacks/lettabot/src/api/ws-gateway.ts',
      });

      // tool_input strictly grows across the running snapshots: each
      // snapshot has at least as many keys as the previous, and the
      // file_path string only grows.
      let prevPathLen = 0;
      for (const tc of running) {
        const fp = (tc.tool_input ?? {}).file_path;
        if (typeof fp === 'string') {
          expect(fp.length).toBeGreaterThanOrEqual(prevPathLen);
          prevPathLen = fp.length;
        }
      }

      // The last frame is a `result`.
      expect(frames[frames.length - 1]!.type).toBe('result');
    } finally {
      await ctx.stop();
    }
  });

  it('emits progressive snapshots for a multi-arg tool (Grep with pattern + path) when client opts in', async () => {
    const ctx = await startHarness({ coalesce: false, partialJson: true });
    try {
      const script = scriptToolCallStream({
        toolCallId: 'tc-grep-1',
        toolName: 'Grep',
        // chunked progression of {"pattern":"foo","path":"/tmp"}
        argChunks: [
          '{"patt',
          'ern":"f',
          'oo","p',
          'ath":"/t',
          'mp"}',
        ],
      });

      const frames = await runScriptedTurn(ctx, script, { progressive: true });
      const toolCalls = frames.filter(
        (f) => f.type === 'stream' && f.event === 'tool_call',
      );
      const running = toolCalls.filter((tc) => tc.status === 'running');
      const completed = toolCalls.filter((tc) => tc.status === 'completed');

      // Final shape has both keys.
      expect(completed).toHaveLength(1);
      expect(completed[0]!.tool_input).toEqual({ pattern: 'foo', path: '/tmp' });

      // Somewhere in the running snapshots, only `pattern` is parseable
      // before `path` joins. Find the first frame with pattern set.
      const firstWithPattern = running.find(
        (tc) => 'pattern' in (tc.tool_input ?? {}),
      );
      expect(firstWithPattern).toBeDefined();
      // And the multi-key shape appears later (or in the completed frame).
      const multiKey = [...running, ...completed].find((tc) => {
        const ti = tc.tool_input ?? {};
        return 'pattern' in ti && 'path' in ti;
      });
      expect(multiKey).toBeDefined();
    } finally {
      await ctx.stop();
    }
  });

  it('all snapshots for a single tool_call_id keep the same id when progressive is opted in (lettabot-ded / sad repro)', async () => {
    // Repro the exact concern from lettabot-sad: a single tool call
    // produces N progressive snapshots that all share toolCallId, so a
    // client doing replace-by-id renders exactly one bubble. This is
    // the deterministic test fixture sad's AC #2 calls for.
    const ctx = await startHarness({ coalesce: false, partialJson: true });
    try {
      const script = scriptToolCallStream({
        toolCallId: 'tc-bubble-1',
        toolName: 'Bash',
        argChunks: [
          '{"comm',
          'and":"echo h',
          'ello"}',
        ],
      });

      const frames = await runScriptedTurn(ctx, script, { progressive: true });
      const toolCalls = frames.filter(
        (f) => f.type === 'stream' && f.event === 'tool_call',
      );

      // The client-side dedup contract: every tool_call frame for this
      // turn carries the same id. A client that key-replaces by
      // tool_call_id will collapse all N to a single rendered bubble.
      const distinctIds = new Set(toolCalls.map((tc) => tc.tool_call_id));
      expect(distinctIds.size).toBe(1);
      expect([...distinctIds][0]).toBe('tc-bubble-1');

      // And exactly one of them carries the terminal status — a client
      // that wants a "done" indicator gets exactly one transition.
      const terminals = toolCalls.filter((tc) => tc.status === 'completed');
      expect(terminals).toHaveLength(1);
    } finally {
      await ctx.stop();
    }
  });

  // --- flag matrix (lettabot-uww.8 + lettabot-pgs.2) ---------------------
  //
  // Drive the same Read script through every combination of
  // (LETTABOT_COALESCE_ENABLED, LETTABOT_PARTIAL_JSON_ENABLED, PROGRESSIVE
  // opt-in) and assert per-combination frame-count bounds + that the final
  // accumulated tool_input is identical across all eight. The PROGRESSIVE
  // axis (per-connection `?progressive_tool_calls=1` opt-in, lettabot-pgs)
  // gates whether the gateway emits running snapshots to this connection at
  // all; without it, PARTIAL_JSON=1 still runs server-side but only the
  // terminal `completed` frame reaches the wire. PROGRESSIVE has no effect
  // when PARTIAL_JSON is off — there are no progressive snapshots produced
  // server-side to gate.
  //
  // | COAL | PJSN | PROG | tool_call frames | running | completed | notes |
  // |  0   |  0   |  0   | exactly 1 | 0    | 0   | legacy single emit, no status field |
  // |  0   |  0   |  1   | exactly 1 | 0    | 0   | PROG no-op when PJSN off |
  // |  1   |  0   |  0   | exactly 1 | 0    | 0   | coalescer is a no-op for a single frame |
  // |  1   |  0   |  1   | exactly 1 | 0    | 0   | PROG no-op when PJSN off |
  // |  0   |  1   |  0   | exactly 1 | 0    | 1   | gate drops running, terminal completed reaches wire (DEFAULT CONTRACT) |
  // |  0   |  1   |  1   | ≥2 (running×N+terminal) | ≥1 | exactly 1 | snapshots emerge 1:1 to the wire |
  // |  1   |  1   |  0   | exactly 1 | 0    | 1   | gate drops running, coalescer is a no-op for the single terminal frame |
  // |  1   |  1   |  1   | ≤ N+1, typically 1 | 0..N | exactly 1 | replace-by-id absorbs running noise; terminal triggers immediate flush |

  describe.each([
    {
      label: 'COALESCE=0, PARTIAL_JSON=0, PROGRESSIVE=0 (legacy single emit)',
      coalesce: false,
      partialJson: false,
      progressive: false,
      assertCounts: (toolCalls: ServerFrame[]) => {
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls.filter((tc) => tc.status === 'running')).toHaveLength(0);
        expect(toolCalls.filter((tc) => tc.status === 'completed')).toHaveLength(0);
        for (const tc of toolCalls) expect(tc.status).toBeUndefined();
      },
    },
    {
      label: 'COALESCE=0, PARTIAL_JSON=0, PROGRESSIVE=1 (PROG no-op when PJSN off)',
      coalesce: false,
      partialJson: false,
      progressive: true,
      assertCounts: (toolCalls: ServerFrame[]) => {
        // PROGRESSIVE opt-in has no effect when PARTIAL_JSON is off —
        // there is no snapshot emitter running server-side to gate.
        expect(toolCalls).toHaveLength(1);
        for (const tc of toolCalls) expect(tc.status).toBeUndefined();
      },
    },
    {
      label: 'COALESCE=1, PARTIAL_JSON=0, PROGRESSIVE=0 (coalesced legacy)',
      coalesce: true,
      partialJson: false,
      progressive: false,
      assertCounts: (toolCalls: ServerFrame[]) => {
        expect(toolCalls).toHaveLength(1);
        for (const tc of toolCalls) expect(tc.status).toBeUndefined();
      },
    },
    {
      label: 'COALESCE=1, PARTIAL_JSON=0, PROGRESSIVE=1 (PROG no-op when PJSN off, coalesced)',
      coalesce: true,
      partialJson: false,
      progressive: true,
      assertCounts: (toolCalls: ServerFrame[]) => {
        expect(toolCalls).toHaveLength(1);
        for (const tc of toolCalls) expect(tc.status).toBeUndefined();
      },
    },
    {
      label: 'COALESCE=0, PARTIAL_JSON=1, PROGRESSIVE=0 (DEFAULT — gate drops running)',
      coalesce: false,
      partialJson: true,
      progressive: false,
      assertCounts: (toolCalls: ServerFrame[]) => {
        // The new default contract: clients that didn't opt in see one
        // tool_call frame per id, the terminal completed snapshot. The
        // running snapshots are dropped by the gateway gate before
        // reaching the wire.
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls.filter((tc) => tc.status === 'running')).toHaveLength(0);
        expect(toolCalls.filter((tc) => tc.status === 'completed')).toHaveLength(1);
      },
    },
    {
      label: 'COALESCE=0, PARTIAL_JSON=1, PROGRESSIVE=1 (uncoalesced progressive)',
      coalesce: false,
      partialJson: true,
      progressive: true,
      assertCounts: (toolCalls: ServerFrame[]) => {
        const running = toolCalls.filter((tc) => tc.status === 'running');
        const completed = toolCalls.filter((tc) => tc.status === 'completed');
        // ≥1 running snapshot (parser yields a structurally-distinct
        // value at least once before the terminal frame) + exactly 1
        // completed.
        expect(running.length).toBeGreaterThanOrEqual(1);
        expect(completed).toHaveLength(1);
        // Frame count is the inflation contrast control: > 1.
        expect(toolCalls.length).toBeGreaterThan(1);
      },
    },
    {
      label: 'COALESCE=1, PARTIAL_JSON=1, PROGRESSIVE=0 (default + coalesced)',
      coalesce: true,
      partialJson: true,
      progressive: false,
      assertCounts: (toolCalls: ServerFrame[]) => {
        // Same as uncoalesced default: the gate already dropped running
        // snapshots, so the coalescer has nothing to absorb.
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls.filter((tc) => tc.status === 'running')).toHaveLength(0);
        expect(toolCalls.filter((tc) => tc.status === 'completed')).toHaveLength(1);
      },
    },
    {
      label: 'COALESCE=1, PARTIAL_JSON=1, PROGRESSIVE=1 (full-progressive opt-in)',
      coalesce: true,
      partialJson: true,
      progressive: true,
      assertCounts: (toolCalls: ServerFrame[]) => {
        const completed = toolCalls.filter((tc) => tc.status === 'completed');
        // Coalescer's replace-by-id absorbs running snapshots; the
        // terminal completed frame triggers an immediate flush. In
        // synchronous-burst tests like ours the coalescer collapses to
        // a single frame (the terminal). Allow ≤ N+1 as an upper bound
        // to stay robust against timer fires across event-loop turns.
        expect(toolCalls.length).toBeLessThanOrEqual(5);
        expect(completed).toHaveLength(1);
      },
    },
  ])('flag matrix · $label', (cfg) => {
    it('drives the same Read script with same final tool_input', async () => {
      const ctx = await startHarness({ coalesce: cfg.coalesce, partialJson: cfg.partialJson });
      try {
        const script = scriptToolCallStream({
          toolCallId: 'tc-matrix-read',
          toolName: 'Read',
          argChunks: [
            '{"file_p',
            'ath":"/opt/sta',
            'cks/lettabot/src/api/ws-',
            'gateway.ts"}',
          ],
        });

        const frames = await runScriptedTurn(ctx, script, { progressive: cfg.progressive });
        const toolCalls = frames.filter(
          (f) => f.type === 'stream' && f.event === 'tool_call',
        );

        // INVARIANT 1: at least one tool_call frame is always emitted.
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);

        // INVARIANT 2: the LAST tool_call frame carries the fully
        // accumulated args, byte-identical across all eight combos.
        const last = toolCalls[toolCalls.length - 1]!;
        expect(last.tool_input).toEqual({
          file_path: '/opt/stacks/lettabot/src/api/ws-gateway.ts',
        });
        expect(last.tool_call_id).toBe('tc-matrix-read');
        expect(last.tool_name).toBe('Read');

        // INVARIANT 3: stream terminates with a `result` frame.
        expect(frames[frames.length - 1]!.type).toBe('result');

        // Per-combination bounds.
        cfg.assertCounts(toolCalls);
      } finally {
        await ctx.stop();
      }
    });
  });

  it('two interleaved tool_calls keep their snapshots separated by id (progressive opt-in)', async () => {
    // Defends against a regression where the per-id buffer gets cross-
    // contaminated when two tools stream concurrently in one turn.
    const ctx = await startHarness({ coalesce: false, partialJson: true });
    try {
      const interleaved: SDKMessage[] = [];
      // Build interleaved tool_call events: A, B, A, B, A — both
      // progressing in parallel.
      const aChunks = ['{"x', '":1', '}'];
      const bChunks = ['{"y', '":"v', '"}'];
      let aBuf = '';
      let bBuf = '';
      for (let i = 0; i < Math.max(aChunks.length, bChunks.length); i++) {
        if (i < aChunks.length) {
          aBuf += aChunks[i];
          interleaved.push({
            type: 'tool_call',
            toolCallId: 'tc-A',
            toolName: 'A',
            toolInput: {},
            rawArguments: aBuf,
            uuid: `u-A-${i}`,
          });
        }
        if (i < bChunks.length) {
          bBuf += bChunks[i];
          interleaved.push({
            type: 'tool_call',
            toolCallId: 'tc-B',
            toolName: 'B',
            toolInput: {},
            rawArguments: bBuf,
            uuid: `u-B-${i}`,
          });
        }
      }
      interleaved.push({
        type: 'result',
        success: true,
        durationMs: 100,
        conversationId: null,
      });

      const frames = await runScriptedTurn(ctx, interleaved, { progressive: true });
      const toolCalls = frames.filter(
        (f) => f.type === 'stream' && f.event === 'tool_call',
      );
      const finalA = toolCalls
        .filter((tc) => tc.tool_call_id === 'tc-A' && tc.status === 'completed')
        .pop();
      const finalB = toolCalls
        .filter((tc) => tc.tool_call_id === 'tc-B' && tc.status === 'completed')
        .pop();

      expect(finalA?.tool_input).toEqual({ x: 1 });
      expect(finalB?.tool_input).toEqual({ y: 'v' });
    } finally {
      await ctx.stop();
    }
  });
});

// --- assistant text reassembly (lettabot-uww.11) -------------------------
//
// Field repro on the Letta Mobile Admin app showed an assistant-text
// mermaid block rendered with corrupted source: `A[LLM snapshots]` arrived
// as `A[LLMapshots|`, missing a space + closing bracket and merging into
// the next node. The signature (silent character loss at chunk boundaries
// inside strict-syntax content) is the classic shape of a snapshot/dedup
// off-by-one.
//
// These tests exercise the WS gateway's assistant-text path with dense,
// adversarial chunking patterns drawn from real model output (mermaid,
// code fences, JSON, prose) and assert byte-perfect reassembly across
// every (COALESCE, PARTIAL_JSON) cell. If these all pass, the gateway
// is exonerated and the bug lives in the client renderer (letta-mobile)
// or further upstream of the gateway in the Letta SDK stream.

/**
 * Build a script of assistant text deltas + terminal result. `content`
 * is split into the exact chunks listed in `chunks` (must reassemble
 * to `content` byte-for-byte; we assert this so a bad fixture fails
 * loudly rather than silently masking a gateway bug).
 */
function scriptAssistantTextStream(opts: {
  chunks: string[];
  resultMessage?: Partial<SDKResultMessage>;
}): { script: SDKMessage[]; expected: string } {
  const expected = opts.chunks.join('');
  const script: SDKMessage[] = opts.chunks.map((c) => ({
    type: 'assistant',
    content: c,
  } as SDKMessage));
  const result: SDKResultMessage = {
    type: 'result',
    success: true,
    durationMs: 100,
    conversationId: null,
    ...opts.resultMessage,
  };
  script.push(result);
  return { script, expected };
}

/**
 * Concatenate the `content` field of every `stream`/`assistant` frame
 * in arrival order. Matches the channel adapter contract §3 (text
 * events are deltas; concatenate as they arrive).
 */
function reassembleAssistantText(frames: ServerFrame[]): string {
  return frames
    .filter((f) => f.type === 'stream' && f.event === 'assistant')
    .map((f) => (typeof f.content === 'string' ? f.content : ''))
    .join('');
}

describe('ws-gateway e2e: assistant text reassembly (lettabot-uww.11)', () => {
  // The mermaid block from the field repro. Includes:
  // - leading/trailing fence lines
  // - `[` / `]` brackets that the bug merged across chunk boundaries
  // - whitespace boundaries (spaces, newlines)
  // - pipe `|` characters which the mermaid parser flagged
  const MERMAID_REPRO = [
    '```mermaid\n',
    'flowchart TD\n',
    '    A[LLM snapshots] --> B{Coalesce?}\n',
    '    B -->|yes| C[Merge into single snapshot]\n',
    '    B -->|no| D[Emit each snapshot]\n',
    '    C --> E[WS Gateway]\n',
    '    D --> E\n',
    '    E -->|stream events| F[Client]\n',
    '```\n',
  ].join('');

  // Patterns we know break naive accumulators when split adversarially.
  const ADVERSARIAL_FIXTURES: Array<{ name: string; chunks: string[] }> = [
    {
      name: 'mermaid block, char-by-char (worst case)',
      chunks: Array.from(MERMAID_REPRO),
    },
    {
      name: 'mermaid block, split at every bracket/pipe boundary',
      chunks: MERMAID_REPRO.split(/(?<=[\[\]|{}])/),
    },
    {
      name: 'mermaid block, 1–3 char rolling chunks (real-token-ish)',
      chunks: chunkRolling(MERMAID_REPRO, [1, 2, 3]),
    },
    {
      name: 'code fence with backticks split mid-fence',
      chunks: ['``', '`', 'ts\n', 'const x = ', '"hello";\n', '`', '`', '`', '\n'],
    },
    {
      name: 'JSON object split mid-key/mid-value',
      chunks: ['{"f', 'oo":"b', 'ar","n', 'um":4', '2}'],
    },
    {
      name: 'whitespace-only chunks interleaved with content',
      chunks: ['hello', ' ', '', 'world', '\n', '', 'next line'],
    },
    {
      name: 'unicode + emoji split across surrogate-safe boundaries',
      chunks: ['done ', '✅ ', 'and ', '🎉', '!\n'],
    },
    {
      name: 'leading "<" that could trigger <no-reply/> guard, then plain text',
      // Worst case for the no-reply guard: chunks that, when accumulated
      // and trimmed, are a strict prefix of "<no-reply/>" — guard buffers
      // them, then a non-prefix chunk forces a flush. Reassembled text
      // must still equal the concatenation of all chunks.
      chunks: ['<', 'n', 'o', '-', 'reply', '/', '>', ' actually wait, replying'],
    },
    {
      name: 'tightly-packed brackets (mermaid node labels back-to-back)',
      chunks: ['A[x]', '-->B[y]', '-->C[z]'],
    },
  ];

  // Drive every fixture across every (COALESCE × PARTIAL_JSON) cell.
  // PARTIAL_JSON is orthogonal to assistant text per channel adapter
  // contract §3, but we test all four cells anyway so a future
  // regression that bleeds tool_call dedup into the text path is
  // caught here.
  describe.each([
    { coalesce: false, partialJson: false },
    { coalesce: false, partialJson: true },
    { coalesce: true, partialJson: false },
    { coalesce: true, partialJson: true },
  ])(
    'COALESCE=$coalesce, PARTIAL_JSON=$partialJson',
    (cfg) => {
      it.each(ADVERSARIAL_FIXTURES)(
        'reassembles byte-perfect: $name',
        async ({ chunks }) => {
          const ctx = await startHarness({
            coalesce: cfg.coalesce,
            partialJson: cfg.partialJson,
          });
          try {
            const { script, expected } = scriptAssistantTextStream({ chunks });

            // Sanity: fixture builder must round-trip its own input. If
            // this fails the test is bad, not the gateway.
            expect(chunks.join('')).toBe(expected);

            const frames = await runScriptedTurn(ctx, script);
            const reassembled = reassembleAssistantText(frames);

            // The smoking-gun assertion. Diff is shown character-by-
            // character on failure, so a missing space or merged
            // bracket is immediately visible in CI output.
            expect(reassembled).toBe(expected);

            // Stream terminates with a `result`.
            expect(frames[frames.length - 1]!.type).toBe('result');
          } finally {
            await ctx.stop();
          }
        },
      );
    },
  );

  it('mermaid repro: rendered output matches the original source exactly', async () => {
    // Tighter, mobile-shaped check: the exact bytes the mobile renderer
    // would feed to its mermaid parser must equal the bytes the agent
    // produced. Uses the default contract (PARTIAL_JSON on, COALESCE on)
    // — what production runs.
    const ctx = await startHarness({ coalesce: true, partialJson: true });
    try {
      const { script, expected } = scriptAssistantTextStream({
        chunks: chunkRolling(MERMAID_REPRO, [1, 2, 3, 5, 8]),
      });
      const frames = await runScriptedTurn(ctx, script);
      const reassembled = reassembleAssistantText(frames);

      // No space lost between `LLM` and `snapshots`.
      expect(reassembled).toContain('A[LLM snapshots]');
      // No closing bracket lost before the next node.
      expect(reassembled).toContain('] --> B{Coalesce?}');
      // Full byte equality — covers any other silent loss not in the
      // two narrower assertions above.
      expect(reassembled).toBe(expected);
    } finally {
      await ctx.stop();
    }
  });
});

/**
 * Split `text` into chunks of sizes drawn round-robin from `sizes`.
 * Useful for simulating real-world tokenizer chunk distributions
 * (1–3 char chunks for SSE deltas, 5–8 for slightly-buffered streams).
 */
function chunkRolling(text: string, sizes: number[]): string[] {
  const chunks: string[] = [];
  let i = 0;
  let s = 0;
  while (i < text.length) {
    const size = sizes[s % sizes.length]!;
    chunks.push(text.slice(i, i + size));
    i += size;
    s++;
  }
  return chunks;
}

// --- cancel + disconnect coverage (lettabot-uww.10) ----------------------
//
// Four scenarios on top of the uww.7 harness, all using the per-yield
// setImmediate pacing the fake added so the test driver can interleave
// control frames (abort) and ws.close() between SDK events.

describe('ws-gateway e2e: cancel and disconnect', () => {
  it('client disconnects mid-stream — gateway cleans up the session without crashing', async () => {
    // Scenario 1: client closes ws after the first running snapshot. The
    // gateway should run its `close` handler (calls sessions.close), the
    // in-flight stream should terminate, and the session count should
    // drop to zero. Sends to a closed socket are silent (readyState
    // check), so the lack of a crash is the success signal.
    const ctx = await startHarness({ coalesce: false, partialJson: true });
    try {
      const ws = await connectClient(ctx, { progressive: true });
      const frames: ServerFrame[] = [];
      ws.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));

      // session_start → wait for session_init
      ws.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-disconnect-1' }));
      await waitFor(frames, (f) => f.type === 'session_init');

      // Queue a script with many snapshots so we can disconnect partway.
      const connIds = Array.from((ctx.fake as unknown as { opened: Map<string, unknown> }).opened.keys());
      ctx.fake.queueScript(connIds[0]!, scriptToolCallStream({
        toolCallId: 'tc-disc-1',
        toolName: 'Read',
        argChunks: ['{"f', 'ile_p', 'ath":', '"/tmp', '/x"}'],
      }));
      ws.send(JSON.stringify({ type: 'message', content: 'go', request_id: 'req-d1' }));

      // Wait for the first tool_call snapshot, then close.
      await waitFor(frames, (f) => f.type === 'stream' && f.event === 'tool_call');
      ws.close();

      // Wait for the gateway-side close handler to run — sessions.close
      // is called from the close listener, so we poll briefly.
      await waitUntil(() => ctx.fake.size === 0, 1000);
      expect(ctx.fake.size).toBe(0);
      // Connection count on the WSS drops too (post-close cleanup).
      expect(ctx.gateway.connectionCount).toBe(0);
    } finally {
      await ctx.stop();
    }
  });

  it('explicit abort frame stops further snapshots and emits synthetic aborted result', async () => {
    // Scenario 3: client sends {type:'abort', request_id} mid-stream.
    // Gateway calls sessions.abort, the fake flips its aborted flag, the
    // generator returns on the next iteration, and the gateway sends a
    // synthetic {type:'result', aborted: true} frame. No further
    // tool_call frames for that id may appear after the abort.
    const ctx = await startHarness({ coalesce: false, partialJson: true });
    try {
      const ws = await connectClient(ctx, { progressive: true });
      const frames: ServerFrame[] = [];
      ws.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));

      ws.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-abort-1' }));
      await waitFor(frames, (f) => f.type === 'session_init');

      const connIds = Array.from((ctx.fake as unknown as { opened: Map<string, unknown> }).opened.keys());
      // Long script so there are events left for the abort to cancel.
      ctx.fake.queueScript(connIds[0]!, scriptToolCallStream({
        toolCallId: 'tc-abort-1',
        toolName: 'Read',
        argChunks: ['{"f', 'ile_p', 'ath":"', '/tmp/', 'long-fil', 'ename.t', 'xt"}'],
      }));
      ws.send(JSON.stringify({ type: 'message', content: 'go', request_id: 'req-a1' }));

      // Wait for the first running snapshot to confirm streaming started.
      await waitFor(frames, (f) => f.type === 'stream' && f.event === 'tool_call' && f.status === 'running');

      const framesAtAbort = frames.length;
      ws.send(JSON.stringify({ type: 'abort', request_id: 'req-a1' }));

      // Wait for the synthetic aborted result.
      const abortedResult = await waitFor(
        frames,
        (f) => f.type === 'result' && (f as { aborted?: boolean }).aborted === true,
      );
      expect((abortedResult as { aborted?: boolean }).aborted).toBe(true);
      expect((abortedResult as { request_id?: string }).request_id).toBe('req-a1');

      // Give the generator one more event-loop turn — confirm no further
      // tool_call frames for tc-abort-1 sneak in after the abort.
      await new Promise((r) => setTimeout(r, 50));
      const postAbortToolCalls = frames
        .slice(framesAtAbort)
        .filter((f) => f.type === 'stream' && f.event === 'tool_call' && f.tool_call_id === 'tc-abort-1');
      // Some snapshots may have already been emitted between
      // framesAtAbort and the abort handler running — that's fine. The
      // contract is "no further snapshots once the gateway processed the
      // abort", which we verify by the result frame appearing without a
      // status='completed' tool_call frame after it.
      const completedAfterAbort = postAbortToolCalls.filter((tc) => tc.status === 'completed');
      expect(completedAfterAbort).toHaveLength(0);

      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    } finally {
      await ctx.stop();
    }
  });

  it('SDK stream error mid-snapshot emits an error frame, no stale running card after', async () => {
    // Scenario 4: the generator throws partway through. Gateway's
    // catch block runs and calls sendError(STREAM_ERROR). No further
    // tool_call frames may follow the error.
    const ctx = await startHarness({ coalesce: false, partialJson: true });
    try {
      const ws = await connectClient(ctx, { progressive: true });
      const frames: ServerFrame[] = [];
      ws.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));

      ws.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-err-1' }));
      await waitFor(frames, (f) => f.type === 'session_init');

      const connIds = Array.from((ctx.fake as unknown as { opened: Map<string, unknown> }).opened.keys());
      // Yield 2 snapshots, then throw — simulates an SDK that fails
      // partway through tool_call argument streaming.
      ctx.fake.queueScript(connIds[0]!, [
        {
          type: 'tool_call',
          toolCallId: 'tc-err-1',
          toolName: 'Read',
          toolInput: {},
          rawArguments: '{"f',
          uuid: 'u-err-0',
        },
        {
          type: 'tool_call',
          toolCallId: 'tc-err-1',
          toolName: 'Read',
          toolInput: {},
          rawArguments: '{"file_p',
          uuid: 'u-err-1',
        },
        { __throw: 'simulated SDK stream error' },
      ]);
      ws.send(JSON.stringify({ type: 'message', content: 'go', request_id: 'req-e1' }));

      // Wait for the error frame.
      const errorFrame = await waitFor(frames, (f) => f.type === 'error');
      expect((errorFrame as { code?: string }).code).toBe('STREAM_ERROR');
      expect((errorFrame as { message?: string }).message).toContain('simulated SDK stream error');
      expect((errorFrame as { request_id?: string }).request_id).toBe('req-e1');

      // Confirm no tool_call frame for tc-err-1 appears AFTER the error.
      const errorIdx = frames.indexOf(errorFrame);
      const toolCallsAfterError = frames
        .slice(errorIdx + 1)
        .filter((f) => f.type === 'stream' && f.event === 'tool_call');
      expect(toolCallsAfterError).toHaveLength(0);

      // And no result frame is sent after a stream error — the error
      // itself is the terminal frame. Give one event-loop tick to
      // confirm.
      await new Promise((r) => setTimeout(r, 50));
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(0);

      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    } finally {
      await ctx.stop();
    }
  });

  it('disconnect followed by reconnect with same agent_id starts a fresh stream', async () => {
    // Scenario 2 (gateway-side portion): after a mid-stream disconnect,
    // a new connection from the same agent gets a fresh session and the
    // new turn's frames are not cross-contaminated by the prior turn.
    // The mobile-side wucn-snapshot-recovery path (timeline replay
    // dedup) is out of scope here — that's the letta-mobile aie.7 fix
    // and is verified manually on Pixel 2XL.
    const ctx = await startHarness({ coalesce: false, partialJson: true });
    try {
      // --- turn 1: disconnect mid-stream ---
      const wsA = await connectClient(ctx, { progressive: true });
      const framesA: ServerFrame[] = [];
      wsA.on('message', (data) => framesA.push(JSON.parse(String(data)) as ServerFrame));
      wsA.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-reconnect-1' }));
      await waitFor(framesA, (f) => f.type === 'session_init');

      const connIdsA = Array.from((ctx.fake as unknown as { opened: Map<string, unknown> }).opened.keys());
      ctx.fake.queueScript(connIdsA[0]!, scriptToolCallStream({
        toolCallId: 'tc-turn-A',
        toolName: 'Read',
        argChunks: ['{"f', 'ile_p', 'ath":"/A"}'],
      }));
      wsA.send(JSON.stringify({ type: 'message', content: 'turn-A', request_id: 'req-A' }));
      await waitFor(framesA, (f) => f.type === 'stream' && f.event === 'tool_call');
      wsA.close();
      await waitUntil(() => ctx.fake.size === 0, 1000);

      // --- turn 2: reconnect, fresh session ---
      const wsB = await connectClient(ctx, { progressive: true });
      const framesB: ServerFrame[] = [];
      wsB.on('message', (data) => framesB.push(JSON.parse(String(data)) as ServerFrame));
      wsB.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-reconnect-1' }));
      await waitFor(framesB, (f) => f.type === 'session_init');

      const connIdsB = Array.from((ctx.fake as unknown as { opened: Map<string, unknown> }).opened.keys());
      // Different tool_call_id and different file path so we can prove
      // there's no leakage.
      ctx.fake.queueScript(connIdsB[0]!, scriptToolCallStream({
        toolCallId: 'tc-turn-B',
        toolName: 'Read',
        argChunks: ['{"file_path":"/B"}'],
      }));
      wsB.send(JSON.stringify({ type: 'message', content: 'turn-B', request_id: 'req-B' }));
      await waitFor(framesB, (f) => f.type === 'result');

      // No tc-turn-A frames leaked into turn B's stream.
      const turnBToolCalls = framesB.filter(
        (f) => f.type === 'stream' && f.event === 'tool_call',
      );
      for (const tc of turnBToolCalls) {
        expect(tc.tool_call_id).toBe('tc-turn-B');
      }
      // Final tool_input for turn B is /B, not /A.
      const completedB = turnBToolCalls.filter((tc) => tc.status === 'completed').pop();
      expect(completedB?.tool_input).toEqual({ file_path: '/B' });

      wsB.close();
      await new Promise<void>((r) => wsB.once('close', () => r()));
    } finally {
      await ctx.stop();
    }
  });
});

// --- ws hardening (lettabot-wsh.1) ---------------------------------------
//
// Three tests covering the heartbeat reaper, idle timeout, and idle-timer
// cancellation on session_start. Use sub-second timings via the new
// pingIntervalMs / idleTimeoutMs harness overrides so each test runs in
// well under a second on real timers.

describe('ws-gateway hardening: heartbeat reaper + idle timeout', () => {
  it('reaps a connection that stops responding to pings (DEAD_CONNECTION close code)', async () => {
    // Drive two ping cycles with a fast interval. On the first cycle the
    // server marks isAlive=false and sends a ping; the destroyed socket
    // can't reply with a pong. On the second cycle the reaper sees
    // isAlive still false and terminates with code 4001.
    const ctx = await startHarness({
      coalesce: false,
      partialJson: false,
      pingIntervalMs: 50,
    });
    try {
      const ws = await connectClient(ctx);
      expect(ctx.gateway.connectionCount).toBe(1);

      // Hard-kill the underlying TCP socket without sending a close
      // frame. Server still believes the connection is open until the
      // reaper notices the missing pong.
      (ws as unknown as { _socket: { destroy: () => void } })._socket.destroy();

      // Two ping cycles + a generous buffer for the close handler to run.
      await new Promise((r) => setTimeout(r, 250));

      expect(ctx.gateway.connectionCount).toBe(0);
    } finally {
      await ctx.stop();
    }
  });

  it('closes a connection that never sends session_start with code IDLE_TIMEOUT (4003)', async () => {
    const ctx = await startHarness({
      coalesce: false,
      partialJson: false,
      idleTimeoutMs: 100,
    });
    try {
      const ws = await connectClient(ctx);

      let closeCode: number | undefined;
      let closeReason: string | undefined;
      ws.on('close', (code, reason) => {
        closeCode = code;
        closeReason = reason.toString('utf8');
      });

      // Don't send session_start. Wait past the idle window + buffer
      // for the close frame to land.
      await new Promise((r) => setTimeout(r, 250));

      expect(closeCode).toBe(4003);
      expect(closeReason).toMatch(/idle/i);
      expect(ctx.gateway.connectionCount).toBe(0);
    } finally {
      await ctx.stop();
    }
  });

  it('cancels the idle timer when session_start arrives', async () => {
    // Inverse of the previous test: send session_start before the idle
    // window, then sit on the connection. The timer should be cleared
    // and no close frame should fire.
    const ctx = await startHarness({
      coalesce: false,
      partialJson: false,
      idleTimeoutMs: 100,
    });
    try {
      const ws = await connectClient(ctx);

      let closeCode: number | undefined;
      ws.on('close', (code) => {
        closeCode = code;
      });

      const frames: ServerFrame[] = [];
      ws.on('message', (data) => {
        frames.push(JSON.parse(String(data)) as ServerFrame);
      });

      // Send session_start before the idle window expires.
      ws.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-keepalive-1' }));
      await waitFor(frames, (f) => f.type === 'session_init');

      // Wait well past the idle window. The connection should still be open.
      await new Promise((r) => setTimeout(r, 250));

      expect(closeCode).toBeUndefined();
      expect(ctx.gateway.connectionCount).toBe(1);

      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    } finally {
      await ctx.stop();
    }
  });
});

// --- ws hardening: per-connId mutex + busy-reject (lettabot-wsh.2) -------
//
// Race repro: a client sends `session_start` (agent B) while a `message`
// for agent A is mid-stream. Without the mutex this would tear down A's
// SDK subprocess from under the for-await iterator and leak interleaved
// frames into B's stream. With the mutex + busy-reject, the second
// `session_start` is rejected with SESSION_BUSY and A's stream completes
// uninterrupted.

describe('ws-gateway hardening: session_start busy-reject (lettabot-wsh.2)', () => {
  it('rejects session_start with SESSION_BUSY while a stream is in flight', async () => {
    const ctx = await startHarness({ coalesce: false, partialJson: false });
    try {
      const ws = await connectClient(ctx);

      const frames: ServerFrame[] = [];
      ws.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));

      // session_start agent A
      ws.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-A' }));
      await waitFor(frames, (f) => f.type === 'session_init');

      // Test-controlled gate: the fake will yield one chunk, then await
      // the pause promise indefinitely. We resolve it after asserting
      // the busy-reject. This guarantees the fake's sendAndStream is
      // genuinely mid-flight (state='busy') when session_start B arrives.
      let releaseStream!: () => void;
      const pauseGate = new Promise<void>((r) => {
        releaseStream = r;
      });

      const connIds = Array.from((ctx.fake as unknown as { opened: Map<string, unknown> }).opened.keys());
      expect(connIds).toHaveLength(1);
      ctx.fake.queueScript(connIds[0]!, [
        {
          type: 'assistant',
          content: 'A-streaming',
          uuid: 'u-A-0',
        } as unknown as SDKMessage,
        { __pause: pauseGate },
        {
          type: 'assistant',
          content: 'A-resumed',
          uuid: 'u-A-1',
        } as unknown as SDKMessage,
        {
          type: 'result',
          success: true,
          durationMs: 100,
          conversationId: null,
        } as SDKMessage,
      ]);

      ws.send(
        JSON.stringify({ type: 'message', content: 'A msg', request_id: 'req-A' }),
      );

      // Wait for the first A chunk so we know streaming started and
      // the pause sentinel is now blocking the fake.
      await waitFor(
        frames,
        (f) => f.type === 'stream' && f.event === 'assistant',
      );

      // Race: try to switch agents while the stream is provably paused
      // mid-flight. The gateway's busy-reject should fire because state
      // is 'busy' (set on entry to fake's sendAndStream).
      ws.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-B' }));

      // Wait for the busy error to arrive.
      await waitFor(
        frames,
        (f) =>
          f.type === 'error' &&
          (f as { code?: string }).code === 'SESSION_BUSY',
        2000,
      );

      // Now release the stream so A can complete naturally.
      releaseStream();

      await waitFor(
        frames,
        (f) => f.type === 'result' && (f as { request_id?: string }).request_id === 'req-A',
        2000,
      );

      // INVARIANT 1: a SESSION_BUSY error frame fired in response to the
      // mid-stream session_start.
      const busyError = frames.find(
        (f) =>
          f.type === 'error' &&
          (f as { code?: string }).code === 'SESSION_BUSY',
      );
      expect(busyError).toBeDefined();

      // INVARIANT 2: only ONE session_init was emitted (the original A);
      // the rejected session_start did NOT open a second SDK session.
      const sessionInits = frames.filter((f) => f.type === 'session_init');
      expect(sessionInits).toHaveLength(1);

      // INVARIANT 3: A's stream completed cleanly with both pre- and
      // post-pause chunks plus its result. No interleaving from B.
      const assistantFrames = frames.filter(
        (f) => f.type === 'stream' && f.event === 'assistant',
      );
      expect(assistantFrames.length).toBe(2);
      const resultFrames = frames.filter(
        (f) => f.type === 'result' && (f as { request_id?: string }).request_id === 'req-A',
      );
      expect(resultFrames).toHaveLength(1);

      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    } finally {
      await ctx.stop();
    }
  });

  it('allows session_start once the prior stream completes (no permanent block)', async () => {
    // Counter-test: after a stream finishes, session_start should succeed
    // normally — the busy state must clear when the stream ends.
    const ctx = await startHarness({ coalesce: false, partialJson: false });
    try {
      const ws = await connectClient(ctx);

      const frames: ServerFrame[] = [];
      ws.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));

      ws.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-A' }));
      await waitFor(frames, (f) => f.type === 'session_init');

      const connIds = Array.from((ctx.fake as unknown as { opened: Map<string, unknown> }).opened.keys());
      ctx.fake.queueScript(connIds[0]!, [
        { type: 'assistant', content: 'done', uuid: 'u-1' } as unknown as SDKMessage,
        {
          type: 'result',
          success: true,
          durationMs: 50,
          conversationId: null,
        } as SDKMessage,
      ]);

      ws.send(
        JSON.stringify({ type: 'message', content: 'A msg', request_id: 'req-A' }),
      );
      await waitFor(
        frames,
        (f) => f.type === 'result' && (f as { request_id?: string }).request_id === 'req-A',
      );

      // Now session_start B — should succeed because state is no longer busy.
      ws.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-B' }));
      await waitFor(
        frames,
        (f) => f.type === 'session_init' && frames.filter((x) => x.type === 'session_init').length === 2,
      );

      const sessionInits = frames.filter((f) => f.type === 'session_init');
      expect(sessionInits).toHaveLength(2);
      const errorFrames = frames.filter((f) => f.type === 'error');
      expect(errorFrames).toHaveLength(0);

      ws.close();
      await new Promise<void>((r) => ws.once('close', () => r()));
    } finally {
      await ctx.stop();
    }
  });
});

// --- conversation id propagation + swap (lettabot-flk.5) -----------------
//
// Part 1: every streamed frame (assistant, tool_call, tool_result,
// reasoning) carries a `conversation_id` so the client can detect at
// the FIRST chunk that the underlying conversation has changed,
// instead of only at the terminal `result` frame.
//
// Part 2: when the manager's recovery path swaps the conversation
// mid-turn, it yields a synthetic `conversation_swap` event. The
// gateway forwards a wire frame { type:'stream', event:'conversation_swap',
// old_conversation_id, new_conversation_id } so the client can
// re-anchor its timeline observer BEFORE retry events arrive.
//
// We test the wire shape end-to-end against the fake (which knows how
// to update its tracked conversationId on the swap event). The
// manager-side emission is a small, mechanical change exercised by
// the unit branches in agent-session-manager.ts.

describe('ws-gateway e2e: conversation_id propagation (lettabot-flk.5)', () => {
  it('every stream frame carries conversation_id matching the active session', async () => {
    const ctx = await startHarness({ coalesce: false, partialJson: true });
    try {
      const script: SDKMessage[] = [
        { type: 'reasoning', content: 'thinking', uuid: 'u-r' } as unknown as SDKMessage,
        { type: 'assistant', content: 'hi ', uuid: 'u-a-1' } as unknown as SDKMessage,
        {
          type: 'tool_call',
          toolCallId: 'tc-flk-1',
          toolName: 'Read',
          toolInput: {},
          rawArguments: '{"file_path":"/tmp/x"}',
          uuid: 'u-tc',
        } as unknown as SDKMessage,
        {
          type: 'tool_result',
          toolCallId: 'tc-flk-1',
          content: 'ok',
          isError: false,
          uuid: 'u-tr',
        } as unknown as SDKMessage,
        { type: 'assistant', content: 'done', uuid: 'u-a-2' } as unknown as SDKMessage,
        {
          type: 'result',
          success: true,
          durationMs: 50,
          conversationId: null,
        } as SDKMessage,
      ];

      const frames = await runScriptedTurn(ctx, script, { progressive: true });

      const sessionInit = frames.find((f) => f.type === 'session_init')!;
      const expectedConvId = (sessionInit as { conversation_id?: string }).conversation_id;
      expect(expectedConvId).toBeTruthy();

      // Every stream-event frame must carry conversation_id that matches
      // the active session.
      const streamFrames = frames.filter((f) => f.type === 'stream');
      expect(streamFrames.length).toBeGreaterThan(0);
      for (const f of streamFrames) {
        expect((f as { conversation_id?: string }).conversation_id).toBe(expectedConvId);
      }

      // The terminal result still carries it too.
      const result = frames[frames.length - 1]!;
      expect(result.type).toBe('result');
      expect((result as { conversation_id?: string }).conversation_id).toBe(expectedConvId);
    } finally {
      await ctx.stop();
    }
  });

  it('forwards a conversation_swap event with old + new ids and re-tags subsequent frames', async () => {
    // Repro of the production symptom: SDK signals a conversation swap
    // mid-turn (in production this comes from the manager's recovery
    // branch; in this test we put it directly into the script and the
    // fake mirrors the real manager's "update getInfo's conversationId"
    // side-effect). The wire output must:
    //   1. Show every frame BEFORE the swap tagged with the original
    //      conversation_id (the one from session_init).
    //   2. Emit a `conversation_swap` stream frame carrying both ids.
    //   3. Show every frame AFTER the swap tagged with the new
    //      conversation_id.
    const ctx = await startHarness({ coalesce: false, partialJson: false });
    try {
      const NEW_CONV = 'conv-recovered-12345678';
      const script: SDKMessage[] = [
        { type: 'assistant', content: 'pre-swap ', uuid: 'u-pre' } as unknown as SDKMessage,
        {
          type: 'conversation_swap',
          oldConversationId: 'unused-test-fixture',
          newConversationId: NEW_CONV,
          agentId: 'agent-flk-1',
        } as unknown as SDKMessage,
        { type: 'assistant', content: 'post-swap', uuid: 'u-post' } as unknown as SDKMessage,
        {
          type: 'result',
          success: true,
          durationMs: 50,
          conversationId: NEW_CONV,
        } as SDKMessage,
      ];

      const frames = await runScriptedTurn(ctx, script);

      const sessionInit = frames.find((f) => f.type === 'session_init')!;
      const originalConvId = (sessionInit as { conversation_id?: string }).conversation_id!;

      // Find the swap frame.
      const swapFrame = frames.find(
        (f) => f.type === 'stream' && f.event === 'conversation_swap',
      );
      expect(swapFrame).toBeDefined();
      expect((swapFrame as { new_conversation_id?: string }).new_conversation_id).toBe(NEW_CONV);
      // old_conversation_id should be the value the manager captured at
      // recovery time. The fake passes through whatever was in the
      // script step, so we just verify the field is present.
      expect(
        Object.prototype.hasOwnProperty.call(swapFrame, 'old_conversation_id'),
      ).toBe(true);
      // The swap frame itself carries conversation_id = the new id.
      expect((swapFrame as { conversation_id?: string }).conversation_id).toBe(NEW_CONV);

      const swapIdx = frames.indexOf(swapFrame!);
      const before = frames.slice(0, swapIdx);
      const after = frames.slice(swapIdx + 1);

      // Pre-swap stream frames are tagged with the original conversation id.
      const preSwapStream = before.filter((f) => f.type === 'stream');
      expect(preSwapStream.length).toBeGreaterThan(0);
      for (const f of preSwapStream) {
        expect((f as { conversation_id?: string }).conversation_id).toBe(originalConvId);
      }

      // Post-swap stream frames are tagged with the new conversation id.
      const postSwapStream = after.filter((f) => f.type === 'stream');
      expect(postSwapStream.length).toBeGreaterThan(0);
      for (const f of postSwapStream) {
        expect((f as { conversation_id?: string }).conversation_id).toBe(NEW_CONV);
      }

      // The terminal result also reflects the new conversation id.
      const result = frames[frames.length - 1]!;
      expect(result.type).toBe('result');
      expect((result as { conversation_id?: string }).conversation_id).toBe(NEW_CONV);
    } finally {
      await ctx.stop();
    }
  });
});

// --- helpers used only by the cancel/disconnect block --------------------

async function waitFor<T>(
  source: T[],
  predicate: (item: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // Poll the array because vitest doesn't have a built-in observable.
  while (Date.now() < deadline) {
    const hit = source.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms; source length=${source.length}`);
}

async function waitUntil(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

// --- letta-mobile-w2hx.2: protocol v2 — conversation_id-driven session_start ---

describe('ws-gateway protocol v2: conversation_id-driven session_start (w2hx.2)', () => {
  /**
   * Build a stub resolver that exposes the same shape `WsGateway` consumes
   * (`resolve` + `prime`). We don't need the full LRU here — just a map.
   */
  function stubResolver(map: Record<string, string | null>) {
    const calls: string[] = [];
    let primeCalls: Array<{ conv: string; agent: string }> = [];
    return {
      calls,
      primeCalls,
      stub: {
        async resolve(convId: string): Promise<string | null> {
          calls.push(convId);
          if (!(convId in map)) return null;
          return map[convId] ?? null;
        },
        prime(conv: string, agent: string): void {
          primeCalls.push({ conv, agent });
        },
        // The other methods are unused in these tests — stub them out so the
        // structural type-check passes without us pulling in the real class.
        invalidate() {},
        clear() {},
        stats() {
          return { size: 0, hits: 0, misses: 0, negativeHits: 0, evictions: 0 };
        },
      } as unknown as ConstructorParameters<typeof WsGateway>[0]['conversationResolver'],
    };
  }

  async function readFrame(ws: WebSocket): Promise<ServerFrame> {
    return await new Promise<ServerFrame>((resolve, reject) => {
      const onMsg = (data: Buffer) => {
        ws.off('message', onMsg);
        ws.off('error', onErr);
        try {
          resolve(JSON.parse(data.toString()) as ServerFrame);
        } catch (e) {
          reject(e);
        }
      };
      const onErr = (e: Error) => {
        ws.off('message', onMsg);
        reject(e);
      };
      ws.on('message', onMsg);
      ws.once('error', onErr);
    });
  }

  it('session_start with conversation_id only resolves agent_id server-side', async () => {
    const r = stubResolver({ 'conv-abc': 'agent-x' });
    const ctx = await startHarness({
      coalesce: false,
      partialJson: false,
      conversationResolver: r.stub,
    });
    try {
      const ws = await connectClient(ctx);
      ws.send(JSON.stringify({ type: 'session_start', conversation_id: 'conv-abc' }));
      const init = await readFrame(ws);

      expect(init.type).toBe('session_init');
      expect(init.agent_id).toBe('agent-x');
      expect(init.conversation_id).toBeTruthy();
      expect(r.calls).toEqual(['conv-abc']);

      ws.close();
    } finally {
      await ctx.stop();
    }
  });

  it('session_start with neither agent_id nor conversation_id is rejected', async () => {
    const r = stubResolver({});
    const ctx = await startHarness({
      coalesce: false,
      partialJson: false,
      conversationResolver: r.stub,
    });
    try {
      const ws = await connectClient(ctx);
      ws.send(JSON.stringify({ type: 'session_start' }));
      const err = await readFrame(ws);

      expect(err.type).toBe('error');
      expect(err.code).toBe('BAD_MESSAGE');
      expect(String(err.message)).toMatch(/agent_id.*conversation_id/i);
      expect(r.calls).toEqual([]); // resolver should not be called

      ws.close();
    } finally {
      await ctx.stop();
    }
  });

  it('session_start with unknown conversation_id is rejected with BAD_MESSAGE', async () => {
    const r = stubResolver({}); // empty: every lookup returns null
    const ctx = await startHarness({
      coalesce: false,
      partialJson: false,
      conversationResolver: r.stub,
    });
    try {
      const ws = await connectClient(ctx);
      ws.send(
        JSON.stringify({ type: 'session_start', conversation_id: 'conv-missing' }),
      );
      const err = await readFrame(ws);

      expect(err.type).toBe('error');
      expect(err.code).toBe('BAD_MESSAGE');
      expect(String(err.message)).toMatch(/not found/i);

      ws.close();
    } finally {
      await ctx.stop();
    }
  });

  it('session_start with both agent_id and matching conversation_id succeeds (back-compat)', async () => {
    const r = stubResolver({ 'conv-abc': 'agent-x' });
    const ctx = await startHarness({
      coalesce: false,
      partialJson: false,
      conversationResolver: r.stub,
    });
    try {
      const ws = await connectClient(ctx);
      ws.send(
        JSON.stringify({
          type: 'session_start',
          agent_id: 'agent-x',
          conversation_id: 'conv-abc',
        }),
      );
      const init = await readFrame(ws);

      expect(init.type).toBe('session_init');
      expect(init.agent_id).toBe('agent-x');

      ws.close();
    } finally {
      await ctx.stop();
    }
  });

  it('session_start with mismatched agent_id and conversation_id is rejected', async () => {
    const r = stubResolver({ 'conv-abc': 'agent-x' });
    const ctx = await startHarness({
      coalesce: false,
      partialJson: false,
      conversationResolver: r.stub,
    });
    try {
      const ws = await connectClient(ctx);
      ws.send(
        JSON.stringify({
          type: 'session_start',
          agent_id: 'agent-y', // wrong agent for this conv
          conversation_id: 'conv-abc',
        }),
      );
      const err = await readFrame(ws);

      expect(err.type).toBe('error');
      expect(err.code).toBe('BAD_MESSAGE');
      expect(String(err.message)).toMatch(/belongs to agent agent-x/);

      ws.close();
    } finally {
      await ctx.stop();
    }
  });

  it('session_start with agent_id only still works (legacy)', async () => {
    const r = stubResolver({});
    const ctx = await startHarness({
      coalesce: false,
      partialJson: false,
      conversationResolver: r.stub,
    });
    try {
      const ws = await connectClient(ctx);
      ws.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-z' }));
      const init = await readFrame(ws);

      expect(init.type).toBe('session_init');
      expect(init.agent_id).toBe('agent-z');
      // Resolver should NOT be called when only agent_id is supplied — there
      // is nothing to look up.
      expect(r.calls).toEqual([]);

      ws.close();
    } finally {
      await ctx.stop();
    }
  });

  it('message frame with mismatched conversation_id is rejected', async () => {
    const r = stubResolver({});
    const ctx = await startHarness({
      coalesce: false,
      partialJson: false,
      conversationResolver: r.stub,
    });
    try {
      const ws = await connectClient(ctx);
      ws.send(JSON.stringify({ type: 'session_start', agent_id: 'agent-z' }));
      const init = await readFrame(ws);
      const realConvId = init.conversation_id as string;

      ws.send(
        JSON.stringify({
          type: 'message',
          content: 'hi',
          request_id: 'r-1',
          conversation_id: 'conv-totally-different',
        }),
      );
      const err = await readFrame(ws);

      expect(err.type).toBe('error');
      expect(err.code).toBe('BAD_MESSAGE');
      expect(String(err.message)).toMatch(/does not match active session/);
      expect(err.request_id).toBe('r-1');
      expect(realConvId).toBeTruthy();

      ws.close();
    } finally {
      await ctx.stop();
    }
  });
});
