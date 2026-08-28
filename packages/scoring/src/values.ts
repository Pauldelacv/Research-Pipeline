/** Value coercion shared by the condition evaluator and the validation step. */

export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    // Tolerates "1,200", "€2.5M", "20-500" (takes the first number).
    const normalised = value.replace(/[\s,]/g, '');
    const match = /-?\d+(?:\.\d+)?/.exec(normalised);
    if (!match) return undefined;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === null || value === undefined) return [];
  return [String(value)];
}

export function normaliseText(value: unknown): string {
  return String(value).trim().toLowerCase();
}

/** Compact, quotable rendering of a value for explanation strings. */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (Array.isArray(value)) {
    const shown = value.slice(0, 3).map((v) => String(v));
    return `[${shown.join(', ')}${value.length > 3 ? `, +${value.length - 3}` : ''}]`;
  }
  if (typeof value === 'string')
    return value.length > 48 ? `"${value.slice(0, 45)}…"` : `"${value}"`;
  return String(value);
}
