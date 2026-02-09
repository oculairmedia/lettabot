/**
 * Worker Spawn System — Type Definitions
 *
 * Self-contained in src/workers/. No dependencies on existing codebase types.
 */

// --- Config ---

/** Workers section of lettabot.yaml */
export interface WorkersConfig {
  /** Model for worker agents (default: 'anthropic/haiku-4-5') */
  defaultModel: string;
  /** Max concurrent worker agents (default: 3) */
  maxConcurrent: number;
  /** Task timeout in ms (default: 300000 = 5 minutes) */
  taskTimeout: number;
  /** Name prefix for ephemeral agents — also used for orphan identification (default: 'worker-') */
  agentNamePrefix: string;
  /** Tools blocked on worker agents (default: ['memory']) */
  blockedTools: string[];
}

// --- Worker Task Types ---

/** Configuration for a single worker spawn request */
export interface WorkerConfig {
  /** The task prompt to send to the worker agent */
  taskPrompt: string;
  /** Model override (defaults to WorkersConfig.defaultModel) */
  model?: string;
  /** Tools to block on the worker (defaults to WorkersConfig.blockedTools) */
  blockedTools?: string[];
  /** Task timeout in ms (defaults to WorkersConfig.taskTimeout) */
  timeout?: number;
  /** Tags for archival memory deduplication */
  tags?: string[];
}

/** Input to the WorkerSpawnWorkflow — passed through Temporal */
export interface WorkerTask {
  /** The main agent whose memory blocks are shared with the worker */
  mainAgentId: string;
  /** Worker configuration */
  config: WorkerConfig;
  /** Resolved from WorkersConfig at call time */
  agentNamePrefix: string;
  /** Resolved model (config.model ?? workersConfig.defaultModel) */
  resolvedModel: string;
  /** Resolved blocked tools */
  resolvedBlockedTools: string[];
  /** Resolved timeout in ms */
  resolvedTimeout: number;
  /** Callback config for completion notification via /api/v1/inject */
  notifyConfig: WorkerNotifyConfig;
}

/** Result returned by WorkerSpawnWorkflow */
export interface WorkerResult {
  /** Whether the task succeeded */
  success: boolean;
  /** The worker agent's response text */
  response: string | null;
  /** Number of archival passages written to the main agent */
  passagesWritten: number;
  /** The ephemeral worker agent ID (for debugging) */
  workerAgentId: string;
  /** Task duration in ms */
  duration: number;
  /** Error message if failed */
  error?: string;
}

/** Immediate response from async spawn (returned before workflow completes) */
export interface WorkerSpawnResponse {
  /** Temporal workflow ID for tracking */
  workflowId: string;
  /** Always 'started' for async spawn */
  status: 'started';
}

/** Notification config passed into the workflow for completion callback */
export interface WorkerNotifyConfig {
  /** LettaBot API base URL (e.g. http://192.168.50.90:8407) */
  apiUrl: string;
  /** LettaBot API key for /api/v1/inject authentication */
  apiKey: string;
}
