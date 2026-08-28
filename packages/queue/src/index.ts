import { env } from '@frp/config';
import type { RunPublisher } from '@frp/core';
import type { StepId } from '@frp/schemas';
import { Queue, type JobsOptions } from 'bullmq';
import Redis, { type RedisOptions } from 'ioredis';

/**
 * Queue and pub/sub wiring.
 *
 * One BullMQ job equals one attempt of one pipeline step. That single decision
 * is what buys the system its operational properties for free:
 *
 *   - retries and backoff are queue concerns, so a waiting step costs a queue
 *     delay rather than a blocked worker slot;
 *   - a worker crash mid-run loses at most one step attempt, and the step's
 *     recorded state lets the redelivered job resume rather than restart;
 *   - steps are individually observable in any BullMQ dashboard.
 *
 * Redis pub/sub carries live run updates to whichever API instance a browser
 * happens to be connected to, which is what lets the pipeline view stream from
 * more than one API process.
 */

/** BullMQ forbids ':' in queue names — it uses that separator for its keys. */
export const RUN_STEP_QUEUE = 'frp-run-step';

export interface RunStepJob {
  runId: string;
  stepId: StepId;
  tenantId: string;
  projectId: string;
}

export function redisOptions(url = env().REDIS_URL): RedisOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.username ? { username: parsed.username } : {}),
    // BullMQ requires this to be null so blocking commands are not cut short.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

export function createRedis(url = env().REDIS_URL): Redis {
  return new Redis(redisOptions(url));
}

export function createRunStepQueue(connection: Redis): Queue<RunStepJob> {
  return new Queue<RunStepJob>(RUN_STEP_QUEUE, { connection });
}

export interface EnqueueOptions {
  /** Attempts allowed for this step, taken from the step definition. */
  attempts: number;
  delayMs?: number;
}

/**
 * Enqueues one step.
 *
 * The job id is derived from (run, step), which makes a duplicate enqueue — a
 * double-clicked "Run", a redelivered webhook — a no-op *while a job for that
 * step is still pending*. That is the guarantee we want; "never again" is not,
 * because a step legitimately runs a second time when an operator resumes a
 * run parked at the review gate.
 *
 * BullMQ retains finished jobs and silently returns the existing job on an id
 * collision, so a finished job under the same id is removed first. Without
 * this, `POST /runs/:id/resume` reports success and nothing happens.
 */
export async function enqueueStep(
  queue: Queue<RunStepJob>,
  job: RunStepJob,
  options: EnqueueOptions,
): Promise<{ jobId: string | undefined; enqueued: boolean }> {
  // BullMQ reserves ':' in both queue names and job ids.
  const jobId = `${job.runId}--${job.stepId}`;

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    // Anything not yet finished is already going to run; leave it alone.
    if (state !== 'completed' && state !== 'failed' && state !== 'unknown') {
      return { jobId: existing.id, enqueued: false };
    }
    await existing.remove();
  }

  const jobOptions: JobsOptions = {
    jobId,
    attempts: Math.max(1, options.attempts),
    backoff: { type: 'exponential', delay: 1_000 },
    // Kept briefly for inspection in a queue dashboard; the run record, not
    // the queue, is the durable history.
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400 },
    ...(options.delayMs ? { delay: options.delayMs } : {}),
  };

  const added = await queue.add(job.stepId, job, jobOptions);
  return { jobId: added.id, enqueued: true };
}

// --- run event pub/sub ----------------------------------------------------

export function runChannel(runId: string): string {
  return `frp:run:${runId}`;
}

/** Redis-backed implementation of the engine's `RunPublisher` port. */
export class RedisRunPublisher implements RunPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(runId: string, message: unknown): Promise<void> {
    await this.redis.publish(runChannel(runId), JSON.stringify(message));
  }
}

/**
 * Subscribes to one run's updates.
 *
 * Returns an unsubscribe function. The caller owns the connection lifetime: a
 * subscriber connection cannot issue ordinary commands, so the API creates one
 * per SSE client and disposes of it when the client disconnects.
 */
export async function subscribeToRun(
  redis: Redis,
  runId: string,
  onMessage: (message: unknown) => void,
): Promise<() => Promise<void>> {
  const channel = runChannel(runId);
  await redis.subscribe(channel);

  const handler = (incoming: string, payload: string) => {
    if (incoming !== channel) return;
    try {
      onMessage(JSON.parse(payload));
    } catch {
      // A malformed payload must not tear down a live stream.
    }
  };

  redis.on('message', handler);

  return async () => {
    redis.off('message', handler);
    await redis.unsubscribe(channel).catch(() => {});
  };
}
