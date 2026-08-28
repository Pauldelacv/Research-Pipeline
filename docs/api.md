# API reference

Base URL `http://localhost:4000`. JSON in, JSON out. When `API_KEY` is set,
every `/v1` request needs `x-api-key`; `/health` stays open.

Errors share one envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "invalid body",
    "details": [{ "path": "name", "message": "Too small" }]
  }
}
```

| Code                               | HTTP |
| ---------------------------------- | ---- |
| `VALIDATION_FAILED`, `BAD_REQUEST` | 400  |
| `UNAUTHORIZED`                     | 401  |
| `NOT_FOUND`                        | 404  |
| `CONFLICT`                         | 409  |
| `INTERNAL`                         | 500  |

---

## System

| Method | Path                 | Notes                                                      |
| ------ | -------------------- | ---------------------------------------------------------- |
| `GET`  | `/health`            | Probes Postgres, Redis and the queue. 503 if any is down   |
| `GET`  | `/v1/metrics`        | Success rate, median duration, entity counts, queue depth  |
| `GET`  | `/v1/pipelines`      | Registered templates, with their targeting form and fields |
| `GET`  | `/v1/pipelines/:key` | One full configuration                                     |
| `GET`  | `/v1/providers`      | Inventory with **live** healthchecks and the defaults      |
| `GET`  | `/v1/connectors`     | Inventory with the options each accepts                    |

---

## Projects

| Method   | Path                    | Notes                                |
| -------- | ----------------------- | ------------------------------------ |
| `GET`    | `/v1/projects`          | `limit`, `offset`                    |
| `POST`   | `/v1/projects`          | Create; optionally queue a run       |
| `GET`    | `/v1/projects/:id`      | With its most recent run             |
| `PATCH`  | `/v1/projects/:id`      | Name, objective, targeting           |
| `DELETE` | `/v1/projects/:id`      | Cascades to runs, entities, evidence |
| `POST`   | `/v1/projects/:id/runs` | Start a run — 202                    |

```http
POST /v1/projects
{
  "name": "French B2B SaaS — Q3",
  "objective": "Find French B2B SaaS companies that recently raised…",
  "configKey": "lead-generation",
  "targeting": { "industry": "B2B SaaS", "location": "France", "companySize": [20, 500] },
  "overrides": { "discovery": { "maxResults": 40 } },
  "startImmediately": true
}
```

Overrides are merged onto the template and **re-validated**; an override that
orphans a scoring rule is rejected here rather than mid-run.

---

## Runs

| Method | Path                   | Notes                                                |
| ------ | ---------------------- | ---------------------------------------------------- |
| `GET`  | `/v1/runs`             | `projectId`, `limit`, `offset`                       |
| `GET`  | `/v1/runs/:id`         | Run, project, all nine steps, exports, entity counts |
| `GET`  | `/v1/runs/:id/events`  | `after` (cursor), `limit`, `level`                   |
| `GET`  | `/v1/runs/:id/sources` | Every document the run looked at                     |
| `GET`  | `/v1/runs/:id/stream`  | **SSE**                                              |
| `POST` | `/v1/runs/:id/cancel`  | Cooperative; steps stop between units of work        |
| `POST` | `/v1/runs/:id/resume`  | Past the review gate                                 |

`GET /v1/runs/:id` returns all nine steps, padding the ones that have not
started, so a client can render the full pipeline from the first frame.

### Resume

```http
POST /v1/runs/:id/resume
{ "force": false }
```

Refuses with 400 while entities are pending, naming the count. `{"force": true}`
accepts the remainder and records an event — accepting unreviewed data is a
decision, and decisions are logged. The endpoint is idempotent and self-healing:
it enqueues before changing status, so an interrupted resume can be retried.

### Event stream

```
GET /v1/runs/:id/stream        text/event-stream
```

```
data: {"type":"snapshot","run":{…},"steps":[…]}
data: {"type":"step.updated","step":{…}}
data: {"type":"event","event":{…}}
data: {"type":"run.updated","run":{…}}
data: {"type":"heartbeat","at":"2026-06-01T12:00:00.000Z"}
```

A snapshot arrives first, which removes the race where a run finishes between
page load and subscription. Heartbeats every 15s keep intermediaries from
closing an idle connection during a long step.

---

## Entities and review

| Method | Path                                | Notes                                    |
| ------ | ----------------------------------- | ---------------------------------------- |
| `GET`  | `/v1/runs/:id/entities`             | Search, filter, sort, paginate           |
| `GET`  | `/v1/entities/:id`                  | Fields, evidence, review history, config |
| `POST` | `/v1/entities/:id/review`           | approve · reject · edit · reprocess      |
| `POST` | `/v1/runs/:id/entities/bulk-review` | Up to 1000 ids                           |

Query parameters: `q`, `status` (repeatable), `minScore`, `maxScore`, `signal`,
`flaggedOnly`, `sort`, `direction`, `limit`, `offset`.

```http
POST /v1/entities/ent_x/review
{ "action": "edit", "fieldKey": "employeeCount", "value": "about 240 people",
  "note": "corrected from the careers page" }
```

The value is coerced with the field's declared type; `"lots"` is rejected with
400 rather than stored. A successful edit sets the field to `edited` with
confidence 1 — freezing it against later machine writes — records the previous
value, and **re-scores the entity** so the number an operator sees is the number
the export will carry.

`reprocess` recomputes signals and score from current field values. It does
**not** re-fetch sources; re-extracting one entity would mean re-paying for its
sources. The UI labels it "Re-score" for that reason.

---

## Exports

| Method | Path                       | Notes                                   |
| ------ | -------------------------- | --------------------------------------- |
| `GET`  | `/v1/runs/:id/exports`     | Export records for a run                |
| `POST` | `/v1/runs/:id/export`      | Ad-hoc export of the current result set |
| `GET`  | `/v1/exports/:id/download` | Streams the file                        |

```http
POST /v1/runs/:id/export
{ "connector": "csv", "entityIds": ["ent_a", "ent_b"], "options": { "filename": "shortlist.csv" } }
```

Distinct from the pipeline's own export step: this is what an operator uses
after filtering or selecting rows. Rejected entities are never included. The
download endpoint refuses any path outside `EXPORT_DIR`.
