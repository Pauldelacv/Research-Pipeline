import type { Condition, ConditionTrace } from '@frp/schemas';
import { describeValue, isEmpty, normaliseText, toDate, toNumber, toStringList } from './values.js';

export interface EvaluationContext {
  /** Flat field values for the entity being evaluated. */
  fields: Record<string, unknown>;
  /** Keys of signals currently detected on the entity. */
  signals: ReadonlySet<string>;
  /** Injected so evaluation is deterministic in tests. */
  now: Date;
}

export function createEvaluationContext(
  fields: Record<string, unknown>,
  signals: Iterable<string> = [],
  now: Date = new Date(),
): EvaluationContext {
  return { fields, signals: new Set(signals), now };
}

/**
 * Evaluates a condition and returns both the boolean result and a trace that
 * can be shown to an operator. The trace is why scores in this system are
 * never a bare number: every contribution carries the reason it fired.
 *
 * Trust boundary: conditions come from configuration authored by the engineer
 * deploying the pipeline, not from end users. `matches` compiles a regular
 * expression, so patterns are length-capped and inputs truncated to keep a
 * pathological pattern from stalling a worker.
 */
export function evaluateCondition(condition: Condition, ctx: EvaluationContext): ConditionTrace {
  if ('always' in condition) {
    return { matched: true, description: 'always' };
  }

  if ('all' in condition) {
    const children = condition.all.map((child) => evaluateCondition(child, ctx));
    const matched = children.every((child) => child.matched);
    return { matched, description: `all of (${children.length})`, children };
  }

  if ('any' in condition) {
    const children = condition.any.map((child) => evaluateCondition(child, ctx));
    const matched = children.some((child) => child.matched);
    return { matched, description: `any of (${children.length})`, children };
  }

  if ('not' in condition) {
    const child = evaluateCondition(condition.not, ctx);
    return { matched: !child.matched, description: 'not', children: [child] };
  }

  if ('signal' in condition) {
    const wantPresent = condition.present ?? true;
    const present = ctx.signals.has(condition.signal);
    return {
      matched: present === wantPresent,
      description: `signal ${condition.signal} ${present ? 'present' : 'absent'}`,
    };
  }

  const actual = ctx.fields[condition.field];
  const shown = describeValue(actual);

  if (condition.op === 'exists') {
    return { matched: !isEmpty(actual), description: `${condition.field} exists → ${shown}` };
  }
  if (condition.op === 'missing') {
    return { matched: isEmpty(actual), description: `${condition.field} missing → ${shown}` };
  }

  const { value } = condition;
  const matched = compare(condition.op, actual, value, ctx.now);
  return {
    matched,
    description: `${condition.field} ${condition.op} ${describeValue(value)} → ${shown}`,
  };
}

const MAX_PATTERN_LENGTH = 200;
const MAX_MATCH_INPUT = 4000;

function compare(op: string, actual: unknown, expected: unknown, now: Date): boolean {
  switch (op) {
    case 'eq':
      return looseEquals(actual, expected);
    case 'neq':
      return !looseEquals(actual, expected);

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === undefined || b === undefined) return false;
      if (op === 'gt') return a > b;
      if (op === 'gte') return a >= b;
      if (op === 'lt') return a < b;
      return a <= b;
    }

    case 'contains':
    case 'not_contains': {
      const needle = normaliseText(expected);
      const hit = Array.isArray(actual)
        ? actual.some((item) => normaliseText(item).includes(needle))
        : !isEmpty(actual) && normaliseText(actual).includes(needle);
      return op === 'contains' ? hit : !hit;
    }

    case 'matches': {
      if (isEmpty(actual)) return false;
      const pattern = String(expected);
      if (pattern.length > MAX_PATTERN_LENGTH) return false;
      try {
        const regex = new RegExp(pattern, 'i');
        return toStringList(actual).some((item) => regex.test(item.slice(0, MAX_MATCH_INPUT)));
      } catch {
        return false;
      }
    }

    case 'in':
    case 'not_in': {
      const candidates = Array.isArray(expected) ? expected : [expected];
      const wanted = new Set(candidates.map((c) => normaliseText(c)));
      const values = toStringList(actual).map((v) => normaliseText(v));
      const hit = values.some((v) => wanted.has(v));
      return op === 'in' ? hit : !hit;
    }

    case 'between': {
      const a = toNumber(actual);
      if (a === undefined || !Array.isArray(expected) || expected.length !== 2) return false;
      const min = toNumber(expected[0]);
      const max = toNumber(expected[1]);
      if (min === undefined || max === undefined) return false;
      return a >= Math.min(min, max) && a <= Math.max(min, max);
    }

    case 'within_days':
    case 'older_than_days': {
      const date = toDate(actual);
      const days = toNumber(expected);
      if (!date || days === undefined) return false;
      const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
      return op === 'within_days' ? ageDays <= days : ageDays > days;
    }

    default:
      return false;
  }
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (isEmpty(actual)) return isEmpty(expected);
  if (typeof expected === 'boolean') {
    if (typeof actual === 'boolean') return actual === expected;
    const text = normaliseText(actual);
    if (['true', 'yes', '1'].includes(text)) return expected;
    if (['false', 'no', '0'].includes(text)) return !expected;
    return false;
  }
  if (typeof expected === 'number') return toNumber(actual) === expected;
  if (Array.isArray(actual))
    return actual.some((item) => normaliseText(item) === normaliseText(expected));
  return normaliseText(actual) === normaliseText(expected);
}

/** Flattens a trace into the one-line explanations shown in the score panel. */
export function renderTrace(trace: ConditionTrace): string {
  if (!trace.children || trace.children.length === 0) return trace.description;
  const parts = trace.children.map((child) => renderTrace(child));
  if (trace.description === 'not') return `not (${parts[0] ?? ''})`;
  const joiner = trace.description.startsWith('all') ? ' and ' : ' or ';
  return parts.join(joiner);
}
