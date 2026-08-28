'use client';

import { Field, Input, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/format';
import type { TargetingFieldDefinition } from '@frp/schemas';

/**
 * Renders the "Create Research" form from a pipeline's `targeting.fields`.
 *
 * This component is the reason the framework is configurable rather than
 * merely parameterised: it knows about field *types*, never about industries
 * or company sizes. Registering a pipeline that asks for a market and a set of
 * competitor names produces the right form with no change here.
 */
export type TargetingState = Record<string, unknown>;

export function initialTargeting(fields: TargetingFieldDefinition[]): TargetingState {
  const state: TargetingState = {};
  for (const field of fields) {
    if (field.defaultValue !== undefined) {
      state[field.key] = field.defaultValue;
    } else if (
      field.type === 'multiselect' ||
      field.type === 'checkbox_group' ||
      field.type === 'tags'
    ) {
      state[field.key] = [];
    } else if (field.type === 'range') {
      state[field.key] = [field.min ?? 0, field.max ?? 100];
    } else {
      state[field.key] = '';
    }
  }
  return state;
}

export function TargetingForm({
  fields,
  value,
  onChange,
}: {
  fields: TargetingFieldDefinition[];
  value: TargetingState;
  onChange: (next: TargetingState) => void;
}) {
  const set = (key: string, next: unknown) => onChange({ ...value, [key]: next });

  const groups = new Map<string, TargetingFieldDefinition[]>();
  for (const field of fields) {
    const group = field.group ?? 'Target';
    groups.set(group, [...(groups.get(group) ?? []), field]);
  }

  return (
    <div className="flex flex-col gap-4">
      {[...groups.entries()].map(([group, groupFields]) => (
        <fieldset key={group} className="flex flex-col gap-3">
          <legend className="mb-1 w-full border-b border-[var(--color-line)] pb-1 text-[10px] font-semibold tracking-[0.1em] text-[var(--color-ink-faint)] uppercase">
            {group}
          </legend>

          {groupFields.map((field) => (
            <TargetingControl
              key={field.key}
              field={field}
              value={value[field.key]}
              onChange={(next) => set(field.key, next)}
            />
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function TargetingControl({
  field,
  value,
  onChange,
}: {
  field: TargetingFieldDefinition;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  switch (field.type) {
    case 'text':
      return (
        <Field label={field.label} hint={field.help} required={field.required}>
          <Input
            value={String(value ?? '')}
            placeholder={field.placeholder}
            onChange={(event) => onChange(event.target.value)}
          />
        </Field>
      );

    case 'textarea':
      return (
        <Field label={field.label} hint={field.help} required={field.required}>
          <textarea
            value={String(value ?? '')}
            placeholder={field.placeholder}
            rows={3}
            onChange={(event) => onChange(event.target.value)}
            className="w-full border border-[var(--color-line)] bg-[var(--color-base)] px-2 py-1.5 text-[12px] focus:border-[var(--color-accent)] focus:outline-none"
            style={{ borderRadius: 'var(--radius-sm)' }}
          />
        </Field>
      );

    case 'number':
      return (
        <Field label={field.label} hint={field.help} required={field.required}>
          <Input
            type="number"
            value={String(value ?? '')}
            min={field.min}
            max={field.max}
            onChange={(event) => onChange(Number(event.target.value))}
          />
        </Field>
      );

    case 'select':
      return (
        <Field label={field.label} hint={field.help} required={field.required}>
          <Select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
            <option value="">—</option>
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      );

    case 'multiselect':
    case 'checkbox_group': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <Field label={field.label} hint={field.help} required={field.required}>
          <div className="flex flex-col gap-1 border border-[var(--color-line)] bg-[var(--color-base)] p-1.5">
            {field.options?.map((option) => {
              const checked = selected.includes(option.value);
              return (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 px-1 py-0.5 text-[12px] hover:bg-[var(--color-raised)]"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      onChange(
                        checked
                          ? selected.filter((item) => item !== option.value)
                          : [...selected, option.value],
                      )
                    }
                    className="h-3 w-3 accent-[var(--color-accent)]"
                  />
                  <span className={cn(!checked && 'text-[var(--color-ink-muted)]')}>
                    {option.label}
                  </span>
                </label>
              );
            })}
          </div>
        </Field>
      );
    }

    case 'range': {
      const range = Array.isArray(value) ? (value as number[]) : [field.min ?? 0, field.max ?? 100];
      return (
        <Field label={field.label} hint={field.help} required={field.required}>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              className="tnum"
              value={String(range[0] ?? '')}
              min={field.min}
              max={field.max}
              onChange={(event) => onChange([Number(event.target.value), range[1]])}
            />
            <span className="text-[var(--color-ink-faint)]">to</span>
            <Input
              type="number"
              className="tnum"
              value={String(range[1] ?? '')}
              min={field.min}
              max={field.max}
              onChange={(event) => onChange([range[0], Number(event.target.value)])}
            />
          </div>
        </Field>
      );
    }

    case 'tags': {
      const tags = Array.isArray(value) ? (value as string[]) : [];
      return (
        <Field label={field.label} hint={field.help ?? 'Comma separated'} required={field.required}>
          <Input
            value={tags.join(', ')}
            placeholder={field.placeholder}
            onChange={(event) =>
              onChange(
                event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
            }
          />
        </Field>
      );
    }

    default:
      return null;
  }
}
