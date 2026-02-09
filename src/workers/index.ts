import { loadConfig } from '../config/index.js';
import { getWorkersConfig } from './config.js';
import { registerWorkerTool } from './tool.js';
import { startWorkerSpawn, getWorkerStatus } from './client.js';
import type { WorkerStatusResult } from './client.js';
import { loadOrGenerateApiKey } from '../api/auth.js';
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

function getNotifyConfig() {
  const port = process.env.PORT || '8080';
  const host = process.env.API_HOST || '127.0.0.1';
  const apiUrl = `http://${host === '0.0.0.0' ? '192.168.50.90' : host}:${port}`;
  const apiKey = loadOrGenerateApiKey();
  return { apiUrl, apiKey };
}

export async function handleWorkerSpawnRequest(body: {
  task_description: string;
  agent_id: string;
  model?: string;
  tags?: string[];
  timeout_seconds?: number;
}): Promise<{ success: boolean; workflow_id?: string; error?: string }> {
  if (!initialized) {
    return { success: false, error: 'Worker system not initialized' };
  }

  const config: WorkerConfig = {
    taskPrompt: body.task_description,
    model: body.model,
    tags: body.tags,
    timeout: body.timeout_seconds ? body.timeout_seconds * 1000 : undefined,
  };

  const result = await startWorkerSpawn(body.agent_id, config, getNotifyConfig());

  if (!result) {
    return { success: false, error: 'Workflow failed to start' };
  }

  return {
    success: true,
    workflow_id: result.workflowId,
  };
}

export async function handleWorkerStatusRequest(workflowId: string): Promise<WorkerStatusResult | null> {
  if (!initialized) return null;
  return getWorkerStatus(workflowId);
}

export { startWorkerSpawn } from './client.js';
export type { WorkerConfig, WorkerResult, WorkersConfig } from './types.js';
