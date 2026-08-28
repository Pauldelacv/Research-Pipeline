# Competitive intelligence

Monitors a competitor set for product launches, pricing changes, funding, hiring
surges, partnerships and technology moves, and turns them into a structured,
deduplicated intelligence feed.

|              |                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| Entity       | `competitor_event` — an _observed change_, not an organisation                                                       |
| Identity     | `competitor` + `eventType` + `observedAt`, lowercased                                                                |
| Fields       | 10 — competitor, change type, headline, summary, observed date, impact, price before/after, open roles, technologies |
| Signals      | `price_increase`, `recent`, `high_impact`, `aggressive_hiring`                                                       |
| Scoring      | Recency and impact weighted highest — a six-month-old launch is not news                                             |
| Review       | **Non-blocking** — flags are recorded, the feed keeps moving                                                         |
| Destinations | NDJSON feed, Slack digest filtered to high-impact items (disabled, dry-run)                                          |

## Points of interest

**This is the configurability proof.** The entity is not a company. Changing
`entity.type` and the identity fields is the entire adaptation — the engine, the
stores, the review queue, the scoring engine and the UI are untouched.

**Composite identity does real work.** The same funding announcement appears on
the company blog, a news site and an aggregator. Identity on
`competitor + eventType + observedAt` merges all three into one item carrying
three pieces of evidence, instead of three duplicate rows.

**Non-blocking review is a deliberate policy inversion.** Intelligence is
time-sensitive: an alert that waits for a reviewer has already lost most of its
value. Flags are still recorded and still visible in the explorer — the run just
does not stop.

**Recency is scored, not filtered.** `recent` (within 30 days) is worth 25
points rather than acting as a cut-off, so older items still appear, ranked
below the fresh ones.
