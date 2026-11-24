# Lure — promotion framework with a measured loop

Depth: deep — a new product whose first choices are hard to undo: who calls the model, how the
data is reached, how the tool is shipped.

## Idea

In the author's words (the conversation was in Russian; English after each quote):

> «я хотел бы иметь масштабированный проект, где можно настроить тоже самое для другого
> продукта. Т.е. мне нужен по сути фреймворк не sdlc а seo продвижения»

*I want a scalable project where the same thing can be set up for another product — in effect,
a framework not for the SDLC but for SEO promotion.*

> «для компании пока только сайт, для своих проектов нужен максимальный охват и сайт и
> соцсети. Это по идее должно настраиваться»

*For the company, only the website for now; for my own projects, maximum reach — the website
and social networks. This should be configurable.*

> «я точно забуду записать выводы и не вспомню, что мне нужно что-то проверить»

*I will certainly forget to write the conclusions down, and won't remember that something needs
checking.*

> «я плохой автор, да и времени на написание статей у меня нет»

*I am a poor writer, and I have no time to write articles.*

## Goal and problem

- Who is worse off without this, and how: a product owner without SEO experience. Audit tools
  and AI writers tell them what to change and draft text, but nothing remembers what was
  changed, checks weeks later whether it worked, and carries the lesson into the next plan.
  The person forgets to measure, so effort is spent and nothing is learned.
- What is true when the work is done: for each configured product, every change is recorded
  as a hypothesis with a baseline, is measured on schedule without the person having to
  remember, gets a verdict with a confidence level, and verified lessons accumulate in the
  product's playbook. Content is drafted from the person's own material, at a cost of minutes
  of their time per piece.
- Success after three months of the first phase: more organic clicks on the target pages of
  the company website against the baseline, adjusted by control pages, and a playbook with
  verified lessons. An honest "this does not work here" is also a result.

## Stress test

- Hidden assumptions — "this holds only if …":
  - The loop is worth building only if a small site's traffic can show any signal. And if not?
    Most verdicts come out "no signal"; the traffic floor (Decisions) says so up front rather
    than after a month.
  - Scheduled runs replace memory only if the machine is on often enough. And if not? Missed
    runs are caught up at the next start; a weekly cadence tolerates gaps.
  - Third-party audit skills are usable only if they keep working across versions. And if not?
    Lure never depends on their output format; versions are pinned.
- The main trade-off: start early with a thin version made of skills (fast, but limited) rather
  than build a proper CLI first (solid, but weeks pass before the first data, and data needs
  weeks anyway).
- The weakest point: statistics on small sites. Traffic per page is low, controls are not fully
  independent, and Google updates move pages unevenly.
- Failure modes — cause, what breaks, the signal that shows it (independent hunt, ranked):
  1. Too little traffic — verdicts are "no signal" or false positives with confident labels —
     confidence intervals straddle zero; verdicts flip when the window shifts.
  2. Control pages are not independent (shared templates, navigation, site-level quality) —
     adjustment cancels or invents effects — controls move right after a template change.
  3. Outside events (core updates, AI Overviews, seasonality, backlinks, own launches) — lessons
     credit the edit for what the algorithm did — verdict changes line up with update dates.
  4. The log drifts from what is live (CMS steps done late or never, edits outside Lure,
     merge ≠ deploy ≠ re-crawl) — wrong baseline window — live page differs from the record;
     last crawl is earlier than the change.
  5. Search Console plumbing degrades quietly (row caps, anonymised queries, 2–3 day lag,
     16-month retention, URL mismatches) — gaps and undercounts — totals differ from the UI.
  6. Nothing runs the loop for weeks — overdue verdicts pile up — a growing overdue list.
  7. The playbook generalises from noise — plans repeat a wrong move confidently — lessons
     without sample size; no lesson is ever retracted.
  8. AI-visibility metric is unstable — it tracks model releases, not the site — same prompts
     disagree on the same day.
  9. Agent changes damage the site (invalid schema, stray noindex, broken canonical, URL
     without redirect) — real traffic loss — new errors in indexing reports.
  10. Pluggable audit tools flood the queue and carry supply-chain risk — the queue fills with
      checklist items — most hypotheses come from one plugin; skill text asks for unrelated
      actions.
  11. Non-developers drop off at install (agent runtime, Node on Windows, exports, git) — the
      release fails its audience — issues about installation, not results.
- Other shapes considered, and why this one:
  - Another audit tool — rejected: claude-seo (~29.6k stars) and others already cover audits.
  - A manual first phase (claude-seo plus a markdown journal by hand) — rejected: the author
    will forget to measure, which is failure mode 6; a thin automated version tests the same
    question and keeps running.
  - An "AI humanizer" to pass detectors — rejected (Decisions).

## Scope and non-goals

- In scope:
  - Product workspaces: a profile (audience, voice, competitors, forbidden claims), channels,
    a hypothesis log, measurements and a playbook, per product.
  - The loop: hypothesis with baseline → change → scheduled measurement → verdict → lesson.
  - Pluggable audit and drafting tools, installed from a vetted list or by link.
  - Content from the person's own material: interview → draft in their voice → approval.
  - Channels with per-platform publishing modes; social channels from the fourth phase.
  - A public release for non-developers on macOS, Windows and Linux.
- Not doing:
  - An own SEO auditor or crawler.
  - Mass content generation, or disguising AI text as human (Decisions).
  - Automated engagement on social platforms (likes, comments, invitations, messages).
  - Paid advertising (it moves money).
  - Yandex, for now.
  - A hosted service: Lure runs on the person's machine.

## Decisions

- The core of Lure is the hypothesis log, the measurement and the playbook; audits and drafts
  come from pluggable tools — rejected: building an own auditor, because claude-seo and others
  already do it well.
- Users at release: product owners without SEO experience (solo founders, "vibe coders") —
  rejected as the main audience: SEO specialists and agencies, who already have tools to
  choose from. Until release the author is the beta tester, on two products: the company
  website (WordPress), where hypotheses are measured, and fapost.in, whose blog is where
  content (phase 2) is tried. jig.fapost.in was dropped on 2026-11-24: Jig is being rewritten
  on another stack, which would change its pages under any hypothesis.
- The model is called by the agent runtime (Claude Code, Codex), as in Jig; Lure's own code
  never calls a model — rejected: an own API key, an extra key and an extra bill for
  non-developers. Cost: without an agent runtime Lure does nothing.
- Engine apart from data: Lure's repository holds no product data; a product's workspace is
  its own folder of plain files — rejected: data inside the engine repository, which would
  leak company data on publication.
- Git is optional for users; when the workspace is a git repository, Lure commits its own
  changes — rejected: requiring `git init`, a barrier for non-developers.
- Channels are configured per product: an adapter and a publishing mode (`auto`, `pr`, `draft`,
  `manual`), capped by the platform's own rules. LinkedIn defaults to `draft`; Reddit, Hacker
  News and Habr are `manual` at most; a Telegram channel of one's own may be `auto`.
- Measurement is honest for small sites:
  - a verdict carries a confidence level ("noticeable gain", "no signal", "worse"), sample size
    and effect, never a bare "worked";
  - changed pages are compared with untouched control pages;
  - one hypothesis per page at a time;
  - a traffic floor is stated when the hypothesis is recorded: whether this page can show
    anything in the measurement window;
  - before measuring, Lure checks that the change is live and that Google re-crawled the page
    after it; otherwise the measurement waits;
  - a Google update inside the window is shown on the verdict;
  - a lesson enters the playbook only after two consistent results, with sample size, date and
    site; lessons do not transfer between sites on their own.
- AI-search visibility is measured as the share of mentions over a fixed set of prompts, not as
  a position — rejected: "AI rank", because repeated runs almost never return the same list.
- Pluggable tools: Lure does not depend on their output format; the agent runs the tool and
  records findings as candidate hypotheses in Lure's format — rejected: a strict contract no
  existing tool speaks. Installation comes from a vetted list showing source, author, stars and
  licence, pins a version, shows what it installs and waits for a yes, and never updates on its
  own; a link given by hand is installed the same way, with a "not from the vetted list"
  warning.
- The first version is skills, a markdown journal and a local schedule, with no CLI —
  rejected: a CLI first, because the first verdict needs three to four weeks of Google data
  whatever is built, so the earliest start wins.
- Scheduled runs are local, on the person's machine — rejected: a cloud routine, which would
  need company Search Console access in the cloud.
- Search Console in the first version: through the author's own Google Cloud project (a
  one-time setup for the beta tester) — rejected: CSV exports, which the person would forget
  exactly as they would forget to measure. A connection without Google Cloud (a verified OAuth
  client; Bing by API key) is part of the public release.
- Notifications go to a Telegram bot — rejected as primary: desktop notifications, which do not
  reach the phone. A desktop notification remains the fallback.
- Implementation in TypeScript on Node — rejected: shell, which proved too heavy for the machine
  (a process per step). The installer brings its own Node runtime; exactly how is open.
- Content comes from the person's own material: the hypothesis log and playbook are raw
  material for articles (real experiments, real numbers), and the person is the source, not
  the writer. The agent interviews them (5–10 questions, voice answers in Telegram accepted),
  drafts in their voice from the answers and the log, and checks facts including titles,
  descriptions and schema; the person spends about fifteen minutes answering and five
  approving. Where a platform bans AI text (Habr), Lure publishes only what the person wrote,
  or skips the platform.
- Rejected: "AI humanizer" tools to pass detectors — Google penalises content without value,
  not AI use; detectors are unreliable both ways; humanizers degrade the text; on platforms
  that ban AI text it breaks their rules and risks the account.
- The command stays `lure` — accepted collision: LURE, a Linux package builder; its users and
  Lure's barely overlap. Rejected name: Reel, which in marketing means short video and has
  several `reel` CLIs.

## Open questions

- Who at the company approves changes to the website, and does the company allow its data to
  go to an AI model. Phase 1 started on the company site; the answer may still limit it.
- The format and period of the company data already collected — what the first phase imports
  as its first baseline.
- Do OpenClaw skills work in Claude Code and Codex unchanged — whether they enter the vetted
  list.
- How Node reaches the user: a private runtime in Lure's folder, or one compiled binary — the
  installer of the public release; signing and notarisation follow from it.
- How the agent changes a WordPress site: instructions to the person, the REST API, or a plugin
  — how often the log drifts from what is live (failure mode 4).
- Whether to build on claude-seo's own snapshots (`/seo drift`) as part of measurement, or only
  recommend the plugin.
- The licence of the repository (Jig is MIT) — whether others may use Lure at all.

## Set aside

- Yandex Webmaster and Metrica — set aside because the author's products and the company do not
  need them now.
- Paid advertising — set aside because it moves money and is a different loop.
- Multilingual content — set aside until a product needs a second language.
- unexplored: documentation at lure.fapost.in, and how the first outside users find Lure.
- unexplored: several approvers in one workspace (a company with a marketing department).

## Assumptions left untested

- The company website has enough traffic for at least part of its hypotheses — taken at deep;
  the traffic floor on the first hypotheses will test it.
- The author's Mac is on often enough for a weekly check — taken at deep; the log of missed runs
  will test it.
- Search Console figures used here (1,000-row export cap in the UI, 2–3 day data lag, 16 months
  of history) — taken from research; check against Google's documentation before the first
  phase relies on them.
- The person will answer a short interview for each piece of content — taken at deep; the
  number of interviews left unanswered in the first month will test it.
