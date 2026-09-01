import { defineResearchPipeline } from '@frp/config';
import type { ResearchPipelineConfig } from '@frp/schemas';
import { describe, expect, it } from 'vitest';
import { REDACTED, sanitizeDetail } from '../src/redact.js';
import {
  applyTrust,
  effectiveTrust,
  isSelfReportedSource,
  resolveSourceTrust,
} from '../src/trust.js';

/**
 * Source trust and redaction.
 *
 * Trust decides how much of a provider's confidence survives; redaction
 * decides what is safe to keep from a provider's error body. Both run on every
 * value a pipeline stores, so both are pinned down closely.
 */

const config: ResearchPipelineConfig = defineResearchPipeline({
  key: 'trust-test',
  name: 'Trust test',
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
    ],
  },
});

describe('resolveSourceTrust', () => {
  it('matches a listed domain', () => {
    const trust = resolveSourceTrust(config, {
      url: 'https://www.linkedin.com/company/acme',
      kind: 'page',
    });
    expect(trust.categoryId).toBe('professional-network');
    expect(trust.score).toBe(0.9);
  });

  it('treats a leading wildcard as a suffix rule', () => {
    expect(
      resolveSourceTrust(config, { url: 'https://data.gouv.fr/x', kind: 'page' }).categoryId,
    ).toBe('government');
    expect(
      resolveSourceTrust(config, { url: 'https://impots.gouv.fr/x', kind: 'page' }).categoryId,
    ).toBe('government');
  });

  it('does not let a listed domain claim a lookalike', () => {
    const trust = resolveSourceTrust(config, { url: 'https://notlinkedin.com/x', kind: 'page' });
    expect(trust.categoryId).toBeNull();
    expect(trust.score).toBe(config.sources.trust.defaultScore);
  });

  it('falls back to the default for an unknown host', () => {
    const trust = resolveSourceTrust(config, { url: 'https://blog.example/post', kind: 'page' });
    expect(trust.categoryId).toBeNull();
    expect(trust.score).toBe(0.5);
  });

  it('prefers a domain match over a kind match', () => {
    // `dataset` would match `official-dataset` on kind alone; the government
    // domain rule is more specific and must win.
    const trust = resolveSourceTrust(config, { url: 'https://sec.gov/filing', kind: 'dataset' });
    expect(trust.categoryId).toBe('government');
  });

  it('matches on source kind when nothing else claims the source', () => {
    const trust = resolveSourceTrust(config, { url: 'https://unknown.example', kind: 'manual' });
    expect(trust.categoryId).toBe('operator-entered');
    expect(trust.score).toBe(1);
  });

  it('prefers a pattern match over a kind match', () => {
    const patterned = defineResearchPipeline({
      ...structuredClone(rawConfig),
      sources: {
        trust: {
          categories: [
            {
              id: 'press-release',
              label: 'Press release',
              score: 0.7,
              patterns: ['/press-releases?/'],
            },
            { id: 'any-page', label: 'Any page', score: 0.2, kinds: ['page'] },
          ],
        },
      },
    });
    expect(
      resolveSourceTrust(patterned, { url: 'https://x.example/press-release/1', kind: 'page' })
        .categoryId,
    ).toBe('press-release');
  });

  it('survives a malformed pattern instead of throwing mid-run', () => {
    // The config schema rejects a bad pattern at authoring time, so this can
    // only reach the resolver from a run snapshot written before that check
    // existed. A historical run must still be re-runnable, not crash on read.
    const broken = structuredClone(config);
    broken.sources.trust.categories = [
      {
        id: 'broken',
        label: 'Broken',
        score: 0.9,
        patterns: ['([unclosed'],
        domains: [],
        kinds: [],
      },
    ];
    expect(() =>
      resolveSourceTrust(broken, { url: 'https://x.example', kind: 'page' }),
    ).not.toThrow();
    expect(
      resolveSourceTrust(broken, { url: 'https://x.example', kind: 'page' }).categoryId,
    ).toBeNull();
  });

  it('rejects a malformed pattern at configuration time', () => {
    expect(() =>
      defineResearchPipeline({
        ...structuredClone(rawConfig),
        sources: {
          trust: {
            categories: [{ id: 'broken', label: 'Broken', score: 0.9, patterns: ['([unclosed'] }],
          },
        },
      }),
    ).toThrow(/invalid pattern/);
  });
});

describe('applyTrust', () => {
  it('leaves confidence untouched at full trust', () => {
    expect(applyTrust(0.9, 1, 0.5)).toBeCloseTo(0.9);
  });

  it('is inert at zero weight, whatever the trust', () => {
    expect(applyTrust(0.9, 0.1, 0)).toBeCloseTo(0.9);
  });

  it('damps proportionally to weight', () => {
    // 0.9 * (1 - 0.5 + 0.5 * 0.4) = 0.9 * 0.7
    expect(applyTrust(0.9, 0.4, 0.5)).toBeCloseTo(0.63);
  });

  it('never raises a confidence, however trusted the source', () => {
    for (const trust of [0, 0.5, 1]) {
      expect(applyTrust(0.6, trust, 1)).toBeLessThanOrEqual(0.6);
    }
  });
});

describe('isSelfReportedSource', () => {
  it('recognises a page on the entity own domain', () => {
    expect(
      isSelfReportedSource(config, { website: 'https://acme.com' }, 'https://www.acme.com/about'),
    ).toBe(true);
  });

  it('does not treat a directory listing as self-reported', () => {
    expect(
      isSelfReportedSource(config, { website: 'https://acme.com' }, 'https://crunchbase.com/acme'),
    ).toBe(false);
  });

  it('promotes trust only upward', () => {
    const low = { score: 0.4, categoryId: null, label: 'x' };
    expect(effectiveTrust(config, low, true).score).toBe(1);
    const high = { score: 1, categoryId: 'government', label: 'Gov' };
    expect(effectiveTrust(config, high, true).categoryId).toBe('government');
  });
});

describe('sanitizeDetail', () => {
  it('redacts values under credential-shaped keys', () => {
    const output = sanitizeDetail({ authorization: 'Bearer abc123', status: 401 });
    expect(output).toEqual({ authorization: REDACTED, status: 401 });
  });

  it('redacts a token embedded in free text', () => {
    const output = sanitizeDetail({ message: 'rejected key sk-ant-abcdefghijklmnop' });
    expect(String(output?.message)).toContain(REDACTED);
    expect(String(output?.message)).not.toContain('abcdefghijklmnop');
  });

  it('bounds strings, arrays and depth', () => {
    const output = sanitizeDetail({
      long: 'x'.repeat(5_000),
      many: Array.from({ length: 50 }, (_, i) => i),
    });
    expect(String(output?.long).length).toBeLessThan(2_100);
    expect((output?.many as unknown[]).length).toBe(21);
  });

  it('returns null for nothing rather than an empty shell', () => {
    expect(sanitizeDetail(undefined)).toBeNull();
    expect(sanitizeDetail(null)).toBeNull();
  });

  it('never throws on a circular structure', () => {
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    expect(() => sanitizeDetail(circular)).not.toThrow();
  });
});

/** Raw input reused by the tests that need a differently-configured pipeline. */
const rawConfig = {
  key: 'trust-test',
  name: 'Trust test',
  entity: {
    type: 'company',
    label: 'Company',
    labelPlural: 'Companies',
    displayField: 'name',
    identity: { fields: ['website'], normalizer: 'domain' as const },
  },
  extraction: {
    fields: [
      { key: 'name', label: 'Name', type: 'string' as const, required: true },
      { key: 'website', label: 'Website', type: 'url' as const, required: true },
    ],
  },
};
