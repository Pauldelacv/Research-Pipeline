import { applyProjectOverrides } from '@frp/config';
import { createProjectInputSchema, PIPELINE_STEP_ORDER } from '@frp/schemas';
import {
  createProject,
  createRun,
  deleteProject,
  getProject,
  listProjects,
  updateProjectConfig,
} from '@frp/db';
import { enqueueStep } from '@frp/queue';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, idParamSchema, notFound, parse } from '../http.js';

/**
 * Project routes.
 *
 * Creating a project resolves a template plus the operator's overrides into a
 * concrete, validated configuration, which is then stored on the project. A
 * later edit to the template never changes an existing project, and a run
 * snapshots the configuration again — so a result set can always be explained
 * by the rules that actually produced it.
 */
export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/projects', async (request) => {
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      request.query,
      'query',
    );
    return listProjects(ctx.db, ctx.tenantId, query);
  });

  app.get('/v1/projects/:id', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const project = await getProject(ctx.db, id, ctx.tenantId);
    if (!project) throw notFound('project');

    const runs = await ctx.stores.runs.get(project.lastRunId ?? '');
    return { project, lastRun: runs };
  });

  app.post('/v1/projects', async (request, reply) => {
    const input = parse(createProjectInputSchema, request.body, 'body');

    const template = ctx.pipelines.get(input.configKey);
    if (!template) {
      throw badRequest(`unknown pipeline "${input.configKey}"`, {
        available: ctx.pipelines.keys(),
      });
    }

    // Overrides are re-validated against the full config schema, so a
    // narrowed field set that breaks a scoring rule is rejected here rather
    // than three steps into a run.
    const config = applyProjectOverrides(template, input.overrides);

    const project = await createProject(ctx.db, {
      tenantId: ctx.tenantId,
      name: input.name,
      objective: input.objective,
      configKey: input.configKey,
      config,
      targeting: input.targeting,
    });

    if (!input.startImmediately) {
      reply.status(201);
      return { project, run: null };
    }

    const run = await startRun(ctx, project);
    reply.status(201);
    return { project, run };
  });

  app.patch('/v1/projects/:id', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const patch = parse(
      z.object({
        name: z.string().min(1).max(160).optional(),
        objective: z.string().min(1).max(2000).optional(),
        targeting: z.record(z.string(), z.unknown()).optional(),
      }),
      request.body,
      'body',
    );

    const existing = await getProject(ctx.db, id, ctx.tenantId);
    if (!existing) throw notFound('project');

    const updated = await updateProjectConfig(ctx.db, id, patch);
    if (!updated) throw notFound('project');
    return { project: updated };
  });

  app.delete('/v1/projects/:id', async (request, reply) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const existing = await getProject(ctx.db, id, ctx.tenantId);
    if (!existing) throw notFound('project');
    await deleteProject(ctx.db, id);
    reply.status(204);
    return null;
  });

  app.post('/v1/projects/:id/runs', async (request, reply) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const project = await getProject(ctx.db, id, ctx.tenantId);
    if (!project) throw notFound('project');

    const run = await startRun(ctx, project);
    reply.status(202);
    return { run };
  });
}

/**
 * Creates a run and enqueues its first step.
 *
 * Only the first step is enqueued: each step enqueues its successor after it
 * has durably recorded its own result, which is what keeps the queue and the
 * database from disagreeing about where a run actually is.
 */
export async function startRun(
  ctx: AppContext,
  project: Awaited<ReturnType<typeof getProject>> & object,
) {
  const run = await createRun(ctx.db, project, 'manual');
  const firstStepId = PIPELINE_STEP_ORDER[0];
  if (!firstStepId) throw new Error('pipeline has no steps');
  const step = ctx.engine.step(firstStepId);

  await ctx.stores.events.append({
    runId: run.id,
    stepId: null,
    level: 'info',
    type: 'run.queued',
    message: `Run queued for "${project.name}"`,
    data: { pipeline: project.configKey, maxResults: project.config.discovery.maxResults },
  });

  const { enqueued } = await enqueueStep(
    ctx.queue,
    { runId: run.id, stepId: firstStepId, tenantId: run.tenantId, projectId: run.projectId },
    { attempts: step.maxAttempts },
  );
  if (!enqueued) {
    ctx.logger.warn({ runId: run.id }, 'first step was already queued for this run');
  }

  ctx.logger.info({ runId: run.id, projectId: project.id }, 'run queued');
  return run;
}
