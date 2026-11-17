import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  API, MAX_TEXT, compose, splitText, notify, poll, pair, main, osascriptArgs, makeCode, readNotice,
  writeNotice, botPath, ownerPath, offsetPath,
} from "../plugins/lure/scripts/notify.mts";
import type { ComposeReport, Notice, NotifyDeps } from "../plugins/lure/scripts/notify.mts";
import { INCIDENTS, runAll } from "../plugins/lure/scripts/check.mts";
import type { Deps, HypReport, RunResult } from "../plugins/lure/scripts/check.mts";
import { addDays, readHypotheses, record } from "../plugins/lure/scripts/metrics.mts";

// Synthetic data only: example.com pages, a made-up bot token and made-up Telegram ids. Nothing
// here reaches Telegram, the real ~/.lure or osascript: fetch and execFile are fakes, and the
// Lure home is a temporary folder.
const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijk";
const BOT = "lure_test_bot";
const OWNER = { chat_id: 1001, user_id: 2002, paired_on: "2026-08-01" };
const STRANGER = 3003;
const A = "https://example.com/a/";
const B = "https://example.com/b/";
const C = "https://example.com/c/";
const D = "https://example.com/d/";
const RECORDED = "2026-07-20";
const ID = `${RECORDED}-new-title`;
const TODAY = "2026-08-10";

let ws = "";
let home = "";

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "lure-notify-ws-"));
  home = mkdtempSync(join(tmpdir(), "lure-notify-home-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ---- Fixtures -----------------------------------------------------------------------------

function writeWorkspace(language = "ru"): void {
  writeFileSync(join(ws, "lure.yaml"),
    `lure: 1\nproduct: shop\nsite: https://example.com\nlanguage: ${language}\nmetrics:\n  search_console:\n    property: https://example.com/\n`);
  mkdirSync(join(ws, ".lure"), { recursive: true });
  writeFileSync(join(ws, ".lure", "search-console.yaml"), "account: someone@example.com\n");
  const rows = ["date,page,clicks,impressions,ctr,position"];
  const site = ["date,clicks,impressions,ctr,position"];
  for (let i = 0; i < 400; i++) {
    const date = addDays("2025-09-01", i);
    for (const page of [A, B, C, D]) rows.push([date, page, 10 + (i % 7), 200 + (i % 5), 0.05, 12].join(","));
    site.push([date, 40, 800, 0.05, 12].join(","));
  }
  mkdirSync(join(ws, "search-console"), { recursive: true });
  writeFileSync(join(ws, "search-console", "pages-daily.csv"), rows.join("\n") + "\n");
  writeFileSync(join(ws, "search-console", "site-daily.csv"), site.join("\n") + "\n");
  record(ws, {
    slug: "new-title", page: A, change: "Rewrite the title", planned_live: "2026-08-01", metric: "clicks",
    expected: "up", floor: "measurable", floor_reason: "about 200 impressions a day", live_marker: "Brand new title",
    before: { title: "Old title", h1: "Old h1", description: "Old description" },
    controls: [B, C, D], sections: [{ heading: "Why", text: "Because." }], recorded: RECORDED,
  }, RECORDED);
  writeFileSync(join(home, "workspaces.yaml"), `workspaces:\n  - product: shop\n    path: ${ws}\n`);
}

function writeTelegram(withOwner = true): void {
  mkdirSync(join(home, "telegram"), { recursive: true });
  writeFileSync(botPath(home), JSON.stringify({ token: TOKEN, username: BOT }));
  if (withOwner) writeFileSync(ownerPath(home), JSON.stringify(OWNER));
}

const question = (over: Partial<Notice["questions"][0]> = {}) => ({ q: "q1", hypothesis: ID, page: "/a/", asked_on: "2026-08-09", message_ids: [50], ...over });
const emptyNotice = (): Notice => ({ last_sent: null, last_digest: null, said: [], questions: [] });
const hdr = () => readHypotheses(ws).find((h) => h.header.id === ID)!.header as any;

type Call = { method: string; body: any };
type Fake = {
  updates?: any[][];               // one batch per getUpdates call; then empty
  fail?: Record<string, { code: number; description: string }>;
  throwOn?: string;                // a method whose fetch throws, quoting the URL
};

function telegram(f: Fake = {}, calls: Call[] = []): typeof fetch {
  let batch = 0, nextId = 100;
  return (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const prefix = `${API}/bot${TOKEN}/`;
    if (!url.startsWith(prefix)) throw new Error("unexpected fetch");
    const method = url.slice(prefix.length);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, body });
    if (f.throwOn === method) throw new TypeError(`fetch failed for ${url}`);
    const fail = f.fail?.[method];
    if (fail) return new Response(JSON.stringify({ ok: false, error_code: fail.code, description: fail.description }), { status: fail.code });
    let result: any = true;
    if (method === "getUpdates") {
      const all = f.updates ?? [];
      result = (all[batch++] ?? []).filter((u: any) => u.update_id >= (body.offset ?? 0));
    }
    if (method === "sendMessage") result = { message_id: nextId++ };
    if (method === "getMe") result = { id: 42, is_bot: true, username: BOT };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
}

function nd(over: Partial<NotifyDeps> = {}): NotifyDeps {
  return {
    fetch: telegram(),
    today: TODAY,
    now: () => new Date("2026-08-10T08:00:00Z"),
    lureHome: home,
    platform: "linux",
    execFile: async () => { throw new Error("execFile not expected"); },
    readToken: async () => TOKEN,
    ...over,
  };
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const log = console.log, error = console.error;
  const out: string[] = [], err: string[] = [];
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  try {
    return { result: await fn(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const cb = (update_id: number, data: string, from = OWNER.user_id, chat = OWNER.chat_id, message_id = 50) =>
  ({ update_id, callback_query: { id: `cb${update_id}`, from: { id: from }, data, message: { message_id, chat: { id: chat } } } });
// Question ids are random; tests that read them pass a counter instead.
const ids = () => { let i = 0; return () => `q${++i}`; };
const msg = (update_id: number, text: string, opts: { from?: number; chat?: number; reply?: number; type?: string } = {}) =>
  ({
    update_id,
    message: {
      message_id: 900 + update_id, text, from: { id: opts.from ?? OWNER.user_id },
      chat: { id: opts.chat ?? OWNER.chat_id, type: opts.type ?? "private" },
      ...(opts.reply !== undefined ? { reply_to_message: { message_id: opts.reply } } : {}),
    },
  });

// ---- compose ------------------------------------------------------------------------------

const VERDICT = {
  label: "no_signal", metric: "impressions", expected: "up", effect: 0.18, low: -0.09, high: 0.52,
  past: "9 of 40", placebos: 40, unreliable: false,
  page: { before: 12345, after: 23456 }, controls: { before: 98765, after: 87654 },
  per_control: [{ page: B, effect: 0.01 }], clicks: { effect: 0.05, ctr: { before: 0.0123, after: 0.0456 } },
};

function report(over: Partial<ComposeReport> = {}, hyps: HypReport[] = []): ComposeReport {
  return { at: "2026-11-25T08:00:00Z", errors: [], events: [], hypotheses: hyps, ...over };
}

test("compose: every kind of news, in Russian, with paths, labels and percentages only", () => {
  const c = compose("shipstation", report({
    events: ["added: November 2026 core update"],
    errors: ["Search Console: the sign-in of someone@example.com has expired or was revoked; run auth again"],
  }, [
    { id: "h1", status: "live", changes: ["live"], page: "https://example.com/shipstation/", live_on: "2026-11-23" },
    { id: "h2", status: "live", changes: ["crawled"], page: "https://example.com/b/", live_on: "2026-11-20", crawled_on: "2026-11-25",
      after_window: { from: "2026-12-02", to: "2026-12-29" }, check_on: "2027-01-01" },
    { id: "h3", status: "measured", changes: ["measured"], page: "https://example.com/c/?x=1", verdict: VERDICT },
  ]), emptyNotice(), "2026-11-25", "ru")!;
  assert.ok(c);
  assert.match(c.text, /^Lure · shipstation/);
  assert.match(c.text, /\/shipstation\/ — изменение на странице \(видно с 23\.11\)/);
  assert.match(c.text, /\/b\/ — Google пересканировал 25\.11, замер с 02\.12 по 29\.12, итог около 01\.01/);
  assert.match(c.text, /\/c\/\?x=1: нет сигнала — показы \+18% к контрольным \(90%: −9%…\+52%\), сдвиг такого размера был в 9 из 40 прошлых периодов/);
  assert.match(c.text, /новый апдейт Google: November 2026 core update/);
  assert.match(c.text, /Search Console/);
  // No domain, e-mail, absolute count, hypothesis id or error prose.
  for (const bad of ["example.com", "someone@", "12345", "23456", "98765", "87654", "h1", "h2", "h3", "revoked", "0.0123"]) {
    assert.ok(!c.text.includes(bad), `"${bad}" leaked into the message`);
  }
  assert.deepEqual(c.buttons, []);
  assert.deepEqual(c.said, ["signin"]);
});

test("compose: English templates; an unknown language falls back to English", () => {
  const r = report({}, [{ id: "h1", status: "live", changes: ["live"], page: A, live_on: "2026-11-23" }]);
  assert.match(compose("shop", r, emptyNotice(), "2026-11-25", "en")!.text, /\/a\/ — the change is on the page \(seen since Nov 23\)/);
  assert.match(compose("shop", r, emptyNotice(), "2026-11-25", "de")!.text, /the change is on the page/);
});

test("compose: a date question has three buttons with short callback_data and a random id", () => {
  const h: HypReport = { id: ID, status: "planned", changes: [], page: A, planned_live: "2026-08-01", needs_date: true };
  const first = compose("shop", report({}, [h]), emptyNotice(), TODAY, "ru", { ws: 3 })!;
  assert.equal(first.questions.length, 1);
  const q = first.questions[0].q;
  assert.match(q, /^q[A-Za-z0-9]{6}$/);
  assert.match(first.text, /\/a\/ не открывается для Lure/);
  const data = first.buttons[0].map((b) => b.callback_data);
  assert.deepEqual(data, [`l:3:${q}:20260810`, `l:3:${q}:20260809`, `l:3:${q}:other`]);
  for (const d of data) assert.ok(Buffer.byteLength(d) < 64);
  assert.match(first.buttons[0][0].text, /Сегодня, 10\.08/);
  // Two at once are numbered.
  const two = compose("shop", report({}, [h, { ...h, id: "other", page: B }]), emptyNotice(), "2026-08-11", "en", { newId: ids() })!;
  assert.deepEqual(two.questions.map((x) => [x.q, x.n]), [["q1", 1], ["q2", 2]]);
  assert.match(two.buttons[1][0].text, /^2 · Today/);
});

test("compose: a question already asked sends no message by itself; it rides along with news and the Monday digest", () => {
  const h: HypReport = { id: ID, status: "planned", changes: [], page: A, planned_live: "2026-08-01", needs_date: true };
  const first = compose("shop", report({}, [h]), emptyNotice(), TODAY, "ru", { newId: ids() })!;
  const asked: Notice = { last_sent: TODAY, last_digest: null, said: first.said, questions: first.questions.map((q) => ({ ...q, message_ids: [50] })) };
  // Tuesday, nothing new: silence.
  assert.equal(compose("shop", report({}, [h]), asked, "2026-08-11", "ru"), null);
  // News on Wednesday: the question comes along, same id, new buttons, earlier messages kept.
  const news = compose("shop", report({}, [h, { id: "x", status: "live", changes: ["live"], page: B, live_on: "2026-08-11" }]), asked, "2026-08-12", "ru")!;
  assert.match(news.text, /\/a\/ не открывается для Lure/);
  assert.equal(news.questions[0].q, "q1");
  assert.deepEqual(news.questions[0].message_ids, [50]);
  assert.equal(news.buttons[0][0].callback_data, "l:0:q1:20260812");
  // The next Monday after a silent week: the digest, with the question.
  const monday = compose("shop", report({}, [h]), asked, "2026-08-17", "ru")!;
  assert.ok(monday.digest);
  assert.match(monday.text, /Всё идёт/);
  assert.match(monday.text, /\/a\/ не открывается для Lure/);
});

test("compose: needs-you is said once; a new one is said; a cleared one leaves `said`", () => {
  const overdue: HypReport = { id: ID, status: "planned", changes: ["waiting"], page: A, planned_live: "2026-07-01", overdue: true };
  const r = report({ errors: ["Google updates not refreshed: status 500"] }, [overdue]);
  const first = compose("shop", r, emptyNotice(), TODAY, "en")!;
  assert.match(first.text, /\/a\/ — the change is overdue \(planned for Jul 1\)/);
  assert.match(first.text, /the check finished with errors \(1\) — open \/lure:check/);
  assert.ok(!first.text.includes("status 500"));
  assert.deepEqual(first.said.sort(), ["errors", `overdue:${ID}`].sort());
  const notice: Notice = { ...emptyNotice(), last_sent: TODAY, said: first.said };
  assert.equal(compose("shop", r, notice, "2026-08-11", "en"), null);
  const more = compose("shop", report({ errors: [...r.errors, "no Search Console account in .lure/search-console.yaml"] }, [overdue]), notice, "2026-08-11", "en")!;
  assert.match(more.text, /Search Console sign-in/);
  assert.ok(!more.text.includes("overdue"));
});

test("compose: silence sends nothing; Monday after a silent week sends the digest", () => {
  const hs: HypReport[] = [
    { id: "p", status: "planned", changes: [], page: A, planned_live: "2026-12-01" },
    { id: "l", status: "live", changes: [], page: B, live_on: "2026-11-01" },
    { id: "c", status: "live", changes: [], page: C, live_on: "2026-11-01", crawled_on: "2026-11-05", check_on: "2026-12-20" },
  ];
  assert.equal(compose("shop", report({}, hs), emptyNotice(), "2026-11-17", "ru"), null);   // Tuesday
  const monday = compose("shop", report({}, hs), emptyNotice(), "2026-11-16", "ru")!;
  assert.ok(monday.digest);
  assert.match(monday.text, /Всё идёт\. Ждём:/);
  assert.match(monday.text, /\/a\/ — выкатки \(план 01\.12\)/);
  assert.match(monday.text, /\/b\/ — пересканирования Google/);
  assert.match(monday.text, /\/c\/ — итога около 20\.12/);
  const recent: Notice = { ...emptyNotice(), last_sent: "2026-11-12" };
  assert.equal(compose("shop", report({}, hs), recent, "2026-11-16", "ru"), null);
  const old: Notice = { ...emptyNotice(), last_sent: "2026-11-09" };
  assert.ok(compose("shop", report({}, hs), old, "2026-11-16", "ru")!.digest);
});

test("compose: a run that could not reach the folder says so", () => {
  const c = compose("shop", report({ failure: "no access (on macOS, background jobs cannot read Documents, Desktop or Downloads)" }), emptyNotice(), TODAY, "ru")!;
  assert.match(c.text, /нет доступа к папке продукта/);
  assert.deepEqual(c.said, ["access"]);
});

test("splitText: long text is cut into parts of at most 4000 characters, at line ends", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `• /page-${i}/ ${"x".repeat(40)}`);
  const parts = splitText(lines.join("\n"));
  assert.ok(parts.length >= 4);
  for (const p of parts) assert.ok(p.length <= MAX_TEXT);
  assert.equal(parts.join("\n"), lines.join("\n"));
  const one = splitText("y".repeat(MAX_TEXT * 2 + 5));
  assert.deepEqual(one.map((p) => p.length), [MAX_TEXT, MAX_TEXT, 5]);
});

// ---- pair ---------------------------------------------------------------------------------

function pairWorld(updatesFor: (code: string) => any[][]) {
  let code = "";
  const said: string[] = [];
  const say = (s: string) => { said.push(s); const m = s.match(/start=([A-Za-z0-9]+)/); if (m) code = m[1]; };
  const calls: Call[] = [];
  let batch = 0;
  const inner = (async (input: any, init?: RequestInit) => {
    const method = String(input).split("/").pop();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method: method!, body });
    const result = method === "getUpdates" ? (updatesFor(code)[batch++] ?? []) : { message_id: 1 };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { say, said, calls, fetch: inner, code: () => code };
}

test("pair: the exact /start <code> in a private chat binds the owner; strangers and wrong codes do not", async () => {
  writeTelegram(false);
  const w = pairWorld((code) => [
    [msg(1, "/start WRONGCODE0000000", { from: STRANGER, chat: STRANGER }), msg(2, `/start ${code}`, { type: "group", from: 7, chat: -5 }), msg(3, "hello")],
    [msg(4, `/start ${code}x`), msg(5, `/start ${code}`, { from: 2002, chat: 1001 })],
  ]);
  const ok = await pair(nd({ fetch: w.fetch }), 10, w.say);
  assert.equal(ok, true);
  assert.equal(w.code().length, 16);
  assert.match(w.code(), /^[A-Za-z0-9]{16}$/);
  assert.match(w.said.join("\n"), new RegExp(`https://t\\.me/${BOT}\\?start=`));
  assert.ok(!w.said.join("\n").includes(TOKEN));
  const owner = JSON.parse(readFileSync(ownerPath(home), "utf8"));
  assert.deepEqual(owner, { chat_id: 1001, user_id: 2002, paired_on: TODAY });
  assert.equal(JSON.parse(readFileSync(offsetPath(home), "utf8")).offset, 6);
  // getUpdates is a long poll, limited to what the person asked for.
  const gu = w.calls.find((c) => c.method === "getUpdates")!;
  assert.ok(gu.body.timeout > 0);
  assert.deepEqual(gu.body.allowed_updates, ["message", "callback_query"]);
});

test("pair: only a stranger's /start and a wrong code until the time is up: nobody is bound", async () => {
  writeTelegram(false);
  const w = pairWorld(() => [[msg(1, "/start WRONGCODE0000000"), msg(2, "/start", { from: STRANGER, chat: STRANGER })]]);
  let t = Date.parse("2026-08-10T08:00:00Z");
  const now = () => { t += 31_000; return new Date(t); };
  const ok = await pair(nd({ fetch: w.fetch, now }), 2, w.say);
  assert.equal(ok, false);
  assert.ok(!existsSync(ownerPath(home)));
  assert.equal(JSON.parse(readFileSync(offsetPath(home), "utf8")).offset, 3);
});

test("pair codes are 16 characters of A-Za-z0-9 and differ", () => {
  const codes = new Set(Array.from({ length: 50 }, makeCode));
  assert.equal(codes.size, 50);
  for (const c of codes) assert.match(c, /^[A-Za-z0-9]{16}$/);
});

// ---- poll ---------------------------------------------------------------------------------

function pollSetup(): void {
  writeWorkspace();
  writeTelegram();
  writeNotice(ws, { last_sent: "2026-08-09", last_digest: null, said: [], questions: [question()] });
}

test("poll: a button applies the date as the person's, journals it, confirms and removes the buttons", async () => {
  pollSetup();
  const calls: Call[] = [];
  const r = await poll(nd({ fetch: telegram({ updates: [[cb(10, `l:0:q1:20260803`)]] }, calls) }));
  assert.deepEqual(r, { paired: true, applied: 1, refused: 0, ignored: 0, errors: 0 });
  assert.equal(hdr().status, "live");
  assert.equal(hdr().live_on, "2026-08-03");
  assert.equal(hdr().live_source, "person");
  assert.match(readFileSync(join(ws, "journal.md"), "utf8"), /live since 2026-08-03 \(said by the person in Telegram\)/);
  assert.deepEqual(readNotice(ws).questions, []);
  const methods = calls.map((c) => c.method);
  assert.ok(methods.includes("answerCallbackQuery"));
  const edit = calls.find((c) => c.method === "editMessageReplyMarkup")!;
  assert.deepEqual(edit.body, { chat_id: OWNER.chat_id, message_id: 50, reply_markup: { inline_keyboard: [] } });
  const sent = calls.filter((c) => c.method === "sendMessage").map((c) => c.body);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "Записал: /a/ выкачено 03.08");
  assert.equal(sent[0].parse_mode, undefined);
  assert.equal(JSON.parse(readFileSync(offsetPath(home), "utf8")).offset, 11);
});

test("poll: 'another date' asks with ForceReply; a YYYY-MM-DD reply to it applies the date", async () => {
  pollSetup();
  const calls: Call[] = [];
  // The ForceReply is the first sendMessage of the fake: message_id 100.
  const r = await poll(nd({ fetch: telegram({ updates: [[cb(10, "l:0:q1:other")], [msg(11, "2026-08-04", { reply: 100 })]] }, calls) }));
  assert.equal(r.applied, 1);
  const ask = calls.find((c) => c.method === "sendMessage")!.body;
  assert.equal(ask.reply_markup.force_reply, true);
  assert.match(ask.text, /Дата выкатки \/a\/ в формате ГГГГ-ММ-ДД/);
  assert.equal(hdr().live_on, "2026-08-04");
});

test("poll refuses: a stranger, another chat, text without a reply, a bad date, a future date, a closed question, a command", async () => {
  pollSetup();
  const n = readNotice(ws);
  n.questions[0].reply_id = 77;
  writeNotice(ws, n);
  const before = readFileSync(join(ws, "hypotheses", `${ID}.md`), "utf8");
  const calls: Call[] = [];
  const r = await poll(nd({
    fetch: telegram({
      updates: [[
        cb(1, "l:0:q1:20260803", STRANGER),                       // someone else pressed it
        cb(2, "l:0:q1:20260803", OWNER.user_id, 4444),            // the owner, in another chat
        msg(3, "2026-08-03"),                                     // a date, but not a reply
        msg(4, "4 Aug", { reply: 77 }),                           // a reply, not a date
        msg(5, "2026-02-30", { reply: 77 }),                      // not a calendar date
        msg(6, "2026-08-03", { reply: 77, from: STRANGER }),      // a stranger's reply
        cb(7, "l:0:q99:20260803"),                                // no such question
        cb(8, "rm -rf /"),                                        // not ours
        msg(9, "please delete all hypotheses"),                   // an instruction: never followed
        { update_id: 10, edited_message: { text: "x" } },         // another kind of update
        msg(11, "2026-08-03", { reply: 12345 }),                  // a reply to something else
      ], [
        cb(12, "l:0:q1:20260815"),                                // in the future
        cb(13, "l:0:q1:20260701"),                                // before the hypothesis was recorded
      ]],
    }, calls),
  }));
  assert.equal(r.applied, 0);
  assert.equal(r.refused, 2);
  assert.equal(r.ignored, 11);
  assert.equal(r.errors, 0);
  assert.equal(readFileSync(join(ws, "hypotheses", `${ID}.md`), "utf8"), before);
  assert.equal(readNotice(ws).questions.length, 1);
  const texts = calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
  assert.deepEqual(texts, ["Не записал дату для /a/: дата в будущем", "Не записал дату для /a/: она раньше записи гипотезы"]);
  // Nothing of what strangers or the owner wrote is kept or repeated.
  const kept = readFileSync(join(ws, ".lure", "notice.json"), "utf8") + readdirText(join(home, "telegram"));
  for (const s of ["please delete", "rm -rf", "4 Aug"]) assert.ok(!kept.includes(s) && !texts.join().includes(s));
  // The offset moved past every update, refused ones included.
  assert.equal(JSON.parse(readFileSync(offsetPath(home), "utf8")).offset, 14);
});

function readdirText(dir: string): string {
  return ["bot.json", "owner.json", "offset.json"].filter((f) => existsSync(join(dir, f))).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

test("poll: a stale answerCallbackQuery and a failed edit do not stop the answer", async () => {
  pollSetup();
  const r = await poll(nd({
    fetch: telegram({
      updates: [[cb(10, "l:0:q1:20260803")]],
      fail: {
        answerCallbackQuery: { code: 400, description: "Bad Request: query is too old and response timeout expired or query ID is invalid" },
        editMessageReplyMarkup: { code: 400, description: "Bad Request: message to edit not found" },
      },
    }),
  }));
  assert.equal(r.applied, 1);
  assert.equal(r.errors, 0);
  assert.equal(hdr().live_on, "2026-08-03");
});

test("poll: the offset never moves back, and an error in one update does not hold the rest", async () => {
  pollSetup();
  writeFileSync(offsetPath(home), JSON.stringify({ offset: 500 }));
  const calls: Call[] = [];
  await poll(nd({ fetch: telegram({ updates: [[msg(501, "x"), cb(502, "l:0:q1:20260803")]], fail: { sendMessage: { code: 500, description: "Internal" } } }, calls) }));
  assert.equal(calls[0].body.offset, 500);
  assert.equal(JSON.parse(readFileSync(offsetPath(home), "utf8")).offset, 503);
  assert.equal(hdr().live_on, "2026-08-03");   // applied; only the confirmation failed
});

test("poll without a bot or an owner does nothing", async () => {
  writeWorkspace();
  const calls: Call[] = [];
  assert.equal((await poll(nd({ fetch: telegram({}, calls) }))).paired, false);
  writeTelegram(false);
  assert.equal((await poll(nd({ fetch: telegram({}, calls) }))).paired, false);
  assert.equal(calls.length, 0);
});

// ---- notify after a run -------------------------------------------------------------------

function writeReport(r: Partial<ComposeReport> & { at: string }): void {
  mkdirSync(join(ws, ".lure"), { recursive: true });
  writeFileSync(join(ws, ".lure", "check-last.json"), JSON.stringify({ workspace: ws, today: TODAY, errors: [], events: [], hypotheses: [], ...r }));
}

const RUN = (over: Partial<RunResult> = {}): RunResult => ({ at: "2026-08-10T08:00:00.000Z", workspaces: [{ path: ws, ok: true, errors: 0 }], errors: [], ...over });
const LIVE_NEWS = [{ id: ID, status: "live", changes: ["live"], page: A, live_on: "2026-08-09" }];

test("notify: sends news to the owner as plain text, splits a long one, and remembers it", async () => {
  writeWorkspace("en");
  writeTelegram();
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `h${i}`, status: "live", changes: ["live"], page: `https://example.com/${"p".repeat(20)}-${i}/`, live_on: "2026-08-09" }));
  writeReport({ at: "2026-08-10T08:00:01.000Z", hypotheses: [...many, { id: ID, status: "planned", changes: [], page: A, planned_live: "2026-08-01", needs_date: true }] });
  const calls: Call[] = [];
  const res = await notify(RUN(), nd({ fetch: telegram({}, calls) }));
  assert.equal(res.sent, 1);
  assert.equal(res.errors, 0);
  const sent = calls.filter((c) => c.method === "sendMessage").map((c) => c.body);
  assert.ok(sent.length >= 2);
  for (const s of sent) {
    assert.ok(s.text.length <= MAX_TEXT);
    assert.equal(s.parse_mode, undefined);
    assert.equal(s.chat_id, OWNER.chat_id);
  }
  assert.equal(sent.slice(0, -1).some((s) => s.reply_markup), false);
  const n = readNotice(ws);
  const q = n.questions[0].q;
  assert.deepEqual(sent.at(-1).reply_markup.inline_keyboard[0].map((b: any) => b.callback_data), [`l:0:${q}:20260810`, `l:0:${q}:20260809`, `l:0:${q}:other`]);
  assert.equal(n.last_sent, TODAY);
  assert.deepEqual(n.questions[0].message_ids, [100 + sent.length - 1]);
});

test("notify: yesterday's report is not news; nothing to say sends nothing", async () => {
  writeWorkspace();
  writeTelegram();
  writeReport({ at: "2026-08-09T08:00:00.000Z", hypotheses: LIVE_NEWS });
  const calls: Call[] = [];
  const res = await notify(RUN(), nd({ fetch: telegram({}, calls) }));
  assert.equal(res.sent, 0);
  // A Tuesday, so no weekly digest either (2026-08-10 is a Monday).
  writeReport({ at: "2026-08-10T08:00:01.000Z", hypotheses: [{ id: ID, status: "live", changes: [], page: A, live_on: "2026-08-09" }] });
  await notify(RUN(), nd({ today: "2026-08-11", fetch: telegram({}, calls) }));
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 0);
});

test("fallback: without a bot, on macOS, osascript gets the text as arguments through execFile", async () => {
  writeWorkspace();
  writeReport({ at: "2026-08-10T08:00:01.000Z", hypotheses: LIVE_NEWS });
  const runs: { cmd: string; args: string[] }[] = [];
  const res = await notify(RUN(), nd({ platform: "darwin", execFile: async (cmd, args) => { runs.push({ cmd, args }); } }));
  assert.equal(res.fallback, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cmd, "osascript");
  assert.deepEqual(runs[0].args, osascriptArgs("есть новости по shop — откройте /lure:check"));
  assert.deepEqual(runs[0].args.slice(0, 6), [
    "-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run",
  ]);
  assert.deepEqual(runs[0].args.slice(6), ["есть новости по shop — откройте /lure:check", "Lure"]);
  // Elsewhere nothing is shown.
  const none = await notify(RUN(), nd({ platform: "linux" }));
  assert.equal(none.fallback, 0);
});

test("fallback: a failed send on macOS shows the notification and counts the error", async () => {
  writeWorkspace();
  writeTelegram();
  writeReport({ at: "2026-08-10T08:00:01.000Z", hypotheses: LIVE_NEWS });
  const runs: string[][] = [];
  const res = await notify(RUN(), nd({
    platform: "darwin", fetch: telegram({ fail: { sendMessage: { code: 403, description: "Forbidden: bot was blocked by the user" } } }),
    execFile: async (_c, args) => { runs.push(args); },
  }));
  assert.equal(res.errors, 1);
  assert.equal(res.fallback, 1);
  assert.equal(runs.length, 1);
});

// ---- The token ----------------------------------------------------------------------------

test("set-token: the token is checked with getMe, kept 0600 and never printed", async () => {
  const calls: Call[] = [];
  const r = await quiet(() => main(["set-token"], nd({ fetch: telegram({}, calls) })));
  assert.equal(r.result, 0);
  assert.equal(r.out, `bot: @${BOT}`);
  assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN));
  assert.equal(calls[0].method, "getMe");
  assert.deepEqual(JSON.parse(readFileSync(botPath(home), "utf8")), { token: TOKEN, username: BOT });
  if (process.platform !== "win32") assert.equal(statSync(botPath(home)).mode & 0o777, 0o600);
});

test("set-token: a malformed or refused token is not echoed and not kept", async () => {
  const bad = await quiet(() => main(["set-token"], nd({ readToken: async () => "not a token at all" })));
  assert.equal(bad.result, 1);
  assert.ok(!bad.err.includes("not a token at all"));
  const refused = await quiet(() => main(["set-token"], nd({ fetch: telegram({ fail: { getMe: { code: 401, description: "Unauthorized" } } }) })));
  assert.equal(refused.result, 1);
  assert.match(refused.err, /did not accept/);
  assert.ok(!refused.err.includes(TOKEN));
  assert.ok(!existsSync(botPath(home)));
});

test("the token never reaches output, even when a failed fetch quotes its URL", async () => {
  writeWorkspace();
  writeTelegram();
  writeNotice(ws, { ...emptyNotice(), questions: [question()] });
  const outs: string[] = [];
  for (const [args, fake] of [
    [["test"], { throwOn: "sendMessage" }],
    [["poll"], { throwOn: "getUpdates" }],
    [["pair", "--minutes", "1"], { throwOn: "getUpdates" }],
    [["status"], {}],
    [["test"], {}],
  ] as [string[], Fake][]) {
    const r = await quiet(() => main(args, nd({ fetch: telegram(fake) })));
    outs.push(r.out, r.err);
  }
  const all = outs.join("\n");
  assert.match(all, /could not reach Telegram/);
  assert.match(all, new RegExp(`@${BOT}`));
  assert.ok(!all.includes(TOKEN));
  assert.ok(!all.includes(TOKEN.split(":")[1]));
});

test("owner.json and offset.json are owner-only", { skip: process.platform === "win32" }, async () => {
  writeTelegram(false);
  rmSync(botPath(home));
  mkdirSync(join(home, "telegram"), { recursive: true });
  writeFileSync(botPath(home), JSON.stringify({ token: TOKEN, username: BOT }), { mode: 0o600 });
  const w = pairWorld((code) => [[msg(5, `/start ${code}`)]]);
  assert.equal(await pair(nd({ fetch: w.fetch }), 1, w.say), true);
  assert.equal(statSync(ownerPath(home)).mode & 0o777, 0o600);
  assert.equal(statSync(offsetPath(home)).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, "telegram")).mode & 0o777, 0o700);
});

test("unpair removes the owner; --forget-token removes the bot too", async () => {
  writeTelegram();
  await quiet(() => main(["unpair"], nd()));
  assert.ok(!existsSync(ownerPath(home)) && existsSync(botPath(home)));
  await quiet(() => main(["unpair", "--forget-token"], nd()));
  assert.ok(!existsSync(botPath(home)));
});

// ---- With the check -----------------------------------------------------------------------

function checkDeps(over: Partial<Deps>, tg: typeof fetch): Deps {
  const f = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url === INCIDENTS) return new Response("[]", { status: 200 });
    if (url === A) return new Response("Forbidden", { status: 403 });
    return tg(input, init);
  }) as unknown as typeof fetch;
  return {
    fetch: f,
    today: TODAY,
    now: () => new Date("2026-08-10T08:00:00Z"),
    lureHome: home,
    token: async () => "google-access-token-xyz",
    pull: async () => ({}),
    inspect: async () => ({ lastCrawlTime: null, pageFetchState: null, googleCanonical: null, coverageState: null }),
    ...over,
  };
}

test("runAll: a failing notify never fails the check; only its error count reaches last-run.json", async () => {
  writeWorkspace();
  const out = await runAll(checkDeps({ notify: async () => { throw new Error(`boom ${TOKEN}`); } }, telegram()));
  assert.deepEqual(out.workspaces, [{ path: ws, ok: true, errors: 0 }]);
  assert.deepEqual(out.notify, { errors: 1 });
  const saved = readFileSync(join(home, "logs", "last-run.json"), "utf8");
  assert.deepEqual(JSON.parse(saved).notify, { errors: 1 });
  assert.ok(!saved.includes("boom") && !saved.includes(TOKEN));
  const fine = await runAll(checkDeps({ notify: async () => ({ errors: 0 }) }, telegram()));
  assert.equal(fine.notify, undefined);
});

test("runAll with notify: the page that does not open for Lure becomes a date question; the token is in no file", async () => {
  writeWorkspace();
  writeTelegram();
  const calls: Call[] = [];
  const tg = telegram({}, calls);
  const d = checkDeps({ notify: (run, dd) => notify(run, nd({ fetch: dd.fetch, today: dd.today, now: dd.now, lureHome: dd.lureHome })) }, tg);
  const r = await quiet(() => runAll(d));
  assert.equal(r.result.notify, undefined);
  const last = JSON.parse(readFileSync(join(ws, ".lure", "check-last.json"), "utf8"));
  assert.equal(last.hypotheses[0].needs_date, true);
  assert.equal(last.hypotheses[0].page, A);
  const sent = calls.filter((c) => c.method === "sendMessage").map((c) => c.body);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/a\/ не открывается для Lure/);
  const q = readNotice(ws).questions[0];
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].callback_data, `l:0:${q.q}:20260810`);
  assert.deepEqual(q.message_ids, [100]);
  const files = [
    join(ws, ".lure", "check-last.json"), join(ws, ".lure", "notice.json"), join(home, "logs", "last-run.json"),
    join(ws, ".lure", "check.log"), join(ws, "journal.md"),
  ].filter(existsSync).map((p) => readFileSync(p, "utf8")).join("\n");
  const texts = sent.map((s) => s.text).join("\n");
  for (const s of [files, texts, r.out, r.err]) assert.ok(!s.includes(TOKEN));
  // Answering the button the next day applies it.
  const calls2: Call[] = [];
  const res = await poll(nd({ today: "2026-08-11", fetch: telegram({ updates: [[cb(1, `l:0:${q.q}:20260809`, OWNER.user_id, OWNER.chat_id, 100)]] }, calls2) }));
  assert.equal(res.applied, 1);
  assert.equal(hdr().live_on, "2026-08-09");
});

// ---- The poll and the message of the same run ---------------------------------------------

const ASKING = { id: ID, status: "planned", changes: [], page: A, planned_live: "2026-08-01", needs_date: true };

test("notify: a date answered by the run's own poll is not asked again in the same run", async () => {
  pollSetup();
  writeReport({ at: "2026-08-10T08:00:01.000Z", hypotheses: [ASKING] });
  const calls: Call[] = [];
  const res = await notify(RUN(), nd({ today: "2026-08-11", fetch: telegram({ updates: [[cb(10, "l:0:q1:20260809")]] }, calls) }));
  assert.equal(res.applied, 1);
  assert.equal(hdr().live_on, "2026-08-09");
  const texts = calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
  assert.deepEqual(texts, ["Записал: /a/ выкачено 09.08"]);
  assert.deepEqual(readNotice(ws).questions, []);
});

test("notify: an 'another date' tap handled by the run's poll keeps its ForceReply, and the reply applies later", async () => {
  pollSetup();
  writeReport({ at: "2026-08-10T08:00:01.000Z", hypotheses: [ASKING] });
  const calls: Call[] = [];
  await notify(RUN(), nd({ fetch: telegram({ updates: [[cb(10, "l:0:q1:other")]] }, calls) }));
  const ask = calls.find((c) => c.method === "sendMessage" && c.body.reply_markup?.force_reply)!;
  assert.ok(ask);
  const q = readNotice(ws).questions[0];
  assert.equal(q.reply_id, 100);              // the ForceReply was the first message sent
  assert.equal(q.q, "q1");
  const later = await poll(nd({ today: "2026-08-11", fetch: telegram({ updates: [[msg(11, "2026-08-05", { reply: 100 })]] }) }));
  assert.equal(later.applied, 1);
  assert.equal(hdr().live_on, "2026-08-05");
});

// ---- Old buttons (F1, F2) ------------------------------------------------------------------

test("poll: a button from a message that did not ask the question is ignored, even with the same id", async () => {
  pollSetup();
  // notice.json was lost and the question asked again: same id by chance, a new message.
  writeNotice(ws, { ...emptyNotice(), questions: [question({ message_ids: [60] })] });
  const r = await poll(nd({ fetch: telegram({ updates: [[cb(10, "l:0:q1:20260803", OWNER.user_id, OWNER.chat_id, 50)]] }) }));
  assert.equal(r.applied, 0);
  assert.equal(r.ignored, 1);
  assert.equal(hdr().status, "planned");
});

test("poll: after the registry changes order, an old button cannot answer another workspace's question", async () => {
  pollSetup();
  // Another workspace now sits at index 0, with its own open question that has the same id.
  const other = mkdtempSync(join(tmpdir(), "lure-notify-other-"));
  try {
    writeFileSync(join(other, "lure.yaml"), "lure: 1\nproduct: other\nsite: https://example.com\nlanguage: en\n");
    writeNotice(other, { ...emptyNotice(), questions: [question({ hypothesis: "2026-07-20-other", page: "/x/", message_ids: [70] })] });
    writeFileSync(join(home, "workspaces.yaml"), `workspaces:\n  - product: other\n    path: ${other}\n  - product: shop\n    path: ${ws}\n`);
    // The old button of `shop`, made when it was at index 0, in message 50.
    const r = await poll(nd({ fetch: telegram({ updates: [[cb(10, "l:0:q1:20260803")]] }) }));
    assert.equal(r.applied, 0);
    assert.equal(r.ignored, 1);
    assert.equal(readNotice(other).questions.length, 1);
    assert.equal(hdr().status, "planned");
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("poll: an answer removes the buttons from every message that asked the question", async () => {
  pollSetup();
  writeNotice(ws, { ...emptyNotice(), questions: [question({ message_ids: [50, 60] })] });
  const calls: Call[] = [];
  const r = await poll(nd({ fetch: telegram({ updates: [[cb(10, "l:0:q1:20260803", OWNER.user_id, OWNER.chat_id, 50)]] }, calls) }));
  assert.equal(r.applied, 1);
  const edits = calls.filter((c) => c.method === "editMessageReplyMarkup").map((c) => c.body.message_id);
  assert.deepEqual(edits, [50, 60]);
});

// ---- Desktop fallback and the weekly digest (F3) -----------------------------------------

test("fallback: a quiet Monday raises no desktop notification; news does, and counts as sent", async () => {
  writeWorkspace();
  const runs: string[][] = [];
  const darwin = (today: string) => nd({ today, platform: "darwin", execFile: async (_c, a) => { runs.push(a); } });
  writeReport({ at: "2026-08-10T08:00:01.000Z", hypotheses: [{ id: ID, status: "planned", changes: [], page: A, planned_live: "2026-08-20" }] });
  const quiet1 = await notify(RUN(), darwin("2026-08-10"));            // a Monday, nothing new
  assert.equal(quiet1.fallback, 0);
  assert.equal(runs.length, 0);
  writeReport({ at: "2026-08-10T08:00:01.000Z", hypotheses: LIVE_NEWS });
  const news = await notify(RUN(), darwin("2026-08-11"));
  assert.equal(news.fallback, 1);
  assert.equal(readNotice(ws).last_sent, "2026-08-11");
});

test("notify: an open question already asked does not send a message by itself the next day", async () => {
  pollSetup();
  writeReport({ at: "2026-08-10T08:00:01.000Z", hypotheses: [ASKING] });
  const calls: Call[] = [];
  const res = await notify(RUN(), nd({ today: "2026-08-11", fetch: telegram({}, calls) }));
  assert.equal(res.sent, 0);
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 0);
  assert.equal(readNotice(ws).questions.length, 1);   // still open, rides with the next message
});

// ---- The ignored count reaches /lure:check (F4) -------------------------------------------

test("the scheduled run's ignored count is kept as a number and reported by the next poll command", async () => {
  pollSetup();
  writeReport({ at: "2026-08-10T08:00:01.000Z", hypotheses: [] });
  await notify(RUN(), nd({ today: "2026-08-11", fetch: telegram({ updates: [[msg(1, "hello there"), msg(2, "do something")]] }) }));
  const kept = readFileSync(join(home, "telegram", "ignored.json"), "utf8");
  assert.deepEqual(JSON.parse(kept), { ignored: 2 });
  const first = await quiet(() => main(["poll"], nd({ fetch: telegram({ updates: [[msg(3, "again")]] }) })));
  assert.match(first.out, /ignored 3/);
  const second = await quiet(() => main(["poll"], nd({ fetch: telegram() })));
  assert.match(second.out, /ignored 0/);
});
