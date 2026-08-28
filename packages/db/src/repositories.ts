import { newId } from '@frp/core';
import type {
  Paginated,
  PipelineStepRun,
  ResearchPipelineConfig,
  ResearchProject,
  ResearchRun,
  ExportRecord,
  RunStatus,
  StepId,
  Tenant,
} from '@frp/schemas';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { toExportRecord, toProject, toRun, toStepRun } from './mappers.js';
import {
  entities,
  exports as exportsTable,
  pipelineStepRuns,
  projects,
  runs,
  tenants,
} from './schema.js';

/**
 * Application-level queries.
 *
 * These are the reads and writes the API performs directly — creating a
 * project, listing the dashboard, resuming a run. They are kept apart from the
 * engine's store ports because the engine has no business creating projects,
 * and the API has no business reaching into step state.
 */

export async function ensureTenant(db: Database, slug: string, name = slug): Promise<Tenant> {
  const [existing] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (existing) {
    return { ...existing, createdAt: existing.createdAt.toISOString() };
  }
  const [row] = await db
    .insert(tenants)
    .values({ id: newId('ten'), slug, name })
    .onConflictDoUpdate({ target: tenants.slug, set: { name } })
    .returning();
  if (!row) throw new Error(`failed to create tenant ${slug}`);
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export interface CreateProjectRecord {
  tenantId: string;
  name: string;
  objective: string;
  configKey: string;
  config: ResearchPipelineConfig;
  targeting: Record<string, unknown>;
  createdBy?: string | null;
}

export async function createProject(
  db: Database,
  input: CreateProjectRecord,
): Promise<ResearchProject> {
  const [row] = await db
    .insert(projects)
    .values({
      id: newId('prj'),
      tenantId: input.tenantId,
      name: input.name,
      objective: input.objective,
      configKey: input.configKey,
      config: input.config,
      targeting: input.targeting,
      status: 'draft',
      createdBy: input.createdBy ?? null,
    })
    .returning();
  if (!row) throw new Error('failed to create project');
  return toProject(row);
}

export async function listProjects(
  db: Database,
  tenantId: string,
  options: { limit?: number; offset?: number; status?: RunStatus } = {},
): Promise<Paginated<ResearchProject>> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const where = options.status
    ? and(eq(projects.tenantId, tenantId), eq(projects.status, options.status))
    : eq(projects.tenantId, tenantId);

  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(projects)
      .where(where)
      .orderBy(desc(projects.updatedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(projects)
      .where(where),
  ]);

  return { items: rows.map(toProject), total: counted?.total ?? 0, limit, offset };
}

export async function getProject(
  db: Database,
  projectId: string,
  tenantId: string,
): Promise<ResearchProject | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.tenantId, tenantId)))
    .limit(1);
  return row ? toProject(row) : null;
}

export async function updateProjectConfig(
  db: Database,
  projectId: string,
  patch: {
    name?: string;
    objective?: string;
    config?: ResearchPipelineConfig;
    targeting?: Record<string, unknown>;
  },
): Promise<ResearchProject | null> {
  const [row] = await db
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning();
  return row ? toProject(row) : null;
}

export async function deleteProject(db: Database, projectId: string): Promise<boolean> {
  const rows = await db
    .delete(projects)
    .where(eq(projects.id, projectId))
    .returning({ id: projects.id });
  return rows.length > 0;
}

/**
 * Creates a queued run and snapshots the project's configuration onto it.
 * The snapshot is what makes an old run reproducible after the project has
 * been edited.
 */
export async function createRun(
  db: Database,
  project: ResearchProject,
  trigger: ResearchRun['trigger'] = 'manual',
): Promise<ResearchRun> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(runs)
      .values({
        id: newId('run'),
        projectId: project.id,
        tenantId: project.tenantId,
        status: 'queued',
        trigger,
        configSnapshot: project.config,
        targeting: project.targeting,
        queuedAt: new Date(),
      })
      .returning();
    if (!row) throw new Error('failed to create run');

    await tx
      .update(projects)
      .set({ status: 'queued', lastRunId: row.id, lastRunAt: new Date(), updatedAt: new Date() })
      .where(eq(projects.id, project.id));

    return toRun(row);
  });
}

export async function getRun(db: Database, runId: string): Promise<ResearchRun | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  return row ? toRun(row) : null;
}

export async function listRuns(
  db: Database,
  filter: { tenantId: string; projectId?: string; limit?: number; offset?: number },
): Promise<Paginated<ResearchRun>> {
  const limit = filter.limit ?? 25;
  const offset = filter.offset ?? 0;
  const where = filter.projectId
    ? and(eq(runs.tenantId, filter.tenantId), eq(runs.projectId, filter.projectId))
    : eq(runs.tenantId, filter.tenantId);

  const [rows, [counted]] = await Promise.all([
    db.select().from(runs).where(where).orderBy(desc(runs.createdAt)).limit(limit).offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(runs)
      .where(where),
  ]);

  return { items: rows.map(toRun), total: counted?.total ?? 0, limit, offset };
}

export async function listStepRuns(db: Database, runId: string): Promise<PipelineStepRun[]> {
  const rows = await db
    .select()
    .from(pipelineStepRuns)
    .where(eq(pipelineStepRuns.runId, runId))
    .orderBy(pipelineStepRuns.createdAt);
  return rows.map(toStepRun);
}

export async function requestCancellation(db: Database, runId: string): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ cancelRequested: true, updatedAt: new Date() })
    .where(and(eq(runs.id, runId), sql`${runs.status} in ('queued', 'running', 'review_required')`))
    .returning({ id: runs.id });
  return rows.length > 0;
}

/** Clears the step record so a resumed run re-executes the gate cleanly. */
export async function clearStepRun(db: Database, runId: string, stepId: StepId): Promise<void> {
  await db
    .delete(pipelineStepRuns)
    .where(and(eq(pipelineStepRuns.runId, runId), eq(pipelineStepRuns.stepId, stepId)));
}

export async function countEntities(db: Database, runId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(entities)
    .where(eq(entities.runId, runId));
  return row?.total ?? 0;
}

/** Operational counters for the dashboard header. */
export interface TenantMetrics {
  projects: number;
  runsTotal: number;
  runsFailed: number;
  runsRunning: number;
  entities: number;
  successRate: number;
  medianDurationMs: number | null;
}

export async function tenantMetrics(db: Database, tenantId: string): Promise<TenantMetrics> {
  const [row] = await db
    .select({
      runsTotal: sql<number>`count(*)::int`,
      runsFailed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
      runsRunning: sql<number>`count(*) filter (where ${runs.status} in ('running','queued'))::int`,
      runsCompleted: sql<number>`count(*) filter (where ${runs.status} = 'completed')::int`,
      medianDurationMs: sql<
        number | null
      >`percentile_cont(0.5) within group (order by extract(epoch from (${runs.finishedAt} - ${runs.startedAt})) * 1000) filter (where ${runs.finishedAt} is not null)`,
    })
    .from(runs)
    .where(eq(runs.tenantId, tenantId));

  const [projectRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(projects)
    .where(eq(projects.tenantId, tenantId));

  const [entityRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(entities)
    .where(eq(entities.tenantId, tenantId));

  const runsTotal = row?.runsTotal ?? 0;
  const finished = (row?.runsCompleted ?? 0) + (row?.runsFailed ?? 0);

  return {
    projects: projectRow?.total ?? 0,
    runsTotal,
    runsFailed: row?.runsFailed ?? 0,
    runsRunning: row?.runsRunning ?? 0,
    entities: entityRow?.total ?? 0,
    successRate: finished > 0 ? Math.round(((row?.runsCompleted ?? 0) / finished) * 100) : 0,
    medianDurationMs:
      row?.medianDurationMs === null || row?.medianDurationMs === undefined
        ? null
        : Math.round(Number(row.medianDurationMs)),
  };
}

/** Liveness probe used by the API health endpoint. */
export async function pingDatabase(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}

/** Looks up a single export record without needing to know its run. */
export async function getExportById(db: Database, exportId: string): Promise<ExportRecord | null> {
  const [row] = await db.select().from(exportsTable).where(eq(exportsTable.id, exportId)).limit(1);
  return row ? toExportRecord(row) : null;
}
