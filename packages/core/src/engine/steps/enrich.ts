import type { JsonValue } from '@frp/schemas';
import { mapWithConcurrency } from '../../concurrency.js';
import { deterministicId } from '../../ids.js';
import { canonicaliseUrl, coerceFieldValue } from '../../normalize.js';
import type { EntityWithFields, EvidenceWrite, SourceWrite } from '../../ports/stores.js';
import type { PipelineContext, PipelineStep, StepResult } from '../types.js';

/**
 * Fills gaps using a provider that works from an identified entity rather than
 * from a document — a company-graph API, an internal warehouse, a tech-stack
 * detector.
 *
 * Enrichment is bounded on purpose: it may only write the field keys listed in
 * `enrichment.fields`, and it never overwrites a value a human has edited or
 * approved. Sources it consults are recorded like any other, so an enriched
 * value is exactly as traceable as an extracted one.
 */
export const enrichStep: PipelineStep = {
  id: 'enrich',
  name: 'Enriching entities',
  idempotent: true,
  maxAttempts: 3,
  timeoutMs: 900_000,

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const { config } = ctx;
    const provider = ctx.providers.enrichment;

    if (!provider || !config.enrichment.enabled || config.enrichment.fields.length === 0) {
      await ctx.emit({
        type: 'enrich.skipped',
        message: provider
          ? 'Enrichment is disabled for this pipeline'
          : 'No enrichment provider is configured',
      });
      return { status: 'skipped', output: { reason: provider ? 'disabled' : 'no-provider' } };
    }

    const targetFields = config.extraction.fields.filter((field) =>
      config.enrichment.fields.includes(field.key),
    );
    const targetKeys = new Set(targetFields.map((field) => field.key));

    const entities: EntityWithFields[] = [];
    for await (const record of ctx.stores.entities.iterate(ctx.runId, 200)) {
      if (record.entity.status === 'rejected') continue;
      entities.push(record);
    }

    let providerCalls = 0;
    let fieldsWritten = 0;
    let sourcesRecorded = 0;

    const { failures } = await mapWithConcurrency(
      entities,
      config.enrichment.concurrency,
      async ({ entity, fields }) => {
        await ctx.assertNotCancelled();
        providerCalls += 1;

        const output = await provider.enrich(
          {
            entityId: entity.id,
            entityType: entity.entityType,
            values: entity.data,
            targetFields,
            signals: config.signals,
          },
          { runId: ctx.runId, attempt: ctx.attempt, logger: ctx.logger, signal: ctx.signal },
        );

        // Record the consulted sources first so evidence can reference them.
        const sourceWrites: SourceWrite[] = output.sources.map((result) => {
          const canonicalUrl = canonicaliseUrl(result.url);
          return {
            id: deterministicId('src', ctx.runId, canonicalUrl),
            runId: ctx.runId,
            url: result.url,
            canonicalUrl,
            title: result.title,
            snippet: result.snippet,
            kind: result.kind,
            provider: provider.meta.id,
            query: null,
            rank: result.rank,
          };
        });
        if (sourceWrites.length > 0) {
          const { inserted } = await ctx.stores.sources.upsertMany(sourceWrites);
          sourcesRecorded += inserted;
        }
        const fallbackSourceId = sourceWrites[0]?.id ?? null;

        const frozen = new Set(
          fields
            .filter((field) => field.status === 'edited' || field.status === 'approved')
            .map((field) => field.key),
        );

        for (const enriched of output.fields) {
          if (!targetKeys.has(enriched.key) || frozen.has(enriched.key)) continue;
          const definition = targetFields.find((field) => field.key === enriched.key);
          if (!definition) continue;

          const value = coerceFieldValue(definition, enriched.value);
          if (value === undefined) continue;

          const evidence: EvidenceWrite[] = fallbackSourceId
            ? [
                {
                  sourceId: fallbackSourceId,
                  snippet: enriched.evidence.snippet.slice(0, 1000),
                  locator: enriched.evidence.locator ?? null,
                  confidence: enriched.confidence,
                  method: enriched.evidence.method,
                },
              ]
            : [];

          await ctx.stores.entities.updateField(entity.id, enriched.key, {
            value: value as JsonValue | null,
            confidence: enriched.confidence,
            status: 'auto',
            extractedBy: provider.meta.id,
            evidence,
          });
          fieldsWritten += 1;
        }
      },
      { signal: ctx.signal },
    );

    await ctx.stores.runs.incrementStats(ctx.runId, {
      providerErrors: failures.length,
      sourcesDiscovered: sourcesRecorded,
    });

    const warnings = failures
      .slice(0, 10)
      .map(
        ({ item, error }) =>
          `enrichment failed for ${(item as EntityWithFields).entity.displayName}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );

    await ctx.emit({
      level: failures.length > 0 ? 'warn' : 'info',
      type: 'enrich.completed',
      message: `${fieldsWritten} fields enriched across ${entities.length - failures.length} entities`,
      data: { fieldsWritten, entities: entities.length, failures: failures.length },
    });

    return {
      status: failures.length > 0 ? 'partial' : 'completed',
      metrics: {
        itemsIn: entities.length,
        itemsOut: entities.length - failures.length,
        itemsFailed: failures.length,
        providerCalls,
        providerErrors: failures.length,
      },
      warnings,
      output: { fieldsWritten, sourcesRecorded },
    };
  },
};
