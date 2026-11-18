/**
 * OS keychain adapters for the vault master key.
 *
 * Modes:
 *   - keyfile (default): `~/.pi/agent/secret-vault/master.key` (32 bytes, 0600)
 *   - keychain: master key lives in the OS credential store, away from the
 *     vault directory, so a copied/backed-up vault folder does not leak it.
 *
 * Backends:
 *   - macOS  `security` (generic password)
 *   - Linux  `secret-tool` (libsecret / GNOME Keyring, KWallet via libsecret)
 *   - Windows DPAPI via PowerShell `ConvertFrom-SecureString` (user+machine
 *     bound; the ciphertext lives outside the vault directory)
 *
 * Every call is a **bounded subprocess** (default 10s): an interactive-less
 * SSH session on macOS can hang the native keychain API forever — that is a
 * known trap, so we never wait unbounded. Secrets travel via stdin/env, not
 * argv where the platform allows it.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type KeychainBackend = "macos-security" | "linux-secret-tool" | "windows-dpapi" | "unavailable";

export interface KeychainOptions {
  backend?: KeychainBackend;
  service?: string;
  account?: string;
  /** Windows DPAPI ciphertext path (default under LOCALAPPDATA / ~/.aiti). */
  file?: string;
  timeoutMs?: number;
}

export interface KeychainLike {
  backend: KeychainBackend;
  get(): string | undefined;
  set(value: string): void;
  delete(): void;
  available(): boolean;
}

export const KEYCHAIN_SERVICE = "aiti-secret-vault";
export const KEYCHAIN_ACCOUNT = "master-key";
const DEFAULT_TIMEOUT_MS = 10_000;

function findInPath(name: string): boolean {
  const path = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext))) return true;
      if (existsSync(join(dir, name.toLowerCase() + ext.toLowerCase()))) return true;
    }
  }
  return false;
}

export function detectKeychainBackend(): KeychainBackend {
  if (process.platform === "darwin") return "macos-security";
  if (process.platform === "win32") return findInPath("powershell") || findInPath("pwsh") ? "windows-dpapi" : "unavailable";
  if (process.platform === "linux" && findInPath("secret-tool")) return "linux-secret-tool";
  return "unavailable";
}

function windowsKeyFile(opts: KeychainOptions): string {
  if (opts.file) return opts.file;
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), ".aiti");
  return join(base, "aiti-secret-vault", "master.key.dpapi");
}

function windowsPowerShell(): string {
  return findInPath("pwsh") ? "pwsh" : "powershell";
}

/** Run a helper synchronously with a hard timeout; returns stdout on success. */
function runSync(cmd: string, args: string[], opts: KeychainOptions & { input?: string; env?: NodeJS.ProcessEnv } = {}): { ok: boolean; stdout: string; stderr: string; notFound: boolean } {
  const res = spawnSync(cmd, args, {
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    encoding: "utf8",
    input: opts.input,
    env: opts.env ?? process.env,
    windowsHide: true,
  });
  const notFound =
    res.status === 44 || // macOS security: item not found
    res.status === 1 && /not found|no such|not set/i.test(String(res.stderr ?? "")) ||
    res.status === 2 && /not found|no such/i.test(String(res.stderr ?? ""));
  return { ok: res.status === 0 && !res.error, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? res.error ?? ""), notFound };
}

/** Asynchronous variant (UI paths that must not block the event loop). */
function runAsync(cmd: string, args: string[], opts: KeychainOptions & { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

const DARWIN_READ = ["find-generic-password", "-s"];
const DARWIN_ADD = ["add-generic-password", "-U", "-s"];
const DARWIN_DELETE = ["delete-generic-password", "-s"];

export function createKeychain(opts: KeychainOptions = {}): KeychainLike {
  const backend = opts.backend ?? detectKeychainBackend();
  const service = opts.service ?? KEYCHAIN_SERVICE;
  const account = opts.account ?? KEYCHAIN_ACCOUNT;
  const available = (): boolean => backend !== "unavailable";

  return {
    backend,
    available,
    get(): string | undefined {
      if (backend === "macos-security") {
        const r = runSync("security", [...DARWIN_READ, service, "-a", account, "-w"], opts);
        if (!r.ok) return undefined;
        return r.stdout.trim() || undefined;
      }
      if (backend === "linux-secret-tool") {
        const r = runSync("secret-tool", ["lookup", "service", service, "account", account], opts);
        return r.ok && r.stdout.trim() ? r.stdout.trim() : undefined;
      }
      if (backend === "windows-dpapi") {
        const file = windowsKeyFile(opts);
        if (!existsSync(file)) return undefined;
        const script =
          "$ErrorActionPreference='Stop';" +
          "$sec = Get-Content -Raw -LiteralPath $env:AITI_VAULT_KEY_FILE | ConvertTo-SecureString;" +
          "$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec);" +
          "[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)";
        const r = runSync(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command", script], {
          ...opts,
          env: { ...process.env, AITI_VAULT_KEY_FILE: file },
        });
        return r.ok && r.stdout.trim() ? r.stdout.trim() : undefined;
      }
      return undefined;
    },
    set(value: string): void {
      if (backend === "macos-security") {
        const r = runSync("security", [...DARWIN_ADD, service, "-a", account, "-w", value], opts);
        if (!r.ok) throw new Error(`keychain: security add-generic-password failed: ${r.stderr.trim() || "unknown error"}`);
        return;
      }
      if (backend === "linux-secret-tool") {
        const r = runSync("secret-tool", ["store", "--label", `${service}:${account}`, "service", service, "account", account], { ...opts, input: value });
        if (!r.ok) throw new Error(`keychain: secret-tool store failed: ${r.stderr.trim() || "unknown error"}`);
        return;
      }
      if (backend === "windows-dpapi") {
        const file = windowsKeyFile(opts);
        mkdirSync(dirname(file), { recursive: true });
        const script =
          "$ErrorActionPreference='Stop';" +
          "$sec = ConvertTo-SecureString $env:AITI_VAULT_KEY -AsPlainText -Force;" +
          "ConvertFrom-SecureString $sec | Set-Content -NoNewline -LiteralPath $env:AITI_VAULT_KEY_FILE";
        const r = runSync(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command", script], {
          ...opts,
          env: { ...process.env, AITI_VAULT_KEY: value, AITI_VAULT_KEY_FILE: file },
        });
        if (!r.ok) throw new Error(`keychain: DPAPI write failed: ${r.stderr.trim() || "unknown error"}`);
        try {
          chmodSync(file, 0o600);
        } catch {}
        return;
      }
      throw new Error("keychain: no OS keychain backend available on this platform");
    },
    delete(): void {
      if (backend === "macos-security") {
        runSync("security", [...DARWIN_DELETE, service, "-a", account], opts);
        return;
      }
      if (backend === "linux-secret-tool") {
        runSync("secret-tool", ["clear", "service", service, "account", account], opts);
        return;
      }
      if (backend === "windows-dpapi") {
        try {
          unlinkSync(windowsKeyFile(opts));
        } catch {
          rmSync(windowsKeyFile(opts), { force: true });
        }
        return;
      }
      throw new Error("keychain: no OS keychain backend available on this platform");
    },
  };
}

/** Async keychain get for hooks/UI where blocking is unacceptable. */
export async function keychainGetAsync(keychain: KeychainLike, opts: KeychainOptions = {}): Promise<string | undefined> {
  if (keychain.backend !== "linux-secret-tool" && keychain.backend !== "macos-security") return keychain.get();
  const service = opts.service ?? KEYCHAIN_SERVICE;
  const account = opts.account ?? KEYCHAIN_ACCOUNT;
  const cmd = keychain.backend === "linux-secret-tool" ? "secret-tool" : "security";
  const args = keychain.backend === "linux-secret-tool" ? ["lookup", "service", service, "account", account] : [...DARWIN_READ, service, "-a", account, "-w"];
  const r = await runAsync(cmd, args, opts);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : undefined;
}
