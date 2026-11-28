/**
 * agent-accounts — shared engine for multi-agent login account profiles (alias backup / one-click switch / automatic safety net)
 * (pure module, testable; authoritative source is this file; caller: aiti-agent-manager).
 *
 * Design (decided 2026-09-13):
 *   - **Single-file store**: all agents, all account profiles live in one JSON file
 *     (default `<agent-manager configDir>/agent-accounts.json`, 0600) — the aiti-configs backup can encrypt everything with a single
 *     encrypt pattern (agent-accounts.json), nothing scattered across multiple files.
 *   - **slot**: each agent's login credentials = a set of "slots" (key / label / current machine's absolute path),
 *     resolved per machine by the caller; the snapshot stores only key + content, and switching back writes to the current machine's paths (usable for cross-machine backup).
 *   - **Automatic safety profile**: before overriding operations like switch / login / logout, if the current login is not covered by any profile →
 *     automatically store `_auto-before-<kind>` — never lose an account to switching / re-login, and no need for the user to back up manually first.
 *   - **current determination**: content-signature (sha256) comparison, no extra state stored; external file changes are still noticed.
 *   - **Logout**: `clearSlots` deletes the current credential files (after the caller's automatic safety net); credentials injected via feature/env
 *     are not file-level and are naturally unaffected (the caller may warn).
 *
 * Storage structure:
 *   { version: 1,
 *     accounts: { <agent>: { <alias>: {
 *       savedAt: number, auto?: boolean, note?: string,
 *       files: { <slotKey>: { data: string, b64?: boolean, label?: string } } } } } }
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const ACCOUNTS_STORE_VERSION = 1;
/** Single-file size defense (normally tens of KB; exceeding the limit means a large file was mistakenly collected — refuse the write and error). */
export const MAX_STORE_BYTES = 4 * 1024 * 1024;
/** Automatic safety-profile prefix (user manual aliases must not start with this). */
export const AUTO_ALIAS_PREFIX = "_auto-";

/** One credential slot (key is the stable logical identity; decoupled from the current machine's path when writing snapshots/switching back). */
export interface AccountSlot {
  key: string;
  label: string;
  /** Current machine's absolute path (absent = this slot currently has no content). */
  path: string;
}

interface StoredFile {
  data: string;
  /** true = data is base64 (the original file was not UTF-8 text); default = plain text */
  b64?: boolean;
  label?: string;
}

export interface StoredAccount {
  savedAt: number;
  auto?: boolean;
  note?: string;
  /** Account identity fingerprint (built by the caller, e.g. "Li Yong|330116798388") — still marks "current" after automatic token refresh */
  identity?: string;
  /** Account display metadata (user/uin/expiresAt; for display, no token) */
  account?: AccountDisplay;
  files: Record<string, StoredFile>;
}

/** Account display metadata (extracted from each vendor's /login/status; fields optional). */
export interface AccountDisplay {
  user?: string;
  uin?: string;
  /** Credential validity (ms timestamp; token expiry time) */
  expiresAt?: number;
}

export interface AccountsStore {
  version: number;
  accounts: Record<string, Record<string, StoredAccount>>;
}

/** List entry (for panel display; no file content). */
export interface AccountEntry {
  alias: string;
  savedAt: number;
  auto: boolean;
  note?: string;
  /** Account display metadata (user/uin/expiresAt; when missing in old profiles the caller backfills from identity) */
  user?: string;
  uin?: string;
  expiresAt?: number;
  slotCount: number;
  /** Number of slots that already have content on the current machine (< slotCount when the profile stored it but this machine lacks the slot) */
  presentCount: number;
  current: boolean;
}

export function emptyStore(): AccountsStore {
  return { version: ACCOUNTS_STORE_VERSION, accounts: {} };
}

/** Reads the single-file store (missing/bad JSON/version mismatch → empty store, no throw). */
export function readAccountsStore(file: string): AccountsStore {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as AccountsStore;
    if (!j || typeof j !== "object" || !j.accounts || typeof j.accounts !== "object") return emptyStore();
    return { version: ACCOUNTS_STORE_VERSION, accounts: j.accounts };
  } catch {
    return emptyStore();
  }
}

/** Atomically writes the single-file store (temp file + rename; 0600; size defense). */
export function writeAccountsStore(file: string, store: AccountsStore): void {
  const body = JSON.stringify({ version: ACCOUNTS_STORE_VERSION, accounts: store.accounts }, null, 1);
  if (Buffer.byteLength(body) > MAX_STORE_BYTES) {
    throw new Error(`account profile file over the size limit (>${Math.round(MAX_STORE_BYTES / 1024 / 1024)}MB) — check whether a slot mistakenly collected a large file`);
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* non-POSIX tolerance */ }
  renameSync(tmp, file);
}

/** User-input alias sanitization: 1-32 chars, Unicode letters/digits/._- spaces, first char not a symbol, reserved prefix and path separators forbidden. */
export function sanitizeAlias(alias: unknown): string | null {
  const a = String(alias ?? "").trim();
  if (!a || a.length > 32) return null;
  if (a.startsWith(AUTO_ALIAS_PREFIX)) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(a)) return null;
  if (a.includes("..") || a.includes("/") || a.includes("\\")) return null;
  return a;
}

/** Automatic safety-profile alias. */
export function autoAlias(kind: "switch" | "login" | "logout"): string {
  return `${AUTO_ALIAS_PREFIX}before-${kind}`;
}

/** Slot's current content (missing/empty file → null; non-UTF-8 binary → base64). */
function readSlotData(slot: AccountSlot): StoredFile | null {
  try {
    if (!existsSync(slot.path)) return null;
    const st = statSync(slot.path);
    if (!st.isFile() || st.size === 0) return null;
    const buf = readFileSync(slot.path);
    const text = buf.toString("utf8");
    const lossless = Buffer.compare(Buffer.from(text, "utf8"), buf) === 0 && !text.includes("\u0000");
    return lossless ? { data: text, label: slot.label } : { data: buf.toString("base64"), b64: true, label: slot.label };
  } catch {
    return null;
  }
}

function storedToBuffer(f: StoredFile): Buffer {
  return f.b64 ? Buffer.from(f.data, "base64") : Buffer.from(f.data, "utf8");
}

/** Content signature of the slot set (only includes currently present content; keys sorted for stability). */
export function currentSignature(slots: AccountSlot[]): string {
  const h = createHash("sha256");
  for (const s of [...slots].sort((a, b) => a.key.localeCompare(b.key))) {
    const f = readSlotData(s);
    if (!f) continue;
    h.update(s.key).update("\u0000").update(f.b64 ? "b64:" : "").update(f.data).update("\u0000");
  }
  return h.digest("hex").slice(0, 16);
}

function accountSignature(acct: StoredAccount): string {
  const h = createHash("sha256");
  for (const key of Object.keys(acct.files).sort()) {
    const f = acct.files[key];
    h.update(key).update("\u0000").update(f.b64 ? "b64:" : "").update(f.data).update("\u0000");
  }
  return h.digest("hex").slice(0, 16);
}

/** Whether the current slots have any content (yes = can back up / needs the safety net). */
export function hasAnySlotContent(slots: AccountSlot[]): boolean {
  return slots.some((s) => readSlotData(s) !== null);
}

/** Whether the current login is already covered by some profile (for the pre-auto-safety-net check; same identity also counts as covered). */
export function isCurrentCovered(store: AccountsStore, agent: string, slots: AccountSlot[], identity?: string): boolean {
  const sig = currentSignature(slots);
  if (sig === currentSignature([])) return false; // currently no content
  return Object.values(store.accounts[agent] ?? {}).some((a) =>
    accountSignature(a) === sig || Boolean(identity && a.identity && a.identity === identity));
}

/**
 * Lists an agent's account profiles (savedAt descending).
 * current = content signature matches, **or** same identity (still recognizes the same account when automatic token refresh rotates the content).
 */
export function listAccounts(
  store: AccountsStore,
  agent: string,
  slots: AccountSlot[],
  opts: { identity?: string } = {},
): AccountEntry[] {
  const cur = currentSignature(slots);
  const map = store.accounts[agent] ?? {};
  const presentKeys = new Set(slots.map((s) => s.key));
  return Object.entries(map)
    .map(([alias, acct]) => ({
      alias,
      savedAt: acct.savedAt,
      auto: acct.auto === true || alias.startsWith(AUTO_ALIAS_PREFIX),
      ...(acct.note ? { note: acct.note } : {}),
      ...(acct.account?.user ? { user: acct.account.user } : {}),
      ...(acct.account?.uin ? { uin: acct.account.uin } : {}),
      ...(typeof acct.account?.expiresAt === "number" && Number.isFinite(acct.account.expiresAt) ? { expiresAt: acct.account.expiresAt } : {}),
      slotCount: Object.keys(acct.files).length,
      presentCount: Object.keys(acct.files).filter((k) => presentKeys.has(k)).length,
      current: Object.keys(acct.files).length > 0
        && (accountSignature(acct) === cur || Boolean(opts.identity && acct.identity && acct.identity === opts.identity)),
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Backs up the current login as an account profile (overwrites a same-named profile).
 * @throws when no slot has any content (no login state to back up)
 */
export function saveAccount(
  store: AccountsStore,
  agent: string,
  alias: string,
  slots: AccountSlot[],
  opts: { auto?: boolean; note?: string; identity?: string; account?: AccountDisplay; now?: number } = {},
): { entry: AccountEntry; overwritten: boolean } {
  const clean = opts.auto ? String(alias) : sanitizeAlias(alias);
  if (!clean || clean.includes("/") || clean.includes("\\") || clean.includes("..")) {
    throw new Error("invalid alias: 1-32 characters; Unicode letters/digits/./_/-/space allowed; must not start with _auto-");
  }
  const files: Record<string, StoredFile> = {};
  for (const s of slots) {
    const f = readSlotData(s);
    if (f) files[s.key] = f;
  }
  if (!Object.keys(files).length) throw new Error("no login state to back up (no credential files detected)");
  const prev = store.accounts[agent]?.[clean];
  const account = opts.account && (opts.account.user || opts.account.uin || typeof opts.account.expiresAt === "number") ? opts.account : undefined;
  store.accounts[agent] = store.accounts[agent] ?? {};
  store.accounts[agent][clean] = {
    savedAt: opts.now ?? Date.now(),
    ...(opts.auto ? { auto: true } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.identity ? { identity: opts.identity } : {}),
    ...(account ? { account } : {}),
    files,
  };
  const entries = listAccounts(store, agent, slots, { identity: opts.identity });
  const entry = entries.find((e) => e.alias === clean)!;
  return { entry, overwritten: Boolean(prev) };
}

/** Restores profile content to slot paths (slots missing from the profile → delete the current file, keeping the post-switch state clean). */
export function restoreAccount(store: AccountsStore, agent: string, alias: string, slots: AccountSlot[]): StoredAccount {
  const acct = store.accounts[agent]?.[alias];
  if (!acct) throw new Error(`account profile does not exist: ${agent} / ${alias}`);
  for (const s of slots) {
    const f = acct.files[s.key];
    if (f) {
      mkdirSync(dirname(s.path), { recursive: true, mode: 0o700 });
      writeFileSync(s.path, storedToBuffer(f), { mode: 0o600 });
      try { chmodSync(s.path, 0o600); } catch { /* non-POSIX tolerance */ }
    } else {
      try { rmSync(s.path, { force: true }); } catch { /* already gone */ }
    }
  }
  return acct;
}

/**
 * Switches to an account profile: if the current login is not covered by any profile, first auto-stores `_auto-before-switch`, then restores the target profile.
 * @returns autoSaved = whether an automatic safety profile was created
 */
export function switchAccount(
  store: AccountsStore,
  agent: string,
  alias: string,
  slots: AccountSlot[],
  opts: { now?: number; note?: string; identity?: string; account?: AccountDisplay } = {},
): { entry: AccountEntry; autoSaved: boolean } {
  const clean = String(alias ?? "").trim();
  if (!store.accounts[agent]?.[clean]) throw new Error(`account profile does not exist: ${clean}`);
  let autoSaved = false;
  if (hasAnySlotContent(slots) && !isCurrentCovered(store, agent, slots, opts.identity)) {
    try {
      saveAccount(store, agent, autoAlias("switch"), slots, {
        auto: true, now: opts.now,
        ...(opts.identity ? { identity: opts.identity } : {}),
        ...(opts.account ? { account: opts.account } : {}),
      });
      autoSaved = true;
    } catch { /* safety-net failure does not block the switch */ }
  }
  restoreAccount(store, agent, clean, slots);
  const entries = listAccounts(store, agent, slots, { identity: opts.identity });
  const entry = entries.find((e) => e.alias === clean)!;
  return { entry, autoSaved };
}

/** Deletes an account profile (including automatic safety profiles). */
export function removeAccount(store: AccountsStore, agent: string, alias: string): boolean {
  const clean = String(alias ?? "").trim();
  if (!clean || clean.includes("/") || clean.includes("\\") || clean.includes("..")) throw new Error("invalid alias");
  const bag = store.accounts[agent];
  if (!bag?.[clean]) return false;
  delete bag[clean];
  if (!Object.keys(bag).length) delete store.accounts[agent];
  return true;
}

/**
 * Logout (clears all slot files). The caller should first ensure the current login is saved (automatic safety net `_auto-before-logout`).
 * @returns the file paths actually deleted
 */
export function clearSlots(slots: AccountSlot[]): string[] {
  const removed: string[] = [];
  for (const s of slots) {
    try {
      if (!existsSync(s.path)) continue;
      rmSync(s.path, { force: true });
      removed.push(s.path);
    } catch { /* deletion failed; left for next time */ }
  }
  return removed;
}

