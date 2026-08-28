import type {
  ResearchPipelineConfig,
  ScoreBreakdown,
  ScoreContribution,
  ScoringRuleDefinition,
} from '@frp/schemas';
import { evaluateCondition, renderTrace, type EvaluationContext } from './conditions.js';
import { toNumber } from './values.js';

export interface ScoreInput {
  fields: Record<string, unknown>;
  signals: Iterable<string>;
  now?: Date;
}

/**
 * Deterministic, explainable scoring.
 *
 * Two properties matter more than sophistication here:
 *   1. The same entity and the same rules always produce the same number.
 *   2. Every point is attributable to a named rule with a readable reason.
 *
 * There is no model in this path. A model may *produce a field* that a rule
 * reads, but it never produces the score itself.
 */
export function scoreEntity(config: ResearchPipelineConfig, input: ScoreInput): ScoreBreakdown {
  const ctx: EvaluationContext = {
    fields: input.fields,
    signals: new Set(input.signals),
    now: input.now ?? new Date(),
  };

  const contributions = config.scoring.rules.map((rule) => evaluateRule(rule, ctx));

  const rawPoints = contributions.reduce((sum, c) => sum + c.points, 0);
  // Penalties (negative weights) do not inflate the denominator.
  const maxPoints = contributions.reduce((sum, c) => sum + Math.max(c.maxPoints, 0), 0);

  const { maxScore, thresholds } = config.scoring;
  const ratio = maxPoints > 0 ? rawPoints / maxPoints : 0;
  const total = clamp(Math.round(ratio * maxScore), 0, maxScore);

  return {
    total,
    maxScore,
    rawPoints: round2(rawPoints),
    maxPoints: round2(maxPoints),
    band:
      total >= thresholds.qualified
        ? 'qualified'
        : total >= thresholds.review
          ? 'review'
          : 'rejected',
    contributions,
    scoredAt: ctx.now.toISOString(),
  };
}

function evaluateRule(rule: ScoringRuleDefinition, ctx: EvaluationContext): ScoreContribution {
  const base: Omit<ScoreContribution, 'matched' | 'points' | 'explanation'> = {
    ruleId: rule.id,
    label: rule.label,
    maxPoints: rule.weight,
  };

  // A `when` on a graded rule acts as a gate before interpolation.
  if (rule.when) {
    const trace = evaluateCondition(rule.when, ctx);
    if (!trace.matched) {
      return { ...base, matched: false, points: 0, explanation: renderTrace(trace) };
    }
    if (rule.mode === 'binary') {
      return { ...base, matched: true, points: rule.weight, explanation: renderTrace(trace) };
    }
  }

  if (rule.mode === 'graded' && rule.scale) {
    const value = toNumber(ctx.fields[rule.scale.field]);
    if (value === undefined) {
      return {
        ...base,
        matched: false,
        points: 0,
        explanation: `${rule.scale.field} is not a number → no points`,
      };
    }
    const span = rule.scale.to - rule.scale.from;
    let position = span === 0 ? (value >= rule.scale.to ? 1 : 0) : (value - rule.scale.from) / span;
    if (rule.scale.clamp) position = clamp(position, 0, 1);
    const points = round2(rule.weight * position);
    return {
      ...base,
      matched: points !== 0,
      points,
      explanation:
        `${rule.scale.field} = ${value} on scale ${rule.scale.from}→${rule.scale.to} ` +
        `(${Math.round(position * 100)}% of ${rule.weight})`,
    };
  }

  return { ...base, matched: false, points: 0, explanation: 'rule produced no contribution' };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
