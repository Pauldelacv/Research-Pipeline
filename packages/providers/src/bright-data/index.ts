import { z } from 'zod';
import {
  ProviderError,
  type EnrichmentInput,
  type EnrichmentOutput,
  type EnrichmentProvider,
  type ExtractionInput,
  type ExtractionOutput,
  type ExtractionProvider,
  type ProviderCallContext,
  type ProviderHealth,
  type SearchProvider,
  type SearchQuery,
  type SearchResult,
} from '@frp/core';
import { canonicaliseUrl } from '@frp/core';
import { htmlToText } from '../llm/index.js';
import { BrightDataClient, requireBrightDataConfig, type BrightDataConfig } from './client.js';

/**
 * Bright Data adapters.
 *
 * `BrightDataSearchProvider` uses a SERP zone for discovery.
 * `BrightDataExtractionProvider` uses a Web Unlocker zone to fetch pages that
 * ordinary `fetch` cannot reach, then hands the text to a delegate extraction
 * provider (typically the LLM one) — separating *retrieval* from
 * *interpretation* is what keeps this adapter small and swappable.
 *
 * See `client.ts` for the honest statement of what has and has not been tested.
 */

/** Bright Data's parsed SERP payload, validated before use. */
const serpSchema = z.object({
  organic: z
    .array(
      z.object({
        link: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        rank: z.number().optional(),
      }),
    )
    .default([]),
});

export class BrightDataSearchProvider implements SearchProvider {
  readonly meta = {
    id: 'bright-data',
    kind: 'search' as const,
    label: 'Bright Data SERP',
    description: 'Search-engine results via a Bright Data SERP zone.',
    requiresCredentials: true,
  };

  private readonly client: BrightDataClient;

  constructor(config: Partial<BrightDataConfig>) {
    this.client = new BrightDataClient(requireBrightDataConfig(config));
  }

  async healthcheck(): Promise<ProviderHealth> {
    return { ok: true, detail: `configured for zone "${this.client.zones.serp}"` };
  }

  async search(query: SearchQuery, ctx: ProviderCallContext): Promise<SearchResult[]> {
    const url = this.client.serpUrl(query.query, query.limit, query.region);
    const startedAt = Date.now();
    let body: string;
    try {
      body = await this.client.request(
        { url, zone: this.client.zones.serp, format: 'raw' },
        ctx.signal,
      );
    } catch (error) {
      // Bright Data bills per request, not per token, so a failed request is
      // still a request: recording it keeps the run's call count honest.
      ctx.recordUsage({
        operation: 'search',
        latencyMs: Date.now() - startedAt,
        outcome: 'failure',
        errorCode: error instanceof ProviderError ? error.code : 'INTERNAL',
        target: query.query,
      });
      throw error;
    }
    ctx.recordUsage({
      operation: 'search',
      latencyMs: Date.now() - startedAt,
      outcome: 'success',
      target: query.query,
    });

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new ProviderError(
        'bright-data',
        'PROVIDER_BAD_RESPONSE',
        'SERP response was not JSON — check that the zone is configured for parsed output',
        { retryable: false },
      );
    }

    const parsed = serpSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderError(
        'bright-data',
        'PROVIDER_BAD_RESPONSE',
        `unexpected SERP payload shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }

    return parsed.data.organic.slice(0, query.limit).map((result, index) => ({
      url: canonicaliseUrl(result.link),
      title: result.title ?? null,
      snippet: result.description ?? null,
      rank: result.rank ?? index + 1,
      kind: 'search_result' as const,
    }));
  }
}

export class BrightDataExtractionProvider implements ExtractionProvider {
  readonly meta = {
    id: 'bright-data',
    kind: 'extraction' as const,
    label: 'Bright Data Web Unlocker',
    description:
      'Fetches hard-to-reach pages through a Web Unlocker zone and delegates interpretation.',
    requiresCredentials: true,
  };

  private readonly client: BrightDataClient;

  /**
   * @param delegate the provider that turns page text into fields. Retrieval
   * and interpretation are separate concerns; this adapter only does the first.
   */
  constructor(
    config: Partial<BrightDataConfig>,
    private readonly delegate: ExtractionProvider,
  ) {
    this.client = new BrightDataClient(requireBrightDataConfig(config));
  }

  async healthcheck(): Promise<ProviderHealth> {
    const delegateHealth = await this.delegate.healthcheck();
    return {
      ok: delegateHealth.ok,
      detail: `unlocker zone "${this.client.zones.unlocker}"; interpretation via ${this.delegate.meta.id} (${delegateHealth.detail})`,
    };
  }

  async extract(input: ExtractionInput, ctx: ProviderCallContext): Promise<ExtractionOutput> {
    const startedAt = Date.now();
    let html: string;
    try {
      html = await this.client.request(
        { url: input.source.url, zone: this.client.zones.unlocker, format: 'raw' },
        ctx.signal,
      );
    } catch (error) {
      ctx.recordUsage({
        operation: 'unlock',
        latencyMs: Date.now() - startedAt,
        outcome: 'failure',
        errorCode: error instanceof ProviderError ? error.code : 'INTERNAL',
        target: input.source.id,
      });
      throw error;
    }
    // The unlocker fetch is billed separately from whatever the delegate
    // spends interpreting the page; the delegate records its own row.
    ctx.recordUsage({
      operation: 'unlock',
      latencyMs: Date.now() - startedAt,
      outcome: 'success',
      target: input.source.id,
    });

    const text = htmlToText(html);
    if (!text) {
      return { entities: [], providerCalls: 1, warnings: ['unlocker returned no readable text'] };
    }

    // The delegate receives the fetched text in place of the snippet, so it
    // never has to reach the network itself. Its spend is attributed to it
    // rather than to the unlocker: a cost report that bills model tokens to
    // Bright Data cannot be used to decide anything.
    const delegateCtx: ProviderCallContext = {
      ...ctx,
      recordUsage: (usage) =>
        ctx.recordUsage({
          ...usage,
          provider: this.delegate.meta.id,
          providerKind: this.delegate.meta.kind,
        }),
    };

    const output = await this.delegate.extract(
      { ...input, source: { ...input.source, snippet: text } },
      delegateCtx,
    );

    return { ...output, providerCalls: output.providerCalls + 1 };
  }
}

/**
 * Enrichment through Bright Data's dataset products is intentionally not
 * implemented. Doing it properly means picking a specific dataset, mapping its
 * schema and handling its async delivery model — that is a per-client decision,
 * not a framework default. This adapter exists so the gap is explicit rather
 * than silently missing; see docs/providers.md for how to add one.
 */
export class BrightDataEnrichmentProvider implements EnrichmentProvider {
  readonly meta = {
    id: 'bright-data',
    kind: 'enrichment' as const,
    label: 'Bright Data datasets (not implemented)',
    description:
      'Placeholder. Dataset selection and schema mapping are client-specific; implement per deployment.',
    requiresCredentials: true,
  };

  async healthcheck(): Promise<ProviderHealth> {
    return { ok: false, detail: 'not implemented — select a dataset and map its schema first' };
  }

  async enrich(_input: EnrichmentInput, _ctx: ProviderCallContext): Promise<EnrichmentOutput> {
    throw new ProviderError(
      'bright-data',
      'PROVIDER_NOT_CONFIGURED',
      'the Bright Data enrichment adapter is not implemented. Choose a dataset, map its fields ' +
        'to your pipeline configuration, and implement enrich(); or set PROVIDER_ENRICHMENT=mock.',
    );
  }
}

export { BrightDataClient, requireBrightDataConfig } from './client.js';
export type { BrightDataConfig } from './client.js';
