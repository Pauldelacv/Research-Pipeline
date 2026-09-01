import { newId, type FailureStore, type UsageStore, type UsageWrite } from '@frp/core';
import type {
  ProviderUsage,
  RunFailure,
  RunUsageSummary,
  UsageBreakdownRow,
  UsageTotals,
} from '@frp/schemas';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { toProviderUsage, toRunFailure } from '../mappers.js';
import { providerUsage, runFailures } from '../schema.js';

/**
 * Cost accounting and failure inspection.
 *
 * Both tables are append-only and read far less often than they are written,
 * so the writes stay a single batched insert and the aggregation happens in
 * SQL on read. A run has bounded cardinality — thousands of calls, not
 * millions — which is what makes the rollup affordable without a materialised
 * counter that could drift from the rows it summarises.
 */

export function createUsageStore(db: Database): UsageStore {
  return {
    async recordMany(entries: UsageWrite[]): Promise<number> {
      if (entries.length === 0) return 0;
      const rows = await db
        .insert(providerUsage)
        .values(
          entries.map((entry) => ({
            id: newId('usg'),
            runId: entry.runId,
            stepId: entry.stepId,
            provider: entry.provider,
            providerKind: entry.providerKind,
            operation: entry.operation,
            model: entry.model,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            requests: entry.requests,
            costUsd: entry.costUsd,
            costSource: entry.costSource,
            latencyMs: entry.latencyMs,
            outcome: entry.outcome,
            errorCode: entry.errorCode,
            target: entry.target?.slice(0, 500) ?? null,
          })),
        )
        .returning({ id: providerUsage.id });
      return rows.length;
    },

    async listByRun(runId, options = {}): Promise<ProviderUsage[]> {
      const rows = await db
        .select()
        .from(providerUsage)
        .where(eq(providerUsage.runId, runId))
        .orderBy(asc(providerUsage.createdAt))
        .limit(options.limit ?? 500)
        .offset(options.offset ?? 0);
      return rows.map(toProviderUsage);
    },

    async summarise(runId: string): Promise<RunUsageSummary> {
      const [byProvider, byStep] = await Promise.all([
        aggregate(db, runId, 'provider'),
        aggregate(db, runId, 'step'),
      ]);
      return { runId, totals: sumTotals(byProvider), byProvider, byStep };
    },
  };
}

/**
 * One aggregation query, grouped either by (provider, operation, model) or by
 * step. `partialCost` is the honest part: it flags a rollup whose total is a
 * floor because at least one call could not be priced.
 */
async function aggregate(
  db: Database,
  runId: string,
  by: 'provider' | 'step',
): Promise<UsageBreakdownRow[]> {
  const rows = await db
    .select({
      provider: by === 'provider' ? providerUsage.provider : sql<string>`'all'`,
      providerKind: by === 'provider' ? providerUsage.providerKind : sql<string>`'all'`,
      operation: by === 'provider' ? providerUsage.operation : sql<string>`'all'`,
      model: by === 'provider' ? providerUsage.model : sql<string | null>`null`,
      stepId: providerUsage.stepId,
      requests: sql<number>`coalesce(sum(${providerUsage.requests}), 0)::int`,
      failures: sql<number>`count(*) filter (where ${providerUsage.outcome} = 'failure')::int`,
      inputTokens: sql<number>`coalesce(sum(${providerUsage.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${providerUsage.outputTokens}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${providerUsage.costUsd}), 0)::double precision`,
      latencyMs: sql<number>`coalesce(sum(${providerUsage.latencyMs}), 0)::int`,
      unpriced: sql<number>`count(*) filter (where ${providerUsage.costUsd} is null)::int`,
    })
    .from(providerUsage)
    .where(eq(providerUsage.runId, runId))
    .groupBy(
      ...(by === 'provider'
        ? [
            providerUsage.provider,
            providerUsage.providerKind,
            providerUsage.operation,
            providerUsage.model,
            providerUsage.stepId,
          ]
        : [providerUsage.stepId]),
    )
    .orderBy(desc(sql`coalesce(sum(${providerUsage.costUsd}), 0)`));

  return rows.map((row) => ({
    provider: row.provider,
    providerKind: row.providerKind,
    operation: row.operation,
    model: row.model ?? null,
    stepId: row.stepId ?? null,
    requests: row.requests,
    failures: row.failures,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: round6(row.costUsd),
    latencyMs: row.latencyMs,
    partialCost: row.unpriced > 0,
  }));
}

function sumTotals(rows: UsageBreakdownRow[]): UsageTotals {
  const totals: UsageTotals = {
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    partialCost: false,
  };
  for (const row of rows) {
    totals.requests += row.requests;
    totals.failures += row.failures;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.costUsd += row.costUsd;
    totals.latencyMs += row.latencyMs;
    totals.partialCost ||= row.partialCost;
  }
  totals.costUsd = round6(totals.costUsd);
  return totals;
}

/** Six decimals: per-call model costs are routinely fractions of a cent. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function createFailureStore(db: Database): FailureStore {
  return {
    async record(failure): Promise<RunFailure> {
      const [row] = await db
        .insert(runFailures)
        .values({
          id: newId('fail'),
          runId: failure.runId,
          stepId: failure.stepId,
          scope: failure.scope,
          attempt: failure.attempt,
          maxAttempts: failure.maxAttempts,
          willRetry: failure.willRetry,
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          provider: failure.provider,
          operation: failure.operation,
          targetId: failure.targetId,
          targetLabel: failure.targetLabel,
          detail: failure.detail,
        })
        .returning();
      if (!row) throw new Error('failed to record run failure');
      return toRunFailure(row);
    },

    async listByRun(runId, options = {}): Promise<RunFailure[]> {
      const rows = await db
        .select()
        .from(runFailures)
        .where(eq(runFailures.runId, runId))
        // Newest first: an operator opening a broken run wants the thing that
        // just went wrong, not the first hiccup of a long extraction.
        .orderBy(desc(runFailures.createdAt))
        .limit(options.limit ?? 200)
        .offset(options.offset ?? 0);
      return rows.map(toRunFailure);
    },

    async countByRun(runId: string): Promise<number> {
      const [row] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(runFailures)
        .where(eq(runFailures.runId, runId));
      return row?.total ?? 0;
    },
  };
}

/** Failures for one step of one run, used by the step drill-down. */
export async function listStepFailures(
  db: Database,
  runId: string,
  stepId: string,
): Promise<RunFailure[]> {
  const rows = await db
    .select()
    .from(runFailures)
    .where(and(eq(runFailures.runId, runId), eq(runFailures.stepId, stepId as never)))
    .orderBy(desc(runFailures.createdAt))
    .limit(100);
  return rows.map(toRunFailure);
}
