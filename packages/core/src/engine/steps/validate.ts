import type { Entity, EntityStatus, ValidationIssue } from '@frp/schemas';
import { createEvaluationContext, evaluateCondition, renderTrace } from '@frp/scoring';
import { entityEvaluationFields } from '../../evaluation.js';
import { aggregateConfidence } from '../../merge.js';
import type { PipelineContext, PipelineStep, StepResult } from '../types.js';

/**
 * Decides, per entity, whether the data is trustworthy enough to act on.
 *
 * Three independent checks run here, and each produces a specific, named
 * reason rather than a generic "low quality" verdict:
 *   - required fields present
 *   - configured validation rules satisfied
 *   - per-field confidence at or above the review threshold
 *
 * Entities that fail land in the review queue by default. Deployments that
 * prefer volume over precision can set `validation.dropInvalid`.
 */
export const validateStep: PipelineStep = {
  id: 'validate',
  name: 'Validating information',
  idempotent: true,
  maxAttempts: 2,
  timeoutMs: 300_000,

  async execute(ctx: PipelineContext): Promise<StepResult> {
    const { config } = ctx;
    const definitions = config.extraction.fields;
    const requiredKeys = definitions.filter((field) => field.required).map((field) => field.key);
    const flagThreshold = config.review.enabled
      ? config.review.flagBelowConfidence
      : config.validation.minimumConfidence;

    let processed = 0;
    let valid = 0;
    let flagged = 0;
    let invalid = 0;
    const dropped: string[] = [];

    for await (const { entity, fields } of ctx.stores.entities.iterate(ctx.runId, 200)) {
      await ctx.assertNotCancelled();
      processed += 1;

      const issues: ValidationIssue[] = [];
      const fieldByKey = new Map(fields.map((field) => [field.key, field]));

      for (const key of requiredKeys) {
        const field = fieldByKey.get(key);
        if (!field || field.value === null || field.value === '') {
          issues.push({
            ruleId: 'required-field',
            label: 'Required field missing',
            severity: 'error',
            message: `"${labelOf(definitions, key)}" was not extracted`,
            field: key,
          });
        }
      }

      const evaluation = createEvaluationContext(
        entityEvaluationFields(config, entity),
        entity.signals.filter((signal) => signal.detected).map((signal) => signal.key),
        ctx.now(),
      );
      for (const rule of config.validation.rules) {
        const trace = evaluateCondition(rule.require, evaluation);
        if (!trace.matched) {
          issues.push({
            ruleId: rule.id,
            label: rule.label,
            severity: rule.severity,
            message: rule.message ?? `failed: ${renderTrace(trace)}`,
            field: null,
          });
        }
      }

      // Confidence flagging only applies to fields that actually carry a
      // value: a missing field is a completeness problem, already reported.
      const flaggedFields = fields
        .filter(
          (field) =>
            field.value !== null &&
            field.status !== 'approved' &&
            field.status !== 'edited' &&
            field.confidence < flagThreshold,
        )
        .map((field) => field.key);

      const hasErrors = issues.some((issue) => issue.severity === 'error');
      const confidence = aggregateConfidence(config, fields);

      if (hasErrors && config.validation.dropInvalid) {
        dropped.push(entity.id);
        invalid += 1;
        await ctx.stores.entities.setValidation(entity.id, {
          validationStatus: 'invalid',
          validationIssues: issues,
          flaggedFields,
          status: 'rejected',
          confidence,
        });
        continue;
      }

      const validationStatus: Entity['validationStatus'] = hasErrors
        ? 'invalid'
        : flaggedFields.length > 0 || issues.length > 0
          ? 'flagged'
          : 'valid';

      const needsReview =
        config.review.enabled &&
        (hasErrors ||
          flaggedFields.length > 0 ||
          issues.length > 0 ||
          confidence < config.validation.minimumConfidence);

      const status: EntityStatus = needsReview ? 'needs_review' : 'new';

      if (validationStatus === 'valid') valid += 1;
      else if (validationStatus === 'invalid') invalid += 1;
      else flagged += 1;

      await ctx.stores.entities.setValidation(entity.id, {
        validationStatus,
        validationIssues: issues,
        flaggedFields,
        status,
        confidence,
      });

      // Mark the low-confidence fields themselves so the review panel can
      // highlight the exact cells a human needs to look at.
      for (const key of flaggedFields) {
        await ctx.stores.entities.updateField(entity.id, key, { status: 'flagged' });
      }
    }

    await ctx.stores.runs.incrementStats(ctx.runId, {
      entitiesValid: valid,
      entitiesFlagged: flagged,
    });

    const warnings: string[] = [];
    if (invalid > 0) {
      warnings.push(
        config.validation.dropInvalid
          ? `${invalid} entities dropped for failing an error-severity rule`
          : `${invalid} entities failed an error-severity rule and need review`,
      );
    }

    await ctx.emit({
      level: invalid > 0 ? 'warn' : 'info',
      type: 'validate.completed',
      message: `${valid} valid, ${flagged} flagged, ${invalid} invalid`,
      data: { processed, valid, flagged, invalid, threshold: flagThreshold },
    });

    return {
      status: invalid > 0 ? 'partial' : 'completed',
      metrics: { itemsIn: processed, itemsOut: valid + flagged, itemsFailed: invalid },
      warnings,
      output: { valid, flagged, invalid, dropped: dropped.length },
    };
  },
};

function labelOf(definitions: Array<{ key: string; label: string }>, key: string): string {
  return definitions.find((definition) => definition.key === key)?.label ?? key;
}
