/**
 * Redaction for anything a provider hands back that we intend to store.
 *
 * A provider's error body is the most useful thing in a failure report and the
 * most likely place for a credential to appear — an echoed `Authorization`
 * header, a signed URL, a key in a "your request was" dump. Redacting at the
 * point of *persistence* rather than at the point of display means a leak
 * cannot be reintroduced later by a new view over the same rows.
 *
 * The rules are intentionally blunt. Over-redacting a debugging aid is cheap;
 * writing a live API key into a table an operator can read is not.
 */

const SENSITIVE_KEY = /(pass|secret|token|key|auth|cookie|credential|signature|session)/i;

/** Anything shaped like a bearer token, an API key or a signed URL parameter. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\bsk-(?:ant|or|proj)[-_][A-Za-z0-9._-]{12,}/gi,
  /\b(?:api[_-]?key|access[_-]?token)=[^&\s"']{8,}/gi,
];

export const REDACTED = '[redacted]';

const MAX_STRING = 2_000;
const MAX_ARRAY = 20;
const MAX_DEPTH = 6;

/**
 * Produces a JSON-safe, redacted, size-bounded copy of arbitrary provider
 * output. Never throws: a failure report must not itself fail.
 */
export function sanitizeDetail(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const sanitized = walk(value, 0, false);
  if (sanitized === undefined) return null;
  if (typeof sanitized === 'object' && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
}

export function redactString(input: string): string {
  let output = input;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) output = output.replace(pattern, REDACTED);
  return output.length > MAX_STRING ? `${output.slice(0, MAX_STRING)}… [truncated]` : output;
}

function walk(value: unknown, depth: number, redacted: boolean): unknown {
  if (redacted) return REDACTED;
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }

  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY)
      .map((item) => walk(item, depth + 1, false))
      .filter((item) => item !== undefined);
    if (value.length > MAX_ARRAY) items.push(`… ${value.length - MAX_ARRAY} more`);
    return items;
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const result = walk(entry, depth + 1, SENSITIVE_KEY.test(key));
      if (result !== undefined) output[key] = result;
    }
    return output;
  }

  return undefined;
}
