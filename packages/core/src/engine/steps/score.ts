import { deriveSignals, detectedSignalKeys, scoreEntity } from '@frp/scoring';
import type { PipelineContext, PipelineStep, StepResult } from '../types.js';

/**
 * Derives signals and applies the configured scoring rules.
 *
 * Signals are recomputed here rather than reused from extraction, because the
 * enrichment step — and any human edit before a re-score — may have changed
 * the underlying fields. Recomputing keeps "uses HubSpot" consistent with the
 * value actually stored in the technologies field.
 *
 * The score itself is arithmetic over named rules. Nothing in this step calls
 * a model, and every point is attributable in `scoreBreakdown.contributions`.
 */
export const scoreStep: PipelineStep = {
  id: 'score',
  name: 'Applying scoring rules',
  idempotent: true,
  maxAttempts: 2,
  timeoutMs: 300_000,

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const { config } = ctx;

    if (config.scoring.rules.length === 0) {
      await ctx.emit({
        type: 'score.skipped',
        message: 'No scoring rules are configured for this pipeline',
      });
      return { status: 'skipped', output: { reason: 'no-rules' } };
    }

    let processed = 0;
    let qualified = 0;
    let totalScore = 0;
    const now = ctx.now();

    for await (const { entity } of ctx.stores.entities.iterate(ctx.runId, 200)) {
      await ctx.assertNotCancelled();
      processed += 1;

      const extractedSignals = entity.signals.filter((signal) => signal.source === 'extracted');
      const signals = deriveSignals(config, entity.data, extractedSignals, now);
      await ctx.stores.entities.setSignals(entity.id, signals);

      const breakdown = scoreEntity(config, {
        fields: entity.data,
        signals: detectedSignalKeys(signals),
        now,
      });

      await ctx.stores.entities.setScore(entity.id, breakdown.total, breakdown);

      totalScore += breakdown.total;
      if (breakdown.band === 'qualified') qualified += 1;
    }

    const average = processed > 0 ? Math.round(totalScore / processed) : 0;

    await ctx.emit({
      type: 'score.completed',
      message: `${processed} entities scored, ${qualified} qualified (average ${average}/${config.scoring.maxScore})`,
      data: {
        processed,
        qualified,
        average,
        rules: config.scoring.rules.length,
        threshold: config.scoring.thresholds.qualified,
      },
    });

    return {
      status: 'completed',
      metrics: { itemsIn: processed, itemsOut: processed },
      output: { scored: processed, qualified, averageScore: average },
    };
  },
};
