---
id: adr-20261116-hypothesis-log-format
type: adr
status: accepted
date: 2026-11-16
domains: []
paths:
  - plugins/lure/scripts/metrics.mts
  - "plugins/lure/skills/hypothesis/**"
summary: One file per hypothesis, header written only by metrics.mts; one active hypothesis per page, shared controls, impressions primary below the click floor
---
# The hypothesis log: one file per hypothesis, its header written only by Lure's script

## Context

The hypothesis log is the core of Lure (adr-20261115-hypothesis-loop-is-the-core) and part of
the workspace contract. A check reads it weeks after it was written, so its numbers must be
exact and its header readable without a YAML library. The first real site (a company's) has
clicks only on its home page: per-page clicks cannot measure anything there. Task
`hypothesis-baseline`, design approved 2026-11-16.

## Decision

- One Markdown file per hypothesis, `hypotheses/<date recorded>-<slug>.md`: a block-style YAML
  header with its own format version (`lure_hypothesis: 1`), then the person's prose. The full
  field list is in `workspace-format.md`.
- Only `plugins/lure/scripts/metrics.mts` writes the header. The agent passes its decisions as
  JSON; the script computes every number (baseline over 28 days, impression-weighted position,
  controls, site totals, the provisional check date) and refuses what breaks the rules. The
  script's parser reads only what the script wrote.
- Statuses: `planned` → `live` → `measured`, or `abandoned`. `planned` and `live` are active.
- One active hypothesis per page. The page of an active hypothesis is never a control. A page
  may be a control of several hypotheses; turning a control into a target releases it from the
  other hypothesis only after the person's yes, and the release is written into that file.
- Below the click floor (50 clicks in the window) the primary metric is impressions, with
  average position secondary: average position follows the mix of queries, so a page that gains
  new distant queries looks worse while it grows. The floor tiers (`measurable`, `weak`,
  `below`) and their numbers live in the hypothesis skill's `measurement.md` and are
  assumptions until the first verdicts.
- `before` (title, H1, description) and `live_marker` (text present only after the change) are
  written when the hypothesis is recorded: the only moment anyone knows them.
- A change to the whole site is not a hypothesis; it goes to `events.md`.

## Alternatives

- One `hypotheses.md` for all — rejected: every check would edit one growing document.
- The agent writes the header from the script's output — rejected: hand-copied numbers and
  free-form YAML would bring back the silent errors the script exists to remove.
- Exclusive controls — rejected: a small site has four or five measurable pages; a second
  hypothesis would find no control.
- Average position as the primary metric on low-click pages — rejected for the query-mix reason
  above; position on a fixed query set is left to the check.

## Consequences

- A small site runs one or two hypotheses at a time.
- Changing the header's shape raises `lure_hypothesis`; adding an optional field does not
  (adr-20261116-optional-additions-keep-the-format-version).
- Controls of one template are linked by navigation; the check must show each control on its
  own, not only their average.
