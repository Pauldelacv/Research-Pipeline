'use client';

import { EntityPanel } from '@/components/entity-panel';
import { PipelineTimeline } from '@/components/pipeline-progress';
import { ResultsTable } from '@/components/results-table';
import { RunEvents } from '@/components/run-events';
import { RunFailures } from '@/components/run-failures';
import { RunUsage } from '@/components/run-usage';
import { PageHeader } from '@/components/shell';
import {
  Button,
  Dot,
  Empty,
  Meter,
  Mono,
  Panel,
  StatusPill,
  Tabs,
} from '@/components/ui/primitives';
import { api } from '@/lib/api';
import type { ExportRecord } from '@frp/schemas';
import {
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  cn,
  formatCost,
  formatDuration,
  formatRelative,
  formatTimestamp,
  percent,
} from '@/lib/format';
import { useLiveRun, useRunSources } from '@/lib/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';

/**
 * Run view.
 *
 * The left rail is the pipeline itself, streamed from the backend. The right
 * side switches between the structured results, the sources the run looked at,
 * its event log, the failures it recorded and what it spent. The review gate
 * surfaces as a banner with the two actions that actually move the run forward.
 */
type RunTab = 'results' | 'sources' | 'events' | 'failures' | 'usage' | 'exports';

export default function RunPage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;
  const { detail, events, connected } = useLiveRun(runId);
  const client = useQueryClient();

  const [tab, setTab] = useState<RunTab>('results');
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const run = detail?.run;
  const config = run?.configSnapshot;

  async function resume(force = false) {
    setBusy(true);
    setNotice(null);
    try {
      await api.resumeRun(runId, force);
      await client.invalidateQueries({ queryKey: ['run', runId] });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await api.cancelRun(runId);
      await client.invalidateQueries({ queryKey: ['run', runId] });
    } finally {
      setBusy(false);
    }
  }

  async function exportNow(connector: 'csv' | 'json') {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.exportRun(runId, { connector });
      setNotice(`${result.export.entityCount} rows written to ${result.export.location}`);
      await client.invalidateQueries({ queryKey: ['run', runId] });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!run || !config) {
    return (
      <>
        <PageHeader title="Run" subtitle={runId} />
        <div className="flex-1 p-4">
          <Empty title="Loading run…" />
        </div>
      </>
    );
  }

  const isActive = ['queued', 'running'].includes(run.status);

  return (
    <>
      <PageHeader
        title={detail?.project?.name ?? 'Research run'}
        subtitle={detail?.project?.objective}
        meta={
          <>
            <StatusPill
              tone={RUN_STATUS_TONE[run.status]}
              label={RUN_STATUS_LABEL[run.status]}
              pulse={run.status === 'running'}
            />
            <Mono className="text-[var(--color-ink-faint)]">{run.id}</Mono>
            <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-faint)]">
              <Dot tone={connected ? 'ok' : 'idle'} pulse={connected} />
              {connected ? 'live' : isActive ? 'polling' : 'finished'}
            </span>
            <span className="text-[11px] text-[var(--color-ink-faint)]">
              started {formatRelative(run.startedAt)}
              {run.finishedAt
                ? ` · took ${formatDuration(
                    new Date(run.finishedAt).getTime() -
                      new Date(run.startedAt ?? run.finishedAt).getTime(),
                  )}`
                : ''}
            </span>
          </>
        }
        actions={
          <>
            {run.status === 'review_required' ? (
              <Button variant="primary" disabled={busy} onClick={() => void resume(false)}>
                Resume run
              </Button>
            ) : null}
            {isActive ? (
              <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
                Cancel
              </Button>
            ) : null}
            <Button disabled={busy} onClick={() => void exportNow('csv')}>
              Export CSV
            </Button>
            <Button disabled={busy} onClick={() => void exportNow('json')}>
              Export JSON
            </Button>
          </>
        }
      />

      {run.status === 'review_required' ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-4 py-2">
          <Dot tone="warn" />
          <p className="text-[12px] text-[var(--color-warn)]">
            <span className="font-medium">{detail.pendingReview} entities need a decision.</span>{' '}
            The run is paused before export — this is a real gate, not a notification.
          </p>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" onClick={() => setTab('results')}>
              Review them
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void resume(true)}>
              Accept remaining & continue
            </Button>
          </div>
        </div>
      ) : null}

      {run.error ? (
        <div className="shrink-0 border-b border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-2 text-[12px] text-[var(--color-danger)]">
          {run.error}
        </div>
      ) : null}

      {notice ? (
        <div className="shrink-0 border-b border-[var(--color-line)] bg-[var(--color-raised)] px-4 py-1.5 text-[11px] text-[var(--color-ink-muted)]">
          {notice}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Pipeline rail */}
        <div className="flex w-[300px] shrink-0 flex-col overflow-auto border-r border-[var(--color-line)]">
          <div className="border-b border-[var(--color-line)] px-3 py-2">
            <h2 className="text-[10px] font-semibold tracking-[0.1em] text-[var(--color-ink-faint)] uppercase">
              Research pipeline
            </h2>
          </div>
          <PipelineTimeline steps={detail.steps} activeStep={run.currentStep} />

          <div className="mt-2 border-t border-[var(--color-line)] px-3 py-2">
            <h3 className="mb-1.5 text-[10px] font-semibold tracking-[0.1em] text-[var(--color-ink-faint)] uppercase">
              Counters
            </h3>
            <dl className="flex flex-col gap-0.5">
              <Counter label="Sources discovered" value={run.stats.sourcesDiscovered} />
              <Counter label="Candidates extracted" value={run.stats.entitiesExtracted} />
              <Counter label="Entities structured" value={run.stats.entitiesStructured} />
              <Counter label="Valid" value={run.stats.entitiesValid} />
              <Counter label="Flagged" value={run.stats.entitiesFlagged} tone="warn" />
              <Counter label="Approved" value={run.stats.entitiesApproved} tone="ok" />
              <Counter label="Rejected" value={run.stats.entitiesRejected} />
              <Counter label="Exported" value={run.stats.entitiesExported} />
              <Counter label="Provider errors" value={run.stats.providerErrors} tone="danger" />
              <Counter label="Retries" value={run.stats.retries} tone="warn" />
            </dl>
          </div>

          <div className="border-t border-[var(--color-line)] px-3 py-2">
            <h3 className="mb-1.5 text-[10px] font-semibold tracking-[0.1em] text-[var(--color-ink-faint)] uppercase">
              Spend
            </h3>
            <dl className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <dt className="text-[var(--color-ink-faint)]">
                  {detail.usage.partialCost ? 'Cost (at least)' : 'Estimated cost'}
                </dt>
                <dd className="tnum text-[var(--color-ink)]">{formatCost(detail.usage.costUsd)}</dd>
              </div>
              <Counter label="Provider calls" value={detail.usage.requests} />
              <Counter label="Failed calls" value={detail.usage.failures} tone="danger" />
              <button
                onClick={() => setTab('usage')}
                className="mt-1 self-start text-[11px] text-[var(--color-accent)] hover:underline"
              >
                Break it down →
              </button>
            </dl>
          </div>
        </div>

        {/* Work area */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 px-3 pt-2">
            <Tabs
              tabs={[
                {
                  id: 'results' as const,
                  label: config.entity.labelPlural,
                  count: detail.entityCounts
                    ? Object.values(detail.entityCounts).reduce((a, b) => a + b, 0)
                    : undefined,
                },
                { id: 'sources' as const, label: 'Sources', count: run.stats.sourcesDiscovered },
                { id: 'events' as const, label: 'Events', count: events.length },
                { id: 'failures' as const, label: 'Failures', count: detail.failureCount },
                { id: 'usage' as const, label: 'Cost', count: detail.usage.requests },
                { id: 'exports' as const, label: 'Exports', count: detail.exports.length },
              ]}
              active={tab}
              onChange={setTab}
            />
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {tab === 'results' ? (
                <ResultsTable
                  runId={runId}
                  config={config}
                  selectedEntityId={selectedEntity}
                  onSelect={setSelectedEntity}
                  live={isActive}
                />
              ) : tab === 'sources' ? (
                <SourcesTable runId={runId} />
              ) : tab === 'events' ? (
                <RunEvents events={events} />
              ) : tab === 'failures' ? (
                <RunFailures runId={runId} live={isActive} />
              ) : tab === 'usage' ? (
                <RunUsage runId={runId} live={isActive} />
              ) : (
                <ExportsTable exports={detail.exports} />
              )}
            </div>

            {selectedEntity && tab === 'results' ? (
              <EntityPanel
                entityId={selectedEntity}
                runId={runId}
                config={config}
                onClose={() => setSelectedEntity(null)}
              />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <dt className="text-[var(--color-ink-faint)]">{label}</dt>
      <dd
        className={cn(
          'tnum',
          value === 0 && 'text-[var(--color-ink-faint)]',
          value > 0 && tone === 'ok' && 'text-[var(--color-ok)]',
          value > 0 && tone === 'warn' && 'text-[var(--color-warn)]',
          value > 0 && tone === 'danger' && 'text-[var(--color-danger)]',
          value > 0 && !tone && 'text-[var(--color-ink)]',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function SourcesTable({ runId }: { runId: string }) {
  const query = useRunSources(runId);
  const items = query.data?.items ?? [];

  if (items.length === 0) {
    return (
      <Empty
        title={query.isLoading ? 'Loading sources…' : 'No sources recorded yet'}
        hint="Sources are written before anything is extracted from them, so even a failed run leaves the exact list of documents it looked at."
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 bg-[var(--color-surface)]">
          <tr className="border-b border-[var(--color-line)] text-left text-[10px] tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
            <th className="px-3 py-1.5 font-medium">Source</th>
            <th className="w-24 px-3 py-1.5 font-medium">Kind</th>
            <th className="w-40 px-3 py-1.5 font-medium">Found by query</th>
            <th className="w-20 px-3 py-1.5 font-medium">Provider</th>
            <th className="w-36 px-3 py-1.5 font-medium">Trust</th>
            <th className="w-16 px-3 py-1.5 text-right font-medium">Rank</th>
          </tr>
        </thead>
        <tbody>
          {items.map((source) => (
            <tr key={source.id} className="border-b border-[var(--color-line)] last:border-b-0">
              <td className="max-w-0 px-3 py-1.5">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate text-[var(--color-accent)] hover:underline"
                >
                  {source.title ?? source.canonicalUrl}
                </a>
                <span className="block truncate text-[10px] text-[var(--color-ink-faint)]">
                  {source.snippet ?? source.canonicalUrl}
                </span>
              </td>
              <td className="px-3 py-1.5">
                <Mono className="text-[var(--color-ink-muted)]">{source.kind}</Mono>
              </td>
              <td className="max-w-0 truncate px-3 py-1.5 text-[var(--color-ink-faint)]">
                {source.query ?? '—'}
              </td>
              <td className="px-3 py-1.5">
                <Mono className="text-[var(--color-ink-faint)]">{source.provider}</Mono>
              </td>
              <td className="px-3 py-1.5">
                {/* Trust modifies the confidence of everything extracted from
                    this page, so it belongs beside the page, not buried in a
                    field's provenance. */}
                <span className="flex items-center gap-1.5">
                  <Meter
                    value={source.trustScore}
                    tone={
                      source.trustScore >= 0.8 ? 'ok' : source.trustScore >= 0.5 ? 'warn' : 'danger'
                    }
                    width={32}
                  />
                  <span className="tnum text-[11px] text-[var(--color-ink-faint)]">
                    {percent(source.trustScore)}
                  </span>
                  <span
                    className="truncate text-[10px] text-[var(--color-ink-faint)]"
                    title={source.trustCategory ?? 'no category matched'}
                  >
                    {source.trustCategory ?? '—'}
                  </span>
                </span>
              </td>
              <td className="tnum px-3 py-1.5 text-right text-[var(--color-ink-faint)]">
                {source.rank ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExportsTable({ exports }: { exports: ExportRecord[] }) {
  if (exports.length === 0) {
    return (
      <Empty
        title="Nothing exported yet"
        hint="The export step runs after review. You can also export the current result set at any time from the header."
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <Panel title="Exports">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-[var(--color-line)] text-left text-[10px] tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
              <th className="px-3 py-1.5 font-medium">Destination</th>
              <th className="w-24 px-3 py-1.5 font-medium">Connector</th>
              <th className="w-24 px-3 py-1.5 font-medium">Status</th>
              <th className="w-16 px-3 py-1.5 text-right font-medium">Rows</th>
              <th className="px-3 py-1.5 font-medium">Location</th>
              <th className="w-24 px-3 py-1.5 font-medium">When</th>
              <th className="w-24 px-3 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {exports.map((record) => (
              <tr key={record.id} className="border-b border-[var(--color-line)] last:border-b-0">
                <td className="px-3 py-1.5">{record.destinationId}</td>
                <td className="px-3 py-1.5">
                  <Mono className="text-[var(--color-ink-muted)]">{record.connector}</Mono>
                </td>
                <td className="px-3 py-1.5">
                  <StatusPill
                    tone={
                      record.status === 'completed'
                        ? 'ok'
                        : record.status === 'failed'
                          ? 'danger'
                          : 'info'
                    }
                    label={record.status}
                  />
                </td>
                <td className="tnum px-3 py-1.5 text-right">{record.entityCount}</td>
                <td className="max-w-0 truncate px-3 py-1.5 text-[var(--color-ink-faint)]">
                  {record.error ? (
                    <span className="text-[var(--color-danger)]">{record.error}</span>
                  ) : (
                    <Mono>{record.location}</Mono>
                  )}
                </td>
                <td className="px-3 py-1.5 text-[var(--color-ink-faint)]">
                  {formatTimestamp(record.finishedAt ?? record.createdAt)}
                </td>
                <td className="px-3 py-1.5 text-right">
                  {record.status === 'completed' && record.location ? (
                    <a href={api.downloadUrl(record.id)} download>
                      <Button size="sm">Download</Button>
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
