# Architecture

High-level map of the system. Describe engineering intent, not implementation:
what the domains are, where the boundaries lie, which direction dependencies may point,
and which constraints and invariants hold system-wide. Anything the code already says
does not belong here.

Lure helps one person promote a product — its website's search visibility and its channels —
with AI agents. Its core is a measured loop: every change is recorded as a hypothesis with a
baseline, checked on schedule against control pages, and turned into lessons in the product's
playbook. Audits and drafting come from third-party tools. Its users are product owners
without SEO or development experience; the author is the beta tester. Source: spec `lure`.

## Built

- **Workspace** — `/lure:init` creates a product's folder in format version 1, registers it in
  `~/.lure/workspaces.yaml`, and commits its own files when the folder already is a git
  repository (adr-20261115-workspace-format-and-registry).
- **Tools** — the vetted list (`plugins/lure/vetted-tools.md`) and pinned installation of
  third-party Claude Code plugins, checked against the pinned commit.
- **Search Console** — the first metrics adapter. `/lure:search-console` guides the person
  through their own OAuth client, and `plugins/lure/scripts/search-console.mts` signs in, lists
  properties and pulls daily history into the workspace's `search-console/` folder; earlier
  notes are reconciled with it and their outside events go to `events.md`
  (adr-20261116-search-console-oauth-and-local-secrets).
- **Hypotheses** (recording) — `/lure:hypothesis` writes one file per hypothesis with its
  baseline, controls, traffic floor and provisional check date; `plugins/lure/scripts/metrics.mts`
  does the arithmetic and writes the header (adr-20261116-hypothesis-log-format).
- **Measurement** (the check) — a daily launchd job runs `check.mts` from the engine copy in
  `~/.lure/engine/`, with no model. For each registered workspace it pulls Search Console,
  adds Google's ranking updates to `events.md`, marks a change live (marker on the page, or the
  person's date) and re-crawled (URL Inspection), and measures it once final data covers the
  after-window. `measure.mts` does the arithmetic; `metrics.mts` still writes every header.
  `/lure:check` installs the job, takes live dates and explains verdicts. macOS only for now
  (adr-20261117-scheduled-check-is-code-without-a-model, adr-20261117-verdict-by-placebo-windows).
- **Playbook** — `/lure:playbook` turns verdicts into lessons under the two-results rule and
  retracts them. `plugins/lure/scripts/playbook.mts` writes each lesson's header in
  `playbook/`, links hypotheses that test a lesson before their verdict, and syncs lessons when
  the person opens `/lure:playbook` or `/lure:check`, never in the scheduled job
  (adr-20261117-playbook-lessons-checked-by-script).
- Lure itself is a Claude Code plugin in this repository's marketplace
  (adr-20261115-distributed-as-a-claude-code-plugin). It is skills and Markdown, plus
  dependency-free Node scripts where a skill could not do without code — `search-console`,
  `metrics`, `check`, `measure`, `schedule`, `playbook`
  (adr-20261116-code-enters-before-the-cli).

## Intended — not built yet

The task that builds a part moves it out of this heading.

### Domains

- **Hypotheses** — the log: candidates, hypotheses, their pages, baselines, control pages,
  traffic floors and check dates. Knows nothing of where metrics come from.
- **Content** — interview, draft in the person's voice, fact check, approval.
- **Channels** — one adapter per platform, each with its publishing modes and platform cap.
- **Tools** — running third-party audit and drafting tools and turning their findings into
  candidates (installing them is built).

The first phase builds these as skills over Markdown files, with no CLI
(adr-20261115-typescript-on-node); the domains are the same either way.

### Boundaries and dependency direction

- Domains depend on ports, never on adapters. Adapters at the edges: metrics sources (Search
  Console first), site changes (pull request, CMS instructions), notifications (Telegram first),
  the scheduler, channel platforms.
- Measurement reads Hypotheses; Playbook reads Measurement's verdicts; Content reads Hypotheses
  and Playbook as material; Channels publish what Content produced. Nothing points back up the
  chain. The direction binds code and formats; a skill may lead the person through a downstream
  step (`/lure:check` syncs the playbook) without the code below it knowing.
- The engine never reads or writes product data outside a workspace
  (adr-20261115-engine-apart-from-workspaces); its only writes outside are to `~/.lure/`: the
  registry of workspace names and paths (adr-20261115-workspace-format-and-registry),
  credentials (adr-20261116-search-console-oauth-and-local-secrets), and the engine copy with
  its run logs (adr-20261117-scheduled-check-is-code-without-a-model) — plus, on macOS, the one
  LaunchAgent plist of the schedule. It never calls a model
  (adr-20261115-agent-runtime-calls-the-model).

### Runtime flows

1. **The loop.** A tool or the person yields candidates → the person decides → a hypothesis is
   recorded with baseline, controls, traffic floor and check date → the change is made (a pull
   request, or instructions for a CMS) → on schedule the check confirms the change is live and
   re-crawled, measures, gives a verdict → the person is notified → after two consistent
   verdicts a lesson enters the playbook.
2. **Content.** Material from the log and playbook → an interview with the person → a draft in
   their voice → fact check → the person approves → each channel publishes within its mode and
   cap.
3. **Init** (built). A workspace is created → the profile is drafted from
   the website's address for the person to correct → tools are offered from the vetted list and
   installed after a yes → the workspace is committed if it is a git repository → metrics
   sources are connected — Search Console, by `/lure:search-console`.

## System-wide constraints and invariants

- Lure runs on the person's machine; no hosted service (adr-20261115-local-first).
- Nothing goes public beyond its channel's publishing mode and platform cap; no automated
  engagement (adr-20261115-person-approves-what-goes-public).
- The hypothesis loop is the core; tools are pluggable and never depended on for format
  (adr-20261115-hypothesis-loop-is-the-core).
