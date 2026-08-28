import { defineResearchPipeline } from '@frp/config';

/**
 * Competitive intelligence.
 *
 * The entity here is not a company — it is an *observed change*: a launch, a
 * price move, a funding announcement. That single difference (`entity.type`
 * plus a different identity key) is the whole adaptation. The engine, the
 * stores, the review queue and the scoring engine are untouched.
 *
 * Identity is the composite of competitor + event type + date, so the same
 * announcement seen on three sites merges into one intelligence item with
 * three pieces of evidence rather than three duplicate rows.
 */
export const competitiveIntelligencePipeline = defineResearchPipeline({
  key: 'competitive-intelligence',
  name: 'Competitive intelligence',
  description:
    'Monitors a competitor set for product, pricing, hiring, funding and partnership changes, ' +
    'and turns them into a structured, deduplicated intelligence feed.',
  version: '1.0.0',

  entity: {
    type: 'competitor_event',
    label: 'Intelligence item',
    labelPlural: 'Intelligence items',
    displayField: 'headline',
    identity: { fields: ['competitor', 'eventType', 'observedAt'], normalizer: 'lowercase' },
  },

  targeting: {
    fields: [
      {
        key: 'competitors',
        label: 'Competitors',
        type: 'tags',
        group: 'Watchlist',
        required: true,
        help: 'One entry per competitor. Names are used verbatim in query planning.',
        defaultValue: ['Acme Analytics', 'Northwind Data', 'Meridian Cloud'],
      },
      {
        key: 'eventTypes',
        label: 'Change types to detect',
        type: 'checkbox_group',
        group: 'Watchlist',
        defaultValue: ['Product launch', 'Pricing change', 'Funding announcement', 'Hiring surge'],
        options: [
          { value: 'Product launch', label: 'Product launches' },
          { value: 'Pricing change', label: 'Pricing changes' },
          { value: 'Funding announcement', label: 'Funding announcements' },
          { value: 'Partnership', label: 'Partnerships' },
          { value: 'Hiring surge', label: 'New job openings' },
          { value: 'Technology migration', label: 'Technology changes' },
        ],
      },
      {
        key: 'lookbackDays',
        label: 'Look back (days)',
        type: 'number',
        group: 'Window',
        min: 7,
        max: 365,
        defaultValue: 90,
      },
    ],
  },

  discovery: {
    maxResults: 150,
    sources: ['web', 'news', 'jobs'],
    queriesPerPlan: 12,
    resultsPerQuery: 15,
  },

  extraction: {
    concurrency: 6,
    maxSourcesPerEntity: 6,
    fields: [
      {
        key: 'competitor',
        label: 'Competitor',
        type: 'string',
        required: true,
        display: { inTable: true, order: 10, width: 180 },
      },
      {
        key: 'eventType',
        label: 'Change type',
        type: 'enum',
        required: true,
        options: [
          'Product launch',
          'Pricing change',
          'Funding announcement',
          'Partnership',
          'Hiring surge',
          'Executive hire',
          'Acquisition',
          'Technology migration',
          'Market expansion',
        ],
        display: { inTable: true, order: 20, width: 170 },
      },
      {
        key: 'headline',
        label: 'Headline',
        type: 'string',
        required: true,
        display: { inTable: true, order: 30, width: 320 },
      },
      {
        key: 'summary',
        label: 'Summary',
        type: 'text',
        display: { inTable: false, order: 40 },
      },
      {
        key: 'observedAt',
        label: 'Observed',
        type: 'date',
        required: true,
        display: { inTable: true, order: 50, width: 120 },
      },
      {
        key: 'impact',
        label: 'Impact',
        type: 'enum',
        options: ['Low', 'Medium', 'High'],
        display: { inTable: true, order: 60, width: 100 },
      },
      {
        key: 'priceBefore',
        label: 'Price before',
        type: 'money',
        display: { inTable: false, order: 70 },
      },
      {
        key: 'priceAfter',
        label: 'Price after',
        type: 'money',
        display: { inTable: false, order: 80 },
      },
      {
        key: 'openRoles',
        label: 'Open roles',
        type: 'integer',
        min: 0,
        display: { inTable: true, order: 90, width: 100 },
      },
      {
        key: 'technologies',
        label: 'Technologies',
        type: 'string_array',
        display: { inTable: false, order: 100 },
      },
    ],
  },

  signals: [
    {
      key: 'price_increase',
      label: 'Price increased',
      tone: 'positive',
      source: 'derived',
      description: 'A competitor raising prices is a commercial opening.',
      when: {
        all: [
          { field: 'priceBefore', op: 'exists' },
          { field: 'priceAfter', op: 'exists' },
          { field: 'priceAfter', op: 'gt', value: 0 },
        ],
      },
    },
    {
      key: 'recent',
      label: 'Within the last 30 days',
      tone: 'neutral',
      source: 'derived',
      when: { field: 'observedAt', op: 'within_days', value: 30 },
    },
    {
      key: 'high_impact',
      label: 'High impact',
      tone: 'positive',
      source: 'derived',
      when: { field: 'impact', op: 'eq', value: 'High' },
    },
    {
      key: 'aggressive_hiring',
      label: 'Aggressive hiring',
      tone: 'neutral',
      source: 'derived',
      when: { field: 'openRoles', op: 'gte', value: 15 },
    },
  ],

  validation: {
    minimumConfidence: 0.7,
    dropInvalid: false,
    rules: [
      {
        id: 'dated',
        label: 'Event is dated',
        require: { field: 'observedAt', op: 'exists' },
        severity: 'error',
        message: 'An undated change cannot be placed on the timeline.',
      },
      {
        id: 'not-stale',
        label: 'Within the reporting window',
        require: { field: 'observedAt', op: 'within_days', value: 365 },
        severity: 'warning',
        message: 'Older than a year — likely a historical reference, not a change.',
      },
    ],
  },

  enrichment: {
    enabled: true,
    concurrency: 4,
    fields: ['summary', 'impact', 'technologies'],
  },

  scoring: {
    maxScore: 100,
    thresholds: { qualified: 65, review: 35 },
    rules: [
      { id: 'high-impact', label: 'High impact', weight: 30, when: { signal: 'high_impact' } },
      { id: 'recent', label: 'Happened recently', weight: 25, when: { signal: 'recent' } },
      {
        id: 'price-move',
        label: 'Pricing moved',
        weight: 20,
        when: { signal: 'price_increase' },
      },
      {
        id: 'launch',
        label: 'Product launch',
        weight: 15,
        when: { field: 'eventType', op: 'eq', value: 'Product launch' },
      },
      {
        id: 'hiring',
        label: 'Aggressive hiring',
        weight: 10,
        when: { signal: 'aggressive_hiring' },
      },
    ],
  },

  review: {
    enabled: true,
    // Intelligence is time-sensitive: publish the feed, flag the uncertain
    // items in place rather than holding the whole run for a reviewer.
    blocking: false,
    flagBelowConfidence: 0.7,
  },

  export: {
    approvedOnly: false,
    destinations: [
      {
        id: 'json-feed',
        label: 'JSON intelligence feed',
        connector: 'json',
        enabled: true,
        options: { format: 'ndjson' },
      },
      {
        id: 'slack-digest',
        label: 'Slack digest',
        connector: 'slack',
        enabled: false,
        options: { dryRun: true, topN: 8 },
        filter: { signal: 'high_impact' },
      },
    ],
  },

  metadata: { owner: 'product-marketing', cadence: 'weekly' },
});

export default competitiveIntelligencePipeline;
