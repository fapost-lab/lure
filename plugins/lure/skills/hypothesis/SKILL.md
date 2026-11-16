---
name: hypothesis
description: Record a change to a website page as a hypothesis in a Lure workspace — the page, what changes and why, the state before, a 28-day baseline from Search Console, control pages, an honest traffic floor and the date of the check. Also abandons a recorded hypothesis. Use when the person says "record a hypothesis", "I'm going to change <page>", "let's test <idea>", "lure hypothesis", picks an audit finding to act on, or wants to drop a hypothesis.
license: MIT
---

# hypothesis — record a change before it is made

A **hypothesis** is one change to one page, written down before the change goes live, with
everything a check needs weeks later to say honestly whether it helped. Talk to the person in
their language and write the prose in it. Show the whole file before writing it.

The script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/metrics.mts" <command> --workspace <dir>`. It
does every number and writes the file's header; you never type a number into the file.

## 1. Fresh data

The workspace (the folder with `lure.yaml`) must have `metrics.search_console` set; if not,
offer `/lure:search-console`. Pull the days that became final since the last time, with the
account in `.lure/search-console.yaml`:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/search-console.mts" pull --account <e-mail> --property <property> --workspace <dir>`

If the workspace has active hypotheses, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mts" status
--workspace <dir>` too. On macOS also run `node "${CLAUDE_PLUGIN_ROOT}/scripts/schedule.mts" show`.
Tell the person and offer `/lure:check` in either case:

- the check has never run, or has not run for days: nothing measures their hypotheses until it
  does;
- the engine copy is stale: the schedule runs an older Lure.

## 2. What changes

The idea comes from the person, or from an audit report they point to. Ask what you do not
know yet: which page (the URL as Search Console shows it), what exactly changes, why it should
help, and when they expect it to be live.

A change to the whole site — speed work, a CDN or firewall setting, a theme, a migration — is not
a hypothesis: no control page escapes it. Offer to write it to `events.md` instead, so every
check sees it (format in [workspace format](../init/references/workspace-format.md#eventsmd)).

## 3. Is the page free

Run `busy`. If the page is the page of an active hypothesis, stop: name it, and offer to wait for
its check or to abandon it (§9). If the page is a control of an active hypothesis, say that
changing it takes that control away from the other hypothesis; go on only after a yes, and pass
that hypothesis's id in `release_controls_of`.

## 4. Metric and traffic floor

Run `window --page <url>` and decide by [measurement](references/measurement.md): which metric
is primary and which is secondary, with the expected direction of each, and whether the page can
show anything — `measurable`, `weak` or `below`. Tell the person plainly, with the numbers. On
`below`, say the check will most likely answer "no signal", and record only if they still want
to.

## 5. Control pages

Run `pages`. Propose two or three controls by the rules in
[measurement](references/measurement.md#control-pages), and say why each. The person confirms or
changes them.

## 6. Before and after

Open the page and note its title, H1 and meta description: that is `before`, the way back for
a site without history. If the page does not open for you (some sites refuse anything that is
not a browser), ask the person to copy the three from their browser.

Ask for `live_marker`: an exact piece of text that will be on the page only after the change —
usually the new title or H1. The check looks for it to know the change is live.

## 7. Events in the window

Read `events.md` and keep the lines whose date, or span of dates, overlaps the baseline window
(the `from` and `to` that `window` printed). Show them. If one affects the whole site, say the baseline carries
it.

## 8. Write it

Put your decisions in `<workspace>/.lure/hypothesis.json` (local, never committed; overwrite it
each time):

```json
{
  "slug": "short-kebab-name",
  "page": "https://example.com/page/",
  "change": "one line: what changes",
  "planned_live": "YYYY-MM-DD",
  "metric": "impressions", "expected": "up",
  "secondary": "position", "secondary_expected": "down",
  "floor": "measurable", "floor_reason": "the numbers that decided it",
  "live_marker": "text that appears once live",
  "before": { "title": "…", "h1": "…", "description": "…" },
  "controls": ["https://example.com/other/", "https://example.com/third/"],
  "events": ["lines from events.md inside the window"],
  "sections": [
    { "heading": "Why it should help", "text": "…" },
    { "heading": "What exactly changes", "text": "…" },
    { "heading": "How to undo", "text": "…" },
    { "heading": "What we risk", "text": "…" }
  ],
  "release_controls_of": []
}
```

Write the section headings in the person's language. Run `record --input <workspace>/.lure/hypothesis.json --dry-run` and
show the person the whole file it prints. After their yes, run it without `--dry-run`. The check
date it sets is provisional: the check moves it if the change goes live later or Google has not
re-crawled the page yet.

## 9. Abandon

When a change will not be made after all, run `abandon --id <id> --reason "<their words>"`. The
page is free again.

## 10. Journal and git

Append to `journal.md` one line for what was done, with its undo (delete the file, or set the
status back). Then git, by [the rule](../init/references/workspace-format.md#git): the files are
`hypotheses/<id>.md`, any hypothesis whose control was released, `events.md` if it changed, and
`journal.md`.

## 11. Report

Say what was recorded, the metric and floor, the controls, and the check date. Remind the person
that the change itself is theirs to make; the check will look for `live_marker` to see it live.
If the page does not open for Lure, or the person would rather give the date, they tell it
through `/lure:check` once the change is out. If no schedule is installed yet, offer
`/lure:check` to install one.
