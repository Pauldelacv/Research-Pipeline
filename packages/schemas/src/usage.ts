import { z } from 'zod';
import { stepIdSchema } from './pipeline.js';

/**
 * Provider usage accounting.
 *
 * A research run is a sequence of purchases: search calls, page fetches, model
 * tokens. Until they are counted, "is this pipeline worth running?" has no
 * answer, and neither does "which step got expensive after last week's config
 * change?".
 *
 * One row per upstream call. Costs are recorded as estimates and labelled as
 * such: some providers report a price, most report only tokens, and a token
 * count multiplied by a local price table is an estimate no matter how
 * confidently it is displayed.
 */

export const usageOutcomeSchema = z.enum(['success', 'failure']);
export type UsageOutcome = z.infer<typeof usageOutcomeSchema>;

/** Where the money figure came from. Displayed, not just stored. */
export const costSourceSchema = z.enum([
  /** The provider returned a price for this call. */
  'reported',
  /** Tokens multiplied by a configured or built-in price table. */
  'estimated',
  /** No price could be determined. */
  'unknown',
]);
export type CostSource = z.infer<typeof costSourceSchema>;

export const providerUsageSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: stepIdSchema.nullable(),
  provider: z.string(),
  /** `research` | `search` | `extraction` | `enrichment`. */
  providerKind: z.string(),
  /** Provider-specific verb: `plan`, `search`, `extract`, `fetch`. */
  operation: z.string(),
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  /** Upstream requests represented by this row. Usually 1. */
  requests: z.number().int().nonnegative().default(1),
  costUsd: z.number().nonnegative().nullable(),
  costSource: costSourceSchema.default('unknown'),
  latencyMs: z.number().int().nonnegative().nullable(),
  outcome: usageOutcomeSchema,
  errorCode: z.string().nullable(),
  /** Source id, entity id or query the call was made for. */
  target: z.string().nullable(),
  createdAt: z.string(),
});

export type ProviderUsage = z.infer<typeof providerUsageSchema>;

export const usageTotalsSchema = z.object({
  requests: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  /** True when at least one row could not be priced — the total is a floor. */
  partialCost: z.boolean(),
});

export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export const usageBreakdownRowSchema = usageTotalsSchema.extend({
  provider: z.string(),
  providerKind: z.string(),
  operation: z.string(),
  model: z.string().nullable(),
  stepId: stepIdSchema.nullable(),
});

export type UsageBreakdownRow = z.infer<typeof usageBreakdownRowSchema>;

export const runUsageSummarySchema = z.object({
  runId: z.string(),
  totals: usageTotalsSchema,
  byProvider: z.array(usageBreakdownRowSchema),
  byStep: z.array(usageBreakdownRowSchema),
});

export type RunUsageSummary = z.infer<typeof runUsageSummarySchema>;
