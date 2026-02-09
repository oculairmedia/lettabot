/**
 * HTTP API server for LettaBot
 * Provides endpoints for CLI to send messages across Docker boundaries
 */

import * as http from 'http';
import * as fs from 'fs';
import { validateApiKey } from './auth.js';
import type { SendMessageRequest, SendMessageResponse, SendFileResponse, InjectContextRequest, InjectContextResponse } from './types.js';
import { parseMultipart } from './multipart.js';
import type { LettaBot } from '../core/bot.js';
import type { ChannelId } from '../core/types.js';
import { handleWorkerSpawnRequest, handleWorkerStatusRequest } from '../workers/index.js';

const VALID_CHANNELS: ChannelId[] = ['telegram', 'slack', 'discord', 'whatsapp', 'signal'];
const MAX_BODY_SIZE = 10 * 1024; // 10KB
const MAX_TEXT_LENGTH = 10000; // 10k chars
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

interface UpgradeHandler {
  handleUpgrade(req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer): boolean;
}

interface ServerOptions {
  port: number;
  apiKey: string;
  host?: string;
  corsOrigin?: string;
  upgradeHandlers?: UpgradeHandler[];
}

/**
 * Create and start the HTTP API server
 */
export function createApiServer(bot: LettaBot, options: ServerOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    // Set CORS headers (configurable origin, defaults to same-origin for security)
    const corsOrigin = options.corsOrigin || req.headers.origin || 'null';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');

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

        // Send via unified bot method
        const messageId = await bot.deliverToChannel(
          fields.channel as ChannelId,
          fields.chatId,
          {
            text: fields.text,
            filePath: file?.tempPath,
            kind: fields.kind as 'image' | 'file' | undefined,
          }
        );

        // Cleanup temp file if any
        if (file) {
          try {
            fs.unlinkSync(file.tempPath);
          } catch (err) {
            console.warn('[API] Failed to cleanup temp file:', err);
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
        console.error('[API] Error handling request:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/inject - inject context into agent (background, like Gmail polling)
    if (req.url === '/api/v1/inject' && req.method === 'POST') {
      try {
        if (!validateApiKey(req.headers, options.apiKey)) {
          sendError(res, 401, 'Unauthorized');
          return;
        }

        const body = await readBody(req, MAX_BODY_SIZE);
        let request: InjectContextRequest;
        try {
          request = JSON.parse(body);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }

        if (!request.text) {
          sendError(res, 400, 'Missing required field: text', 'text');
          return;
        }

        if (typeof request.text !== 'string' || request.text.length > MAX_TEXT_LENGTH) {
          sendError(res, 400, `Text must be a string under ${MAX_TEXT_LENGTH} chars`, 'text');
          return;
        }

        const source = request.source || 'api';
        const prefix = `[${source}] `;
        const fullText = prefix + request.text;

        console.log(`[API] Injecting context from ${source} (${request.text.length} chars)`);
        
        if (request.async) {
          bot.sendToAgent(fullText).catch(err =>
            console.error(`[API] Async inject failed:`, err)
          );
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, queued: true }));
        } else {
          const response = await bot.sendToAgent(fullText);
          const result: InjectContextResponse = {
            success: true,
            response: response || undefined,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      } catch (error: any) {
        console.error('[API] Error injecting context:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: POST /api/v1/worker/spawn - spawn ephemeral worker agent (called by Letta sandbox, no auth)
    if (req.url === '/api/v1/worker/spawn' && req.method === 'POST') {
      try {
        const body = await readBody(req, MAX_BODY_SIZE);
        let request: { task_description: string; agent_id: string; model?: string; tags?: string[]; timeout_seconds?: number };
        try {
          request = JSON.parse(body);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }

        if (!request.task_description || !request.agent_id) {
          sendError(res, 400, 'Missing required fields: task_description, agent_id');
          return;
        }

        console.log(`[API] Worker spawn request: agent=${request.agent_id}, timeout=${request.timeout_seconds ?? 'default'}s, task="${request.task_description.slice(0, 80)}..."`);

        const result = await handleWorkerSpawnRequest(request);

        const statusCode = result.success ? 202 : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error: any) {
        console.error('[API] Error handling worker spawn:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: GET /api/v1/worker/status/:workflowId - check worker workflow status (no auth, called by Letta sandbox)
    if (req.url?.startsWith('/api/v1/worker/status/') && req.method === 'GET') {
      try {
        const workflowId = decodeURIComponent(req.url.slice('/api/v1/worker/status/'.length));
        if (!workflowId) {
          sendError(res, 400, 'Missing workflow ID');
          return;
        }

        const status = await handleWorkerStatusRequest(workflowId);
        if (!status) {
          sendError(res, 404, `Workflow ${workflowId} not found`);
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
      } catch (error: any) {
        console.error('[API] Error checking worker status:', error);
        sendError(res, 500, error.message || 'Internal server error');
      }
      return;
    }

    // Route: 404 Not Found
    sendError(res, 404, 'Not found');
  });

  if (options.upgradeHandlers?.length) {
    server.on('upgrade', (req, socket, head) => {
      for (const handler of options.upgradeHandlers!) {
        if (handler.handleUpgrade(req, socket, head)) return;
      }
      socket.destroy();
    });
  }

  const host = options.host || '127.0.0.1';
  server.listen(options.port, host, () => {
    console.log(`[API] Server listening on ${host}:${options.port}`);
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
 * Validate send message request
 */
function validateRequest(request: SendMessageRequest): { message: string; field?: string } | null {
  if (!request.channel) {
    return { message: 'Missing required field: channel', field: 'channel' };
  }

  if (!request.chatId) {
    return { message: 'Missing required field: chatId', field: 'chatId' };
  }

  if (!request.text) {
    return { message: 'Missing required field: text', field: 'text' };
  }

  if (!VALID_CHANNELS.includes(request.channel as ChannelId)) {
    return { message: `Invalid channel: ${request.channel}`, field: 'channel' };
  }

  if (typeof request.text !== 'string') {
    return { message: 'Field "text" must be a string', field: 'text' };
  }

  if (request.text.length > MAX_TEXT_LENGTH) {
    return { message: `Text too long (max ${MAX_TEXT_LENGTH} chars)`, field: 'text' };
  }

  return null;
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
