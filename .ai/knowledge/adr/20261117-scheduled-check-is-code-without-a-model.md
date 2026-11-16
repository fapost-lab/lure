---
id: adr-20261117-scheduled-check-is-code-without-a-model
type: adr
status: accepted
date: 2026-11-17
domains: []
paths:
  - plugins/lure/scripts/check.mts
  - plugins/lure/scripts/schedule.mts
  - "plugins/lure/skills/check/**"
summary: A daily launchd job runs check.mts from ~/.lure/engine without a model; the skill installs it, takes live dates and explains verdicts
---
# The scheduled check is a Node script without a model; the agent handles what needs the person

## Context

adr-20261115-local-first and the spec expected scheduled runs to start the agent runtime
headless, or to use the desktop app's scheduled tasks. Research for task `scheduled-check`
(2026-11-17) showed three things:

- `claude -p` denies every permission unless the tools are listed one by one, and each run
  costs tokens and needs a live sign-in.
- Desktop scheduled tasks run only while the app is open, catch up one missed run per seven
  days, and stall on a permission prompt.
- The verdict is arithmetic. A model adds nothing to it, and an agent's mistake in it would be
  silent.

The plugin's own scripts sit in a cache path that contains the plugin version, so a reinstall
breaks any schedule that points there. Design approved by the author on 2026-11-17.

## Decision

- A per-user launchd job (`in.fapost.lure.check`, daily at 10:00, `RunAtLoad`) runs
  `node ~/.lure/engine/check.mts run --all`. No model and no agent runtime is involved.
- The check visits every workspace in the registry. It pulls Search Console, adds Google's
  ranking updates to `events.md`, and moves each active hypothesis on: it waits with a written
  reason, marks the change live or re-crawled, or measures it.
  - State lives in the workspace's files, so every run handles whatever is due by today. A
    missed run is simply caught up by the next one.
- `/lure:check` handles everything that needs the person:
  - installing the job after showing the whole plan, then a trial run that must leave a trace;
  - the live date, when the page does not open for Lure;
  - status, and explaining verdicts;
  - committing the run's changes after a yes. The unattended run never commits.
- `schedule install` copies the engine's scripts to `~/.lure/engine/` with a version and file
  hashes, and only through the skill. A copy older than the plugin is reported as stale.
- Outside a workspace the schedule writes only:
  - the engine copy;
  - run logs in `~/.lure/logs/`, which hold each workspace's path, whether the run went well,
    and an error count — the details, which name pages, stay in the workspace's
    `.lure/check-last.json`;
  - the one LaunchAgent plist `~/Library/LaunchAgents/in.fapost.lure.check.plist`.
- Lure fetches the page as `Lure-check/<version>`. A site that challenges non-browsers stays
  closed to it, and the person gives the date instead.
- Only macOS is supported for now. Linux (a systemd user timer with `Persistent=true`) and
  Windows (schtasks `/xml` with `StartWhenAvailable`) belong to the installer of the public
  release. The check itself runs on all three, and CI checks it there.

## What this replaces

- adr-20261115-local-first named "the desktop app's scheduled tasks or cron with a headless
  agent run" for scheduled runs. This replaces that clause: scheduled runs are this launchd job.
- adr-20261115-agent-runtime-calls-the-model said "Scheduled runs start the runtime headless".
  This replaces that sentence for the check: the scheduled job calls no model and starts no
  runtime. The rest of that ADR stands.

Both old ADRs carry a note pointing here.

## Alternatives

- **The agent runtime headless (`claude -p "/lure:check"`).** Rejected: a permission list to
  maintain, tokens on every run, a sign-in that can lapse, a silent mistake in the verdict, and
  no Codex.
- **Desktop scheduled tasks.** Rejected: the app has to be open, and a run waits on permission
  prompts.
- **A cloud routine.** Rejected by adr-20261115-local-first.
- **Pointing the job at the plugin cache.** Rejected: the path contains the version.
- **A browser User-Agent to get past challenges.** Rejected: that would mean defeating the
  site's own protection.

## Consequences

- Scheduled checks cost nothing and are tested in CI. Explaining a verdict waits until the
  person opens a session, or until a notification comes (telegram-notice).
- The engine copy must be refreshed after a plugin update. The skills that work with
  hypotheses (`check`, `hypothesis`, `search-console`) say so when it is stale (`schedule show`).
- macOS keeps background jobs out of Documents, Desktop and Downloads. Workspaces there must
  move, and the plan warns about it.
- A Mac that is off or logged out runs nothing; the next login catches up (`RunAtLoad`). The same
  skills say when the check has not run for eight days (`check status`).
