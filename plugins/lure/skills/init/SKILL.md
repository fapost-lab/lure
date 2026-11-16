---
name: init
description: Set up Lure for a product — create its workspace folder, draft its product profile from the website for the person to correct, and offer vetted audit tools to install at pinned versions. Use when the person says "set up Lure", "add a product", "start promoting <site>", "lure init", or names a website to promote that has no workspace yet.
license: MIT
---

# init — set up a product's workspace

A **workspace** is one product's folder of plain files. It lives wherever the person keeps it,
never inside Lure itself. This skill creates it, fills its product profile with the person, and
installs the audit tools they agree to. It connects no metrics source: that is a later step.

Talk to the person in their language and write the workspace's prose in it too. Show every
file before writing it; write nothing they have not seen.

## 1. Where and what

Ask for the product's website address and where to keep the workspace. Offer
`~/Lure/<product>` as the default, `<product>` a short lowercase name from the domain.

- The folder holds a `lure.yaml` already: it is a workspace. Read it, say what is there, and
  offer to continue from the first step it lacks. Never overwrite it.
- The folder holds other files: it is fine to use it, but say which files Lure will add.

Ask whether the website lives in git (the person edits files and pushes) or in a CMS such as
WordPress (the person edits in an admin panel). That sets the site channel's mode: `pr` for
git, `draft` for a CMS.

## 2. Draft the product profile

Read the website with the runtime's own web tools: the home page and up to five pages that
say what the product is — about, pricing, documentation, features. Read nothing behind a login.

Draft `profile.md` from [the template](../../templates/workspace/profile.md). Mark every line
you inferred rather than read `(guess — confirm)`. Two sections are never guessed:

- **Never promise** — ask: "What must we never claim about this product?" Give two examples
  from what you read (a feature it lacks, a guarantee it does not give).
- **Target pages** — ask which pages matter most; propose the ones you would pick and why.

Show the whole draft. Apply the person's corrections and drop a `(guess — confirm)` mark only
when they confirmed that line. Write nothing until they say yes to the profile.

## 3. Write the workspace

Create the files [workspace format](references/workspace-format.md) describes, from the
templates: `lure.yaml`, `profile.md`, `journal.md`, and the `.lure/` folder. Add the folder to
the registry `~/.lure/workspaces.yaml`, creating it if it does not exist.

Append one line to `journal.md` for what this step did. Commit nothing yet: the tools below
change `lure.yaml` too, and the workspace is committed once, in §5.

## 4. Offer the tools

Read the [vetted list](../../vetted-tools.md). Offer the tools listed for this runtime. For each,
show the person, before asking:

- what it is for, its author, licence and stars;
- the pinned version;
- what it installs on the machine and what it sends outside;
- the exact commands you will run.

Install only the ones they say yes to, by [installing tools](references/installing-tools.md),
and record each in `lure.yaml` under `tools`.

**A tool the person names by link** goes the same way, with one more line shown first:
"This tool is not on Lure's vetted list." Read its README and licence before showing anything;
say plainly what you could not find out.

## 5. Commit, if there is git

Append the result to `journal.md` first. Then git, by [the rule](references/workspace-format.md#git):

- The folder is already a git repository: commit only the files Lure wrote, as that rule says.
- It is not: do nothing with git. Never run `git init`.

## 6. Report

Say what the workspace holds, where it is, which tools were installed at which version, whether
it was committed, and what comes next: connecting Search Console with `/lure:search-console`.
