/**
 * Conversations REST proxy
 *
 * Proxies the Letta /v1/conversations API surface to Android (and other clients)
 * with auth injection — clients only hold a lettabot API key, never a Letta key.
 *
 * Part of letta-mobile-w2hx (Letta-native multi-agent transport). Replaces the
 * "bound agent" model: conv-xxx IS the chatId; agent_id is a property of the
 * conversation itself, resolved server-side.
 *
 * Routes (all under /api/v1/conversations):
 *   GET    /api/v1/conversations?agent_id=X[&limit=50]   list per agent
 *   GET    /api/v1/conversations/:id                     get one
 *   GET    /api/v1/conversations/:id/messages[?limit=&after=&before=]
 *   POST   /api/v1/conversations?agent_id=X              create
 *
 * All routes require a valid lettabot API key (X-Api-Key or Authorization: Bearer).
 * Lettabot injects the Letta API key from LETTA_API_KEY env on the upstream call.
 */

import type * as http from 'http';
import { Letta } from '@letta-ai/letta-client';
import { validateApiKey } from './auth.js';
import { createLogger } from '../logger.js';
import { stripEnvelope } from '../core/envelope-guard.js';

const log = createLogger('ConvProxy');

/**
 * Scrub `<system-reminder>` envelopes from a stored Letta message before
 * returning it to a REST client (e.g. the Android app).
 *
 * Lettabot wraps every inbound user message in a system-reminder envelope
 * before forwarding to the agent. Letta persists that wrapped form in
 * conversation history, so a naïve passthrough leaks the envelope back
 * into the chat UI as a "second" user message containing the original
 * prompt + envelope metadata. This re-render then sometimes prompts the
 * agent again, producing a doubled assistant response.
 *
 * Tracking: lettabot-y4j. The bot-channel egress path is already
 * protected by `envelope-guard` in `core/bot.ts`; this is the matching
 * fix on the REST history path.
 *
 * Strategy:
 *   - For user-role messages, strip envelopes from string content and
 *     from any text parts inside an array `content`.
 *   - Assistant content is left alone here: leakage in assistant text
 *     is a separate bug class (envelope-guard should have caught it on
 *     the way out). Logging it here would double-warn.
 *   - If a user message becomes empty after stripping (envelope-only),
 *     return `null` so the caller can drop it from the rendered list.
 *
 * Pure / synchronous / no throws — safe to call inside the SDK
 * iteration loop.
 */
function scrubStoredMessage(msg: unknown): unknown | null {
  if (!msg || typeof msg !== 'object') return msg;
  const m = msg as { role?: string; content?: unknown };
  if (m.role !== 'user') return msg;

  // Case 1: string content
  if (typeof m.content === 'string') {
    const result = stripEnvelope(m.content);
    if (result.blockMatches === 0 && result.tagMatches === 0) return msg;
    if (result.text.length === 0) return null;
    return { ...m, content: result.text };
  }

  // Case 2: array content (multimodal: text/image parts)
  if (Array.isArray(m.content)) {
    let touched = false;
    const scrubbedParts: unknown[] = [];
    for (const part of m.content) {
      if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: unknown };
        if (p.type === 'text' && typeof p.text === 'string') {
          const result = stripEnvelope(p.text);
          if (result.blockMatches > 0 || result.tagMatches > 0) {
            touched = true;
            if (result.text.length === 0) {
              // Drop envelope-only text parts entirely.
              continue;
            }
            scrubbedParts.push({ ...p, text: result.text });
            continue;
          }
        }
      }
      scrubbedParts.push(part);
    }
    if (!touched) return msg;
    if (scrubbedParts.length === 0) return null;
    return { ...m, content: scrubbedParts };
  }

  return msg;
}
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'https://api.letta.com';

let cachedClient: Letta | null = null;
function getLettaClient(): Letta {
  if (cachedClient) return cachedClient;
  cachedClient = new Letta({
    apiKey: process.env.LETTA_API_KEY || '',
    baseURL: LETTA_BASE_URL,
    defaultHeaders: { 'X-Letta-Source': 'lettabot' },
  });
  return cachedClient;
}

interface ProxyOptions {
  apiKey: string;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Try to handle a conversations-proxy request.
 *
 * Returns true if the request was handled (response written), false if not
 * matched and the caller should continue route dispatch.
 *
 * Note: this proxy ONLY matches routes that carry `agent_id` query (for
 * collection routes) or a path with `:id` (for single-resource routes).
 * Existing `?agent=<botName>` callers fall through to the legacy handler
 * in server.ts so we don't break the portal/store-bound behavior.
 */
export async function tryHandleConversationsProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ProxyOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (!path.startsWith('/api/v1/conversations')) return false;

  // Auth: every conversations-proxy route requires a valid lettabot API key.
  if (!validateApiKey(req.headers, options.apiKey)) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }

  const client = getLettaClient();

  // Parse path segments after /api/v1/conversations
  // Examples: '' (collection), '/conv-xxx', '/conv-xxx/messages'
  const tail = path.slice('/api/v1/conversations'.length);
  const segments = tail.split('/').filter((s) => s.length > 0);

  try {
    // ── Collection routes (no path id) ──────────────────────────────────
    if (segments.length === 0) {
      const agentIdParam = url.searchParams.get('agent_id');

      // We only handle requests that pass agent_id directly. Legacy
      // ?agent=<botName> requests fall through to the existing handler.
      if (!agentIdParam) return false;

      if (req.method === 'GET') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);
        const order = (url.searchParams.get('order') as 'asc' | 'desc') || 'desc';
        const orderByRaw = url.searchParams.get('order_by') || 'last_run_completion';
        const orderBy =
          orderByRaw === 'created_at' || orderByRaw === 'last_message_at' || orderByRaw === 'last_run_completion'
            ? orderByRaw
            : 'last_run_completion';

        const convos = await client.conversations.list({
          agent_id: agentIdParam,
          limit,
          order,
          order_by: orderBy,
        });

        const items = convos.map((c) => ({
          id: c.id,
          agent_id: c.agent_id,
          created_at: c.created_at,
          updated_at: c.updated_at,
          last_message_at: c.last_message_at ?? null,
          summary: c.summary ?? null,
          in_context_message_ids: c.in_context_message_ids ?? [],
        }));

        log.debug(`GET /conversations agent=${agentIdParam} count=${items.length}`);
        sendJson(res, 200, { conversations: items });
        return true;
      }

      if (req.method === 'POST') {
        const conv = await client.conversations.create({ agent_id: agentIdParam });
        log.info(`POST /conversations agent=${agentIdParam} -> ${conv.id}`);
        sendJson(res, 201, {
          id: conv.id,
          agent_id: conv.agent_id,
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          summary: conv.summary ?? null,
        });
        return true;
      }

      sendError(res, 405, 'Method not allowed');
      return true;
    }

    // ── Resource routes: /api/v1/conversations/:id ───────────────────────
    const conversationId = segments[0];

    // Quick guard: only proxy clearly-formed conv ids.
    if (!conversationId.startsWith('conv-')) {
      sendError(res, 400, 'Invalid conversation id');
      return true;
    }

    // GET /api/v1/conversations/:id
    if (segments.length === 1) {
      if (req.method !== 'GET') {
        sendError(res, 405, 'Method not allowed');
        return true;
      }
      const conv = await client.conversations.retrieve(conversationId);
      sendJson(res, 200, {
        id: conv.id,
        agent_id: conv.agent_id,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        last_message_at: conv.last_message_at ?? null,
        summary: conv.summary ?? null,
        in_context_message_ids: conv.in_context_message_ids ?? [],
      });
      return true;
    }

    // GET /api/v1/conversations/:id/messages
    if (segments.length === 2 && segments[1] === 'messages') {
      if (req.method !== 'GET') {
        sendError(res, 405, 'Method not allowed');
        return true;
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);
      const after = url.searchParams.get('after') || undefined;
      const before = url.searchParams.get('before') || undefined;
      const order = (url.searchParams.get('order') as 'asc' | 'desc') || 'asc';

      // SDK signature: client.conversations.messages.list(conversationId, options)
      const params: Record<string, unknown> = { limit, order };
      if (after) params.after = after;
      if (before) params.before = before;

      const messages = await client.conversations.messages.list(conversationId, params);
      // SDK returns a paginated iterator; collect synchronously up to limit.
      const items: unknown[] = [];
      // Some SDK versions return an array directly, others an async iterator.
      // Handle both.
      if (Array.isArray(messages)) {
        items.push(...messages);
      } else if (messages && typeof (messages as { items?: unknown[] }).items !== 'undefined') {
        const maybe = (messages as { items?: unknown[] }).items;
        if (Array.isArray(maybe)) items.push(...maybe);
      } else if (messages && typeof (messages as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
        for await (const m of messages as AsyncIterable<unknown>) {
          items.push(m);
          if (items.length >= limit) break;
        }
      }

      // Scrub any leaked system-reminder envelopes from stored user
      // messages before responding. See scrubStoredMessage(). Counts the
      // strip events for ops visibility — a non-zero number here means
      // history that pre-dates this fix is still flowing through (or a
      // brand-new wrap path is bypassing envelope-guard).
      let scrubbed = 0;
      let dropped = 0;
      const cleaned: unknown[] = [];
      for (const it of items) {
        const out = scrubStoredMessage(it);
        if (out === null) {
          dropped += 1;
          continue;
        }
        if (out !== it) scrubbed += 1;
        cleaned.push(out);
      }
      if (scrubbed > 0 || dropped > 0) {
        log.warn(
          `[envelope-guard] scrubbed ${scrubbed} stored user message(s), ` +
            `dropped ${dropped} envelope-only message(s) on GET ` +
            `/conversations/${conversationId}/messages. See lettabot-y4j.`,
        );
      }

      log.debug(
        `GET /conversations/${conversationId}/messages count=${cleaned.length} ` +
          `(scrubbed=${scrubbed} dropped=${dropped})`,
      );
      sendJson(res, 200, { messages: cleaned });
      return true;
    }

    sendError(res, 404, 'Not found');
    return true;
  } catch (err: unknown) {
    const e = err as { status?: number; statusCode?: number; message?: string };
    const status = e.status || e.statusCode || 500;
    const message = e.message || 'Internal server error';
    log.error(`Conversations proxy error (${status}): ${message}`);
    sendError(res, status, message);
    return true;
  }
}
