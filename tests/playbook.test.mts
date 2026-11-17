import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LureError, add, candidates, link, sync, retract, readLessons, lessonsTesting, listLines, splitLesson, main,
} from "../plugins/lure/scripts/playbook.mts";
import type { AddInput } from "../plugins/lure/scripts/playbook.mts";
import { joinFile, readHypotheses } from "../plugins/lure/scripts/metrics.mts";

// Synthetic data only: example.com URLs and made-up numbers. Hypotheses are written straight
// as files, in the header metrics.mts writes, at the stage each test needs.
const SITE = "https://example.com";
const TODAY = "2027-02-01";
const page = (n: string) => `${SITE}/${n}/`;

let ws = "";
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "lure-playbook-ws-"));
  writeFileSync(join(ws, "lure.yaml"), `lure: 1\nproduct: test\nsite: ${SITE}\n`);
  mkdirSync(join(ws, "hypotheses"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

type HypOpts = {
  status?: string; label?: string; metric?: string; unreliable?: boolean; effect?: number;
  low?: number | null; high?: number | null; pageSum?: [number, number];
};

function hyp(slug: string, pageName: string, o: HypOpts = {}): string {
  const id = `2026-10-01-${slug}`;
  const status = o.status ?? "measured";
  const header: any = {
    lure_hypothesis: 1, id, status, page: page(pageName), change: `Rewrite ${pageName}`,
    recorded: "2026-10-01", planned_live: "2026-10-05", check_on: "2026-11-15",
    metric: o.metric ?? "impressions", expected: "up", window_days: 28, floor: "measurable",
    floor_reason: "enough", live_marker: "New", controls: [], events: [],
  };
  if (status === "measured") {
    const label = o.label ?? "noticeable_gain";
    header.live_on = "2026-10-05";
    header.crawled_on = "2026-10-07";
    header.before_window = { from: "2026-09-08", to: "2026-10-05" };
    header.after_window = { from: "2026-10-08", to: "2026-11-04" };
    header.verdict = {
      label, metric: o.metric ?? "impressions", expected: "up",
      effect: o.effect ?? (label === "worse" ? -0.3 : label === "noticeable_gain" ? 0.4 : 0.02),
      low: o.low === undefined ? (label === "insufficient_history" ? null : 0.1) : o.low,
      high: o.high === undefined ? (label === "insufficient_history" ? null : 0.8) : o.high,
      mde: label === "insufficient_history" ? null : 0.1,
      unreliable: o.unreliable ?? false,
      before: { from: "2026-09-08", to: "2026-10-05" },
      after: { from: "2026-10-08", to: "2026-11-04" },
      page: { before: (o.pageSum ?? [1500, 1860])[0], after: (o.pageSum ?? [1500, 1860])[1] },
      controls: { before: 3000, after: 3100 },
      measured_on: "2026-11-08",
    };
  }
  writeFileSync(join(ws, "hypotheses", `${id}.md`), joinFile(header, "\n## Why\n\nBecause.\n"));
  return id;
}

function setStatus(id: string, o: HypOpts): void {
  const slug = id.replace(/^2026-10-01-/, "");
  const h = readHypotheses(ws).find((x) => x.header.id === id)!;
  hyp(slug, h.header.page.replace(`${SITE}/`, "").replace(/\/$/, ""), { metric: h.header.metric, ...o });
}

function input(ids: string[], over: Partial<AddInput> = {}): AddInput {
  return {
    slug: "faq-pages", statement: "A rewritten page with an FAQ gains impressions",
    change_kind: "rewrite with FAQ", hypotheses: ids, body: "Both pages got an FAQ.", ...over,
  };
}

const journal = () => (existsSync(join(ws, "journal.md")) ? readFileSync(join(ws, "journal.md"), "utf8") : "");
const lessonText = (id: string) => readFileSync(join(ws, "playbook", `${id}.md`), "utf8");

function lessonWith(): { id: string; a: string; b: string } {
  const a = hyp("a", "a"), b = hyp("b", "b");
  const { id } = add(ws, input([a, b]), "2026-12-01");
  return { id, a, b };
}

// ---- add ----------------------------------------------------------------------------------

test("add writes a lesson from two consistent measured verdicts, with sample, date and site", () => {
  const a = hyp("a", "a"), b = hyp("b", "b", { pageSum: [1000, 1200] });
  const r = add(ws, input([a, b]), "2026-12-01");
  assert.equal(r.id, "2026-12-01-faq-pages");
  const [l] = readLessons(ws);
  assert.equal(l.header.lure_lesson, 1);
  assert.equal(l.header.status, "active");
  assert.equal(l.header.direction, "gain");
  assert.equal(l.header.metric, "impressions");
  assert.equal(l.header.site, SITE);
  assert.equal(l.header.created, "2026-12-01");
  assert.deepEqual(l.header.evidence.map((e: any) => [e.hypothesis, e.sample, e.label]),
    [[a, 3360, "noticeable_gain"], [b, 2200, "noticeable_gain"]]);
  assert.equal(l.header.evidence[0].measured_on, "2026-11-08");
  assert.deepEqual(l.header.tests, []);
  assert.equal(l.header.in_doubt, false);
  assert.equal(l.header.retracted, null);
  assert.match(journal(), /^- 2026-12-01 — playbook: lesson 2026-12-01-faq-pages added from .* — playbook\/2026-12-01-faq-pages\.md — delete the file\n$/);
});

test("add derives loss from two worse verdicts", () => {
  const a = hyp("a", "a", { label: "worse" }), b = hyp("b", "b", { label: "worse" });
  add(ws, input([a, b]), TODAY);
  assert.equal(readLessons(ws)[0].header.direction, "loss");
});

test("add --dry-run writes nothing, journal included", () => {
  const a = hyp("a", "a"), b = hyp("b", "b");
  const r = add(ws, input([a, b]), TODAY, true);
  assert.match(r.text, /^---\nlure_lesson: 1\n/);
  assert.equal(existsSync(join(ws, "playbook")), false);
  assert.equal(journal(), "");
});

test("add counts the sample from page impressions when the metric is not impressions", () => {
  mkdirSync(join(ws, "search-console"));
  const rows = ["date,page,clicks,impressions,ctr,position"];
  for (const [d, imp] of [["2026-09-08", 100], ["2026-10-05", 50], ["2026-10-06", 999], ["2026-11-04", 70]] as const) {
    rows.push(`${d},${page("a")},5,${imp},0.05,10`, `${d},${page("b")},5,10,0.5,10`);
  }
  writeFileSync(join(ws, "search-console", "pages-daily.csv"), rows.join("\n") + "\n");
  const a = hyp("a", "a", { metric: "clicks" }), b = hyp("b", "b", { metric: "clicks" });
  add(ws, input([a, b]), TODAY);
  // 2026-10-06 is between the windows and does not count.
  assert.deepEqual(readLessons(ws)[0].header.evidence.map((e: any) => e.sample), [220, 30]);
});

test("add refuses a single hypothesis", () => {
  const a = hyp("a", "a");
  assert.throws(() => add(ws, input([a]), TODAY), /at least two/);
});

test("add refuses different labels", () => {
  const a = hyp("a", "a"), b = hyp("b", "b", { label: "worse" });
  assert.throws(() => add(ws, input([a, b]), TODAY), /disagree/);
});

for (const [name, o] of [
  ["no_signal", { label: "no_signal" }],
  ["insufficient_history", { label: "insufficient_history" }],
  ["an unreliable verdict", { unreliable: true }],
] as [string, HypOpts][]) {
  test(`add refuses ${name}`, () => {
    const a = hyp("a", "a"), b = hyp("b", "b", o);
    assert.throws(() => add(ws, input([a, b]), TODAY), LureError);
    assert.equal(existsSync(join(ws, "playbook")), false);
  });
}

test("add refuses different metrics", () => {
  const a = hyp("a", "a"), b = hyp("b", "b", { metric: "clicks" });
  assert.throws(() => add(ws, input([a, b]), TODAY), /different metrics/);
});

test("add refuses two hypotheses on the same page", () => {
  const a = hyp("a", "a"), b = hyp("b", "a");
  assert.throws(() => add(ws, input([a, b]), TODAY), /same page/);
});

test("add refuses a hypothesis already in another lesson", () => {
  const { a } = lessonWith();
  const c = hyp("c", "c");
  assert.throws(() => add(ws, input([a, c], { slug: "other" }), TODAY), /already in lesson 2026-12-01-faq-pages/);
});

test("add refuses a hypothesis that is not measured", () => {
  const a = hyp("a", "a"), b = hyp("b", "b", { status: "live" });
  assert.throws(() => add(ws, input([a, b]), TODAY), /is live, not measured/);
});

test("add refuses a direction the verdicts do not give", () => {
  const a = hyp("a", "a"), b = hyp("b", "b");
  assert.throws(() => add(ws, input([a, b], { direction: "loss" }), TODAY), /say gain/);
});

test("add refuses a lesson id that exists", () => {
  lessonWith();
  const c = hyp("c", "c"), d = hyp("d", "d");
  assert.throws(() => add(ws, input([c, d]), "2026-12-01"), /already exists/);
});

// ---- candidates ---------------------------------------------------------------------------

test("candidates lists free significant reliable verdicts only", () => {
  const { a, b } = lessonWith();
  const c = hyp("c", "c"), d = hyp("d", "d", { label: "worse" });
  hyp("e", "e", { label: "no_signal" });
  hyp("f", "f", { unreliable: true });
  hyp("g", "g", { status: "live" });
  const ids = candidates(ws).map((x) => x.id);
  assert.deepEqual(ids, [c, d]);
  assert.ok(!ids.includes(a) && !ids.includes(b));
});

// ---- link ---------------------------------------------------------------------------------

test("link puts a planned or live hypothesis into the lesson's tests", () => {
  const { id } = lessonWith();
  const p = hyp("p", "p", { status: "planned" });
  const q = hyp("q", "q", { status: "live" });
  link(ws, id, p, TODAY);
  link(ws, id, q, TODAY);
  assert.deepEqual(readLessons(ws)[0].header.tests, [p, q]);
  assert.deepEqual(lessonsTesting(ws, p), [id]);
  assert.deepEqual(lessonsTesting(ws, "nothing"), []);
  assert.match(journal(), new RegExp(`playbook: ${p} linked to test lesson ${id}`));
});

test("link refuses a measured hypothesis", () => {
  const { id } = lessonWith();
  const m = hyp("m", "m");
  const before = lessonText(id);
  assert.throws(() => link(ws, id, m, TODAY), /only a hypothesis without a verdict/);
  assert.equal(lessonText(id), before);
});

test("link refuses another metric, an evidence page, a second link and a retracted lesson", () => {
  const { id } = lessonWith();
  assert.throws(() => link(ws, id, hyp("x", "x", { status: "live", metric: "clicks" }), TODAY), /same metric/);
  assert.throws(() => link(ws, id, hyp("y", "a", { status: "live" }), TODAY), /already a page of this lesson's evidence/);
  const z = hyp("z", "z", { status: "live" });
  link(ws, id, z, TODAY);
  assert.throws(() => link(ws, id, z, TODAY), /already in lesson/);
  retract(ws, id, "the person says so", TODAY);
  assert.throws(() => link(ws, id, hyp("w", "w", { status: "live" }), TODAY), /retracted/);
});

test("link refuses a page already under test in the lesson", () => {
  const { id } = lessonWith();
  link(ws, id, hyp("t1", "t", { status: "live" }), TODAY);
  assert.throws(() => link(ws, id, hyp("t2", "t", { status: "planned" }), TODAY), /already the page of/);
});

// ---- sync ---------------------------------------------------------------------------------

test("sync moves a test with the same label into evidence", () => {
  const { id } = lessonWith();
  const t = hyp("t", "t", { status: "live" });
  link(ws, id, t, TODAY);
  assert.deepEqual(sync(ws, TODAY), []); // no verdict yet
  setStatus(t, { label: "noticeable_gain" });
  const ch = sync(ws, TODAY);
  assert.deepEqual(ch.map((c) => c.kind), ["evidence"]);
  const l = readLessons(ws)[0].header;
  assert.deepEqual(l.tests, []);
  assert.deepEqual(l.evidence.map((e: any) => e.hypothesis).slice(-1), [t]);
  assert.equal(l.status, "active");
});

test("sync retracts the lesson on the opposite significant label, naming the hypothesis and numbers", () => {
  const { id } = lessonWith();
  const t = hyp("t", "t", { status: "live" });
  link(ws, id, t, TODAY);
  setStatus(t, { label: "worse", effect: -0.25, low: -0.4, high: -0.1 });
  const ch = sync(ws, TODAY);
  assert.deepEqual(ch.map((c) => c.kind), ["retracted"]);
  const l = readLessons(ws)[0].header;
  assert.equal(l.status, "retracted");
  assert.equal(l.retracted, TODAY);
  assert.match(l.retract_reason, new RegExp(`${t}.*worse.*-0\\.25.*-0\\.4 … -0\\.1.*sample 3360`));
  assert.deepEqual(l.tests, []);
  assert.equal(l.evidence.length, 2);
  assert.match(journal(), /retracted: automatic/);
});

test("sync puts no_signal and insufficient_history into not_confirmed and marks doubt when they reach the evidence", () => {
  const { id } = lessonWith();
  const t1 = hyp("t1", "t1", { status: "live" }), t2 = hyp("t2", "t2", { status: "live" });
  link(ws, id, t1, TODAY);
  link(ws, id, t2, TODAY);
  setStatus(t1, { label: "no_signal" });
  assert.deepEqual(sync(ws, TODAY).map((c) => c.kind), ["not_confirmed"]);
  assert.equal(readLessons(ws)[0].header.in_doubt, false);
  setStatus(t2, { label: "insufficient_history" });
  assert.deepEqual(sync(ws, TODAY).map((c) => c.kind), ["not_confirmed", "in_doubt"]);
  const l = readLessons(ws)[0].header;
  assert.equal(l.in_doubt, true);
  assert.equal(l.status, "active"); // the person retracts it, not the script
  assert.deepEqual(l.not_confirmed.map((e: any) => [e.hypothesis, e.label, e.low]), [[t1, "no_signal", 0.1], [t2, "insufficient_history", null]]);
});

test("sync counts an unreliable significant verdict neither way", () => {
  const { id } = lessonWith();
  const t = hyp("t", "t", { status: "live" });
  link(ws, id, t, TODAY);
  setStatus(t, { label: "worse", unreliable: true });
  assert.deepEqual(sync(ws, TODAY).map((c) => c.kind), ["not_confirmed"]);
  assert.equal(readLessons(ws)[0].header.status, "active");
});

test("sync removes an abandoned hypothesis from tests", () => {
  const { id } = lessonWith();
  const t = hyp("t", "t", { status: "live" });
  link(ws, id, t, TODAY);
  setStatus(t, { status: "abandoned" });
  assert.deepEqual(sync(ws, TODAY).map((c) => c.kind), ["abandoned"]);
  assert.deepEqual(readLessons(ws)[0].header.tests, []);
});

test("a second sync changes nothing: same lesson bytes, same journal", () => {
  const { id } = lessonWith();
  const t1 = hyp("t1", "t1", { status: "live" }), t2 = hyp("t2", "t2", { status: "live" });
  const t3 = hyp("t3", "t3", { status: "live" });
  link(ws, id, t1, TODAY);
  link(ws, id, t2, TODAY);
  link(ws, id, t3, TODAY);
  setStatus(t1, { label: "noticeable_gain" });
  setStatus(t2, { label: "no_signal" });
  setStatus(t3, { status: "abandoned" });
  assert.equal(sync(ws, TODAY).length, 3);
  const text = lessonText(id), j = journal();
  assert.deepEqual(sync(ws, "2027-02-02"), []);
  assert.equal(lessonText(id), text);
  assert.equal(journal(), j);
});

test("sync leaves a retracted lesson alone", () => {
  const { id } = lessonWith();
  const t = hyp("t", "t", { status: "live" });
  link(ws, id, t, TODAY);
  retract(ws, id, "the person says so", TODAY);
  setStatus(t, { label: "worse" });
  const text = lessonText(id);
  assert.deepEqual(sync(ws, TODAY), []);
  assert.equal(lessonText(id), text);
});

test("sync does not rewrite a lesson checked out with CRLF line endings", () => {
  const { id } = lessonWith();
  const t = hyp("t", "t", { status: "live" });
  link(ws, id, t, TODAY);
  const p = join(ws, "playbook", `${id}.md`);
  writeFileSync(p, readFileSync(p, "utf8").replace(/\n/g, "\r\n"));
  const crlf = readFileSync(p, "utf8");
  assert.deepEqual(sync(ws, TODAY), []);
  assert.equal(readFileSync(p, "utf8"), crlf);
});

test("the tests left in a retracted lesson are free for another lesson", () => {
  const { id } = lessonWith();
  const t = hyp("t", "t", { status: "live" });
  link(ws, id, t, TODAY);
  retract(ws, id, "the person says so", TODAY);
  setStatus(t, { label: "noticeable_gain" });
  assert.ok(candidates(ws).some((c) => c.id === t));
  add(ws, input([t, hyp("u", "u")], { slug: "again" }), TODAY);
  assert.equal(readLessons(ws).length, 2);
});

// ---- retract ------------------------------------------------------------------------------

test("retract records the person's reason and refuses twice", () => {
  const { id } = lessonWith();
  assert.throws(() => retract(ws, id, "  ", TODAY), /--reason/);
  retract(ws, id, "the market changed", TODAY);
  const l = readLessons(ws)[0].header;
  assert.equal(l.status, "retracted");
  assert.equal(l.retract_reason, "the market changed");
  assert.throws(() => retract(ws, id, "again", TODAY), /not active/);
  assert.match(listLines(ws)[0], /retracted 2027-02-01: the market changed/);
});

// ---- The header ---------------------------------------------------------------------------

test("the lesson header reads back exactly what was written", () => {
  const a = hyp("a", "a"), b = hyp("b", "b");
  const statement = 'Переписанная страница с FAQ под запросы «3PL for <платформа>»: рост "показов"';
  const r = add(ws, input([a, b], { statement, change_kind: "rewrite: platform page" }), TODAY);
  const text = lessonText(r.id);
  const { header, body } = splitLesson(text);
  assert.equal(header.statement, statement);
  assert.equal(header.change_kind, "rewrite: platform page");
  assert.equal(header.id, r.id);
  assert.deepEqual(header.tests, []);
  assert.deepEqual(header.not_confirmed, []);
  assert.equal(header.in_doubt, false);
  assert.equal(header.retracted, null);
  assert.equal(header.retract_reason, null);
  assert.equal(header.evidence.length, 2);
  assert.deepEqual(Object.keys(header), [
    "lure_lesson", "id", "status", "statement", "change_kind", "direction", "metric", "site", "created",
    "evidence", "tests", "not_confirmed", "in_doubt", "retracted", "retract_reason",
  ]);
  assert.equal(joinFile(header, body), text);
  assert.equal(body, "\nBoth pages got an FAQ.\n");
});

// ---- Command line -------------------------------------------------------------------------

function quiet(fn: () => number): { code: number; out: string[]; err: string[] } {
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...x: unknown[]) => { out.push(x.join(" ")); };
  console.error = (...x: unknown[]) => { err.push(x.join(" ")); };
  try { return { code: fn(), out, err }; } finally { console.log = log; console.error = error; }
}

test("the command line adds, lists tests and reports refusals without a stack trace", () => {
  const a = hyp("a", "a"), b = hyp("b", "b");
  const file = join(ws, ".input.json");
  writeFileSync(file, JSON.stringify(input([a, b])));
  let r = quiet(() => main(["add", "--workspace", ws, "--input", file, "--dry-run"], TODAY));
  assert.equal(r.code, 0);
  assert.equal(existsSync(join(ws, "playbook")), false);
  r = quiet(() => main(["add", "--workspace", ws, "--input", file], TODAY));
  assert.equal(r.code, 0);
  const id = `${TODAY}-faq-pages`;
  const t = hyp("t", "t", { status: "planned" });
  r = quiet(() => main(["link", "--workspace", ws, "--lesson", id, "--hypothesis", t], TODAY));
  assert.equal(r.code, 0);
  r = quiet(() => main(["list", "--workspace", ws, "--tests", t], TODAY));
  assert.deepEqual(r.out, [id]);
  r = quiet(() => main(["list", "--workspace", ws, "--tests", a], TODAY));
  assert.deepEqual(r.out, []);
  r = quiet(() => main(["link", "--workspace", ws, "--lesson", id, "--hypothesis", a], TODAY));
  assert.equal(r.code, 1);
  assert.match(r.err[0], /^lure: /);
  r = quiet(() => main(["sync", "--workspace", ws], TODAY));
  assert.deepEqual(r.out, ["nothing changed"]);
  // An unreadable hypothesis is a refusal too, not a crash.
  writeFileSync(join(ws, "hypotheses", "broken.md"), "---\nlure_hypothesis: 1\n???\n---\n");
  r = quiet(() => main(["candidates", "--workspace", ws], TODAY));
  assert.equal(r.code, 1);
  assert.match(r.err[0], /cannot be read/);
});

test("playbook writes nothing outside playbook/ and journal.md", () => {
  const { id } = lessonWith();
  const t = hyp("t", "t", { status: "live" });
  const withT = readdirSync(join(ws, "hypotheses")).map((f) => readFileSync(join(ws, "hypotheses", f), "utf8"));
  link(ws, id, t, TODAY);
  sync(ws, TODAY);
  retract(ws, id, "done", TODAY);
  assert.deepEqual(readdirSync(join(ws, "hypotheses")).map((f) => readFileSync(join(ws, "hypotheses", f), "utf8")), withT);
  assert.deepEqual(readdirSync(ws).sort(), ["hypotheses", "journal.md", "lure.yaml", "playbook"]);
});
