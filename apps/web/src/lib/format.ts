import type { JsonValue, RunStatus, StepStatus } from '@frp/schemas';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Compact durations: operators read "1m 24s", not "84000ms". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const seconds = Math.round(diff / 1_000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatValue(value: JsonValue | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'object') return JSON.stringify(value);
  // ISO timestamps read better as dates in a dense table.
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString();
  }
  return value;
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  draft: 'Draft',
  queued: 'Queued',
  running: 'Running',
  review_required: 'Review required',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'idle';

export const RUN_STATUS_TONE: Record<RunStatus, Tone> = {
  draft: 'idle',
  queued: 'idle',
  running: 'info',
  review_required: 'warn',
  completed: 'ok',
  failed: 'danger',
  cancelled: 'idle',
};

export const STEP_STATUS_TONE: Record<StepStatus, Tone> = {
  pending: 'idle',
  running: 'info',
  completed: 'ok',
  partial: 'warn',
  suspended: 'warn',
  failed: 'danger',
  skipped: 'idle',
};

export function scoreTone(
  score: number | null,
  thresholds: { qualified: number; review: number },
): Tone {
  if (score === null) return 'idle';
  if (score >= thresholds.qualified) return 'ok';
  if (score >= thresholds.review) return 'warn';
  return 'danger';
}

export function confidenceTone(confidence: number, threshold: number): Tone {
  if (confidence >= threshold) return 'ok';
  if (confidence >= threshold * 0.75) return 'warn';
  return 'danger';
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Money, at the scale a single provider call actually costs.
 *
 * A run's total is dollars; one extraction is fractions of a cent. Printing
 * both with two decimals turns every individual call into "$0.00", which reads
 * as free — so small figures keep enough precision to be compared, and larger
 * ones drop it.
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Token counts get long fast; an operator wants the magnitude. */
export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined) return '—';
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export const FAILURE_SCOPE_LABEL: Record<string, string> = {
  step: 'Step',
  query: 'Query',
  source: 'Source',
  entity: 'Entity',
  destination: 'Destination',
};

/** Where a stored cost figure came from, spelled out rather than implied. */
export const COST_SOURCE_LABEL: Record<string, string> = {
  reported: 'billed by the provider',
  estimated: 'estimated from tokens',
  unknown: 'not priced',
};
