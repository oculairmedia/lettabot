import { Client, Connection } from '@temporalio/client';
import type { WorkerConfig, WorkerResult, WorkerTask } from './types.js';
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
): Promise<WorkerResult | null> {
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
    };

    const workflowId = `worker-spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const handle = await c.workflow.start<(task: WorkerTask) => Promise<WorkerResult>>(
      'WorkerSpawnWorkflow',
      {
        taskQueue: TASK_QUEUE,
        workflowId,
        workflowExecutionTimeout: `${task.resolvedTimeout + 60_000}ms`,
        args: [task],
      },
    );

    console.log(`[Worker] Started workflow ${workflowId}`);
    const result = await handle.result();

    if (result.success) {
      console.log(`[Worker] Workflow ${workflowId} completed: ${result.passagesWritten} passages written`);
    } else {
      console.warn(`[Worker] Workflow ${workflowId} failed: ${result.error}`);
    }

    return result;
  } catch (error) {
    console.error('[Worker] Failed to start worker spawn:', error);
    return null;
  }
}

export async function closeWorkerClient(): Promise<void> {
  client = null;
}
