/**
 * GitHub CLI (`gh`) credential bridge.
 *
 * The extension never stores a gh token: it asks `gh auth token` on demand and keeps
 * the value in a short-lived in-memory cache. `gh auth status --json hosts` provides
 * the account list/scopes for the settings UI (never the token).
 *
 * Security: execFile only (no shell), strict timeout, tokens never logged or written
 * to config/state. The caller must have explicit user consent for this auth mode.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderConfig } from "./contract.ts";
import { ForgeHttpError } from "./http.ts";

const TOKEN_TTL_MS = 60_000;
const EXEC_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 1 << 20;

export type GhExec = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec = promisify(execFile) as unknown as GhExec;

export interface GhAccount {
  host: string;
  login: string;
  active: boolean;
  state: string;
  scopes: string;
  tokenSource?: string;
}

export interface GhStatus {
  available: boolean;
  version?: string;
  error?: string;
  accounts: GhAccount[];
}

export interface GhCli {
  status(host?: string): Promise<GhStatus>;
  token(host?: string, user?: string): Promise<string>;
  clearTokenCache(): void;
}

function errText(e: unknown): string {
  const o = e as { code?: string; stderr?: string; message?: string };
  if (o?.code === "ENOENT") return "gh CLI is not installed (https://cli.github.com/)";
  return String(o?.stderr || o?.message || e).trim().slice(0, 300);
}

function parseStatus(raw: string, host?: string): GhAccount[] {
  const data = JSON.parse(raw) as { hosts?: Record<string, Array<Record<string, unknown>>> };
  const out: GhAccount[] = [];
  for (const [h, list] of Object.entries(data.hosts || {})) {
    if (host && h !== host) continue;
    for (const a of Array.isArray(list) ? list : []) {
      out.push({
        host: h,
        login: String(a.login || ""),
        active: a.active === true,
        state: String(a.state || "unknown"),
        scopes: String(a.scopes || ""),
        tokenSource: a.tokenSource ? String(a.tokenSource) : undefined,
      });
    }
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || a.login.localeCompare(b.login));
}

export function createGhCli(exec: GhExec = defaultExec): GhCli {
  const cache = new Map<string, { token: string; at: number }>();
  let version: string | undefined;
  let versionTried = false;

  async function versionOf(): Promise<string | undefined> {
    if (versionTried) return version;
    versionTried = true;
    try {
      const { stdout } = await exec("gh", ["--version"], { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true });
      version = String(stdout || "").split("\n")[0].trim();
    } catch {
      version = undefined;
    }
    return version;
  }

  return {
    async status(host?: string): Promise<GhStatus> {
      const v = await versionOf();
      if (!v) return { available: false, error: "gh CLI is not installed (https://cli.github.com/)", accounts: [] };
      try {
        const { stdout } = await exec("gh", ["auth", "status", "--json", "hosts"], {
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
        });
        return { available: true, version: v, accounts: parseStatus(stdout, host) };
      } catch (e) {
        return { available: true, version: v, error: errText(e), accounts: [] };
      }
    },

    async token(host = "github.com", user?: string): Promise<string> {
      const key = `${host}\0${user || ""}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
      const args = ["auth", "token", "--hostname", host, ...(user ? ["--user", user] : [])];
      try {
        const { stdout } = await exec("gh", args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true });
        const token = String(stdout || "").trim();
        if (!token) throw new Error("gh returned no token");
        cache.set(key, { token, at: Date.now() });
        return token;
      } catch (e) {
        throw new ForgeHttpError(`Cannot read the gh token: ${errText(e)} (run "gh auth login" first)`, { status: 401, code: "auth" });
      }
    },

    clearTokenCache(): void {
      cache.clear();
    },
  };
}

export const ghCli = createGhCli();

/** Replace the token placeholder for `authType: "gh"` requests (never persisted). */
export async function withGhToken(cfg: ProviderConfig, cli: GhCli = ghCli): Promise<ProviderConfig> {
  if (cfg.authType !== "gh") return cfg;
  const token = await cli.token(cfg.ghHost || "github.com", cfg.ghUser);
  return { ...cfg, token };
}
