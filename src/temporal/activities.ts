/**
 * Temporal Activities for Background Task Model Swap
 *
 * These activities handle Letta API calls for swapping agent models
 * during background tasks (email polling, heartbeats, cron jobs).
 *
 * Activities call the Letta REST API directly (stateless HTTP) rather
 * than going through the in-process bot.sendToAgent() which is stateful.
 *
 * Error classification:
 * - 4xx / auth errors -> ApplicationFailure.nonRetryable
 * - 5xx / network errors -> ApplicationFailure.retryable
 */

import { ApplicationFailure } from '@temporalio/activity';

// Configuration from environment (set by configToEnv in io.ts)
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || 'http://192.168.50.90:8289';
const LETTA_API_KEY = process.env.LETTA_API_KEY || '';

// --- Types ---

export interface SwapModelInput {
  agentId: string;
  targetModel: string;
}

export interface SwapModelResult {
  previousModel: string;
}

export interface ExecuteTaskInput {
  agentId: string;
  message: string;
}

export interface ExecuteTaskResult {
  response: string | null;
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

function classifyError(error: unknown): never {
  if (error instanceof ApplicationFailure) {
    throw error;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // Auth / client errors -> non-retryable
    if (msg.includes('401') || msg.includes('403') || msg.includes('404') || msg.includes('400') || msg.includes('422')) {
      throw ApplicationFailure.nonRetryable(
        `Client error: ${error.message}`,
        'LettaClientError',
      );
    }

    // Server errors -> retryable
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('timeout')) {
      throw ApplicationFailure.retryable(
        `Server error: ${error.message}`,
        'LettaServerError',
      );
    }

    // Network errors -> retryable
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('econnrefused') || msg.includes('econnreset')) {
      throw ApplicationFailure.retryable(
        `Network error: ${error.message}`,
        'LettaNetworkError',
      );
    }
  }

  // Unknown -> retryable to be safe
  throw ApplicationFailure.retryable(
    `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    'LettaUnknownError',
  );
}

// --- Activities ---

/**
 * Swap an agent's model to the target model.
 * Returns the previous model handle so it can be restored.
 */
export async function swapAgentModel(input: SwapModelInput): Promise<SwapModelResult> {
  const { agentId, targetModel } = input;
  console.log(`[Temporal Activity] swapAgentModel: agent=${agentId}, target=${targetModel}`);

  try {
    // Step 1: Get current model
    const getRes = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}`, {
      method: 'GET',
      headers: lettaHeaders(),
    });

    if (!getRes.ok) {
      const body = await getRes.text();
      throw new Error(`GET agent failed (${getRes.status}): ${body}`);
    }

    const agent = await getRes.json() as { model?: string };
    const previousModel = agent.model || 'unknown';

    // Step 2: Update to target model
    const updateRes = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}`, {
      method: 'PATCH',
      headers: lettaHeaders(),
      body: JSON.stringify({ model: targetModel }),
    });

    if (!updateRes.ok) {
      const body = await updateRes.text();
      throw new Error(`PATCH agent model failed (${updateRes.status}): ${body}`);
    }

    console.log(`[Temporal Activity] Model swapped: ${previousModel} -> ${targetModel}`);
    return { previousModel };
  } catch (error) {
    classifyError(error);
  }
}

/**
 * Restore an agent's model to the original model.
 * This is the compensation activity - must succeed to guarantee model restoration.
 */
export async function restoreAgentModel(input: SwapModelInput): Promise<void> {
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
    classifyError(error);
  }
}

/**
 * Execute a background task by sending a message to the Letta agent.
 * Uses the Letta REST API directly (POST /v1/agents/{id}/messages).
 */
export async function executeBackgroundTask(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
  const { agentId, message } = input;
  console.log(`[Temporal Activity] executeBackgroundTask: agent=${agentId}, message=${message.slice(0, 100)}...`);

  try {
    const res = await fetch(`${LETTA_BASE_URL}/v1/agents/${agentId}/messages`, {
      method: 'POST',
      headers: lettaHeaders(),
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: message,
        }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`POST messages failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { messages?: Array<{ message_type?: string; content?: string }> };

    // Extract assistant response text
    let responseText: string | null = null;
    if (data.messages) {
      for (const msg of data.messages) {
        if (msg.message_type === 'assistant_message' && msg.content) {
          responseText = (responseText || '') + msg.content;
        }
      }
    }

    console.log(`[Temporal Activity] Task completed, response: ${responseText?.slice(0, 100) || '(none)'}...`);
    return { response: responseText };
  } catch (error) {
    classifyError(error);
  }
}
