import { z } from 'zod';
import { stepIdSchema } from './pipeline.js';

/**
 * Recorded pipeline failures.
 *
 * The run event log says *that* something failed; this says everything needed
 * to act on it without opening a worker's stdout: which step, which provider,
 * which document or entity was in hand, how many attempts had been spent, and
 * what the provider actually replied.
 *
 * The provider's reply is stored sanitised. It is the single most useful field
 * when a run breaks and the single most likely place for a bearer token to
 * turn up, so redaction happens before persistence, not before display.
 */

export const failureScopeSchema = z.enum([
  /** The whole step attempt failed. */
  'step',
  /** One planned query failed while the step continued. */
  'query',
  /** One source failed while the step continued. */
  'source',
  /** One entity failed while the step continued. */
  'entity',
  /** One export destination failed. */
  'destination',
]);

export type FailureScope = z.infer<typeof failureScopeSchema>;

export const runFailureSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: stepIdSchema,
  scope: failureScopeSchema,
  /** Which attempt of the step this failure happened on (1-based). */
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  /** True when the engine scheduled another attempt after this failure. */
  willRetry: z.boolean(),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  provider: z.string().nullable(),
  /** Provider-specific verb the call was making: `search`, `extract`, … */
  operation: z.string().nullable(),
  /** Id of the source/entity/destination in hand, when there was one. */
  targetId: z.string().nullable(),
  /** Human-readable label for that target: a URL, an entity name, a query. */
  targetLabel: z.string().nullable(),
  /** Sanitised provider response or error detail. */
  detail: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

export type RunFailure = z.infer<typeof runFailureSchema>;
