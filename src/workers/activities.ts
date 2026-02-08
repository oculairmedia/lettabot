import { ApplicationFailure } from '@temporalio/activity';
import type { WorkerTask } from './types.js';
import {
  createWorkerAgent,
  deleteWorkerAgent,
  sendMessageToAgent,
  writeArchivalPassage,
} from './letta.js';

function classifyError(error: unknown): ApplicationFailure {
  if (error instanceof ApplicationFailure) return error;

  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (msg.includes('401') || msg.includes('403') || msg.includes('404') || msg.includes('400') || msg.includes('422')) {
    return ApplicationFailure.nonRetryable(`Client error: ${msg}`, 'WorkerClientError');
  }

  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('timeout')) {
    return ApplicationFailure.retryable(`Server error: ${msg}`, 'WorkerServerError');
  }

  return ApplicationFailure.retryable(
    `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    'WorkerUnknownError',
  );
}

export async function createWorkerAgentActivity(task: WorkerTask): Promise<string> {
  const agentName = `${task.agentNamePrefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    return await createWorkerAgent({
      mainAgentId: task.mainAgentId,
      model: task.resolvedModel,
      agentName,
      taskPrompt: task.config.taskPrompt,
      blockedTools: task.resolvedBlockedTools,
    });
  } catch (error) {
    throw classifyError(error);
  }
}

export async function executeWorkerTaskActivity(
  workerAgentId: string,
  taskPrompt: string,
): Promise<string> {
  try {
    return await sendMessageToAgent(workerAgentId, taskPrompt);
  } catch (error) {
    throw classifyError(error);
  }
}

export async function writeResultsToArchivalActivity(
  mainAgentId: string,
  response: string,
  workflowId: string,
  tags: string[],
): Promise<number> {
  try {
    const allTags = [`worker:${workflowId}`, ...tags];
    const written = await writeArchivalPassage(mainAgentId, response, allTags);
    return written ? 1 : 0;
  } catch (error) {
    throw classifyError(error);
  }
}

export async function deleteWorkerAgentActivity(workerAgentId: string): Promise<void> {
  try {
    await deleteWorkerAgent(workerAgentId);
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('404') || msg.includes('not found')) return;
    throw classifyError(error);
  }
}
