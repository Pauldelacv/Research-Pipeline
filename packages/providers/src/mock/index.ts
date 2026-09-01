import {
  ProviderError,
  sleep,
  type EnrichmentInput,
  type EnrichmentOutput,
  type EnrichmentProvider,
  type ExtractedField,
  type ExtractionInput,
  type ExtractionOutput,
  type ExtractionProvider,
  type PlannedQuery,
  type ProviderCallContext,
  type ProviderHealth,
  type ResearchPlan,
  type ResearchPlanInput,
  type ResearchProvider,
  type SearchProvider,
  type SearchQuery,
  type SearchResult,
} from '@frp/core';
import type { FieldDefinition, JsonValue } from '@frp/schemas';
import { DIRECTORY_HOSTS } from './corpus.js';
import { SeededRandom, hashString } from './random.js';
import { MockWorld, UNIVERSE_SIZE } from './world.js';

/**
 * The mock provider suite.
 *
 * Its job is not to return data — it is to behave like a remote system:
 * it takes time, it fails intermittently, it disagrees with itself across
 * sources, it omits fields it could not determine, and it attaches evidence to
 * everything it does report. A pipeline that works against these providers
 * works against real ones, because it has already had to cope with latency,
 * retries, partial failures, conflicts and missing values.
 *
 * Nothing here is a fixture file. Every value is derived from a seed, so runs
 * are reproducible without being static.
 */

export interface MockProviderOptions {
  seed: string;
  /** Base latency per call. Jittered by ±40%. */
  latencyMs: number;
  /** Probability that any one call fails with a retryable error. */
  failureRate: number;
  /** Disables latency and failures — used by tests. */
  deterministic?: boolean;
}

export const DEFAULT_MOCK_OPTIONS: MockProviderOptions = {
  seed: 'field-research',
  latencyMs: 350,
  failureRate: 0.04,
};

abstract class MockProviderBase {
  constructor(protected readonly options: MockProviderOptions) {}

  async healthcheck(): Promise<ProviderHealth> {
    return { ok: true, detail: `mock provider ready (seed "${this.options.seed}")` };
  }

  /**
   * Simulates one remote call: latency, then a chance of a retryable failure.
   *
   * Two separate generators, on purpose:
   *
   *   - the *data* generator is seeded from the call key alone, so a given
   *     query always returns the same results and a run is reproducible;
   *   - the *failure* generator additionally mixes in the attempt number, so a
   *     simulated transient failure does not reproduce identically on retry.
   *
   * Without the second one, `retryable: true` would be a lie: every attempt
   * would hit the same deterministic failure and the step could never recover.
   */
  protected async remoteCall(key: string, ctx: ProviderCallContext): Promise<SeededRandom> {
    const data = new SeededRandom(`${this.options.seed}:${key}`);
    const [operation = 'call', ...rest] = key.split(':');
    const target = rest.join(':') || null;
    const startedAt = Date.now();

    /**
     * Usage is reported like everything else the mock does: simulated, but
     * shaped like the real thing, so the cost view has something to render
     * without credentials. The *cost* is a truthful zero — a mock call really
     * is free — while the token counts are seeded fiction, which is why they
     * are derived from the same generator as the data.
     */
    const account = (outcome: 'success' | 'failure', errorCode?: string) => {
      const inputTokens = 400 + Math.round(data.next() * 3_000);
      ctx.recordUsage({
        operation,
        model: `mock:${this.options.seed}`,
        inputTokens,
        outputTokens: Math.round(inputTokens * (0.05 + data.next() * 0.2)),
        costUsd: 0,
        costSource: 'reported',
        latencyMs: Date.now() - startedAt,
        outcome,
        errorCode: errorCode ?? null,
        target,
      });
    };

    if (!this.options.deterministic) {
      const jitter = 0.6 + data.next() * 0.8;
      await sleep(Math.round(this.options.latencyMs * jitter), ctx.signal);

      const fate = new SeededRandom(`${this.options.seed}:${key}:attempt:${ctx.attempt}`);
      if (fate.next() < this.options.failureRate) {
        const code = fate.bool() ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_TIMEOUT';
        account('failure', code);
        throw new ProviderError(
          'mock',
          code,
          `simulated upstream failure (attempt ${ctx.attempt}) for "${key}"`,
          { retryable: true, details: { key, attempt: ctx.attempt } },
        );
      }
    }

    account('success');
    return data;
  }

  protected world(fields: FieldDefinition[], targeting: Record<string, unknown>): MockWorld {
    return new MockWorld(this.options.seed, fields, targeting);
  }
}

// --- research -------------------------------------------------------------

export class MockResearchProvider extends MockProviderBase implements ResearchProvider {
  readonly meta = {
    id: 'mock',
    kind: 'research' as const,
    label: 'Mock research planner',
    description: 'Builds a deterministic query plan from the configuration and targeting values.',
    requiresCredentials: false,
  };

  async plan(input: ResearchPlanInput, ctx: ProviderCallContext): Promise<ResearchPlan> {
    const random = await this.remoteCall(`plan:${input.objective}`, ctx);
    const { config, targeting } = input;

    const facets = Object.entries(targeting)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `${key}:${formatFacet(value)}`);

    const queries: PlannedQuery[] = [];
    const sources = config.discovery.sources;
    const wanted = config.discovery.queriesPerPlan;

    // One query per (source, facet) pair, then generic sweeps to fill the plan.
    for (const source of sources) {
      for (const facet of facets) {
        if (queries.length >= wanted) break;
        queries.push({
          id: `q${queries.length + 1}`,
          query: `${config.entity.labelPlural} ${facet.split(':')[1]} ${config.entity.type}`.trim(),
          source,
          intent: `Find ${config.entity.labelPlural.toLowerCase()} matching ${facet}`,
          priority: 100 - queries.length,
          expectedFields: config.extraction.fields
            .filter((field) => field.required)
            .map((field) => field.key),
        });
      }
    }

    while (queries.length < wanted) {
      const field = random.pick(config.extraction.fields);
      queries.push({
        id: `q${queries.length + 1}`,
        query: `${config.entity.labelPlural} ${field.label.toLowerCase()} directory`,
        source: random.pick(sources),
        intent: `Broaden coverage for "${field.label}"`,
        priority: 50 - queries.length,
        expectedFields: [field.key],
      });
    }

    const fieldGuidance: Record<string, string> = {};
    for (const field of config.extraction.fields) {
      fieldGuidance[field.key] =
        field.description ??
        `Extract ${field.label.toLowerCase()} as ${field.type}${field.required ? ' (required)' : ''}`;
    }

    return {
      rationale:
        `Planned ${queries.length} queries across ${sources.join(', ')} to identify ` +
        `${config.entity.labelPlural.toLowerCase()}` +
        (facets.length > 0 ? ` matching ${facets.join(', ')}.` : '.'),
      queries,
      fieldGuidance,
      estimatedEntities: Math.min(config.discovery.maxResults, UNIVERSE_SIZE),
    };
  }
}

// --- search ---------------------------------------------------------------

export class MockSearchProvider extends MockProviderBase implements SearchProvider {
  readonly meta = {
    id: 'mock',
    kind: 'search' as const,
    label: 'Mock search',
    description: 'Returns synthetic but stable search results for planned queries.',
    requiresCredentials: false,
  };

  async search(query: SearchQuery, ctx: ProviderCallContext): Promise<SearchResult[]> {
    const random = await this.remoteCall(`search:${query.source}:${query.query}`, ctx);
    const world = this.world([], {});
    const results: SearchResult[] = [];

    // Different queries overlap on the same universe, which is exactly what
    // produces duplicate entities for the structure step to merge.
    const offset = hashString(query.query) % UNIVERSE_SIZE;
    const count = Math.max(3, Math.round(query.limit * random.float(0.6, 1)));

    for (let i = 0; i < count; i += 1) {
      const slug = world.slugAt(offset + i * 7);
      const entity = world.entityFor(slug);
      const onOwnSite = random.bool(0.45);
      const host = onOwnSite ? entity.primaryDomain : random.pick(DIRECTORY_HOSTS);
      const path = onOwnSite ? random.pick(['about', 'company', 'careers', '']) : `company/${slug}`;

      results.push({
        url: `https://${host}/${path}`.replace(/\/$/, ''),
        title: onOwnSite
          ? `${titleCase(slug)} — ${entity.values.industry ?? 'Company'}`
          : `${titleCase(slug)} profile | ${host}`,
        snippet: entity.narrative,
        rank: i + 1,
        kind: onOwnSite ? 'page' : 'search_result',
        raw: { source: query.source, slug },
      });
    }

    return results;
  }
}

// --- extraction -----------------------------------------------------------

export class MockExtractionProvider extends MockProviderBase implements ExtractionProvider {
  readonly meta = {
    id: 'mock',
    kind: 'extraction' as const,
    label: 'Mock extraction',
    description:
      'Observes the synthetic world through one source, with realistic omissions and disagreement.',
    requiresCredentials: false,
  };

  async extract(input: ExtractionInput, ctx: ProviderCallContext): Promise<ExtractionOutput> {
    const random = await this.remoteCall(`extract:${input.source.url}`, ctx);
    const world = this.world(input.fields, input.targeting);

    const slug = slugFromUrl(input.source.url, world);
    if (!slug) {
      return {
        entities: [],
        providerCalls: 1,
        warnings: ['no entity could be identified on this page'],
      };
    }

    const entity = world.entityFor(slug);
    const warnings: string[] = [];
    const fields: ExtractedField[] = [];

    for (const definition of input.fields) {
      const canonical = entity.values[definition.key];
      if (canonical === null || canonical === undefined) continue;

      // A single page rarely carries every attribute. Required fields are more
      // likely to appear, which is what makes most — but not all — entities
      // pass validation.
      const presenceOdds = definition.required ? 0.88 : 0.55;
      if (!random.bool(presenceOdds)) continue;

      const { value, confidence, note } = observe(canonical, definition, random);
      if (note) warnings.push(note);

      fields.push({
        key: definition.key,
        value,
        confidence,
        evidence: {
          snippet: evidenceSnippet(entity.narrative, definition, value),
          locator: `${input.source.kind === 'page' ? 'main' : 'div.result'} > p:nth-of-type(1)`,
          method: 'rule',
        },
      });
    }

    if (fields.length === 0) {
      return { entities: [], providerCalls: 1, warnings: ['page carried no extractable fields'] };
    }

    const signals = input.signals
      .filter((signal) => signal.source === 'extracted')
      .map((signal) => {
        const detected = random.bool(0.4);
        return {
          key: signal.key,
          detected,
          confidence: random.float(0.6, 0.97),
          rationale: detected
            ? `mentioned on ${input.source.url}`
            : `no mention found on ${input.source.url}`,
        };
      });

    return { entities: [{ fields, signals }], providerCalls: 1, warnings };
  }
}

// --- enrichment -----------------------------------------------------------

export class MockEnrichmentProvider extends MockProviderBase implements EnrichmentProvider {
  readonly meta = {
    id: 'mock',
    kind: 'enrichment' as const,
    label: 'Mock enrichment',
    description: 'Fills gaps from a synthetic entity graph, with its own evidence.',
    requiresCredentials: false,
  };

  async enrich(input: EnrichmentInput, ctx: ProviderCallContext): Promise<EnrichmentOutput> {
    const random = await this.remoteCall(`enrich:${input.entityId}`, ctx);
    const world = this.world(input.targetFields, {});

    // The enrichment provider is keyed on the entity's own identity, not on a
    // page, so it can answer for entities no single source described fully.
    const identity = String(
      input.values.website ?? input.values.domain ?? input.values.name ?? input.entityId,
    );
    const slug = slugFromUrl(identity, world) ?? world.slugAt(hashString(identity));
    const entity = world.entityFor(slug);

    const fields: ExtractedField[] = [];
    for (const definition of input.targetFields) {
      const existing = input.values[definition.key];
      const alreadyKnown = existing !== null && existing !== undefined && existing !== '';
      // Enrichment mostly fills gaps; occasionally it corrects a known value,
      // which the merge step turns into a conflict for review.
      if (alreadyKnown && !random.bool(0.15)) continue;

      const canonical = entity.values[definition.key];
      if (canonical === null || canonical === undefined) continue;

      fields.push({
        key: definition.key,
        value: canonical,
        confidence: random.float(0.72, 0.95),
        evidence: {
          snippet: `Entity graph record for ${entity.slug}: ${definition.label} = ${formatFacet(canonical)}`,
          locator: `graph:${entity.slug}#${definition.key}`,
          method: 'api',
        },
      });
    }

    return {
      fields,
      signals: [],
      sources: [
        {
          url: `https://graph.example/entity/${entity.slug}`,
          title: `Entity graph record — ${titleCase(entity.slug)}`,
          snippet: entity.narrative,
          rank: 1,
          kind: 'api',
        },
      ],
      providerCalls: 1,
    };
  }
}

// --- helpers --------------------------------------------------------------

/**
 * Adds observation noise to a canonical value.
 *
 * Numbers drift (a directory says 240, the careers page says 265), enums are
 * occasionally reported with the wrong separator, lists come back partial.
 * Each kind of noise exists to exercise a specific downstream behaviour:
 * numeric tolerance in the merge, enum coercion in normalisation, and
 * agreement counting for lists.
 */
function observe(
  canonical: JsonValue,
  definition: FieldDefinition,
  random: SeededRandom,
): { value: JsonValue; confidence: number; note?: string } {
  const accurate = random.bool(0.78);
  const confidence = accurate ? random.float(0.82, 0.99) : random.float(0.45, 0.8);

  if (!accurate) {
    if (typeof canonical === 'number') {
      const drift = random.float(0.75, 1.3);
      return { value: Math.round(canonical * drift), confidence };
    }
    if (Array.isArray(canonical) && canonical.length > 1) {
      return {
        value: canonical.slice(0, Math.max(1, canonical.length - 1)) as JsonValue,
        confidence,
      };
    }
    if (typeof canonical === 'string' && definition.type === 'enum') {
      return { value: canonical.replace(/\s+/g, '-'), confidence };
    }
  }

  return { value: canonical, confidence };
}

function evidenceSnippet(narrative: string, definition: FieldDefinition, value: JsonValue): string {
  const rendered = Array.isArray(value) ? value.join(', ') : String(value);
  return `${narrative} (${definition.label}: ${rendered})`;
}

/** Recovers the world entity a mock URL points at. */
function slugFromUrl(url: string, world: MockWorld): string | null {
  const directoryMatch = /\/company\/([a-z0-9-]+)/i.exec(url);
  if (directoryMatch?.[1]) return directoryMatch[1];

  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    const base = host.replace(/^www\./, '').split('.')[0];
    if (!base) return null;
    // Own-site URLs collapse the slug's hyphens; re-derive by scanning the
    // universe for the slug whose collapsed form matches.
    for (let i = 0; i < UNIVERSE_SIZE; i += 1) {
      const slug = world.slugAt(i);
      if (slug.replace(/-/g, '') === base) return slug;
    }
    return null;
  } catch {
    return null;
  }
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .slice(0, -1)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatFacet(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('min' in record && 'max' in record) return `${record.min}-${record.max}`;
    return JSON.stringify(value);
  }
  return String(value);
}

export function createMockProviders(options: Partial<MockProviderOptions> = {}) {
  const resolved: MockProviderOptions = { ...DEFAULT_MOCK_OPTIONS, ...options };
  return {
    research: new MockResearchProvider(resolved),
    search: new MockSearchProvider(resolved),
    extraction: new MockExtractionProvider(resolved),
    enrichment: new MockEnrichmentProvider(resolved),
  };
}

export { MockWorld } from './world.js';
export { SeededRandom } from './random.js';
