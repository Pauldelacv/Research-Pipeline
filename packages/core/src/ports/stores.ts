import type {
  Entity,
  EntityField,
  EntitySignal,
  EntityStatus,
  Evidence,
  ExportRecord,
  FailureScope,
  FieldStatus,
  JsonValue,
  Paginated,
  PipelineStepRun,
  ProviderUsage,
  ResearchProject,
  ResearchRun,
  Review,
  RunEvent,
  RunEventLevel,
  RunFailure,
  RunUsageSummary,
  ScoreBreakdown,
  Source,
  SourceKind,
  SourceTrust,
  StepId,
  StepMetrics,
  StepStatus,
  ValidationIssue,
} from '@frp/schemas';

/**
 * Persistence ports.
 *
 * The engine depends on these interfaces, never on Drizzle or Postgres. That
 * boundary is what lets the whole pipeline run against in-memory stores in a
 * unit test in milliseconds, and what would let a deployment swap the
 * datastore without touching a single step.
 */

export interface ProjectStore {
  get(projectId: string): Promise<ResearchProject | null>;
  updateAfterRun(
    projectId: string,
    patch: { status: ResearchRun['status']; lastRunId: string; entityCount: number },
  ): Promise<void>;
}

export interface RunStore {
  get(runId: string): Promise<ResearchRun | null>;
  setStatus(
    runId: string,
    status: ResearchRun['status'],
    patch?: { currentStep?: StepId | null; error?: string | null; finishedAt?: Date },
  ): Promise<void>;
  /** Atomic counter bump, so concurrent step attempts do not clobber stats. */
  incrementStats(runId: string, deltas: Partial<ResearchRun['stats']>): Promise<void>;
  isCancelled(runId: string): Promise<boolean>;

  getStepRun(runId: string, stepId: StepId): Promise<PipelineStepRun | null>;
  listStepRuns(runId: string): Promise<PipelineStepRun[]>;
  startStepRun(
    runId: string,
    stepId: StepId,
    patch: { attempt: number; maxAttempts: number },
  ): Promise<PipelineStepRun>;
  finishStepRun(
    runId: string,
    stepId: StepId,
    patch: {
      status: StepStatus;
      metrics?: StepMetrics;
      warnings?: string[];
      error?: PipelineStepRun['error'];
      output?: Record<string, unknown> | null;
    },
  ): Promise<PipelineStepRun>;
}

export interface SourceWrite {
  id: string;
  runId: string;
  url: string;
  canonicalUrl: string;
  title: string | null;
  snippet: string | null;
  kind: SourceKind;
  provider: string;
  query: string | null;
  rank: number | null;
  /** Resolved when the source is recorded; see `trust.ts`. */
  trust: SourceTrust;
}

export interface SourceStore {
  /** Idempotent: sources are keyed by their deterministic id. */
  upsertMany(sources: SourceWrite[]): Promise<{ inserted: number; skipped: number }>;
  listByRun(runId: string, options?: { limit?: number; offset?: number }): Promise<Source[]>;
  countByRun(runId: string): Promise<number>;
  markFetched(
    id: string,
    patch: { httpStatus: number | null; contentHash: string | null },
  ): Promise<void>;
}

export interface EvidenceWrite {
  sourceId: string;
  snippet: string;
  locator: string | null;
  confidence: number;
  method: Evidence['method'];
}

export interface EntityFieldWrite {
  key: string;
  value: JsonValue | null;
  confidence: number;
  status: FieldStatus;
  extractedBy: string | null;
  agreementCount: number;
  evidence: EvidenceWrite[];
}

export interface EntityWrite {
  id: string;
  runId: string;
  projectId: string;
  tenantId: string;
  entityType: string;
  dedupeKey: string;
  displayName: string;
  status: EntityStatus;
  data: Record<string, JsonValue | null>;
  confidence: number;
  validationStatus: Entity['validationStatus'];
  validationIssues: ValidationIssue[];
  signals: EntitySignal[];
  score: number | null;
  scoreBreakdown: ScoreBreakdown | null;
  flaggedFields: string[];
  sourceCount: number;
  fields: EntityFieldWrite[];
}

export interface EntityWithFields {
  entity: Entity;
  fields: EntityField[];
}

export interface EntityListQuery {
  q?: string;
  status?: EntityStatus[];
  minScore?: number;
  maxScore?: number;
  signal?: string;
  flaggedOnly?: boolean;
  sort?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface EntityStore {
  findByDedupeKey(runId: string, dedupeKey: string): Promise<EntityWithFields | null>;
  /** Upserts the entity, its fields and their evidence in one transaction. */
  save(entity: EntityWrite): Promise<Entity>;
  get(entityId: string): Promise<EntityWithFields | null>;
  list(runId: string, query: EntityListQuery): Promise<Paginated<Entity>>;
  /** Streams every entity of a run in id order, for the score/export steps. */
  iterate(runId: string, batchSize?: number): AsyncIterable<EntityWithFields>;
  countByRun(runId: string): Promise<number>;
  countsByStatus(runId: string): Promise<Record<EntityStatus, number>>;

  setValidation(
    entityId: string,
    patch: {
      validationStatus: Entity['validationStatus'];
      validationIssues: ValidationIssue[];
      flaggedFields: string[];
      status: EntityStatus;
      confidence: number;
    },
  ): Promise<void>;
  setScore(entityId: string, score: number, breakdown: ScoreBreakdown): Promise<void>;
  setSignals(entityId: string, signals: EntitySignal[]): Promise<void>;
  setStatus(entityIds: string[], status: EntityStatus): Promise<number>;

  /** Field-level write used by human review and by the enrichment step. */
  updateField(
    entityId: string,
    key: string,
    patch: {
      value?: JsonValue | null;
      confidence?: number;
      status?: FieldStatus;
      extractedBy?: string | null;
      reviewedBy?: string | null;
      evidence?: EvidenceWrite[];
    },
  ): Promise<EntityField>;

  listEvidence(entityId: string): Promise<Array<Evidence & { source: Source | null }>>;
  /** Entities still holding at least one flagged field. */
  countPendingReview(runId: string): Promise<number>;
}

export interface EventStore {
  append(event: {
    runId: string;
    stepId: StepId | null;
    level: RunEventLevel;
    type: string;
    message: string;
    data?: Record<string, unknown> | null;
  }): Promise<RunEvent>;
  list(
    runId: string,
    options: { after?: string; limit: number; level?: RunEventLevel },
  ): Promise<RunEvent[]>;
}

export interface ReviewStore {
  record(review: Omit<Review, 'id' | 'createdAt'>): Promise<Review>;
  listByEntity(entityId: string): Promise<Review[]>;
}

export interface ExportStore {
  create(record: Omit<ExportRecord, 'id' | 'createdAt' | 'finishedAt'>): Promise<ExportRecord>;
  finish(
    id: string,
    patch: {
      status: ExportRecord['status'];
      location?: string | null;
      error?: string | null;
      entityCount?: number;
    },
  ): Promise<ExportRecord>;
  listByRun(runId: string): Promise<ExportRecord[]>;
}

/**
 * Per-call provider accounting.
 *
 * Written in batches at the end of a step attempt rather than inline: a
 * provider call should not pay a database round-trip to be counted, and a
 * failed step must still leave behind what it spent before failing.
 */
export interface UsageWrite {
  runId: string;
  stepId: StepId | null;
  provider: string;
  providerKind: string;
  operation: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  requests: number;
  costUsd: number | null;
  costSource: ProviderUsage['costSource'];
  latencyMs: number | null;
  outcome: ProviderUsage['outcome'];
  errorCode: string | null;
  target: string | null;
}

export interface UsageStore {
  recordMany(entries: UsageWrite[]): Promise<number>;
  listByRun(runId: string, options?: { limit?: number; offset?: number }): Promise<ProviderUsage[]>;
  /** Run-level rollup: totals plus per-provider and per-step breakdowns. */
  summarise(runId: string): Promise<RunUsageSummary>;
}

export interface FailureWrite {
  runId: string;
  stepId: StepId;
  scope: FailureScope;
  attempt: number;
  maxAttempts: number;
  willRetry: boolean;
  code: string;
  message: string;
  retryable: boolean;
  provider: string | null;
  operation: string | null;
  targetId: string | null;
  targetLabel: string | null;
  /** Already sanitised by the caller — see `redact.ts`. */
  detail: Record<string, unknown> | null;
}

export interface FailureStore {
  record(failure: FailureWrite): Promise<RunFailure>;
  listByRun(runId: string, options?: { limit?: number; offset?: number }): Promise<RunFailure[]>;
  countByRun(runId: string): Promise<number>;
}

export interface StoreBundle {
  projects: ProjectStore;
  runs: RunStore;
  sources: SourceStore;
  candidates: CandidateStore;
  entities: EntityStore;
  events: EventStore;
  reviews: ReviewStore;
  exports: ExportStore;
  usage: UsageStore;
  failures: FailureStore;
}

/**
 * Fan-out port for live run updates. Redis-backed in the deployed system,
 * a no-op in tests. The API subscribes and re-emits over SSE.
 */
export interface RunPublisher {
  publish(runId: string, message: unknown): Promise<void>;
}

export const noopPublisher: RunPublisher = {
  publish: async () => {},
};

/**
 * Staging area between `extract` and `structure`.
 *
 * The extract step writes one candidate per (source, entity) pair; the
 * structure step reads them all and merges. Keeping candidates in their own
 * table rather than in the step's output column means extraction stays
 * resumable over large runs, and a bad merge can be re-run without re-paying
 * for extraction.
 */
export interface EntityCandidate {
  id: string;
  runId: string;
  sourceId: string;
  /** Coerced field values with per-field confidence and evidence. */
  payload: {
    fields: Array<{
      key: string;
      value: JsonValue | null;
      /** Provider confidence *after* the source's trust weighting. */
      confidence: number;
      evidence: {
        snippet: string;
        locator: string | null;
        method: Evidence['method'];
        /** Raw provider confidence, before trust. Provenance, not a score. */
        confidence?: number;
      };
    }>;
    signals: Array<{ key: string; detected: boolean; confidence: number; rationale: string }>;
    /** Trust actually applied, including any self-reported override. */
    sourceTrust?: { score: number; categoryId: string | null };
  };
  extractedBy: string;
  createdAt: string;
}

export interface CandidateStore {
  /** Idempotent on the deterministic candidate id. */
  upsertMany(candidates: Array<Omit<EntityCandidate, 'createdAt'>>): Promise<number>;
  iterate(runId: string, batchSize?: number): AsyncIterable<EntityCandidate>;
  countByRun(runId: string): Promise<number>;
  deleteByRun(runId: string): Promise<number>;
}
