---
id: adr-20261117-telegram-notices-by-the-owners-bot
type: adr
status: accepted
date: 2026-11-17
domains: []
paths:
  - plugins/lure/scripts/notify.mts
  - "plugins/lure/skills/notify/**"
summary: The scheduled check notifies through the person's own Telegram bot and applies only live-date answers from the paired owner, with no model
---
# Notifications go through the person's own Telegram bot, sent and answered by code without a model

## Context

The scheduled check (adr-20261117-scheduled-check-is-code-without-a-model) runs unattended, so a
verdict, a change seen live or a question only the person can answer waited until someone opened
`/lure:check`. Telegram's Bot API needs no server: the check can send with `sendMessage` and read
answers with `getUpdates`, which keeps updates for 24 hours. Bot chats have no end-to-end
encryption, so Telegram sees every message. Design approved by the author on 2026-11-17 (task
`telegram-notice`).

## Decision

- Each person creates their own bot in @BotFather. The person types its token into
  `notify.mts set-token` in their own terminal (it refuses input that is not a terminal); the
  agent never sees or handles it. The token and the pairing live in `~/.lure/telegram/`
  (folder 0700, files 0600) and are never printed, nor quoted in an error.
- The owner is paired by a one-time 16-character code in a deep link (`/start <code>`, private
  chat only, compared in constant time). The link passes through the agent's output: it binds
  only whoever presses Start before it expires, and the person sees the result.
- After every scheduled run `check.mts` calls `notify.mts` (through its injected deps; a notify
  failure is an error count in `last-run.json` and never fails the check). One pure `compose`
  builds the message from the workspace's `.lure/check-last.json`:
  - news of this run: a change seen live, a re-crawl with the after-window, a verdict, a new
    Google ranking update;
  - what needs the person, each said once (`said` in `.lure/notice.json`);
  - a date question for a page Lure cannot open, sent by itself only the first time and then
    riding along with the next message and the Monday digest until answered;
  - a Monday digest when the week was silent; otherwise nothing is sent.
- What leaves the machine: page paths without the domain, labels, the effect in percent with the
  90% interval, and dates. Never absolute impressions or clicks, query names, hypothesis ids or
  error texts. Plain text, split at 4000 characters, in `ru` or `en` by `lure.yaml`.
- Answers are only live dates: a button (`l:<ws#>:<q>:<yyyymmdd|other>`, where `q` is a random
  id and the button's message must be one that asked that question) or an exact `YYYY-MM-DD`
  reply to the bot's ForceReply. Both must come from the paired user in the paired chat and go
  through the same rules as `check.mts live` (`applyLive`). Everything else is counted, never
  stored, printed or acted on; `/lure:check` polls first and reports the count.
- Without a bot, or when sending fails, macOS shows a notification through `execFile`
  `osascript` with the text as arguments, never through a shell; it counts as sent and is not
  raised for a digest alone.

## What this changes

adr-20261117-scheduled-check-is-code-without-a-model listed what the schedule writes outside a
workspace and gave live dates to `/lure:check` only. The scheduled run now also calls
api.telegram.org, writes `~/.lure/telegram/offset.json` and `ignored.json` (a number), and
applies a live date the paired owner gave in Telegram. That ADR carries a note pointing here.

## Alternatives

- **A Lure-run bot or relay server.** Rejected by adr-20261115-local-first: product news would
  pass through a server of ours.
- **Free-text answers interpreted by a model.** Rejected: an unattended job with no model, and
  a chat message must never become an instruction.
- **Only "there is news, open Lure".** Kept as the fallback text; rejected as the default
  because the author wants the verdict on the phone. A company whose policy forbids it can stop
  at the macOS notification by not pairing a bot.
- **A webhook.** Rejected: it needs a public endpoint.

## Consequences

- The person learns of a verdict the day it is made and can give a live date from the phone.
- An answer is applied at the next scheduled run or when `/lure:check` opens; an answer older
  than 24 hours is lost, and the question is asked again.
- Telegram sees page paths and effect sizes of the product. That is the price of the feature.
- `notify.mts` is part of the engine copy; installed schedules report a stale copy until
  reinstalled.
