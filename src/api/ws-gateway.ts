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
import type { SDKMessage } from '@letta-ai/letta-code-sdk';
import { createLogger } from '../logger.js';

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

export class WsGateway {
  private wss: WebSocketServer;
  private sessions: AgentSessionManager;
  private connectionIds = new Map<WebSocket, string>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly apiKey: string;
  private readonly path: string;
  private readonly maxConnections: number;
  private readonly onSourceUpdate?: (source: { channel: string; chatId: string }) => void;

  constructor(options: WsGatewayOptions) {
    this.apiKey = options.apiKey;
    this.path = options.path ?? WS_PATH;
    this.maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
    this.sessions = options.sessionManager ?? new AgentSessionManager({
      onConversationUpdate: options.onConversationUpdate,
    });
    this.onSourceUpdate = options.onSourceUpdate;

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.wss.on('connection', (ws) => this.onConnection(ws));

    const pingMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => this.pingAll(), pingMs);
    this.pingTimer.unref?.();

    log.info(`WebSocket gateway ready on ${this.path}`);
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

  // --- connection handling ---

  private onConnection(ws: WebSocket): void {
    const connId = crypto.randomUUID();
    this.connectionIds.set(ws, connId);
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
      case 'abort':
        await this.sessions.abort(connId);
        // Send a synthetic result so the client's stream loop terminates
        this.send(ws, {
          type: 'result',
          success: false,
          aborted: true,
          request_id: (payload as { request_id?: string }).request_id,
        });
        break;
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

      /** Flush buffered tool calls with fully accumulated arguments. */
      const flushPendingToolCalls = () => {
        for (const [, pending] of pendingToolCalls) {
          let toolInput: Record<string, unknown> = {};
          if (pending.accumulatedArgs) {
            try { toolInput = JSON.parse(pending.accumulatedArgs); }
            catch { toolInput = { raw: pending.accumulatedArgs }; }
          } else {
            // No rawArguments — use the original toolInput from the first chunk
            toolInput = (pending.msg as any).toolInput ?? {};
          }
          const enriched = { ...pending.msg, toolInput } as SDKMessage;
          const tcName = (enriched as any).toolName as string | undefined;
          const tcId = (enriched as any).toolCallId as string | undefined;
          if (tcName && tcId) {
            toolNameMap.set(tcId, tcName);
          }
          this.forwardStreamEvent(ws, connId, enriched, msg.request_id, toolNameMap);
        }
        pendingToolCalls.clear();
        lastPendingToolCallId = null;
      };

      // Buffer assistant text to detect <no-reply/> marker.
      // Tokens arrive one-by-one, so we accumulate and only forward once
      // we're sure it's not a no-reply suppression. (mirrors bot.ts mayBeHidden logic)
      let assistantBuffer = '';
      const bufferedEvents: Array<{ content: string; uuid?: string }> = [];

      const flushAssistantBuffer = () => {
        for (const ev of bufferedEvents) {
          this.send(ws, { type: 'stream', event: 'assistant', content: ev.content, uuid: ev.uuid, request_id: msg.request_id });
        }
        bufferedEvents.length = 0;
      };

      for await (const event of this.sessions.sendAndStream(connId, msg.content)) {
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
          continue; // buffer, don't forward yet
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
            this.send(ws, { type: 'stream', event: 'assistant', content: event.content, uuid: event.uuid, request_id: msg.request_id });
          }
        } else {
          // Non-assistant events flush the buffer (tool calls break the no-reply pattern)
          if (bufferedEvents.length > 0) {
            flushAssistantBuffer();
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
        // Don't flush — discard the buffered events
      } else if (bufferedEvents.length > 0) {
        // Partial match that never completed (e.g. "<no-r" then stream ended) — flush it
        flushAssistantBuffer();
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

  private forwardStreamEvent(ws: WebSocket, connId: string, msg: SDKMessage, requestId?: string, toolNameMap?: Map<string, string>): void {
    switch (msg.type) {
      case 'assistant':
        if (this.isInternalMessage(msg.content)) break;
        this.send(ws, { type: 'stream', event: 'assistant', content: msg.content, uuid: msg.uuid, request_id: requestId });
        break;
      case 'tool_call': {
        // Include toolInput so clients can display tool call details
        const toolInput = (msg as any).toolInput ?? {};
        this.send(ws, { type: 'stream', event: 'tool_call', tool_name: msg.toolName, tool_call_id: msg.toolCallId, tool_input: toolInput, uuid: msg.uuid, request_id: requestId });
        break;
      }
      case 'tool_result': {
        const resolvedToolName = (msg.toolCallId && toolNameMap?.get(msg.toolCallId)) ?? null;
        this.send(ws, { type: 'stream', event: 'tool_result', content: msg.content, tool_call_id: msg.toolCallId, tool_name: resolvedToolName, is_error: msg.isError, uuid: msg.uuid, request_id: requestId });
        break;
      }
      case 'reasoning':
        this.send(ws, { type: 'stream', event: 'reasoning', content: msg.content, uuid: msg.uuid, request_id: requestId });
        break;
      case 'result': {
        const info = this.sessions.getInfo(connId);
        this.send(ws, {
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

  private sendError(ws: WebSocket, code: string, message: string, requestId?: string): void {
    this.send(ws, { type: 'error', code, message, ...(requestId ? { request_id: requestId } : {}) });
  }

  private pingAll(): void {
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }
  }
}
