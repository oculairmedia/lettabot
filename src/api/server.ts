/**
 * HTTP API server for LettaBot
 * Provides endpoints for CLI to send messages across Docker boundaries
 */

import * as http from 'http';
import * as fs from 'fs';
import { readFile } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateApiKey } from './auth.js';
import type { SendMessageResponse, ChatRequest, ChatResponse, AsyncChatResponse, PairingListResponse, PairingApproveRequest, PairingApproveResponse } from './types.js';
import { listPairingRequests, approvePairingCode } from '../pairing/store.js';
import { parseMultipart } from './multipart.js';
import type { AgentRouter } from '../core/interfaces.js';
import type { ChannelId } from '../core/types.js';
import type { Store } from '../core/store.js';
import {
  generateCompletionId, extractLastUserMessage, buildCompletion,
  buildChunk, buildToolCallChunk, formatSSE, SSE_DONE,
  buildErrorResponse, buildModelList, validateChatRequest,
} from './openai-compat.js';
import type { OpenAIChatRequest } from './openai-compat.js';
import { getTurnViewerHtml } from '../core/turn-viewer.js';
import { tryHandleConversationsProxy } from './conversations-proxy.js';

import { createLogger } from '../logger.js';

const log = createLogger('API');
const VALID_CHANNELS: ChannelId[] = ['telegram', 'slack', 'discord', 'whatsapp', 'signal'];
const MAX_BODY_SIZE = 10 * 1024; // 10KB
const MAX_TEXT_LENGTH = 10000; // 10k chars
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const WEBHOOK_CONTEXT = { type: 'webhook' as const, outputMode: 'silent' as const };
const PORTAL_HTML = fs.readFileSync(new URL('./portal.html', import.meta.url), 'utf-8');
const MAX_FILESYSTEM_BROWSE_ENTRIES = 500;

type ResolvedChatRequest = {
  message: string;
  agentName: string | undefined;
  resolvedName: string;
};

export interface UpgradeHandler {
  handleUpgrade(req: import('http').IncomingMessage, socket: import('stream').Duplex, head: Buffer): boolean;
}

interface ServerOptions {
  port: number;
  apiKey: string;
  host?: string;       // Bind address (default: 127.0.0.1 for security)
  corsOrigin?: string; // CORS origin (default: same-origin only)
  turnLogFiles?: Record<string, string>; // agentName -> filePath; enables GET /turns viewer
  stores?: Map<string, Store>; // Agent stores for management endpoints
  agentChannels?: Map<string, string[]>; // Channel IDs per agent name
  agentConversationModes?: Map<string, string>; // agentName -> conversationMode (shared|per-channel|per-chat|disabled)
  gatewayAgentDetails?: () => Array<Record<string, unknown>>; // Client-mode WS gateway agent cwd/status metadata
  sessionInvalidators?: Map<string, (key?: string) => void>; // Invalidate live sessions after store writes
  upgradeHandlers?: UpgradeHandler[];
  heartbeatTriggers?: Map<string, () => Promise<void>>; // agentName -> trigger fn
}

/**
 * Create and start the HTTP API server
 */
export function createApiServer(deliverer: AgentRouter, options: ServerOptions): http.Server {
  // ── Turn viewer SSE infrastructure ──────────────────────────────────────
  interface SSEClient {
    res: http.ServerResponse;
    sentCount: number;
    lastTurnId?: string;
  }
  const sseClientsByAgent = new Map<string, Set<SSEClient>>();
  const broadcastQueues = new Map<string, Promise<void>>();

  function getTurnId(turn: unknown): string | undefined {
    if (!turn || typeof turn !== 'object') return undefined;
    const id = (turn as { turnId?: unknown }).turnId;
    return typeof id === 'string' && id.trim() ? id : undefined;
  }

  async function readTurns(filePath: string): Promise<unknown[]> {
    try {
      const content = await readFile(filePath, 'utf8');
      return content.split('\n').filter(l => l.trim()).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  async function broadcastNewTurns(agentName: string, filePath: string): Promise<void> {
    const clients = sseClientsByAgent.get(agentName);
    if (!clients || clients.size === 0) return;
    const allTurns = await readTurns(filePath);
    const currentLastTurnId = getTurnId(allTurns[allTurns.length - 1]);

    for (const client of clients) {
      // If the log was cleared, reset the client snapshot and UI.
      if (allTurns.length === 0) {
        const shouldReset = client.sentCount !== 0 || !!client.lastTurnId;
        client.sentCount = 0;
        client.lastTurnId = undefined;
        if (shouldReset) {
          const payload = `data: ${JSON.stringify({ type: 'init', turns: [] })}\n\n`;
          try { client.res.write(payload); } catch { clients.delete(client); }
        }
        continue;
      }

      if (client.lastTurnId === currentLastTurnId && client.sentCount === allTurns.length) {
        continue;
      }

      let turnsToAppend: unknown[] | null = null;
      if (client.lastTurnId) {
        let previousIndex = -1;
        for (let i = allTurns.length - 1; i >= 0; i--) {
          if (getTurnId(allTurns[i]) === client.lastTurnId) {
            previousIndex = i;
            break;
          }
        }
        if (previousIndex >= 0) {
          turnsToAppend = allTurns.slice(previousIndex + 1);
        }
      } else if (client.sentCount < allTurns.length) {
        // Fallback for older records without turnId.
        turnsToAppend = allTurns.slice(client.sentCount);
      }

      const appendTurns = turnsToAppend ?? [];
      const shouldResync = turnsToAppend === null
        || (appendTurns.length === 0 && (client.sentCount !== allTurns.length || client.lastTurnId !== currentLastTurnId));

      const payload = shouldResync
        ? `data: ${JSON.stringify({ type: 'init', turns: allTurns })}\n\n`
        : appendTurns.length > 0
          ? `data: ${JSON.stringify({ type: 'append', turns: appendTurns })}\n\n`
          : null;

      if (payload) {
        try {
          client.res.write(payload);
        } catch {
          clients.delete(client);
          continue;
        }
      }

      client.sentCount = allTurns.length;
      client.lastTurnId = currentLastTurnId;
    }
  }

  function enqueueBroadcast(agentName: string, filePath: string): void {
    const prev = broadcastQueues.get(filePath) ?? Promise.resolve();
    const next = prev.then(() => broadcastNewTurns(agentName, filePath)).catch(() => {});
    broadcastQueues.set(filePath, next);
  }

  const watchers = new Map<string, fs.FSWatcher>();

  function ensureWatching(agentName: string, filePath: string): void {
    if (watchers.has(filePath)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
        if (eventType === 'rename') {
          // Inode replaced (trim via atomic rename on Linux). Restart watcher.
          watcher.close();
          watchers.delete(filePath);
          setTimeout(() => {
            const clients = sseClientsByAgent.get(agentName);
            if (clients && clients.size > 0) {
              enqueueBroadcast(agentName, filePath);
              ensureWatching(agentName, filePath);
            }
          }, 200);
          return;
        }
        enqueueBroadcast(agentName, filePath);
      });
    } catch {
      setTimeout(() => {
        const clients = sseClientsByAgent.get(agentName);
        if (clients && clients.size > 0) ensureWatching(agentName, filePath);
      }, 2000);
      return;
    }
    watcher.on('error', () => {
      watcher.close();
      watchers.delete(filePath);
      // Auto-restart watcher after trim (inode replacement on Linux)
      setTimeout(() => {
        const clients = sseClientsByAgent.get(agentName);
        if (clients && clients.size > 0) ensureWatching(agentName, filePath);
      }, 500);
    });
    watchers.set(filePath, watcher);
  }

  function maybeUnwatch(filePath: string, clients: Set<SSEClient>): void {
    if (clients.size === 0 && watchers.has(filePath)) {
      watchers.get(filePath)!.close();
      watchers.delete(filePath);
      broadcastQueues.delete(filePath);
    }
  }

  if (options.turnLogFiles) {
    for (const agentName of Object.keys(options.turnLogFiles)) {
      sseClientsByAgent.set(agentName, new Set());
    }
  }

  const server = http.createServer(async (req, res) => {
    // Set CORS headers (configurable origin, defaults to same-origin for security)
    const corsOrigin = options.corsOrigin || req.headers.origin || 'null';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization');

    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route: GET /health or GET /
    if ((req.url === '/health' || req.url === '/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // Route: GET /healthz - Structured health check for monitoring (no auth required)
    if (req.url === '/healthz' && req.method === 'GET') {
      const agents: Record<string, { agentId: string | null; channels: string[]; conversationMode: string }> = {};
      if (options.stores) {
        for (const [name, store] of options.stores) {
          const info = store.getInfo();
          agents[name] = {
            agentId: info.agentId ?? null,
            channels: options.agentChannels?.get(name) ?? [],
            conversationMode: options.agentConversationModes?.get(name) ?? 'shared',
          };
        }
      }
      const health = {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        agents,
        memoryUsageMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }

    // Turn viewer routes
    if (options.turnLogFiles && req.method === 'GET') {
      const agentNames = Object.keys(options.turnLogFiles);
      const parsedUrl = new URL(req.url ?? '/', `http://localhost`);

      const validateTurnAuth = (): boolean => {
        if (validateApiKey(req.headers, options.apiKey)) return true;
        const qKey = parsedUrl.searchParams.get('key') || '';
        if (!qKey) return false;
        const a = Buffer.from(qKey);
        const b = Buffer.from(options.apiKey);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      };

      if (parsedUrl.pathname === '/turns') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getTurnViewerHtml(agentNames));
        return;
      }
      if (parsedUrl.pathname === '/turns/data') {
        if (!validateTurnAuth()) { sendError(res, 401, 'Unauthorized'); return; }
        const agentName = parsedUrl.searchParams.get('agent') || agentNames[0];
        const filePath = options.turnLogFiles[agentName];
        if (!filePath) { res.writeHead(404); res.end('Unknown agent'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(await readTurns(filePath)));
        return;
      }
      if (parsedUrl.pathname === '/turns/stream') {
        if (!validateTurnAuth()) { sendError(res, 401, 'Unauthorized'); return; }
        const agentName = parsedUrl.searchParams.get('agent') || agentNames[0];
        const filePath = options.turnLogFiles[agentName];
        if (!filePath) { res.writeHead(404); res.end('Unknown agent'); return; }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const allTurns = await readTurns(filePath);
        res.write(`data: ${JSON.stringify({ type: 'init', turns: allTurns })}\n\n`);
        const clients = sseClientsByAgent.get(agentName)!;
        const client: SSEClient = {
          res,
          sentCount: allTurns.length,
          lastTurnId: getTurnId(allTurns[allTurns.length - 1]),
        };
        clients.add(client);
        ensureWatching(agentName, filePath);
        req.on('close', () => {
          clients.delete(client);
          maybeUnwatch(filePath, clients);
        });
        return;
      }
    }

    // Route: POST /api/v1/messages (unified: supports both text and files)
    if (req.url === '/api/v1/messages' && req.method === 'POST') {
      try {
        // Validate authentication
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const contentType = req.headers['content-type'] || '';

        // Parse multipart/form-data (supports both text-only and file uploads)
        if (!contentType.includes('multipart/form-data')) {
          sendError(res, 400, 'Content-Type must be multipart/form-data');
          return;
        }

        // Parse multipart data
        const { fields, files } = await parseMultipart(req, MAX_FILE_SIZE);

        // Validate required fields
        if (!fields.channel || !fields.chatId) {
          sendError(res, 400, 'Missing required fields: channel, chatId');
          return;
        }

        if (!VALID_CHANNELS.includes(fields.channel as ChannelId)) {
          sendError(res, 400, `Invalid channel: ${fields.channel}`, 'channel');
          return;
        }

        // Validate that either text or file is provided
        if (!fields.text && files.length === 0) {
          sendError(res, 400, 'Either text or file must be provided');
          return;
        }

        const file = files.length > 0 ? files[0] : undefined;

        // Send via unified deliverer method
        const messageId = await deliverer.deliverToChannel(
          fields.channel as ChannelId,
          fields.chatId,
          {
            text: fields.text,
            filePath: file?.tempPath,
            kind: fields.kind as 'image' | 'file' | 'audio' | undefined,
          }
        );

        // Cleanup temp file if any
        if (file) {
          try {
            fs.unlinkSync(file.tempPath);
          } catch (err) {
            log.warn('Failed to cleanup temp file:', err);
          }
        }

        // Success response
        const response: SendMessageResponse = {
          success: true,
          messageId,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        log.error('Error handling request:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/chat (send a message to the agent, get response)
    if (req.url === '/api/v1/chat' && req.method === 'POST') {
      try {
        const resolved = await parseWebhookChatRequest(req, res, options.apiKey, deliverer);
        if (!resolved) {
          return;
        }
        log.info(`Chat request for agent "${resolved.resolvedName}": ${resolved.message.slice(0, 100)}...`);
        const wantsStream = (req.headers.accept || '').includes('text/event-stream');

        if (wantsStream) {
          // SSE streaming: forward SDK stream chunks as events
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          let clientDisconnected = false;
          req.on('close', () => { clientDisconnected = true; });

          try {
            for await (const msg of deliverer.streamToAgent(resolved.agentName, resolved.message, WEBHOOK_CONTEXT)) {
              if (clientDisconnected) break;
              res.write(`data: ${JSON.stringify(msg)}\n\n`);
              if (msg.type === 'result') break;
            }
          } catch (streamError: any) {
            if (!clientDisconnected) {
              res.write(`data: ${JSON.stringify({ type: 'error', error: streamError.message })}\n\n`);
            }
          }
          res.end();
        } else {
          // Sync: wait for full response
          const response = await deliverer.sendToAgent(resolved.agentName, resolved.message, WEBHOOK_CONTEXT);

          const chatRes: ChatResponse = {
            success: true,
            response,
            agentName: resolved.resolvedName,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(chatRes));
        }
      } catch (error: any) {
        log.error('Chat error:', error);
        const chatRes: ChatResponse = {
          success: false,
          error: error.message || 'Internal server error',
        };
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(chatRes));
      }
      return;
    }

    // Route: POST /api/v1/chat/async (fire-and-forget: returns 202, processes in background)
    if (req.url === '/api/v1/chat/async' && req.method === 'POST') {
      try {
        const resolved = await parseWebhookChatRequest(req, res, options.apiKey, deliverer);
        if (!resolved) {
          return;
        }
        log.info(`Async chat request for agent "${resolved.resolvedName}": ${resolved.message.slice(0, 100)}...`);

        // Return 202 immediately
        const asyncRes: AsyncChatResponse = {
          success: true,
          status: 'queued',
          agentName: resolved.resolvedName,
        };
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(asyncRes));

        // Process in background (detached promise)
        deliverer.sendToAgent(resolved.agentName, resolved.message, WEBHOOK_CONTEXT).catch((error: any) => {
          log.error(`Async chat background error for agent "${resolved.resolvedName}":`, error);
        });
      } catch (error: any) {
        log.error('Async chat error:', error);
        const asyncRes: AsyncChatResponse = {
          success: false,
          status: 'error',
          error: error.message || 'Internal server error',
        };
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(asyncRes));
      }
      return;
    }

    // Route: GET /api/v1/pairing/:channel - List pending pairing requests
    const pairingListMatch = req.url?.match(/^\/api\/v1\/pairing\/([a-z0-9-]+)$/);
    if (pairingListMatch && req.method === 'GET') {
      try {
        if (getPortalMode(options) !== 'shared' && !validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const channel = pairingListMatch[1];
        if (!VALID_CHANNELS.includes(channel as ChannelId)) {
          sendError(res, 400, `Invalid channel: ${channel}`, 'channel');
          return;
        }

        const requests = await listPairingRequests(channel);
        const response: PairingListResponse = { requests };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        log.error('Pairing list error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/pairing/:channel/approve - Approve a pairing code
    const pairingApproveMatch = req.url?.match(/^\/api\/v1\/pairing\/([a-z0-9-]+)\/approve$/);
    if (pairingApproveMatch && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const channel = pairingApproveMatch[1];
        if (!VALID_CHANNELS.includes(channel as ChannelId)) {
          sendError(res, 400, `Invalid channel: ${channel}`, 'channel');
          return;
        }

        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
          sendError(res, 400, 'Content-Type must be application/json');
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let approveReq: PairingApproveRequest;
        try {
          approveReq = JSON.parse(body);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }

        if (!approveReq.code || typeof approveReq.code !== 'string') {
          sendError(res, 400, 'Missing required field: code');
          return;
        }

        const result = await approvePairingCode(channel, approveReq.code);
        if (!result) {
          const response: PairingApproveResponse = {
            success: false,
            error: 'Code not found or expired',
          };
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          return;
        }

        log.info(`Pairing approved: ${channel} user ${result.userId}`);
        const response: PairingApproveResponse = {
          success: true,
          userId: result.userId,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error: any) {
        log.error('Pairing approve error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: GET /v1/models (OpenAI-compatible)
    if (req.url === '/v1/models' && req.method === 'GET') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          const err = buildErrorResponse('Invalid API key', 'invalid_request_error', 401);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const models = buildModelList(deliverer.getAgentNames());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (error: any) {
        log.error('Models error:', error);
        const err = buildErrorResponse(error.message || 'Internal server error', 'server_error', 500);
        res.writeHead(err.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err.body));
      }
      return;
    }

    // Route: POST /v1/chat/completions (OpenAI-compatible)
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          const err = buildErrorResponse('Invalid API key', 'invalid_request_error', 401);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/json')) {
          const err = buildErrorResponse('Content-Type must be application/json', 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          const err = buildErrorResponse('Invalid JSON body', 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        // Validate OpenAI request shape
        const validationError = validateChatRequest(parsed);
        if (validationError) {
          res.writeHead(validationError.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(validationError.body));
          return;
        }

        const chatReq = parsed as OpenAIChatRequest;

        // Extract the last user message
        const userMessage = extractLastUserMessage(chatReq.messages);
        if (!userMessage) {
          const err = buildErrorResponse('No user message found in messages array', 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        if (userMessage.length > MAX_TEXT_LENGTH) {
          const err = buildErrorResponse(`Message too long (max ${MAX_TEXT_LENGTH} chars)`, 'invalid_request_error', 400);
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        // Resolve agent from model field
        const agentNames = deliverer.getAgentNames();
        const modelName = chatReq.model || agentNames[0];
        const agentName = agentNames.includes(modelName) ? modelName : undefined;

        // If an explicit model was requested but doesn't match any agent, error
        if (chatReq.model && !agentNames.includes(chatReq.model)) {
          const err = buildErrorResponse(
            `Model not found: ${chatReq.model}. Available: ${agentNames.join(', ')}`,
            'model_not_found',
            404,
          );
          res.writeHead(err.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(err.body));
          return;
        }

        const completionId = generateCompletionId();
        const context = { type: 'webhook' as const, outputMode: 'silent' as const };

        log.info(`OpenAI chat: model="${modelName}", stream=${!!chatReq.stream}, msg="${userMessage.slice(0, 100)}..."`);

        if (chatReq.stream) {
          // ---- Streaming response ----
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          let clientDisconnected = false;
          req.on('close', () => { clientDisconnected = true; });

          // First chunk: role announcement
          res.write(formatSSE(buildChunk(completionId, modelName, { role: 'assistant' })));

          try {
            let toolIndex = 0;

            for await (const msg of deliverer.streamToAgent(agentName, userMessage, context)) {
              if (clientDisconnected) break;

              if (msg.type === 'assistant' && msg.content) {
                // Text content delta
                res.write(formatSSE(buildChunk(completionId, modelName, { content: msg.content })));
              } else if (msg.type === 'tool_call') {
                // Tool call delta (emit name + args in one chunk)
                const toolCallId = msg.toolCallId || `call_${msg.uuid || 'unknown'}`;
                const toolName = msg.toolName || 'unknown';
                const args = msg.toolInput ? JSON.stringify(msg.toolInput) : '{}';
                res.write(formatSSE(buildToolCallChunk(
                  completionId, modelName, toolIndex++, toolCallId, toolName, args,
                )));
              } else if (msg.type === 'result') {
                if (!(msg as any).success) {
                  const errMsg = (msg as any).error || 'Agent run failed';
                  res.write(formatSSE(buildChunk(completionId, modelName, {
                    content: `\n\n[Error: ${errMsg}]`,
                  })));
                }
                break;
              }
              // Skip 'reasoning', 'tool_result', and other internal types
            }
          } catch (streamError: any) {
            if (!clientDisconnected) {
              // Emit error as a content delta so clients see it
              res.write(formatSSE(buildChunk(completionId, modelName, {
                content: `\n\n[Error: ${streamError.message}]`,
              })));
            }
          }

          // Finish chunk + done sentinel
          if (!clientDisconnected) {
            res.write(formatSSE(buildChunk(completionId, modelName, {}, 'stop')));
            res.write(SSE_DONE);
          }
          res.end();
        } else {
          // ---- Sync response ----
          const response = await deliverer.sendToAgent(agentName, userMessage, context);
          const completion = buildCompletion(completionId, modelName, response);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(completion));
        }
      } catch (error: any) {
        log.error('OpenAI chat error:', error);
        const err = buildErrorResponse(error.message || 'Internal server error', 'server_error', 500);
        res.writeHead(err.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err.body));
      }
      return;
    }

    // Route: GET /api/v1/status - Agent status (conversation IDs, channels)
    if (req.url === '/api/v1/status' && req.method === 'GET') {
      try {
        if (getPortalMode(options) !== 'shared' && !validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        const agents: Record<string, any> = {};
        const agentDetails: Array<Record<string, unknown>> = [];
        if (options.stores) {
          for (const [name, store] of options.stores) {
            const info = store.getInfo();
            agents[name] = {
              agentId: info.agentId,
              conversationId: info.conversationId || null,
              conversations: info.conversations || {},
              channels: options.agentChannels?.get(name) || [],
              baseUrl: info.baseUrl,
              createdAt: info.createdAt,
              lastUsedAt: info.lastUsedAt,
            };
            if (info.agentId) {
              agentDetails.push({
                id: info.agentId,
                name,
                status: 'ready',
              });
            }
          }
        }
        for (const detail of options.gatewayAgentDetails?.() ?? []) {
          const id = typeof detail.id === 'string' ? detail.id : undefined;
          const existing = id
            ? agentDetails.find(agentDetail => agentDetail.id === id)
            : undefined;
          if (existing) {
            Object.assign(existing, {
              ...detail,
              name: typeof existing.name === 'string' ? existing.name : detail.name,
              status: detail.status ?? existing.status,
            });
            continue;
          }
          agentDetails.push(detail);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents, agent_details: agentDetails }));
      } catch (error: any) {
        log.error('Status error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: GET /api/v1/filesystem/browse - Authenticated server-side directory picker data
    if (req.method === 'GET') {
      const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (parsedUrl.pathname === '/api/v1/filesystem/browse') {
        try {
          if (!validateApiKey(req.headers, options.apiKey)) {
            sendError(res, 401, 'Unauthorized');
            return;
          }
          const requestedPath = parsedUrl.searchParams.get('path') ?? undefined;
          const limit = parsePositiveInt(parsedUrl.searchParams.get('limit'), MAX_FILESYSTEM_BROWSE_ENTRIES);
          const listing = await browseServerDirectory(requestedPath, Math.min(limit, MAX_FILESYSTEM_BROWSE_ENTRIES));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(listing));
        } catch (error: any) {
          log.warn('Filesystem browse error:', error);
          sendError(res, filesystemBrowseStatus(error), error.message || 'Unable to browse filesystem');
        }
        return;
      }
    }

    // Route: POST /api/v1/heartbeat - Trigger heartbeat for an agent
    if (req.url === '/api/v1/heartbeat' && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        if (!options.heartbeatTriggers || options.heartbeatTriggers.size === 0) {
          sendError(res, 404, 'No heartbeat services configured');
          return;
        }

        let agentName: string | undefined;
        try {
          const body = await readBody(req, MAX_BODY_SIZE);
          if (body.trim()) {
            const parsed = JSON.parse(body);
            agentName = parsed.agent;
          }
        } catch { /* empty body is fine — triggers first/only agent */ }

        const triggers = options.heartbeatTriggers;
        const targetName = agentName || triggers.keys().next().value;
        if (!targetName || !triggers.has(targetName)) {
          const available = [...triggers.keys()];
          sendError(res, 404, `Agent not found. Available: ${available.join(', ')}`);
          return;
        }

        const trigger = triggers.get(targetName)!;
        trigger().catch(err => log.error(`Heartbeat trigger error for ${targetName}:`, err));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, agent: targetName, message: 'Heartbeat triggered (silent mode)' }));
      } catch (error: any) {
        log.error('Heartbeat trigger error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/conversation - Set conversation ID
    if (req.url === '/api/v1/conversation' && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        if (!options.stores || options.stores.size === 0) {
          sendError(res, 500, 'No stores configured');
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let request: { conversationId?: string; agent?: string; key?: string };
        try {
          request = JSON.parse(body);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }

        if (!request.conversationId || typeof request.conversationId !== 'string') {
          sendError(res, 400, 'Missing required field: conversationId');
          return;
        }

        // Resolve agent name (default to first store)
        const agentName = request.agent || options.stores.keys().next().value!;
        const store = options.stores.get(agentName);
        if (!store) {
          sendError(res, 404, `Agent not found: ${agentName}`);
          return;
        }

        const mode = options.agentConversationModes?.get(agentName);
        const isPerKey = mode === 'per-channel' || mode === 'per-chat';
        const key = request.key || (isPerKey ? null : 'shared');
        if (!key) {
          sendError(res, 400, `Agent "${agentName}" uses ${mode} conversation mode — a key is required (e.g. "discord", "heartbeat")`);
          return;
        }
        // Reject 'shared' key in per-key modes (per-channel, per-chat, disabled)
        if (key === 'shared' && (mode === 'per-channel' || mode === 'per-chat' || mode === 'disabled')) {
          const expectedFormat = mode === 'per-channel'
            ? 'channel ID (e.g. "telegram", "discord")'
            : mode === 'per-chat'
            ? 'chat-specific key (e.g. "telegram:123456")'
            : 'explicit key (shared mode is disabled)';
          sendError(res, 400, `Agent "${agentName}" uses ${mode} conversation mode — key "shared" is not allowed. Expected: ${expectedFormat}`);
          return;
        }
        if (key === 'shared') {
          store.conversationId = request.conversationId;
        } else {
          store.setConversationId(key, request.conversationId);
        }

        // Invalidate the live session so the next message uses the new conversation
        const invalidate = options.sessionInvalidators?.get(agentName);
        if (invalidate) {
          invalidate(key === 'shared' ? undefined : key);
        }

        log.info(`API set conversation: agent=${agentName} key=${key} conv=${request.conversationId}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, agent: agentName, key, conversationId: request.conversationId }));
      } catch (error: any) {
        log.error('Set conversation error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/inject - Inject external context into agent conversation
    // Allows external systems to push context (e.g., webhook data, notifications)
    // without expecting a response. The agent processes it as a silent background trigger.
    if (req.url === '/api/v1/inject' && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let request: { text?: string; agent?: string; source?: string; metadata?: Record<string, unknown> };
        try {
          request = JSON.parse(body);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }

        if (!request.text || typeof request.text !== 'string') {
          sendError(res, 400, 'Missing required field: text');
          return;
        }
        if (request.text.length > MAX_TEXT_LENGTH) {
          sendError(res, 400, `Text exceeds maximum length (${MAX_TEXT_LENGTH} chars)`);
          return;
        }

        // Resolve agent
        const agentName = request.agent || deliverer.getAgentNames()[0];
        if (!agentName) {
          sendError(res, 404, 'No agents configured');
          return;
        }

        const source = request.source || 'inject';
        const metaStr = request.metadata ? `\n\nMetadata: ${JSON.stringify(request.metadata)}` : '';
        const message = `[External Context Injection - source: ${source}]\n\n${request.text}${metaStr}`;

        // Fire-and-forget: process in background, return 202 immediately
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted', agent: agentName, source }));

        // Process asynchronously
        deliverer.sendToAgent(agentName, message, {
          type: 'webhook',
          outputMode: 'silent',
          sourceChannel: source as ChannelId,
        }).catch(err => {
          log.error(`Inject processing error for agent ${agentName}:`, err);
        });
      } catch (error: any) {
        log.error('Inject endpoint error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: /api/v1/conversations[/:id[/messages]] - Letta conversations proxy.
    // Handles requests carrying agent_id query (collection) or a conv-* path
    // segment (resource). Legacy ?agent=<botName> requests fall through to
    // the handler below.
    // Part of letta-mobile-w2hx (Letta-native multi-agent transport).
    if (req.url?.startsWith('/api/v1/conversations')) {
      const handled = await tryHandleConversationsProxy(req, res, { apiKey: options.apiKey });
      if (handled) return;
    }

    // Route: GET /api/v1/conversations - List conversations from Letta API
    if (req.url?.startsWith('/api/v1/conversations') && req.method === 'GET') {
      try {
        if (getPortalMode(options) !== 'shared' && !validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        if (!options.stores || options.stores.size === 0) {
          sendError(res, 500, 'No stores configured');
          return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const agentName = url.searchParams.get('agent') || options.stores.keys().next().value!;
        const store = options.stores.get(agentName);
        if (!store) {
          sendError(res, 404, `Agent not found: ${agentName}`);
          return;
        }

        const agentId = store.getInfo().agentId;
        if (!agentId) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ conversations: [] }));
          return;
        }

        const { Letta } = await import('@letta-ai/letta-client');
        const client = new Letta({
          apiKey: process.env.LETTA_API_KEY || '',
          baseURL: process.env.LETTA_BASE_URL || 'https://api.letta.com',
        });
        const convos = await client.conversations.list({
          agent_id: agentId,
          limit: 50,
          order: 'desc',
          order_by: 'last_run_completion',
        });

        const conversations = convos.map(c => ({
          id: c.id,
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          summary: c.summary || null,
          messageCount: c.in_context_message_ids?.length || 0,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conversations }));
      } catch (error: any) {
        log.error('List conversations error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: GET /portal - Admin portal for pairing approvals
    if ((req.url === '/portal' || req.url === '/portal/') && req.method === 'GET') {
      const portalMode = getPortalMode(options);
      if (portalMode === 'disabled') {
        sendError(res, 404, 'Portal not available (conversation routing is disabled)');
        return;
      }
      const modeScript = `<script>window.__PORTAL_MODE__ = '${portalMode}';</script>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PORTAL_HTML.replace('</head>', modeScript + '</head>'));
      return;
    }

    // Route: GET /api/v1/agent-names - Get current agent names (for Matrix room sync)
    // Returns mapping of agent ID -> current name from the Letta server.
    if (req.url?.startsWith('/api/v1/agent-names') && req.method === 'GET') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const agentIds = url.searchParams.get('ids')?.split(',').filter(Boolean) ?? [];

        const { Letta } = await import('@letta-ai/letta-client');
        const client = new Letta({
          apiKey: process.env.LETTA_API_KEY || '',
          baseURL: process.env.LETTA_BASE_URL || 'https://api.letta.com',
        });

        const names: Record<string, string> = {};
        const idsToCheck = agentIds.length > 0 ? agentIds : (
          // If no IDs specified, check all agents in stores
          [...(options.stores?.keys() ?? [])].map(name => {
            const store = options.stores?.get(name);
            return store?.getInfo()?.agentId;
          }).filter((id): id is string => !!id)
        );

        for (const agentId of idsToCheck) {
          try {
            const agent = await client.agents.retrieve(agentId);
            if (agent?.name) {
              names[agentId] = agent.name;
            }
          } catch {
            // Agent may not exist
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: names }));
      } catch (error: any) {
        log.error('Agent names endpoint error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/cleanup/orphaned-agents - Check and clean orphaned agent rooms
    // Used by Matrix bridge to detect deleted agents and archive their rooms
    if (req.url === '/api/v1/cleanup/orphaned-agents' && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        // Get tracked agent IDs from each upgrade handler (WsGateway)
        const trackedIds: string[] = [];
        for (const handler of options.upgradeHandlers ?? []) {
          if ('listTrackedAgentIds' in handler && typeof (handler as any).listTrackedAgentIds === 'function') {
            trackedIds.push(...(handler as any).listTrackedAgentIds());
          }
        }

        if (trackedIds.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ orphaned: [], active: [], checked: 0 }));
          return;
        }

        // Check which agents still exist via Letta API
        const { agentExists } = await import('../tools/letta-api.js');
        const results: { id: string; exists: boolean }[] = [];
        for (const id of [...new Set(trackedIds)]) {
          try {
            const exists = await agentExists(id);
            results.push({ id, exists });
          } catch {
            results.push({ id, exists: false });
          }
        }

        const orphaned = results.filter(r => !r.exists).map(r => r.id);
        const active = results.filter(r => r.exists).map(r => r.id);

        // Optionally auto-clean (remove from conversation store)
        const body = await readBody(req, MAX_BODY_SIZE).catch(() => '{}');
        let autoClean = false;
        try {
          const parsed = JSON.parse(body);
          autoClean = parsed.autoClean === true;
        } catch { /* ignore */ }

        let removed: string[] = [];
        if (autoClean && orphaned.length > 0) {
          for (const handler of options.upgradeHandlers ?? []) {
            if ('removeOrphanedAgents' in handler && typeof (handler as any).removeOrphanedAgents === 'function') {
              removed.push(...(handler as any).removeOrphanedAgents(orphaned));
            }
          }
          log.info(`Cleaned ${removed.length} orphaned agent(s) from gateway conversation store`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ orphaned, active, checked: results.length, removed }));
      } catch (error: any) {
        log.error('Cleanup endpoint error:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: 404 Not Found
    sendError(res, 404, 'Not found');
  });

  // Bind to localhost by default for security (prevents network exposure on bare metal)
  // Use API_HOST=0.0.0.0 in Docker to expose on all interfaces
  const host = options.host || '127.0.0.1';
  if (options.upgradeHandlers?.length) {
    server.on('upgrade', (req, socket, head) => {
      for (const handler of options.upgradeHandlers!) {
        if (handler.handleUpgrade(req, socket, head)) return;
      }
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    });
  }

  server.listen(options.port, host, () => {
    log.info(`Server listening on ${host}:${options.port}`);
  });

  return server;
}

/**
 * Read request body with size limit
 */
function readBody(req: http.IncomingMessage, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error(`Request body too large (max ${maxSize} bytes)`));
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      resolve(body);
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Returns the effective portal mode based on agent conversation modes:
 * - 'disabled' if ALL agents are disabled (portal not available)
 * - 'shared' if ALL agents are in shared mode (no per-user auth)
 * - otherwise the first non-shared mode (e.g. 'per-channel', 'per-chat')
 */
function getPortalMode(options: ServerOptions): string {
  const modes = options.agentConversationModes;
  if (!modes || modes.size === 0) return 'shared';
  const values = [...modes.values()];
  if (values.every(m => m === 'disabled')) return 'disabled';
  if (values.every(m => m === 'shared')) return 'shared';
  return values.find(m => m !== 'shared') ?? 'shared';
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function browseServerDirectory(requestedPath: string | undefined, limit: number): Promise<{
  path: string;
  parent: string | null;
  entries: Array<{
    name: string;
    path: string;
    type: 'directory';
    isSymlink: boolean;
  }>;
  truncated: boolean;
}> {
  const expandedPath = expandServerPath(requestedPath?.trim() || process.cwd());
  const resolvedPath = path.resolve(expandedPath);
  const stat = await fs.promises.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw Object.assign(new Error(`Path is not a directory: ${resolvedPath}`), { statusCode: 400 });
  }

  const dirents = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
  const entries: Array<{ name: string; path: string; type: 'directory'; isSymlink: boolean }> = [];
  let scanned = 0;

  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))) {
    if (entries.length >= limit) break;
    scanned += 1;
    if (dirent.name === '.' || dirent.name === '..') continue;
    const childPath = path.join(resolvedPath, dirent.name);
    const isDirectory = dirent.isDirectory() || (dirent.isSymbolicLink() && await isDirectorySymlink(childPath));
    if (!isDirectory) continue;
    entries.push({
      name: dirent.name,
      path: childPath,
      type: 'directory',
      isSymlink: dirent.isSymbolicLink(),
    });
  }

  const parent = path.dirname(resolvedPath);
  return {
    path: resolvedPath,
    parent: parent === resolvedPath ? null : parent,
    entries,
    truncated: scanned < dirents.length || entries.length >= limit,
  };
}

function expandServerPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function isDirectorySymlink(value: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

function filesystemBrowseStatus(error: unknown): number {
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;
  if (statusCode && statusCode >= 400 && statusCode < 600) return statusCode;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  if (code === 'ENOENT') return 404;
  if (code === 'EACCES' || code === 'EPERM') return 403;
  return 500;
}

function ensureAuthorized(req: http.IncomingMessage, res: http.ServerResponse, apiKey: string): boolean {
  if (validateApiKey(req.headers, apiKey)) {
    return true;
  }
  sendError(res, 401, 'Unauthorized');
  return false;
}

function ensureJsonContentType(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) {
    return true;
  }
  sendError(res, 400, 'Content-Type must be application/json');
  return false;
}

async function parseJsonBody<T>(req: http.IncomingMessage, res: http.ServerResponse): Promise<T | null> {
  const body = await readBody(req, MAX_BODY_SIZE);
  try {
    return JSON.parse(body) as T;
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return null;
  }
}

function resolveAgentNameOrError(
  deliverer: AgentRouter,
  requestedAgentName: string | undefined,
  res: http.ServerResponse,
): { agentName: string | undefined; resolvedName: string } | null {
  const agentNames = deliverer.getAgentNames();
  const resolvedName = requestedAgentName || agentNames[0];
  if (requestedAgentName && !agentNames.includes(requestedAgentName)) {
    sendError(res, 404, `Agent not found: ${requestedAgentName}. Available: ${agentNames.join(', ')}`);
    return null;
  }
  return { agentName: requestedAgentName, resolvedName };
}

async function parseWebhookChatRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  apiKey: string,
  deliverer: AgentRouter,
): Promise<ResolvedChatRequest | null> {
  if (!ensureAuthorized(req, res, apiKey)) {
    return null;
  }
  if (!ensureJsonContentType(req, res)) {
    return null;
  }

  const chatReq = await parseJsonBody<ChatRequest>(req, res);
  if (!chatReq) {
    return null;
  }
  if (!chatReq.message || typeof chatReq.message !== 'string') {
    sendError(res, 400, 'Missing required field: message');
    return null;
  }
  if (chatReq.message.length > MAX_TEXT_LENGTH) {
    sendError(res, 400, `Message too long (max ${MAX_TEXT_LENGTH} chars)`);
    return null;
  }

  const agent = resolveAgentNameOrError(deliverer, chatReq.agent, res);
  if (!agent) {
    return null;
  }

  return {
    message: chatReq.message,
    agentName: agent.agentName,
    resolvedName: agent.resolvedName,
  };
}

/**
 * Send error response
 */
function sendError(res: http.ServerResponse, status: number, message: string, field?: string): void {
  const response: SendMessageResponse = {
    success: false,
    error: message,
    field,
  };
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}
