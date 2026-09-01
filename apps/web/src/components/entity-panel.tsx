'use client';

import { Button, Input, Meter, Mono, StatusPill, Tabs } from '@/components/ui/primitives';
import { cn, confidenceTone, formatRelative, formatValue, percent, scoreTone } from '@/lib/format';
import type { EntityDetail } from '@/lib/api';
import { useEntity, useReview } from '@/lib/hooks';
import type { EntityField, ResearchPipelineConfig, Source } from '@frp/schemas';
import { useState } from 'react';

/**
 * Entity detail panel.
 *
 * This is where the traceability model pays off. Every field shows its
 * confidence, how many independent sources agreed, and the exact snippets that
 * produced it — with a link to each source document. An operator can answer
 * "where did this number come from?" without leaving the row.
 */
type PanelTab = 'fields' | 'evidence' | 'score' | 'history';

/** Bucket for evidence recorded against the entity rather than one field. */
const UNATTACHED_EVIDENCE = '__entity__';

export function EntityPanel({
  entityId,
  config,
  onClose,
  runId,
}: {
  entityId: string;
  config: ResearchPipelineConfig;
  runId: string;
  onClose: () => void;
}) {
  const query = useEntity(entityId);
  const review = useReview(runId);
  const [tab, setTab] = useState<PanelTab>('fields');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const detail = query.data;
  const entity = detail?.entity;
  const definitions = new Map(config.extraction.fields.map((field) => [field.key, field]));

  async function submitEdit(fieldKey: string) {
    setError(null);
    try {
      await review.mutateAsync({ entityId, action: 'edit', fieldKey, value: draft });
      setEditing(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function act(action: 'approve' | 'reject' | 'reprocess', fieldKey?: string) {
    setError(null);
    try {
      await review.mutateAsync({ entityId, action, fieldKey });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  // Evidence is grouped by field so each field can show only its own snippets.
  const evidenceByField = new Map<string, EntityDetail['evidence']>();
  for (const item of detail?.evidence ?? []) {
    const key = item.entityFieldId ?? UNATTACHED_EVIDENCE;
    evidenceByField.set(key, [...(evidenceByField.get(key) ?? []), item]);
  }

  return (
    <aside className="flex h-full w-[460px] shrink-0 flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)]">
      <header className="flex shrink-0 items-start justify-between gap-2 border-b border-[var(--color-line)] px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold">
            {entity?.displayName ?? 'Loading…'}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {entity ? (
              <>
                <StatusPill
                  tone={
                    entity.status === 'approved'
                      ? 'ok'
                      : entity.status === 'rejected'
                        ? 'danger'
                        : entity.status === 'needs_review'
                          ? 'warn'
                          : 'info'
                  }
                  label={entity.status.replace('_', ' ')}
                />
                {entity.score !== null ? (
                  <span
                    className={cn(
                      'tnum text-[12px] font-medium',
                      scoreTone(entity.score, config.scoring.thresholds) === 'ok'
                        ? 'text-[var(--color-ok)]'
                        : scoreTone(entity.score, config.scoring.thresholds) === 'warn'
                          ? 'text-[var(--color-warn)]'
                          : 'text-[var(--color-ink-muted)]',
                    )}
                  >
                    {entity.score}/{config.scoring.maxScore}
                  </span>
                ) : null}
                <Mono className="text-[var(--color-ink-faint)]">{entity.id}</Mono>
              </>
            ) : null}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close panel">
          ✕
        </Button>
      </header>

      {entity ? (
        <div className="flex shrink-0 gap-1.5 border-b border-[var(--color-line)] px-3 py-2">
          <Button size="sm" onClick={() => void act('approve')} disabled={review.isPending}>
            Approve
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => void act('reject')}
            disabled={review.isPending}
          >
            Reject
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void act('reprocess')}
            disabled={review.isPending}
            title="Recompute signals and score from the current field values. Does not re-fetch sources."
          >
            Re-score
          </Button>
        </div>
      ) : null}

      {error ? (
        <p className="shrink-0 border-b border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-1.5 text-[11px] text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}

      <div className="shrink-0 px-3">
        <Tabs
          tabs={[
            { id: 'fields' as const, label: 'Fields', count: detail?.fields.length },
            { id: 'evidence' as const, label: 'Evidence', count: detail?.evidence.length },
            {
              id: 'score' as const,
              label: 'Score',
              count: entity?.scoreBreakdown?.contributions.length,
            },
            { id: 'history' as const, label: 'History', count: detail?.reviews.length },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!detail ? (
          <p className="px-3 py-4 text-[12px] text-[var(--color-ink-faint)]">Loading…</p>
        ) : tab === 'fields' ? (
          <ul className="flex flex-col">
            {detail.fields.map((field) => {
              const definition = definitions.get(field.key);
              const evidence = evidenceByField.get(field.id) ?? [];
              return (
                <li key={field.id} className="border-b border-[var(--color-line)] px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px] tracking-wide text-[var(--color-ink-faint)] uppercase">
                      {definition?.label ?? field.key}
                    </span>
                    <FieldStatusBadge field={field} threshold={config.review.flagBelowConfidence} />
                  </div>

                  {editing === field.key ? (
                    <div className="mt-1 flex items-center gap-1.5">
                      <Input
                        value={draft}
                        autoFocus
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void submitEdit(field.key);
                          if (event.key === 'Escape') setEditing(null);
                        }}
                      />
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void submitEdit(field.key)}
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <button
                      className="mt-0.5 w-full text-left text-[12px] hover:text-[var(--color-accent)]"
                      onClick={() => {
                        setEditing(field.key);
                        setDraft(field.value === null ? '' : String(field.value));
                      }}
                      title="Click to correct this value"
                    >
                      {formatValue(field.value)}
                    </button>
                  )}

                  <div className="mt-1 flex items-center gap-2">
                    <Meter
                      value={field.confidence}
                      tone={confidenceTone(field.confidence, config.review.flagBelowConfidence)}
                      width={60}
                    />
                    <span className="tnum text-[10px] text-[var(--color-ink-muted)]">
                      {percent(field.confidence)}
                    </span>
                    <span className="text-[10px] text-[var(--color-ink-faint)]">
                      {field.agreementCount} source{field.agreementCount === 1 ? '' : 's'}
                    </span>
                    {field.extractedBy ? (
                      <Mono className="text-[var(--color-ink-faint)]">{field.extractedBy}</Mono>
                    ) : null}
                    {field.status === 'flagged' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => void act('approve', field.key)}
                      >
                        Accept
                      </Button>
                    ) : null}
                  </div>

                  {field.previousValue !== null && field.previousValue !== undefined ? (
                    <p className="mt-1 text-[10px] text-[var(--color-ink-faint)]">
                      was <s>{formatValue(field.previousValue)}</s> before an operator edit
                    </p>
                  ) : null}

                  {evidence.length > 0 ? (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[10px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]">
                        {evidence.length} supporting snippet{evidence.length === 1 ? '' : 's'}
                      </summary>
                      <ul className="mt-1 flex flex-col gap-1">
                        {evidence.map((item) => (
                          <li
                            key={item.id}
                            className="border-l-2 border-[var(--color-line-strong)] pl-2"
                          >
                            <p className="text-[11px] text-[var(--color-ink-muted)] italic">
                              “{item.snippet}”
                            </p>
                            {item.source ? (
                              <>
                                <a
                                  href={item.source.url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="mt-0.5 block truncate text-[10px] text-[var(--color-accent)] hover:underline"
                                >
                                  {item.source.canonicalUrl}
                                </a>
                                <SourceTrust source={item.source} />
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : tab === 'evidence' ? (
          <ul className="flex flex-col">
            {detail.evidence.map((item) => (
              <li key={item.id} className="border-b border-[var(--color-line)] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <Mono className="text-[var(--color-ink-faint)]">{item.method}</Mono>
                  <span className="tnum text-[10px] text-[var(--color-ink-muted)]">
                    {percent(item.confidence)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[var(--color-ink-muted)] italic">
                  “{item.snippet}”
                </p>
                {item.source ? (
                  <>
                    <a
                      href={item.source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1 block truncate text-[10px] text-[var(--color-accent)] hover:underline"
                    >
                      {item.source.canonicalUrl}
                    </a>
                    <SourceTrust source={item.source} />
                  </>
                ) : null}
                {item.locator ? (
                  <Mono className="mt-0.5 block text-[var(--color-ink-faint)]">{item.locator}</Mono>
                ) : null}
              </li>
            ))}
          </ul>
        ) : tab === 'score' ? (
          <ScoreBreakdown entity={detail.entity} config={config} />
        ) : (
          <ul className="flex flex-col">
            {detail.reviews.length === 0 ? (
              <li className="px-3 py-4 text-[11px] text-[var(--color-ink-faint)]">
                No operator decisions recorded for this entity.
              </li>
            ) : (
              detail.reviews.map((item) => (
                <li key={item.id} className="border-b border-[var(--color-line)] px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px]">
                      <span className="font-medium">{item.action}</span>
                      {item.fieldKey ? (
                        <span className="text-[var(--color-ink-muted)]"> · {item.fieldKey}</span>
                      ) : null}
                    </span>
                    <span className="text-[10px] text-[var(--color-ink-faint)]">
                      {formatRelative(item.createdAt)}
                    </span>
                  </div>
                  {item.previousValue !== null || item.newValue !== null ? (
                    <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)]">
                      {formatValue(item.previousValue)} → {formatValue(item.newValue)}
                    </p>
                  ) : null}
                  {item.note ? (
                    <p className="mt-0.5 text-[11px] text-[var(--color-ink-faint)]">{item.note}</p>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </aside>
  );
}

function FieldStatusBadge({ field, threshold }: { field: EntityField; threshold: number }) {
  if (field.status === 'edited') {
    return <span className="text-[10px] text-[var(--color-accent)]">edited by operator</span>;
  }
  if (field.status === 'approved') {
    return <span className="text-[10px] text-[var(--color-ok)]">approved</span>;
  }
  if (field.status === 'flagged' || field.confidence < threshold) {
    return <span className="text-[10px] text-[var(--color-warn)]">needs review</span>;
  }
  return null;
}

function ScoreBreakdown({
  entity,
  config,
}: {
  entity: { score: number | null; scoreBreakdown: NonNullable<unknown> | null } & {
    scoreBreakdown: {
      total: number;
      maxScore: number;
      band: string;
      contributions: Array<{
        ruleId: string;
        label: string;
        matched: boolean;
        points: number;
        maxPoints: number;
        explanation: string;
      }>;
    } | null;
  };
  config: ResearchPipelineConfig;
}) {
  const breakdown = entity.scoreBreakdown;
  if (!breakdown) {
    return (
      <p className="px-3 py-4 text-[11px] text-[var(--color-ink-faint)]">
        This entity has not been scored yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between border-b border-[var(--color-line)] px-3 py-3">
        <span className="text-[10px] tracking-[0.08em] text-[var(--color-ink-faint)] uppercase">
          Total score
        </span>
        <span className="tnum text-[22px] leading-none font-semibold">
          {breakdown.total}
          <span className="text-[12px] text-[var(--color-ink-faint)]">/{breakdown.maxScore}</span>
        </span>
      </div>

      <ul className="flex flex-col">
        {breakdown.contributions.map((contribution) => (
          <li
            key={contribution.ruleId}
            className={cn(
              'border-b border-[var(--color-line)] px-3 py-1.5',
              !contribution.matched && 'opacity-55',
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px]">{contribution.label}</span>
              <span
                className={cn(
                  'tnum shrink-0 text-[12px] font-medium',
                  contribution.points > 0
                    ? 'text-[var(--color-ok)]'
                    : contribution.points < 0
                      ? 'text-[var(--color-danger)]'
                      : 'text-[var(--color-ink-faint)]',
                )}
              >
                {contribution.points > 0 ? '+' : ''}
                {contribution.points}
                <span className="text-[10px] text-[var(--color-ink-faint)]">
                  /{contribution.maxPoints}
                </span>
              </span>
            </div>
            {/* Every point is attributable to a named rule and a readable reason. */}
            <p className="mt-0.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--color-ink-faint)]">
              {contribution.explanation}
            </p>
          </li>
        ))}
      </ul>

      <p className="px-3 py-2 text-[10px] text-[var(--color-ink-faint)]">
        Qualified at {config.scoring.thresholds.qualified}, review at{' '}
        {config.scoring.thresholds.review}. Scores are arithmetic over the rules above — no model is
        involved in this step.
      </p>
    </div>
  );
}

/**
 * How much the source behind a snippet was trusted.
 *
 * Shown next to the evidence rather than folded into the number above it: the
 * confidence on the field has already been weighted by this, and an operator
 * adjudicating a conflict needs to see *why* one source lost — "0.62" is not
 * an argument, "0.9 from an unknown aggregator" is.
 */
function SourceTrust({ source }: { source: Source }) {
  return (
    <p className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--color-ink-faint)]">
      <span
        className={
          source.trustScore >= 0.8
            ? 'text-[var(--color-ok)]'
            : source.trustScore >= 0.5
              ? 'text-[var(--color-warn)]'
              : 'text-[var(--color-danger)]'
        }
      >
        trust {percent(source.trustScore)}
      </span>
      <span>· {source.trustCategory ?? 'no category matched'}</span>
    </p>
  );
}
