# Configuration guide

A deployment is defined by one serialisable object. This is the whole adaptation
surface: extraction, validation, signals, scoring, review policy, export
destinations and the operator-facing form are all derived from it.

```ts
import { defineResearchPipeline } from '@frp/config';

export const pipeline = defineResearchPipeline({/* … */});
```

`defineResearchPipeline` validates at module load and throws with the offending
path. A configuration that would break three steps into a run is rejected before
the run starts.

---

## Minimal configuration

Only four things are required:

```ts
defineResearchPipeline({
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
    ],
  },
});
```

Everything else has defaults: 100 results, blocking review at 0.75 confidence,
no scoring rules, no destinations.

---

## `entity` — identity

```ts
entity: {
  type: 'company',              // free-form; appears on rows and in the API
  label: 'Company',
  labelPlural: 'Companies',     // used for tab labels and messages
  displayField: 'name',         // the label an operator sees per row
  identity: {
    fields: ['website'],        // combined to form the dedupe key
    normalizer: 'domain',       // domain | url | lowercase | none
  },
}
```

Identity is the most consequential choice in the file. Get it wrong and you
either merge distinct records or ship the same one five times.

| Normaliser  | `https://www.Acme.com/about` becomes             | Use for                                       |
| ----------- | ------------------------------------------------ | --------------------------------------------- |
| `domain`    | `acme.com`                                       | Companies, products with a site               |
| `url`       | `https://www.acme.com/about`                     | Documents, job posts, articles                |
| `lowercase` | `acme` (accents folded, legal suffixes stripped) | People, organisations without a site          |
| `none`      | unchanged (trimmed)                              | Values already canonical, e.g. an external id |

Composite identity is how non-company entities work:

```ts
// One announcement seen on three sites merges into one item with three
// pieces of evidence, instead of three duplicate rows.
identity: { fields: ['competitor', 'eventType', 'observedAt'], normalizer: 'lowercase' }
```

A candidate whose identity fields are all empty is **dropped** by the `structure`
step and counted in its warnings — merging it would be guesswork.

---

## `extraction.fields` — the output schema

Field definitions drive the extraction contract, runtime coercion, the results
table, the detail panel and the mock generator. Adding one makes it appear end
to end.

```ts
{
  key: 'employeeCount',        // identifier; stable, referenced by rules
  label: 'Employees',          // shown to operators and used as the CSV header
  type: 'integer',
  required: true,              // participates in validation and confidence
  description: '…',            // handed to extraction providers as guidance
  options: ['Seed', 'Series A'],  // enum only
  min: 1, max: 100_000,
  examples: ['120', '1,400'],  // few-shot hints for LLM extraction
  display: { inTable: true, order: 50, width: 110 },
}
```

### Types and coercion

Every provider value passes through `coerceFieldValue`. A value that cannot be
coerced is **dropped**, not stored as a string in a numeric column.

| Type              | Accepts                             | Produces                                       |
| ----------------- | ----------------------------------- | ---------------------------------------------- |
| `string`, `text`  | anything                            | trimmed string                                 |
| `number`, `money` | `"€2.5M"`, `"1,200"`, `"about 250"` | `2500000`, `1200`, `250`                       |
| `integer`         | as above                            | rounded                                        |
| `boolean`         | `true`, `"yes"`, `"1"`, `"no"`      | boolean; `"maybe"` → dropped                   |
| `url`             | `acme.com`, `HTTP://WWW.Acme.com/`  | `https://acme.com/` (tracking params stripped) |
| `email`           | validated                           | lowercased                                     |
| `date`            | anything `Date` parses              | ISO 8601                                       |
| `enum`            | `"series-a"` → `"Series A"`         | one of `options`, or dropped                   |
| `string_array`    | `"a, b; c"` or `["a","b"]`          | `['a','b','c']`                                |

The tolerance is deliberate: extraction providers return prose. The strictness
is equally deliberate: `"lots"` in an integer field is dropped, so a downstream
rule never compares against garbage.

---

## `targeting.fields` — the operator's form

This describes _what the operator is asked_, which is separate from what the
pipeline produces. The "Create Research" page renders it directly.

```ts
targeting: {
  fields: [
    { key: 'industry', label: 'Industry', type: 'select', required: true,
      options: [{ value: 'B2B SaaS', label: 'B2B SaaS' }] },
    { key: 'companySize', label: 'Company size', type: 'range',
      min: 1, max: 5000, defaultValue: [20, 500] },
    { key: 'signals', label: 'Signals', type: 'checkbox_group', options: [/* … */] },
  ],
}
```

Types: `text`, `textarea`, `number`, `select`, `multiselect`, `checkbox_group`,
`range`, `tags`. Use `group` to lay fields out under headings.

The collected values reach the research provider for query planning, and the
mock provider honours several of them (`location`, `industry`, `companySize`) so
changing the form visibly changes the results.

---

## The condition language

One small declarative language serves signal detection, validation rules, export
filters and scoring. It is JSON-serialisable, storable, renderable, and — most
importantly — produces a human-readable trace of _why_ it matched.

```ts
{ field: 'employeeCount', op: 'between', value: [20, 500] }
{ field: 'technologies', op: 'contains', value: 'HubSpot' }
{ field: 'lastFundingDate', op: 'within_days', value: 540 }
{ signal: 'recent_funding' }
{ all: [ … ] }   { any: [ … ] }   { not: … }   { always: true }
```

### Operators

| Operator                          | Notes                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `exists` / `missing`              | Empty string and empty array count as missing                                      |
| `eq` / `neq`                      | Case-insensitive for strings; array fields match if any element matches            |
| `gt` `gte` `lt` `lte`             | Numeric; strings are parsed                                                        |
| `between`                         | `[min, max]`, inclusive                                                            |
| `contains` / `not_contains`       | Substring, or membership for arrays                                                |
| `matches`                         | Case-insensitive regex; length-capped, and a bad pattern is `false`, never a crash |
| `in` / `not_in`                   | Case-insensitive membership                                                        |
| `within_days` / `older_than_days` | Relative to an injected clock, so tests are deterministic                          |

### Reserved field names

Conditions can read computed values that are not extraction fields:

`score`, `scoreBand`, `confidence`, `status`, `validationStatus`,
`sourceCount`, `displayName`.

```ts
filter: { field: 'score', op: 'gte', value: 70 }   // export only qualified rows
```

If your pipeline declares a field with one of these keys, **your field wins** —
its own rules see the extracted value.

---

## `signals`

A signal is a named, reusable observation.

```ts
signals: [
  {
    key: 'recent_funding',
    label: 'Recent funding',
    tone: 'positive', // positive | neutral | negative — drives colour
    source: 'derived', // derived | extracted
    when: {
      all: [
        { field: 'fundingStage', op: 'in', value: ['Seed', 'Series A'] },
        { field: 'lastFundingDate', op: 'within_days', value: 540 },
      ],
    },
  },
];
```

- **`derived`** signals are recomputed from field values, so they stay
  consistent after enrichment or a human edit. They require `when`.
- **`extracted`** signals are reported by a provider and passed through. One the
  provider did not report is recorded as _undetected_, not missing — so its
  absence is a fact rather than a gap.

Signals are recomputed in the `score` step and again after every review action.

---

## `validation`

```ts
validation: {
  minimumConfidence: 0.75,
  dropInvalid: false,          // true discards rather than flags
  rules: [
    {
      id: 'has-website',
      label: 'Website present',
      require: { field: 'website', op: 'exists' },   // must be SATISFIED
      severity: 'error',                             // error | warning
      message: 'A company without a website cannot be contacted.',
    },
  ],
}
```

Note `require` states what must be **true**, not what constitutes a failure.

Three independent checks run, each producing a specific named reason: required
fields present, rules satisfied, per-field confidence at or above the review
threshold.

---

## `scoring`

```ts
scoring: {
  maxScore: 100,
  thresholds: { qualified: 70, review: 40 },
  rules: [
    { id: 'uses-hubspot', label: 'Uses HubSpot', weight: 20,
      when: { signal: 'uses_hubspot' } },

    { id: 'too-large', label: 'Outside the motion', weight: -15,
      when: { field: 'employeeCount', op: 'gt', value: 1500 } },

    { id: 'completeness', label: 'Headcount scale', weight: 25, mode: 'graded',
      scale: { field: 'employeeCount', from: 0, to: 500, clamp: true } },
  ],
}
```

**How the number is produced.** Awarded points are summed; the denominator is
the sum of _positive_ weights only, so a penalty reduces the score without
inflating the maximum. The result is normalised onto `maxScore` and clamped.

**Graded rules** interpolate linearly across `scale` — useful for "closer to the
ideal size scores higher". A `when` on a graded rule acts as a gate before
interpolation.

Every rule produces a contribution with `points`, `maxPoints`, `matched` and a
rendered explanation, shown in the detail panel. Scoring is pure arithmetic; no
model is involved.

---

## `review`

```ts
review: {
  enabled: true,
  blocking: true,              // the run halts before export
  flagBelowConfidence: 0.75,
}
```

| Setting           | Effect                                           | Use when                                        |
| ----------------- | ------------------------------------------------ | ----------------------------------------------- |
| `blocking: true`  | Run parks at `review_required`; nothing exported | Precision matters — outbound lists, CRM writes  |
| `blocking: false` | Flags are recorded, the run continues            | Timeliness matters — intelligence feeds         |
| `enabled: false`  | No flagging at all                               | Exploratory work where coverage beats precision |

All three appear in the shipped examples.

---

## `export`

```ts
export: {
  approvedOnly: false,
  destinations: [
    { id: 'csv-export', label: 'CSV', connector: 'csv', enabled: true,
      options: { filename: 'qualified.csv' },
      filter: { field: 'score', op: 'gte', value: 70 } },
  ],
}
```

Each destination gets its own export record; one failing does not fail the
others. Rejected entities are never exported.

---

## `providers`

```ts
providers: { search: 'bright-data', extraction: 'llm' }
```

Per-stage, per-pipeline, falling back to the deployment's environment defaults.
Omit for the defaults.

---

## Project overrides

The create-research form collects sparse overrides that are merged and
**re-validated**:

```ts
overrides: {
  discovery: { maxResults: 40 },
  extraction: { fieldKeys: ['name', 'website', 'industry'] },  // narrow the set
  validation: { minimumConfidence: 0.6 },
  review: { blocking: false },
  export: { destinationIds: ['csv-export'] },
  scoring: { weights: { 'uses-hubspot': 30 } },
}
```

Narrowing the field set also drops signals, validation rules and scoring rules
that reference removed fields — otherwise the configuration would be invalid.
Identity and display fields are always retained; they are structural.

---

## Testing a configuration

```ts
import { describe, expect, it } from 'vitest';
import { scoreEntity, deriveSignals, detectedSignalKeys } from '@frp/scoring';
import { pipeline } from './index.js';

it('scores a strong lead as qualified', () => {
  const fields = { employeeCount: 140, technologies: ['HubSpot'], openRoles: 12 };
  const signals = deriveSignals(pipeline, fields);
  const breakdown = scoreEntity(pipeline, {
    fields,
    signals: detectedSignalKeys(signals),
    now: new Date('2026-06-01'),
  });

  expect(breakdown.band).toBe('qualified');
  // Assert on the reason, not just the number.
  expect(breakdown.contributions.find((c) => c.ruleId === 'uses-hubspot')?.matched).toBe(true);
});
```

Because scoring is deterministic and takes an injected clock, a client's
commercial rules are testable like any other business logic.
