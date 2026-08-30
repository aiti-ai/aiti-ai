/**
 * Extension loader — scans the extensions root and loads each extension entry
 * with jiti (TypeScript transpilation, same mechanism the pi TUI uses).
 */
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { createJiti } from "jiti";
import type { PiWebExtension } from "./types.ts";

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
  const jiti = createJiti(pathToFileURL(entry).href, { interopDefault: true, moduleCache: false });
  const mod = (await jiti.import(pathToFileURL(entry).href)) as unknown;
  const ext = (mod as { default?: unknown } | undefined)?.default ?? mod;
  if (!ext || typeof ext !== "object") return null;
  const candidate = ext as Partial<PiWebExtension>;
  if (typeof candidate.id !== "string" || !candidate.id) return null;
  return candidate as PiWebExtension;
}
