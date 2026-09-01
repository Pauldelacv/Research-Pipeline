# Local development

## Requirements

- Node 20.11+ (22 recommended) and pnpm 10
- Docker, **or** local PostgreSQL 16 + Redis 7

## Docker

```bash
cp .env.example .env
docker compose up --build
```

The API container applies migrations and seeds three demo projects before it
starts serving, so a single `up` leaves a usable system. Open
<http://localhost:3000>.

```bash
docker compose logs -f api worker    # follow structured logs
docker compose down -v               # stop and drop the volumes
```

## Without Docker

```bash
cp .env.example .env      # defaults already point at localhost
pnpm install
pnpm db:migrate
pnpm seed
pnpm dev                  # api :4000 · worker · web :3000
```

`pnpm dev` starts the API and worker **from the repository root** so both
processes resolve `EXPORT_DIR` to the same directory. If you start them from
inside `apps/*`, use an absolute `EXPORT_DIR` or the API will not find the files
the worker wrote.

## Commands

| Command                                   | What it does                                         |
| ----------------------------------------- | ---------------------------------------------------- |
| `pnpm dev`                                | API, worker and web together                         |
| `pnpm dev:api` / `dev:worker` / `dev:web` | One at a time                                        |
| `pnpm test`                               | Unit tests across every package                      |
| `pnpm test:e2e`                           | Playwright, against a running stack                  |
| `pnpm typecheck`                          | Whole monorepo, including the web app                |
| `pnpm lint` / `pnpm format`               | ESLint / Prettier                                    |
| `pnpm db:generate`                        | Regenerate migrations after a schema change          |
| `pnpm db:migrate`                         | Apply pending migrations                             |
| `pnpm db:reset`                           | Drop and recreate the schema (refuses in production) |
| `pnpm seed`                               | Create the demo projects (idempotent)                |

## How the monorepo is wired

Internal packages are consumed as **TypeScript source**, not as build output:

```json
{ "exports": { ".": "./src/index.ts" } }
```

There is no build-order graph, no `dist` to stale out, and no watch-mode
choreography. `tsx` runs the source directly, Next.js transpiles it
(`transpilePackages`), and `tsup` inlines it into a single file for the
production images.

Two consequences worth knowing:

- Cross-package imports use an explicit `.js` extension, as ESM requires. Node
  and tsx resolve it to the `.ts` source; webpack needs
  `resolve.extensionAlias`, which `apps/web/next.config.ts` sets.
- Adding a package means adding a path alias in `tsconfig.base.json` and, if it
  has tests, an alias in that package's `vitest.config.ts`.

## Testing

**Unit tests** need no services. The core suite runs the entire nine-step
pipeline against in-memory stores in about 50ms — see
`packages/core/test/harness.ts`. If a test ever needs a database, something has
leaked across the port boundary.

**End-to-end tests** drive a real browser against a running stack:

```bash
pnpm dev                     # in one terminal
pnpm test:e2e                # in another
```

They follow the same path the README promises, so a broken README is a failing
test. If your environment already ships a Chromium, point at it instead of
downloading another:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium pnpm test:e2e
```

## Debugging a run

1. **The run view** — step statuses, attempt counts, per-step metrics, warnings
   and errors, live.
2. **The Failures tab** — usually the fastest answer. One row per failure, with
   the pipeline stage, the provider, the attempt count, the source or entity in
   hand, and the provider's response (redacted when it was written). It records
   the failures a step _tolerated_ as well as the ones that ended it, which is
   the part logs make hard to see.
3. **The Events tab** — filter by level; expand an event for its structured
   data. `step.retry`, `step.failed` and `provider` errors are all here.
4. **The Cost tab** — when the problem is "this run got expensive", not "this
   run broke". Spend per provider, per stage and per call.
5. **Logs** — every line carries `runId`, `stepId`, `attempt` and `provider`:

   ```bash
   docker compose logs worker | grep run_9es8v0
   ```

6. **The database** — the run record is the source of truth:

   ```sql
   select step_id, status, attempt, metrics->>'durationMs' as ms, error
   from pipeline_step_runs where run_id = 'run_9es8v0' order by created_at;

   select step_id, scope, code, provider, target_label, will_retry
   from run_failures where run_id = 'run_9es8v0' order by created_at desc;

   select provider, operation, count(*), sum(cost_usd)
   from provider_usage where run_id = 'run_9es8v0' group by 1, 2;
   ```

7. **The System page** — provider health, connector inventory, queue depth. A
   missing credential shows up here rather than three steps into someone's run.

## Common problems

**The pipeline view does not update live.** Check `/v1/runs/:id/stream` reaches
the browser. A proxy that buffers responses will break SSE; the UI falls back to
4-second polling, so this looks like sluggishness rather than breakage. Set
`X-Accel-Buffering: no` (already sent) and disable proxy buffering.

**Exports 404 on download.** The API and worker resolved `EXPORT_DIR`
differently. The API logs its resolved path at boot as `exportDir`; compare it
with the worker's.

**A run sits in `queued`.** The worker is not consuming. Check it is running and
that both services point at the same Redis.

**Migrations fail after editing the schema.** Run `pnpm db:generate` to produce
the SQL, and commit it — the containers apply files, they do not diff at
runtime.

**Everything is flagged for review.** `flagBelowConfidence` is above what your
provider reports. The mock provider deliberately returns a spread of
confidences; lower the threshold or raise `MOCK_FAILURE_RATE=0` for a cleaner
demo.
