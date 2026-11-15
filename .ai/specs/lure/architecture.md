# Architecture — Lure

**Intended — not built yet.**

## Shape

Two parts that never mix:

- **The engine** — this repository: skills, later a TypeScript CLI, templates, the vetted list of
  tools. It holds no product data and can be public.
- **A workspace** — one folder per product, wherever the person keeps it: the product profile,
  channels, the hypothesis log, measurements, the playbook, drafts. Plain files; git optional.
  When the folder is a git repository, Lure commits its own changes.

The model is always the agent runtime's (Claude Code, Codex). The engine's code never calls a
model: it holds the steps, the formats and the rules, and the runtime does the thinking — the
same split as Jig.

## Inside the engine

Modules by domain, with ports at the edges:

- **Hypotheses** — the log: a hypothesis, its page, baseline, control pages, traffic floor, check
  date, verdict.
- **Measurement** — reads metrics through a port, checks the change is live, compares with
  baseline and controls, marks outside events, produces a verdict with confidence.
- **Playbook** — turns verdicts into lessons under the two-results rule, and retracts them.
- **Content** — interview, draft, fact check, approval.
- **Channels** — one adapter per platform, each with its publishing modes and the platform's cap.
- **Tools** — the vetted list and installation of third-party audit and drafting skills.

Ports at the edges: metrics sources (Search Console first; Bing at release), site changes
(git pull request, CMS instructions, later the WordPress REST API), notifications (Telegram
first), the scheduler (local), channel platforms.

## Considered

- A plain layered application — rejected: the edges (metrics sources, platforms, site kinds)
  grow independently and are what changes most; ports keep each one replaceable.
- Ports and adapters everywhere, with no domain modules — rejected: at this size the domains are
  what an agent needs to find its way; ports only where the outside world is.
- A hosted service — rejected: company data would leave the machine, and the audience would
  need an account and a subscription on top of their agent runtime.
