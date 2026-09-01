import { defineResearchPipeline } from '@frp/config';
import {
  nullLogger,
  ProviderError,
  type ProviderCallContext,
  type ProviderUsageReport,
} from '@frp/core';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtractionSchema, planSchema } from '../llm/schema.js';
import { estimateCost, lookupModelPrice } from '../pricing.js';
import { OpenRouterExtractionProvider, OpenRouterResearchProvider } from './index.js';
import { toStrictJsonSchema } from './schema.js';

/**
 * The OpenRouter adapter, tested against a stubbed transport.
 *
 * Nothing here reaches the network. What is worth pinning down is the part
 * that is not obvious: the JSON-schema shaping OpenRouter's stricter providers
 * need, the error classification that decides whether a run retries or gives
 * up, and the cost accounting that has to prefer a reported price over an
 * estimated one.
 */

const config = defineResearchPipeline({
  key: 'openrouter-test',
  name: 'OpenRouter test',
  entity: {
    type: 'company',
    label: 'Company',
    labelPlural: 'Companies',
    displayField: 'name',
    identity: { fields: ['website'], normalizer: 'domain' },
  },
  discovery: { sources: ['web'], queriesPerPlan: 2 },
  extraction: {
    fields: [
      { key: 'name', label: 'Name', type: 'string', required: true },
      { key: 'website', label: 'Website', type: 'url', required: true },
    ],
  },
});

const options = { apiKey: 'test-key', model: 'openai/gpt-4o-mini' };

function callContext(): ProviderCallContext & { usage: ProviderUsageReport[] } {
  const usage: ProviderUsageReport[] = [];
  return {
    runId: 'run_test',
    attempt: 1,
    logger: nullLogger,
    usage,
    recordUsage: (entry) => usage.push(entry),
  };
}

/** Stubs one HTTP round trip. */
function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function completion(content: unknown, usage?: Record<string, number>) {
  return {
    id: 'gen-1',
    model: 'openai/gpt-4o-mini',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
    ...(usage ? { usage } : {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toStrictJsonSchema', () => {
  it('drops $schema, which several strict validators reject', () => {
    const schema = toStrictJsonSchema(planSchema);
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe('object');
  });

  it('closes every object, as strict mode requires', () => {
    const schema = toStrictJsonSchema(planSchema);
    expect(schema.additionalProperties).toBe(false);
  });

  it('collapses a nullable union into a nullable type', () => {
    const schema = toStrictJsonSchema(z.object({ value: z.string().nullable() }));
    const value = (schema.properties as Record<string, Record<string, unknown>>).value;
    expect(value?.anyOf).toBeUndefined();
    expect(value?.type).toEqual(['string', 'null']);
  });

  it('leaves a union of objects alone rather than mangling it', () => {
    const schema = toStrictJsonSchema(
      z.object({ shape: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]) }),
    );
    const shape = (schema.properties as Record<string, Record<string, unknown>>).shape;
    expect(Array.isArray(shape?.anyOf)).toBe(true);
  });

  it('keeps the extraction schema usable after conversion', () => {
    const schema = toStrictJsonSchema(
      buildExtractionSchema(config.extraction.fields, config.signals),
    );
    const entities = (schema.properties as Record<string, Record<string, unknown>>).entities;
    expect(entities?.type).toBe('array');
  });
});

describe('OpenRouterResearchProvider', () => {
  it('sends a strict json_schema request and returns the plan', async () => {
    const spy = stubFetch(
      200,
      completion(
        {
          rationale: 'test',
          queries: [
            {
              query: 'saas companies',
              source: 'web',
              intent: 'find',
              priority: 90,
              expectedFields: ['name'],
            },
          ],
          fieldGuidance: [{ key: 'name', guidance: 'the legal name' }],
          estimatedEntities: 12,
        },
        { prompt_tokens: 900, completion_tokens: 120, cost: 0.004 },
      ),
    );

    const ctx = callContext();
    const plan = await new OpenRouterResearchProvider(options).plan(
      { objective: 'find companies', config, targeting: {} },
      ctx,
    );

    expect(plan.queries).toHaveLength(1);
    expect(plan.queries[0]?.id).toBe('q1');
    expect(plan.fieldGuidance.name).toBe('the legal name');

    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      model: string;
      response_format: { type: string; json_schema: { strict: boolean } };
    };
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
  });

  it('prefers the price OpenRouter reported over the local table', async () => {
    stubFetch(
      200,
      completion(
        { rationale: 't', queries: [], fieldGuidance: [], estimatedEntities: 0 },
        { prompt_tokens: 1_000, completion_tokens: 1_000, cost: 0.25 },
      ),
    );

    const ctx = callContext();
    await new OpenRouterResearchProvider(options).plan(
      { objective: 'x', config, targeting: {} },
      ctx,
    );

    expect(ctx.usage[0]?.costUsd).toBe(0.25);
    expect(ctx.usage[0]?.costSource).toBe('reported');
    expect(ctx.usage[0]?.outcome).toBe('success');
  });

  it('estimates from tokens when no price comes back', async () => {
    stubFetch(
      200,
      completion(
        { rationale: 't', queries: [], fieldGuidance: [], estimatedEntities: 0 },
        { prompt_tokens: 1_000_000, completion_tokens: 0 },
      ),
    );

    const ctx = callContext();
    await new OpenRouterResearchProvider(options).plan(
      { objective: 'x', config, targeting: {} },
      ctx,
    );

    expect(ctx.usage[0]?.costSource).toBe('estimated');
    expect(ctx.usage[0]?.costUsd).toBeCloseTo(0.15);
  });

  it('treats a rate limit as retryable and a bad key as not', async () => {
    stubFetch(429, { error: { message: 'slow down' } });
    await expect(
      new OpenRouterResearchProvider(options).plan(
        { objective: 'x', config, targeting: {} },
        callContext(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: true });

    stubFetch(401, { error: { message: 'no such key' } });
    await expect(
      new OpenRouterResearchProvider(options).plan(
        { objective: 'x', config, targeting: {} },
        callContext(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED', retryable: false });

    // Out of credits: retrying just burns the run's remaining attempts.
    stubFetch(402, { error: { message: 'insufficient credits' } });
    await expect(
      new OpenRouterResearchProvider(options).plan(
        { objective: 'x', config, targeting: {} },
        callContext(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED', retryable: false });
  });

  it('accounts for a failed call rather than losing it', async () => {
    stubFetch(500, { error: { message: 'upstream exploded' } });
    const ctx = callContext();
    await expect(
      new OpenRouterResearchProvider(options).plan({ objective: 'x', config, targeting: {} }, ctx),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(ctx.usage).toHaveLength(1);
    expect(ctx.usage[0]?.outcome).toBe('failure');
    expect(ctx.usage[0]?.errorCode).toBe('PROVIDER_UNAVAILABLE');
  });

  it('refuses to construct without a key', () => {
    expect(() => new OpenRouterResearchProvider({ ...options, apiKey: '' })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it('rejects a reply that is not schema-valid', async () => {
    stubFetch(200, completion({ rationale: 'missing the rest' }));
    await expect(
      new OpenRouterResearchProvider(options).plan(
        { objective: 'x', config, targeting: {} },
        callContext(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_BAD_RESPONSE', retryable: true });
  });
});

describe('OpenRouterExtractionProvider', () => {
  it('drops a value the model reported without evidence', async () => {
    let call = 0;
    vi.stubGlobal('fetch', async () => {
      call += 1;
      // First call fetches the page, second asks the model about it.
      if (call === 1) {
        return new Response('<html><body><h1>Acme</h1><p>acme.com</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(
        JSON.stringify(
          completion({
            entities: [
              {
                fields: [
                  { key: 'name', value: 'Acme', confidence: 0.9, evidence: 'Acme' },
                  { key: 'website', value: 'acme.com', confidence: 0.9, evidence: '' },
                  { key: 'invented', value: 'x', confidence: 0.9, evidence: 'x' },
                ],
                signals: [],
              },
            ],
          }),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const output = await new OpenRouterExtractionProvider(options).extract(
      {
        source: {
          id: 'src_1',
          url: 'https://acme.example',
          title: null,
          snippet: null,
          kind: 'page',
          query: null,
        },
        entityType: 'company',
        fields: config.extraction.fields,
        signals: [],
        objective: 'find companies',
        targeting: {},
        guidance: {},
      },
      callContext(),
    );

    expect(output.entities[0]?.fields.map((field) => field.key)).toEqual(['name']);
    expect(output.warnings).toContain('model returned unknown field "invented"');
  });
});

describe('pricing', () => {
  it('resolves a model by prefix, longest match first', () => {
    expect(lookupModelPrice('openai/gpt-4o-mini-2024-07-18')?.inputPerMTok).toBe(0.15);
    expect(lookupModelPrice('openai/gpt-4o-2024-08-06')?.inputPerMTok).toBe(2.5);
  });

  it('returns null rather than a confident zero for an unpriced model', () => {
    expect(lookupModelPrice('some-vendor/unknown-model-v9')).toBeNull();
    expect(estimateCost('some-vendor/unknown-model-v9', { input: 1_000, output: 100 })).toEqual({
      costUsd: null,
      costSource: 'unknown',
    });
  });

  it('lets a deployment override the table', () => {
    const estimate = estimateCost(
      'some-vendor/unknown-model-v9',
      { input: 1_000_000, output: 1_000_000 },
      { override: { inputPerMTok: 1, outputPerMTok: 2 } },
    );
    expect(estimate).toEqual({ costUsd: 3, costSource: 'estimated' });
  });

  it('does not price a call it has no tokens for', () => {
    expect(estimateCost('openai/gpt-4o-mini', { input: null, output: null }).costSource).toBe(
      'unknown',
    );
  });
});
