# Workspace format, version 1

The workspace is a public contract: later skills, other people's workspaces and, later, Lure's
CLI read it. A change to anything here raises `lure:` in `lure.yaml` and comes with a
migration.

## Files

```
<workspace>/
  lure.yaml     # settings Lure reads: format version, product, site, channels, tools
  profile.md    # the product profile, for people and agents
  journal.md    # what Lure changed and when
  .lure/        # this machine's local state; never committed
```

Later steps add their own files here (the hypothesis log, the playbook). A file this version
does not name is left alone.

## lure.yaml

```yaml
lure: 1
product: <short lowercase name>
site: <https URL of the website>
language: <the person's language, e.g. ru, en>
channels:
  site:
    mode: <pr | draft>
tools:
  - id: <id from the vetted list, or "link">
    runtime: <claude-code | codex>
    source: <owner/repo>
    ref: <tag>
    sha: <full commit of the tag>
    installed: <YYYY-MM-DD>
```

- `lure` is the format version. A reader that does not know the version stops and says so.
- `channels.site.mode`: `pr` when the site is in git, `draft` when it is in a CMS.
- `tools` lists only what Lure installed; it is empty (`tools: []`) when nothing was.

## profile.md

Sections, in this order: What it is, Who it is for, Voice, Competitors, Never promise, Target
pages. A line ending in `(guess — confirm)` is the agent's inference the person has not
confirmed; nothing downstream may rely on it as fact.

## journal.md

One line per action, newest last:

```
- YYYY-MM-DD — <what was done> — <files> — <how to undo>
```

Without git this is the only record of what Lure changed. Lure appends; it never rewrites
earlier lines.

## .lure/

Local state of this machine. It is never committed and never copied with the workspace:
anything secret that later steps keep belongs here or outside the workspace, never in the
other files.

## The registry

`~/.lure/workspaces.yaml` lists every workspace on this machine, so scheduled steps can find
them:

```yaml
workspaces:
  - product: <name>
    path: <absolute path>
```

Adding a workspace appends an entry; a path already listed is not added twice.

## Git

Lure never runs `git init`, and never pushes. When the workspace already is a git repository:

1. Look first: `git status --porcelain`. Something already staged belongs to the person — leave
   it alone and keep it out of Lure's commit (the pathspec below does that).
2. `.lure/` missing from `.gitignore`: if `.gitignore` has no uncommitted changes, append
   `.lure/` and include `.gitignore` in the commit. If it has the person's own uncommitted edits,
   do not touch it; tell them to add `.lure/` themselves, and commit without it.
3. Commit only the files Lure wrote, named on the command line, so nothing else staged comes
   along:

   ```
   git add -- <file> <file>
   git commit -m "lure: <what was done>" -- <file> <file>
   ```

Never `git add .`, `-A` or `-a`.
