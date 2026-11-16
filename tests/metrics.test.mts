import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LureError, parseCsv, aggregate, addDays, defaultWindow, readPages, windowFor, pagesTable,
  renderYaml, parseYaml, splitFile, joinFile, record, busy, abandon, main, localToday,
} from "../plugins/lure/scripts/metrics.mts";
import type { RecordInput } from "../plugins/lure/scripts/metrics.mts";

// Synthetic data only: example.com URLs and made-up numbers.
const A = "https://example.com/a/";
const B = "https://example.com/b/";
const C = "https://example.com/c/";
const D = "https://example.com/d/";
const E = "https://example.com/e/";
const F = "https://example.com/f/";
const TODAY = "2026-02-12";

type Spec = { page: string; clicks: number; impressions: number; position: number };
const SPECS: Spec[] = [
  { page: A, clicks: 5, impressions: 100, position: 10 },
  { page: B, clicks: 3, impressions: 100, position: 20 },
  { page: C, clicks: 2, impressions: 200, position: 30 },
  { page: D, clicks: 1, impressions: 100, position: 15 },
  { page: E, clicks: 4, impressions: 100, position: 25 },
  { page: F, clicks: 1, impressions: 50, position: 40 },
];
const SITE = { clicks: 50, impressions: 1000, position: 12 };

const PAGES_HEADER = "date,page,clicks,impressions,ctr,position";
const SITE_HEADER = "date,clicks,impressions,ctr,position";

let ws = "";

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "lure-metrics-"));
  writeFileSync(join(ws, "lure.yaml"), "name: test\n");
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function writeCsv(file: string, header: string, rows: (string | number)[][]): void {
  mkdirSync(join(ws, "search-console"), { recursive: true });
  writeFileSync(join(ws, "search-console", file), [header, ...rows.map((r) => r.join(","))].join("\n") + "\n");
}

function dates(start: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}

// N consecutive days for the given pages, plus a constant site total.
function seed(specs: Spec[] = SPECS, n = 40, start = "2026-01-01"): void {
  const ds = dates(start, n);
  writeCsv("pages-daily.csv", PAGES_HEADER,
    ds.flatMap((d) => specs.map((s) => [d, s.page, s.clicks, s.impressions, s.clicks / s.impressions, s.position])));
  writeCsv("site-daily.csv", SITE_HEADER,
    ds.map((d) => [d, SITE.clicks, SITE.impressions, SITE.clicks / SITE.impressions, SITE.position]));
}

function base(over: Partial<RecordInput> = {}): RecordInput {
  return {
    slug: "new-title",
    page: A,
    change: "Rewrite the title",
    planned_live: "2026-03-01",
    metric: "clicks",
    expected: "up",
    floor: "measurable",
    floor_reason: "about 100 impressions a day",
    live_marker: "Brand new title",
    before: { title: "Old title", h1: "Old h1", description: "Old description" },
    controls: [B, C],
    sections: [{ heading: "Why", text: "Because the old title is vague." }],
    ...over,
  };
}

function refuses(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof LureError && re.test(e.message), `expected LureError ${re}`);
}

const readHeader = (path: string) => splitFile(readFileSync(path, "utf8")).header as any;

// ---- parseCsv -----------------------------------------------------------------------------

test("parseCsv: plain rows with a trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("parseCsv: no trailing newline keeps the last row", () => {
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("parseCsv: CRLF and bare CR line endings", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseCsv("a\rb\r"), [["a"], ["b"]]);
});

test("parseCsv: quoted fields with commas", () => {
  assert.deepEqual(parseCsv('"a,b",c\n'), [["a,b", "c"]]);
});

test("parseCsv: doubled quotes inside quoted fields", () => {
  assert.deepEqual(parseCsv('"say ""hi""",x\n'), [['say "hi"', "x"]]);
});

test("parseCsv: newlines (LF and CRLF) inside quotes stay in the field", () => {
  assert.deepEqual(parseCsv('"l1\nl2",x\n3,4\n'), [["l1\nl2", "x"], ["3", "4"]]);
  assert.deepEqual(parseCsv('"l1\r\nl2",x\r\n'), [["l1\r\nl2", "x"]]);
});

test("parseCsv: empty text, blank lines and empty fields", () => {
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("a\n\nb\n"), [["a"], ["b"]]);
  assert.deepEqual(parseCsv("a,\n"), [["a", ""]]);
  assert.deepEqual(parseCsv("a,"), [["a", ""]]);
  assert.deepEqual(parseCsv(",,\n"), [["", "", ""]]);
});

// ---- aggregate ----------------------------------------------------------------------------

test("aggregate: position is weighted by impressions", () => {
  const a = aggregate([
    { date: "2026-01-01", clicks: 1, impressions: 100, position: 10 },
    { date: "2026-01-02", clicks: 3, impressions: 300, position: 40 },
  ]);
  assert.equal(a.position, 32.5);
  assert.equal(a.clicks, 4);
  assert.equal(a.impressions, 400);
  assert.equal(a.ctr, 0.01);
  assert.equal(a.days, 2);
});

test("aggregate: ctr rounds to four digits and position to two", () => {
  const a = aggregate([{ date: "2026-01-01", clicks: 1, impressions: 3, position: 7 }]);
  assert.equal(a.ctr, 0.3333);
  const b = aggregate([
    { date: "2026-01-01", clicks: 0, impressions: 1, position: 1 },
    { date: "2026-01-02", clicks: 0, impressions: 2, position: 2 },
  ]);
  assert.equal(b.position, 1.67);
});

test("aggregate: days counts distinct dates, not rows", () => {
  const a = aggregate([
    { date: "2026-01-01", clicks: 1, impressions: 10, position: 5 },
    { date: "2026-01-01", clicks: 1, impressions: 10, position: 5 },
    { date: "2026-01-02", clicks: 1, impressions: 10, position: 5 },
  ]);
  assert.equal(a.days, 2);
  assert.equal(a.clicks, 3);
});

test("aggregate: zero impressions gives null ctr and null position", () => {
  const a = aggregate([{ date: "2026-01-01", clicks: 0, impressions: 0, position: 0 }]);
  assert.deepEqual(a, { days: 1, clicks: 0, impressions: 0, ctr: null, position: null });
});

test("aggregate: no rows at all", () => {
  assert.deepEqual(aggregate([]), { days: 0, clicks: 0, impressions: 0, ctr: null, position: null });
});

// ---- addDays / localToday -----------------------------------------------------------------

test("addDays: crosses month, year and leap day boundaries, both directions", () => {
  assert.equal(addDays("2024-02-28", 2), "2024-03-01");
  assert.equal(addDays("2025-02-28", 1), "2025-03-01");
  assert.equal(addDays("2025-12-31", 1), "2026-01-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2026-03-01", 0), "2026-03-01");
});

test("localToday: formats a Date in local time as YYYY-MM-DD", () => {
  assert.equal(localToday(new Date(2026, 0, 5, 23, 59, 59)), "2026-01-05");
  assert.equal(localToday(new Date(2026, 11, 31, 0, 0, 0)), "2026-12-31");
  assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
});

// ---- readPages / defaultWindow / windowFor / pagesTable -----------------------------------

test("readPages: reads rows and converts numbers", () => {
  writeCsv("pages-daily.csv", PAGES_HEADER, [["2026-01-01", A, 5, 100, 0.05, 10.5]]);
  assert.deepEqual(readPages(ws), [{ date: "2026-01-01", page: A, clicks: 5, impressions: 100, position: 10.5 }]);
});

test("readPages: wrong header is a LureError", () => {
  mkdirSync(join(ws, "search-console"));
  writeFileSync(join(ws, "search-console", "pages-daily.csv"), "date,page,clicks\n2026-01-01,x,1\n");
  refuses(() => readPages(ws), /header/);
});

test("readPages: an empty file is a LureError", () => {
  mkdirSync(join(ws, "search-console"));
  writeFileSync(join(ws, "search-console", "pages-daily.csv"), "");
  refuses(() => readPages(ws), /header/);
});

test("readPages: a missing file is a LureError that points at pulling", () => {
  refuses(() => readPages(ws), /pull/);
});

test("windowFor: missing site file is a LureError that points at pulling", () => {
  writeCsv("pages-daily.csv", PAGES_HEADER, [["2026-01-01", A, 5, 100, 0.05, 10]]);
  refuses(() => windowFor(ws, A), /pull/);
});

test("defaultWindow: 28 days ending on the last date in the file", () => {
  seed(SPECS, 40);
  const w = defaultWindow(readPages(ws));
  assert.deepEqual(w, { from: "2026-01-13", to: "2026-02-09" });
  assert.equal(dates(w.from, 28).at(-1), w.to);
});

test("defaultWindow: the last date wins even when rows are not sorted", () => {
  const rows = [
    { date: "2026-03-10", page: A, clicks: 0, impressions: 0, position: 0 },
    { date: "2026-03-01", page: A, clicks: 0, impressions: 0, position: 0 },
  ];
  assert.deepEqual(defaultWindow(rows), { from: "2026-02-11", to: "2026-03-10" });
});

test("defaultWindow: an empty file is a LureError", () => {
  refuses(() => defaultWindow([]), /empty/);
  writeCsv("pages-daily.csv", PAGES_HEADER, []);
  writeCsv("site-daily.csv", SITE_HEADER, []);
  refuses(() => windowFor(ws, A), /empty/);
  refuses(() => pagesTable(ws), /empty/);
});

test("windowFor: default window aggregates the page and the site", () => {
  seed(SPECS, 40);
  const w = windowFor(ws, A);
  assert.equal(w.from, "2026-01-13");
  assert.equal(w.to, "2026-02-09");
  assert.deepEqual(w.page, { days: 28, clicks: 140, impressions: 2800, ctr: 0.05, position: 10 });
  assert.deepEqual(w.site, { days: 28, clicks: 1400, impressions: 28000, ctr: 0.05, position: 12 });
});

test("windowFor: explicit from/to are inclusive on both ends", () => {
  seed(SPECS, 40);
  const w = windowFor(ws, A, "2026-01-10", "2026-01-16");
  assert.equal(w.from, "2026-01-10");
  assert.equal(w.to, "2026-01-16");
  assert.equal(w.page.days, 7);
  assert.equal(w.page.clicks, 35);
  assert.equal(w.site.days, 7);
  assert.equal(windowFor(ws, A, "2026-01-10", "2026-01-10").page.days, 1);
});

test("windowFor: days missing from the file only reduce days", () => {
  const ds = dates("2026-01-01", 10);
  writeCsv("pages-daily.csv", PAGES_HEADER,
    ds.filter((_, i) => i % 2 === 0).map((d) => [d, A, 2, 20, 0.1, 8]).concat(ds.map((d) => [d, B, 1, 10, 0.1, 9])));
  writeCsv("site-daily.csv", SITE_HEADER, ds.map((d) => [d, 10, 100, 0.1, 5]));
  const w = windowFor(ws, A, "2026-01-01", "2026-01-10");
  assert.equal(w.page.days, 5);
  assert.equal(w.page.clicks, 10);
  assert.equal(w.page.impressions, 100);
  assert.equal(w.page.position, 8);
  assert.equal(w.site.days, 10);
});

test("windowFor: site totals come from site-daily.csv, not from the sum of pages", () => {
  seed(SPECS, 40);
  const w = windowFor(ws, A);
  const pagesSum = SPECS.reduce((s, p) => s + p.impressions, 0) * 28;
  assert.notEqual(w.site.impressions, pagesSum);
  assert.equal(w.site.impressions, SITE.impressions * 28);
});

test("windowFor: a page with no rows in the window aggregates to zero", () => {
  seed(SPECS, 40);
  const w = windowFor(ws, "https://example.com/nothing/");
  assert.deepEqual(w.page, { days: 0, clicks: 0, impressions: 0, ctr: null, position: null });
});

test("windowFor: bad dates and from > to are LureErrors", () => {
  seed(SPECS, 40);
  refuses(() => windowFor(ws, A, "2026-02-01", "2026-01-01"), /from/);
  refuses(() => windowFor(ws, A, "yesterday", "2026-01-01"), /from/);
  refuses(() => windowFor(ws, A, "2026-01-01", "2026-13-01"), /from/);
  refuses(() => windowFor(ws, A, "2026-1-1", "2026-01-05"), /from/);
  refuses(() => windowFor(ws, A, "2026-01-01", undefined), /from/);
  refuses(() => windowFor(ws, A, undefined, "2026-01-05"), /from/);
});

test("pagesTable: sorted by impressions desc, then page", () => {
  const ds = dates("2026-01-01", 5);
  const rows: (string | number)[][] = [];
  for (const d of ds) {
    rows.push([d, B, 1, 100, 0.01, 10]);
    rows.push([d, A, 1, 100, 0.01, 10]);
    rows.push([d, C, 1, 300, 0.003, 10]);
    rows.push([d, D, 1, 10, 0.1, 10]);
  }
  writeCsv("pages-daily.csv", PAGES_HEADER, rows);
  writeCsv("site-daily.csv", SITE_HEADER, []);
  const t = pagesTable(ws);
  assert.deepEqual(t.pages.map((p) => p.page), [C, A, B, D]);
  assert.equal(t.pages[0].impressions, 1500);
  assert.equal(t.pages[0].days, 5);
});

test("pagesTable: only rows inside the window count", () => {
  seed(SPECS, 40);
  const t = pagesTable(ws, "2026-01-01", "2026-01-03");
  assert.equal(t.from, "2026-01-01");
  assert.equal(t.to, "2026-01-03");
  const a = t.pages.find((p) => p.page === A)!;
  assert.equal(a.days, 3);
  assert.equal(a.clicks, 15);
  const def = pagesTable(ws);
  assert.equal(def.from, "2026-01-13");
  assert.equal(def.pages.find((p) => p.page === A)!.days, 28);
});

test("pagesTable: a window with no rows is an empty table", () => {
  seed(SPECS, 10);
  assert.deepEqual(pagesTable(ws, "2030-01-01", "2030-01-31").pages, []);
});

// ---- YAML subset --------------------------------------------------------------------------

test("yaml: strings that look like other types stay strings", () => {
  const tricky = ["null", "true", "false", "123", "1.5", "-4", "2026-01-05", "[]", "yes", "", "Null", "0x1F", "- dash"];
  const obj: any = { items: tricky };
  for (const [i, s] of tricky.entries()) obj[`k${i}`] = s;
  const back = parseYaml(renderYaml(obj)) as any;
  assert.deepEqual(back, obj);
  for (const s of tricky) assert.equal(typeof back.items[tricky.indexOf(s)], "string");
});

test("yaml: real null, booleans and numbers keep their types", () => {
  const obj = { n: null, t: true, f: false, i: 42, neg: -3, fl: 0.0125 };
  assert.deepEqual(parseYaml(renderYaml(obj)), obj);
});

test("yaml: dates render bare, other strings quoted when needed", () => {
  const out = renderYaml({ d: "2026-01-05", id: "2026-01-05-my-slug", s: "null", n: "12", plain: "abc" });
  assert.match(out, /^d: 2026-01-05$/m);
  assert.match(out, /^s: "null"$/m);
  assert.match(out, /^n: "12"$/m);
  assert.match(out, /^plain: abc$/m);
});

test("yaml: quotes, colons, newlines and unicode survive", () => {
  const obj = {
    q: 'He said "hi"',
    colon: "key: value # not a comment",
    nl: "line1\nline2",
    cyr: "Заголовок страницы",
    dash: "Тест — проверка",
    back: "back\\slash",
    lead: "  padded  ",
  };
  const text = renderYaml(obj);
  assert.ok(text.includes("Заголовок страницы"), "unicode is written as is");
  assert.ok(text.includes("—"));
  assert.deepEqual(parseYaml(text), obj);
});

test("yaml: an empty list renders as [] and parses back", () => {
  assert.equal(renderYaml({ events: [] }), "events: []\n");
  assert.deepEqual(parseYaml("events: []\n"), { events: [] });
});

test("yaml: a list of strings", () => {
  const obj = { events: ["2026-01-05 deploy", "note: with colon", "plain"] };
  const text = renderYaml(obj);
  assert.match(text, /^events:\n {2}- "2026-01-05 deploy"\n/);
  assert.deepEqual(parseYaml(text), obj);
});

test("yaml: a list of maps (controls) with null values", () => {
  const obj = {
    controls: [
      { page: B, days: 28, clicks: 84, impressions: 2800, ctr: 0.03, position: 20 },
      { page: C, days: 0, clicks: 0, impressions: 0, ctr: null, position: null },
    ],
    after: "x",
  };
  assert.deepEqual(parseYaml(renderYaml(obj)), obj);
});

test("yaml: nested maps (baseline.page)", () => {
  const obj = {
    baseline: {
      from: "2026-01-13",
      to: "2026-02-09",
      page: { days: 28, clicks: 140, ctr: 0.05, position: null },
      site: { days: 28, clicks: 1400, ctr: 0.05, position: 12 },
    },
    tail: true,
  };
  const text = renderYaml(obj);
  assert.match(text, /^baseline:\n {2}from: 2026-01-13\n/);
  assert.match(text, /^ {4}days: 28$/m);
  assert.deepEqual(parseYaml(text), obj);
});

test("yaml: undefined values are skipped", () => {
  assert.equal(renderYaml({ a: 1, b: undefined as any, c: 2 }), "a: 1\nc: 2\n");
});

test("yaml: an unreadable line is a LureError", () => {
  refuses(() => parseYaml("this is not yaml\n"), /unreadable/);
});

test("splitFile/joinFile: round trip and refusal without a header", () => {
  const header = { id: "x", n: 1, list: ["a b"] };
  const text = joinFile(header, "\n## Why\n\nBody.\n");
  assert.ok(text.startsWith("---\n"));
  const s = splitFile(text);
  assert.deepEqual(s.header, header);
  assert.equal(s.body, "\n## Why\n\nBody.\n");
  assert.equal(joinFile(s.header, s.body), text);
  refuses(() => splitFile("no header here\n"), /header/);
});

// ---- record -------------------------------------------------------------------------------

test("record: writes a planned hypothesis with baseline equal to windowFor", () => {
  seed(SPECS, 40);
  const r = record(ws, base(), TODAY);
  const id = `${TODAY}-new-title`;
  assert.equal(r.path, join(ws, "hypotheses", `${id}.md`));
  assert.ok(existsSync(r.path));
  assert.deepEqual(r.released, []);

  const h = readHeader(r.path);
  assert.equal(h.lure_hypothesis, 1);
  assert.equal(h.id, id);
  assert.equal(h.status, "planned");
  assert.equal(h.page, A);
  assert.equal(h.recorded, TODAY);
  assert.equal(h.planned_live, "2026-03-01");
  assert.equal(h.check_on, "2026-04-01");
  assert.equal(h.window_days, 28);
  assert.equal(h.metric, "clicks");
  assert.equal(h.expected, "up");
  assert.equal(h.floor, "measurable");
  assert.equal("secondary" in h, false);
  assert.deepEqual(h.before, { title: "Old title", h1: "Old h1", description: "Old description" });
  assert.deepEqual(h.events, []);

  const wa = windowFor(ws, A);
  assert.equal(h.baseline.from, wa.from);
  assert.equal(h.baseline.to, wa.to);
  assert.deepEqual(h.baseline.page, wa.page);
  assert.deepEqual(h.baseline.site, wa.site);
  assert.deepEqual(h.baseline.page, { days: 28, clicks: 140, impressions: 2800, ctr: 0.05, position: 10 });
  assert.equal(h.controls.length, 2);
  for (const [i, c] of [B, C].entries()) {
    assert.deepEqual(h.controls[i], { page: c, ...windowFor(ws, c, wa.from, wa.to).page });
  }
  assert.equal(h.controls[0].clicks, 84);
  assert.equal(h.controls[1].impressions, 5600);

  const body = splitFile(readFileSync(r.path, "utf8")).body;
  assert.equal(body, "\n## Why\n\nBecause the old title is vague.\n");
  assert.equal(readdirSync(join(ws, "hypotheses")).some((f) => f.endsWith(".part")), false);
});

test("record: check_on is planned_live plus 31 days across a year end", () => {
  seed(SPECS, 40);
  const r = record(ws, base({ planned_live: "2026-12-15" }), TODAY);
  assert.equal(readHeader(r.path).check_on, "2027-01-15");
});

test("record: explicit from/to set the baseline window for page, site and controls", () => {
  seed(SPECS, 40);
  const r = record(ws, base({ from: "2026-01-10", to: "2026-01-16" }), TODAY);
  const h = readHeader(r.path);
  assert.equal(h.baseline.from, "2026-01-10");
  assert.equal(h.baseline.to, "2026-01-16");
  assert.equal(h.baseline.page.days, 7);
  assert.equal(h.baseline.site.days, 7);
  assert.equal(h.controls[0].days, 7);
});

test("record: recorded overrides today in the id and the planned_live check", () => {
  seed(SPECS, 40);
  const r = record(ws, base({ recorded: "2026-02-01", planned_live: "2026-02-05" }), TODAY);
  assert.ok(r.path.endsWith("2026-02-01-new-title.md"));
  assert.equal(readHeader(r.path).recorded, "2026-02-01");
});

test("record: secondary metric is written with its direction", () => {
  seed(SPECS, 40);
  const r = record(ws, base({ secondary: "position", secondary_expected: "down" }), TODAY);
  const h = readHeader(r.path);
  assert.equal(h.secondary, "position");
  assert.equal(h.secondary_expected, "down");
});

test("record: events and missing before fields", () => {
  seed(SPECS, 40);
  const r = record(ws, base({ before: {}, events: ["2026-02-01 site migration", "note: a: b"] }), TODAY);
  const h = readHeader(r.path);
  assert.deepEqual(h.before, { title: null, h1: null, description: null });
  assert.deepEqual(h.events, ["2026-02-01 site migration", "note: a: b"]);
});

test("record: a written file with unicode round-trips byte for byte", () => {
  seed(SPECS, 40);
  const r = record(ws, base({
    change: "Заголовок — новый: тест",
    before: { title: 'Старый "заголовок"', h1: "H1: один", description: "Описание — длинное" },
    events: ["пример: событие"],
    sections: [
      { heading: "Почему", text: "Потому что — так." },
      { heading: "How", text: "Line one\n\nLine two" },
    ],
  }), TODAY);
  const onDisk = readFileSync(r.path, "utf8");
  assert.equal(onDisk, r.text);
  const { header, body } = splitFile(onDisk);
  assert.equal(joinFile(header, body), onDisk);
  assert.equal((header as any).change, "Заголовок — новый: тест");
  assert.equal((header as any).before.title, 'Старый "заголовок"');
});

test("record: dryRun returns the text and writes nothing", () => {
  seed(SPECS, 40);
  const r = record(ws, base(), TODAY, true);
  assert.deepEqual(r.released, []);
  assert.ok(r.text.startsWith("---\n"));
  assert.equal(existsSync(join(ws, "hypotheses")), false);
  const real = record(ws, base(), TODAY);
  assert.equal(readFileSync(real.path, "utf8"), r.text);
});

test("record: dryRun with release_controls_of leaves the other file untouched", () => {
  seed(SPECS, 40);
  const h1 = record(ws, base({ slug: "first" }), TODAY);
  const before = readFileSync(h1.path, "utf8");
  record(ws, base({ slug: "second", page: B, controls: [D, E], release_controls_of: ["2026-02-12-first"] }), TODAY, true);
  assert.equal(readFileSync(h1.path, "utf8"), before);
  assert.equal(readdirSync(join(ws, "hypotheses")).length, 1);
});

test("record: a refused record leaves no file behind", () => {
  seed(SPECS, 40);
  refuses(() => record(ws, base({ slug: "Bad Slug" }), TODAY), /slug/);
  assert.equal(existsSync(join(ws, "hypotheses")), false);
});

test("record: refuses a workspace without lure.yaml", () => {
  seed(SPECS, 40);
  rmSync(join(ws, "lure.yaml"));
  refuses(() => record(ws, base(), TODAY), /lure\.yaml/);
});

test("record: refuses bad slugs", () => {
  seed(SPECS, 40);
  for (const slug of ["", "Upper", "has space", "-lead", "under_score", "a".repeat(62), "ключ"]) {
    refuses(() => record(ws, base({ slug }), TODAY), /slug/);
  }
  assert.doesNotThrow(() => record(ws, base({ slug: "a".repeat(61) }), TODAY, true));
  assert.doesNotThrow(() => record(ws, base({ slug: "0-ok" }), TODAY, true));
});

test("record: refuses a page that is not a URL", () => {
  seed(SPECS, 40);
  for (const page of ["/a/", "example.com/a/", "ftp://example.com/a/", ""]) {
    refuses(() => record(ws, base({ page }), TODAY), /page/);
  }
});

test("record: refuses an empty change, floor_reason and live_marker", () => {
  seed(SPECS, 40);
  refuses(() => record(ws, base({ change: "   " }), TODAY), /change/);
  refuses(() => record(ws, base({ floor_reason: "" }), TODAY), /floor_reason/);
  refuses(() => record(ws, base({ live_marker: " " }), TODAY), /live_marker/);
});

test("record: refuses planned_live before today or not a date", () => {
  seed(SPECS, 40);
  refuses(() => record(ws, base({ planned_live: "2026-02-11" }), TODAY), /planned_live/);
  refuses(() => record(ws, base({ planned_live: "soon" }), TODAY), /planned_live/);
  refuses(() => record(ws, base({ planned_live: "2026-02-30x" }), TODAY), /planned_live/);
  assert.doesNotThrow(() => record(ws, base({ planned_live: TODAY }), TODAY, true));
});

test("record: refuses unknown metric, expected and floor", () => {
  seed(SPECS, 40);
  refuses(() => record(ws, base({ metric: "ctr" }), TODAY), /metric/);
  refuses(() => record(ws, base({ expected: "sideways" }), TODAY), /expected/);
  refuses(() => record(ws, base({ floor: "huge" }), TODAY), /floor/);
});

test("record: refuses a secondary equal to the metric or without a direction", () => {
  seed(SPECS, 40);
  refuses(() => record(ws, base({ secondary: "clicks", secondary_expected: "up" }), TODAY), /secondary/);
  refuses(() => record(ws, base({ secondary: "bogus", secondary_expected: "up" }), TODAY), /secondary/);
  refuses(() => record(ws, base({ secondary: "position" }), TODAY), /secondary_expected/);
  refuses(() => record(ws, base({ secondary: "position", secondary_expected: "flat" }), TODAY), /secondary_expected/);
});

test("record: refuses zero or six controls, accepts one and five", () => {
  seed(SPECS, 40);
  refuses(() => record(ws, base({ controls: [] }), TODAY), /controls/);
  refuses(() => record(ws, base({ controls: [B, C, D, E, F, "https://example.com/g/"] }), TODAY), /controls/);
  refuses(() => record(ws, base({ controls: undefined as any }), TODAY), /controls/);
  assert.doesNotThrow(() => record(ws, base({ controls: [B] }), TODAY, true));
  assert.doesNotThrow(() => record(ws, base({ controls: [B, C, D, E, F] }), TODAY, true));
});

test("record: refuses duplicate controls and a page among its own controls", () => {
  seed(SPECS, 40);
  refuses(() => record(ws, base({ controls: [B, B] }), TODAY), /each page once/);
  refuses(() => record(ws, base({ controls: [B, A] }), TODAY), /own control/);
});

test("record: refuses sections that are not a list", () => {
  seed(SPECS, 40);
  refuses(() => record(ws, base({ sections: undefined as any }), TODAY), /sections/);
});

test("record: refuses an id that already exists, even on another page", () => {
  seed(SPECS, 40);
  record(ws, base(), TODAY);
  refuses(() => record(ws, base({ page: D, controls: [E] }), TODAY), /already exists/);
});

test("record: one hypothesis per page while the first is active", () => {
  seed(SPECS, 40);
  const first = record(ws, base({ slug: "first" }), TODAY);
  refuses(() => record(ws, base({ slug: "second" }), TODAY), /2026-02-12-first/);
  assert.equal(readdirSync(join(ws, "hypotheses")).length, 1);

  abandon(ws, readHeader(first.path).id, "changed our mind", "2026-02-13");
  const second = record(ws, base({ slug: "second" }), TODAY);
  assert.ok(existsSync(second.path));
});

test("record: a control cannot be the target of an active hypothesis", () => {
  seed(SPECS, 40);
  record(ws, base({ slug: "first" }), TODAY);
  refuses(() => record(ws, base({ slug: "second", page: D, controls: [A, E] }), TODAY), /2026-02-12-first/);
});

test("record: controls of an abandoned hypothesis no longer block recording on them", () => {
  seed(SPECS, 40);
  record(ws, base({ slug: "first" }), TODAY);
  abandon(ws, "2026-02-12-first", "no longer needed", TODAY);
  assert.doesNotThrow(() => record(ws, base({ slug: "second", page: B, controls: [D] }), TODAY));
});

test("record: a page that is a control of an active hypothesis needs release_controls_of", () => {
  seed(SPECS, 40);
  record(ws, base({ slug: "first" }), TODAY);
  refuses(() => record(ws, base({ slug: "second", page: B, controls: [D, E] }), TODAY), /2026-02-12-first/);
  refuses(() => record(ws, base({ slug: "second", page: B, controls: [D, E], release_controls_of: ["other-id"] }), TODAY), /2026-02-12-first/);
  assert.equal(existsSync(join(ws, "hypotheses", "2026-02-12-second.md")), false);
});

test("record: release_controls_of releases the control and changes nothing else in the other file", () => {
  seed(SPECS, 40);
  const h1 = record(ws, base({ slug: "first" }), TODAY);
  const before = splitFile(readFileSync(h1.path, "utf8"));
  const today2 = "2026-02-14";

  const h2 = record(ws, base({ slug: "second", page: B, controls: [D, E], release_controls_of: ["2026-02-12-first"] }), today2);
  assert.deepEqual(h2.released, ["2026-02-12-first"]);
  assert.ok(existsSync(h2.path));

  const after = splitFile(readFileSync(h1.path, "utf8"));
  const bh = before.header as any;
  const ah = after.header as any;
  assert.equal(after.body, before.body);
  assert.deepEqual(ah.controls[0], { ...bh.controls[0], released: today2, released_because: "2026-02-14-second changes this page" });
  assert.deepEqual(ah.controls[1], bh.controls[1]);
  const { controls: _bc, ...restBefore } = bh;
  const { controls: _ac, ...restAfter } = ah;
  assert.deepEqual(restAfter, restBefore);
  // The rewritten file is still in canonical form.
  const text = readFileSync(h1.path, "utf8");
  assert.equal(joinFile(after.header, after.body), text);

  const b = busy(ws).map((x) => `${x.page} ${x.role} ${x.id}`).sort();
  assert.deepEqual(b, [
    `${A} target 2026-02-12-first`,
    `${B} target 2026-02-14-second`,
    `${C} control 2026-02-12-first`,
    `${D} control 2026-02-14-second`,
    `${E} control 2026-02-14-second`,
  ].sort());
});

test("record: a page that is a control of two hypotheses must release both", () => {
  seed(SPECS, 40);
  record(ws, base({ slug: "first", page: A, controls: [B, C] }), TODAY);
  record(ws, base({ slug: "second", page: D, controls: [B, E] }), TODAY);
  refuses(
    () => record(ws, base({ slug: "third", page: B, controls: [F], release_controls_of: ["2026-02-12-first"] }), TODAY),
    /2026-02-12-second/,
  );
  const r = record(ws, base({ slug: "third", page: B, controls: [F], release_controls_of: ["2026-02-12-first", "2026-02-12-second"] }), TODAY);
  assert.deepEqual(r.released.sort(), ["2026-02-12-first", "2026-02-12-second"]);
  assert.equal(busy(ws).some((x) => x.page === B && x.role === "control"), false);
});

// ---- busy ---------------------------------------------------------------------------------

test("busy: no hypotheses directory means nothing is busy", () => {
  assert.deepEqual(busy(ws), []);
});

test("busy: lists targets and unreleased controls of planned and live hypotheses only", () => {
  seed([...SPECS, { page: "https://example.com/g/", clicks: 1, impressions: 50, position: 40 }], 40);
  const planned = record(ws, base({ slug: "planned-one", page: A, controls: [B] }), TODAY);
  const live = record(ws, base({ slug: "live-one", page: C, controls: [D] }), TODAY);
  const measured = record(ws, base({ slug: "measured-one", page: E, controls: [F] }), TODAY);
  const dropped = record(ws, base({ slug: "dropped-one", page: "https://example.com/g/", controls: [B] }), TODAY);

  const setStatus = (path: string, status: string) =>
    writeFileSync(path, readFileSync(path, "utf8").replace("status: planned\n", `status: ${status}\n`));
  setStatus(live.path, "live");
  setStatus(measured.path, "measured");
  abandon(ws, readHeader(dropped.path).id, "not doing it", TODAY);
  assert.ok(existsSync(planned.path));

  const rows = busy(ws);
  assert.deepEqual(
    rows.map((x) => `${x.page} ${x.role} ${x.id} ${x.status}`).sort(),
    [
      `${A} target 2026-02-12-planned-one planned`,
      `${B} control 2026-02-12-planned-one planned`,
      `${C} target 2026-02-12-live-one live`,
      `${D} control 2026-02-12-live-one live`,
    ].sort(),
  );
});

// ---- abandon ------------------------------------------------------------------------------

test("abandon: sets status, date and reason and keeps the rest of the file", () => {
  seed(SPECS, 40);
  const r = record(ws, base(), TODAY);
  const before = splitFile(readFileSync(r.path, "utf8"));
  const path = abandon(ws, "2026-02-12-new-title", "  the page was redesigned  ", "2026-02-20");
  assert.equal(path, r.path);
  const after = splitFile(readFileSync(path, "utf8"));
  const ah = after.header as any;
  assert.equal(ah.status, "abandoned");
  assert.equal(ah.abandoned, "2026-02-20");
  assert.equal(ah.abandon_reason, "the page was redesigned");
  assert.equal(after.body, before.body);
  const { status: _s, abandoned: _a, abandon_reason: _r, ...restAfter } = ah;
  const { status: _s2, ...restBefore } = before.header as any;
  assert.deepEqual(restAfter, restBefore);
  assert.equal(joinFile(after.header, after.body), readFileSync(path, "utf8"));
  assert.deepEqual(busy(ws), []);
});

test("abandon: a reason with quotes and unicode survives", () => {
  seed(SPECS, 40);
  const r = record(ws, base(), TODAY);
  abandon(ws, "2026-02-12-new-title", 'причина: "тест" — ok', TODAY);
  assert.equal(readHeader(r.path).abandon_reason, 'причина: "тест" — ok');
});

test("abandon: refuses an unknown id", () => {
  seed(SPECS, 40);
  refuses(() => abandon(ws, "nope", "reason", TODAY), /no hypothesis nope/);
  record(ws, base(), TODAY);
  refuses(() => abandon(ws, "nope", "reason", TODAY), /no hypothesis nope/);
});

test("abandon: refuses an empty reason", () => {
  seed(SPECS, 40);
  record(ws, base(), TODAY);
  refuses(() => abandon(ws, "2026-02-12-new-title", "", TODAY), /reason/);
  refuses(() => abandon(ws, "2026-02-12-new-title", "   ", TODAY), /reason/);
  assert.equal(readHeader(join(ws, "hypotheses", "2026-02-12-new-title.md")).status, "planned");
});

test("abandon: refuses a hypothesis that is already abandoned or measured", () => {
  seed(SPECS, 40);
  const r = record(ws, base(), TODAY);
  abandon(ws, "2026-02-12-new-title", "first reason", TODAY);
  refuses(() => abandon(ws, "2026-02-12-new-title", "second reason", "2026-02-21"), /abandoned/);
  assert.equal(readHeader(r.path).abandon_reason, "first reason");

  writeFileSync(r.path, readFileSync(r.path, "utf8").replace("status: abandoned\n", "status: measured\n"));
  refuses(() => abandon(ws, "2026-02-12-new-title", "late", TODAY), /measured/);
});

// ---- main ---------------------------------------------------------------------------------

function capture(t: { mock: { method: (...a: any[]) => any } }) {
  const log = t.mock.method(console, "log", () => {});
  const err = t.mock.method(console, "error", () => {});
  return {
    out: () => log.mock.calls.map((c: any) => String(c.arguments[0])),
    errs: () => err.mock.calls.map((c: any) => String(c.arguments[0])),
  };
}

test("main: pages prints the window line, a header and one row per page", (t) => {
  seed(SPECS, 40);
  const cap = capture(t);
  assert.equal(main(["pages", "--workspace", ws], TODAY), 0);
  const lines = cap.out();
  assert.equal(lines[0], "window 2026-01-13 … 2026-02-09");
  assert.equal(lines[1], "impressions\tclicks\tctr\tposition\tdays\tpage");
  assert.equal(lines.length, 2 + SPECS.length);
  assert.equal(lines[2], `5600\t56\t0.01\t30\t28\t${C}`);
});

test("main: pages prints a dash for null ctr and position", (t) => {
  writeCsv("pages-daily.csv", PAGES_HEADER, [["2026-01-01", A, 0, 0, 0, 0]]);
  writeCsv("site-daily.csv", SITE_HEADER, []);
  const cap = capture(t);
  assert.equal(main(["pages", "--workspace", ws], TODAY), 0);
  assert.equal(cap.out()[2], `0\t0\t-\t-\t1\t${A}`);
});

test("main: pages --json with --from/--to prints parseable JSON", (t) => {
  seed(SPECS, 40);
  const cap = capture(t);
  assert.equal(main(["pages", "--workspace", ws, "--from", "2026-01-01", "--to", "2026-01-02", "--json"], TODAY), 0);
  const parsed = JSON.parse(cap.out()[0]);
  assert.equal(parsed.from, "2026-01-01");
  assert.equal(parsed.to, "2026-01-02");
  assert.equal(parsed.pages.length, SPECS.length);
});

test("main: window prints JSON and requires --page", (t) => {
  seed(SPECS, 40);
  const cap = capture(t);
  assert.equal(main(["window", "--workspace", ws, "--page", A], TODAY), 0);
  assert.equal(JSON.parse(cap.out()[0]).page.clicks, 140);
  assert.equal(main(["window", "--workspace", ws], TODAY), 1);
  assert.match(cap.errs().at(-1)!, /--page is required/);
});

test("main: busy prints a message when nothing is active", (t) => {
  const cap = capture(t);
  assert.equal(main(["busy", "--workspace", ws], TODAY), 0);
  assert.deepEqual(cap.out(), ["no active hypotheses"]);
});

test("main: record, busy and abandon work end to end", (t) => {
  seed(SPECS, 40);
  const input = join(ws, "input.json");
  writeFileSync(input, JSON.stringify(base()));
  const cap = capture(t);

  assert.equal(main(["record", "--workspace", ws, "--input", input, "--dry-run"], TODAY), 0);
  assert.ok(cap.out()[0].startsWith("---\n"));
  assert.equal(existsSync(join(ws, "hypotheses")), false);

  assert.equal(main(["record", "--workspace", ws, "--input", input], TODAY), 0);
  const path = join(ws, "hypotheses", `${TODAY}-new-title.md`);
  assert.ok(cap.out().includes(`written: ${path}`));

  assert.equal(main(["busy", "--workspace", ws], TODAY), 0);
  assert.ok(cap.out().includes(`${A}\ttarget\t${TODAY}-new-title\tplanned`));

  assert.equal(main(["abandon", "--workspace", ws, "--id", `${TODAY}-new-title`, "--reason", "done"], TODAY), 0);
  assert.ok(cap.out().includes(`abandoned: ${path}`));
});

test("main: record announces released controls", (t) => {
  seed(SPECS, 40);
  record(ws, base({ slug: "first" }), TODAY);
  const input = join(ws, "input.json");
  writeFileSync(input, JSON.stringify(base({ slug: "second", page: B, controls: [D], release_controls_of: [`${TODAY}-first`] })));
  const cap = capture(t);
  assert.equal(main(["record", "--workspace", ws, "--input", input], TODAY), 0);
  assert.ok(cap.out().includes(`control released in: ${TODAY}-first`));
});

test("main: no command prints usage and returns 2", (t) => {
  const cap = capture(t);
  assert.equal(main(["--workspace", ws], TODAY), 2);
  assert.match(cap.errs()[0], /usage/);
  assert.equal(main(["frobnicate", "--workspace", ws], TODAY), 2);
});

test("main: missing --workspace returns 1", (t) => {
  const cap = capture(t);
  assert.equal(main(["pages"], TODAY), 1);
  assert.equal(main([], TODAY), 1);
  assert.match(cap.errs()[0], /^lure: --workspace is required/);
});

test("main: record with unreadable or missing JSON returns 1", (t) => {
  seed(SPECS, 40);
  const bad = join(ws, "bad.json");
  writeFileSync(bad, "{not json");
  const cap = capture(t);
  assert.equal(main(["record", "--workspace", ws, "--input", bad], TODAY), 1);
  assert.match(cap.errs()[0], /not readable JSON/);
  assert.equal(main(["record", "--workspace", ws, "--input", join(ws, "missing.json")], TODAY), 1);
  assert.equal(main(["record", "--workspace", ws], TODAY), 1);
  assert.match(cap.errs().at(-1)!, /--input is required/);
});

test("main: record that fails validation returns 1 with a lure: message", (t) => {
  seed(SPECS, 40);
  const input = join(ws, "input.json");
  writeFileSync(input, JSON.stringify(base({ slug: "BAD" })));
  const cap = capture(t);
  assert.equal(main(["record", "--workspace", ws, "--input", input], TODAY), 1);
  assert.match(cap.errs()[0], /^lure: slug/);
});

test("main: abandon without --id or with an unknown id returns 1", (t) => {
  seed(SPECS, 40);
  const cap = capture(t);
  assert.equal(main(["abandon", "--workspace", ws], TODAY), 1);
  assert.match(cap.errs()[0], /--id is required/);
  assert.equal(main(["abandon", "--workspace", ws, "--id", "nope", "--reason", "x"], TODAY), 1);
  assert.equal(main(["abandon", "--workspace", ws, "--id", "nope"], TODAY), 1);
});

test("main: a missing history returns 1 and points at pulling", (t) => {
  const cap = capture(t);
  assert.equal(main(["pages", "--workspace", ws], TODAY), 1);
  assert.match(cap.errs()[0], /pull/);
});

// ---- review round 1 -----------------------------------------------------------------------

test("line and paragraph separators in text survive the header round trip", () => {
  seed(SPECS, 40);
  const r = record(ws, base({ before: { title: "a\u2028b", h1: "c\u2029d", description: "e" } }), TODAY);
  const h = readHeader(r.path);
  assert.equal(h.before.title, "a\u2028b");
  assert.equal(h.before.h1, "c\u2029d");
  assert.equal(busy(ws).length > 0, true);
});

test("record refuses a recorded value that is not a date", () => {
  seed(SPECS, 40);
  assert.throws(() => record(ws, base({ recorded: "../x" }), TODAY), LureError);
  assert.equal(existsSync(join(ws, "x.md")), false);
});

test("a person's own note in hypotheses/ is skipped; a broken hypothesis is named", () => {
  seed(SPECS, 40);
  record(ws, base(), TODAY);
  writeFileSync(join(ws, "hypotheses", "README.md"), "# notes\n");
  assert.equal(busy(ws).length > 0, true);
  writeFileSync(join(ws, "hypotheses", "broken.md"), "---\nlure_hypothesis: 1\n  : nonsense\n---\n");
  assert.throws(() => busy(ws), (e: any) => e instanceof LureError && e.message.includes("broken.md"));
});

test("a hypothesis checked out with CRLF line endings still reads", () => {
  seed(SPECS, 40);
  const r = record(ws, base(), TODAY);
  writeFileSync(r.path, readFileSync(r.path, "utf8").replace(/\n/g, "\r\n"));
  assert.equal(busy(ws).some((b) => b.role === "target"), true);
});

test("an unknown status is an error, not a free page", () => {
  seed(SPECS, 40);
  const r = record(ws, base(), TODAY);
  writeFileSync(r.path, readFileSync(r.path, "utf8").replace("status: planned\n", "status: plannd\n"));
  assert.throws(() => busy(ws), (e: any) => e instanceof LureError && e.message.includes("plannd"));
});

test("record refuses a page or control with no rows in the window", () => {
  seed(SPECS, 40);
  assert.throws(() => record(ws, base({ page: "https://example.com/nope/" }), TODAY), (e: any) => e instanceof LureError && e.message.includes("trailing slash"));
  assert.throws(() => record(ws, base({ controls: ["https://example.com/nope/"] }), TODAY), LureError);
});

test("record refuses impossible dates and malformed items", () => {
  seed(SPECS, 40);
  assert.throws(() => record(ws, base({ planned_live: "2026-02-30" }), TODAY), LureError);
  assert.throws(() => record(ws, base({ events: [1 as any] }), TODAY), LureError);
  assert.throws(() => record(ws, base({ sections: [null as any] }), TODAY), LureError);
  assert.throws(() => record(ws, null as any, TODAY), LureError);
});

test("main returns 2 on an unknown option instead of throwing", (t) => {
  t.mock.method(console, "error", () => {});
  assert.equal(main(["busy", "--workspace", ws, "--nope"], TODAY), 2);
});
