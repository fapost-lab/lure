import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LureError, property, account, registry, rankingIncidents, incidentLine, mergeIncidents, readEvents,
  normalise, probe, verdictFor, checkWorkspace, runAll, status, main, INCIDENTS, BASELINE_DRIFT,
} from "../plugins/lure/scripts/check.mts";
import type { Deps } from "../plugins/lure/scripts/check.mts";
import {
  LureError as MetricsError, record, addDays, readHypotheses, markLive, markAbsent, markCrawled,
  setWaiting, writeVerdict, busy, localToday,
} from "../plugins/lure/scripts/metrics.mts";
import { windows } from "../plugins/lure/scripts/measure.mts";
import { inspect, LureError as GoogleError } from "../plugins/lure/scripts/search-console.mts";

// Synthetic data only: example.com URLs and made-up numbers. Nothing here touches the network,
// the real ~/.lure or launchctl: every dependency of the check is a fake.
const A = "https://example.com/a/";
const B = "https://example.com/b/";
const C = "https://example.com/c/";
const D = "https://example.com/d/";
const MARKER = "Brand new title";
const RECORDED = "2026-07-20";
const PLANNED = "2026-08-01";
const ID = `${RECORDED}-new-title`;
const START = "2025-09-01";   // 400 days of data end on 2026-10-05
const DATA_END = "2026-10-05";

let ws = "";
let home = "";

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "lure-check-ws-"));
  home = mkdtempSync(join(tmpdir(), "lure-check-home-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

// ---- Fixtures -----------------------------------------------------------------------------

function writeWorkspace(dir: string, opts: { days?: number; connected?: boolean; account?: boolean } = {}): void {
  const { days = 400, connected = true, account: withAccount = true } = opts;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lure.yaml"),
    connected
      ? "lure: 1\nproduct: test\nsite: https://example.com\nmetrics:\n  search_console:\n    property: https://example.com/\n"
      : "lure: 1\nproduct: test\nsite: https://example.com\n");
  if (withAccount) {
    mkdirSync(join(dir, ".lure"), { recursive: true });
    writeFileSync(join(dir, ".lure", "search-console.yaml"), "account: someone@example.com\n");
  }
  const pages: Record<string, [number, number, number]> = { [A]: [10, 200, 12], [B]: [8, 160, 14], [C]: [12, 240, 11], [D]: [9, 180, 13] };
  const rows: string[] = ["date,page,clicks,impressions,ctr,position"];
  const site: string[] = ["date,clicks,impressions,ctr,position"];
  for (let i = 0; i < days; i++) {
    const date = addDays(START, i);
    let sc = 0, si = 0;
    for (const [page, [c, imp, pos]] of Object.entries(pages)) {
      const clicks = c + (i % 7) + (page === A ? (i % 3) : 0);
      const impressions = imp + 5 * (i % 7);
      rows.push([date, page, clicks, impressions, clicks / impressions, pos].join(","));
      sc += clicks; si += impressions;
    }
    site.push([date, sc, si, sc / si, 12].join(","));
  }
  mkdirSync(join(dir, "search-console"), { recursive: true });
  writeFileSync(join(dir, "search-console", "pages-daily.csv"), rows.join("\n") + "\n");
  writeFileSync(join(dir, "search-console", "site-daily.csv"), site.join("\n") + "\n");
}

function recordHyp(dir = ws): void {
  record(dir, {
    slug: "new-title", page: A, change: "Rewrite the title", planned_live: PLANNED, metric: "clicks",
    expected: "up", floor: "measurable", floor_reason: "about 200 impressions a day", live_marker: MARKER,
    before: { title: "Old title", h1: "Old h1", description: "Old description" },
    controls: [B, C, D], sections: [{ heading: "Why", text: "Because the old title is vague." }],
    recorded: RECORDED,
  }, RECORDED);
}

function setup(opts: Parameters<typeof writeWorkspace>[1] = {}): void {
  writeWorkspace(ws, opts);
  recordHyp();
}

const hdr = (dir = ws, id = ID): any => readHypotheses(dir).find((h) => h.header.id === id)!.header;
const hypPath = (dir = ws) => join(dir, "hypotheses", `${ID}.md`);
const journalOf = (dir = ws) => (existsSync(join(dir, "journal.md")) ? readFileSync(join(dir, "journal.md"), "utf8") : "");

type World = {
  incidents?: unknown; incidentsStatus?: number; pageBody?: string; pageStatus?: number; pageThrows?: boolean;
};
type Call = { url: string; init?: RequestInit };

function makeFetch(world: World, calls: Call[] = []): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === INCIDENTS) {
      const status = world.incidentsStatus ?? 200;
      return new Response(JSON.stringify(world.incidents ?? []), { status });
    }
    if (url === A) {
      if (world.pageThrows) throw new TypeError("fetch failed");
      return new Response(world.pageBody ?? "<html></html>", { status: world.pageStatus ?? 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

const withMarker = `<html><body><h1>${MARKER}</h1></body></html>`;
const noMarker = "<html><body><h1>Old title</h1></body></html>";
const challenge = "<html><title>Just a moment...</title><script src='/cdn-cgi/challenge-platform/x'></script></html>";

function deps(over: Partial<Deps> & { world?: World; calls?: Call[] } = {}): Deps {
  const { world, calls, ...rest } = over;
  return {
    fetch: makeFetch(world ?? {}, calls),
    today: "2026-10-10",
    now: () => new Date("2026-10-10T08:00:00Z"),
    lureHome: home,
    token: async () => "tok-123",
    pull: async () => ({}),
    inspect: async () => ({ lastCrawlTime: null, pageFetchState: null, googleCanonical: null, coverageState: null }),
    ...rest,
  };
}

// An instant at local noon of `day`: its local date is `day` in any timezone.
const noon = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d, 12, 0).toISOString(); };
const crawlTime = (day: string) => ({ lastCrawlTime: noon(day), pageFetchState: "SUCCESSFUL", googleCanonical: A, coverageState: "Submitted and indexed" });

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; out: string[]; err: string[] }> {
  const log = console.log, error = console.error;
  const out: string[] = [], err: string[] = [];
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  try {
    return { result: await fn(), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// ---- 1. planned, too early ----------------------------------------------------------------

test("planned before planned_live - 3: waits with the planned date, and a second run changes nothing", async () => {
  setup();
  const d = deps({ today: "2026-07-25" });
  const r1 = await checkWorkspace(ws, d);
  assert.match(hdr().waiting, /planned for 2026-08-01/);
  assert.equal(hdr().status, "planned");
  assert.deepEqual(r1.hypotheses[0].changes, ["waiting"]);
  const bytes = readFileSync(hypPath(), "utf8");
  const journal = journalOf();
  const r2 = await checkWorkspace(ws, d);
  assert.equal(readFileSync(hypPath(), "utf8"), bytes);
  assert.equal(journalOf(), journal);
  assert.deepEqual(r2.hypotheses[0].changes, []);
  assert.match(r2.hypotheses[0].waiting!, /planned for/);
});

test("planned: the page is not probed before planned_live - 3", async () => {
  setup();
  const calls: Call[] = [];
  await checkWorkspace(ws, deps({ today: "2026-07-25", calls }));
  assert.equal(calls.filter((c) => c.url === A).length, 0);
});

// ---- 2. planned, page opens ---------------------------------------------------------------

test("planned, page opens without the marker: live_absent_on set, waits 'not on the page yet'", async () => {
  setup();
  await checkWorkspace(ws, deps({ today: "2026-08-02", world: { pageBody: noMarker } }));
  const h = hdr();
  assert.equal(h.status, "planned");
  assert.equal(h.live_absent_on, "2026-08-02");
  assert.match(h.waiting, /not on the page yet/);
  assert.doesNotMatch(h.waiting, /overdue/);
});

test("planned, page opens with the marker (case and whitespace differ): live today, source marker, journal line", async () => {
  setup();
  const body = "<p>  BRAND   new\n title </p>";
  const r = await checkWorkspace(ws, deps({ today: "2026-08-02", world: { pageBody: body } }));
  const h = hdr();
  assert.equal(h.status, "live");
  assert.equal(h.live_on, "2026-08-02");
  assert.equal(h.live_source, "marker");
  // the same run goes on to the crawl step: Google has not been asked yet, so it waits for it
  assert.match(h.waiting, /has not re-crawled the page since 2026-08-02 \(never crawled\)/);
  assert.deepEqual(r.hypotheses[0].changes, ["live", "waiting"]);
  assert.match(journalOf(), new RegExp(`2026-08-02 — check: ${ID} marked live`));
});

test("planned, not on the page yet, past planned_live + 14: overdue suffix", async () => {
  setup();
  await checkWorkspace(ws, deps({ today: "2026-08-16", world: { pageBody: noMarker } }));
  assert.match(hdr().waiting, /not on the page yet · overdue: planned for 2026-08-01/);
  await checkWorkspace(ws, deps({ today: "2026-08-15", world: { pageBody: noMarker } }));
  assert.doesNotMatch(hdr().waiting, /overdue/);
});

// ---- 3. page that does not open -----------------------------------------------------------

test("a 403 challenge page: waits with 'does not open for Lure' and points at /lure:check; marker in challenge is not trusted", async () => {
  setup();
  await checkWorkspace(ws, deps({ today: "2026-08-02", world: { pageStatus: 403, pageBody: challenge + MARKER } }));
  const h = hdr();
  assert.equal(h.status, "planned");
  assert.match(h.waiting, /does not open for Lure \(code 403\)/);
  assert.match(h.waiting, /\/lure:check/);
  assert.equal(h.live_absent_on, undefined);
});

test("a 200 challenge body is also closed; the overdue suffix appears after planned_live + 14", async () => {
  setup();
  await checkWorkspace(ws, deps({ today: "2026-08-20", world: { pageBody: challenge + MARKER } }));
  assert.match(hdr().waiting, /does not open for Lure \(code 200\).*overdue: planned for 2026-08-01/);
});

test("a page that cannot be fetched at all: 'no answer'", async () => {
  setup();
  const r = await checkWorkspace(ws, deps({ today: "2026-08-02", world: { pageThrows: true } }));
  assert.match(hdr().waiting, /does not open for Lure \(no answer\)/);
  assert.deepEqual(r.errors, []);
});

// ---- 4. main live -------------------------------------------------------------------------

test("main live: the person's date sets live_source person and journals", async () => {
  setup();
  const { result } = await quiet(() => main(["live", "--workspace", ws, "--id", ID, "--date", "2026-08-03"], deps({ today: "2026-08-10" })));
  assert.equal(result, 0);
  assert.equal(hdr().status, "live");
  assert.equal(hdr().live_on, "2026-08-03");
  assert.equal(hdr().live_source, "person");
  assert.match(journalOf(), /said by the person/);
});

test("main live: refuses a future date, a date before recorded, a missing flag, an unknown id", async () => {
  setup();
  const d = deps({ today: "2026-08-10" });
  const run = (args: string[]) => quiet(() => main(["live", "--workspace", ws, ...args], d));
  let r = await run(["--id", ID, "--date", "2026-08-11"]);
  assert.equal(r.result, 1);
  assert.match(r.err.join("\n"), /future/);
  r = await run(["--id", ID, "--date", "2026-07-19"]);
  assert.equal(r.result, 1);
  assert.match(r.err.join("\n"), /before the hypothesis was recorded/);
  r = await run(["--id", ID]);
  assert.equal(r.result, 1);
  r = await run(["--id", "nope", "--date", "2026-08-03"]);
  assert.equal(r.result, 1);
  assert.match(r.err.join("\n"), /no hypothesis nope/);
  assert.equal(hdr().status, "planned");
});

test("main live: refuses once crawled_on exists; a person's date can still correct a live, not yet crawled change", async () => {
  setup();
  const d = deps({ today: "2026-10-10" });
  await quiet(() => main(["live", "--workspace", ws, "--id", ID, "--date", "2026-08-03"], d));
  const again = await quiet(() => main(["live", "--workspace", ws, "--id", ID, "--date", "2026-08-02"], d));
  assert.equal(again.result, 0);
  assert.equal(hdr().live_on, "2026-08-02");
  markCrawled(ws, ID, "2026-08-06", windows("2026-08-02", "2026-08-06"));
  const late = await quiet(() => main(["live", "--workspace", ws, "--id", ID, "--date", "2026-08-01"], d));
  assert.equal(late.result, 1);
  assert.match(late.err.join("\n"), /can no longer change/);
  assert.equal(hdr().live_on, "2026-08-02");
});

test("a marker seen later never overrides the person's date", async () => {
  setup();
  await quiet(() => main(["live", "--workspace", ws, "--id", ID, "--date", "2026-08-03"], deps({ today: "2026-08-10" })));
  assert.equal(markLive(ws, ID, "2026-08-10", "marker", "2026-08-10"), false);
  assert.equal(hdr().live_on, "2026-08-03");
  assert.equal(hdr().live_source, "person");
});

// ---- 5. live, crawl ----------------------------------------------------------------------

function goLive(on = "2026-08-01"): void {
  markLive(ws, ID, on, "person", "2026-10-10");
}

test("live: Google has not re-crawled since live_on (crawl on or before the live day, or never)", async () => {
  setup();
  goLive();
  await checkWorkspace(ws, deps({ world: { pageBody: withMarker }, inspect: async () => crawlTime("2026-08-01") }));
  assert.match(hdr().waiting, /has not re-crawled the page since 2026-08-01 \(last crawl 2026-08-01\)/);
  assert.equal(hdr().crawled_on, undefined);
  await checkWorkspace(ws, deps({ world: { pageBody: withMarker } }));
  assert.match(hdr().waiting, /\(never crawled\)/);
});

test("live: a crawl after live_on fixes crawled_on and the windows, and journals", async () => {
  setup({ days: 300 }); // data ends before the after window: the run stops at 'waiting for final data'
  goLive();
  const r = await checkWorkspace(ws, deps({ world: { pageBody: withMarker }, inspect: async () => crawlTime("2026-08-05") }));
  const h = hdr();
  const w = windows("2026-08-01", "2026-08-05");
  assert.equal(h.crawled_on, "2026-08-05");
  assert.deepEqual(h.before_window, w.before);
  assert.deepEqual(h.after_window, w.after);
  assert.equal(h.check_on, w.checkOn);
  // the same run checked the data coverage after marking the crawl
  assert.match(h.waiting, new RegExp(`waiting for final data to ${w.after.to}`));
  assert.equal(h.status, "live");
  assert.deepEqual(r.hypotheses[0].changes, ["crawled", "waiting"]);
  assert.match(journalOf(), new RegExp(`${ID} re-crawled by Google on 2026-08-05`));
});

test("live: Google's canonical differs from the page -> a warning that stays, and status shows it", async () => {
  setup();
  goLive();
  const other = "https://example.com/other/";
  await checkWorkspace(ws, deps({
    world: { pageBody: withMarker },
    inspect: async () => ({ ...crawlTime("2026-08-01"), googleCanonical: other }),
  }));
  assert.ok(hdr().warnings.some((w: string) => w.includes(`another canonical: ${other}`)));
  assert.ok(status(ws, "2026-10-10").some((l) => l.includes("warning: Google chose another canonical")));
});

test("live: an inspect failure is recorded for that hypothesis and the check goes on", async () => {
  setup();
  goLive();
  const r = await checkWorkspace(ws, deps({
    world: { pageBody: withMarker },
    inspect: async () => { throw new GoogleError("URL Inspection refused (429): quota"); },
  }));
  assert.deepEqual(r.errors, [`${ID}: URL Inspection refused (429): quota`]);
});

// ---- 6. measurement invariant ------------------------------------------------------------

test("no verdict while live but not crawled, even with plenty of data", async () => {
  setup();
  goLive();
  await checkWorkspace(ws, deps({ world: { pageBody: withMarker } }));
  assert.equal(hdr().status, "live");
  assert.equal(hdr().verdict, undefined);
});

test("no verdict while final data ends before after_window.to: waits for final data", async () => {
  setup({ days: 300 }); // data ends 2026-06-26
  goLive();
  const w = windows("2026-08-01", "2026-08-05");
  markCrawled(ws, ID, "2026-08-05", w);
  const r = await checkWorkspace(ws, deps({ world: { pageBody: withMarker } }));
  assert.equal(hdr().status, "live");
  assert.equal(hdr().verdict, undefined);
  assert.match(hdr().waiting, new RegExp(`waiting for final data to ${w.after.to} \\(final data to 2026-06-27\\)`));
  assert.ok(!r.hypotheses[0].changes.includes("measured"));
});

test("no verdict at all when there is no data: 'no data'", async () => {
  setup();
  goLive();
  markCrawled(ws, ID, "2026-08-05", windows("2026-08-01", "2026-08-05"));
  rmSync(join(ws, "search-console"), { recursive: true });
  await checkWorkspace(ws, deps({ world: { pageBody: withMarker } }));
  assert.match(hdr().waiting, /waiting for final data to .* \(no data\)/);
  assert.equal(hdr().verdict, undefined);
});

test("verdict written once data covers the after window; second run leaves it alone", async () => {
  setup();
  goLive();
  const w = windows("2026-08-01", "2026-08-05");
  markCrawled(ws, ID, "2026-08-05", w);
  const d = deps({ world: { pageBody: withMarker } });
  const r = await checkWorkspace(ws, d);
  const h = hdr();
  assert.equal(h.status, "measured");
  assert.equal(h.verdict.measured_on, "2026-10-10");
  assert.ok(["noticeable_gain", "worse", "no_signal", "insufficient_history"].includes(h.verdict.label));
  for (const k of ["effect", "past", "page", "controls"]) assert.ok(k in h.verdict, k);
  assert.deepEqual(h.verdict.after, w.after);
  assert.ok(Array.isArray(h.verdict.updates) && Array.isArray(h.verdict.events));
  assert.ok(r.hypotheses[0].changes.includes("measured"));
  assert.equal(r.hypotheses[0].status, "measured");
  assert.ok(r.hypotheses[0].verdict);
  assert.match(journalOf(), new RegExp(`${ID} measured: ${h.verdict.label}`));
  // measured is no longer active: the next run does not touch it.
  const bytes = readFileSync(hypPath(), "utf8");
  const r2 = await checkWorkspace(ws, d);
  assert.equal(readFileSync(hypPath(), "utf8"), bytes);
  assert.equal(r2.hypotheses.length, 0);
});

test("main measure prints the verdict and writes nothing; refuses before crawl", async () => {
  setup();
  goLive();
  const early = await quiet(() => main(["measure", "--workspace", ws, "--id", ID], deps()));
  assert.equal(early.result, 1);
  assert.match(early.err.join("\n"), /no measurement windows yet/);
  markCrawled(ws, ID, "2026-08-05", windows("2026-08-01", "2026-08-05"));
  const bytes = readFileSync(hypPath(), "utf8");
  const ok = await quiet(() => main(["measure", "--workspace", ws, "--id", ID], deps()));
  assert.equal(ok.result, 0);
  const v = JSON.parse(ok.out.join("\n"));
  assert.ok(v.label && "effect" in v);
  assert.equal(readFileSync(hypPath(), "utf8"), bytes);
  const none = await quiet(() => main(["measure", "--workspace", ws, "--id", "nope"], deps()));
  assert.equal(none.result, 1);
});

// ---- 7. rollback -------------------------------------------------------------------------

test("a marker that disappears while live: warning about rollback", async () => {
  setup();
  goLive();
  await checkWorkspace(ws, deps({ world: { pageBody: noMarker }, inspect: async () => crawlTime("2026-08-01") }));
  assert.ok(hdr().warnings.some((w: string) => /rolled back/.test(w)));
  assert.ok(status(ws, "2026-10-10").some((l) => /warning: .*rolled back/.test(l)));
});

test("a marker gone while the page does not open (challenge): no rollback warning", async () => {
  setup();
  goLive();
  await checkWorkspace(ws, deps({ world: { pageStatus: 403, pageBody: challenge }, inspect: async () => crawlTime("2026-08-01") }));
  assert.equal(hdr().warnings, undefined);
});

test("a rollback warning is written once, not repeated every day", async () => {
  setup();
  goLive();
  const d = deps({ world: { pageBody: noMarker }, inspect: async () => crawlTime("2026-08-01") });
  await checkWorkspace(ws, d);
  await checkWorkspace(ws, d);
  assert.equal(hdr().warnings.length, 1);
});

// ---- 8. failures -------------------------------------------------------------------------

test("pull throwing: error in the report and check-last.json, hypotheses still processed", async () => {
  setup();
  const r = await checkWorkspace(ws, deps({
    today: "2026-07-25",
    pull: async () => { throw new GoogleError("sign-in expired; run /lure:search-console"); },
  }));
  assert.deepEqual(r.errors, ["Search Console: sign-in expired; run /lure:search-console"]);
  assert.match(hdr().waiting, /planned for/);
  const saved = JSON.parse(readFileSync(join(ws, ".lure", "check-last.json"), "utf8"));
  assert.deepEqual(saved.errors, r.errors);
  assert.match(readFileSync(join(ws, ".lure", "check.log"), "utf8"), /\terrors\tchanges=1\tSearch Console: sign-in expired/);
});

test("token failure: a live, not yet crawled hypothesis waits with the sign-in reason; inspect is not called", async () => {
  setup();
  goLive();
  let inspected = 0;
  const r = await checkWorkspace(ws, deps({
    world: { pageBody: withMarker },
    token: async () => { throw new GoogleError("no token"); },
    inspect: async () => { inspected++; return crawlTime("2026-08-05"); },
  }));
  assert.equal(inspected, 0);
  assert.match(hdr().waiting, /Search Console sign-in failed/);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^Search Console: no token/);
});

test("a network failure surfaces as a plain message", async () => {
  setup();
  const r = await checkWorkspace(ws, deps({
    today: "2026-07-25",
    token: async () => { throw new TypeError("fetch failed"); },
  }));
  assert.deepEqual(r.errors, ["Search Console: could not reach the network"]);
});

test("a missing Search Console account is an error, but the check goes on without a token", async () => {
  writeWorkspace(ws, { account: false });
  recordHyp();
  goLive();
  const r = await checkWorkspace(ws, deps({ world: { pageBody: withMarker } }));
  assert.match(r.errors[0], /no Search Console account/);
  assert.match(hdr().waiting, /sign-in failed/);
});

test("the incidents feed failing is an error, not a crash; a non-list feed is refused", async () => {
  setup();
  let r = await checkWorkspace(ws, deps({ today: "2026-07-25", world: { incidentsStatus: 500 } }));
  assert.match(r.errors[0], /Google updates not refreshed: status 500/);
  r = await checkWorkspace(ws, deps({ today: "2026-07-25", world: { incidents: { not: "a list" } } }));
  assert.match(r.errors[0], /not a list/);
  assert.equal(existsSync(join(ws, "events.md")), false);
});

test("a workspace without lure.yaml is refused; without a Search Console section it is skipped", async () => {
  await assert.rejects(checkWorkspace(ws, deps()), (e: unknown) => e instanceof LureError && /no lure.yaml/.test((e as Error).message));
  writeWorkspace(ws, { connected: false });
  const r = await checkWorkspace(ws, deps());
  assert.equal(r.skipped, "Search Console is not connected");
  assert.equal(existsSync(join(ws, ".lure", "check-last.json")), false);
});

// ---- 9. events.md ------------------------------------------------------------------------

const RANKING = { id: "inc-1", external_desc: "  October 2026   core update ", begin: "2026-10-01T10:00:00Z", service_name: "Ranking" };
const OTHER = { id: "inc-2", external_desc: "Search outage", begin: "2026-10-03T10:00:00Z", end: "2026-10-03T12:00:00Z", service_name: "Search" };

test("rankingIncidents: keeps Ranking only, trims names and dates, null end when missing; refuses a non-list", () => {
  const got = rankingIncidents([RANKING, OTHER, null, { service_name: "Ranking", begin: "2026-10-02T00:00:00Z" }, { ...RANKING, id: "inc-3", end: "2026-10-05T00:00:00Z", external_desc: undefined }]);
  assert.deepEqual(got, [
    { id: "inc-1", name: "October 2026 core update", begin: "2026-10-01", end: null },
    { id: "inc-3", name: "Google ranking update", begin: "2026-10-01", end: "2026-10-05" },
  ]);
  assert.throws(() => rankingIncidents("x"), LureError);
});

test("incidentLine: open, single day and range", () => {
  assert.equal(incidentLine({ id: "7", name: "N", begin: "2026-10-01", end: null }), "- 2026-10-01 … open — N — status.search.google.com, incident 7");
  assert.equal(incidentLine({ id: "7", name: "N", begin: "2026-10-01", end: "2026-10-01" }), "- 2026-10-01 — N — status.search.google.com, incident 7");
  assert.equal(incidentLine({ id: "7", name: "N", begin: "2026-10-01", end: "2026-10-04" }), "- 2026-10-01 … 2026-10-04 — N — status.search.google.com, incident 7");
});

test("mergeIncidents: inserts in date order, once, and updates an open line when it ends", () => {
  const text = "# Events\n\n- 2026-01-01 — Old thing\n- 2026-12-01 — Later thing\n";
  const open = { id: "9", name: "Spam update", begin: "2026-10-01", end: null as string | null };
  const first = mergeIncidents(text, [open]);
  assert.deepEqual(first.text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2, 12)), ["2026-01-01", "2026-10-01", "2026-12-01"]);
  assert.deepEqual(first.changes, ["added: Spam update"]);
  const again = mergeIncidents(first.text, [open]);
  assert.equal(again.text, first.text);
  assert.deepEqual(again.changes, []);
  const ended = mergeIncidents(first.text, [{ ...open, end: "2026-10-06" }]);
  assert.match(ended.text, /- 2026-10-01 … 2026-10-06 — Spam update/);
  assert.doesNotMatch(ended.text, /… open/);
  assert.deepEqual(ended.changes, ["updated: Spam update"]);
  // Before-all and after-all positions, and a file with no dated lines at all.
  const early = mergeIncidents(text, [{ id: "1", name: "E", begin: "2025-01-01", end: null }]).text.split("\n").filter((l) => l.startsWith("- "));
  assert.match(early[0], /^- 2025-01-01/);
  const none = mergeIncidents("# Events\n", [open]).text;
  assert.match(none, /- 2026-10-01 … open/);
  assert.ok(none.endsWith("\n"));
});

test("checkWorkspace: Ranking incident goes into events.md once, non-Ranking ignored, journal line written", async () => {
  setup();
  const world = { incidents: [RANKING, OTHER] };
  const r1 = await checkWorkspace(ws, deps({ today: "2026-07-25", world }));
  const text = readFileSync(join(ws, "events.md"), "utf8");
  assert.ok(text.startsWith("# Events\n"));
  assert.match(text, /- 2026-10-01 … open — October 2026 core update — status\.search\.google\.com, incident inc-1/);
  assert.doesNotMatch(text, /outage/);
  assert.deepEqual(r1.events, ["added: October 2026 core update"]);
  assert.match(journalOf(), /Google update added: October 2026 core update — events\.md/);
  const j = journalOf();
  const r2 = await checkWorkspace(ws, deps({ today: "2026-07-25", world }));
  assert.equal(readFileSync(join(ws, "events.md"), "utf8"), text);
  assert.deepEqual(r2.events, []);
  assert.equal(journalOf(), j);
});

test("checkWorkspace: an open incident line is updated when `end` appears", async () => {
  setup();
  await checkWorkspace(ws, deps({ today: "2026-07-25", world: { incidents: [RANKING] } }));
  const r = await checkWorkspace(ws, deps({ today: "2026-07-25", world: { incidents: [{ ...RANKING, end: "2026-10-06T00:00:00Z" }] } }));
  const text = readFileSync(join(ws, "events.md"), "utf8");
  assert.match(text, /- 2026-10-01 … 2026-10-06 — October 2026 core update/);
  assert.equal((text.match(/incident inc-1/g) ?? []).length, 1);
  assert.deepEqual(r.events, ["updated: October 2026 core update"]);
});

test("readEvents: open lines run to today, outages are flagged, bad dates and prose are skipped", () => {
  writeFileSync(join(ws, "events.md"), [
    "# Events", "", "Intro line.",
    "- 2026-10-01 … open — Update — status.search.google.com, incident 1",
    "- 2026-09-10 … 2026-09-12 — Hosting down (outage)",
    "- 2026-09-20 — Sale started",
    "- 2026-02-30 — impossible date",
    "- not a date",
  ].join("\r\n"));
  const ev = readEvents(ws, "2026-10-10");
  assert.deepEqual(ev.map((e) => [e.from, e.to, e.outage]), [
    ["2026-10-01", "2026-10-10", false],
    ["2026-09-10", "2026-09-12", true],
    ["2026-09-20", "2026-09-20", false],
  ]);
  assert.equal(readEvents(join(ws, "nowhere"), "2026-10-10").length, 0);
});

test("verdictFor: Google update lines go to `updates`, others to `events`, only those overlapping the windows", () => {
  setup();
  goLive();
  const w = windows("2026-08-01", "2026-08-05");
  markCrawled(ws, ID, "2026-08-05", w);
  const events = [
    { from: "2026-08-10", to: "2026-08-12", line: "2026-08-10 … 2026-08-12 — Core — status.search.google.com, incident 1", outage: false },
    { from: "2026-07-10", to: "2026-07-10", line: "2026-07-10 — Sale started", outage: false },
    { from: "2026-01-01", to: "2026-01-02", line: "2026-01-01 — Far away", outage: false },
    { from: "2026-08-20", to: "2026-08-21", line: "2026-08-20 — Hosting down (outage)", outage: true },
  ];
  const pages = readPagesForTest();
  const v = verdictFor(hdr(), pages, events);
  assert.deepEqual(v.updates, [events[0].line]);
  assert.deepEqual(v.events, [events[1].line, events[3].line]);
});

function readPagesForTest() {
  const lines = readFileSync(join(ws, "search-console", "pages-daily.csv"), "utf8").trim().split("\n").slice(1);
  return lines.map((l) => {
    const [date, page, clicks, impressions, , position] = l.split(",");
    return { date, page, clicks: Number(clicks), impressions: Number(impressions), position: Number(position) };
  });
}

// ---- 10. lock ----------------------------------------------------------------------------

test("a fresh lock: another check is running; the hypothesis is untouched and the lock stays", async () => {
  setup();
  mkdirSync(join(ws, ".lure"), { recursive: true });
  const lock = join(ws, ".lure", "check.lock");
  writeFileSync(lock, "123 now\n");
  const bytes = readFileSync(hypPath(), "utf8");
  await assert.rejects(checkWorkspace(ws, deps({ today: "2026-07-25", now: () => new Date() })),
    (e: unknown) => e instanceof LureError && /another check is running/.test((e as Error).message));
  assert.equal(readFileSync(hypPath(), "utf8"), bytes);
  assert.ok(existsSync(lock));
});

test("a stale lock (older than 2 hours) is replaced, and the lock is removed after the run", async () => {
  setup();
  mkdirSync(join(ws, ".lure"), { recursive: true });
  const lock = join(ws, ".lure", "check.lock");
  writeFileSync(lock, "123 old\n");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(lock, old, old);
  await checkWorkspace(ws, deps({ today: "2026-07-25", now: () => new Date() }));
  assert.equal(existsSync(lock), false);
  assert.match(hdr().waiting, /planned for/);
});

test("the lock is removed even when the run throws", async () => {
  setup();
  writeFileSync(join(ws, "hypotheses", "broken.md"), "---\nlure_hypothesis: 1\nno closing marker\n");
  await assert.rejects(checkWorkspace(ws, deps({ today: "2026-07-25" })));
  assert.equal(existsSync(join(ws, ".lure", "check.lock")), false);
});

// ---- 11. runAll --------------------------------------------------------------------------

test("registry: reads documented entries, strips quotes; no file means an empty list", () => {
  assert.deepEqual(registry(home), []);
  writeFileSync(join(home, "workspaces.yaml"),
    `workspaces:\n  - product: one\n    path: /w/one\n  - product: two\n    path: "/w/two"\n`);
  assert.deepEqual(registry(home), ["/w/one", "/w/two"]);
});

test("registry: the `- path:` form is read too (as schedule.mts reads it)", () => {
  writeFileSync(join(home, "workspaces.yaml"), `workspaces:\n  - path: /w/one\n    product: one\n`);
  assert.deepEqual(registry(home), ["/w/one"]);
});

test("runAll: per-workspace results, a missing lure.yaml is an error, last-run.json under lureHome/logs", async () => {
  setup();
  const gone = join(home, "gone");
  mkdirSync(gone);
  writeFileSync(join(home, "workspaces.yaml"), `workspaces:\n  - product: ok\n    path: ${ws}\n  - product: gone\n    path: ${gone}\n`);
  const out = await runAll(deps({ today: "2026-07-25" }));
  assert.equal(out.workspaces.length, 2);
  assert.deepEqual(out.workspaces[0], { path: ws, ok: true, errors: 0 });
  assert.equal(out.workspaces[1].ok, false);
  assert.equal(out.workspaces[1].errors, 1);
  assert.match(out.workspaces[1].reason!, /no lure.yaml/);
  const saved = JSON.parse(readFileSync(join(home, "logs", "last-run.json"), "utf8"));
  assert.deepEqual(saved.workspaces, out.workspaces);
  assert.equal(saved.at, "2026-10-10T08:00:00.000Z");
});

test("runAll: a workspace whose check recorded errors is not ok; one without a metrics section is skipped but ok", async () => {
  setup();
  const plain = join(home, "plain");
  writeWorkspace(plain, { connected: false });
  writeFileSync(join(home, "workspaces.yaml"), `workspaces:\n  - path: ${plain}\n  - path: ${ws}\n`);
  const out = await runAll(deps({ today: "2026-07-25", pull: async () => { throw new GoogleError("expired"); } }));
  assert.deepEqual(out.workspaces[0], { path: plain, ok: true, errors: 0 });
  assert.equal(out.workspaces[1].ok, false);
  assert.equal(out.workspaces[1].errors, 1);
  assert.equal(out.workspaces[1].reason, undefined); // the text stays in the workspace's check-last.json
  assert.deepEqual(JSON.parse(readFileSync(join(ws, ".lure", "check-last.json"), "utf8")).errors, ["Search Console: expired"]);
});

test("runAll: an empty registry is reported and still writes last-run.json", async () => {
  const out = await runAll(deps());
  assert.match(out.errors[0], /no workspaces in/);
  assert.ok(existsSync(join(home, "logs", "last-run.json")));
});

test("main run --all returns 1 when a workspace fails, 0 when all is well; --workspace needs a value", async () => {
  setup();
  writeFileSync(join(home, "workspaces.yaml"), `workspaces:\n  - path: ${ws}\n`);
  const ok = await quiet(() => main(["run", "--all"], deps({ today: "2026-07-25" })));
  assert.equal(ok.result, 0);
  assert.match(ok.out.join("\n"), new RegExp(`^ok\\t${ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const bad = await quiet(() => main(["run", "--all"], deps({ today: "2026-07-25", pull: async () => { throw new GoogleError("expired"); } })));
  assert.equal(bad.result, 1);
  const none = await quiet(() => main(["run"], deps()));
  assert.equal(none.result, 1);
  assert.match(none.err.join("\n"), /--all or --workspace/);
  const one = await quiet(() => main(["run", "--workspace", ws], deps({ today: "2026-07-25" })));
  assert.equal(one.result, 0);
  assert.match(one.out.join("\n"), new RegExp(`${ID}\\tplanned\\twaiting: the change is planned for`));
});

test("main: unknown command is a usage error (2); bad flags too; settings parsing", async () => {
  assert.equal((await quiet(() => main(["wat"], deps()))).result, 2);
  assert.equal((await quiet(() => main(["run", "--nope"], deps()))).result, 2);
  writeWorkspace(ws);
  assert.equal(property(ws), "https://example.com/");
  assert.equal(account(ws), "someone@example.com");
  writeFileSync(join(ws, "lure.yaml"), `metrics:\n  search_console:\n    property: "sc-domain:example.com"\n`);
  assert.equal(property(ws), "sc-domain:example.com");
  writeFileSync(join(ws, "lure.yaml"), "product: x\n");
  assert.equal(property(ws), null);
  rmSync(join(ws, ".lure"), { recursive: true });
  assert.equal(account(ws), null);
});

// ---- 12. status --------------------------------------------------------------------------

test("status: never ran; hypothesis lines still listed", () => {
  setup();
  const lines = status(ws, "2026-08-01");
  assert.equal(lines[0], "the check has never run for this workspace");
  assert.equal(lines[1], `${ID}\tplanned\tcheck_on 2026-09-01`);
});

test("status: 'has not run since' only after more than 8 days; overdue marker once check_on has passed", async () => {
  setup();
  await checkWorkspace(ws, deps({ today: "2026-08-20", world: { pageBody: noMarker } }));
  const same = status(ws, "2026-08-28");
  assert.ok(!same.some((l) => /has not run since/.test(l)));
  const silent = status(ws, "2026-08-29");
  assert.ok(silent.some((l) => l === "the check has not run since 2026-08-20"));
  assert.match(silent[0], /^last check: 2026-08-20T/.test(silent[0]) ? /./ : /last check/);
  const line = status(ws, "2026-09-02").find((l) => l.startsWith(ID))!;
  assert.match(line, /\toverdue\twaiting: the change is not on the page yet/);
  assert.doesNotMatch(status(ws, "2026-09-01").find((l) => l.startsWith(ID))!, /\toverdue\t/);
});

test("status: errors of the last run are shown; a measured hypothesis shows its label", async () => {
  setup();
  goLive();
  markCrawled(ws, ID, "2026-08-05", windows("2026-08-01", "2026-08-05"));
  await checkWorkspace(ws, deps({ world: { pageBody: withMarker }, pull: async () => { throw new GoogleError("expired"); } }));
  const lines = status(ws, "2026-10-10");
  assert.match(lines[0], /errors: Search Console: expired/);
  const label = hdr().verdict.label;
  assert.equal(lines[1], `${ID}\tmeasured\tcheck_on ${hdr().check_on}\t${label}`);
});

test("status: abandoned hypotheses are not listed; main status prints lines", async () => {
  setup();
  const r = await quiet(() => main(["status", "--workspace", ws], deps({ today: "2026-08-01" })));
  assert.equal(r.result, 0);
  assert.equal(r.out.length, 2);
  const bad = await quiet(() => main(["status"], deps()));
  assert.equal(bad.result, 1);
});

// ---- 13. metrics setters -----------------------------------------------------------------

const VERDICT = {
  label: "no_signal", effect: 0.01, low: -0.05, high: 0.07, mde: 0.06, past: "3 of 10",
  page: { before: 1, after: 2 }, controls: { before: 1, after: 2 },
};

function refuses(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof MetricsError && re.test((e as Error).message), `expected LureError ${re}`);
}

test("markLive: returns true on change, false when nothing changes; refuses measured and abandoned", () => {
  setup();
  assert.equal(markLive(ws, ID, "2026-08-01", "marker", "2026-08-02"), true);
  assert.equal(markLive(ws, ID, "2026-08-01", "marker", "2026-08-02"), false);
  refuses(() => markLive(ws, ID, "2026-08-01", "robot" as any, "2026-08-02"), /marker or person/);
  refuses(() => markLive(ws, ID, "2026-8-1", "person", "2026-08-02"), /must be a date/);
  refuses(() => markLive(ws, "nope", "2026-08-01", "person", "2026-08-02"), /no hypothesis nope/);
  markCrawled(ws, ID, "2026-08-05", windows("2026-08-01", "2026-08-05"));
  writeVerdict(ws, ID, { ...VERDICT, label: "no_signal" }, "2026-10-10");
  refuses(() => markLive(ws, ID, "2026-08-02", "person", "2026-10-10"), /is measured.*can no longer change/);
});

test("markLive: refuses an abandoned hypothesis", async () => {
  setup();
  const { abandon } = await import("../plugins/lure/scripts/metrics.mts");
  abandon(ws, ID, "changed my mind", "2026-08-01");
  refuses(() => markLive(ws, ID, "2026-08-01", "person", "2026-08-02"), /is abandoned/);
  refuses(() => setWaiting(ws, ID, "x"), /not active/);
});

test("markAbsent: only for planned; idempotent within a day", () => {
  setup();
  assert.equal(markAbsent(ws, ID, "2026-08-02"), true);
  assert.equal(markAbsent(ws, ID, "2026-08-02"), false);
  assert.equal(markAbsent(ws, ID, "2026-08-03"), true);
  goLive();
  refuses(() => markAbsent(ws, ID, "2026-08-04"), /not planned/);
});

test("markCrawled: refuses a crawl on or before live_on, a planned hypothesis and bad windows", () => {
  setup();
  refuses(() => markCrawled(ws, ID, "2026-08-05", windows("2026-08-01", "2026-08-05")), /not live/);
  goLive();
  refuses(() => markCrawled(ws, ID, "2026-08-01", windows("2026-08-01", "2026-08-01")), /after the live date/);
  refuses(() => markCrawled(ws, ID, "2026-07-31", windows("2026-08-01", "2026-07-31")), /after the live date/);
  refuses(() => markCrawled(ws, ID, "2026-08-05", { ...windows("2026-08-01", "2026-08-05"), checkOn: "soon" }), /windows: dates/);
  assert.equal(hdr().crawled_on, undefined);
  assert.equal(markCrawled(ws, ID, "2026-08-05", windows("2026-08-01", "2026-08-05")), true);
  assert.equal(markCrawled(ws, ID, "2026-08-05", windows("2026-08-01", "2026-08-05")), false);
});

test("setWaiting: set, repeat (false), clear with null, and warnings accumulate without duplicates", () => {
  setup();
  assert.equal(setWaiting(ws, ID, "because"), true);
  assert.equal(setWaiting(ws, ID, "because"), false);
  assert.equal(setWaiting(ws, ID, "because", ["w1"]), true);
  assert.equal(setWaiting(ws, ID, "because", ["w1"]), false);
  assert.equal(setWaiting(ws, ID, null, ["w2"]), true);
  assert.equal(hdr().waiting, undefined);
  assert.deepEqual(hdr().warnings, ["w1", "w2"]);
  assert.equal(setWaiting(ws, ID, null), false);
});

test("writeVerdict: refuses a verdict without its keys and a hypothesis that is not crawled", () => {
  setup();
  const v = VERDICT;
  refuses(() => writeVerdict(ws, ID, v, "2026-10-10"), /not live and re-crawled/);
  goLive();
  refuses(() => writeVerdict(ws, ID, v, "2026-10-10"), /not live and re-crawled/);
  markCrawled(ws, ID, "2026-08-05", windows("2026-08-01", "2026-08-05"));
  for (const k of Object.keys(v)) {
    const { [k]: _gone, ...rest } = v as Record<string, unknown>;
    refuses(() => writeVerdict(ws, ID, rest as any, "2026-10-10"), new RegExp(`needs ${k}`));
  }
  assert.equal(hdr().status, "live");
  // low, high and mde must be there and be numbers, except for insufficient_history
  for (const bad of [null, "0.1", undefined]) {
    for (const k of ["low", "high", "mde"]) {
      const x = { ...v, [k]: bad } as any;
      if (bad === undefined) delete x[k];
      refuses(() => writeVerdict(ws, ID, x, "2026-10-10"), bad === undefined ? new RegExp(`needs ${k}`) : /needs its interval/);
    }
  }
  assert.equal(hdr().status, "live");
  setWaiting(ws, ID, "x");
  assert.equal(writeVerdict(ws, ID, v, "2026-10-10"), true);
  assert.equal(hdr().status, "measured");
  assert.equal(hdr().waiting, undefined);
  assert.equal(hdr().verdict.measured_on, "2026-10-10");
  refuses(() => writeVerdict(ws, ID, v, "2026-10-11"), /not live and re-crawled/);
});

test("writeVerdict: insufficient_history may carry null low, high and mde, but still needs the keys", () => {
  setup();
  goLive();
  markCrawled(ws, ID, "2026-08-05", windows("2026-08-01", "2026-08-05"));
  const v = { ...VERDICT, label: "insufficient_history", low: null, high: null, mde: null };
  const { mde: _m, ...noMde } = v;
  refuses(() => writeVerdict(ws, ID, noMde as any, "2026-10-10"), /needs mde/);
  assert.equal(writeVerdict(ws, ID, v, "2026-10-10"), true);
  assert.equal(hdr().verdict.label, "insufficient_history");
  assert.equal(hdr().verdict.low, null);
});

test("an old hypothesis file without the new fields still reads, and busy works", () => {
  setup();
  const h = hdr();
  for (const k of ["live_on", "live_source", "live_absent_on", "crawled_on", "before_window", "after_window", "waiting", "warnings", "verdict"]) {
    assert.equal(h[k], undefined, k);
  }
  assert.deepEqual(busy(ws).map((b) => [b.page, b.role]), [[A, "target"], [B, "control"], [C, "control"], [D, "control"]]);
  assert.deepEqual(status(ws, "2026-08-01").slice(1), [`${ID}\tplanned\tcheck_on 2026-09-01`]);
});

// ---- 14. inspect -------------------------------------------------------------------------

function inspectFetch(body: unknown, status: number, seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
  return (async (url: any, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("inspect: posts inspectionUrl and siteUrl with a Bearer header and parses the fields", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const body = { inspectionResult: { indexStatusResult: {
    lastCrawlTime: "2026-08-05T03:00:00Z", pageFetchState: "SUCCESSFUL", googleCanonical: A, coverageState: "Submitted and indexed",
  } } };
  const got = await inspect("tok-123", "https://example.com/", A, inspectFetch(body, 200, seen));
  assert.deepEqual(got, { lastCrawlTime: "2026-08-05T03:00:00Z", pageFetchState: "SUCCESSFUL", googleCanonical: A, coverageState: "Submitted and indexed" });
  assert.match(seen.url!, /urlInspection\/index:inspect$/);
  assert.equal(seen.init!.method, "POST");
  assert.equal((seen.init!.headers as Record<string, string>).authorization, "Bearer tok-123");
  assert.deepEqual(JSON.parse(seen.init!.body as string), { inspectionUrl: A, siteUrl: "https://example.com/" });
});

test("inspect: missing fields (or no result at all) come back as null", async () => {
  const nulls = { lastCrawlTime: null, pageFetchState: null, googleCanonical: null, coverageState: null };
  assert.deepEqual(await inspect("t", "https://example.com/", A, inspectFetch({ inspectionResult: { indexStatusResult: { lastCrawlTime: "2026-08-05T03:00:00Z" } } }, 200)),
    { ...nulls, lastCrawlTime: "2026-08-05T03:00:00Z" });
  assert.deepEqual(await inspect("t", "https://example.com/", A, inspectFetch({}, 200)), nulls);
});

test("inspect: a non-OK answer is a LureError with Google's message and never echoes the token", async () => {
  await assert.rejects(inspect("secret-token-xyz", "https://example.com/", A, inspectFetch({ error: { message: "quota exceeded" } }, 429)),
    (e: unknown) => e instanceof GoogleError && /429/.test((e as Error).message) && /quota exceeded/.test((e as Error).message) && !/secret-token-xyz/.test((e as Error).message));
  const notJson = (async () => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" })) as unknown as typeof fetch;
  await assert.rejects(inspect("secret-token-xyz", "https://example.com/", A, notJson),
    (e: unknown) => e instanceof GoogleError && /502.*Bad Gateway/.test((e as Error).message) && !/secret-token-xyz/.test((e as Error).message));
});

// ---- 15. normalise / probe ---------------------------------------------------------------

test("normalise: entities (named, decimal, hex), whitespace and case", () => {
  assert.equal(normalise("  Tom &amp; Jerry&nbsp;&lt;3 \n\t &quot;hi&quot; &#39;x&#39; &#x41;&#66; "), `tom & jerry <3 "hi" 'x' ab`);
  assert.equal(normalise("&unknown; stays"), "&unknown; stays");
  assert.equal(normalise(""), "");
});

test("probe: sends a Lure-check/ User-Agent, matches across entities and whitespace, reports status", async () => {
  const calls: Call[] = [];
  const f = makeFetch({ pageBody: "<h1>Tom &amp;   Jerry\n guide</h1>" }, calls);
  const p = await probe(A, "tom & jerry guide", f);
  assert.deepEqual(p, { opened: true, found: true, status: 200 });
  const ua = (calls[0].init!.headers as Record<string, string>)["user-agent"];
  assert.match(ua, /^Lure-check\//);
  assert.equal(calls[0].init!.redirect, "follow");
  assert.deepEqual(await probe(A, "absent text", f), { opened: true, found: false, status: 200 });
});

test("probe: 404/500 and challenge pages are not opened; an unreadable body does not throw", async () => {
  assert.deepEqual(await probe(A, MARKER, makeFetch({ pageStatus: 404, pageBody: MARKER })), { opened: false, found: false, status: 404 });
  assert.deepEqual(await probe(A, MARKER, makeFetch({ pageBody: "cf-chl-bypass " + MARKER })), { opened: false, found: false, status: 200 });
  const broken = (async () => ({ ok: true, status: 200, text: async () => { throw new Error("stream"); } })) as unknown as typeof fetch;
  assert.deepEqual(await probe(A, MARKER, broken), { opened: true, found: false, status: 200 });
  await assert.rejects(probe(A, MARKER, makeFetch({ pageThrows: true })), TypeError);
});

// ---- 16. one run follows a transition (F1) -----------------------------------------------

test("F1: a run that finds the marker also inspects the crawl; a second run the same day changes nothing", async () => {
  setup();
  let inspected = 0;
  const d = deps({
    today: "2026-08-02",
    world: { pageBody: withMarker },
    inspect: async () => { inspected++; return crawlTime("2026-08-01"); }, // crawled, but not after the live day
  });
  const r1 = await checkWorkspace(ws, d);
  assert.equal(inspected, 1);
  assert.equal(hdr().status, "live");
  assert.match(hdr().waiting, /has not re-crawled the page since 2026-08-02 \(last crawl 2026-08-01\)/);
  assert.deepEqual(r1.hypotheses[0].changes, ["live", "waiting"]);
  assert.equal(r1.hypotheses[0].status, "live");
  assert.match(r1.hypotheses[0].waiting!, /has not re-crawled/);
  const bytes = readFileSync(hypPath(), "utf8");
  const journal = journalOf();
  const r2 = await checkWorkspace(ws, d);
  assert.equal(readFileSync(hypPath(), "utf8"), bytes);
  assert.equal(journalOf(), journal);
  assert.deepEqual(r2.hypotheses[0].changes, []);
});

test("F1: a run that marks the crawl also checks data coverage; a second run the same day changes nothing", async () => {
  setup({ days: 300 }); // data ends before the after window
  goLive();
  const d = deps({ world: { pageBody: withMarker }, inspect: async () => crawlTime("2026-08-05") });
  const r1 = await checkWorkspace(ws, d);
  assert.deepEqual(r1.hypotheses[0].changes, ["crawled", "waiting"]);
  assert.match(hdr().waiting, /waiting for final data/);
  const bytes = readFileSync(hypPath(), "utf8");
  const journal = journalOf();
  const r2 = await checkWorkspace(ws, d);
  assert.equal(readFileSync(hypPath(), "utf8"), bytes);
  assert.equal(journalOf(), journal);
  assert.deepEqual(r2.hypotheses[0].changes, []);
});

test("F1: a run that marks the crawl measures in the same run when the data is there", async () => {
  setup();
  goLive();
  const d = deps({ world: { pageBody: withMarker }, inspect: async () => crawlTime("2026-08-05") });
  const r = await checkWorkspace(ws, d);
  assert.deepEqual(r.hypotheses[0].changes, ["crawled", "measured"]);
  assert.equal(hdr().status, "measured");
  assert.equal(r.hypotheses[0].status, "measured");
  const bytes = readFileSync(hypPath(), "utf8");
  const journal = journalOf();
  await checkWorkspace(ws, d);
  assert.equal(readFileSync(hypPath(), "utf8"), bytes);
  assert.equal(journalOf(), journal);
});

// ---- 17. the page's own history (F2), baseline drift (F5) --------------------------------

function crawledRows(): { h: any; rows: ReturnType<typeof readPagesForTest> } {
  setup();
  goLive();
  markCrawled(ws, ID, "2026-08-05", windows("2026-08-01", "2026-08-05"));
  return { h: hdr(), rows: readPagesForTest() };
}

test("F2: history starts at the target page's first row, not the controls': a young page is insufficient_history", () => {
  const { h, rows } = crawledRows();
  assert.notEqual(verdictFor(h, rows, []).label, "insufficient_history"); // 400 days for everyone
  const young = rows.filter((r) => r.page !== A || r.date >= addDays("2026-08-01", -60));
  assert.ok(young.some((r) => r.page === B && r.date < "2026-01-01")); // the controls do have the long history
  assert.equal(verdictFor(h, young, []).label, "insufficient_history");
});

test("F5: no baseline drift warning within a factor of two either way (the boundary included)", () => {
  const { h, rows } = crawledRows();
  const before = verdictFor(h, rows, []).page.before;
  assert.ok(before > 100);
  assert.equal(BASELINE_DRIFT, 2);
  assert.deepEqual(verdictFor({ ...h, baseline: undefined }, rows, []).warnings, []);
  for (const f of [1, 1.5, 1 / 1.5, 2, 0.5]) {
    const v = verdictFor({ ...h, baseline: { page: { clicks: before * f } } }, rows, []);
    assert.deepEqual(v.warnings, [], `factor ${f}`);
  }
});

test("F5: a before-window more than twice the baseline, or less than half of it, warns", () => {
  const { h, rows } = crawledRows();
  const before = verdictFor(h, rows, []).page.before;
  for (const recorded of [before / 3, before * 3]) {
    const v = verdictFor({ ...h, baseline: { page: { clicks: recorded } } }, rows, []);
    assert.equal(v.warnings.length, 1, `recorded ${recorded}`);
    assert.match(v.warnings[0], new RegExp(`before-window has ${before} clicks, the baseline recorded with the hypothesis ${recorded}`));
  }
});

test("F5: the warning reaches the verdict written to the hypothesis", async () => {
  setup();
  goLive();
  const w = windows("2026-08-01", "2026-08-05");
  markCrawled(ws, ID, "2026-08-05", w);
  const before = verdictFor(hdr(), readPagesForTest(), []).page.before;
  // an honest baseline first: no warning in a verdict written from it
  const recorded = hdr().baseline.page.clicks;
  assert.ok(Number.isFinite(recorded));
  const text = readFileSync(hypPath(), "utf8");
  const skewed = text.replace(/(baseline:[\s\S]*?\n\s+clicks: )[\d.]+/, `$1${before * 5}`);
  assert.notEqual(skewed, text);
  writeFileSync(hypPath(), skewed);
  assert.equal(hdr().baseline.page.clicks, before * 5);
  await checkWorkspace(ws, deps({ world: { pageBody: withMarker } }));
  assert.equal(hdr().status, "measured");
  assert.ok(hdr().verdict.warnings.some((x: string) => /something else changed/.test(x)));
});

// ---- 18. unreadable history (F7) ---------------------------------------------------------

test("F7: an unreadable pages-daily.csv is reported, not swallowed; the check goes on", async () => {
  setup();
  writeFileSync(join(ws, "search-console", "pages-daily.csv"), "day,url,c,i\n2026-01-01,x,1,1\n");
  const r = await checkWorkspace(ws, deps({ today: "2026-07-25" }));
  assert.ok(r.errors.some((e) => e.startsWith("Search Console history unreadable:")), r.errors.join("|"));
  assert.match(hdr().waiting, /planned for/);
  assert.match(readFileSync(join(ws, ".lure", "check.log"), "utf8"), /\terrors\t/);
});

// ---- 19. the marker was there at the first look (F8) -------------------------------------

test("F8: marker found with no live_absent_on: a warning says the date may be corrected with /lure:check", async () => {
  setup();
  await checkWorkspace(ws, deps({ today: "2026-08-02", world: { pageBody: withMarker } }));
  const w: string[] = hdr().warnings;
  assert.equal(w.length, 1);
  assert.match(w[0], /already on the page at the check's first look \(2026-08-02\)/);
  assert.match(w[0], /\/lure:check/);
  assert.ok(status(ws, "2026-08-02").some((l) => l.includes("warning: the marker was already on the page")));
});

test("F8: no such warning when the check saw the page without the marker first", async () => {
  setup();
  await checkWorkspace(ws, deps({ today: "2026-08-02", world: { pageBody: noMarker } }));
  assert.equal(hdr().live_absent_on, "2026-08-02");
  await checkWorkspace(ws, deps({ today: "2026-08-03", world: { pageBody: withMarker } }));
  assert.equal(hdr().status, "live");
  assert.equal(hdr().live_on, "2026-08-03");
  assert.equal(hdr().warnings, undefined);
});

// ---- 20. crawled_on is a local date (F9) -------------------------------------------------

// Instants built from local clock times, so the expectations hold in any timezone.
const localInstant = (day: string, hour: number, minute = 0) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute).toISOString();
};

test("F9: a crawl at 01:00 local on the day after live counts, as that local date", async () => {
  setup({ days: 300 });
  goLive("2026-08-01");
  const t = localInstant("2026-08-02", 1);
  assert.equal(localToday(new Date(t)), "2026-08-02");
  await checkWorkspace(ws, deps({ world: { pageBody: withMarker }, inspect: async () => ({ ...crawlTime("2026-08-02"), lastCrawlTime: t }) }));
  assert.equal(hdr().crawled_on, "2026-08-02");
});

test("F9: a crawl at 23:00 local on the live day is not after the live day", async () => {
  setup({ days: 300 });
  goLive("2026-08-01");
  const t = localInstant("2026-08-01", 23);
  await checkWorkspace(ws, deps({ world: { pageBody: withMarker }, inspect: async () => ({ ...crawlTime("2026-08-01"), lastCrawlTime: t }) }));
  assert.equal(hdr().crawled_on, undefined);
  assert.match(hdr().waiting, /has not re-crawled the page since 2026-08-01 \(last crawl 2026-08-01\)/);
});

test("F9: an unparseable lastCrawlTime counts as never crawled", async () => {
  setup();
  goLive();
  await checkWorkspace(ws, deps({ world: { pageBody: withMarker }, inspect: async () => ({ ...crawlTime("2026-08-05"), lastCrawlTime: "not a time" }) }));
  assert.equal(hdr().crawled_on, undefined);
  assert.match(hdr().waiting, /\(never crawled\)/);
});

// ---- 21. what leaves the workspace (F18, F15) --------------------------------------------

const SECRET_TOKEN = "tok-SECRET-123";

test("F18: last-run.json holds paths, ok and error counts: no hypothesis id, page URL or error text", async () => {
  setup();
  goLive();
  writeFileSync(join(home, "workspaces.yaml"), `workspaces:\n  - path: ${ws}\n`);
  const out = await runAll(deps({
    world: { pageBody: withMarker },
    inspect: async () => { throw new GoogleError(`URL Inspection refused for ${A}: quota`); },
  }));
  assert.deepEqual(out.workspaces, [{ path: ws, ok: false, errors: 1 }]);
  const raw = readFileSync(join(home, "logs", "last-run.json"), "utf8");
  assert.ok(!raw.includes(ID), raw);
  assert.ok(!raw.includes(A), raw);
  assert.ok(!raw.includes("quota"), raw);
  // the detail stays in the workspace
  assert.match(readFileSync(join(ws, ".lure", "check-last.json"), "utf8"), /quota/);
});

test("F18: main run --all prints the path, ok/errors and 'N error(s), see .lure/check-last.json' only", async () => {
  setup();
  goLive();
  writeFileSync(join(home, "workspaces.yaml"), `workspaces:\n  - path: ${ws}\n`);
  const r = await quiet(() => main(["run", "--all"], deps({
    world: { pageBody: withMarker },
    inspect: async () => { throw new GoogleError(`URL Inspection refused for ${A}: quota`); },
  })));
  assert.equal(r.result, 1);
  assert.deepEqual(r.out, [`errors\t${ws}\t1 error(s), see .lure/check-last.json`]);
  const all = [...r.out, ...r.err].join("\n");
  assert.ok(!all.includes(ID) && !all.includes(A) && !all.includes("quota"), all);
});

test("F18: a workspace-level failure carries a reason: no lure.yaml, lock held, no access", async () => {
  setup();
  const nowhere = join(home, "nowhere");
  mkdirSync(nowhere);
  const locked = join(home, "locked");
  writeWorkspace(locked);
  writeFileSync(join(locked, ".lure", "check.lock"), "123 now\n");
  const denied = join(home, "denied");
  writeWorkspace(denied);
  chmodSync(join(denied, "lure.yaml"), 0o000);
  writeFileSync(join(home, "workspaces.yaml"), `workspaces:\n  - path: ${nowhere}\n  - path: ${locked}\n  - path: ${denied}\n`);
  try {
    const out = await runAll(deps({ now: () => new Date() }));
    assert.match(out.workspaces[0].reason!, /no lure.yaml/);
    assert.match(out.workspaces[1].reason!, /another check is running/);
    if (process.getuid?.() !== 0) assert.match(out.workspaces[2].reason!, /no access/);
    for (const w of out.workspaces) assert.deepEqual([w.ok, w.errors], [false, 1]);
  } finally {
    chmodSync(join(denied, "lure.yaml"), 0o644);
  }
});

test("F15: the token reaches pull and inspect but never stdout, stderr, check-last.json, check.log, last-run.json or the workspace files", async () => {
  setup();
  goLive();
  writeFileSync(join(home, "workspaces.yaml"), `workspaces:\n  - path: ${ws}\n`);
  const seen: string[] = [];
  const d = deps({
    world: { pageBody: withMarker },
    token: async () => SECRET_TOKEN,
    pull: async (t) => { seen.push(t); return {}; },
    inspect: async (t) => { seen.push(t); return crawlTime("2026-08-05"); },
  });
  // first with failures on both calls, then a clean run that measures
  const bad = await quiet(() => main(["run", "--all"], deps({
    world: { pageBody: withMarker },
    token: async () => SECRET_TOKEN,
    pull: async () => { throw new GoogleError("pull refused (401)"); },
    inspect: async () => { throw new GoogleError("inspect refused (401)"); },
  })));
  assert.equal(bad.result, 1);
  const ok = await quiet(() => main(["run", "--all"], d));
  assert.equal(ok.result, 0);
  assert.equal(hdr().status, "measured");
  assert.ok(seen.length >= 1 && seen.every((t) => t === SECRET_TOKEN));
  const files = ["check-last.json", "check.log"].map((f) => readFileSync(join(ws, ".lure", f), "utf8"))
    .concat(readFileSync(join(home, "logs", "last-run.json"), "utf8"), readFileSync(hypPath(), "utf8"), journalOf());
  const everything = [...ok.out, ...ok.err, ...bad.out, ...bad.err, ...files].join("\n");
  assert.ok(!everything.includes(SECRET_TOKEN));
  assert.ok(!everything.includes("SECRET"));
});
