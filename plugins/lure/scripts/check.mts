// Lure's scheduled check. Runs without a model: for each workspace it pulls Search Console,
// records Google's ranking updates in events.md, and moves each active hypothesis on — it
// waits with a written reason, marks the change live or re-crawled, or measures it.
//
//   node check.mts run     --all | --workspace <dir>
//   node check.mts status  --workspace <dir>
//   node check.mts live    --workspace <dir> --id <id> --date YYYY-MM-DD
//   node check.mts measure --workspace <dir> --id <id>      (prints the verdict, writes nothing)
//
// It writes only inside a workspace (its hypotheses through metrics.mts, events.md,
// journal.md, .lure/) and under ~/.lure/logs/. Read-only towards Google and the site.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ACTIVE, LureError as MetricsError, addDays, isDate, localToday, markAbsent, markCrawled, markLive,
  readHypotheses, readPages, setWaiting, writeVerdict,
} from "./metrics.mts";
import { LureError as MeasureError, measure, windows } from "./measure.mts";
import type { DayRow, Span } from "./measure.mts";
import {
  LureError as GoogleError, MIN_NODE, accessToken, inspect, lureHome, nodeTooOld, pull,
} from "./search-console.mts";
import type { Inspection } from "./search-console.mts";

export class LureError extends Error {}

type Fetch = typeof fetch;
export const INCIDENTS = "https://status.search.google.com/incidents.json";
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
export const PROBE_FROM_DAYS = 3;   // start looking for the marker this many days before planned_live
export const OVERDUE_DAYS = 14;     // planned_live + this, and still not live: say so
export const SILENT_DAYS = 8;       // no run for longer than this: the skills say so
export const BASELINE_DRIFT = 2;    // before-window vs recorded baseline, either way: warn
const VERSION = "0.1.0";

export type Deps = {
  fetch: Fetch;
  today: string;
  now: () => Date;
  lureHome: string;
  token: (account: string) => Promise<string>;
  pull: (token: string, property: string, ws: string, today: string) => Promise<unknown>;
  inspect: (token: string, property: string, url: string) => Promise<Inspection>;
};

export function defaultDeps(): Deps {
  return {
    fetch,
    today: localToday(),
    now: () => new Date(),
    lureHome: lureHome(),
    token: (a) => accessToken(a),
    pull: (t, p, w, d) => pull(t, p, w, d),
    inspect: (t, p, u) => inspect(t, p, u),
  };
}

const isLureError = (e: unknown) =>
  e instanceof LureError || e instanceof MetricsError || e instanceof MeasureError || e instanceof GoogleError;
const message = (e: unknown) =>
  isLureError(e) ? (e as Error).message
    : e instanceof TypeError && e.message === "fetch failed" ? "could not reach the network"
    : e instanceof Error ? e.message : String(e);

// ---- Workspace settings -------------------------------------------------------------------

export function property(ws: string): string | null {
  const text = readFileSync(join(ws, "lure.yaml"), "utf8");
  const m = text.match(/^metrics:\s*\n(?:[ \t].*\n)*?[ \t]+search_console:\s*\n(?:[ \t].*\n)*?[ \t]+property:\s*(\S+)/m);
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

export function account(ws: string): string | null {
  const p = join(ws, ".lure", "search-console.yaml");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^account:\s*(\S+)/m);
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

export function registry(home: string): string[] {
  const p = join(home, "workspaces.yaml");
  if (!existsSync(p)) return [];
  return [...readFileSync(p, "utf8").matchAll(/^\s+(?:-\s+)?path:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/^["']|["']$/g, ""));
}

// ---- events.md: Google's ranking updates and outages --------------------------------------

export type Incident = { id: string; name: string; begin: string; end: string | null };

export function rankingIncidents(feed: unknown): Incident[] {
  if (!Array.isArray(feed)) throw new LureError("the Search Status feed is not a list");
  return feed
    .filter((x: any) => x && x.service_name === "Ranking" && typeof x.begin === "string" && x.id)
    .map((x: any) => ({
      id: String(x.id),
      name: String(x.external_desc ?? "Google ranking update").replace(/\s+/g, " ").trim(),
      begin: x.begin.slice(0, 10),
      end: typeof x.end === "string" ? x.end.slice(0, 10) : null,
    }));
}

export function incidentLine(i: Incident): string {
  const when = i.end === null ? `${i.begin} … open` : i.end === i.begin ? i.begin : `${i.begin} … ${i.end}`;
  return `- ${when} — ${i.name} — status.search.google.com, incident ${i.id}`;
}

// Adds new incidents in date order and rewrites the line of one whose dates changed (a
// rollout that has ended). Returns the new text and what changed.
export function mergeIncidents(text: string, incidents: Incident[]): { text: string; changes: string[] } {
  const lines = text.split("\n");
  const changes: string[] = [];
  for (const inc of incidents) {
    const line = incidentLine(inc);
    const at = lines.findIndex((l) => l.endsWith(`incident ${inc.id}`));
    if (at >= 0) {
      if (lines[at] !== line) { lines[at] = line; changes.push(`updated: ${inc.name}`); }
      continue;
    }
    // Before the first dated line that starts later; otherwise after the last dated line.
    let pos = -1, lastDated = -1;
    for (let k = 0; k < lines.length; k++) {
      const m = lines[k].match(/^- (\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      lastDated = k;
      if (pos < 0 && m[1] > inc.begin) pos = k;
    }
    if (pos < 0) pos = lastDated >= 0 ? lastDated + 1 : lines.length;
    lines.splice(pos, 0, line);
    changes.push(`added: ${inc.name}`);
  }
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return { text: out, changes };
}

const EVENTS_HEAD = "# Events\n\nOutside events that move search traffic and are not Lure's own changes, oldest first.\n\n";

export type Event = { from: string; to: string; line: string; outage: boolean };

export function readEvents(ws: string, today: string): Event[] {
  const p = join(ws, "events.md");
  if (!existsSync(p)) return [];
  const out: Event[] = [];
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^- (\d{4}-\d{2}-\d{2})(?: … (\d{4}-\d{2}-\d{2}|open))?/);
    if (!m || !isDate(m[1])) continue;
    const to = m[2] === "open" ? today : m[2] ?? m[1];
    out.push({ from: m[1], to, line: line.slice(2), outage: /\(outage\)/.test(line) });
  }
  return out;
}

const overlaps = (a: Span, b: Span) => a.from <= b.to && b.from <= a.to;

// ---- The page itself ----------------------------------------------------------------------

export type Probe = { opened: boolean; found: boolean; status: number };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function normalise(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Lure introduces itself honestly; a site that challenges non-browsers stays closed to it, and
// the person tells the date instead.
export async function probe(url: string, marker: string, f: Fetch): Promise<Probe> {
  const res = await f(url, {
    headers: { "user-agent": `Lure-check/${VERSION} (+https://github.com/fapost-lab/lure)` },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text().catch(() => "");
  const challenged = /cf-chl|challenge-platform|Just a moment\.\.\./i.test(body);
  if (!res.ok || challenged) return { opened: false, found: false, status: res.status };
  return { opened: true, found: normalise(body).includes(normalise(marker)), status: res.status };
}

// ---- One workspace ------------------------------------------------------------------------

export type HypReport = { id: string; status: string; waiting?: string; changes: string[]; verdict?: unknown };
export type Report = {
  at: string; workspace: string; today: string;
  errors: string[]; events: string[]; hypotheses: HypReport[]; skipped?: string;
};

function lock(ws: string, now: Date): () => void {
  const dir = join(ws, ".lure");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "check.lock");
  if (existsSync(p) && now.getTime() - statSync(p).mtimeMs > LOCK_STALE_MS) unlinkSync(p);
  let fd: number;
  try {
    fd = openSync(p, "wx");
  } catch (e: any) {
    if (e?.code === "EEXIST") throw new LureError(`another check is running in ${ws} (${p})`);
    throw e;
  }
  writeFileSync(fd, `${process.pid} ${now.toISOString()}\n`);
  closeSync(fd);
  return () => { try { unlinkSync(p); } catch { /* already gone */ } };
}

function journal(ws: string, today: string, what: string, file: string, undo: string): void {
  appendFileSync(join(ws, "journal.md"), `- ${today} — check: ${what} — ${file} — ${undo}\n`);
}

function lastFinalDate(rows: { date: string }[]): string | null {
  return rows.reduce<string | null>((m, r) => (m === null || r.date > m ? r.date : m), null);
}

export async function checkWorkspace(ws: string, d: Deps): Promise<Report> {
  const report: Report = { at: d.now().toISOString(), workspace: ws, today: d.today, errors: [], events: [], hypotheses: [] };
  if (!existsSync(join(ws, "lure.yaml"))) throw new LureError(`${ws} is not a Lure workspace (no lure.yaml)`);
  const prop = property(ws);
  if (!prop) { report.skipped = "Search Console is not connected"; return report; }
  const unlock = lock(ws, d.now());
  try {
    await run(ws, prop, d, report);
  } finally {
    unlock();
  }
  const dir = join(ws, ".lure");
  const tmp = join(dir, "check-last.json.part");
  writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n");
  renameSync(tmp, join(dir, "check-last.json"));
  const changed = report.hypotheses.reduce((n, h) => n + h.changes.length, 0) + report.events.length;
  appendFileSync(join(dir, "check.log"),
    `${report.at}\t${report.errors.length ? "errors" : "ok"}\tchanges=${changed}\t${report.errors.join(" | ")}\n`);
  return report;
}

async function run(ws: string, prop: string, d: Deps, report: Report): Promise<void> {
  // 1. Search Console. A failure is recorded; the check goes on with the data it has.
  let token: string | null = null;
  const acct = account(ws);
  if (!acct) report.errors.push("no Search Console account in .lure/search-console.yaml; run /lure:search-console");
  else {
    try {
      token = await d.token(acct);
      await d.pull(token, prop, ws, d.today);
    } catch (e) {
      report.errors.push(`Search Console: ${message(e)}`);
    }
  }

  // 2. Google's ranking updates into events.md.
  try {
    const res = await d.fetch(INCIDENTS, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new LureError(`status ${res.status}`);
    const incidents = rankingIncidents(await res.json());
    const p = join(ws, "events.md");
    const before = existsSync(p) ? readFileSync(p, "utf8") : EVENTS_HEAD;
    const merged = mergeIncidents(before, incidents);
    if (merged.text !== before) {
      writeFileSync(`${p}.part`, merged.text);
      renameSync(`${p}.part`, p);
      for (const c of merged.changes) journal(ws, d.today, `Google update ${c}`, "events.md", "delete the line");
      report.events.push(...merged.changes);
    }
  } catch (e) {
    report.errors.push(`Google updates not refreshed: ${message(e)}`);
  }

  // 3. Each active hypothesis, one step at a time.
  let rows: (DayRow & { page: string })[] = [];
  try {
    rows = readPages(ws);
  } catch (e) {
    report.errors.push(`Search Console history unreadable: ${message(e)}`);
  }
  const lastFinal = lastFinalDate(rows);
  const events = readEvents(ws, d.today);
  for (const h of readHypotheses(ws)) {
    if (!ACTIVE.includes(h.header.status)) continue;
    const r: HypReport = { id: h.header.id, status: h.header.status, changes: [] };
    report.hypotheses.push(r);
    try {
      // A transition (live, re-crawled) is followed by the next step in the same run, so a
      // second run on the same day finds nothing left to do.
      for (let i = 0; i < 3; i++) {
        const hdr = readHypotheses(ws).find((x) => x.header.id === h.header.id)!.header;
        if (!ACTIVE.includes(hdr.status)) break;
        if (!(await step(ws, hdr, { d, token, prop, rows, lastFinal, events, r }))) break;
      }
    } catch (e) {
      report.errors.push(`${h.header.id}: ${message(e)}`);
    }
    const now = readHypotheses(ws).find((x) => x.header.id === h.header.id)!.header;
    r.status = now.status;
    if (now.waiting) r.waiting = now.waiting;
    if (now.verdict) r.verdict = now.verdict;
  }
}

type Ctx = {
  d: Deps; token: string | null; prop: string; rows: (DayRow & { page: string })[];
  lastFinal: string | null; events: Event[]; r: HypReport;
};

// One step of one hypothesis. Returns true when it moved the hypothesis to a new stage.
async function step(ws: string, hdr: any, c: Ctx): Promise<boolean> {
  const { d, r } = c;
  const id = hdr.id;
  const file = `hypotheses/${id}.md`;

  if (hdr.status === "planned") {
    if (d.today < addDays(hdr.planned_live, -PROBE_FROM_DAYS)) {
      if (setWaiting(ws, id, `the change is planned for ${hdr.planned_live}`)) r.changes.push("waiting");
      return false;
    }
    const overdue = d.today > addDays(hdr.planned_live, OVERDUE_DAYS)
      ? ` · overdue: planned for ${hdr.planned_live}` : "";
    let p: Probe;
    try {
      p = await probe(hdr.page, hdr.live_marker, d.fetch);
    } catch (e) {
      p = { opened: false, found: false, status: 0 };
    }
    if (p.found) {
      markLive(ws, id, d.today, "marker", d.today);
      if (!hdr.live_absent_on) {
        setWaiting(ws, id, null, [
          `the marker was already on the page at the check's first look (${d.today}); if the change went live earlier, tell the date with /lure:check before Google re-crawls the page`,
        ]);
      }
      journal(ws, d.today, `${id} marked live (marker seen on the page)`, file, `/lure:check live with the right date`);
      r.changes.push("live");
      return true;
    }
    if (p.opened) {
      markAbsent(ws, id, d.today);
      if (setWaiting(ws, id, `the change is not on the page yet${overdue}`)) r.changes.push("waiting");
      return false;
    }
    const why = p.status ? `code ${p.status}` : "no answer";
    if (setWaiting(ws, id, `the page does not open for Lure (${why}); tell the live date with /lure:check${overdue}`)) {
      r.changes.push("waiting");
    }
    return false;
  }

  // live: the marker should still be there.
  const warnings: string[] = [];
  try {
    const p = await probe(hdr.page, hdr.live_marker, d.fetch);
    if (p.opened && !p.found) warnings.push("the live marker is no longer on the page — was the change rolled back?");
  } catch { /* the page could not be fetched; nothing to say about the marker */ }

  if (!hdr.crawled_on) {
    if (!c.token) {
      if (setWaiting(ws, id, "cannot ask Google about the crawl: Search Console sign-in failed", warnings)) r.changes.push("waiting");
      return false;
    }
    const ins = await d.inspect(c.token, c.prop, hdr.page);
    if (ins.googleCanonical && ins.googleCanonical !== hdr.page) {
      warnings.push(`Google chose another canonical: ${ins.googleCanonical}; Search Console credits its data there`);
    }
    // The live date is a local day; the crawl is an instant. Compare in the same local terms,
    // so a crawl on the evening before a late deploy never counts as after it.
    const t = ins.lastCrawlTime ? new Date(ins.lastCrawlTime) : null;
    const crawled = t && !Number.isNaN(t.getTime()) ? localToday(t) : null;
    if (crawled && crawled > hdr.live_on) {
      setWaiting(ws, id, null, warnings);
      markCrawled(ws, id, crawled, windows(hdr.live_on, crawled));
      journal(ws, d.today, `${id} re-crawled by Google on ${crawled}; windows fixed`, file, "remove crawled_on and the windows");
      r.changes.push("crawled");
      return true;
    }
    const last = crawled ? ` (last crawl ${crawled})` : " (never crawled)";
    if (setWaiting(ws, id, `Google has not re-crawled the page since ${hdr.live_on}${last}`, warnings)) r.changes.push("waiting");
    return false;
  }

  const after = hdr.after_window;
  if (!c.lastFinal || c.lastFinal < after.to) {
    const have = c.lastFinal ? `final data to ${c.lastFinal}` : "no data";
    if (setWaiting(ws, id, `waiting for final data to ${after.to} (${have})`, warnings)) r.changes.push("waiting");
    return false;
  }
  if (warnings.length) setWaiting(ws, id, null, warnings);
  const verdict = verdictFor(hdr, c.rows, c.events);
  writeVerdict(ws, id, verdict as any, d.today);
  journal(ws, d.today, `${id} measured: ${verdict.label}`, file, "remove verdict and set status live");
  r.changes.push("measured");
  return false;
}

export function verdictFor(hdr: any, rows: (DayRow & { page: string })[], events: Event[]) {
  const before: Span = hdr.before_window, after: Span = hdr.after_window;
  const of = (page: string) => rows.filter((x) => x.page === page);
  // The page's own history: a page younger than its controls has fewer comparable periods.
  const own = of(hdr.page);
  const historyFrom = own.reduce((m, x) => (x.date < m ? x.date : m), own[0]?.date ?? before.from);
  const controls = (hdr.controls ?? []).filter((c: any) => !c.released).map((c: any) => ({ page: c.page, rows: of(c.page) }));
  const v = measure({
    metric: hdr.metric, expected: hdr.expected, floor: hdr.floor, liveOn: hdr.live_on,
    before, after, historyFrom, page: of(hdr.page), controls,
    outages: events.filter((e) => e.outage).map((e) => ({ from: e.from, to: e.to })),
  });
  const inWindows = events.filter((e) => overlaps(e, before) || overlaps(e, after));
  // The before-window should look like the baseline recorded with the hypothesis; a large gap
  // means something else changed in between (a canonical, tracking, an outage).
  const warnings: string[] = [];
  const recorded = Number(hdr.baseline?.page?.[hdr.metric]);
  if (Number.isFinite(recorded) && recorded > 0) {
    const ratio = v.page.before / recorded;
    if (ratio > BASELINE_DRIFT || ratio < 1 / BASELINE_DRIFT) {
      warnings.push(`the before-window has ${v.page.before} ${hdr.metric}, the baseline recorded with the hypothesis ${recorded}: something else changed in between`);
    }
  }
  return {
    ...v,
    warnings,
    updates: inWindows.filter((e) => /status\.search\.google\.com/.test(e.line)).map((e) => e.line),
    events: inWindows.filter((e) => !/status\.search\.google\.com/.test(e.line)).map((e) => e.line),
  };
}

// ---- All workspaces -----------------------------------------------------------------------

// What a run leaves outside the workspaces (~/.lure/logs/last-run.json, launchd's log): each
// path, whether it went well and how many errors. The errors themselves name pages and stay in
// the workspace's own .lure/check-last.json.
export type RunSummary = { path: string; ok: boolean; errors: number; reason?: string };

export async function runAll(d: Deps): Promise<{ at: string; workspaces: RunSummary[]; errors: string[] }> {
  const out = { at: d.now().toISOString(), workspaces: [] as RunSummary[], errors: [] as string[] };
  const list = registry(d.lureHome);
  if (list.length === 0) out.errors.push(`no workspaces in ${join(d.lureHome, "workspaces.yaml")}`);
  for (const ws of list) {
    try {
      const rep = await checkWorkspace(ws, d);
      out.workspaces.push({ path: ws, ok: rep.errors.length === 0, errors: rep.errors.length });
    } catch (e) {
      // A folder macOS keeps from background jobs fails here (EPERM): say so plainly.
      const denied = (e as any)?.code === "EPERM" || (e as any)?.code === "EACCES";
      // Errors at this level name no page: no lure.yaml, a run already in progress, no access.
      out.workspaces.push({
        path: ws, ok: false, errors: 1,
        reason: denied ? "no access (on macOS, background jobs cannot read Documents, Desktop or Downloads)" : message(e),
      });
    }
  }
  const logs = join(d.lureHome, "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "last-run.json.part"), JSON.stringify(out, null, 2) + "\n");
  renameSync(join(logs, "last-run.json.part"), join(logs, "last-run.json"));
  return out;
}

// ---- Status -------------------------------------------------------------------------------

export function status(ws: string, today: string): string[] {
  const lines: string[] = [];
  const last = join(ws, ".lure", "check-last.json");
  if (!existsSync(last)) lines.push("the check has never run for this workspace");
  else {
    const rep = JSON.parse(readFileSync(last, "utf8"));
    const day = String(rep.today ?? rep.at).slice(0, 10);
    lines.push(`last check: ${rep.at}${rep.errors?.length ? ` — errors: ${rep.errors.join(" | ")}` : ""}`);
    if (addDays(day, SILENT_DAYS) < today) lines.push(`the check has not run since ${day}`);
  }
  for (const h of readHypotheses(ws)) {
    const x = h.header;
    if (!ACTIVE.includes(x.status) && !(x.status === "measured" && x.verdict)) continue;
    let line = `${x.id}\t${x.status}\tcheck_on ${x.check_on}`;
    if (x.status === "measured") line += `\t${x.verdict.label}`;
    else if (x.check_on < today) line += "\toverdue";
    if (x.waiting) line += `\twaiting: ${x.waiting}`;
    for (const w of x.warnings ?? []) line += `\twarning: ${w}`;
    lines.push(line);
  }
  return lines;
}

// ---- Command line -------------------------------------------------------------------------

export async function main(argv: string[], deps: Partial<Deps> = {}): Promise<number> {
  if (nodeTooOld(process.versions.node)) {
    console.error(`Lure needs Node ${MIN_NODE} or newer; this is ${process.versions.node}.`);
    return 1;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true,
      options: { workspace: { type: "string" }, all: { type: "boolean" }, id: { type: "string" }, date: { type: "string" } },
    });
  } catch (e) {
    console.error(`lure: ${message(e)}`);
    return 2;
  }
  const { positionals, values } = parsed;
  const d: Deps = { ...defaultDeps(), ...deps };
  try {
    switch (positionals[0]) {
      case "run": {
        if (values.all) {
          const out = await runAll(d);
          for (const w of out.workspaces) {
            console.log(`${w.ok ? "ok" : "errors"}\t${w.path}${w.ok ? "" : `\t${w.reason ?? `${w.errors} error(s), see .lure/check-last.json`}`}`);
          }
          for (const e of out.errors) console.error(`lure: ${e}`);
          return out.errors.length || out.workspaces.some((w) => !w.ok) ? 1 : 0;
        }
        if (!values.workspace) throw new LureError("--all or --workspace is required");
        const rep = await checkWorkspace(values.workspace, d);
        if (rep.skipped) console.log(`skipped: ${rep.skipped}`);
        for (const e of rep.events) console.log(`events.md: ${e}`);
        for (const h of rep.hypotheses) console.log(`${h.id}\t${h.status}${h.waiting ? `\twaiting: ${h.waiting}` : ""}`);
        for (const e of rep.errors) console.error(`lure: ${e}`);
        return rep.errors.length ? 1 : 0;
      }
      case "status": {
        if (!values.workspace) throw new LureError("--workspace is required");
        for (const l of status(values.workspace, d.today)) console.log(l);
        return 0;
      }
      case "live": {
        if (!values.workspace || !values.id || !values.date) throw new LureError("--workspace, --id and --date are required");
        markLive(values.workspace, values.id, values.date, "person", d.today);
        journal(values.workspace, d.today, `${values.id} live since ${values.date} (said by the person)`,
          `hypotheses/${values.id}.md`, "/lure:check live with the right date");
        console.log(`${values.id}: live since ${values.date}`);
        return 0;
      }
      case "measure": {
        if (!values.workspace || !values.id) throw new LureError("--workspace and --id are required");
        const h = readHypotheses(values.workspace).find((x) => x.header.id === values.id);
        if (!h) throw new LureError(`no hypothesis ${values.id}`);
        if (!h.header.after_window) throw new LureError(`${values.id} has no measurement windows yet (not re-crawled)`);
        const v = verdictFor(h.header, readPages(values.workspace), readEvents(values.workspace, d.today));
        console.log(JSON.stringify(v, null, 2));
        return 0;
      }
      default:
        console.error("usage: check.mts run --all | run --workspace <dir> | status --workspace <dir> | live --workspace <dir> --id <id> --date <date> | measure --workspace <dir> --id <id>");
        return 2;
    }
  } catch (e) {
    if (isLureError(e) || (e instanceof TypeError && e.message === "fetch failed")) {
      console.error(`lure: ${message(e)}`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
