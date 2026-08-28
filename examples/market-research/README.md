# Market research

Maps a market into a structured dataset of participants, their positioning,
pricing, segments and technology choices. The output is a dataset to pivot and
filter, not a text report.

|              |                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Entity       | `market_participant`, identified by web domain                                                                                 |
| Fields       | 10 — name, website, category, positioning, primary segment, entry price, headcount, funding stage, technology signals, summary |
| Signals      | `price_transparent`, `enterprise_focus`, `well_funded`                                                                         |
| Scoring      | **Graded** completeness plus four presence rules                                                                               |
| Review       | **Disabled**                                                                                                                   |
| Destinations | CSV market map, Notion database (disabled, dry-run)                                                                            |

## Points of interest

**Graded scoring.** The `completeness` rule interpolates linearly across a scale
rather than matching a boolean:

```ts
{ id: 'completeness', weight: 25, mode: 'graded',
  scale: { field: 'employeeCount', from: 0, to: 500, clamp: true } }
```

A participant at 250 employees scores 12.5 of 25. Use this shape whenever
"closer to the ideal" is more truthful than "matches or does not".

**Review is off, on purpose.** A market map's value is coverage. Holding 120
rows for per-field review would cost days and change few conclusions, so
`review.enabled: false` and the confidence threshold is lowered to 0.65.

This is the point of making review policy configuration rather than product
behaviour: the same framework enforces a hard gate for outbound lists and no
gate at all for exploratory research.

**Scoring measures record quality, not commercial fit.** Every rule rewards
knowing something — pricing is public, positioning identified, segment
identified. A high score means "this row is well understood", which is the right
question when you are mapping rather than selling.
