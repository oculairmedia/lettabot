/**
 * Conversation → Agent ID resolver with LRU + TTL caching.
 *
 * When an inbound WS frame carries a conversation_id, lettabot needs to know
 * which agent_id owns that conversation in order to pick the right SDK
 * session from the per-agent pool (sibling letta-mobile-w2hx.3).
 *
 * Letta enforces that conversations are immutable w.r.t. agent_id, so once
 * we've resolved a (conv-xxx → agent-xxx) mapping it is safe to cache for the
 * lifetime of the process. We still apply a TTL as defence-in-depth and an
 * LRU cap to bound memory.
 *
 * Hot path: O(1) Map lookup + LRU touch. Cold path: one HTTP roundtrip to
 * Letta (cached for the rest of the process lifetime in practice).
 *
 * Part of letta-mobile-w2hx.12.
 */

import { Letta } from '@letta-ai/letta-client';
import { createLogger } from '../logger.js';

const log = createLogger('ConvResolver');

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_NEG_TTL_MS = 30 * 1000; // negative cache: 30s

interface CacheEntry {
  agentId: string | null; // null = negative cache (conversation not found)
  expiresAt: number;
}

export interface ResolverOptions {
  /** Override the Letta SDK client (for tests). */
  client?: Pick<Letta, 'conversations'>;
  /** Cache TTL for successful lookups (ms). Default 1h. */
  ttlMs?: number;
  /** Cache TTL for negative lookups (ms). Default 30s. */
  negativeTtlMs?: number;
  /** Max entries before LRU eviction. Default 10000. */
  maxEntries?: number;
  /** Override now() for tests. */
  now?: () => number;
}

export interface ResolverStats {
  size: number;
  hits: number;
  misses: number;
  negativeHits: number;
  evictions: number;
}

export class ConversationAgentResolver {
  private readonly client: Pick<Letta, 'conversations'>;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  // Map iteration order is insertion order in JS; we re-insert on hit to track LRU.
  private readonly cache = new Map<string, CacheEntry>();

  // In-flight resolutions are coalesced to avoid stampedes on cold start.
  private readonly inflight = new Map<string, Promise<string | null>>();

  private hits = 0;
  private misses = 0;
  private negativeHits = 0;
  private evictions = 0;

  constructor(options: ResolverOptions = {}) {
    this.client =
      options.client ??
      new Letta({
        apiKey: process.env.LETTA_API_KEY || '',
        baseURL: process.env.LETTA_BASE_URL || 'https://api.letta.com',
        defaultHeaders: { 'X-Letta-Source': 'lettabot' },
      });
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEG_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /**
   * Resolve a conversation_id → agent_id.
   * Returns null if the conversation does not exist or has no agent.
   * Throws on transport errors so the caller can choose to retry.
   */
  async resolve(conversationId: string): Promise<string | null> {
    if (!conversationId || typeof conversationId !== 'string') {
      throw new Error('resolve: conversationId is required');
    }

    const now = this.now();
    const cached = this.cache.get(conversationId);
    if (cached) {
      if (cached.expiresAt > now) {
        // LRU touch: re-insert at the end of the Map.
        this.cache.delete(conversationId);
        this.cache.set(conversationId, cached);
        if (cached.agentId === null) {
          this.negativeHits++;
        } else {
          this.hits++;
        }
        return cached.agentId;
      }
      // Expired — drop and fall through to refetch.
      this.cache.delete(conversationId);
    }

    // Coalesce concurrent lookups for the same conv id.
    const existing = this.inflight.get(conversationId);
    if (existing) return existing;

    const p = this.fetch(conversationId).finally(() => {
      this.inflight.delete(conversationId);
    });
    this.inflight.set(conversationId, p);
    return p;
  }

  /**
   * Pre-populate the cache. Useful when the WS gateway already learned the
   * (conv, agent) pair from a session_init or message-create response.
   */
  prime(conversationId: string, agentId: string): void {
    if (!conversationId || !agentId) return;
    this.set(conversationId, agentId);
  }

  /** Drop a cache entry (e.g. on conversation deletion event). */
  invalidate(conversationId: string): void {
    this.cache.delete(conversationId);
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
    this.hits = 0;
    this.misses = 0;
    this.negativeHits = 0;
    this.evictions = 0;
  }

  stats(): ResolverStats {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      negativeHits: this.negativeHits,
      evictions: this.evictions,
    };
  }

  private async fetch(conversationId: string): Promise<string | null> {
    this.misses++;
    try {
      const conv = await this.client.conversations.retrieve(conversationId);
      const agentId = (conv as { agent_id?: string }).agent_id ?? null;
      this.set(conversationId, agentId);
      log.debug(`resolved ${conversationId} -> ${agentId ?? '(none)'}`);
      return agentId;
    } catch (err: unknown) {
      const e = err as { status?: number; statusCode?: number };
      const status = e.status ?? e.statusCode;
      if (status === 404) {
        // Negative cache: conversation does not exist.
        this.set(conversationId, null);
        log.debug(`resolved ${conversationId} -> not found (negative cached)`);
        return null;
      }
      // Transient error: don't poison the cache; let caller retry.
      log.warn(`resolve(${conversationId}) transport error: ${(err as Error).message}`);
      throw err;
    }
  }

  private set(conversationId: string, agentId: string | null): void {
    const ttl = agentId === null ? this.negativeTtlMs : this.ttlMs;
    const entry: CacheEntry = {
      agentId,
      expiresAt: this.now() + ttl,
    };
    // If already present, delete first so the re-insert moves it to the end (LRU).
    this.cache.delete(conversationId);
    this.cache.set(conversationId, entry);
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.maxEntries) {
      // Map preserves insertion order; first key is LRU.
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.evictions++;
    }
  }
}

// Process-wide singleton — most callers should use this.
let sharedResolver: ConversationAgentResolver | null = null;

export function getSharedResolver(): ConversationAgentResolver {
  if (!sharedResolver) {
    sharedResolver = new ConversationAgentResolver();
  }
  return sharedResolver;
}

/** For tests: replace or clear the shared resolver. */
export function _setSharedResolverForTest(r: ConversationAgentResolver | null): void {
  sharedResolver = r;
}
