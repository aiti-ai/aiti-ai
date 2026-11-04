/**
 * agent-accounts —— 多 agent 登录账号档（别名备份 / 一键切换 / 自动保险）共享引擎
 * （纯模块，可测；权威源在本文件，调用方：aiti-agent-manager）。
 *
 * 设计（2026-09-13 拍板）：
 *   - **单文件存储**：所有 agent、所有账号档收在一个 JSON 文件里
 *     （默认 `<agent-manager configDir>/agent-accounts.json`，0600）——aiti-configs
 *     备份时一条 encrypt pattern（agent-accounts.json）即可全量加密，不散落多文件。
 *   - **slot**：每 agent 的登录凭据 = 一组「槽位」（key / label / 当前机器绝对路径），
 *     由调用方逐机器解析；快照只存 key + 内容，切回时按当前机器的路径写回（跨机备份可用）。
 *   - **自动保险档**：switch / login / logout 等覆盖性操作前，当前登录若未被任何档覆盖 →
 *     自动存 `_auto-before-<kind>`——永不因切换 / 重新登录丢账号，也无须用户先手动备份。
 *   - **current 判定**：内容签名（sha256）比对，不存额外状态，文件被外部改动也能感知。
 *   - **登出**：`clearSlots` 删除当前凭据文件（先经调用方自动保险）；feature/env 注入的
 *     凭据不在文件层，天然不受影响（调用方可提示）。
 *
 * 存储结构：
 *   { version: 1,
 *     accounts: { <agent>: { <alias>: {
 *       savedAt: number, auto?: boolean, note?: string,
 *       files: { <slotKey>: { data: string, b64?: boolean, label?: string } } } } } }
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const ACCOUNTS_STORE_VERSION = 1;
/** 单文件体积防御（正常几十 KB；超限说明误收大文件，拒绝写入并报错）。 */
export const MAX_STORE_BYTES = 4 * 1024 * 1024;
/** 自动保险档前缀（用户手动别名禁以此开头）。 */
export const AUTO_ALIAS_PREFIX = "_auto-";

/** 一个凭据槽位（key 稳定逻辑标识，写入快照/切回时与当前机器路径解耦）。 */
export interface AccountSlot {
  key: string;
  label: string;
  /** 当前机器绝对路径（不存在 = 该槽位暂无内容）。 */
  path: string;
}

interface StoredFile {
  data: string;
  /** true = data 为 base64（原文件非 UTF-8 文本）；缺省 = 纯文本 */
  b64?: boolean;
  label?: string;
}

export interface StoredAccount {
  savedAt: number;
  auto?: boolean;
  note?: string;
  /** 账号身份指纹（调用方构造，如 "李永|330116798388"）——token 自动刷新后仍能标记「当前」 */
  identity?: string;
  /** 账号展示元数据（user/uin/expiresAt；展示用，不含 token） */
  account?: AccountDisplay;
  files: Record<string, StoredFile>;
}

/** 账号展示元数据（各家 /login/status 提取；字段可缺）。 */
export interface AccountDisplay {
  user?: string;
  uin?: string;
  /** 凭据有效期（ms 时间戳；token 过期时间） */
  expiresAt?: number;
}

export interface AccountsStore {
  version: number;
  accounts: Record<string, Record<string, StoredAccount>>;
}

/** 列表项（面板展示用；不含文件内容）。 */
export interface AccountEntry {
  alias: string;
  savedAt: number;
  auto: boolean;
  note?: string;
  /** 账号展示元数据（user/uin/expiresAt；旧档缺省时由调用方按身份回填） */
  user?: string;
  uin?: string;
  expiresAt?: number;
  slotCount: number;
  /** 当前机器上已有内容的槽位数（档存了但本机没这个槽位时 < slotCount） */
  presentCount: number;
  current: boolean;
}

export function emptyStore(): AccountsStore {
  return { version: ACCOUNTS_STORE_VERSION, accounts: {} };
}

/** 读单文件存储（缺失/坏 JSON/版本不符 → 空 store，不抛）。 */
export function readAccountsStore(file: string): AccountsStore {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as AccountsStore;
    if (!j || typeof j !== "object" || !j.accounts || typeof j.accounts !== "object") return emptyStore();
    return { version: ACCOUNTS_STORE_VERSION, accounts: j.accounts };
  } catch {
    return emptyStore();
  }
}

/** 原子写单文件存储（临时文件 + rename；0600；体积防御）。 */
export function writeAccountsStore(file: string, store: AccountsStore): void {
  const body = JSON.stringify({ version: ACCOUNTS_STORE_VERSION, accounts: store.accounts }, null, 1);
  if (Buffer.byteLength(body) > MAX_STORE_BYTES) {
    throw new Error(`账号档文件超限（>${Math.round(MAX_STORE_BYTES / 1024 / 1024)}MB）——检查槽位是否误收大文件`);
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* 非 POSIX 容错 */ }
  renameSync(tmp, file);
}

/** 用户输入别名净化：1-32 字符，中文/字母/数字/._- 空格，首字符非符号，禁保留前缀与路径分隔。 */
export function sanitizeAlias(alias: unknown): string | null {
  const a = String(alias ?? "").trim();
  if (!a || a.length > 32) return null;
  if (a.startsWith(AUTO_ALIAS_PREFIX)) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(a)) return null;
  if (a.includes("..") || a.includes("/") || a.includes("\\")) return null;
  return a;
}

/** 自动保险档别名。 */
export function autoAlias(kind: "switch" | "login" | "logout"): string {
  return `${AUTO_ALIAS_PREFIX}before-${kind}`;
}

/** 槽位当前内容（文件不存在/空文件 → null；非 UTF-8 二进制 → base64）。 */
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

/** 槽位集合的内容签名（只含当前存在的内容；key 排序稳定）。 */
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

/** 当前槽位是否已有内容（有 = 可备份 / 需保险）。 */
export function hasAnySlotContent(slots: AccountSlot[]): boolean {
  return slots.some((s) => readSlotData(s) !== null);
}

/** 当前登录是否已被某个档覆盖（用于自动保险前的判断；identity 相同也算覆盖）。 */
export function isCurrentCovered(store: AccountsStore, agent: string, slots: AccountSlot[], identity?: string): boolean {
  const sig = currentSignature(slots);
  if (sig === currentSignature([])) return false; // 当前无内容
  return Object.values(store.accounts[agent] ?? {}).some((a) =>
    accountSignature(a) === sig || Boolean(identity && a.identity && a.identity === identity));
}

/**
 * 列出某 agent 的账号档（savedAt 倒序）。
 * current = 内容签名一致，**或** identity 相同（token 自动刷新导致内容轮换时仍认得同一账号）。
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
 * 备份当前登录为账号档（覆盖同名档）。
 * @throws 当前无任何槽位内容时（没有可备份的登录态）
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
    throw new Error("别名非法：1-32 字符，可用中文/字母/数字/./_/-/空格，且不得以 _auto- 开头");
  }
  const files: Record<string, StoredFile> = {};
  for (const s of slots) {
    const f = readSlotData(s);
    if (f) files[s.key] = f;
  }
  if (!Object.keys(files).length) throw new Error("当前无登录态可备份（未检测到任何凭据文件）");
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

/** 把账号档内容恢复到槽位路径（档里没有的槽位 → 删除当前文件，保证切换后状态干净）。 */
export function restoreAccount(store: AccountsStore, agent: string, alias: string, slots: AccountSlot[]): StoredAccount {
  const acct = store.accounts[agent]?.[alias];
  if (!acct) throw new Error(`账号档不存在：${agent} / ${alias}`);
  for (const s of slots) {
    const f = acct.files[s.key];
    if (f) {
      mkdirSync(dirname(s.path), { recursive: true, mode: 0o700 });
      writeFileSync(s.path, storedToBuffer(f), { mode: 0o600 });
      try { chmodSync(s.path, 0o600); } catch { /* 非 POSIX 容错 */ }
    } else {
      try { rmSync(s.path, { force: true }); } catch { /* 已不在 */ }
    }
  }
  return acct;
}

/**
 * 切换到账号档：当前登录未被任何档覆盖时先自动存 `_auto-before-switch`，再恢复目标档。
 * @returns autoSaved = 是否生成了自动保险档
 */
export function switchAccount(
  store: AccountsStore,
  agent: string,
  alias: string,
  slots: AccountSlot[],
  opts: { now?: number; note?: string; identity?: string; account?: AccountDisplay } = {},
): { entry: AccountEntry; autoSaved: boolean } {
  const clean = String(alias ?? "").trim();
  if (!store.accounts[agent]?.[clean]) throw new Error(`账号档不存在：${clean}`);
  let autoSaved = false;
  if (hasAnySlotContent(slots) && !isCurrentCovered(store, agent, slots, opts.identity)) {
    try {
      saveAccount(store, agent, autoAlias("switch"), slots, {
        auto: true, now: opts.now,
        ...(opts.identity ? { identity: opts.identity } : {}),
        ...(opts.account ? { account: opts.account } : {}),
      });
      autoSaved = true;
    } catch { /* 保险失败不阻断切换 */ }
  }
  restoreAccount(store, agent, clean, slots);
  const entries = listAccounts(store, agent, slots, { identity: opts.identity });
  const entry = entries.find((e) => e.alias === clean)!;
  return { entry, autoSaved };
}

/** 删除账号档（含自动保险档）。 */
export function removeAccount(store: AccountsStore, agent: string, alias: string): boolean {
  const clean = String(alias ?? "").trim();
  if (!clean || clean.includes("/") || clean.includes("\\") || clean.includes("..")) throw new Error("别名非法");
  const bag = store.accounts[agent];
  if (!bag?.[clean]) return false;
  delete bag[clean];
  if (!Object.keys(bag).length) delete store.accounts[agent];
  return true;
}

/**
 * 登出（清空全部槽位文件）。调用方应先确保当前登录已存档（自动保险 `_auto-before-logout`）。
 * @returns 实际删除的文件路径
 */
export function clearSlots(slots: AccountSlot[]): string[] {
  const removed: string[] = [];
  for (const s of slots) {
    try {
      if (!existsSync(s.path)) continue;
      rmSync(s.path, { force: true });
      removed.push(s.path);
    } catch { /* 删失败留给下次 */ }
  }
  return removed;
}

