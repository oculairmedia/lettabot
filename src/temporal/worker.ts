/**
 * Temporal Worker for LettaBot Background Tasks
 *
 * Registers workflows and activities, polls the lettabot-background task queue.
 * Runs in-process alongside the bot (started from main.ts).
 *
 * Uses createRequire for workflowsPath since lettabot is ESM but
 * Temporal's workflow bundler needs a require.resolve path.
 */

import { Worker, NativeConnection } from '@temporalio/worker';
import { createRequire } from 'node:module';
import * as activities from './activities.js';

const require = createRequire(import.meta.url);

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || '192.168.50.90:7233';
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || 'lettabot-background';

let worker: Worker | null = null;

/**
 * Start the Temporal worker.
 * Connects to Temporal server, registers workflows + activities, and polls for tasks.
 * Returns the worker instance for graceful shutdown.
 */
export async function startWorker(): Promise<Worker> {
  console.log(`[Temporal Worker] Connecting to Temporal at ${TEMPORAL_ADDRESS}`);

  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
  });

  worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('../temporal-cjs/workflows'),
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
    worker.shutdown();
    worker = null;
  }
}
