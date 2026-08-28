import type { FieldDefinition, JsonValue, TargetingValues } from '@frp/schemas';
import {
  COUNTRIES,
  EU_CITIES,
  EVENT_TYPES,
  FIRST_NAMES,
  FRENCH_CITIES,
  FUNDING_STAGES,
  INDUSTRIES,
  JOB_TITLES,
  LAST_NAMES,
  NAME_PREFIXES,
  NAME_SUFFIXES,
  POSITIONING,
  SEGMENTS,
  SNIPPET_TEMPLATES,
  TECHNOLOGIES,
} from './corpus.js';
import { SeededRandom } from './random.js';

/**
 * A deterministic synthetic world.
 *
 * The world is *stateless*: `entityFor(slug)` re-derives the same record from
 * the seed and the slug alone. That is what lets the search provider invent a
 * URL and the extraction provider — a different object, in a different worker,
 * minutes later — recover exactly the entity that URL refers to, without any
 * shared state or fixture file.
 *
 * Everything is driven by the pipeline's own field definitions. Nothing here
 * knows about lead generation; a configuration describing market segments
 * produces market segments.
 */

/** Size of the entity universe. Overlap across queries is what creates merges. */
const UNIVERSE = 320;

export interface WorldEntity {
  slug: string;
  index: number;
  /** Canonical values. Observations add noise on top of these. */
  values: Record<string, JsonValue | null>;
  /** Prose the extraction provider quotes as evidence. */
  narrative: string;
  primaryDomain: string;
}

export class MockWorld {
  constructor(
    private readonly seed: string,
    private readonly fields: FieldDefinition[],
    private readonly targeting: TargetingValues = {},
  ) {}

  /** Stable slug for the nth member of the universe. */
  slugAt(index: number): string {
    const wrapped = ((index % UNIVERSE) + UNIVERSE) % UNIVERSE;
    const random = new SeededRandom(`${this.seed}:slug:${wrapped}`);
    const prefix = random.pick(NAME_PREFIXES);
    const suffix = random.pick(NAME_SUFFIXES);
    const base = suffix ? `${prefix}-${suffix}` : prefix;
    return `${base.toLowerCase()}-${wrapped.toString(36)}`;
  }

  entityFor(slug: string): WorldEntity {
    const random = new SeededRandom(`${this.seed}:entity:${slug}`);
    const index = parseInt(slug.split('-').pop() ?? '0', 36);

    const displayName = slug
      .split('-')
      .slice(0, -1)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');

    const domain = `${slug.replace(/-/g, '')}.${random.pick(['com', 'io', 'fr', 'eu', 'co'])}`;
    const region = String(this.targeting.location ?? this.targeting.country ?? '').toLowerCase();
    const city = region.includes('france')
      ? random.pick(FRENCH_CITIES)
      : random.pick([...FRENCH_CITIES, ...EU_CITIES]);
    const country = region.includes('france') ? 'France' : random.pick(COUNTRIES);

    const employees = this.employeeCountFor(random);
    const founded = random.int(2008, 2023);
    const stage = random.pick(FUNDING_STAGES);
    const technologies = random.sample(TECHNOLOGIES, random.int(2, 6));
    const industry = this.industryFor(random);
    const openRoles = random.int(0, 24);

    const context: GenerationContext = {
      random,
      slug,
      displayName,
      domain,
      city,
      country,
      employees,
      founded,
      stage,
      technologies,
      industry,
      openRoles,
      index,
    };

    const values: Record<string, JsonValue | null> = {};
    for (const field of this.fields) {
      values[field.key] = generateValue(field, context);
    }

    return {
      slug,
      index,
      values,
      narrative: renderNarrative(context),
      primaryDomain: domain,
    };
  }

  /**
   * Honours a `companySize` / `employees` targeting range when the operator
   * supplied one, so filtering the search actually changes the results.
   */
  private employeeCountFor(random: SeededRandom): number {
    const raw = this.targeting.companySize ?? this.targeting.employeeCount ?? this.targeting.size;
    const range = parseRange(raw);
    if (!range) return Math.round(2 ** random.float(3, 11, 3));
    // Most results land inside the requested band; a minority fall outside,
    // which is what gives the validation and scoring steps something to do.
    const inside = random.bool(0.8);
    return inside
      ? random.int(range[0], range[1])
      : random.bool()
        ? Math.max(1, Math.round(range[0] * random.float(0.2, 0.9)))
        : Math.round(range[1] * random.float(1.1, 3));
  }

  private industryFor(random: SeededRandom): string {
    const wanted = this.targeting.industry;
    const options = INDUSTRIES;
    if (typeof wanted === 'string' && wanted.trim()) {
      const match = options.find((option) =>
        option.toLowerCase().includes(wanted.trim().toLowerCase()),
      );
      if (match && random.bool(0.75)) return match;
    }
    if (Array.isArray(wanted) && wanted.length > 0 && random.bool(0.75)) {
      const first = String(wanted[0]);
      const match = options.find((option) => option.toLowerCase().includes(first.toLowerCase()));
      if (match) return match;
    }
    return random.pick(options);
  }
}

interface GenerationContext {
  random: SeededRandom;
  slug: string;
  displayName: string;
  domain: string;
  city: string;
  country: string;
  employees: number;
  founded: number;
  stage: string;
  technologies: string[];
  industry: string;
  openRoles: number;
  index: number;
}

/**
 * Produces a value for a field the configuration declared.
 *
 * Resolution order: a key-name heuristic first (so `employeeCount` gets a head
 * count rather than an arbitrary number), then the declared type. Enum fields
 * always draw from their own declared options, never from the corpus, so a
 * client-specific enum stays valid.
 */
function generateValue(field: FieldDefinition, ctx: GenerationContext): JsonValue | null {
  const { random } = ctx;
  const key = field.key.toLowerCase();

  if (field.type === 'enum' && field.options?.length) {
    return random.pick(field.options);
  }

  // Dates are resolved before the key heuristics below, otherwise a key like
  // `lastFundingDate` would match the funding branch and yield prose that no
  // date coercion could accept.
  if (field.type === 'date') {
    // Funding dates skew recent enough that the "recent funding" signal fires
    // for part of the universe — which is what gives the scoring demo a
    // spread of scores rather than one repeated number.
    const maxAgeDays = key.includes('fund') ? 1_000 : 900;
    const daysAgo = random.int(15, maxAgeDays);
    return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  }

  if (key.includes('linkedin')) {
    return `https://www.linkedin.com/company/${ctx.slug}`;
  }
  if (key === 'website' || key === 'url' || key.endsWith('website')) {
    return `https://${ctx.domain}`;
  }
  if (key.includes('domain')) return ctx.domain;
  if (key === 'name' || key.endsWith('name')) {
    if (key.includes('contact') || key.includes('person')) {
      return `${random.pick(FIRST_NAMES)} ${random.pick(LAST_NAMES)}`;
    }
    return ctx.displayName;
  }
  if (key.includes('industry') || key.includes('category') || key.includes('vertical')) {
    return ctx.industry;
  }
  if (key.includes('employee') || key.includes('headcount') || key.includes('staff')) {
    return ctx.employees;
  }
  if (
    key.includes('city') ||
    key.includes('location') ||
    key.includes('headquarter') ||
    key === 'hq'
  ) {
    return `${ctx.city}, ${ctx.country}`;
  }
  if (key.includes('country')) return ctx.country;
  if (key.includes('founded') || key.includes('year')) return ctx.founded;
  if (key.includes('stage') || key.includes('round')) return ctx.stage;
  if (key.includes('fundingamount') || key.includes('raised') || key.includes('amount')) {
    return Math.round(2 ** random.float(19, 25, 3));
  }
  if (key.includes('funding')) {
    return `${ctx.stage} (${ctx.founded + random.int(1, 6)})`;
  }
  if (key.includes('tech') || key.includes('stack') || key.includes('tool')) {
    return ctx.technologies;
  }
  if (key.includes('hiring') || key.includes('openrole') || key.includes('job')) {
    return field.type === 'boolean' ? ctx.openRoles > 0 : ctx.openRoles;
  }
  if (key.includes('segment') || key.includes('audience')) return random.pick(SEGMENTS);
  if (key.includes('positioning') || key.includes('strategy')) return random.pick(POSITIONING);
  if (key.includes('event') || key.includes('change') || key.includes('signaltype')) {
    return random.pick(EVENT_TYPES);
  }
  if (key.includes('title') || key.includes('role')) return random.pick(JOB_TITLES);
  if (key.includes('email')) {
    return `${random.pick(FIRST_NAMES).toLowerCase()}@${ctx.domain}`;
  }
  if (key.includes('price') || key.includes('mrr') || key.includes('arr')) {
    return random.int(19, 4800);
  }
  if (key.includes('description') || key.includes('summary') || key.includes('note')) {
    return renderNarrative(ctx);
  }

  return byType(field, ctx);
}

function byType(field: FieldDefinition, ctx: GenerationContext): JsonValue | null {
  const { random } = ctx;
  const min = field.min ?? 0;
  const max = field.max ?? 1000;

  switch (field.type) {
    case 'string':
      return field.examples?.length ? random.pick(field.examples) : ctx.displayName;
    case 'text':
      return renderNarrative(ctx);
    case 'number':
    case 'money':
      return random.float(min, max);
    case 'integer':
      return random.int(Math.round(min), Math.round(max));
    case 'boolean':
      return random.bool(0.45);
    case 'url':
      return `https://${ctx.domain}/${field.key.toLowerCase()}`;
    case 'email':
      return `${field.key.toLowerCase()}@${ctx.domain}`;
    case 'string_array':
      return random.sample(TECHNOLOGIES, random.int(1, 4));
    case 'enum':
      return field.options?.length ? random.pick(field.options) : null;
    default:
      return null;
  }
}

function renderNarrative(ctx: GenerationContext): string {
  const template = ctx.random.pick(SNIPPET_TEMPLATES);
  return template
    .replaceAll('{name}', ctx.displayName)
    .replaceAll('{industry}', ctx.industry)
    .replaceAll('{city}', ctx.city)
    .replaceAll('{country}', ctx.country)
    .replaceAll('{employees}', String(ctx.employees))
    .replaceAll('{founded}', String(ctx.founded))
    .replaceAll('{stage}', ctx.stage)
    .replaceAll('{segment}', ctx.random.pick(SEGMENTS))
    .replaceAll('{tech}', ctx.technologies.slice(0, 3).join(', '))
    .replaceAll('{jobs}', String(ctx.openRoles));
}

/** Parses "20-500", "20 to 500", [20, 500] and {min,max} into a numeric range. */
export function parseRange(raw: unknown): [number, number] | null {
  if (Array.isArray(raw) && raw.length === 2) {
    const min = Number(raw[0]);
    const max = Number(raw[1]);
    if (Number.isFinite(min) && Number.isFinite(max))
      return [Math.min(min, max), Math.max(min, max)];
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const min = Number(record.min);
    const max = Number(record.max);
    if (Number.isFinite(min) && Number.isFinite(max)) return [min, max];
  }
  if (typeof raw === 'string') {
    const numbers = raw.match(/\d+/g);
    if (numbers && numbers.length >= 2) {
      const min = Number(numbers[0]);
      const max = Number(numbers[1]);
      return [Math.min(min, max), Math.max(min, max)];
    }
  }
  return null;
}

export const UNIVERSE_SIZE = UNIVERSE;
