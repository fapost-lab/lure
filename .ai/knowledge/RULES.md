# Rules and Invariants

Normative requirements for this project. Rules say how work must be done; invariants say
what must always hold. Both are enforced in review and verification. Area-specific rules
are added as sections of this file.

Lure has no code yet: every check named below is review until a test can carry it.

## Invariants

- The engine repository holds no product data: no workspace files, metrics or credentials.
  (adr-20261115-engine-apart-from-workspaces) Checked: review of every diff.
- No code in the engine calls a model API, holds a model key or depends on a model SDK.
  (adr-20261115-agent-runtime-calls-the-model) Checked: review; dependency manifests once they
  exist.
- Nothing is published beyond the channel's publishing mode, and no mode exceeds its platform
  cap. (adr-20261115-person-approves-what-goes-public) Checked: review of every channel adapter.
- Lure never automates engagement on another account's content or messages other people.
  (adr-20261115-person-approves-what-goes-public) Checked: review.
- A verdict always carries a confidence level, sample size and effect; "worked" alone is never
  a verdict. (spec `lure`) Checked: review of the check's output format.
- A check measures only after confirming the change is live and the page was re-crawled after
  it; otherwise it waits. (spec `lure`) Checked: review.
- One hypothesis per page at a time. (spec `lure`) Checked: review of hypothesis recording.
- A lesson enters the playbook only after two consistent verdicts, with sample size, date and
  site; lessons never transfer between products on their own. (spec `lure`) Checked: review.
- Lure commits only in a workspace that already is a git repository, and never runs `git init`.
  (adr-20261115-engine-apart-from-workspaces) Checked: review.
- A tool is installed only after the person's yes, at a pinned version, and Lure never updates
  it on its own. (adr-20261115-hypothesis-loop-is-the-core) Checked: review.

## Rules

- Durable artifacts — knowledge, ADRs, skills, documentation, code comments, commit messages —
  are written in English. (the author's instruction) Checked: review.
- Lure's own code is TypeScript on Node; no shell scripts in what users install. Jig's tooling
  under `.ai/` and the git hooks in `hooks/` are development tools, not the product.
  (adr-20261115-typescript-on-node) Checked: review.
- Content is drafted from the person's own material and fact-checked — titles, descriptions and
  schema included — before the person approves it. (adr-20261115-person-approves-what-goes-public)
  Checked: review of the content flow.
