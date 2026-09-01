'use client';

import { Empty, Mono, StatusPill } from '@/components/ui/primitives';
import { FAILURE_SCOPE_LABEL, cn, formatTimestamp } from '@/lib/format';
import { useRunFailures } from '@/lib/hooks';
import { STEP_LABELS, type RunFailure } from '@frp/schemas';
import { useMemo, useState } from 'react';

/**
 * Failure inspection.
 *
 * The question this view answers is the one an operator actually has when a
 * run goes wrong: *what* failed, on *which* document or entity, at which
 * stage, how many attempts were spent on it, and what the provider said back.
 * Answering it here rather than in `docker compose logs -f worker` is the
 * whole point — a failed run should be explainable from the run.
 *
 * Everything shown is recorded state. The provider response was redacted when
 * it was written, so nothing here can leak a credential that was echoed back
 * in an error body.
 */
export function RunFailures({ runId, live }: { runId: string; live: boolean }) {
  const query = useRunFailures(runId, { enabled: true, live });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scope, setScope] = useState<string>('all');

  const failures = useMemo(() => query.data?.items ?? [], [query.data]);
  const scopes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const failure of failures) {
      counts.set(failure.scope, (counts.get(failure.scope) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [failures]);

  const visible = scope === 'all' ? failures : failures.filter((f) => f.scope === scope);

  if (failures.length === 0) {
    return (
      <Empty
        title={query.isLoading ? 'Loading failures…' : 'No failures recorded'}
        hint="Every provider error, dropped source and failed destination lands here with the response that caused it — including the ones a step tolerated and kept going."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-3 py-1.5">
        <span className="text-[10px] tracking-[0.08em] text-[var(--color-ink-faint)] uppercase">
          Scope
        </span>
        <FilterChip
          label="all"
          count={failures.length}
          active={scope === 'all'}
          onClick={() => setScope('all')}
        />
        {scopes.map(([id, count]) => (
          <FilterChip
            key={id}
            label={FAILURE_SCOPE_LABEL[id] ?? id}
            count={count}
            active={scope === id}
            onClick={() => setScope(id)}
          />
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <ul className="flex flex-col">
          {visible.map((failure) => (
            <FailureRow
              key={failure.id}
              failure={failure}
              expanded={expanded === failure.id}
              onToggle={() => setExpanded(expanded === failure.id ? null : failure.id)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function FailureRow({
  failure,
  expanded,
  onToggle,
}: {
  failure: RunFailure;
  expanded: boolean;
  onToggle: () => void;
}) {
  // A tolerated item failure and a step that will retry are both survivable;
  // a step that is out of attempts is what actually ended the run.
  const terminal = failure.scope === 'step' && !failure.willRetry;

  return (
    <li className="border-b border-[var(--color-line)] last:border-b-0">
      <button
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-raised)]"
      >
        <Mono className="w-[62px] shrink-0 text-[var(--color-ink-faint)]">
          {formatTimestamp(failure.createdAt).split(', ')[1] ?? ''}
        </Mono>
        <Mono
          className={cn(
            'w-[150px] shrink-0 truncate',
            terminal ? 'text-[var(--color-danger)]' : 'text-[var(--color-warn)]',
          )}
        >
          {failure.code}
        </Mono>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink)]">
          {failure.message}
        </span>
        {failure.targetLabel ? (
          <span className="hidden max-w-[220px] shrink-0 truncate text-[11px] text-[var(--color-ink-faint)] lg:inline">
            {failure.targetLabel}
          </span>
        ) : null}
        <Mono className="w-[76px] shrink-0 text-right text-[var(--color-ink-faint)]">
          {failure.stepId}
        </Mono>
      </button>

      {expanded ? (
        <div className="border-t border-[var(--color-line)] bg-[var(--color-base)] px-3 py-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] sm:grid-cols-3">
            <Detail label="Pipeline stage" value={STEP_LABELS[failure.stepId]} />
            <Detail label="Scope" value={FAILURE_SCOPE_LABEL[failure.scope] ?? failure.scope} />
            <Detail label="Provider" value={failure.provider ?? 'none'} mono />
            <Detail label="Operation" value={failure.operation ?? '—'} mono />
            <Detail
              label="Attempt"
              value={`${failure.attempt} of ${failure.maxAttempts}${
                failure.willRetry ? ' · retried' : ''
              }`}
            />
            <Detail label="Retryable" value={failure.retryable ? 'yes' : 'no'} />
            <Detail label="Timestamp" value={formatTimestamp(failure.createdAt)} />
            {failure.targetId ? (
              <Detail label="Entity / source id" value={failure.targetId} mono />
            ) : null}
          </dl>

          {failure.targetLabel ? (
            <p className="mt-2 border-l-2 border-[var(--color-line-strong)] pl-2 text-[11px] break-all text-[var(--color-ink-muted)]">
              {failure.targetLabel}
            </p>
          ) : null}

          <p className="mt-2 text-[12px] text-[var(--color-danger)]">{failure.message}</p>

          {failure.detail ? (
            <>
              <p className="mt-2 text-[10px] tracking-[0.08em] text-[var(--color-ink-faint)] uppercase">
                Provider response (redacted)
              </p>
              <pre className="mt-1 max-h-64 overflow-auto border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-ink-muted)]">
                {JSON.stringify(failure.detail, null, 2)}
              </pre>
            </>
          ) : (
            <p className="mt-2 text-[11px] text-[var(--color-ink-faint)]">
              The provider returned no response body for this failure.
            </p>
          )}

          <div className="mt-2 flex items-center gap-2">
            <StatusPill
              tone={terminal ? 'danger' : 'warn'}
              label={terminal ? 'ended the step' : failure.willRetry ? 'retried' : 'tolerated'}
            />
            <span className="text-[11px] text-[var(--color-ink-faint)]">
              {terminal
                ? 'No attempts remained, or the error was not retryable.'
                : failure.willRetry
                  ? 'The step was scheduled for another attempt after this failure.'
                  : 'The step continued without this item and reported a partial result.'}
            </span>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[10px] tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
        {label}
      </dt>
      <dd
        className={cn(
          'truncate text-[var(--color-ink)]',
          mono && 'font-[family-name:var(--font-mono)]',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-1.5 py-0.5 text-[11px]',
        active
          ? 'bg-[var(--color-raised)] text-[var(--color-ink)]'
          : 'text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]',
      )}
    >
      {label}
      <span className="tnum ml-1 text-[var(--color-ink-faint)]">{count}</span>
    </button>
  );
}
