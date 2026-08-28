/** Error taxonomy. Every failure that reaches the run record carries a code. */

export type ErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_BAD_RESPONSE'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'CONNECTOR_NOT_CONFIGURED'
  | 'CONNECTOR_FAILED'
  | 'VALIDATION_FAILED'
  | 'STEP_FAILED'
  | 'RUN_CANCELLED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

export class PipelineError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PipelineError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export class ProviderError extends PipelineError {
  readonly provider: string;

  constructor(
    provider: string,
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(code, message, options);
    this.name = 'ProviderError';
    this.provider = provider;
  }
}

/**
 * Thrown when a provider is selected but its credentials are absent.
 *
 * This is deliberately loud and non-retryable: a public repository must never
 * silently degrade to fabricated data because an API key was missing.
 */
export class NotConfiguredError extends ProviderError {
  constructor(provider: string, missing: string[]) {
    super(
      provider,
      'PROVIDER_NOT_CONFIGURED',
      `provider "${provider}" is not configured - missing ${missing.join(', ')}. ` +
        'Set these in your environment, or select the "mock" provider.',
      { retryable: false, details: { missing } },
    );
    this.name = 'NotConfiguredError';
  }
}

export class RunCancelledError extends PipelineError {
  constructor(runId: string) {
    super('RUN_CANCELLED', `run ${runId} was cancelled`, { retryable: false });
    this.name = 'RunCancelledError';
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof PipelineError && error.retryable;
}

export interface ErrorRecord {
  code: string;
  message: string;
  retryable: boolean;
  stack?: string;
}

export function toErrorRecord(error: unknown): ErrorRecord {
  if (error instanceof PipelineError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return { code: 'INTERNAL', message: error.message, retryable: false, stack: error.stack };
  }
  return { code: 'INTERNAL', message: String(error), retryable: false };
}
