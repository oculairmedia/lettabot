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

// --- Wire protocol types ---

interface SessionStartMsg {
  type: 'session_start';
  agent_id: string;
  conversation_id?: string;
}

interface ClientMessage {
  type: 'message';
  content: string;
  request_id?: string;
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

  constructor(options: WsGatewayOptions) {
    this.apiKey = options.apiKey;
    this.path = options.path ?? WS_PATH;
    this.maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
    this.sessions = options.sessionManager ?? new AgentSessionManager();

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.wss.on('connection', (ws) => this.onConnection(ws));

    const pingMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => this.pingAll(), pingMs);
    this.pingTimer.unref?.();

    console.log(`[Gateway] WebSocket gateway ready on ${this.path}`);
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

  // --- connection handling ---

  private onConnection(ws: WebSocket): void {
    const connId = crypto.randomUUID();
    this.connectionIds.set(ws, connId);
    console.log(`[Gateway] Connection opened: ${connId.slice(0, 8)}...`);

    ws.on('message', (data) => {
      this.onMessage(ws, connId, data).catch((err) => {
        console.error(`[Gateway] Unhandled error on ${connId.slice(0, 8)}:`, err);
        this.sendError(ws, ErrorCode.STREAM_ERROR, String(err));
      });
    });

    ws.on('close', () => {
      console.log(`[Gateway] Connection closed: ${connId.slice(0, 8)}...`);
      this.connectionIds.delete(ws);
      this.sessions.close(connId).catch(() => {});
    });

    ws.on('error', (err) => {
      console.error(`[Gateway] WS error on ${connId.slice(0, 8)}:`, err.message);
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
      const init = await this.sessions.open(connId, msg.agent_id, msg.conversation_id);
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

    try {
      for await (const event of this.sessions.sendAndStream(connId, msg.content)) {
        this.forwardStreamEvent(ws, connId, event, msg.request_id);
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

  private forwardStreamEvent(ws: WebSocket, connId: string, msg: SDKMessage, requestId?: string): void {
    switch (msg.type) {
      case 'assistant':
        this.send(ws, { type: 'stream', event: 'assistant', content: msg.content, uuid: msg.uuid, request_id: requestId });
        break;
      case 'tool_call':
        this.send(ws, { type: 'stream', event: 'tool_call', tool_name: msg.toolName, tool_call_id: msg.toolCallId, uuid: msg.uuid, request_id: requestId });
        break;
      case 'tool_result':
        this.send(ws, { type: 'stream', event: 'tool_result', content: msg.content, tool_call_id: msg.toolCallId, is_error: msg.isError, uuid: msg.uuid, request_id: requestId });
        break;
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
