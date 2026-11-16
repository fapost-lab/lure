---
id: adr-20261115-distributed-as-a-claude-code-plugin
type: adr
status: accepted
date: 2026-11-15
domains: []
paths:
  - ".claude-plugin/**"
  - "plugins/lure/.claude-plugin/**"
summary: Lure is a Claude Code plugin in its own marketplace; skills use standard Agent Skills fields
---
# Lure reaches the agent runtime as a Claude Code plugin from its own marketplace

## Context

Lure's skills must be available in any folder, since each product is its own workspace
(adr-20261115-engine-apart-from-workspaces), and must have a version people can pin. Claude Code
loads personal skills from `~/.claude/skills` and plugins from marketplaces; plugin skills are
namespaced (`/<plugin>:<skill>`). Codex reads the same Agent Skills format from
`~/.agents/skills`. Task `product-workspace`, discovery.

## Decision

- This repository is a Claude Code marketplace (`.claude-plugin/marketplace.json`) with one
  plugin, `lure`, under `plugins/lure/`. Skills live in `plugins/lure/skills/<name>/` and are
  invoked as `/lure:<name>`. Developers add their local clone as the marketplace; others add
  `fapost-lab/lure`.
- Skills use only the standard Agent Skills frontmatter fields (`name`, `description`,
  `license`, `compatibility`, `metadata`, `allowed-tools`), so the same files can serve Codex.
- Codex is supported later, by copying skills to `~/.agents/skills` or a Codex plugin, once
  verified.

## Alternatives

- Skills copied into `~/.claude/skills` by hand — rejected: no version, no update path, and
  names collide with other skills (`/init`).
- A Codex plugin now — rejected: its commands were confirmed only by third-party sources.

## Consequences

- A release of Lure is a version in `plugin.json` and a git tag people pin the marketplace to.
- Skill references resolve relative to the skill's own folder; shared files (the vetted list,
  templates) live in `plugins/lure/`.
