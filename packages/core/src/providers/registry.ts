import type { ResearchPipelineConfig } from '@frp/schemas';
import { PipelineError } from '../errors.js';
import type {
  EnrichmentProvider,
  Provider,
  ProviderBundle,
  ProviderKind,
  ProviderMeta,
  ResearchProvider,
  SearchProvider,
  ExtractionProvider,
} from './types.js';

/**
 * Resolves provider ids to implementations.
 *
 * Selection is layered: the pipeline configuration wins, otherwise the
 * deployment default (from the environment) applies. That lets one deployment
 * run most projects on mock data while a single project uses live providers.
 */
export interface ProviderDefaults {
  research: string;
  search: string;
  extraction: string;
  enrichment: string;
}

type AnyProviderFactory = () => Provider;

export class ProviderRegistry {
  private readonly providers = new Map<string, AnyProviderFactory>();
  private readonly metas = new Map<string, ProviderMeta>();

  register(meta: ProviderMeta, factory: AnyProviderFactory): this {
    const key = registryKey(meta.kind, meta.id);
    if (this.providers.has(key)) {
      throw new Error(`provider ${key} is already registered`);
    }
    this.providers.set(key, factory);
    this.metas.set(key, meta);
    return this;
  }

  has(kind: ProviderKind, id: string): boolean {
    return this.providers.has(registryKey(kind, id));
  }

  resolve<T extends Provider>(kind: ProviderKind, id: string): T {
    const factory = this.providers.get(registryKey(kind, id));
    if (!factory) {
      const available = this.list(kind)
        .map((meta) => meta.id)
        .join(', ');
      throw new PipelineError(
        'NOT_FOUND',
        `no ${kind} provider registered under "${id}" (available: ${available || 'none'})`,
      );
    }
    return factory() as T;
  }

  list(kind?: ProviderKind): ProviderMeta[] {
    return [...this.metas.values()]
      .filter((meta) => !kind || meta.kind === kind)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Resolves the full set of providers a run needs. */
  bundleFor(config: ResearchPipelineConfig, defaults: ProviderDefaults): ProviderBundle {
    const pick = (kind: ProviderKind): string => config.providers[kind] ?? defaults[kind];

    return {
      research: this.resolve<ResearchProvider>('research', pick('research')),
      search: this.resolve<SearchProvider>('search', pick('search')),
      extraction: this.resolve<ExtractionProvider>('extraction', pick('extraction')),
      enrichment: config.enrichment.enabled
        ? this.resolve<EnrichmentProvider>('enrichment', pick('enrichment'))
        : null,
    };
  }
}

function registryKey(kind: ProviderKind, id: string): string {
  return `${kind}:${id}`;
}
