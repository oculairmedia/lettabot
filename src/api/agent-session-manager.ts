/**
 * Agent Session Manager
 *
 * Manages letta-code-sdk Session instances for the WebSocket gateway.
 * Completely decoupled from the bot's channel system — each managed session
 * is an independent SDK subprocess that talks directly to the Letta server.
 */

import { createSession, resumeSession, type Session, type SDKMessage, type SDKInitMessage } from '@letta-ai/letta-code-sdk';
import type { CreateSessionOptions } from '@letta-ai/letta-code-sdk';

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
}

export interface AgentSessionManagerOptions {
  /** Max idle time before auto-close (ms). Default: 5 minutes */
  idleTimeoutMs?: number;
  /** Sweep interval for idle sessions (ms). Default: 60 seconds */
  sweepIntervalMs?: number;
  /** SDK session options applied to all sessions */
  sessionDefaults?: CreateSessionOptions;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const INIT_TIMEOUT_MS = 30_000;

/**
 * Creates, tracks, and cleans up SDK sessions.
 * One instance per gateway — sessions are keyed by an opaque connection ID.
 */
export class AgentSessionManager {
  private sessions = new Map<string, ManagedSession>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly sessionDefaults: CreateSessionOptions;

  constructor(options: AgentSessionManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sessionDefaults = options.sessionDefaults ?? {
      permissionMode: 'bypassPermissions',
    };

    const sweepMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => this.sweepIdle(), sweepMs);
    this.sweepTimer.unref?.();
  }

  /**
   * Open a new SDK session for a connection.
   * Returns the init message on success.
   */
  async open(
    connectionId: string,
    agentId: string,
    conversationId?: string,
  ): Promise<SDKInitMessage> {
    // Close existing session for this connection (if any)
    await this.close(connectionId);

    const opts: CreateSessionOptions = { ...this.sessionDefaults };

    const session: Session = conversationId
      ? resumeSession(conversationId, opts)
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
      return initMsg;
    } catch (err) {
      managed.state = 'error';
      // Clean up the subprocess on init failure
      try { session.close(); } catch { /* swallow */ }
      this.sessions.delete(connectionId);
      throw err;
    }
  }

  /**
   * Send a message and yield stream events.
   * Caller is responsible for forwarding events over WS.
   */
  async *sendAndStream(
    connectionId: string,
    message: string,
  ): AsyncGenerator<SDKMessage> {
    const managed = this.sessions.get(connectionId);
    if (!managed) throw new Error('No session for connection');
    if (managed.state === 'busy') throw new SessionBusyError();
    if (managed.state !== 'ready') throw new Error(`Session not ready (state=${managed.state})`);

    managed.state = 'busy';
    managed.lastActivity = Date.now();

    try {
      await managed.session.send(message);
      for await (const msg of managed.session.stream()) {
        managed.lastActivity = Date.now();
        yield msg;
        if (msg.type === 'result') break;
      }
      managed.state = 'ready';
    } catch (err) {
      managed.state = 'error';
      throw err;
    }
  }

  /** Abort the in-flight request for a connection */
  async abort(connectionId: string): Promise<void> {
    const managed = this.sessions.get(connectionId);
    if (!managed || managed.state !== 'busy') return;
    try {
      await managed.session.abort();
    } catch { /* best-effort */ }
    managed.state = 'ready';
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

  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, managed] of this.sessions) {
      if (managed.state === 'busy') continue; // never evict mid-request
      if (now - managed.lastActivity > this.idleTimeoutMs) {
        console.log(`[Gateway] Closing idle session for connection ${id.slice(0, 8)}...`);
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
