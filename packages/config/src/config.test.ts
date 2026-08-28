import type { ResearchPipelineConfigInput } from '@frp/schemas';
import { describe, expect, it } from 'vitest';
import { PipelineConfigError, defineResearchPipeline, parseResearchPipeline } from './define.js';
import { applyProjectOverrides } from './overrides.js';
import { PipelineRegistry } from './registry.js';
import { loadEnv } from './env.js';

/**
 * Configuration is the framework's public surface — an engineer standing up a
 * client writes one of these and nothing else. So invalid configurations must
 * fail at definition time with a message naming the offending path, and a
 * minimal configuration must be valid.
 */

const minimal: ResearchPipelineConfigInput = {
  key: 'minimal',
  name: 'Minimal',
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
    ],
  },
};

describe('defineResearchPipeline', () => {
  it('accepts a minimal configuration and fills in defaults', () => {
    const config = defineResearchPipeline(minimal);
    expect(config.version).toBe('1.0.0');
    expect(config.discovery.maxResults).toBe(100);
    expect(config.review.enabled).toBe(true);
    expect(config.validation.minimumConfidence).toBe(0.75);
    expect(config.export.destinations).toEqual([]);
  });

  it('rejects a display field that is not an extraction field', () => {
    expect(() =>
      defineResearchPipeline({
        ...minimal,
        entity: { ...minimal.entity, displayField: 'nope' },
      }),
    ).toThrow(/displayField "nope" is not an extraction field/);
  });

  it('rejects an identity field that is not an extraction field', () => {
    expect(() =>
      defineResearchPipeline({
        ...minimal,
        entity: { ...minimal.entity, identity: { fields: ['ghost'] } },
      }),
    ).toThrow(/identity field "ghost"/);
  });

  it('rejects duplicate field keys', () => {
    expect(() =>
      defineResearchPipeline({
        ...minimal,
        extraction: {
          fields: [...minimal.extraction.fields, { key: 'name', label: 'Again', type: 'string' }],
        },
      }),
    ).toThrow(/duplicate field key "name"/);
  });

  it('rejects an enum field with no options', () => {
    expect(() =>
      defineResearchPipeline({
        ...minimal,
        extraction: {
          fields: [...minimal.extraction.fields, { key: 'stage', label: 'Stage', type: 'enum' }],
        },
      }),
    ).toThrow(/must declare options/);
  });

  it('rejects a derived signal without a condition', () => {
    expect(() =>
      defineResearchPipeline({
        ...minimal,
        signals: [{ key: 'hiring', label: 'Hiring', source: 'derived' }],
      }),
    ).toThrow(/requires a "when" condition/);
  });

  it('rejects a graded scoring rule with no scale', () => {
    expect(() =>
      defineResearchPipeline({
        ...minimal,
        scoring: { rules: [{ id: 'r', label: 'R', weight: 10, mode: 'graded' }] },
      }),
    ).toThrow(/requires "scale"/);
  });

  it('reports every issue at once, with paths', () => {
    try {
      defineResearchPipeline({
        ...minimal,
        entity: { ...minimal.entity, displayField: 'nope', identity: { fields: ['ghost'] } },
      });
      expect.fail('expected a configuration error');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineConfigError);
      expect((error as PipelineConfigError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('parses without throwing when asked to', () => {
    const bad = parseResearchPipeline({ key: 'x' });
    expect(bad.ok).toBe(false);
    const good = parseResearchPipeline(minimal);
    expect(good.ok).toBe(true);
  });
});

describe('applyProjectOverrides', () => {
  const template = defineResearchPipeline({
    ...minimal,
    signals: [
      {
        key: 'big',
        label: 'Large',
        source: 'derived',
        when: { field: 'employeeCount', op: 'gt', value: 500 },
      },
    ],
    scoring: {
      rules: [
        {
          id: 'size',
          label: 'Size',
          weight: 20,
          when: { field: 'employeeCount', op: 'gt', value: 20 },
        },
        { id: 'named', label: 'Named', weight: 10, when: { field: 'name', op: 'exists' } },
      ],
    },
    export: {
      destinations: [
        { id: 'csv', label: 'CSV', connector: 'csv' },
        { id: 'json', label: 'JSON', connector: 'json' },
      ],
    },
  });

  it('narrows the field set and drops rules that reference removed fields', () => {
    const narrowed = applyProjectOverrides(template, {
      extraction: { fieldKeys: ['name'] },
    });

    const keys = narrowed.extraction.fields.map((field) => field.key);
    // Identity and display fields survive because they are structural.
    expect(keys).toContain('name');
    expect(keys).toContain('website');
    expect(keys).not.toContain('employeeCount');

    // The rule and signal that referenced the removed field are gone, so the
    // configuration stays valid rather than failing mid-run.
    expect(narrowed.scoring.rules.map((rule) => rule.id)).toEqual(['named']);
    expect(narrowed.signals).toHaveLength(0);
  });

  it('applies simple overrides', () => {
    const overridden = applyProjectOverrides(template, {
      discovery: { maxResults: 7 },
      validation: { minimumConfidence: 0.5 },
      review: { blocking: false },
    });
    expect(overridden.discovery.maxResults).toBe(7);
    expect(overridden.validation.minimumConfidence).toBe(0.5);
    expect(overridden.review.blocking).toBe(false);
  });

  it('enables only the selected destinations', () => {
    const overridden = applyProjectOverrides(template, {
      export: { destinationIds: ['json'] },
    });
    expect(overridden.export.destinations.find((d) => d.id === 'csv')?.enabled).toBe(false);
    expect(overridden.export.destinations.find((d) => d.id === 'json')?.enabled).toBe(true);
  });

  it('overrides individual scoring weights', () => {
    const overridden = applyProjectOverrides(template, {
      scoring: { weights: { size: 99 } },
    });
    expect(overridden.scoring.rules.find((r) => r.id === 'size')?.weight).toBe(99);
    expect(overridden.scoring.rules.find((r) => r.id === 'named')?.weight).toBe(10);
  });

  it('leaves the template untouched', () => {
    const before = JSON.stringify(template);
    applyProjectOverrides(template, { discovery: { maxResults: 1 } });
    expect(JSON.stringify(template)).toBe(before);
  });
});

describe('PipelineRegistry', () => {
  it('registers, lists and requires by key', () => {
    const registry = new PipelineRegistry().register(defineResearchPipeline(minimal));
    expect(registry.keys()).toEqual(['minimal']);
    expect(registry.require('minimal').name).toBe('Minimal');
    expect(() => registry.require('other')).toThrow(/registered: minimal/);
  });

  it('refuses a duplicate key rather than silently replacing', () => {
    const registry = new PipelineRegistry().register(defineResearchPipeline(minimal));
    expect(() => registry.register(defineResearchPipeline(minimal))).toThrow(/already registered/);
  });
});

describe('loadEnv', () => {
  it('fails loudly and names the missing variable', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('applies demo-friendly defaults', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://localhost/x' } as NodeJS.ProcessEnv);
    expect(env.PROVIDER_SEARCH).toBe('mock');
    expect(env.API_PORT).toBe(4000);
    expect(env.MOCK_FAILURE_RATE).toBeGreaterThan(0);
  });
});
