# Architecture

High-level map of the system. Describe engineering intent, not implementation:
what the domains are, where the boundaries lie, which direction dependencies may point,
and which constraints and invariants hold system-wide. Anything the code already says
does not belong here.

Lure helps one person promote a product — its website's search visibility and its channels —
with AI agents. Its core is a measured loop: every change is recorded as a hypothesis with a
baseline, checked on schedule against control pages, and turned into lessons in the product's
playbook. Audits and drafting come from third-party tools. Its users are product owners
without SEO or development experience; the author is the beta tester. Source: spec `lure`.

## Intended — not built yet

Nothing below exists yet. The task that builds a part moves it out of this heading.

### Domains

- **Hypotheses** — the log: candidates, hypotheses, their pages, baselines, control pages,
  traffic floors and check dates. Knows nothing of where metrics come from.
- **Measurement** — the check: confirms a change is live and re-crawled, reads metrics through
  a port, compares with baseline and controls, marks outside events such as Google updates,
  gives a verdict.
- **Playbook** — turns verdicts into lessons under the two-results rule, and retracts them.
- **Content** — interview, draft in the person's voice, fact check, approval.
- **Channels** — one adapter per platform, each with its publishing modes and platform cap.
- **Tools** — the vetted list; installing and running third-party audit and drafting tools.
- **Workspace** — reading and writing a product's folder, and committing when it is a git
  repository.

The first phase builds these as skills over Markdown files, with no CLI
(adr-20261115-typescript-on-node); the domains are the same either way.

### Boundaries and dependency direction

- Domains depend on ports, never on adapters. Adapters at the edges: metrics sources (Search
  Console first), site changes (pull request, CMS instructions), notifications (Telegram first),
  the scheduler, channel platforms.
- Measurement reads Hypotheses; Playbook reads Measurement's verdicts; Content reads Hypotheses
  and Playbook as material; Channels publish what Content produced. Nothing points back up the
  chain.
- The engine never reads or writes product data outside a workspace
  (adr-20261115-engine-apart-from-workspaces), and never calls a model
  (adr-20261115-agent-runtime-calls-the-model).

### Runtime flows

1. **The loop.** A tool or the person yields candidates → the person decides → a hypothesis is
   recorded with baseline, controls, traffic floor and check date → the change is made (a pull
   request, or instructions for a CMS) → on schedule the check confirms the change is live and
   re-crawled, measures, gives a verdict → the person is notified → after two consistent
   verdicts a lesson enters the playbook.
2. **Content.** Material from the log and playbook → an interview with the person → a draft in
   their voice → fact check → the person approves → each channel publishes within its mode and
   cap.
3. **Init.** A workspace is created → the profile is drafted from the website's address for the
   person to correct → tools are offered from the vetted list → metrics sources are connected.

## System-wide constraints and invariants

- Lure runs on the person's machine; no hosted service (adr-20261115-local-first).
- Nothing goes public beyond its channel's publishing mode and platform cap; no automated
  engagement (adr-20261115-person-approves-what-goes-public).
- The hypothesis loop is the core; tools are pluggable and never depended on for format
  (adr-20261115-hypothesis-loop-is-the-core).
