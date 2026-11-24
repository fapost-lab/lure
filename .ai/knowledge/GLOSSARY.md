# Glossary

Canonical ubiquitous language for this project. One entry per term. Use the canonical
term in source code, database schema, APIs, documentation and commit messages.

## Engine

Lure itself — this repository's skills, CLI, templates and vetted list — as opposed to any
product's data.

Informal synonyms: Lure, the framework.
Use in: source code, documentation.

## Workspace

The folder holding one product's profile, channels, hypothesis log, measurements, playbook and
drafts; it lives outside the engine and may or may not be a git repository.

Informal synonyms: project, product folder.
Use in: source code, documentation.

## Registry

The per-machine list of workspaces, `~/.lure/workspaces.yaml`: product name and path, nothing
else. Scheduled steps find workspaces through it.

Informal synonyms: workspace list, index.
Use in: source code, documentation.

## Journal

A workspace's append-only `journal.md`: one line per action Lure took, with how to undo it.

Informal synonyms: log, history, changelog.
Use in: source code, documentation.

## Property

A site as Search Console knows it, named exactly as Google names it: a Domain property
(`sc-domain:example.com`) or a URL-prefix property (`https://example.com/`). One site may have
both, with different histories; a workspace reads one.

Informal synonyms: site, GSC account, resource.
Use in: source code, documentation.

## Outside event

Something that moved a site's search traffic and is not one of Lure's own changes — an outage,
a blocked crawler, a migration, a sitemap sent, a Google update. Kept in a workspace's
`events.md` with its date and source, so a check can mark it in a hypothesis's window.

Informal synonyms: incident, external factor.
Use in: source code, documentation.

## Credentials

What lets Lure read a service as the person — an OAuth client, tokens, API keys. They live under
`~/.lure/<service>/`, readable by the owner only, never in a workspace and never read by an agent.

Informal synonyms: secrets, keys, tokens.
Use in: source code, documentation.

## Product profile

What Lure knows about a product: what it is, its audience, voice, competitors and the claims it
must never make.

Informal synonyms: profile, brief.
Use in: source code, documentation.

## Hypothesis

One recorded change to one page or channel, with why it should help, its baseline, its control
pages and its check date. Not a finding: a finding becomes a hypothesis only when someone decides
to make the change.

Informal synonyms: experiment, test, change.
Use in: source code, documentation.

## Candidate

A finding from an audit or the person, not yet decided on; it becomes a hypothesis or is dropped.

Informal synonyms: finding, suggestion, issue.
Use in: source code, documentation.

## Baseline

The metrics of a hypothesis's page over a fixed window before the change, against which the
check compares.

Informal synonyms: before, starting point.
Use in: source code, documentation.

## Control page

A page left untouched during a hypothesis, measured over the same window, so that what moved
everything is not credited to the change. A page may be a control of several hypotheses, but never while it is the
page of an active one.

Informal synonyms: control.
Use in: source code, documentation.

## Traffic floor

The statement, made when a hypothesis is recorded, of whether its page has enough traffic to
show any effect within the measurement window. One of `measurable`, `weak`, `below`.

Informal synonyms: minimum traffic.
Use in: source code, documentation.

## Check

The scheduled step that confirms a hypothesis's change is live and re-crawled, measures it
against baseline and controls, and gives a verdict. It runs daily as `check.mts`, with no
model (adr-20261117-scheduled-check-is-code-without-a-model). One run of it is a *check run*.

Informal synonyms: review. ("Measurement" is the domain the check belongs to; "measure" is the
step that computes a verdict, `measure.mts`.)
Use in: source code, documentation.

## Verdict

The result of a check: "noticeable gain", "no signal" or "worse" (or "insufficient history"),
with confidence, sample size and effect. Never a bare "worked". In code the labels are
`noticeable_gain`, `no_signal`, `worse` and `insufficient_history`
(adr-20261117-verdict-by-placebo-windows).

Informal synonyms: result, outcome.
Use in: source code, documentation.

## Placebo window

An earlier pair of before and after windows from the page's own history, with no change in it.
The spread of the page-against-controls shift across placebo windows is the check's measure of
noise: it gives the verdict's interval and the smallest effect the page can show.

Informal synonyms: past period, null window.
Use in: source code, documentation.

## Live date

`live_on`: the day a hypothesis's change reached the public site. The check sees it as the
`live_marker` appearing on the page, or the person says it. A date the person says cannot be
on or before `live_absent_on`, a day the check saw the page without the marker. It can change
until Google re-crawls the page (`crawled_on`); after that the measurement windows are fixed.

Informal synonyms: deploy date, release date, go-live.
Use in: source code, documentation.

## Notice

A message Lure sends the person after a scheduled run — news, what needs them, a date question
or the Monday digest — through their Telegram bot, or a macOS notification without one. What
was already said is kept in the workspace's `.lure/notice.json`.

Informal synonyms: alert, notification, ping.
Use in: source code, documentation.

## Owner

The one Telegram user, in one private chat, paired with the person's Lure bot by a one-time
code. The bot accepts answers from nobody else.

Informal synonyms: bot user, subscriber.
Use in: source code, documentation.

## Engine copy

`~/.lure/engine/`: the scripts the scheduled job runs, copied from the plugin with their version
and hashes so the schedule survives a plugin reinstall. It is stale when it is older than the
plugin.

Informal synonyms: installed engine.
Use in: source code, documentation.

## Lesson

A rule in a product's playbook, admitted only after two consistent verdicts, carrying sample
size, date and site, and retracted when later verdicts contradict it.

Informal synonyms: insight, learning, conclusion.
Use in: source code, documentation.

## Playbook

A product's lessons, one file each in its workspace's `playbook/` folder; the next plan starts
from it.

Informal synonyms: knowledge base, notes.
Use in: source code, documentation.

## In doubt

A lesson whose linked tests came back not confirmed (no signal, insufficient history or an
unreliable verdict) at least as often as it has evidence. It stays active until the person
retracts it.

Informal synonyms: weak lesson.
Use in: source code, documentation.

## Retracted

A lesson withdrawn, automatically by a linked test with the opposite significant label, or by
the person. It stays in the playbook as history and is never used again.

Informal synonyms: deleted, rejected.
Use in: source code, documentation.

## Channel

A place a product reaches people — its website, a Telegram channel, a LinkedIn profile —
configured per product with an adapter and a publishing mode.

Informal synonyms: platform, network, outlet.
Use in: source code, documentation.

## Publishing mode

How far Lure goes on a channel: `auto` (official API), `pr` (a proposed change to a site in
git), `draft` (prepared for the person) or `manual` (found and left for the person).

Informal synonyms: mode, autonomy.
Use in: source code, configuration, documentation.

## Platform cap

The highest publishing mode a platform's own rules allow; no configuration exceeds it.

Informal synonyms: limit, ceiling.
Use in: source code, documentation.

## Tool

A third-party audit or drafting skill or plugin that Lure installs and runs through the agent
runtime; installed from the vetted list or by link.

Informal synonyms: plugin, skill, integration.
Use in: source code, documentation.

## Vetted list

The engine's list of tools it offers to install, each with source, author, licence and a pinned
version.

Informal synonyms: catalogue, recommended tools.
Use in: source code, documentation.

## Interview

The agent's short set of questions to the person, whose answers are the material a draft is
written from.

Informal synonyms: questions, brief.
Use in: source code, documentation.
