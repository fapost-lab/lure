import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LureError, nodeTooOld, tokenPath, writeSecret, readClient, emailFromIdToken, accessToken, query,
  csvField, lastDate, pull, main, earliest, addDays, clientPath, SITE_HEADER, PAGES_HEADER, auth,
} from "../plugins/lure/scripts/search-console.mts";

const ACCOUNT = "me@example.com";
const PROPERTY = "https://example.com/";
const ACCESS = "ACCESS-TOKEN-aaa111";
const REFRESH = "REFRESH-TOKEN-bbb222";
const CLIENT_SECRET = "CLIENT-SECRET-ccc333";
const isWin = process.platform === "win32";

let home = "";
let ws = "";
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.LURE_HOME;
  home = mkdtempSync(join(tmpdir(), "lure-home-"));
  ws = mkdtempSync(join(tmpdir(), "lure-ws-"));
  writeFileSync(join(ws, "lure.yaml"), "name: test\n");
  process.env.LURE_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LURE_HOME;
  else process.env.LURE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

function signIn(): void {
  const p = clientPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify({ installed: { client_id: "cid", client_secret: CLIENT_SECRET } }));
  writeSecret(tokenPath(ACCOUNT), { account: ACCOUNT, refresh_token: REFRESH });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; body: any };

// A fake Google: token endpoint, sites list, and a searchAnalytics store keyed by dimension count.
function fakeGoogle(opts: { site?: Record<string, any>[]; failPages?: boolean; tokenResponse?: Response } = {}) {
  const calls: Call[] = [];
  const store = {
    site: opts.site ?? [],
    pages: [] as any[],
  };
  const f = (async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body ? (url.includes("oauth2") ? init.body : JSON.parse(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("oauth2.googleapis.com/token")) {
      return opts.tokenResponse ?? json({ access_token: ACCESS });
    }
    if (url.endsWith("/sites")) {
      return json({ siteEntry: [{ siteUrl: "https://z.example/", permissionLevel: "siteOwner" }, { siteUrl: "https://a.example/", permissionLevel: "siteFullUser" }] });
    }
    if (url.includes("/searchAnalytics/query")) {
      const isPages = body.dimensions.includes("page");
      if (isPages && opts.failPages) throw new Error("network down");
      const rows = (isPages ? store.pages : store.site)
        .filter((r: any) => r.keys[0] >= body.startDate && r.keys[0] <= body.endDate);
      return json({ rows: rows.slice().reverse() });
    }
    return json({ error: { message: "unexpected" } }, 404);
  }) as unknown as typeof fetch;
  return { f, calls, store, queries: () => calls.filter((c) => c.url.includes("searchAnalytics")) };
}

const siteRow = (date: string) => ({ keys: [date], clicks: 1, impressions: 10, ctr: 0.1, position: 3.5 });
const pageRows = (date: string) => [
  { keys: [date, "https://example.com/b"], clicks: 2, impressions: 20, ctr: 0.1, position: 4 },
  { keys: [date, "https://example.com/a"], clicks: 3, impressions: 30, ctr: 0.1, position: 5 },
];

function addDay(g: ReturnType<typeof fakeGoogle>, date: string) {
  g.store.site.push(siteRow(date));
  g.store.pages.push(...pageRows(date));
}

const siteCsv = () => join(ws, "search-console", "site-daily.csv");
const pagesCsv = () => join(ws, "search-console", "pages-daily.csv");

// ---- nodeTooOld ---------------------------------------------------------------------------

test("nodeTooOld flags versions below 22.18.0", () => {
  assert.equal(nodeTooOld("20.11.0"), true);
  assert.equal(nodeTooOld("22.17.9"), true);
  assert.equal(nodeTooOld("22.18.0"), false);
  assert.equal(nodeTooOld("26.9.0"), false);
  assert.equal(nodeTooOld("v23.0.0"), false);
});

// ---- tokenPath ----------------------------------------------------------------------------

test("tokenPath rejects path tricks and non-emails", () => {
  for (const bad of ["../x@y", "a/b@c", "no-at-sign", "a\\b@c", "a b@c.com", ""]) {
    assert.throws(() => tokenPath(bad), LureError, bad);
  }
});

test("tokenPath accepts a normal e-mail and stays under LURE_HOME", () => {
  const p = tokenPath("a.b@c.com");
  assert.equal(p, join(home, "google", "tokens", "a.b@c.com.json"));
});

// ---- writeSecret --------------------------------------------------------------------------

test("writeSecret round-trips content and leaves no .part file", () => {
  const p = join(home, "google", "tokens", "x.json");
  writeSecret(p, { a: 1, b: "two" });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { a: 1, b: "two" });
  assert.deepEqual(readdirSync(join(home, "google", "tokens")), ["x.json"]);
});

test("writeSecret uses 0600 file and 0700 directory", { skip: isWin && "mode bits are ignored on Windows" }, () => {
  const p = join(home, "google", "tokens", "x.json");
  writeSecret(p, { a: 1 });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, "google", "tokens")).mode & 0o777, 0o700);
});

test("writeSecret overwrites an existing secret", () => {
  const p = join(home, "s.json");
  writeSecret(p, { v: 1 });
  writeSecret(p, { v: 2 });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { v: 2 });
});

// ---- readClient ---------------------------------------------------------------------------

test("readClient throws LureError when the file is missing", () => {
  assert.throws(() => readClient(), LureError);
});

test("readClient throws LureError on invalid JSON", () => {
  const p = join(home, "c.json");
  writeFileSync(p, "{not json");
  assert.throws(() => readClient(p), LureError);
});

test("readClient rejects a web client", () => {
  const p = join(home, "c.json");
  writeFileSync(p, JSON.stringify({ web: { client_id: "a", client_secret: "b" } }));
  assert.throws(() => readClient(p), /Desktop app/);
});

test("readClient rejects an installed client without a secret", () => {
  const p = join(home, "c.json");
  writeFileSync(p, JSON.stringify({ installed: { client_id: "a" } }));
  assert.throws(() => readClient(p), LureError);
});

test("readClient returns id and secret of a Desktop client", () => {
  const p = join(home, "c.json");
  writeFileSync(p, JSON.stringify({ installed: { client_id: "id1", client_secret: "sec1", extra: 1 } }));
  assert.deepEqual(readClient(p), { client_id: "id1", client_secret: "sec1" });
});

// ---- emailFromIdToken ---------------------------------------------------------------------

test("emailFromIdToken reads the e-mail claim of an unsigned JWT", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64({ alg: "none" })}.${b64({ email: "who@example.com", sub: "1" })}.sig`;
  assert.equal(emailFromIdToken(jwt), "who@example.com");
});

test("emailFromIdToken fails on empty token and on a token without e-mail", () => {
  assert.throws(() => emailFromIdToken(""), LureError);
  const payload = Buffer.from(JSON.stringify({ sub: "1" })).toString("base64url");
  assert.throws(() => emailFromIdToken(`h.${payload}.s`), LureError);
});

// ---- accessToken --------------------------------------------------------------------------

test("accessToken exchanges the refresh token for an access token", async () => {
  signIn();
  const g = fakeGoogle();
  assert.equal(await accessToken(ACCOUNT, g.f), ACCESS);
  const form = new URLSearchParams(g.calls[0].body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), REFRESH);
});

test("accessToken says to run auth again on invalid_grant", async () => {
  signIn();
  const g = fakeGoogle({ tokenResponse: json({ error: "invalid_grant" }, 400) });
  await assert.rejects(accessToken(ACCOUNT, g.f), (e: any) => e instanceof LureError && /run auth again/.test(e.message));
});

test("accessToken fails for an account that never signed in", async () => {
  signIn();
  await assert.rejects(accessToken("other@example.com", fakeGoogle().f), /not signed in/);
});

test("main sites never prints the access token, refresh token or client secret", async (t) => {
  signIn();
  const out: string[] = [];
  const grab = (...a: unknown[]) => void out.push(a.join(" "));
  t.mock.method(console, "log", grab);
  t.mock.method(console, "error", grab);

  assert.equal(await main(["sites", "--account", ACCOUNT], fakeGoogle().f), 0);
  const failing = fakeGoogle({ tokenResponse: json({ error: "invalid_grant", error_description: "Bad" }, 400) });
  assert.equal(await main(["sites", "--account", ACCOUNT], failing.f), 1);

  const all = out.join("\n");
  assert.match(all, /https:\/\/a\.example\/\tsiteFullUser/);
  assert.ok(all.indexOf("a.example") < all.indexOf("z.example"), "sites are sorted");
  for (const secret of [ACCESS, REFRESH, CLIENT_SECRET]) assert.ok(!all.includes(secret), `leaked ${secret}`);
});

// ---- query --------------------------------------------------------------------------------

test("query paginates by 25000 rows with final web data", async () => {
  const pages = [25000, 3].map((n) => Array.from({ length: n }, (_, i) => ({ keys: ["2026-01-01"], clicks: i, impressions: 1, ctr: 0, position: 1 })));
  const calls: any[] = [];
  const f = (async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return json({ rows: pages[calls.length - 1] });
  }) as unknown as typeof fetch;
  const rows = await query(f, "tok", PROPERTY, ["date"], "2026-01-01", "2026-01-02");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.startRow), [0, 25000]);
  assert.equal(rows.length, 25003);
  for (const c of calls) {
    assert.equal(c.dataState, "final");
    assert.equal(c.type, "web");
    assert.equal(c.rowLimit, 25000);
    assert.deepEqual(c.dimensions, ["date"]);
  }
});

test("query stops after one call when the response has no rows", async () => {
  let n = 0;
  const f = (async () => { n++; return json({}); }) as unknown as typeof fetch;
  assert.deepEqual(await query(f, "t", PROPERTY, ["date"], "2026-01-01", "2026-01-02"), []);
  assert.equal(n, 1);
});

test("query turns an API error into a LureError", async () => {
  const f = (async () => json({ error: { message: "no access" } }, 403)) as unknown as typeof fetch;
  await assert.rejects(query(f, "t", PROPERTY, ["date"], "a", "b"), /403.*no access/);
});

// ---- CSV ----------------------------------------------------------------------------------

test("csvField escapes commas, quotes and newlines and leaves plain values alone", () => {
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("a\nb"), '"a\nb"');
  assert.equal(csvField("a\rb"), '"a\rb"');
  assert.equal(csvField("https://example.com/x?y=1"), "https://example.com/x?y=1");
  assert.equal(csvField(0.25), "0.25");
  assert.equal(csvField(""), "");
});

// ---- dates --------------------------------------------------------------------------------

test("addDays and earliest handle month and year boundaries", () => {
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2025-12-31", 1), "2026-01-01");
  assert.equal(earliest("2026-03-10"), "2024-11-10");
});

test("lastDate is null for a missing or header-only file", () => {
  assert.equal(lastDate(join(ws, "nope.csv")), null);
  const p = join(ws, "h.csv");
  writeFileSync(p, "date,clicks\n");
  assert.equal(lastDate(p), null);
});

// ---- pull ---------------------------------------------------------------------------------

test("pull from empty creates both files with headers, sorted rows, and starts at earliest(today)", async () => {
  const today = "2026-03-10";
  const g = fakeGoogle();
  addDay(g, "2026-03-02");
  addDay(g, "2026-03-01");
  g.store.site.push(siteRow("2020-01-01")); // before the window: must be ignored
  const result = await pull(ACCESS, PROPERTY, ws, today, g.f);

  assert.equal(g.queries()[0].body.startDate, earliest(today));
  assert.equal(g.queries()[0].body.endDate, today);
  assert.ok(g.queries()[0].url.includes(encodeURIComponent(PROPERTY)));

  const site = readFileSync(siteCsv(), "utf8").split("\n");
  assert.equal(site[0], SITE_HEADER.join(","));
  assert.deepEqual(site.slice(1, 3).map((l) => l.slice(0, 10)), ["2026-03-01", "2026-03-02"]);
  assert.ok(!readFileSync(siteCsv(), "utf8").includes("2020-01-01"));

  const pages = readFileSync(pagesCsv(), "utf8").trimEnd().split("\n");
  assert.equal(pages[0], PAGES_HEADER.join(","));
  assert.deepEqual(pages.slice(1).map((l) => l.split(",")[0] + " " + l.split(",")[1].slice(-1)),
    ["2026-03-01 a", "2026-03-01 b", "2026-03-02 a", "2026-03-02 b"]);
  assert.deepEqual(result.map((r) => [r.rows, r.from, r.to]), [[2, "2026-03-01", "2026-03-02"], [4, "2026-03-01", "2026-03-02"]]);
});

test("pull resumes from the day after the last written date and never rewrites old lines", async () => {
  const g = fakeGoogle();
  addDay(g, "2026-03-01");
  addDay(g, "2026-03-02");
  await pull(ACCESS, PROPERTY, ws, "2026-03-03", g.f);
  const siteBefore = readFileSync(siteCsv(), "utf8");
  const pagesBefore = readFileSync(pagesCsv(), "utf8");

  addDay(g, "2026-03-03");
  addDay(g, "2026-03-04");
  g.calls.length = 0;
  await pull(ACCESS, PROPERTY, ws, "2026-03-05", g.f);

  assert.deepEqual(g.queries().map((q) => q.body.startDate), ["2026-03-03", "2026-03-03"]);
  const siteAfter = readFileSync(siteCsv(), "utf8");
  const pagesAfter = readFileSync(pagesCsv(), "utf8");
  assert.ok(siteAfter.startsWith(siteBefore));
  assert.ok(pagesAfter.startsWith(pagesBefore));
  assert.deepEqual(siteAfter.trimEnd().split("\n").slice(1).map((l) => l.slice(0, 10)),
    ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"]);
  assert.equal(pagesAfter.trimEnd().split("\n").length, 1 + 8);
  assert.equal(new Set(siteAfter.trimEnd().split("\n")).size, 5, "no duplicate lines");

  // Nothing new: files stay byte-identical and the result is empty.
  const result = await pull(ACCESS, PROPERTY, ws, "2026-03-05", g.f);
  assert.deepEqual(result, []);
  assert.equal(readFileSync(siteCsv(), "utf8"), siteAfter);
  assert.equal(readFileSync(pagesCsv(), "utf8"), pagesAfter);
});

test("pull makes no request when both files already reach today", async () => {
  const g = fakeGoogle();
  addDay(g, "2026-03-05");
  await pull(ACCESS, PROPERTY, ws, "2026-03-05", g.f);
  g.calls.length = 0;
  assert.deepEqual(await pull(ACCESS, PROPERTY, ws, "2026-03-05", g.f), []);
  assert.equal(g.queries().length, 0, "nothing to ask Google when both files already reach today");
});

test("an interrupted pull leaves pages-daily.csv untouched and the next pull completes it", async () => {
  const g = fakeGoogle();
  addDay(g, "2026-03-01");
  await pull(ACCESS, PROPERTY, ws, "2026-03-02", g.f);
  const pagesBefore = readFileSync(pagesCsv(), "utf8");

  addDay(g, "2026-03-02");
  addDay(g, "2026-03-03");
  const broken = fakeGoogle({ failPages: true });
  broken.store.site = g.store.site;
  broken.store.pages = g.store.pages;
  await assert.rejects(pull(ACCESS, PROPERTY, ws, "2026-03-04", broken.f), /network down/);

  assert.equal(readFileSync(pagesCsv(), "utf8"), pagesBefore);
  assert.deepEqual(readdirSync(join(ws, "search-console")).filter((n) => n.endsWith(".part")), []);
  assert.equal(lastDate(siteCsv()), "2026-03-03", "site succeeded before the failure");

  const result = await pull(ACCESS, PROPERTY, ws, "2026-03-04", g.f);
  assert.equal(result.length, 1);
  assert.equal(lastDate(pagesCsv()), "2026-03-03");
  assert.equal(readFileSync(pagesCsv(), "utf8").trimEnd().split("\n").length, 1 + 6);
});

test("an interrupted first pull leaves no pages-daily.csv at all", async () => {
  const g = fakeGoogle({ failPages: true });
  addDay(g, "2026-03-01");
  await assert.rejects(pull(ACCESS, PROPERTY, ws, "2026-03-02", g.f));
  assert.equal(existsSync(pagesCsv()), false);
  assert.equal(existsSync(`${pagesCsv()}.part`), false);
});

test("pull refuses a folder without lure.yaml", async () => {
  rmSync(join(ws, "lure.yaml"));
  const g = fakeGoogle();
  await assert.rejects(pull(ACCESS, PROPERTY, ws, "2026-03-02", g.f), (e: any) => e instanceof LureError && /lure\.yaml/.test(e.message));
  assert.equal(g.calls.length, 0);
  assert.equal(existsSync(join(ws, "search-console")), false);
});

test("pull of a property with no data writes nothing", async () => {
  const g = fakeGoogle();
  assert.deepEqual(await pull(ACCESS, PROPERTY, ws, "2026-03-02", g.f), []);
  assert.equal(existsSync(siteCsv()), false);
});

// ---- main ---------------------------------------------------------------------------------

test("main with no command prints usage and returns 2", async (t) => {
  const err = t.mock.method(console, "error", () => {});
  assert.equal(await main([]), 2);
  assert.match(String(err.mock.calls[0].arguments[0]), /usage/);
});

test("main reports missing flags as a LureError exit 1", async (t) => {
  t.mock.method(console, "error", () => {});
  assert.equal(await main(["sites"]), 1);
});

// ---- auth: the loopback sign-in ------------------------------------------------------------

function idToken(email: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "none" })}.${b({ email })}.sig`;
}

async function startAuth(t: any, minutes = 1) {
  process.env.LURE_NO_BROWSER = "1";
  t.after(() => { delete process.env.LURE_NO_BROWSER; });
  const p = clientPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify({ installed: { client_id: "cid", client_secret: CLIENT_SECRET } }));
  const lines: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => { lines.push(a.join(" ")); });
  const tokenBodies: string[] = [];
  const f = (async (_url: string, init: any) => {
    tokenBodies.push(String(init.body));
    return new Response(JSON.stringify({
      access_token: ACCESS, refresh_token: REFRESH, id_token: idToken("Me@Example.com"),
      scope: "openid https://www.googleapis.com/auth/webmasters.readonly email",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const done = auth(minutes, f);
  let url: URL | undefined;
  for (let i = 0; i < 200 && !url; i++) {
    const line = lines.find((l) => l.startsWith("https://accounts.google.com/"));
    if (line) url = new URL(line);
    else await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(url, "auth printed no sign-in address");
  return { done, url: url!, tokenBodies, lines };
}

test("auth listens on 127.0.0.1, rejects a wrong state, and saves the token on the right one", async (t) => {
  const { done, url, tokenBodies, lines } = await startAuth(t);
  const redirect = new URL(url.searchParams.get("redirect_uri")!);
  assert.equal(redirect.hostname, "127.0.0.1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope")!, /webmasters\.readonly/);
  assert.doesNotMatch(url.searchParams.get("scope")!, /auth\/webmasters(\s|$)/);
  const state = url.searchParams.get("state")!;

  const bad = await fetch(`${redirect.origin}/?code=x&state=wrong`);
  assert.equal(bad.status, 400);
  await bad.text();

  const ok = await fetch(`${redirect.origin}/?code=good-code&state=${encodeURIComponent(state)}`);
  assert.equal(ok.status, 200);
  await ok.text();
  assert.equal(await done, "Me@Example.com");

  assert.equal(tokenBodies.length, 1);
  const body = new URLSearchParams(tokenBodies[0]);
  assert.equal(body.get("code"), "good-code");
  assert.ok(body.get("code_verifier"));
  const saved = JSON.parse(readFileSync(tokenPath("me@example.com"), "utf8"));
  assert.equal(saved.refresh_token, REFRESH);
  for (const l of lines) {
    assert.ok(!l.includes(REFRESH) && !l.includes(ACCESS) && !l.includes(CLIENT_SECRET), "secret printed");
  }
});

test("auth refuses a timeout that is not a number from 1 to 60", async () => {
  await assert.rejects(auth(Number("abc")), LureError);
  await assert.rejects(auth(0), LureError);
  await assert.rejects(auth(61), LureError);
});

test("a damaged token file gives a LureError that does not quote the file", async () => {
  signIn();
  writeFileSync(tokenPath(ACCOUNT), `{"refresh_token": "${REFRESH}" broken`);
  await assert.rejects(accessToken(ACCOUNT, (async () => new Response("{}")) as typeof fetch), (e: any) => {
    assert.ok(e instanceof LureError);
    assert.ok(!e.message.includes(REFRESH));
    return true;
  });
});

test("main reports an unreachable network without a stack trace", async (t) => {
  signIn();
  const errors: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => { errors.push(a.join(" ")); });
  const offline = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  assert.equal(await main(["sites", "--account", ACCOUNT], offline), 1);
  assert.match(errors.join("\n"), /could not reach Google/);
});
