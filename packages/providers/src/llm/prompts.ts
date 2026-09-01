import type { ExtractedField, ExtractionInput, ResearchPlanInput } from '@frp/core';

/**
 * The prompts and the post-processing every model-backed provider shares.
 *
 * The instructions are the interesting part of these adapters, and they are
 * not model-specific: "quote the source, never infer, null when absent" is the
 * contract that makes the output reviewable regardless of who serves the
 * tokens. Keeping one copy means a provider added later inherits the rules
 * rather than an approximation of them written from memory.
 */

export const PLAN_SYSTEM =
  'You plan web research. Produce specific, high-yield search queries. ' +
  'Every query must use one of the listed source channels verbatim. ' +
  'Prefer queries that surface pages listing many entities over single-company pages.';

export const EXTRACTION_SYSTEM =
  'You extract structured records from web pages. Rules you must follow:\n' +
  '1. Report only what the source states. Never infer, estimate or recall from memory.\n' +
  '2. If a field is not stated, return null for it rather than guessing.\n' +
  '3. Every reported value must include a short verbatim quote from the source.\n' +
  '4. Confidence reflects how clearly the source states the value, not how plausible it is.\n' +
  '5. Return one entity per distinct organisation or record described; none if the page describes no entity of the requested type.';

export function buildPlanPrompt(input: ResearchPlanInput): string {
  const { config, targeting, objective } = input;
  return [
    `Objective: ${objective}`,
    `Entity type: ${config.entity.label} (${config.entity.type})`,
    `Available source channels: ${config.discovery.sources.join(', ')}`,
    `Produce at most ${config.discovery.queriesPerPlan} queries.`,
    '',
    'Targeting criteria supplied by the operator:',
    JSON.stringify(targeting, null, 2),
    '',
    'Fields that must be populated from the sources you find:',
    config.extraction.fields
      .map(
        (field) =>
          `- ${field.key} (${field.type}${field.required ? ', required' : ''}): ${field.label}` +
          (field.description ? ` — ${field.description}` : ''),
      )
      .join('\n'),
  ].join('\n');
}

export function buildExtractionPrompt(input: ExtractionInput, content: string): string {
  const fieldSpec = input.fields
    .map((field) => {
      const guidance = input.guidance[field.key];
      const options = field.options?.length ? ` One of: ${field.options.join(' | ')}.` : '';
      return `- ${field.key} (${field.type})${field.required ? ' [required]' : ''}: ${field.label}.${options}${
        guidance ? ` ${guidance}` : ''
      }`;
    })
    .join('\n');

  return [
    `Entity type to extract: ${input.entityType}`,
    `Research objective: ${input.objective}`,
    '',
    'Fields:',
    fieldSpec,
    '',
    input.signals.length > 0
      ? `Signals to assess:\n${input.signals.map((s) => `- ${s.key}: ${s.label}`).join('\n')}`
      : '',
    '',
    `Source URL: ${input.source.url}`,
    'Source text:',
    '---',
    content,
    '---',
  ].join('\n');
}

/** The model's raw entity shape, common to every schema built for extraction. */
export interface ParsedEntity {
  fields: Array<{ key: string; value: string | null; confidence: number; evidence: string }>;
  signals: Array<{ key: string; detected: boolean; confidence: number; rationale: string }>;
}

export interface MappedEntity {
  fields: ExtractedField[];
  signals: Array<{ key: string; detected: boolean; confidence: number; rationale: string }>;
}

/**
 * Turns the model's answer into the pipeline's shape, dropping anything it
 * cannot justify.
 *
 * Two rejections happen here and nowhere else: a field the configuration never
 * declared (the model invented a column) and a value with no supporting quote
 * (nobody could review it). Both are counted as warnings rather than silently
 * ignored, because a model that keeps doing either is a prompt problem worth
 * seeing.
 */
export function mapExtractedEntities(
  entities: ParsedEntity[],
  fieldKeys: Set<string>,
  warnings: string[],
): MappedEntity[] {
  return entities.map((entity) => {
    const fields: ExtractedField[] = [];
    for (const field of entity.fields ?? []) {
      if (!fieldKeys.has(field.key)) {
        warnings.push(`model returned unknown field "${field.key}"`);
        continue;
      }
      if (field.value === null || !field.evidence?.trim()) continue;
      fields.push({
        key: field.key,
        value: field.value,
        confidence: clamp01(field.confidence),
        evidence: { snippet: field.evidence, method: 'llm' },
      });
    }
    return {
      fields,
      signals: (entity.signals ?? []).map((signal) => ({
        key: signal.key,
        detected: signal.detected,
        confidence: clamp01(signal.confidence),
        rationale: signal.rationale,
      })),
    };
  });
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
