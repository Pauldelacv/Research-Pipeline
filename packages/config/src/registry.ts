import type { ResearchPipelineConfig } from '@frp/schemas';

/**
 * The set of pipeline templates a deployment offers.
 *
 * A deployment registers the configurations it ships with at boot (see
 * `apps/api/src/pipelines.ts`). Projects reference a template by key and store
 * their own resolved copy, so editing a template never mutates history.
 */
export class PipelineRegistry {
  private readonly configs = new Map<string, ResearchPipelineConfig>();

  register(config: ResearchPipelineConfig): this {
    if (this.configs.has(config.key)) {
      throw new Error(`pipeline configuration "${config.key}" is already registered`);
    }
    this.configs.set(config.key, config);
    return this;
  }

  registerAll(configs: ResearchPipelineConfig[]): this {
    for (const config of configs) this.register(config);
    return this;
  }

  get(key: string): ResearchPipelineConfig | undefined {
    return this.configs.get(key);
  }

  require(key: string): ResearchPipelineConfig {
    const config = this.configs.get(key);
    if (!config) {
      throw new Error(
        `unknown pipeline configuration "${key}" (registered: ${this.keys().join(', ') || 'none'})`,
      );
    }
    return config;
  }

  list(): ResearchPipelineConfig[] {
    return [...this.configs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  keys(): string[] {
    return [...this.configs.keys()];
  }
}
