/**
 * Background Task Workflow
 *
 * Wraps background tasks (email polling, heartbeats, cron) with a model swap:
 * 1. Save original model (Sonnet 4.5)
 * 2. Swap to cheap model (Haiku 4.5)
 * 3. Execute the background task
 * 4. Restore original model (guaranteed via compensating transactions)
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
const {
  swapAgentModel,
  executeBackgroundTask,
} = proxyActivities<typeof activities>({
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
 * - Before swapping, register restore as compensation
 * - On success OR failure, model is always restored
 * - Temporal guarantees this runs even after crashes
 */
export async function BackgroundTaskWorkflow(
  input: BackgroundTaskInput,
): Promise<BackgroundTaskResult> {
  const { agentId, message, taskType, backgroundModel } = input;

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
    // Phase 1: Swap to background model
    phase = 'swapping-model';
    const swapResult = await swapAgentModel({
      agentId,
      targetModel: backgroundModel,
    });
    originalModel = swapResult.previousModel;

    console.log(`[BackgroundTaskWorkflow] Model swapped: ${originalModel} -> ${backgroundModel}`);

    // Phase 2: Execute the background task
    phase = 'executing-task';
    const taskResult = await executeBackgroundTask({
      agentId,
      message,
    });

    console.log(`[BackgroundTaskWorkflow] Task completed: type=${taskType}`);

    // Phase 3: Restore original model (success path)
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
