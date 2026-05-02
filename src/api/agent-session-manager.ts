/**
 * Agent Session Manager
 *
 * Manages letta-code-sdk Session instances for the WebSocket gateway.
 * Completely decoupled from the bot's channel system — each managed session
 * is an independent SDK subprocess that talks directly to the Letta server.
 *
 * Conversation IDs are persisted to disk per agent_id so that reconnecting
 * clients automatically resume their last conversation even if they omit
 * conversation_id in session_start.
 */

import { createSession, resumeSession, type Session, type SDKMessage, type SDKInitMessage, type SendMessage, type MessageContentItem } from '@letta-ai/letta-code-sdk';
import type { CreateSessionOptions } from '@letta-ai/letta-code-sdk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getDataDir } from '../utils/paths.js';
import { ensureNoToolApprovals, recoverOrphanedConversationApproval, cancelRuns } from '../tools/letta-api.js';
import { createLogger } from '../logger.js';
import { classifyError, recoverApprovalConflict } from './gateway-resilience.js';

const log = createLogger('AgentSessionMgr');

/** Lifecycle state of a managed session */
export type SessionState = 'initializing' | 'ready' | 'busy' | 'error' | 'closed';

/**
 * Synthetic event yielded by `_doSendAndStream` when conversation
 * recovery swaps the underlying conversation mid-turn (lettabot-flk.5).
 *
 * This is **not** a real SDK message — the SDK only learns about the
 * new conversation through `init.conversationId` after `_openLocked`
 * runs. The gateway needs the swap signaled inline so it can tell
 * connected clients to re-anchor their timeline observer **before**
 * retry stream events arrive carrying the new `conversation_id`,
 * rather than learning about the swap only from the terminal result.
 *
 * The session manager yields this event into its `sendAndStream`
 * generator using `as unknown as SDKMessage`; the gateway switches on
 * `msg.type === 'conversation_swap'` and forwards a wire frame.
 */
export interface SDKConversationSwapMessage {
  type: 'conversation_swap';
  oldConversationId: string | null;
  newConversationId: string;
  agentId: string;
}

/** Tracked session wrapper */
export interface ManagedSession {
  session: Session;
  agentId: string;
  conversationId: string | null;
  state: SessionState;
  lastActivity: number;
  initMessage: SDKInitMessage | null;
  /** Working directory used to launch this SDK subprocess. */
  cwd?: string;
  /** Set when abort() interrupts the current run — prevents conversation recovery on result.success=false */
  aborted?: boolean;
}

/**
 * Per-connection pool of SDK sessions, keyed on agentId
 * (letta-mobile-w2hx.3).
 *
 * Each WS connection can multiplex multiple agents (Android picker
 * switches, multi-agent chats). Spawning a fresh letta-code-sdk
 * subprocess per agent switch is expensive (~1-3s + bootstrap calls),
 * so we keep recently-used agent sessions warm on the same connection
 * and reuse them.
 *
 * Eviction policy:
 *   - Capped at `maxAgentsPerConnection` (default 4) using LRU.
 *   - Idle eviction via the existing sweep timer when an entry exceeds
 *     `idleTimeoutMs` AND is not currently busy.
 *
 * `activeAgentId` is the agent that the connection is currently scoped
 * to — i.e. the one served by the public `connectionId`-keyed API
 * (`getInfo(connId)`, `sendAndStream(connId, …)`, `abort(connId)`).
 * `session_start(agent_id=X)` flips this pointer (after either
 * reusing or creating an X-keyed session).
 */
interface ConnectionPool {
  /** agentId → ManagedSession. Insertion order = LRU recency (oldest first). */
  agents: Map<string, ManagedSession>;
  /** Which agent the public connectionId-keyed API resolves to. */
  activeAgentId: string | null;
}

export interface AgentSessionManagerOptions {
  /** Max idle time before auto-close (ms). Default: 5 minutes */
  idleTimeoutMs?: number;
  /** Sweep interval for idle sessions (ms). Default: 60 seconds */
  sweepIntervalMs?: number;
  /**
   * Max warm agent sessions per WS connection. When the pool is full
   * and a new agent is opened, the LRU non-busy entry is evicted.
   * Default: 4.
   */
  maxAgentsPerConnection?: number;
  /** SDK session options applied to all sessions */
  sessionDefaults?: CreateSessionOptions;
  /** Path to persist agent conversation mappings. Default: <dataDir>/gateway-conversations.json */
  conversationStorePath?: string;
  onConversationUpdate?: (agentId: string, conversationId: string) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_AGENTS_PER_CONNECTION = 4;
const INIT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Conversation persistence — maps agentId → last known conversationId
// ---------------------------------------------------------------------------

interface ConversationStoreData {
  /** Schema version for future migrations */
  version: 1;
  /** agentId → { conversationId, updatedAt, recentlyAborted? } */
  agents: Record<string, { conversationId: string; updatedAt: string; recentlyAborted?: boolean }>;
}

class ConversationStore {
  private readonly path: string;
  private data: ConversationStoreData;

  constructor(storePath?: string) {
    this.path = storePath ?? resolve(getDataDir(), 'gateway-conversations.json');
    this.data = this.load();
  }

  private load(): ConversationStoreData {
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, 'utf-8'));
        if (raw?.version === 1 && raw.agents) {
          return raw as ConversationStoreData;
        }
      }
    } catch (err) {
      log.warn('Failed to load conversation store:', err instanceof Error ? err.message : err);
    }
    return { version: 1, agents: {} };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch (err) {
      log.warn('Failed to save conversation store:', err instanceof Error ? err.message : err);
    }
  }

  /** Get the last known conversation ID for an agent */
  get(agentId: string): string | null {
    return this.data.agents[agentId]?.conversationId ?? null;
  }

  /** Persist a conversation ID for an agent */
  set(agentId: string, conversationId: string): void {
    this.data.agents[agentId] = {
      conversationId,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  /** Remove the conversation mapping for an agent */
  clear(agentId: string): void {
    delete this.data.agents[agentId];
    this.save();
  }

  /** Mark an agent's conversation as recently aborted (suppress auto-recovery on next failure) */
  markAborted(agentId: string): void {
    const entry = this.data.agents[agentId];
    if (entry) {
      entry.recentlyAborted = true;
      this.save();
    }
  }

  /** Check if an agent was recently aborted */
  wasRecentlyAborted(agentId: string): boolean {
    return this.data.agents[agentId]?.recentlyAborted === true;
  }

  /** Clear the recently-aborted flag (call after a successful send) */
  clearAborted(agentId: string): void {
    const entry = this.data.agents[agentId];
    if (entry?.recentlyAborted) {
      delete entry.recentlyAborted;
      this.save();
    }
  }

  /** List all tracked agent IDs (for cleanup/archival) */
  listAgentIds(): string[] {
    return Object.keys(this.data.agents);
  }

  /** Remove agent entries for deleted agents. Returns removed agent IDs. */
  removeAgents(agentIds: string[]): string[] {
    const removed: string[] = [];
    for (const id of agentIds) {
      if (this.data.agents[id]) {
        delete this.data.agents[id];
        removed.push(id);
      }
    }
    if (removed.length > 0) this.save();
    return removed;
  }
}

/**
 * Creates, tracks, and cleans up SDK sessions.
 * One instance per gateway — sessions are keyed by an opaque connection ID.
 *
 * Conversation IDs are automatically persisted per agent_id. When a client
 * sends session_start without a conversation_id, the manager resumes the
 * last known conversation for that agent (if one exists).
 */
export class AgentSessionManager {
  /**
   * connectionId → per-connection pool of agentId-keyed sessions
   * (w2hx.3). The legacy "one session per connection" view is
   * preserved by `getActive` / `setActive`, which respect
   * `pool.activeAgentId`.
   */
  private pools = new Map<string, ConnectionPool>();
  /**
   * Per-connection serialization (lettabot-wsh.2). All mutations to a
   * given connection's session — `open` (which closes any existing
   * session) and `sendAndStream` (which holds for the duration of the
   * stream) — are serialized through this lock so a `session_start`
   * arriving while a stream is in flight cannot tear down the SDK
   * subprocess mid-iteration. `abort` and `close` are deliberately
   * NOT locked: they are interrupters and must run concurrently with
   * the lock holder.
   */
  private locks = new Map<string, Promise<void>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly maxAgentsPerConnection: number;
  private readonly sessionDefaults: CreateSessionOptions;
  private readonly conversationStore: ConversationStore;
  private readonly onConversationUpdate?: (agentId: string, conversationId: string) => void;
  private readonly bootstrappedAgents = new Set<string>();

  /**
   * Close an SDK session with a SIGKILL fallback (lettabot-wsh.3).
   *
   * `session.close()` calls `process.kill()` on the subprocess which
   * sends SIGTERM by default. SIGTERM is catchable; if the letta-code
   * CLI's signal handler hangs (waiting on a network call, doing
   * cleanup, etc.) the subprocess can outlive its parent's expectation
   * of being closed. Production observed 4 leaked PIDs over 5h before
   * wsh.2 — wsh.2 closes the race window, wsh.3 reaps any survivors.
   *
   * The PID accessor reaches into private SDK state. If the SDK API
   * changes shape, we silently no-op (best-effort).
   */
  private safeCloseSession(session: Session): void {
    // Capture the PID BEFORE close — close() nulls out transport.process.
    let pid: number | undefined;
    try {
      pid = (session as unknown as { transport?: { process?: { pid?: number } } })
        .transport?.process?.pid;
    } catch { /* swallow */ }

    try { session.close(); } catch { /* swallow */ }

    if (typeof pid !== 'number' || pid <= 0) return;

    const SIGKILL_GRACE_MS = 5000;
    const timer = setTimeout(() => {
      try {
        // Signal 0 doesn't actually send anything — it just probes
        // existence. Throws ESRCH if the process is dead.
        process.kill(pid, 0);
        // Still alive — force-terminate.
        log.warn(`SDK subprocess pid=${pid} still alive ${SIGKILL_GRACE_MS}ms after close, sending SIGKILL`);
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* race: died between probe and kill, fine */
        }
      } catch {
        /* dead — clean exit, nothing to do */
      }
    }, SIGKILL_GRACE_MS);
    timer.unref?.();
  }

  /**
   * Acquire the per-connection lock and return a release function.
   * Callers MUST call the release fn in a `finally`. Subsequent callers
   * for the same connId run strictly serialized in arrival order.
   */
  private async acquireLock(connId: string): Promise<() => void> {
    const prev = this.locks.get(connId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    // Capture `chained` once — Promise.then() returns a fresh promise on
    // each call, so re-computing this expression in cleanup would compare
    // distinct identities and never match.
    const chained = prev.then(() => next);
    this.locks.set(connId, chained);
    await prev;
    return () => {
      release();
      // Only delete if we are still the tail of the chain. If a later
      // caller has already chained off our `chained`, we leave the entry
      // in place for them to clean up when they release.
      if (this.locks.get(connId) === chained) {
        this.locks.delete(connId);
      }
    };
  }

  constructor(options: AgentSessionManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxAgentsPerConnection =
      options.maxAgentsPerConnection ?? DEFAULT_MAX_AGENTS_PER_CONNECTION;
    this.sessionDefaults = options.sessionDefaults ?? {
      permissionMode: 'bypassPermissions',
      memfs: false,
    };
    this.conversationStore = new ConversationStore(options.conversationStorePath);
    this.onConversationUpdate = options.onConversationUpdate;

    const sweepMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => this.sweepIdle(), sweepMs);
    this.sweepTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Pool helpers (w2hx.3) — internal accessors that translate the public
  // `connectionId`-keyed API into operations on the per-connection pool.
  // -------------------------------------------------------------------------

  /** Get-or-create the pool for a connection. */
  private getOrCreatePool(connectionId: string): ConnectionPool {
    let pool = this.pools.get(connectionId);
    if (!pool) {
      pool = { agents: new Map(), activeAgentId: null };
      this.pools.set(connectionId, pool);
    }
    return pool;
  }

  /** Resolve the active managed session for a connection (if any). */
  private getActive(connectionId: string): ManagedSession | undefined {
    const pool = this.pools.get(connectionId);
    if (!pool || !pool.activeAgentId) return undefined;
    return pool.agents.get(pool.activeAgentId);
  }

  /**
   * Mark an agent as the active one for the connection AND bump it to
   * MRU position in the LRU map. Re-insertion is the standard JS LRU
   * trick — `Map` preserves insertion order, so deleting + re-setting
   * moves the entry to the tail (most recent).
   */
  private touchAndActivate(pool: ConnectionPool, agentId: string): void {
    const entry = pool.agents.get(agentId);
    if (entry) {
      pool.agents.delete(agentId);
      pool.agents.set(agentId, entry);
      entry.lastActivity = Date.now();
    }
    pool.activeAgentId = agentId;
  }

  /**
   * Evict the LRU non-busy entry from the pool to make room. Returns
   * true if something was evicted, false if every entry is busy (in
   * which case the caller must accept exceeding the cap rather than
   * tearing down an in-flight stream).
   */
  private evictLruIfNeeded(connectionId: string, pool: ConnectionPool): boolean {
    if (pool.agents.size < this.maxAgentsPerConnection) return false;

    for (const [agentId, managed] of pool.agents) {
      if (managed.state === 'busy') continue;
      log.info(
        `Evicting LRU agent ${agentId.slice(0, 12)}... ` +
        `from pool for connection ${connectionId.slice(0, 8)}... ` +
        `(pool size ${pool.agents.size}/${this.maxAgentsPerConnection})`,
      );
      managed.state = 'closed';
      this.safeCloseSession(managed.session);
      pool.agents.delete(agentId);
      // If we just evicted the active agent, clear the pointer; the
      // caller (open) will re-set it after creating the new session.
      if (pool.activeAgentId === agentId) pool.activeAgentId = null;
      return true;
    }
    log.warn(
      `Pool for connection ${connectionId.slice(0, 8)}... is at cap ` +
      `(${this.maxAgentsPerConnection}) and every entry is busy — ` +
      `temporarily exceeding the cap. New sessions will be reaped on next idle sweep.`,
    );
    return false;
  }

  /**
   * Open a new SDK session for a connection.
   *
   * Per-agent pool semantics (w2hx.3):
   *   - If a warm session for `agentId` already exists on this
   *     connection and is reusable (`state==='ready'`, `forceNew` is
   *     false, and either no `conversationId` was requested OR it
   *     matches the cached one), the cached session is reused: no
   *     subprocess spawn, no Letta `initialize` round-trip. The
   *     session's `initMessage` is returned so the gateway can echo
   *     the same `session_init` shape to the client.
   *   - Otherwise a fresh session is created and added to the pool.
   *     If the pool is at `maxAgentsPerConnection`, the LRU non-busy
   *     entry is evicted first.
   *
   * If no conversation_id is provided, the manager checks for a persisted
   * conversation for this agent_id and resumes it automatically. This
   * prevents memory loss when clients reconnect without tracking their
   * conversation_id.
   *
   * Returns the init message on success.
   */
  async open(
    connectionId: string,
    agentId: string,
    conversationId?: string,
    forceNew?: boolean,
  ): Promise<SDKInitMessage> {
    const releaseLock = await this.acquireLock(connectionId);
    try {
      return await this._openLocked(connectionId, agentId, conversationId, forceNew);
    } finally {
      releaseLock();
    }
  }

  /**
   * Lock-free body of `open`. Callers are responsible for holding the
   * per-connection lock. Used by `open` (which acquires) and by the
   * recovery branches in `_doSendAndStream` (which run inside an
   * already-held `sendAndStream` lock and would deadlock if they
   * re-entered the public `open`).
   */
  private async _openLocked(
    connectionId: string,
    agentId: string,
    conversationId?: string,
    forceNew?: boolean,
  ): Promise<SDKInitMessage> {
    const pool = this.getOrCreatePool(connectionId);

    // -- Pool reuse fast path (w2hx.3) ----------------------------------
    // If we already have a warm session for this agent on this
    // connection AND the request is compatible (no force_new, and
    // either no specific conversation requested or it matches the
    // cached one), reuse it. This avoids spawning a fresh
    // letta-code-sdk subprocess on agent re-selection (the common
    // case for the Android picker).
    if (!forceNew) {
      const cached = pool.agents.get(agentId);
      if (
        cached &&
        cached.state === 'ready' &&
        cached.initMessage &&
        (!conversationId || cached.conversationId === conversationId)
      ) {
        log.info(
          `Reusing warm session for agent ${agentId.slice(0, 12)}... ` +
          `on connection ${connectionId.slice(0, 8)}... ` +
          `(conv ${cached.conversationId?.slice(0, 12) ?? 'none'}...)`,
        );
        this.touchAndActivate(pool, agentId);
        return cached.initMessage;
      }
      // Cached but unusable (different conversationId, error state,
      // etc.) — close it before creating a fresh one to avoid leaking
      // the subprocess.
      if (cached) {
        log.info(
          `Discarding stale cached session for agent ${agentId.slice(0, 12)}... ` +
          `(state=${cached.state}, requested conv=${conversationId?.slice(0, 12) ?? 'none'}, ` +
          `cached conv=${cached.conversationId?.slice(0, 12) ?? 'none'})`,
        );
        this.safeCloseSession(cached.session);
        pool.agents.delete(agentId);
        if (pool.activeAgentId === agentId) pool.activeAgentId = null;
      }
    } else {
      // forceNew: drop any existing entry for this agent without ceremony.
      const cached = pool.agents.get(agentId);
      if (cached) {
        this.safeCloseSession(cached.session);
        pool.agents.delete(agentId);
        if (pool.activeAgentId === agentId) pool.activeAgentId = null;
      }
      this.conversationStore.clear(agentId);
      log.info(`Forced new conversation for agent ${agentId.slice(0, 12)}...`);
    }

    // -- Eviction --------------------------------------------------------
    // Make room before we spawn the new subprocess.
    this.evictLruIfNeeded(connectionId, pool);

    const effectiveConversationId = forceNew
      ? undefined
      : (conversationId ?? this.conversationStore.get(agentId));
    if (!conversationId && !forceNew && effectiveConversationId) {
      log.info(`Auto-resuming persisted conversation ${effectiveConversationId.slice(0, 12)}... for agent ${agentId.slice(0, 12)}...`);
    }

    const opts: CreateSessionOptions = { ...this.sessionDefaults };

    const session: Session = effectiveConversationId
      ? resumeSession(effectiveConversationId, opts)
      : createSession(agentId, opts);

    const managed: ManagedSession = {
      session,
      agentId,
      conversationId: null,
      state: 'initializing',
      lastActivity: Date.now(),
      initMessage: null,
      cwd: opts.cwd,
    };

    pool.agents.set(agentId, managed);
    pool.activeAgentId = agentId;

    try {
      const initMsg = await withTimeout(session.initialize(), INIT_TIMEOUT_MS);

      // letta-mobile-c87t.2: silent-resume guard.
      //
      // The SDK's `resumeSession(convId)` does not fail when `convId` is
      // unknown — the underlying letta-code CLI silently allocates a fresh
      // conversation and reports the new id back via the init message. The
      // SDKInitMessage has no `resumed: boolean` field, so the only way to
      // detect substitution is to compare the requested id against the
      // returned id.
      //
      // Refuse the substitution **only when the caller explicitly asked
      // for a specific conversation_id and did not opt into force_new.**
      // The auto-resume-from-store path (line ~567 below) intentionally
      // passes `effectiveConversationId` from the persistent store while
      // keeping `conversationId` undefined — that path's recovery is the
      // existing recursive retry, and we leave it untouched.
      if (
        conversationId &&
        !forceNew &&
        initMsg.conversationId &&
        initMsg.conversationId !== conversationId
      ) {
        log.warn(
          `Refusing silent conversation substitution: requested ` +
          `${conversationId.slice(0, 12)}... but SDK allocated ` +
          `${initMsg.conversationId.slice(0, 12)}...`,
        );
        // Reap the substituted SDK subprocess and remove the pool entry.
        // Do NOT persist the substituted id — the caller will decide
        // whether to retry with force_new (creating a fresh conv on
        // purpose) or back out.
        this.safeCloseSession(session);
        pool.agents.delete(agentId);
        if (pool.activeAgentId === agentId) pool.activeAgentId = null;
        throw new ConversationNotResumableError(conversationId, initMsg.conversationId);
      }

      managed.state = 'ready';
      managed.conversationId = initMsg.conversationId;
      managed.initMessage = initMsg;
      managed.lastActivity = Date.now();

      // Persist the conversation mapping so future reconnects auto-resume
      if (initMsg.conversationId) {
        this.conversationStore.set(agentId, initMsg.conversationId);
        this.onConversationUpdate?.(agentId, initMsg.conversationId);
      }

      // Bootstrap agent: disable tool approvals and recover orphaned approvals (once per agent).
      // Fire-and-forget: don't block session_init response (recovery can take 20s+).
      this.bootstrapAgent(agentId, initMsg.conversationId).catch(() => {});

      return initMsg;
    } catch (err) {
      managed.state = 'error';
      // Clean up the subprocess on init failure
      this.safeCloseSession(session);
      pool.agents.delete(agentId);
      if (pool.activeAgentId === agentId) pool.activeAgentId = null;

      // If we tried to resume a persisted conversation and it failed (e.g., 404),
      // clear the stale mapping and retry with a fresh conversation.
      // Recursive call into _openLocked stays inside the same held lock.
      if (effectiveConversationId && !conversationId) {
        log.warn(`Persisted conversation ${effectiveConversationId.slice(0, 12)}... is stale, clearing and retrying with fresh conversation`);
        this.conversationStore.clear(agentId);
        return this._openLocked(connectionId, agentId, undefined);
      }

      throw err;
    }
  }

  /**
   * Send a message and yield stream events.
   * Caller is responsible for forwarding events over WS.
   *
   * After a successful result, the conversation mapping is refreshed in case
   * the server assigned a different conversation ID mid-stream.
   */
  async *sendAndStream(
    connectionId: string,
    message: SendMessage,
  ): AsyncGenerator<SDKMessage> {
    // Hold the per-connection lock for the entire stream lifetime.
    // This serializes sendAndStream against any concurrent `open` for
    // the same connId, so a `session_start` arriving mid-stream can't
    // tear down the SDK subprocess we're iterating from.
    const releaseLock = await this.acquireLock(connectionId);
    try {
      const managed = this.getActive(connectionId);
      if (!managed) throw new Error('No session for connection');
      if (managed.state === 'busy') throw new SessionBusyError();
      if (managed.state !== 'ready') throw new Error(`Session not ready (state=${managed.state})`);

      managed.state = 'busy';
      managed.lastActivity = Date.now();

      try {
        yield* this._doSendAndStream(managed, connectionId, message);
      } catch (err) {
        managed.state = 'error';
        throw err;
      }
    } finally {
      releaseLock();
    }
  }

  /**
   * Internal send+stream with auto-recovery.
   *
   * If the SDK returns a result with success=false on the first attempt,
   * the conversation is likely corrupted. We close the session, clear the
   * persisted conversation, re-open with a fresh conversation, and retry
   * the message once.
   *
   * IMPORTANT: Recovery is only safe when **no content has been delivered**
   * to the caller yet. Once we yield an assistant/tool_call/tool_result/
   * reasoning message it has already been forwarded over the wire and the
   * client has rendered it. Retrying on a fresh conversation in that state
   * produces a SECOND complete answer, which the client renders as a
   * doubled bubble (root cause of lettabot-y4j retry-doubles-output bug).
   * Mirrors the `nothingDelivered` guard in `bot.ts::buildResultRetryDecision`.
   */
   private async *_doSendAndStream(
    managed: ManagedSession,
    connectionId: string,
    message: SendMessage,
    isRetry = false,
  ): AsyncGenerator<SDKMessage> {
    // Clear the aborted flag at the start of each new send
    managed.aborted = false;
    // Track whether we've yielded any user-visible content. Recovery is
    // unsafe once this flips true — see the docstring above.
    let deliveredContent = false;
    try {
      // Pre-send: populate graphiti context + agent discovery blocks BEFORE the
      // agent sees the message.  This is the gateway path — channel-based messages
      // go through bot.ts which has its own presend hook.
      // Extract text from message for presend context (works for both string and multimodal)
      const presendText = typeof message === 'string' ? message : (
        ((message as MessageContentItem[]).find(item => item.type === 'text') as { text: string } | undefined)?.text ?? ''
      );
      if (presendText.length > 0 && managed.agentId && !isRetry) {
        const presendUrl = process.env.PRESEND_URL || 'http://192.168.50.90:5005/presend/context';
        try {
          const resp = await fetch(presendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_id: managed.agentId, prompt: presendText }),
            signal: AbortSignal.timeout(8000),
          });
          if (resp.ok) {
            const data = await resp.json() as { status?: string; graphiti?: boolean; agents_matched?: number };
            log.info(`presend/context: ${data.status} graphiti=${data.graphiti ?? '?'} agents=${data.agents_matched ?? '?'}`);
          }
        } catch (e) {
          log.warn(`presend/context failed (non-fatal): ${e instanceof Error ? e.message : e}`);
        }
      }

      await managed.session.send(message);
      for await (const msg of managed.session.stream()) {
        managed.lastActivity = Date.now();

        // Detect corrupted conversation: SDK returns result with success=false
        // before any assistant content was streamed.
        if (msg.type === 'result') {
          const result = msg as {
            success?: boolean;
            conversationId?: string;
            error?: string;
            errorCode?: string;
            stopReason?: string;
            durationMs?: number;
          };
          const wasAborted = managed.aborted || this.conversationStore.wasRecentlyAborted(managed.agentId);
          if (!result.success && !isRetry && !wasAborted) {
            // wsh.4 telemetry: the `error: 'error'` we see in production
            // is the SDK's literal pass-through of the CLI's wire result
            // subtype — uninformative on its own. errorCode (mapped from
            // stop_reason via toSdkErrorCode), stopReason itself, and the
            // tail of the CLI's stderr usually carry the actual reason.
            const detail = formatResultFailureDetail(managed.session, result);

            // ── Retry-doubles-output guard (lettabot-y4j) ──
            // If we already yielded user-visible content, the client has
            // rendered it. Retrying on a new conversation would produce
            // a SECOND complete answer (doubled bubble). Mirrors the
            // `nothingDelivered` guard in bot.ts. Accept the partial
            // result; clear the conversation so the next turn starts fresh.
            if (deliveredContent) {
              log.warn(
                `Conversation failed for agent ${managed.agentId} ` +
                `AFTER partial delivery — ${detail}. ` +
                `Skipping recovery to avoid doubled output (lettabot-y4j). ` +
                `Clearing conversation for next turn.`
              );
              this.conversationStore.clear(managed.agentId);
              managed.state = 'error';
              yield msg;
              break;
            }

            log.warn(
              `Conversation failed for agent ${managed.agentId} — ${detail}. ` +
              `Clearing stale conversation and retrying...`
            );

            // Capture the broken conversation ID before we tear down so
            // the swap event below can carry both old and new ids.
            const oldConversationId = managed.conversationId;

            // Tear down the broken session
            managed.state = 'closed';
            this.safeCloseSession(managed.session);
            this.removeFromPool(connectionId, managed.agentId);
            this.conversationStore.clear(managed.agentId);

            // Re-open with a fresh conversation. We're inside a `sendAndStream`
            // lock-held region; use `_openLocked` to avoid re-entering the mutex.
            const init = await this._openLocked(connectionId, managed.agentId, undefined);
            const retryManaged = this.getActive(connectionId);
            if (!retryManaged) throw new Error('Failed to re-open session after conversation recovery');

            log.info(
              `Recovery successful — new conversation ${init.conversationId} ` +
              `for agent ${managed.agentId}. Retrying message...`
            );

            // Tell downstream consumers about the swap BEFORE retry events
            // arrive. Without this the client sees retry chunks tagged with
            // the new conversation_id but tied (by the in-flight observer)
            // to the original conversation, stranding the response in the
            // wrong timeline. (lettabot-flk.5)
            const swapEvent: SDKConversationSwapMessage = {
              type: 'conversation_swap',
              oldConversationId,
              newConversationId: init.conversationId,
              agentId: managed.agentId,
            };
            yield swapEvent as unknown as SDKMessage;

            retryManaged.state = 'busy';
            yield* this._doSendAndStream(retryManaged, connectionId, message, true);
            return;
          }

          // Aborted run (in-session or recently aborted via persisted flag) —
          // skip conversation recovery, keep context intact, retry once on same conversation.
          if (!result.success && wasAborted && !isRetry) {
            // Same retry-doubles-output guard: if content was delivered before
            // the abort took effect, do NOT retry — would produce a doubled answer.
            if (deliveredContent) {
              log.warn(
                `Post-abort failure for agent ${managed.agentId.slice(0, 12)}... ` +
                `AFTER partial delivery — skipping retry to avoid doubled output (lettabot-y4j).`
              );
              this.conversationStore.clearAborted(managed.agentId);
              managed.state = 'error';
              yield msg;
              break;
            }
            log.info(
              `Post-abort failure for agent ${managed.agentId.slice(0, 12)}... — ` +
              `conversation may have incomplete tool call. Retrying on same conversation...`
            );
            this.conversationStore.clearAborted(managed.agentId);

            // Cancel any lingering server-side runs before retry
            try { await cancelRuns(managed.agentId); } catch { /* best-effort */ }

            // Brief pause to let Letta clean up the cancelled run
            await new Promise(r => setTimeout(r, 500));

            // Retry on the same conversation — don't clear it
            managed.state = 'ready';
            yield* this._doSendAndStream(managed, connectionId, message, true);
            return;
          }

          // Aborted run on retry — nothing more we can do, accept the result
          if (!result.success && wasAborted && isRetry) {
            log.warn(
              `Post-abort retry also failed for agent ${managed.agentId.slice(0, 12)}... — ` +
              `accepting result to preserve conversation context`
            );
            this.conversationStore.clearAborted(managed.agentId);
          }

          // Normal success — refresh persisted conversation ID
          const convId = result.conversationId ?? managed.conversationId;
          if (convId) {
            this.conversationStore.set(managed.agentId, convId);
            this.onConversationUpdate?.(managed.agentId, convId);
          }
          yield msg;
          break;
        }

        // Track user-visible delivery for the retry-doubles-output guard.
        // We only count message types the WS gateway actually forwards
        // to the client as content (not init / stream_event / retry).
        if (
          msg.type === 'assistant' ||
          msg.type === 'tool_call' ||
          msg.type === 'tool_result' ||
          msg.type === 'reasoning'
        ) {
          deliveredContent = true;
        }
        yield msg;
      }
      managed.state = 'ready';
    } catch (err) {
      // --- Tier 1 Gateway Resilience ---
      // Classify the error and attempt recovery before giving up.
      const classified = classifyError(err);
      log.warn(
        `Send failed for agent ${managed.agentId.slice(0, 12)}... ` +
        `[${classified.type}]: ${classified.description}`
      );

      // 409 Approval Conflict — recover approvals and retry once
      // Skip retry if content was already delivered (lettabot-y4j guard).
      if (classified.type === 'approval_conflict' && !isRetry && !deliveredContent) {
        log.info('Attempting approval conflict recovery...');
        const recovered = await recoverApprovalConflict(
          managed.agentId,
          managed.conversationId,
        );
        if (recovered) {
          log.info('Approval recovery succeeded — retrying message...');
          managed.state = 'busy';
          yield* this._doSendAndStream(managed, connectionId, message, true);
          return;
        }
      } else if (classified.type === 'approval_conflict' && deliveredContent) {
        log.warn(
          `Approval conflict for agent ${managed.agentId.slice(0, 12)}... ` +
          `AFTER partial delivery — skipping retry to avoid doubled output (lettabot-y4j).`
        );
      }

      // 404 Conversation Missing — clear store, re-open, retry once
      // Skip retry if content was already delivered (lettabot-y4j guard).
      if (classified.type === 'conversation_missing' && !isRetry && !deliveredContent) {
        log.info('Attempting conversation recovery (clear + re-open)...');
        const oldConversationId = managed.conversationId;
        managed.state = 'closed';
        this.safeCloseSession(managed.session);
        this.removeFromPool(connectionId, managed.agentId);
        this.conversationStore.clear(managed.agentId);

        // Same lock-held caveat as the result.success=false branch above.
        const init = await this._openLocked(connectionId, managed.agentId, undefined);
        const retryManaged = this.getActive(connectionId);
        if (!retryManaged) throw new Error('Failed to re-open session after conversation recovery');

        log.info(
          `Conversation recovery successful — new conversation ${init.conversationId} ` +
          `for agent ${managed.agentId}. Retrying message...`
        );

        // Signal the swap so the client re-anchors the timeline before
        // retry events arrive (lettabot-flk.5; mirrors result.success=false branch).
        const swapEvent: SDKConversationSwapMessage = {
          type: 'conversation_swap',
          oldConversationId,
          newConversationId: init.conversationId,
          agentId: managed.agentId,
        };
        yield swapEvent as unknown as SDKMessage;

        retryManaged.state = 'busy';
        yield* this._doSendAndStream(retryManaged, connectionId, message, true);
        return;
      } else if (classified.type === 'conversation_missing' && deliveredContent) {
        log.warn(
          `Conversation missing for agent ${managed.agentId.slice(0, 12)}... ` +
          `AFTER partial delivery — skipping retry to avoid doubled output (lettabot-y4j).`
        );
      }

      // Fatal errors (auth) — invalidate the session so next attempt creates a fresh one
      if (classified.fatal) {
        log.error(`Fatal error for agent ${managed.agentId.slice(0, 12)}... — invalidating session`);
        managed.state = 'closed';
        this.safeCloseSession(managed.session);
        this.removeFromPool(connectionId, managed.agentId);
        this.conversationStore.clear(managed.agentId);
        // Also clear the bootstrap cache so next session re-bootstraps
        this.bootstrappedAgents.delete(managed.agentId);
      } else {
        managed.state = 'error';
      }

      throw err;
    }
  }

  /** Abort the in-flight request for a connection */
  async abort(connectionId: string): Promise<void> {
    const managed = this.getActive(connectionId);
    if (!managed || managed.state !== 'busy') return;
    try {
      await managed.session.abort();
      managed.aborted = true;
    } catch { /* best-effort */ }
    // Cancel server-side runs so the conversation is clean for next resume
    try {
      await cancelRuns(managed.agentId);
    } catch { /* best-effort */ }
    // Persist abort flag so new sessions (after WS eviction) know to suppress auto-recovery
    this.conversationStore.markAborted(managed.agentId);
    managed.state = 'ready';
  }

  /** Abort all in-flight requests for a given agent (across all connections) */
  async abortByAgentId(agentId: string): Promise<number> {
    let aborted = 0;
    for (const pool of this.pools.values()) {
      const managed = pool.agents.get(agentId);
      if (managed && managed.state === 'busy') {
        try {
          await managed.session.abort();
          managed.aborted = true;
          managed.state = 'ready';
          aborted++;
        } catch { /* best-effort */ }
      }
    }
    // Cancel server-side runs once (not per connection)
    if (aborted > 0) {
      try {
        await cancelRuns(agentId);
      } catch { /* best-effort */ }
      // Persist abort flag so new sessions know to suppress auto-recovery
      this.conversationStore.markAborted(agentId);
    }
    return aborted;
  }

  /**
   * Close and remove **all** sessions for a connection. Called when
   * the WS disconnects — every agent in the pool needs its subprocess
   * reaped.
   */
  async close(connectionId: string): Promise<void> {
    const pool = this.pools.get(connectionId);
    if (!pool) return;
    for (const [, managed] of pool.agents) {
      managed.state = 'closed';
      this.safeCloseSession(managed.session);
    }
    pool.agents.clear();
    pool.activeAgentId = null;
    this.pools.delete(connectionId);
  }

  /**
   * Internal helper: remove a single (connectionId, agentId) entry
   * from the pool without closing the session (caller is expected to
   * have already called `safeCloseSession`). Idempotent.
   */
  private removeFromPool(connectionId: string, agentId: string): void {
    const pool = this.pools.get(connectionId);
    if (!pool) return;
    pool.agents.delete(agentId);
    if (pool.activeAgentId === agentId) pool.activeAgentId = null;
    if (pool.agents.size === 0) this.pools.delete(connectionId);
  }

  /** Check if a connection has at least one live session in its pool. */
  has(connectionId: string): boolean {
    const pool = this.pools.get(connectionId);
    return !!pool && pool.activeAgentId !== null && pool.agents.has(pool.activeAgentId);
  }

  /** Get session metadata for the active agent (no direct Session access) */
  getInfo(connectionId: string): { agentId: string; conversationId: string | null; state: SessionState } | null {
    const managed = this.getActive(connectionId);
    if (!managed) return null;
    return { agentId: managed.agentId, conversationId: managed.conversationId, state: managed.state };
  }

  /** Total number of warm sessions across all pools */
  get size(): number {
    let n = 0;
    for (const pool of this.pools.values()) n += pool.agents.size;
    return n;
  }

  /** Number of warm agent sessions in a specific connection's pool (w2hx.3 telemetry). */
  poolSize(connectionId: string): number {
    return this.pools.get(connectionId)?.agents.size ?? 0;
  }

  /** List all agent IDs tracked in the conversation store */
  listTrackedAgentIds(): string[] {
    return this.conversationStore.listAgentIds();
  }

  /**
   * Client-mode filesystem location metadata for status endpoints.
   *
   * The path concept belongs to the letta-code SDK subprocess owned by the
   * WS gateway, not to generic channel bots. Active sessions report their
   * launch cwd as the current working directory; tracked-but-idle agents expose
   * it as the default/start location so clients can avoid an "unknown" state
   * before a socket has opened.
   */
  listAgentLocations(): Array<{
    id: string;
    name: string;
    status: SessionState | 'tracked';
    conversationId: string | null;
    currentWorkingDirectory?: string;
    defaultWorkingDirectory?: string;
  }> {
    const byAgent = new Map<string, {
      id: string;
      name: string;
      status: SessionState | 'tracked';
      conversationId: string | null;
      currentWorkingDirectory?: string;
      defaultWorkingDirectory?: string;
    }>();
    const defaultWorkingDirectory = this.sessionDefaults.cwd;

    for (const pool of this.pools.values()) {
      for (const [agentId, managed] of pool.agents) {
        byAgent.set(agentId, {
          id: agentId,
          name: agentId,
          status: managed.state,
          conversationId: managed.conversationId,
          currentWorkingDirectory: managed.cwd ?? defaultWorkingDirectory,
          defaultWorkingDirectory: managed.cwd ?? defaultWorkingDirectory,
        });
      }
    }

    for (const agentId of this.conversationStore.listAgentIds()) {
      if (byAgent.has(agentId)) continue;
      byAgent.set(agentId, {
        id: agentId,
        name: agentId,
        status: 'tracked',
        conversationId: this.conversationStore.get(agentId),
        defaultWorkingDirectory,
      });
    }

    return [...byAgent.values()];
  }

  /** Remove agent entries from the conversation store. Returns removed IDs. */
  removeOrphanedAgents(agentIds: string[]): string[] {
    return this.conversationStore.removeAgents(agentIds);
  }

  /** Close all sessions across all pools and stop the sweep timer */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const ids = [...this.pools.keys()];
    await Promise.allSettled(ids.map(id => this.close(id)));
  }

  // --- internals ---

  /**
   * Bootstrap an agent for headless gateway operation (once per unique agent_id).
   * Mirrors the startup logic from bot.ts:
   *   1. Disable requires_approval on all tools (prevents stuck approval states)
   *   2. Recover any orphaned approval_request_messages from previous sessions
   * Best-effort: failures are logged but don't block the session.
   */
  private async bootstrapAgent(agentId: string, conversationId: string | null): Promise<void> {
    if (this.bootstrappedAgents.has(agentId)) return;
    this.bootstrappedAgents.add(agentId);

    log.info(`Bootstrapping agent ${agentId.slice(0, 12)}... (disabling tool approvals, recovering orphaned approvals)`);

    try {
      await ensureNoToolApprovals(agentId);
    } catch (e) {
      log.warn(`Failed to disable tool approvals for agent ${agentId.slice(0, 12)}...:`, e);
    }

    if (conversationId) {
      try {
        const result = await recoverOrphanedConversationApproval(agentId, conversationId);
        if (result.recovered) {
          log.info(`Recovered orphaned approvals for agent ${agentId.slice(0, 12)}...: ${result.details}`);
        }
      } catch (e) {
        log.warn(`Failed to recover orphaned approvals for agent ${agentId.slice(0, 12)}...:`, e);
      }
    }
  }


  private sweepIdle(): void {
    const now = Date.now();
    for (const [connId, pool] of this.pools) {
      // Iterate a snapshot — we mutate pool.agents inside the loop.
      const entries = [...pool.agents.entries()];
      for (const [agentId, managed] of entries) {
        if (managed.state === 'busy') continue; // never evict mid-request
        if (now - managed.lastActivity > this.idleTimeoutMs) {
          log.info(
            `Closing idle session for agent ${agentId.slice(0, 12)}... ` +
            `on connection ${connId.slice(0, 8)}...`,
          );
          this.safeCloseSession(managed.session);
          this.removeFromPool(connId, agentId);
        }
      }
    }
  }
}

/** Thrown when a session is already processing a message */
export class SessionBusyError extends Error {
  constructor() {
    super('Session is busy processing another request');
    this.name = 'SessionBusyError';
  }
}

/**
 * Thrown by `_openLocked` when a caller asks to resume a specific
 * `conversation_id` and the SDK silently allocates a different one
 * instead. The underlying `letta-code` CLI does not surface a
 * "conversation not found" error — when given an unknown conversation
 * id it just creates a fresh conversation and reports the new id back
 * via the init message. Trusting that result silently moves the user
 * to a new conversation; the agent has no memory of the prior one.
 *
 * Surfacing this as a typed error lets the gateway send a typed wire
 * code (CONVERSATION_NOT_RESUMABLE) so clients can offer an explicit
 * "start fresh" action instead of a silent migration.
 *
 * See plan: 2026-04-clientmode-prevent-silent-conversation-swap.md.
 */
export class ConversationNotResumableError extends Error {
  constructor(
    public readonly requestedConversationId: string,
    public readonly substituteConversationId: string,
  ) {
    super(
      `Requested conversation ${requestedConversationId} is no longer resumable; ` +
      `SDK allocated ${substituteConversationId} instead`,
    );
    this.name = 'ConversationNotResumableError';
  }
}

// --- helpers ---

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

/**
 * Format a one-line failure detail for the recovery-cycle warning log
 * (lettabot-wsh.4). Pulls every field we have on the result envelope plus
 * the last few lines of the SDK subprocess's stderr — the actual error
 * detail rarely lands in `result.error` (which is just the wire subtype,
 * usually the literal string "error"), but `stopReason` and stderr tail
 * usually carry the underlying cause.
 */
function formatResultFailureDetail(
  session: Session,
  result: {
    error?: string;
    errorCode?: string;
    stopReason?: string;
    conversationId?: string;
    durationMs?: number;
  },
): string {
  const parts = [
    `error=${result.error ?? 'unknown'}`,
    `errorCode=${result.errorCode ?? 'none'}`,
    `stopReason=${result.stopReason ?? 'none'}`,
    `convId=${result.conversationId?.slice(0, 12) ?? 'unset'}`,
    `durationMs=${result.durationMs ?? '?'}`,
  ];
  // Best-effort grab of the SDK transport's stderr tail. Reaches into
  // private state — silently no-op if the SDK API changes.
  try {
    const stderr = (
      session as unknown as { transport?: { getStderr?: () => string } }
    ).transport?.getStderr?.();
    if (stderr) {
      const tail = stderr
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .slice(-3)
        .join(' | ');
      if (tail) parts.push(`stderrTail="${tail.slice(0, 400)}"`);
    }
  } catch { /* swallow */ }
  return parts.join(', ');
}
