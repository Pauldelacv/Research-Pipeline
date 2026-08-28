'use client';

import { Mono } from '@/components/ui/primitives';
import { cn, formatTimestamp } from '@/lib/format';
import type { RunEvent, RunEventLevel } from '@frp/schemas';
import { useEffect, useRef, useState } from 'react';

/**
 * The run event log.
 *
 * A run's timeline is the primary debugging surface, so this is a real log
 * viewer: level filtering, structured data on demand, and follow-tail that
 * disengages the moment the operator scrolls up to read something.
 */
const LEVEL_STYLE: Record<RunEventLevel, string> = {
  debug: 'text-[var(--color-ink-faint)]',
  info: 'text-[var(--color-ink-muted)]',
  warn: 'text-[var(--color-warn)]',
  error: 'text-[var(--color-danger)]',
};

export function RunEvents({ events }: { events: RunEvent[] }) {
  const [level, setLevel] = useState<RunEventLevel>('info');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const order: RunEventLevel[] = ['debug', 'info', 'warn', 'error'];
  const minIndex = order.indexOf(level);
  const visible = events.filter((event) => order.indexOf(event.level) >= minIndex);

  useEffect(() => {
    if (!follow || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [visible.length, follow]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-3 py-1.5">
        <span className="text-[10px] tracking-[0.08em] text-[var(--color-ink-faint)] uppercase">
          Level
        </span>
        {order.map((option) => (
          <button
            key={option}
            onClick={() => setLevel(option)}
            className={cn(
              'px-1.5 py-0.5 text-[11px] uppercase',
              level === option
                ? 'bg-[var(--color-raised)] text-[var(--color-ink)]'
                : 'text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]',
            )}
          >
            {option}
          </button>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-ink-faint)]">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
            className="h-3 w-3 accent-[var(--color-accent)]"
          />
          Follow
        </label>
      </div>

      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          if (follow !== atBottom) setFollow(atBottom);
        }}
        className="min-h-0 flex-1 overflow-auto"
      >
        {visible.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-[var(--color-ink-faint)]">
            No events at this level yet.
          </p>
        ) : (
          <ul className="flex flex-col">
            {visible.map((event) => (
              <li key={event.id} className="border-b border-[var(--color-line)] last:border-b-0">
                <button
                  onClick={() => setExpanded(expanded === event.id ? null : event.id)}
                  className="flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-[var(--color-raised)]"
                >
                  <Mono className="shrink-0 text-[var(--color-ink-faint)]">
                    {formatTimestamp(event.createdAt).split(', ')[1] ?? ''}
                  </Mono>
                  <Mono className={cn('w-[92px] shrink-0 truncate', LEVEL_STYLE[event.level])}>
                    {event.type}
                  </Mono>
                  <span
                    className={cn('min-w-0 flex-1 truncate text-[12px]', LEVEL_STYLE[event.level])}
                  >
                    {event.message}
                  </span>
                  {event.stepId ? (
                    <Mono className="shrink-0 text-[var(--color-ink-faint)]">{event.stepId}</Mono>
                  ) : null}
                </button>

                {expanded === event.id && event.data ? (
                  <pre className="overflow-x-auto border-t border-[var(--color-line)] bg-[var(--color-base)] px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-ink-muted)]">
                    {JSON.stringify(event.data, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
