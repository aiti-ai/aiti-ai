/**
 * file-ignore —— 基于 .gitignore + .aitignore 的文件忽略规则引擎（纯文件驱动，零硬编码）。
 *
 * 语义（方案 docs/pi-web-files-ignore-gitignore-plan.md）：
 *  1. 规则收集：对目标目录 D，从 D 向上逐层收集 `.gitignore` 与 `.aitignore`，
 *     直到 git 仓库根（遇 `.git` 目录）或文件系统根；层内 `.aitignore` 优先于 `.gitignore`
 *     （AI/工具视图专属覆盖层，可用 `!` 恢复显示被 .gitignore 忽略的目标）。
 *  2. 优先级：从深到浅（越靠近目标的层越优先，git 语义）；每层内 `.aitignore` 先于 `.gitignore`
 *     判定；任一层的 `!`（unignored）恢复，ignored 定案忽略。
 *  3. 无任何 ignore 文件 → 全部显示（所见即磁盘），不保留任何内置默认忽略集合。
 *  4. 唯一硬编码特例 = `.git`（git 自身无视 .gitignore，规则层无从表达）：由 isIgnored
 *     直接判为忽略，与普通忽略项同走 `showIgnored` 通道（见 isIgnored 注释）。
 *
 * 匹配基于 npm `ignore`（gitignore 语法：通配符 * 与 **、?、! 否定、斜杠锚定、尾斜杠目录限定、
 * 双星号目录前缀 / 后缀等）。
 */
import ignore from "ignore";
import type { Ignore } from "ignore";
import * as fs from "node:fs";
import * as path from "node:path";

/** 单个目录层：该层的 .gitignore（git）与 .aitignore（ait）编译实例 */
interface ComboLayer {
  /** 层目录（绝对路径，越靠近目标的层越深） */
  dir: string;
  git?: Ignore;
  ait?: Ignore;
}

interface CacheEntry {
  /** 从深到浅的层列表 */
  layers: ComboLayer[];
  expiresAt: number;
}

/** 缓存 TTL：短窗口即可——list 高频调用避免反复 stat/parse；文件变更 3s 内反映 */
const CACHE_TTL_MS = 3000;

declare global {
  // eslint-disable-next-line no-var
  var __piFileIgnoreCache: Map<string, CacheEntry> | undefined;
}

function cache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIgnoreCache) globalThis.__piFileIgnoreCache = new Map();
  return globalThis.__piFileIgnoreCache;
}

function statMtime(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function readRules(p: string): string[] {
  try {
    const txt = fs.readFileSync(p, "utf8");
    // 拆分规则行：去注释/空行；Windows CRLF 归一
    return txt
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function buildLayer(dir: string): ComboLayer {
  const layer: ComboLayer = { dir };
  const gi = path.join(dir, ".gitignore");
  const ai = path.join(dir, ".aitignore");
  const gm = statMtime(gi);
  const am = statMtime(ai);
  if (gm != null) layer.git = ignore().add(readRules(gi));
  if (am != null) layer.ait = ignore().add(readRules(ai));
  return layer;
}

/** 收集从 dir（含）向上到 git 仓库根 / 文件系统根的规则层，返回从深到浅数组 */
function collect(dirAbs: string): CacheEntry {
  const dirs: string[] = [];
  let cur = path.resolve(dirAbs);
  for (;;) {
    dirs.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const layers: ComboLayer[] = [];
  for (const d of dirs) {
    layers.push(buildLayer(d));
    // git 边界：d 是仓库根（含 .git）→ 不再向上（仓库外规则不影响仓库内）
    if (fs.existsSync(path.join(d, ".git"))) break;
  }
  return { layers, expiresAt: Date.now() + CACHE_TTL_MS };
}

function layersFor(dir: string): ComboLayer[] {
  const key = path.resolve(dir);
  const c = cache().get(key);
  if (c && c.expiresAt > Date.now()) return c.layers;
  const fresh = collect(key);
  // 防无限增长：缓存超过 200 个目录时清掉过期项
  if (cache().size > 200) {
    for (const [k, v] of cache()) if (v.expiresAt <= Date.now()) cache().delete(k);
  }
  cache().set(key, fresh);
  return fresh.layers;
}

/** 相对 POSIX 路径（fromDir → toAbs；层 dir 是 toAbs 的祖先，结果不含 ..） */
function relFrom(fromDir: string, toAbs: string): string {
  return path.relative(fromDir, toAbs).split(path.sep).join("/");
}

/** 单个实例判定：unignored（! 恢复）> ignored > none */
function testLayer(ig: Ignore, subRel: string, isDir: boolean): "ignored" | "unignored" | "none" {
  const p = isDir ? `${subRel}/` : subRel;
  const r = ig.test(p);
  if (r.unignored) return "unignored";
  if (r.ignored) return "ignored";
  return "none";
}

/**
 * 判定 dir 下的 name（直接子项）是否被忽略（.gitignore + .aitignore 完整语义）。
 *
 * **唯一硬编码特例 = `.git`**：git 自身对它无视 `.gitignore`（写进规则也无效），
 * 规则层无从表达，故直接判为忽略——语义上它就是一项「默认隐藏」，与普通忽略项同走
 * `showIgnored` 通道（打开时照常带 `ignored` 标记返回，用户要看全部就给他全部）。
 * worktree 与子模块的 `.git` 是 gitdir 指针文件，同名同判。
 *
 * @param dir 父目录绝对路径
 * @param name 直接子项名
 * @param isDir 子项是否为目录
 */
export function isIgnored(dir: string, name: string, isDir: boolean): boolean {
  if (name === ".git") return true;
  const abs = path.join(dir, name);
  for (const L of layersFor(dir)) {
    const sub = relFrom(L.dir, abs);
    // git 仓库根边界内：layer 永远是 abs 的祖先，sub 非空；防御性跳过
    if (!sub || sub === ".") continue;
    if (L.ait) {
      const r = testLayer(L.ait, sub, isDir);
      if (r !== "none") return r === "ignored";
    }
    if (L.git) {
      const r = testLayer(L.git, sub, isDir);
      if (r !== "none") return r === "ignored";
    }
  }
  return false;
}

/**
 * 仅按 .aitignore 判定（供 git 仓库叠加：`git ls-files --exclude-standard` 已处理 .gitignore 层，
 * git 不认识 .aitignore，须本函数补叠）。relPath 相对 dir，按文件处理（git ls-files 只列文件）。
 */
export function isAitIgnored(dir: string, relPath: string): boolean {
  const abs = path.join(dir, relPath);
  for (const L of layersFor(dir)) {
    if (!L.ait) continue;
    const sub = relFrom(L.dir, abs);
    if (!sub || sub === ".") continue;
    const r = testLayer(L.ait, sub, false);
    if (r !== "none") return r === "ignored";
  }
  return false;
}

/** 测试辅助：清空规则缓存（单测隔离用） */
export function clearIgnoreCache(): void {
  cache().clear();
}
