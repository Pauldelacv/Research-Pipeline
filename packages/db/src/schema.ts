import type { EntityCandidate } from '@frp/core';
import type {
  EntitySignal,
  ResearchPipelineConfig,
  ScoreBreakdown,
  StepId,
  StepMetrics,
  ValidationIssue,
} from '@frp/schemas';
import type { JsonValue } from '@frp/schemas';
import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * The traceability spine of the system.
 *
 * The chain that matters is:
 *
 *   run -> source -> entity_candidate -> entity -> entity_field -> evidence
 *                                                                     |
 *                                                                     +-> source
 *
 * Every stored value can be walked back to the document it came from and the
 * fragment of that document that justified it. Denormalised projections
 * (`entities.data`, `entities.signals`) exist purely for read performance and
 * are always written from their normalised source of truth.
 *
 * Multi-tenancy: `tenant_id` is carried on every tenant-owned row rather than
 * being reachable only by join, so row-level security can be switched on
 * without a migration. See docs/security.md.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    objective: text('objective').notNull(),
    configKey: text('config_key').notNull(),
    /** Resolved configuration for this project, not a pointer to a template. */
    config: jsonb('config').$type<ResearchPipelineConfig>().notNull(),
    targeting: jsonb('targeting').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('draft'),
    lastRunId: text('last_run_id'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    entityCount: integer('entity_count').notNull().default(0),
    createdBy: text('created_by'),
    ...timestamps,
  },
  (table) => [
    index('projects_tenant_idx').on(table.tenantId, table.createdAt),
    index('projects_status_idx').on(table.status),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull(),
    status: text('status').notNull().default('queued'),
    currentStep: text('current_step').$type<StepId>(),
    trigger: text('trigger').notNull().default('manual'),
    /**
     * The configuration as it was when the run started. Editing a project
     * never rewrites history, so an old run stays explainable.
     */
    configSnapshot: jsonb('config_snapshot').$type<ResearchPipelineConfig>().notNull(),
    targeting: jsonb('targeting').$type<Record<string, unknown>>().notNull().default({}),
    stats: jsonb('stats').$type<Record<string, number>>().notNull().default({}),
    error: text('error'),
    /** Cooperative cancellation: steps poll this between units of work. */
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('runs_project_idx').on(table.projectId, table.createdAt),
    index('runs_status_idx').on(table.status),
    index('runs_tenant_idx').on(table.tenantId),
  ],
);

export const pipelineStepRuns = pgTable(
  'pipeline_step_runs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').$type<StepId>().notNull(),
    status: text('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    metrics: jsonb('metrics').$type<StepMetrics>(),
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    error: jsonb('error').$type<{
      code: string;
      message: string;
      retryable: boolean;
      stack?: string;
    }>(),
    /** Small hand-off between steps (the plan, counts). Never bulk data. */
    output: jsonb('output').$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [uniqueIndex('step_runs_run_step_idx').on(table.runId, table.stepId)],
);

export const sources = pgTable(
  'sources',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    title: text('title'),
    snippet: text('snippet'),
    kind: text('kind').notNull().default('search_result'),
    provider: text('provider').notNull(),
    query: text('query'),
    rank: integer('rank'),
    /**
     * Trust resolved from the pipeline configuration when the source was
     * recorded. Stored rather than recomputed so a historical run keeps the
     * verdict it actually acted on, even after the configuration changes.
     */
    trustScore: real('trust_score').notNull().default(0.5),
    trustCategory: text('trust_category'),
    httpStatus: integer('http_status'),
    contentHash: text('content_hash'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sources_run_url_idx').on(table.runId, table.canonicalUrl),
    index('sources_run_idx').on(table.runId, table.discoveredAt),
  ],
);

export const entityCandidates = pgTable(
  'entity_candidates',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').$type<EntityCandidate['payload']>().notNull(),
    extractedBy: text('extracted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('candidates_run_idx').on(table.runId, table.id)],
);

export const entities = pgTable(
  'entities',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    entityType: text('entity_type').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('new'),
    /** Projection of entity_fields. Never written independently. */
    data: jsonb('data').$type<Record<string, JsonValue | null>>().notNull().default({}),
    confidence: real('confidence').notNull().default(0),
    validationStatus: text('validation_status').notNull().default('pending'),
    validationIssues: jsonb('validation_issues').$type<ValidationIssue[]>().notNull().default([]),
    /** Projection of entity_signals, for rendering the results table. */
    signals: jsonb('signals').$type<EntitySignal[]>().notNull().default([]),
    score: integer('score'),
    scoreBreakdown: jsonb('score_breakdown').$type<ScoreBreakdown>(),
    flaggedFields: jsonb('flagged_fields').$type<string[]>().notNull().default([]),
    sourceCount: integer('source_count').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('entities_run_dedupe_idx').on(table.runId, table.dedupeKey),
    index('entities_run_status_idx').on(table.runId, table.status),
    index('entities_run_score_idx').on(table.runId, table.score),
    index('entities_tenant_idx').on(table.tenantId),
  ],
);

export const entityFields = pgTable(
  'entity_fields',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').$type<JsonValue | null>(),
    confidence: real('confidence').notNull().default(0),
    status: text('status').notNull().default('auto'),
    extractedBy: text('extracted_by'),
    /** Retained on edit so a human correction stays auditable. */
    previousValue: jsonb('previous_value').$type<JsonValue | null>(),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    agreementCount: integer('agreement_count').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('entity_fields_entity_key_idx').on(table.entityId, table.key),
    index('entity_fields_status_idx').on(table.entityId, table.status),
  ],
);

export const evidence = pgTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    entityFieldId: text('entity_field_id').references(() => entityFields.id, {
      onDelete: 'cascade',
    }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    snippet: text('snippet').notNull(),
    locator: text('locator'),
    confidence: real('confidence').notNull().default(0),
    method: text('method').notNull().default('rule'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('evidence_entity_idx').on(table.entityId),
    index('evidence_field_idx').on(table.entityFieldId),
    uniqueIndex('evidence_dedupe_idx').on(table.entityFieldId, table.sourceId, table.snippet),
  ],
);

export const entitySignals = pgTable(
  'entity_signals',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    tone: text('tone').notNull().default('neutral'),
    detected: boolean('detected').notNull().default(false),
    confidence: real('confidence').notNull().default(0),
    rationale: text('rationale'),
    source: text('source').notNull().default('derived'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('entity_signals_entity_key_idx').on(table.entityId, table.key),
    index('entity_signals_run_key_idx').on(table.runId, table.key, table.detected),
  ],
);

/**
 * Append-only score history. The current score lives on `entities` for fast
 * sorting; this table answers "the score changed after review — why?".
 */
export const entityScores = pgTable(
  'entity_scores',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    score: integer('score').notNull(),
    breakdown: jsonb('breakdown').$type<ScoreBreakdown>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('entity_scores_entity_idx').on(table.entityId, table.createdAt)],
);

export const reviews = pgTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    action: text('action').notNull(),
    fieldKey: text('field_key'),
    previousValue: jsonb('previous_value').$type<JsonValue | null>(),
    newValue: jsonb('new_value').$type<JsonValue | null>(),
    note: text('note'),
    reviewer: text('reviewer').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('reviews_entity_idx').on(table.entityId, table.createdAt)],
);

export const exports = pgTable(
  'exports',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    destinationId: text('destination_id').notNull(),
    connector: text('connector').notNull(),
    status: text('status').notNull().default('pending'),
    entityCount: integer('entity_count').notNull().default(0),
    location: text('location'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('exports_run_idx').on(table.runId, table.createdAt)],
);

/**
 * One row per upstream provider call.
 *
 * Append-only and never updated: a run's cost is the sum of what it did, and
 * a row that can be edited is a number nobody can defend. Aggregation happens
 * on read — runs are bounded and the index makes the rollup cheap.
 */
export const providerUsage = pgTable(
  'provider_usage',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').$type<StepId>(),
    provider: text('provider').notNull(),
    providerKind: text('provider_kind').notNull(),
    operation: text('operation').notNull(),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    requests: integer('requests').notNull().default(1),
    /** Nullable on purpose: an unpriced call is not a free call. */
    costUsd: real('cost_usd'),
    costSource: text('cost_source').notNull().default('unknown'),
    latencyMs: integer('latency_ms'),
    outcome: text('outcome').notNull().default('success'),
    errorCode: text('error_code'),
    target: text('target'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('provider_usage_run_idx').on(table.runId, table.createdAt),
    index('provider_usage_run_provider_idx').on(table.runId, table.provider, table.operation),
  ],
);

/**
 * Failures worth showing an operator, at a finer grain than the step row.
 *
 * A step that reports `partial` swallowed something; these are the rows that
 * say what. `detail` holds the sanitised provider response — the single most
 * useful field when debugging a run, redacted before it is written rather
 * than before it is displayed.
 */
export const runFailures = pgTable(
  'run_failures',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').$type<StepId>().notNull(),
    scope: text('scope').notNull().default('step'),
    attempt: integer('attempt').notNull().default(1),
    maxAttempts: integer('max_attempts').notNull().default(1),
    willRetry: boolean('will_retry').notNull().default(false),
    code: text('code').notNull(),
    message: text('message').notNull(),
    retryable: boolean('retryable').notNull().default(false),
    provider: text('provider'),
    operation: text('operation'),
    targetId: text('target_id'),
    targetLabel: text('target_label'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('run_failures_run_idx').on(table.runId, table.createdAt),
    index('run_failures_run_step_idx').on(table.runId, table.stepId),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: text('id').primaryKey(),
    /** Monotonic cursor used to tail the timeline without missing events. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id').$type<StepId>(),
    level: text('level').notNull().default('info'),
    type: text('type').notNull(),
    message: text('message').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('run_events_run_seq_idx').on(table.runId, table.seq),
    index('run_events_level_idx').on(table.runId, table.level),
  ],
);

// --- relations (used by Drizzle's relational query API) -------------------

export const projectRelations = relations(projects, ({ one, many }) => ({
  tenant: one(tenants, { fields: [projects.tenantId], references: [tenants.id] }),
  runs: many(runs),
}));

export const runRelations = relations(runs, ({ one, many }) => ({
  project: one(projects, { fields: [runs.projectId], references: [projects.id] }),
  steps: many(pipelineStepRuns),
  sources: many(sources),
  entities: many(entities),
  events: many(runEvents),
  usage: many(providerUsage),
  failures: many(runFailures),
}));

export const entityRelations = relations(entities, ({ one, many }) => ({
  run: one(runs, { fields: [entities.runId], references: [runs.id] }),
  fields: many(entityFields),
  evidence: many(evidence),
  signals: many(entitySignals),
}));

export const entityFieldRelations = relations(entityFields, ({ one, many }) => ({
  entity: one(entities, { fields: [entityFields.entityId], references: [entities.id] }),
  evidence: many(evidence),
}));

export const evidenceRelations = relations(evidence, ({ one }) => ({
  entity: one(entities, { fields: [evidence.entityId], references: [entities.id] }),
  field: one(entityFields, { fields: [evidence.entityFieldId], references: [entityFields.id] }),
  source: one(sources, { fields: [evidence.sourceId], references: [sources.id] }),
}));

/** Convenience for `count(*)` expressions across the stores. */
export const countAll = sql<number>`count(*)::int`;
