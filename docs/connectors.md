# Connector guide

A connector delivers a finished dataset to a destination. It receives fully
structured, validated entities — never raw provider payloads — so a new
destination is a small, self-contained adapter.

```ts
interface Connector {
  readonly meta: ConnectorMeta;
  write(input: ConnectorWriteInput): Promise<ConnectorResult>;
}
```

Rows arrive as an `AsyncIterable`, so a 50k-entity export uses the same memory
as a 50-entity one.

---

## Status of the shipped connectors

Stated plainly, because a public repository that overclaims is worse than one
that does less.

| Connector | Payload mapping     | Network path                                                          | Default |
| --------- | ------------------- | --------------------------------------------------------------------- | ------- |
| `csv`     | Implemented, tested | Local filesystem — fully working                                      | —       |
| `json`    | Implemented, tested | Local filesystem — fully working                                      | —       |
| `hubspot` | Implemented, tested | Written from public API docs, **unverified against a live portal**    | dry run |
| `notion`  | Implemented, tested | Written from public API docs, **unverified against a live workspace** | dry run |
| `slack`   | Implemented, tested | Written from the incoming-webhook contract, **unverified**            | dry run |

"Unverified" means the request shape, batching and error classification are
implemented and unit-tested, but nobody has watched a real 200 come back from
that vendor. The first live run is an integration test.

### Dry run

The credentialed connectors default to `dryRun` when their credentials are
absent, and write the **exact request bodies they would send** to
`$EXPORT_DIR/dry-run/<runId>.<connector>.json`:

```json
{
  "connector": "hubspot",
  "runId": "run_9es8v0",
  "payload": {
    "endpoint": "https://api.hubapi.com/crm/v3/objects/companies/batch/upsert",
    "batches": [
      [
        {
          "idProperty": "domain",
          "id": "acme.com",
          "properties": { "name": "Acme", "domain": "acme.com" }
        }
      ]
    ]
  }
}
```

Diff that against the vendor's documentation before enabling the live path. This
is the honest alternative to pretending a CRM push succeeded.

---

## `csv`

```ts
{ id: 'csv-export', label: 'CSV', connector: 'csv',
  options: { filename: 'qualified.csv', delimiter: ',',
             columns: ['name', 'website'], includeMetadata: true, includeSources: true } }
```

Streams straight to disk. RFC 4180 quoting on every cell, and a leading `=`,
`+`, `-` or `@` is prefixed with `'` so a spreadsheet cannot be tricked into
evaluating extracted text as a formula — extracted content is untrusted input,
and a CSV is executed by the application that opens it.

## `json`

```ts
{ id: 'json-export', label: 'JSON', connector: 'json',
  options: { format: 'json', pretty: true } }   // or format: 'ndjson'
```

Keeps per-field confidence, status, provenance and the score breakdown, so a
downstream system receives what an operator sees rather than a flattened
summary.

## `hubspot`

```ts
options: {
  dryRun: true,
  idProperty: 'domain',
  propertyMap: { name: 'name', website: 'domain', employeeCount: 'numberofemployees' },
}
```

Batches of 100 against the CRM v3 batch upsert endpoint. Rows without a value
for `idProperty` are skipped with a warning rather than sent. Needs
`HUBSPOT_ACCESS_TOKEN`.

## `notion`

```ts
options: { dryRun: true, databaseId: '…', titleField: 'name' }
```

One page per entity, with property types derived from your field definitions
(`number`, `checkbox`, `url`, `date`, `select`, `multi_select`, `rich_text`).
Needs `NOTION_TOKEN`.

## `slack`

```ts
options: { dryRun: true, topN: 8 }
```

A notification destination, not a data destination: it receives a Block Kit
digest — counts and the top-scoring entities — not the dataset. Needs
`SLACK_WEBHOOK_URL`.

---

## Writing one

`packages/connectors/src/my-crm/index.ts`:

```ts
import {
  NotConfiguredError,
  PipelineError,
  type Connector,
  type ConnectorResult,
  type ConnectorWriteInput,
} from '@frp/core';

export const myCrmConnector: Connector = {
  meta: {
    id: 'my-crm',
    label: 'My CRM',
    description: 'Creates records in My CRM.',
    requiresCredentials: true,
    // Surfaced on the System page so an operator can see what to configure.
    options: [
      { key: 'listId', description: 'Target list id', required: true },
      { key: 'dryRun', description: 'Write the payload to disk instead', required: false },
    ],
  },

  async write(input: ConnectorWriteInput): Promise<ConnectorResult> {
    const { listId, dryRun } = input.options as { listId?: string; dryRun?: boolean };
    if (!listId) {
      throw new PipelineError('CONNECTOR_NOT_CONFIGURED', 'my-crm requires "listId"');
    }

    const token = process.env.MY_CRM_TOKEN;
    if (!dryRun && !token) throw new NotConfiguredError('my-crm', ['MY_CRM_TOKEN']);

    const warnings: string[] = [];
    let count = 0;

    // Stream: never materialise the whole result set.
    for await (const { entity, fields } of input.rows) {
      if (input.signal?.aborted) {
        warnings.push('export aborted before completion');
        break;
      }
      await send(token!, listId, entity, fields);
      count += 1;
    }

    input.logger.info({ listId, rows: count }, 'my-crm export written');
    return { location: `my-crm:${listId}`, entityCount: count, warnings };
  },
};
```

Register it in `packages/connectors/src/index.ts`, then reference it from a
pipeline's `export.destinations`.

### Guidelines

- **Stream.** Do not collect rows into an array.
- **Check `input.signal`** between items so a cancelled run stops promptly.
- **Return warnings** rather than throwing for per-row problems; throw only when
  the destination as a whole failed.
- **Mark transient failures retryable** — the export step retries the whole
  destination.
- **Use `input.logger`**; it is already tagged with the run and connector.
- **Reuse `rows.ts`** (`flattenRow`, `structuredRow`) so every destination
  exports the same logical record.
