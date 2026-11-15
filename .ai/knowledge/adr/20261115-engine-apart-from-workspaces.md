---
id: adr-20261115-engine-apart-from-workspaces
type: adr
status: accepted
date: 2026-11-15
domains: []
paths: []
summary: The engine holds no product data; a product is a workspace folder of plain files, git optional
---
# The engine holds no product data; each product is a workspace folder of plain files

## Context

Lure will be public, and one of its first products is the author's employer's website, whose
data must never be published. One person runs several products, each configured apart. Spec
`lure`, Decisions.

## Decision

This repository is the engine: skills, CLI, templates, the vetted list of tools. A product's
profile, channels, hypothesis log, measurements, playbook and drafts live in a workspace — a
folder the person chooses, outside this repository. A workspace is plain files. Git is not
required; when the workspace already is a git repository, Lure commits its own changes there,
and it never runs `git init` itself.

## Alternatives

- Product data inside the engine repository — rejected: publishing the engine would publish the
  company's data.
- A database — rejected: non-developers can read, back up and move a folder; a database needs a
  tool.
- Requiring git — rejected: a barrier for non-developers.

## Consequences

- Without git there is no undo; Lure keeps its own record of what it changed and a copy before
  overwriting a draft or plan.
- Workspace formats are a public contract: a change to them needs a migration.
