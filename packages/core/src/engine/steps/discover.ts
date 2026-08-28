import { PipelineError } from '../../errors.js';
import { deterministicId } from '../../ids.js';
import { canonicaliseUrl } from '../../normalize.js';
import type { SourceWrite } from '../../ports/stores.js';
import type { PlannedQuery } from '../../providers/types.js';
import { mapWithConcurrency } from '../../concurrency.js';
import type { PipelineContext, PipelineStep, StepResult } from '../types.js';

/**
 * Executes the planned queries against the search provider and records every
 * source it finds.
 *
 * Sources are stored before anything is extracted from them. That ordering is
 * what makes the run auditable: even a run that fails during extraction leaves
 * behind the exact list of documents it was looking at.
 */
export const discoverStep: PipelineStep = {
  id: 'discover',
  name: 'Discovering sources',
  idempotent: true,
  maxAttempts: 3,
  timeoutMs: 300_000,

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const plan = await ctx.outputOf<{ queries: PlannedQuery[] }>('plan');
    const queries = plan?.queries ?? [];

    if (queries.length === 0) {
      throw new PipelineError('STEP_FAILED', 'no planned queries to execute', { retryable: false });
    }

    const provider = ctx.providers.search;
    const { maxResults, resultsPerQuery } = ctx.config.discovery;
    const seen = new Set<string>();
    const collected: SourceWrite[] = [];
    let providerCalls = 0;

    const { failures } = await mapWithConcurrency(
      [...queries].sort((a, b) => b.priority - a.priority),
      Math.min(4, queries.length),
      async (query) => {
        await ctx.assertNotCancelled();
        providerCalls += 1;

        const results = await provider.search(
          {
            query: query.query,
            source: query.source,
            limit: Math.min(resultsPerQuery, maxResults),
          },
          { runId: ctx.runId, attempt: ctx.attempt, logger: ctx.logger, signal: ctx.signal },
        );

        for (const result of results) {
          if (collected.length >= maxResults) break;
          const canonicalUrl = canonicaliseUrl(result.url);
          if (!canonicalUrl || seen.has(canonicalUrl)) continue;
          seen.add(canonicalUrl);
          collected.push({
            // Deterministic: re-running discover re-derives the same ids and
            // the upsert becomes a no-op rather than a duplicate.
            id: deterministicId('src', ctx.runId, canonicalUrl),
            runId: ctx.runId,
            url: result.url,
            canonicalUrl,
            title: result.title,
            snippet: result.snippet,
            kind: result.kind,
            provider: provider.meta.id,
            query: query.query,
            rank: result.rank,
          });
        }

        await ctx.emit({
          level: 'debug',
          type: 'source.discovered',
          message: `${results.length} results for "${query.query}"`,
          data: { queryId: query.id, source: query.source, results: results.length },
        });
      },
      { signal: ctx.signal },
    );

    if (collected.length === 0) {
      throw new PipelineError(
        'STEP_FAILED',
        `no sources discovered across ${queries.length} queries`,
        // Retryable: an empty result set is often a transient upstream issue.
        { retryable: failures.length > 0, details: { failures: failures.length } },
      );
    }

    const { inserted, skipped } = await ctx.stores.sources.upsertMany(collected);
    await ctx.stores.runs.incrementStats(ctx.runId, {
      sourcesDiscovered: inserted,
      providerErrors: failures.length,
    });

    const warnings = failures.map(
      ({ item, error }) =>
        `query "${(item as PlannedQuery).query}" failed: ${error instanceof Error ? error.message : String(error)}`,
    );

    await ctx.emit({
      level: warnings.length > 0 ? 'warn' : 'info',
      type: 'discover.completed',
      message: `${inserted} sources discovered (${skipped} already known)`,
      data: { inserted, skipped, failedQueries: failures.length },
    });

    return {
      status: failures.length > 0 ? 'partial' : 'completed',
      metrics: {
        itemsIn: queries.length,
        itemsOut: inserted,
        itemsFailed: failures.length,
        providerCalls,
        providerErrors: failures.length,
      },
      warnings,
      output: { sourceCount: inserted, queriesExecuted: queries.length - failures.length },
    };
  },
};
