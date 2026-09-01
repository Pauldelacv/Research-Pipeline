import { PIPELINE_STEP_ORDER, runEventQuerySchema, type StepId } from '@frp/schemas';
import {
  clearStepRun,
  getProject,
  getRun,
  listRuns,
  listStepRuns,
  requestCancellation,
} from '@frp/db';
import { createRedis, enqueueStep, subscribeToRun } from '@frp/queue';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, conflict, idParamSchema, notFound, parse } from '../http.js';

/**
 * Run routes, including the live event stream.
 *
 * The pipeline view is driven from real backend state: `GET /v1/runs/:id`
 * returns the recorded step rows, and `/stream` pushes each state change as it
 * is persisted. Nothing about progress is interpolated or animated on a timer.
 */
export function registerRunRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/runs', async (request) => {
    const query = parse(
      z.object({
        projectId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
      'query',
    );
    return listRuns(ctx.db, { tenantId: ctx.tenantId, ...query });
  });

  app.get('/v1/runs/:id', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const run = await requireRun(ctx, id);

    const [steps, exports, counts, project, failureCount, usage] = await Promise.all([
      listStepRuns(ctx.db, id),
      ctx.stores.exports.listByRun(id),
      ctx.stores.entities.countsByStatus(id),
      getProject(ctx.db, run.projectId, ctx.tenantId),
      ctx.stores.failures.countByRun(id),
      // Totals only: the per-call rows live behind /usage, so opening a run
      // does not pay for a table nobody has asked to see yet.
      ctx.stores.usage.summarise(id),
    ]);

    return {
      run,
      project,
      steps: withPendingSteps(steps),
      exports,
      entityCounts: counts,
      pendingReview: counts.needs_review,
      failureCount,
      usage: usage.totals,
    };
  });

  app.get('/v1/runs/:id/events', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    await requireRun(ctx, id);
    const query = parse(runEventQuerySchema, request.query, 'query');
    const events = await ctx.stores.events.list(id, query);
    return { events };
  });

  /**
   * Failures recorded during a run.
   *
   * The event log tells the story of a run; this answers "what broke, on what,
   * and what did the provider say?" without an operator opening a worker's
   * stdout. Provider detail is already redacted at write time.
   */
  app.get('/v1/runs/:id/failures', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    await requireRun(ctx, id);
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(500).default(200),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
      'query',
    );
    const [items, total] = await Promise.all([
      ctx.stores.failures.listByRun(id, query),
      ctx.stores.failures.countByRun(id),
    ]);
    return { items, total, ...query };
  });

  /**
   * What the run spent.
   *
   * The rollup is computed on read from the append-only usage rows rather than
   * kept as a counter, so the number always matches the calls it claims to
   * summarise. `partialCost` flags a total that is a floor because at least one
   * call could not be priced.
   */
  app.get('/v1/runs/:id/usage', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    await requireRun(ctx, id);
    const query = parse(
      z.object({
        detail: z
          .union([z.boolean(), z.enum(['true', 'false'])])
          .optional()
          .transform((value) => value === true || value === 'true'),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      request.query,
      'query',
    );

    const summary = await ctx.stores.usage.summarise(id);
    if (!query.detail) return { ...summary, calls: null };
    return { ...summary, calls: await ctx.stores.usage.listByRun(id, { limit: query.limit }) };
  });

  app.get('/v1/runs/:id/sources', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    await requireRun(ctx, id);
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
      'query',
    );
    const [sources, total] = await Promise.all([
      ctx.stores.sources.listByRun(id, query),
      ctx.stores.sources.countByRun(id),
    ]);
    return { items: sources, total, ...query };
  });

  app.post('/v1/runs/:id/cancel', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const run = await requireRun(ctx, id);
    const cancelled = await requestCancellation(ctx.db, id);
    if (!cancelled) throw conflict(`run is ${run.status} and cannot be cancelled`);

    await ctx.stores.events.append({
      runId: id,
      stepId: run.currentStep,
      level: 'warn',
      type: 'run.cancel_requested',
      message: 'Cancellation requested by an operator',
      data: null,
    });
    await ctx.publisher.publish(id, { type: 'run.updated', run: await getRun(ctx.db, id) });
    return { ok: true };
  });

  /**
   * Resumes a run parked at the human-review gate.
   *
   * Deliberately idempotent and self-healing. The review step's record is
   * cleared so the gate genuinely re-evaluates — if entities are still
   * flagged, the run parks again rather than sliding past the check — and the
   * job is enqueued *before* the run status changes, so a failure here leaves
   * the run parked rather than stranded in `running` with an empty queue.
   * Calling it twice is safe: the queue deduplicates on (run, step).
   */
  app.post('/v1/runs/:id/resume', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const run = await requireRun(ctx, id);

    // `running` is accepted so an interrupted resume can be retried; the
    // enqueue is deduplicated, so a genuinely in-flight run is unaffected.
    if (run.status !== 'review_required' && run.status !== 'running') {
      throw conflict(`run is ${run.status}; only a paused or in-flight run can be resumed`);
    }

    const pending = await ctx.stores.entities.countPendingReview(id);
    const force = parse(
      z.object({ force: z.boolean().default(false) }),
      request.body ?? {},
      'body',
    ).force;

    if (pending > 0 && !force) {
      throw badRequest(
        `${pending} entities still need a decision. Resolve them, or resume with { "force": true } ` +
          'to accept them as-is.',
        { pending },
      );
    }

    if (force && pending > 0) {
      // Accepting the remaining queue is an explicit, recorded act.
      await ctx.stores.events.append({
        runId: id,
        stepId: 'review',
        level: 'warn',
        type: 'review.force_resumed',
        message: `Operator resumed the run with ${pending} entities still unreviewed`,
        data: { pending },
      });
    }

    await clearStepRun(ctx.db, id, 'review');

    const step = ctx.engine.step('review');
    const { enqueued } = await enqueueStep(
      ctx.queue,
      { runId: id, stepId: 'review', tenantId: run.tenantId, projectId: run.projectId },
      { attempts: step.maxAttempts },
    );

    await ctx.stores.runs.setStatus(id, 'running', { currentStep: 'review' });

    await ctx.stores.events.append({
      runId: id,
      stepId: 'review',
      level: 'info',
      type: 'run.resumed',
      message: enqueued ? 'Run resumed after review' : 'Run already resuming',
      data: { pending, forced: force },
    });

    const refreshed = await getRun(ctx.db, id);
    await ctx.publisher.publish(id, { type: 'run.updated', run: refreshed });
    return { ok: true, enqueued, run: refreshed };
  });

  /**
   * Server-sent events for one run.
   *
   * An initial snapshot avoids the race where a run finishes between the page
   * load and the subscription. Each client gets its own Redis subscriber
   * connection, because a connection in subscriber mode cannot issue ordinary
   * commands.
   */
  app.get('/v1/runs/:id/stream', async (request, reply) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    await requireRun(ctx, id);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (payload: unknown) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const [run, steps] = await Promise.all([getRun(ctx.db, id), listStepRuns(ctx.db, id)]);
    send({ type: 'snapshot', run, steps: withPendingSteps(steps) });

    const subscriber = createRedis(ctx.env.REDIS_URL);
    const unsubscribe = await subscribeToRun(subscriber, id, (message) => send(message));

    // Keeps intermediaries from closing an idle connection during a long step.
    const heartbeat = setInterval(
      () => send({ type: 'heartbeat', at: new Date().toISOString() }),
      15_000,
    );

    const cleanup = async () => {
      clearInterval(heartbeat);
      await unsubscribe().catch(() => {});
      subscriber.disconnect();
    };

    request.raw.on('close', () => void cleanup());
    reply.raw.on('error', () => void cleanup());

    // Returning the raw reply tells Fastify the response is managed manually.
    return reply;
  });
}

async function requireRun(ctx: AppContext, runId: string) {
  const run = await getRun(ctx.db, runId);
  if (!run || run.tenantId !== ctx.tenantId) throw notFound('run');
  return run;
}

/**
 * Pads the recorded steps with the ones that have not started.
 *
 * The UI needs the full nine-step spine from the first render; showing only
 * executed steps would make the pipeline appear to grow as it runs.
 */
function withPendingSteps(steps: Awaited<ReturnType<typeof listStepRuns>>) {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  return PIPELINE_STEP_ORDER.map((stepId: StepId) => {
    const existing = byId.get(stepId);
    if (existing) return existing;
    return {
      id: `pending:${stepId}`,
      runId: steps[0]?.runId ?? '',
      stepId,
      status: 'pending' as const,
      attempt: 0,
      maxAttempts: 1,
      startedAt: null,
      finishedAt: null,
      metrics: null,
      warnings: [],
      error: null,
      output: null,
    };
  });
}
