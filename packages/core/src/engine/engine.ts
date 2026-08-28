import { PIPELINE_STEP_ORDER, type RunStatus, type StepId, type StepMetrics } from '@frp/schemas';
import { PipelineError, RunCancelledError, toErrorRecord } from '../errors.js';
import type { PipelineContext, PipelineStep, StepOutcome } from './types.js';

/**
 * The pipeline engine.
 *
 * It owns exactly three concerns: which step runs next, how a single step
 * attempt is executed and recorded, and how the run's status changes as a
 * result. It does not know what any step does.
 *
 * Retries are deliberately *not* an internal sleep loop. `executeStepAttempt`
 * performs one attempt and reports whether another is worthwhile; the caller
 * decides how to schedule it. In the deployed system that caller is the BullMQ
 * worker, so a backoff costs a queue delay rather than a blocked worker slot.
 * `runToCompletion` provides the same semantics in-process for tests.
 */
export class PipelineEngine {
  private readonly steps: Map<StepId, PipelineStep>;
  private readonly order: StepId[];

  constructor(steps: PipelineStep[]) {
    this.steps = new Map(steps.map((step) => [step.id, step]));
    this.order = PIPELINE_STEP_ORDER.filter((id) => this.steps.has(id));
    const missing = PIPELINE_STEP_ORDER.filter((id) => !this.steps.has(id));
    if (missing.length > 0) {
      throw new Error(`pipeline engine is missing steps: ${missing.join(', ')}`);
    }
  }

  get stepIds(): StepId[] {
    return [...this.order];
  }

  step(id: StepId): PipelineStep {
    const step = this.steps.get(id);
    if (!step) throw new PipelineError('NOT_FOUND', `unknown pipeline step "${id}"`);
    return step;
  }

  firstStep(): StepId {
    const first = this.order[0];
    if (!first) throw new PipelineError('INTERNAL', 'pipeline has no steps');
    return first;
  }

  nextStep(after: StepId): StepId | null {
    const index = this.order.indexOf(after);
    if (index < 0) return null;
    return this.order[index + 1] ?? null;
  }

  /**
   * Executes one attempt of one step and persists the result.
   *
   * Returns an outcome instead of throwing for expected failures — the caller
   * needs the outcome to decide between "retry", "fail the run" and "advance".
   * Cancellation is the one condition handled here directly, because it must
   * short-circuit regardless of what the step was doing.
   */
  async executeStepAttempt(ctx: PipelineContext, stepId: StepId): Promise<StepOutcome> {
    const step = this.step(stepId);
    const startedAt = ctx.now().getTime();

    const existing = await ctx.stores.runs.getStepRun(ctx.runId, stepId);
    if (existing && (existing.status === 'completed' || existing.status === 'skipped')) {
      // Resumability: a step that already finished is never re-executed, even
      // if the queue redelivers its job after a worker crash.
      ctx.logger.info({ stepId, status: existing.status }, 'step already finished, skipping');
      return {
        stepId,
        status: existing.status,
        nextStepId: this.nextStep(stepId),
        metrics: existing.metrics ?? emptyMetrics(),
        warnings: existing.warnings,
      };
    }

    await ctx.stores.runs.startStepRun(ctx.runId, stepId, {
      attempt: ctx.attempt,
      maxAttempts: step.maxAttempts,
    });
    await ctx.stores.runs.setStatus(ctx.runId, 'running', { currentStep: stepId });
    await ctx.emit({
      type: 'step.started',
      message: `${step.name} started`,
      data: { stepId, attempt: ctx.attempt, maxAttempts: step.maxAttempts },
    });

    try {
      await ctx.assertNotCancelled();
      const result = await withTimeout(step.execute(ctx), step.timeoutMs, step.id, ctx.signal);

      const metrics: StepMetrics = {
        ...emptyMetrics(),
        ...result.metrics,
        durationMs: ctx.now().getTime() - startedAt,
      };
      const warnings = result.warnings ?? [];

      await ctx.stores.runs.finishStepRun(ctx.runId, stepId, {
        status: result.status,
        metrics,
        warnings,
        output: result.output ?? null,
        error: null,
      });

      await ctx.emit({
        level: warnings.length > 0 ? 'warn' : 'info',
        type: result.status === 'suspended' ? 'step.suspended' : 'step.completed',
        message:
          result.status === 'suspended'
            ? `${step.name} is waiting for human review`
            : `${step.name} finished`,
        data: { stepId, ...metrics, warnings: warnings.length },
      });

      return {
        stepId,
        status: result.status,
        nextStepId: result.status === 'suspended' ? stepId : this.nextStep(stepId),
        metrics,
        warnings,
      };
    } catch (error) {
      const record = toErrorRecord(error);
      const durationMs = ctx.now().getTime() - startedAt;
      const cancelled = error instanceof RunCancelledError;
      const willRetry = !cancelled && record.retryable && ctx.attempt < step.maxAttempts;

      await ctx.stores.runs.finishStepRun(ctx.runId, stepId, {
        // A step awaiting another attempt stays `running`, so the UI shows a
        // retry in flight rather than flapping to failed and back.
        status: willRetry ? 'running' : cancelled ? 'skipped' : 'failed',
        metrics: { ...emptyMetrics(), durationMs },
        error: record,
      });

      if (willRetry) {
        await ctx.stores.runs.incrementStats(ctx.runId, { retries: 1 });
        await ctx.emit({
          level: 'warn',
          type: 'step.retry',
          message: `${step.name} failed with ${record.code}, retrying (${ctx.attempt}/${step.maxAttempts})`,
          data: { stepId, attempt: ctx.attempt, code: record.code, error: record.message },
        });
      } else {
        await ctx.emit({
          level: cancelled ? 'warn' : 'error',
          type: cancelled ? 'step.cancelled' : 'step.failed',
          message: cancelled ? `${step.name} cancelled` : `${step.name} failed: ${record.message}`,
          data: { stepId, code: record.code, attempt: ctx.attempt },
        });
      }

      ctx.logger.error(
        { stepId, attempt: ctx.attempt, code: record.code, willRetry },
        `step ${stepId} attempt failed: ${record.message}`,
      );

      return {
        stepId,
        status: willRetry ? 'running' : cancelled ? 'skipped' : 'failed',
        nextStepId: null,
        metrics: { ...emptyMetrics(), durationMs },
        warnings: [],
        error: record,
      };
    }
  }

  /**
   * Applies a step outcome to the run record and reports what should happen
   * next. Keeping this separate from execution means the worker and the
   * in-process runner share identical run-status semantics.
   */
  async settleRun(
    ctx: PipelineContext,
    outcome: StepOutcome,
  ): Promise<{
    action: 'advance' | 'retry' | 'stop';
    nextStepId: StepId | null;
    status: RunStatus;
  }> {
    if (outcome.status === 'failed') {
      await ctx.stores.runs.setStatus(ctx.runId, 'failed', {
        currentStep: outcome.stepId,
        error: outcome.error?.message ?? 'step failed',
        finishedAt: ctx.now(),
      });
      await ctx.emit({
        level: 'error',
        type: 'run.failed',
        message: `Run failed during ${outcome.stepId}`,
        data: { stepId: outcome.stepId, code: outcome.error?.code },
      });
      return { action: 'stop', nextStepId: null, status: 'failed' };
    }

    if (outcome.status === 'skipped' && (await ctx.stores.runs.isCancelled(ctx.runId))) {
      await ctx.stores.runs.setStatus(ctx.runId, 'cancelled', {
        currentStep: outcome.stepId,
        finishedAt: ctx.now(),
      });
      return { action: 'stop', nextStepId: null, status: 'cancelled' };
    }

    if (outcome.status === 'running') {
      return { action: 'retry', nextStepId: outcome.stepId, status: 'running' };
    }

    if (outcome.status === 'suspended') {
      await ctx.stores.runs.setStatus(ctx.runId, 'review_required', {
        currentStep: outcome.stepId,
      });
      await ctx.emit({
        type: 'run.review_required',
        message: 'Run paused: entities are waiting for human review',
        data: { stepId: outcome.stepId },
      });
      return { action: 'stop', nextStepId: outcome.stepId, status: 'review_required' };
    }

    if (!outcome.nextStepId) {
      await ctx.stores.runs.setStatus(ctx.runId, 'completed', {
        currentStep: null,
        finishedAt: ctx.now(),
      });
      await ctx.emit({ type: 'run.completed', message: 'Run completed' });
      return { action: 'stop', nextStepId: null, status: 'completed' };
    }

    return { action: 'advance', nextStepId: outcome.nextStepId, status: 'running' };
  }

  /**
   * In-process execution of a whole run. Used by tests and by the `runOnce`
   * script; the deployed system drives the same steps through the queue.
   */
  async runToCompletion(
    makeContext: (stepId: StepId, attempt: number) => PipelineContext,
    options: { startAt?: StepId; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<RunStatus> {
    const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let stepId: StepId | null = options.startAt ?? this.firstStep();
    let attempt = 1;
    let status: RunStatus = 'running';

    while (stepId) {
      const ctx = makeContext(stepId, attempt);
      const outcome = await this.executeStepAttempt(ctx, stepId);
      const decision = await this.settleRun(ctx, outcome);
      status = decision.status;

      if (decision.action === 'stop') return status;
      if (decision.action === 'retry') {
        attempt += 1;
        await sleep(backoffMs(attempt));
        continue;
      }
      stepId = decision.nextStepId;
      attempt = 1;
    }

    return status;
  }
}

/** Exponential backoff with a ceiling, shared by the worker and the runner. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 2 ** Math.max(0, attempt - 1) * 1_000);
}

export function emptyMetrics(): StepMetrics {
  return {
    itemsIn: 0,
    itemsOut: 0,
    itemsFailed: 0,
    providerCalls: 0,
    providerErrors: 0,
    durationMs: 0,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stepId: string,
  signal: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new PipelineError('PROVIDER_TIMEOUT', `step "${stepId}" exceeded ${timeoutMs}ms`, {
            retryable: true,
          }),
        ),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new PipelineError('RUN_CANCELLED', 'aborted'));
    signal.addEventListener('abort', () => reject(new PipelineError('RUN_CANCELLED', 'aborted')), {
      once: true,
    });
  });

  try {
    return await Promise.race([promise, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
