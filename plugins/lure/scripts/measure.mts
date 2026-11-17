// Lure's measurement arithmetic: one change on one page against 1-5 untouched control
// pages, from daily Search Console rows. Pure computation, no file or network I/O.
// Node built-ins only.
//
// The change is the log ratio of the page to its controls, after against before. Its noise
// is read from placebo windows: the same comparison made earlier in the history, where
// nothing was changed. A placebo shifts both windows back by whole weeks and must end
// before the change went live and stay clear of known outages.

export const WINDOW_DAYS = 28;
export const SETTLE_DAYS = 7;
export const DATA_LAG_DAYS = 3;
export const MIN_HISTORY_DAYS = 182;
export const MIN_CLICKS = 30;
export const LEVEL = 0.9;
const MIN_PLACEBOS = 5;
const ZERO_SUM = 0.5;

export class LureError extends Error {}

export type DayRow = { date: string; clicks: number; impressions: number; position: number };
export type Span = { from: string; to: string };
export type Metric = "impressions" | "clicks";

export type MeasureInput = {
  metric: Metric;
  expected: "up" | "down";
  floor: "measurable" | "weak" | "below";
  liveOn: string;
  before: Span;
  after: Span;
  historyFrom: string;
  page: DayRow[];
  controls: { page: string; rows: DayRow[] }[];
  outages: Span[];
};

export type Label = "noticeable_gain" | "worse" | "no_signal" | "insufficient_history";

export type Verdict = {
  label: Label;
  metric: Metric;
  expected: "up" | "down";
  effect: number;
  low: number | null;
  high: number | null;
  p: number | null;
  past: string;
  placebos: number;
  effective_windows: number;
  mde: number | null;
  unreliable: boolean;
  before: Span;
  after: Span;
  page: { before: number; after: number };
  controls: { before: number; after: number };
  per_control: { page: string; effect: number }[];
  position: { before: number | null; after: number | null };
  clicks: { effect: number; ctr: { before: number | null; after: number | null } } | "not_enough_clicks" | null;
};

// ---- dates --------------------------------------------------------------------------------

const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const overlaps = (a: Span, b: Span) => a.from <= b.to && b.from <= a.to;
const shift = (s: Span, days: number): Span => ({ from: addDays(s.from, days), to: addDays(s.to, days) });

function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new LureError(message);
}

// ---- windows ------------------------------------------------------------------------------

// The before window is the 28 days ending the day before the change went live. The after
// window starts SETTLE_DAYS after the later of going live and being crawled, and the check
// waits DATA_LAG_DAYS more for Search Console to settle.
export function windows(liveOn: string, crawledOn: string): { before: Span; after: Span; checkOn: string } {
  need(isDate(liveOn), `live_on is not a date: ${liveOn}`);
  need(isDate(crawledOn), `crawled_on is not a date: ${crawledOn}`);
  const start = addDays(liveOn > crawledOn ? liveOn : crawledOn, SETTLE_DAYS);
  const afterTo = addDays(start, WINDOW_DAYS - 1);
  const beforeTo = addDays(liveOn, -1);
  return {
    before: { from: addDays(beforeTo, -(WINDOW_DAYS - 1)), to: beforeTo },
    after: { from: start, to: afterTo },
    checkOn: addDays(afterTo, DATA_LAG_DAYS),
  };
}

// ---- arithmetic ---------------------------------------------------------------------------

export function sumIn(rows: DayRow[], span: Span, metric: Metric): number {
  let total = 0;
  for (const r of rows) if (r.date >= span.from && r.date <= span.to) total += r[metric];
  return total;
}

// ln(P_after / C_after) - ln(P_before / C_before); a zero sum counts as 0.5 so the log exists.
export function delta(pBefore: number, cBefore: number, pAfter: number, cAfter: number): number {
  const z = (x: number) => (x === 0 ? ZERO_SUM : x);
  return Math.log(z(pAfter) / z(cAfter)) - Math.log(z(pBefore) / z(cBefore));
}

// Nearest-rank quantile: the smallest value with at least a fraction q of the sample at or
// below it, i.e. sorted[ceil(q * n) - 1], clamped to the sample. No interpolation.
export function quantile(values: number[], q: number): number {
  need(values.length > 0, "quantile of an empty list");
  need(q >= 0 && q <= 1, "quantile level must be within 0..1");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

const round = (x: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
const expm1r = (log: number) => round(Math.exp(log) - 1, 4);

function weightedPosition(rows: DayRow[], span: Span): number | null {
  let imp = 0;
  let weighted = 0;
  for (const r of rows) {
    if (r.date >= span.from && r.date <= span.to) { imp += r.impressions; weighted += r.position * r.impressions; }
  }
  return imp > 0 ? round(weighted / imp, 2) : null;
}

// ---- measure ------------------------------------------------------------------------------

function validate(input: MeasureInput): void {
  need(input.metric === "impressions" || input.metric === "clicks", `metric must be impressions or clicks, not ${input.metric}`);
  need(input.expected === "up" || input.expected === "down", `expected must be up or down, not ${input.expected}`);
  need(["measurable", "weak", "below"].includes(input.floor), `floor must be measurable, weak or below, not ${input.floor}`);
  need(isDate(input.liveOn), `live_on is not a date: ${input.liveOn}`);
  need(isDate(input.historyFrom), `history start is not a date: ${input.historyFrom}`);
  for (const [name, s] of [["before", input.before], ["after", input.after]] as const) {
    need(s && isDate(s.from) && isDate(s.to), `the ${name} window needs two dates`);
    need(s.from <= s.to, `the ${name} window ends before it starts`);
  }
  need(input.after.from > input.before.to, "the after window must start after the before window ends");
  need(Array.isArray(input.controls) && input.controls.length > 0, "at least one control page is needed");
  for (const o of input.outages ?? []) need(o && isDate(o.from) && isDate(o.to) && o.from <= o.to, "an outage needs from ≤ to dates");
}

export function measure(input: MeasureInput): Verdict {
  validate(input);
  const { metric, before, after, page, controls, liveOn, historyFrom } = input;
  const ctrlSum = (span: Span, m: Metric = metric) => controls.reduce((t, c) => t + sumIn(c.rows, span, m), 0);

  const pB = sumIn(page, before, metric);
  const pA = sumIn(page, after, metric);
  const cB = ctrlSum(before);
  const cA = ctrlSum(after);
  const d = delta(pB, cB, pA, cA);

  // Placebo pairs: both windows shifted back by whole weeks, most recent first.
  type Pair = { delta: number; span: Span };
  const kept: Pair[] = [];
  for (let s = 7; ; s += 7) {
    const b = shift(before, -s);
    if (b.from < historyFrom) break;
    const a = shift(after, -s);
    if (a.to >= liveOn) continue;
    if (input.outages.some((o) => overlaps(b, o) || overlaps(a, o))) continue;
    kept.push({
      delta: delta(sumIn(page, b, metric), ctrlSum(b), sumIn(page, a, metric), ctrlSum(a)),
      span: { from: b.from, to: a.to },
    });
  }
  const m = kept.length;

  const counted: Span[] = [];
  for (const k of kept) if (!counted.some((c) => overlaps(c, k.span))) counted.push(k.span);

  const abs = kept.map((k) => Math.abs(k.delta));
  const q = m > 0 ? quantile(abs, LEVEL) : null;
  const lowLog = q === null ? null : d - q;
  const highLog = q === null ? null : d + q;
  const pastK = abs.filter((x) => x >= Math.abs(d)).length;

  let label: Label;
  if (daysBetween(historyFrom, liveOn) < MIN_HISTORY_DAYS || m < MIN_PLACEBOS) label = "insufficient_history";
  else {
    const sign = input.expected === "up" ? 1 : -1;
    const lo = sign * lowLog!;
    const hi = sign * highLog!;
    label = lo > 0 && hi > 0 ? "noticeable_gain" : lo < 0 && hi < 0 ? "worse" : "no_signal";
  }

  const per_control = controls.map((c, j) => {
    const others = controls.filter((_, i) => i !== j);
    const oB = others.reduce((t, o) => t + sumIn(o.rows, before, metric), 0);
    const oA = others.reduce((t, o) => t + sumIn(o.rows, after, metric), 0);
    // With no other control the denominator is 1 on both sides: the control's own change.
    const dj = others.length === 0
      ? delta(sumIn(c.rows, before, metric), 1, sumIn(c.rows, after, metric), 1)
      : delta(sumIn(c.rows, before, metric), oB, sumIn(c.rows, after, metric), oA);
    return { page: c.page, effect: expm1r(dj) };
  });

  let clicks: Verdict["clicks"] = null;
  if (metric === "impressions") {
    const kB = sumIn(page, before, "clicks");
    const kA = sumIn(page, after, "clicks");
    const iB = sumIn(page, before, "impressions");
    const iA = sumIn(page, after, "impressions");
    const ctr = (k: number, i: number) => (i > 0 ? Math.round((k / i) * 10000) / 10000 : null);
    clicks = kB >= MIN_CLICKS && kA >= MIN_CLICKS
      ? {
          effect: expm1r(delta(kB, ctrlSum(before, "clicks"), kA, ctrlSum(after, "clicks"))),
          ctr: { before: ctr(kB, iB), after: ctr(kA, iA) },
        }
      : "not_enough_clicks";
  }

  return {
    label,
    metric,
    expected: input.expected,
    effect: expm1r(d),
    low: lowLog === null ? null : expm1r(lowLog),
    high: highLog === null ? null : expm1r(highLog),
    p: m > 0 ? round((1 + pastK) / (1 + m), 4) : null,
    past: `${pastK} of ${m}`,
    placebos: m,
    effective_windows: counted.length,
    mde: q === null ? null : expm1r(q),
    unreliable: input.floor === "below",
    before: { ...before },
    after: { ...after },
    page: { before: Math.round(pB), after: Math.round(pA) },
    controls: { before: Math.round(cB), after: Math.round(cA) },
    per_control,
    position: { before: weightedPosition(page, before), after: weightedPosition(page, after) },
    clicks,
  };
}
