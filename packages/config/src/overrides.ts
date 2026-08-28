import type { CreateProjectInput, ResearchPipelineConfig } from '@frp/schemas';
import { defineResearchPipeline } from './define.js';

/**
 * Applies the sparse overrides collected by the "Create Research" form onto a
 * template, then re-validates. Re-validating matters: narrowing the field set
 * can invalidate `entity.displayField` or a scoring rule, and we want that
 * rejected at creation time rather than mid-run.
 */
export function applyProjectOverrides(
  template: ResearchPipelineConfig,
  overrides: CreateProjectInput['overrides'],
): ResearchPipelineConfig {
  // Structured clone keeps the template immutable across concurrent requests.
  const draft = structuredClone(template) as ResearchPipelineConfig;

  if (overrides.discovery?.maxResults !== undefined) {
    draft.discovery.maxResults = overrides.discovery.maxResults;
  }
  if (overrides.discovery?.sources?.length) {
    draft.discovery.sources = overrides.discovery.sources;
  }

  if (overrides.extraction?.fieldKeys?.length) {
    const keep = new Set(overrides.extraction.fieldKeys);
    // Identity and display fields are structural — they are always retained.
    keep.add(draft.entity.displayField);
    for (const key of draft.entity.identity.fields) keep.add(key);
    draft.extraction.fields = draft.extraction.fields.filter((field) => keep.has(field.key));
    draft.enrichment.fields = draft.enrichment.fields.filter((key) => keep.has(key));
    draft.signals = draft.signals.filter((signal) => conditionFieldsSatisfied(signal.when, keep));
    draft.validation.rules = draft.validation.rules.filter((rule) =>
      conditionFieldsSatisfied(rule.require, keep),
    );
    draft.scoring.rules = draft.scoring.rules.filter(
      (rule) =>
        conditionFieldsSatisfied(rule.when, keep) && (!rule.scale || keep.has(rule.scale.field)),
    );
  }

  if (overrides.validation?.minimumConfidence !== undefined) {
    draft.validation.minimumConfidence = overrides.validation.minimumConfidence;
  }

  if (overrides.review) {
    if (overrides.review.enabled !== undefined) draft.review.enabled = overrides.review.enabled;
    if (overrides.review.blocking !== undefined) draft.review.blocking = overrides.review.blocking;
    if (overrides.review.flagBelowConfidence !== undefined) {
      draft.review.flagBelowConfidence = overrides.review.flagBelowConfidence;
    }
  }

  if (overrides.export?.destinationIds) {
    const selected = new Set(overrides.export.destinationIds);
    draft.export.destinations = draft.export.destinations.map((destination) => ({
      ...destination,
      enabled: selected.has(destination.id),
    }));
  }

  if (overrides.providers) {
    draft.providers = { ...draft.providers, ...stripUndefined(overrides.providers) };
  }

  if (overrides.scoring?.weights) {
    const weights = overrides.scoring.weights;
    draft.scoring.rules = draft.scoring.rules.map((rule) =>
      weights[rule.id] === undefined ? rule : { ...rule, weight: weights[rule.id] as number },
    );
  }

  return defineResearchPipeline(draft);
}

/**
 * A condition can only survive a field-set narrowing if every field it
 * references is still present. Signal references are left alone — signals are
 * filtered in the same pass.
 */
function conditionFieldsSatisfied(condition: unknown, keep: Set<string>): boolean {
  if (!condition || typeof condition !== 'object') return true;
  const node = condition as Record<string, unknown>;
  if (typeof node.field === 'string') return keep.has(node.field);
  if (Array.isArray(node.all)) return node.all.every((c) => conditionFieldsSatisfied(c, keep));
  if (Array.isArray(node.any)) return node.any.every((c) => conditionFieldsSatisfied(c, keep));
  if (node.not) return conditionFieldsSatisfied(node.not, keep);
  return true;
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
