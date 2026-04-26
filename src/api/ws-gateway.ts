/**
 * WebSocket Gateway for multi-agent streaming.
 *
 * Standalone WS server that creates independent letta-code-sdk sessions
 * per connection. No dependency on the bot's channel system.
 *
 * Protocol: see docs/prd/lettabot-ws-gateway.md
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import crypto from 'crypto';
import { validateApiKey } from './auth.js';
import { AgentSessionManager, SessionBusyError } from './agent-session-manager.js';
import type { SDKMessage, SendMessage, MessageContentItem } from '@letta-ai/letta-code-sdk';
import { createLogger } from '../logger.js';
import { maybeGenerateConversationTitle } from '../services/conversation-title.js';
import {
  BotStreamCoalescer,
  DEFAULT_COALESCE_WINDOW_MS,
  type StreamFrame,
} from './bot-stream-coalescer.js';
import { PartialJsonSnapshotEmitter } from './partial-json-snapshot-emitter.js';

const log = createLogger('WsGateway');

// --- Wire protocol types ---

interface SessionStartMsg {
  type: 'session_start';
  agent_id: string;
  conversation_id?: string;
  force_new?: boolean;
}

interface ClientMessage {
  type: 'message';
  content: string;
  request_id?: string;
  /** Optional originating channel metadata (e.g., from Matrix bridge) */
  source?: {
    channel: string;
    chatId: string;
  };
}

interface AbortMsg {
  type: 'abort';
  request_id?: string;
}

interface SessionCloseMsg {
  type: 'session_close';
}

type ClientPayload = SessionStartMsg | ClientMessage | AbortMsg | SessionCloseMsg;

interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

// --- Error codes ---

const ErrorCode = {
  AUTH_FAILED: 'AUTH_FAILED',
  BAD_MESSAGE: 'BAD_MESSAGE',
  NO_SESSION: 'NO_SESSION',
  SESSION_BUSY: 'SESSION_BUSY',
  SESSION_INIT_FAILED: 'SESSION_INIT_FAILED',
  STREAM_ERROR: 'STREAM_ERROR',
} as const;

// --- Gateway ---

export interface WsGatewayOptions {
  apiKey: string;
  path?: string;
  maxConnections?: number;
  pingIntervalMs?: number;
  sessionManager?: AgentSessionManager;
  onSourceUpdate?: (source: { channel: string; chatId: string }) => void;
  onConversationUpdate?: (agentId: string, conversationId: string) => void;
}

const WS_PATH = '/api/v1/agent-gateway';
const MAX_CONNECTIONS = 100;
const PING_INTERVAL_MS = 30_000;

/**
 * Resolve the stream coalescer config from env. **Enabled by default** as of
 * lettabot-aie.6 (after letta-mobile shipped the wucn-scope fix in aie.7).
 * Set `LETTABOT_COALESCE_ENABLED=0` (or `false`) as a kill switch if a
 * regression is observed; the kill switch is retained for two release
 * cycles per the rollout plan in
 * docs/architecture/bot-stream-coalescer.md §5, then removed via
 * lettabot-qs5.
 *
 * Knobs:
 *   - LETTABOT_COALESCE_ENABLED: '0' | 'false' to disable (default: on)
 *   - LETTABOT_COALESCE_WINDOW_MS: positive integer (default: 200)
 */
function readCoalesceConfig(): { enabled: boolean; windowMs: number } {
  const raw = process.env.LETTABOT_COALESCE_ENABLED;
  // Opt-out form: only explicit '0' or 'false' disables. Unset, '1', 'true',
  // or any other value → enabled (default-on).
  const enabled = raw !== '0' && raw !== 'false';
  const windowRaw = process.env.LETTABOT_COALESCE_WINDOW_MS;
  let windowMs = DEFAULT_COALESCE_WINDOW_MS;
  if (windowRaw) {
    const parsed = Number.parseInt(windowRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) windowMs = parsed;
  }
  return { enabled, windowMs };
}

/**
 * Resolve the partial-JSON tool_call config from env. **Enabled by
 * default** as of lettabot-uww.6 (after letta-mobile UI verification
 * in uww.5 confirmed progressive tool cards render correctly on
 * Pixel 2XL). Set `LETTABOT_PARTIAL_JSON_ENABLED=0` (or `false`) as
 * a kill switch if a regression is observed; the kill switch is
 * retained for two release cycles per the rollout plan in
 * docs/architecture/partial-json-tool-args.md §6, then removed
 * along with the legacy single-frame fallback in a follow-up bead.
 *
 * When enabled, the gateway emits a fresh `tool_call` snapshot on
 * every structurally-distinct parse-extension during streaming, with
 * `status='running'` while the args are still arriving and
 * `status='completed'` on the final emit. The BotStreamCoalescer's
 * replace-by-id rule absorbs the per-byte snapshot noise.
 *
 * When disabled the gateway uses the bespoke accumulator that emits
 * a single tool_call frame per call, after the full args buffer has
 * been received (legacy behavior).
 *
 * Knobs:
 *   - LETTABOT_PARTIAL_JSON_ENABLED: '0' | 'false' to disable (default: on)
 */
function readPartialJsonConfig(): { enabled: boolean } {
  const raw = process.env.LETTABOT_PARTIAL_JSON_ENABLED;
  // Opt-out form: only explicit '0' or 'false' disables. Unset, '1', 'true',
  // or any other value → enabled (default-on).
  const enabled = raw !== '0' && raw !== 'false';
  return { enabled };
}

export class WsGateway {
  private wss: WebSocketServer;
  private sessions: AgentSessionManager;
  private connectionIds = new Map<WebSocket, string>();
  /** Per-connection coalescer; absent when LETTABOT_COALESCE_ENABLED is off. */
  private coalescers = new Map<WebSocket, BotStreamCoalescer>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly apiKey: string;
  private readonly path: string;
  private readonly maxConnections: number;
  private readonly onSourceUpdate?: (source: { channel: string; chatId: string }) => void;
  private readonly coalesceConfig: { enabled: boolean; windowMs: number };
  private readonly partialJsonConfig: { enabled: boolean };

  constructor(options: WsGatewayOptions) {
    this.apiKey = options.apiKey;
    this.path = options.path ?? WS_PATH;
    this.maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
    this.sessions = options.sessionManager ?? new AgentSessionManager({
      onConversationUpdate: options.onConversationUpdate,
    });
    this.onSourceUpdate = options.onSourceUpdate;
    this.coalesceConfig = readCoalesceConfig();
    this.partialJsonConfig = readPartialJsonConfig();

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.wss.on('connection', (ws) => this.onConnection(ws));

    const pingMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => this.pingAll(), pingMs);
    this.pingTimer.unref?.();

    log.info(
      `WebSocket gateway ready on ${this.path}` +
        (this.coalesceConfig.enabled
          ? ` (stream coalescer ON, window=${this.coalesceConfig.windowMs}ms)`
          : ' (stream coalescer OFF)') +
        (this.partialJsonConfig.enabled
          ? ' (partial-JSON tool_call ON)'
          : ' (partial-JSON tool_call OFF)'),
    );
  }

  /**
   * Call from http.Server 'upgrade' event.
   * Returns true if this request was handled (path matched).
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== this.path) return false;

    if (!validateApiKey(req.headers, this.apiKey)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return true;
    }

    if (this.wss.clients.size >= this.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return true;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
    return true;
  }

  async shutdown(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    await this.sessions.shutdown();
    for (const coalescer of this.coalescers.values()) {
      coalescer.dispose();
    }
    this.coalescers.clear();
    for (const ws of this.wss.clients) {
      ws.terminate();
    }
    this.wss.close();
  }

  get connectionCount(): number {
    return this.wss.clients.size;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Abort all in-flight gateway requests for a given agent */
  async abortByAgentId(agentId: string): Promise<number> {
    return this.sessions.abortByAgentId(agentId);
  }

  /** List all agent IDs tracked in the gateway conversation store */
  listTrackedAgentIds(): string[] {
    return this.sessions.listTrackedAgentIds();
  }

  /** Remove orphaned agents from the gateway conversation store */
  removeOrphanedAgents(agentIds: string[]): string[] {
    return this.sessions.removeOrphanedAgents(agentIds);
  }

  /** Broadcast a system event to all connected WS clients */
  broadcastSystemEvent(event: { type: string; [key: string]: unknown }): void {
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, event);
      }
    }
  }

  // --- connection handling ---

  private onConnection(ws: WebSocket): void {
    const connId = crypto.randomUUID();
    this.connectionIds.set(ws, connId);

    if (this.coalesceConfig.enabled) {
      this.coalescers.set(
        ws,
        new BotStreamCoalescer({
          windowMs: this.coalesceConfig.windowMs,
          onFlush: (frame) => this.send(ws, frame),
        }),
      );
    }

    log.info(`Connection opened: ${connId.slice(0, 8)}...`);

    ws.on('message', (data) => {
      this.onMessage(ws, connId, data).catch((err) => {
        log.error(`Unhandled error on ${connId.slice(0, 8)}:`, err);
        this.sendError(ws, ErrorCode.STREAM_ERROR, String(err));
      });
    });

    ws.on('close', () => {
      log.info(`Connection closed: ${connId.slice(0, 8)}...`);
      this.connectionIds.delete(ws);
      const coalescer = this.coalescers.get(ws);
      if (coalescer) {
        coalescer.dispose();
        this.coalescers.delete(ws);
      }
      this.sessions.close(connId).catch(() => {});
    });

    ws.on('error', (err) => {
      log.error(`WS error on ${connId.slice(0, 8)}:`, err.message);
    });

    ws.on('pong', () => {
      // Connection is alive — lastActivity tracked by session manager
    });
  }

  private async onMessage(ws: WebSocket, connId: string, raw: unknown): Promise<void> {
    let payload: ClientPayload;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      this.sendError(ws, ErrorCode.BAD_MESSAGE, 'Invalid JSON');
      return;
    }

    if (!payload || typeof payload !== 'object' || !('type' in payload)) {
      this.sendError(ws, ErrorCode.BAD_MESSAGE, 'Missing "type" field');
      return;
    }

    switch (payload.type) {
      case 'session_start':
        await this.handleSessionStart(ws, connId, payload as SessionStartMsg);
        break;
      case 'message':
        await this.handleClientMessage(ws, connId, payload as ClientMessage);
        break;
      case 'abort': {
        await this.sessions.abort(connId);
        // Drop any buffered output for the aborted request — sending stale
        // partial text after the user cancelled would be wrong.
        const abortRequestId = (payload as { request_id?: string }).request_id;
        const coalescer = this.coalescers.get(ws);
        coalescer?.flushAndDiscard(abortRequestId);
        // Send a synthetic result so the client's stream loop terminates
        this.send(ws, {
          type: 'result',
          success: false,
          aborted: true,
          request_id: abortRequestId,
        });
        break;
      }
      case 'session_close':
        await this.sessions.close(connId);
        break;
      default:
        this.sendError(ws, ErrorCode.BAD_MESSAGE, `Unknown type: ${(payload as { type: string }).type}`);
    }
  }

  private async handleSessionStart(ws: WebSocket, connId: string, msg: SessionStartMsg): Promise<void> {
    if (!msg.agent_id) {
      this.sendError(ws, ErrorCode.BAD_MESSAGE, 'Missing agent_id');
      return;
    }

    try {
      const init = await this.sessions.open(connId, msg.agent_id, msg.conversation_id, msg.force_new);
      this.send(ws, {
        type: 'session_init',
        agent_id: init.agentId,
        conversation_id: init.conversationId,
        session_id: init.sessionId,
      });
    } catch (err) {
      this.sendError(ws, ErrorCode.SESSION_INIT_FAILED, String(err));
    }
  }

  /**
   * Try to parse a JSON string as a multimodal MessageContentItem[].
   * Returns the parsed array if valid, otherwise null (treat as plain text).
   *
   * A valid multimodal message is a JSON array where every element has
   * a `type` field that is either "text" or "image".
   */
  private parseMultimodalContent(content: string): MessageContentItem[] | null {
    // Quick checks to avoid JSON.parse overhead on plain text messages
    const trimmed = content.trimStart();
    if (!trimmed.startsWith('[')) return null;

    try {
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;

      // Validate: every element must have a recognized type
      const isValid = parsed.every(
        (item: unknown) =>
          typeof item === 'object' && item !== null &&
          'type' in item &&
          ((item as { type: string }).type === 'text' || (item as { type: string }).type === 'image')
      );
      if (!isValid) return null;

      log.info(`Parsed multimodal content: ${parsed.length} part(s) (${parsed.filter((i: { type: string }) => i.type === 'image').length} image(s))`);
      return parsed as MessageContentItem[];
    } catch {
      return null;
    }
  }

  private async handleClientMessage(ws: WebSocket, connId: string, msg: ClientMessage): Promise<void> {
    if (!this.sessions.has(connId)) {
      this.sendError(ws, ErrorCode.NO_SESSION, 'Send session_start first', msg.request_id);
      return;
    }

    if (!msg.content) {
      this.sendError(ws, ErrorCode.BAD_MESSAGE, 'Missing content', msg.request_id);
      return;
    }

    if (msg.source?.channel && msg.source?.chatId && this.onSourceUpdate) {
      this.onSourceUpdate(msg.source);
    }

    // Detect multimodal content: the Matrix bridge JSON-serializes
    // MessageContentItem[] arrays as the content string.  Parse them
    // back so the SDK receives proper inline images.
    const messageToSend: SendMessage = this.parseMultimodalContent(msg.content) ?? msg.content;

    try {
      // --- Tool call accumulation ---
      // The SDK streams tool_call events token-by-token as arguments are generated,
      // so a single tool call produces many wire events with the same toolCallId but
      // progressively more complete arguments. We buffer them and flush a single
      // complete tool_call when the next semantic event type arrives (mirroring the
      // bot's session-manager dedupedStream pattern).
      const pendingToolCalls = new Map<string, { msg: SDKMessage; accumulatedArgs: string }>();
      let lastPendingToolCallId: string | null = null;
      let anonToolCallCounter = 0;
      // Track toolCallId → toolName so we can enrich tool_result events
      // (SDK tool_result only carries toolCallId, not toolName)
      const toolNameMap = new Map<string, string>();

      // --- Partial-JSON tool_call snapshot tracking (lettabot-uww) ---
      // When `partialJsonConfig.enabled` is true, we emit a fresh tool_call
      // snapshot on every structurally-distinct parse-extension during
      // streaming (status='running'), then a final snapshot on type
      // boundary (status='completed'). The emitter encapsulates the
      // per-id buffer + parser + dedupe; see partial-json-snapshot-emitter.ts.
      const partialJsonEnabled = this.partialJsonConfig.enabled;
      const snapshotEmitter = partialJsonEnabled
        ? new PartialJsonSnapshotEmitter({
            onSnapshot: (emission) => {
              const pending = pendingToolCalls.get(emission.id);
              if (!pending) return; // race: cleared mid-flight
              const enriched = buildToolCallMessage(
                pending.msg,
                emission.value,
                emission.rawArgs,
              );
              const tcName = (enriched as { toolName?: string }).toolName;
              const tcId = (enriched as { toolCallId?: string }).toolCallId;
              if (tcName && tcId) {
                toolNameMap.set(tcId, tcName);
              }
              this.forwardStreamEvent(
                ws,
                connId,
                enriched,
                msg.request_id,
                toolNameMap,
                emission.status,
              );
            },
            logWarning: (m) => log.warn(m),
          })
        : null;

      /** Merge tool argument strings, handling both delta and cumulative chunking. */
      const mergeToolArgs = (existing: string, incoming: string): string => {
        if (!incoming) return existing;
        if (!existing) return incoming;
        if (incoming === existing) return existing;
        // Cumulative: latest chunk includes all prior text
        if (incoming.startsWith(existing)) return incoming;
        if (existing.endsWith(incoming)) return existing;
        // Delta: each chunk is an append
        return `${existing}${incoming}`;
      };

      /**
       * Build a tool_call SDK message envelope with the given parsed args.
       * If parser produced an empty object but we have raw text, fall
       * back to the raw-wrapped value so the client can at least render
       * something (matches legacy behavior on JSON.parse failure).
       */
      const buildToolCallMessage = (
        base: SDKMessage,
        parsedArgs: Record<string, unknown>,
        rawFallback: string,
      ): SDKMessage => {
        const toolInput =
          Object.keys(parsedArgs).length === 0 && rawFallback
            ? { raw: rawFallback }
            : parsedArgs;
        return { ...base, toolInput } as SDKMessage;
      };

      /** Flush buffered tool calls with fully accumulated arguments. */
      const flushPendingToolCalls = () => {
        if (partialJsonEnabled && snapshotEmitter) {
          // Partial-JSON path: emit terminal `completed` snapshot per id
          // via the emitter. The coalescer's replace-by-id rule causes
          // this terminal frame to overwrite any in-flight running
          // snapshot on the wire.
          for (const id of pendingToolCalls.keys()) {
            snapshotEmitter.finalize(id);
          }
          snapshotEmitter.clear();
        } else {
          // --- Legacy path (flag off): emit one frame per call. ---
          for (const [, pending] of pendingToolCalls) {
            let toolInput: Record<string, unknown> = {};
            if (pending.accumulatedArgs) {
              try { toolInput = JSON.parse(pending.accumulatedArgs); }
              catch { toolInput = { raw: pending.accumulatedArgs }; }
            } else {
              // No rawArguments — use the original toolInput from the first chunk
              toolInput = ((pending.msg as { toolInput?: Record<string, unknown> }).toolInput) ?? {};
            }
            const enriched = { ...pending.msg, toolInput } as SDKMessage;
            const tcName = (enriched as { toolName?: string }).toolName;
            const tcId = (enriched as { toolCallId?: string }).toolCallId;
            if (tcName && tcId) {
              toolNameMap.set(tcId, tcName);
            }
            this.forwardStreamEvent(ws, connId, enriched, msg.request_id, toolNameMap);
          }
        }
        pendingToolCalls.clear();
        lastPendingToolCallId = null;
      };

      // Buffer assistant text to detect <no-reply/> marker.
      // Tokens arrive one-by-one, so we accumulate and only forward once
      // we're sure it's not a no-reply suppression. (mirrors bot.ts mayBeHidden logic)
      let assistantBuffer = '';
      let streamConversationId: string | null = null;
      const bufferedEvents: Array<{ content: string; uuid?: string }> = [];

      const flushAssistantBuffer = () => {
        for (const ev of bufferedEvents) {
          this.sendStream(ws, { type: 'stream', event: 'assistant', content: ev.content, uuid: ev.uuid, request_id: msg.request_id });
        }
        bufferedEvents.length = 0;
      };

      for await (const event of this.sessions.sendAndStream(connId, messageToSend)) {
        // --- Tool call accumulation ---
        if (event.type === 'tool_call') {
          const tc = event as import('@letta-ai/letta-code-sdk').SDKToolCallMessage;
          let id: string | undefined = tc.toolCallId;
          if (!id) {
            // Tool calls without IDs — assign synthetic or merge with current pending
            const currentPending = lastPendingToolCallId ? pendingToolCalls.get(lastPendingToolCallId) : null;
            if (lastPendingToolCallId && currentPending && (((currentPending.msg as any).toolName) || 'unknown') === (tc.toolName || 'unknown')) {
              id = lastPendingToolCallId;
            } else {
              id = `__anon_${++anonToolCallCounter}__`;
            }
          }
          const incoming = tc.rawArguments || '';
          const existing = pendingToolCalls.get(id);
          if (existing) {
            existing.accumulatedArgs = mergeToolArgs(existing.accumulatedArgs, incoming);
          } else {
            pendingToolCalls.set(id, { msg: event, accumulatedArgs: incoming });
          }
          lastPendingToolCallId = id;

          // Partial-JSON path: feed the fragment into the snapshot
          // emitter. The emitter parses+dedupes+emits internally; the
          // BotStreamCoalescer (when on) collapses these per-id by
          // replace-by-id, so we can emit liberally without flooding
          // the wire.
          if (partialJsonEnabled && snapshotEmitter) {
            snapshotEmitter.appendArgs(id, incoming);
          }
          continue; // buffer, don't forward yet (legacy) — or already
                    // emitted as a snapshot above (partial-JSON path)
        }

        // Flush pending tool calls on semantic type boundary
        if (pendingToolCalls.size > 0 && event.type !== 'stream_event') {
          flushPendingToolCalls();
        }

        // Buffer assistant events to detect and suppress <no-reply/>
        if (event.type === 'assistant') {
          if (this.isInternalMessage(event.content)) continue;
          assistantBuffer += event.content ?? '';
          const trimmed = assistantBuffer.trim();
          const mayBeNoReply = '<no-reply/>'.startsWith(trimmed);

          if (mayBeNoReply) {
            // Could still become <no-reply/> — hold it
            bufferedEvents.push({ content: event.content, uuid: event.uuid });
          } else {
            // Definitely not <no-reply/> — flush everything we held back, then forward normally
            flushAssistantBuffer();
            this.sendStream(ws, { type: 'stream', event: 'assistant', content: event.content, uuid: event.uuid, request_id: msg.request_id });
          }
        } else {
          // Non-assistant events flush the buffer (tool calls break the no-reply pattern)
          if (bufferedEvents.length > 0) {
            flushAssistantBuffer();
          }
          // Capture conversation ID from result event for title generation
          if (event.type === 'result' && (event as { conversationId?: string }).conversationId) {
            streamConversationId = (event as { conversationId?: string }).conversationId!;
          }
          this.forwardStreamEvent(ws, connId, event, msg.request_id, toolNameMap);
        }
      }

      // Flush any remaining buffered tool calls at stream end
      if (pendingToolCalls.size > 0) {
        flushPendingToolCalls();
      }

      // After stream ends: suppress if final text was exactly <no-reply/>
      if (assistantBuffer.trim() === '<no-reply/>') {
        log.info(`Suppressed <no-reply/> for connection ${connId.slice(0, 8)}`);
        // Don't flush — discard the buffered events from the no-reply guard.
        // Anything pending in the coalescer for this request is also stale,
        // so drop it without emitting.
        const coalescer = this.coalescers.get(ws);
        coalescer?.flushAndDiscard(msg.request_id);
      } else if (bufferedEvents.length > 0) {
        // Partial match that never completed (e.g. "<no-r" then stream ended) — flush it
        flushAssistantBuffer();
      }

      // Belt-and-braces: drain any remaining coalescer entries so nothing
      // sits buffered after the request stream completes (covers SDK-side
      // edge cases where a 'result' event isn't emitted).
      this.flushCoalescerFor(ws, msg.request_id);

      // Fire-and-forget: generate conversation title from first exchange
      const userText = typeof messageToSend === 'string' ? messageToSend : msg.content;
      if (streamConversationId && userText && assistantBuffer.trim() && assistantBuffer.trim() !== '<no-reply/>') {
        maybeGenerateConversationTitle(streamConversationId, userText, assistantBuffer.trim())
          .catch(err => log.warn('Conversation title generation failed:', err instanceof Error ? err.message : err));
      }
    } catch (err) {
      if (err instanceof SessionBusyError) {
        this.sendError(ws, ErrorCode.SESSION_BUSY, err.message, msg.request_id);
      } else {
        this.sendError(ws, ErrorCode.STREAM_ERROR, String(err), msg.request_id);
      }
    }
  }

  // --- outbound helpers ---

  private forwardStreamEvent(
    ws: WebSocket,
    connId: string,
    msg: SDKMessage,
    requestId?: string,
    toolNameMap?: Map<string, string>,
    /** Partial-JSON tool_call status. Wire-additive; undefined for legacy single-emit path. */
    toolCallStatus?: 'running' | 'completed',
  ): void {
    switch (msg.type) {
      case 'assistant':
        if (this.isInternalMessage(msg.content)) break;
        this.sendStream(ws, { type: 'stream', event: 'assistant', content: msg.content, uuid: msg.uuid, request_id: requestId });
        break;
      case 'tool_call': {
        // Include toolInput so clients can display tool call details
        const toolInput = (msg as { toolInput?: Record<string, unknown> }).toolInput ?? {};
        const frame: ServerEvent = {
          type: 'stream',
          event: 'tool_call',
          tool_name: msg.toolName,
          tool_call_id: msg.toolCallId,
          tool_input: toolInput,
          uuid: msg.uuid,
          request_id: requestId,
        };
        if (toolCallStatus) frame.status = toolCallStatus;
        this.sendStream(ws, frame);
        break;
      }
      case 'tool_result': {
        const resolvedToolName = (msg.toolCallId && toolNameMap?.get(msg.toolCallId)) ?? null;
        this.sendStream(ws, { type: 'stream', event: 'tool_result', content: msg.content, tool_call_id: msg.toolCallId, tool_name: resolvedToolName, is_error: msg.isError, uuid: msg.uuid, request_id: requestId });
        break;
      }
      case 'reasoning':
        this.sendStream(ws, { type: 'stream', event: 'reasoning', content: msg.content, uuid: msg.uuid, request_id: requestId });
        break;
      case 'result': {
        const info = this.sessions.getInfo(connId);
        // Route through coalescer so any pending text drains before the
        // terminal frame.  The coalescer recognizes type !== 'stream' as
        // pass-through-with-flush.
        this.sendStream(ws, {
          type: 'result',
          success: msg.success,
          conversation_id: msg.conversationId ?? info?.conversationId ?? null,
          request_id: requestId,
          duration_ms: msg.durationMs,
          ...(msg.error ? { error: msg.error } : {}),
        });
        break;
      }
    }
  }

  private isInternalMessage(content: string | undefined): boolean {
    if (!content) return false;
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"type"')) return false;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed?.type === 'system_alert' || parsed?.type === 'internal_monologue';
    } catch {
      return false;
    }
  }

  private send(ws: WebSocket, data: ServerEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /**
   * Route an outbound frame through the per-connection coalescer when enabled.
   * Falls back to direct send if the coalescer is disabled or absent.
   *
   * Stream events ('assistant', 'reasoning', 'tool_call', 'tool_result') get
   * coalesced per the rules in BotStreamCoalescer. Other event types
   * (`type === 'result'`, `type === 'error'`) are passed through but cause
   * the coalescer to flush any pending entries first, preserving order.
   */
  private sendStream(ws: WebSocket, data: ServerEvent): void {
    const coalescer = this.coalescers.get(ws);
    if (coalescer) {
      coalescer.handle(data as unknown as StreamFrame);
      return;
    }
    this.send(ws, data);
  }

  /** Flush any pending coalescer entries for `requestId` immediately. */
  private flushCoalescerFor(ws: WebSocket, requestId: string | undefined): void {
    const coalescer = this.coalescers.get(ws);
    if (!coalescer) return;
    coalescer.flushFor(requestId);
  }

  private sendError(ws: WebSocket, code: string, message: string, requestId?: string): void {
    // Errors are scoped to a request when one is supplied; route through the
    // coalescer so any pending stream output flushes first (preserving order).
    if (requestId) {
      this.sendStream(ws, { type: 'error', code, message, request_id: requestId });
    } else {
      this.send(ws, { type: 'error', code, message });
    }
  }

  private pingAll(): void {
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }
  }
}
