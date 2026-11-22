/**
 * Entry helpers: command capture, .env import, environment scan, alias
 * suggestion, and value→alias lookup (used by the vault landing mode).
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fnv1a } from "@aiti-ai/secret-mask-core";
import { VaultError, type AddResult, type VaultStore } from "./store.ts";

export const CAPTURE_DEFAULT_TIMEOUT_MS = 10_000;
export const CAPTURE_DEFAULT_MAX_BYTES = 4096;
export const CAPTURE_DEFAULT_MAX_VALUE = 4096;

function killTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Windows: kill the whole process tree, not just the shell.
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } catch {
      try {
        child.kill();
      } catch {}
    }
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

export interface CaptureOptions {
  timeoutMs?: number;
  maxBytes?: number;
  cwd?: string;
}

/** Run a command and return its stdout (values never echo to the terminal/chat). */
export function captureStdout(command: string, opts: CaptureOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? CAPTURE_DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? CAPTURE_DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd: opts.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(out.trim());
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(new VaultError("timeout", `vault: capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (buf: Buffer) => {
      out += buf.toString("utf8");
      if (Buffer.byteLength(out) > maxBytes) {
        killTree(child);
        finish(new VaultError("too-large", `vault: captured output exceeds ${maxBytes} bytes (refusing to store)`));
      }
    });
    child.stderr?.on("data", (buf: Buffer) => {
      err = (err + buf.toString("utf8")).slice(-2000);
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new VaultError("capture-failed", `vault: command exited with ${code}${err.trim() ? `: ${err.trim().split("\n")[0]}` : ""}`));
        return;
      }
      finish();
    });
  });
}

export interface CaptureResult extends AddResult {
  alias: string;
}

/** `/vault capture <alias> -- <command>` */
export async function captureIntoVault(
  store: VaultStore,
  alias: string,
  command: string,
  opts: CaptureOptions & { project?: boolean; desc?: string; tags?: string[] } = {},
): Promise<CaptureResult> {
  const value = await captureStdout(command, opts);
  if (value.length > CAPTURE_DEFAULT_MAX_VALUE) {
    throw new VaultError("too-large", `vault: captured value exceeds ${CAPTURE_DEFAULT_MAX_VALUE} bytes (refusing to store)`);
  }
  return store.add(alias, value, { project: opts.project, desc: opts.desc, tags: opts.tags });
}

// ---------------------------------------------------------------------------
// .env import / environment scan
// ---------------------------------------------------------------------------

export interface EnvPair {
  key: string;
  value: string;
}

/** Parse `KEY=value` / `export KEY=value` lines (quotes stripped, comments skipped). */
export function parseEnvFile(text: string): EnvPair[] {
  const out: EnvPair[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    out.push({ key: m[1]!, value });
  }
  return out;
}

const ENV_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|DSN)/i;

/** Convert an environment variable name into a vault alias. */
export function aliasFromEnvName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "env-value";
}

export interface ImportResult {
  added: number;
  rotated: number;
  skipped: number;
  aliases: string[];
  /** Aliases whose values were assessed as weak passwords. */
  weak: string[];
}

export function importPairs(store: VaultStore, pairs: EnvPair[], opts: { project?: boolean } = {}): ImportResult {
  const result: ImportResult = { added: 0, rotated: 0, skipped: 0, aliases: [], weak: [] };
  for (const pair of pairs) {
    const alias = aliasFromEnvName(pair.key);
    if (valueExists(store, pair.value)) {
      result.skipped++;
      continue;
    }
    try {
      const res = store.add(alias, pair.value, { project: opts.project, tags: ["imported"] });
      if (res.created) result.added++;
      else result.rotated++;
      result.aliases.push(res.alias);
      if (res.weak) result.weak.push(res.alias);
    } catch {
      result.skipped++;
    }
  }
  return result;
}

export function importEnvFile(store: VaultStore, path: string, opts: { project?: boolean } = {}): ImportResult {
  const text = readFileSync(path, "utf8");
  return importPairs(store, parseEnvFile(text), opts);
}

/** Scan the current process environment for secret-looking values. */
export function importProcessEnv(store: VaultStore, opts: { project?: boolean; env?: NodeJS.ProcessEnv } = {}): ImportResult {
  const env = opts.env ?? process.env;
  const pairs: EnvPair[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || !ENV_NAME_RE.test(key)) continue;
    if (value.length < 8) continue;
    if (/^rsec_[0-9a-f]{8}$/.test(value) || value.startsWith("[REDACTED:")) continue;
    pairs.push({ key, value });
  }
  return importPairs(store, pairs, opts);
}

// ---------------------------------------------------------------------------
// value → alias lookup (vault landing mode)
// ---------------------------------------------------------------------------

/** True when any vault entry decrypts to this exact value. */
export function valueExists(store: VaultStore, value: string): boolean {
  return findAliasForValue(store, value) !== undefined;
}

/** Find the alias holding exactly this value (first match in list order). */
export function findAliasForValue(store: VaultStore, value: string): string | undefined {
  for (const info of store.list()) {
    try {
      if (store.get(info.alias).value === value) return info.alias;
    } catch {
      // locked/bad entry: behave as "not found" instead of failing the hook
    }
  }
  return undefined;
}

/** `auto-<label>-<hash8>` alias used when landing auto-detected prompt values. */
export function suggestAutoAlias(label: string, value: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "value";
  return `auto-${slug}-${fnv1a(value)}`;
}
