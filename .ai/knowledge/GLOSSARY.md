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
everything is not credited to the change.

Informal synonyms: control.
Use in: source code, documentation.

## Traffic floor

The statement, made when a hypothesis is recorded, of whether its page has enough traffic to
show any effect within the measurement window.

Informal synonyms: minimum traffic.
Use in: source code, documentation.

## Check

The scheduled step that confirms a hypothesis's change is live and re-crawled, measures it
against baseline and controls, and gives a verdict.

Informal synonyms: measurement, measure, review.
Use in: source code, documentation.

## Verdict

The result of a check: "noticeable gain", "no signal" or "worse", with confidence, sample size
and effect. Never a bare "worked".

Informal synonyms: result, outcome.
Use in: source code, documentation.

## Lesson

A rule in a product's playbook, admitted only after two consistent verdicts, carrying sample
size, date and site, and retracted when later verdicts contradict it.

Informal synonyms: insight, learning, conclusion.
Use in: source code, documentation.

## Playbook

A product's lessons; the next plan starts from it.

Informal synonyms: knowledge base, notes.
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
