/**
 * Encrypted vault store (file shape inspired by SOPS: plaintext metadata,
 * encrypted values, per-entry IV).
 *
 * Layout under `~/.pi/agent/secret-vault/`:
 *   master.key            32 random bytes, 0600 (keyfile mode)
 *   global.json           entries available in every project
 *   vault.<cwdHash8>.json project bucket (shadows global aliases)
 *
 * Trust model: the keyfile is the root. A same-uid process can read it, so
 * encryption protects the case "vault file leaves this machine", not local
 * attackers. Unlock is fail-closed: a missing/mismatched key never decrypts.
 */

import { homedir } from "node:os";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assessPasswordStrength, fnv1a, MIN_REDACT_LENGTH, type PasswordStrength } from "@aiti-ai/secret-mask-core";
import {
  createKeyFile,
  decryptValue,
  encryptValue,
  generateKey,
  readKeyFile,
  writeFileAtomic,
  type Envelope,
} from "./crypto.ts";
import { createKeychain, type KeychainLike } from "./keychain.ts";

export const DEFAULT_VAULT_DIR = join(homedir(), ".pi", "agent", "secret-vault");
export const MASTER_KEY_FILE = "master.key";
export const MODE_FILE = "config.json";
export const GLOBAL_FILE = "global.json";
export const CHECK_PLAINTEXT = "aiti-secret-vault:check:v1";
export const ALIAS_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export type VaultScope = "global" | "project";

export class VaultError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "VaultError";
  }
}

export interface VaultEntryRecord {
  desc?: string;
  tags?: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastUsedSession?: string;
  enc: Envelope;
}

export interface VaultFile {
  version: 1;
  kdf: null;
  check: Envelope;
  entries: Record<string, VaultEntryRecord>;
}

export interface VaultEntryInfo {
  alias: string;
  scope: VaultScope;
  desc?: string;
  tags?: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastUsedSession?: string;
}

export type VaultKeyMode = "keyfile" | "keychain";

export interface VaultStoreOptions {
  /** Vault directory (default `~/.pi/agent/secret-vault`). */
  dir?: string;
  /** Project key for the project bucket (default `process.cwd()`). */
  cwd?: string;
  /** Override the keyfile path (tests). */
  keyPath?: string;
  /** Override the unlock-mode config path (tests). */
  modePath?: string;
  /** Injected OS keychain adapter (tests); defaults to the platform backend. */
  keychain?: KeychainLike;
}

export interface AddOptions {
  desc?: string;
  tags?: string[];
  /** Store in the project bucket instead of the global one. */
  project?: boolean;
}

export interface AddResult {
  alias: string;
  scope: VaultScope;
  version: number;
  created: boolean;
  /** True when a global add is hidden by a same-alias project entry. */
  shadowed?: boolean;
  /** Weak-password assessment for the stored value (no value is returned). */
  weak: boolean;
  weakReasons: PasswordStrength["reasons"];
}

/** Read a vault JSON file; throws on malformed content (fail-closed). */
function readVaultFile(path: string): VaultFile | undefined {
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
  if (!raw || raw.version !== 1 || typeof raw.entries !== "object" || !raw.check) {
    throw new VaultError("malformed", `vault: ${path} is not a v1 vault file`);
  }
  return raw;
}

export class VaultStore {
  readonly dir: string;
  cwd: string;
  readonly keyPath: string;
  readonly modePath: string;
  readonly keychain: KeychainLike;
  private key?: Buffer;

  constructor(opts: VaultStoreOptions = {}) {
    this.dir = opts.dir ?? DEFAULT_VAULT_DIR;
    this.cwd = opts.cwd ?? process.cwd();
    this.keyPath = opts.keyPath ?? join(this.dir, MASTER_KEY_FILE);
    this.modePath = opts.modePath ?? join(this.dir, MODE_FILE);
    this.keychain = opts.keychain ?? createKeychain();
  }

  /** Current unlock mode (persisted in config.json; default keyfile). */
  get mode(): VaultKeyMode {
    try {
      const doc = JSON.parse(readFileSync(this.modePath, "utf8")) as { mode?: string };
      return doc?.mode === "keychain" ? "keychain" : "keyfile";
    } catch {
      return "keyfile";
    }
  }

  private setMode(mode: VaultKeyMode): void {
    writeFileAtomic(this.modePath, JSON.stringify({ version: 1, mode }, null, 2) + "\n");
  }

  /** Read the master key from the active backend (base64 in the OS keychain). */
  private readStoredKey(): Buffer | undefined {
    if (this.mode === "keychain") {
      const b64 = this.keychain.get();
      if (!b64) return undefined;
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32) throw new VaultError("bad-key", "vault: the OS keychain entry has an invalid key length");
      return key;
    }
    return readKeyFile(this.keyPath);
  }

  /** Session cwd changed (pi session_start may enter another project). */
  updateCwd(cwd: string): void {
    this.cwd = cwd;
  }

  get globalPath(): string {
    return join(this.dir, GLOBAL_FILE);
  }

  get projectPath(): string {
    return join(this.dir, `vault.${fnv1a(this.cwd)}.json`);
  }

  scopePath(scope: VaultScope): string {
    return scope === "global" ? this.globalPath : this.projectPath;
  }

  /** True when a keyfile exists (unlock possible without creating one). */
  get initialized(): boolean {
    return existsSync(this.keyPath);
  }

  get locked(): boolean {
    return this.key === undefined;
  }

  /**
   * Load the key (or create it when `create` is set). Fail-closed: an
   * existing keyfile that cannot decrypt a vault check envelope is an error.
   */
  keyFor(create: boolean): Buffer {
    if (this.key) return this.key;
    let key = this.readStoredKey();
    let created = false;
    if (!key) {
      if (!create) {
        throw new VaultError(
          "locked",
          `vault is not initialized: run /vault add <alias> (creates the vault and its ${this.mode} key) or restore a backup of ~/.pi/agent/secret-vault`,
        );
      }
      // A vault file without its key is unrecoverable. Never silently generate
      // a new key (that would make existing entries undecryptable while
      // looking healthy).
      if (existsSync(this.projectPath) || existsSync(this.globalPath)) {
        throw new VaultError(
          "missing-key",
          `vault: the ${this.mode} master key is missing but vault data exists — restore it (or delete the vault files to start over)`,
        );
      }
      if (this.mode === "keychain") {
        if (!this.keychain.available()) {
          throw new VaultError("no-keychain", "vault: keychain mode is configured but no OS keychain backend is available on this machine — run /vault mode keyfile");
        }
        key = generateKey();
        this.keychain.set(key.toString("base64"));
      } else {
        key = createKeyFile(this.keyPath);
      }
      created = true;
    }
    if (!created) this.verifyKey(key);
    this.key = key;
    return key;
  }

  /**
   * Switch unlock mode, re-encrypting every vault file with a fresh key.
   * All files are decrypted and re-encrypted in memory first, then written;
   * the new key is stored last (keyfile promotion / keychain write).
   */
  rekeyTo(mode: VaultKeyMode): { ok: true; files: number } {
    const files = [this.projectPath, this.globalPath].filter((p) => existsSync(p));
    if (mode === "keychain" && !this.keychain.available()) {
      throw new VaultError("no-keychain", "vault: no OS keychain backend is available on this machine (macOS security / Linux secret-tool / Windows DPAPI)");
    }
    if (files.length === 0) {
      this.setMode(mode);
      this.key = undefined;
      return { ok: true, files: 0 };
    }
    const previousMode = this.mode;
    const oldKey = this.keyFor(false);
    const newKey = generateKey();
    const planned = files.map((path) => {
      const file = readVaultFile(path)!;
      const entries: Record<string, VaultEntryRecord> = {};
      for (const [alias, rec] of Object.entries(file.entries)) {
        entries[alias] = { ...rec, enc: encryptValue(newKey, decryptValue(oldKey, rec.enc)) };
      }
      const next: VaultFile = { version: 1, kdf: null, check: encryptValue(newKey, CHECK_PLAINTEXT), entries };
      return { path, next };
    });
    // store the new key before rewriting, so a crash mid-way leaves a key that
    // can decrypt the already-converted files
    const pendingKeyfile = `${this.keyPath}.new`;
    if (mode === "keychain") {
      this.keychain.set(newKey.toString("base64"));
    } else {
      writeFileAtomic(pendingKeyfile, newKey, 0o600);
    }
    for (const { path, next } of planned) {
      writeFileAtomic(path, JSON.stringify(next, null, 2) + "\n");
    }
    if (mode === "keyfile") {
      // promote the pre-written key file atomically
      renameSync(pendingKeyfile, this.keyPath);
      try {
        chmodSync(this.keyPath, 0o600);
      } catch {
        // best effort on Windows
      }
    } else {
      try {
        rmSync(this.keyPath, { force: true });
      } catch {}
    }
    if (mode === "keyfile" && previousMode === "keychain") {
      try {
        this.keychain.delete();
      } catch {}
    }
    if (previousMode !== mode) this.setMode(mode);
    this.key = newKey;
    return { ok: true, files: files.length };
  }

  /** Explicit unlock (commands/UI). Never creates the vault. */
  unlock(): { ok: boolean; error?: string } {
    try {
      this.keyFor(false);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  lock(): void {
    this.key = undefined;
  }

  private verifyKey(key: Buffer): void {
    for (const path of [this.projectPath, this.globalPath]) {
      const file = readVaultFile(path);
      if (!file) continue;
      try {
        const check = decryptValue(key, file.check);
        if (check !== CHECK_PLAINTEXT) throw new Error("check mismatch");
      } catch {
        throw new VaultError("bad-key", `vault: the keyfile ${this.keyPath} does not unlock ${path}`);
      }
      return;
    }
  }

  private load(scope: VaultScope): VaultFile | undefined {
    return readVaultFile(this.scopePath(scope));
  }

  private save(file: VaultFile, scope: VaultScope): void {
    writeFileAtomic(this.scopePath(scope), JSON.stringify(file, null, 2) + "\n");
  }

  private emptyFile(key: Buffer): VaultFile {
    return { version: 1, kdf: null, check: encryptValue(key, CHECK_PLAINTEXT), entries: {} };
  }

  /** All aliases, project entries shadowing global ones. */
  list(opts: { scope?: VaultScope } = {}): VaultEntryInfo[] {
    const out = new Map<string, VaultEntryInfo>();
    const scopes: VaultScope[] = opts.scope ? [opts.scope] : ["global", "project"];
    for (const scope of scopes) {
      const file = this.load(scope);
      if (!file) continue;
      for (const [alias, rec] of Object.entries(file.entries)) {
        out.set(alias, {
          alias,
          scope,
          desc: rec.desc,
          tags: rec.tags,
          version: rec.version,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          lastUsedAt: rec.lastUsedAt,
          lastUsedSession: rec.lastUsedSession,
        });
      }
    }
    return [...out.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  find(alias: string): VaultEntryInfo | undefined {
    return this.list().find((e) => e.alias === alias);
  }

  /** Decrypt one alias (project bucket first). Throws VaultError when absent/locked. */
  get(alias: string, opts: { touch?: boolean; sessionId?: string } = {}): { alias: string; scope: VaultScope; value: string; info: VaultEntryInfo } {
    for (const scope of ["project", "global"] as const) {
      const file = this.load(scope);
      const rec = file?.entries?.[alias];
      if (!file || !rec) continue;
      const key = this.keyFor(false);
      let value: string;
      try {
        value = decryptValue(key, rec.enc);
      } catch {
        throw new VaultError("bad-key", `vault: could not decrypt "${alias}" (key mismatch or corrupted entry)`);
      }
      if (opts.touch) {
        rec.lastUsedAt = new Date().toISOString();
        if (opts.sessionId) rec.lastUsedSession = opts.sessionId;
        this.save(file, scope);
      }
      return {
        alias,
        scope,
        value,
        info: {
          alias,
          scope,
          desc: rec.desc,
          tags: rec.tags,
          version: rec.version,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          lastUsedAt: rec.lastUsedAt,
          lastUsedSession: rec.lastUsedSession,
        },
      };
    }
    if (!this.initialized) {
      throw new VaultError(
        "not-initialized",
        "vault is not initialized: ask the user to run /vault add <alias> (creates the vault and its keyfile)",
      );
    }
    throw new VaultError("not-found", `vault: no entry named "${alias}" (/vault list for aliases)`);
  }

  /**
   * Add or rotate an alias. First write auto-creates the vault + keyfile.
   * Rotation keeps createdAt and increments `version` (attributable history).
   */
  add(alias: string, value: string, opts: AddOptions = {}): AddResult {
    if (!ALIAS_RE.test(alias)) throw new VaultError("bad-alias", "vault: alias must be 1-64 chars of [A-Za-z0-9_.-]");
    const trimmed = value.trim();
    if (trimmed.length < MIN_REDACT_LENGTH) {
      throw new VaultError("too-short", `vault: value must be at least ${MIN_REDACT_LENGTH} characters (shorter values cannot be masked safely)`);
    }
    const strength = assessPasswordStrength(trimmed);
    const key = this.keyFor(true);
    const scope: VaultScope = opts.project ? "project" : "global";
    const file = this.load(scope) ?? this.emptyFile(key);
    const now = new Date().toISOString();
    const previous = file.entries[alias];
    file.entries[alias] = {
      desc: opts.desc ?? previous?.desc,
      tags: opts.tags ?? previous?.tags,
      version: previous ? previous.version + 1 : 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      enc: encryptValue(key, trimmed),
    };
    this.save(file, scope);
    const shadowed = scope === "global" && Boolean(this.load("project")?.entries?.[alias]);
    return { alias, scope, version: file.entries[alias]!.version, created: !previous, shadowed, weak: strength.weak, weakReasons: strength.reasons };
  }

  /** Remove an alias from both buckets. Returns how many records were deleted. */
  remove(alias: string): number {
    let removed = 0;
    for (const scope of ["project", "global"] as const) {
      const file = this.load(scope);
      if (!file?.entries?.[alias]) continue;
      delete file.entries[alias];
      this.save(file, scope);
      removed++;
    }
    return removed;
  }

  status(): {
    dir: string;
    mode: VaultKeyMode;
    keychainBackend: string;
    initialized: boolean;
    locked: boolean;
    keyfile: string;
    globalEntries: number;
    projectEntries: number;
    scopes: { global: string; project: string };
  } {
    const globalFile = this.load("global");
    const projectFile = this.load("project");
    return {
      dir: this.dir,
      mode: this.mode,
      keychainBackend: this.keychain.backend,
      initialized: this.initialized,
      locked: this.locked,
      keyfile: this.keyPath,
      globalEntries: globalFile ? Object.keys(globalFile.entries).length : 0,
      projectEntries: projectFile ? Object.keys(projectFile.entries).length : 0,
      scopes: { global: this.globalPath, project: this.projectPath },
    };
  }
}
