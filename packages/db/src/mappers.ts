import type {
  Entity,
  EntityField,
  ExportRecord,
  PipelineStepRun,
  ResearchProject,
  ResearchRun,
  Review,
  RunEvent,
  Source,
} from '@frp/schemas';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  entities,
  entityFields,
  exports as exportsTable,
  pipelineStepRuns,
  projects,
  reviews,
  runEvents,
  runs,
  sources,
} from './schema.js';

/**
 * Row-to-domain mapping.
 *
 * The API speaks ISO strings, Postgres speaks `Date`. Converting in one place
 * keeps `toISOString()` out of route handlers and guarantees the wire format
 * matches the Zod schemas the web application validates against.
 */

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

const isoRequired = (value: Date): string => value.toISOString();

export function toProject(row: InferSelectModel<typeof projects>): ResearchProject {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    objective: row.objective,
    configKey: row.configKey,
    config: row.config,
    targeting: row.targeting,
    status: row.status as ResearchProject['status'],
    lastRunId: row.lastRunId,
    lastRunAt: iso(row.lastRunAt),
    entityCount: row.entityCount,
    createdBy: row.createdBy,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

const DEFAULT_STATS: ResearchRun['stats'] = {
  sourcesDiscovered: 0,
  entitiesExtracted: 0,
  entitiesStructured: 0,
  entitiesValid: 0,
  entitiesFlagged: 0,
  entitiesApproved: 0,
  entitiesRejected: 0,
  entitiesExported: 0,
  providerErrors: 0,
  retries: 0,
};

export function toRun(row: InferSelectModel<typeof runs>): ResearchRun {
  return {
    id: row.id,
    projectId: row.projectId,
    tenantId: row.tenantId,
    status: row.status as ResearchRun['status'],
    currentStep: row.currentStep,
    trigger: row.trigger as ResearchRun['trigger'],
    configSnapshot: row.configSnapshot,
    targeting: row.targeting,
    stats: { ...DEFAULT_STATS, ...row.stats },
    error: row.error,
    queuedAt: iso(row.queuedAt),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export function toStepRun(row: InferSelectModel<typeof pipelineStepRuns>): PipelineStepRun {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    status: row.status as PipelineStepRun['status'],
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    metrics: row.metrics,
    warnings: row.warnings,
    error: row.error ?? null,
    output: row.output ?? null,
  };
}

export function toSource(row: InferSelectModel<typeof sources>): Source {
  return {
    id: row.id,
    runId: row.runId,
    url: row.url,
    canonicalUrl: row.canonicalUrl,
    title: row.title,
    snippet: row.snippet,
    kind: row.kind as Source['kind'],
    provider: row.provider,
    query: row.query,
    rank: row.rank,
    httpStatus: row.httpStatus,
    contentHash: row.contentHash,
    fetchedAt: iso(row.fetchedAt),
    discoveredAt: isoRequired(row.discoveredAt),
  };
}

export function toEntity(row: InferSelectModel<typeof entities>): Entity {
  return {
    id: row.id,
    runId: row.runId,
    projectId: row.projectId,
    tenantId: row.tenantId,
    entityType: row.entityType,
    dedupeKey: row.dedupeKey,
    displayName: row.displayName,
    status: row.status as Entity['status'],
    data: row.data,
    confidence: row.confidence,
    validationStatus: row.validationStatus as Entity['validationStatus'],
    validationIssues: row.validationIssues,
    signals: row.signals,
    score: row.score,
    scoreBreakdown: row.scoreBreakdown ?? null,
    flaggedFields: row.flaggedFields,
    sourceCount: row.sourceCount,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export function toEntityField(row: InferSelectModel<typeof entityFields>): EntityField {
  return {
    id: row.id,
    entityId: row.entityId,
    key: row.key,
    value: row.value ?? null,
    confidence: row.confidence,
    status: row.status as EntityField['status'],
    extractedBy: row.extractedBy,
    previousValue: row.previousValue ?? null,
    reviewedBy: row.reviewedBy,
    reviewedAt: iso(row.reviewedAt),
    agreementCount: row.agreementCount,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export function toRunEvent(row: InferSelectModel<typeof runEvents>): RunEvent {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId ?? null,
    level: row.level as RunEvent['level'],
    type: row.type,
    message: row.message,
    data: row.data ?? null,
    createdAt: isoRequired(row.createdAt),
  };
}

export function toReview(row: InferSelectModel<typeof reviews>): Review {
  return {
    id: row.id,
    entityId: row.entityId,
    runId: row.runId,
    action: row.action as Review['action'],
    fieldKey: row.fieldKey,
    previousValue: row.previousValue ?? null,
    newValue: row.newValue ?? null,
    note: row.note,
    reviewer: row.reviewer,
    createdAt: isoRequired(row.createdAt),
  };
}

export function toExportRecord(row: InferSelectModel<typeof exportsTable>): ExportRecord {
  return {
    id: row.id,
    runId: row.runId,
    destinationId: row.destinationId,
    connector: row.connector,
    status: row.status as ExportRecord['status'],
    entityCount: row.entityCount,
    location: row.location,
    error: row.error,
    createdAt: isoRequired(row.createdAt),
    finishedAt: iso(row.finishedAt),
  };
}
