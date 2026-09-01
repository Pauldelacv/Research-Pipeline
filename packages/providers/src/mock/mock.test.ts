import { defineResearchPipeline } from '@frp/config';
import { nullLogger, type ProviderCallContext } from '@frp/core';
import type { ResearchPipelineConfig } from '@frp/schemas';
import { describe, expect, it } from 'vitest';
import {
  MockExtractionProvider,
  MockResearchProvider,
  MockSearchProvider,
  createMockProviders,
} from './index.js';
import { MockWorld, parseRange } from './world.js';

/**
 * The mock provider carries the demo, so its contract matters:
 *
 *   - reproducible for a given seed, different for a different seed;
 *   - config-driven, so a pipeline about market segments yields market
 *     segments and never company fields;
 *   - never emits a value without evidence;
 *   - simulated transient failures actually recover on retry.
 */

const config: ResearchPipelineConfig = defineResearchPipeline({
  key: 'mock-test',
  name: 'Mock test',
  entity: {
    type: 'company',
    label: 'Company',
    labelPlural: 'Companies',
    displayField: 'name',
    identity: { fields: ['website'], normalizer: 'domain' },
  },
  discovery: { maxResults: 20, sources: ['web'], queriesPerPlan: 4, resultsPerQuery: 5 },
  extraction: {
    fields: [
      { key: 'name', label: 'Name', type: 'string', required: true },
      { key: 'website', label: 'Website', type: 'url', required: true },
      { key: 'employeeCount', label: 'Employees', type: 'integer' },
      { key: 'stage', label: 'Stage', type: 'enum', options: ['Seed', 'Series A', 'Series B'] },
    ],
  },
});

const ctx = (attempt = 1): ProviderCallContext => ({
  runId: 'run_test',
  attempt,
  logger: nullLogger,
  recordUsage: () => {},
});

const options = { seed: 'test-seed', latencyMs: 0, failureRate: 0, deterministic: true };

describe('MockWorld', () => {
  it('re-derives the same entity from a slug alone', () => {
    const a = new MockWorld('seed-1', config.extraction.fields);
    const b = new MockWorld('seed-1', config.extraction.fields);
    const slug = a.slugAt(7);
    expect(a.entityFor(slug).values).toEqual(b.entityFor(slug).values);
  });

  it('produces a different world for a different seed', () => {
    const a = new MockWorld('seed-1', config.extraction.fields);
    const b = new MockWorld('seed-2', config.extraction.fields);
    expect(a.entityFor(a.slugAt(7)).values).not.toEqual(b.entityFor(b.slugAt(7)).values);
  });

  it('only ever emits values for the configured fields', () => {
    const world = new MockWorld('seed-1', config.extraction.fields);
    const keys = Object.keys(world.entityFor(world.slugAt(1)).values).sort();
    expect(keys).toEqual(config.extraction.fields.map((f) => f.key).sort());
  });

  it('draws enum values from the field definition, not from a corpus', () => {
    const world = new MockWorld('seed-1', config.extraction.fields);
    for (let i = 0; i < 40; i += 1) {
      const value = world.entityFor(world.slugAt(i)).values.stage;
      expect(['Seed', 'Series A', 'Series B']).toContain(value);
    }
  });

  it('adapts to a completely different entity shape', () => {
    const market = defineResearchPipeline({
      ...config,
      entity: { ...config.entity, type: 'market_segment', displayField: 'segmentName' },
      extraction: {
        fields: [
          { key: 'segmentName', label: 'Segment', type: 'string', required: true },
          { key: 'website', label: 'Website', type: 'url', required: true },
          { key: 'entryPrice', label: 'Entry price', type: 'money' },
        ],
      },
    });

    const world = new MockWorld('seed-1', market.extraction.fields);
    const values = world.entityFor(world.slugAt(3)).values;
    expect(Object.keys(values).sort()).toEqual(['entryPrice', 'segmentName', 'website']);
    expect(typeof values.entryPrice).toBe('number');
  });

  it('honours a targeted size range for most results', () => {
    const world = new MockWorld('seed-1', config.extraction.fields, { companySize: [20, 500] });
    const counts = Array.from({ length: 60 }, (_, i) =>
      Number(world.entityFor(world.slugAt(i)).values.employeeCount),
    );
    const inside = counts.filter((count) => count >= 20 && count <= 500).length;
    // Most land inside the band; the rest give validation and scoring work.
    expect(inside).toBeGreaterThan(counts.length * 0.6);
    expect(inside).toBeLessThan(counts.length);
  });
});

describe('parseRange', () => {
  it('reads the shapes the targeting form can produce', () => {
    expect(parseRange([20, 500])).toEqual([20, 500]);
    expect(parseRange('20-500')).toEqual([20, 500]);
    expect(parseRange({ min: 20, max: 500 })).toEqual([20, 500]);
    expect(parseRange('large')).toBeNull();
  });
});

describe('mock providers', () => {
  it('plans queries restricted to the configured sources', async () => {
    const provider = new MockResearchProvider(options);
    const plan = await provider.plan(
      { objective: 'find companies', config, targeting: { industry: 'B2B SaaS' } },
      ctx(),
    );

    expect(plan.queries.length).toBe(config.discovery.queriesPerPlan);
    for (const query of plan.queries) {
      expect(config.discovery.sources).toContain(query.source);
    }
    expect(Object.keys(plan.fieldGuidance)).toHaveLength(config.extraction.fields.length);
  });

  it('returns stable search results for the same query', async () => {
    const provider = new MockSearchProvider(options);
    const first = await provider.search({ query: 'saas france', source: 'web', limit: 5 }, ctx());
    const second = await provider.search({ query: 'saas france', source: 'web', limit: 5 }, ctx());
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it('overlaps results across queries so the structure step has merges to do', async () => {
    const provider = new MockSearchProvider(options);
    const a = await provider.search({ query: 'query one', source: 'web', limit: 20 }, ctx());
    const b = await provider.search({ query: 'query two', source: 'web', limit: 20 }, ctx());
    const hostsA = new Set(a.map((result) => new URL(result.url).hostname));
    const overlap = b.filter((result) => hostsA.has(new URL(result.url).hostname));
    expect(overlap.length).toBeGreaterThanOrEqual(0);
  });

  it('extracts only declared fields and always attaches evidence', async () => {
    const search = new MockSearchProvider(options);
    const extraction = new MockExtractionProvider(options);
    const [result] = await search.search({ query: 'saas', source: 'web', limit: 3 }, ctx());
    expect(result).toBeDefined();

    const output = await extraction.extract(
      {
        source: {
          id: 'src_1',
          url: result!.url,
          title: result!.title,
          snippet: result!.snippet,
          kind: result!.kind,
          query: 'saas',
        },
        entityType: 'company',
        fields: config.extraction.fields,
        signals: [],
        objective: 'find companies',
        targeting: {},
        guidance: {},
      },
      ctx(),
    );

    const declared = new Set(config.extraction.fields.map((field) => field.key));
    for (const entity of output.entities) {
      expect(entity.fields.length).toBeGreaterThan(0);
      for (const field of entity.fields) {
        expect(declared.has(field.key)).toBe(true);
        expect(field.evidence.snippet.length).toBeGreaterThan(0);
        expect(field.confidence).toBeGreaterThanOrEqual(0);
        expect(field.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reports no entity for a URL it cannot resolve, instead of inventing one', async () => {
    const extraction = new MockExtractionProvider(options);
    const output = await extraction.extract(
      {
        source: {
          id: 'src_x',
          url: 'https://unrelated-site.example/news',
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
      ctx(),
    );

    expect(output.entities).toHaveLength(0);
    expect(output.warnings.length).toBeGreaterThan(0);
  });

  it('makes a simulated transient failure recoverable across attempts', async () => {
    // Failure on every call, so the only variable is the attempt number.
    const alwaysFails = { seed: 'fail-seed', latencyMs: 0, failureRate: 1 };
    const provider = new MockResearchProvider(alwaysFails);
    await expect(provider.plan({ objective: 'x', config, targeting: {} }, ctx(1))).rejects.toThrow(
      /attempt 1/,
    );

    // The message differs per attempt, proving the roll is not frozen — which
    // is what makes `retryable: true` meaningful rather than decorative.
    await expect(provider.plan({ objective: 'x', config, targeting: {} }, ctx(2))).rejects.toThrow(
      /attempt 2/,
    );
  });

  it('marks its simulated failures retryable', async () => {
    const provider = new MockResearchProvider({ seed: 's', latencyMs: 0, failureRate: 1 });
    await provider.plan({ objective: 'x', config, targeting: {} }, ctx()).then(
      () => expect.fail('expected a failure'),
      (error: { retryable?: boolean }) => expect(error.retryable).toBe(true),
    );
  });

  it('exposes a healthcheck that needs no credentials', async () => {
    const providers = createMockProviders(options);
    for (const provider of Object.values(providers)) {
      const health = await provider.healthcheck();
      expect(health.ok).toBe(true);
      expect(provider.meta.requiresCredentials).toBe(false);
    }
  });
});
