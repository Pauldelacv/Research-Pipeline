import type { ExportRow } from '@frp/core';
import type { FieldDefinition, JsonValue, ResearchPipelineConfig } from '@frp/schemas';

/**
 * Shared row shaping.
 *
 * Every connector exports the same logical record, so a CSV and a CRM push
 * never disagree about what "the results" are. Provenance columns are included
 * by default: an exported row that cannot be traced back is not much use to
 * the analyst who receives it.
 */

export interface FlatRow {
  [column: string]: string | number | boolean | null;
}

export interface RowShapeOptions {
  /** Field keys to include, in order. Defaults to every configured field. */
  columns?: string[];
  /** Adds score, confidence, status and signal columns. */
  includeMetadata?: boolean;
  /** Adds one column listing the source URLs behind the record. */
  includeSources?: boolean;
}

export function resolveColumns(
  config: ResearchPipelineConfig,
  options: RowShapeOptions,
): FieldDefinition[] {
  const all = config.extraction.fields;
  if (!options.columns?.length) return all;
  const wanted = new Set(options.columns);
  return all.filter((field) => wanted.has(field.key));
}

export function headerFor(config: ResearchPipelineConfig, options: RowShapeOptions): string[] {
  const header = resolveColumns(config, options).map((field) => field.label);
  if (options.includeMetadata !== false) {
    header.push('Score', 'Score band', 'Confidence', 'Status', 'Signals');
  }
  if (options.includeSources !== false) {
    header.push('Sources');
  }
  return header;
}

export function flattenRow(
  config: ResearchPipelineConfig,
  row: ExportRow,
  options: RowShapeOptions,
  sourceUrls: string[] = [],
): FlatRow {
  const flat: FlatRow = {};

  for (const field of resolveColumns(config, options)) {
    flat[field.label] = renderValue(row.entity.data[field.key] ?? null);
  }

  if (options.includeMetadata !== false) {
    flat['Score'] = row.entity.score;
    flat['Score band'] = row.entity.scoreBreakdown?.band ?? null;
    flat['Confidence'] = Math.round(row.entity.confidence * 100) / 100;
    flat['Status'] = row.entity.status;
    flat['Signals'] = row.entity.signals
      .filter((signal) => signal.detected)
      .map((signal) => signal.label)
      .join('; ');
  }

  if (options.includeSources !== false) {
    flat['Sources'] = sourceUrls.join(' ');
  }

  return flat;
}

/** Structured export shape — richer than a flat row, used by JSON destinations. */
export function structuredRow(config: ResearchPipelineConfig, row: ExportRow) {
  const definitions = new Map(config.extraction.fields.map((field) => [field.key, field]));

  return {
    id: row.entity.id,
    name: row.entity.displayName,
    entityType: row.entity.entityType,
    status: row.entity.status,
    score: row.entity.score,
    scoreBand: row.entity.scoreBreakdown?.band ?? null,
    confidence: row.entity.confidence,
    validation: {
      status: row.entity.validationStatus,
      issues: row.entity.validationIssues,
    },
    signals: row.entity.signals
      .filter((signal) => signal.detected)
      .map((signal) => ({ key: signal.key, label: signal.label, tone: signal.tone })),
    fields: row.fields
      .filter((field) => definitions.has(field.key))
      .map((field) => ({
        key: field.key,
        label: definitions.get(field.key)?.label ?? field.key,
        value: field.value,
        confidence: field.confidence,
        status: field.status,
        extractedBy: field.extractedBy,
        agreementCount: field.agreementCount,
      })),
    scoreBreakdown: row.entity.scoreBreakdown?.contributions ?? [],
    updatedAt: row.entity.updatedAt,
  };
}

function renderValue(value: JsonValue | null): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => String(item)).join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}
