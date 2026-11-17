---
name: check
description: Run and manage Lure's scheduled check of recorded hypotheses — install the daily schedule on this Mac, run a check now, say when a change went live, show what is waiting and why, and explain a verdict. Use when the person says "check my hypotheses", "set up the schedule", "the change is live", "it went live on <date>", "what did the check find", "lure check", "remove the schedule", or a Lure skill reports that the check has not run.
license: MIT
---

# check — measure on schedule, without the person remembering

The check runs without a model: a daily job on the person's machine runs
`node ~/.lure/engine/check.mts run --all`. For each workspace in `~/.lure/workspaces.yaml` it
pulls Search Console, adds Google's ranking updates to `events.md`, and moves each active
hypothesis on. Each hypothesis is in one of four states:

- it waits, with the reason written in its header (`waiting`);
- it is marked live, when the check saw the `live_marker` on the page or the person gave the date;
- it is marked re-crawled, when Google crawled the page after the change, which fixes the
  measurement windows;
- it is measured: a verdict is written once the after-window has final data.

Your part is everything that needs the person. Talk to them in their language.

The scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts/`. In this file they are called `check`
(`node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mts"`) and `schedule`
(`node "${CLAUDE_PLUGIN_ROOT}/scripts/schedule.mts"`). They do every number. Never edit a
hypothesis header yourself.

## 1. Where things stand

Run `check status --workspace <dir>` and tell the person, in plain words:

- **Each active hypothesis:** what it waits for. Turn the `waiting` reason into a sentence they
  can act on.
- **Warnings**, such as a rollback suspected or another canonical chosen by Google.
- **Overdue checks.**
- **"the check has not run since"**, if the status prints it. Then look at `schedule show`
  (§2): the job may be missing, stale or failing.
- **Uncommitted changes from the check**, in a git workspace (§7).

## 2. The schedule (macOS)

The schedule exists only on macOS for now. On Linux or Windows, say so and offer to run the
check by hand (§3) whenever the person opens a session.

1. Run `schedule show`.
   - If it is installed and not stale, say when it last ran and stop.
   - If it is stale (the engine is older than the plugin), offer to reinstall: step 3, after a
     yes.
2. Find node with `command -v node`. Use that path as it is, not its real path: a symlink such
   as `/opt/homebrew/bin/node` keeps working when node is upgraded. Then run
   `schedule plan --node <path>`.
3. Show the whole plan to the person: the job, the time (daily 10:00), what is copied into
   `~/.lure/engine/`, and the log path. If the plan warns that a workspace is under Documents,
   Desktop or Downloads, explain that macOS keeps background jobs out of those folders. Suggest
   moving the workspace. Do not suggest granting node Full Disk Access.
4. Only after a yes, run `schedule install --node <path>`.
   - It loads the job and makes one trial run.
   - If the trial run left no trace, read the log tail it prints. Say what failed and how to fix
     it.
5. `schedule remove` takes it all away: the job, the plist and the engine copy. Run it only
   when asked.

## 3. Run it now

`check run --workspace <dir>` runs the same steps for one workspace, then you report:

- what changed;
- what waits, and why;
- any errors. An expired Search Console sign-in means `/lure:search-console` again.

The run does not commit; see §7.

## 4. "It went live on <date>"

When the person says when a change went live, or the check waits because the page does not
open for Lure, ask which hypothesis and which date. Then run:

`check live --workspace <dir> --id <id> --date YYYY-MM-DD`

Use the day the change reached the public site, not the day it was approved. The date can be
corrected until Google re-crawls the page; after that the measurement windows are fixed.

## 5. A verdict

When a hypothesis is `measured`, explain its verdict by [reading a verdict](references/verdict.md):

- the label;
- the effect with its interval and how often such a shift happened before;
- the sample size;
- the smallest effect the page could show;
- each control on its own;
- updates and events in the windows.

Never say "it worked" without the interval. "No signal" is a result, not a failure. A lesson
from it belongs to the playbook, which needs two consistent results.

`check measure --workspace <dir> --id <id>` recomputes a verdict from the data and writes
nothing. Use it when the person doubts a verdict.

## 6. Outages

A line in `events.md` that ends with `(outage)` is left out of the noise estimate: the
interval is then not widened by days when the site was broken.

When `events.md` has a stretch where the site was down or blocked crawlers, offer to mark that
line. Mark it only after a yes.

## 7. Committing what the check changed

Neither the scheduled run nor `check run` ever commits. In a workspace that is a git
repository, whenever you open this skill — for status too — find the files the check changed
and have not been committed yet. These are the hypothesis files named in the journal's `check:`
lines, plus `events.md` and `journal.md`, and only the ones `git status --porcelain` shows as
changed.

Show the person the diff. After their yes, commit exactly those files by
[the workspace's Git rule](../init/references/workspace-format.md#git). Name each file on the
command line, never a folder: a folder would carry along the person's own edits to other
hypotheses. Never commit `.lure/`.
