import { newId, type ProjectStore, type RunStore } from '@frp/core';
import type { PipelineStepRun, ResearchProject, ResearchRun, StepId } from '@frp/schemas';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { toProject, toRun, toStepRun } from '../mappers.js';
import { pipelineStepRuns, projects, runs } from '../schema.js';

/** Counter names the run record accepts. Anything else is ignored. */
const RUN_STAT_KEYS = new Set<string>([
  'sourcesDiscovered',
  'entitiesExtracted',
  'entitiesStructured',
  'entitiesValid',
  'entitiesFlagged',
  'entitiesApproved',
  'entitiesRejected',
  'entitiesExported',
  'providerErrors',
  'retries',
]);

export function createProjectStore(db: Database): ProjectStore {
  return {
    async get(projectId: string): Promise<ResearchProject | null> {
      const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      return row ? toProject(row) : null;
    },

    async updateAfterRun(projectId, patch): Promise<void> {
      await db
        .update(projects)
        .set({
          status: patch.status,
          lastRunId: patch.lastRunId,
          lastRunAt: new Date(),
          entityCount: patch.entityCount,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));
    },
  };
}

export function createRunStore(db: Database): RunStore {
  return {
    async get(runId: string): Promise<ResearchRun | null> {
      const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
      return row ? toRun(row) : null;
    },

    async setStatus(runId, status, patch = {}): Promise<void> {
      const set: Record<string, unknown> = { status, updatedAt: new Date() };
      if (patch.currentStep !== undefined) set.currentStep = patch.currentStep;
      if (patch.error !== undefined) set.error = patch.error;
      if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
      if (status === 'running') {
        // `started_at` is set once, on the first transition into running.
        set.startedAt = sql`coalesce(${runs.startedAt}, now())`;
      }
      await db.update(runs).set(set).where(eq(runs.id, runId));
    },

    /**
     * Counters are merged inside Postgres rather than read-modify-written in
     * Node, so parallel step attempts cannot lose an increment.
     */
    async incrementStats(runId, deltas): Promise<void> {
      const entries = Object.entries(deltas).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' &&
          entry[1] !== 0 &&
          // Keys are whitelisted: they are interpolated into the JSON path.
          RUN_STAT_KEYS.has(entry[0]),
      );
      if (entries.length === 0) return;

      const pairs = entries.map(
        ([key, value]) =>
          sql`${key}::text, coalesce((${runs.stats} ->> ${key})::int, 0) + ${value}`,
      );

      await db
        .update(runs)
        .set({
          stats: sql`${runs.stats} || jsonb_build_object(${sql.join(pairs, sql`, `)})`,
          updatedAt: new Date(),
        })
        .where(eq(runs.id, runId));
    },

    async isCancelled(runId: string): Promise<boolean> {
      const [row] = await db
        .select({ cancelRequested: runs.cancelRequested, status: runs.status })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      if (!row) return false;
      return row.cancelRequested || row.status === 'cancelled';
    },

    async getStepRun(runId: string, stepId: StepId): Promise<PipelineStepRun | null> {
      const [row] = await db
        .select()
        .from(pipelineStepRuns)
        .where(and(eq(pipelineStepRuns.runId, runId), eq(pipelineStepRuns.stepId, stepId)))
        .limit(1);
      return row ? toStepRun(row) : null;
    },

    async listStepRuns(runId: string): Promise<PipelineStepRun[]> {
      const rows = await db
        .select()
        .from(pipelineStepRuns)
        .where(eq(pipelineStepRuns.runId, runId))
        .orderBy(asc(pipelineStepRuns.createdAt));
      return rows.map(toStepRun);
    },

    async startStepRun(runId, stepId, patch): Promise<PipelineStepRun> {
      const [row] = await db
        .insert(pipelineStepRuns)
        .values({
          id: newId('stp'),
          runId,
          stepId,
          status: 'running',
          attempt: patch.attempt,
          maxAttempts: patch.maxAttempts,
          startedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [pipelineStepRuns.runId, pipelineStepRuns.stepId],
          set: {
            status: 'running',
            attempt: patch.attempt,
            maxAttempts: patch.maxAttempts,
            // A retry keeps the original start time so duration stays honest.
            startedAt: sql`coalesce(${pipelineStepRuns.startedAt}, now())`,
            finishedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error(`failed to start step ${stepId} of run ${runId}`);
      return toStepRun(row);
    },

    async finishStepRun(runId, stepId, patch): Promise<PipelineStepRun> {
      const [row] = await db
        .update(pipelineStepRuns)
        .set({
          status: patch.status,
          metrics: patch.metrics ?? null,
          warnings: patch.warnings ?? [],
          error: patch.error ?? null,
          output: patch.output === undefined ? undefined : patch.output,
          finishedAt: patch.status === 'running' ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(pipelineStepRuns.runId, runId), eq(pipelineStepRuns.stepId, stepId)))
        .returning();
      if (!row) throw new Error(`step ${stepId} of run ${runId} not found`);
      return toStepRun(row);
    },
  };
}
