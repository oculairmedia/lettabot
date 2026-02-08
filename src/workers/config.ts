import type { WorkersConfig } from './types.js';

const DEFAULTS: WorkersConfig = {
  defaultModel: 'anthropic/haiku-4-5',
  maxConcurrent: 3,
  taskTimeout: 300_000,
  agentNamePrefix: 'worker-',
  blockedTools: ['memory'],
};

export function getWorkersConfig(raw?: Partial<WorkersConfig>): WorkersConfig {
  const config: WorkersConfig = {
    defaultModel: raw?.defaultModel || DEFAULTS.defaultModel,
    maxConcurrent: raw?.maxConcurrent ?? DEFAULTS.maxConcurrent,
    taskTimeout: raw?.taskTimeout ?? DEFAULTS.taskTimeout,
    agentNamePrefix: raw?.agentNamePrefix || DEFAULTS.agentNamePrefix,
    blockedTools: raw?.blockedTools ?? DEFAULTS.blockedTools,
  };

  if (config.maxConcurrent < 1) {
    console.warn(`[Worker] maxConcurrent=${config.maxConcurrent} invalid, using ${DEFAULTS.maxConcurrent}`);
    config.maxConcurrent = DEFAULTS.maxConcurrent;
  }

  if (config.taskTimeout < 1000) {
    console.warn(`[Worker] taskTimeout=${config.taskTimeout}ms too low, using ${DEFAULTS.taskTimeout}ms`);
    config.taskTimeout = DEFAULTS.taskTimeout;
  }

  if (!config.blockedTools.includes('memory')) {
    console.warn('[Worker] blockedTools missing "memory" — adding for core memory protection');
    config.blockedTools = [...config.blockedTools, 'memory'];
  }

  return config;
}
