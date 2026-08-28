'use client';

import { cn, type Tone } from '@/lib/format';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

/**
 * UI primitives.
 *
 * Written directly rather than pulled from a component library: this is a
 * dense operations console with maybe a dozen distinct controls, and the whole
 * set fits in one file. Everything is built from hairline borders and flat
 * surfaces — no shadows, no gradients, one accent colour.
 */

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-[var(--color-ok)]',
  warn: 'text-[var(--color-warn)]',
  danger: 'text-[var(--color-danger)]',
  info: 'text-[var(--color-info)]',
  idle: 'text-[var(--color-idle)]',
};

const TONE_BG: Record<Tone, string> = {
  ok: 'bg-[var(--color-ok)]',
  warn: 'bg-[var(--color-warn)]',
  danger: 'bg-[var(--color-danger)]',
  info: 'bg-[var(--color-info)]',
  idle: 'bg-[var(--color-idle)]',
};

export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      className={cn(
        'inline-block h-[6px] w-[6px] shrink-0 rounded-full',
        TONE_BG[tone],
        pulse && 'pulse',
      )}
      aria-hidden
    />
  );
}

export function StatusPill({
  tone,
  label,
  pulse = false,
}: {
  tone: Tone;
  label: string;
  pulse?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 border border-[var(--color-line)] bg-[var(--color-surface)]',
        'px-1.5 py-[3px] text-[11px] font-medium tracking-wide uppercase',
        TONE_TEXT[tone],
      )}
      style={{ borderRadius: 'var(--radius-sm)' }}
    >
      <Dot tone={tone} pulse={pulse} />
      {label}
    </span>
  );
}

export function Button({
  variant = 'default',
  size = 'md',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 border font-medium whitespace-nowrap',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-[12px]',
        variant === 'default' &&
          'border-[var(--color-line-strong)] bg-[var(--color-raised)] text-[var(--color-ink)] hover:bg-[var(--color-overlay)]',
        variant === 'primary' &&
          'border-[var(--color-accent)] bg-[var(--color-accent-dim)] text-[var(--color-ink)] hover:brightness-125',
        variant === 'ghost' &&
          'border-transparent bg-transparent text-[var(--color-ink-muted)] hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]',
        variant === 'danger' &&
          'border-[var(--color-danger)]/50 bg-transparent text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10',
        className,
      )}
      style={{ borderRadius: 'var(--radius-sm)' }}
    >
      {children}
    </button>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'h-7 w-full border border-[var(--color-line)] bg-[var(--color-base)] px-2 text-[12px]',
        'text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)]',
        'focus:border-[var(--color-accent)] focus:outline-none',
        className,
      )}
      style={{ borderRadius: 'var(--radius-sm)' }}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'h-7 w-full appearance-none border border-[var(--color-line)] bg-[var(--color-base)]',
        'px-2 pr-6 text-[12px] text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none',
        className,
      )}
      style={{ borderRadius: 'var(--radius-sm)' }}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
        {label}
        {required ? <span className="ml-1 text-[var(--color-danger)]">*</span> : null}
      </span>
      {children}
      {hint ? <span className="text-[11px] text-[var(--color-ink-faint)]">{hint}</span> : null}
    </label>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn('border border-[var(--color-line)] bg-[var(--color-surface)]', className)}
      style={{ borderRadius: 'var(--radius-md)' }}
    >
      {title ? (
        <header className="flex h-9 items-center justify-between gap-3 border-b border-[var(--color-line)] px-3">
          <h2 className="text-[11px] font-semibold tracking-[0.08em] text-[var(--color-ink-muted)] uppercase">
            {title}
          </h2>
          {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(bodyClassName)}>{children}</div>
    </section>
  );
}

/** Horizontal proportion bar. Used for confidence and score, never decoration. */
export function Meter({ value, tone, width = 48 }: { value: number; tone: Tone; width?: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <span
      className="inline-block h-[4px] shrink-0 bg-[var(--color-line)]"
      style={{ width }}
      role="img"
      aria-label={`${Math.round(clamped * 100)}%`}
    >
      <span className={cn('block h-full', TONE_BG[tone])} style={{ width: `${clamped * 100}%` }} />
    </span>
  );
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-48 flex-col items-center justify-center gap-2 overflow-hidden px-6 py-10 text-center">
      <div className="grid-field pointer-events-none absolute inset-0" aria-hidden />
      <p className="relative text-[13px] text-[var(--color-ink)]">{title}</p>
      {hint ? (
        <p className="relative max-w-md text-[12px] text-[var(--color-ink-faint)]">{hint}</p>
      ) : null}
      {action ? <div className="relative mt-2">{action}</div> : null}
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-[family-name:var(--font-mono)] text-[11px]', className)}>
      {children}
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex items-end gap-0 border-b border-[var(--color-line)]" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'relative -mb-px border-b-2 px-3 py-1.5 text-[12px] transition-colors',
            active === tab.id
              ? 'border-[var(--color-accent)] text-[var(--color-ink)]'
              : 'border-transparent text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]',
          )}
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span className="tnum ml-1.5 text-[var(--color-ink-faint)]">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
