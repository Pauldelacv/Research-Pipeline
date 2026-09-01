import { env } from '@frp/config';
import { ProviderRegistry, type ExtractionProvider } from '@frp/core';
import {
  BrightDataEnrichmentProvider,
  BrightDataExtractionProvider,
  BrightDataSearchProvider,
} from './bright-data/index.js';
import { LlmExtractionProvider, LlmResearchProvider } from './llm/index.js';
import { OpenRouterExtractionProvider, OpenRouterResearchProvider } from './openrouter/index.js';
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

  // A deployment that sets the price overrides means them for whichever model
  // it actually runs, so both model adapters read the same pair.
  const priceOverride = {
    ...(config.LLM_PRICE_INPUT_PER_MTOK !== undefined
      ? { inputPerMTok: config.LLM_PRICE_INPUT_PER_MTOK }
      : {}),
    ...(config.LLM_PRICE_OUTPUT_PER_MTOK !== undefined
      ? { outputPerMTok: config.LLM_PRICE_OUTPUT_PER_MTOK }
      : {}),
  };

  const llmOptions = {
    apiKey: config.ANTHROPIC_API_KEY ?? '',
    model: config.LLM_MODEL,
    price: priceOverride,
    ...(config.LLM_BASE_URL ? { baseUrl: config.LLM_BASE_URL } : {}),
  };

  const openRouterOptions = {
    apiKey: config.OPENROUTER_API_KEY ?? '',
    model: config.OPENROUTER_MODEL,
    baseUrl: config.OPENROUTER_BASE_URL,
    appName: config.OPENROUTER_APP_NAME,
    price: priceOverride,
    ...(config.OPENROUTER_SITE_URL ? { siteUrl: config.OPENROUTER_SITE_URL } : {}),
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

  registry.register(
    {
      id: 'openrouter',
      kind: 'research',
      label: 'OpenRouter research planner',
      description:
        `Query planning through any OpenRouter model (currently ${config.OPENROUTER_MODEL}). ` +
        'Requires OPENROUTER_API_KEY.',
      requiresCredentials: true,
    },
    () => new OpenRouterResearchProvider(openRouterOptions),
  );

  registry.register(
    {
      id: 'openrouter',
      kind: 'extraction',
      label: 'OpenRouter extraction',
      description:
        `Schema-constrained extraction with evidence via ${config.OPENROUTER_MODEL}. ` +
        'Requires OPENROUTER_API_KEY.',
      requiresCredentials: true,
    },
    () => new OpenRouterExtractionProvider(openRouterOptions),
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
      // a model provider is required and fails loudly when unconfigured.
      // Anthropic wins when both are configured; OpenRouter covers the
      // deployment that only has an OpenRouter key.
      const delegate: ExtractionProvider =
        !config.ANTHROPIC_API_KEY && config.OPENROUTER_API_KEY
          ? new OpenRouterExtractionProvider(openRouterOptions)
          : new LlmExtractionProvider(llmOptions);
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
export * from './openrouter/index.js';
export * from './bright-data/index.js';
export * from './pricing.js';
