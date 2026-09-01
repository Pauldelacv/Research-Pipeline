'use client';

import { Empty, Mono, Panel } from '@/components/ui/primitives';
import {
  COST_SOURCE_LABEL,
  cn,
  formatCost,
  formatDuration,
  formatTimestamp,
  formatTokens,
} from '@/lib/format';
import { useRunUsage } from '@/lib/hooks';
import { STEP_LABELS, type StepId, type UsageBreakdownRow } from '@frp/schemas';

/**
 * What a run cost.
 *
 * Three levels, because three different questions get asked: the totals answer
 * "was this run worth it", the per-provider table answers "what should I
 * change", and the call log answers "why is that number so large".
 *
 * The view is careful about one thing above all: it never presents an estimate
 * as a bill. Rows the provider priced itself are labelled as such; rows derived
 * from a token count and a price table say so; and a total that omits unpriced
 * calls is shown as a floor rather than as the answer.
 */
export function RunUsage({ runId, live }: { runId: string; live: boolean }) {
  const query = useRunUsage(runId, { enabled: true, live });
  const summary = query.data;

  if (!summary || summary.totals.requests === 0) {
    return (
      <Empty
        title={query.isLoading ? 'Loading usage…' : 'No provider calls recorded yet'}
        hint="Every upstream call a run makes is counted here — tokens, latency and cost per provider and per step."
      />
    );
  }

  const { totals } = summary;
  const calls = summary.calls ?? [];

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Estimated cost"
          value={formatCost(totals.costUsd)}
          hint={totals.partialCost ? 'at least — some calls are unpriced' : undefined}
          tone={totals.partialCost ? 'warn' : 'ok'}
        />
        <Stat label="Provider calls" value={String(totals.requests)} />
        <Stat
          label="Failed calls"
          value={String(totals.failures)}
          tone={totals.failures > 0 ? 'danger' : undefined}
        />
        <Stat label="Input tokens" value={formatTokens(totals.inputTokens)} />
        <Stat label="Output tokens" value={formatTokens(totals.outputTokens)} />
        <Stat
          label="Time in providers"
          value={formatDuration(totals.latencyMs)}
          hint="summed across parallel calls"
        />
      </div>

      {totals.partialCost ? (
        <p className="border-l-2 border-[var(--color-warn)] bg-[var(--color-warn)]/5 py-1 pl-2 text-[11px] text-[var(--color-warn)]">
          Some calls could not be priced — either the provider reports no cost and the model is
          absent from the price table, or it bills per request rather than per token. The total
          above is a lower bound. Set <Mono>LLM_PRICE_INPUT_PER_MTOK</Mono> and{' '}
          <Mono>LLM_PRICE_OUTPUT_PER_MTOK</Mono> to price your model explicitly.
        </p>
      ) : null}

      <Panel title="By provider and operation">
        <BreakdownTable rows={summary.byProvider} groupBy="provider" />
      </Panel>

      <Panel title="By pipeline stage">
        <BreakdownTable rows={summary.byStep} groupBy="step" />
      </Panel>

      {calls.length > 0 ? (
        <Panel title={`Calls (${calls.length} most recent)`}>
          <div className="max-h-96 overflow-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 bg-[var(--color-surface)]">
                <tr className="border-b border-[var(--color-line)] text-left text-[10px] tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
                  <th className="w-24 px-3 py-1.5 font-medium">When</th>
                  <th className="w-24 px-3 py-1.5 font-medium">Provider</th>
                  <th className="w-20 px-3 py-1.5 font-medium">Operation</th>
                  <th className="px-3 py-1.5 font-medium">Model</th>
                  <th className="w-20 px-3 py-1.5 text-right font-medium">In</th>
                  <th className="w-20 px-3 py-1.5 text-right font-medium">Out</th>
                  <th className="w-20 px-3 py-1.5 text-right font-medium">Latency</th>
                  <th className="w-24 px-3 py-1.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr
                    key={call.id}
                    className={cn(
                      'border-b border-[var(--color-line)] last:border-b-0',
                      call.outcome === 'failure' && 'bg-[var(--color-danger)]/5',
                    )}
                  >
                    <td className="px-3 py-1 text-[var(--color-ink-faint)]">
                      <Mono>{formatTimestamp(call.createdAt).split(', ')[1] ?? ''}</Mono>
                    </td>
                    <td className="px-3 py-1">
                      <Mono
                        className={
                          call.outcome === 'failure'
                            ? 'text-[var(--color-danger)]'
                            : 'text-[var(--color-ink-muted)]'
                        }
                      >
                        {call.provider}
                      </Mono>
                    </td>
                    <td className="px-3 py-1 text-[var(--color-ink-muted)]">{call.operation}</td>
                    <td className="max-w-0 truncate px-3 py-1 text-[var(--color-ink-faint)]">
                      {call.model ?? '—'}
                      {call.errorCode ? (
                        <span className="ml-2 text-[var(--color-danger)]">{call.errorCode}</span>
                      ) : null}
                    </td>
                    <td className="tnum px-3 py-1 text-right text-[var(--color-ink-faint)]">
                      {formatTokens(call.inputTokens)}
                    </td>
                    <td className="tnum px-3 py-1 text-right text-[var(--color-ink-faint)]">
                      {formatTokens(call.outputTokens)}
                    </td>
                    <td className="tnum px-3 py-1 text-right text-[var(--color-ink-faint)]">
                      {formatDuration(call.latencyMs)}
                    </td>
                    <td
                      className="tnum px-3 py-1 text-right text-[var(--color-ink)]"
                      title={COST_SOURCE_LABEL[call.costSource]}
                    >
                      {formatCost(call.costUsd)}
                      {call.costSource === 'estimated' ? (
                        <span className="ml-1 text-[var(--color-ink-faint)]">~</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function BreakdownTable({
  rows,
  groupBy,
}: {
  rows: UsageBreakdownRow[];
  groupBy: 'provider' | 'step';
}) {
  if (rows.length === 0) {
    return <p className="px-3 py-3 text-[11px] text-[var(--color-ink-faint)]">Nothing recorded.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-[var(--color-line)] text-left text-[10px] tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
            <th className="px-3 py-1.5 font-medium">{groupBy === 'step' ? 'Stage' : 'Provider'}</th>
            {groupBy === 'provider' ? (
              <>
                <th className="w-24 px-3 py-1.5 font-medium">Operation</th>
                <th className="w-20 px-3 py-1.5 font-medium">Stage</th>
              </>
            ) : null}
            <th className="w-20 px-3 py-1.5 text-right font-medium">Calls</th>
            <th className="w-20 px-3 py-1.5 text-right font-medium">Failed</th>
            <th className="w-20 px-3 py-1.5 text-right font-medium">In</th>
            <th className="w-20 px-3 py-1.5 text-right font-medium">Out</th>
            <th className="w-24 px-3 py-1.5 text-right font-medium">Latency</th>
            <th className="w-24 px-3 py-1.5 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.provider}-${row.operation}-${row.stepId ?? index}`}
              className="border-b border-[var(--color-line)] last:border-b-0"
            >
              <td className="px-3 py-1.5">
                {groupBy === 'step' ? (
                  stageLabel(row.stepId)
                ) : (
                  <>
                    <Mono className="text-[var(--color-ink)]">{row.provider}</Mono>
                    {row.model ? (
                      <span className="ml-2 text-[11px] text-[var(--color-ink-faint)]">
                        {row.model}
                      </span>
                    ) : null}
                  </>
                )}
              </td>
              {groupBy === 'provider' ? (
                <>
                  <td className="px-3 py-1.5 text-[var(--color-ink-muted)]">{row.operation}</td>
                  <td className="px-3 py-1.5 text-[var(--color-ink-faint)]">
                    <Mono>{row.stepId ?? '—'}</Mono>
                  </td>
                </>
              ) : null}
              <td className="tnum px-3 py-1.5 text-right">{row.requests}</td>
              <td
                className={cn(
                  'tnum px-3 py-1.5 text-right',
                  row.failures > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-faint)]',
                )}
              >
                {row.failures}
              </td>
              <td className="tnum px-3 py-1.5 text-right text-[var(--color-ink-faint)]">
                {formatTokens(row.inputTokens)}
              </td>
              <td className="tnum px-3 py-1.5 text-right text-[var(--color-ink-faint)]">
                {formatTokens(row.outputTokens)}
              </td>
              <td className="tnum px-3 py-1.5 text-right text-[var(--color-ink-faint)]">
                {formatDuration(row.latencyMs)}
              </td>
              <td className="tnum px-3 py-1.5 text-right">
                {formatCost(row.costUsd)}
                {row.partialCost ? (
                  <span className="ml-1 text-[var(--color-warn)]" title="some calls are unpriced">
                    +
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function stageLabel(stepId: string | null): string {
  if (!stepId) return 'Unattributed';
  return STEP_LABELS[stepId as StepId] ?? stepId;
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  return (
    <div
      className="border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
      style={{ borderRadius: 'var(--radius-md)' }}
    >
      <p className="text-[10px] tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
        {label}
      </p>
      <p
        className={cn(
          'tnum mt-0.5 text-[16px]',
          tone === 'ok' && 'text-[var(--color-ink)]',
          tone === 'warn' && 'text-[var(--color-warn)]',
          tone === 'danger' && 'text-[var(--color-danger)]',
          !tone && 'text-[var(--color-ink)]',
        )}
      >
        {value}
      </p>
      {hint ? <p className="text-[10px] text-[var(--color-ink-faint)]">{hint}</p> : null}
    </div>
  );
}
