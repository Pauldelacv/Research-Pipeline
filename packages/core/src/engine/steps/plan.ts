import type { PipelineContext, PipelineStep, StepResult } from '../types.js';
import type { ResearchPlan } from '../../providers/types.js';

/**
 * Turns a research objective into an executable plan: a set of queries with
 * stated intent, plus per-field extraction guidance.
 *
 * The plan is persisted as the step's output so the run stays reproducible and
 * an operator can see *why* a particular query was issued when results look
 * wrong. This is also the only step where a language model is a natural fit —
 * and even here its output is schema-validated before it is stored.
 */
export const planStep: PipelineStep = {
  id: 'plan',
  name: 'Planning research strategy',
  idempotent: true,
  maxAttempts: 3,
  timeoutMs: 120_000,

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const provider = ctx.providers.research;

    await ctx.emit({
      type: 'plan.started',
      message: `Planning with the "${provider.meta.id}" research provider`,
      data: { provider: provider.meta.id, objective: ctx.objective },
    });

    const plan: ResearchPlan = await provider.plan(
      { objective: ctx.objective, config: ctx.config, targeting: ctx.targeting },
      ctx.providerCall(provider.meta, { target: ctx.objective.slice(0, 200) }),
    );

    const queries = plan.queries
      .filter((query) => ctx.config.discovery.sources.includes(query.source))
      .slice(0, ctx.config.discovery.queriesPerPlan);

    const warnings: string[] = [];
    if (queries.length === 0) {
      warnings.push(
        `the plan produced no query matching the configured sources (${ctx.config.discovery.sources.join(', ')})`,
      );
    }
    if (queries.length < plan.queries.length) {
      warnings.push(`${plan.queries.length - queries.length} planned queries were filtered out`);
    }

    for (const query of queries) {
      await ctx.emit({
        level: 'debug',
        type: 'plan.query',
        message: query.query,
        data: { source: query.source, intent: query.intent, priority: query.priority },
      });
    }

    await ctx.emit({
      type: 'plan.completed',
      message: plan.rationale,
      data: { queries: queries.length, estimatedEntities: plan.estimatedEntities },
    });

    return {
      status: warnings.length > 0 ? 'partial' : 'completed',
      metrics: { itemsOut: queries.length, providerCalls: 1 },
      warnings,
      output: {
        rationale: plan.rationale,
        estimatedEntities: plan.estimatedEntities,
        fieldGuidance: plan.fieldGuidance,
        queries,
      },
    };
  },
};
