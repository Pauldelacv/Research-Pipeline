'use client';

import { PageHeader } from '@/components/shell';
import { TargetingForm, initialTargeting, type TargetingState } from '@/components/targeting-form';
import { Button, Field, Input, Mono, Panel, Select } from '@/components/ui/primitives';
import { ApiError, api, type PipelineSummary } from '@/lib/api';
import { cn } from '@/lib/format';
import { usePipelines } from '@/lib/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

/**
 * Create research.
 *
 * The whole form — targeting inputs, field selection, destinations, scoring
 * weights — is generated from the selected pipeline configuration. Choosing a
 * different pipeline reshapes the page; nothing about lead generation is
 * hardcoded here.
 */
export default function NewResearchPage() {
  const pipelines = usePipelines();
  const router = useRouter();
  const client = useQueryClient();

  const [configKey, setConfigKey] = useState<string>('');
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [targeting, setTargeting] = useState<TargetingState>({});
  const [maxResults, setMaxResults] = useState(50);
  const [fieldKeys, setFieldKeys] = useState<string[]>([]);
  const [destinationIds, setDestinationIds] = useState<string[]>([]);
  const [minimumConfidence, setMinimumConfidence] = useState(0.75);
  const [blockingReview, setBlockingReview] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = pipelines.data?.items ?? [];
  const selected: PipelineSummary | undefined = useMemo(
    () => items.find((item) => item.key === configKey),
    [items, configKey],
  );

  // Selecting a pipeline seeds every dependent control from its configuration.
  useEffect(() => {
    if (!configKey && items.length > 0) {
      setConfigKey(items[0]!.key);
      return;
    }
    if (!selected) return;
    setTargeting(initialTargeting(selected.targeting.fields));
    setMaxResults(Math.min(selected.discovery.maxResults, 50));
    setFieldKeys(selected.fields.map((field) => field.key));
    setDestinationIds(selected.destinations.filter((d) => d.enabled).map((d) => d.id));
    setBlockingReview(selected.review.blocking);
    setName((current) => current || `${selected.name} — ${new Date().toLocaleDateString()}`);
    setObjective((current) => current || (selected.description ?? ''));
  }, [configKey, selected, items]);

  async function submit(startImmediately: boolean) {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const { project, run } = await api.createProject({
        name,
        objective,
        configKey: selected.key,
        targeting,
        overrides: {
          discovery: { maxResults },
          extraction: { fieldKeys },
          validation: { minimumConfidence },
          review: { blocking: blockingReview },
          export: { destinationIds },
        },
        startImmediately,
      });
      await client.invalidateQueries({ queryKey: ['projects'] });
      router.push(run ? `/runs/${run.id}` : `/`);
      void project;
    } catch (caught) {
      // Configuration errors are reported with the offending path, so an
      // invalid combination is actionable rather than mysterious.
      if (caught instanceof ApiError) {
        const details = Array.isArray(caught.details)
          ? ` (${caught.details.map((d: { path?: string; message?: string }) => `${d.path}: ${d.message}`).join('; ')})`
          : '';
        setError(`${caught.message}${details}`);
      } else {
        setError(String(caught));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const valid = Boolean(selected && name.trim() && objective.trim() && fieldKeys.length > 0);

  return (
    <>
      <PageHeader
        title="New research"
        subtitle="Configure a research job. Every control below is generated from the selected pipeline."
        actions={
          <>
            <Button disabled={!valid || submitting} onClick={() => void submit(false)}>
              Save as draft
            </Button>
            <Button
              variant="primary"
              disabled={!valid || submitting}
              onClick={() => void submit(true)}
            >
              {submitting ? 'Starting…' : 'Run research'}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <div
            className="mb-3 border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]"
            style={{ borderRadius: 'var(--radius-sm)' }}
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-3">
            <Panel title="Pipeline" bodyClassName="flex flex-col gap-3 p-3">
              <Field label="Configuration" required>
                <Select value={configKey} onChange={(event) => setConfigKey(event.target.value)}>
                  {items.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>

              {selected ? (
                <div className="border-l-2 border-[var(--color-line-strong)] pl-2 text-[11px] text-[var(--color-ink-faint)]">
                  <p>{selected.description}</p>
                  <p className="mt-1">
                    Produces{' '}
                    <span className="text-[var(--color-ink-muted)]">
                      {selected.entity.labelPlural.toLowerCase()}
                    </span>{' '}
                    · identity <Mono>{selected.entity.identity.fields.join(' + ')}</Mono> · v
                    {selected.version}
                  </p>
                </div>
              ) : null}

              <Field label="Research name" required>
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>

              <Field
                label="Objective"
                required
                hint="Handed to the research provider for query planning."
              >
                <textarea
                  value={objective}
                  rows={4}
                  onChange={(event) => setObjective(event.target.value)}
                  className="w-full border border-[var(--color-line)] bg-[var(--color-base)] px-2 py-1.5 text-[12px] focus:border-[var(--color-accent)] focus:outline-none"
                  style={{ borderRadius: 'var(--radius-sm)' }}
                />
              </Field>

              <Field label="Maximum results" hint="Upper bound on discovered sources.">
                <Input
                  type="number"
                  className="tnum"
                  min={1}
                  max={selected?.discovery.maxResults ?? 1000}
                  value={String(maxResults)}
                  onChange={(event) => setMaxResults(Number(event.target.value))}
                />
              </Field>
            </Panel>
          </div>

          <div className="flex flex-col gap-3">
            <Panel title="Target" bodyClassName="p-3">
              {selected ? (
                <TargetingForm
                  fields={selected.targeting.fields}
                  value={targeting}
                  onChange={setTargeting}
                />
              ) : null}
            </Panel>
          </div>

          <div className="flex flex-col gap-3">
            <Panel
              title={`Required fields (${fieldKeys.length}/${selected?.fields.length ?? 0})`}
              bodyClassName="max-h-64 overflow-auto p-2"
            >
              {selected?.fields.map((field) => {
                const checked = fieldKeys.includes(field.key);
                const structural =
                  field.key === selected.entity.displayField ||
                  selected.entity.identity.fields.includes(field.key);
                return (
                  <label
                    key={field.key}
                    className={cn(
                      'flex cursor-pointer items-center justify-between gap-2 px-1.5 py-1 text-[12px] hover:bg-[var(--color-raised)]',
                      structural && 'cursor-default opacity-70',
                    )}
                    title={structural ? 'Structural field — always extracted' : field.description}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={structural}
                        onChange={() =>
                          setFieldKeys((current) =>
                            checked
                              ? current.filter((key) => key !== field.key)
                              : [...current, field.key],
                          )
                        }
                        className="h-3 w-3 accent-[var(--color-accent)]"
                      />
                      {field.label}
                      {field.required ? (
                        <span className="text-[10px] text-[var(--color-warn)]">required</span>
                      ) : null}
                    </span>
                    <Mono className="text-[var(--color-ink-faint)]">{field.type}</Mono>
                  </label>
                );
              })}
            </Panel>

            <Panel title="Review & scoring" bodyClassName="flex flex-col gap-3 p-3">
              <Field
                label={`Minimum confidence — ${Math.round(minimumConfidence * 100)}%`}
                hint="Fields below this are flagged for human review."
              >
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={minimumConfidence}
                  onChange={(event) => setMinimumConfidence(Number(event.target.value))}
                  className="w-full accent-[var(--color-accent)]"
                />
              </Field>

              <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={blockingReview}
                  onChange={(event) => setBlockingReview(event.target.checked)}
                  className="h-3 w-3 accent-[var(--color-accent)]"
                />
                Hold the run for review before exporting
              </label>

              {selected && selected.scoring.rules.length > 0 ? (
                <div className="border-t border-[var(--color-line)] pt-2">
                  <div className="mb-1 text-[10px] tracking-[0.08em] text-[var(--color-ink-faint)] uppercase">
                    Scoring rules
                  </div>
                  <ul className="flex flex-col gap-0.5">
                    {selected.scoring.rules.map((rule) => (
                      <li key={rule.id} className="flex items-center justify-between text-[11px]">
                        <span className="text-[var(--color-ink-muted)]">{rule.label}</span>
                        <span
                          className={cn(
                            'tnum',
                            rule.weight >= 0
                              ? 'text-[var(--color-ok)]'
                              : 'text-[var(--color-danger)]',
                          )}
                        >
                          {rule.weight >= 0 ? '+' : ''}
                          {rule.weight}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Panel>

            <Panel title="Destinations" bodyClassName="p-2">
              {selected?.destinations.length === 0 ? (
                <p className="px-1.5 py-1 text-[11px] text-[var(--color-ink-faint)]">
                  This pipeline defines no export destination. Results stay in the explorer and can
                  still be exported ad hoc.
                </p>
              ) : (
                selected?.destinations.map((destination) => {
                  const checked = destinationIds.includes(destination.id);
                  return (
                    <label
                      key={destination.id}
                      className="flex cursor-pointer items-center justify-between gap-2 px-1.5 py-1 text-[12px] hover:bg-[var(--color-raised)]"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setDestinationIds((current) =>
                              checked
                                ? current.filter((id) => id !== destination.id)
                                : [...current, destination.id],
                            )
                          }
                          className="h-3 w-3 accent-[var(--color-accent)]"
                        />
                        {destination.label}
                      </span>
                      <Mono className="text-[var(--color-ink-faint)]">{destination.connector}</Mono>
                    </label>
                  );
                })
              )}
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
