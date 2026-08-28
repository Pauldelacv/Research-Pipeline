import type {
  Entity,
  EntityField,
  EntityStatus,
  Evidence,
  ExportRecord,
  FieldDefinition,
  Paginated,
  PipelineStepRun,
  ResearchPipelineConfig,
  ResearchProject,
  ResearchRun,
  Review,
  RunEvent,
  ScoringRuleDefinition,
  SignalDefinition,
  Source,
  TargetingFieldDefinition,
} from '@frp/schemas';

/**
 * Typed API client.
 *
 * The domain types are imported from `@frp/schemas` — the same definitions the
 * API and the pipeline engine use — so a change to the wire contract surfaces
 * as a type error here rather than as an undefined at runtime.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `request failed with ${response.status}`,
      error?.details,
    );
  }

  return payload as T;
}

// --- catalogue ------------------------------------------------------------

export interface PipelineSummary {
  key: string;
  name: string;
  description: string | null;
  version: string;
  entity: ResearchPipelineConfig['entity'];
  targeting: { fields: TargetingFieldDefinition[] };
  fields: FieldDefinition[];
  signals: SignalDefinition[];
  scoring: {
    rules: ScoringRuleDefinition[];
    maxScore: number;
    thresholds: { qualified: number; review: number };
  };
  review: ResearchPipelineConfig['review'];
  discovery: ResearchPipelineConfig['discovery'];
  destinations: Array<{ id: string; label: string; connector: string; enabled: boolean }>;
}

export interface ProviderInfo {
  id: string;
  kind: 'research' | 'search' | 'extraction' | 'enrichment';
  label: string;
  description: string;
  requiresCredentials: boolean;
  health: { ok: boolean; detail: string };
}

export interface ConnectorInfo {
  id: string;
  label: string;
  description: string;
  requiresCredentials: boolean;
  options: Array<{ key: string; description: string; required: boolean }>;
}

export interface Metrics {
  projects: number;
  runsTotal: number;
  runsFailed: number;
  runsRunning: number;
  entities: number;
  successRate: number;
  medianDurationMs: number | null;
  queue: Record<string, number>;
}

// --- runs -----------------------------------------------------------------

export interface RunDetail {
  run: ResearchRun;
  project: ResearchProject | null;
  steps: PipelineStepRun[];
  exports: ExportRecord[];
  entityCounts: Record<EntityStatus, number>;
  pendingReview: number;
}

export interface EntityDetail {
  entity: Entity;
  fields: EntityField[];
  evidence: Array<Evidence & { source: Source | null }>;
  reviews: Review[];
  config: ResearchPipelineConfig | null;
}

export interface EntityFilters {
  q?: string;
  status?: EntityStatus[];
  minScore?: number;
  signal?: string;
  flaggedOnly?: boolean;
  sort?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export const api = {
  pipelines: () => request<{ items: PipelineSummary[] }>('/v1/pipelines'),
  providers: () =>
    request<{ items: ProviderInfo[]; defaults: Record<string, string> }>('/v1/providers'),
  connectors: () => request<{ items: ConnectorInfo[] }>('/v1/connectors'),
  metrics: () => request<Metrics>('/v1/metrics'),

  projects: (limit = 50) => request<Paginated<ResearchProject>>(`/v1/projects?limit=${limit}`),
  project: (id: string) =>
    request<{ project: ResearchProject; lastRun: ResearchRun | null }>(`/v1/projects/${id}`),
  createProject: (body: unknown) =>
    request<{ project: ResearchProject; run: ResearchRun | null }>('/v1/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteProject: (id: string) => request<void>(`/v1/projects/${id}`, { method: 'DELETE' }),
  startRun: (projectId: string) =>
    request<{ run: ResearchRun }>(`/v1/projects/${projectId}/runs`, { method: 'POST' }),

  runs: (limit = 25) => request<Paginated<ResearchRun>>(`/v1/runs?limit=${limit}`),
  run: (id: string) => request<RunDetail>(`/v1/runs/${id}`),
  runEvents: (id: string, after?: string) =>
    request<{ events: RunEvent[] }>(
      `/v1/runs/${id}/events?limit=300${after ? `&after=${after}` : ''}`,
    ),
  runSources: (id: string, limit = 100) =>
    request<{ items: Source[]; total: number }>(`/v1/runs/${id}/sources?limit=${limit}`),
  cancelRun: (id: string) => request<{ ok: boolean }>(`/v1/runs/${id}/cancel`, { method: 'POST' }),
  resumeRun: (id: string, force = false) =>
    request<{ ok: boolean; enqueued: boolean; run: ResearchRun }>(`/v1/runs/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),

  entities: (runId: string, filters: EntityFilters) => {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    for (const status of filters.status ?? []) params.append('status', status);
    if (filters.minScore !== undefined) params.set('minScore', String(filters.minScore));
    if (filters.signal) params.set('signal', filters.signal);
    if (filters.flaggedOnly) params.set('flaggedOnly', 'true');
    params.set('sort', filters.sort ?? 'score');
    params.set('direction', filters.direction ?? 'desc');
    params.set('limit', String(filters.limit ?? 100));
    params.set('offset', String(filters.offset ?? 0));
    return request<Paginated<Entity>>(`/v1/runs/${runId}/entities?${params.toString()}`);
  },

  entity: (id: string) => request<EntityDetail>(`/v1/entities/${id}`),
  review: (
    entityId: string,
    body: {
      action: 'approve' | 'reject' | 'edit' | 'reprocess';
      fieldKey?: string;
      value?: unknown;
      note?: string;
    },
  ) =>
    request<{ entity: Entity; fields: EntityField[] }>(`/v1/entities/${entityId}/review`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  bulkReview: (runId: string, entityIds: string[], action: 'approve' | 'reject') =>
    request<{ updated: number; pending: number }>(`/v1/runs/${runId}/entities/bulk-review`, {
      method: 'POST',
      body: JSON.stringify({ entityIds, action }),
    }),

  runExports: (runId: string) => request<{ items: ExportRecord[] }>(`/v1/runs/${runId}/exports`),
  exportRun: (
    runId: string,
    body: { connector?: string; entityIds?: string[]; options?: Record<string, unknown> },
  ) =>
    request<{ export: ExportRecord; warnings: string[] }>(`/v1/runs/${runId}/export`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  downloadUrl: (exportId: string) => `${API_URL}/v1/exports/${exportId}/download`,
};
