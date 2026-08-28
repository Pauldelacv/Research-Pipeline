import type { PipelineRegistry } from '@frp/config';
import { competitiveIntelligencePipeline } from '@frp/example-competitive-intelligence';
import { leadGenerationPipeline } from '@frp/example-lead-generation';
import { marketResearchPipeline } from '@frp/example-market-research';

/**
 * Pipeline templates this deployment offers.
 *
 * This is the file a Forward Deployed Engineer edits when standing up a
 * client: import their configuration package, register it, deploy. Nothing
 * else in the application needs to change — the create-research form, the
 * results table columns and the scoring panel are all derived from whatever
 * is registered here.
 */
export function registerPipelines(registry: PipelineRegistry): PipelineRegistry {
  return registry.registerAll([
    leadGenerationPipeline,
    competitiveIntelligencePipeline,
    marketResearchPipeline,
  ]);
}
