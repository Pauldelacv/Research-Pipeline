import { z } from 'zod';
import { researchPipelineConfigSchema } from './config.js';

/**
 * The canonical pipeline. Steps are ordered and every run walks them in this
 * sequence. A configuration can make a step a no-op (e.g. disable enrichment)
 * but it cannot reorder or remove steps — the fixed spine is what makes runs
 * comparable, resumable and debuggable across every client deployment.
 */
export const stepIdSchema = z.enum([
  'plan',
  'discover',
  'extract',
  'structure',
  'validate',
  'enrich',
  'score',
  'review',
  'export',
]);

export type StepId = z.infer<typeof stepIdSchema>;

export const PIPELINE_STEP_ORDER: readonly StepId[] = [
  'plan',
  'discover',
  'extract',
  'structure',
  'validate',
  'enrich',
  'score',
  'review',
  'export',
] as const;

export const STEP_LABELS: Record<StepId, string> = {
  plan: 'Planning research strategy',
  discover: 'Discovering sources',
  extract: 'Extracting entity data',
  structure: 'Structuring results',
  validate: 'Validating information',
  enrich: 'Enriching entities',
  score: 'Applying scoring rules',
  review: 'Awaiting human review',
  export: 'Preparing export',
};

export const runStatusSchema = z.enum([
  'draft',
  'queued',
  'running',
  'review_required',
  'completed',
  'failed',
  'cancelled',
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export const stepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  /** Finished, but with recoverable errors — see `StepRun.warnings`. */
  'partial',
  /** Halted on purpose and waiting for an external signal (human review). */
  'suspended',
  'failed',
  'skipped',
]);

export type StepStatus = z.infer<typeof stepStatusSchema>;

export const runEventLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type RunEventLevel = z.infer<typeof runEventLevelSchema>;

export const runEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: stepIdSchema.nullable(),
  level: runEventLevelSchema,
  /** Machine-readable event name, e.g. `source.discovered`, `step.retry`. */
  type: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

export type RunEvent = z.infer<typeof runEventSchema>;

/** Counters a step reports so operators can see throughput without log diving. */
export const stepMetricsSchema = z.object({
  itemsIn: z.number().int().nonnegative().default(0),
  itemsOut: z.number().int().nonnegative().default(0),
  itemsFailed: z.number().int().nonnegative().default(0),
  providerCalls: z.number().int().nonnegative().default(0),
  providerErrors: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
});

export type StepMetrics = z.infer<typeof stepMetricsSchema>;

export const stepRunSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: stepIdSchema,
  status: stepStatusSchema,
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  metrics: stepMetricsSchema.nullable(),
  warnings: z.array(z.string()).default([]),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      stack: z.string().optional(),
    })
    .nullable(),
  /** Small, serialisable hand-off between steps (never bulk data). */
  output: z.record(z.string(), z.unknown()).nullable(),
});

export type PipelineStepRun = z.infer<typeof stepRunSchema>;

export const runSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  tenantId: z.string(),
  status: runStatusSchema,
  currentStep: stepIdSchema.nullable(),
  trigger: z.enum(['manual', 'schedule', 'api', 'resume']).default('manual'),
  /** Snapshot of the configuration used, so a run stays reproducible. */
  configSnapshot: researchPipelineConfigSchema,
  targeting: z.record(z.string(), z.unknown()),
  stats: z
    .object({
      sourcesDiscovered: z.number().int().default(0),
      entitiesExtracted: z.number().int().default(0),
      entitiesStructured: z.number().int().default(0),
      entitiesValid: z.number().int().default(0),
      entitiesFlagged: z.number().int().default(0),
      entitiesApproved: z.number().int().default(0),
      entitiesRejected: z.number().int().default(0),
      entitiesExported: z.number().int().default(0),
      providerErrors: z.number().int().default(0),
      retries: z.number().int().default(0),
    })
    .default(() => ({
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
    })),
  error: z.string().nullable(),
  queuedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ResearchRun = z.infer<typeof runSchema>;
