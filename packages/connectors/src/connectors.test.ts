import { defineResearchPipeline } from '@frp/config';
import { nullLogger, type ExportRow } from '@frp/core';
import type { Entity, EntityField, ResearchPipelineConfig, ResearchRun } from '@frp/schemas';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvConnector } from './csv/index.js';
import { jsonConnector } from './json/index.js';
import { mapProperties } from './hubspot/index.js';
import { buildDigest } from './slack/index.js';
import { toNotionProperties } from './notion/index.js';
import { flattenRow, headerFor, structuredRow } from './rows.js';

/**
 * Connector behaviour that actually matters in an export: correct escaping,
 * the destination filter being honoured, provenance surviving the trip, and
 * formula injection being neutralised before a spreadsheet opens the file.
 */

const config: ResearchPipelineConfig = defineResearchPipeline({
  key: 'export-test',
  name: 'Export test',
  entity: {
    type: 'company',
    label: 'Company',
    labelPlural: 'Companies',
    displayField: 'name',
    identity: { fields: ['website'], normalizer: 'domain' },
  },
  extraction: {
    fields: [
      { key: 'name', label: 'Company', type: 'string', required: true },
      { key: 'website', label: 'Website', type: 'url', required: true },
      { key: 'tech', label: 'Technologies', type: 'string_array' },
      { key: 'employeeCount', label: 'Employees', type: 'integer' },
    ],
  },
});

function entity(overrides: Partial<Entity> = {}): Entity {
  const now = '2026-06-01T00:00:00.000Z';
  return {
    id: 'ent_1',
    runId: 'run_1',
    projectId: 'prj_1',
    tenantId: 'ten_1',
    entityType: 'company',
    dedupeKey: 'acme.com',
    displayName: 'Acme',
    status: 'approved',
    data: {
      name: 'Acme',
      website: 'https://acme.com',
      tech: ['HubSpot', 'Segment'],
      employeeCount: 140,
    },
    confidence: 0.91,
    validationStatus: 'valid',
    validationIssues: [],
    signals: [
      {
        key: 'hiring',
        label: 'Hiring',
        tone: 'positive',
        detected: true,
        confidence: 1,
        rationale: 'openRoles >= 3',
        source: 'derived',
      },
    ],
    score: 82,
    scoreBreakdown: {
      total: 82,
      maxScore: 100,
      rawPoints: 41,
      maxPoints: 50,
      band: 'qualified',
      contributions: [
        {
          ruleId: 'hiring',
          label: 'Hiring',
          matched: true,
          points: 15,
          maxPoints: 15,
          explanation: 'signal hiring present',
        },
      ],
      scoredAt: now,
    },
    flaggedFields: [],
    sourceCount: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fields(): EntityField[] {
  const now = '2026-06-01T00:00:00.000Z';
  return [
    {
      id: 'fld_1',
      entityId: 'ent_1',
      key: 'name',
      value: 'Acme',
      confidence: 0.95,
      status: 'auto',
      extractedBy: 'mock',
      previousValue: null,
      reviewedBy: null,
      reviewedAt: null,
      agreementCount: 2,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

const run = {
  id: 'run_1',
  projectId: 'prj_1',
  tenantId: 'ten_1',
  status: 'completed',
  currentStep: null,
  trigger: 'manual',
  configSnapshot: config,
  targeting: {},
  stats: {
    sourcesDiscovered: 12,
    entitiesExtracted: 8,
    entitiesStructured: 5,
    entitiesValid: 4,
    entitiesFlagged: 1,
    entitiesApproved: 4,
    entitiesRejected: 0,
    entitiesExported: 0,
    providerErrors: 0,
    retries: 0,
  },
  error: null,
  queuedAt: null,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
} as ResearchRun;

async function rows(items: ExportRow[]): Promise<AsyncIterable<ExportRow>> {
  return (async function* generate() {
    for (const item of items) yield item;
  })();
}

let exportDir: string;

beforeAll(async () => {
  exportDir = await mkdtemp(path.join(tmpdir(), 'frp-export-'));
  process.env.EXPORT_DIR = exportDir;
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
});

afterAll(() => {
  delete process.env.EXPORT_DIR;
});

describe('row shaping', () => {
  it('includes provenance columns by default', () => {
    const header = headerFor(config, {});
    expect(header).toContain('Score');
    expect(header).toContain('Confidence');
    expect(header).toContain('Sources');
  });

  it('renders arrays and nulls predictably', () => {
    const flat = flattenRow(config, { entity: entity(), fields: fields() }, {});
    expect(flat['Technologies']).toBe('HubSpot; Segment');
    expect(flat['Signals']).toBe('Hiring');
  });

  it('keeps per-field confidence in the structured shape', () => {
    const structured = structuredRow(config, { entity: entity(), fields: fields() });
    expect(structured.fields[0]).toMatchObject({
      key: 'name',
      confidence: 0.95,
      agreementCount: 2,
      extractedBy: 'mock',
    });
    expect(structured.scoreBreakdown).toHaveLength(1);
  });
});

describe('csvConnector', () => {
  it('writes a header and one row per entity', async () => {
    const result = await csvConnector.write({
      run,
      config,
      destinationId: 'csv',
      options: { filename: 'basic.csv' },
      rows: await rows([{ entity: entity(), fields: fields() }]),
      logger: nullLogger,
    });

    const content = await readFile(result.location, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Company,Website');
    expect(lines[1]).toContain('Acme');
    expect(result.entityCount).toBe(1);
  });

  it('quotes values containing the delimiter', async () => {
    const result = await csvConnector.write({
      run,
      config,
      destinationId: 'csv',
      options: { filename: 'quoting.csv' },
      rows: await rows([
        {
          entity: entity({ data: { ...entity().data, name: 'Acme, Inc. "the" one' } }),
          fields: fields(),
        },
      ]),
      logger: nullLogger,
    });

    const content = await readFile(result.location, 'utf8');
    expect(content).toContain('"Acme, Inc. ""the"" one"');
  });

  it('neutralises spreadsheet formula injection', async () => {
    const result = await csvConnector.write({
      run,
      config,
      destinationId: 'csv',
      options: { filename: 'injection.csv' },
      rows: await rows([
        {
          entity: entity({ data: { ...entity().data, name: '=HYPERLINK("http://evil","x")' } }),
          fields: fields(),
        },
      ]),
      logger: nullLogger,
    });

    const content = await readFile(result.location, 'utf8');
    // The leading `=` is defused with a quote so a spreadsheet shows the text.
    expect(content).toContain("'=HYPERLINK");
  });

  it('rejects a multi-character delimiter rather than writing a broken file', async () => {
    await expect(
      csvConnector.write({
        run,
        config,
        destinationId: 'csv',
        options: { delimiter: '||' },
        rows: await rows([]),
        logger: nullLogger,
      }),
    ).rejects.toThrow(/single character/);
  });
});

describe('jsonConnector', () => {
  it('writes valid JSON with run metadata and full provenance', async () => {
    const result = await jsonConnector.write({
      run,
      config,
      destinationId: 'json',
      options: { filename: 'out.json' },
      rows: await rows([{ entity: entity(), fields: fields() }]),
      logger: nullLogger,
    });

    const parsed = JSON.parse(await readFile(result.location, 'utf8'));
    expect(parsed.run.id).toBe('run_1');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].fields[0].confidence).toBe(0.95);
  });

  it('writes one JSON object per line in ndjson mode', async () => {
    const result = await jsonConnector.write({
      run,
      config,
      destinationId: 'json',
      options: { filename: 'out.ndjson', format: 'ndjson' },
      rows: await rows([
        { entity: entity(), fields: fields() },
        { entity: entity({ id: 'ent_2' }), fields: fields() },
      ]),
      logger: nullLogger,
    });

    const lines = (await readFile(result.location, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
  });

  it('produces valid JSON for an empty result set', async () => {
    const result = await jsonConnector.write({
      run,
      config,
      destinationId: 'json',
      options: { filename: 'empty.json' },
      rows: await rows([]),
      logger: nullLogger,
    });
    const parsed = JSON.parse(await readFile(result.location, 'utf8'));
    expect(parsed.items).toEqual([]);
  });
});

describe('credentialed connectors', () => {
  it('maps entity fields onto HubSpot properties', () => {
    const properties = mapProperties(
      { entity: entity(), fields: fields() },
      { name: 'name', website: 'domain', tech: 'technologies' },
    );
    expect(properties).toEqual({
      name: 'Acme',
      domain: 'https://acme.com',
      technologies: 'HubSpot;Segment',
    });
  });

  it('builds Notion properties typed per field definition', () => {
    const definitions = new Map(config.extraction.fields.map((field) => [field.key, field]));
    const properties = toNotionProperties(
      { entity: entity(), fields: fields() },
      definitions,
      'name',
    ) as Record<string, { multi_select?: unknown[]; number?: number }>;

    expect(properties['Technologies']?.multi_select).toHaveLength(2);
    expect(properties['Employees']?.number).toBe(140);
    expect(properties['Score']?.number).toBe(82);
  });

  it('builds a Slack digest without leaking the whole dataset', () => {
    const digest = buildDigest({ run, config }, 42, [{ name: 'Acme', score: 82 }]) as {
      text: string;
      blocks: unknown[];
    };
    expect(digest.text).toContain('42');
    expect(digest.blocks.length).toBeGreaterThan(1);
  });

  it('falls back to a dry run when no credentials are present', async () => {
    delete process.env.HUBSPOT_ACCESS_TOKEN;
    const { hubspotConnector } = await import('./hubspot/index.js');

    const result = await hubspotConnector.write({
      run,
      config,
      destinationId: 'hubspot',
      options: { propertyMap: { website: 'domain' } },
      rows: await rows([{ entity: entity(), fields: fields() }]),
      logger: nullLogger,
    });

    // Nothing is sent; the exact request bodies land on disk for inspection.
    expect(result.warnings.join(' ')).toContain('dry run');
    const payload = JSON.parse(await readFile(result.location, 'utf8'));
    expect(payload.payload.batches[0][0].properties.domain).toBe('https://acme.com');
  });
});
