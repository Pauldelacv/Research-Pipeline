# Example pipelines

Three configurations, chosen because they stress different parts of the design.
Each is a workspace package exporting one `defineResearchPipeline({ … })` call —
they contain **no code**, only configuration.

| Example                                                | Entity               | Identity                 | Review       | What it demonstrates                                                   |
| ------------------------------------------------------ | -------------------- | ------------------------ | ------------ | ---------------------------------------------------------------------- |
| [`lead-generation`](lead-generation)                   | `company`            | domain                   | blocking     | Signals, weighted scoring with a penalty, CRM destination              |
| [`competitive-intelligence`](competitive-intelligence) | `competitor_event`   | competitor + type + date | non-blocking | A non-company entity; composite identity; time-sensitive review policy |
| [`market-research`](market-research)                   | `market_participant` | domain                   | disabled     | Graded (interpolated) scoring; coverage over precision                 |

## Why these three

**Lead generation** is the canonical case: firmographic and technographic
filtering, commercial scoring, a human gate before anything reaches a CRM.

**Competitive intelligence** is the proof that the framework is not a
lead-generation tool with knobs. Its entity is an _observed change_ — a launch,
a price move — not an organisation. Identity is composite, so the same
announcement seen on three sites merges into one item with three pieces of
evidence. Review is non-blocking because an intelligence feed that waits for a
reviewer is a stale intelligence feed.

**Market research** turns review off entirely. A market map's value is coverage,
not per-row precision, and its scoring is _graded_: completeness interpolates
across a scale rather than matching a boolean.

Between them they exercise every branch of the review policy, both scoring
modes, and both identity strategies. Nothing in `packages/` knows any of them
exists.

## Running one

All three are seeded by `pnpm seed` (and by `docker compose up`). Open the
dashboard and press **Run**.

## Writing your own

1. Copy the closest example into `examples/<client>/`.
2. Rename the package and the pipeline `key`.
3. Change `entity`, `extraction.fields`, `signals` and `scoring.rules`.
4. Register it in `apps/api/src/pipelines.ts`.

The mock provider adapts automatically — it generates from your field
definitions, so you can see the whole pipeline run against your schema before
connecting a real provider.

See [../docs/configuration.md](../docs/configuration.md) for the full reference.
