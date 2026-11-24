# Roadmap — Lure

Destination: a product owner without SEO experience installs Lure on their own machine, points
it at their product, and from then on every change to their website and channels is recorded,
measured on schedule and turned into verified lessons — without them having to remember any
of it.

## Phase 1 — The loop, on skills

Goal: the author's two products run the full loop with no CLI — skills, a markdown journal and a
local schedule. Done when: a hypothesis on the company website reaches a verdict on schedule,
and the author learns it from a Telegram message without having asked.

- [x] `product-workspace` — Product workspace: `lure-init` creates a product's folder, drafts its profile from the
  website's address for the person to correct, and installs audit tools from the vetted list
  (or by link, with a warning)
- [x] `search-console-access` — Search Console access: connect through the author's Google Cloud project, and import the
  company data already collected as the first baseline (after: `product-workspace` — the data
  lands in a workspace)
- [x] `hypothesis-baseline` — Hypothesis with baseline: `lure-hypothesis` records what changes, where and why, snapshots
  the baseline, picks control pages, states the traffic floor and sets the check date (after:
  `search-console-access` — the baseline is read from it)
- [x] `scheduled-check` — Scheduled check: `lure-check` runs on a local schedule, confirms the change is live and
  re-crawled, measures against baseline and controls, marks Google updates in the window, gives
  a verdict with confidence, and catches up on missed runs (after: `hypothesis-baseline` — it
  measures recorded hypotheses)
- [x] `telegram-notice` — Telegram notice: the check reports what it measured and what needs the person, and the
  person can answer in the chat (after: `scheduled-check` — it reports the check's results)
- [x] `playbook-lessons` — Playbook: lessons enter only after two consistent results, carry sample size, date and
  site, and are retracted when later results contradict them (after: `scheduled-check` — lessons
  come from verdicts)
- [ ] fog: changing a WordPress site — instructions to the person, the REST API or a plugin;
  needs the company's answer on who approves changes, and a look at how often the log drifts

## Phase 2 — Content from own material

Goal: articles for the website come from the person's experience at minutes of their time.
Done when: one article built from the author's own material (an interview, and the hypothesis
log where the product has one) is published on the fapost.in blog with under twenty minutes of
the author's time. The blog does not exist yet; making it is the author's.

- [ ] Interview to draft — the agent asks 5–10 questions (voice answers in Telegram accepted),
  drafts in the person's voice from the answers and the log, and checks facts, titles,
  descriptions and schema before the person approves
- [ ] Voice profile — the product profile learns the person's voice from texts they really wrote
- [ ] fog: AI-search visibility — share of mentions over a fixed prompt set; how to run it
  repeatably on the person's machine is not yet clear

## Phase 3 — The CLI

Goal: what the skills of phase 1 do awkwardly moves into a TypeScript CLI.
Done when: the scheduled check runs as one process without the agent re-deriving its steps.

- [ ] fog: the CLI's scope — which steps are slow, error-prone or costly as skills is only known
  after phase 1 has run for some weeks

## Phase 4 — Social channels

Goal: one piece of material reaches the product's channels, each within its platform's rules.
Done when: a phase-2 article is announced on a Telegram channel automatically and drafted for
LinkedIn for the person to post.

- [ ] Channel configuration — per-product channels with adapter, publishing mode and the
  platform's cap
- [ ] Telegram channel — publish to the product's own channel (after: Channel configuration —
  its mode comes from the configuration)
- [ ] LinkedIn drafts — drafts for the person's profile, posted by the person (after: Channel
  configuration — its mode comes from the configuration)
- [ ] Channel measurement — which channel brings people to the site, and which to switch off
  (after: Telegram channel — needs a channel publishing to measure)

## Phase 5 — Public release

Goal: a non-developer installs and connects Lure with no developer step.
Done when: a person on Windows with no Node and no Google Cloud project reaches their first
recorded hypothesis.

- [ ] Search Console without Google Cloud — a verified OAuth client, and Bing by API key
- [ ] Installer — brings its own Node runtime on macOS, Windows and Linux, signed where the
  platform warns otherwise
- [ ] Documentation — lure.fapost.in, written for non-developers
- [ ] fog: licence and first users — the licence decision and how the first outside users find
  Lure

## Waves

1. product-workspace
2. search-console-access
3. hypothesis-baseline
4. scheduled-check
5. telegram-notice; playbook-lessons; Interview to draft
6. Voice profile; Channel configuration
7. Telegram channel; LinkedIn drafts
8. Channel measurement; Search Console without Google Cloud; Installer; Documentation

<!--
Rules (jig-idea §8):
- An item is a finished slice that makes the product noticeably better, never a layer.
- A dependency without a one-line reason is not a dependency.
- A `task-id` appears when the item's task is filed; `[x]` is set when that task is closed.
- `fog:` items are not split or sized; they become real items once the fog lifts.
- No dates, no point estimates: order is the priority.
- `jig spec list` counts checkbox lines only: `[x]` done, a leading backticked task id
  followed by a dash (`—` or `-`) filed, a leading `fog:` fog. Keep waves as a numbered list.
- A wave entry names an item by its title (the text before its first ` — `) or its task id,
  entries separated by `;` — `jig spec plan` reports an entry that names no item or several.
-->
