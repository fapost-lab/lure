---
id: adr-20261117-verdict-by-placebo-windows
type: adr
status: accepted
date: 2026-11-17
domains: []
paths:
  - plugins/lure/scripts/measure.mts
  - plugins/lure/skills/check/references/verdict.md
summary: "Verdict: page vs controls ratio of ratios, 90% interval from placebo windows in the page's history, measured only after live and re-crawl"
---
# A verdict compares the page with its controls and takes its uncertainty from the page's own history

## Context

The first products have pages with tens of impressions a day and almost no clicks. A
before/after comparison would credit the change for seasons and Google updates. A bootstrap
over four weeks gives intervals that are too narrow (Bertrand, Duflo and Mullainathan, 2004).
The verdict is the core of the loop, and a wrong verdict is silent. Task `scheduled-check`,
design approved 2026-11-17.

## Decision

- **The measurement waits** until the change is live (`live_on`), Google has re-crawled the
  page after it (URL Inspection `lastCrawlTime`, `crawled_on`), and final data covers the
  after-window.
- **The windows.** Before: 28 days ending the day before `live_on`. After: 28 days starting 7
  days after the later of `live_on` and `crawled_on`. Both are fixed at `crawled_on`.
- **The estimate.** Δ = ln(P_after/C_after) − ln(P_before/C_before), on the primary metric
  summed over each window, for the page (P) and its unreleased controls together (C). The
  effect is e^Δ − 1.
- **The uncertainty.** Placebo windows: the same pair slid back through the history before
  `live_on` in steps of 7 days, leaving out pairs that touch an `(outage)` line of
  `events.md`.
  - The 90% interval is Δ ± the 90th percentile of |Δ_i|.
  - The verdict also reports how many earlier periods moved as much, and the smallest effect
    the page can show.
- **The label.**
  - `noticeable_gain` or `worse` when the whole interval lies on one side of zero;
  - `no_signal` otherwise;
  - `insufficient_history` with fewer than 182 days of history or fewer than 5 placebo windows.
- **Alongside the label:** each control against the others, position for description only,
  clicks only at 30 or more in each window, and the updates and events that overlap either
  window.
- **Code.** `plugins/lure/scripts/measure.mts` does the arithmetic and holds the constants.
  `metrics.mts` writes the verdict and refuses one without a label, effect, interval and sample
  size.

## Alternatives

- **A block bootstrap over weeks.** Rejected: four blocks, intervals too narrow.
- **A 4-against-4-week permutation.** Rejected: it assumes no trend.
- **CausalImpact or synthetic control.** Rejected: they need more controls and a modelling
  library.
- **Before/after without controls.** Rejected: it credits seasons and updates to the change.

## Consequences

- On small pages most verdicts will be `no_signal`. The smallest detectable effect says up
  front how large a change must be to show.
- The constants (7 days to settle, 90%, 182 days) are assumptions until verdicts accumulate.
  Changing them is a reviewed change to Lure, never a tweak after seeing a result.
- A verdict carries all its inputs; `check.mts measure` recomputes it without writing.
