/**
 * Temporal Activities for Background Task Execution
 *
 * Background tasks run through Letta Code SDK so the agent keeps local
 * tool execution capability (Bash, Read, Glob, lettabot-message, etc.).
 *
 * Error classification:
 * - 4xx / auth errors -> ApplicationFailure.nonRetryable
 * - 5xx / network errors -> ApplicationFailure.retryable
 */

import { ApplicationFailure } from '@temporalio/activity';
import { createSession, resumeSession } from '@letta-ai/letta-code-sdk';
import type { Session } from '@letta-ai/letta-code-sdk';

// Configuration from environment (set by configToEnv in io.ts)
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'http://192.168.50.90:8289';
const LETTA_API_KEY = process.env.LETTA_API_KEY || '';

interface ProcessingLockController {
  acquireProcessingLock(timeoutMs?: number): Promise<boolean>;
  releaseProcessingLock(): void;
}

let lockController: ProcessingLockController | null = null;

export function setProcessingLockController(controller: ProcessingLockController | null): void {
  lockController = controller;
}

// --- Types ---

export interface RestoreModelInput {
  agentId: string;
  targetModel: string;
}

export interface ExecuteTaskInput {
  agentId: string;
  message: string;
  conversationId: string | null;
  backgroundModel: string;
  allowedTools: string[];
  cwd: string;
}

export interface ExecuteTaskResult {
  response: string | null;
  originalModel: string;
}

// --- Helpers ---

function lettaHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Letta-Source': 'lettabot-temporal',
  };
  if (LETTA_API_KEY) {
    headers['Authorization'] = `Bearer ${LETTA_API_KEY}`;
  }
  return headers;
}

async function getAgentModel(agentId: string): Promise<string> {
  const getRes = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}`, {
    method: 'GET',
    headers: lettaHeaders(),
  });

  if (!getRes.ok) {
    const body = await getRes.text();
    throw new Error(`GET agent failed (${getRes.status}): ${body}`);
  }

  const agent = await getRes.json() as { model?: string };
  if (!agent.model) {
    throw new Error('Agent model missing from GET /v1/agents response');
  }
  return agent.model;
}

function classifyError(error: unknown): ApplicationFailure {
  if (error instanceof ApplicationFailure) {
    return error;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // Auth / client errors -> non-retryable
    if (msg.includes('401') || msg.includes('403') || msg.includes('404') || msg.includes('400') || msg.includes('422')) {
      return ApplicationFailure.nonRetryable(
        `Client error: ${error.message}`,
        'LettaClientError',
      );
    }

    // Server errors -> retryable
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('timeout')) {
      return ApplicationFailure.retryable(
        `Server error: ${error.message}`,
        'LettaServerError',
      );
    }

    // Network errors -> retryable
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('econnrefused') || msg.includes('econnreset')) {
      return ApplicationFailure.retryable(
        `Network error: ${error.message}`,
        'LettaNetworkError',
      );
    }
  }

  // Unknown -> retryable to be safe
  return ApplicationFailure.retryable(
    `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    'LettaUnknownError',
  );
}

// --- Activities ---

/**
 * Restore an agent's model to the original model.
 * This is the compensation activity - must succeed to guarantee model restoration.
 */
export async function restoreAgentModel(input: RestoreModelInput): Promise<void> {
  const { agentId, targetModel: originalModel } = input;
  console.log(`[Temporal Activity] restoreAgentModel: agent=${agentId}, restoring to ${originalModel}`);

  try {
    const res = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}`, {
      method: 'PATCH',
      headers: lettaHeaders(),
      body: JSON.stringify({ model: originalModel }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`PATCH restore model failed (${res.status}): ${body}`);
    }

    console.log(`[Temporal Activity] Model restored to ${originalModel}`);
  } catch (error) {
    throw classifyError(error);
  }
}

/**
 * Execute a background task through Letta Code SDK so local tools are available.
 */
export async function executeBackgroundTask(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
  const { agentId, message, conversationId, backgroundModel, allowedTools, cwd } = input;
  console.log(`[Temporal Activity] executeBackgroundTask: agent=${agentId}, model=${backgroundModel}, message=${message.slice(0, 100)}...`);

  let lockAcquired = false;
  let session: Session | undefined;

  try {
    const originalModel = await getAgentModel(agentId);

    if (lockController) {
      lockAcquired = await lockController.acquireProcessingLock(30_000);
      if (!lockAcquired) {
        throw ApplicationFailure.retryable(
          'Timed out waiting for bot processing lock',
          'ProcessingLockTimeout',
        );
      }
    }

    const baseOptions = {
      model: backgroundModel,
      permissionMode: 'bypassPermissions' as const,
      allowedTools,
      cwd,
    };

    if (conversationId) {
      session = resumeSession(conversationId, baseOptions);
    } else {
      session = createSession(agentId, baseOptions);
    }

    await session.send(message);

    let responseText = '';
    for await (const msg of session.stream()) {
      if (msg.type === 'assistant' && typeof msg.content === 'string') {
        responseText += msg.content;
      }
    }

    console.log(`[Temporal Activity] Task completed, response: ${responseText.slice(0, 100) || '(none)'}...`);
    return {
      response: responseText || null,
      originalModel,
    };
  } catch (error) {
    throw classifyError(error);
  } finally {
    if (session) {
      session.close();
    }
    if (lockAcquired && lockController) {
      lockController.releaseProcessingLock();
    }
  }
}
