import type { FieldDefinition, JsonValue, ResearchPipelineConfig } from '@frp/schemas';

/**
 * Normalisation and identity.
 *
 * Deduplication quality decides whether a run produces "140 companies" or
 * "140 rows, 60 of which are the same company three times". Identity is
 * derived from configured fields and a declared normaliser, so a deployment
 * targeting people or products dedupes just as well as one targeting
 * companies without any code change.
 */

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'ref',
  'referrer',
]);

const COMMON_SUBDOMAINS = new Set(['www', 'm', 'en', 'fr', 'de', 'es', 'app']);

export function canonicaliseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    url.hash = '';
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    for (const param of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(param.toLowerCase())) url.searchParams.delete(param);
    }
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return trimmed.toLowerCase();
  }
}

/** Registrable-ish domain: strips scheme, path and one common subdomain. */
export function extractDomain(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname.toLowerCase();
  } catch {
    hostname = trimmed.toLowerCase().split('/')[0] ?? '';
  }
  const labels = hostname.replace(/\.$/, '').split('.');
  if (labels.length > 2 && COMMON_SUBDOMAINS.has(labels[0] ?? '')) labels.shift();
  return labels.join('.');
}

export function normaliseName(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(sas|sarl|sa|inc|llc|ltd|gmbh|bv|plc|co|corp|corporation|company)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Builds the deduplication key for an entity from the configured identity
 * fields. Returns null when no identity field carries a value — such a
 * candidate cannot be merged safely and is dropped by the `structure` step.
 */
export function buildDedupeKey(
  config: ResearchPipelineConfig,
  values: Record<string, unknown>,
): string | null {
  const parts: string[] = [];
  for (const key of config.entity.identity.fields) {
    const raw = values[key];
    if (raw === null || raw === undefined || raw === '') continue;
    parts.push(applyNormaliser(String(raw), config.entity.identity.normalizer));
  }
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) return null;
  return filtered.join('|');
}

export function applyNormaliser(
  value: string,
  normalizer: ResearchPipelineConfig['entity']['identity']['normalizer'],
): string {
  switch (normalizer) {
    case 'domain':
      return extractDomain(value);
    case 'url':
      return canonicaliseUrl(value);
    case 'lowercase':
      return normaliseName(value);
    case 'none':
    default:
      return value.trim();
  }
}

/**
 * Coerces a provider-supplied value onto the declared field type.
 *
 * Extraction providers — LLM-backed ones especially — return "approximately
 * 250 employees" or "Series-A". Coercion happens once, here, so every
 * downstream consumer (validation, scoring, export) sees a typed value.
 * Returns `undefined` when the value cannot be coerced, which the caller
 * treats as "not extracted" rather than silently storing garbage.
 */
export function coerceFieldValue(
  field: FieldDefinition,
  raw: unknown,
): JsonValue | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;

  switch (field.type) {
    case 'string':
    case 'text':
      return String(raw).trim();

    case 'number':
    case 'money': {
      const value = parseNumeric(raw);
      return value === undefined ? undefined : value;
    }

    case 'integer': {
      const value = parseNumeric(raw);
      return value === undefined ? undefined : Math.round(value);
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const text = String(raw).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(text)) return true;
      if (['false', 'no', 'n', '0'].includes(text)) return false;
      return undefined;
    }

    case 'url': {
      const canonical = canonicaliseUrl(String(raw));
      return canonical.startsWith('https://') ? canonical : undefined;
    }

    case 'email': {
      const text = String(raw).trim().toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : undefined;
    }

    case 'date': {
      const date = new Date(String(raw));
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    case 'enum': {
      const text = String(raw).trim();
      const options = field.options ?? [];
      const exact = options.find((option) => option.toLowerCase() === text.toLowerCase());
      if (exact) return exact;
      // Tolerate "Series-A" for "Series A" and similar separator drift.
      const loose = options.find((option) => slug(option) === slug(text));
      return loose ?? undefined;
    }

    case 'string_array': {
      const values = Array.isArray(raw)
        ? raw
        : String(raw)
            .split(/[,;|]/)
            .map((part) => part.trim());
      const cleaned = values.map((v) => String(v).trim()).filter((v) => v.length > 0);
      return cleaned.length > 0 ? cleaned : null;
    }

    default:
      return undefined;
  }
}

function parseNumeric(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  const text = String(raw).replace(/[\s,\u00a0\u202f]/g, '');
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  if (!match) return undefined;
  let value = Number(match[0]);
  if (!Number.isFinite(value)) return undefined;
  // "€2.5M", "12k" — apply the magnitude suffix when it directly follows.
  const suffix = text
    .slice(text.indexOf(match[0]) + match[0].length, text.indexOf(match[0]) + match[0].length + 1)
    .toLowerCase();
  if (suffix === 'k') value *= 1_000;
  else if (suffix === 'm') value *= 1_000_000;
  else if (suffix === 'b') value *= 1_000_000_000;
  return value;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
