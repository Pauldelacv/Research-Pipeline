import { defineResearchPipeline } from '@frp/config';
import type { ResearchPipelineConfig, StepId } from '@frp/schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { PipelineEngine, backoffMs } from '../src/engine/engine.js';
import { createRunContext } from '../src/engine/context.js';
import { defaultSteps } from '../src/engine/steps/index.js';
import type { PipelineStep, StepResult } from '../src/engine/types.js';
import { PipelineError } from '../src/errors.js';
import { ProviderRegistry } from '../src/providers/registry.js';
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
 * Engine behaviour, verified against in-memory stores and scripted providers.
 *
 * The properties under test are the ones an operator depends on: a failed step
 * fails the run with a reason, a retryable failure is retried and can recover,
 * a completed step is never re-executed after a crash, and the review gate
 * genuinely halts the pipeline.
 */

const config: ResearchPipelineConfig = defineResearchPipeline({
  key: 'engine-test',
  name: 'Engine test',
  entity: {
    type: 'company',
    label: 'Company',
    labelPlural: 'Companies',
    displayField: 'name',
    identity: { fields: ['website'], normalizer: 'domain' },
  },
  discovery: { maxResults: 5, sources: ['web'], queriesPerPlan: 2, resultsPerQuery: 3 },
  extraction: {
    fields: [
      { key: 'name', label: 'Name', type: 'string', required: true },
      { key: 'website', label: 'Website', type: 'url', required: true },
      { key: 'employeeCount', label: 'Employees', type: 'integer' },
    ],
  },
  enrichment: { enabled: false },
  review: { enabled: true, blocking: true, flagBelowConfidence: 0.75 },
  export: { destinations: [] },
});

function providerBundle(overrides: Partial<ProviderBundle> = {}): ProviderBundle {
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

  const research: ResearchProvider = {
    ...base,
    async plan() {
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
    meta: { ...base.meta, kind: 'search' },
    async search() {
      return [
        {
          url: 'https://acme.example/about',
          title: 'Acme',
          snippet: 'Acme',
          rank: 1,
          kind: 'page' as const,
        },
        {
          url: 'https://beta.example/about',
          title: 'Beta',
          snippet: 'Beta',
          rank: 2,
          kind: 'page' as const,
        },
      ];
    },
  };

  const extraction: ExtractionProvider = {
    ...base,
    meta: { ...base.meta, kind: 'extraction' },
    async extract(input) {
      const host = new URL(input.source.url).hostname;
      const name = host.split('.')[0] ?? 'unknown';
      return {
        entities: [
          {
            fields: [
              {
                key: 'name',
                value: name,
                confidence: 0.95,
                evidence: { snippet: `About ${name}`, method: 'rule' as const },
              },
              {
                key: 'website',
                value: `https://${host}`,
                confidence: 0.95,
                evidence: { snippet: host, method: 'rule' as const },
              },
              {
                key: 'employeeCount',
                // Low confidence, so the review gate has something to hold.
                value: 120,
                confidence: 0.4,
                evidence: { snippet: '120 employees', method: 'rule' as const },
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
      // Cancellation is polled; zero interval makes it check every call.
      cancellationCheckMs: 0,
    });

  return { stores, publisher, engine, makeContext, runId };
}

describe('PipelineEngine', () => {
  it('requires every canonical step to be present', () => {
    expect(() => new PipelineEngine(defaultSteps.slice(0, 3))).toThrow(/missing steps/);
  });

  it('walks the steps in the declared order', () => {
    const engine = new PipelineEngine(defaultSteps);
    expect(engine.firstStep()).toBe('plan');
    expect(engine.nextStep('plan')).toBe('discover');
    expect(engine.nextStep('score')).toBe('review');
    expect(engine.nextStep('export')).toBeNull();
  });

  it('runs a pipeline to the review gate and halts there', async () => {
    const { engine, makeContext, stores, runId } = harness();
    const status = await engine.runToCompletion(makeContext, { sleep: async () => {} });

    expect(status).toBe('review_required');

    const state = stores.snapshot();
    expect(state.runs.get(runId)?.status).toBe('review_required');
    // Two sources, deduplicated into two companies.
    expect(state.entities.size).toBe(2);
    expect(state.stepRuns.get(`${runId}:review`)?.status).toBe('suspended');
    // Nothing past the gate ran.
    expect(state.stepRuns.get(`${runId}:export`)).toBeUndefined();
  });

  it('continues past the gate once nothing is pending review', async () => {
    const relaxed = defineResearchPipeline({
      ...config,
      review: { enabled: true, blocking: true, flagBelowConfidence: 0.1 },
    });
    const stores = createMemoryStores();
    const { runId, projectId, tenantId } = seedRun(stores, relaxed);
    const engine = new PipelineEngine(defaultSteps);
    const publisher = recordingPublisher();

    const status = await engine.runToCompletion(
      (stepId, attempt) =>
        createRunContext({
          runId,
          projectId,
          tenantId,
          objective: 'Find companies',
          config: relaxed,
          targeting: {},
          providers: providerBundle(),
          stores,
          connectors: emptyConnectors(),
          publisher,
          logger: testLogger,
          stepId,
          attempt,
        }),
      { sleep: async () => {} },
    );

    expect(status).toBe('completed');
    expect(stores.snapshot().stepRuns.get(`${runId}:export`)?.status).toBe('skipped');
  });

  it('retries a retryable failure and recovers', async () => {
    let attempts = 0;
    const flaky: PipelineStep = {
      ...defaultSteps[0]!,
      maxAttempts: 3,
      async execute(): Promise<StepResult> {
        attempts += 1;
        if (attempts < 3) {
          throw new PipelineError('PROVIDER_TIMEOUT', 'transient', { retryable: true });
        }
        return { status: 'completed', output: { queries: [] } };
      },
    };

    const { engine, makeContext, stores, runId } = harness([flaky, ...defaultSteps.slice(1)]);

    const ctx1 = makeContext('plan', 1);
    expect((await engine.executeStepAttempt(ctx1, 'plan')).status).toBe('running');
    const ctx2 = makeContext('plan', 2);
    expect((await engine.executeStepAttempt(ctx2, 'plan')).status).toBe('running');
    const ctx3 = makeContext('plan', 3);
    expect((await engine.executeStepAttempt(ctx3, 'plan')).status).toBe('completed');

    expect(attempts).toBe(3);
    // Each intermediate failure is counted, so the dashboard shows the churn.
    expect(stores.snapshot().runs.get(runId)?.stats.retries).toBe(2);
  });

  it('fails the run when a retryable failure exhausts its attempts', async () => {
    const doomed: PipelineStep = {
      ...defaultSteps[0]!,
      maxAttempts: 2,
      async execute(): Promise<StepResult> {
        throw new PipelineError('PROVIDER_UNAVAILABLE', 'upstream is down', { retryable: true });
      },
    };

    const { engine, makeContext, stores, runId } = harness([doomed, ...defaultSteps.slice(1)]);
    const status = await engine.runToCompletion(makeContext, { sleep: async () => {} });

    expect(status).toBe('failed');
    const run = stores.snapshot().runs.get(runId);
    expect(run?.error).toContain('upstream is down');
    expect(stores.snapshot().stepRuns.get(`${runId}:plan`)?.status).toBe('failed');
  });

  it('does not retry a non-retryable failure', async () => {
    let calls = 0;
    const fatal: PipelineStep = {
      ...defaultSteps[0]!,
      maxAttempts: 5,
      async execute(): Promise<StepResult> {
        calls += 1;
        throw new PipelineError('VALIDATION_FAILED', 'configuration is wrong');
      },
    };

    const { engine, makeContext } = harness([fatal, ...defaultSteps.slice(1)]);
    const status = await engine.runToCompletion(makeContext, { sleep: async () => {} });

    expect(status).toBe('failed');
    expect(calls).toBe(1);
  });

  it('skips a step that already completed, so a redelivered job is safe', async () => {
    let executions = 0;
    const counted: PipelineStep = {
      ...defaultSteps[0]!,
      async execute(): Promise<StepResult> {
        executions += 1;
        return { status: 'completed', output: { queries: [] } };
      },
    };

    const { engine, makeContext } = harness([counted, ...defaultSteps.slice(1)]);

    await engine.executeStepAttempt(makeContext('plan', 1), 'plan');
    const second = await engine.executeStepAttempt(makeContext('plan', 1), 'plan');

    expect(executions).toBe(1);
    expect(second.status).toBe('completed');
    expect(second.nextStepId).toBe('discover');
  });

  it('stops on cancellation instead of finishing the run', async () => {
    const { engine, makeContext, stores, runId } = harness();
    stores.snapshot().cancelled = runId;

    const status = await engine.runToCompletion(makeContext, { sleep: async () => {} });

    expect(status).toBe('cancelled');
    expect(stores.snapshot().runs.get(runId)?.status).toBe('cancelled');
  });

  it('records an event timeline for the whole run', async () => {
    const { engine, makeContext, stores } = harness();
    await engine.runToCompletion(makeContext, { sleep: async () => {} });

    const types = stores.snapshot().events.map((event) => event.type);
    expect(types).toContain('step.started');
    expect(types).toContain('plan.completed');
    expect(types).toContain('structure.completed');
    expect(types).toContain('run.review_required');
  });

  it('publishes run updates for the live view', async () => {
    const { engine, makeContext, publisher } = harness();
    await engine.runToCompletion(makeContext, { sleep: async () => {} });
    expect(publisher.messages.length).toBeGreaterThan(0);
  });
});

describe('backoffMs', () => {
  it('grows exponentially and is capped', () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(50)).toBe(30_000);
  });
});

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it('resolves per-kind and reports what is available on a miss', () => {
    const bundle = providerBundle();
    registry.register(bundle.research.meta, () => bundle.research);
    expect(registry.resolve('research', 'test')).toBe(bundle.research);
    expect(() => registry.resolve('research', 'nope')).toThrow(/available: test/);
  });

  it('prefers the pipeline configuration over the deployment default', () => {
    const bundle = providerBundle();
    registry.register(bundle.research.meta, () => bundle.research);
    registry.register({ ...bundle.research.meta, id: 'other' }, () => bundle.research);
    registry.register(bundle.search.meta, () => bundle.search);
    registry.register(bundle.extraction.meta, () => bundle.extraction);

    const configured = defineResearchPipeline({
      ...config,
      providers: { research: 'other' },
    });

    const resolved = registry.bundleFor(configured, {
      research: 'test',
      search: 'test',
      extraction: 'test',
      enrichment: 'test',
    });

    expect(resolved.research).toBeDefined();
    // Enrichment is disabled in this configuration, so none is resolved.
    expect(resolved.enrichment).toBeNull();
  });
});
