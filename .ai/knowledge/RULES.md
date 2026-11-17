# Rules and Invariants

Normative requirements for this project. Rules say how work must be done; invariants say
what must always hold. Both are enforced in review and verification. Area-specific rules
are added as sections of this file.

Most checks below are review. Where code carries a rule, its tests do too (`npm test`, run by
`jig verify` and by CI on Linux, macOS and Windows).

## Invariants

- The engine repository holds no product data: no workspace files, metrics or credentials.
  (adr-20261115-engine-apart-from-workspaces) Checked: review of every diff.
- No code in the engine calls a model API, holds a model key or depends on a model SDK.
  (adr-20261115-agent-runtime-calls-the-model; for scheduled runs,
  adr-20261117-scheduled-check-is-code-without-a-model) Checked: review; dependency manifests once they
  exist.
- Nothing is published beyond the channel's publishing mode, and no mode exceeds its platform
  cap. (adr-20261115-person-approves-what-goes-public) Checked: review of every channel adapter.
- Lure never automates engagement on another account's content or messages other people.
  (adr-20261115-person-approves-what-goes-public) Checked: review.
- A verdict always carries a confidence level, sample size and effect; "worked" alone is never
  a verdict. (spec `lure`, adr-20261117-verdict-by-placebo-windows) Checked: tests of
  `metrics.mts writeVerdict` and `measure.mts`.
- A check measures only after confirming the change is live and the page was re-crawled after
  it; otherwise it waits with the reason written. (spec `lure`) Checked: tests of `check.mts`.
- The scheduled job never calls a model, never commits, and is installed or removed only after
  the person's yes to the plan shown. (adr-20261117-scheduled-check-is-code-without-a-model)
  Checked: review of the check skill; tests of `schedule.mts` (no real `launchctl` in tests).
- One active hypothesis per page at a time; the page of an active hypothesis is never a control.
  (spec `lure`, adr-20261116-hypothesis-log-format) Checked: tests of `metrics.mts record`.
- Numbers in a hypothesis file come from the script, never typed by an agent.
  (adr-20261116-hypothesis-log-format) Checked: review of the hypothesis skill.
- A lesson enters the playbook only after two consistent verdicts, with sample size, date and
  site; lessons never transfer between products on their own. (spec `lure`) Checked: review.
- Lure commits only in a workspace that already is a git repository, and never runs `git init`.
  (adr-20261115-engine-apart-from-workspaces) Checked: review.
- A tool is installed only after the person's yes, at a pinned version, and Lure never updates
  it on its own. (adr-20261115-hypothesis-loop-is-the-core) Checked: review.
- Credentials never enter a workspace, `.lure/` included; they live under `~/.lure/<service>/`,
  owner-only. Lure's scripts never print them, and skills never read, print or copy credential
  files. (adr-20261116-search-console-oauth-and-local-secrets) Checked: tests of the scripts'
  output and file modes; review of every skill that touches a credential.
- Metrics are read-only: Lure asks a metrics source for no scope that can change it.
  (adr-20261116-search-console-oauth-and-local-secrets) Checked: tests of the requested scopes.

## Rules

- Durable artifacts — knowledge, ADRs, skills, documentation, code comments, commit messages —
  are written in English. (the author's instruction) Checked: review.
- Code arrives only where a skill cannot do the step without it: one script per need under
  `plugins/lure/scripts/`, Node built-ins only, no npm dependencies, tested under `tests/`.
  (adr-20261116-code-enters-before-the-cli) Checked: review of `package.json` and every new script.
- Lure's own code is TypeScript on Node; no shell scripts in what users install. Jig's tooling
  under `.ai/` and the git hooks in `hooks/` are development tools, not the product.
  (adr-20261115-typescript-on-node) Checked: review.
- Content is drafted from the person's own material and fact-checked — titles, descriptions and
  schema included — before the person approves it. (adr-20261115-person-approves-what-goes-public)
  Checked: review of the content flow.
