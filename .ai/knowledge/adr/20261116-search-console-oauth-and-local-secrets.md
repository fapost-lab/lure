---
id: adr-20261116-search-console-oauth-and-local-secrets
type: adr
status: accepted
date: 2026-11-16
domains: []
paths:
  - plugins/lure/scripts/search-console.mts
  - "plugins/lure/skills/search-console/**"
summary: Search Console via the person's own published OAuth client; credentials under ~/.lure/<service>/, owner-only, never read by the agent
---
# Search Console through the person's own OAuth client; secrets under ~/.lure, never read by the agent

## Context

adr-20261115-local-first left open where credentials live on the machine. Search Console
access for the first version goes through the person's own Google Cloud project (spec `lure`).
Whatever an agent reads is sent to the model provider, so a credential the agent reads has left
the machine. Task `search-console-access`, design approved 2026-11-16.

## Decision

- Sign-in uses an OAuth "Desktop app" client in the person's own Google Cloud project, published
  to Production, with the read-only scope `webmasters.readonly`, a loopback redirect on
  127.0.0.1, PKCE and a checked `state`.
- Credentials live under `~/.lure/<service>/` — for Google, `client.json` and
  `tokens/<e-mail>.json` — in a directory readable by the owner only (0700, files 0600 on macOS
  and Linux; on Windows, the user's profile). One sign-in per account serves every workspace.
- Credentials are never in a workspace, `.lure/` included. A workspace names its source
  (`metrics.search_console.property`) and, locally in `.lure/`, the account that reads it.
- Skills never read, print or copy credential files; they move a downloaded client file into
  place without reading it. Lure's scripts print the account's e-mail and summaries only.
- `~/.lure/` is Lure's per-machine folder: the registry and the credentials — later also the
  engine copy and run logs (adr-20261117-scheduled-check-is-code-without-a-model) — never
  product data.

## Alternatives

- The same client left in "Testing" — rejected: Google expires its sign-ins after 7 days, and
  scheduled checks would stop.
- A service account added to the property — kept as the way around an organisation that forbids
  unverified apps, not built: a long-lived key file, and a new user visible on the company's
  property.
- Tokens in the workspace's `.lure/` — rejected: copied with the folder, and repeated per product.
- The system keychain — deferred to the installer: without dependencies there is no portable way
  to reach it from Node, and `keytar` is archived.

## Consequences

- Google shows "this app isn't verified" at sign-in; the skill warns the person first.
- A sign-in unused for six months expires; a weekly check keeps it alive.
- Windows protects the files only by their location until the installer sets ACLs or uses the
  credential store.
