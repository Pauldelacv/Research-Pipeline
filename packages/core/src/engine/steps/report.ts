import type { FailureScope } from '@frp/schemas';
import { PipelineError, ProviderError, toErrorRecord } from '../../errors.js';
import type { PipelineContext } from '../types.js';

/**
 * Turns the per-item failures a fan-out step tolerated into records an
 * operator can inspect.
 *
 * A step that reports `partial` has, by construction, swallowed something. The
 * warning it surfaces is a sentence; this is the row that says which document
 * it was, which provider refused, and what the provider actually replied — the
 * difference between "extraction failed for a source" and a fix.
 */
export async function recordItemFailures<T>(
  ctx: PipelineContext,
  scope: FailureScope,
  failures: ReadonlyArray<{ item: T; error: unknown }>,
  describe: (item: T) => { id: string | null; label: string | null; provider?: string | null },
  operation: string,
): Promise<void> {
  for (const { item, error } of failures) {
    const record = toErrorRecord(error);
    const target = describe(item);
    await ctx.recordFailure({
      scope,
      code: record.code,
      message: record.message,
      retryable: record.retryable,
      provider: error instanceof ProviderError ? error.provider : (target.provider ?? null),
      operation,
      targetId: target.id,
      targetLabel: target.label,
      detail: error instanceof PipelineError ? error.details : undefined,
    });
  }
}
