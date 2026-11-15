---
id: adr-20261115-hypothesis-loop-is-the-core
type: adr
status: accepted
date: 2026-11-15
domains: []
paths: []
summary: Lure builds the hypothesis loop; audits and drafting are pluggable third-party tools
---
# The hypothesis loop is Lure's core; audits and drafting come from pluggable tools

## Context

Audits and AI drafting are well covered (the claude-seo plugin, OpenClaw marketing skills,
commercial SEO agents). None records a change as a hypothesis, measures it weeks later and
turns the result into a lesson. Spec `lure`, research.md.

## Decision

Lure builds the hypothesis log, the scheduled measurement, the verdict and the playbook.
Audit and drafting tools are third-party and pluggable. Lure does not depend on their output
format: the agent runs a tool and records its findings as candidate hypotheses in Lure's own
format. Tools are installed from a vetted list (source, author, stars, licence shown), at a
pinned version, after the person's yes, and are never updated by Lure on its own; a link given
by hand is installed the same way with a "not from the vetted list" warning.

## Alternatives

- An own auditor or crawler — rejected: others already do it well; Lure would chase them
  instead of building what nobody has.
- A strict contract tools must emit — rejected: no existing tool speaks it.

## Consequences

- Lure depends on the quality of others' tools, and a skill is code and instructions from
  someone else: installation is a supply-chain decision the person confirms.
- Generic audit checklists can flood the log; candidate hypotheses need triage before they
  become hypotheses.
