'use client';

import { PageHeader } from '@/components/shell';
import { Button, Empty, Mono, Panel, StatusPill } from '@/components/ui/primitives';
import { PipelineProgress } from '@/components/pipeline-progress';
import { api } from '@/lib/api';
import {
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  cn,
  formatDuration,
  formatRelative,
} from '@/lib/format';
import { useMetrics, useProjects, useRuns } from '@/lib/hooks';
import type { ResearchProject, ResearchRun } from '@frp/schemas';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Research dashboard.
 *
 * One table, one row per research job, with the pipeline's live position shown
 * inline. The counters above it are read from the API's own metrics endpoint —
 * they are the same numbers an on-call engineer would query.
 */
export default function DashboardPage() {
  const projects = useProjects();
  const runs = useRuns();
  const metrics = useMetrics();
  const router = useRouter();
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const runByProject = new Map<string, ResearchRun>();
  for (const run of runs.data?.items ?? []) {
    if (!runByProject.has(run.projectId)) runByProject.set(run.projectId, run);
  }

  const items = projects.data?.items ?? [];

  async function startRun(project: ResearchProject) {
    setBusy(project.id);
    try {
      const { run } = await api.startRun(project.id);
      await client.invalidateQueries({ queryKey: ['projects'] });
      router.push(`/runs/${run.id}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Research"
        subtitle="Every research job in this workspace, with its live pipeline position."
        actions={
          <Link href="/new">
            <Button variant="primary">New research</Button>
          </Link>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
        <div className="grid grid-cols-2 gap-px border border-[var(--color-line)] bg-[var(--color-line)] md:grid-cols-3 lg:grid-cols-6">
          <Metric label="Projects" value={metrics.data?.projects ?? 0} />
          <Metric label="Runs" value={metrics.data?.runsTotal ?? 0} />
          <Metric
            label="In flight"
            value={metrics.data?.runsRunning ?? 0}
            tone={metrics.data?.runsRunning ? 'info' : undefined}
          />
          <Metric
            label="Failed"
            value={metrics.data?.runsFailed ?? 0}
            tone={metrics.data?.runsFailed ? 'danger' : undefined}
          />
          <Metric label="Entities" value={metrics.data?.entities ?? 0} />
          <Metric
            label="Success rate"
            value={`${metrics.data?.successRate ?? 0}%`}
            hint={
              metrics.data?.medianDurationMs
                ? `median ${formatDuration(metrics.data.medianDurationMs)}`
                : undefined
            }
          />
        </div>

        <Panel title={`Research jobs (${items.length})`}>
          {items.length === 0 ? (
            <Empty
              title="No research jobs yet"
              hint="A research job pairs an objective with a pipeline configuration. Create one to see the pipeline execute against the mock providers — no credentials required."
              action={
                <Link href="/new">
                  <Button variant="primary">Create research</Button>
                </Link>
              }
            />
          ) : (
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[10px] tracking-[0.08em] text-[var(--color-ink-faint)] uppercase">
                  <th className="px-3 py-1.5 font-medium">Research</th>
                  <th className="px-3 py-1.5 font-medium">Status</th>
                  <th className="w-[240px] px-3 py-1.5 font-medium">Pipeline</th>
                  <th className="px-3 py-1.5 text-right font-medium">Results</th>
                  <th className="px-3 py-1.5 font-medium">Created</th>
                  <th className="px-3 py-1.5 font-medium">Last run</th>
                  <th className="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {items.map((project) => {
                  const run = runByProject.get(project.id);
                  const status = run?.status ?? project.status;
                  return (
                    <tr
                      key={project.id}
                      className="border-b border-[var(--color-line)] last:border-b-0 hover:bg-[var(--color-raised)]"
                    >
                      <td className="max-w-0 px-3 py-2">
                        <div className="truncate font-medium">
                          {run ? (
                            <Link
                              href={`/runs/${run.id}`}
                              className="hover:text-[var(--color-accent)]"
                            >
                              {project.name}
                            </Link>
                          ) : (
                            project.name
                          )}
                        </div>
                        <div className="truncate text-[11px] text-[var(--color-ink-faint)]">
                          {project.objective}
                        </div>
                        <Mono className="mt-0.5 block text-[var(--color-ink-faint)]">
                          {project.configKey}
                        </Mono>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <StatusPill
                          tone={RUN_STATUS_TONE[status]}
                          label={RUN_STATUS_LABEL[status]}
                          pulse={status === 'running'}
                        />
                      </td>
                      <td className="px-3 py-2 align-top">
                        {run ? (
                          <PipelineProgress run={run} />
                        ) : (
                          <span className="text-[var(--color-ink-faint)]">not started</span>
                        )}
                      </td>
                      <td className="tnum px-3 py-2 text-right align-top">
                        {project.entityCount || run?.stats.entitiesStructured || 0}
                      </td>
                      <td className="px-3 py-2 align-top text-[var(--color-ink-muted)]">
                        {formatRelative(project.createdAt)}
                      </td>
                      <td className="px-3 py-2 align-top text-[var(--color-ink-muted)]">
                        {formatRelative(project.lastRunAt)}
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        <div className="flex justify-end gap-1">
                          {run ? (
                            <Link href={`/runs/${run.id}`}>
                              <Button size="sm">Open</Button>
                            </Link>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === project.id}
                            onClick={() => void startRun(project)}
                          >
                            {busy === project.id ? 'Starting…' : 'Run'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'info' | 'danger';
}) {
  return (
    <div className="bg-[var(--color-surface)] px-3 py-2">
      <div className="text-[10px] tracking-[0.08em] text-[var(--color-ink-faint)] uppercase">
        {label}
      </div>
      <div
        className={cn(
          'tnum mt-0.5 text-[18px] leading-none font-semibold',
          tone === 'info' && 'text-[var(--color-info)]',
          tone === 'danger' && 'text-[var(--color-danger)]',
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-1 text-[10px] text-[var(--color-ink-faint)]">{hint}</div> : null}
    </div>
  );
}
