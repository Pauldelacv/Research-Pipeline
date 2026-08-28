# Lead generation

Finds companies matching a firmographic and technographic profile, scores them
against configurable commercial criteria, and exports the qualified set.

**The brief this answers:** _find French B2B SaaS companies with 20–500
employees that recently raised, use HubSpot, and are hiring._

|              |                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Entity       | `company`, identified by web domain                                                                                             |
| Fields       | 12 — name, website, LinkedIn, industry, headcount, HQ, funding stage and date, technologies, open roles, contact name and title |
| Signals      | `recent_funding`, `uses_hubspot`, `hiring`, `size_match`, `enterprise_scale` (negative)                                         |
| Scoring      | 6 positive rules totalling 100 points, plus a **−15 penalty** for companies outside the target motion                           |
| Review       | **Blocking** — nothing reaches a CRM without a human decision                                                                   |
| Destinations | CSV (filtered to score ≥ 70), JSON with full provenance, HubSpot (disabled, dry-run)                                            |

## Points of interest

**The penalty rule.** `too-large` subtracts 15 points rather than filtering the
row out. The company stays visible and explains itself in the score breakdown —
an operator can see that it was found, considered, and marked down, which is
more useful than silence.

**The export filter reads `score`.** `score` is a computed column, not an
extracted field; the condition language exposes it as a reserved name, so
`{ field: 'score', op: 'gte', value: 70 }` works in a destination filter.

**Blocking review is the right default here.** These records feed outbound
sequences and a CRM. The cost of a wrong headcount is a wasted email and a
damaged sender reputation, so the run parks until someone looks.

**The HubSpot destination ships disabled and dry-run.** Enabling it writes the
exact batch-upsert bodies to disk so you can check them before setting
`HUBSPOT_ACCESS_TOKEN`.
