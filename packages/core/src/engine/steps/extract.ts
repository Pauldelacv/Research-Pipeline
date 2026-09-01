import type { JsonValue, Source } from '@frp/schemas';
import { mapWithConcurrency } from '../../concurrency.js';
import { PipelineError } from '../../errors.js';
import { deterministicId } from '../../ids.js';
import { coerceFieldValue } from '../../normalize.js';
import type { EntityCandidate } from '../../ports/stores.js';
import type { ExtractedEntity } from '../../providers/types.js';
import { applyTrust, effectiveTrust, isSelfReportedSource } from '../../trust.js';
import type { PipelineContext, PipelineStep, StepResult } from '../types.js';
import { recordItemFailures } from './report.js';

/**
 * Pulls structured candidates out of each discovered source.
 *
 * Two things happen here that matter downstream:
 *   1. Every value is coerced onto its declared type. A provider returning
 *      "approx. 250" yields the number 250 or nothing at all — never a string
 *      masquerading as a count.
 *   2. Every value keeps the evidence that produced it. A field with no
 *      evidence is dropped, because it could not be reviewed.
 *   3. Every confidence is weighted by how much the source is trusted. The
 *      weighting is applied to the candidate's confidence only — the evidence
 *      keeps the raw number the provider reported, so "the extractor was 0.9
 *      sure, but the page was an unknown aggregator" stays legible instead of
 *      collapsing into one unexplained 0.63.
 *
 * Output lands in the candidate staging table rather than in `entities`;
 * merging is the next step's job.
 */
export const extractStep: PipelineStep = {
  id: 'extract',
  name: 'Extracting entity data',
  idempotent: true,
  maxAttempts: 3,
  timeoutMs: 900_000,

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const plan = await ctx.outputOf<{ fieldGuidance: Record<string, string> }>('plan');
    const guidance = plan?.fieldGuidance ?? {};
    const provider = ctx.providers.extraction;
    const fields = ctx.config.extraction.fields;
    const fieldsByKey = new Map(fields.map((field) => [field.key, field]));

    const sources = await ctx.stores.sources.listByRun(ctx.runId, {
      limit: ctx.config.discovery.maxResults,
    });
    if (sources.length === 0) {
      throw new PipelineError('STEP_FAILED', 'no sources available to extract from');
    }

    const trustConfig = ctx.config.sources.trust;
    let providerCalls = 0;
    let droppedValues = 0;
    let trustDamped = 0;
    const candidates: Array<Omit<EntityCandidate, 'createdAt'>> = [];
    const warnings: string[] = [];

    const { failures } = await mapWithConcurrency(
      sources,
      ctx.config.extraction.concurrency,
      async (source) => {
        await ctx.assertNotCancelled();
        providerCalls += 1;

        const output = await provider.extract(
          {
            source: {
              id: source.id,
              url: source.url,
              title: source.title,
              snippet: source.snippet,
              kind: source.kind,
              query: source.query,
            },
            entityType: ctx.config.entity.type,
            fields,
            signals: ctx.config.signals,
            objective: ctx.objective,
            targeting: ctx.targeting,
            guidance,
          },
          ctx.providerCall(provider.meta, { target: source.id }),
        );

        warnings.push(...output.warnings.map((w) => `${source.canonicalUrl}: ${w}`));

        output.entities.forEach((entity: ExtractedEntity, index: number) => {
          const payloadFields = [];
          const coerced: Record<string, JsonValue | null> = {};

          for (const extracted of entity.fields) {
            const definition = fieldsByKey.get(extracted.key);
            if (!definition) continue;

            const value = coerceFieldValue(definition, extracted.value);
            if (value === undefined) {
              // The provider returned something we cannot trust as this type.
              droppedValues += 1;
              continue;
            }
            if (!extracted.evidence?.snippet) {
              droppedValues += 1;
              continue;
            }

            coerced[extracted.key] = value as JsonValue | null;
            payloadFields.push({
              key: extracted.key,
              // Raw provider confidence; weighted below, once the candidate's
              // own values have revealed whether this is its official site.
              confidence: clamp01(extracted.confidence),
              value: value as JsonValue | null,
              evidence: {
                snippet: extracted.evidence.snippet.slice(0, 1000),
                locator: extracted.evidence.locator ?? null,
                method: extracted.evidence.method,
              },
            });
          }

          if (payloadFields.length === 0) return;

          const selfReported =
            trustConfig.selfReported.enabled &&
            isSelfReportedSource(ctx.config, coerced, source.canonicalUrl);
          const trust = effectiveTrust(
            ctx.config,
            { score: source.trustScore, categoryId: source.trustCategory, label: '' },
            selfReported,
          );

          const weighted = payloadFields.map((field) => {
            const confidence = trustConfig.enabled
              ? applyTrust(field.confidence, trust.score, trustConfig.weight)
              : field.confidence;
            if (confidence < field.confidence) trustDamped += 1;
            return {
              ...field,
              confidence,
              // Provenance is not rewritten: the evidence row keeps what the
              // extractor said before trust had an opinion about the page.
              evidence: { ...field.evidence, confidence: field.confidence },
            };
          });

          candidates.push({
            id: deterministicId('ent', ctx.runId, source.id, String(index)),
            runId: ctx.runId,
            sourceId: source.id,
            payload: {
              fields: weighted,
              signals: entity.signals,
              sourceTrust: { score: trust.score, categoryId: trust.categoryId },
            },
            extractedBy: provider.meta.id,
          });
        });

        await ctx.emit({
          level: 'debug',
          type: 'extract.source',
          message: `${output.entities.length} candidates from ${source.canonicalUrl}`,
          data: { sourceId: source.id, candidates: output.entities.length },
        });
      },
      { signal: ctx.signal },
    );

    if (candidates.length === 0) {
      throw new PipelineError(
        'STEP_FAILED',
        `extraction produced no candidates from ${sources.length} sources`,
        { retryable: failures.length === sources.length, details: { failures: failures.length } },
      );
    }

    const written = await ctx.stores.candidates.upsertMany(candidates);
    await ctx.stores.runs.incrementStats(ctx.runId, {
      entitiesExtracted: written,
      providerErrors: failures.length,
    });

    for (const failure of failures.slice(0, 10)) {
      const source = failure.item as Source;
      warnings.push(
        `extraction failed for ${source.canonicalUrl}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
      );
    }
    if (droppedValues > 0) {
      warnings.push(
        `${droppedValues} extracted values were discarded (wrong type or missing evidence)`,
      );
    }

    await recordItemFailures(
      ctx,
      'source',
      failures,
      (source) => ({
        id: source.id,
        label: source.canonicalUrl,
        provider: provider.meta.id,
      }),
      'extract',
    );

    await ctx.emit({
      level: failures.length > 0 ? 'warn' : 'info',
      type: 'extract.completed',
      message: `${written} candidates extracted from ${sources.length - failures.length} sources`,
      data: { candidates: written, failedSources: failures.length, droppedValues, trustDamped },
    });

    return {
      status: failures.length > 0 ? 'partial' : 'completed',
      metrics: {
        itemsIn: sources.length,
        itemsOut: written,
        itemsFailed: failures.length,
        providerCalls,
        providerErrors: failures.length,
      },
      warnings: warnings.slice(0, 50),
      output: { candidates: written, sourcesProcessed: sources.length - failures.length },
    };
  },
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
