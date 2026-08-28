import type {
  ResearchPipelineConfig,
  StepId,
  StepMetrics,
  StepStatus,
  TargetingValues,
} from '@frp/schemas';
import type { Logger } from '../logger.js';
import type { ConnectorRegistry } from '../ports/connectors.js';
import type { RunPublisher, StoreBundle } from '../ports/stores.js';
import type { ProviderBundle } from '../providers/types.js';

/**
 * Everything a step is allowed to touch.
 *
 * A step receives capabilities, not globals: stores, providers, connectors, a
 * logger already tagged with the run and step, a clock, and an abort signal.
 * That is what makes each step independently testable and what stops the
 * engine from turning into one large `runResearch()` function.
 */
export interface PipelineContext {
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
  now(): Date;
  signal: AbortSignal;

  /** Which attempt of the current step this is (1-based). */
  attempt: number;

  /** Structured run event. Persisted and pushed to any live SSE subscriber. */
  emit(event: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    type: string;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<void>;

  /** Reads the recorded output of an earlier step in this run. */
  outputOf<T = Record<string, unknown>>(stepId: StepId): Promise<T | null>;

  /** Throws `RunCancelledError` when the operator has cancelled the run. */
  assertNotCancelled(): Promise<void>;
}

export interface StepResult {
  /**
   * `partial` means the step produced usable output despite recoverable
   * errors — the run continues and the warnings surface in the UI.
   * `suspended` halts the run until an external signal resumes it.
   */
  status: Extract<StepStatus, 'completed' | 'partial' | 'suspended' | 'skipped'>;
  metrics?: Partial<StepMetrics>;
  warnings?: string[];
  /** Small, serialisable hand-off to later steps. Never bulk data. */
  output?: Record<string, unknown>;
}

export interface PipelineStep {
  id: StepId;
  name: string;
  /**
   * Declares that re-executing this step after a crash converges to the same
   * state. Every step here is idempotent; the flag is explicit so an added
   * step cannot silently become unsafe to retry.
   */
  idempotent: boolean;
  maxAttempts: number;
  /** Milliseconds before the step is aborted. */
  timeoutMs: number;
  execute(ctx: PipelineContext): Promise<StepResult>;
}

export interface StepOutcome {
  stepId: StepId;
  status: StepStatus;
  nextStepId: StepId | null;
  metrics: StepMetrics;
  warnings: string[];
  error?: { code: string; message: string; retryable: boolean };
}
