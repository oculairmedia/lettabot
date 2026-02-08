import { loadConfig } from '../config/index.js';
import { getWorkersConfig } from './config.js';
import { registerWorkerTool } from './tool.js';
import { startWorkerSpawn } from './client.js';
import type { WorkerConfig } from './types.js';

let initialized = false;

export async function initWorkers(agentId: string): Promise<void> {
  const rawConfig = loadConfig().workers;
  if (!rawConfig && !process.env.LETTABOT_WORKERS_ENABLED) {
    console.log('[Worker] Workers not configured, skipping initialization');
    return;
  }

  const config = getWorkersConfig(rawConfig);
  console.log(`[Worker] Initializing: model=${config.defaultModel}, maxConcurrent=${config.maxConcurrent}, prefix=${config.agentNamePrefix}`);

  try {
    await registerWorkerTool(agentId);
  } catch (err) {
    console.error('[Worker] Failed to register spawn_worker tool:', err);
  }

  initialized = true;
  console.log('[Worker] Initialization complete');
}

export async function handleWorkerSpawnRequest(body: {
  task_description: string;
  agent_id: string;
  model?: string;
  tags?: string[];
}): Promise<{ success: boolean; response: string | null; passages_written: number; error?: string }> {
  if (!initialized) {
    return { success: false, response: null, passages_written: 0, error: 'Worker system not initialized' };
  }

  const config: WorkerConfig = {
    taskPrompt: body.task_description,
    model: body.model,
    tags: body.tags,
  };

  const result = await startWorkerSpawn(body.agent_id, config);

  if (!result) {
    return { success: false, response: null, passages_written: 0, error: 'Workflow failed to start' };
  }

  return {
    success: result.success,
    response: result.response,
    passages_written: result.passagesWritten,
    error: result.error,
  };
}

export { startWorkerSpawn } from './client.js';
export type { WorkerConfig, WorkerResult, WorkersConfig } from './types.js';
