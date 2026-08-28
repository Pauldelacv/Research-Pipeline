'use client';

import { cn } from '@/lib/format';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Application shell.
 *
 * A fixed left rail and a thin top bar, both hairline-bordered. The layout
 * gives the content the full remaining viewport because every screen in this
 * tool is a table or a timeline that benefits from vertical space.
 */
const NAV = [
  {
    href: '/',
    label: 'Research',
    match: (path: string) => path === '/' || path.startsWith('/runs'),
  },
  { href: '/new', label: 'New research', match: (path: string) => path === '/new' },
  { href: '/system', label: 'System', match: (path: string) => path === '/system' },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <nav className="flex w-[184px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)]">
        <div className="flex h-11 items-center gap-2 border-b border-[var(--color-line)] px-3">
          <Glyph />
          <div className="leading-tight">
            <div className="text-[12px] font-semibold tracking-tight">Field Research</div>
            <div className="text-[10px] tracking-[0.1em] text-[var(--color-ink-faint)] uppercase">
              Pipeline
            </div>
          </div>
        </div>

        <ul className="flex flex-col gap-px p-2">
          {NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    'block border-l-2 px-2 py-1.5 text-[12px] transition-colors',
                    active
                      ? 'border-[var(--color-accent)] bg-[var(--color-raised)] text-[var(--color-ink)]'
                      : 'border-transparent text-[var(--color-ink-muted)] hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="mt-auto border-t border-[var(--color-line)] p-3">
          <p className="text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
            Configurable research and data enrichment pipelines.
          </p>
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}

/** A small mark built from the pipeline metaphor: sources funnelling to a row. */
function Glyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="4" height="4" stroke="var(--color-accent)" />
      <rect x="1.5" y="13.5" width="4" height="4" stroke="var(--color-accent)" />
      <rect x="14.5" y="8" width="4" height="4" stroke="var(--color-ink-muted)" />
      <path d="M5.5 4.5H10V10H14.5" stroke="var(--color-line-strong)" />
      <path d="M5.5 15.5H10V10" stroke="var(--color-line-strong)" />
    </svg>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  meta,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2.5">
      <div className="min-w-0">
        <h1 className="truncate text-[14px] font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-0.5 truncate text-[12px] text-[var(--color-ink-muted)]">{subtitle}</p>
        ) : null}
        {meta ? <div className="mt-1.5 flex flex-wrap items-center gap-3">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5 pt-0.5">{actions}</div> : null}
    </header>
  );
}
