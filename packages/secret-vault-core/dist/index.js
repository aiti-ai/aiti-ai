// src/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var KEY_BYTES = 32;
var IV_BYTES = 12;
var TAG_BYTES = 16;
function generateKey() {
  return randomBytes(KEY_BYTES);
}
function encryptValue(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64")
  };
}
function decryptValue(key, env) {
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("vault: malformed envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]).toString("utf8");
}
function writeFileAtomic(path, data, mode = 384) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
  }
}
function readKeyFile(path) {
  try {
    const raw = readFileSync(path);
    if (raw.length !== KEY_BYTES) throw new Error(`vault: keyfile ${path} must be exactly ${KEY_BYTES} bytes`);
    return raw;
  } catch (e) {
    if (e.code === "ENOENT") return void 0;
    throw e;
  }
}
function createKeyFile(path) {
  const key = generateKey();
  writeFileAtomic(path, key, 384);
  return key;
}

// src/store.ts
import { homedir as homedir2 } from "node:os";
import { chmodSync as chmodSync3, existsSync as existsSync2, readFileSync as readFileSync3, renameSync as renameSync2, rmSync as rmSync2 } from "node:fs";
import { join as join2 } from "node:path";

// node_modules/@aiti-ai/secret-mask-core/dist/index.js
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
function entropy(v) {
  if (!v) return 0;
  const counts = /* @__PURE__ */ new Map();
  for (const ch of v) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / v.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
var B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
var B64_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_VALUE[B64URL.charCodeAt(i)] = i;
B64_VALUE[43] = 62;
B64_VALUE[47] = 63;
var MIN_REDACT_LENGTH = 6;
var EXTRACT_MAX_BYTES = 256 * 1024;
var WEAK_PASSWORDS = /* @__PURE__ */ new Set([
  "password",
  "passw0rd",
  "password1",
  "password12",
  "password123",
  "p@ssw0rd",
  "passw0rd1",
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "0123456789",
  "9876543210",
  "123456a",
  "a123456",
  "a12345678",
  "rsec_035c2182",
  "abc123",
  "abc12345",
  "abcd1234",
  "abc123!",
  "qwerty",
  "qwertyui",
  "qwertyuiop",
  "qwerty12",
  "qwerty123",
  "qwe123",
  "qweasd",
  "qweasdzxc",
  "asdfgh",
  "asdfghjkl",
  "asdf1234",
  "zxcvbnm",
  "zxcvbnm123",
  "poiuytrewq",
  "1qaz2wsx",
  "1qazxsw2",
  "1qaz2wsx3edc",
  "1qaz@wsx",
  "1q2w3e4r",
  "1q2w3e4r5t",
  "q1w2e3r4",
  "zaq12wsx",
  "qazwsx",
  "qazwsxedc",
  "abcdef",
  "abcdefg",
  "abcdefgh",
  "iloveyou",
  "iloveu",
  "loveme",
  "loveyou",
  "mylove",
  "forever",
  "admin",
  "admin123",
  "admin888",
  "administrator",
  "root",
  "root123",
  "toor",
  "guest",
  "guest123",
  "user",
  "user123",
  "user1234",
  "test",
  "test123",
  "test1234",
  "demo",
  "demo123",
  "temp123",
  "temp1234",
  "letmein",
  "letmein123",
  "welcome",
  "welcome1",
  "welcome123",
  "changeme",
  "secret",
  "secret123",
  "monkey",
  "monkey123",
  "dragon",
  "dragon123",
  "master",
  "sunshine",
  "sunshine1",
  "princess",
  "princess1",
  "football",
  "football1",
  "baseball",
  "baseball1",
  "shadow",
  "shadow1",
  "superman",
  "superman1",
  "michael",
  "michael1",
  "jennifer",
  "jennifer1",
  "trustno1",
  "whatever",
  "nothing",
  "trustme",
  "woaini",
  "woaini1314",
  "woaini520",
  "5201314",
  "5201314520",
  "1314520",
  "1314521",
  "7758521",
  "7758258",
  "888888",
  "88888888",
  "666666",
  "66666666",
  "111111",
  "11111111",
  "000000",
  "00000000",
  "999999",
  "555555",
  "777777",
  "123123",
  "112233",
  "11223344",
  "121212",
  "159753",
  "147258369",
  "123321",
  "654321",
  "987654321",
  "123654",
  "159357",
  "159951",
  "1234554321",
  "25252525",
  "mysql",
  "postgres",
  "postgresql",
  "oracle",
  "sybase",
  "sa123456",
  "system",
  "manager",
  "company",
  "computer",
  "internet",
  "service",
  "server",
  "backup",
  "default",
  "oracle123",
  "mysql123",
  "fuckyou",
  "fuckyou1",
  "fuckoff",
  "asshole",
  "bitch",
  "suckit",
  "biteme",
  "killer",
  "access",
  "flower",
  "hello",
  "hello123",
  "freedom",
  "whatever1",
  "starwars",
  "pokemon",
  "naruto",
  "batman",
  "matrix",
  "mustang",
  "mercedes",
  "ferrari",
  "corvette",
  "porsche",
  "yamaha",
  "hunter",
  "ranger",
  "buster",
  "soccer",
  "hockey",
  "tennis",
  "golfer",
  "cookie",
  "orange",
  "banana",
  "purple",
  "silver",
  "golden",
  "diamond",
  "pepper",
  "ginger",
  "summer",
  "winter",
  "spring",
  "autumn",
  "january",
  "february"
]);
function assessPasswordStrength(value) {
  const v = value.trim();
  const lower = v.toLowerCase();
  const reasons = [];
  if (WEAK_PASSWORDS.has(lower)) reasons.push("dictionary");
  if (v.length < 8) reasons.push("short");
  if (/^\d+$/.test(v) && v.length < 12) reasons.push("digits-only");
  if (/^[a-z]+$/.test(v) && v.length < 12) reasons.push("lowercase-only");
  if (v.length >= 8 && !WEAK_PASSWORDS.has(lower) && entropy(v) < 2.5) reasons.push("low-entropy");
  if (/^(.)\1+$/.test(v) || /(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf|zxcv|password|admin)/i.test(v)) reasons.push("sequence");
  return { weak: reasons.length > 0, reasons };
}
function describePasswordWeakness(strength) {
  const labels = {
    dictionary: "common weak password",
    short: "shorter than 8 characters",
    "digits-only": "digits only",
    "lowercase-only": "lowercase letters only",
    "low-entropy": "low entropy",
    sequence: "sequential pattern"
  };
  return strength.reasons.map((r) => labels[r]).join(", ");
}

// src/keychain.ts
import { spawn, spawnSync } from "node:child_process";
import { chmodSync as chmodSync2, existsSync, mkdirSync as mkdirSync2, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname as dirname2, join } from "node:path";
var KEYCHAIN_SERVICE = "aiti-secret-vault";
var KEYCHAIN_ACCOUNT = "master-key";
var DEFAULT_TIMEOUT_MS = 1e4;
function findInPath(name) {
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
function detectKeychainBackend() {
  if (process.platform === "darwin") return "macos-security";
  if (process.platform === "win32") return findInPath("powershell") || findInPath("pwsh") ? "windows-dpapi" : "unavailable";
  if (process.platform === "linux" && findInPath("secret-tool")) return "linux-secret-tool";
  return "unavailable";
}
function windowsKeyFile(opts) {
  if (opts.file) return opts.file;
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), ".aiti");
  return join(base, "aiti-secret-vault", "master.key.dpapi");
}
function windowsPowerShell() {
  return findInPath("pwsh") ? "pwsh" : "powershell";
}
function runSync(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    encoding: "utf8",
    input: opts.input,
    env: opts.env ?? process.env,
    windowsHide: true
  });
  const notFound = res.status === 44 || // macOS security: item not found
  res.status === 1 && /not found|no such|not set/i.test(String(res.stderr ?? "")) || res.status === 2 && /not found|no such/i.test(String(res.stderr ?? ""));
  return { ok: res.status === 0 && !res.error, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? res.error ?? ""), notFound };
}
var DARWIN_READ = ["find-generic-password", "-s"];
var DARWIN_ADD = ["add-generic-password", "-U", "-s"];
var DARWIN_DELETE = ["delete-generic-password", "-s"];
function createKeychain(opts = {}) {
  const backend = opts.backend ?? detectKeychainBackend();
  const service = opts.service ?? KEYCHAIN_SERVICE;
  const account = opts.account ?? KEYCHAIN_ACCOUNT;
  const available = () => backend !== "unavailable";
  return {
    backend,
    available,
    get() {
      if (backend === "macos-security") {
        const r = runSync("security", [...DARWIN_READ, service, "-a", account, "-w"], opts);
        if (!r.ok) return void 0;
        return r.stdout.trim() || void 0;
      }
      if (backend === "linux-secret-tool") {
        const r = runSync("secret-tool", ["lookup", "service", service, "account", account], opts);
        return r.ok && r.stdout.trim() ? r.stdout.trim() : void 0;
      }
      if (backend === "windows-dpapi") {
        const file = windowsKeyFile(opts);
        if (!existsSync(file)) return void 0;
        const script = "$ErrorActionPreference='Stop';$sec = Get-Content -Raw -LiteralPath $env:AITI_VAULT_KEY_FILE | ConvertTo-SecureString;$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec);[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)";
        const r = runSync(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command", script], {
          ...opts,
          env: { ...process.env, AITI_VAULT_KEY_FILE: file }
        });
        return r.ok && r.stdout.trim() ? r.stdout.trim() : void 0;
      }
      return void 0;
    },
    set(value) {
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
        mkdirSync2(dirname2(file), { recursive: true });
        const script = "$ErrorActionPreference='Stop';$sec = ConvertTo-SecureString $env:AITI_VAULT_KEY -AsPlainText -Force;ConvertFrom-SecureString $sec | Set-Content -NoNewline -LiteralPath $env:AITI_VAULT_KEY_FILE";
        const r = runSync(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command", script], {
          ...opts,
          env: { ...process.env, AITI_VAULT_KEY: value, AITI_VAULT_KEY_FILE: file }
        });
        if (!r.ok) throw new Error(`keychain: DPAPI write failed: ${r.stderr.trim() || "unknown error"}`);
        try {
          chmodSync2(file, 384);
        } catch {
        }
        return;
      }
      throw new Error("keychain: no OS keychain backend available on this platform");
    },
    delete() {
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
    }
  };
}

// src/store.ts
var DEFAULT_VAULT_DIR = join2(homedir2(), ".pi", "agent", "secret-vault");
var MASTER_KEY_FILE = "master.key";
var MODE_FILE = "config.json";
var GLOBAL_FILE = "global.json";
var CHECK_PLAINTEXT = "aiti-secret-vault:check:v1";
var ALIAS_RE = /^[A-Za-z0-9_.-]{1,64}$/;
var VaultError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "VaultError";
  }
};
function readVaultFile(path) {
  if (!existsSync2(path)) return void 0;
  const raw = JSON.parse(readFileSync3(path, "utf8"));
  if (!raw || raw.version !== 1 || typeof raw.entries !== "object" || !raw.check) {
    throw new VaultError("malformed", `vault: ${path} is not a v1 vault file`);
  }
  return raw;
}
var VaultStore = class {
  constructor(opts = {}) {
    this.dir = opts.dir ?? DEFAULT_VAULT_DIR;
    this.cwd = opts.cwd ?? process.cwd();
    this.keyPath = opts.keyPath ?? join2(this.dir, MASTER_KEY_FILE);
    this.modePath = opts.modePath ?? join2(this.dir, MODE_FILE);
    this.keychain = opts.keychain ?? createKeychain();
  }
  /** Current unlock mode (persisted in config.json; default keyfile). */
  get mode() {
    try {
      const doc = JSON.parse(readFileSync3(this.modePath, "utf8"));
      return doc?.mode === "keychain" ? "keychain" : "keyfile";
    } catch {
      return "keyfile";
    }
  }
  setMode(mode) {
    writeFileAtomic(this.modePath, JSON.stringify({ version: 1, mode }, null, 2) + "\n");
  }
  /** Read the master key from the active backend (base64 in the OS keychain). */
  readStoredKey() {
    if (this.mode === "keychain") {
      const b64 = this.keychain.get();
      if (!b64) return void 0;
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32) throw new VaultError("bad-key", "vault: the OS keychain entry has an invalid key length");
      return key;
    }
    return readKeyFile(this.keyPath);
  }
  /** Session cwd changed (pi session_start may enter another project). */
  updateCwd(cwd) {
    this.cwd = cwd;
  }
  get globalPath() {
    return join2(this.dir, GLOBAL_FILE);
  }
  get projectPath() {
    return join2(this.dir, `vault.${fnv1a(this.cwd)}.json`);
  }
  scopePath(scope) {
    return scope === "global" ? this.globalPath : this.projectPath;
  }
  /** True when a keyfile exists (unlock possible without creating one). */
  get initialized() {
    return existsSync2(this.keyPath);
  }
  get locked() {
    return this.key === void 0;
  }
  /**
   * Load the key (or create it when `create` is set). Fail-closed: an
   * existing keyfile that cannot decrypt a vault check envelope is an error.
   */
  keyFor(create) {
    if (this.key) return this.key;
    let key = this.readStoredKey();
    let created = false;
    if (!key) {
      if (!create) {
        throw new VaultError(
          "locked",
          `vault is not initialized: run /vault add <alias> (creates the vault and its ${this.mode} key) or restore a backup of ~/.pi/agent/secret-vault`
        );
      }
      if (existsSync2(this.projectPath) || existsSync2(this.globalPath)) {
        throw new VaultError(
          "missing-key",
          `vault: the ${this.mode} master key is missing but vault data exists \u2014 restore it (or delete the vault files to start over)`
        );
      }
      if (this.mode === "keychain") {
        if (!this.keychain.available()) {
          throw new VaultError("no-keychain", "vault: keychain mode is configured but no OS keychain backend is available on this machine \u2014 run /vault mode keyfile");
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
  rekeyTo(mode) {
    const files = [this.projectPath, this.globalPath].filter((p) => existsSync2(p));
    if (mode === "keychain" && !this.keychain.available()) {
      throw new VaultError("no-keychain", "vault: no OS keychain backend is available on this machine (macOS security / Linux secret-tool / Windows DPAPI)");
    }
    if (files.length === 0) {
      this.setMode(mode);
      this.key = void 0;
      return { ok: true, files: 0 };
    }
    const previousMode = this.mode;
    const oldKey = this.keyFor(false);
    const newKey = generateKey();
    const planned = files.map((path) => {
      const file = readVaultFile(path);
      const entries = {};
      for (const [alias, rec] of Object.entries(file.entries)) {
        entries[alias] = { ...rec, enc: encryptValue(newKey, decryptValue(oldKey, rec.enc)) };
      }
      const next = { version: 1, kdf: null, check: encryptValue(newKey, CHECK_PLAINTEXT), entries };
      return { path, next };
    });
    const pendingKeyfile = `${this.keyPath}.new`;
    if (mode === "keychain") {
      this.keychain.set(newKey.toString("base64"));
    } else {
      writeFileAtomic(pendingKeyfile, newKey, 384);
    }
    for (const { path, next } of planned) {
      writeFileAtomic(path, JSON.stringify(next, null, 2) + "\n");
    }
    if (mode === "keyfile") {
      renameSync2(pendingKeyfile, this.keyPath);
      try {
        chmodSync3(this.keyPath, 384);
      } catch {
      }
    } else {
      try {
        rmSync2(this.keyPath, { force: true });
      } catch {
      }
    }
    if (mode === "keyfile" && previousMode === "keychain") {
      try {
        this.keychain.delete();
      } catch {
      }
    }
    if (previousMode !== mode) this.setMode(mode);
    this.key = newKey;
    return { ok: true, files: files.length };
  }
  /** Explicit unlock (commands/UI). Never creates the vault. */
  unlock() {
    try {
      this.keyFor(false);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  lock() {
    this.key = void 0;
  }
  verifyKey(key) {
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
  load(scope) {
    return readVaultFile(this.scopePath(scope));
  }
  save(file, scope) {
    writeFileAtomic(this.scopePath(scope), JSON.stringify(file, null, 2) + "\n");
  }
  emptyFile(key) {
    return { version: 1, kdf: null, check: encryptValue(key, CHECK_PLAINTEXT), entries: {} };
  }
  /** All aliases, project entries shadowing global ones. */
  list(opts = {}) {
    const out = /* @__PURE__ */ new Map();
    const scopes = opts.scope ? [opts.scope] : ["global", "project"];
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
          lastUsedSession: rec.lastUsedSession
        });
      }
    }
    return [...out.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }
  find(alias) {
    return this.list().find((e) => e.alias === alias);
  }
  /** Decrypt one alias (project bucket first). Throws VaultError when absent/locked. */
  get(alias, opts = {}) {
    for (const scope of ["project", "global"]) {
      const file = this.load(scope);
      const rec = file?.entries?.[alias];
      if (!file || !rec) continue;
      const key = this.keyFor(false);
      let value;
      try {
        value = decryptValue(key, rec.enc);
      } catch {
        throw new VaultError("bad-key", `vault: could not decrypt "${alias}" (key mismatch or corrupted entry)`);
      }
      if (opts.touch) {
        rec.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
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
          lastUsedSession: rec.lastUsedSession
        }
      };
    }
    if (!this.initialized) {
      throw new VaultError(
        "not-initialized",
        "vault is not initialized: ask the user to run /vault add <alias> (creates the vault and its keyfile)"
      );
    }
    throw new VaultError("not-found", `vault: no entry named "${alias}" (/vault list for aliases)`);
  }
  /**
   * Add or rotate an alias. First write auto-creates the vault + keyfile.
   * Rotation keeps createdAt and increments `version` (attributable history).
   */
  add(alias, value, opts = {}) {
    if (!ALIAS_RE.test(alias)) throw new VaultError("bad-alias", "vault: alias must be 1-64 chars of [A-Za-z0-9_.-]");
    const trimmed = value.trim();
    if (trimmed.length < MIN_REDACT_LENGTH) {
      throw new VaultError("too-short", `vault: value must be at least ${MIN_REDACT_LENGTH} characters (shorter values cannot be masked safely)`);
    }
    const strength = assessPasswordStrength(trimmed);
    const key = this.keyFor(true);
    const scope = opts.project ? "project" : "global";
    const file = this.load(scope) ?? this.emptyFile(key);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const previous = file.entries[alias];
    file.entries[alias] = {
      desc: opts.desc ?? previous?.desc,
      tags: opts.tags ?? previous?.tags,
      version: previous ? previous.version + 1 : 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      enc: encryptValue(key, trimmed)
    };
    this.save(file, scope);
    const shadowed = scope === "global" && Boolean(this.load("project")?.entries?.[alias]);
    return { alias, scope, version: file.entries[alias].version, created: !previous, shadowed, weak: strength.weak, weakReasons: strength.reasons };
  }
  /** Remove an alias from both buckets. Returns how many records were deleted. */
  remove(alias) {
    let removed = 0;
    for (const scope of ["project", "global"]) {
      const file = this.load(scope);
      if (!file?.entries?.[alias]) continue;
      delete file.entries[alias];
      this.save(file, scope);
      removed++;
    }
    return removed;
  }
  status() {
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
      scopes: { global: this.globalPath, project: this.projectPath }
    };
  }
};

// src/entries.ts
import { spawn as spawn2 } from "node:child_process";
import { readFileSync as readFileSync4 } from "node:fs";
var CAPTURE_DEFAULT_TIMEOUT_MS = 1e4;
var CAPTURE_DEFAULT_MAX_BYTES = 4096;
var CAPTURE_DEFAULT_MAX_VALUE = 4096;
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      spawn2("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } catch {
      try {
        child.kill();
      } catch {
      }
    }
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
  }
}
function captureStdout(command, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? CAPTURE_DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? CAPTURE_DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn2(command, { shell: true, cwd: opts.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (error) => {
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
    child.stdout?.on("data", (buf) => {
      out += buf.toString("utf8");
      if (Buffer.byteLength(out) > maxBytes) {
        killTree(child);
        finish(new VaultError("too-large", `vault: captured output exceeds ${maxBytes} bytes (refusing to store)`));
      }
    });
    child.stderr?.on("data", (buf) => {
      err = (err + buf.toString("utf8")).slice(-2e3);
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
async function captureIntoVault(store, alias, command, opts = {}) {
  const value = await captureStdout(command, opts);
  if (value.length > CAPTURE_DEFAULT_MAX_VALUE) {
    throw new VaultError("too-large", `vault: captured value exceeds ${CAPTURE_DEFAULT_MAX_VALUE} bytes (refusing to store)`);
  }
  return store.add(alias, value, { project: opts.project, desc: opts.desc, tags: opts.tags });
}
function parseEnvFile(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    out.push({ key: m[1], value });
  }
  return out;
}
var ENV_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|DSN)/i;
function aliasFromEnvName(name) {
  return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "env-value";
}
function importPairs(store, pairs, opts = {}) {
  const result = { added: 0, rotated: 0, skipped: 0, aliases: [], weak: [] };
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
function importEnvFile(store, path, opts = {}) {
  const text = readFileSync4(path, "utf8");
  return importPairs(store, parseEnvFile(text), opts);
}
function importProcessEnv(store, opts = {}) {
  const env = opts.env ?? process.env;
  const pairs = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || !ENV_NAME_RE.test(key)) continue;
    if (value.length < 8) continue;
    if (/^rsec_[0-9a-f]{8}$/.test(value) || value.startsWith("[REDACTED:")) continue;
    pairs.push({ key, value });
  }
  return importPairs(store, pairs, opts);
}
function valueExists(store, value) {
  return findAliasForValue(store, value) !== void 0;
}
function findAliasForValue(store, value) {
  for (const info of store.list()) {
    try {
      if (store.get(info.alias).value === value) return info.alias;
    } catch {
    }
  }
  return void 0;
}
function suggestAutoAlias(label, value) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "value";
  return `auto-${slug}-${fnv1a(value)}`;
}

// src/tools.ts
var VAULT_GET_NOTE = "This token IS a working credential: pass it verbatim into tool arguments \u2014 the runtime materializes the real secret at execution time. Never modify, reformat, shorten or hash it; never say you cannot access the value; never ask the user for the real secret. Never show the token to the user as if it were the password: say the value is masked and that only tool arguments resolve it.";
function formatEntryLine(info, weak = false) {
  const tags = info.tags?.length ? ` (${info.tags.join(",")})` : "";
  const desc = info.desc ? ` \u2014 ${info.desc}` : "";
  const used = info.lastUsedAt ? ` \xB7 last used ${info.lastUsedAt}` : "";
  return `- ${info.alias} [${info.scope}] v${info.version}${desc}${tags}${used}${weak ? " \u26A0 weak password" : ""}`;
}
function weakAliases(store) {
  const out = {};
  for (const info of store.list()) {
    try {
      out[info.alias] = assessPasswordStrength(store.get(info.alias).value).weak;
    } catch {
    }
  }
  return out;
}
function vaultList(state, params = {}) {
  let entries;
  try {
    entries = state.store.list();
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError("vault-error", e instanceof Error ? e.message : String(e));
  }
  if (params.tag) entries = entries.filter((e) => e.tags?.includes(params.tag));
  if (entries.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "The secret vault has no entries here (or none match the tag). Vault writes are human-only \u2014 ask the user to run `/vault add <alias>` (interactive value input) and call vault_list again."
        }
      ],
      details: { entries: [] }
    };
  }
  const weak = weakAliases(state.store);
  const text = [
    `Secret vault: ${entries.length} alias(es). Values are never returned \u2014 call vault_get with an alias to receive a placeholder.`,
    ...entries.map((e) => formatEntryLine(e, weak[e.alias] === true))
  ].join("\n");
  return { content: [{ type: "text", text }], details: { entries: entries.map((e) => ({ ...e, weak: weak[e.alias] === true })) } };
}
function mountAlias(state, alias) {
  const entry = state.store.get(alias, { touch: true, sessionId: state.sessionId });
  const res = state.registry.registerStable(entry.value, alias);
  if (!res) throw new VaultError("mount-failed", `vault: could not mount "${alias}" (placeholder collision \u2014 /vault status)`);
  return {
    alias,
    placeholder: res.entry.placeholder,
    desc: entry.info.desc,
    scope: entry.scope,
    version: entry.info.version,
    weak: assessPasswordStrength(entry.value).weak
  };
}
function vaultGet(state, params) {
  const alias = params.alias?.trim();
  if (!alias) throw new VaultError("bad-args", "vault_get requires { alias } \u2014 call vault_list to see aliases");
  const mounted = mountAlias(state, alias);
  return {
    content: [
      {
        type: "text",
        text: [
          mounted.placeholder,
          "",
          VAULT_GET_NOTE,
          `(alias: ${mounted.alias}${mounted.desc ? ` \u2014 ${mounted.desc}` : ""}, v${mounted.version})`,
          ...mounted.weak ? ["Note: this credential is a weak password \u2014 advise the user to rotate it."] : []
        ].join("\n")
      }
    ],
    details: { placeholder: mounted.placeholder, alias: mounted.alias, desc: mounted.desc, version: mounted.version, scope: mounted.scope, weak: mounted.weak }
  };
}

// src/landing.ts
function landValueInVault(state, value, label) {
  try {
    let alias = findAliasForValue(state.store, value);
    let created = false;
    if (!alias) {
      alias = suggestAutoAlias(label, value);
      state.store.add(alias, value, { desc: `auto-captured from prompt (${label})`, tags: ["auto"] });
      created = true;
    }
    const res = state.registry.registerStable(value, alias);
    if (!res) return void 0;
    return { alias, placeholder: res.entry.placeholder, created };
  } catch {
    return void 0;
  }
}

// src/commands.ts
import { existsSync as existsSync3 } from "node:fs";
function parseAddArgs(tail) {
  const tokens = tail.split(/\s+/).filter(Boolean);
  const out = { project: false };
  if (tokens.length === 0) return out;
  out.alias = tokens.shift();
  const desc = [];
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "--project") {
      out.project = true;
      continue;
    }
    if (token === "--tags") {
      const value = tokens.shift();
      if (value) out.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
      continue;
    }
    desc.push(token);
  }
  if (desc.length) out.desc = desc.join(" ");
  return out;
}
function flag(tokens, name) {
  const at = tokens.indexOf(name);
  if (at < 0) return false;
  tokens.splice(at, 1);
  return true;
}
function importSummary(label, res) {
  const weak = res.weak.length ? ` \u26A0 weak password: ${res.weak.join(", ")}` : "";
  return `${label}: ${res.added} added, ${res.rotated} rotated, ${res.skipped} skipped.${weak}`;
}
async function handleVaultCommand(state, rawArgs, io = {}) {
  const args = rawArgs.trim();
  const [cmd, ...rest] = args.length ? args.split(/\s+/) : [""];
  const tail = args.slice(cmd.length).trim();
  const tokens = rest.slice();
  switch (cmd) {
    case "":
    case "help":
      return { ok: true, text: helpText() };
    case "add":
    case "set": {
      const parsed = parseAddArgs(tail);
      if (!parsed.alias) return { ok: false, text: `Usage: /vault ${cmd} <alias> [description] [--project] [--tags a,b]` };
      if (cmd === "set" && !state.store.find(parsed.alias)) {
        return { ok: false, text: `vault: no entry named "${parsed.alias}" \u2014 use /vault add to create it.` };
      }
      if (!io.input) return { ok: false, text: "vault: this host has no masked input surface." };
      const value = await io.input(`Value for "${parsed.alias}" (input is kept out of the chat)`);
      if (!value || !value.trim()) return { ok: false, text: "vault: cancelled." };
      try {
        const res = state.store.add(parsed.alias, value, { desc: parsed.desc, tags: parsed.tags, project: parsed.project });
        return { ok: true, text: describeAdd(res) };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "capture": {
      const sep = tail.indexOf(" -- ");
      if (sep < 0) return { ok: false, text: "Usage: /vault capture <alias> [--project] -- <command>" };
      const head = tail.slice(0, sep).trim();
      const command = tail.slice(sep + 4).trim();
      const headTokens = head.split(/\s+/).filter(Boolean);
      const alias = headTokens.shift();
      const project = flag(headTokens, "--project");
      if (!alias || !command) return { ok: false, text: "Usage: /vault capture <alias> [--project] -- <command>" };
      try {
        const cwd = existsSync3(state.cwd) ? state.cwd : process.cwd();
        const res = await captureIntoVault(state.store, alias, command, { project, cwd });
        return { ok: true, text: describeAdd(res) + " (value captured from command output; never echoed)" };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "import": {
      const rest2 = tail.split(/\s+/).filter(Boolean);
      const project = flag(rest2, "--project");
      const path = rest2[0];
      if (!path) return { ok: false, text: "Usage: /vault import <file.env> [--project]" };
      try {
        return { ok: true, text: importSummary(`vault import ${path}`, importEnvFile(state.store, path, { project })) };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "import-env": {
      const project = flag(tokens, "--project");
      try {
        return { ok: true, text: importSummary("vault import-env", importProcessEnv(state.store, { project })) + " (secret-named variables only)" };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "list": {
      const scope = flag(tokens, "--project") ? "project" : flag(tokens, "--global") ? "global" : void 0;
      let entries;
      try {
        entries = state.store.list(scope ? { scope } : {});
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
      if (entries.length === 0) return { ok: true, text: "vault: no entries (add one with /vault add <alias>)." };
      const lines = entries.map((e) => {
        let weak = false;
        try {
          weak = assessPasswordStrength(state.store.get(e.alias).value).weak;
        } catch {
        }
        return formatEntryLine(e, weak);
      });
      return { ok: true, text: `vault: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}:
${lines.join("\n")}` };
    }
    case "remove": {
      const alias = tokens[0];
      if (!alias) return { ok: false, text: "Usage: /vault remove <alias>" };
      if (!state.store.find(alias)) return { ok: false, text: `vault: no entry named "${alias}".` };
      const confirmed = io.confirm ? await io.confirm(`Delete "${alias}" from the vault? This cannot be undone.`) : await io.input?.(`Type "${alias}" again to confirm deletion`) === alias;
      if (!confirmed) return { ok: false, text: "vault: cancelled." };
      const removed = state.store.remove(alias);
      state.registry.forgetByLabel(alias);
      return { ok: true, text: `vault: removed "${alias}" (${removed} record(s)); mounted placeholder invalidated.` };
    }
    case "reveal": {
      const alias = tokens[0];
      if (!alias) return { ok: false, text: "Usage: /vault reveal <alias>" };
      try {
        const entry = state.store.get(alias);
        if (!io.show && !io.copy) return { ok: false, text: "vault: this host has no dialog/clipboard surface; refusing to print the value into the transcript." };
        io.show?.(`vault: ${alias}`, entry.value);
        io.copy?.(entry.value);
        const strength = assessPasswordStrength(entry.value);
        const weakNote = strength.weak ? ` \u26A0 weak password (${describePasswordWeakness(strength)}); consider rotating it.` : "";
        return {
          ok: true,
          text: `vault: "${alias}" ${io.show ? "shown in a dialog" : ""}${io.show && io.copy ? " and " : ""}${io.copy ? "copied to the clipboard" : ""} \u2014 never printed into the session.${weakNote}`
        };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "get": {
      const alias = tokens[0];
      if (!alias) return { ok: false, text: "Usage: /vault get <alias> (mounts the alias; prints only its placeholder)" };
      try {
        const mounted = mountAlias(state, alias);
        const weakNote = mounted.weak ? " \u26A0 weak password \u2014 consider rotating it." : "";
        return { ok: true, text: `vault: mounted "${alias}" as ${mounted.placeholder} (v${mounted.version}, ${mounted.scope}).${weakNote}` };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "scope": {
      const st = state.store.status();
      return { ok: true, text: `vault scopes:
- global:  ${st.scopes.global}
- project: ${st.scopes.project}  (${state.cwd})` };
    }
    case "mode": {
      const requested = tokens[0];
      const current = state.store.status();
      if (!requested) {
        const backend = current.keychainBackend === "unavailable" ? "unavailable on this machine" : current.keychainBackend;
        return {
          ok: true,
          text: [
            `vault unlock mode: ${current.mode}`,
            `- keyfile: 32-byte key at ${state.store.keyPath}`,
            `- keychain: OS credential store (backend: ${backend})`,
            "switching modes regenerates the key and re-encrypts every vault file."
          ].join("\n")
        };
      }
      if (requested !== "keyfile" && requested !== "keychain") return { ok: false, text: "Usage: /vault mode [keyfile|keychain]" };
      if (requested === current.mode) return { ok: true, text: `vault: already in ${requested} mode.` };
      const confirmed = io.confirm ? await io.confirm(`Switch the vault to ${requested} mode? The master key is regenerated and every entry re-encrypted.`) : true;
      if (!confirmed) return { ok: false, text: "vault: cancelled." };
      try {
        const res = state.store.rekeyTo(requested);
        return { ok: true, text: `vault: unlock mode \u2192 ${requested} (${res.files} file(s) re-encrypted with a fresh key).` };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }
    case "lock": {
      state.store.lock();
      return { ok: true, text: "vault: locked (the next read/write needs the keyfile again)." };
    }
    case "unlock": {
      const res = state.store.unlock();
      return res.ok ? { ok: true, text: `vault: unlocked (keyfile ${state.store.keyPath}).` } : { ok: false, text: `vault: unlock failed: ${res.error}` };
    }
    case "forget": {
      const mounted = state.registry.entries().filter((e) => e.source === "vault");
      for (const entry of mounted) state.registry.forgetByLabel(entry.alias ?? entry.label);
      return { ok: true, text: `vault: unmounted ${mounted.length} alias(es); their placeholders are now invalid (guarded).` };
    }
    case "status": {
      const st = state.store.status();
      const mounted = state.registry.entries().filter((e) => e.source === "vault").length;
      return {
        ok: true,
        text: [
          `vault: ${st.initialized ? st.locked ? "locked" : "unlocked" : "not initialized"} (mode: ${st.mode}, keychain: ${st.keychainBackend})`,
          `keyfile: ${st.keyfile}`,
          `entries: ${st.globalEntries} global + ${st.projectEntries} project; mounted in this session: ${mounted}`,
          `dir: ${st.dir}`
        ].join("\n")
      };
    }
    default:
      return { ok: false, text: `vault: unknown subcommand "${cmd}". Try /vault help.` };
  }
}
function describeAdd(res) {
  const scope = res.scope === "project" ? "project" : "global";
  const shadow = res.shadowed ? " (warning: a same-alias project entry shadows this global value)" : "";
  const weak = res.weak ? ` \u26A0 weak password (${res.weakReasons.join(", ")}) \u2014 stored anyway; consider rotating to a stronger one.` : "";
  return `vault: ${res.created ? "added" : "rotated"} "${res.alias}" v${res.version} [${scope}]${shadow}${weak}`;
}
function errorText(e) {
  if (e instanceof VaultError) return e.message;
  return `vault: ${e instanceof Error ? e.message : String(e)}`;
}
function helpText() {
  return [
    "vault commands (values never appear in the transcript):",
    "  /vault add <alias> [desc] [--project] [--tags a,b]   masked input; existing alias = rotate (version+1)",
    "  /vault set <alias>                                  rotate an existing alias",
    "  /vault capture <alias> [--project] -- <command>     stdout into the vault (never echoed)",
    "  /vault import <file.env> [--project]                KEY=value / export KEY=value",
    "  /vault import-env [--project]                       scan this process env (secret-named vars)",
    "  /vault list [--global|--project]                    aliases + metadata (zero values)",
    "  /vault get <alias>                                  mount alias \u2192 placeholder (prints token only)",
    "  /vault reveal <alias>                               dialog + clipboard only, never the transcript",
    "  /vault remove <alias>                               delete (asks for confirmation)",
    "  /vault forget                                       unmount all aliases for this session",
    "  /vault scope | mode | lock | unlock | status"
  ].join("\n");
}

// src/session-state.ts
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "node:fs";
var SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var MAX_SESSION_RECORDS = 50;
var EMPTY_SESSION_STATE = { version: 1, sessions: {} };
function readSessionState(path) {
  if (!existsSync4(path)) return { version: 1, sessions: {} };
  try {
    const doc = JSON.parse(readFileSync5(path, "utf8"));
    if (!doc || doc.version !== 1 || typeof doc.sessions !== "object") return { version: 1, sessions: {} };
    return doc;
  } catch {
    return { version: 1, sessions: {} };
  }
}
function prune(file, now = Date.now()) {
  const entries = Object.entries(file.sessions).filter(([, rec]) => {
    if (rec.pid) return true;
    const at = Date.parse(rec.updatedAt);
    return Number.isFinite(at) ? now - at <= SESSION_RETENTION_MS : false;
  }).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, MAX_SESSION_RECORDS);
  return { version: 1, sessions: Object.fromEntries(entries) };
}
function writeSessionRecord(path, sessionId, record) {
  const file = readSessionState(path);
  file.sessions[sessionId || "unknown"] = { ...record, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeFileAtomic(path, JSON.stringify(prune(file), null, 2) + "\n");
}
export {
  ALIAS_RE,
  CAPTURE_DEFAULT_MAX_BYTES,
  CAPTURE_DEFAULT_MAX_VALUE,
  CAPTURE_DEFAULT_TIMEOUT_MS,
  CHECK_PLAINTEXT,
  DEFAULT_VAULT_DIR,
  EMPTY_SESSION_STATE,
  GLOBAL_FILE,
  KEY_BYTES,
  MASTER_KEY_FILE,
  MAX_SESSION_RECORDS,
  MODE_FILE,
  SESSION_RETENTION_MS,
  VAULT_GET_NOTE,
  VaultError,
  VaultStore,
  aliasFromEnvName,
  captureIntoVault,
  captureStdout,
  createKeyFile,
  decryptValue,
  encryptValue,
  findAliasForValue,
  formatEntryLine,
  generateKey,
  handleVaultCommand,
  importEnvFile,
  importPairs,
  importProcessEnv,
  landValueInVault,
  mountAlias,
  parseEnvFile,
  readKeyFile,
  readSessionState,
  suggestAutoAlias,
  valueExists,
  vaultGet,
  vaultList,
  weakAliases,
  writeFileAtomic,
  writeSessionRecord
};
