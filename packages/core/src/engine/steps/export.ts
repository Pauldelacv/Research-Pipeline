import type { Condition, Entity } from '@frp/schemas';
import { createEvaluationContext, evaluateCondition } from '@frp/scoring';
import { detectedSignals, entityEvaluationFields } from '../../evaluation.js';
import { PipelineError, toErrorRecord } from '../../errors.js';
import type { ExportRow } from '../../ports/connectors.js';
import type { PipelineContext, PipelineStep, StepResult } from '../types.js';

/**
 * Delivers the finished dataset to every enabled destination.
 *
 * Rows are streamed to connectors rather than materialised, so a 10k-entity
 * run does not need to fit in memory. A destination that fails does not fail
 * the others: each gets its own export record with its own error, which is
 * what an operator needs when the CSV landed but the CRM push did not.
 */
export const exportStep: PipelineStep = {
  id: 'export',
  name: 'Preparing export',
  idempotent: false,
  maxAttempts: 3,
  timeoutMs: 600_000,

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const { config } = ctx;
    const destinations = config.export.destinations.filter((destination) => destination.enabled);

    if (destinations.length === 0) {
      await ctx.emit({
        type: 'export.skipped',
        message: 'No export destination is enabled; results remain available in the explorer',
      });
      return { status: 'skipped', output: { reason: 'no-destinations' } };
    }

    const run = await ctx.stores.runs.get(ctx.runId);
    if (!run) throw new PipelineError('NOT_FOUND', `run ${ctx.runId} disappeared mid-export`);

    const warnings: string[] = [];
    let totalExported = 0;
    let failed = 0;

    for (const destination of destinations) {
      await ctx.assertNotCancelled();
      const connector = ctx.connectors.get(destination.connector);

      if (!connector) {
        failed += 1;
        warnings.push(
          `destination "${destination.id}" skipped: no connector "${destination.connector}" is registered`,
        );
        await ctx.recordFailure({
          scope: 'destination',
          code: 'CONNECTOR_NOT_CONFIGURED',
          message: `no connector "${destination.connector}" is registered`,
          retryable: false,
          operation: 'export',
          targetId: destination.id,
          targetLabel: destination.label,
        });
        await ctx.emit({
          level: 'error',
          type: 'export.unavailable',
          message: `Connector "${destination.connector}" is not registered`,
          data: { destinationId: destination.id },
        });
        continue;
      }

      const record = await ctx.stores.exports.create({
        runId: ctx.runId,
        destinationId: destination.id,
        connector: destination.connector,
        status: 'running',
        entityCount: 0,
        location: null,
        error: null,
      });

      const counter = { exported: 0, skipped: 0 };

      try {
        const result = await connector.write({
          run,
          config,
          destinationId: destination.id,
          options: destination.options,
          rows: rowsFor(ctx, destination.filter, counter),
          logger: ctx.logger.child({ connector: destination.connector }),
          signal: ctx.signal,
        });

        await ctx.stores.exports.finish(record.id, {
          status: 'completed',
          location: result.location,
          entityCount: result.entityCount,
        });
        totalExported += result.entityCount;
        warnings.push(...result.warnings.map((w) => `${destination.label}: ${w}`));

        await ctx.emit({
          type: 'export.completed',
          message: `${result.entityCount} entities written to ${destination.label}`,
          data: {
            destinationId: destination.id,
            connector: destination.connector,
            location: result.location,
            skippedByFilter: counter.skipped,
          },
        });
      } catch (error) {
        failed += 1;
        const record_ = toErrorRecord(error);
        await ctx.stores.exports.finish(record.id, {
          status: 'failed',
          error: record_.message,
        });
        warnings.push(`${destination.label} failed: ${record_.message}`);
        await ctx.recordFailure({
          scope: 'destination',
          code: record_.code,
          message: record_.message,
          retryable: error instanceof PipelineError ? error.retryable : false,
          provider: destination.connector,
          operation: 'export',
          targetId: destination.id,
          targetLabel: destination.label,
          detail: error instanceof PipelineError ? error.details : undefined,
        });
        await ctx.emit({
          level: 'error',
          type: 'export.failed',
          message: `Export to ${destination.label} failed: ${record_.message}`,
          data: { destinationId: destination.id, code: record_.code },
        });
      }
    }

    if (failed === destinations.length) {
      throw new PipelineError(
        'CONNECTOR_FAILED',
        `every export destination failed (${destinations.length})`,
        { retryable: true, details: { warnings } },
      );
    }

    await ctx.stores.runs.incrementStats(ctx.runId, { entitiesExported: totalExported });

    return {
      status: failed > 0 ? 'partial' : 'completed',
      metrics: { itemsOut: totalExported, itemsFailed: failed },
      warnings,
      output: { exported: totalExported, destinations: destinations.length, failed },
    };
  },
};

/**
 * Streams the rows a destination should receive, applying the destination
 * filter and the pipeline-wide `approvedOnly` policy.
 */
async function* rowsFor(
  ctx: PipelineContext,
  filter: Condition | undefined,
  counter: { exported: number; skipped: number },
): AsyncIterable<ExportRow> {
  const approvedOnly = ctx.config.export.approvedOnly;
  const now = ctx.now();

  for await (const { entity, fields } of ctx.stores.entities.iterate(ctx.runId, 200)) {
    if (!isExportable(entity, approvedOnly)) {
      counter.skipped += 1;
      continue;
    }
    if (filter) {
      // Filters see the extracted fields plus reserved metadata such as
      // `score`, which is a column rather than a field.
      const evaluation = createEvaluationContext(
        entityEvaluationFields(ctx.config, entity),
        detectedSignals(entity),
        now,
      );
      if (!evaluateCondition(filter, evaluation).matched) {
        counter.skipped += 1;
        continue;
      }
    }
    counter.exported += 1;
    yield { entity, fields };
  }
}

function isExportable(entity: Entity, approvedOnly: boolean): boolean {
  if (entity.status === 'rejected') return false;
  if (approvedOnly) return entity.status === 'approved' || entity.status === 'exported';
  return true;
}
