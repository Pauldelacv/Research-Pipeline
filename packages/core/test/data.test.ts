import { defineResearchPipeline } from '@frp/config';
import type { EntityField, ResearchPipelineConfig } from '@frp/schemas';
import { describe, expect, it } from 'vitest';
import { deterministicId, newId } from '../src/ids.js';
import { aggregateConfidence, mergeFields, projectData, valuesAgree } from '../src/merge.js';
import {
  buildDedupeKey,
  canonicaliseUrl,
  coerceFieldValue,
  extractDomain,
  normaliseName,
} from '../src/normalize.js';
import { entityEvaluationFields } from '../src/evaluation.js';

/**
 * Normalisation, identity and merge.
 *
 * These decide whether a run produces "140 companies" or "140 rows, 60 of
 * which are the same company three times", so they are pinned down closely.
 */

const config: ResearchPipelineConfig = defineResearchPipeline({
  key: 'data-test',
  name: 'Data test',
  entity: {
    type: 'company',
    label: 'Company',
    labelPlural: 'Companies',
    displayField: 'name',
    identity: { fields: ['website'], normalizer: 'domain' },
  },
  extraction: {
    fields: [
      { key: 'name', label: 'Name', type: 'string', required: true },
      { key: 'website', label: 'Website', type: 'url', required: true },
      { key: 'employeeCount', label: 'Employees', type: 'integer' },
      { key: 'stage', label: 'Stage', type: 'enum', options: ['Seed', 'Series A'] },
      { key: 'tech', label: 'Tech', type: 'string_array' },
      { key: 'active', label: 'Active', type: 'boolean' },
      { key: 'founded', label: 'Founded', type: 'date' },
    ],
  },
});

describe('canonicaliseUrl', () => {
  it('normalises scheme, host case and trailing slash', () => {
    expect(canonicaliseUrl('HTTP://WWW.Acme.COM/about/')).toBe('https://www.acme.com/about');
  });

  it('strips tracking parameters but keeps meaningful ones', () => {
    expect(canonicaliseUrl('https://acme.com/p?utm_source=x&id=7')).toBe('https://acme.com/p?id=7');
  });

  it('accepts a bare host', () => {
    expect(canonicaliseUrl('acme.com')).toBe('https://acme.com/');
  });
});

describe('extractDomain', () => {
  it('drops a common subdomain but keeps a meaningful one', () => {
    expect(extractDomain('https://www.acme.com/about')).toBe('acme.com');
    expect(extractDomain('https://careers.acme.com')).toBe('careers.acme.com');
  });

  it('handles multi-part hosts', () => {
    expect(extractDomain('https://www.acme.co.uk')).toBe('acme.co.uk');
  });
});

describe('normaliseName', () => {
  it('folds accents, case and legal suffixes', () => {
    expect(normaliseName('Sociéte Générale SAS')).toBe(normaliseName('societe generale'));
    expect(normaliseName('Acme Inc.')).toBe('acme');
  });
});

describe('buildDedupeKey', () => {
  it('derives identity from the configured field and normaliser', () => {
    const a = buildDedupeKey(config, { website: 'https://www.acme.com/about' });
    const b = buildDedupeKey(config, { website: 'http://acme.com' });
    expect(a).toBe('acme.com');
    expect(a).toBe(b);
  });

  it('returns null when no identity field carries a value', () => {
    expect(buildDedupeKey(config, { name: 'Acme' })).toBeNull();
  });
});

describe('coerceFieldValue', () => {
  const field = (key: string) => config.extraction.fields.find((f) => f.key === key)!;

  it('parses a number out of prose', () => {
    expect(coerceFieldValue(field('employeeCount'), 'about 1,200 people')).toBe(1200);
    expect(coerceFieldValue(field('employeeCount'), '2.5M')).toBe(2_500_000);
  });

  it('rejects a value it cannot type, rather than storing garbage', () => {
    expect(coerceFieldValue(field('employeeCount'), 'lots')).toBeUndefined();
    expect(coerceFieldValue(field('founded'), 'not a date')).toBeUndefined();
  });

  it('coerces enums tolerantly but only onto declared options', () => {
    expect(coerceFieldValue(field('stage'), 'series-a')).toBe('Series A');
    expect(coerceFieldValue(field('stage'), 'Series D')).toBeUndefined();
  });

  it('splits delimited strings into arrays', () => {
    expect(coerceFieldValue(field('tech'), 'HubSpot, Segment; Stripe')).toEqual([
      'HubSpot',
      'Segment',
      'Stripe',
    ]);
  });

  it('understands textual booleans', () => {
    expect(coerceFieldValue(field('active'), 'yes')).toBe(true);
    expect(coerceFieldValue(field('active'), 'no')).toBe(false);
    expect(coerceFieldValue(field('active'), 'maybe')).toBeUndefined();
  });

  it('treats an empty string as absent, not as a value', () => {
    expect(coerceFieldValue(field('name'), '   ')).toBeNull();
  });
});

describe('mergeFields', () => {
  const existingField = (overrides: Partial<EntityField> = {}): EntityField => ({
    id: 'fld_1',
    entityId: 'ent_1',
    key: 'employeeCount',
    value: 200,
    confidence: 0.8,
    status: 'auto',
    extractedBy: 'source-a',
    previousValue: null,
    reviewedBy: null,
    reviewedAt: null,
    agreementCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('raises confidence and agreement when sources agree', () => {
    const { fields, conflicts } = mergeFields(
      [existingField()],
      [
        {
          key: 'employeeCount',
          value: 205,
          confidence: 0.8,
          extractedBy: 'source-b',
          evidence: [],
        },
      ],
    );

    expect(conflicts).toHaveLength(0);
    expect(fields[0]?.agreementCount).toBe(2);
    expect(fields[0]?.confidence).toBeGreaterThan(0.8);
  });

  it('takes the higher-confidence value on conflict and lowers confidence', () => {
    const { fields, conflicts } = mergeFields(
      [existingField()],
      [
        {
          key: 'employeeCount',
          value: 900,
          confidence: 0.95,
          extractedBy: 'source-b',
          evidence: [],
        },
      ],
    );

    expect(conflicts).toEqual(['employeeCount']);
    expect(fields[0]?.value).toBe(900);
    // Penalised, so the field lands in the review queue rather than shipping.
    expect(fields[0]?.confidence).toBeCloseTo(0.8, 5);
    expect(fields[0]?.agreementCount).toBe(1);
  });

  it('never overwrites a human decision', () => {
    for (const status of ['edited', 'approved'] as const) {
      const { fields } = mergeFields(
        [existingField({ status, value: 42, confidence: 1 })],
        [
          {
            key: 'employeeCount',
            value: 9999,
            confidence: 0.99,
            extractedBy: 'source-b',
            evidence: [],
          },
        ],
      );
      expect(fields[0]?.value).toBe(42);
      expect(fields[0]?.status).toBe(status);
    }
  });

  it('adds fields it has not seen before', () => {
    const { fields } = mergeFields(
      [],
      [{ key: 'name', value: 'Acme', confidence: 0.9, extractedBy: 'a', evidence: [] }],
    );
    expect(fields).toHaveLength(1);
    expect(fields[0]?.status).toBe('auto');
  });
});

describe('valuesAgree', () => {
  it('tolerates small numeric drift between estimates', () => {
    expect(valuesAgree(200, 205)).toBe(true);
    expect(valuesAgree(200, 300)).toBe(false);
  });

  it('compares arrays as sets', () => {
    expect(valuesAgree(['a', 'b'], ['B', 'A'])).toBe(true);
    expect(valuesAgree(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('aggregateConfidence', () => {
  it('weights required fields above optional ones', () => {
    const complete = aggregateConfidence(config, [
      { key: 'name', value: 'Acme', confidence: 0.9 },
      { key: 'website', value: 'https://acme.com', confidence: 0.9 },
    ]);
    const missingRequired = aggregateConfidence(config, [
      { key: 'name', value: 'Acme', confidence: 0.9 },
    ]);
    expect(complete).toBeGreaterThan(missingRequired);
  });

  it('returns zero for an entity with nothing extracted', () => {
    expect(aggregateConfidence(config, [])).toBe(0);
  });
});

describe('projectData', () => {
  it('includes every declared field, null when absent', () => {
    const data = projectData(config.extraction.fields, [{ key: 'name', value: 'Acme' }]);
    expect(data.name).toBe('Acme');
    expect(data.employeeCount).toBeNull();
    expect(Object.keys(data)).toHaveLength(config.extraction.fields.length);
  });
});

describe('entityEvaluationFields', () => {
  it('exposes computed metadata alongside extracted fields', () => {
    const fields = entityEvaluationFields(config, {
      data: { name: 'Acme' },
      score: 82,
      confidence: 0.9,
      status: 'approved',
      validationStatus: 'valid',
      sourceCount: 3,
      displayName: 'Acme',
      scoreBreakdown: { band: 'qualified' },
    } as never);

    expect(fields.name).toBe('Acme');
    expect(fields.score).toBe(82);
    expect(fields.scoreBand).toBe('qualified');
  });

  it('lets a declared field of the same name win', () => {
    const shadowing = defineResearchPipeline({
      ...config,
      extraction: {
        fields: [
          ...config.extraction.fields,
          { key: 'score', label: 'Vendor score', type: 'integer' },
        ],
      },
    });

    const fields = entityEvaluationFields(shadowing, {
      data: { score: 7 },
      score: 82,
      confidence: 0.9,
      status: 'new',
      validationStatus: 'valid',
      sourceCount: 1,
      displayName: 'Acme',
      scoreBreakdown: null,
    } as never);

    expect(fields.score).toBe(7);
  });
});

describe('identifiers', () => {
  it('derives the same id from the same content', () => {
    expect(deterministicId('src', 'run_1', 'https://acme.com')).toBe(
      deterministicId('src', 'run_1', 'https://acme.com'),
    );
  });

  it('derives different ids from different content', () => {
    expect(deterministicId('src', 'run_1', 'https://acme.com')).not.toBe(
      deterministicId('src', 'run_1', 'https://beta.com'),
    );
  });

  it('generates unique random ids with a readable prefix', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('run')));
    expect(ids.size).toBe(500);
    expect([...ids][0]).toMatch(/^run_[0-9a-z]{22}$/);
  });
});
