import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LureError, WINDOW_DAYS, SETTLE_DAYS, DATA_LAG_DAYS, windows, delta, quantile, sumIn, measure,
} from "../plugins/lure/scripts/measure.mts";
import type { DayRow, MeasureInput, Span } from "../plugins/lure/scripts/measure.mts";

// Synthetic data only: example.com URLs and made-up numbers.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = "2025-01-01";
const DAYS = 400;
const LIVE = "2025-10-28"; // day 300
const dayOf = (i: number) => new Date(Date.parse(`${START}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
const win = windows(LIVE, LIVE);

// A series of `base` per day with a shared slow wave and +-10% multiplicative noise.
function series(seed: number, base: number, multiplier = 1, position = 10): DayRow[] {
  const rnd = mulberry32(seed);
  const rows: DayRow[] = [];
  for (let i = 0; i < DAYS; i++) {
    const date = dayOf(i);
    const shared = 1 + 0.3 * Math.sin(i / 20);
    const noise = 1 + (rnd() * 0.2 - 0.1);
    const m = date >= win.after.from && date <= win.after.to ? multiplier : 1;
    const impressions = base * shared * noise * m;
    rows.push({ date, clicks: impressions * 0.05, impressions, position });
  }
  return rows;
}

function input(multiplier: number, over: Partial<MeasureInput> = {}): MeasureInput {
  return {
    metric: "impressions",
    expected: "up",
    floor: "measurable",
    liveOn: LIVE,
    before: win.before,
    after: win.after,
    historyFrom: START,
    page: series(1, 40, multiplier),
    controls: [
      { page: "https://example.com/c1/", rows: series(2, 60) },
      { page: "https://example.com/c2/", rows: series(3, 80) },
      { page: "https://example.com/c3/", rows: series(4, 50) },
    ],
    outages: [],
    ...over,
  };
}

test("windows: crawl after live", () => {
  const w = windows("2026-03-10", "2026-03-12");
  assert.deepEqual(w.before, { from: "2026-02-10", to: "2026-03-09" });
  assert.deepEqual(w.after, { from: "2026-03-19", to: "2026-04-15" });
  assert.equal(w.checkOn, "2026-04-18");
});

test("windows: crawl before live", () => {
  const w = windows("2026-03-10", "2026-03-01");
  assert.deepEqual(w.after, { from: "2026-03-17", to: "2026-04-13" });
  assert.equal(w.checkOn, "2026-04-16");
  assert.equal(SETTLE_DAYS + WINDOW_DAYS + DATA_LAG_DAYS - 1, 37);
});

test("delta: zero sums become 0.5", () => {
  assert.equal(delta(10, 10, 10, 10), 0);
  assert.ok(Math.abs(delta(10, 10, 20, 10) - Math.log(2)) < 1e-12);
  assert.ok(Math.abs(delta(0, 10, 10, 10) - (Math.log(1) - Math.log(0.05))) < 1e-12);
  assert.ok(Math.abs(delta(10, 10, 10, 0) - (Math.log(20) - 0)) < 1e-12);
});

test("quantile: nearest rank", () => {
  const v = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
  assert.equal(quantile(v, 0.9), 9);
  assert.equal(quantile(v, 0.5), 5);
  assert.equal(quantile(v, 1), 10);
  assert.equal(quantile(v, 0), 1);
  assert.equal(quantile([7], 0.9), 7);
  assert.throws(() => quantile([], 0.9), LureError);
});

test("sumIn: inclusive span", () => {
  const rows: DayRow[] = [
    { date: "2026-01-01", clicks: 1, impressions: 10, position: 5 },
    { date: "2026-01-02", clicks: 2, impressions: 20, position: 5 },
    { date: "2026-01-03", clicks: 3, impressions: 30, position: 5 },
  ];
  assert.equal(sumIn(rows, { from: "2026-01-01", to: "2026-01-02" }, "impressions"), 30);
  assert.equal(sumIn(rows, { from: "2026-01-02", to: "2026-01-03" }, "clicks"), 5);
});

test("a 1.5x uplift is a noticeable gain", () => {
  const v = measure(input(1.5));
  assert.equal(v.label, "noticeable_gain");
  assert.ok(Math.abs(v.effect - 0.5) < 0.1, `effect ${v.effect}`);
  assert.ok(v.low! > 0 && v.high! > v.low!);
  assert.ok(v.placebos >= 5);
  assert.equal(v.past.split(" of ")[1], String(v.placebos));
  assert.ok(v.mde! > 0 && v.mde! < 0.2);
  assert.equal(v.unreliable, false);
});

test("no uplift is no signal", () => {
  const v = measure(input(1));
  assert.equal(v.label, "no_signal");
  assert.ok(Math.abs(v.effect) < 0.1);
  assert.ok(v.low! < 0 && v.high! > 0);
});

test("halving is worse", () => {
  const v = measure(input(0.5));
  assert.equal(v.label, "worse");
  assert.ok(v.effect < -0.4);
});

test("expected down turns a drop into a gain", () => {
  assert.equal(measure(input(0.5, { expected: "down" })).label, "noticeable_gain");
  assert.equal(measure(input(1.5, { expected: "down" })).label, "worse");
});

test("120 days of history is insufficient", () => {
  const historyFrom = dayOf(180); // 120 days before LIVE
  const v = measure(input(1.5, { historyFrom }));
  assert.equal(v.label, "insufficient_history");
  assert.ok(Number.isFinite(v.effect));
});

test("no placebos leaves intervals empty", () => {
  const v = measure(input(1.5, { historyFrom: dayOf(290) }));
  assert.equal(v.label, "insufficient_history");
  assert.equal(v.placebos, 0);
  assert.equal(v.low, null);
  assert.equal(v.high, null);
  assert.equal(v.p, null);
  assert.equal(v.mde, null);
  assert.equal(v.past, "0 of 0");
  assert.equal(v.effective_windows, 0);
});

test("an outage in the history reduces the placebo count", () => {
  const free = measure(input(1));
  const out: Span = { from: dayOf(100), to: dayOf(130) };
  const hit = measure(input(1, { outages: [out] }));
  assert.ok(hit.placebos < free.placebos, `${hit.placebos} < ${free.placebos}`);
  assert.ok(hit.placebos > 0);
});

test("placebo pairs never reach liveOn", () => {
  // The unshifted after window ends 34 days past liveOn, so the first shift that stays
  // clear of liveOn is 35 days back, i.e. 5 weeks: shifts 7..28 are skipped.
  const v = measure(input(1));
  const room = 300 - 28 - 35; // days between history start and the earliest allowed before' end
  assert.ok(v.placebos <= Math.floor(room / 7) + 1);
  // History that ends exactly where the first usable shift would start admits none.
  const tight = measure(input(1, { historyFrom: dayOf(300 - 28 - 34) }));
  assert.equal(tight.placebos, 0);
  const one = measure(input(1, { historyFrom: dayOf(300 - 28 - 35) }));
  assert.equal(one.placebos, 1);
});

test("effective windows count non-overlapping placebo spans", () => {
  const v = measure(input(1));
  // Each pair spans 28 + 7 + 28 = 63 days, shifted weekly: about a ninth are independent.
  assert.ok(v.effective_windows >= 2 && v.effective_windows < v.placebos);
});

test("per_control with three controls", () => {
  const v = measure(input(1.5));
  assert.equal(v.per_control.length, 3);
  assert.deepEqual(v.per_control.map((c) => c.page), [
    "https://example.com/c1/", "https://example.com/c2/", "https://example.com/c3/",
  ]);
  for (const c of v.per_control) assert.ok(Math.abs(c.effect) < 0.1, `${c.page} ${c.effect}`);
});

test("per_control with one control is its own change", () => {
  const rows: DayRow[] = [
    { date: "2026-01-05", clicks: 0, impressions: 100, position: 5 },
    { date: "2026-03-05", clicks: 0, impressions: 150, position: 5 },
  ];
  const v = measure({
    metric: "impressions", expected: "up", floor: "weak", liveOn: "2026-02-01",
    before: { from: "2026-01-01", to: "2026-01-31" }, after: { from: "2026-03-01", to: "2026-03-31" },
    historyFrom: "2026-01-01", page: rows,
    controls: [{ page: "https://example.com/solo/", rows }], outages: [],
  });
  assert.deepEqual(v.per_control, [{ page: "https://example.com/solo/", effect: 0.5 }]);
  assert.equal(v.effect, 0);
});

test("clicks secondary: enough clicks", () => {
  const v = measure(input(1.5));
  assert.ok(typeof v.clicks === "object" && v.clicks !== null);
  assert.ok(Math.abs(v.clicks.effect - 0.5) < 0.1);
});

test("clicks secondary: carries the page's CTR before and after, 4 decimals", () => {
  const i = input(1.5);
  // clicks = 5% of impressions every day; make the after window 8% so the two differ.
  i.page = i.page.map((r) => (r.date >= i.after.from && r.date <= i.after.to ? { ...r, clicks: r.impressions * 0.08 } : r));
  const v = measure(i);
  assert.ok(typeof v.clicks === "object" && v.clicks !== null);
  assert.deepEqual(v.clicks.ctr, { before: 0.05, after: 0.08 });
  assert.ok(Number.isFinite(v.clicks.effect));
});

test("clicks secondary: CTR is null for a window without impressions", () => {
  const i = input(1.5);
  i.page = i.page.map((r) => (r.date >= i.after.from && r.date <= i.after.to ? { ...r, clicks: 5, impressions: 0 } : r));
  const v = measure(i);
  assert.ok(typeof v.clicks === "object" && v.clicks !== null);
  assert.equal(v.clicks.ctr.after, null);
  assert.equal(v.clicks.ctr.before, 0.05);
});

test("clicks secondary: not enough clicks, and null when clicks is the metric", () => {
  const thin = input(1.5);
  thin.page = thin.page.map((r) => ({ ...r, clicks: r.date >= win.after.from ? 0 : r.clicks }));
  assert.equal(measure(thin).clicks, "not_enough_clicks");
  const v = measure(input(1.5, { metric: "clicks" }));
  assert.equal(v.clicks, null);
  assert.equal(v.label, "noticeable_gain");
});

test("position is impression weighted", () => {
  const i = input(1);
  i.page = [
    { date: i.before.from, clicks: 0, impressions: 90, position: 10 },
    { date: i.before.to, clicks: 0, impressions: 10, position: 20 },
    { date: i.after.from, clicks: 0, impressions: 0, position: 3 },
  ];
  const v = measure(i);
  assert.equal(v.position.before, 11);
  assert.equal(v.position.after, null);
  assert.deepEqual(v.page, { before: 100, after: 0 });
});

test("floor below marks the verdict unreliable", () => {
  assert.equal(measure(input(1, { floor: "below" })).unreliable, true);
});

test("the verdict is plain JSON with no undefined", () => {
  const v = measure(input(1.5));
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
});

test("invalid input throws LureError", () => {
  assert.throws(() => measure(input(1, { controls: [] })), LureError);
  assert.throws(() => measure(input(1, { metric: "position" as never })), LureError);
  assert.throws(() => measure(input(1, { liveOn: "2025-02-30" })), LureError);
  assert.throws(() => measure(input(1, { historyFrom: "nope" })), LureError);
  assert.throws(() => measure(input(1, { after: win.before })), LureError);
  assert.throws(() => measure(input(1, { before: { from: "2025-02-01", to: "2025-01-01" } })), LureError);
  assert.throws(() => windows("2026-13-01", "2026-01-01"), LureError);
  assert.throws(() => windows("2026-01-01", "x"), LureError);
});
