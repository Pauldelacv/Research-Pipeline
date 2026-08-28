import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  NotConfiguredError,
  ProviderError,
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
} from '@frp/core';
import { buildExtractionSchema, planSchema } from './schema.js';

/**
 * Language-model-backed research planning and extraction.
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
}

const DEFAULT_MAX_CONTENT = 24_000;

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

  /** Maps SDK errors onto the pipeline's retryable/non-retryable taxonomy. */
  protected toProviderError(error: unknown): ProviderError {
    if (error instanceof Anthropic.RateLimitError) {
      return new ProviderError('llm', 'PROVIDER_RATE_LIMITED', 'rate limited by the model API', {
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new ProviderError('llm', 'PROVIDER_UNAVAILABLE', 'could not reach the model API', {
        retryable: true,
        cause: error,
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
        },
      );
    }
    return new ProviderError('llm', 'PROVIDER_BAD_RESPONSE', String(error), { cause: error });
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
    const { config, targeting, objective } = input;

    const prompt = [
      `Objective: ${objective}`,
      `Entity type: ${config.entity.label} (${config.entity.type})`,
      `Available source channels: ${config.discovery.sources.join(', ')}`,
      `Produce at most ${config.discovery.queriesPerPlan} queries.`,
      '',
      'Targeting criteria supplied by the operator:',
      JSON.stringify(targeting, null, 2),
      '',
      'Fields that must be populated from the sources you find:',
      config.extraction.fields
        .map(
          (field) =>
            `- ${field.key} (${field.type}${field.required ? ', required' : ''}): ${field.label}` +
            (field.description ? ` — ${field.description}` : ''),
        )
        .join('\n'),
    ].join('\n');

    try {
      const response = await this.client.messages.parse({
        model: this.options.model,
        max_tokens: 16000,
        system:
          'You plan web research. Produce specific, high-yield search queries. ' +
          'Every query must use one of the listed source channels verbatim. ' +
          'Prefer queries that surface pages listing many entities over single-company pages.',
        messages: [{ role: 'user', content: prompt }],
        output_config: { format: zodOutputFormat(planSchema) },
      });

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
      if (error instanceof ProviderError) throw error;
      throw this.toProviderError(error);
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

    const fieldSpec = input.fields
      .map((field) => {
        const guidance = input.guidance[field.key];
        const options = field.options?.length ? ` One of: ${field.options.join(' | ')}.` : '';
        return `- ${field.key} (${field.type})${field.required ? ' [required]' : ''}: ${field.label}.${options}${
          guidance ? ` ${guidance}` : ''
        }`;
      })
      .join('\n');

    try {
      const response = await this.client.messages.parse({
        model: this.options.model,
        max_tokens: 16000,
        system:
          'You extract structured records from web pages. Rules you must follow:\n' +
          '1. Report only what the source states. Never infer, estimate or recall from memory.\n' +
          '2. If a field is not stated, return null for it rather than guessing.\n' +
          '3. Every reported value must include a short verbatim quote from the source.\n' +
          '4. Confidence reflects how clearly the source states the value, not how plausible it is.\n' +
          '5. Return one entity per distinct organisation or record described; none if the page describes no entity of the requested type.',
        messages: [
          {
            role: 'user',
            content: [
              `Entity type to extract: ${input.entityType}`,
              `Research objective: ${input.objective}`,
              '',
              'Fields:',
              fieldSpec,
              '',
              input.signals.length > 0
                ? `Signals to assess:\n${input.signals.map((s) => `- ${s.key}: ${s.label}`).join('\n')}`
                : '',
              '',
              `Source URL: ${input.source.url}`,
              'Source text:',
              '---',
              content,
              '---',
            ].join('\n'),
          },
        ],
        output_config: { format: zodOutputFormat(schema) },
      });

      const parsed = response.parsed_output;
      if (!parsed) {
        throw new ProviderError(
          'llm',
          'PROVIDER_BAD_RESPONSE',
          'the model returned no schema-valid extraction',
          { retryable: true },
        );
      }

      const entities = parsed.entities.map((entity) => {
        const fields: ExtractedField[] = [];
        for (const field of entity.fields) {
          if (!fieldKeys.has(field.key)) {
            warnings.push(`model returned unknown field "${field.key}"`);
            continue;
          }
          if (field.value === null || !field.evidence?.trim()) continue;
          fields.push({
            key: field.key,
            value: field.value,
            confidence: clamp01(field.confidence),
            evidence: { snippet: field.evidence, method: 'llm' },
          });
        }
        return {
          fields,
          signals: entity.signals.map((signal) => ({
            key: signal.key,
            detected: signal.detected,
            confidence: clamp01(signal.confidence),
            rationale: signal.rationale,
          })),
        };
      });

      return { entities, providerCalls: 1, warnings };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.toProviderError(error);
    }
  }

  /**
   * Minimal HTML-to-text. Deliberately simple: pages that need JavaScript or
   * bot mitigation should be fetched by an unlocker-capable search/extraction
   * provider (see the bright-data adapter) rather than handled here.
   */
  private async fetchText(url: string, signal?: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await fetch(url, {
        signal,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'field-research-pipeline/0.1',
        },
        redirect: 'follow',
      });
    } catch (error) {
      throw new ProviderError('llm', 'PROVIDER_UNAVAILABLE', `could not fetch ${url}`, {
        retryable: true,
        cause: error,
      });
    }

    if (response.status === 429 || response.status >= 500) {
      throw new ProviderError(
        'llm',
        'PROVIDER_UNAVAILABLE',
        `${url} responded ${response.status}`,
        {
          retryable: true,
        },
      );
    }
    if (!response.ok) {
      throw new ProviderError(
        'llm',
        'PROVIDER_BAD_RESPONSE',
        `${url} responded ${response.status}`,
      );
    }

    const html = await response.text();
    return htmlToText(html).slice(0, this.options.maxContentChars ?? DEFAULT_MAX_CONTENT);
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function createLlmProviders(options: LlmProviderOptions) {
  return {
    research: new LlmResearchProvider(options),
    extraction: new LlmExtractionProvider(options),
  };
}
