import type { ResearchPipelineConfig, StepId, TargetingValues } from '@frp/schemas';
import { RunCancelledError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ConnectorRegistry } from '../ports/connectors.js';
import type { RunPublisher, StoreBundle } from '../ports/stores.js';
import type { ProviderBundle } from '../providers/types.js';
import type { PipelineContext } from './types.js';

export interface RunContextInput {
  runId: string;
  projectId: string;
  tenantId: string;
  objective: string;
  config: ResearchPipelineConfig;
  targeting: TargetingValues;
  providers: ProviderBundle;
  stores: StoreBundle;
  connectors: ConnectorRegistry;
  publisher: RunPublisher;
  logger: Logger;
  stepId: StepId;
  attempt: number;
  signal?: AbortSignal;
  now?: () => Date;
  /** Cancellation is polled, not pushed; this bounds how often we ask. */
  cancellationCheckMs?: number;
}

/**
 * Builds the capability object handed to a step.
 *
 * Two behaviours are worth calling out:
 *   - `emit` writes the event *and* publishes it, so the run view updates
 *     live without any step knowing that SSE exists.
 *   - `assertNotCancelled` throttles its database read, so a tight per-item
 *     loop can call it freely without turning cancellation into a hot query.
 */
export function createRunContext(input: RunContextInput): PipelineContext {
  const now = input.now ?? (() => new Date());
  const controller = new AbortController();
  const signal = input.signal ?? controller.signal;
  const checkInterval = input.cancellationCheckMs ?? 2_000;

  const logger = input.logger.child({
    runId: input.runId,
    projectId: input.projectId,
    stepId: input.stepId,
    attempt: input.attempt,
  });

  let lastCancellationCheck = 0;
  let cancelled = false;

  return {
    runId: input.runId,
    projectId: input.projectId,
    tenantId: input.tenantId,
    objective: input.objective,
    config: input.config,
    targeting: input.targeting,
    providers: input.providers,
    stores: input.stores,
    connectors: input.connectors,
    publisher: input.publisher,
    logger,
    signal,
    attempt: input.attempt,
    now,

    async emit(event) {
      const record = await input.stores.events.append({
        runId: input.runId,
        stepId: input.stepId,
        level: event.level ?? 'info',
        type: event.type,
        message: event.message,
        data: event.data ?? null,
      });
      await input.publisher.publish(input.runId, { type: 'event', event: record });
      const log = logger[event.level ?? 'info'] ?? logger.info;
      log.call(logger, { eventType: event.type, ...event.data }, event.message);
    },

    async outputOf<T>(stepId: StepId): Promise<T | null> {
      const stepRun = await input.stores.runs.getStepRun(input.runId, stepId);
      return (stepRun?.output as T | undefined) ?? null;
    },

    async assertNotCancelled() {
      if (cancelled) throw new RunCancelledError(input.runId);
      const elapsed = Date.now() - lastCancellationCheck;
      if (elapsed < checkInterval) return;
      lastCancellationCheck = Date.now();
      if (await input.stores.runs.isCancelled(input.runId)) {
        cancelled = true;
        controller.abort();
        throw new RunCancelledError(input.runId);
      }
    },
  };
}
