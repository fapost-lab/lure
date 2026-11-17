// Lure's playbook: lessons drawn from measured hypotheses of one workspace. A lesson is
// admitted only on two consistent verdicts, gains strength from the hypotheses linked to test
// it before their verdict, and is retracted when one of them says the opposite.
//
//   node playbook.mts list       --workspace <dir> [--tests <hypothesis-id>]
//   node playbook.mts candidates --workspace <dir>
//   node playbook.mts add        --workspace <dir> --input <file.json> [--dry-run]
//   node playbook.mts link       --workspace <dir> --lesson <id> --hypothesis <id>
//   node playbook.mts sync       --workspace <dir>
//   node playbook.mts retract    --workspace <dir> --id <lesson> --reason <text>
//
// It reads hypotheses through metrics.mts and never writes them: Playbook reads Measurement,
// nothing points back. It writes only playbook/<id>.md and appends to journal.md, and never
// reads another workspace. The lesson header is written only by this module, with the same
// block-style YAML writer and reader as the hypothesis header.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ACTIVE, LureError as MetricsError, isDate, joinFile, localToday, parseYaml, readHypotheses, readPages,
  writeAtomic,
} from "./metrics.mts";
import type { Value } from "./metrics.mts";

export const LESSON_FORMAT = 1;
export const DIRECTION_LABEL: Record<string, string> = { gain: "noticeable_gain", loss: "worse" };
export const LABEL_DIRECTION: Record<string, string> = { noticeable_gain: "gain", worse: "loss" };

export class LureError extends Error {}

type Header = { [k: string]: any };
// `original` is the file as this module would write it when it was read: a save compares
// against it, so a file checked out with CRLF line endings is not rewritten for nothing.
export type Lesson = { path: string; header: Header; body: string; original: string };
type Hyp = { path: string; header: Header; body: string };

function need(cond: unknown, message: string): void {
  if (!cond) throw new LureError(message);
}

// ---- Reading -------------------------------------------------------------------------------

export function splitLesson(text: string): { header: Header; body: string } {
  text = text.replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new LureError("not a lesson file (no --- header)");
  return { header: parseYaml(m[1]), body: m[2] };
}

export function readLessons(ws: string): Lesson[] {
  const dir = join(ws, "playbook");
  if (!existsSync(dir)) return [];
  const out: Lesson[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const path = join(dir, f);
    const text = readFileSync(path, "utf8");
    if (!text.startsWith("---")) continue; // a note of the person's, not a lesson
    try {
      const { header, body } = splitLesson(text);
      if (header.lure_lesson === undefined) continue;
      out.push({ path, header, body, original: joinFile(header, body) });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new LureError(`${path} cannot be read (${why}); fix its header or move it out of playbook/`);
    }
  }
  return out;
}

export function siteOf(ws: string): string {
  const p = join(ws, "lure.yaml");
  need(existsSync(p), `${ws} is not a Lure workspace (no lure.yaml)`);
  const m = readFileSync(p, "utf8").match(/^site:\s*(\S+)\s*$/m);
  need(m, `${p} names no site`);
  return m![1].replace(/^["']|["']$/g, "");
}

// Every hypothesis a lesson already holds — as evidence or as not confirmed, in a retracted
// lesson too, and as a test of an active lesson — so no result is counted twice. The tests of a
// retracted lesson were never counted and are free again.
function usedBy(lessons: Lesson[]): Map<string, string> {
  const used = new Map<string, string>();
  for (const l of lessons) {
    for (const e of l.header.evidence ?? []) used.set(e.hypothesis, l.header.id);
    for (const e of l.header.not_confirmed ?? []) used.set(e.hypothesis, l.header.id);
    if (l.header.status === "active") for (const t of l.header.tests ?? []) used.set(t, l.header.id);
  }
  return used;
}

// ---- One verdict as a lesson entry ---------------------------------------------------------

// The sample is the page's impressions over both windows: the verdict's own sums when the
// metric is impressions, otherwise counted from the Search Console history over the windows
// (a sum of clicks or of daily positions is not a sample size).
function sampleOf(ws: string, h: Hyp, rows: () => { date: string; page: string; impressions: number }[]): number {
  const v = h.header.verdict;
  if (h.header.metric === "impressions" && typeof v.page?.before === "number" && typeof v.page?.after === "number") {
    return v.page.before + v.page.after;
  }
  const before = v.before ?? h.header.before_window;
  const after = v.after ?? h.header.after_window;
  need(before && after, `${h.header.id}: the verdict names no windows; cannot count its sample`);
  const inside = (d: string) => (d >= before.from && d <= before.to) || (d >= after.from && d <= after.to);
  return rows().filter((r) => r.page === h.header.page && inside(r.date)).reduce((n, r) => n + r.impressions, 0);
}

function pagesLoader(ws: string) {
  let cache: ReturnType<typeof readPages> | null = null;
  return () => (cache ??= readPages(ws));
}

function entryOf(ws: string, h: Hyp, rows: ReturnType<typeof pagesLoader>): { [k: string]: Value } {
  const v = h.header.verdict;
  return {
    hypothesis: h.header.id,
    page: h.header.page,
    label: v.label,
    effect: v.effect ?? null,
    low: v.low ?? null,
    high: v.high ?? null,
    sample: sampleOf(ws, h, rows),
    measured_on: v.measured_on ?? null,
  };
}

const interval = (e: { low: unknown; high: unknown }) =>
  e.low === null || e.low === undefined ? "no interval" : `interval ${e.low} … ${e.high}`;

// ---- candidates ----------------------------------------------------------------------------

export type Candidate = {
  id: string; page: string; change: string; metric: string; label: string;
  effect: number; low: number | null; high: number | null; measured_on: string;
};

// Measured significant, reliable verdicts no lesson holds yet: the material a lesson is
// proposed from. Whether two of them are "of one kind" is the person's call, not the script's.
export function candidates(ws: string): Candidate[] {
  const used = usedBy(readLessons(ws));
  return readHypotheses(ws)
    .filter((h) => h.header.status === "measured" && h.header.verdict)
    .filter((h) => LABEL_DIRECTION[h.header.verdict.label] && h.header.verdict.unreliable !== true)
    .filter((h) => !used.has(h.header.id))
    .map((h) => ({
      id: h.header.id, page: h.header.page, change: h.header.change, metric: h.header.metric,
      label: h.header.verdict.label, effect: h.header.verdict.effect, low: h.header.verdict.low,
      high: h.header.verdict.high, measured_on: h.header.verdict.measured_on,
    }));
}

// ---- add -----------------------------------------------------------------------------------

export type AddInput = {
  slug: string;
  statement: string;
  change_kind: string;
  hypotheses: string[];
  body: string;
  direction?: string;
  created?: string;
};

export function add(ws: string, input: AddInput, today: string, dryRun = false): { path: string; text: string; id: string } {
  const site = siteOf(ws);
  need(input !== null && typeof input === "object" && !Array.isArray(input), "the input must be a JSON object");
  const created = input.created ?? today;
  need(isDate(created), "created: a date");
  need(typeof input.slug === "string" && /^[a-z0-9][a-z0-9-]{0,60}$/.test(input.slug), "slug: lowercase letters, digits and dashes");
  need(typeof input.statement === "string" && input.statement.trim(), "statement: the lesson, in one sentence");
  need(typeof input.change_kind === "string" && input.change_kind.trim(), "change_kind: what kind of change the lesson is about");
  need(typeof input.body === "string" && input.body.trim(), "body: in your own words, what was done and where the lesson ends");
  need(Array.isArray(input.hypotheses) && input.hypotheses.every((x) => typeof x === "string"), "hypotheses: a list of hypothesis ids");
  const ids = input.hypotheses;
  need(new Set(ids).size === ids.length, "hypotheses: each one once");
  need(ids.length >= 2, "a lesson needs at least two measured hypotheses with the same result; one is not a lesson");

  const all = readHypotheses(ws);
  const hyps: Hyp[] = ids.map((id) => {
    const h = all.find((x) => x.header.id === id);
    need(h, `no hypothesis ${id} in this workspace`);
    need(h!.header.status === "measured" && h!.header.verdict, `${id} is ${h!.header.status}, not measured; a lesson stands on verdicts`);
    const v = h!.header.verdict;
    need(LABEL_DIRECTION[v.label], `${id} measured ${v.label}; only noticeable_gain or worse can support a lesson`);
    need(v.unreliable !== true, `${id}: its verdict is unreliable (the page was below the traffic floor); it cannot support a lesson`);
    return h!;
  });

  const labels = new Set(hyps.map((h) => h.header.verdict.label));
  need(labels.size === 1, `the verdicts disagree (${[...labels].join(", ")}); a lesson needs the same result from each`);
  const metrics = new Set(hyps.map((h) => h.header.metric));
  need(metrics.size === 1, `the hypotheses measure different metrics (${[...metrics].join(", ")}); a lesson needs one`);
  const pages = new Set(hyps.map((h) => h.header.page));
  need(pages.size === hyps.length, "two of the hypotheses are on the same page; a lesson needs results from different pages");

  const used = usedBy(readLessons(ws));
  for (const h of hyps) {
    const by = used.get(h.header.id);
    need(!by, `${h.header.id} is already in lesson ${by}; one result is never counted twice`);
  }

  const label = hyps[0].header.verdict.label;
  const direction = LABEL_DIRECTION[label];
  need(input.direction === undefined || input.direction === direction,
    `direction: the verdicts say ${direction} (${label}), not ${input.direction}`);

  const id = `${created}-${input.slug}`;
  const path = join(ws, "playbook", `${id}.md`);
  need(!existsSync(path), `lesson ${id} already exists`);

  const rows = pagesLoader(ws);
  const header: { [k: string]: Value } = {
    lure_lesson: LESSON_FORMAT,
    id,
    status: "active",
    statement: input.statement.trim(),
    change_kind: input.change_kind.trim(),
    direction,
    metric: hyps[0].header.metric,
    site,
    created,
    evidence: hyps.map((h) => entryOf(ws, h, rows)),
    tests: [],
    not_confirmed: [],
    in_doubt: false,
    retracted: null,
    retract_reason: null,
  };
  const text = joinFile(header, `\n${input.body.trim()}\n`);
  if (dryRun) return { path, text, id };

  mkdirSync(join(ws, "playbook"), { recursive: true });
  try {
    writeFileSync(path, text, { flag: "wx" });
  } catch (e: any) {
    if (e?.code === "EEXIST") throw new LureError(`lesson ${id} already exists`);
    throw e;
  }
  journal(ws, today, `lesson ${id} added from ${ids.join(", ")}`, id, "delete the file");
  return { path, text, id };
}

// ---- link ----------------------------------------------------------------------------------

function findLesson(ws: string, id: string): Lesson {
  const l = readLessons(ws).find((x) => x.header.id === id);
  need(l, `no lesson ${id}`);
  return l!;
}

function save(l: Lesson): boolean {
  const text = joinFile(l.header, l.body);
  if (text === l.original) return false;
  writeAtomic(l.path, text);
  return true;
}

// A hypothesis is linked to test a lesson before its verdict, never after: linking a measured
// one would pick results to fit the lesson.
export function link(ws: string, lessonId: string, hypId: string, today: string): string {
  const l = findLesson(ws, lessonId);
  need(l.header.status === "active", `lesson ${lessonId} is ${l.header.status}; only an active lesson can be tested`);
  const all = readHypotheses(ws);
  const h = all.find((x) => x.header.id === hypId);
  need(h, `no hypothesis ${hypId} in this workspace`);
  need(ACTIVE.includes(h!.header.status) && !h!.header.verdict,
    `${hypId} is ${h!.header.status}${h!.header.verdict ? ` with a verdict (${h!.header.verdict.label})` : ""}; only a hypothesis without a verdict (planned or live) can test a lesson`);
  need(h!.header.metric === l.header.metric,
    `${hypId} measures ${h!.header.metric}, the lesson ${l.header.metric}; a test must measure the same metric`);
  const evidencePages = (l.header.evidence ?? []).map((e: any) => e.page);
  need(!evidencePages.includes(h!.header.page), `${h!.header.page} is already a page of this lesson's evidence; a test needs another page`);
  // A page already under test, or already not confirmed, would count twice once sync moves both.
  const linked = new Set<string>([...(l.header.tests ?? []), ...(l.header.not_confirmed ?? []).map((e: any) => e.hypothesis)]);
  const other = all.find((x) => x.header.id !== hypId && linked.has(x.header.id) && x.header.page === h!.header.page);
  need(!other, `${h!.header.page} is already the page of ${other?.header.id} in this lesson; a test needs another page`);
  const by = usedBy(readLessons(ws)).get(hypId);
  need(!by, `${hypId} is already in lesson ${by}; one result is never counted twice`);
  l.header.tests = [...(l.header.tests ?? []), hypId];
  save(l);
  journal(ws, today, `${hypId} linked to test lesson ${lessonId}`, lessonId, `remove ${hypId} from tests`);
  return l.path;
}

// ---- sync ----------------------------------------------------------------------------------

export type SyncChange = { lesson: string; kind: "evidence" | "retracted" | "not_confirmed" | "in_doubt" | "doubt_cleared" | "abandoned" | "missing"; text: string };

// Walks each active lesson's tests. A verdict with the lesson's label strengthens it; the
// opposite significant label retracts it; no_signal, insufficient_history and an unreliable
// verdict count neither way and go to not_confirmed; an abandoned hypothesis leaves the tests.
// A second run with nothing new changes nothing.
export function sync(ws: string, today: string): SyncChange[] {
  const changes: SyncChange[] = [];
  const hyps = readHypotheses(ws);
  const rows = pagesLoader(ws);
  for (const l of readLessons(ws)) {
    if (l.header.status !== "active") continue;
    const id = l.header.id;
    const own: SyncChange[] = [];
    const tests: string[] = [...(l.header.tests ?? [])];
    const keep: string[] = [];
    const evidence = [...(l.header.evidence ?? [])];
    const notConfirmed = [...(l.header.not_confirmed ?? [])];
    for (let i = 0; i < tests.length; i++) {
      const hid = tests[i];
      if (l.header.status !== "active") { keep.push(hid); continue; }
      const h = hyps.find((x) => x.header.id === hid);
      if (!h) {
        keep.push(hid);
        own.push({ lesson: id, kind: "missing", text: `${hid} is not in hypotheses/; left in tests` });
        continue;
      }
      if (h.header.status === "abandoned") {
        own.push({ lesson: id, kind: "abandoned", text: `${hid} was abandoned; removed from tests` });
        continue;
      }
      if (h.header.status !== "measured" || !h.header.verdict) { keep.push(hid); continue; }
      const v = h.header.verdict;
      const entry = entryOf(ws, h, rows);
      const significant = LABEL_DIRECTION[v.label] && v.unreliable !== true;
      if (significant && v.label === DIRECTION_LABEL[l.header.direction]) {
        evidence.push(entry);
        own.push({ lesson: id, kind: "evidence", text: `${hid} measured ${v.label} (effect ${v.effect}, ${interval(v)}); now evidence` });
      } else if (significant) {
        l.header.status = "retracted";
        l.header.retracted = today;
        l.header.retract_reason = `automatic: ${hid} on ${h.header.page} measured ${v.label} (effect ${v.effect}, ${interval(v)}, sample ${entry.sample}), against the lesson's ${l.header.direction}`;
        own.push({ lesson: id, kind: "retracted", text: `retracted: ${l.header.retract_reason}` });
      } else {
        notConfirmed.push(entry);
        const why = v.unreliable === true ? `${v.label}, unreliable` : v.label;
        own.push({ lesson: id, kind: "not_confirmed", text: `${hid} measured ${why}; not confirmed` });
      }
    }
    l.header.tests = keep;
    l.header.evidence = evidence;
    l.header.not_confirmed = notConfirmed;
    if (l.header.status === "active") {
      const doubt = notConfirmed.length >= evidence.length;
      if (doubt && l.header.in_doubt !== true) own.push({ lesson: id, kind: "in_doubt", text: `in doubt: ${notConfirmed.length} not confirmed against ${evidence.length} evidence; the lesson does not hold up` });
      if (!doubt && l.header.in_doubt === true) own.push({ lesson: id, kind: "doubt_cleared", text: "no longer in doubt" });
      l.header.in_doubt = doubt;
    }
    if (save(l)) {
      for (const c of own) {
        if (c.kind === "missing") continue;
        const undo = c.kind === "retracted" ? "set status active, retracted and retract_reason null, put the id back in tests"
          : c.kind === "abandoned" ? "put the id back in tests"
          : c.kind === "evidence" || c.kind === "not_confirmed" ? "move the entry back to tests"
          : "set in_doubt back";
        journal(ws, today, `lesson ${id}: ${c.text}`, id, undo);
      }
    }
    changes.push(...own);
  }
  return changes;
}

// ---- retract -------------------------------------------------------------------------------

export function retract(ws: string, id: string, reason: string, today: string): string {
  need(reason && reason.trim(), "--reason is required");
  const l = findLesson(ws, id);
  need(l.header.status === "active", `lesson ${id} is ${l.header.status}, not active`);
  l.header.status = "retracted";
  l.header.retracted = today;
  l.header.retract_reason = reason.trim();
  save(l);
  journal(ws, today, `lesson ${id} retracted: ${reason.trim()}`, id, "set status active, retracted and retract_reason null");
  return l.path;
}

// ---- list ----------------------------------------------------------------------------------

export function lessonsTesting(ws: string, hypId: string): string[] {
  return readLessons(ws).filter((l) => (l.header.tests ?? []).includes(hypId)).map((l) => l.header.id);
}

export function listLines(ws: string): string[] {
  return readLessons(ws).map((l) => {
    const x = l.header;
    let line = `${x.id}\t${x.status}${x.in_doubt ? " (in doubt)" : ""}\t${x.direction} ${x.metric}`;
    line += `\tevidence ${(x.evidence ?? []).length}\tnot confirmed ${(x.not_confirmed ?? []).length}\ttests ${(x.tests ?? []).length}`;
    if (x.status === "retracted") line += `\tretracted ${x.retracted}: ${x.retract_reason}`;
    return `${line}\t${x.statement}`;
  });
}

// ---- journal -------------------------------------------------------------------------------

function journal(ws: string, today: string, what: string, lessonId: string, undo: string): void {
  appendFileSync(join(ws, "journal.md"), `- ${today} — playbook: ${what} — playbook/${lessonId}.md — ${undo}\n`);
}

// ---- Command line --------------------------------------------------------------------------

const isLureError = (e: unknown) => e instanceof LureError || e instanceof MetricsError;

export function main(argv: string[], today = localToday()): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        workspace: { type: "string" }, tests: { type: "string" }, input: { type: "string" },
        lesson: { type: "string" }, hypothesis: { type: "string" }, id: { type: "string" },
        reason: { type: "string" }, "dry-run": { type: "boolean" },
      },
    });
  } catch (e) {
    console.error(`lure: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  const { positionals, values } = parsed;
  try {
    const ws = values.workspace;
    need(ws, "--workspace is required");
    need(existsSync(join(ws!, "lure.yaml")), `${ws} is not a Lure workspace (no lure.yaml)`);
    switch (positionals[0]) {
      case "list": {
        if (values.tests !== undefined) {
          for (const id of lessonsTesting(ws!, values.tests)) console.log(id);
          return 0;
        }
        const lines = listLines(ws!);
        if (lines.length === 0) console.log("no lessons");
        for (const l of lines) console.log(l);
        return 0;
      }
      case "candidates": {
        const c = candidates(ws!);
        if (c.length === 0) console.log("no measured result is free for a lesson");
        for (const x of c) {
          const iv = x.low === null ? "no interval" : `${x.low} … ${x.high}`;
          console.log(`${x.id}\t${x.label}\t${x.metric}\teffect ${x.effect} (${iv})\tmeasured ${x.measured_on}\t${x.page}\t${x.change}`);
        }
        return 0;
      }
      case "add": {
        need(values.input, "--input is required");
        let input: AddInput;
        try { input = JSON.parse(readFileSync(values.input!, "utf8")); }
        catch { throw new LureError(`${values.input} is not readable JSON`); }
        const r = add(ws!, input, today, values["dry-run"]);
        if (values["dry-run"]) { console.log(r.text); return 0; }
        console.log(`written: ${r.path}`);
        return 0;
      }
      case "link": {
        need(values.lesson && values.hypothesis, "--lesson and --hypothesis are required");
        console.log(`linked: ${values.hypothesis} tests ${values.lesson} (${link(ws!, values.lesson!, values.hypothesis!, today)})`);
        return 0;
      }
      case "sync": {
        const all = sync(ws!, today);
        const changes = all.filter((c) => c.kind !== "missing");
        for (const c of all.filter((c) => c.kind === "missing")) console.error(`lure: ${c.lesson}: ${c.text}`);
        if (changes.length === 0) console.log("nothing changed");
        for (const c of changes) console.log(`${c.lesson}\t${c.kind}\t${c.text}`);
        return 0;
      }
      case "retract": {
        need(values.id, "--id is required");
        console.log(`retracted: ${retract(ws!, values.id!, values.reason ?? "", today)}`);
        return 0;
      }
      default:
        console.error("usage: playbook.mts list|candidates|add|link|sync|retract --workspace <dir> …");
        return 2;
    }
  } catch (e) {
    if (isLureError(e)) { console.error(`lure: ${(e as Error).message}`); return 1; }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
