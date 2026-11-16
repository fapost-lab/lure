// Lure's Search Console port: sign in with the person's own OAuth client, list their
// properties, and pull daily history into a workspace. Read-only. Node built-ins only.
//
//   node search-console.mts auth [--timeout-minutes 10]
//   node search-console.mts sites --account <email>
//   node search-console.mts pull  --account <email> --property <url> --workspace <dir>
//
// Secrets live under ~/.lure/google/ (LURE_HOME overrides ~/.lure). Nothing secret is ever
// printed: output is the account e-mail and summaries only.

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const MIN_NODE = "22.18.0";
const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly", "openid", "email"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://searchconsole.googleapis.com/webmasters/v3";
const PAGE_SIZE = 25000;
const HISTORY_MONTHS = 16;

export const SITE_HEADER = ["date", "clicks", "impressions", "ctr", "position"];
export const PAGES_HEADER = ["date", "page", "clicks", "impressions", "ctr", "position"];

type Fetch = typeof fetch;
type Row = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

export class LureError extends Error {}

// ---- Node version -------------------------------------------------------------------------

export function nodeTooOld(version: string, min = MIN_NODE): boolean {
  const a = version.replace(/^v/, "").split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) < b[i];
  }
  return false;
}

// ---- Paths and secret files ---------------------------------------------------------------

export function lureHome(): string {
  return process.env.LURE_HOME || join(homedir(), ".lure");
}

export function googleDir(): string {
  return join(lureHome(), "google");
}

export function clientPath(): string {
  return join(googleDir(), "client.json");
}

export function tokenPath(account: string): string {
  if (!/^[^/\\\s]+@[^/\\\s]+$/.test(account) || account.includes("..")) {
    throw new LureError(`not an e-mail address: ${account}`);
  }
  return join(googleDir(), "tokens", `${account.toLowerCase()}.json`);
}

// Owner-only on macOS and Linux. On Windows mode bits are ignored; the file is protected by
// living in the user's profile.
export function writeSecret(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.part`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

type Client = { client_id: string; client_secret: string };

export function readClient(path = clientPath()): Client {
  if (!existsSync(path)) {
    throw new LureError(`no OAuth client at ${path} — create a Desktop app client and put its JSON there`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // The parser's message would quote the file; the file holds the client secret.
    throw new LureError(`${path} is not valid JSON`);
  }
  const c = parsed.installed;
  if (!c || !c.client_id || !c.client_secret) {
    throw new LureError(`${path} is not a "Desktop app" OAuth client (no "installed" section)`);
  }
  return { client_id: c.client_id, client_secret: c.client_secret };
}

// ---- OAuth --------------------------------------------------------------------------------

async function postForm(f: Fetch, url: string, form: Record<string, string>): Promise<any> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Google's error codes carry no secrets; never echo the request.
    throw new LureError(`Google refused (${res.status}): ${body.error ?? ""} ${body.error_description ?? ""}`.trim());
  }
  return body;
}

export function emailFromIdToken(idToken: string): string {
  const payload = idToken.split(".")[1];
  if (!payload) throw new LureError("Google returned no identity token");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!claims.email) throw new LureError("Google returned no e-mail for this account");
  return claims.email;
}

function openBrowser(url: string): void {
  if (process.env.LURE_NO_BROWSER) return;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is printed as well; the person can open it by hand.
  }
}

export async function auth(timeoutMinutes = 10, f: Fetch = fetch): Promise<string> {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes > 60) {
    throw new LureError("--timeout-minutes must be a number from 1 to 60");
  }
  const client = readClient();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    let redirect = "";
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const done = (status: number, text: string) => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
      };
      if (u.searchParams.get("state") !== state) {
        done(400, "Lure: this sign-in link does not match. Close this tab and start again.");
        return;
      }
      clearTimeout(timer);
      server.close();
      const err = u.searchParams.get("error");
      const c = u.searchParams.get("code");
      if (err || !c) {
        done(400, "Lure: sign-in was not completed. You can close this tab.");
        reject(new LureError(`sign-in was not completed: ${err ?? "no code"}`));
        return;
      }
      done(200, "Lure: signed in. You can close this tab and return to your agent.");
      resolve({ code: c, redirect });
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new LureError(`no sign-in within ${timeoutMinutes} minutes; run auth again`));
    }, timeoutMinutes * 60_000);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new LureError("could not open a local port for sign-in"));
        return;
      }
      redirect = `http://127.0.0.1:${addr.port}`;
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: "code",
        scope: SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      console.log("Open this address to sign in (it opens by itself if it can):");
      console.log(url.toString());
      console.log(`Waiting up to ${timeoutMinutes} minutes…`);
      openBrowser(url.toString());
    });
  });

  const tokens = await postForm(f, TOKEN_URL, {
    code: code.code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: code.redirect,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  if (!tokens.refresh_token) throw new LureError("Google returned no refresh token; run auth again");
  if (!String(tokens.scope ?? "").includes("webmasters.readonly")) {
    throw new LureError("Search Console access was not granted; tick it on the consent screen and run auth again");
  }
  const account = emailFromIdToken(tokens.id_token ?? "");
  writeSecret(tokenPath(account), {
    account,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    created: new Date().toISOString(),
  });
  return account;
}

export async function accessToken(account: string, f: Fetch = fetch): Promise<string> {
  const path = tokenPath(account);
  if (!existsSync(path)) throw new LureError(`${account} is not signed in; run auth`);
  let saved: any;
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Never echo the parser's message: it quotes the file, and the file is a secret.
    throw new LureError(`the saved sign-in of ${account} is damaged; delete ${path} and run auth again`);
  }
  const client = readClient();
  try {
    const t = await postForm(f, TOKEN_URL, {
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: saved.refresh_token,
      grant_type: "refresh_token",
    });
    return t.access_token;
  } catch (e) {
    if (e instanceof LureError && e.message.includes("invalid_grant")) {
      throw new LureError(`the sign-in of ${account} has expired or was revoked; run auth again`);
    }
    throw e;
  }
}

// ---- Search Console API -------------------------------------------------------------------

async function api(f: Fetch, token: string, path: string, body?: unknown): Promise<any> {
  const res = await f(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new LureError(`Search Console refused (${res.status}): ${json.error?.message ?? res.statusText}`);
  }
  return json;
}

export async function listSites(token: string, f: Fetch = fetch): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  const json = await api(f, token, "/sites");
  return (json.siteEntry ?? []).sort((a: any, b: any) => a.siteUrl.localeCompare(b.siteUrl));
}

export async function query(
  f: Fetch, token: string, property: string, dimensions: string[], startDate: string, endDate: string,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let startRow = 0; ; startRow += PAGE_SIZE) {
    const json = await api(f, token, `/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
      startDate, endDate, dimensions, type: "web", dataState: "final", rowLimit: PAGE_SIZE, startRow,
    });
    const page: Row[] = json.rows ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

// URL Inspection: what Google's index holds for one page — never the live page itself.
const INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export type Inspection = {
  lastCrawlTime: string | null; pageFetchState: string | null; googleCanonical: string | null; coverageState: string | null;
};

export async function inspect(token: string, property: string, url: string, f: Fetch = fetch): Promise<Inspection> {
  const res = await f(INSPECT, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ inspectionUrl: url, siteUrl: property }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new LureError(`URL Inspection refused (${res.status}): ${json.error?.message ?? res.statusText}`);
  }
  const r = json.inspectionResult?.indexStatusResult ?? {};
  return {
    lastCrawlTime: r.lastCrawlTime ?? null,
    pageFetchState: r.pageFetchState ?? null,
    googleCanonical: r.googleCanonical ?? null,
    coverageState: r.coverageState ?? null,
  };
}

// ---- CSV ----------------------------------------------------------------------------------

export function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(fields: (string | number)[]): string {
  return fields.map(csvField).join(",") + "\n";
}

// The last date in a file this module wrote: dates are the first field and rows are sorted.
export function lastDate(path: string): string | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  for (let i = lines.length - 1; i > 0; i--) {
    const d = lines[i].slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  }
  return null;
}

// Append whole new rows at once: the file is rewritten to a temporary file and renamed, so an
// interrupted pull leaves the previous file intact and never half a day.
export function appendRows(path: string, header: string[], rows: (string | number)[][]): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const before = existsSync(path) ? readFileSync(path, "utf8") : csvLine(header);
  const tmp = `${path}.part`;
  writeFileSync(tmp, before + rows.map(csvLine).join(""));
  renameSync(tmp, path);
}

// ---- Dates --------------------------------------------------------------------------------

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function earliest(today: string, months = HISTORY_MONTHS): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

// ---- Pull ---------------------------------------------------------------------------------

export type PullResult = { file: string; from: string; to: string; rows: number }[];

export async function pull(
  token: string, property: string, workspace: string, today: string, f: Fetch = fetch,
): Promise<PullResult> {
  if (!existsSync(join(workspace, "lure.yaml"))) {
    throw new LureError(`${workspace} is not a Lure workspace (no lure.yaml)`);
  }
  const dir = join(workspace, "search-console");
  const files = [
    { path: join(dir, "site-daily.csv"), header: SITE_HEADER, dims: ["date"] },
    { path: join(dir, "pages-daily.csv"), header: PAGES_HEADER, dims: ["date", "page"] },
  ];
  const result: PullResult = [];
  for (const file of files) {
    const last = lastDate(file.path);
    const from = last ? addDays(last, 1) : earliest(today);
    if (from > today) continue;
    const rows = await query(f, token, property, file.dims, from, today);
    const out = rows
      .filter((r) => r.keys[0] >= from)
      .sort((a, b) => a.keys.join("\t").localeCompare(b.keys.join("\t")))
      .map((r) => [...r.keys, r.clicks, r.impressions, r.ctr, r.position]);
    appendRows(file.path, file.header, out);
    if (out.length > 0) {
      result.push({ file: file.path, from: out[0][0] as string, to: out[out.length - 1][0] as string, rows: out.length });
    }
  }
  return result;
}

// ---- Command line -------------------------------------------------------------------------

function need(v: string | undefined, name: string): string {
  if (!v) throw new LureError(`--${name} is required`);
  return v;
}

export async function main(argv: string[], f: Fetch = fetch): Promise<number> {
  if (nodeTooOld(process.versions.node)) {
    console.error(`Lure needs Node ${MIN_NODE} or newer; this is ${process.versions.node}.`);
    return 1;
  }
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      account: { type: "string" },
      property: { type: "string" },
      workspace: { type: "string" },
      "timeout-minutes": { type: "string" },
    },
  });
  try {
    switch (positionals[0]) {
      case "auth": {
        const account = await auth(Number(values["timeout-minutes"] ?? 10), f);
        console.log(`signed in: ${account}`);
        return 0;
      }
      case "sites": {
        const token = await accessToken(need(values.account, "account"), f);
        const sites = await listSites(token, f);
        if (sites.length === 0) console.log("no Search Console properties for this account");
        for (const s of sites) console.log(`${s.siteUrl}\t${s.permissionLevel}`);
        return 0;
      }
      case "pull": {
        const token = await accessToken(need(values.account, "account"), f);
        const today = new Date().toISOString().slice(0, 10);
        const done = await pull(token, need(values.property, "property"), need(values.workspace, "workspace"), today, f);
        if (done.length === 0) console.log("nothing new: every final day is already in the workspace");
        for (const d of done) console.log(`${d.file}: ${d.rows} rows, ${d.from} … ${d.to}`);
        return 0;
      }
      default:
        console.error("usage: search-console.mts auth | sites --account <e-mail> | pull --account <e-mail> --property <url> --workspace <dir>");
        return 2;
    }
  } catch (e) {
    if (e instanceof LureError) {
      console.error(`lure: ${e.message}`);
      return 1;
    }
    if (e instanceof TypeError && e.message === "fetch failed") {
      console.error("lure: could not reach Google; check the internet connection and try again");
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
