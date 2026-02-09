import {
  proxyActivities,
  defineQuery,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

import type * as workerActivities from './activities';
import type { WorkerTask, WorkerResult } from './types';

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
  const { createWorkerAgentActivity, executeWorkerTaskActivity, writeResultsToArchivalActivity } =
    proxyActivities<typeof workerActivities>({
      startToCloseTimeout: task.resolvedTimeout,
      retry: {
        initialInterval: '2 seconds',
        backoffCoefficient: 2,
        maximumInterval: '60 seconds',
        maximumAttempts: 3,
        nonRetryableErrorTypes: ['WorkerClientError'],
      },
    });

  const { notifyCompletionActivity } = proxyActivities<typeof workerActivities>({
    startToCloseTimeout: task.resolvedTimeout,
    retry: {
      initialInterval: '5 seconds',
      backoffCoefficient: 2,
      maximumInterval: '60 seconds',
      maximumAttempts: 2,
      nonRetryableErrorTypes: ['WorkerClientError'],
    },
  });

  const startTime = Date.now();
  let phase = 'initializing';
  let workerAgentId = '';
  let lastError: string | undefined;

  setHandler(workerStatusQuery, () => ({
    phase,
    workerAgentId: workerAgentId || undefined,
    error: lastError,
  }));

  let result: WorkerResult;

  try {
    phase = 'creating-agent';
    workerAgentId = await createWorkerAgentActivity(task);

    phase = 'executing-task';
    const response = await executeWorkerTaskActivity(workerAgentId, task.config.taskPrompt);

    phase = 'writing-results';
    const wfId = workflowInfo().workflowId;
    const passagesWritten = await writeResultsToArchivalActivity(
      task.mainAgentId,
      response,
      wfId,
      task.config.tags ?? [],
    );

    result = {
      success: true,
      response,
      passagesWritten,
      workerAgentId,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    result = {
      success: false,
      response: null,
      passagesWritten: 0,
      workerAgentId,
      duration: Date.now() - startTime,
      error: lastError,
    };
  }

  phase = result.success ? 'notifying' : 'notifying-failure';
  try {
    await notifyCompletionActivity(
      task.notifyConfig.apiUrl,
      task.notifyConfig.apiKey,
      workflowInfo().workflowId,
      task.config.taskPrompt,
      result.success,
      result.response,
      result.passagesWritten,
      result.error,
    );
  } catch {
    // Notification failure shouldn't fail the workflow — results are already in archival
  }

  if (workerAgentId) {
    phase = 'cleaning-up';
    try {
      await deleteWorkerAgentActivity(workerAgentId);
    } catch {
      // Cleanup failure is logged by the activity
    }
  }

  phase = result.success ? 'completed' : 'failed';
  return result;
}
