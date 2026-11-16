---
name: search-console
description: Connect a Lure workspace to Google Search Console — guide the person through their own Google Cloud OAuth client, sign in read-only, choose the property, pull its daily history into the workspace, and reconcile it with data they collected before. Use when the person says "connect Search Console", "connect GSC", "pull Search Console data", "lure search-console", or after /lure:init when a workspace has no metrics source yet.
license: MIT
---

# search-console — connect a workspace to Google Search Console

Search Console is where Lure reads a site's clicks, impressions and positions. Access is
read-only, through an OAuth client in the person's own Google Cloud project. Talk to the person
in their language; show every change to a workspace file before writing it.

The script: `node "${CLAUDE_PLUGIN_ROOT}/scripts/search-console.mts" <command>`. It prints only
the account's e-mail and summaries.

**Never read, print or copy the contents of anything under `~/.lure/google/`** — not with a file
tool, not with `cat`, not to "check" it. What you read goes to the model provider, and these
files hold the person's Google credentials. Check that a file exists, nothing more.

## 1. The workspace and Node

Find the workspace: the current folder, or one the person names, holding `lure.yaml`; or ask,
offering the entries of `~/.lure/workspaces.yaml`. Without a workspace, offer `/lure:init`.

If `lure.yaml` already has `metrics.search_console.property`, the workspace is connected: skip
to §5 and pull what is new.

`node --version` must be 22.18 or newer. If it is older or missing, say so and stop: Lure's
installer comes later, and until then the person installs Node themselves (nodejs.org, LTS).

## 2. The OAuth client

If `~/.lure/google/client.json` exists, go on to §3. Otherwise walk the person through
[Google Cloud setup](references/google-cloud-setup.md), one step at a time, waiting for each.
They do the clicking; you say exactly where and what.

When they have downloaded the client's JSON file, ask for its path and move it into place
without reading it:

- macOS and Linux: `install -d -m 700 ~/.lure/google && install -m 600 "<downloaded>" ~/.lure/google/client.json && rm "<downloaded>"`
- Windows (PowerShell): `New-Item -ItemType Directory -Force "$HOME\.lure\google" | Out-Null; Move-Item "<downloaded>" "$HOME\.lure\google\client.json"`

## 3. Sign in

Ask which Google account owns the site's Search Console property. If
`~/.lure/google/tokens/<that e-mail>.json` exists, it is signed in already: go to §4.

Otherwise tell the person before running anything:

- a browser tab opens with Google's sign-in; it may say Google hasn't verified the app — that
  is their own app: **Advanced → Go to … (unsafe)** continues;
- tick the Search Console permission if Google asks;
- they have ten minutes.

Start `auth` **in the background** (a foreground command would hide the sign-in address until it
exits, and sign-in can take longer than a command may run). Read its output: the first lines are
the sign-in address. Give the address to the person in case no browser tab opened — on a remote
machine or in WSL it will not. Wait for the background command to finish; it prints
`signed in: <e-mail>`, or gives up after ten minutes. If it fails, say what it printed. "access blocked" or "admin" in the message means the
account's organisation forbids unverified apps: say so and stop — a service account is the way
around it, and Lure does not offer it yet.

## 4. Choose the property

Run `sites --account <e-mail>`. Show the list. A site often has both a Domain property
(`sc-domain:example.com`) and a URL-prefix one (`https://example.com/`); the older one usually
holds more history — recommend the one matching the workspace's `site`, and say why.

Show the change, then write it:

- `lure.yaml`: `metrics:` → `search_console:` → `property: <chosen>`;
- `<workspace>/.lure/search-console.yaml`: `account: <e-mail>` — local, never committed, because
  an e-mail is personal.

## 5. Pull the history

Run `pull --account <e-mail> --property <property> --workspace <dir>` (the account from
`.lure/search-console.yaml`). The first pull takes everything Google keeps (about 16 months);
later pulls add only the days that became final since. Show what it printed.

## 6. What was collected before

Ask whether the person already collected Search Console data by hand — notes, exports, tables.
If they have, ask where, and read them:

- **Reconcile.** Sum `search-console/site-daily.csv` by month (position as an average weighted
  by impressions) and compare with their monthly figures — only months both cover fully. Show
  a table: month, theirs, pulled, difference. Name each difference you cannot explain; small ones
  from final data are normal.
- **Outside events.** List the dated events their notes mention that affect search traffic:
  outages, blocks, migrations, sitemaps sent, removals, indexing requests. Show the list; after
  their yes, write them to `events.md` (format in
  [workspace format](../init/references/workspace-format.md#eventsmd)).

## 7. Journal and git

Append to `journal.md`, one line per step done (connected, pulled, events recorded), each with
its undo. Then git, by [the rule](../init/references/workspace-format.md#git): the files are
`lure.yaml`, `journal.md`, `events.md` and `search-console/` — never `.lure/`.

## 8. Report

Say which property is connected through which account, how many days were pulled and from when,
what the reconciliation showed, and what comes next: recording the first hypothesis.
