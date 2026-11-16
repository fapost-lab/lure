// Lure's scheduler adapter for macOS launchd. Installs ONE per-user LaunchAgent that runs,
// every day at 10:00, `<node> <lureHome>/engine/check.mts run --all`. The scripts are copied to
// <lureHome>/engine/ so the schedule survives plugin reinstalls (the plugin cache path holds
// the version). Node built-ins only.
//
//   node schedule.mts plan    --node <abs path> [--hour 10] [--minute 0]
//   node schedule.mts install --node <abs path> [--hour 10] [--minute 0]
//   node schedule.mts remove
//   node schedule.mts show
//
// Linux and Windows: every command except `plan` refuses; `plan` prints the same note.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const LABEL = "in.fapost.lure.check";
export const ENGINE_FILES = ["check.mts", "measure.mts", "metrics.mts", "search-console.mts"];

export class LureError extends Error {}

export type Exec = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

export type CommonOptions = {
  platform?: string;
  lureHome?: string;
  agentsDir?: string;
  uid?: number;
  exec?: Exec;
  srcDir?: string;
  pluginVersion?: string;
};
export type PlanOptions = CommonOptions & { node?: string; hour?: number; minute?: number };
export type InstallOptions = PlanOptions & {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitSeconds?: number;
};
export type Deps = InstallOptions;

// ---- Defaults -----------------------------------------------------------------------------

function defaultLureHome(): string {
  return process.env.LURE_HOME || join(homedir(), ".lure");
}

const defaultExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function thisDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function unsupported(platform: string): string {
  return `scheduling on ${platform} is not supported yet; run /lure:check by hand`;
}

function resolved(o: CommonOptions) {
  return {
    platform: o.platform ?? process.platform,
    lureHome: o.lureHome ?? defaultLureHome(),
    agentsDir: o.agentsDir ?? join(homedir(), "Library", "LaunchAgents"),
    uid: o.uid ?? process.getuid?.() ?? 0,
    exec: o.exec ?? defaultExec,
    srcDir: o.srcDir ?? thisDir(),
  };
}

export function readPluginVersion(srcDir: string): string {
  const file = join(srcDir, "..", ".claude-plugin", "plugin.json");
  try {
    const v = JSON.parse(readFileSync(file, "utf8")).version;
    if (typeof v === "string" && v) return v;
  } catch {
    // fall through
  }
  throw new LureError(`cannot read the plugin version from ${file}`);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// ---- Pure pieces --------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function plist(o: { node: string; script: string; hour: number; minute: number; log: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(o.node)}</string>
    <string>${esc(o.script)}</string>
    <string>run</string>
    <string>--all</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${o.hour}</integer>
    <key>Minute</key>
    <integer>${o.minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(o.log)}</string>
</dict>
</plist>
`;
}

export function paths(o: { lureHome: string; agentsDir: string }) {
  const engine = join(o.lureHome, "engine");
  return {
    engine,
    script: join(engine, "check.mts"),
    plist: join(o.agentsDir, `${LABEL}.plist`),
    log: join(o.lureHome, "logs", "check.log"),
    lastRun: join(o.lureHome, "logs", "last-run.json"),
  };
}

export function copyEngine(srcDir: string, engineDir: string, version: string): { version: string; files: Record<string, string> } {
  for (const f of ENGINE_FILES) {
    if (!existsSync(join(srcDir, f))) throw new LureError(`engine file is missing: ${join(srcDir, f)}`);
  }
  const tmp = `${engineDir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const files: Record<string, string> = {};
  try {
    for (const f of ENGINE_FILES) {
      copyFileSync(join(srcDir, f), join(tmp, f));
      files[f] = sha256(join(tmp, f));
    }
    const info = { version, files };
    writeFileSync(join(tmp, "VERSION.json"), JSON.stringify(info, null, 2) + "\n");
    rmSync(engineDir, { recursive: true, force: true });
    renameSync(tmp, engineDir);
    return info;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export function riskyWorkspaces(registryText: string, home: string): string[] {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const h = norm(home);
  const roots = ["Documents", "Desktop", "Downloads"].map((d) => `${h}/${d}`);
  const out: string[] = [];
  for (const m of registryText.matchAll(/^\s+(?:-\s+)?path:\s*(.+?)\s*$/gm)) {
    const value = m[1].replace(/^(["'])(.*)\1$/, "$2");
    const p = norm(value);
    if (roots.some((r) => p === r || p.startsWith(r + "/"))) out.push(value);
  }
  return out;
}

function readRegistry(lureHome: string): string {
  try {
    return readFileSync(join(lureHome, "workspaces.yaml"), "utf8");
  } catch {
    return "";
  }
}

function checkTime(hour: number, minute: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new LureError("--hour must be an integer 0-23");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new LureError("--minute must be an integer 0-59");
}

function requireNode(node: string | undefined): string {
  if (!node) throw new LureError("--node <absolute path to node> is required");
  if (!isAbsolute(node)) throw new LureError(`--node must be an absolute path, got: ${node}`);
  return node;
}

// ---- Commands -----------------------------------------------------------------------------

export function plan(o: PlanOptions): string {
  const r = resolved(o);
  if (r.platform !== "darwin") return unsupported(r.platform);
  const node = requireNode(o.node);
  const hour = o.hour ?? 10;
  const minute = o.minute ?? 0;
  checkTime(hour, minute);
  const p = paths(r);
  const lines = [
    "Lure would install a daily check with launchd:",
    `  time:        every day at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (and once at load)`,
    `  node:        ${node}`,
    `  engine copy: ${p.engine}  (${ENGINE_FILES.join(", ")})`,
    `  LaunchAgent: ${p.plist}`,
    `  log:         ${p.log}`,
    `  command:     ${node} ${p.script} run --all`,
    "",
    "plist:",
    plist({ node, script: p.script, hour, minute, log: p.log }),
  ];
  const risky = riskyWorkspaces(readRegistry(r.lureHome), homedir());
  if (risky.length) {
    lines.push(
      "Warning: these workspaces are inside Documents, Desktop or Downloads. macOS privacy",
      "protection can block background jobs there; move them or grant access:",
      ...risky.map((w) => `  - ${w}`),
    );
  }
  if (versionedNode(node)) {
    lines.push(
      "Warning: this node path names a node version (nvm, Homebrew Cellar, asdf, Volta). After",
      "node is upgraded or that version removed, the job stops; run /lure:check to reinstall it.",
    );
  }
  return lines.join("\n");
}

// A path that changes when node is upgraded: the schedule would silently stop finding node.
export function versionedNode(node: string): boolean {
  return /[\\/](\.nvm[\\/]versions|Cellar|\.asdf[\\/]installs|\.volta[\\/]tools|\.fnm|n[\\/]versions)[\\/]/.test(node);
}

export async function install(o: InstallOptions): Promise<{ ok: boolean; message: string }> {
  const r = resolved(o);
  if (r.platform !== "darwin") throw new LureError(unsupported(r.platform));
  const node = requireNode(o.node);
  if (!existsSync(node)) throw new LureError(`node not found at ${node}`);
  const hour = o.hour ?? 10;
  const minute = o.minute ?? 0;
  checkTime(hour, minute);
  const pluginVersion = o.pluginVersion ?? readPluginVersion(r.srcDir);
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const waitSeconds = o.waitSeconds ?? 60;
  const p = paths(r);

  copyEngine(r.srcDir, p.engine, pluginVersion);
  mkdirSync(dirname(p.log), { recursive: true });
  mkdirSync(r.agentsDir, { recursive: true });
  writeFileSync(p.plist, plist({ node, script: p.script, hour, minute, log: p.log }));

  const target = `gui/${r.uid}/${LABEL}`;
  r.exec("launchctl", ["bootout", target]); // not loaded yet is fine
  // RunAtLoad starts the trial run as soon as the job is loaded; nothing is kicked or killed,
  // so a run never dies holding a workspace lock. A bootstrap right after a bootout can fail
  // while launchd is still tearing the old job down: try a few times.
  const start = now();
  let boot = r.exec("launchctl", ["bootstrap", `gui/${r.uid}`, p.plist]);
  for (let attempt = 1; boot.status !== 0 && attempt < 3; attempt++) {
    await sleep(1000);
    boot = r.exec("launchctl", ["bootstrap", `gui/${r.uid}`, p.plist]);
  }
  if (boot.status !== 0) {
    throw new LureError(`launchctl bootstrap failed: ${(boot.stderr || boot.stdout).trim() || `exit ${boot.status}`}`);
  }

  const deadline = start + waitSeconds * 1000;
  for (;;) {
    const last = readLastRun(p.lastRun);
    if (last && typeof last.at === "string" && Date.parse(last.at) >= start) {
      const errors: unknown[] = Array.isArray(last.errors) ? last.errors : [];
      const failed: any[] = Array.isArray(last.workspaces) ? last.workspaces.filter((w: any) => w && w.ok === false) : [];
      let message = `Installed. Trial run finished at ${last.at}.`;
      if (errors.length) message += ` It reported ${errors.length} error(s):\n` + errors.map((e) => `  - ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n");
      for (const w of failed) {
        message += `\n  - ${w.path}: ${w.reason ?? `${w.errors} error(s); see ${w.path}/.lure/check-last.json`}`;
      }
      return { ok: true, message };
    }
    if (now() >= deadline) break;
    await sleep(1000);
  }
  let message =
    `The trial run left no trace within ${waitSeconds}s. Read ${p.log}. Common causes: node not found at ${node}, ` +
    "no access to a workspace folder (macOS privacy: Documents, Desktop, Downloads).";
  if (existsSync(p.log)) {
    const tail = readFileSync(p.log, "utf8").split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l).slice(-20);
    message += `\nLast lines of the log:\n${tail.join("\n")}`;
  }
  return { ok: false, message };
}

function readLastRun(file: string): any | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function remove(o: CommonOptions): string[] {
  const r = resolved(o);
  if (r.platform !== "darwin") throw new LureError(unsupported(r.platform));
  const p = paths(r);
  const done: string[] = [];
  const res = r.exec("launchctl", ["bootout", `gui/${r.uid}/${LABEL}`]);
  if (res.status === 0) done.push(`unloaded ${LABEL}`);
  if (existsSync(p.plist)) {
    rmSync(p.plist, { force: true });
    done.push(`deleted ${p.plist}`);
  }
  if (existsSync(p.engine)) {
    rmSync(p.engine, { recursive: true, force: true });
    done.push(`deleted ${p.engine}`);
  }
  if (!done.length) done.push("nothing to remove");
  return done;
}

export function show(o: CommonOptions) {
  const r = resolved(o);
  if (r.platform !== "darwin") throw new LureError(unsupported(r.platform));
  const p = paths(r);
  const pluginVersion = o.pluginVersion ?? readPluginVersion(r.srcDir);
  const installed = existsSync(p.plist);
  const loaded = r.exec("launchctl", ["print", `gui/${r.uid}/${LABEL}`]).status === 0;
  let engine: { version: string; files?: Record<string, string> } | null = null;
  try {
    engine = JSON.parse(readFileSync(join(p.engine, "VERSION.json"), "utf8"));
  } catch {
    engine = null;
  }
  let stale = false;
  if (engine) {
    stale = engine.version !== pluginVersion;
    for (const f of ENGINE_FILES) {
      let src = "";
      try { src = sha256(join(r.srcDir, f)); } catch { /* missing source counts as differing */ }
      if (engine.files?.[f] !== src) stale = true;
    }
  }
  return {
    installed,
    loaded,
    engine: engine ? { version: engine.version } : null,
    pluginVersion,
    stale,
    lastRun: readLastRun(p.lastRun),
  };
}

// ---- CLI ----------------------------------------------------------------------------------

const USAGE = "usage: schedule.mts plan|install --node <abs path> [--hour 10] [--minute 0] | remove | show";

export async function main(argv: string[], deps: Partial<Deps> = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { node: { type: "string" }, hour: { type: "string" }, minute: { type: "string" } },
    });
  } catch {
    console.error(USAGE);
    return 2;
  }
  const cmd = parsed.positionals[0];
  if (!["plan", "install", "remove", "show"].includes(cmd ?? "") || parsed.positionals.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  try {
    const opts: InstallOptions = {
      ...deps,
      node: parsed.values.node ?? deps.node,
      hour: parsed.values.hour !== undefined ? Number(parsed.values.hour) : deps.hour,
      minute: parsed.values.minute !== undefined ? Number(parsed.values.minute) : deps.minute,
    };
    if (cmd === "plan") {
      console.log(plan(opts));
    } else if (cmd === "install") {
      const res = await install(opts);
      console.log(res.message);
      return res.ok ? 0 : 1;
    } else if (cmd === "remove") {
      for (const l of remove(opts)) console.log(l);
    } else {
      const s = show(opts);
      console.log(`installed: ${s.installed}`);
      console.log(`loaded: ${s.loaded}`);
      console.log(`engine: ${s.engine ? s.engine.version : "none"} (plugin ${s.pluginVersion})${s.stale ? " - STALE, run install again" : ""}`);
      console.log(`last run: ${s.lastRun ? JSON.stringify(s.lastRun) : "none"}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof LureError) {
      console.error(`lure: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
