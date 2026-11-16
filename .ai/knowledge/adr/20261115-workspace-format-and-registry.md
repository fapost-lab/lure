---
id: adr-20261115-workspace-format-and-registry
type: adr
status: accepted
date: 2026-11-15
domains: []
paths:
  - "plugins/lure/skills/init/**"
  - "plugins/lure/templates/workspace/**"
summary: Workspace format v1 (lure.yaml, profile, journal, .lure/) and the ~/.lure/workspaces.yaml registry
---
# Workspace format version 1, and a per-machine registry of workspaces

## Context

The workspace is a public contract (adr-20261115-engine-apart-from-workspaces): later skills and
the future CLI read it. Scheduled checks must find every workspace on the machine without
searching the disk. Task `product-workspace`, design approved 2026-11-15.

## Decision

- A workspace holds `lure.yaml` (settings, with `lure: 1` as the format version), `profile.md`,
  `journal.md` and a never-committed `.lure/` folder for the machine's local state. The full
  format is `plugins/lure/skills/init/references/workspace-format.md`; later steps add files of
  their own and leave unknown files alone.
- `journal.md` is append-only: one line per action with how to undo it — the record Lure keeps
  when there is no git.
- The registry `~/.lure/workspaces.yaml` lists each workspace's product name and absolute path.
  It was the first place Lure writes outside a workspace (credentials, the engine copy and run
  logs followed: adr-20261116-search-console-oauth-and-local-secrets,
  adr-20261117-scheduled-check-is-code-without-a-model), and it holds names and paths only, never
  product data.
- In a workspace that already is a git repository, Lure commits only the files it wrote, named by
  pathspec, after checking what the person had staged; it never runs `git init` and never pushes.

## Alternatives

- One file for the whole workspace — rejected: it grows with the hypothesis log and is hard to
  read.
- JSON settings — rejected: harder for non-developers to read and edit.
- Finding workspaces by scanning the disk — rejected: slow and unreliable for a scheduled check.

## Consequences

- A change to the format raises `lure:` and ships with a migration; a reader meeting an unknown
  version stops.
- Removing a workspace from the registry has no rule yet; the first skill that needs it defines
  one.
