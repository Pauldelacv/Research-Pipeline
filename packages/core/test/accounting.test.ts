import { defineResearchPipeline } from '@frp/config';
import type { ResearchPipelineConfig, StepId } from '@frp/schemas';
import { describe, expect, it } from 'vitest';
import { createRunContext } from '../src/engine/context.js';
import { PipelineEngine } from '../src/engine/engine.js';
import { defaultSteps } from '../src/engine/steps/index.js';
import type { PipelineStep, StepResult } from '../src/engine/types.js';
import { PipelineError, ProviderError } from '../src/errors.js';
import type {
  EnrichmentProvider,
  ExtractionProvider,
  ProviderBundle,
  ResearchProvider,
  SearchProvider,
} from '../src/providers/types.js';
import {
  createMemoryStores,
  emptyConnectors,
  recordingPublisher,
  seedRun,
  testLogger,
} from './harness.js';

/**
 * Cost accounting, failure recording and source trust, end to end through the
 * engine.
 *
 * The properties that matter operationally: a step that dies still accounts
 * for what it spent, a failure an operator has to act on is written down with
 * the provider's answer attached, and a low-trust source visibly lowers the
 * confidence of what was extracted from it without rewriting its evidence.
 */

const config: ResearchPipelineConfig = defineResearchPipeline({
  key: 'accounting-test',
  name: 'Accounting test',
  entity: {
    type: 'company',
    label: 'Company',
    labelPlural: 'Companies',
    displayField: 'name',
    identity: { fields: ['website'], normalizer: 'domain' },
  },
  discovery: { maxResults: 5, sources: ['web'], queriesPerPlan: 2, resultsPerQuery: 3 },
  sources: {
    trust: {
      weight: 1,
      defaultScore: 0.5,
      categories: [
        { id: 'trusted', label: 'Trusted', score: 1, domains: ['acme.example'] },
        { id: 'sketchy', label: 'Sketchy', score: 0.2, domains: ['beta.example'] },
      ],
      // Off, so the domain rules above are the only thing moving confidence.
      selfReported: { enabled: false },
    },
  },
  extraction: {
    fields: [
      { key: 'name', label: 'Name', type: 'string', required: true },
      { key: 'website', label: 'Website', type: 'url', required: true },
    ],
  },
  enrichment: { enabled: false },
  review: { enabled: false },
  export: { destinations: [] },
});

const base = {
  meta: {
    id: 'test',
    kind: 'research' as const,
    label: 'test',
    description: '',
    requiresCredentials: false,
  },
  healthcheck: async () => ({ ok: true, detail: 'ok' }),
};

function providerBundle(overrides: Partial<ProviderBundle> = {}): ProviderBundle {
  const research: ResearchProvider = {
    ...base,
    async plan(_input, ctx) {
      ctx.recordUsage({
        operation: 'plan',
        model: 'test-model',
        inputTokens: 1_000,
        outputTokens: 200,
        costUsd: 0.01,
        costSource: 'reported',
        latencyMs: 20,
      });
      return {
        rationale: 'test plan',
        queries: [
          {
            id: 'q1',
            query: 'companies',
            source: 'web',
            intent: 'find',
            priority: 10,
            expectedFields: ['name'],
          },
        ],
        fieldGuidance: {},
        estimatedEntities: 2,
      };
    },
  };

  const search: SearchProvider = {
    ...base,
    meta: { ...base.meta, id: 'searcher', kind: 'search' },
    async search(_query, ctx) {
      ctx.recordUsage({ operation: 'search', latencyMs: 5 });
      return [
        { url: 'https://acme.example/about', title: 'Acme', snippet: null, rank: 1, kind: 'page' },
        { url: 'https://beta.example/about', title: 'Beta', snippet: null, rank: 2, kind: 'page' },
      ];
    },
  };

  const extraction: ExtractionProvider = {
    ...base,
    meta: { ...base.meta, id: 'extractor', kind: 'extraction' },
    async extract(input, ctx) {
      const host = new URL(input.source.url).hostname;
      ctx.recordUsage({
        operation: 'extract',
        model: 'test-model',
        inputTokens: 5_000,
        outputTokens: 500,
        // Unpriced on purpose: the rollup must flag the total as a floor.
        costUsd: null,
        latencyMs: 30,
      });
      const name = host.split('.')[0] ?? 'unknown';
      return {
        entities: [
          {
            fields: [
              {
                key: 'name',
                value: name,
                confidence: 0.8,
                evidence: { snippet: `About ${name}`, method: 'rule' as const },
              },
              {
                key: 'website',
                value: `https://${host}`,
                confidence: 0.8,
                evidence: { snippet: host, method: 'rule' as const },
              },
            ],
            signals: [],
          },
        ],
        providerCalls: 1,
        warnings: [],
      };
    },
  };

  return {
    research,
    search,
    extraction,
    enrichment: null as EnrichmentProvider | null,
    ...overrides,
  };
}

function harness(steps: PipelineStep[] = defaultSteps, providers = providerBundle()) {
  const stores = createMemoryStores();
  const publisher = recordingPublisher();
  const { runId, projectId, tenantId } = seedRun(stores, config);
  const engine = new PipelineEngine(steps);

  const makeContext = (stepId: StepId, attempt: number) =>
    createRunContext({
      runId,
      projectId,
      tenantId,
      objective: 'Find companies',
      config,
      targeting: {},
      providers,
      stores,
      connectors: emptyConnectors(),
      publisher,
      logger: testLogger,
      stepId,
      attempt,
      maxAttempts: engine.step(stepId).maxAttempts,
    });

  return { stores, engine, makeContext, runId };
}

describe('provider usage accounting', () => {
  it('records one row per provider call, attributed to its step', async () => {
    const { engine, makeContext, stores, runId } = harness();
    await engine.runToCompletion(makeContext, { sleep: async () => {} });

    const usage = await stores.usage.listByRun(runId);
    expect(usage.filter((row) => row.operation === 'plan')).toHaveLength(1);
    expect(usage.filter((row) => row.operation === 'search')).toHaveLength(1);
    expect(usage.filter((row) => row.operation === 'extract')).toHaveLength(2);

    const plan = usage.find((row) => row.operation === 'plan');
    expect(plan?.stepId).toBe('plan');
    expect(plan?.provider).toBe('test');
    expect(plan?.inputTokens).toBe(1_000);
  });

  it('rolls the calls up and flags a total that omits unpriced calls', async () => {
    const { engine, makeContext, stores, runId } = harness();
    await engine.runToCompletion(makeContext, { sleep: async () => {} });

    const summary = await stores.usage.summarise(runId);
    expect(summary.totals.requests).toBe(4);
    expect(summary.totals.costUsd).toBeCloseTo(0.01);
    // Extraction reported no price, so the total is a floor and says so.
    expect(summary.totals.partialCost).toBe(true);
    expect(summary.totals.inputTokens).toBe(11_000);
  });

  it('accounts for a step that spent tokens and then failed', async () => {
    const spendThenFail: PipelineStep = {
      ...defaultSteps[0]!,
      maxAttempts: 1,
      async execute(ctx): Promise<StepResult> {
        await ctx.providers.research.plan(
          { objective: ctx.objective, config: ctx.config, targeting: ctx.targeting },
          ctx.providerCall(ctx.providers.research.meta),
        );
        throw new PipelineError('STEP_FAILED', 'fell over after paying', { retryable: false });
      },
    };

    const { engine, makeContext, stores, runId } = harness([
      spendThenFail,
      ...defaultSteps.slice(1),
    ]);
    const status = await engine.runToCompletion(makeContext, { sleep: async () => {} });

    expect(status).toBe('failed');
    // The point of flushing on the failure path: the spend survives the crash.
    expect(await stores.usage.listByRun(runId)).toHaveLength(1);
  });
});

describe('failure recording', () => {
  it('records a step failure with the provider detail attached', async () => {
    const doomed: PipelineStep = {
      ...defaultSteps[0]!,
      maxAttempts: 1,
      async execute(): Promise<StepResult> {
        throw new ProviderError('flaky-vendor', 'PROVIDER_BAD_RESPONSE', 'upstream said no', {
          details: { status: 418, authorization: 'Bearer super-secret-value' },
        });
      },
    };

    const { engine, makeContext, stores, runId } = harness([doomed, ...defaultSteps.slice(1)]);
    await engine.runToCompletion(makeContext, { sleep: async () => {} });

    const failures = await stores.failures.listByRun(runId);
    expect(failures).toHaveLength(1);
    const [failure] = failures;
    expect(failure?.scope).toBe('step');
    expect(failure?.stepId).toBe('plan');
    expect(failure?.provider).toBe('flaky-vendor');
    expect(failure?.code).toBe('PROVIDER_BAD_RESPONSE');
    expect(failure?.willRetry).toBe(false);
    expect(failure?.detail?.status).toBe(418);
    // The one thing that must never reach the table.
    expect(JSON.stringify(failure?.detail)).not.toContain('super-secret-value');
  });

  it('marks a failure that will be retried, then the one that ends it', async () => {
    let attempts = 0;
    const flaky: PipelineStep = {
      ...defaultSteps[0]!,
      maxAttempts: 2,
      async execute(): Promise<StepResult> {
        attempts += 1;
        throw new PipelineError('PROVIDER_TIMEOUT', 'transient', { retryable: true });
      },
    };

    const { engine, makeContext, stores, runId } = harness([flaky, ...defaultSteps.slice(1)]);
    await engine.runToCompletion(makeContext, { sleep: async () => {} });

    expect(attempts).toBe(2);
    const failures = await stores.failures.listByRun(runId);
    expect(failures.map((f) => f.willRetry)).toEqual([true, false]);
    expect(failures.map((f) => f.attempt)).toEqual([1, 2]);
  });

  it('records a tolerated per-source failure without failing the run', async () => {
    const providers = providerBundle();
    const flakyExtraction: ExtractionProvider = {
      ...providers.extraction,
      async extract(input, ctx) {
        if (input.source.url.includes('beta.example')) {
          throw new ProviderError('extractor', 'PROVIDER_TIMEOUT', 'timed out on beta', {
            retryable: true,
          });
        }
        return providers.extraction.extract(input, ctx);
      },
    };

    const { engine, makeContext, stores, runId } = harness(defaultSteps, {
      ...providers,
      extraction: flakyExtraction,
    });
    const status = await engine.runToCompletion(makeContext, { sleep: async () => {} });

    expect(status).toBe('completed');
    const failures = await stores.failures.listByRun(runId);
    const sourceFailures = failures.filter((f) => f.scope === 'source');
    expect(sourceFailures).toHaveLength(1);
    expect(sourceFailures[0]?.targetLabel).toContain('beta.example');
    expect(sourceFailures[0]?.operation).toBe('extract');
  });
});

describe('source trust in the pipeline', () => {
  it('records the resolved trust alongside each source', async () => {
    const { engine, makeContext, stores, runId } = harness();
    await engine.runToCompletion(makeContext, { sleep: async () => {} });

    const sources = await stores.sources.listByRun(runId);
    const byHost = new Map(sources.map((source) => [new URL(source.url).hostname, source]));
    expect(byHost.get('acme.example')?.trustCategory).toBe('trusted');
    expect(byHost.get('acme.example')?.trustScore).toBe(1);
    expect(byHost.get('beta.example')?.trustScore).toBe(0.2);
  });

  it('damps confidence from an untrusted source but keeps the raw evidence', async () => {
    const { engine, makeContext, stores, runId } = harness();
    await engine.runToCompletion(makeContext, { sleep: async () => {} });

    const state = stores.snapshot();
    const entities = [...state.entities.values()].filter((entity) => entity.runId === runId);
    const acme = entities.find((entity) => entity.dedupeKey.includes('acme'));
    const beta = entities.find((entity) => entity.dedupeKey.includes('beta'));

    const nameOf = (id: string) =>
      (state.fields.get(id) ?? []).find((field) => field.key === 'name');

    // Same provider confidence (0.8) on both, weighted by the source's trust:
    // 0.8 * 1.0 against 0.8 * 0.2.
    expect(nameOf(acme!.id)?.confidence).toBeCloseTo(0.8);
    expect(nameOf(beta!.id)?.confidence).toBeCloseTo(0.16);

    // Provenance is untouched: the candidate still carries what the extractor
    // said before trust had an opinion about the page.
    const candidates = [...state.candidates.values()].filter(
      (candidate) => candidate.runId === runId,
    );
    for (const candidate of candidates) {
      for (const field of candidate.payload.fields) {
        expect(field.evidence.confidence).toBeCloseTo(0.8);
      }
    }
  });
});
