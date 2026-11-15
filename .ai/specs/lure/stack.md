# Stack — Lure

**Intended — not built yet.**

- **Phase 1:** agent skills (Markdown) for Claude Code and Codex; the journal as Markdown files
  in the workspace; a local schedule (the desktop app's scheduled tasks, or cron with a headless
  agent run); a Telegram bot for notices; the Search Console API through the author's own
  Google Cloud project.
- **From phase 3:** TypeScript on Node for the CLI, one process for a whole step rather than a
  process per command. Rejected: POSIX shell, which proved too heavy on the machine.
- **Release:** the installer brings its own Node runtime. Open: a private runtime in Lure's own
  folder (touches no system PATH or existing Node) or one compiled binary (Node single
  executable applications, `bun build --compile` or `deno compile`, each about 50–120 MB).
  Either way, code signing on Windows and Developer ID signing with notarisation on macOS, or
  users meet SmartScreen and Gatekeeper warnings.
- **Data sources:** Google Search Console API (16 months of history, a lag of a few days);
  Bing Webmaster API by key at release; GA4 later if needed. Not Yandex, for now.
- **Platforms (phase 4):** Telegram Bot API for an own channel; LinkedIn "Share on LinkedIn"
  (`w_member_social`) for personal posts, used for drafts by default. X is paid per post;
  Reddit needs approval of every token; Medium has no API; Habr's API is closed.
