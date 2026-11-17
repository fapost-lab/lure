# Workspace format, version 1

The workspace is a public contract: later skills, other people's workspaces and, later, Lure's
CLI read it. Removing, renaming or changing the meaning of anything here raises `lure:` in
`lure.yaml` and comes with a migration. Adding an optional key or file does not: a reader that
does not know it leaves it alone, and a workspace without it means the feature is not set up.

## Files

```
<workspace>/
  lure.yaml     # settings Lure reads: format version, product, site, channels, tools
  profile.md    # the product profile, for people and agents
  journal.md    # what Lure changed and when
  events.md     # optional: dated outside events that affect search traffic
  search-console/   # optional: daily history pulled from Search Console
    site-daily.csv
    pages-daily.csv
  hypotheses/       # optional: one file per hypothesis
    <YYYY-MM-DD>-<slug>.md
  playbook/         # optional: one file per lesson
    <YYYY-MM-DD>-<slug>.md
  .lure/        # this machine's local state; never committed
```

Later steps add their own files here. A file this version does not name is left alone.

## lure.yaml

```yaml
lure: 1
product: <short lowercase name>
site: <https URL of the website>
language: <the person's language, e.g. ru, en>
channels:
  site:
    mode: <pr | draft>
tools:
  - id: <id from the vetted list, or "link">
    runtime: <claude-code | codex>
    source: <owner/repo>
    ref: <tag>
    sha: <full commit of the tag>
    installed: <YYYY-MM-DD>
metrics:                      # optional; absent until a source is connected
  search_console:
    property: <sc-domain:example.com | https://example.com/>
```

- `lure` is the format version. A reader that does not know the version stops and says so.
- `channels.site.mode`: `pr` when the site is in git, `draft` when it is in a CMS.
- `tools` lists only what Lure installed; it is empty (`tools: []`) when nothing was.
- `metrics.search_console.property` is the Search Console property exactly as Google names it.
  Which account reads it is personal and local: `.lure/search-console.yaml`.

## profile.md

Sections, in this order: What it is, Who it is for, Voice, Competitors, Never promise, Target
pages. A line ending in `(guess — confirm)` is the agent's inference the person has not
confirmed; nothing downstream may rely on it as fact.

## journal.md

One line per action, newest last:

```
- YYYY-MM-DD — <what was done> — <files> — <how to undo>
```

Without git this is the only record of what Lure changed. Lure appends; it never rewrites
earlier lines.

## events.md

Outside events that move search traffic and are not Lure's own changes: outages, blocked
crawlers, migrations, sitemaps sent, removals, Google updates. One line each, oldest first:

```
- YYYY-MM-DD — <what happened> — <source>
- YYYY-MM-DD … YYYY-MM-DD — <what happened over a span> — <source>
```

Measurement reads it to mark what else happened in a hypothesis's window. The scheduled check
adds Google's ranking updates itself, from the Search Status Dashboard, ending in
`status.search.google.com, incident <id>`; a rollout still under way reads `<date> … open` until
it ends. A line that ends with `(outage)` — the site down, crawlers blocked — is left out of the
check's noise estimate.

## search-console/

Pulled by `/lure:search-console`; final data only, web search, dates in Google's Pacific time.

- `site-daily.csv` — `date,clicks,impressions,ctr,position`: the property's totals per day,
  anonymised queries included.
- `pages-daily.csv` — `date,page,clicks,impressions,ctr,position`: one row per page per day.

Rows are sorted by date (then page). A pull appends whole days after the last one in each file
and never rewrites earlier rows. A day with no impressions has no row.

## hypotheses/

One Markdown file per hypothesis, named by its id `<date recorded>-<slug>`. The header between
`---` lines is written only by Lure's `metrics.mts`, in block style, and carries its own format
version, `lure_hypothesis: 1`:

- `id`, `status` (`planned` → `live` → `measured`, or `abandoned`), `page`, `change`,
  `recorded`, `planned_live`, `check_on` (provisional: `planned_live` + 28 + 3 days);
- `metric` and `expected`, optional `secondary` and `secondary_expected` — metrics `clicks`,
  `impressions`, `position`; directions `up`, `down` (`position` down is better);
- `window_days`, `floor` (`measurable`, `weak`, `below`) and `floor_reason`;
- `live_marker` — text that is on the page only once the change is live;
- `before` — `title`, `h1`, `description` of the page before the change;
- `baseline` — `from`, `to`, and for `page` and `site`: `days`, `clicks`, `impressions`, `ctr`,
  `position` (position weighted by impressions);
- `controls` — a list, each with `page` and the same figures over the baseline window; a control
  taken away by a later hypothesis gains `released` and `released_because`;
- `events` — lines of `events.md` inside the baseline window;
- when abandoned: `abandoned` and `abandon_reason`.

Written later by the scheduled check (`check.mts`, through `metrics.mts`), all optional:

- `live_on` and `live_source` (`marker` — the check saw `live_marker` on the page — or
  `person`); `live_absent_on`, the last day the check saw the page without the marker;
- `crawled_on` — the day Google re-crawled the page after `live_on` (URL Inspection);
- `before_window` and `after_window` (`from`, `to`), fixed at `crawled_on`; `check_on` is then
  replaced by the after-window's end plus 3 days;
- `waiting` — why the check cannot go on yet; `warnings` — a list that stays until the verdict;
- `verdict` — `label` (`noticeable_gain`, `no_signal`, `worse`, `insufficient_history`),
  `metric`, `expected`, `effect`, `low`, `high`, `p`, `past`, `placebos`, `effective_windows`,
  `mde`, `unreliable`, the windows, sums for `page` and `controls`, `per_control`, `position`,
  `clicks`, `updates`, `events`, `measured_on`. How to read it: the check skill's `verdict.md`.

Below the header, the person's prose: why it should help, what exactly changes, how to undo it,
what is at risk.

Rules: one active (`planned` or `live`) hypothesis per page; a page that is the page of an
active hypothesis is never a control; a page may be a control of several hypotheses.

## playbook/

One Markdown file per lesson, named by its id `<date created>-<slug>`. A workspace without the
folder has no lessons yet. The header between `---` lines is written only by Lure's
`playbook.mts`, in the same block style as a hypothesis, and carries its own format version,
`lure_lesson: 1`:

- `id`, `status` (`active` or `retracted`), `statement` (the lesson in one sentence),
  `change_kind`;
- `direction` — `gain` (its evidence is `noticeable_gain`) or `loss` (`worse`); `metric` — the
  primary metric of every hypothesis behind it;
- `site` — the product's site, from `lure.yaml`; a lesson never moves to another workspace;
- `created`;
- `evidence` — the verdicts that support it, at least two at creation, from measured hypotheses
  on different pages, none unreliable. Each has `hypothesis`, `page`, `label`, `effect`, `low`,
  `high`, `sample` (the page's impressions over both windows) and `measured_on`. A hypothesis is
  evidence of one lesson at most;
- `tests` — ids of hypotheses linked to test the lesson while still `planned` or `live`; the
  hypothesis itself does not know;
- `not_confirmed` — tests that measured `no_signal`, `insufficient_history` or an unreliable
  verdict, as entries like `evidence`;
- `in_doubt` — `true` while `not_confirmed` has at least as many entries as `evidence`;
- `retracted` and `retract_reason` — `null` while active. A test with the opposite significant
  label retracts the lesson on its own, with the hypothesis and its numbers in the reason; the
  person may retract it too.

Below the header, the agent's and the person's prose: what was done, why it is thought general,
where it ends.

## .lure/

Local state of this machine. It is never committed and never copied with the workspace.
`.lure/search-console.yaml` holds `account: <e-mail>`, the Google account that reads the
property. The scheduled check keeps `.lure/check-last.json` (its last run: changes, waiting
reasons, errors — what a notification reads), `.lure/check.log` (one line per run) and
`.lure/check.lock` while it runs. In `check-last.json`, each hypothesis also carries `page`, the
dates it has (`planned_live`, `live_on`, `crawled_on`, `after_window`, `check_on`), and, while
planned, `needs_date` — the page does not open for Lure, so only the person can tell the live
date — and `overdue`.

`.lure/notice.json` is what the notification (`notify.mts`) has told the person about this
workspace. Only `notify.mts` writes it:

```json
{
  "last_sent": "YYYY-MM-DD",
  "last_digest": "YYYY-MM-DD",
  "said": ["signin", "errors", "access", "failed", "overdue:<hypothesis id>"],
  "questions": [
    { "q": "qX7k2Pa", "hypothesis": "<id>", "page": "/path/", "asked_on": "YYYY-MM-DD",
      "n": 1, "message_ids": [123, 130], "reply_id": 131 }
  ]
}
```

- `last_sent`: the last day something was told, by Telegram or by the macOS notification.
  The Monday digest goes out only after a week without one.
- `last_digest`: the last day a digest was sent.
- `said`: the keys of what needs the person and was already told. A key leaves when its
  condition clears, so it is told again if it comes back.
- `questions`: the open live-date questions.
  - `q` is a random id used in the bot's buttons.
  - `hypothesis` is the hypothesis id; `page` is its path, without the domain.
  - `asked_on` is the day the latest buttons were made: their "today" and "yesterday".
  - `n` is the question's number when one message asks several.
  - `message_ids` lists the messages whose buttons ask it, at most the last 10. A button counts
    only from one of these messages.
  - `reply_id` is the bot's request for another date. Only a reply to it is read as a date.
- No key holds anything the person wrote in the chat.

Deleting the file makes the next message tell everything again and ask the open questions
anew. The buttons of earlier messages stop working, since their messages are no longer listed.
The person answers the new ones.

Secrets are never in the workspace at all, `.lure/` included: credentials live under
`~/.lure/<service>/`, readable by the owner only.

## The registry

`~/.lure/workspaces.yaml` lists every workspace on this machine, so scheduled steps can find
them:

```yaml
workspaces:
  - product: <name>
    path: <absolute path>
```

Adding a workspace appends an entry; a path already listed is not added twice.

## Git

Lure never runs `git init`, and never pushes. When the workspace already is a git repository:

1. Look first: `git status --porcelain`. Something already staged belongs to the person — leave
   it alone and keep it out of Lure's commit (the pathspec below does that).
2. `.lure/` missing from `.gitignore`: if `.gitignore` has no uncommitted changes, append
   `.lure/` and include `.gitignore` in the commit. If it has the person's own uncommitted edits,
   do not touch it; tell them to add `.lure/` themselves, and commit without it.
3. Commit only the files Lure wrote, named on the command line, so nothing else staged comes
   along:

   ```
   git add -- <file> <file>
   git commit -m "lure: <what was done>" -- <file> <file>
   ```

Never `git add .`, `-A` or `-a`.
