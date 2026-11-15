---
id: adr-20261115-typescript-on-node
type: adr
status: accepted
date: 2026-11-15
domains: []
paths: []
summary: Code is TypeScript on Node; the installer brings its own runtime
---
# Lure's code is TypeScript on Node; the installer brings its own runtime

## Context

The author's experience with a shell-based tool: a process per step proved too heavy for the
machine. Lure's users include non-developers on Windows who have no Node. Spec `lure`, Decisions
and stack.md.

## Decision

Code in this repository is TypeScript running on Node, one process per whole step. The installer
provides Node when the machine has none, without asking the person to install anything.

## Alternatives

- POSIX shell — rejected: too heavy on the machine, and poor on Windows.
- Requiring the person to install Node — rejected: a developer step for non-developers.

## Consequences

- How Node arrives is open: a private runtime in Lure's own folder (no change to the system's
  PATH or existing Node) or one compiled binary (about 50–120 MB). Either needs code signing on
  Windows and notarisation on macOS for a clean install.
- The first phase is skills only; code appears when the CLI does.
