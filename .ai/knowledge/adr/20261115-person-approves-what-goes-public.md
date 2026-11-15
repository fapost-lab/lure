---
id: adr-20261115-person-approves-what-goes-public
type: adr
status: accepted
date: 2026-11-15
domains: []
paths: []
summary: Publishing never exceeds the channel's mode and the platform's cap; no automated engagement
---
# Nothing goes public beyond its channel's mode and its platform's rules

## Context

Platforms limit automation: LinkedIn bans unauthorised automated posting and engagement;
Reddit approves every token; Habr bans generated texts; Hacker News bans AI comments. Google
penalises content without value however it was made. Publishing under a person's name cannot be
taken back. Spec `lure`, Decisions; research.md.

## Decision

- Each channel of a product has a publishing mode: `auto` (official API), `pr` (a proposed
  change to a site in git), `draft` (prepared for the person to publish) or `manual` (found and
  left for the person). Each platform adapter has a cap no configuration can exceed.
- Lure never automates engagement: no likes, comments, invitations or messages on someone
  else's content or to other people.
- Content comes from the person's own material: an interview and the hypothesis log, drafted in
  their voice and fact-checked (titles, descriptions and schema included) before they approve.
  Where a platform bans AI text, Lure publishes only what the person wrote, or skips it.
- Lure does not disguise AI text as human.

## Alternatives

- Publishing everywhere automatically — rejected: account bans and irreversible mistakes under
  the person's name.
- "AI humanizer" tools to pass detectors — rejected: Google judges value, not authorship;
  detectors are unreliable; humanizers degrade text; on platforms that ban AI text it breaks
  their rules.
- Mass content generation — rejected: scaled content abuse.

## Consequences

- Reach depends on the person approving; Lure must keep their part to minutes.
- A platform rule change lowers the adapter's cap, never the other way round.
