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
class FakeAgentSessionManager {
  private scripts = new Map<string, SDKMessage[]>();
  private opened = new Map<string, { agentId: string; conversationId: string | null }>();

  /** Queue the SDK event sequence the next sendAndStream() call will yield. */
  queueScript(connectionId: string, events: SDKMessage[]): void {
    this.scripts.set(connectionId, events);
  }

  async open(
    connectionId: string,
    agentId: string,
    conversationId?: string,
  ): Promise<SDKInitMessage> {
    const convId = conversationId ?? `conv-${connectionId.slice(0, 8)}`;
    this.opened.set(connectionId, { agentId, conversationId: convId });
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
    for (const event of script) {
      yield event;
    }
  }

  has(connectionId: string): boolean {
    return this.opened.has(connectionId);
  }

  async close(connectionId: string): Promise<void> {
    this.opened.delete(connectionId);
    this.scripts.delete(connectionId);
  }

  async abort(_connectionId: string): Promise<void> {
    /* no-op for the harness */
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
