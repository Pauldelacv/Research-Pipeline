import type {
  JsonValue,
  ResearchPipelineConfig,
  SourceKind,
  SourceTrust,
  SourceTrustCategory,
} from '@frp/schemas';
import { extractDomain } from './normalize.js';

/**
 * Resolving how much a source is worth.
 *
 * The rule is specificity, not order: an explicit domain beats a URL pattern,
 * which beats a blanket rule about a source *kind*. Within one level of
 * specificity the first declared category wins, so a deployment can shadow a
 * default by putting its own entry above it.
 *
 * Trust only ever damps a confidence. A government register does not make a
 * badly-evidenced extraction correct; it just fails to punish a well-evidenced
 * one. That asymmetry is what keeps the number an operator sees honest.
 */

const SPECIFICITY = { domain: 3, pattern: 2, kind: 1 } as const;

export const UNCATEGORISED_LABEL = 'Uncategorised source';

export interface TrustInput {
  url: string;
  kind: SourceKind;
}

export function resolveSourceTrust(config: ResearchPipelineConfig, input: TrustInput): SourceTrust {
  const trust = config.sources.trust;
  const fallback: SourceTrust = {
    score: trust.defaultScore,
    categoryId: null,
    label: UNCATEGORISED_LABEL,
  };

  const domain = extractDomain(input.url);
  let best: { category: SourceTrustCategory; specificity: number } | null = null;

  for (const category of trust.categories) {
    const specificity = matchSpecificity(category, domain, input);
    if (specificity === 0) continue;
    if (!best || specificity > best.specificity) best = { category, specificity };
  }

  if (!best) return fallback;
  return { score: best.category.score, categoryId: best.category.id, label: best.category.label };
}

function matchSpecificity(
  category: SourceTrustCategory,
  domain: string,
  input: TrustInput,
): number {
  if (domain && category.domains.some((pattern) => domainMatches(pattern, domain))) {
    return SPECIFICITY.domain;
  }
  for (const pattern of category.patterns) {
    let expression: RegExp;
    try {
      expression = new RegExp(pattern, 'i');
    } catch {
      // A malformed pattern is a configuration bug, not a runtime failure:
      // the config schema already reports it, and a run must not die here.
      continue;
    }
    if (expression.test(input.url)) return SPECIFICITY.pattern;
  }
  if (category.kinds.includes(input.kind)) return SPECIFICITY.kind;
  return 0;
}

/**
 * `*.gov` matches `data.gov` and `gov` alike; `linkedin.com` matches only
 * itself. Suffix matching is opt-in because `example.com` should not silently
 * claim `notexample.com`.
 */
function domainMatches(pattern: string, domain: string): boolean {
  const cleaned = pattern.trim().toLowerCase().replace(/^\*\./, '');
  if (!cleaned) return false;
  if (domain === cleaned) return true;
  if (pattern.trim().startsWith('*.')) return domain.endsWith(`.${cleaned}`);
  // A registrable domain equal to a listed suffix is also a match, which is
  // what makes `gov.uk` usable as a rule for `companieshouse.gov.uk`.
  return domain.endsWith(`.${cleaned}`) && cleaned.includes('.');
}

/**
 * Applies trust to one provider-reported confidence.
 *
 * `weight` is how much say the configuration gives trust at all; at 0 the
 * whole mechanism is inert and the provider's number passes through unchanged.
 */
export function applyTrust(confidence: number, trust: number, weight: number): number {
  if (!Number.isFinite(confidence)) return 0;
  const clampedWeight = clamp01(weight);
  const clampedTrust = clamp01(trust);
  const factor = 1 - clampedWeight + clampedWeight * clampedTrust;
  return clamp01(confidence * factor);
}

/**
 * Recognises a page published by the entity it describes.
 *
 * An entity's own site is the one source that cannot be listed in advance:
 * the domain is only known once a value has been extracted from the page. So
 * it is decided per candidate, by comparing the source's registrable domain
 * against whatever domain-ish identity the candidate carries.
 */
export function isSelfReportedSource(
  config: ResearchPipelineConfig,
  values: Record<string, JsonValue | null | undefined>,
  sourceUrl: string,
): boolean {
  const sourceDomain = extractDomain(sourceUrl);
  if (!sourceDomain) return false;

  const candidateKeys = new Set([
    ...config.entity.identity.fields,
    ...config.extraction.fields.filter((field) => field.type === 'url').map((field) => field.key),
  ]);

  for (const key of candidateKeys) {
    const value = values[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (extractDomain(value) === sourceDomain) return true;
  }
  return false;
}

/** Trust actually used for a candidate, after the self-reported override. */
export function effectiveTrust(
  config: ResearchPipelineConfig,
  recorded: SourceTrust,
  selfReported: boolean,
): SourceTrust {
  const { selfReported: rule } = config.sources.trust;
  if (!selfReported || !rule.enabled) return recorded;
  if (rule.score <= recorded.score) return recorded;
  return { score: rule.score, categoryId: 'self-reported', label: 'Published by the entity' };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
