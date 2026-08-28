'use client';

import { PageHeader } from '@/components/shell';
import { Dot, Mono, Panel, StatusPill } from '@/components/ui/primitives';
import { cn } from '@/lib/format';
import { useConnectors, useMetrics, usePipelines, useProviders } from '@/lib/hooks';

/**
 * System view.
 *
 * What a Forward Deployed Engineer checks first on a new deployment: which
 * providers are wired, whether their credentials actually work, which
 * connectors exist, and what the queue is doing. Provider health is a live
 * probe, not a static list — a missing API key shows up here rather than
 * three steps into someone's run.
 */
export default function SystemPage() {
  const providers = useProviders();
  const connectors = useConnectors();
  const pipelines = usePipelines();
  const metrics = useMetrics();

  const defaults = providers.data?.defaults ?? {};
  const kinds = ['research', 'search', 'extraction', 'enrichment'] as const;

  return (
    <>
      <PageHeader
        title="System"
        subtitle="Registered pipelines, provider health and queue state for this deployment."
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto p-4 lg:grid-cols-2">
        <Panel title="Providers">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-[var(--color-line)] text-left text-[10px] tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
                <th className="px-3 py-1.5 font-medium">Stage</th>
                <th className="px-3 py-1.5 font-medium">Provider</th>
                <th className="px-3 py-1.5 font-medium">Health</th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((kind) => {
                const forKind = (providers.data?.items ?? []).filter((item) => item.kind === kind);
                return forKind.map((provider, index) => {
                  const isDefault = defaults[kind] === provider.id;
                  return (
                    <tr
                      key={`${kind}:${provider.id}`}
                      className="border-b border-[var(--color-line)] last:border-b-0"
                    >
                      {index === 0 ? (
                        <td
                          rowSpan={forKind.length}
                          className="border-r border-[var(--color-line)] px-3 py-1.5 align-top text-[var(--color-ink-muted)]"
                        >
                          {kind}
                        </td>
                      ) : null}
                      <td className="px-3 py-1.5">
                        <span className="flex items-center gap-2">
                          <Mono
                            className={cn(
                              isDefault
                                ? 'text-[var(--color-ink)]'
                                : 'text-[var(--color-ink-muted)]',
                            )}
                          >
                            {provider.id}
                          </Mono>
                          {isDefault ? (
                            <span className="border border-[var(--color-accent)]/40 px-1 text-[9px] tracking-wide text-[var(--color-accent)] uppercase">
                              default
                            </span>
                          ) : null}
                          {provider.requiresCredentials ? (
                            <span className="text-[9px] tracking-wide text-[var(--color-ink-faint)] uppercase">
                              keys
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="max-w-0 px-3 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <Dot tone={provider.health.ok ? 'ok' : 'danger'} />
                          <span
                            className="truncate text-[11px] text-[var(--color-ink-faint)]"
                            title={provider.health.detail}
                          >
                            {provider.health.detail}
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </Panel>

        <Panel title="Queue">
          <div className="grid grid-cols-2 gap-px bg-[var(--color-line)] md:grid-cols-3">
            {Object.entries(metrics.data?.queue ?? {}).map(([state, count]) => (
              <div key={state} className="bg-[var(--color-surface)] px-3 py-2">
                <div className="text-[10px] tracking-[0.08em] text-[var(--color-ink-faint)] uppercase">
                  {state}
                </div>
                <div
                  className={cn(
                    'tnum mt-0.5 text-[16px] font-semibold',
                    state === 'failed' && count > 0 && 'text-[var(--color-danger)]',
                    state === 'active' && count > 0 && 'text-[var(--color-info)]',
                  )}
                >
                  {count}
                </div>
              </div>
            ))}
          </div>
          <p className="border-t border-[var(--color-line)] px-3 py-2 text-[11px] text-[var(--color-ink-faint)]">
            One job equals one attempt of one pipeline step. Retries and backoff are handled by the
            queue, so a waiting step costs a queue delay rather than a blocked worker.
          </p>
        </Panel>

        <Panel title="Connectors">
          <ul className="flex flex-col">
            {(connectors.data?.items ?? []).map((connector) => (
              <li
                key={connector.id}
                className="border-b border-[var(--color-line)] px-3 py-2 last:border-b-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[12px]">
                    <Mono>{connector.id}</Mono>
                    <span className="text-[var(--color-ink-muted)]">{connector.label}</span>
                  </span>
                  <StatusPill
                    tone={connector.requiresCredentials ? 'warn' : 'ok'}
                    label={connector.requiresCredentials ? 'needs keys' : 'ready'}
                  />
                </div>
                <p className="mt-0.5 text-[11px] text-[var(--color-ink-faint)]">
                  {connector.description}
                </p>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Registered pipelines">
          <ul className="flex flex-col">
            {(pipelines.data?.items ?? []).map((pipeline) => (
              <li
                key={pipeline.key}
                className="border-b border-[var(--color-line)] px-3 py-2 last:border-b-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-medium">{pipeline.name}</span>
                  <Mono className="text-[var(--color-ink-faint)]">
                    {pipeline.key} v{pipeline.version}
                  </Mono>
                </div>
                <p className="mt-0.5 text-[11px] text-[var(--color-ink-faint)]">
                  {pipeline.entity.labelPlural} · {pipeline.fields.length} fields ·{' '}
                  {pipeline.signals.length} signals · {pipeline.scoring.rules.length} scoring rules
                  · review{' '}
                  {pipeline.review.enabled
                    ? pipeline.review.blocking
                      ? 'blocking'
                      : 'non-blocking'
                    : 'off'}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}
