import { ProviderError } from '@frp/core';
import { z } from 'zod';

/**
 * A small OpenRouter client.
 *
 * OpenRouter speaks the OpenAI chat-completions dialect over one endpoint and
 * hundreds of models, so a plain `fetch` is genuinely enough — pulling in an
 * SDK to send one JSON body would add a dependency, a version to track, and no
 * capability. What the file does carry is the part that is not obvious: the
 * error taxonomy, the strict-JSON-schema shaping, and the usage accounting.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  /**
   * Sent as `HTTP-Referer` and `X-Title`. OpenRouter uses them for its public
   * app rankings and for per-app dashboards; both are optional and neither
   * affects routing.
   */
  siteUrl?: string;
  appName?: string;
}

const usageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  /** Present when the request asked for it; OpenRouter's own credit charge. */
  cost: z.number().optional(),
});

const completionSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string().nullable().optional() }).optional(),
      }),
    )
    .default([]),
  usage: usageSchema.optional(),
  error: z
    .object({ message: z.string(), code: z.union([z.number(), z.string()]).optional() })
    .optional(),
});

export interface CompletionResult {
  /** Parsed JSON object the model produced, already validated as JSON. */
  content: unknown;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** OpenRouter's reported charge in USD, when it returned one. */
  reportedCostUsd: number | null;
}

export class OpenRouterClient {
  constructor(private readonly config: OpenRouterConfig) {}

  get model(): string {
    return this.config.model;
  }

  /**
   * One structured-output completion.
   *
   * `strict: true` makes OpenRouter enforce the schema for providers that
   * support it and validate the result for those that do not, which is what
   * lets the pipeline treat the reply as data rather than as prose to parse.
   */
  async complete(request: {
    system: string;
    prompt: string;
    schema: { name: string; schema: Record<string, unknown> };
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<CompletionResult> {
    const response = await this.post(
      '/chat/completions',
      {
        model: this.config.model,
        max_tokens: request.maxTokens ?? 16000,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.schema.name, strict: true, schema: request.schema.schema },
        },
        // Asks OpenRouter to return what the call actually cost, so the run's
        // cost view can say `reported` instead of `estimated`.
        usage: { include: true },
      },
      request.signal,
    );

    const parsed = completionSchema.safeParse(response);
    if (!parsed.success) {
      throw new ProviderError(
        'openrouter',
        'PROVIDER_BAD_RESPONSE',
        `unexpected completion payload: ${parsed.error.issues[0]?.message ?? 'unknown shape'}`,
        { details: { response } },
      );
    }
    if (parsed.data.error) {
      throw new ProviderError(
        'openrouter',
        'PROVIDER_BAD_RESPONSE',
        `OpenRouter returned an error: ${parsed.data.error.message}`,
        { retryable: true, details: { response: parsed.data.error } },
      );
    }

    const text = parsed.data.choices[0]?.message?.content ?? '';
    const finishReason = parsed.data.choices[0]?.finish_reason ?? null;
    if (!text.trim()) {
      throw new ProviderError(
        'openrouter',
        'PROVIDER_BAD_RESPONSE',
        finishReason === 'length'
          ? 'the model hit its output limit before producing a complete answer'
          : 'the model returned an empty response',
        { retryable: true, details: { finishReason, model: parsed.data.model } },
      );
    }

    let content: unknown;
    try {
      content = JSON.parse(stripCodeFence(text));
    } catch {
      throw new ProviderError(
        'openrouter',
        'PROVIDER_BAD_RESPONSE',
        'the model did not return valid JSON despite a strict schema',
        { retryable: true, details: { finishReason, sample: text.slice(0, 500) } },
      );
    }

    return {
      content,
      model: parsed.data.model ?? this.config.model,
      inputTokens: parsed.data.usage?.prompt_tokens ?? null,
      outputTokens: parsed.data.usage?.completion_tokens ?? null,
      reportedCostUsd: parsed.data.usage?.cost ?? null,
    };
  }

  /** Cheap credentials probe. Does not consume model quota. */
  async credits(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    try {
      const payload = await this.post('/key', undefined, signal, 'GET');
      const parsed = z
        .object({ data: z.object({ label: z.string().optional() }).optional() })
        .safeParse(payload);
      return {
        ok: true,
        detail:
          parsed.success && parsed.data.data?.label
            ? `key "${parsed.data.data.label}" accepted, model ${this.config.model}`
            : `key accepted, model ${this.config.model}`,
      };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        signal,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          ...(this.config.siteUrl ? { 'HTTP-Referer': this.config.siteUrl } : {}),
          ...(this.config.appName ? { 'X-Title': this.config.appName } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new ProviderError(
        'openrouter',
        'PROVIDER_UNAVAILABLE',
        'could not reach the OpenRouter API',
        { retryable: true, cause: error },
      );
    }

    const text = await response.text();
    const payload: unknown = text ? safeJson(text) : null;

    if (!response.ok) throw this.toError(response.status, payload, text);
    return payload;
  }

  /**
   * OpenRouter surfaces upstream provider failures with its own status codes;
   * 429 and 5xx are transient, 402 (out of credits) and 4xx are not — retrying
   * an exhausted account just burns the run's remaining attempts.
   */
  private toError(status: number, payload: unknown, raw: string): ProviderError {
    const message =
      (payload as { error?: { message?: string } } | null)?.error?.message ?? raw.slice(0, 300);
    const details = { status, response: payload ?? raw.slice(0, 1000), model: this.config.model };

    if (status === 429) {
      return new ProviderError(
        'openrouter',
        'PROVIDER_RATE_LIMITED',
        `rate limited by OpenRouter: ${message}`,
        { retryable: true, details },
      );
    }
    if (status === 401 || status === 403) {
      return new ProviderError(
        'openrouter',
        'PROVIDER_NOT_CONFIGURED',
        `OpenRouter rejected the credentials (${status}): ${message}`,
        { retryable: false, details },
      );
    }
    if (status === 402) {
      return new ProviderError(
        'openrouter',
        'PROVIDER_NOT_CONFIGURED',
        `OpenRouter account has insufficient credits: ${message}`,
        { retryable: false, details },
      );
    }
    if (status >= 500 || status === 408) {
      return new ProviderError(
        'openrouter',
        'PROVIDER_UNAVAILABLE',
        `OpenRouter responded ${status}: ${message}`,
        { retryable: true, details },
      );
    }
    return new ProviderError(
      'openrouter',
      'PROVIDER_BAD_RESPONSE',
      `OpenRouter responded ${status}: ${message}`,
      { retryable: false, details },
    );
  }
}

/** Some models wrap JSON in a fence despite a structured-output request. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
