/**
 * 公开（expose）方案持久化 — 「另存为方案」+「上次使用」自动记录。
 *
 * 存储：~/.pi/web/expose-presets.json（0600，原子写；目录可用
 * PI_WEB_EXPOSE_PRESETS_DIR 覆盖，供测试/隔离实例）。敏感值（token /
 * secret / password…——以库 ParamSpec type:"password" 标记为准、叶键名
 * 启发式兜底）用 AES-256-GCM 加密后落盘；密钥是首次使用时随机生成的
 * ~/.pi/web/.expose-preset.key（0600）。加密目标是**静态存储**：文件被
 * 备份/拷走时不带明文凭据；不防御已能读密钥文件或进程内存的攻击者。
 * 加载（preset-load / 上次使用回填）时解密回明文供表单使用。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { isSensitiveExposeParam } from "./service-tunnels-integration.ts";

/** 表单配置（与 Ports 页公开表单一一对应）。参数均为 schema 键 → 字符串。
 *  serviceBasePath：端口转发属性 Base Path（vite base=/dev/ 填 dev；空 = 根路径）。 */
export interface ExposePresetConfig {
  provider: string | null;
  tunnel: string;
  protocol: "http" | "https" | "tcp";
  mode: "tunnel" | "proxy" | "both";
  site: string;
  serviceBasePath?: string;
  tunnelParams: Record<string, string>;
  providerParams: Record<string, string>;
}

interface StoredConfig {
  provider: string | null;
  tunnel: string;
  protocol: string;
  mode: string;
  site: string;
  serviceBasePath?: string;
  tunnelParams: Record<string, string>;
  providerParams: Record<string, string>;
}

interface PresetFile {
  version: 1;
  lastUsed?: { savedAt: number; config: StoredConfig };
  presets: Array<{ id: string; name: string; createdAt: number; updatedAt: number; config: StoredConfig }>;
}

// 目录用函数惰性解析（不能用模块顶层 const：测试在每个用例里切
// PI_WEB_EXPOSE_PRESETS_DIR，顶层求值会把首刈目录固化，测试写进真实家目录）。
function presetDir(): string {
  return process.env.PI_WEB_EXPOSE_PRESETS_DIR ?? join(homedir(), ".pi", "web");
}
function storeFile(): string {
  return join(presetDir(), "expose-presets.json");
}
function keyFile(): string {
  return join(presetDir(), ".expose-preset.key");
}
/** 「上次使用」伪 id（下拉固定项）。 */
export const LAST_USED_ID = "__last__";
const MAX_PRESETS = 50;
const MAX_NAME_LEN = 60;

// 读-改-写串行化：同一进程内「公开成功记 last-used」与「另存方案」并发时，
// 交错 readFile→writeFile 会互相覆盖（丢一份写入）。单 promise 链排队即可
// （同用户单实例场景，无需跨进程锁）。
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => T): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// AES-256-GCM（敏感值加密）
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null;
let cachedKeyDir: string | null = null;

/** 首次使用生成随机密钥（0600）；之后读缓存/文件。失败抛错（fail-closed）。 */
function getKey(): Buffer {
  const dir = presetDir();
  if (cachedKey && cachedKeyDir === dir) return cachedKey;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const KEY_FILE = keyFile();
  if (existsSync(KEY_FILE)) {
    const k = readFileSync(KEY_FILE);
    if (k.length === 32) { cachedKey = k; cachedKeyDir = dir; return k; }
    // 长度异常（损坏/手工编辑）→ 丢弃重建：已存密文解不开，但公开方案里的
    // 敏感参数本就要重填，非敏感字段不受影响。
  }
  const k = randomBytes(32);
  writeFileSync(KEY_FILE, k, { mode: 0o600 });
  try { chmodSync(KEY_FILE, 0o600); } catch { /* Windows 等 */ }
  cachedKey = k;
  cachedKeyDir = dir;
  return k;
}

function encryptValue(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `enc:v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

function decryptValue(v: string): string {
  const m = /^enc:v1:([^:]+):([^:]+):(.+)$/.exec(v);
  if (!m) return v; // 兼容历史/手写的明文值
  try {
    const d = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(m[1]!, "base64"));
    d.setAuthTag(Buffer.from(m[2]!, "base64"));
    return Buffer.concat([d.update(Buffer.from(m[3]!, "base64")), d.final()]).toString("utf8");
  } catch {
    return ""; // 密钥轮换/损坏 → 敏感值留空让用户重填，不整个方案报废
  }
}

// ---------------------------------------------------------------------------
// 序列化（敏感值加密 / 反序列化解密）
// ---------------------------------------------------------------------------

function toStringRecord(params: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

function toStored(cfg: ExposePresetConfig): StoredConfig {
  const encParams = (params: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      out[k] = v !== "" && isSensitiveExposeParam(k) ? encryptValue(v) : v;
    }
    return out;
  };
  return {
    provider: cfg.provider ?? null,
    tunnel: cfg.tunnel,
    protocol: cfg.protocol,
    mode: cfg.mode,
    site: cfg.site ?? "",
    // Base Path 非敏感、非路径秘密——明文存储，方便直接查看 enrolled 配置
    ...(typeof cfg.serviceBasePath === "string" && cfg.serviceBasePath !== "" ? { serviceBasePath: cfg.serviceBasePath } : {}),
    tunnelParams: encParams(toStringRecord(cfg.tunnelParams)),
    providerParams: encParams(toStringRecord(cfg.providerParams)),
  };
}

function fromStored(cfg: StoredConfig): ExposePresetConfig {
  const protocol = cfg.protocol === "https" || cfg.protocol === "tcp" ? cfg.protocol : "http";
  const mode = cfg.mode === "proxy" || cfg.mode === "both" ? cfg.mode : "tunnel";
  const dec = (params: Record<string, string>) =>
    Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [k, typeof v === "string" ? decryptValue(v) : v]));
  return {
    provider: typeof cfg.provider === "string" && cfg.provider !== "" ? cfg.provider : null,
    tunnel: typeof cfg.tunnel === "string" && cfg.tunnel !== "" ? cfg.tunnel : "cloudflared",
    protocol,
    mode,
    site: typeof cfg.site === "string" ? cfg.site : "",
    serviceBasePath: typeof cfg.serviceBasePath === "string" ? cfg.serviceBasePath : "",
    tunnelParams: dec(cfg.tunnelParams ?? {}),
    providerParams: dec(cfg.providerParams ?? {}),
  };
}

// ---------------------------------------------------------------------------
// 文件读写（原子、0600）
// ---------------------------------------------------------------------------

function readFile(): PresetFile {
  try {
    const raw = JSON.parse(readFileSync(storeFile(), "utf8")) as Partial<PresetFile>;
    if (raw && Array.isArray(raw.presets)) return raw as PresetFile;
  } catch {
    // 不存在/损坏 → 空 store
  }
  return { version: 1, presets: [] };
}

function writeFile(store: PresetFile): void {
  const dir = presetDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const FILE = storeFile();
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows 等 */ }
  renameSync(tmp, FILE);
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/** 方案清单（下拉用）——只含元数据，不含任何参数值（明/密文都不下发）。 */
export function listExposePresets(): {
  presets: Array<{ id: string; name: string; createdAt: number; updatedAt: number }>;
  lastUsedAt: number | null;
} {
  const s = readFile();
  return {
    presets: s.presets.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt })),
    lastUsedAt: s.lastUsed?.savedAt ?? null,
  };
}

/** 加载一份方案（id = 方案 id 或 LAST_USED_ID）→ 解密后的完整表单配置。 */
export function loadExposePreset(id: string): ExposePresetConfig | null {
  const s = readFile();
  if (id === LAST_USED_ID) return s.lastUsed ? fromStored(s.lastUsed.config) : null;
  const p = s.presets.find((x) => x.id === id);
  return p ? fromStored(p.config) : null;
}

/** 新建/更新（同名覆盖）方案。name 必填非空。 */
export async function saveExposePreset(name: string, cfg: ExposePresetConfig): Promise<{ id: string; updatedAt: number }> {
  const trimmed = name.trim().slice(0, MAX_NAME_LEN);
  if (!trimmed) throw new Error("preset name required");
  return withWriteLock(() => {
    const s = readFile();
    const now = Date.now();
    const existing = s.presets.find((p) => p.name === trimmed);
    if (existing) {
      existing.config = toStored(cfg);
      existing.updatedAt = now;
      writeFile(s);
      return { id: existing.id, updatedAt: now };
    }
    if (s.presets.length >= MAX_PRESETS) throw new Error(`too many presets (max ${MAX_PRESETS})`);
    const id = `p_${now.toString(36)}${randomBytes(4).toString("hex")}`;
    s.presets.push({ id, name: trimmed, createdAt: now, updatedAt: now, config: toStored(cfg) });
    writeFile(s);
    return { id, updatedAt: now };
  });
}

export function deleteExposePreset(id: string): boolean {
  const s = readFile();
  const before = s.presets.length;
  s.presets = s.presets.filter((p) => p.id !== id);
  if (s.presets.length === before) return false;
  writeFile(s);
  return true;
}

/** 每次公开成功后自动记录「上次使用」（best-effort，失败不影响公开结果）。 */
export function saveLastUsedExpose(cfg: ExposePresetConfig): void {
  void withWriteLock(() => {
    const s = readFile();
    s.lastUsed = { savedAt: Date.now(), config: toStored(cfg) };
    writeFile(s);
  }).catch((err) => {
    console.warn("[pi-web] 保存「上次使用」公开配置失败:", err);
  });
}
