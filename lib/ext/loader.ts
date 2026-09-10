/**
 * Extension loader — scans the extensions root and loads each extension entry
 * with jiti (TypeScript transpilation, same mechanism the pi TUI uses).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { createJiti } from "jiti";
import { jitiCacheDir } from "./data-dir.ts";
import type { PiWebExtension } from "./types.ts";

// 宿主 SDK alias：扩展部署产物通常不带 node_modules（如 ~/.pi/web/extensions/*），
// 裸说明符 @earendil-works/pi-coding-agent 由宿主 node_modules 提供——依赖宿主而非外部链接。
// 与 pi-web 自身依赖同版本同实例（package.json dependencies 锁 0.85.x）。
// Turbopack 编译 instrumentation hook 时 import.meta.dirname 为 undefined（Next 16 已知坑），
// 而 next dev/start 恒以项目根为 cwd——用 cwd 推导 node_modules 位置。
const hostSdkDir = resolve(
  import.meta.dirname ? join(import.meta.dirname, "..", "..") : process.cwd(),
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);

const HOST_SDK_ID = "@earendil-works/pi-coding-agent";

// 宿主 SDK 模块对象（懒单例原生 import）：virtualModules 直注每个 jiti 实例——
// 扩展与宿主拿到结构性同一 SDK 实例（SDK 内部单例/全局注册表不分裂），不再依赖
// serverExternalPackages 的「同 URL 命中 ESM 缓存」配置巧合（磁盘出现双份 SDK /
// 打包策略变化时 alias 目录指向可能分叉出第二实例）。求值链里 virtualModules 在
// alias 之前：裸 ID 精确命中直注；子路径（.../client）走 alias 前缀解析兜底。
// 宿主无 SDK 或原生 import 失败 → null → 回退纯 alias 分支（与旧行为一致）。
let hostSdkModulePromise: Promise<Record<string, unknown> | null> | null = null;

function hostSdkModule(): Promise<Record<string, unknown> | null> | null {
  const entry = join(hostSdkDir, "dist", "index.js");
  if (!existsSync(entry)) return null;
  hostSdkModulePromise ??= import(pathToFileURL(entry).href).catch((e: unknown) => {
    console.error("[ext] 宿主 SDK virtualModules 注入失败，回退 alias 解析:", e instanceof Error ? e.message : e);
    hostSdkModulePromise = null;
    return null;
  });
  return hostSdkModulePromise;
}

const ENTRY_NAMES = ["index.ts", "index.mjs", "index.js", "index.cjs"];

export function scanExtensionDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith(".")) // skip hidden dirs (.git etc.)
    .map((name) => join(root, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

/** Find the entry file for one extension directory, or null. */
export function resolveExtensionEntry(dir: string): string | null {
  for (const name of ENTRY_NAMES) {
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  // Single-script layout: one .ts/.js/.mjs file directly in the dir.
  const files = readdirSync(dir).filter((f) => /\.(ts|mjs|js|cjs)$/.test(f) && !f.startsWith("."));
  if (files.length === 1) return join(dir, files[0]);
  return null;
}

/**
 * 解析扩展版本号为可比较结构（"1.2.3" / "v1.2.3" / "1.2" / "1.2.3-beta.1"）。
 * 数值段全为数字才算可解析；否则返回 null（同名裁决时视为未知，回退根优先级）。
 */
export function parseExtVersion(v: unknown): { core: number[]; pre: string } | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^[v=]+/i, "");
  if (!s) return null;
  const dash = s.indexOf("-");
  const corePart = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : "";
  const parts = corePart.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const core: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    core.push(Number(p));
  }
  return { core, pre };
}

/**
 * 版本比较：a>b → 1；a<b → -1；相等或任一不可解析 → 0（调用方回退根优先级）。
 * 数值段逐位比（缺段补 0）；数值相等时正式版 > 预发布，两个预发布按字符串比
 * （够用即可，不实现完整 semver prerelease 语义）。
 */
export function compareExtVersions(a: unknown, b: unknown): number {
  const va = parseExtVersion(a);
  const vb = parseExtVersion(b);
  if (!va || !vb) return 0;
  const len = Math.max(va.core.length, vb.core.length);
  for (let i = 0; i < len; i++) {
    const x = va.core[i] ?? 0;
    const y = vb.core[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (va.pre && vb.pre) return va.pre === vb.pre ? 0 : va.pre > vb.pre ? 1 : -1;
  if (va.pre) return -1;
  if (vb.pre) return 1;
  return 0;
}

/** Load one extension directory into a PiWebExtension object (default export). */
export async function loadExtensionFromDir(dir: string): Promise<PiWebExtension | null> {
  const entry = resolveExtensionEntry(dir);
  if (!entry) return null;
  // jiti id = 扩展入口文件（而非加载器自身）：裸说明符从扩展目录解析——扩展可带
  // 标准 node_modules 依赖（npm 安装），不依赖宿主 node_modules。
  // moduleCache: false so POST /api/extensions/reload picks up code changes.
  // 宿主 SDK：virtualModules 直注单实例（见 hostSdkModule 注释）；直注不可用时
  // 回退 alias 目录解析（宿主无 SDK 则不传，保持原行为）。
  const sdk = await hostSdkModule();
  const jiti = createJiti(pathToFileURL(entry).href, {
    interopDefault: true,
    moduleCache: false,
    // jiti 转译缓存固定到持久目录（默认回落 /tmp/jiti，重启即清）：键=文件路径 hash、
    // 尾部源码 hash 校验——内容不变即命中，重启后首启免全量重转译；dev/prod 各自
    // webRoot 天然隔离。详见 docs/pi-web-ext-loader-jiti-fscache-persist-plan.md §1。
    fsCache: jitiCacheDir(),
    ...(sdk
      ? {
          virtualModules: { [HOST_SDK_ID]: sdk },
          alias: { [HOST_SDK_ID]: hostSdkDir }, // 子路径前缀兜底（裸 ID 由 virtual 命中）
        }
      : existsSync(hostSdkDir)
        ? { alias: { [HOST_SDK_ID]: hostSdkDir } }
        : {}),
  });
  const mod = (await jiti.import(pathToFileURL(entry).href)) as unknown;
  const ext = (mod as { default?: unknown } | undefined)?.default ?? mod;
  if (!ext || typeof ext !== "object") return null;
  const candidate = ext as Partial<PiWebExtension>;
  if (typeof candidate.id !== "string" || !candidate.id) return null;
  embedUiSvgIcons(dir, candidate);
  return candidate as PiWebExtension;
}

/**
 * jiti 持久缓存目录快照（PI_WEB_EXT_TIMING=1 观测用）：path → mtimeMs 平铺映射
 * （jiti 缓存键形如 <basename>-<hash>.mjs，一层平铺）。命中不写文件、miss 覆盖写
 * （mtime 变化）→ 前后快照 diff 即该扩展加载期间的重转译文件数。
 */
export function snapshotJitiCache(): Map<string, number> {
  const dir = jitiCacheDir();
  const snap = new Map<string, number>();
  if (!existsSync(dir)) return snap;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".mjs")) continue;
    try {
      snap.set(name, statSync(join(dir, name)).mtimeMs);
    } catch {
      // 竞态删除：跳过（diff 口径宁少勿多）
    }
  }
  return snap;
}

/** 快照 diff：after 中新增或 mtime 变化的文件数 = 重转译数（0 = 全命中）。 */
export function countRetranspiled(before: Map<string, number>, after: Map<string, number>): number {
  let n = 0;
  for (const [name, mtime] of after) {
    if (before.get(name) !== mtime) n++;
  }
  return n;
}

/**
 * ui 条目图标文件内嵌（2026-09 契约）：icon 写扩展内 .svg 文件相对路径（如 "icons/mic.svg"）
 * 时，加载即读取文件、抽出 <svg> 内层标记，替换为 { svg } 内嵌对象——manifest 发给前端的
 * 已是内嵌 svg，渲染零请求；文件缺失/非法则保留原字符串（前端走 assets mask 兑底渲染）。
 * 每次扩展加载/reload 执行一次（结果随 ext.ext.ui 缓存，manifest() 直读）。
 */
function embedUiSvgIcons(dir: string, ext: Partial<PiWebExtension>): void {
  const ui = ext.ui as Record<string, unknown> | undefined;
  if (!ui || typeof ui !== "object") return;
  for (const val of Object.values(ui)) {
    if (!Array.isArray(val)) continue;
    for (const item of val) {
      if (!item || typeof item !== "object") continue;
      const icon = (item as { icon?: unknown }).icon;
      if (typeof icon !== "string" || !icon.endsWith(".svg")) continue;
      if (icon.startsWith("/") || icon.includes("..") || icon.includes("://")) continue;
      try {
        const raw = readFileSync(join(dir, icon), "utf8");
        const inner = /<svg[^>]*>([\s\S]*?)<\/svg\s*>/.exec(raw)?.[1]?.trim();
        if (inner) (item as { icon: unknown }).icon = { svg: inner };
      } catch {
        // 文件缺失：保留字符串，前端 renderExtItemIcon 走 assets mask 兑底
      }
    }
  }
}
