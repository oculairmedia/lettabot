import { Client, Connection } from '@temporalio/client';
import type { WorkerConfig, WorkerTask, WorkerSpawnResponse, WorkerNotifyConfig } from './types.js';
import { getWorkersConfig } from './config.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || '192.168.50.90:7233';
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || 'lettabot-background';

let client: Client | null = null;

async function getClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    client = new Client({ connection });
  }
  return client;
}

export async function startWorkerSpawn(
  mainAgentId: string,
  config: WorkerConfig,
  notifyConfig: WorkerNotifyConfig,
): Promise<WorkerSpawnResponse | null> {
  try {
    const c = await getClient();
    const workersConfig = getWorkersConfig();

    const task: WorkerTask = {
      mainAgentId,
      config,
      agentNamePrefix: workersConfig.agentNamePrefix,
      resolvedModel: config.model ?? workersConfig.defaultModel,
      resolvedBlockedTools: config.blockedTools ?? workersConfig.blockedTools,
      resolvedTimeout: config.timeout ?? workersConfig.taskTimeout,
      notifyConfig,
    };

    const workflowId = `worker-spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await c.workflow.start('WorkerSpawnWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId,
      workflowExecutionTimeout: `${task.resolvedTimeout + 60_000}ms`,
      args: [task],
    });

    console.log(`[Worker] Started async workflow ${workflowId}`);

    return { workflowId, status: 'started' };
  } catch (error) {
    console.error('[Worker] Failed to start worker spawn:', error);
    return null;
  }
}

export interface WorkerStatusResult {
  workflowId: string;
  status: string;
  phase?: string;
  workerAgentId?: string;
  error?: string;
}

export async function getWorkerStatus(workflowId: string): Promise<WorkerStatusResult | null> {
  try {
    const c = await getClient();
    const handle = c.workflow.getHandle(workflowId);
    const description = await handle.describe();

    const workflowStatus = description.status.name;

    let phase: string | undefined;
    let workerAgentId: string | undefined;
    let error: string | undefined;

    if (workflowStatus === 'RUNNING') {
      try {
        const queryResult = await handle.query<{ phase: string; workerAgentId?: string; error?: string }>('workerStatus');
        phase = queryResult.phase;
        workerAgentId = queryResult.workerAgentId;
        error = queryResult.error;
      } catch {
        phase = 'unknown';
      }
    }

    return { workflowId, status: workflowStatus, phase, workerAgentId, error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('NOT_FOUND')) {
      return null;
    }
    console.error(`[Worker] Failed to get status for ${workflowId}:`, err);
    return null;
  }
}

export async function closeWorkerClient(): Promise<void> {
  client = null;
}
