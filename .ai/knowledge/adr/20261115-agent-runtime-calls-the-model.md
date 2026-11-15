---
id: adr-20261115-agent-runtime-calls-the-model
type: adr
status: accepted
date: 2026-11-15
domains: []
paths: []
summary: Lure's code never calls a model; the agent runtime does the thinking
---
# Lure's own code never calls a model; the agent runtime does the thinking

## Context

Lure needs a model to plan, draft, read audits and judge results. Its users are product owners
without SEO or development experience who already use an agent runtime (Claude Code, Codex).
Spec `lure`, Decisions.

## Decision

Lure is skills plus, later, a CLI that an agent runtime runs. No code in this repository sends a
request to a model API, holds a model key or depends on a model SDK. Scheduled runs start the
runtime headless; the runtime calls the model.

## Alternatives

- An own API key in Lure — rejected: an extra key and an extra bill for non-developers, and
  keys to store safely on their machines.
- A hosted model behind a Lure service — rejected with the hosted service itself
  (adr-20261115-local-first).

## Consequences

- Without an agent runtime Lure does nothing; the installer and documentation must say so.
- The runtime's subscription pays for the thinking; Lure has no billing of its own.
- Steps must be written so a runtime can follow them reliably: skills stay short, mechanics go
  to the CLI as it appears.
