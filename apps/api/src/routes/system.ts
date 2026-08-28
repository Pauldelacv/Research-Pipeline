import { exportRequestSchema } from '@frp/schemas';
import { getExportById, getRun, pingDatabase, tenantMetrics } from '@frp/db';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, idParamSchema, notFound, parse } from '../http.js';

/**
 * System, catalogue and export routes.
 *
 * The catalogue endpoints are what let the web application stay generic: it
 * renders whatever pipelines, providers and connectors this deployment
 * registered, rather than hardcoding a list.
 */
export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Liveness plus real dependency checks — used by Docker's healthcheck. */
  app.get('/health', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    try {
      await pingDatabase(ctx.db);
      checks.database = { ok: true, detail: 'reachable' };
    } catch (error) {
      checks.database = { ok: false, detail: String(error) };
    }

    try {
      const pong = await ctx.redis.ping();
      checks.redis = { ok: pong === 'PONG', detail: pong };
    } catch (error) {
      checks.redis = { ok: false, detail: String(error) };
    }

    try {
      const counts = await ctx.queue.getJobCounts('waiting', 'active', 'failed', 'delayed');
      checks.queue = { ok: true, detail: JSON.stringify(counts) };
    } catch (error) {
      checks.queue = { ok: false, detail: String(error) };
    }

    const ok = Object.values(checks).every((check) => check.ok);
    reply.status(ok ? 200 : 503);
    return { ok, checks, version: '0.1.0' };
  });

  app.get('/v1/pipelines', async () => ({
    items: ctx.pipelines.list().map((config) => ({
      key: config.key,
      name: config.name,
      description: config.description ?? null,
      version: config.version,
      entity: config.entity,
      targeting: config.targeting,
      fields: config.extraction.fields,
      signals: config.signals,
      scoring: config.scoring,
      review: config.review,
      discovery: config.discovery,
      destinations: config.export.destinations.map((destination) => ({
        id: destination.id,
        label: destination.label,
        connector: destination.connector,
        enabled: destination.enabled,
      })),
    })),
  }));

  app.get('/v1/pipelines/:key', async (request) => {
    const { key } = parse(z.object({ key: z.string().min(1).max(64) }), request.params, 'params');
    const config = ctx.pipelines.get(key);
    if (!config) throw notFound('pipeline');
    return { config };
  });

  /** Provider inventory with live health, so misconfiguration is visible. */
  app.get('/v1/providers', async () => {
    const metas = ctx.providers.list();
    const items = await Promise.all(
      metas.map(async (meta) => {
        try {
          const provider = ctx.providers.resolve(meta.kind, meta.id);
          const health = await provider.healthcheck();
          return { ...meta, health };
        } catch (error) {
          return {
            ...meta,
            health: { ok: false, detail: error instanceof Error ? error.message : String(error) },
          };
        }
      }),
    );

    return {
      items,
      defaults: {
        research: ctx.env.PROVIDER_RESEARCH,
        search: ctx.env.PROVIDER_SEARCH,
        extraction: ctx.env.PROVIDER_EXTRACTION,
        enrichment: ctx.env.PROVIDER_ENRICHMENT,
      },
    };
  });

  app.get('/v1/connectors', async () => ({
    items: ctx.connectors.list().map((connector) => connector.meta),
  }));

  app.get('/v1/metrics', async () => {
    const [metrics, queueCounts] = await Promise.all([
      tenantMetrics(ctx.db, ctx.tenantId),
      ctx.queue.getJobCounts('waiting', 'active', 'failed', 'delayed', 'completed'),
    ]);
    return { ...metrics, queue: queueCounts };
  });

  app.get('/v1/runs/:id/exports', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const run = await getRun(ctx.db, id);
    if (!run || run.tenantId !== ctx.tenantId) throw notFound('run');
    return { items: await ctx.stores.exports.listByRun(id) };
  });

  /**
   * Ad-hoc export of the current result set.
   *
   * Distinct from the pipeline's own export step: this is what the operator
   * uses after filtering or selecting rows in the explorer.
   */
  app.post('/v1/runs/:id/export', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const body = parse(exportRequestSchema, request.body ?? {}, 'body');

    const run = await getRun(ctx.db, id);
    if (!run || run.tenantId !== ctx.tenantId) throw notFound('run');

    const config = run.configSnapshot;
    const destination = body.destinationId
      ? config.export.destinations.find((d) => d.id === body.destinationId)
      : undefined;
    const connectorId = body.connector ?? destination?.connector ?? 'csv';

    const connector = ctx.connectors.get(connectorId);
    if (!connector) throw badRequest(`unknown connector "${connectorId}"`);

    const selected = body.entityIds?.length ? new Set(body.entityIds) : null;
    const record = await ctx.stores.exports.create({
      runId: id,
      destinationId: destination?.id ?? `adhoc-${connectorId}`,
      connector: connectorId,
      status: 'running',
      entityCount: 0,
      location: null,
      error: null,
    });

    try {
      const result = await connector.write({
        run,
        config,
        destinationId: record.destinationId,
        options: { ...(destination?.options ?? {}), ...body.options },
        rows: (async function* rows() {
          for await (const row of ctx.stores.entities.iterate(id, 200)) {
            if (selected && !selected.has(row.entity.id)) continue;
            if (row.entity.status === 'rejected') continue;
            yield row;
          }
        })(),
        logger: ctx.logger.child({ connector: connectorId, runId: id }),
      });

      const finished = await ctx.stores.exports.finish(record.id, {
        status: 'completed',
        location: result.location,
        entityCount: result.entityCount,
      });
      return { export: finished, warnings: result.warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.stores.exports.finish(record.id, { status: 'failed', error: message });
      throw badRequest(`export failed: ${message}`);
    }
  });

  /**
   * Streams a completed export file.
   *
   * The path is resolved against the configured export directory and rejected
   * if it escapes it, so a stored location can never be used to read
   * arbitrary files.
   */
  app.get('/v1/exports/:id/download', async (request, reply) => {
    const { id } = parse(idParamSchema, request.params, 'params');

    const record = await getExportById(ctx.db, id);
    if (!record) throw notFound('export');
    if (record.status !== 'completed' || !record.location) {
      throw badRequest('export is not complete');
    }

    const root = path.resolve(ctx.env.EXPORT_DIR);
    const resolved = path.resolve(record.location);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw badRequest('this export was not written to the local filesystem');
    }

    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) throw notFound('export file');

    reply.header('content-type', guessContentType(resolved));
    reply.header('content-length', info.size);
    reply.header('content-disposition', `attachment; filename="${path.basename(resolved)}"`);
    return reply.send(createReadStream(resolved));
  });
}

function guessContentType(file: string): string {
  if (file.endsWith('.csv')) return 'text/csv; charset=utf-8';
  if (file.endsWith('.ndjson')) return 'application/x-ndjson';
  if (file.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
