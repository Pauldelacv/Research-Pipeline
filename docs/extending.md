# Extending the framework

Four extension points, in rough order of how often you will reach for them.

---

## 1. A new pipeline (most client work)

Write a configuration and register it. No framework code changes.

```
examples/my-client/
  package.json          # name: @frp/example-my-client
  src/index.ts          # defineResearchPipeline({ … })
```

Register in `apps/api/src/pipelines.ts` — the one file a deployment differs in:

```ts
export function registerPipelines(registry: PipelineRegistry): PipelineRegistry {
  return registry.registerAll([leadGenerationPipeline, myClientPipeline]);
}
```

The create-research form, the results columns, the scoring panel, the review
thresholds and the export destinations all follow. See
[configuration.md](configuration.md).

---

## 2. A new provider

See [providers.md](providers.md). Implement one of the four interfaces, register
it lazily, select it with `PROVIDER_*` or per pipeline.

---

## 3. A new connector

See [connectors.md](connectors.md). Implement `Connector`, register it,
reference it from `export.destinations`.

---

## 4. A new or replaced step

**Replacing an implementation** is the common case — a client with an internal
entity resolver substitutes `structure`:

```ts
import { defaultSteps, PipelineEngine } from '@frp/core';
import { myStructureStep } from './steps/structure.js';

const steps = defaultSteps.map((step) => (step.id === 'structure' ? myStructureStep : step));

const engine = new PipelineEngine(steps);
```

The engine requires every canonical step id to be present, so a partial set
fails at construction rather than mid-run.

A step implementation looks like this:

```ts
export const myStructureStep: PipelineStep = {
  id: 'structure',
  name: 'Structuring results',
  idempotent: true, // must be true: a redelivered job re-runs it
  maxAttempts: 2,
  timeoutMs: 300_000,

  async execute(ctx): Promise<StepResult> {
    let processed = 0;

    for await (const candidate of ctx.stores.candidates.iterate(ctx.runId, 200)) {
      await ctx.assertNotCancelled(); // cheap; throttled internally
      // …
      processed += 1;
    }

    await ctx.emit({
      type: 'structure.completed',
      message: `${processed} candidates merged`,
      data: { processed },
    });

    return {
      status: 'completed',
      metrics: { itemsIn: processed, itemsOut: processed },
      output: { entities: processed }, // small hand-off only, never bulk data
    };
  },
};
```

Rules a step must respect:

- **Be idempotent.** Derive write keys from stable inputs
  (`deterministicId('ent', runId, dedupeKey)`), so a redelivered job converges.
- **Call `ctx.assertNotCancelled()`** between units of work.
- **Report metrics.** They are what the run view and the dashboard show.
- **Return `partial`, not a throw,** when some items failed and the output is
  still usable.
- **Keep `output` small.** It is a hand-off between steps, not a data channel —
  bulk data belongs in a store.

**Adding a genuinely new step** means extending `PIPELINE_STEP_ORDER` and
`STEP_LABELS` in `packages/schemas/src/pipeline.ts`. Think carefully: the fixed
spine is what makes runs comparable across deployments, and every existing run
in the database has the old shape.

---

## 5. Replacing the datastore

The engine depends on store _ports_, not on Postgres. Implement
`packages/core/src/ports/stores.ts` and pass your `StoreBundle`. This is
genuinely viable — the test suite already ships a complete in-memory
implementation (`packages/core/test/harness.ts`) that the whole pipeline runs
against.

You would still need to reimplement the API's application queries
(`packages/db/src/repositories.ts`), which are intentionally separate from the
engine's ports: the engine has no business creating projects, and the API has no
business reaching into step state.

---

## Where things live

| You want to change                           | Edit                                                 |
| -------------------------------------------- | ---------------------------------------------------- |
| What a client's pipeline collects and scores | `examples/<client>/src/index.ts`                     |
| Which pipelines a deployment offers          | `apps/api/src/pipelines.ts`                          |
| How a stage reaches the outside world        | `packages/providers/src/<provider>/`                 |
| Where results are delivered                  | `packages/connectors/src/<connector>/`               |
| What a step does                             | `packages/core/src/engine/steps/<step>.ts`           |
| Ordering, retries, state transitions         | `packages/core/src/engine/engine.ts`                 |
| The database schema                          | `packages/db/src/schema.ts`, then `pnpm db:generate` |
| API surface                                  | `apps/api/src/routes/`                               |
| The operator console                         | `apps/web/src/`                                      |
| Shared types and the wire contract           | `packages/schemas/src/`                              |
