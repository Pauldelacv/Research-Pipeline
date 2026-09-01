# Provider development guide

Providers are the only place the pipeline touches the outside world. Four
interfaces, in `packages/core/src/providers/types.ts`:

```ts
interface ResearchProvider {
  plan(input, ctx): Promise<ResearchPlan>;
}
interface SearchProvider {
  search(query, ctx): Promise<SearchResult[]>;
}
interface ExtractionProvider {
  extract(input, ctx): Promise<ExtractionOutput>;
}
interface EnrichmentProvider {
  enrich(input, ctx): Promise<EnrichmentOutput>;
}
```

Every provider also implements `healthcheck()`, which must be cheap and must not
consume paid quota — the System page probes it live.

---

## The contract

Four rules. The first two are what keep the system trustworthy.

### 1. Never invent data

A field you could not determine is **absent**. Not an empty string, not a
plausible guess, not a default. The validation step is designed to treat missing
data as a completeness problem and tell the operator; a fabricated value defeats
the entire design.

### 2. Always attach evidence

```ts
{
  key: 'employeeCount',
  value: 140,
  confidence: 0.86,
  evidence: {
    snippet: 'Acme employs around 140 people across three offices.',
    locator: 'main > section.about > p:nth-of-type(2)',   // optional
    method: 'llm',                                        // llm | rule | api | manual
  },
}
```

The extraction step **drops any value without a snippet**. A value that cannot
be reviewed has no business in the dataset.

### 3. Classify failures honestly

```ts
throw new ProviderError('my-provider', 'PROVIDER_RATE_LIMITED', '429 from upstream', {
  retryable: true,
});
```

`retryable: true` for 429s, 5xx and timeouts — the engine turns it into a
queue-level retry with backoff. `retryable: false` for bad credentials, malformed
requests and anything a retry cannot fix. Getting this wrong either wastes
budget retrying a permanent failure, or fails a run that would have recovered.

### 4. Fail loudly when unconfigured

```ts
if (!apiKey) throw new NotConfiguredError('my-provider', ['MY_PROVIDER_API_KEY']);
```

Never degrade silently to fabricated data. The error names the missing variable
and suggests the mock provider.

---

## Writing one

`packages/providers/src/my-provider/index.ts`:

```ts
import {
  ProviderError,
  NotConfiguredError,
  type ProviderCallContext,
  type SearchProvider,
  type SearchQuery,
  type SearchResult,
} from '@frp/core';

export class MySearchProvider implements SearchProvider {
  readonly meta = {
    id: 'my-provider',
    kind: 'search' as const,
    label: 'My search API',
    description: 'Search results from example.com.',
    requiresCredentials: true,
  };

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new NotConfiguredError('my-provider', ['MY_PROVIDER_API_KEY']);
  }

  async healthcheck() {
    return { ok: Boolean(this.apiKey), detail: 'credentials present' };
  }

  async search(query: SearchQuery, ctx: ProviderCallContext): Promise<SearchResult[]> {
    const response = await fetch('https://api.example.com/search', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ q: query.query, limit: query.limit }),
      signal: ctx.signal, // honour cancellation
    });

    if (response.status === 429 || response.status >= 500) {
      throw new ProviderError(
        'my-provider',
        'PROVIDER_RATE_LIMITED',
        `upstream responded ${response.status}`,
        { retryable: true },
      );
    }
    if (!response.ok) {
      throw new ProviderError(
        'my-provider',
        'PROVIDER_BAD_RESPONSE',
        `upstream responded ${response.status}`,
      );
    }

    // Validate the payload before trusting its shape.
    const parsed = responseSchema.parse(await response.json());

    return parsed.results.map((result, index) => ({
      url: result.link,
      title: result.title ?? null,
      snippet: result.description ?? null,
      rank: index + 1,
      kind: 'search_result',
    }));
  }
}
```

Register it lazily in `packages/providers/src/index.ts` so a deployment without
credentials still boots and can still list what exists:

```ts
registry.register(
  {
    id: 'my-provider',
    kind: 'search',
    label: 'My search API',
    description: '…',
    requiresCredentials: true,
  },
  () => new MySearchProvider(config.MY_PROVIDER_API_KEY ?? ''),
);
```

Construction — and therefore the `NotConfiguredError` — happens only when a run
actually selects it.

Then use it:

```bash
PROVIDER_SEARCH=my-provider
```

---

## `ProviderCallContext`

```ts
{
  runId: string;
  attempt: number;
  logger: Logger;
  signal?: AbortSignal;
  recordUsage(usage: ProviderUsageReport): void;
}
```

`attempt` is the current step attempt (1-based). Use it for logging, or to vary
an idempotency key across retries. The mock provider uses it so a simulated
transient failure does not reproduce identically on retry — without that,
`retryable: true` would be decorative.

### 5. Report what a call consumed

`recordUsage` is synchronous and never throws: accounting must not be able to
fail a run, and a provider should not wait on a database to be counted. The
report is buffered and flushed once per step attempt — including when the step
fails, so a step that dies half-way still accounts for what it spent.

```ts
const startedAt = Date.now();
try {
  const response = await callUpstream();
  ctx.recordUsage({
    operation: 'search', // your verb: plan | search | extract | unlock…
    model: null, // null for a per-request API
    inputTokens: response.usage?.prompt_tokens ?? null,
    outputTokens: response.usage?.completion_tokens ?? null,
    costUsd: response.usage?.cost ?? null,
    costSource: 'reported', // reported | estimated | unknown
    latencyMs: Date.now() - startedAt,
    outcome: 'success',
    target: query.query, // the source, entity or query this was for
  });
  return response;
} catch (error) {
  // A failed call still consumed a request and often tokens.
  ctx.recordUsage({
    operation: 'search',
    latencyMs: Date.now() - startedAt,
    outcome: 'failure',
    errorCode: error instanceof ProviderError ? error.code : 'INTERNAL',
  });
  throw error;
}
```

Report what you actually know and leave the rest `null`. A made-up token count
is worse than a missing one: it looks authoritative in a cost report. `costUsd:
null` renders as "not priced" and marks the run's total as a floor, which is
the honest outcome when nobody knows the number.

An adapter that delegates — Bright Data fetching a page and handing the text to
a model — should attribute the delegate's spend to the delegate by setting
`provider` and `providerKind` on the reports it forwards. A cost report that
bills model tokens to an unlocker cannot be used to decide anything.

### Provider detail in failure reports

Anything you attach to a `ProviderError`'s `details` is stored on the run's
failure record and shown in the UI, so put the response body there — it is the
first thing anyone debugging asks for:

```ts
throw new ProviderError('my-provider', 'PROVIDER_BAD_RESPONSE', message, {
  details: { status, response: body, model },
});
```

It is redacted before it is written: keys that look like credentials
(`authorization`, `*token*`, `*secret*`, `*key*`…) and token-shaped values in
free text are replaced, strings and arrays are bounded. Redaction happens at
write time rather than at display time, so a view added later cannot reintroduce
a leak.

---

## Shipped providers

### `mock` — the default

Not a fixture file. It maintains a deterministic synthetic world derived from a
seed and observes it noisily.

**Stateless world.** `entityFor(slug)` re-derives the same record from the seed
and the slug alone. The search provider invents a URL; the extraction provider —
a different object, in a different worker, minutes later — recovers exactly the
entity that URL refers to, with no shared state.

**Config-driven.** Values come from _your_ field definitions. Enum fields draw
from their declared options; a pipeline about market segments produces market
segments and never company fields.

**Realistically imperfect,** and each imperfection exists to exercise a specific
behaviour:

| Behaviour                                                 | Exercises                                       |
| --------------------------------------------------------- | ----------------------------------------------- |
| Sources disagree (numbers drift, lists come back partial) | Merge conflict resolution, confidence penalties |
| Fields go missing (~45% for optional fields)              | Validation, review flagging                     |
| Enums arrive with the wrong separator (`Series-A`)        | Coercion                                        |
| Queries overlap on the same universe                      | Deduplication                                   |
| Calls take time, jittered ±40%                            | Progress rendering, timeouts                    |
| ~4% of calls fail retryably                               | Retry and backoff                               |

Tuning:

```bash
MOCK_SEED=field-research     # change for a different world
MOCK_LATENCY_MS=350
MOCK_FAILURE_RATE=0.04
MOCK_DETERMINISTIC=true      # disable latency and failures (tests)
```

### `llm` — research planning and extraction (Anthropic)

Requires `ANTHROPIC_API_KEY`. Both entry points use schema-constrained
structured outputs: the response schema is **built from your pipeline's field
definitions**, so the model cannot return a field you did not ask for.

The system prompt is explicit about the two rules that matter — report only what
the source states, and quote evidence for every value — and everything that
comes back still passes through the same coercion and merge path as any other
provider.

Values arrive as strings and are coerced by the framework rather than by the
model, which keeps typing in one place and turns "approximately 250" into a
clean rejection instead of a string in a numeric column.

The extraction provider fetches pages with plain `fetch` and a minimal
HTML-to-text pass. Pages needing JavaScript or bot mitigation should be fetched
by an unlocker-capable provider — see below.

The Anthropic API reports tokens but not a price, so its cost rows are
`estimated` from the built-in price table. Published prices move; override them
for the model you actually run:

```bash
LLM_PRICE_INPUT_PER_MTOK=3
LLM_PRICE_OUTPUT_PER_MTOK=15
```

The same pair applies to whichever model adapter is in use — a deployment sets
them for the model it runs, not per vendor.

### `openrouter` — research planning and extraction

Requires `OPENROUTER_API_KEY`. One key and one OpenAI-compatible endpoint reach
OpenRouter's whole catalogue, which makes it the pragmatic choice when you want
to compare models, run a cheaper one for bulk extraction, or use a vendor you
already pay for.

```bash
PROVIDER_RESEARCH=openrouter
PROVIDER_EXTRACTION=openrouter
OPENROUTER_API_KEY=sk-or-…
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5   # any OpenRouter model slug
OPENROUTER_SITE_URL=https://research.example   # optional attribution
OPENROUTER_APP_NAME=field-research-pipeline    # optional attribution
```

It shares the prompts, the response schema, the evidence requirement and the
value coercion with the `llm` adapter. Switching between them changes who serves
the tokens and nothing about what reaches the datastore.

Two details are specific to it:

- **Strict JSON Schema.** The same Zod schema is converted to JSON Schema and
  sent with `strict: true`. OpenRouter forwards it to whichever provider serves
  the model, and their validators are not equally forgiving, so the conversion
  drops `$schema` and rewrites `anyOf: [{type: 'string'}, {type: 'null'}]` as
  `type: ['string', 'null']`. The reply is re-validated against the Zod schema
  afterwards: the JSON Schema constrains the model, the Zod parse catches the
  model that ignored it.
- **Reported cost.** OpenRouter returns what a call actually cost, so its usage
  rows are `reported` rather than `estimated` — the only shipped provider for
  which the run's cost figure is a price rather than a calculation.

Errors are classified by status: 429 and 5xx are retryable; 401/403 (bad key)
and 402 (out of credits) are not, because retrying those just burns the run's
remaining attempts.

### `bright-data` — search and extraction

Requires `BRIGHT_DATA_API_KEY` and configured zones.

- **Search** uses a SERP zone; the response is validated with Zod before use.
- **Extraction** uses a Web Unlocker zone to _fetch_, then delegates
  _interpretation_ to another extraction provider (the LLM one). Separating
  retrieval from interpretation is what keeps this adapter small and swappable.

Retrieval is billed per request rather than per token, so its usage rows carry
a request count and a latency and no price. The delegate's tokens are attributed
to the delegate, not to the unlocker.

**Status, stated plainly:** written against Bright Data's public documentation
and **not verified against a live account**, because this repository ships
without credentials. The request shapes, error classification and response
validation are implemented; nobody has watched a real 200 come back. Treat the
first live run as an integration test.

- **Enrichment is not implemented.** Doing it properly means choosing a specific
  dataset, mapping its schema and handling async delivery — per-client decisions.
  The adapter throws a clear error rather than guessing. To implement one:
  choose the dataset, map its fields onto your configuration's field keys, and
  return `ExtractedField[]` with evidence pointing at the dataset record.

---

## Testing a provider

The contract tests worth writing, in order of value:

```ts
it('never returns a value without evidence', async () => {
  const output = await provider.extract(input, ctx);
  for (const entity of output.entities) {
    for (const field of entity.fields) {
      expect(field.evidence.snippet.length).toBeGreaterThan(0);
    }
  }
});

it('only returns declared fields', async () => {
  const declared = new Set(config.extraction.fields.map((f) => f.key));
  // …every returned key is in `declared`
});

it('marks a 429 retryable', async () => {
  // …expect error.retryable === true
});

it('returns nothing rather than inventing an entity', async () => {
  const output = await provider.extract({ ...input, source: unrelatedPage }, ctx);
  expect(output.entities).toHaveLength(0);
});
```

`packages/providers/src/mock/mock.test.ts` implements all of these against the
mock provider and is a reasonable template.

---

## Cost accounting

Every provider call writes one row to `provider_usage`: provider, operation,
model, tokens, request count, latency, outcome and cost. The table is
append-only and the run-level rollup is computed on read, so the number always
matches the calls it claims to summarise.

`GET /v1/runs/:id/usage` returns totals plus per-provider and per-stage
breakdowns; `?detail=true` adds the individual calls. The run view renders it
under the **Cost** tab.

Three things the view is deliberately careful about:

| Label                       | Means                                                       |
| --------------------------- | ----------------------------------------------------------- |
| `reported`                  | The provider returned this price for this call.             |
| `estimated`                 | Tokens × a price table. Shown with a `~`.                   |
| `unknown` (`costUsd: null`) | Nobody could price it. The run's total is shown as a floor. |

A model absent from the price table yields `null`, never a confident zero — a
zero quietly understates a run's cost, which is the one number this exists to
get right. Set `LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK` to
price your model explicitly, or use `openrouter`, which reports real prices.
