---
id: adr-20261117-playbook-lessons-checked-by-script
type: adr
status: accepted
date: 2026-11-17
domains: []
paths:
  - plugins/lure/scripts/playbook.mts
  - "plugins/lure/skills/playbook/**"
summary: Lessons are files whose header only playbook.mts writes; the script enforces two consistent results, links before the verdict, and syncs outside the schedule
---
# A lesson is a file whose header only playbook.mts writes; the script holds the two-results rule

## Context

The spec says a lesson enters a product's playbook only after two consistent verdicts, with
sample size, date and site, and is retracted when later verdicts contradict it. An agent judging
"consistent" in prose would make the rule unenforceable, and a lesson picked to fit a result
that already came in would be worth nothing. Design approved by the author on 2026-11-17 (task
`playbook-lessons`).

## Decision

- One file per lesson, `playbook/<YYYY-MM-DD>-<slug>.md`, `lure_lesson: 1`. Its header is
  written only by `plugins/lure/scripts/playbook.mts`, as hypothesis headers are only by
  `metrics.mts`. The agent and the person decide that changes are "of one kind" and word the
  lesson; the script takes hypothesis ids, never numbers.
- `add` refuses unless there are at least two different measured hypotheses of this workspace,
  on different pages, with the same metric and the same significant label (both
  `noticeable_gain` → `gain`, both `worse` → `loss`), none `unreliable`, `no_signal` or
  `insufficient_history`. Sample is the page's impressions over both windows (counted from
  `pages-daily.csv` when the metric is not impressions).
- A result counts once: a hypothesis in any lesson's `evidence` or `not_confirmed`, or in an
  active lesson's `tests`, cannot be used again. A retracted lesson's untested `tests` are free.
- A hypothesis tests a lesson only through `link`, before it has a verdict (planned or live),
  with the lesson's metric and on a page not already in the lesson. The link lives in the
  lesson's `tests`; the hypothesis format does not change.
- `sync` walks each active lesson's `tests`: the same significant label moves the test to
  `evidence`; the opposite significant label retracts the lesson automatically, with the date
  and a reason naming the hypothesis and its numbers; `no_signal`, `insufficient_history` and an
  unreliable verdict of either sign go to `not_confirmed`, and `in_doubt` is set while
  `not_confirmed` ≥ `evidence` (the person retracts it then); an abandoned hypothesis leaves
  `tests`. A second `sync` changes nothing.
- Sync runs when the person opens `/lure:playbook` or `/lure:check`, never in the scheduled job:
  the engine copy does not contain `playbook.mts`, and no Measurement code imports it.
- A lesson records its `site`. The script never reads another workspace, and no skill offers to
  copy a lesson to another product.

## Alternatives

- **One `playbook.md` edited by agent and person.** Rejected: the two-results rule could not be
  checked.
- **Sync in the scheduled check.** Rejected: Measurement would then depend on Playbook, against
  the dependency direction in ARCHITECTURE.
- **The link stored in the hypothesis.** Rejected: it would change the hypothesis format, and
  Hypotheses would know about Playbook.
- **An unreliable opposite verdict retracts.** Rejected: a verdict too weak to admit a lesson is
  too weak to retract one; it counts as not confirmed.

## Consequences

- Skills upstream of Playbook (`/lure:hypothesis`, `/lure:check`) call `playbook.mts` as
  orchestration. The dependency direction binds code and formats, not the skills that lead the
  person through them.
- A lesson can be retracted with nobody watching only as fast as someone opens a skill; the
  retraction is shown in the same minute it is made.
- The first lesson on a real product needs two measured verdicts: months, not days.
