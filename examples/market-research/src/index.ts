import { defineResearchPipeline } from '@frp/config';

/**
 * Market research.
 *
 * The output is a dataset, not a memo. Each row is a company positioned in a
 * market — with pricing, segment, positioning and technology signals — so the
 * result can be pivoted, filtered and re-scored rather than re-read.
 *
 * This configuration turns human review off deliberately: a market map is an
 * exploratory artefact, and its value is coverage rather than per-row
 * precision. That is a per-use-case judgement expressed in configuration, not
 * a limitation of the framework.
 */
export const marketResearchPipeline = defineResearchPipeline({
  key: 'market-research',
  name: 'Market research',
  description:
    'Maps a market into a structured dataset of companies, their positioning, pricing, ' +
    'segments and technology choices.',
  version: '1.0.0',

  entity: {
    type: 'market_participant',
    label: 'Participant',
    labelPlural: 'Participants',
    displayField: 'name',
    identity: { fields: ['website'], normalizer: 'domain' },
  },

  targeting: {
    fields: [
      {
        key: 'market',
        label: 'Market',
        type: 'text',
        group: 'Scope',
        required: true,
        placeholder: 'Revenue operations software',
        defaultValue: 'Revenue operations software',
      },
      {
        key: 'geography',
        label: 'Geography',
        type: 'multiselect',
        group: 'Scope',
        defaultValue: ['Europe'],
        options: [
          { value: 'Europe', label: 'Europe' },
          { value: 'North America', label: 'North America' },
          { value: 'APAC', label: 'APAC' },
          { value: 'Global', label: 'Global' },
        ],
      },
      {
        key: 'segments',
        label: 'Customer segments of interest',
        type: 'checkbox_group',
        group: 'Scope',
        defaultValue: ['Mid-market', 'Enterprise'],
        options: [
          { value: 'SMB', label: 'SMB' },
          { value: 'Mid-market', label: 'Mid-market' },
          { value: 'Enterprise', label: 'Enterprise' },
          { value: 'Developers', label: 'Developers' },
          { value: 'Public sector', label: 'Public sector' },
        ],
      },
      {
        key: 'depth',
        label: 'Participants to map',
        type: 'number',
        group: 'Scope',
        min: 10,
        max: 500,
        defaultValue: 60,
      },
    ],
  },

  discovery: {
    maxResults: 120,
    sources: ['web', 'directory', 'reviews'],
    queriesPerPlan: 10,
    resultsPerQuery: 20,
  },

  extraction: {
    concurrency: 5,
    maxSourcesPerEntity: 6,
    fields: [
      {
        key: 'name',
        label: 'Company',
        type: 'string',
        required: true,
        display: { inTable: true, order: 10, width: 200 },
      },
      {
        key: 'website',
        label: 'Website',
        type: 'url',
        required: true,
        display: { inTable: true, order: 20, width: 190 },
      },
      {
        key: 'category',
        label: 'Category',
        type: 'enum',
        required: true,
        options: [
          'B2B SaaS',
          'Data Infrastructure',
          'MarTech',
          'DevTools',
          'FinTech',
          'HR Tech',
          'Cybersecurity',
          'RetailTech',
        ],
        display: { inTable: true, order: 30, width: 160 },
      },
      {
        key: 'positioning',
        label: 'Positioning',
        type: 'enum',
        options: [
          'Cost leader',
          'Premium',
          'Developer-first',
          'All-in-one suite',
          'Vertical specialist',
          'Open-source core',
          'Compliance-led',
        ],
        display: { inTable: true, order: 40, width: 160 },
      },
      {
        key: 'targetSegment',
        label: 'Primary segment',
        type: 'enum',
        options: [
          'SMB',
          'Mid-market',
          'Enterprise',
          'Developers',
          'Agencies',
          'Public sector',
          'Startups',
        ],
        display: { inTable: true, order: 50, width: 140 },
      },
      {
        key: 'entryPrice',
        label: 'Entry price',
        type: 'money',
        unit: 'EUR/month',
        min: 0,
        display: { inTable: true, order: 60, width: 120 },
      },
      {
        key: 'employeeCount',
        label: 'Employees',
        type: 'integer',
        min: 1,
        display: { inTable: true, order: 70, width: 110 },
      },
      {
        key: 'fundingStage',
        label: 'Stage',
        type: 'enum',
        options: ['Pre-seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Bootstrapped', 'Growth'],
        display: { inTable: true, order: 80, width: 120 },
      },
      {
        key: 'technologies',
        label: 'Technology signals',
        type: 'string_array',
        display: { inTable: true, order: 90, width: 220 },
      },
      {
        key: 'summary',
        label: 'Positioning summary',
        type: 'text',
        display: { inTable: false, order: 100 },
      },
    ],
  },

  signals: [
    {
      key: 'price_transparent',
      label: 'Public pricing',
      tone: 'positive',
      source: 'derived',
      when: { field: 'entryPrice', op: 'exists' },
    },
    {
      key: 'enterprise_focus',
      label: 'Enterprise focus',
      tone: 'neutral',
      source: 'derived',
      when: { field: 'targetSegment', op: 'in', value: ['Enterprise', 'Public sector'] },
    },
    {
      key: 'well_funded',
      label: 'Well funded',
      tone: 'neutral',
      source: 'derived',
      when: { field: 'fundingStage', op: 'in', value: ['Series B', 'Series C', 'Growth'] },
    },
  ],

  validation: {
    minimumConfidence: 0.65,
    dropInvalid: false,
    rules: [
      {
        id: 'identifiable',
        label: 'Identifiable participant',
        require: { field: 'website', op: 'exists' },
        severity: 'error',
      },
      {
        id: 'categorised',
        label: 'Category assigned',
        require: { field: 'category', op: 'exists' },
        severity: 'warning',
      },
    ],
  },

  enrichment: {
    enabled: true,
    concurrency: 5,
    fields: ['positioning', 'targetSegment', 'entryPrice', 'technologies', 'summary'],
  },

  scoring: {
    maxScore: 100,
    thresholds: { qualified: 60, review: 30 },
    rules: [
      {
        id: 'completeness',
        label: 'Record completeness',
        weight: 25,
        mode: 'graded',
        // A market map is only as good as its coverage, so completeness is
        // scored directly rather than left implicit.
        scale: { field: 'employeeCount', from: 0, to: 500, clamp: true },
      },
      {
        id: 'pricing-known',
        label: 'Pricing is public',
        weight: 25,
        when: { signal: 'price_transparent' },
      },
      {
        id: 'positioned',
        label: 'Positioning identified',
        weight: 20,
        when: { field: 'positioning', op: 'exists' },
      },
      {
        id: 'segment-known',
        label: 'Segment identified',
        weight: 15,
        when: { field: 'targetSegment', op: 'exists' },
      },
      {
        id: 'tech-signals',
        label: 'Technology signals found',
        weight: 15,
        when: { field: 'technologies', op: 'exists' },
      },
    ],
  },

  review: {
    // Coverage matters more than per-row precision for a market map.
    enabled: false,
    blocking: false,
    flagBelowConfidence: 0.6,
  },

  export: {
    approvedOnly: false,
    destinations: [
      {
        id: 'csv-market-map',
        label: 'CSV market map',
        connector: 'csv',
        enabled: true,
        options: { filename: 'market-map.csv' },
      },
      {
        id: 'notion-database',
        label: 'Notion database',
        connector: 'notion',
        enabled: false,
        options: { dryRun: true, databaseId: '' },
      },
    ],
  },

  metadata: { owner: 'strategy', cadence: 'quarterly' },
});

export default marketResearchPipeline;
