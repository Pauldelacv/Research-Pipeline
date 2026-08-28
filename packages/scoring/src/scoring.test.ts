import { defineResearchPipeline } from '@frp/config';
import type { ResearchPipelineConfigInput } from '@frp/schemas';
import { describe, expect, it } from 'vitest';
import { createEvaluationContext, evaluateCondition, renderTrace } from './conditions.js';
import { scoreEntity } from './score.js';
import { deriveSignals, detectedSignalKeys } from './signals.js';

/**
 * The scoring engine is the part of the system a client argues with, so its
 * behaviour is pinned down precisely: determinism, explainability, correct
 * handling of penalties, and no silent coercion surprises.
 */

const NOW = new Date('2026-06-01T00:00:00.000Z');

function config(overrides: Partial<ResearchPipelineConfigInput> = {}) {
  return defineResearchPipeline({
    key: 'test-pipeline',
    name: 'Test',
    entity: {
      type: 'company',
      label: 'Company',
      labelPlural: 'Companies',
      displayField: 'name',
      identity: { fields: ['website'], normalizer: 'domain' },
    },
    targeting: { fields: [] },
    discovery: { sources: ['web'] },
    extraction: {
      fields: [
        { key: 'name', label: 'Name', type: 'string', required: true },
        { key: 'website', label: 'Website', type: 'url', required: true },
        { key: 'employeeCount', label: 'Employees', type: 'integer' },
        { key: 'fundingStage', label: 'Stage', type: 'enum', options: ['Seed', 'Series A'] },
        { key: 'lastFundingDate', label: 'Last funding', type: 'date' },
        { key: 'technologies', label: 'Tech', type: 'string_array' },
      ],
    },
    ...overrides,
  } as ResearchPipelineConfigInput);
}

describe('evaluateCondition', () => {
  const ctx = createEvaluationContext(
    {
      employeeCount: 140,
      fundingStage: 'Series A',
      technologies: ['HubSpot', 'Segment'],
      lastFundingDate: '2026-03-01T00:00:00.000Z',
      name: 'Acme',
    },
    ['hiring'],
    NOW,
  );

  it('compares numbers, including within a range', () => {
    expect(
      evaluateCondition({ field: 'employeeCount', op: 'between', value: [20, 500] }, ctx).matched,
    ).toBe(true);
    expect(
      evaluateCondition({ field: 'employeeCount', op: 'between', value: [200, 500] }, ctx).matched,
    ).toBe(false);
    expect(evaluateCondition({ field: 'employeeCount', op: 'gte', value: 140 }, ctx).matched).toBe(
      true,
    );
  });

  it('treats a list membership test case-insensitively', () => {
    expect(
      evaluateCondition({ field: 'fundingStage', op: 'in', value: ['seed', 'series a'] }, ctx)
        .matched,
    ).toBe(true);
  });

  it('matches inside array fields', () => {
    expect(
      evaluateCondition({ field: 'technologies', op: 'contains', value: 'hubspot' }, ctx).matched,
    ).toBe(true);
    expect(
      evaluateCondition({ field: 'technologies', op: 'contains', value: 'salesforce' }, ctx)
        .matched,
    ).toBe(false);
  });

  it('evaluates date recency against the injected clock', () => {
    expect(
      evaluateCondition({ field: 'lastFundingDate', op: 'within_days', value: 180 }, ctx).matched,
    ).toBe(true);
    expect(
      evaluateCondition({ field: 'lastFundingDate', op: 'within_days', value: 30 }, ctx).matched,
    ).toBe(false);
  });

  it('reads signals as well as fields', () => {
    expect(evaluateCondition({ signal: 'hiring' }, ctx).matched).toBe(true);
    expect(evaluateCondition({ signal: 'hiring', present: false }, ctx).matched).toBe(false);
    expect(evaluateCondition({ signal: 'unknown_signal' }, ctx).matched).toBe(false);
  });

  it('composes with all/any/not', () => {
    const condition = {
      all: [
        { field: 'employeeCount', op: 'gte' as const, value: 100 },
        { any: [{ signal: 'hiring' }, { signal: 'missing' }] },
        { not: { field: 'fundingStage', op: 'eq' as const, value: 'Seed' } },
      ],
    };
    expect(evaluateCondition(condition, ctx).matched).toBe(true);
  });

  it('produces a readable trace rather than a bare boolean', () => {
    const trace = evaluateCondition(
      { field: 'employeeCount', op: 'between', value: [20, 500] },
      ctx,
    );
    expect(renderTrace(trace)).toContain('employeeCount');
    expect(renderTrace(trace)).toContain('140');
  });

  it('does not throw on a malformed regex', () => {
    expect(evaluateCondition({ field: 'name', op: 'matches', value: '([' }, ctx).matched).toBe(
      false,
    );
  });

  it('treats a missing field as not matching, never as a crash', () => {
    expect(evaluateCondition({ field: 'nope', op: 'gte', value: 1 }, ctx).matched).toBe(false);
    expect(evaluateCondition({ field: 'nope', op: 'missing' }, ctx).matched).toBe(true);
  });
});

describe('scoreEntity', () => {
  const scored = config({
    scoring: {
      maxScore: 100,
      thresholds: { qualified: 70, review: 40 },
      rules: [
        { id: 'funding', label: 'Recent funding', weight: 30, when: { signal: 'recent_funding' } },
        {
          id: 'hubspot',
          label: 'Uses HubSpot',
          weight: 20,
          when: { field: 'technologies', op: 'contains', value: 'HubSpot' },
        },
        {
          id: 'size',
          label: 'Size fits',
          weight: 10,
          when: { field: 'employeeCount', op: 'between', value: [20, 500] },
        },
        {
          id: 'too-big',
          label: 'Too big',
          weight: -15,
          when: { field: 'employeeCount', op: 'gt', value: 1000 },
        },
      ],
    },
  });

  it('awards points only for matching rules and normalises onto the scale', () => {
    const breakdown = scoreEntity(scored, {
      fields: { employeeCount: 140, technologies: ['HubSpot'] },
      signals: [],
      now: NOW,
    });

    // 20 + 10 awarded out of 60 available positive points.
    expect(breakdown.rawPoints).toBe(30);
    expect(breakdown.maxPoints).toBe(60);
    expect(breakdown.total).toBe(50);
    expect(breakdown.band).toBe('review');
  });

  it('is deterministic for the same inputs', () => {
    const input = { fields: { employeeCount: 140 }, signals: ['recent_funding'], now: NOW };
    expect(scoreEntity(scored, input)).toEqual(scoreEntity(scored, input));
  });

  it('explains every contribution, matched or not', () => {
    const breakdown = scoreEntity(scored, { fields: {}, signals: [], now: NOW });
    expect(breakdown.contributions).toHaveLength(4);
    for (const contribution of breakdown.contributions) {
      expect(contribution.explanation.length).toBeGreaterThan(0);
    }
  });

  it('applies penalties without inflating the denominator', () => {
    const breakdown = scoreEntity(scored, {
      fields: { employeeCount: 5000, technologies: ['HubSpot'] },
      signals: ['recent_funding'],
      now: NOW,
    });

    // 30 + 20 - 15 = 35 of 60; the -15 rule must not add to maxPoints.
    expect(breakdown.maxPoints).toBe(60);
    expect(breakdown.rawPoints).toBe(35);
  });

  it('never returns a score outside the configured scale', () => {
    const punitive = config({
      scoring: {
        maxScore: 100,
        thresholds: { qualified: 70, review: 40 },
        rules: [
          { id: 'a', label: 'A', weight: 10, when: { always: true } },
          { id: 'penalty', label: 'Penalty', weight: -500, when: { always: true } },
        ],
      },
    });
    const breakdown = scoreEntity(punitive, { fields: {}, signals: [], now: NOW });
    expect(breakdown.total).toBe(0);
  });

  it('interpolates graded rules across their scale', () => {
    const graded = config({
      scoring: {
        maxScore: 100,
        thresholds: { qualified: 70, review: 40 },
        rules: [
          {
            id: 'completeness',
            label: 'Headcount scale',
            weight: 40,
            mode: 'graded',
            scale: { field: 'employeeCount', from: 0, to: 400, clamp: true },
          },
        ],
      },
    });

    expect(
      scoreEntity(graded, { fields: { employeeCount: 200 }, signals: [], now: NOW }).total,
    ).toBe(50);
    expect(
      scoreEntity(graded, { fields: { employeeCount: 9999 }, signals: [], now: NOW }).total,
    ).toBe(100);
    expect(scoreEntity(graded, { fields: {}, signals: [], now: NOW }).total).toBe(0);
  });
});

describe('deriveSignals', () => {
  const withSignals = config({
    signals: [
      {
        key: 'recent_funding',
        label: 'Recent funding',
        source: 'derived',
        tone: 'positive',
        when: {
          all: [
            { field: 'fundingStage', op: 'in', value: ['Seed', 'Series A'] },
            { field: 'lastFundingDate', op: 'within_days', value: 540 },
          ],
        },
      },
      { key: 'reported', label: 'Reported by provider', source: 'extracted', tone: 'neutral' },
    ],
  });

  it('recomputes derived signals from current field values', () => {
    const signals = deriveSignals(
      withSignals,
      { fundingStage: 'Series A', lastFundingDate: '2026-03-01T00:00:00.000Z' },
      [],
      NOW,
    );
    expect(detectedSignalKeys(signals)).toContain('recent_funding');
  });

  it('passes provider-reported signals through untouched', () => {
    const signals = deriveSignals(
      withSignals,
      {},
      [
        {
          key: 'reported',
          label: 'Reported by provider',
          tone: 'neutral',
          detected: true,
          confidence: 0.9,
          rationale: 'seen on the page',
          source: 'extracted',
        },
      ],
      NOW,
    );
    const reported = signals.find((signal) => signal.key === 'reported');
    expect(reported?.detected).toBe(true);
    expect(reported?.rationale).toBe('seen on the page');
  });

  it('reports an extracted signal the provider omitted as undetected, not missing', () => {
    const signals = deriveSignals(withSignals, {}, [], NOW);
    const reported = signals.find((signal) => signal.key === 'reported');
    expect(reported).toBeDefined();
    expect(reported?.detected).toBe(false);
  });
});
