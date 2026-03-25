/**
 * Gateway Resilience — Error classification and recovery helpers
 *
 * Extracted into a separate file to avoid merge conflicts with upstream
 * letta-ai/lettabot changes to agent-session-manager.ts and ws-gateway.ts.
 *
 * Ports the mature error handling patterns from src/core/bot.ts (lines 34-111)
 * into the gateway context, adapting them for the AgentSessionManager's
 * _doSendAndStream() catch block.
 */

import { createLogger } from '../logger.js';
import {
  ensureNoToolApprovals,
  recoverOrphanedConversationApproval,
  cancelRuns,
} from '../tools/letta-api.js';

const log = createLogger('GatewayResilience');

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

/**
 * Classified error type for the gateway error handler.
 *
 * - approval_conflict:      409 — stuck approval or concurrent request
 * - conversation_missing:   404 — conversation/agent deleted or expired
 * - session_busy:           409 — another request in-flight (same conversation)
 * - auth_error:             401/403 — bad API key or forbidden
 * - rate_limited:           429 — usage/rate limit exceeded
 * - server_error:           500/502/503 — Letta backend issue
 * - unknown:                anything else
 */
export type GatewayErrorType =
  | 'approval_conflict'
  | 'conversation_missing'
  | 'session_busy'
  | 'auth_error'
  | 'rate_limited'
  | 'server_error'
  | 'unknown';

export interface ClassifiedError {
  type: GatewayErrorType;
  /** Whether this error is worth retrying after recovery */
  retryable: boolean;
  /** Whether the session should be invalidated (subprocess killed, map entry removed) */
  fatal: boolean;
  /** Human-readable description for logs / WS error frames */
  description: string;
  /** The original error */
  cause: unknown;
}

/**
 * Classify a thrown error into a structured gateway error.
 *
 * Detection heuristics are ported from bot.ts:
 *   isApprovalConflictError (lines 34-43)
 *   isConversationMissingError (lines 50-60)
 *   formatApiErrorForUser (lines 66-111)
 */
export function classifyError(error: unknown): ClassifiedError {
  const msg = errorMessage(error);
  const status = errorStatus(error);

  // --- 409 CONFLICT: approval stuck or concurrent request ---
  if (status === 409
    || msg.includes('waiting for approval')
    || (msg.includes('conflict') && msg.includes('approval'))
    || msg.includes('another request is currently being processed')) {
    // Distinguish "approval stuck" from "session busy" (both 409)
    const isApproval = msg.includes('approval') || msg.includes('waiting for approval');
    if (isApproval) {
      return {
        type: 'approval_conflict',
        retryable: true,
        fatal: false,
        description: 'Stuck tool approval detected — recovering',
        cause: error,
      };
    }
    return {
      type: 'session_busy',
      retryable: false,
      fatal: false,
      description: 'Another request is still processing on this conversation',
      cause: error,
    };
  }

  // --- 404: conversation or agent not found ---
  if (status === 404
    || msg.includes('not found')
    || (msg.includes('conversation') && (msg.includes('missing') || msg.includes('does not exist')))
    || (msg.includes('agent') && msg.includes('not found'))) {
    return {
      type: 'conversation_missing',
      retryable: true,
      fatal: false,
      description: 'Conversation or agent not found — will reset and retry',
      cause: error,
    };
  }

  // --- 401/403: auth failure ---
  if (status === 401 || status === 403
    || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return {
      type: 'auth_error',
      retryable: false,
      fatal: true,
      description: 'Authentication failed — check API key configuration',
      cause: error,
    };
  }

  // --- 429: rate limited ---
  if (status === 429
    || msg.includes('rate limit') || msg.includes('usage limit')
    || msg.includes('out of credits')) {
    return {
      type: 'rate_limited',
      retryable: false,
      fatal: false,
      description: 'Rate limited — try again later',
      cause: error,
    };
  }

  // --- 5xx: server errors ---
  if (status !== undefined && status >= 500 && status < 600
    || msg.includes('internal server error')
    || msg.includes('bad gateway')
    || msg.includes('service unavailable')) {
    return {
      type: 'server_error',
      retryable: false,
      fatal: false,
      description: 'Letta API server error — try again later',
      cause: error,
    };
  }

  // --- Fallback ---
  return {
    type: 'unknown',
    retryable: false,
    fatal: false,
    description: truncate(msg, 200),
    cause: error,
  };
}

// ---------------------------------------------------------------------------
// Recovery Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to recover from a 409 approval conflict.
 *
 * 1. Cancel any in-flight runs on the agent
 * 2. Ensure no tools require approval (disable them)
 * 3. Scan the conversation for orphaned approval requests and auto-resolve them
 *
 * Returns true if recovery succeeded and a retry is safe.
 */
export async function recoverApprovalConflict(
  agentId: string,
  conversationId: string | null,
): Promise<boolean> {
  log.info(`Recovering approval conflict for agent ${agentId.slice(0, 12)}...`);

  try {
    // Step 1: Cancel stuck runs
    await cancelRuns(agentId);
  } catch (e) {
    log.warn(`Failed to cancel runs during approval recovery:`, e instanceof Error ? e.message : e);
  }

  try {
    // Step 2: Disable tool approvals so this doesn't happen again
    await ensureNoToolApprovals(agentId);
  } catch (e) {
    log.warn(`Failed to disable tool approvals during recovery:`, e instanceof Error ? e.message : e);
  }

  if (conversationId) {
    try {
      // Step 3: Resolve any orphaned approval_request_messages
      const result = await recoverOrphanedConversationApproval(agentId, conversationId);
      if (result.recovered) {
        log.info(`Recovered orphaned approvals: ${result.details}`);
      }
      return true;
    } catch (e) {
      log.warn(`Failed to recover orphaned approvals:`, e instanceof Error ? e.message : e);
      // Even if approval recovery fails, the cancelRuns + ensureNoToolApprovals
      // may have cleared the blockage, so still return true for retry.
      return true;
    }
  }

  // No conversation ID means we can't scan for orphaned approvals,
  // but cancelRuns + ensureNoToolApprovals should still help.
  return true;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Extract a lowercase error message string from any thrown value */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  if (typeof error === 'string') return error.toLowerCase();
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message).toLowerCase();
  }
  return '';
}

/** Extract an HTTP status code from error objects (SDK errors, fetch errors, etc.) */
function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
    // Nested: error.response.status (axios-style)
    if (e.response && typeof e.response === 'object') {
      const resp = e.response as Record<string, unknown>;
      if (typeof resp.status === 'number') return resp.status;
    }
  }
  return undefined;
}

/** Truncate a string to maxLen characters */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}
