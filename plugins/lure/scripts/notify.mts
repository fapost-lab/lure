// Lure's notifications adapter: after the scheduled check, the person's own Telegram bot tells
// them what was measured and what needs them, and takes one kind of answer back — the live
// date of a change, as a button or as a YYYY-MM-DD reply to the bot's question. Nothing in a
// message is ever followed as an instruction; everything else is only counted. Without a bot,
// or when sending fails, macOS shows a desktop notification instead. No model, Node built-ins.
//
//   node notify.mts set-token                  (in the person's own terminal; hidden input)
//   node notify.mts pair [--minutes 10]
//   node notify.mts test
//   node notify.mts poll
//   node notify.mts status
//   node notify.mts unpair [--forget-token]
//
// The token and the owner live under ~/.lure/telegram/ (LURE_HOME overrides ~/.lure), owner-
// only, and are never printed. What was said and which questions are open live in each
// workspace's .lure/notice.json.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { applyLive, registry, registryEntries } from "./check.mts";
import type { HypReport, RunResult, RunSummary } from "./check.mts";
import { LureError as MetricsError, addDays, isDate, localToday, readHypotheses } from "./metrics.mts";
import { MIN_NODE, lureHome, nodeTooOld, writeSecret } from "./search-console.mts";

export class LureError extends Error {}

// A failed Bot API call. Its message holds the method and Telegram's own description at most:
// never the request URL, which carries the token.
export class TelegramError extends LureError {
  code: number;
  constructor(method: string, code: number, description: string) {
    super(`Telegram ${method}: ${description}`);
    this.code = code;
  }
}

type Fetch = typeof fetch;

export const API = "https://api.telegram.org";
export const MAX_TEXT = 4000;            // sendMessage takes 4096; leave room
export const CODE_LENGTH = 16;
export const ALLOWED_UPDATES = ["message", "callback_query"];
const TOKEN_SHAPE = /^\d{5,15}:[A-Za-z0-9_-]{30,80}$/;
const CALLBACK = /^l:(\d{1,4}):(q[A-Za-z0-9]{1,8}):(\d{8}|other)$/;
const MAX_PAGES = 20;                    // getUpdates pages per poll (100 updates each)

export type NotifyDeps = {
  fetch: Fetch;
  today: string;
  now: () => Date;
  lureHome: string;
  platform: string;
  // Runs a program with arguments, no shell. Used only for the macOS notification.
  execFile: (cmd: string, args: string[]) => Promise<void>;
  // The token, typed by the person with echo off.
  readToken: () => Promise<string>;
};

export function defaultNotifyDeps(): NotifyDeps {
  return {
    fetch,
    today: localToday(),
    now: () => new Date(),
    lureHome: lureHome(),
    platform: process.platform,
    execFile: (cmd, args) => new Promise<void>((ok, fail) => {
      nodeExecFile(cmd, args, { timeout: 15_000 }, (e) => (e ? fail(e) : ok()));
    }),
    readToken: readHidden,
  };
}

// ---- Files --------------------------------------------------------------------------------

export type Bot = { token: string; username: string };
export type Owner = { chat_id: number; user_id: number; paired_on: string };

export const telegramDir = (home: string) => join(home, "telegram");
export const botPath = (home: string) => join(telegramDir(home), "bot.json");
export const ownerPath = (home: string) => join(telegramDir(home), "owner.json");
export const offsetPath = (home: string) => join(telegramDir(home), "offset.json");

function readJson(p: string): any | null {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function readBot(home: string): Bot | null {
  const b = readJson(botPath(home));
  return b && typeof b.token === "string" && typeof b.username === "string" ? b : null;
}

export function readOwner(home: string): Owner | null {
  const o = readJson(ownerPath(home));
  return o && Number.isInteger(o.chat_id) && Number.isInteger(o.user_id) ? o : null;
}

function readOffset(home: string): number {
  const o = readJson(offsetPath(home));
  return o && Number.isInteger(o.offset) ? o.offset : 0;
}

// Never moves back: /lure:check's poll and the scheduled run may overlap.
function saveOffset(home: string, offset: number): void {
  if (offset > readOffset(home)) writeSecret(offsetPath(home), { offset });
}

// A button answers a question only when both match: its random `q` and the message it sits in
// (one of `message_ids`). So a button left in an old message never answers a later question
// about another page — not after the registry changed order, not after notice.json was lost.
export type Question = {
  q: string;               // random id, the one in callback_data
  hypothesis: string;      // hypothesis id
  page: string;            // the page's path, no domain
  asked_on: string;        // the day the buttons were made (their "today" and "yesterday")
  n?: number;              // its number in a message with several questions
  message_ids: number[];   // the messages whose buttons ask it, newest last
  reply_id?: number;       // the ForceReply message that asked for another date
  // How each of those messages labelled its button (`n`, `asked_on`), by message id: a later
  // message may number the question differently or carry other dates, and an older message's
  // remaining buttons must stay as that message showed them.
  shown?: { [messageId: string]: { n?: number; asked_on: string } };
};
export type Notice = { last_sent: string | null; last_digest: string | null; said: string[]; questions: Question[] };

export const QUESTION_ID_LENGTH = 6;
export const MAX_MESSAGE_IDS = 10;

const noticePath = (ws: string) => join(ws, ".lure", "notice.json");

export function readNotice(ws: string): Notice {
  const n = readJson(noticePath(ws)) ?? {};
  return {
    last_sent: typeof n.last_sent === "string" ? n.last_sent : null,
    last_digest: typeof n.last_digest === "string" ? n.last_digest : null,
    said: Array.isArray(n.said) ? n.said.filter((x: unknown) => typeof x === "string") : [],
    questions: Array.isArray(n.questions)
      ? n.questions
        .filter((x: any) => x && typeof x.q === "string" && typeof x.hypothesis === "string")
        .map((x: any) => ({ ...x, message_ids: Array.isArray(x.message_ids) ? x.message_ids.filter(Number.isInteger) : [] }))
      : [],
  };
}

export function writeNotice(ws: string, n: Notice): void {
  mkdirSync(join(ws, ".lure"), { recursive: true });
  const p = noticePath(ws);
  writeFileSync(`${p}.part`, JSON.stringify(n, null, 2) + "\n");
  renameSync(`${p}.part`, p);
}

export function settings(ws: string): { product: string | null; language: string } {
  let text = "";
  try { text = readFileSync(join(ws, "lure.yaml"), "utf8"); } catch { /* unreadable: defaults */ }
  const product = text.match(/^product:[ \t]*(.+?)[ \t]*$/m)?.[1].replace(/^["']|["']$/g, "") ?? null;
  const language = text.match(/^language:[ \t]*["']?([A-Za-z]+)/m)?.[1].toLowerCase() ?? "en";
  return { product, language };
}

// The product's name: lure.yaml first, then the registry, then the folder's name.
function productName(ws: string, home: string): string {
  return settings(ws).product ?? registryEntries(home).find((e) => e.path === ws)?.product ?? basename(ws);
}

// Messages the scheduled run's poll did not take as answers, until /lure:check's poll reports
// them. A number only: nothing of the messages themselves.
const ignoredPath = (home: string) => join(telegramDir(home), "ignored.json");

function addIgnored(home: string, n: number): void {
  if (n > 0) writeSecret(ignoredPath(home), { ignored: takeIgnored(home, false) + n });
}

export function takeIgnored(home: string, reset = true): number {
  const o = readJson(ignoredPath(home));
  const n = o && Number.isInteger(o.ignored) ? o.ignored : 0;
  if (reset && existsSync(ignoredPath(home))) rmSync(ignoredPath(home), { force: true });
  return n;
}

// ---- Bot API ------------------------------------------------------------------------------

export async function call(f: Fetch, token: string, method: string, body: object = {}, waitSeconds = 0): Promise<any> {
  let res: Response;
  try {
    res = await f(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((waitSeconds + 20) * 1000),
    });
  } catch {
    // The error of a failed fetch may quote the URL, and with it the token: say nothing of it.
    throw new TelegramError(method, 0, "could not reach Telegram");
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!data || data.ok !== true) {
    const said = typeof data?.description === "string" ? data.description.split(token).join("<token>").slice(0, 200) : `HTTP ${res.status}`;
    throw new TelegramError(method, Number(data?.error_code ?? res.status) || 0, said);
  }
  return data.result;
}

// ---- Language -----------------------------------------------------------------------------

type Lang = "ru" | "en";
export const lang = (language: string): Lang => (language === "ru" ? "ru" : "en");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day(date: string, l: Lang): string {
  const [, m, d] = date.split("-");
  return l === "ru" ? `${d}.${m}` : `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

function percent(x: number): string {
  const v = Math.round(x * 100);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}%`;
}

const T = {
  ru: {
    head: (p: string) => `Lure · ${p}`,
    news: "Новости:",
    needs: "Требует вас:",
    live: (pg: string, d: string) => `${pg} — изменение на странице (видно с ${d})`,
    crawled: (pg: string, c: string, a: string, b: string, end: string) => `${pg} — Google пересканировал ${c}, замер с ${a} по ${b}, итог около ${end}`,
    labels: { noticeable_gain: "заметный рост", no_signal: "нет сигнала", worse: "хуже", insufficient_history: "мало истории для вердикта" } as Record<string, string>,
    metric: { impressions: "показы", clicks: "клики", position: "позиция" } as Record<string, string>,
    toControls: "к контрольным",
    past: (k: string, m: string) => `сдвиг такого размера был в ${k} из ${m} прошлых периодов`,
    unreliable: "трафика мало, вердикт ненадёжен",
    update: (n: string) => `новый апдейт Google: ${n}`,
    updateEnded: (n: string) => `апдейт Google обновлён: ${n}`,
    overdue: (pg: string, d: string) => `${pg} — выкатка просрочена (план ${d})`,
    signin: "вход в Search Console истёк или не настроен — запустите /lure:search-console",
    errors: (n: number) => `проверка закончилась с ошибками (${n}) — откройте /lure:check`,
    denied: "нет доступа к папке продукта (macOS не пускает фоновые задачи в Documents, Desktop и Downloads) — откройте /lure:check",
    failed: "проверка не прошла — откройте /lure:check",
    question: (n: string, pg: string) => `${n}${pg} не открывается для Lure. Когда изменение вышло на сайт? Ответьте кнопкой.`,
    today: "Сегодня", yesterday: "Вчера", other: "Другая дата",
    digest: "Всё идёт. Ждём:",
    digestNone: "Всё идёт. Активных гипотез нет.",
    waitLive: (pg: string, d: string) => `${pg} — выкатки (план ${d})`,
    waitCrawl: (pg: string) => `${pg} — пересканирования Google`,
    waitResult: (pg: string, d: string) => `${pg} — итога около ${d}`,
    askDate: (pg: string) => `Дата выкатки ${pg} в формате ГГГГ-ММ-ДД`,
    recorded: (pg: string, d: string) => `Записал: ${pg} выкачено ${d}`,
    refused: (pg: string, why: string) => `Не записал дату для ${pg}: ${why}`,
    future: "дата в будущем",
    beforeRecorded: "она раньше записи гипотезы",
    beforeAbsent: "в этот день проверка ещё не видела изменения на странице",
    closed: "дату уже нельзя изменить",
    fallback: (p: string) => `есть новости по ${p} — откройте /lure:check`,
    connected: (ps: string) => `Lure подключён к: ${ps}`,
    connectedNone: "Lure подключён. Продуктов пока нет.",
    paired: "Lure: этот чат привязан. Сюда будут приходить новости проверки.",
  },
  en: {
    head: (p: string) => `Lure · ${p}`,
    news: "News:",
    needs: "Needs you:",
    live: (pg: string, d: string) => `${pg} — the change is on the page (seen since ${d})`,
    crawled: (pg: string, c: string, a: string, b: string, end: string) => `${pg} — Google re-crawled it on ${c}; measuring ${a} to ${b}, result around ${end}`,
    labels: { noticeable_gain: "noticeable gain", no_signal: "no signal", worse: "worse", insufficient_history: "not enough history for a verdict" } as Record<string, string>,
    metric: { impressions: "impressions", clicks: "clicks", position: "position" } as Record<string, string>,
    toControls: "against the controls",
    past: (k: string, m: string) => `a shift this size happened in ${k} of ${m} past periods`,
    unreliable: "too little traffic, the verdict is unreliable",
    update: (n: string) => `new Google update: ${n}`,
    updateEnded: (n: string) => `Google update changed: ${n}`,
    overdue: (pg: string, d: string) => `${pg} — the change is overdue (planned for ${d})`,
    signin: "the Search Console sign-in expired or is missing — run /lure:search-console",
    errors: (n: number) => `the check finished with errors (${n}) — open /lure:check`,
    denied: "no access to the product's folder (macOS keeps background jobs out of Documents, Desktop and Downloads) — open /lure:check",
    failed: "the check did not run — open /lure:check",
    question: (n: string, pg: string) => `${n}${pg} does not open for Lure. When did the change reach the site? Answer with a button.`,
    today: "Today", yesterday: "Yesterday", other: "Another date",
    digest: "All is well. Waiting for:",
    digestNone: "All is well. No active hypotheses.",
    waitLive: (pg: string, d: string) => `${pg} — the change to go live (planned for ${d})`,
    waitCrawl: (pg: string) => `${pg} — Google to re-crawl it`,
    waitResult: (pg: string, d: string) => `${pg} — the result, around ${d}`,
    askDate: (pg: string) => `The date ${pg} went live, as YYYY-MM-DD`,
    recorded: (pg: string, d: string) => `Recorded: ${pg} live since ${d}`,
    refused: (pg: string, why: string) => `Did not record the date for ${pg}: ${why}`,
    future: "the date is in the future",
    beforeRecorded: "it is before the hypothesis was recorded",
    beforeAbsent: "on that day the check still saw the page without the change",
    closed: "the date can no longer change",
    fallback: (p: string) => `news for ${p} — open /lure:check`,
    connected: (ps: string) => `Lure is connected to: ${ps}`,
    connectedNone: "Lure is connected. No products yet.",
    paired: "Lure: this chat is paired. The check's news will come here.",
  },
};

// The page's path: the domain is the person's business, and the path is enough to know it.
export function pathOf(url: unknown): string {
  try {
    const u = new URL(String(url));
    return u.pathname + u.search;
  } catch {
    return "(page)";
  }
}

// ---- Composing a message ------------------------------------------------------------------

export type Button = { text: string; callback_data: string };
export type ComposeReport = {
  at?: string;
  errors: string[];
  events: string[];
  hypotheses: HypReport[];
  failure?: string;     // the run could not check this workspace (from last-run's reason)
};
export type Composed = {
  text: string;
  buttons: Button[][];
  said: string[];
  questions: Question[];
  digest: boolean;         // nothing new: the Monday digest (open questions ride along)
};

const SIGNIN = /^Search Console: .*(expired|revoked)|^no Search Console account/;

// What needs the person now, as keys; `said` holds the ones already told. Date questions are
// not keys: they are repeated until answered.
export function needs(report: ComposeReport): string[] {
  const keys: string[] = [];
  for (const h of report.hypotheses) if (h.status === "planned" && h.overdue) keys.push(`overdue:${h.id}`);
  if (report.errors.some((e) => SIGNIN.test(e))) keys.push("signin");
  if (report.errors.some((e) => !SIGNIN.test(e))) keys.push("errors");
  if (report.failure) keys.push(/no access/.test(report.failure) ? "access" : "failed");
  return keys;
}

const ymd = (date: string) => date.replaceAll("-", "");

export function buttonsFor(ws: number, questions: Question[], language: string): Button[][] {
  const t = T[lang(language)];
  return questions.map((q) => {
    const p = q.n !== undefined ? `${q.n} · ` : "";
    const y = addDays(q.asked_on, -1);
    return [
      { text: `${p}${t.today}, ${day(q.asked_on, lang(language))}`, callback_data: `l:${ws}:${q.q}:${ymd(q.asked_on)}` },
      { text: `${p}${t.yesterday}, ${day(y, lang(language))}`, callback_data: `l:${ws}:${q.q}:${ymd(y)}` },
      { text: `${p}${t.other}`, callback_data: `l:${ws}:${q.q}:other` },
    ];
  });
}

function verdictLine(pg: string, v: any, l: Lang): string {
  const t = T[l];
  const label = t.labels[v?.label] ?? String(v?.label ?? "?");
  if (v?.label === "insufficient_history" || typeof v?.effect !== "number") return `${pg}: ${label}`;
  let line = `${pg}: ${label} — ${t.metric[v.metric] ?? ""} ${percent(v.effect)} ${t.toControls}`.replace(/ {2,}/g, " ");
  if (typeof v.low === "number" && typeof v.high === "number") line += ` (90%: ${percent(v.low)}…${percent(v.high)})`;
  const past = typeof v.past === "string" ? v.past.match(/^(\d+) of (\d+)$/) : null;
  if (past) line += `, ${t.past(past[1], past[2])}`;
  if (v.unreliable === true) line += `; ${t.unreliable}`;
  return line;
}

// The message for one workspace, or null when there is nothing to say. Everything comes in as
// arguments (`newId` makes question ids; random by default). Only paths, labels, percentages
// and dates go out — never absolute counts, error texts, e-mails or hypothesis ids.
//
// A message goes out for news, for something new that needs the person, for a date question
// asked for the first time, or for the Monday digest after a silent week. A question already
// asked does not send a message by itself: it rides along with the next one.
export function compose(
  product: string, report: ComposeReport, notice: Notice, today: string, language: string,
  extra: { ws?: number; newId?: () => string } = {},
): Composed | null {
  const l = lang(language);
  const t = T[l];
  const ws = extra.ws ?? 0;
  const newId = extra.newId ?? (() => `q${makeCode(QUESTION_ID_LENGTH)}`);

  const news: string[] = [];
  for (const h of report.hypotheses) {
    const pg = pathOf(h.page);
    for (const c of h.changes) {
      if (c === "live" && h.live_on) news.push(t.live(pg, day(h.live_on, l)));
      if (c === "crawled" && h.crawled_on && h.after_window && h.check_on) {
        news.push(t.crawled(pg, day(h.crawled_on, l), day(h.after_window.from, l), day(h.after_window.to, l), day(h.check_on, l)));
      }
      if (c === "measured" && h.verdict) news.push(verdictLine(pg, h.verdict, l));
    }
  }
  for (const e of report.events) {
    const m = e.match(/^(added|updated): (.+)$/);
    if (m) news.push(m[1] === "added" ? t.update(m[2]) : t.updateEnded(m[2]));
  }

  const keys = needs(report);
  const fresh = keys.filter((k) => !notice.said.includes(k));
  const needLines: string[] = [];
  for (const k of fresh) {
    if (k.startsWith("overdue:")) {
      const h = report.hypotheses.find((x) => `overdue:${x.id}` === k)!;
      needLines.push(t.overdue(pathOf(h.page), h.planned_live ? day(h.planned_live, l) : "?"));
    } else if (k === "signin") needLines.push(t.signin);
    else if (k === "errors") needLines.push(t.errors(report.errors.filter((e) => !SIGNIN.test(e)).length));
    else if (k === "access") needLines.push(t.denied);
    else if (k === "failed") needLines.push(t.failed);
  }

  // Open date questions: kept by hypothesis, so a repeated question keeps its id, its earlier
  // messages and a pending "another date".
  const asking = report.hypotheses.filter((h) => h.status === "planned" && h.needs_date);
  const taken = new Set(notice.questions.map((q) => q.q));
  let firstAsked = 0;
  const questions: Question[] = asking.map((h, i) => {
    const old = notice.questions.find((q) => q.hypothesis === h.id);
    let id = old?.q;
    if (!id) {
      firstAsked++;
      do { id = newId(); } while (taken.has(id));
      taken.add(id);
    }
    const q: Question = { q: id, hypothesis: h.id, page: pathOf(h.page), asked_on: today, message_ids: old?.message_ids ?? [] };
    if (asking.length > 1) q.n = i + 1;
    if (old?.reply_id !== undefined) q.reply_id = old.reply_id;
    if (old?.shown) q.shown = old.shown;
    return q;
  });

  const monday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1;
  const quietWeek = notice.last_sent === null || notice.last_sent < addDays(today, -6);
  const nothingNew = news.length === 0 && needLines.length === 0 && firstAsked === 0;
  const digest = nothingNew && monday && quietWeek;
  if (nothingNew && !digest) return null;

  const parts: string[] = [t.head(product)];
  if (news.length) parts.push([t.news, ...news.map((x) => `• ${x}`)].join("\n"));
  if (needLines.length || questions.length) {
    parts.push([t.needs, ...needLines.map((x) => `• ${x}`),
      ...questions.map((q) => `• ${t.question(q.n !== undefined ? `${q.n}) ` : "", q.page)}`)].join("\n"));
  }
  if (digest) {
    const waits: string[] = [];
    for (const h of report.hypotheses) {
      const pg = pathOf(h.page);
      if (h.status === "planned") waits.push(t.waitLive(pg, h.planned_live ? day(h.planned_live, l) : "?"));
      else if (h.status === "live" && !h.crawled_on) waits.push(t.waitCrawl(pg));
      else if (h.status === "live") waits.push(t.waitResult(pg, h.check_on ? day(h.check_on, l) : "?"));
    }
    parts.push(waits.length ? [t.digest, ...waits.map((x) => `• ${x}`)].join("\n") : t.digestNone);
  }
  return { text: parts.join("\n\n"), buttons: buttonsFor(ws, questions, language), said: keys, questions, digest };
}

// Parts of at most `max` characters, cut at line ends where possible.
export function splitText(text: string, max = MAX_TEXT): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > max) {
      if (cur) { out.push(cur); cur = ""; }
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    const joined = cur ? `${cur}\n${rest}` : rest;
    if (joined.length > max) { out.push(cur); cur = rest; } else cur = joined;
  }
  if (cur) out.push(cur);
  return out;
}

// ---- Sending ------------------------------------------------------------------------------

async function send(f: Fetch, bot: Bot, chat: number, text: string, buttons: Button[][] = []): Promise<number> {
  const parts = splitText(text);
  let id = 0;
  for (let i = 0; i < parts.length; i++) {
    const body: any = { chat_id: chat, text: parts[i], link_preview_options: { is_disabled: true } };
    if (i === parts.length - 1 && buttons.length) body.reply_markup = { inline_keyboard: buttons };
    id = (await call(f, bot.token, "sendMessage", body)).message_id;
  }
  return id;
}

// The macOS notification: osascript gets the text as arguments of `on run argv`, so nothing in
// it is ever parsed as a script, and execFile runs no shell.
export function osascriptArgs(text: string, title = "Lure"): string[] {
  return [
    "-e", "on run argv",
    "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e", "end run",
    text, title,
  ];
}

// ---- Answers from the owner ---------------------------------------------------------------

export type PollResult = { paired: boolean; applied: number; refused: number; ignored: number; errors: number };

type PollContext = { d: NotifyDeps; bot: Bot; owner: Owner; list: string[]; r: PollResult };

async function quietly(p: Promise<unknown>): Promise<void> {
  try { await p; } catch { /* a stale answerCallbackQuery or an edit of an old message: no matter */ }
}

async function apply(ctx: PollContext, ws: number, question: Question, date: string, callbackId: string | null): Promise<void> {
  const { d, bot, owner } = ctx;
  const dir = ctx.list[ws];
  const language = settings(dir).language;
  const t = T[lang(language)];
  const notice = readNotice(dir);
  try {
    applyLive(dir, question.hypothesis, date, d.today, "said by the person in Telegram");
  } catch (e) {
    if (!(e instanceof MetricsError)) throw e;
    const m = e.message;
    const why = /in the future/.test(m) ? t.future : /before the hypothesis was recorded/.test(m) ? t.beforeRecorded : /without the marker/.test(m) ? t.beforeAbsent : t.closed;
    if (why === t.closed) {
      notice.questions = notice.questions.filter((q) => q.q !== question.q);
      writeNotice(dir, notice);
    }
    ctx.r.refused++;
    if (callbackId) await quietly(call(d.fetch, bot.token, "answerCallbackQuery", { callback_query_id: callbackId }));
    await send(d.fetch, bot, owner.chat_id, t.refused(question.page, why));
    return;
  }
  ctx.r.applied++;
  notice.questions = notice.questions.filter((q) => q.q !== question.q);
  writeNotice(dir, notice);
  if (callbackId) await quietly(call(d.fetch, bot.token, "answerCallbackQuery", { callback_query_id: callbackId }));
  // Every message that asked this question loses its buttons; the other questions of such a
  // message keep theirs.
  for (const id of question.message_ids) {
    // Each remaining question is labelled as this message showed it, not as the latest did.
    const rest = notice.questions.filter((q) => q.message_ids.includes(id)).map((q) => {
      const was = q.shown?.[String(id)];
      return was ? { ...q, n: was.n, asked_on: was.asked_on } : q;
    });
    await quietly(call(d.fetch, bot.token, "editMessageReplyMarkup", {
      chat_id: owner.chat_id, message_id: id,
      reply_markup: { inline_keyboard: buttonsFor(ws, rest, language) },
    }));
  }
  await send(d.fetch, bot, owner.chat_id, t.recorded(question.page, day(date, lang(language))));
}

async function handleUpdate(ctx: PollContext, u: any): Promise<void> {
  const { owner, d, bot } = ctx;
  const cq = u?.callback_query;
  if (cq) {
    if (cq.from?.id !== owner.user_id || cq.message?.chat?.id !== owner.chat_id) { ctx.r.ignored++; return; }
    const m = typeof cq.data === "string" ? cq.data.match(CALLBACK) : null;
    const ws = m ? Number(m[1]) : -1;
    const dir = m ? ctx.list[ws] : undefined;
    // The question must be open and this button must sit in a message that asked it.
    const question = dir
      ? readNotice(dir).questions.find((q) => q.q === m![2] && q.message_ids.includes(cq.message?.message_id))
      : undefined;
    if (!m || !dir || !question) {
      ctx.r.ignored++;
      await quietly(call(d.fetch, bot.token, "answerCallbackQuery", { callback_query_id: cq.id }));
      return;
    }
    if (m[3] === "other") {
      const t = T[lang(settings(dir).language)];
      const sent = await call(d.fetch, bot.token, "sendMessage", {
        chat_id: owner.chat_id, text: t.askDate(question.page),
        reply_markup: { force_reply: true, input_field_placeholder: "YYYY-MM-DD" },
      });
      const notice = readNotice(dir);
      const q = notice.questions.find((x) => x.q === question.q);
      if (q) { q.reply_id = sent.message_id; writeNotice(dir, notice); }
      await quietly(call(d.fetch, bot.token, "answerCallbackQuery", { callback_query_id: cq.id }));
      return;
    }
    const date = `${m[3].slice(0, 4)}-${m[3].slice(4, 6)}-${m[3].slice(6)}`;
    if (!isDate(date)) { ctx.r.ignored++; return; }
    await apply(ctx, ws, question, date, cq.id);
    return;
  }
  const msg = u?.message;
  if (msg) {
    const reply = msg.reply_to_message?.message_id;
    if (msg.from?.id !== owner.user_id || msg.chat?.id !== owner.chat_id || !Number.isInteger(reply) || typeof msg.text !== "string") {
      ctx.r.ignored++;
      return;
    }
    for (let ws = 0; ws < ctx.list.length; ws++) {
      const question = readNotice(ctx.list[ws]).questions.find((q) => q.reply_id === reply);
      if (!question) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(msg.text) || !isDate(msg.text)) { ctx.r.ignored++; return; }
      await apply(ctx, ws, question, msg.text, null);
      return;
    }
  }
  ctx.r.ignored++;
}

// Reads every pending update and applies the owner's answers. The offset moves past every
// update read, accepted or not, so nothing piles up. Nothing of a message is kept or printed;
// the number of ignored ones is added to ~/.lure/telegram/ignored.json for /lure:check.
export async function poll(d: NotifyDeps): Promise<PollResult> {
  const r: PollResult = { paired: false, applied: 0, refused: 0, ignored: 0, errors: 0 };
  const bot = readBot(d.lureHome), owner = readOwner(d.lureHome);
  if (!bot || !owner) return r;
  r.paired = true;
  const ctx: PollContext = { d, bot, owner, list: registry(d.lureHome), r };
  let offset = readOffset(d.lureHome);
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      let updates: any[];
      try {
        updates = await call(d.fetch, bot.token, "getUpdates", { offset, timeout: 0, allowed_updates: ALLOWED_UPDATES });
      } catch {
        r.errors++;
        break;
      }
      if (!Array.isArray(updates) || updates.length === 0) break;
      for (const u of updates) {
        try {
          await handleUpdate(ctx, u);
        } catch {
          r.errors++;
        } finally {
          if (Number.isInteger(u?.update_id) && u.update_id >= offset) offset = u.update_id + 1;
          saveOffset(d.lureHome, offset);
        }
      }
    }
  } finally {
    addIgnored(d.lureHome, r.ignored);
  }
  return r;
}

// ---- After a check run --------------------------------------------------------------------

export type NotifyResult = { sent: number; fallback: number; errors: number; applied: number; ignored: number };
type Outcome = "none" | "sent" | "fallback" | "failed" | "fallback-after-error";

export async function notify(run: RunResult, d: NotifyDeps): Promise<NotifyResult> {
  const res: NotifyResult = { sent: 0, fallback: 0, errors: 0, applied: 0, ignored: 0 };
  const bot = readBot(d.lureHome), owner = readOwner(d.lureHome);
  if (bot && owner) {
    const p = await poll(d);
    res.applied = p.applied;
    res.ignored = p.ignored;
    res.errors += p.errors;
  }
  const list = registry(d.lureHome);
  for (const w of run.workspaces) {
    try {
      const out = await notifyWorkspace(w, run, list.indexOf(w.path), bot && owner ? { bot, owner } : null, d);
      if (out === "sent") res.sent++;
      if (out === "fallback") res.fallback++;
      if (out === "failed") res.errors++;
      if (out === "fallback-after-error") { res.errors++; res.fallback++; }
    } catch {
      res.errors++;
    }
  }
  return res;
}

async function notifyWorkspace(
  w: RunSummary, run: RunResult, ws: number, tg: { bot: Bot; owner: Owner } | null, d: NotifyDeps,
): Promise<Outcome> {
  let report: ComposeReport | null = null;
  if (w.reason) report = { errors: [], events: [], hypotheses: [], failure: w.reason };
  else {
    const last = readJson(join(w.path, ".lure", "check-last.json"));
    // Only this run's report is news: a skipped workspace keeps yesterday's file.
    if (!last || typeof last.at !== "string" || last.at < run.at) return "none";
    report = {
      at: last.at,
      errors: Array.isArray(last.errors) ? last.errors : [],
      events: Array.isArray(last.events) ? last.events : [],
      hypotheses: Array.isArray(last.hypotheses) ? last.hypotheses : [],
    };
  }
  // The poll at the start of notify may have just applied a date the person gave: that
  // hypothesis is no longer waiting for one, whatever the report written before it says.
  if (!report.failure) {
    const statusOf = new Map<string, string>();
    try { for (const h of readHypotheses(w.path)) statusOf.set(String(h.header.id), String(h.header.status)); } catch { /* keep the report */ }
    report.hypotheses = report.hypotheses.map((h) =>
      h.needs_date && statusOf.has(h.id) && statusOf.get(h.id) !== "planned" ? { ...h, needs_date: false } : h);
  }
  const s = settings(w.path);
  const product = productName(w.path, d.lureHome);
  const notice = readNotice(w.path);
  const save = (n: Notice) => { try { writeNotice(w.path, n); } catch { /* a folder we cannot write: it is said again */ } };
  const message = compose(product, report, notice, d.today, s.language, { ws: Math.max(ws, 0) });
  if (message && report.failure) {
    // A run that could not look into the workspace knows nothing of its hypotheses: what was
    // said and asked before stays as it was.
    message.said = [...new Set([...notice.said, ...message.said])];
    message.questions = notice.questions;
    message.buttons = [];
  }
  if (!message) {
    if (report.failure) return "none";
    // Nothing to send: forget what cleared; keep the open questions for the next message.
    const keys = needs(report);
    const open = new Set(report.hypotheses.filter((h) => h.status === "planned" && h.needs_date).map((h) => h.id));
    const next = { ...notice, said: notice.said.filter((k) => keys.includes(k)), questions: notice.questions.filter((q) => open.has(q.hypothesis)) };
    if (JSON.stringify(next) !== JSON.stringify(notice)) save(next);
    return "none";
  }
  // Buttons only for a workspace the registry knows: their number is its place there.
  const buttons = ws >= 0 ? message.buttons : [];
  const delivered = (messageId: number | null): Notice => ({
    last_sent: d.today,
    last_digest: message.digest ? d.today : notice.last_digest,
    said: message.said,
    questions: message.questions.map((q) => {
      if (messageId === null || !buttons.length) return q;
      const ids = [...q.message_ids, messageId].slice(-MAX_MESSAGE_IDS);
      const shown: NonNullable<Question["shown"]> = {};
      for (const id of ids) {
        const was = id === messageId ? undefined : q.shown?.[String(id)];
        if (was) shown[String(id)] = was;
      }
      shown[String(messageId)] = q.n !== undefined ? { n: q.n, asked_on: q.asked_on } : { asked_on: q.asked_on };
      return { ...q, message_ids: ids, shown };
    }),
  });
  let failed = false;
  if (tg) {
    try {
      save(delivered(await send(d.fetch, tg.bot, tg.owner.chat_id, message.text, buttons)));
      return "sent";
    } catch {
      failed = true;
    }
  }
  // The desktop notification only says there is news: a digest with nothing new is not.
  if (d.platform !== "darwin" || message.digest) return failed ? "failed" : "none";
  const t = T[lang(s.language)];
  try {
    await d.execFile("osascript", osascriptArgs(t.fallback(product)));
  } catch {
    return "failed";
  }
  // Told, though not through Telegram: it counts as sent, so it is not repeated.
  save(delivered(null));
  return failed ? "fallback-after-error" : "fallback";
}

// ---- Setting up ---------------------------------------------------------------------------

export function makeCode(length = CODE_LENGTH): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(32)) {
      if (b < 248 && out.length < length) out += alphabet[b % 62]; // 248 = 4 * 62: no bias
    }
  }
  return out;
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function setToken(d: NotifyDeps): Promise<string> {
  const token = (await d.readToken()).trim();
  if (!TOKEN_SHAPE.test(token)) throw new LureError("this does not look like a bot token from @BotFather (digits, a colon, then letters)");
  let me: any;
  try {
    me = await call(d.fetch, token, "getMe");
  } catch (e) {
    if (e instanceof TelegramError && (e.code === 401 || e.code === 404)) throw new LureError("Telegram did not accept this token");
    throw e;
  }
  if (!me?.is_bot || typeof me.username !== "string") throw new LureError("Telegram did not accept this token");
  writeSecret(botPath(d.lureHome), { token, username: me.username });
  return me.username;
}

// Binds the owner: the one who sends `/start <code>` in a private chat while this waits. The
// code is shown only on this machine, so whoever finds the bot by name cannot bind themselves.
export async function pair(d: NotifyDeps, minutes = 10, say: (s: string) => void = console.log): Promise<boolean> {
  const bot = readBot(d.lureHome);
  if (!bot) throw new LureError("no bot yet: run `notify.mts set-token` in your own terminal first");
  if (!(minutes > 0 && minutes <= 60)) throw new LureError("--minutes must be between 1 and 60");
  const code = makeCode();
  say(`Open this link on a device with your Telegram and press Start (the link works once, for ${minutes} min):`);
  say(`  https://t.me/${bot.username}?start=${code}`);
  const deadline = d.now().getTime() + minutes * 60_000;
  let offset = readOffset(d.lureHome);
  while (d.now().getTime() < deadline) {
    const wait = Math.max(1, Math.min(30, Math.floor((deadline - d.now().getTime()) / 1000)));
    const updates = await call(d.fetch, bot.token, "getUpdates", { offset, timeout: wait, allowed_updates: ALLOWED_UPDATES }, wait);
    for (const u of Array.isArray(updates) ? updates : []) {
      if (Number.isInteger(u?.update_id) && u.update_id >= offset) offset = u.update_id + 1;
      const m = u?.message;
      if (m && m.chat?.type === "private" && typeof m.text === "string" && sameCode(m.text, `/start ${code}`)
        && Number.isInteger(m.from?.id) && Number.isInteger(m.chat?.id)) {
        saveOffset(d.lureHome, offset);
        writeSecret(ownerPath(d.lureHome), { chat_id: m.chat.id, user_id: m.from.id, paired_on: d.today });
        await quietly(send(d.fetch, bot, m.chat.id, T[lang(firstLanguage(d.lureHome))].paired));
        return true;
      }
    }
    saveOffset(d.lureHome, offset);
  }
  return false;
}

function firstLanguage(home: string): string {
  const first = registry(home)[0];
  return first ? settings(first).language : "en";
}

export async function sendTest(d: NotifyDeps): Promise<void> {
  const bot = readBot(d.lureHome), owner = readOwner(d.lureHome);
  if (!bot || !owner) throw new LureError("Telegram is not set up: run set-token, then pair");
  const t = T[lang(firstLanguage(d.lureHome))];
  const names = registry(d.lureHome).map((ws) => productName(ws, d.lureHome));
  await send(d.fetch, bot, owner.chat_id, names.length ? t.connected(names.join(", ")) : t.connectedNone);
}

export function statusLines(home: string): string[] {
  const bot = readBot(home), owner = readOwner(home);
  const lines = [
    bot ? `bot: @${bot.username}` : "bot: not set up (run set-token in your own terminal)",
    owner ? `owner: paired on ${owner.paired_on}` : "owner: not paired",
  ];
  for (const ws of registry(home)) {
    let qs: Question[] = [];
    try { qs = readNotice(ws).questions; } catch { /* unreadable */ }
    if (qs.length) lines.push(`${ws}: ${qs.length} open question(s): ${qs.map((q) => q.page).join(", ")}`);
  }
  return lines;
}

export function unpair(home: string, forgetToken: boolean): string[] {
  const done: string[] = [];
  for (const p of [ownerPath(home), offsetPath(home), ...(forgetToken ? [botPath(home)] : [])]) {
    if (existsSync(p)) { rmSync(p, { force: true }); done.push(`deleted ${p}`); }
  }
  if (!done.length) done.push("nothing to remove");
  return done;
}

// The token, typed with echo off. Only from a terminal: a token piped in passes through
// whatever piped it — a shell history, or an agent.
export async function readHidden(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new LureError("set-token reads from a terminal only: run it in your own terminal, not through an agent");
  process.stderr.write("Bot token from @BotFather (hidden): ");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise<string>((ok, fail) => {
    let value = "";
    const done = (e?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (e) fail(e); else ok(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new LureError("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// ---- Command line -------------------------------------------------------------------------

const USAGE = "usage: notify.mts set-token | pair [--minutes 10] | test | poll | status | unpair [--forget-token]";

export async function main(argv: string[], deps: Partial<NotifyDeps> = {}): Promise<number> {
  if (nodeTooOld(process.versions.node)) {
    console.error(`Lure needs Node ${MIN_NODE} or newer; this is ${process.versions.node}.`);
    return 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true,
      options: { minutes: { type: "string" }, "forget-token": { type: "boolean" } },
    });
  } catch {
    console.error(USAGE);
    return 2;
  }
  const d: NotifyDeps = { ...defaultNotifyDeps(), ...deps };
  try {
    switch (parsed.positionals[0]) {
      case "set-token": {
        const name = await setToken(d);
        console.log(`bot: @${name}`);
        return 0;
      }
      case "pair": {
        const minutes = parsed.values.minutes === undefined ? 10 : Number(parsed.values.minutes);
        const ok = await pair(d, minutes);
        console.log(ok ? "paired" : "no matching /start arrived in time; run pair again");
        return ok ? 0 : 1;
      }
      case "test":
        await sendTest(d);
        console.log("sent");
        return 0;
      case "poll": {
        const r = await poll(d);
        if (!r.paired) { console.log("Telegram is not set up"); return 0; }
        // Ignored since the last /lure:check: the scheduled runs' and this poll's, then reset.
        console.log(`applied ${r.applied}, refused ${r.refused}, ignored ${takeIgnored(d.lureHome)}, errors ${r.errors}`);
        return r.errors ? 1 : 0;
      }
      case "status":
        for (const l of statusLines(d.lureHome)) console.log(l);
        return 0;
      case "unpair":
        for (const l of unpair(d.lureHome, parsed.values["forget-token"] === true)) console.log(l);
        return 0;
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof LureError) {
      console.error(`lure: ${e.message}`);
      return 1;
    }
    // Anything else may quote a request: say only what kind of failure it was.
    console.error(`lure: ${e instanceof Error ? e.name : "error"} in notify.mts`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
