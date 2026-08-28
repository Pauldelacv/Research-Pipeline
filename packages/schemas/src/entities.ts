import { z } from 'zod';
import { confidenceSchema, jsonValueSchema } from './primitives.js';

/**
 * Traceability model.
 *
 * `Source` — something we looked at (a search result, a fetched page, an API
 * response). `Evidence` — the specific fragment of a source that justifies one
 * field value. `EntityField` — one attribute of one entity, with its own
 * confidence and review state. `Entity` — the merged record.
 *
 * The chain entity → field → evidence → source is what lets an operator answer
 * "where did this number come from?" for every cell in the results table.
 */

export const sourceKindSchema = z.enum(['search_result', 'page', 'api', 'dataset', 'manual']);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceSchema = z.object({
  id: z.string(),
  runId: z.string(),
  url: z.string(),
  canonicalUrl: z.string(),
  title: z.string().nullable(),
  snippet: z.string().nullable(),
  kind: sourceKindSchema,
  /** Which provider surfaced this source. */
  provider: z.string(),
  /** Which planned query surfaced it — useful when a query goes off-target. */
  query: z.string().nullable(),
  rank: z.number().int().nullable(),
  httpStatus: z.number().int().nullable(),
  contentHash: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  discoveredAt: z.string(),
});

export type Source = z.infer<typeof sourceSchema>;

export const evidenceSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  entityFieldId: z.string().nullable(),
  sourceId: z.string(),
  /** The literal text supporting the value. Kept short and quotable. */
  snippet: z.string(),
  /** Where in the source the snippet came from (selector, offset, JSON path). */
  locator: z.string().nullable(),
  confidence: confidenceSchema,
  /** How the value was derived from the snippet. */
  method: z.enum(['llm', 'rule', 'api', 'manual']),
  createdAt: z.string(),
});

export type Evidence = z.infer<typeof evidenceSchema>;

export const fieldStatusSchema = z.enum([
  /** Written by the pipeline, above the confidence threshold. */
  'auto',
  /** Below threshold or failing a validation rule — needs a human. */
  'flagged',
  'approved',
  'edited',
  'rejected',
]);
export type FieldStatus = z.infer<typeof fieldStatusSchema>;

export const entityFieldSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  key: z.string(),
  value: jsonValueSchema.nullable(),
  confidence: confidenceSchema,
  status: fieldStatusSchema,
  /** Provider id that produced the value, e.g. `mock`, `bright-data`. */
  extractedBy: z.string().nullable(),
  /** Retained when an operator edits a value, so the change is auditable. */
  previousValue: jsonValueSchema.nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  /** Number of independent sources that agreed on this value. */
  agreementCount: z.number().int().min(0).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type EntityField = z.infer<typeof entityFieldSchema>;

export const entitySignalSchema = z.object({
  key: z.string(),
  label: z.string(),
  tone: z.enum(['positive', 'neutral', 'negative']),
  detected: z.boolean(),
  confidence: confidenceSchema,
  /** Why the signal fired — the rendered condition trace or provider note. */
  rationale: z.string().nullable(),
  source: z.enum(['extracted', 'derived']),
});

export type EntitySignal = z.infer<typeof entitySignalSchema>;

export const validationIssueSchema = z.object({
  ruleId: z.string(),
  label: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  field: z.string().nullable(),
});

export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const scoreContributionSchema = z.object({
  ruleId: z.string(),
  label: z.string(),
  matched: z.boolean(),
  /** Points actually awarded (may be negative). */
  points: z.number(),
  /** Points that were available for this rule. */
  maxPoints: z.number(),
  /** Rendered explanation of the underlying condition. */
  explanation: z.string(),
});

export type ScoreContribution = z.infer<typeof scoreContributionSchema>;

export const scoreBreakdownSchema = z.object({
  /** Normalised onto the configured scale (default 0–100). */
  total: z.number(),
  maxScore: z.number(),
  rawPoints: z.number(),
  maxPoints: z.number(),
  band: z.enum(['qualified', 'review', 'rejected']),
  contributions: z.array(scoreContributionSchema),
  scoredAt: z.string(),
});

export type ScoreBreakdown = z.infer<typeof scoreBreakdownSchema>;

export const entityStatusSchema = z.enum([
  'new',
  'needs_review',
  'approved',
  'rejected',
  'exported',
]);
export type EntityStatus = z.infer<typeof entityStatusSchema>;

export const entitySchema = z.object({
  id: z.string(),
  runId: z.string(),
  projectId: z.string(),
  tenantId: z.string(),
  entityType: z.string(),
  dedupeKey: z.string(),
  displayName: z.string(),
  status: entityStatusSchema,
  /**
   * Denormalised projection of `entity_fields`, kept in sync by the entity
   * store. Reads for the results table hit this; provenance questions hit the
   * field rows. The projection is never written independently.
   */
  data: z.record(z.string(), jsonValueSchema.nullable()),
  /** Mean confidence across required fields. */
  confidence: confidenceSchema,
  validationStatus: z.enum(['pending', 'valid', 'invalid', 'flagged']),
  validationIssues: z.array(validationIssueSchema).default([]),
  signals: z.array(entitySignalSchema).default([]),
  score: z.number().nullable(),
  scoreBreakdown: scoreBreakdownSchema.nullable(),
  /** Field keys currently awaiting a human decision. */
  flaggedFields: z.array(z.string()).default([]),
  sourceCount: z.number().int().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Entity = z.infer<typeof entitySchema>;

export const reviewActionSchema = z.enum(['approve', 'reject', 'edit', 'reprocess']);
export type ReviewAction = z.infer<typeof reviewActionSchema>;

export const reviewSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  runId: z.string(),
  action: reviewActionSchema,
  /** Null for entity-level decisions, set for field-level edits. */
  fieldKey: z.string().nullable(),
  previousValue: jsonValueSchema.nullable(),
  newValue: jsonValueSchema.nullable(),
  note: z.string().nullable(),
  reviewer: z.string(),
  createdAt: z.string(),
});

export type Review = z.infer<typeof reviewSchema>;

export const exportRecordSchema = z.object({
  id: z.string(),
  runId: z.string(),
  destinationId: z.string(),
  connector: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  entityCount: z.number().int(),
  /** Path, URL or external id produced by the connector. */
  location: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type ExportRecord = z.infer<typeof exportRecordSchema>;
