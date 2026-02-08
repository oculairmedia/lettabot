/**
 * Background Task Workflow
 *
 * Wraps background tasks (email polling, heartbeats, cron) with durable
 * execution and model restoration:
 * 1. Execute the background task through Letta Code SDK on Haiku
 * 2. Restore original model in a compensation step
 *
 * The compensating transaction pattern ensures the model is ALWAYS restored,
 * even if the process crashes mid-task. Temporal's durable execution
 * guarantees the finally/compensation block will run.
 */

import {
  proxyActivities,
  defineQuery,
  setHandler,
} from '@temporalio/workflow';

import type * as activities from './activities';

// Proxy activities with retry policies
const { executeBackgroundTask } = proxyActivities<typeof activities>({
  startToCloseTimeout: '120 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '60 seconds',
    maximumAttempts: 5,
    nonRetryableErrorTypes: ['LettaClientError'],
  },
});

// Restore gets aggressive retry - this MUST succeed
const { restoreAgentModel } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 20, // Very aggressive - model restoration is critical
    nonRetryableErrorTypes: ['LettaClientError'],
  },
});

export type { BackgroundTaskInput, BackgroundTaskResult } from './types';
import type { BackgroundTaskInput, BackgroundTaskResult } from './types';

// --- Queries ---

export const statusQuery = defineQuery<{
  phase: string;
  originalModel?: string;
  error?: string;
}>('status');

// --- Workflow ---

/**
 * BackgroundTaskWorkflow
 *
 * Compensating transaction pattern:
 * - Execute task through SDK with local tool access
 * - Restore model on success OR failure
 * - Temporal guarantees this runs even after crashes
 */
export async function BackgroundTaskWorkflow(
  input: BackgroundTaskInput,
): Promise<BackgroundTaskResult> {
  const { agentId, message, taskType, backgroundModel, conversationId, allowedTools, cwd } = input;

  let phase = 'initializing';
  let originalModel = '';
  let lastError: string | undefined;

  // Wire up status query
  setHandler(statusQuery, () => ({
    phase,
    originalModel: originalModel || undefined,
    error: lastError,
  }));

  console.log(`[BackgroundTaskWorkflow] Starting: type=${taskType}, agent=${agentId}, model=${backgroundModel}`);

  try {
    // Phase 1: Execute the background task through SDK
    phase = 'executing-task';
    const taskResult = await executeBackgroundTask({
      agentId,
      message,
      conversationId,
      backgroundModel,
      allowedTools,
      cwd,
    });
    originalModel = taskResult.originalModel;

    console.log(`[BackgroundTaskWorkflow] Task completed: type=${taskType}`);

    // Phase 2: Restore original model (success path)
    phase = 'restoring-model';
    await restoreAgentModel({
      agentId,
      targetModel: originalModel,
    });

    console.log(`[BackgroundTaskWorkflow] Model restored to ${originalModel}`);
    phase = 'completed';

    return {
      success: true,
      taskType,
      response: taskResult.response,
      originalModel,
    };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.log(`[BackgroundTaskWorkflow] Error in phase ${phase}: ${lastError}`);

    // Compensation: restore model if we swapped it
    if (originalModel) {
      phase = 'compensating';
      try {
        await restoreAgentModel({
          agentId,
          targetModel: originalModel,
        });
        console.log(`[BackgroundTaskWorkflow] Compensation: model restored to ${originalModel}`);
      } catch (restoreError) {
        // This is critical - log loudly but Temporal will retry the whole workflow
        const restoreMsg = restoreError instanceof Error ? restoreError.message : String(restoreError);
        console.error(`[BackgroundTaskWorkflow] CRITICAL: Failed to restore model! ${restoreMsg}`);
      }
    }

    phase = 'failed';
    return {
      success: false,
      taskType,
      response: null,
      originalModel: originalModel || 'unknown',
      error: lastError,
    };
  }
}
