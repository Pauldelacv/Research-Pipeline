import { env, PipelineRegistry } from '@frp/config';
import { createConnectorRegistry } from '@frp/connectors';
import {
  PipelineEngine,
  createRunContext,
  defaultSteps,
  toErrorRecord,
  type Logger,
} from '@frp/core';
import { closeDb, createStores, db, getProject, getRun } from '@frp/db';
import { createProviderRegistry } from '@frp/providers';
import {
  RUN_STEP_QUEUE,
  RedisRunPublisher,
  createRedis,
  createRunStepQueue,
  enqueueStep,
  type RunStepJob,
} from '@frp/queue';
import { Worker, type Job } from 'bullmq';
import { createLogger } from './logger.js';

/**
 * The pipeline worker.
 *
 * One job equals one attempt of one step. The worker's only responsibilities
 * are to rebuild the step's context, ask the engine to execute it, and act on
 * the outcome — advance, retry, or stop. All of the interesting logic lives in
 * the steps and the engine, which is what keeps this file short enough to hold
 * in your head while debugging a stuck run at 2am.
 */
async function main(): Promise<void> {
  const config = env();
  const logger = createLogger(config.LOG_LEVEL, 'worker');

  const database = db();
  const stores = createStores(database);
  const connection = createRedis(config.REDIS_URL);
  const publisherConnection = createRedis(config.REDIS_URL);
  const queue = createRunStepQueue(connection);
  const publisher = new RedisRunPublisher(publisherConnection);

  const providers = createProviderRegistry();
  const connectors = createConnectorRegistry();
  const engine = new PipelineEngine(defaultSteps);
  // The worker never resolves templates: a run carries its own configuration
  // snapshot, so it stays reproducible even if a template changed since.
  const pipelines = new PipelineRegistry();
  void pipelines;

  const worker = new Worker<RunStepJob>(RUN_STEP_QUEUE, async (job) => processStep(job), {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
    // A step that outlives this is assumed dead and redelivered; steps are
    // idempotent, so redelivery converges rather than duplicating work.
    lockDuration: 120_000,
    stalledInterval: 30_000,
  });

  async function processStep(job: Job<RunStepJob>): Promise<{ status: string }> {
    const { runId, stepId } = job.data;
    const attempt = job.attemptsMade + 1;
    const jobLogger = logger.child({ runId, stepId, attempt, jobId: job.id });

    const run = await getRun(database, runId);
    if (!run) {
      jobLogger.warn({}, 'run disappeared; dropping job');
      return { status: 'missing' };
    }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      jobLogger.info({ status: run.status }, 'run already finished; dropping job');
      return { status: run.status };
    }

    const project = await getProject(database, run.projectId, run.tenantId);

    const ctx = createRunContext({
      runId,
      projectId: run.projectId,
      tenantId: run.tenantId,
      objective: project?.objective ?? '',
      // The snapshot, not the current template.
      config: run.configSnapshot,
      targeting: run.targeting,
      providers: providers.bundleFor(run.configSnapshot, {
        research: config.PROVIDER_RESEARCH,
        search: config.PROVIDER_SEARCH,
        extraction: config.PROVIDER_EXTRACTION,
        enrichment: config.PROVIDER_ENRICHMENT,
      }),
      stores,
      connectors,
      publisher,
      logger: jobLogger,
      stepId,
      attempt,
    });

    const outcome = await engine.executeStepAttempt(ctx, stepId);

    // Push the freshly persisted step row before deciding what happens next,
    // so the UI reflects the step's own result even if the run then ends.
    await publisher.publish(runId, {
      type: 'step.updated',
      step: await stores.runs.getStepRun(runId, stepId),
    });

    const decision = await engine.settleRun(ctx, outcome);
    await publisher.publish(runId, { type: 'run.updated', run: await getRun(database, runId) });

    if (decision.action === 'retry') {
      // Throwing hands the backoff to BullMQ: the worker slot is released
      // instead of sleeping through the delay.
      throw new Error(outcome.error?.message ?? `step ${stepId} failed and will be retried`);
    }

    if (decision.action === 'advance' && decision.nextStepId) {
      const next = engine.step(decision.nextStepId);
      await enqueueStep(
        queue,
        {
          runId,
          stepId: decision.nextStepId,
          tenantId: run.tenantId,
          projectId: run.projectId,
        },
        { attempts: next.maxAttempts },
      );
      jobLogger.info({ next: decision.nextStepId }, 'step complete, next step queued');
      return { status: 'advanced' };
    }

    // Terminal or suspended: reconcile the project row so the dashboard shows
    // the outcome without needing to open the run.
    const entityCount = await stores.entities.countByRun(runId);
    await stores.projects.updateAfterRun(run.projectId, {
      status: decision.status,
      lastRunId: runId,
      entityCount,
    });

    jobLogger.info({ status: decision.status, entityCount }, 'run settled');
    return { status: decision.status };
  }

  /**
   * Final-failure handling.
   *
   * `executeStepAttempt` already recorded the failed step and `settleRun`
   * already failed the run on the last attempt, so this handler exists for
   * observability and for failures that never reached the engine at all
   * (a lost lock, a stalled job).
   */
  worker.on('failed', (job, error) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.error(
      {
        runId: job.data.runId,
        stepId: job.data.stepId,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts,
        exhausted,
        ...toErrorRecord(error),
      },
      exhausted ? 'step failed permanently' : 'step attempt failed, will retry',
    );
  });

  worker.on('error', (error) => {
    logger.error({ ...toErrorRecord(error) }, 'worker error');
  });

  worker.on('ready', () => {
    logger.info(
      {
        queue: RUN_STEP_QUEUE,
        concurrency: config.WORKER_CONCURRENCY,
        providers: {
          research: config.PROVIDER_RESEARCH,
          search: config.PROVIDER_SEARCH,
          extraction: config.PROVIDER_EXTRACTION,
          enrichment: config.PROVIDER_ENRICHMENT,
        },
      },
      'worker ready',
    );
  });

  const shutdown = async (signal: string, log: Logger) => {
    log.info({ signal }, 'shutting down');
    // `close()` waits for in-flight jobs so a step is never abandoned midway.
    await worker.close().catch(() => {});
    await queue.close().catch(() => {});
    connection.disconnect();
    publisherConnection.disconnect();
    await closeDb().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM', logger));
  process.on('SIGINT', () => void shutdown('SIGINT', logger));
}

main().catch((error) => {
  console.error('[worker] failed to start:', error);
  process.exit(1);
});
