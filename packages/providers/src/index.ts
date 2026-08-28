import { env } from '@frp/config';
import { ProviderRegistry, type ExtractionProvider } from '@frp/core';
import {
  BrightDataEnrichmentProvider,
  BrightDataExtractionProvider,
  BrightDataSearchProvider,
} from './bright-data/index.js';
import { LlmExtractionProvider, LlmResearchProvider } from './llm/index.js';
import {
  MockEnrichmentProvider,
  MockExtractionProvider,
  MockResearchProvider,
  MockSearchProvider,
  type MockProviderOptions,
} from './mock/index.js';

/**
 * Provider registration.
 *
 * Factories are lazy: registering the Bright Data adapter does not construct
 * it, so a deployment with no credentials still boots and still lists what is
 * available. Construction — and therefore the `NotConfiguredError` — happens
 * only when a run actually selects that provider.
 */
export function createProviderRegistry(
  overrides: { mock?: Partial<MockProviderOptions> } = {},
): ProviderRegistry {
  const config = env();
  const registry = new ProviderRegistry();

  const mockOptions: MockProviderOptions = {
    seed: config.MOCK_SEED,
    latencyMs: config.MOCK_LATENCY_MS,
    failureRate: config.MOCK_FAILURE_RATE,
    deterministic: config.MOCK_DETERMINISTIC,
    ...overrides.mock,
  };

  const mockResearch = new MockResearchProvider(mockOptions);
  const mockSearch = new MockSearchProvider(mockOptions);
  const mockExtraction = new MockExtractionProvider(mockOptions);
  const mockEnrichment = new MockEnrichmentProvider(mockOptions);

  registry
    .register(mockResearch.meta, () => mockResearch)
    .register(mockSearch.meta, () => mockSearch)
    .register(mockExtraction.meta, () => mockExtraction)
    .register(mockEnrichment.meta, () => mockEnrichment);

  const llmOptions = {
    apiKey: config.ANTHROPIC_API_KEY ?? '',
    model: config.LLM_MODEL,
    ...(config.LLM_BASE_URL ? { baseUrl: config.LLM_BASE_URL } : {}),
  };

  registry.register(
    {
      id: 'llm',
      kind: 'research',
      label: 'LLM research planner',
      description: 'Schema-validated query planning. Requires ANTHROPIC_API_KEY.',
      requiresCredentials: true,
    },
    () => new LlmResearchProvider(llmOptions),
  );

  registry.register(
    {
      id: 'llm',
      kind: 'extraction',
      label: 'LLM extraction',
      description: 'Schema-constrained extraction with evidence. Requires ANTHROPIC_API_KEY.',
      requiresCredentials: true,
    },
    () => new LlmExtractionProvider(llmOptions),
  );

  const brightDataOptions = {
    apiKey: config.BRIGHT_DATA_API_KEY ?? '',
    baseUrl: config.BRIGHT_DATA_BASE_URL,
    serpZone: config.BRIGHT_DATA_SERP_ZONE,
    unlockerZone: config.BRIGHT_DATA_UNLOCKER_ZONE,
  };

  registry.register(
    {
      id: 'bright-data',
      kind: 'search',
      label: 'Bright Data SERP',
      description: 'Search results via a Bright Data SERP zone. Requires BRIGHT_DATA_API_KEY.',
      requiresCredentials: true,
    },
    () => new BrightDataSearchProvider(brightDataOptions),
  );

  registry.register(
    {
      id: 'bright-data',
      kind: 'extraction',
      label: 'Bright Data Web Unlocker',
      description: 'Fetches blocked pages, then interprets them with the LLM extraction provider.',
      requiresCredentials: true,
    },
    () => {
      // Retrieval is Bright Data's job; interpretation stays with whichever
      // provider can read text. Falling back to mock would fabricate data, so
      // the LLM provider is required and fails loudly when unconfigured.
      const delegate: ExtractionProvider = new LlmExtractionProvider(llmOptions);
      return new BrightDataExtractionProvider(brightDataOptions, delegate);
    },
  );

  registry.register(
    {
      id: 'bright-data',
      kind: 'enrichment',
      label: 'Bright Data datasets',
      description: 'Not implemented — see docs/providers.md.',
      requiresCredentials: true,
    },
    () => new BrightDataEnrichmentProvider(),
  );

  return registry;
}

export * from './mock/index.js';
export * from './llm/index.js';
export * from './bright-data/index.js';
