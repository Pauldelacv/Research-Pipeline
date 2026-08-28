import type { Entity, JsonValue, ResearchPipelineConfig } from '@frp/schemas';

/**
 * The value map conditions are evaluated against.
 *
 * Configuration authors reasonably expect `{ field: 'score', op: 'gte' }` to
 * work in an export filter, but `score` is a computed column rather than an
 * extracted field, so it is absent from `entity.data`. Rather than teach the
 * condition language about entity internals, a small set of reserved
 * metadata keys is merged in here.
 *
 * Extracted fields always win: if a pipeline declares a field called `score`,
 * that field's value is what its own rules see. The reserved names are
 * documented in docs/configuration.md.
 */
export const RESERVED_FIELD_KEYS = [
  'score',
  'scoreBand',
  'confidence',
  'status',
  'validationStatus',
  'sourceCount',
  'displayName',
] as const;

export function entityEvaluationFields(
  config: ResearchPipelineConfig,
  entity: Entity,
): Record<string, JsonValue | null> {
  const declared = new Set(config.extraction.fields.map((field) => field.key));

  const metadata: Record<string, JsonValue | null> = {
    score: entity.score,
    scoreBand: entity.scoreBreakdown?.band ?? null,
    confidence: entity.confidence,
    status: entity.status,
    validationStatus: entity.validationStatus,
    sourceCount: entity.sourceCount,
    displayName: entity.displayName,
  };

  for (const key of RESERVED_FIELD_KEYS) {
    if (declared.has(key)) delete metadata[key];
  }

  return { ...entity.data, ...metadata };
}

/** Signal keys currently detected on an entity. */
export function detectedSignals(entity: Entity): string[] {
  return entity.signals.filter((signal) => signal.detected).map((signal) => signal.key);
}
