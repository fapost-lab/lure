---
id: adr-20261116-code-enters-before-the-cli
type: adr
status: accepted
date: 2026-11-16
domains: []
paths:
  - "plugins/lure/scripts/**"
  - package.json
  - "tests/**"
  - ".github/workflows/**"
summary: "Code arrives before the CLI only where a skill cannot do without it: one dependency-free Node script per need, tested in CI"
---
# Code enters before the CLI, one script where a skill cannot do without it

## Context

adr-20261115-typescript-on-node expected the first phase to be skills only, with code arriving
with the CLI in phase 3. The spec put off the CLI for speed: the first verdict waits three to
four weeks for Google's data whatever is built. Connecting Search Console needs an OAuth sign-in
and paginated API calls, which a Markdown skill cannot do. Task `search-console-access`, design
approved 2026-11-16.

## Decision

Code appears in a phase when a skill cannot do the step without it, and only then:

- one TypeScript module per need under `plugins/lure/scripts/`, run directly by Node's type
  stripping (`node <script>.mts`), Node 22.18 or newer;
- Node's built-ins only — no npm dependencies, no build step, no lock file;
- its commands are shaped as the future CLI's would be, so the CLI absorbs them later;
- tests under `tests/` with `node:test`, run by `npm test` locally (`jig verify`) and in CI on
  Linux, macOS and Windows.

## Alternatives

- A third-party tool for the step (claude-seo's `/seo google`, the mcp-gsc server) — rejected:
  the hypothesis loop's measurement would depend on another tool's output format and on Python
  (adr-20261115-hypothesis-loop-is-the-core).
- The whole CLI now — rejected: the reason the spec put it off still holds.
- The `googleapis` package — rejected: a large dependency in maintenance mode for three calls.

## Consequences

- The person needs Node 22.18 or newer until the installer brings its own; skills check the
  version first and say so plainly.
- The repository has a `package.json` (private, no dependencies) and a CI workflow; `jig task
  ship` can merge on green CI.
