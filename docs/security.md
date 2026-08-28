# Security and multi-tenancy

This repository is public and ships a demo that runs with no credentials. That
shapes what is here and what is deliberately absent.

**What is implemented is stated as implemented. What is missing is stated as
missing.** A framework that pretends to be production-secure is more dangerous
than one that is clear about its gaps.

---

## Implemented

### No credentials in the repository

Every secret is an environment variable, documented in
[`.env.example`](../.env.example), and `.env` is gitignored. Nothing in the
default path requires a key: `PROVIDER_*=mock` is the default, so a clone runs
end to end offline.

### Loud failure instead of silent degradation

A provider selected without its credentials throws `NotConfiguredError` naming
the missing variables. It never falls back to fabricated data. Credentialed
connectors default to a **dry run** that writes the request body to disk rather
than pretending a push succeeded.

### Input validation at every boundary

Every request body, query string and route parameter is parsed with a Zod schema
before a handler sees it. Provider responses are validated before use.
Configurations are validated at definition time.

### Injection resistance

- **SQL** — all queries go through Drizzle's parameterised builder. The one
  place a key is interpolated into a JSON path (`runs.stats` counters) is
  whitelisted against a fixed key set.
- **CSV** — cells beginning `=`, `+`, `-` or `@` are prefixed with `'`, so a
  spreadsheet cannot evaluate extracted text as a formula. Extracted content is
  untrusted input.
- **Regex** — `matches` patterns are length-capped and inputs truncated; a bad
  pattern returns `false` rather than throwing or hanging.
- **Path traversal** — the export download endpoint resolves the stored location
  and refuses anything outside `EXPORT_DIR`.

### Operational hygiene

- Containers run as a non-root user (uid 10001).
- `authorization` and `x-api-key` are redacted from request logs.
- Database URLs are redacted in migration output.
- CORS is an explicit allowlist, not `*`.
- Request bodies are capped at 2 MB.
- Bulk review is capped at 1000 ids per call.

### Optional shared secret

Setting `API_KEY` requires `x-api-key` on every `/v1` request. `/health` stays
open for orchestrator probes. This is a deployment convenience, **not
authentication** — see below.

---

## Not implemented

### Authentication and authorisation

There is no user model, no session, no RBAC. Every request acts as the same
operator; reviews are attributed to the literal string `operator`.

**Where it hooks in:** the `onRequest` hook in `apps/api/src/server.ts`. Replace
the shared-secret check with your identity provider, resolve a user and a tenant
from the token, and attach both to the request. The route handlers already take
`tenantId` from the application context rather than from the client, so the
change is contained.

**What else needs doing at the same time:**

- Replace the `REVIEWER` constant in `apps/api/src/routes/entities.ts` with the
  authenticated identity. The `reviews` table already stores a reviewer per
  decision.
- Decide who may resume a run with `{ force: true }` — that action accepts
  unreviewed data into an export.

### Tenant isolation enforcement

The data model is ready: **every tenant-owned row carries `tenant_id`
directly**, not merely reachable through a join. That was deliberate, so
row-level security can be switched on without a migration.

Today isolation is enforced in application code — every query filters by the
context's `tenantId`. That is one forgotten `where` clause away from a leak.

**To enforce it in the database:**

```sql
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON entities
  USING (tenant_id = current_setting('app.tenant_id', true));

-- repeat for projects, runs, entity_fields, evidence, reviews, exports
```

Then set `app.tenant_id` per connection or per transaction, from the
authenticated token, in the API and the worker. A pooled connection must set it
inside the transaction, not at connect time.

**Also required for real multi-tenancy:**

- **Per-tenant provider credentials.** Today credentials come from process
  environment variables, so all tenants share one Bright Data account and one
  API budget. Move them to a per-tenant secret store and resolve them when the
  provider bundle is built.
- **Per-tenant quotas.** A single tenant can currently saturate the queue. Rate
  limit run creation and give the queue per-tenant fairness.
- **Export isolation.** `EXPORT_DIR` is shared. Partition by tenant, or use
  per-tenant object-storage prefixes.

### Other gaps

| Gap                                             | Consequence                                   | Mitigation if you deploy this                                  |
| ----------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| No rate limiting on the API                     | A client can exhaust the pool                 | Add `@fastify/rate-limit`, or rate limit at the ingress        |
| No audit log for non-review actions             | Cancels and config edits are not attributable | `run_events` is the natural home                               |
| No secret rotation                              | Restart required to pick up new keys          | Resolve credentials per run instead of at boot                 |
| SSE connections are unbounded                   | Many idle tabs hold connections               | Cap connections per tenant                                     |
| No encryption at rest beyond the database's own | Evidence snippets may contain sensitive text  | Use encrypted volumes; consider column encryption for evidence |

---

## Handling research data

Two properties are worth understanding before pointing this at real data.

**Evidence snippets are stored verbatim.** That is the point — traceability
requires the actual sentence. It also means the `evidence` table contains
third-party page content, which may include personal data. Under GDPR, an
extracted person's name and title is personal data; plan retention and deletion
accordingly. Deleting a run cascades to its entities, fields and evidence.

**Exports leave the system's controls.** A CSV on disk has no confidence, no
review state and no access control. The framework compensates by including
confidence, status and source columns by default, so a downstream reader can at
least see what they are trusting — but once exported, it is an ordinary file.

---

## Reporting a vulnerability

Open a GitHub issue for anything already public. For anything sensitive, use
GitHub's private vulnerability reporting on the repository rather than a public
issue.
