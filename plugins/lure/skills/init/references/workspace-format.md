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
  .lure/        # this machine's local state; never committed
```

Later steps add their own files here (the hypothesis log, the playbook). A file this version
does not name is left alone.

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

Measurement reads it to mark what else happened in a hypothesis's window.

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

Below the header, the person's prose: why it should help, what exactly changes, how to undo it,
what is at risk.

Rules: one active (`planned` or `live`) hypothesis per page; a page that is the page of an
active hypothesis is never a control; a page may be a control of several hypotheses.

## .lure/

Local state of this machine. It is never committed and never copied with the workspace.
`.lure/search-console.yaml` holds `account: <e-mail>`, the Google account that reads the
property. Secrets are never in the workspace at all, `.lure/` included: credentials live under
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
