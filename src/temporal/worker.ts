/**
 * Temporal Worker for LettaBot Background Tasks
 *
 * Registers workflows and activities, polls the lettabot-background task queue.
 * Runs in-process alongside the bot (started from main.ts).
 *
 * Uses bundleWorkflowCode to pre-bundle the workflow TypeScript source,
 * avoiding ESM/CJS conflicts since the project is "type": "module".
 */

import { Worker, NativeConnection, bundleWorkflowCode, Runtime } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as activities from './activities.js';
import type { LettaBot } from '../core/bot.js';
import { setProcessingLockController } from './activities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || '192.168.50.90:7233';
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || 'lettabot-background';

let worker: Worker | null = null;

/**
 * Start the Temporal worker.
 * Pre-bundles workflow code, connects to Temporal server,
 * registers workflows + activities, and polls for tasks.
 * Returns the worker instance for graceful shutdown.
 */
export async function startWorker(bot?: LettaBot): Promise<Worker> {
  // Disable worker heartbeating — requires Temporal server ≥1.29.1 (we run 1.22.4).
  // See issue lb-2ry for the server upgrade plan.
  Runtime.install({
    workerHeartbeatInterval: 0,
  });

  console.log(`[Temporal Worker] Connecting to Temporal at ${TEMPORAL_ADDRESS}`);

  if (bot) {
    setProcessingLockController(bot);
  }

  // Pre-bundle from TypeScript source — webpack handles TS natively,
  // avoiding the ESM/CJS "exports is not defined" issue with compiled .js
  const workflowsPath = path.resolve(__dirname, '..', '..', 'src', 'temporal', 'workflows.ts');
  console.log(`[Temporal Worker] Bundling workflows from: ${workflowsPath}`);
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath,
  });
  console.log(`[Temporal Worker] Workflow bundle created successfully`);

  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
  });

  worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: TASK_QUEUE,
    workflowBundle,
    activities,
  });

  console.log(`[Temporal Worker] Started on task queue: ${TASK_QUEUE}`);
  console.log(`[Temporal Worker] Registered workflows: BackgroundTaskWorkflow`);
  console.log(`[Temporal Worker] Registered activities: ${Object.keys(activities).filter(k => typeof (activities as Record<string, unknown>)[k] === 'function').join(', ')}`);

  // Run in background (non-blocking)
  worker.run().catch(err => {
    console.error('[Temporal Worker] Fatal error:', err);
  });

  return worker;
}

/**
 * Gracefully shut down the Temporal worker.
 */
export async function stopWorker(): Promise<void> {
  if (worker) {
    console.log('[Temporal Worker] Shutting down...');
    try {
      worker.shutdown();
    } catch {
      // Worker may already be draining from Runtime's built-in signal handler
    }
    worker = null;
  }
  setProcessingLockController(null);
}
