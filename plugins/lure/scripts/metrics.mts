// Lure's measurement arithmetic and hypothesis log. Reads the Search Console history a
// workspace holds (search-console/*.csv) and writes hypotheses/<id>.md. Node built-ins only.
//
//   node metrics.mts pages   --workspace <dir> [--from YYYY-MM-DD --to YYYY-MM-DD] [--json]
//   node metrics.mts window  --workspace <dir> --page <url> [--from --to]
//   node metrics.mts busy    --workspace <dir>
//   node metrics.mts record  --workspace <dir> --input <file.json> [--dry-run]
//   node metrics.mts abandon --workspace <dir> --id <id> --reason <text>
//
// The hypothesis header is written only by this module, in one block style, so the small
// parser below reads back exactly what it wrote.

import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const FORMAT = 1;
export const WINDOW_DAYS = 28;
export const DATA_LAG_DAYS = 3;
export const METRICS = ["clicks", "impressions", "position"];
export const DIRECTIONS = ["up", "down"];
export const FLOORS = ["measurable", "weak", "below"];
export const ACTIVE = ["planned", "live"];
export const STATUSES = ["planned", "live", "measured", "abandoned"];

export class LureError extends Error {}

export type Agg = { days: number; clicks: number; impressions: number; ctr: number | null; position: number | null };

// ---- CSV ----------------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

type PageRow = { date: string; page: string; clicks: number; impressions: number; position: number };
type SiteRow = { date: string; clicks: number; impressions: number; position: number };

function readTable(path: string, header: string[]): string[][] {
  if (!existsSync(path)) throw new LureError(`no ${path} — connect Search Console and pull first`);
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length === 0 || rows[0].join(",") !== header.join(",")) {
    throw new LureError(`${path} does not have the header ${header.join(",")}`);
  }
  return rows.slice(1);
}

export function readPages(ws: string): PageRow[] {
  return readTable(join(ws, "search-console", "pages-daily.csv"), ["date", "page", "clicks", "impressions", "ctr", "position"])
    .map((r) => ({ date: r[0], page: r[1], clicks: Number(r[2]), impressions: Number(r[3]), position: Number(r[5]) }));
}

export function readSite(ws: string): SiteRow[] {
  return readTable(join(ws, "search-console", "site-daily.csv"), ["date", "clicks", "impressions", "ctr", "position"])
    .map((r) => ({ date: r[0], clicks: Number(r[1]), impressions: Number(r[2]), position: Number(r[4]) }));
}

// ---- Arithmetic ---------------------------------------------------------------------------

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

// Position is averaged weighted by impressions, as Search Console does; a day without a row
// is a day without impressions, never a day of zeros at position 0.
export function aggregate(rows: { date: string; clicks: number; impressions: number; position: number }[]): Agg {
  const days = new Set(rows.map((r) => r.date)).size;
  let clicks = 0, impressions = 0, weighted = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    weighted += r.position * r.impressions;
  }
  return {
    days,
    clicks,
    impressions,
    ctr: impressions > 0 ? round(clicks / impressions, 4) : null,
    position: impressions > 0 ? round(weighted / impressions, 2) : null,
  };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A real calendar date: "2026-02-30" parses in JavaScript but is not one.
export const isDate = (s: unknown) =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// The default window: WINDOW_DAYS days ending on the last day the pages file holds.
export function defaultWindow(rows: PageRow[]): { from: string; to: string } {
  if (rows.length === 0) throw new LureError("the Search Console history is empty — pull first");
  const to = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date);
  return { from: addDays(to, -(WINDOW_DAYS - 1)), to };
}

function resolveWindow(rows: PageRow[], from?: string, to?: string): { from: string; to: string } {
  if (!from && !to) return defaultWindow(rows);
  if (!isDate(from) || !isDate(to) || from! > to!) throw new LureError("--from and --to must be dates, from ≤ to");
  return { from: from!, to: to! };
}

const inWindow = (w: { from: string; to: string }) => (r: { date: string }) => r.date >= w.from && r.date <= w.to;

export function pagesTable(ws: string, from?: string, to?: string) {
  const rows = readPages(ws);
  const w = resolveWindow(rows, from, to);
  const byPage = new Map<string, PageRow[]>();
  for (const r of rows.filter(inWindow(w))) {
    if (!byPage.has(r.page)) byPage.set(r.page, []);
    byPage.get(r.page)!.push(r);
  }
  const pages = [...byPage].map(([page, rs]) => ({ page, ...aggregate(rs) }))
    .sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page));
  return { ...w, pages };
}

export function windowFor(ws: string, page: string, from?: string, to?: string) {
  const rows = readPages(ws);
  const w = resolveWindow(rows, from, to);
  return {
    ...w,
    page: aggregate(rows.filter(inWindow(w)).filter((r) => r.page === page)),
    site: aggregate(readSite(ws).filter(inWindow(w))),
  };
}

// ---- The header: a block-style YAML subset this module writes and reads -------------------

export type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

function scalar(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isDate(v) || (/^[a-z][a-z0-9_-]*$/.test(v) && !["null", "true", "false"].includes(v))) return v;
  // JSON leaves U+2028 and U+2029 raw; they would split a header line when read back.
  return JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderYaml(obj: { [k: string]: Value }, indent = ""): string {
  let out = "";
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) { out += `${indent}${k}: []\n`; continue; }
      out += `${indent}${k}:\n`;
      for (const item of v) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const lines = renderYaml(item, `${indent}    `).split("\n").filter(Boolean);
          out += `${indent}  - ${lines[0].trimStart()}\n`;
          for (const l of lines.slice(1)) out += `${l}\n`;
        } else {
          out += `${indent}  - ${scalar(item as any)}\n`;
        }
      }
    } else if (v !== null && typeof v === "object") {
      out += `${indent}${k}:\n` + renderYaml(v, `${indent}  `);
    } else {
      out += `${indent}${k}: ${scalar(v)}\n`;
    }
  }
  return out;
}

function parseScalar(s: string): Value {
  if (s === "null") return null;
  if (s === "true" || s === "false") return s === "true";
  if (s === "[]") return [];
  if (s.startsWith('"')) return JSON.parse(s);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function parseYaml(text: string): { [k: string]: Value } {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let i = 0;
  const depth = (l: string) => l.length - l.trimStart().length;

  function block(indent: number): { [k: string]: Value } {
    const obj: { [k: string]: Value } = {};
    while (i < lines.length && depth(lines[i]) === indent && !lines[i].trimStart().startsWith("- ")) {
      const m = lines[i].trim().match(/^([A-Za-z_][\w-]*):(?: (.*))?$/);
      if (!m) throw new LureError(`unreadable header line: ${lines[i]}`);
      i++;
      if (m[2] !== undefined) obj[m[1]] = parseScalar(m[2]);
      else if (i < lines.length && lines[i].trimStart().startsWith("- ")) obj[m[1]] = list(depth(lines[i]));
      else if (i < lines.length && depth(lines[i]) > indent) obj[m[1]] = block(depth(lines[i]));
      else obj[m[1]] = {};
    }
    return obj;
  }

  function list(indent: number): Value[] {
    const arr: Value[] = [];
    while (i < lines.length && depth(lines[i]) === indent && lines[i].trimStart().startsWith("- ")) {
      const rest = lines[i].trimStart().slice(2);
      if (/^[A-Za-z_][\w-]*:( |$)/.test(rest)) {
        // A map item: rewrite its first line as a key at the item's inner indent.
        lines[i] = " ".repeat(indent + 2) + rest;
        arr.push(block(indent + 2));
      } else {
        arr.push(parseScalar(rest));
        i++;
      }
    }
    return arr;
  }

  return block(0);
}

export function splitFile(text: string): { header: { [k: string]: Value }; body: string } {
  text = text.replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new LureError("not a hypothesis file (no --- header)");
  return { header: parseYaml(m[1]), body: m[2] };
}

export function joinFile(header: { [k: string]: Value }, body: string): string {
  return `---\n${renderYaml(header)}---\n${body}`;
}

// ---- The hypothesis log -------------------------------------------------------------------

type Hyp = { path: string; header: { [k: string]: any }; body: string };

export function readHypotheses(ws: string): Hyp[] {
  const dir = join(ws, "hypotheses");
  if (!existsSync(dir)) return [];
  const out: Hyp[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const path = join(dir, f);
    const text = readFileSync(path, "utf8");
    if (!text.startsWith("---")) continue; // a note of the person's, not a hypothesis
    try {
      const { header, body } = splitFile(text);
      if (header.lure_hypothesis === undefined) continue;
      out.push({ path, header, body });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new LureError(`${path} cannot be read (${why}); fix its header or move it out of hypotheses/`);
    }
  }
  return out;
}

export type Busy = { page: string; role: "target" | "control"; id: string; status: string };

export function busy(ws: string): Busy[] {
  const out: Busy[] = [];
  for (const h of readHypotheses(ws)) {
    if (!STATUSES.includes(h.header.status)) {
      throw new LureError(`${h.path} has an unknown status "${h.header.status}"; one of ${STATUSES.join(", ")}`);
    }
    if (!ACTIVE.includes(h.header.status)) continue;
    out.push({ page: h.header.page, role: "target", id: h.header.id, status: h.header.status });
    for (const c of h.header.controls ?? []) {
      if (!c.released) out.push({ page: c.page, role: "control", id: h.header.id, status: h.header.status });
    }
  }
  return out;
}

export type RecordInput = {
  slug: string;
  page: string;
  change: string;
  planned_live: string;
  metric: string;
  expected: string;
  secondary?: string;
  secondary_expected?: string;
  floor: string;
  floor_reason: string;
  live_marker: string;
  before: { title?: string; h1?: string; description?: string };
  controls: string[];
  events?: string[];
  sections: { heading: string; text: string }[];
  release_controls_of?: string[];
  recorded?: string;
  from?: string;
  to?: string;
};

export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.part`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function need(cond: unknown, message: string): void {
  if (!cond) throw new LureError(message);
}

export function record(ws: string, input: RecordInput, today: string, dryRun = false): { path: string; text: string; released: string[] } {
  need(existsSync(join(ws, "lure.yaml")), `${ws} is not a Lure workspace (no lure.yaml)`);
  need(input !== null && typeof input === "object" && !Array.isArray(input), "the input must be a JSON object");
  const recorded = input.recorded ?? today;
  need(isDate(recorded), "recorded: a date");
  need(typeof input.slug === "string" && /^[a-z0-9][a-z0-9-]{0,60}$/.test(input.slug), "slug: lowercase letters, digits and dashes");
  need(typeof input.page === "string" && /^https?:\/\//.test(input.page), "page: a full URL as Search Console shows it");
  need(typeof input.change === "string" && input.change.trim(), "change: say what changes, in one line");
  need(isDate(input.planned_live) && input.planned_live >= recorded, "planned_live: a date, not before today");
  need(METRICS.includes(input.metric), `metric: one of ${METRICS.join(", ")}`);
  need(DIRECTIONS.includes(input.expected), `expected: one of ${DIRECTIONS.join(", ")}`);
  if (input.secondary !== undefined) {
    need(METRICS.includes(input.secondary) && input.secondary !== input.metric, "secondary: another metric");
    need(DIRECTIONS.includes(input.secondary_expected ?? ""), "secondary_expected: up or down");
  }
  need(FLOORS.includes(input.floor), `floor: one of ${FLOORS.join(", ")}`);
  need(typeof input.floor_reason === "string" && input.floor_reason.trim(), "floor_reason: say why, with the numbers");
  need(typeof input.live_marker === "string" && input.live_marker.trim(), "live_marker: the text that will be on the page once the change is live");
  need(Array.isArray(input.controls) && input.controls.length >= 1 && input.controls.length <= 5, "controls: one to five pages");
  need(new Set(input.controls).size === input.controls.length, "controls: each page once");
  need(!input.controls.includes(input.page), "controls: the page itself cannot be its own control");
  need(input.controls.every((c) => typeof c === "string" && /^https?:\/\//.test(c)), "controls: full URLs");
  need(Array.isArray(input.sections) && input.sections.every((s) => s && typeof s.heading === "string" && typeof s.text === "string"),
    "sections: a list of { heading, text }");
  need(input.events === undefined || (Array.isArray(input.events) && input.events.every((e) => typeof e === "string")),
    "events: a list of lines");

  const id = `${recorded}-${input.slug}`;
  const dir = join(ws, "hypotheses");
  const path = join(dir, `${id}.md`);
  need(!existsSync(path), `${id} already exists`);

  // One hypothesis per page at a time; a control cannot be another hypothesis's target.
  const taken = busy(ws);
  const target = taken.find((b) => b.page === input.page && b.role === "target");
  need(!target, `${input.page} is already the page of ${target?.id} (${target?.status})`);
  for (const c of input.controls) {
    const t = taken.find((b) => b.page === c && b.role === "target");
    need(!t, `${c} cannot be a control: it is the page of ${t?.id}`);
  }
  const controlOf = [...new Set(taken.filter((b) => b.page === input.page && b.role === "control").map((b) => b.id))];
  const release = input.release_controls_of ?? [];
  const unreleased = controlOf.filter((id) => !release.includes(id));
  need(unreleased.length === 0, `${input.page} is a control of ${unreleased.join(", ")}; ask the person, then pass release_controls_of`);

  const w = windowFor(ws, input.page, input.from, input.to);
  need(w.page.days > 0, `${input.page} has no Search Console rows in ${w.from} … ${w.to}; check the URL exactly as Search Console shows it, trailing slash included`);
  const controls = input.controls.map((c) => ({ page: c, ...windowFor(ws, c, w.from, w.to).page }));
  const empty = controls.filter((c) => c.days === 0).map((c) => c.page);
  need(empty.length === 0, `no Search Console rows in the window for control ${empty.join(", ")}; check the URL`);

  const header: { [k: string]: Value } = {
    lure_hypothesis: FORMAT,
    id,
    status: "planned",
    page: input.page,
    change: input.change.trim(),
    recorded,
    planned_live: input.planned_live,
    check_on: addDays(input.planned_live, WINDOW_DAYS + DATA_LAG_DAYS),
    metric: input.metric,
    expected: input.expected,
    secondary: input.secondary,
    secondary_expected: input.secondary === undefined ? undefined : input.secondary_expected,
    window_days: WINDOW_DAYS,
    floor: input.floor,
    floor_reason: input.floor_reason.trim(),
    live_marker: input.live_marker.trim(),
    before: {
      title: input.before?.title ?? null,
      h1: input.before?.h1 ?? null,
      description: input.before?.description ?? null,
    },
    baseline: { from: w.from, to: w.to, page: w.page, site: w.site } as any,
    controls: controls as any,
    events: input.events ?? [],
  };
  const body = "\n" + input.sections.map((s) => `## ${s.heading}\n\n${s.text.trim()}\n`).join("\n");
  const text = joinFile(header, body);
  if (dryRun) return { path, text, released: [] };

  mkdirSync(dir, { recursive: true });
  // The new file first, and never over one written meanwhile: link fails if the name exists.
  const tmp = `${path}.part`;
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, path);
  } catch (e: any) {
    if (e?.code === "EEXIST") throw new LureError(`${id} already exists`);
    // A filesystem without hard links: an exclusive create is the next best thing.
    try {
      writeFileSync(path, text, { flag: "wx" });
    } catch (e2: any) {
      if (e2?.code === "EEXIST") throw new LureError(`${id} already exists`);
      if (existsSync(path)) unlinkSync(path); // never leave half a hypothesis behind
      throw e2;
    }
  } finally {
    unlinkSync(tmp);
  }
  for (const h of readHypotheses(ws).filter((h) => release.includes(h.header.id) && controlOf.includes(h.header.id))) {
    for (const c of h.header.controls ?? []) {
      if (c.page === input.page && !c.released) {
        c.released = recorded;
        c.released_because = `${id} changes this page`;
      }
    }
    writeAtomic(h.path, joinFile(h.header, h.body));
  }
  return { path, text, released: controlOf };
}

export function abandon(ws: string, id: string, reason: string, today: string): string {
  need(reason && reason.trim(), "--reason is required");
  const h = readHypotheses(ws).find((h) => h.header.id === id);
  need(h, `no hypothesis ${id}`);
  need(ACTIVE.includes(h!.header.status), `${id} is ${h!.header.status}, not active`);
  h!.header.status = "abandoned";
  h!.header.abandoned = today;
  h!.header.abandon_reason = reason.trim();
  writeAtomic(h!.path, joinFile(h!.header, h!.body));
  return h!.path;
}

// ---- What the check writes ----------------------------------------------------------------
// The scheduled check (check.mts) decides; these functions only validate and write, so the
// header keeps one writer. They return true when the file changed, which keeps a second run
// on the same day from touching anything.

function find(ws: string, id: string): Hyp {
  const h = readHypotheses(ws).find((h) => h.header.id === id);
  need(h, `no hypothesis ${id}`);
  return h!;
}

function save(h: Hyp, before: string): boolean {
  const text = joinFile(h.header, h.body);
  if (text === before) return false;
  writeAtomic(h.path, text);
  return true;
}

// The change is live since `liveOn`: seen on the page by the check, or said by the person.
// A person may correct the date while Google has not re-crawled the page yet.
export function markLive(ws: string, id: string, liveOn: string, source: "marker" | "person", today: string): boolean {
  const h = find(ws, id);
  const before = joinFile(h.header, h.body);
  need(source === "marker" || source === "person", "source: marker or person");
  need(isDate(liveOn), "the live date must be a date");
  need(liveOn >= h.header.recorded, `the live date cannot be before the hypothesis was recorded (${h.header.recorded})`);
  need(liveOn <= today, "the live date cannot be in the future");
  // A day the check saw the page without the marker cannot be a live day. The marker's own
  // date is the day it was seen, so only a date said by the person is held to this.
  const absent = h.header.live_absent_on;
  need(source !== "person" || !isDate(absent) || liveOn > absent,
    `the live date cannot be on or before ${absent}, a day the check saw the page without the marker`);
  const correctable = h.header.status === "planned" || (h.header.status === "live" && !h.header.crawled_on);
  need(correctable, `${id} is ${h.header.status}${h.header.crawled_on ? `, re-crawled ${h.header.crawled_on}` : ""}; its live date can no longer change`);
  if (source === "marker" && h.header.status === "live") return false; // the person's date stands
  h.header.status = "live";
  h.header.live_on = liveOn;
  h.header.live_source = source;
  delete h.header.waiting;
  return save(h, before);
}

// The check opened the page and the marker was not there yet: the live date is later than this.
export function markAbsent(ws: string, id: string, today: string): boolean {
  const h = find(ws, id);
  const before = joinFile(h.header, h.body);
  need(h.header.status === "planned", `${id} is ${h.header.status}, not planned`);
  h.header.live_absent_on = today;
  return save(h, before);
}

export type Windows = { before: { from: string; to: string }; after: { from: string; to: string }; checkOn: string };

// Google re-crawled the page after the change: the measurement windows are now fixed.
export function markCrawled(ws: string, id: string, crawledOn: string, w: Windows): boolean {
  const h = find(ws, id);
  const before = joinFile(h.header, h.body);
  need(h.header.status === "live", `${id} is ${h.header.status}, not live`);
  need(isDate(crawledOn) && crawledOn > h.header.live_on, "the crawl must be after the live date");
  need([w.before.from, w.before.to, w.after.from, w.after.to, w.checkOn].every(isDate), "windows: dates");
  h.header.crawled_on = crawledOn;
  h.header.before_window = { from: w.before.from, to: w.before.to };
  h.header.after_window = { from: w.after.from, to: w.after.to };
  h.header.check_on = w.checkOn;
  delete h.header.waiting;
  return save(h, before);
}

// Why the check is waiting (null clears it), and warnings that stay until the verdict.
export function setWaiting(ws: string, id: string, reason: string | null, warnings: string[] = []): boolean {
  const h = find(ws, id);
  const before = joinFile(h.header, h.body);
  need(ACTIVE.includes(h.header.status), `${id} is ${h.header.status}, not active`);
  if (reason === null) delete h.header.waiting;
  else h.header.waiting = reason;
  const all = [...(h.header.warnings ?? [])];
  for (const w of warnings) if (!all.includes(w)) all.push(w);
  if (all.length > 0) h.header.warnings = all;
  return save(h, before);
}

// The verdict: written once, after the after-window is covered by final data.
export function writeVerdict(ws: string, id: string, verdict: { [k: string]: Value }, today: string): boolean {
  const h = find(ws, id);
  need(h.header.status === "live" && h.header.crawled_on, `${id} is not live and re-crawled; nothing to measure`);
  for (const k of ["label", "effect", "low", "high", "mde", "past", "page", "controls"]) {
    need(k in verdict, `a verdict needs ${k}: label, effect, interval and sample size together`);
  }
  // Only "insufficient history" may lack an interval: there were no earlier periods to take it from.
  if (verdict.label !== "insufficient_history") {
    need([verdict.low, verdict.high, verdict.mde].every((x) => typeof x === "number"),
      "a verdict other than insufficient_history needs its interval (low, high) and mde");
  }
  h.header.status = "measured";
  delete h.header.waiting;
  h.header.verdict = { ...verdict, measured_on: today };
  writeAtomic(h.path, joinFile(h.header, h.body));
  return true;
}

// ---- Command line -------------------------------------------------------------------------

function fmt(n: number | null): string {
  return n === null ? "-" : String(n);
}

export function localToday(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function main(argv: string[], today = localToday()): number {
  let parsed;
  try {
    parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workspace: { type: "string" }, page: { type: "string" }, from: { type: "string" }, to: { type: "string" },
      input: { type: "string" }, id: { type: "string" }, reason: { type: "string" },
      json: { type: "boolean" }, "dry-run": { type: "boolean" },
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
    switch (positionals[0]) {
      case "pages": {
        const t = pagesTable(ws!, values.from, values.to);
        if (values.json) { console.log(JSON.stringify(t, null, 2)); return 0; }
        console.log(`window ${t.from} … ${t.to}`);
        console.log("impressions\tclicks\tctr\tposition\tdays\tpage");
        for (const p of t.pages) console.log(`${p.impressions}\t${p.clicks}\t${fmt(p.ctr)}\t${fmt(p.position)}\t${p.days}\t${p.page}`);
        return 0;
      }
      case "window": {
        need(values.page, "--page is required");
        console.log(JSON.stringify(windowFor(ws!, values.page!, values.from, values.to), null, 2));
        return 0;
      }
      case "busy": {
        const b = busy(ws!);
        if (b.length === 0) console.log("no active hypotheses");
        for (const x of b) console.log(`${x.page}\t${x.role}\t${x.id}\t${x.status}`);
        return 0;
      }
      case "record": {
        need(values.input, "--input is required");
        let input: RecordInput;
        try { input = JSON.parse(readFileSync(values.input!, "utf8")); }
        catch { throw new LureError(`${values.input} is not readable JSON`); }
        const r = record(ws!, input, today, values["dry-run"]);
        if (values["dry-run"]) { console.log(r.text); return 0; }
        console.log(`written: ${r.path}`);
        for (const id of r.released) console.log(`control released in: ${id}`);
        return 0;
      }
      case "abandon": {
        need(values.id, "--id is required");
        console.log(`abandoned: ${abandon(ws!, values.id!, values.reason ?? "", today)}`);
        return 0;
      }
      default:
        console.error("usage: metrics.mts pages|window|busy|record|abandon --workspace <dir> …");
        return 2;
    }
  } catch (e) {
    if (e instanceof LureError) { console.error(`lure: ${e.message}`); return 1; }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
