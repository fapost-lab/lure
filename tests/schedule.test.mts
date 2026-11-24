import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  LABEL, ENGINE_FILES, LureError, plist, paths, copyEngine, riskyWorkspaces, plan, install, remove, show, main,
} from "../plugins/lure/scripts/schedule.mts";

let root = "";
let lureHome = "";
let agentsDir = "";
let srcDir = "";
let node = "";
let calls: [string, string[]][] = [];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lure-sched-"));
  lureHome = join(root, "home");
  agentsDir = join(root, "agents");
  srcDir = join(root, "plugin", "scripts");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(join(root, "plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.3" }));
  for (const f of ENGINE_FILES) writeFileSync(join(srcDir, f), `// ${f}\n`);
  node = join(root, "node-bin");
  writeFileSync(node, "");
  mkdirSync(lureHome, { recursive: true });
  calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const fake = (onCall?: (cmd: string, args: string[]) => Partial<{ status: number; stderr: string }> | void) =>
  (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    const r = onCall?.(cmd, args) ?? {};
    return { status: 0, stdout: "", stderr: "", ...r };
  };

const base = () => ({ platform: "darwin", lureHome, agentsDir, srcDir, uid: 501, node, exec: fake() });

test("plist has args, time, RunAtLoad and escapes XML", () => {
  const t = plist({ node: "/a&b/node", script: "/s<1>/check.mts", hour: 10, minute: 5, log: "/l/\"x\"'.log" });
  assert.match(t, /<string>\/a&amp;b\/node<\/string>/);
  assert.match(t, /<string>\/s&lt;1&gt;\/check\.mts<\/string>/);
  assert.match(t, /&quot;x&quot;&apos;/);
  assert.match(t, /<string>run<\/string>\s*<string>--all<\/string>/);
  assert.match(t, /<key>Hour<\/key>\s*<integer>10<\/integer>/);
  assert.match(t, /<key>Minute<\/key>\s*<integer>5<\/integer>/);
  assert.match(t, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(t, new RegExp(`<string>${LABEL}</string>`));
});

test("paths", () => {
  const p = paths({ lureHome: "/h", agentsDir: "/a" });
  assert.equal(p.engine, join("/h", "engine"));
  assert.equal(p.script, join("/h", "engine", "check.mts"));
  assert.equal(p.plist, join("/a", `${LABEL}.plist`));
  assert.equal(p.log, join("/h", "logs", "check.log"));
  assert.equal(p.lastRun, join("/h", "logs", "last-run.json"));
});

test("copyEngine copies, hashes, replaces older engine, refuses missing file", () => {
  const engine = join(root, "engine");
  mkdirSync(engine);
  writeFileSync(join(engine, "stale.txt"), "old");
  const info = copyEngine(srcDir, engine, "1.2.3");
  assert.equal(info.version, "1.2.3");
  assert.equal(info.files["check.mts"], sha("// check.mts\n"));
  assert.ok(!existsSync(join(engine, "stale.txt")));
  for (const f of ENGINE_FILES) assert.ok(existsSync(join(engine, f)));
  assert.deepEqual(JSON.parse(readFileSync(join(engine, "VERSION.json"), "utf8")), info);
  rmSync(join(srcDir, "measure.mts"));
  assert.throws(() => copyEngine(srcDir, engine, "2"), LureError);
  assert.equal(JSON.parse(readFileSync(join(engine, "VERSION.json"), "utf8")).version, "1.2.3");
});

test("riskyWorkspaces", () => {
  const reg = [
    "workspaces:",
    "  - product: a",
    "    path: /Users/x/Documents/a/seo",
    "  - product: b",
    "    path: /Users/x/Projects/b/seo",
    "  - product: c",
    "    path: \"/Users/x/Downloads\"",
    "  - product: d",
    "    path: /Users/x/Desktop2/d",
  ].join("\n");
  writeFileSync(join(lureHome, "workspaces.yaml"), reg);
  assert.deepEqual(riskyWorkspaces(lureHome, "/Users/x"), ["/Users/x/Documents/a/seo", "/Users/x/Downloads"]);
});

test("plan has no side effects and mentions risky warning", () => {
  writeFileSync(join(lureHome, "workspaces.yaml"), `workspaces:\n  - product: a\n    path: ${homedir()}/Documents/a\n`);
  const text = plan(base());
  assert.match(text, /Warning/);
  assert.match(text, /Documents/);
  assert.match(text, /10:00/);
  assert.deepEqual(calls, []);
  assert.ok(!existsSync(agentsDir));
  assert.ok(!existsSync(join(lureHome, "engine")));
});

test("plan on linux prints the note", () => {
  assert.match(plan({ ...base(), platform: "linux" }), /scheduling on linux is not supported yet; run \/lure:check by hand/);
});

for (const platform of ["linux", "win32"]) {
  test(`install, remove, show refuse on ${platform}`, async () => {
    const o = { ...base(), platform };
    await assert.rejects(install(o), /scheduling on .* is not supported yet/);
    assert.throws(() => remove(o), LureError);
    assert.throws(() => show(o), LureError);
    assert.deepEqual(calls, []);
  });
}

test("install on darwin runs bootout then bootstrap (no kickstart) and succeeds", async () => {
  let bootstrapAt = 0;
  const exec = fake((_c, args) => {
    if (args[0] === "bootstrap") {
      // RunAtLoad starts the trial run: the job writes last-run.json once it is loaded.
      bootstrapAt = Date.now();
      mkdirSync(join(lureHome, "logs"), { recursive: true });
      writeFileSync(join(lureHome, "logs", "last-run.json"), JSON.stringify({ at: new Date().toISOString(), errors: ["boom"] }));
    }
    if (args[0] === "bootout") return { status: 3 };
  });
  const res = await install({ ...base(), exec, sleep: async () => { throw new Error("must not wait"); } });
  assert.equal(res.ok, true);
  assert.ok(bootstrapAt > 0);
  assert.match(res.message, /boom/);
  const plistPath = join(agentsDir, `${LABEL}.plist`);
  assert.deepEqual(calls, [
    ["launchctl", ["bootout", `gui/501/${LABEL}`]],
    ["launchctl", ["bootstrap", "gui/501", plistPath]],
  ]);
  assert.ok(!calls.some(([, a]) => a.includes("kickstart")));
  assert.ok(existsSync(plistPath));
  assert.ok(existsSync(join(lureHome, "engine", "check.mts")));
  assert.match(readFileSync(plistPath, "utf8"), /<string>--all<\/string>/);
});

test("install: the start time is taken before bootstrap, so a run finished during bootstrap counts", async () => {
  const t0 = 1_700_000_000_000;
  let t = t0;
  const exec = fake((_c, args) => {
    if (args[0] === "bootstrap") {
      t += 5000; // launchctl takes a while; the trial run finishes inside it
      mkdirSync(join(lureHome, "logs"), { recursive: true });
      writeFileSync(join(lureHome, "logs", "last-run.json"), JSON.stringify({ at: new Date(t0 + 2000).toISOString(), workspaces: [] }));
    }
  });
  const res = await install({ ...base(), exec, now: () => t, sleep: async (ms) => { t += ms; }, waitSeconds: 3 });
  assert.equal(res.ok, true);
});

test("install: a bootstrap that fails twice is retried after sleep(1000) and then succeeds", async () => {
  let boots = 0;
  const slept: number[] = [];
  const exec = fake((_c, args) => {
    if (args[0] === "bootstrap") {
      boots++;
      if (boots < 3) return { status: 5, stderr: "Bootstrap failed: 5" };
      mkdirSync(join(lureHome, "logs"), { recursive: true });
      writeFileSync(join(lureHome, "logs", "last-run.json"), JSON.stringify({ at: new Date().toISOString(), workspaces: [] }));
    }
  });
  const res = await install({ ...base(), exec, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(res.ok, true);
  assert.equal(boots, 3);
  assert.deepEqual(slept, [1000, 1000]);
  assert.equal(calls.filter(([, a]) => a[0] === "bootstrap").length, 3);
  assert.equal(calls[0][1][0], "bootout");
});

test("install: the message lists workspaces with ok:false from last-run.json (reason or error count)", async () => {
  const exec = fake((_c, args) => {
    if (args[0] === "bootstrap") {
      mkdirSync(join(lureHome, "logs"), { recursive: true });
      writeFileSync(join(lureHome, "logs", "last-run.json"), JSON.stringify({
        at: new Date().toISOString(), errors: [],
        workspaces: [
          { path: "/w/fine", ok: true, errors: 0 },
          { path: "/w/locked", ok: false, errors: 1, reason: "no access (on macOS)" },
          { path: "/w/broken", ok: false, errors: 3 },
        ],
      }));
    }
  });
  const res = await install({ ...base(), exec, sleep: async () => {} });
  assert.equal(res.ok, true);
  assert.match(res.message, /\/w\/locked: no access \(on macOS\)/);
  assert.match(res.message, /\/w\/broken: 3 error\(s\)/);
  assert.doesNotMatch(res.message, /\/w\/fine/);
});

test("install returns ok:false when no last-run appears", async () => {
  mkdirSync(join(lureHome, "logs"), { recursive: true });
  writeFileSync(join(lureHome, "logs", "check.log"), "line1\nnode: not found\n");
  let t = 1_000_000;
  const res = await install({ ...base(), now: () => t, sleep: async (ms) => { t += ms; }, waitSeconds: 3 });
  assert.equal(res.ok, false);
  assert.match(res.message, /no trace/);
  assert.match(res.message, /node: not found/);
  assert.ok(t >= 1_003_000);
});

test("install ignores a stale last-run from before the trial", async () => {
  mkdirSync(join(lureHome, "logs"), { recursive: true });
  writeFileSync(join(lureHome, "logs", "last-run.json"), JSON.stringify({ at: "2020-01-01T00:00:00Z" }));
  let t = Date.now();
  const res = await install({ ...base(), now: () => t, sleep: async (ms) => { t += ms; }, waitSeconds: 2 });
  assert.equal(res.ok, false);
});

test("bootstrap failure: three attempts with sleep(1000) between them, then LureError", async () => {
  const slept: number[] = [];
  const exec = fake((_c, args) => (args[0] === "bootstrap" ? { status: 5, stderr: "Bootstrap failed: 5" } : undefined));
  await assert.rejects(
    install({ ...base(), exec, sleep: async (ms) => { slept.push(ms); } }),
    (e: Error) => e instanceof LureError && /Bootstrap failed: 5/.test(e.message),
  );
  assert.equal(calls.filter(([, a]) => a[0] === "bootstrap").length, 3);
  assert.deepEqual(slept, [1000, 1000]);
  assert.ok(!calls.some(([, a]) => a.includes("kickstart")));
});

test("relative or missing node path refused", async () => {
  await assert.rejects(install({ ...base(), node: "node" }), /absolute/);
  await assert.rejects(install({ ...base(), node: join(root, "nope") }), /not found/);
  assert.deepEqual(calls, []);
});

test("remove deletes plist and engine", async () => {
  await install({ ...base(), now: () => 0, sleep: async () => {}, waitSeconds: 0 });
  calls = [];
  const lines = remove(base());
  assert.ok(!existsSync(join(agentsDir, `${LABEL}.plist`)));
  assert.ok(!existsSync(join(lureHome, "engine")));
  assert.equal(calls[0][1][0], "bootout");
  assert.ok(lines.length >= 2);
});

test("show detects stale engine", async () => {
  await install({ ...base(), now: () => 0, sleep: async () => {}, waitSeconds: 0 });
  let s = show(base());
  assert.equal(s.installed, true);
  assert.equal(s.loaded, true);
  assert.equal(s.engine?.version, "1.2.3");
  assert.equal(s.stale, false);
  writeFileSync(join(srcDir, "metrics.mts"), "// changed\n");
  assert.equal(show(base()).stale, true);
  writeFileSync(join(srcDir, "metrics.mts"), "// metrics.mts\n");
  assert.equal(show(base()).stale, false);
  assert.equal(show({ ...base(), pluginVersion: "9.9.9" }).stale, true);
  assert.equal(show({ ...base(), exec: fake(() => ({ status: 113 })) }).loaded, false);
});

test("main: usage, missing node, refusal exit codes", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await main([]), 2);
    assert.equal(await main(["bogus"]), 2);
    assert.equal(await main(["install"], { ...base(), node: undefined }), 1);
    assert.equal(await main(["install", "--node", "/x"], { ...base(), platform: "linux" }), 1);
  } finally {
    console.error = quiet;
  }
});

test("versionedNode: version-bound node paths are recognised", async () => {
  const { versionedNode } = await import("../plugins/lure/scripts/schedule.mts");
  assert.equal(versionedNode("/Users/x/.nvm/versions/node/v26.9.0/bin/node"), true);
  assert.equal(versionedNode("/opt/homebrew/Cellar/node/26.1.0/bin/node"), true);
  assert.equal(versionedNode("/opt/homebrew/bin/node"), false);
  assert.equal(versionedNode("/usr/local/bin/node"), false);
});

test("the engine copy holds every script the check imports, notify.mts included", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "lure", "scripts");
  assert.ok(ENGINE_FILES.includes("notify.mts"));
  for (const f of ENGINE_FILES) {
    const text = readFileSync(join(src, f), "utf8");
    for (const m of text.matchAll(/(?:from\s+|import\()\s*["']\.\/([\w.-]+\.mts)["']/g)) {
      assert.ok(ENGINE_FILES.includes(m[1]), `${f} imports ${m[1]}, which is not in ENGINE_FILES`);
    }
  }
});
