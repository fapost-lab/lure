---
id: adr-20261116-optional-additions-keep-the-format-version
type: adr
status: accepted
date: 2026-11-16
domains: []
paths:
  - plugins/lure/skills/init/references/workspace-format.md
summary: "Adding an optional workspace key or file keeps lure: unchanged; removing, renaming or changing meaning raises it"
---
# Optional additions do not raise the workspace format version

## Context

adr-20261115-workspace-format-and-registry made every change to the format raise `lure:` with a
migration. Each later step adds its own optional files and keys (Search Console first), and a
version bump for each would make every older reader stop for nothing. No outside reader exists
yet, so the rule is cheapest to change now. Task `search-console-access`, design approved
2026-11-16.

## Decision

Removing, renaming or changing the meaning of a key or file raises `lure:` and ships with a
migration. Adding an optional key or file does not: a reader that does not know it leaves it
alone, and its absence means the feature is not set up. This replaces the first consequence of
adr-20261115-workspace-format-and-registry.

## Alternatives

- Raise the version for every addition, with an empty migration — rejected: older readers would
  refuse workspaces they could read perfectly well.

## Consequences

- Every addition must be optional and harmless to ignore; one that is not is a change of meaning
  and raises the version.
