'use client';

import { Button, Empty, Input, Meter, Mono, Select, StatusPill } from '@/components/ui/primitives';
import type { EntityFilters } from '@/lib/api';
import { cn, formatValue, scoreTone } from '@/lib/format';
import { useBulkReview, useEntities } from '@/lib/hooks';
import type { Entity, EntityStatus, FieldDefinition, ResearchPipelineConfig } from '@frp/schemas';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';

/**
 * Results explorer.
 *
 * Columns come from `config.extraction.fields` — the same definitions the
 * extraction step worked from — so a pipeline that collects different
 * attributes gets a different table with no code change. Filtering, sorting
 * and pagination happen server-side; the client never holds the full set.
 */
const STATUS_TONE: Record<EntityStatus, 'ok' | 'warn' | 'danger' | 'info' | 'idle'> = {
  new: 'info',
  needs_review: 'warn',
  approved: 'ok',
  rejected: 'danger',
  exported: 'ok',
};

const STATUS_LABEL: Record<EntityStatus, string> = {
  new: 'New',
  needs_review: 'Review',
  approved: 'Approved',
  rejected: 'Rejected',
  exported: 'Exported',
};

export function ResultsTable({
  runId,
  config,
  selectedEntityId,
  onSelect,
}: {
  runId: string;
  config: ResearchPipelineConfig;
  selectedEntityId: string | null;
  onSelect: (entityId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<EntityStatus | ''>('');
  const [signal, setSignal] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [sort, setSort] = useState('score');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const limit = 50;
  const filters: EntityFilters = {
    q: search || undefined,
    status: status ? [status] : undefined,
    signal: signal || undefined,
    flaggedOnly,
    sort,
    direction,
    limit,
    offset,
  };

  const query = useEntities(runId, filters);
  const bulkReview = useBulkReview(runId);

  const tableColumns = useMemo(
    () =>
      buildColumns(
        config,
        config.extraction.fields.filter((field) => field.display.inTable),
      ),
    [config],
  );

  const rows = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
  });

  const allChecked = rows.length > 0 && rows.every((row) => checked.has(row.id));

  function toggleSort(columnId: string) {
    if (sort === columnId) {
      setDirection(direction === 'desc' ? 'asc' : 'desc');
    } else {
      setSort(columnId);
      setDirection('desc');
    }
    setOffset(0);
  }

  async function runBulk(action: 'approve' | 'reject') {
    await bulkReview.mutateAsync({ entityIds: [...checked], action });
    setChecked(new Set());
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
        <Input
          placeholder="Search name or any value…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
          className="w-56"
        />

        <Select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as EntityStatus | '');
            setOffset(0);
          }}
          className="w-32"
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABEL) as EntityStatus[]).map((option) => (
            <option key={option} value={option}>
              {STATUS_LABEL[option]}
            </option>
          ))}
        </Select>

        {config.signals.length > 0 ? (
          <Select
            value={signal}
            onChange={(event) => {
              setSignal(event.target.value);
              setOffset(0);
            }}
            className="w-40"
          >
            <option value="">Any signal</option>
            {config.signals.map((definition) => (
              <option key={definition.key} value={definition.key}>
                {definition.label}
              </option>
            ))}
          </Select>
        ) : null}

        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-ink-muted)]">
          <input
            type="checkbox"
            checked={flaggedOnly}
            onChange={(event) => {
              setFlaggedOnly(event.target.checked);
              setOffset(0);
            }}
            className="h-3 w-3 accent-[var(--color-accent)]"
          />
          Flagged only
        </label>

        <div className="ml-auto flex items-center gap-2">
          {checked.size > 0 ? (
            <>
              <span className="text-[11px] text-[var(--color-ink-muted)]">
                {checked.size} selected
              </span>
              <Button
                size="sm"
                onClick={() => void runBulk('approve')}
                disabled={bulkReview.isPending}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void runBulk('reject')}
                disabled={bulkReview.isPending}
              >
                Reject
              </Button>
            </>
          ) : null}
          <span className="tnum text-[11px] text-[var(--color-ink-faint)]">
            {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + limit, total)} of ${total}`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            Prev
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
          >
            Next
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <Empty
            title={query.isLoading ? 'Loading results…' : 'No results match these filters'}
            hint={
              query.isLoading
                ? undefined
                : 'Entities appear as the structure step merges extracted candidates.'
            }
          />
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-[var(--color-surface)]">
              <tr className="border-b border-[var(--color-line)] text-left text-[10px] tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
                <th className="w-8 px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={() =>
                      setChecked(allChecked ? new Set() : new Set(rows.map((row) => row.id)))
                    }
                    className="h-3 w-3 accent-[var(--color-accent)]"
                    aria-label="Select all rows on this page"
                  />
                </th>
                {table.getHeaderGroups()[0]?.headers.map((header) => {
                  const sortable = SORTABLE_COLUMNS.has(header.column.id);
                  return (
                    <th
                      key={header.id}
                      style={{ width: header.column.columnDef.size }}
                      className={cn('px-2 py-1.5 font-medium', sortable && 'cursor-pointer')}
                      onClick={sortable ? () => toggleSort(header.column.id) : undefined}
                    >
                      <span className="inline-flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sort === header.column.id ? (
                          <span className="text-[var(--color-accent)]">
                            {direction === 'desc' ? '↓' : '↑'}
                          </span>
                        ) : null}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => {
                const entity = row.original;
                const active = entity.id === selectedEntityId;
                return (
                  <tr
                    key={row.id}
                    onClick={() => onSelect(entity.id)}
                    className={cn(
                      'cursor-pointer border-b border-[var(--color-line)] last:border-b-0',
                      active ? 'bg-[var(--color-overlay)]' : 'hover:bg-[var(--color-raised)]',
                    )}
                  >
                    <td className="px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked.has(entity.id)}
                        onChange={() =>
                          setChecked((current) => {
                            const next = new Set(current);
                            if (next.has(entity.id)) next.delete(entity.id);
                            else next.add(entity.id);
                            return next;
                          })
                        }
                        className="h-3 w-3 accent-[var(--color-accent)]"
                        aria-label={`Select ${entity.displayName}`}
                      />
                    </td>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="max-w-0 px-2 py-1.5">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const SORTABLE_COLUMNS = new Set(['displayName', 'score', 'confidence', 'sourceCount']);

/**
 * Column definitions are plain objects rather than `createColumnHelper` output:
 * every cell reads from `row.original`, so the helper's per-column value
 * generic buys nothing and only complicates the array's type.
 */
function buildColumns(
  config: ResearchPipelineConfig,
  fields: FieldDefinition[],
): ColumnDef<Entity>[] {
  const columns: ColumnDef<Entity>[] = [
    {
      id: 'displayName',
      header: config.entity.label,
      size: 200,
      cell: ({ row }) => (
        <div className="truncate font-medium text-[var(--color-ink)]">
          {row.original.displayName}
        </div>
      ),
    },
  ];

  // The display field is already the first column.
  for (const field of [...fields].sort((a, b) => a.display.order - b.display.order)) {
    if (field.key === config.entity.displayField) continue;
    columns.push({
      id: `field:${field.key}`,
      header: field.label,
      size: field.display.width ?? 140,
      cell: ({ row }) => {
        const value = row.original.data[field.key];
        const flagged = row.original.flaggedFields.includes(field.key);
        return (
          <div
            className={cn(
              'truncate',
              value === null || value === undefined
                ? 'text-[var(--color-ink-faint)]'
                : 'text-[var(--color-ink-muted)]',
              // A flagged cell is marked in place, so an operator can see which
              // value is uncertain without opening the record.
              flagged &&
                'border-b border-dashed border-[var(--color-warn)] text-[var(--color-warn)]',
            )}
            title={flagged ? 'Below the confidence threshold - needs review' : undefined}
          >
            {formatValue(value)}
          </div>
        );
      },
    });
  }

  columns.push({
    id: 'signals',
    header: 'Signals',
    size: 160,
    cell: ({ row }) => {
      const detected = row.original.signals.filter((signal) => signal.detected);
      if (detected.length === 0) {
        return <span className="text-[var(--color-ink-faint)]">—</span>;
      }
      return (
        <div className="flex flex-wrap gap-1">
          {detected.slice(0, 3).map((signal) => (
            <span
              key={signal.key}
              title={signal.rationale ?? undefined}
              className={cn(
                'border px-1 text-[10px] whitespace-nowrap',
                signal.tone === 'positive' && 'border-[var(--color-ok)]/40 text-[var(--color-ok)]',
                signal.tone === 'negative' &&
                  'border-[var(--color-danger)]/40 text-[var(--color-danger)]',
                signal.tone === 'neutral' &&
                  'border-[var(--color-line-strong)] text-[var(--color-ink-muted)]',
              )}
            >
              {signal.label}
            </span>
          ))}
          {detected.length > 3 ? (
            <span className="text-[10px] text-[var(--color-ink-faint)]">
              +{detected.length - 3}
            </span>
          ) : null}
        </div>
      );
    },
  });

  columns.push({
    id: 'confidence',
    header: 'Conf.',
    size: 76,
    cell: ({ row }) => {
      const value = row.original.confidence;
      return (
        <div className="flex items-center gap-1.5">
          <Meter
            value={value}
            tone={value >= 0.75 ? 'ok' : value >= 0.5 ? 'warn' : 'danger'}
            width={28}
          />
          <span className="tnum text-[11px] text-[var(--color-ink-muted)]">
            {Math.round(value * 100)}
          </span>
        </div>
      );
    },
  });

  columns.push({
    id: 'score',
    header: 'Score',
    size: 72,
    cell: ({ row }) => {
      const score = row.original.score;
      if (score === null) return <span className="text-[var(--color-ink-faint)]">—</span>;
      const tone = scoreTone(score, config.scoring.thresholds);
      return (
        <span
          className={cn(
            'tnum font-medium',
            tone === 'ok' && 'text-[var(--color-ok)]',
            tone === 'warn' && 'text-[var(--color-warn)]',
            tone === 'danger' && 'text-[var(--color-ink-muted)]',
          )}
        >
          {score}
        </span>
      );
    },
  });

  columns.push({
    id: 'sourceCount',
    header: 'Src',
    size: 52,
    cell: ({ row }) => (
      <Mono className="text-[var(--color-ink-faint)]">{row.original.sourceCount}</Mono>
    ),
  });

  columns.push({
    id: 'status',
    header: 'Status',
    size: 108,
    cell: ({ row }) => (
      <StatusPill
        tone={STATUS_TONE[row.original.status]}
        label={STATUS_LABEL[row.original.status]}
      />
    ),
  });

  return columns;
}
