import type {
  Entity,
  EntityField,
  EntityStatus,
  ExportRecord,
  Paginated,
  PipelineStepRun,
  ProviderUsage,
  ResearchPipelineConfig,
  ResearchProject,
  ResearchRun,
  Review,
  RunEvent,
  RunFailure,
  RunUsageSummary,
  Source,
  UsageBreakdownRow,
  UsageTotals,
} from '@frp/schemas';
import { PIPELINE_STEP_ORDER } from '@frp/schemas';
import { ConnectorRegistry } from '../src/ports/connectors.js';
import type {
  CandidateStore,
  EntityCandidate,
  EntityStore,
  EntityWithFields,
  EntityWrite,
  EventStore,
  ExportStore,
  FailureStore,
  ProjectStore,
  ReviewStore,
  RunPublisher,
  RunStore,
  SourceStore,
  SourceWrite,
  StoreBundle,
  UsageStore,
  UsageWrite,
} from '../src/ports/stores.js';
import { nullLogger } from '../src/logger.js';
import { newId } from '../src/ids.js';

/**
 * In-memory implementations of every store port.
 *
 * These exist to prove the boundary is real: the whole pipeline runs against
 * them with no database, no Redis and no network, in milliseconds. If a step
 * ever reached for Postgres directly, these tests would stop compiling.
 */
export function createMemoryStores(): StoreBundle & { snapshot(): MemoryState } {
  const state: MemoryState = {
    runs: new Map(),
    projects: new Map(),
    stepRuns: new Map(),
    sources: new Map(),
    candidates: new Map(),
    entities: new Map(),
    fields: new Map(),
    events: [],
    reviews: [],
    exports: [],
    usage: [],
    failures: [],
  };

  const runs: RunStore = {
    async get(runId) {
      return state.runs.get(runId) ?? null;
    },
    async setStatus(runId, status, patch = {}) {
      const run = state.runs.get(runId);
      if (!run) return;
      run.status = status;
      if (patch.currentStep !== undefined) run.currentStep = patch.currentStep;
      if (patch.error !== undefined) run.error = patch.error;
      if (patch.finishedAt !== undefined) run.finishedAt = patch.finishedAt.toISOString();
      if (status === 'running' && !run.startedAt) run.startedAt = new Date().toISOString();
    },
    async incrementStats(runId, deltas) {
      const run = state.runs.get(runId);
      if (!run) return;
      for (const [key, value] of Object.entries(deltas)) {
        if (typeof value !== 'number') continue;
        const stats = run.stats as Record<string, number>;
        stats[key] = (stats[key] ?? 0) + value;
      }
    },
    async isCancelled(runId) {
      return state.cancelled === runId;
    },
    async getStepRun(runId, stepId) {
      return state.stepRuns.get(`${runId}:${stepId}`) ?? null;
    },
    async listStepRuns(runId) {
      return PIPELINE_STEP_ORDER.map((stepId) => state.stepRuns.get(`${runId}:${stepId}`)).filter(
        (step): step is PipelineStepRun => Boolean(step),
      );
    },
    async startStepRun(runId, stepId, patch) {
      const key = `${runId}:${stepId}`;
      const existing = state.stepRuns.get(key);
      const step: PipelineStepRun = {
        id: existing?.id ?? newId('stp'),
        runId,
        stepId,
        status: 'running',
        attempt: patch.attempt,
        maxAttempts: patch.maxAttempts,
        startedAt: existing?.startedAt ?? new Date().toISOString(),
        finishedAt: null,
        metrics: existing?.metrics ?? null,
        warnings: [],
        error: null,
        output: existing?.output ?? null,
      };
      state.stepRuns.set(key, step);
      return step;
    },
    async finishStepRun(runId, stepId, patch) {
      const key = `${runId}:${stepId}`;
      const existing = state.stepRuns.get(key);
      if (!existing) throw new Error(`step ${stepId} not started`);
      const step: PipelineStepRun = {
        ...existing,
        status: patch.status,
        metrics: patch.metrics ?? existing.metrics,
        warnings: patch.warnings ?? [],
        error: patch.error ?? null,
        output: patch.output === undefined ? existing.output : patch.output,
        finishedAt: patch.status === 'running' ? null : new Date().toISOString(),
      };
      state.stepRuns.set(key, step);
      return step;
    },
  };

  const projects: ProjectStore = {
    async get(projectId) {
      return state.projects.get(projectId) ?? null;
    },
    async updateAfterRun(projectId, patch) {
      const project = state.projects.get(projectId);
      if (!project) return;
      project.status = patch.status;
      project.lastRunId = patch.lastRunId;
      project.entityCount = patch.entityCount;
    },
  };

  const sources: SourceStore = {
    async upsertMany(items: SourceWrite[]) {
      let inserted = 0;
      for (const item of items) {
        if (state.sources.has(item.id)) continue;
        const { trust, ...rest } = item;
        state.sources.set(item.id, {
          ...rest,
          trustScore: trust.score,
          trustCategory: trust.categoryId,
          httpStatus: null,
          contentHash: null,
          fetchedAt: null,
          discoveredAt: new Date().toISOString(),
        });
        inserted += 1;
      }
      return { inserted, skipped: items.length - inserted };
    },
    async listByRun(runId, options = {}) {
      return [...state.sources.values()]
        .filter((source) => source.runId === runId)
        .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 500));
    },
    async countByRun(runId) {
      return [...state.sources.values()].filter((source) => source.runId === runId).length;
    },
    async markFetched() {},
  };

  const candidates: CandidateStore = {
    async upsertMany(items) {
      for (const item of items) {
        state.candidates.set(item.id, { ...item, createdAt: new Date().toISOString() });
      }
      return items.length;
    },
    async *iterate(runId) {
      for (const candidate of state.candidates.values()) {
        if (candidate.runId === runId) yield candidate;
      }
    },
    async countByRun(runId) {
      return [...state.candidates.values()].filter((c) => c.runId === runId).length;
    },
    async deleteByRun(runId) {
      let removed = 0;
      for (const [key, candidate] of state.candidates) {
        if (candidate.runId === runId) {
          state.candidates.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };

  const entities: EntityStore = {
    async findByDedupeKey(runId, dedupeKey) {
      for (const entity of state.entities.values()) {
        if (entity.runId === runId && entity.dedupeKey === dedupeKey) {
          return { entity, fields: state.fields.get(entity.id) ?? [] };
        }
      }
      return null;
    },
    async save(input: EntityWrite) {
      const now = new Date().toISOString();
      const existing = state.entities.get(input.id);
      const entity: Entity = {
        ...input,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.entities.set(entity.id, entity);
      state.fields.set(
        entity.id,
        input.fields.map((field) => ({
          id: `${entity.id}:${field.key}`,
          entityId: entity.id,
          key: field.key,
          value: field.value,
          confidence: field.confidence,
          status: field.status,
          extractedBy: field.extractedBy,
          previousValue: null,
          reviewedBy: null,
          reviewedAt: null,
          agreementCount: field.agreementCount,
          createdAt: now,
          updatedAt: now,
        })),
      );
      return entity;
    },
    async get(entityId) {
      const entity = state.entities.get(entityId);
      if (!entity) return null;
      return { entity, fields: state.fields.get(entityId) ?? [] };
    },
    async list(runId): Promise<Paginated<Entity>> {
      const items = [...state.entities.values()].filter((entity) => entity.runId === runId);
      return { items, total: items.length, limit: items.length, offset: 0 };
    },
    async *iterate(runId): AsyncIterable<EntityWithFields> {
      for (const entity of state.entities.values()) {
        if (entity.runId !== runId) continue;
        yield { entity, fields: state.fields.get(entity.id) ?? [] };
      }
    },
    async countByRun(runId) {
      return [...state.entities.values()].filter((entity) => entity.runId === runId).length;
    },
    async countsByStatus(runId) {
      const counts: Record<EntityStatus, number> = {
        new: 0,
        needs_review: 0,
        approved: 0,
        rejected: 0,
        exported: 0,
      };
      for (const entity of state.entities.values()) {
        if (entity.runId === runId) counts[entity.status] += 1;
      }
      return counts;
    },
    async setValidation(entityId, patch) {
      const entity = state.entities.get(entityId);
      if (!entity) return;
      Object.assign(entity, patch);
    },
    async setScore(entityId, score, breakdown) {
      const entity = state.entities.get(entityId);
      if (!entity) return;
      entity.score = score;
      entity.scoreBreakdown = breakdown;
    },
    async setSignals(entityId, signals) {
      const entity = state.entities.get(entityId);
      if (!entity) return;
      entity.signals = signals;
    },
    async setStatus(entityIds, status) {
      let updated = 0;
      for (const id of entityIds) {
        const entity = state.entities.get(id);
        if (!entity) continue;
        entity.status = status;
        updated += 1;
      }
      return updated;
    },
    async updateField(entityId, key, patch) {
      const fields = state.fields.get(entityId) ?? [];
      const now = new Date().toISOString();
      let field = fields.find((item) => item.key === key);
      if (!field) {
        field = {
          id: `${entityId}:${key}`,
          entityId,
          key,
          value: null,
          confidence: 0,
          status: 'auto',
          extractedBy: null,
          previousValue: null,
          reviewedBy: null,
          reviewedAt: null,
          agreementCount: 1,
          createdAt: now,
          updatedAt: now,
        };
        fields.push(field);
        state.fields.set(entityId, fields);
      }
      if (patch.value !== undefined) {
        field.previousValue = field.value;
        field.value = patch.value;
        const entity = state.entities.get(entityId);
        if (entity) entity.data = { ...entity.data, [key]: patch.value };
      }
      if (patch.confidence !== undefined) field.confidence = patch.confidence;
      if (patch.status !== undefined) field.status = patch.status;
      if (patch.extractedBy !== undefined) field.extractedBy = patch.extractedBy;
      if (patch.reviewedBy !== undefined) field.reviewedBy = patch.reviewedBy;
      return field;
    },
    async listEvidence() {
      return [];
    },
    async countPendingReview(runId) {
      return [...state.entities.values()].filter(
        (entity) => entity.runId === runId && entity.status === 'needs_review',
      ).length;
    },
  };

  const events: EventStore = {
    async append(event) {
      const record: RunEvent = {
        id: newId('evt'),
        runId: event.runId,
        stepId: event.stepId,
        level: event.level,
        type: event.type,
        message: event.message,
        data: event.data ?? null,
        createdAt: new Date().toISOString(),
      };
      state.events.push(record);
      return record;
    },
    async list(runId, options) {
      return state.events.filter((event) => event.runId === runId).slice(0, options.limit);
    },
  };

  const reviews: ReviewStore = {
    async record(review) {
      const record: Review = { ...review, id: newId('rev'), createdAt: new Date().toISOString() };
      state.reviews.push(record);
      return record;
    },
    async listByEntity(entityId) {
      return state.reviews.filter((review) => review.entityId === entityId);
    },
  };

  const exports: ExportStore = {
    async create(record) {
      const created: ExportRecord = {
        ...record,
        id: newId('exp'),
        createdAt: new Date().toISOString(),
        finishedAt: null,
      };
      state.exports.push(created);
      return created;
    },
    async finish(id, patch) {
      const record = state.exports.find((item) => item.id === id);
      if (!record) throw new Error('export not found');
      Object.assign(record, patch, { finishedAt: new Date().toISOString() });
      return record;
    },
    async listByRun(runId) {
      return state.exports.filter((record) => record.runId === runId);
    },
  };

  const usage: UsageStore = {
    async recordMany(entries: UsageWrite[]) {
      for (const entry of entries) {
        state.usage.push({
          ...entry,
          id: newId('usg'),
          createdAt: new Date().toISOString(),
        });
      }
      return entries.length;
    },
    async listByRun(runId) {
      return state.usage.filter((row) => row.runId === runId);
    },
    async summarise(runId): Promise<RunUsageSummary> {
      const rows = state.usage.filter((row) => row.runId === runId);
      const group = (key: (row: ProviderUsage) => string): UsageBreakdownRow[] => {
        const buckets = new Map<string, UsageBreakdownRow>();
        for (const row of rows) {
          const id = key(row);
          const bucket = buckets.get(id) ?? {
            provider: row.provider,
            providerKind: row.providerKind,
            operation: row.operation,
            model: row.model,
            stepId: row.stepId,
            ...emptyTotals(),
          };
          bucket.requests += row.requests;
          bucket.failures += row.outcome === 'failure' ? 1 : 0;
          bucket.inputTokens += row.inputTokens ?? 0;
          bucket.outputTokens += row.outputTokens ?? 0;
          bucket.costUsd += row.costUsd ?? 0;
          bucket.latencyMs += row.latencyMs ?? 0;
          bucket.partialCost ||= row.costUsd === null;
          buckets.set(id, bucket);
        }
        return [...buckets.values()];
      };

      const byProvider = group((row) => `${row.provider}|${row.operation}|${row.model ?? ''}`);
      const totals = byProvider.reduce<UsageTotals>((acc, row) => {
        acc.requests += row.requests;
        acc.failures += row.failures;
        acc.inputTokens += row.inputTokens;
        acc.outputTokens += row.outputTokens;
        acc.costUsd += row.costUsd;
        acc.latencyMs += row.latencyMs;
        acc.partialCost ||= row.partialCost;
        return acc;
      }, emptyTotals());

      return { runId, totals, byProvider, byStep: group((row) => row.stepId ?? 'none') };
    },
  };

  const failures: FailureStore = {
    async record(failure) {
      const record: RunFailure = {
        ...failure,
        id: newId('fail'),
        createdAt: new Date().toISOString(),
      };
      state.failures.push(record);
      return record;
    },
    async listByRun(runId) {
      return state.failures.filter((failure) => failure.runId === runId);
    },
    async countByRun(runId) {
      return state.failures.filter((failure) => failure.runId === runId).length;
    },
  };

  return {
    projects,
    runs,
    sources,
    candidates,
    entities,
    events,
    reviews,
    exports,
    usage,
    failures,
    snapshot: () => state,
  };
}

export interface MemoryState {
  runs: Map<string, ResearchRun>;
  projects: Map<string, ResearchProject>;
  stepRuns: Map<string, PipelineStepRun>;
  sources: Map<string, Source>;
  candidates: Map<string, EntityCandidate>;
  entities: Map<string, Entity>;
  fields: Map<string, EntityField[]>;
  events: RunEvent[];
  reviews: Review[];
  exports: ExportRecord[];
  usage: ProviderUsage[];
  failures: RunFailure[];
  cancelled?: string;
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    partialCost: false,
  };
}

export const recordingPublisher = (): RunPublisher & { messages: unknown[] } => {
  const messages: unknown[] = [];
  return {
    messages,
    async publish(_runId, message) {
      messages.push(message);
    },
  };
};

export function seedRun(
  stores: StoreBundle & { snapshot(): MemoryState },
  config: ResearchPipelineConfig,
  targeting: Record<string, unknown> = {},
): { runId: string; projectId: string; tenantId: string } {
  const state = stores.snapshot();
  const tenantId = 'ten_test';
  const projectId = 'prj_test';
  const runId = 'run_test';
  const now = new Date().toISOString();

  state.projects.set(projectId, {
    id: projectId,
    tenantId,
    name: 'Test project',
    objective: 'Test objective',
    configKey: config.key,
    config,
    targeting,
    status: 'queued',
    lastRunId: null,
    lastRunAt: null,
    entityCount: 0,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  });

  state.runs.set(runId, {
    id: runId,
    projectId,
    tenantId,
    status: 'queued',
    currentStep: null,
    trigger: 'manual',
    configSnapshot: config,
    targeting,
    stats: {
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
    },
    error: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  return { runId, projectId, tenantId };
}

export const testLogger = nullLogger;
export const emptyConnectors = () => new ConnectorRegistry();

export type { StoreBundle };
