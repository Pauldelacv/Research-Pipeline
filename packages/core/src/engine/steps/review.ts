import type { PipelineContext, PipelineStep, StepResult } from '../types.js';

/**
 * The human review gate.
 *
 * This is a real control-flow step, not a UI state. When the pipeline is
 * configured with `review.blocking` and entities are still flagged, the step
 * returns `suspended`: the run moves to `review_required`, the queue stops,
 * and nothing is exported. An operator resolving the queue resumes the run,
 * which re-enters this step and — with nothing left pending — proceeds.
 *
 * Making review a step rather than a flag is what stops "reviewed" from
 * becoming a label nobody enforces.
 */
export const reviewStep: PipelineStep = {
  id: 'review',
  name: 'Awaiting human review',
  idempotent: true,
  maxAttempts: 1,
  timeoutMs: 60_000,

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const { config } = ctx;

    if (!config.review.enabled) {
      await ctx.emit({ type: 'review.skipped', message: 'Human review is disabled' });
      return { status: 'skipped', output: { reason: 'disabled' } };
    }

    const pending = await ctx.stores.entities.countPendingReview(ctx.runId);
    const counts = await ctx.stores.entities.countsByStatus(ctx.runId);

    if (pending === 0) {
      await ctx.emit({
        type: 'review.cleared',
        message: 'No entities require review',
        data: counts,
      });
      return {
        status: 'completed',
        metrics: { itemsIn: counts.needs_review, itemsOut: counts.approved },
        output: { pending: 0, ...counts },
      };
    }

    if (!config.review.blocking) {
      await ctx.emit({
        level: 'warn',
        type: 'review.non_blocking',
        message: `${pending} entities need review; continuing because review is non-blocking`,
        data: { pending, ...counts },
      });
      return {
        status: 'partial',
        warnings: [`${pending} entities were exported without review`],
        metrics: { itemsIn: pending },
        output: { pending, blocking: false },
      };
    }

    await ctx.emit({
      type: 'review.required',
      message: `${pending} entities are waiting for a decision`,
      data: { pending, ...counts },
    });

    return {
      status: 'suspended',
      metrics: { itemsIn: pending },
      output: { pending, blocking: true, ...counts },
    };
  },
};
