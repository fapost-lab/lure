---
name: notify
description: Connect the person's own Telegram bot to Lure, so that after each scheduled check the bot tells them what was measured and what needs them, and takes the live date of a change as an answer — create the bot with @BotFather, have the person enter its token in their own terminal, pair their chat with a one-time code, send a test message; also show the setup and disconnect it. Use when the person says "connect Telegram", "notify me", "send me the results", "set up notifications", "lure notify", "disconnect the bot", or asks why no message came.
license: MIT
---

# notify — the check's news in the person's Telegram

After each scheduled check (`check.mts run --all`), Lure's code sends the person a message
through their own bot. No model is involved. The message goes out only when there is something
to say:

- **news:** a change went live, Google re-crawled a page, a verdict, a new Google update;
- **what needs them**, said once: an overdue change, an expired Search Console sign-in, errors,
  no access to a folder;
- **a question about a live date**, with buttons, when it first comes up. Until answered, it
  comes back with every later message;
- **a short digest** on a Monday after a silent week, open questions included.

The message holds page paths, verdict labels and effects in percent with their interval. It
holds no absolute impressions or clicks, no queries and no domain. Telegram can read bot chats,
so tell the person this before they connect. If their company forbids sending even that, do
not connect the bot; the macOS notification alone remains.

The bot accepts one kind of answer, from the paired person only: the live date. It comes as a
button, or as a `YYYY-MM-DD` reply to the bot's question. Anything else written to the bot is
counted and dropped; it is never read as a request. Without a bot, or when sending fails, macOS
shows a notification: "news for <product> — open /lure:check".

Talk to the person in their language. The script:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/notify.mts" <command>` — called `notify` below.

**The token is the person's secret, and you never see it.** Never ask for it. Never run
`set-token` yourself: it reads from a terminal only, and what passes through your shell reaches
the model provider. Never read, print or copy anything under `~/.lure/telegram/`; check that a
file exists, nothing more. If the person pastes the token into the chat anyway, tell them it is
now exposed. They should issue a new one in @BotFather (`/mybots` → the bot → API Token →
Revoke) and enter the new one with `set-token`.

## 1. Where things stand

Run `notify status`. It prints the bot's name (never the token), whether an owner is paired,
and the open date questions.

- Bot and owner both set: offer `notify test` (§4), or stop.
- No bot: §2.
- A bot, no owner: §3.

## 2. The bot and its token

Walk the person through it, one step at a time, waiting for each:

1. In Telegram, open **@BotFather** (the verified one, with the blue tick) and send `/newbot`.
2. Give it a display name, e.g. "Lure — <product>".
3. Give it a username ending in `bot`, e.g. `<product>_lure_bot`. It must be unused.
4. BotFather replies with a token. **Do not paste it here.**
5. In their own terminal (Terminal.app, not this chat), the person runs:

   ```
   node "<the plugin's scripts folder>/notify.mts" set-token
   ```

   Give them the full path: expand `${CLAUDE_PLUGIN_ROOT}/scripts/notify.mts` yourself. The
   token is typed with echo off. The script checks it with Telegram and prints only
   `bot: @<name>`.

Then run `notify status` to see the bot's name.

## 3. Pair the person's chat

The bot answers only one person, bound by a one-time code. Tell the person:

- a link will appear: open it in Telegram on their phone or computer and press **Start**;
- the link works once, for ten minutes;
- a stranger who finds the bot by its name cannot pair, because the code is shown only here.

Start `notify pair` **in the background**: it waits up to ten minutes, longer than a foreground
command may run. Read its first lines and give the person the `https://t.me/...` link. Wait for
the command to finish:

- `paired`: go on to §4;
- no `/start` in time: offer to run it again.

## 4. A test message

Run `notify test`. The person should get "Lure is connected to: <products>". If nothing arrives:

- check that they pressed Start in the bot's chat;
- run `notify status`;
- a `Forbidden: bot was blocked by the user` error means they stopped the bot; they press Start
  again.

## 5. Answers in the chat

Answers are applied by the next scheduled run, and also whenever `/lure:check` opens: it runs
`notify poll` first. A date goes through the same rules as `check live`: not in the future, not
before the hypothesis was recorded, not after Google re-crawled the page. The journal says the
date came from Telegram. A wrong date is corrected with `/lure:check` until the re-crawl.

## 6. Disconnecting

- `notify unpair` forgets the paired chat. Run §3 again to pair another.
- `notify unpair --forget-token` also deletes the token. Tell the person to delete the bot in
  @BotFather too (`/deletebot`).

Without `~/.lure/telegram/`, the check works as before. Only the macOS notification remains.
