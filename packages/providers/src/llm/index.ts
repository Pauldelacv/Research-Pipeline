import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
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
import { estimateCost, type ModelPrice } from '../pricing.js';
import { DEFAULT_MAX_CONTENT, fetchSourceText } from './content.js';
import {
  EXTRACTION_SYSTEM,
  PLAN_SYSTEM,
  buildExtractionPrompt,
  buildPlanPrompt,
  mapExtractedEntities,
} from './prompts.js';
import { buildExtractionSchema, planSchema } from './schema.js';

/**
 * Language-model-backed research planning and extraction, on the Anthropic API.
 *
 * The model's role here is narrow on purpose: it turns unstructured text into
 * candidate values, and it explains its query strategy. It does not score, it
 * does not decide what is valid, and nothing it returns reaches the datastore
 * without passing a schema built from the pipeline's own field definitions.
 *
 * Every value it produces still goes through the same coercion and merge path
 * as any other provider's, and still carries evidence a human can check.
 */

export interface LlmProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Characters of page text handed to the model per source. */
  maxContentChars?: number;
  /** Overrides the built-in price table for cost accounting. */
  price?: Partial<ModelPrice>;
}

abstract class LlmProviderBase {
  protected readonly client: Anthropic;

  constructor(protected readonly options: LlmProviderOptions) {
    if (!options.apiKey) throw new NotConfiguredError('llm', ['ANTHROPIC_API_KEY']);
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    });
  }

  async healthcheck(): Promise<ProviderHealth> {
    return {
      ok: Boolean(this.options.apiKey),
      detail: this.options.apiKey
        ? `configured for model ${this.options.model}`
        : 'ANTHROPIC_API_KEY is not set',
    };
  }

  /**
   * Reports what a call consumed.
   *
   * Anthropic returns tokens, not a price, so the cost is derived from the
   * price table and labelled `estimated` — the run's cost view says so rather
   * than presenting a computed figure as an invoice.
   */
  protected report(
    ctx: ProviderCallContext,
    operation: string,
    startedAt: number,
    usage: { input_tokens?: number | null; output_tokens?: number | null } | null | undefined,
    outcome: 'success' | 'failure',
    errorCode?: string,
  ): void {
    const input = usage?.input_tokens ?? null;
    const output = usage?.output_tokens ?? null;
    const { costUsd, costSource } = estimateCost(
      this.options.model,
      { input, output },
      { override: this.options.price },
    );
    ctx.recordUsage({
      operation,
      model: this.options.model,
      inputTokens: input,
      outputTokens: output,
      costUsd,
      costSource,
      latencyMs: Date.now() - startedAt,
      outcome,
      errorCode: errorCode ?? null,
    });
  }

  /** Maps SDK errors onto the pipeline's retryable/non-retryable taxonomy. */
  protected toProviderError(error: unknown): ProviderError {
    if (error instanceof Anthropic.RateLimitError) {
      return new ProviderError('llm', 'PROVIDER_RATE_LIMITED', 'rate limited by the model API', {
        retryable: true,
        cause: error,
        details: { status: error.status, model: this.options.model },
      });
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new ProviderError('llm', 'PROVIDER_UNAVAILABLE', 'could not reach the model API', {
        retryable: true,
        cause: error,
        details: { model: this.options.model },
      });
    }
    if (error instanceof Anthropic.APIError) {
      const retryable = error.status !== undefined && error.status >= 500;
      return new ProviderError(
        'llm',
        'PROVIDER_BAD_RESPONSE',
        `model API error: ${error.message}`,
        {
          retryable,
          cause: error,
          // The response body is the first thing anyone debugging asks for.
          // It is redacted on the way into storage, never on the way out.
          details: { status: error.status, model: this.options.model, response: error.error },
        },
      );
    }
    return new ProviderError('llm', 'PROVIDER_BAD_RESPONSE', String(error), {
      cause: error,
      details: { model: this.options.model },
    });
  }
}

export class LlmResearchProvider extends LlmProviderBase implements ResearchProvider {
  readonly meta = {
    id: 'llm',
    kind: 'research' as const,
    label: 'LLM research planner',
    description: 'Generates a schema-validated query plan from the objective and targeting values.',
    requiresCredentials: true,
  };

  async plan(input: ResearchPlanInput, ctx: ProviderCallContext): Promise<ResearchPlan> {
    const startedAt = Date.now();

    try {
      const response = await this.client.messages.parse({
        model: this.options.model,
        max_tokens: 16000,
        system: PLAN_SYSTEM,
        messages: [{ role: 'user', content: buildPlanPrompt(input) }],
        output_config: { format: zodOutputFormat(planSchema) },
      });

      this.report(ctx, 'plan', startedAt, response.usage, 'success');

      const parsed = response.parsed_output;
      if (!parsed) {
        throw new ProviderError(
          'llm',
          'PROVIDER_BAD_RESPONSE',
          'the model returned no valid plan',
          {
            retryable: true,
          },
        );
      }

      const queries: PlannedQuery[] = parsed.queries.map((query, index) => ({
        id: `q${index + 1}`,
        query: query.query,
        source: query.source,
        intent: query.intent,
        priority: query.priority,
        expectedFields: query.expectedFields,
      }));

      const fieldGuidance: Record<string, string> = {};
      for (const entry of parsed.fieldGuidance) fieldGuidance[entry.key] = entry.guidance;

      ctx.logger.info({ queries: queries.length }, 'llm produced a research plan');

      return {
        rationale: parsed.rationale,
        queries,
        fieldGuidance,
        estimatedEntities: Number.isFinite(parsed.estimatedEntities)
          ? parsed.estimatedEntities
          : null,
      };
    } catch (error) {
      const mapped = error instanceof ProviderError ? error : this.toProviderError(error);
      // A failed call still consumed a slot of rate limit and, often, tokens.
      this.report(ctx, 'plan', startedAt, null, 'failure', mapped.code);
      throw mapped;
    }
  }
}

export class LlmExtractionProvider extends LlmProviderBase implements ExtractionProvider {
  readonly meta = {
    id: 'llm',
    kind: 'extraction' as const,
    label: 'LLM extraction',
    description: 'Fetches a source and extracts schema-constrained values with per-field evidence.',
    requiresCredentials: true,
  };

  async extract(input: ExtractionInput, ctx: ProviderCallContext): Promise<ExtractionOutput> {
    const content = await this.fetchText(input.source.url, ctx.signal);
    const warnings: string[] = [];

    if (!content.trim()) {
      return { entities: [], providerCalls: 0, warnings: ['source returned no readable text'] };
    }

    const schema = buildExtractionSchema(input.fields, input.signals);
    const fieldKeys = new Set(input.fields.map((field) => field.key));
    const startedAt = Date.now();

    try {
      const response = await this.client.messages.parse({
        model: this.options.model,
        max_tokens: 16000,
        system: EXTRACTION_SYSTEM,
        messages: [{ role: 'user', content: buildExtractionPrompt(input, content) }],
        output_config: { format: zodOutputFormat(schema) },
      });

      this.report(ctx, 'extract', startedAt, response.usage, 'success');

      const parsed = response.parsed_output;
      if (!parsed) {
        throw new ProviderError(
          'llm',
          'PROVIDER_BAD_RESPONSE',
          'the model returned no schema-valid extraction',
          { retryable: true },
        );
      }

      const entities = mapExtractedEntities(parsed.entities, fieldKeys, warnings);
      return { entities, providerCalls: 1, warnings };
    } catch (error) {
      const mapped = error instanceof ProviderError ? error : this.toProviderError(error);
      this.report(ctx, 'extract', startedAt, null, 'failure', mapped.code);
      throw mapped;
    }
  }

  private fetchText(url: string, signal?: AbortSignal): Promise<string> {
    return fetchSourceText('llm', url, {
      signal,
      maxChars: this.options.maxContentChars ?? DEFAULT_MAX_CONTENT,
    });
  }
}

export function createLlmProviders(options: LlmProviderOptions) {
  return {
    research: new LlmResearchProvider(options),
    extraction: new LlmExtractionProvider(options),
  };
}

export { DEFAULT_MAX_CONTENT, fetchSourceText, htmlToText } from './content.js';
export * from './prompts.js';
