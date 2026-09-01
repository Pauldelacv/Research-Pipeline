import {
  NotConfiguredError,
  ProviderError,
  type ExtractionInput,
  type ExtractionOutput,
  type ExtractionProvider,
  type PlannedQuery,
  type ProviderCallContext,
  type ProviderHealth,
  type ResearchPlan,
  type ResearchPlanInput,
  type ResearchProvider,
} from '@frp/core';
import { DEFAULT_MAX_CONTENT, fetchSourceText } from '../llm/content.js';
import {
  EXTRACTION_SYSTEM,
  PLAN_SYSTEM,
  buildExtractionPrompt,
  buildPlanPrompt,
  mapExtractedEntities,
} from '../llm/prompts.js';
import { buildExtractionSchema, planSchema } from '../llm/schema.js';
import { estimateCost, type ModelPrice } from '../pricing.js';
import { OPENROUTER_BASE_URL, OpenRouterClient } from './client.js';
import { toStrictJsonSchema } from './schema.js';

/**
 * OpenRouter-backed research planning and extraction.
 *
 * One API key, one endpoint, and any model on OpenRouter's catalogue — which
 * makes it the pragmatic choice for a deployment that wants to compare models,
 * run a cheaper one for bulk extraction, or use a provider it already pays
 * for. The pipeline's guarantees do not change: the same schema is enforced,
 * the same evidence requirement applies, and the same coercion runs afterwards.
 * Swapping `PROVIDER_EXTRACTION=llm` for `openrouter` changes who serves the
 * tokens and nothing about what reaches the datastore.
 *
 * Cost accounting is a little better here than elsewhere: OpenRouter returns
 * what a call actually cost, so those rows are `reported` rather than
 * `estimated`.
 */

export interface OpenRouterProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  siteUrl?: string;
  appName?: string;
  /** Characters of page text handed to the model per source. */
  maxContentChars?: number;
  /** Fallback pricing, used only if OpenRouter reports no cost. */
  price?: Partial<ModelPrice>;
}

abstract class OpenRouterProviderBase {
  protected readonly client: OpenRouterClient;

  constructor(protected readonly options: OpenRouterProviderOptions) {
    if (!options.apiKey) throw new NotConfiguredError('openrouter', ['OPENROUTER_API_KEY']);
    this.client = new OpenRouterClient({
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl ?? OPENROUTER_BASE_URL,
      ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}),
      ...(options.appName ? { appName: options.appName } : {}),
    });
  }

  async healthcheck(): Promise<ProviderHealth> {
    if (!this.options.apiKey) return { ok: false, detail: 'OPENROUTER_API_KEY is not set' };
    return this.client.credits();
  }

  protected report(
    ctx: ProviderCallContext,
    operation: string,
    startedAt: number,
    result: {
      model?: string;
      inputTokens?: number | null;
      outputTokens?: number | null;
      reportedCostUsd?: number | null;
    } | null,
    outcome: 'success' | 'failure',
    errorCode?: string,
  ): void {
    const model = result?.model ?? this.options.model;
    const { costUsd, costSource } = estimateCost(
      model,
      { input: result?.inputTokens ?? null, output: result?.outputTokens ?? null },
      { reported: result?.reportedCostUsd ?? null, override: this.options.price },
    );
    ctx.recordUsage({
      operation,
      model,
      inputTokens: result?.inputTokens ?? null,
      outputTokens: result?.outputTokens ?? null,
      costUsd,
      costSource,
      latencyMs: Date.now() - startedAt,
      outcome,
      errorCode: errorCode ?? null,
    });
  }

  protected toProviderError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    return new ProviderError('openrouter', 'PROVIDER_BAD_RESPONSE', String(error), {
      cause: error,
      details: { model: this.options.model },
    });
  }
}

export class OpenRouterResearchProvider extends OpenRouterProviderBase implements ResearchProvider {
  readonly meta = {
    id: 'openrouter',
    kind: 'research' as const,
    label: 'OpenRouter research planner',
    description: 'Schema-validated query planning through any OpenRouter model.',
    requiresCredentials: true,
  };

  async plan(input: ResearchPlanInput, ctx: ProviderCallContext): Promise<ResearchPlan> {
    const startedAt = Date.now();

    try {
      const result = await this.client.complete({
        system: PLAN_SYSTEM,
        prompt: buildPlanPrompt(input),
        schema: { name: 'research_plan', schema: toStrictJsonSchema(planSchema) },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      this.report(ctx, 'plan', startedAt, result, 'success');

      // Validated with the same Zod schema the Anthropic adapter uses: the
      // strict JSON schema constrains the model, this catches the model that
      // ignored it. Both providers therefore fail in the same way.
      const parsed = planSchema.safeParse(result.content);
      if (!parsed.success) {
        throw new ProviderError(
          'openrouter',
          'PROVIDER_BAD_RESPONSE',
          `the model returned no schema-valid plan: ${parsed.error.issues[0]?.message ?? ''}`,
          { retryable: true, details: { issues: parsed.error.issues.slice(0, 5) } },
        );
      }

      const queries: PlannedQuery[] = parsed.data.queries.map((query, index) => ({
        id: `q${index + 1}`,
        query: query.query,
        source: query.source,
        intent: query.intent,
        priority: query.priority,
        expectedFields: query.expectedFields,
      }));

      const fieldGuidance: Record<string, string> = {};
      for (const entry of parsed.data.fieldGuidance) fieldGuidance[entry.key] = entry.guidance;

      ctx.logger.info(
        { queries: queries.length, model: result.model },
        'openrouter produced a research plan',
      );

      return {
        rationale: parsed.data.rationale,
        queries,
        fieldGuidance,
        estimatedEntities: Number.isFinite(parsed.data.estimatedEntities)
          ? parsed.data.estimatedEntities
          : null,
      };
    } catch (error) {
      const mapped = this.toProviderError(error);
      this.report(ctx, 'plan', startedAt, null, 'failure', mapped.code);
      throw mapped;
    }
  }
}

export class OpenRouterExtractionProvider
  extends OpenRouterProviderBase
  implements ExtractionProvider
{
  readonly meta = {
    id: 'openrouter',
    kind: 'extraction' as const,
    label: 'OpenRouter extraction',
    description: 'Fetches a source and extracts schema-constrained values with per-field evidence.',
    requiresCredentials: true,
  };

  async extract(input: ExtractionInput, ctx: ProviderCallContext): Promise<ExtractionOutput> {
    const content = await fetchSourceText('openrouter', input.source.url, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      maxChars: this.options.maxContentChars ?? DEFAULT_MAX_CONTENT,
    });

    if (!content.trim()) {
      return { entities: [], providerCalls: 0, warnings: ['source returned no readable text'] };
    }

    const warnings: string[] = [];
    const schema = buildExtractionSchema(input.fields, input.signals);
    const fieldKeys = new Set(input.fields.map((field) => field.key));
    const startedAt = Date.now();

    try {
      const result = await this.client.complete({
        system: EXTRACTION_SYSTEM,
        prompt: buildExtractionPrompt(input, content),
        schema: { name: 'extraction', schema: toStrictJsonSchema(schema) },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      this.report(ctx, 'extract', startedAt, result, 'success');

      const parsed = schema.safeParse(result.content);
      if (!parsed.success) {
        throw new ProviderError(
          'openrouter',
          'PROVIDER_BAD_RESPONSE',
          `the model returned no schema-valid extraction: ${parsed.error.issues[0]?.message ?? ''}`,
          { retryable: true, details: { issues: parsed.error.issues.slice(0, 5) } },
        );
      }

      const entities = mapExtractedEntities(parsed.data.entities, fieldKeys, warnings);
      return { entities, providerCalls: 1, warnings };
    } catch (error) {
      const mapped = this.toProviderError(error);
      this.report(ctx, 'extract', startedAt, null, 'failure', mapped.code);
      throw mapped;
    }
  }
}

export function createOpenRouterProviders(options: OpenRouterProviderOptions) {
  return {
    research: new OpenRouterResearchProvider(options),
    extraction: new OpenRouterExtractionProvider(options),
  };
}

export { OPENROUTER_BASE_URL, OpenRouterClient } from './client.js';
export type { OpenRouterConfig } from './client.js';
export { toStrictJsonSchema } from './schema.js';
