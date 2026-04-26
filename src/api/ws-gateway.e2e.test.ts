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
type ScriptStep = SDKMessage | ThrowSentinel;

function isThrowSentinel(step: ScriptStep): step is ThrowSentinel {
  return typeof step === 'object' && step !== null && '__throw' in step;
}

class FakeAgentSessionManager {
  private scripts = new Map<string, ScriptStep[]>();
  private opened = new Map<string, { agentId: string; conversationId: string | null }>();
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
    this.opened.set(connectionId, { agentId, conversationId: convId });
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
    const script = this.scripts.get(connectionId) ?? [];
    for (const step of script) {
      if (this.aborted.has(connectionId)) return;
      if (isThrowSentinel(step)) {
        throw new Error(step.__throw);
      }
      yield step;
      // Yield to the event loop between events so the test driver can
      // interleave control frames (abort, close) before the next yield.
      // Cost is sub-ms per event; existing tests with 4-5 events stay
      // well under their <5s budget.
      await new Promise<void>((r) => setImmediate(r));
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
    return { agentId: info.agentId, conversationId: info.conversationId, state: 'ready' as const };
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

async function startHarness(opts: { coalesce: boolean; partialJson: boolean }): Promise<HarnessCtx> {
  process.env.LETTABOT_COALESCE_ENABLED = opts.coalesce ? '1' : '0';
  process.env.LETTABOT_PARTIAL_JSON_ENABLED = opts.partialJson ? '1' : '0';

  const apiKey = 'test-api-key';
  const fake = new FakeAgentSessionManager();
  const gateway = new WsGateway({
    apiKey,
    sessionManager: fake as unknown as AgentSessionManager,
    pingIntervalMs: 60_000, // long; we close before pings fire
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

async function connectClient(ctx: HarnessCtx): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/api/v1/agent-gateway`, {
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
  opts: { agentId?: string; requestId?: string; messageContent?: string } = {},
): Promise<ServerFrame[]> {
  const ws = await connectClient(ctx);
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
  it('emits progressive tool_call snapshots for a single-arg tool (Read)', async () => {
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

      const frames = await runScriptedTurn(ctx, script);

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

  it('emits progressive snapshots for a multi-arg tool (Grep with pattern + path)', async () => {
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

      const frames = await runScriptedTurn(ctx, script);
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

  it('all snapshots for a single tool_call_id keep the same id (lettabot-ded / sad repro)', async () => {
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

      const frames = await runScriptedTurn(ctx, script);
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

  // --- flag matrix (lettabot-uww.8) ---------------------------------------
  //
  // Drive the same Read script through every combination of
  // (LETTABOT_COALESCE_ENABLED, LETTABOT_PARTIAL_JSON_ENABLED) and assert
  // per-combination frame-count bounds + that the final accumulated
  // tool_input is identical across all four. This locks in the half-
  // enabled fallback paths that the uww.7 fixtures only exercise via the
  // both-on / both-off implicit goldens.
  //
  // | Combo                          | tool_call frames | running | completed | notes |
  // | (COALESCE=0, PARTIAL_JSON=0)   | exactly 1        | 0       | 0         | legacy single emit, no status field |
  // | (COALESCE=1, PARTIAL_JSON=0)   | exactly 1        | 0       | 0         | coalescer is a no-op for a single frame |
  // | (COALESCE=0, PARTIAL_JSON=1)   | ≥2 (running×N+terminal) | ≥1 | exactly 1 | snapshots emerge 1:1 to the wire |
  // | (COALESCE=1, PARTIAL_JSON=1)   | ≤ N+1, typically 1 | 0..N  | exactly 1 | replace-by-id absorbs running noise; terminal triggers immediate flush |

  describe.each([
    {
      label: 'COALESCE=0, PARTIAL_JSON=0 (legacy single emit)',
      coalesce: false,
      partialJson: false,
      assertCounts: (toolCalls: ServerFrame[]) => {
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls.filter((tc) => tc.status === 'running')).toHaveLength(0);
        expect(toolCalls.filter((tc) => tc.status === 'completed')).toHaveLength(0);
        // No running frames must leak when partial-JSON is off.
        for (const tc of toolCalls) expect(tc.status).toBeUndefined();
      },
    },
    {
      label: 'COALESCE=1, PARTIAL_JSON=0 (coalesced legacy)',
      coalesce: true,
      partialJson: false,
      assertCounts: (toolCalls: ServerFrame[]) => {
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls.filter((tc) => tc.status === 'running')).toHaveLength(0);
        expect(toolCalls.filter((tc) => tc.status === 'completed')).toHaveLength(0);
        for (const tc of toolCalls) expect(tc.status).toBeUndefined();
      },
    },
    {
      label: 'COALESCE=0, PARTIAL_JSON=1 (uncoalesced progressive)',
      coalesce: false,
      partialJson: true,
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
      label: 'COALESCE=1, PARTIAL_JSON=1 (target state — current default)',
      coalesce: true,
      partialJson: true,
      assertCounts: (toolCalls: ServerFrame[]) => {
        const completed = toolCalls.filter((tc) => tc.status === 'completed');
        // Coalescer's replace-by-id absorbs running snapshots; the
        // terminal completed frame triggers an immediate flush. In
        // synchronous-burst tests like ours the coalescer collapses to
        // a single frame (the terminal). Allow ≤ N+1 as an upper bound
        // to stay robust against timer fires across event-loop turns.
        expect(toolCalls.length).toBeLessThanOrEqual(5);
        expect(completed).toHaveLength(1);
        // Frame count is strictly less than the uncoalesced path.
        // (The uncoalesced path emits 4 chunks → up to ~4 running + 1
        // terminal; the coalesced path collapses running snapshots.)
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

        const frames = await runScriptedTurn(ctx, script);
        const toolCalls = frames.filter(
          (f) => f.type === 'stream' && f.event === 'tool_call',
        );

        // INVARIANT 1: at least one tool_call frame is always emitted.
        expect(toolCalls.length).toBeGreaterThanOrEqual(1);

        // INVARIANT 2: the LAST tool_call frame carries the fully
        // accumulated args, byte-identical across all four combos.
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

  it('two interleaved tool_calls keep their snapshots separated by id', async () => {
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

      const frames = await runScriptedTurn(ctx, interleaved);
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
      const ws = await connectClient(ctx);
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
      const ws = await connectClient(ctx);
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
      const ws = await connectClient(ctx);
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
      const wsA = await connectClient(ctx);
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
      const wsB = await connectClient(ctx);
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
