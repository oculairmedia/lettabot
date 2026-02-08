/**
 * Temporal Client for LettaBot
 *
 * Singleton client used by polling/heartbeat/cron services to trigger
 * background task workflows instead of calling bot.sendToAgent directly.
 */

import { Client, Connection } from '@temporalio/client';
import type { BackgroundTaskInput, BackgroundTaskResult } from './types.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || '192.168.50.90:7233';
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || 'lettabot-background';
const BACKGROUND_MODEL = process.env.TEMPORAL_BACKGROUND_MODEL || 'openai-proxy/gpt51';

let client: Client | null = null;

/**
 * Get or create the singleton Temporal client.
 */
async function getClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({
      address: TEMPORAL_ADDRESS,
    });
    client = new Client({ connection });
    console.log(`[Temporal Client] Connected to ${TEMPORAL_ADDRESS}`);
  }
  return client;
}

/**
 * Start a background task workflow.
 *
 * This replaces bot.sendToAgent() for background tasks when Temporal is enabled.
 * The workflow will:
 * 1. Swap the agent's model to the background model (Haiku)
 * 2. Execute the task (send message to agent)
 * 3. Restore the agent's model to the original (Sonnet)
 *
 * @param agentId - The Letta agent ID
 * @param message - The message to send to the agent
 * @param taskType - Task type identifier (e.g. 'email-poll', 'heartbeat', 'cron-daily')
 * @param conversationId - Shared conversation ID to resume
 * @param allowedTools - Tool whitelist for SDK session
 * @param cwd - Working directory for SDK session
 * @returns The workflow result with response text, or null on error
 */
export async function startBackgroundTask(
  agentId: string,
  message: string,
  taskType: string,
  conversationId: string | null,
  allowedTools: string[],
  cwd: string,
): Promise<BackgroundTaskResult | null> {
  try {
    const c = await getClient();

    const workflowId = `bg-${taskType}-${Date.now()}`;

    const handle = await c.workflow.start<(input: BackgroundTaskInput) => Promise<BackgroundTaskResult>>(
      'BackgroundTaskWorkflow',
      {
        taskQueue: TASK_QUEUE,
        workflowId,
        args: [{
          agentId,
          message,
          taskType,
          backgroundModel: BACKGROUND_MODEL,
          conversationId,
          allowedTools,
          cwd,
        }],
      },
    );

    console.log(`[Temporal Client] Started workflow ${workflowId} for ${taskType}`);

    // Wait for completion (background tasks are expected to complete in <2 minutes)
    const result = await handle.result();

    if (result.success) {
      console.log(`[Temporal Client] Workflow ${workflowId} completed successfully`);
    } else {
      console.warn(`[Temporal Client] Workflow ${workflowId} failed: ${result.error}`);
    }

    return result;
  } catch (error) {
    console.error(`[Temporal Client] Failed to run background task ${taskType}:`, error);
    return null;
  }
}

/**
 * Close the Temporal client connection.
 */
export async function closeClient(): Promise<void> {
  if (client) {
    // Client doesn't have an explicit close method in @temporalio/client
    // Setting to null allows GC
    client = null;
    console.log('[Temporal Client] Disconnected');
  }
}
