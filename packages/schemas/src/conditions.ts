import { z } from 'zod';

/**
 * A tiny, declarative condition language.
 *
 * It is deliberately small and non-Turing-complete: conditions come from
 * client-supplied configuration files, they must be serialisable to JSON,
 * storable in Postgres, renderable in the UI, and — most importantly —
 * *explainable*. Every evaluation produces a human-readable trace.
 *
 * The same language is reused in three places, which keeps the surface a
 * Forward Deployed Engineer has to learn very small:
 *
 *   - signal detection  (`SignalDefinition.when`)
 *   - validation rules  (`ValidationRuleDefinition.require`)
 *   - scoring rules     (`ScoringRuleDefinition.when`)
 */

export const comparisonOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'matches',
  'in',
  'not_in',
  'between',
  'within_days',
  'older_than_days',
]);

export type ComparisonOperator = z.infer<typeof comparisonOperatorSchema>;

const comparableValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
  z.tuple([z.number(), z.number()]),
]);

export type ComparableValue = z.infer<typeof comparableValueSchema>;

export type Condition =
  | { field: string; op: 'exists' }
  | { field: string; op: 'missing' }
  | { field: string; op: ComparisonOperator; value: ComparableValue }
  | { signal: string; present?: boolean }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { always: true };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ field: z.string().min(1), op: z.literal('exists') }),
    z.object({ field: z.string().min(1), op: z.literal('missing') }),
    z.object({
      field: z.string().min(1),
      op: comparisonOperatorSchema,
      value: comparableValueSchema,
    }),
    z.object({ signal: z.string().min(1), present: z.boolean().optional() }),
    z.object({ all: z.array(conditionSchema).min(1) }),
    z.object({ any: z.array(conditionSchema).min(1) }),
    z.object({ not: conditionSchema }),
    z.object({ always: z.literal(true) }),
  ]),
);

/** The result of evaluating a condition, retained so the UI can explain it. */
export interface ConditionTrace {
  matched: boolean;
  /** Human-readable description, e.g. `employeeCount between 20 and 500 → 140 ✓`. */
  description: string;
  children?: ConditionTrace[];
}
