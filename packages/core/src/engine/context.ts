import type { ResearchPipelineConfig, StepId, TargetingValues } from '@frp/schemas';
import { RunCancelledError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ConnectorRegistry } from '../ports/connectors.js';
import type { RunPublisher, StoreBundle, UsageWrite } from '../ports/stores.js';
import type {
  ProviderBundle,
  ProviderCallContext,
  ProviderMeta,
  ProviderUsageReport,
} from '../providers/types.js';
import { sanitizeDetail } from '../redact.js';
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
  /** Attempts the step is allowed in total. Used in failure reports. */
  maxAttempts?: number;
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
 *   - `providerCall` hands each provider a context that buffers usage in
 *     memory; the engine flushes it once per step attempt, which keeps
 *     accounting off the hot path and out of every provider's error handling.
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
  const usageBuffer: UsageWrite[] = [];

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
    maxAttempts: input.maxAttempts ?? 1,
    now,

    providerCall(meta: ProviderMeta, options = {}): ProviderCallContext {
      return {
        runId: input.runId,
        attempt: input.attempt,
        logger: logger.child({ provider: meta.id, providerKind: meta.kind }),
        signal,
        recordUsage(usage: ProviderUsageReport) {
          usageBuffer.push({
            runId: input.runId,
            stepId: input.stepId,
            provider: usage.provider ?? meta.id,
            providerKind: usage.providerKind ?? meta.kind,
            operation: usage.operation,
            model: usage.model ?? null,
            inputTokens: nonNegative(usage.inputTokens),
            outputTokens: nonNegative(usage.outputTokens),
            requests: nonNegative(usage.requests) ?? 1,
            costUsd: usage.costUsd ?? null,
            costSource: usage.costSource ?? (usage.costUsd == null ? 'unknown' : 'estimated'),
            latencyMs: nonNegative(usage.latencyMs),
            outcome: usage.outcome ?? 'success',
            errorCode: usage.errorCode ?? null,
            target: usage.target ?? options.target ?? null,
          });
        },
      };
    },

    async flushUsage(): Promise<number> {
      if (usageBuffer.length === 0) return 0;
      const pending = usageBuffer.splice(0, usageBuffer.length);
      try {
        return await input.stores.usage.recordMany(pending);
      } catch (error) {
        // Losing an accounting row must never turn a successful run into a
        // failed one; the loss is logged so it is visible in aggregate.
        logger.warn(
          { rows: pending.length, error: String(error) },
          'failed to persist provider usage',
        );
        return 0;
      }
    },

    async recordFailure(failure): Promise<void> {
      try {
        await input.stores.failures.record({
          runId: input.runId,
          stepId: input.stepId,
          scope: failure.scope,
          attempt: input.attempt,
          maxAttempts: failure.maxAttempts ?? input.maxAttempts ?? 1,
          willRetry: failure.willRetry ?? false,
          code: failure.code,
          message: failure.message.slice(0, 2000),
          retryable: failure.retryable,
          provider: failure.provider ?? null,
          operation: failure.operation ?? null,
          targetId: failure.targetId ?? null,
          targetLabel: failure.targetLabel?.slice(0, 500) ?? null,
          detail: sanitizeDetail(failure.detail),
        });
      } catch (error) {
        logger.warn({ error: String(error) }, 'failed to record run failure');
      }
    },

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

function nonNegative(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}
