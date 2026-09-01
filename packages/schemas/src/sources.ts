import { z } from 'zod';
import { sourceKindSchema } from './entities.js';

/**
 * Source trust.
 *
 * Not every document deserves the same credit. A filing on a government
 * register and a scraped listing on an unknown aggregator can state the same
 * number with the same apparent confidence; only one of them should move an
 * operator to act on it.
 *
 * Trust is deliberately *configuration*, not code: a deployment researching
 * French companies trusts `societe.com` differently from one researching US
 * biotech. It is also deliberately a modifier on confidence rather than a
 * replacement for provenance — the evidence chain keeps the raw, unweighted
 * number each provider reported, so "where did this come from and how sure was
 * the extractor?" stays answerable after the weighting is applied.
 */

export const sourceTrustCategorySchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  /** Multiplier in [0, 1]. 1.0 leaves a provider's confidence untouched. */
  score: z.number().min(0).max(1),
  /**
   * Registrable domains this category covers. A leading `*.` matches any
   * subdomain *and* the bare domain; `gov.uk` matches `data.gov.uk` too,
   * because suffix matching is what makes a public-sector rule writable.
   */
  domains: z.array(z.string().min(1)).default([]),
  /** Regular expressions tested against the canonical URL. */
  patterns: z.array(z.string().min(1)).default([]),
  /** Source kinds this category covers, e.g. `dataset`, `manual`. */
  kinds: z.array(sourceKindSchema).default([]),
});

export type SourceTrustCategory = z.infer<typeof sourceTrustCategorySchema>;

/**
 * A starting catalogue, close to the one most deployments end up writing.
 *
 * It is a default, not a policy: every entry can be overridden, and the whole
 * list can be replaced. The scores follow the rule of thumb that a source is
 * trusted in proportion to how directly accountable its publisher is for the
 * statement — a register, then the subject itself, then a publication with an
 * editor, then an aggregator, then an anonymous page.
 */
export const DEFAULT_SOURCE_TRUST_CATEGORIES: SourceTrustCategory[] = [
  {
    id: 'government',
    label: 'Government or official register',
    score: 1,
    domains: [
      '*.gov',
      '*.gov.uk',
      '*.gouv.fr',
      '*.europa.eu',
      '*.gc.ca',
      '*.gov.au',
      'sec.gov',
      'insee.fr',
      'infogreffe.fr',
      'data.gouv.fr',
      'companieshouse.gov.uk',
    ],
    patterns: [],
    kinds: [],
  },
  {
    id: 'official-dataset',
    label: 'Structured dataset or first-party API',
    score: 0.95,
    domains: [],
    patterns: [],
    kinds: ['dataset', 'api'],
  },
  {
    id: 'professional-network',
    label: 'Professional network profile',
    score: 0.9,
    domains: ['linkedin.com', 'xing.com'],
    patterns: [],
    kinds: [],
  },
  {
    id: 'major-publication',
    label: 'Major news publication',
    score: 0.8,
    domains: [
      'reuters.com',
      'bloomberg.com',
      'ft.com',
      'wsj.com',
      'lesechos.fr',
      'lemonde.fr',
      'techcrunch.com',
      'nytimes.com',
      'theguardian.com',
    ],
    patterns: [],
    kinds: [],
  },
  {
    id: 'industry-directory',
    label: 'Industry directory or aggregator',
    score: 0.6,
    domains: [
      'crunchbase.com',
      'pitchbook.com',
      'g2.com',
      'capterra.com',
      'glassdoor.com',
      'societe.com',
      'pappers.fr',
      'wikipedia.org',
    ],
    patterns: [],
    kinds: [],
  },
  {
    id: 'operator-entered',
    label: 'Entered by an operator',
    score: 1,
    domains: [],
    patterns: [],
    kinds: ['manual'],
  },
];

export const sourceTrustConfigSchema = z
  .object({
    /** When false, trust is resolved and recorded but never alters confidence. */
    enabled: z.boolean().default(true),
    /** Applied to any source no category claims. */
    defaultScore: z.number().min(0).max(1).default(0.5),
    /**
     * How much trust is allowed to move confidence.
     *
     * `effective = confidence * (1 - weight + weight * trust)`. At `weight: 0`
     * trust is inert; at `weight: 1` an untrusted source's values are damped in
     * full proportion to its score. Trust never *raises* a confidence: a
     * reputable source does not make a badly-supported extraction correct.
     */
    weight: z.number().min(0).max(1).default(0.5),
    categories: z.array(sourceTrustCategorySchema).default(DEFAULT_SOURCE_TRUST_CATEGORIES),
    /**
     * A page published on the entity's own domain is the entity speaking about
     * itself: authoritative for what it claims (its address, its headcount),
     * and recognised at extraction time rather than from a static list, since
     * the domain is only known once a value has been extracted.
     */
    selfReported: z
      .object({ enabled: z.boolean().default(true), score: z.number().min(0).max(1).default(1) })
      .prefault({}),
  })
  .prefault({});

export type SourceTrustConfig = z.infer<typeof sourceTrustConfigSchema>;

/** The trust verdict recorded against a source row. */
export const sourceTrustSchema = z.object({
  score: z.number().min(0).max(1),
  categoryId: z.string().nullable(),
  label: z.string(),
});

export type SourceTrust = z.infer<typeof sourceTrustSchema>;
