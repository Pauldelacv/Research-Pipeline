import { defineResearchPipeline } from '@frp/config';

/**
 * Lead generation.
 *
 * The brief this configuration answers: *find French B2B SaaS companies with
 * 20–500 employees that recently raised, use HubSpot, and are hiring.*
 *
 * Note what is and is not in here. The targeting fields describe a form an
 * operator fills in — they are not baked into the pipeline. The scoring rules
 * are the client's commercial judgement expressed as data. Swap this file and
 * the same deployment does competitor monitoring instead; nothing in
 * `packages/` knows this use case exists.
 */
export const leadGenerationPipeline = defineResearchPipeline({
  key: 'lead-generation',
  name: 'B2B lead generation',
  description:
    'Finds companies matching a firmographic and technographic profile, scores them against ' +
    'configurable commercial criteria, and exports the qualified set.',
  version: '1.0.0',

  entity: {
    type: 'company',
    label: 'Company',
    labelPlural: 'Companies',
    displayField: 'name',
    // Two companies are the same company when their web domain matches.
    identity: { fields: ['website'], normalizer: 'domain' },
  },

  targeting: {
    fields: [
      {
        key: 'industry',
        label: 'Industry',
        type: 'select',
        group: 'Target',
        required: true,
        defaultValue: 'B2B SaaS',
        options: [
          { value: 'B2B SaaS', label: 'B2B SaaS' },
          { value: 'HR Tech', label: 'HR Tech' },
          { value: 'FinTech', label: 'FinTech' },
          { value: 'MarTech', label: 'MarTech' },
          { value: 'DevTools', label: 'DevTools' },
          { value: 'Cybersecurity', label: 'Cybersecurity' },
        ],
      },
      {
        key: 'location',
        label: 'Location',
        type: 'text',
        group: 'Target',
        required: true,
        defaultValue: 'France',
        placeholder: 'France',
      },
      {
        key: 'companySize',
        label: 'Company size',
        type: 'range',
        group: 'Target',
        min: 1,
        max: 5000,
        step: 10,
        defaultValue: [20, 500],
        help: 'Employee headcount band. Companies outside it are kept but scored lower.',
      },
      {
        key: 'signals',
        label: 'Signals',
        type: 'checkbox_group',
        group: 'Signals',
        defaultValue: ['recent_funding', 'uses_hubspot', 'hiring'],
        options: [
          { value: 'recent_funding', label: 'Recent funding' },
          { value: 'uses_hubspot', label: 'Uses HubSpot' },
          { value: 'hiring', label: 'Hiring' },
          { value: 'size_match', label: 'Size matches target' },
        ],
      },
    ],
  },

  discovery: {
    maxResults: 100,
    sources: ['web', 'directory'],
    queriesPerPlan: 8,
    resultsPerQuery: 20,
  },

  extraction: {
    concurrency: 4,
    maxSourcesPerEntity: 5,
    fields: [
      {
        key: 'name',
        label: 'Company',
        type: 'string',
        required: true,
        display: { inTable: true, order: 10, width: 220 },
      },
      {
        key: 'website',
        label: 'Website',
        type: 'url',
        required: true,
        description: 'Primary company domain, used as the identity key.',
        display: { inTable: true, order: 20, width: 200 },
      },
      {
        key: 'linkedinUrl',
        label: 'LinkedIn',
        type: 'url',
        display: { inTable: false, order: 30 },
      },
      {
        key: 'industry',
        label: 'Industry',
        type: 'enum',
        required: true,
        options: [
          'B2B SaaS',
          'HR Tech',
          'FinTech',
          'MarTech',
          'DevTools',
          'Cybersecurity',
          'LegalTech',
          'InsurTech',
          'Logistics',
          'E-commerce Infrastructure',
          'Data Infrastructure',
          'HealthTech',
          'PropTech',
          'RetailTech',
          'Climate Tech',
        ],
        display: { inTable: true, order: 40, width: 160 },
      },
      {
        key: 'employeeCount',
        label: 'Employees',
        type: 'integer',
        required: true,
        min: 1,
        max: 100_000,
        display: { inTable: true, order: 50, width: 110 },
      },
      {
        key: 'headquarters',
        label: 'Headquarters',
        type: 'string',
        display: { inTable: true, order: 60, width: 180 },
      },
      {
        key: 'fundingStage',
        label: 'Funding stage',
        type: 'enum',
        options: ['Pre-seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Bootstrapped', 'Growth'],
        display: { inTable: true, order: 70, width: 130 },
      },
      {
        key: 'lastFundingDate',
        label: 'Last funding',
        type: 'date',
        display: { inTable: false, order: 80 },
      },
      {
        key: 'technologies',
        label: 'Technologies',
        type: 'string_array',
        description: 'Detected tools and platforms, e.g. HubSpot, Segment, Snowflake.',
        display: { inTable: true, order: 90, width: 220 },
      },
      {
        key: 'openRoles',
        label: 'Open roles',
        type: 'integer',
        min: 0,
        max: 5000,
        display: { inTable: true, order: 100, width: 100 },
      },
      {
        key: 'contactName',
        label: 'Contact',
        type: 'string',
        display: { inTable: false, order: 110 },
      },
      {
        key: 'contactTitle',
        label: 'Contact title',
        type: 'string',
        display: { inTable: false, order: 120 },
      },
    ],
  },

  signals: [
    {
      key: 'recent_funding',
      label: 'Recent funding',
      tone: 'positive',
      source: 'derived',
      description: 'Raised an institutional round in the last 18 months.',
      when: {
        all: [
          { field: 'fundingStage', op: 'in', value: ['Seed', 'Series A', 'Series B', 'Series C'] },
          { field: 'lastFundingDate', op: 'within_days', value: 540 },
        ],
      },
    },
    {
      key: 'uses_hubspot',
      label: 'Uses HubSpot',
      tone: 'positive',
      source: 'derived',
      when: { field: 'technologies', op: 'contains', value: 'HubSpot' },
    },
    {
      key: 'hiring',
      label: 'Hiring',
      tone: 'positive',
      source: 'derived',
      when: { field: 'openRoles', op: 'gte', value: 3 },
    },
    {
      key: 'size_match',
      label: 'Size matches target',
      tone: 'positive',
      source: 'derived',
      when: { field: 'employeeCount', op: 'between', value: [20, 500] },
    },
    {
      key: 'enterprise_scale',
      label: 'Too large for this motion',
      tone: 'negative',
      source: 'derived',
      when: { field: 'employeeCount', op: 'gt', value: 1500 },
    },
  ],

  validation: {
    minimumConfidence: 0.75,
    dropInvalid: false,
    rules: [
      {
        id: 'has-website',
        label: 'Website present',
        require: { field: 'website', op: 'exists' },
        severity: 'error',
        message: 'A company without a website cannot be deduplicated or contacted.',
      },
      {
        id: 'plausible-headcount',
        label: 'Plausible headcount',
        require: { field: 'employeeCount', op: 'between', value: [1, 500_000] },
        severity: 'warning',
        message: 'Employee count is outside a plausible range.',
      },
    ],
  },

  enrichment: {
    enabled: true,
    concurrency: 4,
    fields: ['linkedinUrl', 'technologies', 'openRoles', 'contactName', 'contactTitle'],
  },

  scoring: {
    maxScore: 100,
    thresholds: { qualified: 70, review: 40 },
    rules: [
      {
        id: 'recent-funding',
        label: 'Recent funding',
        weight: 30,
        when: { signal: 'recent_funding' },
        description: 'Fresh capital correlates with new tooling budget.',
      },
      {
        id: 'uses-hubspot',
        label: 'Uses HubSpot',
        weight: 20,
        when: { signal: 'uses_hubspot' },
      },
      {
        id: 'hiring',
        label: 'Hiring',
        weight: 15,
        when: { signal: 'hiring' },
      },
      {
        id: 'size-match',
        label: 'Company size matches target',
        weight: 12,
        when: { signal: 'size_match' },
      },
      {
        id: 'industry-match',
        label: 'Industry match',
        weight: 15,
        when: {
          field: 'industry',
          op: 'in',
          value: ['B2B SaaS', 'HR Tech', 'MarTech', 'DevTools'],
        },
      },
      {
        id: 'contact-identified',
        label: 'Named contact identified',
        weight: 8,
        when: { field: 'contactName', op: 'exists' },
      },
      {
        id: 'too-large',
        label: 'Outside the target motion',
        weight: -15,
        when: { signal: 'enterprise_scale' },
        description: 'A penalty, not a filter: the row stays visible and explains itself.',
      },
    ],
  },

  review: {
    enabled: true,
    blocking: true,
    flagBelowConfidence: 0.75,
  },

  export: {
    approvedOnly: false,
    destinations: [
      {
        id: 'csv-export',
        label: 'CSV file',
        connector: 'csv',
        enabled: true,
        options: { filename: 'qualified-companies.csv' },
        // Only qualified rows leave the system.
        filter: { field: 'score', op: 'gte', value: 70 },
      },
      {
        id: 'json-export',
        label: 'JSON file (full provenance)',
        connector: 'json',
        enabled: true,
        options: { format: 'json', pretty: true },
      },
      {
        id: 'hubspot-crm',
        label: 'HubSpot CRM',
        connector: 'hubspot',
        enabled: false,
        options: {
          dryRun: true,
          idProperty: 'domain',
          propertyMap: {
            name: 'name',
            website: 'domain',
            industry: 'industry',
            employeeCount: 'numberofemployees',
            headquarters: 'city',
          },
        },
      },
    ],
  },

  providers: {},
  metadata: { owner: 'growth', useCase: 'outbound' },
});

export default leadGenerationPipeline;
