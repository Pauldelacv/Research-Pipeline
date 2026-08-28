import { deriveSignals, detectedSignalKeys, scoreEntity } from '@frp/scoring';
import { coerceFieldValue } from '@frp/core';
import {
  bulkReviewRequestSchema,
  entityQuerySchema,
  reviewRequestSchema,
  type JsonValue,
} from '@frp/schemas';
import { getRun } from '@frp/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { badRequest, idParamSchema, notFound, parse } from '../http.js';

/**
 * Results explorer and human review.
 *
 * Review is a first-class write path, not an annotation layer. An edit records
 * the previous value, freezes the field against later machine writes, and
 * triggers a re-score — so the number an operator sees after correcting a
 * headcount is the number the export will carry.
 */
const REVIEWER = 'operator';

export function registerEntityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/runs/:id/entities', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const run = await getRun(ctx.db, id);
    if (!run || run.tenantId !== ctx.tenantId) throw notFound('run');

    const query = parse(entityQuerySchema, request.query, 'query');
    return ctx.stores.entities.list(id, query);
  });

  app.get('/v1/entities/:id', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const record = await ctx.stores.entities.get(id);
    if (!record || record.entity.tenantId !== ctx.tenantId) throw notFound('entity');

    const [evidence, reviews, run] = await Promise.all([
      ctx.stores.entities.listEvidence(id),
      ctx.stores.reviews.listByEntity(id),
      getRun(ctx.db, record.entity.runId),
    ]);

    return {
      entity: record.entity,
      fields: record.fields,
      evidence,
      reviews,
      config: run?.configSnapshot ?? null,
    };
  });

  app.post('/v1/entities/:id/review', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const body = parse(reviewRequestSchema, request.body, 'body');

    const record = await ctx.stores.entities.get(id);
    if (!record || record.entity.tenantId !== ctx.tenantId) throw notFound('entity');
    const { entity } = record;

    const run = await getRun(ctx.db, entity.runId);
    if (!run) throw notFound('run');
    const config = run.configSnapshot;

    switch (body.action) {
      case 'edit': {
        if (!body.fieldKey) throw badRequest('edit requires a fieldKey');
        const definition = config.extraction.fields.find((f) => f.key === body.fieldKey);
        if (!definition) throw badRequest(`"${body.fieldKey}" is not a field of this pipeline`);

        const coerced = coerceFieldValue(definition, body.value);
        if (coerced === undefined) {
          throw badRequest(`value is not a valid ${definition.type} for "${definition.label}"`, {
            received: body.value,
          });
        }

        const previous = record.fields.find((f) => f.key === body.fieldKey)?.value ?? null;

        await ctx.stores.entities.updateField(id, body.fieldKey, {
          value: coerced,
          // A human-supplied value is certain by definition, and `edited`
          // freezes it against any later machine write.
          confidence: 1,
          status: 'edited',
          reviewedBy: REVIEWER,
        });

        await ctx.stores.reviews.record({
          entityId: id,
          runId: entity.runId,
          action: 'edit',
          fieldKey: body.fieldKey,
          previousValue: previous,
          newValue: coerced as JsonValue,
          note: body.note ?? null,
          reviewer: REVIEWER,
        });
        break;
      }

      case 'approve': {
        if (body.fieldKey) {
          await ctx.stores.entities.updateField(id, body.fieldKey, {
            status: 'approved',
            confidence: 1,
            reviewedBy: REVIEWER,
          });
        } else {
          // Approving the entity clears its whole flagged queue.
          for (const key of entity.flaggedFields) {
            await ctx.stores.entities.updateField(id, key, {
              status: 'approved',
              reviewedBy: REVIEWER,
            });
          }
          await ctx.stores.entities.setStatus([id], 'approved');
          await ctx.stores.runs.incrementStats(entity.runId, { entitiesApproved: 1 });
        }

        await ctx.stores.reviews.record({
          entityId: id,
          runId: entity.runId,
          action: 'approve',
          fieldKey: body.fieldKey ?? null,
          previousValue: null,
          newValue: null,
          note: body.note ?? null,
          reviewer: REVIEWER,
        });
        break;
      }

      case 'reject': {
        await ctx.stores.entities.setStatus([id], 'rejected');
        await ctx.stores.runs.incrementStats(entity.runId, { entitiesRejected: 1 });
        await ctx.stores.reviews.record({
          entityId: id,
          runId: entity.runId,
          action: 'reject',
          fieldKey: body.fieldKey ?? null,
          previousValue: null,
          newValue: null,
          note: body.note ?? null,
          reviewer: REVIEWER,
        });
        break;
      }

      case 'reprocess': {
        // Re-derivation only: re-running extraction for one entity would mean
        // re-paying for its sources, so this recomputes signals and score from
        // the current field values instead. The UI says as much.
        await ctx.stores.reviews.record({
          entityId: id,
          runId: entity.runId,
          action: 'reprocess',
          fieldKey: null,
          previousValue: null,
          newValue: null,
          note: body.note ?? null,
          reviewer: REVIEWER,
        });
        break;
      }
    }

    const rescored = await rescore(ctx, id);
    await ctx.publisher.publish(entity.runId, { type: 'entity.updated', entityId: id });
    return rescored;
  });

  app.post('/v1/runs/:id/entities/bulk-review', async (request) => {
    const { id } = parse(idParamSchema, request.params, 'params');
    const body = parse(bulkReviewRequestSchema, request.body, 'body');

    const run = await getRun(ctx.db, id);
    if (!run || run.tenantId !== ctx.tenantId) throw notFound('run');

    const status = body.action === 'approve' ? 'approved' : 'rejected';
    const updated = await ctx.stores.entities.setStatus(body.entityIds, status);

    for (const entityId of body.entityIds) {
      const record = await ctx.stores.entities.get(entityId);
      if (!record || record.entity.runId !== id) continue;

      if (body.action === 'approve') {
        for (const key of record.entity.flaggedFields) {
          await ctx.stores.entities.updateField(entityId, key, {
            status: 'approved',
            reviewedBy: REVIEWER,
          });
        }
      }

      await ctx.stores.reviews.record({
        entityId,
        runId: id,
        action: body.action,
        fieldKey: null,
        previousValue: null,
        newValue: null,
        note: body.note ?? null,
        reviewer: REVIEWER,
      });
    }

    await ctx.stores.runs.incrementStats(id, {
      [body.action === 'approve' ? 'entitiesApproved' : 'entitiesRejected']: updated,
    });

    const pending = await ctx.stores.entities.countPendingReview(id);
    await ctx.stores.events.append({
      runId: id,
      stepId: 'review',
      level: 'info',
      type: 'review.bulk',
      message: `${updated} entities ${status} by an operator`,
      data: { action: body.action, count: updated, pending },
    });

    return { updated, pending };
  });
}

/**
 * Recomputes signals, flags and score for one entity after a human decision.
 *
 * This is the same code path the `score` step uses, so a reviewed entity is
 * scored by exactly the rules that scored the rest of the run.
 */
async function rescore(ctx: AppContext, entityId: string) {
  const record = await ctx.stores.entities.get(entityId);
  if (!record) throw notFound('entity');

  const run = await getRun(ctx.db, record.entity.runId);
  if (!run) throw notFound('run');
  const config = run.configSnapshot;

  const values = Object.fromEntries(record.fields.map((field) => [field.key, field.value]));
  const extracted = record.entity.signals.filter((signal) => signal.source === 'extracted');
  const signals = deriveSignals(config, values, extracted);
  await ctx.stores.entities.setSignals(entityId, signals);

  const flaggedFields = record.fields
    .filter(
      (field) =>
        field.value !== null &&
        field.status !== 'approved' &&
        field.status !== 'edited' &&
        field.confidence < config.review.flagBelowConfidence,
    )
    .map((field) => field.key);

  const stillNeedsReview = record.entity.status === 'needs_review' && flaggedFields.length > 0;

  await ctx.stores.entities.setValidation(entityId, {
    validationStatus: flaggedFields.length > 0 ? 'flagged' : 'valid',
    validationIssues: record.entity.validationIssues,
    flaggedFields,
    status: stillNeedsReview ? 'needs_review' : record.entity.status,
    confidence: record.entity.confidence,
  });

  if (config.scoring.rules.length > 0) {
    const breakdown = scoreEntity(config, {
      fields: values,
      signals: detectedSignalKeys(signals),
    });
    await ctx.stores.entities.setScore(entityId, breakdown.total, breakdown);
  }

  const refreshed = await ctx.stores.entities.get(entityId);
  return {
    entity: refreshed?.entity ?? record.entity,
    fields: refreshed?.fields ?? record.fields,
  };
}
