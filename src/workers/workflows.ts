import {
  proxyActivities,
  defineQuery,
  setHandler,
} from '@temporalio/workflow';

import type * as workerActivities from './activities';
import type { WorkerTask, WorkerResult } from './types';

const { createWorkerAgentActivity, executeWorkerTaskActivity, writeResultsToArchivalActivity } =
  proxyActivities<typeof workerActivities>({
    startToCloseTimeout: '120 seconds',
    retry: {
      initialInterval: '2 seconds',
      backoffCoefficient: 2,
      maximumInterval: '60 seconds',
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['WorkerClientError'],
    },
  });

const { deleteWorkerAgentActivity } = proxyActivities<typeof workerActivities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 10,
    nonRetryableErrorTypes: ['WorkerClientError'],
  },
});

export type { WorkerTask, WorkerResult } from './types';

export const workerStatusQuery = defineQuery<{
  phase: string;
  workerAgentId?: string;
  error?: string;
}>('workerStatus');

export async function WorkerSpawnWorkflow(task: WorkerTask): Promise<WorkerResult> {
  const startTime = Date.now();
  let phase = 'initializing';
  let workerAgentId = '';
  let lastError: string | undefined;

  setHandler(workerStatusQuery, () => ({
    phase,
    workerAgentId: workerAgentId || undefined,
    error: lastError,
  }));

  try {
    phase = 'creating-agent';
    workerAgentId = await createWorkerAgentActivity(task);

    phase = 'executing-task';
    const response = await executeWorkerTaskActivity(workerAgentId, task.config.taskPrompt);

    phase = 'writing-results';
    const passagesWritten = await writeResultsToArchivalActivity(
      task.mainAgentId,
      response,
      // workflowId not available inside workflow — use agent ID as dedup key
      workerAgentId,
      task.config.tags ?? [],
    );

    phase = 'completed';
    return {
      success: true,
      response,
      passagesWritten,
      workerAgentId,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    phase = 'failed';

    return {
      success: false,
      response: null,
      passagesWritten: 0,
      workerAgentId,
      duration: Date.now() - startTime,
      error: lastError,
    };
  } finally {
    if (workerAgentId) {
      phase = 'cleaning-up';
      try {
        await deleteWorkerAgentActivity(workerAgentId);
      } catch {
        // Cleanup failure is logged by the activity — don't mask the primary error
      }
    }
  }
}
