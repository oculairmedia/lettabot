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

/** Tracked session wrapper */
export interface ManagedSession {
  session: Session;
  agentId: string;
  conversationId: string | null;
  state: SessionState;
  lastActivity: number;
  initMessage: SDKInitMessage | null;
  /** Set when abort() interrupts the current run — prevents conversation recovery on result.success=false */
  aborted?: boolean;
}

export interface AgentSessionManagerOptions {
  /** Max idle time before auto-close (ms). Default: 5 minutes */
  idleTimeoutMs?: number;
  /** Sweep interval for idle sessions (ms). Default: 60 seconds */
  sweepIntervalMs?: number;
  /** SDK session options applied to all sessions */
  sessionDefaults?: CreateSessionOptions;
  /** Path to persist agent conversation mappings. Default: <dataDir>/gateway-conversations.json */
  conversationStorePath?: string;
  onConversationUpdate?: (agentId: string, conversationId: string) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
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
  private sessions = new Map<string, ManagedSession>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly sessionDefaults: CreateSessionOptions;
  private readonly conversationStore: ConversationStore;
  private readonly onConversationUpdate?: (agentId: string, conversationId: string) => void;
  private readonly bootstrappedAgents = new Set<string>();

  constructor(options: AgentSessionManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
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

  /**
   * Open a new SDK session for a connection.
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
    await this.close(connectionId);
    if (forceNew) {
      this.conversationStore.clear(agentId);
      log.info(`Forced new conversation for agent ${agentId.slice(0, 12)}...`);
    }

    const effectiveConversationId = forceNew ? undefined : (conversationId ?? this.conversationStore.get(agentId));
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
    };

    this.sessions.set(connectionId, managed);

    try {
      const initMsg = await withTimeout(session.initialize(), INIT_TIMEOUT_MS);
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
      try { session.close(); } catch { /* swallow */ }
      this.sessions.delete(connectionId);

      // If we tried to resume a persisted conversation and it failed (e.g., 404),
      // clear the stale mapping and retry with a fresh conversation.
      if (effectiveConversationId && !conversationId) {
        log.warn(`Persisted conversation ${effectiveConversationId.slice(0, 12)}... is stale, clearing and retrying with fresh conversation`);
        this.conversationStore.clear(agentId);
        return this.open(connectionId, agentId, undefined);
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
    const managed = this.sessions.get(connectionId);
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
          const result = msg as { success?: boolean; conversationId?: string; error?: string };
          const wasAborted = managed.aborted || this.conversationStore.wasRecentlyAborted(managed.agentId);
          if (!result.success && !isRetry && !wasAborted) {
            // ── Retry-doubles-output guard (lettabot-y4j) ──
            // If we already yielded user-visible content, the client has
            // rendered it. Retrying on a new conversation would produce
            // a SECOND complete answer (doubled bubble). Mirrors the
            // `nothingDelivered` guard in bot.ts. Accept the partial
            // result; clear the conversation so the next turn starts fresh.
            if (deliveredContent) {
              log.warn(
                `Conversation failed for agent ${managed.agentId} ` +
                `AFTER partial delivery (error: ${result.error ?? 'unknown'}). ` +
                `Skipping recovery to avoid doubled output (lettabot-y4j). ` +
                `Clearing conversation for next turn.`
              );
              this.conversationStore.clear(managed.agentId);
              managed.state = 'error';
              yield msg;
              break;
            }

            log.warn(
              `Conversation failed for agent ${managed.agentId} ` +
              `(error: ${result.error ?? 'unknown'}). Clearing stale conversation and retrying...`
            );

            // Tear down the broken session
            managed.state = 'closed';
            try { managed.session.close(); } catch { /* swallow */ }
            this.sessions.delete(connectionId);
            this.conversationStore.clear(managed.agentId);

            // Re-open with a fresh conversation
            const init = await this.open(connectionId, managed.agentId, undefined);
            const retryManaged = this.sessions.get(connectionId);
            if (!retryManaged) throw new Error('Failed to re-open session after conversation recovery');

            log.info(
              `Recovery successful — new conversation ${init.conversationId} ` +
              `for agent ${managed.agentId}. Retrying message...`
            );

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
        managed.state = 'closed';
        try { managed.session.close(); } catch { /* swallow */ }
        this.sessions.delete(connectionId);
        this.conversationStore.clear(managed.agentId);

        const init = await this.open(connectionId, managed.agentId, undefined);
        const retryManaged = this.sessions.get(connectionId);
        if (!retryManaged) throw new Error('Failed to re-open session after conversation recovery');

        log.info(
          `Conversation recovery successful — new conversation ${init.conversationId} ` +
          `for agent ${managed.agentId}. Retrying message...`
        );

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
        try { managed.session.close(); } catch { /* swallow */ }
        this.sessions.delete(connectionId);
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
    const managed = this.sessions.get(connectionId);
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
    for (const [connId, managed] of this.sessions) {
      if (managed.agentId === agentId && managed.state === 'busy') {
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

  /** Close and remove a session */
  async close(connectionId: string): Promise<void> {
    const managed = this.sessions.get(connectionId);
    if (!managed) return;
    managed.state = 'closed';
    try { managed.session.close(); } catch { /* swallow */ }
    this.sessions.delete(connectionId);
  }

  /** Check if a connection has a live session */
  has(connectionId: string): boolean {
    return this.sessions.has(connectionId);
  }

  /** Get session metadata (no direct Session access) */
  getInfo(connectionId: string): { agentId: string; conversationId: string | null; state: SessionState } | null {
    const managed = this.sessions.get(connectionId);
    if (!managed) return null;
    return { agentId: managed.agentId, conversationId: managed.conversationId, state: managed.state };
  }

  /** Number of active sessions */
  get size(): number {
    return this.sessions.size;
  }

  /** List all agent IDs tracked in the conversation store */
  listTrackedAgentIds(): string[] {
    return this.conversationStore.listAgentIds();
  }

  /** Remove agent entries from the conversation store. Returns removed IDs. */
  removeOrphanedAgents(agentIds: string[]): string[] {
    return this.conversationStore.removeAgents(agentIds);
  }

  /** Close all sessions and stop the sweep timer */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const ids = [...this.sessions.keys()];
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
    for (const [id, managed] of this.sessions) {
      if (managed.state === 'busy') continue; // never evict mid-request
      if (now - managed.lastActivity > this.idleTimeoutMs) {
        log.info(`Closing idle session for connection ${id.slice(0, 8)}...`);
        try { managed.session.close(); } catch { /* swallow */ }
        this.sessions.delete(id);
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

// --- helpers ---

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
