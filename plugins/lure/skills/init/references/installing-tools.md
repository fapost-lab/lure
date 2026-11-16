# Installing tools

A tool is someone else's code and instructions that the agent will run on this machine.
Install only after the person's yes to the exact version and commands you showed them.

## Claude Code

Every tool on the vetted list is a Claude Code plugin from a GitHub marketplace. Its entry's
**Pinned** line gives `ref` (the tag) and `sha` (the commit); its **Marketplace** line gives the
repository (`owner/repo`), the marketplace name and the `plugin` name.

1. See what is there already:

   ```
   claude plugin marketplace list --json
   claude plugin list --json
   ```

   - The plugin is installed at the pinned version: record it in `lure.yaml` and stop.
   - The marketplace is added without the pinned ref, or the plugin is installed at another
     version: say so and ask before changing anything. Someone else may rely on it.

2. Add the marketplace pinned to the tag, then install:

   ```
   claude plugin marketplace add <owner/repo>#<ref>
   claude plugin install <plugin>@<marketplace>
   ```

3. Check that what arrived is what was pinned. Tags can be moved; the `sha` is the pin.
   - `claude plugin list --json` shows the plugin enabled. When it reports the installed commit,
     it must equal `sha`. When it differs, uninstall the plugin, tell the person the tag no longer
     points where Lure checked it and that the marketplace is still added (`claude plugin
     marketplace remove <marketplace>` takes it away), and stop.
   - When it reports no commit, read the commit the tag points to now
     (`git ls-remote https://github.com/<owner/repo> refs/tags/<ref>^{}`, or `refs/tags/<ref>` for
     a lightweight tag) and compare that with `sha` instead. Say which of the two checks you made.

   Record `ref` and `sha` in `lure.yaml` only after the check passed.

A marketplace added this way does not update itself. Leave it so: a newer version reaches the
vetted list through a change to Lure, never on its own.

**When the install refuses** because the plugin runs its own install command, Claude Code
will not run it from a skill. Give the person the command to run in their own terminal, say
what it will execute, and continue once they report it done.

**A tool's own setup step** (claude-seo's `/seo setup`, for example) is not part of installing
it. Tell the person it exists and what it downloads; run it only if they ask.

## Codex

Lure's vetted list has no Codex entry verified yet. Say so, and offer the Claude Code entry
when the person has Claude Code too.

## A tool given by link

Read the repository first: its README, its licence, its releases or tags, and its
`.claude-plugin/marketplace.json`. Show the person what you found and what you could not find:

- no licence — say others' rights to use it are unclear;
- no tags — there is no version to pin; offer to pin the current commit instead;
- it asks for keys, paid accounts or sends data to a service — name the service.

Install it as above, pinned to the tag or commit shown, and record it with `id: link`.
