import type { JsonValue, ResearchPipelineConfig } from '@frp/schemas';
import { PipelineError } from '../../errors.js';
import { deterministicId } from '../../ids.js';
import {
  aggregateConfidence,
  mergeFields,
  projectData,
  type MergeCandidateField,
} from '../../merge.js';
import { buildDedupeKey } from '../../normalize.js';
import type { EntityWithFields } from '../../ports/stores.js';
import type { PipelineContext, PipelineStep, StepResult } from '../types.js';

/**
 * Collapses per-source candidates into deduplicated entities.
 *
 * This is where "47 pages mentioning companies" becomes "23 companies, each
 * with its evidence". Merging is field-by-field: agreement raises confidence,
 * disagreement lowers it and keeps both sources so a human can adjudicate.
 *
 * The step is idempotent because entity ids are derived from the run id and
 * the dedupe key, and merging an already-merged candidate converges.
 */
export const structureStep: PipelineStep = {
  id: 'structure',
  name: 'Structuring results',
  idempotent: true,
  maxAttempts: 2,
  timeoutMs: 300_000,

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const { config } = ctx;
    const definitions = config.extraction.fields;

    let processed = 0;
    let unidentifiable = 0;
    let conflictCount = 0;
    const touched = new Map<string, { id: string; sourceIds: Set<string> }>();

    for await (const candidate of ctx.stores.candidates.iterate(ctx.runId, 200)) {
      await ctx.assertNotCancelled();
      processed += 1;

      const values: Record<string, unknown> = {};
      for (const field of candidate.payload.fields) values[field.key] = field.value;

      const dedupeKey = buildDedupeKey(config, values);
      if (!dedupeKey) {
        // Without an identity we cannot merge safely; dropping is preferable
        // to creating a duplicate that pollutes the operator's table.
        unidentifiable += 1;
        continue;
      }

      const entityId = deterministicId('ent', ctx.runId, dedupeKey);
      const existing: EntityWithFields | null = await ctx.stores.entities.findByDedupeKey(
        ctx.runId,
        dedupeKey,
      );

      const incoming: MergeCandidateField[] = candidate.payload.fields.map((field) => ({
        key: field.key,
        value: field.value,
        confidence: field.confidence,
        extractedBy: candidate.extractedBy,
        evidence: [
          {
            sourceId: candidate.sourceId,
            snippet: field.evidence.snippet,
            locator: field.evidence.locator,
            confidence: field.confidence,
            method: field.evidence.method,
          },
        ],
      }));

      const { fields, conflicts } = mergeFields(existing?.fields ?? [], incoming);
      conflictCount += conflicts.length;

      const tracked = touched.get(dedupeKey) ?? { id: entityId, sourceIds: new Set<string>() };
      tracked.sourceIds.add(candidate.sourceId);
      touched.set(dedupeKey, tracked);

      const data = projectData(definitions, fields);
      const displayName = displayNameFor(config, data, dedupeKey);

      await ctx.stores.entities.save({
        id: existing?.entity.id ?? entityId,
        runId: ctx.runId,
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
        entityType: config.entity.type,
        dedupeKey,
        displayName,
        // Validation decides the real status; until then everything is `new`.
        status: existing?.entity.status ?? 'new',
        data,
        confidence: aggregateConfidence(config, fields),
        validationStatus: 'pending',
        validationIssues: [],
        signals: existing?.entity.signals ?? [],
        score: existing?.entity.score ?? null,
        scoreBreakdown: existing?.entity.scoreBreakdown ?? null,
        flaggedFields: [],
        sourceCount: Math.max(existing?.entity.sourceCount ?? 0, tracked.sourceIds.size),
        fields,
      });
    }

    if (touched.size === 0) {
      throw new PipelineError(
        'STEP_FAILED',
        `structuring produced no entities from ${processed} candidates ` +
          `(${unidentifiable} lacked the identity fields ${config.entity.identity.fields.join(', ')})`,
        { retryable: false },
      );
    }

    await ctx.stores.runs.incrementStats(ctx.runId, { entitiesStructured: touched.size });

    const warnings: string[] = [];
    if (unidentifiable > 0) {
      warnings.push(`${unidentifiable} candidates dropped: no identity field could be resolved`);
    }
    if (conflictCount > 0) {
      warnings.push(`${conflictCount} field conflicts resolved by confidence`);
    }

    await ctx.emit({
      type: 'structure.completed',
      message: `${processed} candidates merged into ${touched.size} ${config.entity.labelPlural.toLowerCase()}`,
      data: {
        candidates: processed,
        entities: touched.size,
        dropped: unidentifiable,
        conflicts: conflictCount,
      },
    });

    return {
      status: unidentifiable > 0 ? 'partial' : 'completed',
      metrics: {
        itemsIn: processed,
        itemsOut: touched.size,
        itemsFailed: unidentifiable,
      },
      warnings,
      output: { entities: touched.size, conflicts: conflictCount },
    };
  },
};

/**
 * Picks the label an operator sees in the results table.
 *
 * The configured display field wins. When a source did not report it, the next
 * best human-readable field is used rather than the dedupe key — a row labelled
 * `acme.com|pricing change|2026-05-22` is technically correct and practically
 * useless. The key remains the last resort so a row is never unlabelled.
 */
function displayNameFor(
  config: ResearchPipelineConfig,
  data: Record<string, JsonValue | null>,
  fallback: string,
): string {
  const readable = (value: JsonValue | null | undefined): string | null => {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
    if (typeof value === 'number') return String(value);
    return null;
  };

  const preferred = readable(data[config.entity.displayField]);
  if (preferred) return preferred;

  const candidates = config.extraction.fields
    .filter(
      (field) =>
        field.key !== config.entity.displayField &&
        (field.type === 'string' || field.type === 'text'),
    )
    // Required fields first: they are the ones meant to identify the record.
    .sort((a, b) => Number(b.required) - Number(a.required));

  for (const field of candidates) {
    const value = readable(data[field.key]);
    if (value) return value;
  }

  return fallback;
}
