/**
 * aiti-doc-center · 纯逻辑核心（方案 docs/aiti-doc-center-plan.md §2/§4）
 *
 * 分层：
 *   解析   parseFrontMatter（子集：tags/title）· inlineTagScan（Obsidian 兼容 hashtag，
 *          避坑：URL/md链接目标/围栏与缩进代码/行内代码/HTML注释/纯数字）
 *          · extractHeadings（H1-H3）· extractLinks（md链接/[[wiki]]/@路径）
 *          · derivePathTags（目录 → 嵌套 tag，深度 ≤3）
 *   归一化 normalizeTag（charset/深度≤6/长度≤64/非纯数字/小写 key 保留 display）
 *   SQL    initSchema/compareMap/upsertDoc（rename 同 hash 继承）/markMissingDeleted（软删）
 *          /purgeExpired（物理清理）/rebuildAllLinks/computeRank（PageRank）
 *          /queryDocs（FTS trigram 中文 + <3字符 LIKE 降级 + 融合分）/tagsAll/tagTree/docDetail
 *
 * 本文件不打开数据库（db 句柄注入，node:test 用 :memory:）；无轮询、无全局状态。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = "3"; // v3 = doc_tags.source + 'db'（手工 tag）+ docs.kind（'md'|'file'，M6-A）
/** 派生规则版本（路径派生/ignore 规则变更时 +1 → 启动自动全量重建一次） */
export const TAG_LOGIC_VERSION = "3"; // v3 = 随机目录名规则扩展（test/final/单字母/键盘乱按/高熵/日期豁免）
/** 短词索引版本（doc_bigrams 2-gram 倒排表引入/变更时 +1 → 老库启动自动全量重建一次） */
export const INDEX_LOGIC_VERSION = "1"; // v1 = 短词（<3 码点，trigram FTS 匹配不到）走 doc_bigrams 精确索引
export const DEFAULT_EXCLUDES = ["node_modules", ".git", "dist", ".next", ".e2e", "vendor_cache", "__pycache__"];
export const KEYSEP = "\u0000";

// ───────────────────────── tag 归一化 ─────────────────────────

/**
 * Obsidian 兼容 inline hashtag 正则。
 * 前置守卫：前一字符不得为 字母/数字/_/#/&// （排除 ##标题记号、HTML 实体、URL 尾巴/锚点）；
 * 标签体：字母/数字/_ 开头，charset [\p{L}\p{N}_\-/]，长度 ≤64。
 */
export const TAG_RE = /(^|[^\p{L}\p{N}_#&\/])#([\p{L}\p{N}_][\p{L}\p{N}_\-\/]{0,63}[\p{L}\p{N}_])/gmu;

export interface NormTag { key: string; display: string }

/** 归一化失败返回 null（非法字符/纯数字/深度>6/长度>64）。 */
export function normalizeTag(raw: string): NormTag | null {
  let s = String(raw ?? "").trim().replace(/^#+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "").trim();
  if (!s || s.length > 64) return null;
  const segs = s.split("/");
  if (segs.length > 6) return null;
  for (const seg of segs) {
    if (!seg || !/^[\p{L}\p{N}_\-]+$/u.test(seg)) return null;
  }
  if (!/[\p{L}_]/u.test(s)) return null; // 至少含一个字母/下划线（#2024 不算）
  return { key: s.toLowerCase(), display: s };
}

// ───────────────────────── front-matter 子集 ─────────────────────────

export interface FmData { tags: string[]; title?: string }

export function parseFrontMatter(text: string): { data: FmData; bodyStart: number } {
  const out: FmData = { tags: [] };
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return { data: out, bodyStart: 0 };
  const fmLines: string[] = [];
  let i = 1;
  let closed = false;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") { i++; closed = true; break; }
    fmLines.push(lines[i]);
  }
  if (!closed) return { data: out, bodyStart: 0 };
  let off = 0;
  for (let k = 0; k < i && k < lines.length; k++) off += lines[k].length + 1;
  for (let j = 0; j < fmLines.length; j++) {
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(fmLines[j]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "tags") {
      if (val.startsWith("[") && val.endsWith("]")) {
        out.tags.push(...splitFlowList(val.slice(1, -1)));
      } else if (val === "") {
        for (j++; j < fmLines.length; j++) {
          const bm = /^\s*-\s+(.*)$/.exec(fmLines[j]);
          if (!bm) break;
          const v = stripVal(bm[1]);
          if (v) out.tags.push(v);
        }
      } else {
        const v = stripVal(val);
        if (v) out.tags.push(v);
      }
    } else if (key === "title" && val) {
      out.title = unquote(val);
    }
  }
  return { data: out, bodyStart: Math.min(off, text.length) };
}

function splitFlowList(inner: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let q = "";
  for (const ch of inner) {
    if (q) { if (ch === q) q = ""; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ",") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(stripVal).filter(Boolean);
}

function stripVal(v: string): string {
  return unquote(v.trim().replace(/^#+/, "").trim()); // 容忍 # 前缀（Obsidian 同款）
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

// ───────────────────────── 正文扫描 ─────────────────────────

/** 去围栏代码块（```/~~~，含 info string；闭合须同字符且长度≥开栏）。 */
export function stripFences(text: string): string {
  const out: string[] = [];
  let fenceCh = "";
  let fenceLen = 0;
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (m) {
      const marker = m[1];
      if (!fenceCh) { fenceCh = marker[0]; fenceLen = marker.length; continue; }
      if (marker[0] === fenceCh && marker.length >= fenceLen && m[2].trim() === "") fenceCh = "";
      continue;
    }
    if (fenceCh) continue;
    out.push(l);
  }
  return out.join("\n");
}

/** 2-gram 提取（短词倒排）：trigram FTS 匹配不了 <3 码点的词（如 2 字中文词“遗留/治理/检索”），
 *  短词搜索走此倒排表精确索引。规则：相邻非空白码点对，且两侧都是字母/数字/汉字（跳过标点符号对）；
 *  ASCII 大小写归一（查询与索引同侧 lowercase，CJK 不变）。返回去重集合。 */
export function extractBigrams(text: string): Set<string> {
  const set = new Set<string>();
  const chars = [...String(text ?? "")];
  const WORD_CHAR = /[\p{L}\p{N}]/u;
  let prev = "";
  for (const ch of chars) {
    if (/\s/u.test(ch)) { prev = ""; continue; }
    if (prev && WORD_CHAR.test(prev) && WORD_CHAR.test(ch)) {
      const g = (prev + ch).toLowerCase();
      if ([...g].length === 2) set.add(g);
    }
    prev = ch;
  }
  return set;
}

/** inline #tag 扫描（§2.1 避坑序列，按行处理）。 */
export function inlineTagScan(body: string): string[] {
  let t = stripFences(body).replace(/<!--[\s\S]*?-->/g, "\n"); // 多行 HTML 注释
  const found: string[] = [];
  for (let line of t.split("\n")) {
    if (/^(\s{4,}|\t)/.test(line)) continue; // 缩进代码
    line = line.replace(/`[^`\n]*`/g, " ");            // 行内代码
    line = line.replace(/\]\([^)\n]*\)/g, "] ");       // md 链接目标（含 #锚点）
    line = line.replace(/https?:\/\/[^\s)]+/g, " ");   // 裸 URL
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(line))) {
      found.push(m[2]);
    }
  }
  return found;
}

export interface Heading { level: number; text: string; line: number }

export function extractHeadings(body: string): Heading[] {
  const out: Heading[] = [];
  const lines = stripFences(body).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(lines[i]);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/\s#+\s*$/, "").trim() || m[2].trim(), line: i + 1 });
  }
  return out;
}

export interface RawLink { kind: "md" | "wiki" | "at"; target: string }

/** 引用边提取（§4.8）：md 链接 / [[wiki]] / @路径（.md 结尾天然排除邮箱）。 */
export function extractLinks(body: string): RawLink[] {
  const t = stripFences(body).replace(/`[^`\n]*`/g, " ");
  const out: RawLink[] = [];
  let m: RegExpExecArray | null;
  const MD = /\[[^\]\n]*\]\(([^)\s]+?\.md)(#[^)\s]*)?\)/gi;
  while ((m = MD.exec(t))) out.push({ kind: "md", target: m[1] });
  const WIKI = /\[\[([^\]|\n#]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
  while ((m = WIKI.exec(t))) out.push({ kind: "wiki", target: m[1].trim() });
  const AT = /(?<![\w.\/\-@])@([\w.\-\/]+\.md)\b/g;
  while ((m = AT.exec(t))) out.push({ kind: "at", target: m[1] });
  return out;
}

export interface ParsedDoc {
  title?: string;
  fmTags: string[];
  inlineTags: string[];
  headings: Heading[];
  links: RawLink[];
  body: string;
  wordCount: number;
}

export function parseMarkdown(text: string): ParsedDoc {
  const fm = parseFrontMatter(text);
  const body = text.slice(fm.bodyStart);
  const headings = extractHeadings(body);
  let title = fm.data.title;
  if (!title) {
    const h1 = headings.find((h) => h.level === 1);
    if (h1) title = h1.text;
  }
  return {
    title: title || undefined,
    fmTags: fm.data.tags,
    inlineTags: inlineTagScan(body),
    headings,
    links: extractLinks(body),
    body,
    wordCount: body.length,
  };
}

// 明显随机/临时目录名（AI scratch、工具产物、手工乱建）→ 不作为 folder tag。
// 设计原则：宁可用「语义前缀 + 形态」判定，不做熵值误伤（docs/design/plans/2024/01 这类必须保留）。
const JUNK_DIR_WORDS =
  "tmp|temp|scratch|sandbox|playground|debug|wip|draft|backup|bak|copy|old|new|untitled|" +
  "work|workdir|working|cache|run|test|foo|bar|baz|foobar|asdf|qwer|zxcv|asdfgh|qwerty|xxx|yyy|zzz|aaaa|" +
  "新建文件夹|未命名|临时|备份|副本|最终版?|最新|final|测试";
const JUNK_DIR_WORD_RE = new RegExp(String.raw`^(?:` + JUNK_DIR_WORDS + String.raw`)(?:[._-].*)?$`, "i");       // 前缀(+分隔符任意后缀)：tmp-xxx / tmp.a1b2 / draft-xxx
const JUNK_DIR_WORD_NUM_RE = new RegExp(String.raw`^(?:` + JUNK_DIR_WORDS + String.raw`)\d*$`, "i");          // 前缀+顺序数字：tmp2 / test123 / 备份1（tests 不命中）
const SINGLE_CHAR_RE = /^[a-z]$/i;                                                          // 单字母 scratch（a/b/x…）
const REPEAT_CHAR_RE = /^(.)\1{2,}$/u;                                                      // aaa / 111 / xxx（重复≥3）
const KEYBOARD_MASH_RE = /^(?:asdf|qwer|zxcv|qwerty|asdfgh|haha)/i;                          // 键盘乱按（ redundancy with word list，留显式）
const HIGH_ENTROPY_RE = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[a-zA-Z0-9]{10,}$/;                 // ≥10 位大小写+数字混合（aB3xK9mQ2z）
const HEX8_RE = /^[0-9a-f]{8,}$/i;                                                          // ≥8 位纯 hex（deadbeef 级；decade=6 位不误伤）

/** 纯数字里的日期形态豁免：年(2024)、月日(01/15)、ym(2024-01 无连字符形态 202401)、ymd(20240101)。 */
function isDateLikeDigits(name: string): boolean {
  return (
    (/^\d{4}$/.test(name) && /^(19|20)/.test(name)) ||
    /^\d{1,2}$/.test(name) ||
    /^(19|20)\d{2}[-_]?(0[1-9]|1[0-2])([-_]?\d{1,2})?$/.test(name) ||
    /^(19|20)\d{6}$/.test(name)
  );
}

/** 明显随机/临时目录名 → 不作为 folder tag（v2.3 迭代，方案 §10.2 第 3 条）。 */
export function isRandomDirName(name: string): boolean {
  if (/[0-9a-f]{16,}/i.test(name)) return true;                    // 长十六进制（git_dest12855 的尾段/整段）
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(name)) return true; // UUID 片段
  if (/[a-z_-]+[_-]?\d{6,}$/i.test(name)) return true;            // 字母前缀+≥6 位数字（git_dest128…/workdir549…）
  if (/^\d+([-_]\d+)*$/.test(name) && !isDateLikeDigits(name)) return true; // 纯数字（日期形态豁免）
  if (!/[a-z\u4e00-\u9fa5]/i.test(name) && !isDateLikeDigits(name)) return true;   // 无字母/汉字（纯符号；日期形态豁免）
  if (JUNK_DIR_WORD_RE.test(name)) return true;                    // 临时语义前缀（tmp-xxx/tmp.a1b2/draft-草稿…）
  if (JUNK_DIR_WORD_NUM_RE.test(name)) return true;                // 前缀+顺序数字（tmp2/test123/备份1；tests 不命中）
  if (SINGLE_CHAR_RE.test(name)) return true;                      // 单字母
  if (REPEAT_CHAR_RE.test(name)) return true;                      // 单字符重复 ≥3
  if (KEYBOARD_MASH_RE.test(name)) return true;                    // 键盘乱按
  if (HIGH_ENTROPY_RE.test(name)) return true;                     // 大小写+数字高熵 ≥10
  if (HEX8_RE.test(name) && name.length >= 8 && !isDateLikeDigits(name)) return true;  // ≥8 位纯 hex（日期形态豁免）
  return false;
}

/**
 * 路径派生 tag（v2，迭代 2026-08-31）：**逐段单名、倒排**——离文件越近越优先。
 * 例 pi-work/docs/plans/x.md → ["plans", "docs", "pi-work"]（docs/design/plan 类名字直接可过滤）；
 * 随机目录名（isRandomDirName）与非法字符段跳过；去重；上限 maxDepth 段。
 */
export function derivePathTags(rel: string, maxDepth = 6): string[] {
  const dir = dirname(rel).replace(/\\/g, "/");
  if (!dir || dir === ".") return [];
  const segs = dir.split("/").filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = segs.length - 1; i >= 0 && out.length < maxDepth; i--) {
    const seg = segs[i];
    if (!/^[\p{L}\p{N}_\-]+$/u.test(seg)) continue;
    if (isRandomDirName(seg)) continue;
    if (!seen.has(seg)) { seen.add(seg); out.push(seg); }
  }
  return out;
}

export function contentHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

// ───────────────────────── front-matter tags 写回（M4/M5） ─────────────────────────

/**
 * tags 写回（纯字符串变换，IO 由调用方）：add/remove 归一化去重；
 * 无 front-matter → 文首新建 --- 块；有 → tags 行改写为 flow 列表（块列表折叠）；
 * CRLF 保持；其余内容逐字节不动。返回新文本与最终 tag keys。
 */
export function writeFmTags(text: string, add: string[], remove: string[]): { text: string; tags: string[] } {
  const norm = (list: string[]) => {
    const out: NormTag[] = [];
    for (const raw of list ?? []) {
      const n = normalizeTag(String(raw ?? ""));
      if (n && !out.some((x) => x.key === n.key)) out.push(n);
    }
    return out;
  };
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const hasFm = lines.length > 0 && lines[0].trim() === "---";
  let closeIdx = -1;
  if (hasFm) {
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === "---" || t === "...") { closeIdx = i; break; }
    }
  }
  let existing: NormTag[] = [];
  let tagsLineIdx = -1;
  let blockStart = -1, blockEnd = -1;
  if (hasFm && closeIdx > 0) {
    for (let i = 1; i < closeIdx; i++) {
      const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(lines[i]);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key !== "tags") continue;
      const val = m[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        tagsLineIdx = i;
        existing = val.slice(1, -1).split(",").map((s) => normalizeTag(stripVal(s))).filter((x): x is NormTag => !!x);
      } else if (val === "") {
        blockStart = i; blockEnd = i + 1;
        for (let j = i + 1; j < closeIdx; j++) {
          const bm = /^\s*-\s+(.*)$/.exec(lines[j]);
          if (!bm) break;
          blockEnd = j + 1;
          const n = normalizeTag(stripVal(bm[1]));
          if (n) existing.push(n);
        }
      } else {
        tagsLineIdx = i;
        const n = normalizeTag(stripVal(val));
        existing = n ? [n] : [];
      }
      break;
    }
  }
  const removeKeys = new Set(norm(remove).map((n) => n.key));
  const merged: NormTag[] = existing.filter((n) => !removeKeys.has(n.key));
  for (const n of norm(add)) if (!merged.some((x) => x.key === n.key)) merged.push(n);
  const flowVal = "tags: [" + merged.map((n) => n.display).join(", ") + "]";
  let outLines: string[];
  if (!hasFm || closeIdx < 0) {
    outLines = ["---", flowVal, "---", "", ...lines];
  } else if (tagsLineIdx >= 0) {
    outLines = lines.slice();
    outLines[tagsLineIdx] = flowVal;
  } else if (blockStart >= 0) {
    outLines = lines.slice(0, blockStart).concat([flowVal], lines.slice(blockEnd));
  } else {
    outLines = lines.slice(0, 1).concat([flowVal], lines.slice(1));
  }
  return { text: outLines.join(nl), tags: merged.map((n) => n.key) };
}

// ───────────────────────── 路径/文件 ─────────────────────────

export interface WalkFile { abs: string; rel: string; mtimeMs: number; size: number }

function isExcluded(name: string, excludes: Set<string>): boolean {
  if (excludes.has(name)) return true;
  for (const pat of excludes) {
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.split("*").map(escapeRe).join(".*") + "$");
      if (re.test(name)) return true;
    }
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── ignore 感知（迭代 2026-08-31；引擎收殓至 _shared/ignore-semantics.ts 同步副本 lib/）──
// 约定文件：.gitignore / .aitiignore（自有约定）/ .dockerignore（逐目录读取合并，
// 深层优先、集内后行覆盖前行）。语义与 API 见 lib/ignore-semantics.ts。

export const IGNORE_FILES = [".gitignore", ".aitiignore", ".dockerignore"];
import { compileIgnoreLines, matchRules, type IgnoreRule } from "./lib/ignore-semantics.ts";
export type { IgnoreRule } from "./lib/ignore-semantics.ts";
export interface IgnoreSet { rules: IgnoreRule[] }
export interface IgnoreStack { items: { base: string; set: IgnoreSet }[] }

export function parseIgnoreSet(text: string): IgnoreSet {
  return { rules: compileIgnoreLines(text) };
}

/** rel 相对 root；从最深 ignore 文件往外，第一个产生判定的规则集生效（集内后行覆盖前行）。 */
function isIgnoredPath(stack: IgnoreStack, rel: string): boolean {
  for (let i = stack.items.length - 1; i >= 0; i--) {
    const item = stack.items[i];
    const relToBase = item.base ? rel.slice(item.base.length + 1) : rel;
    if (!relToBase) continue;
    const d = matchRules(item.set.rules, relToBase);
    if (d !== null) return d;
  }
  return false;
}

function loadIgnoreSet(dirAbs: string): IgnoreSet | null {
  let set: IgnoreSet | null = null;
  for (const f of IGNORE_FILES) {
    const p = dirAbs + "/" + f;
    if (!existsSync(p)) continue;
    try {
      const parsed = parseIgnoreSet(readFileSync(p, "utf8"));
      if (!set) set = { rules: [] };
      set.rules.push(...parsed.rules);
    } catch { /* 坏文件容忍 */ }
  }
  return set;
}

export function walkFiles(root: string, excludes: Set<string>, relPrefix = "", out: WalkFile[] = [], stack: IgnoreStack = { items: [] }): WalkFile[] {
  const dirAbs = relPrefix ? root + "/" + relPrefix : root;
  let entries: any[] = [];
  try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return out; }
  const own = loadIgnoreSet(dirAbs);
  const myStack: IgnoreStack = own ? { items: stack.items.concat({ base: relPrefix, set: own }) } : stack;
  for (const e of entries) {
    if (e.name.startsWith(".git")) continue; // .git 及其内部
    if (isExcluded(e.name, excludes)) continue;
    const rel = relPrefix ? relPrefix + "/" + e.name : e.name;
    const abs = root + "/" + rel;
    if (e.isDirectory()) {
      if (isIgnoredPath(myStack, rel, true)) continue;
      walkFiles(root, excludes, rel, out, myStack);
    } else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
      if (isIgnoredPath(myStack, rel, false)) continue;
      try {
        const st = statSync(abs);
        out.push({ abs, rel, mtimeMs: Math.round(st.mtimeMs), size: st.size });
      } catch { /* 竞态：文件消失 */ }
    }
  }
  return out;
}

/** 目录数探测（ignore 感知 + 早退；供 watch 上限判断）。 */
export function countDirs(root: string, excludes: Set<string>, cap: number): number {
  let n = 0;
  const stack: IgnoreStack = { items: [] };
  const walk = (dirAbs: string, relPrefix: string): void => {
    if (n > cap) return;
    let entries: any[] = [];
    try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    const own = loadIgnoreSet(dirAbs);
    const myStack: IgnoreStack = own ? { items: stack.items.concat({ base: relPrefix, set: own }) } : stack;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".git") || isExcluded(e.name, excludes)) continue;
      const rel = relPrefix ? relPrefix + "/" + e.name : e.name;
      if (isIgnoredPath(myStack, rel, true)) continue;
      n++;
      walk(dirAbs + "/" + e.name, rel);
      if (n > cap) return;
    }
  };
  walk(root, "");
  return n;
}

/**
 * countDirs 的分片异步版（2026-09-11）：BFS 逐层扫描，每层批间 setImmediate 让路，
 * 单次连续阻塞 ≤ 一个目录的 readdir——供主线程后台探测（watch 初始化），不再出现
 * 大 roots 下秒级整块卡顿（reload 全局停顿根因，实测 startup hook 2.1-3.2s）。
 * 数量与同步版一致（计数与遍历顺序无关）；同样 cap 早退。
 */
export async function countDirsAsync(root: string, excludes: Set<string>, cap: number): Promise<number> {
  let n = 0;
  type Task = { dirAbs: string; rel: string; stack: IgnoreStack };
  let queue: Task[] = [{ dirAbs: root, rel: "", stack: { items: [] } }];
  while (queue.length) {
    const batch = queue;
    queue = [];
    for (const t of batch) {
      if (n > cap) return n;
      let entries: any[] = [];
      try { entries = readdirSync(t.dirAbs, { withFileTypes: true }); } catch { continue; }
      const own = loadIgnoreSet(t.dirAbs);
      const myStack: IgnoreStack = own ? { items: t.stack.items.concat({ base: t.rel, set: own }) } : t.stack;
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith(".git") || isExcluded(e.name, excludes)) continue;
        const rel = t.rel ? t.rel + "/" + e.name : e.name;
        if (isIgnoredPath(myStack, rel, true)) continue;
        n++;
        queue.push({ dirAbs: t.dirAbs + "/" + e.name, rel, stack: myStack });
      }
    }
    if (queue.length) await new Promise<void>((resolve) => setImmediate(resolve)); // 批间让路
  }
  return n;
}

export function normalizeRoots(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    let p = String(raw ?? "").trim();
    if (!p) continue;
    if (p.startsWith("~")) p = homedir() + p.slice(1);
    p = p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function resolveAbs(target: string, roots: string[]): { root: string; rel: string } | null {
  let t = target.replace(/\\/g, "/");
  if (t.startsWith("~")) t = homedir() + t.slice(1);
  for (const r0 of roots) {
    const r = r0.replace(/\/+$/, "");
    if (t.startsWith(r + "/")) return { root: r, rel: t.slice(r.length + 1) };
  }
  return null;
}

/** 相对目标的候选 rel（先当前文件目录，再 root 相对；做 .. 归一化）。 */
export function linkCandidates(target: string, docRel: string): string[] {
  const norm = (p: string) => {
    const segs: string[] = [];
    for (const s of p.replace(/\\/g, "/").split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") segs.pop();
      else segs.push(s);
    }
    return segs.join("/");
  };
  const raw = target.replace(/\\/g, "/");
  const dir = dirname(docRel).replace(/\\/g, "/");
  const c1 = norm((dir && dir !== "." ? dir + "/" : "") + raw); // 先拼再归一化，保 .. 语义
  const c2 = norm(raw);
  return c1 === c2 ? [c1] : [c1, c2];
}

// ───────────────────────── SQL ─────────────────────────

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs(
      id INTEGER PRIMARY KEY,
      root TEXT NOT NULL,
      relpath TEXT NOT NULL,
      title TEXT,
      mtime_ms INTEGER,
      size INTEGER,
      hash TEXT,
      headings_json TEXT,
      links_json TEXT,
      word_count INTEGER DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER,
      rank REAL NOT NULL DEFAULT 0,
      rank_norm REAL NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'md',
      UNIQUE(root, relpath));
    CREATE TABLE IF NOT EXISTS tags(
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      display TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS doc_tags(
      doc_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('frontmatter','inline','path','ui','db')),
      UNIQUE(doc_id, tag_id, source));
    CREATE TABLE IF NOT EXISTS doc_links(
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      UNIQUE(from_id, to_id));
    CREATE TABLE IF NOT EXISTS doc_sessions(
      doc_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      first_op INTEGER,
      last_op INTEGER,
      op_count INTEGER DEFAULT 0,
      UNIQUE(doc_id, session_id));
    CREATE TABLE IF NOT EXISTS pending_session_docs(
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      sid TEXT NOT NULL,
      first_op INTEGER,
      last_op INTEGER,
      op_count INTEGER DEFAULT 0,
      UNIQUE(root, path, sid));
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      title, headings, tags_text, body, path UNINDEXED, doc_id UNINDEXED,
      tokenize='trigram');
    CREATE TABLE IF NOT EXISTS doc_bigrams(
      doc_id INTEGER NOT NULL,
      gram TEXT NOT NULL,
      UNIQUE(doc_id, gram));
    CREATE INDEX IF NOT EXISTS idx_doc_bigrams_gram ON doc_bigrams(gram);
  `);
  // M6-A 迁移（幂等）：doc_tags.source CHECK 加 'db'（CHECK 变更需重建表）+ docs.kind 补列。
  // 老 CHECK 未含 'db' → 重建拷贝；kind 列已存在则 ALTER 报错吞掉。
  const tgSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='doc_tags'").get() as any)?.sql ?? "";
  if (tgSql && !tgSql.includes("'db'")) {
    db.exec(`
      CREATE TABLE doc_tags_new(
        doc_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('frontmatter','inline','path','ui','db')),
        UNIQUE(doc_id, tag_id, source));
      INSERT INTO doc_tags_new(doc_id, tag_id, source) SELECT doc_id, tag_id, source FROM doc_tags;
      DROP TABLE doc_tags;
      ALTER TABLE doc_tags_new RENAME TO doc_tags;`);
  }
  try { db.exec("ALTER TABLE docs ADD COLUMN kind TEXT NOT NULL DEFAULT 'md'"); } catch { /* 已有列 */ }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(SCHEMA_VERSION);
}

// ───────────────────────── M6-A：非 md 文件手工登记（kind='file'）+ db 来源 tag ─────────────────────────

/** 按绝对路径查 docs 行（root+'/'+'relpath' 归一比对）。 */
export function findDocByAbsPath(db: DatabaseSync, abs: string): any {
  const norm = abs.replace(/\\/g, "/").replace(/\/+$/, "");
  const rows = db.prepare("SELECT id, root, relpath, kind, deleted FROM docs WHERE deleted=0").all() as any[];
  for (const r of rows) {
    const full = (String(r.root) + "/" + String(r.relpath)).replace(/\\/g, "/").replace(/\/+$/, "");
    if (full === norm) return r;
  }
  return null;
}

/** 非 md 文件登记（kind='file'，不参与常规扫描枚举/缺失软删）：已存在则复活并返回。 */
export function registerFileDoc(db: DatabaseSync, absPath: string, meta?: { mtimeMs?: number; size?: number }): number {
  const norm = absPath.replace(/\\/g, "/");
  const existing = findDocByAbsPath(db, norm);
  if (existing) {
    db.prepare("UPDATE docs SET deleted=0 WHERE id=?").run(existing.id);
    return existing.id;
  }
  const sep = norm.lastIndexOf("/");
  const root = sep > 0 ? norm.slice(0, sep) : "/";
  const rel = sep > 0 ? norm.slice(sep + 1) : norm;
  const now = Date.now();
  const ins = db.prepare(
    "INSERT INTO docs(root, relpath, title, mtime_ms, size, hash, deleted, indexed_at, kind) VALUES(?,?,?,COALESCE(?,?),COALESCE(?,?),?,0,?,'file')"
  ).run(root, rel, rel.split("/").pop() || rel, meta?.mtimeMs ?? null, meta?.size ?? null, "file:" + norm + ":" + now, now);
  return Number(ins.lastInsertRowid);
}

/** 加 db 来源 tag（统一词表 normalizeTag；幂等）。 */
export function addDbTag(db: DatabaseSync, docId: number, rawKey: string): { key: string; display: string } | null {
  const t = normalizeTag(rawKey);
  if (!t) return null;
  const tagRow = db.prepare("INSERT INTO tags(key, display) VALUES(?, ?) ON CONFLICT(key) DO NOTHING RETURNING id").get(t.key, t.display) as any;
  const tagId = tagRow?.id ?? (db.prepare("SELECT id FROM tags WHERE key=?").get(t.key) as any)?.id;
  if (!tagId) return null;
  db.prepare("INSERT OR IGNORE INTO doc_tags(doc_id, tag_id, source) VALUES(?,?,'db')").run(docId, tagId);
  return { key: t.key, display: t.display };
}

/** 删 db 来源 tag；kind='file' 文档在无任何 db tag 后软删退出索引（M6 验收：tombstone）。 */
export function removeDbTag(db: DatabaseSync, docId: number, rawKey: string): boolean {
  const key = normalizeTag(rawKey)?.key;
  if (!key) return false;
  const tagRow = db.prepare("SELECT id FROM tags WHERE key=?").get(key) as any;
  if (!tagRow) return false;
  db.prepare("DELETE FROM doc_tags WHERE doc_id=? AND tag_id=? AND source='db'").run(docId, tagRow.id);
  const kind = (db.prepare("SELECT kind FROM docs WHERE id=?").get(docId) as any)?.kind;
  if (kind === "file") {
    const left = db.prepare("SELECT COUNT(*) c FROM doc_tags WHERE doc_id=? AND source='db'").get(docId) as any;
    if ((left?.c ?? 0) === 0) {
      db.prepare("UPDATE docs SET deleted=1 WHERE id=?").run(docId);
      db.prepare("DELETE FROM fts WHERE doc_id=?").run(docId);
    }
  }
  return true;
}

function docKey(root: string, rel: string): string {
  return root + KEYSEP + rel;
}

export function compareMap(db: DatabaseSync): Map<string, { id: number; mtimeMs: number; size: number; deleted: number }> {
  const rows = db.prepare("SELECT id, root, relpath, mtime_ms, size, deleted FROM docs").all() as any[];
  const map = new Map<string, any>();
  for (const r of rows) map.set(docKey(r.root, r.relpath), { id: r.id, mtimeMs: r.mtime_ms, size: r.size, deleted: r.deleted });
  return map;
}

export interface UpsertRec {
  root: string; rel: string; mtimeMs: number; size: number; hash: string;
  parsed: ParsedDoc; pathTags: string[];
}

/** 幂等 upsert：复活软删 / rename 同 hash 继承；重建 tags 与 fts 行。返回 doc_id。 */
export function upsertDoc(db: DatabaseSync, rec: UpsertRec): number {
  const now = Date.now();
  db.exec("BEGIN");
  try {
    let id = 0;
    const row = db.prepare("SELECT id FROM docs WHERE root=? AND relpath=?").get(rec.root, rec.rel) as any;
    if (row) {
      id = row.id;
      db.prepare("UPDATE docs SET deleted=0 WHERE id=?").run(id); // 文件回归复活
    } else {
      const rn = db.prepare("SELECT id FROM docs WHERE root=? AND hash=? AND deleted=1 ORDER BY indexed_at DESC LIMIT 1").get(rec.root, rec.hash) as any;
      if (rn) { // rename/move：继承 doc_tags/doc_sessions（同 doc_id）
        id = rn.id;
        db.prepare("UPDATE docs SET relpath=?, deleted=0 WHERE id=?").run(rec.rel, id);
        db.prepare("DELETE FROM doc_tags WHERE doc_id=?").run(id);  // tags 由新内容重建（路径 tag 可能变）
        db.prepare("DELETE FROM doc_links WHERE from_id=?").run(id);
      } else {
        const ins = db.prepare("INSERT INTO docs(root, relpath, deleted, indexed_at) VALUES(?,?,0,?)").run(rec.root, rec.rel, now);
        id = Number(ins.lastInsertRowid);
      }
    }
    // tag 三来源归一化
    const tagSet: { key: string; display: string; source: string }[] = [];
    const push = (raw: string, source: string) => {
      const n = normalizeTag(raw);
      if (n && !tagSet.some((t) => t.key === n.key && t.source === source)) tagSet.push({ ...n, source });
    };
    for (const tg of rec.parsed.fmTags) push(tg, "frontmatter");
    for (const tg of rec.parsed.inlineTags) push(tg, "inline");
    for (const tg of rec.pathTags) push(tg, "path");
    db.prepare("DELETE FROM doc_tags WHERE doc_id=?").run(id);
    const ensureTag = db.prepare("INSERT OR IGNORE INTO tags(key, display) VALUES(?, ?)");
    const getTag = db.prepare("SELECT id FROM tags WHERE key=?");
    const insDT = db.prepare("INSERT OR IGNORE INTO doc_tags(doc_id, tag_id, source) VALUES(?,?,?)");
    for (const t of tagSet) {
      ensureTag.run(t.key, t.display);
      const tr = getTag.get(t.key) as any;
      insDT.run(id, tr.id, t.source);
    }
    db.prepare("UPDATE docs SET title=?, mtime_ms=?, size=?, hash=?, headings_json=?, links_json=?, word_count=?, indexed_at=? WHERE id=?")
      .run(rec.parsed.title ?? null, rec.mtimeMs, rec.size, rec.hash,
        JSON.stringify(rec.parsed.headings), JSON.stringify(rec.parsed.links), rec.parsed.wordCount, now, id);
    db.prepare("DELETE FROM fts WHERE doc_id=?").run(id);
    db.prepare("INSERT INTO fts(title, headings, tags_text, body, path, doc_id) VALUES(?,?,?,?,?,?)")
      .run(rec.parsed.title ?? "", rec.parsed.headings.map((h) => h.text).join(" "),
        tagSet.map((t) => t.key).join(" "), rec.parsed.body, rec.root + "/" + rec.rel, id);
    // 短词倒排（trigram 匹配不到 <3 码点词；源=标题+标题列表+正文，与 fts 同源重建）
    db.prepare("DELETE FROM doc_bigrams WHERE doc_id=?").run(id);
    const gramSrc = (rec.parsed.title ?? "") + "\n" + rec.parsed.headings.map((h) => h.text).join("\n") + "\n" + rec.parsed.body;
    const grams = [...extractBigrams(gramSrc)];
    if (grams.length) {
      const insG = db.prepare("INSERT OR IGNORE INTO doc_bigrams(doc_id, gram) VALUES(?,?)");
      for (const g of grams) insG.run(id, g);
    }
    db.exec("COMMIT");
    return id;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
}

/** 枚举后：盘上消失的文档置软删（保留 sessions/tags 供 rename 继承），并清 fts 行。 */
export function markMissingDeleted(db: DatabaseSync, seenKeys: Set<string>): number {
  // kind='file'（M6-A 手工登记的非 md 文档）不参与常规扫描枚举 → 不因「扫描未见」被误杀
  const rows = db.prepare("SELECT id, root, relpath FROM docs WHERE deleted=0 AND kind != 'file'").all() as any[];
  const del = db.prepare("UPDATE docs SET deleted=1 WHERE id=?");
  const delFts = db.prepare("DELETE FROM fts WHERE doc_id=?");
  let n = 0;
  for (const r of rows) {
    if (!seenKeys.has(docKey(r.root, r.relpath))) { del.run(r.id); delFts.run(r.id); n++; }
  }
  return n;
}

/** 软删超期物理清理（默认 30 天，调用方传 beforeMs）。 */
export function purgeExpired(db: DatabaseSync, beforeMs: number): number {
  const rows = db.prepare("SELECT id FROM docs WHERE deleted=1 AND indexed_at < ?").all(beforeMs) as any[];
  for (const r of rows) {
    db.prepare("DELETE FROM doc_tags WHERE doc_id=?").run(r.id);
    db.prepare("DELETE FROM doc_links WHERE from_id=? OR to_id=?").run(r.id, r.id);
    db.prepare("DELETE FROM doc_sessions WHERE doc_id=?").run(r.id);
    db.prepare("DELETE FROM fts WHERE doc_id=?").run(r.id);
    db.prepare("DELETE FROM docs WHERE id=?").run(r.id);
  }
  return rows.length;
}

export function markOneDeleted(db: DatabaseSync, root: string, rel: string): boolean {
  const r = db.prepare("SELECT id FROM docs WHERE root=? AND relpath=? AND deleted=0").get(root, rel) as any;
  if (!r) return false;
  db.prepare("UPDATE docs SET deleted=1 WHERE id=?").run(r.id);
  db.prepare("DELETE FROM fts WHERE doc_id=?").run(r.id);
  return true;
}

/** 解析单条引用 → doc_id（0 = dangling）。 */
export function resolveLink(lk: RawLink, docRoot: string, docRel: string, byKey: Map<string, number>, roots: string[]): number {
  const t = lk.target.replace(/\\/g, "/");
  if (t.startsWith("/") || t.startsWith("~")) {
    const abs = resolveAbs(t, roots);
    return abs ? (byKey.get(docKey(abs.root, abs.rel)) ?? 0) : 0;
  }
  const tryCands = (tt: string) => {
    for (const c of linkCandidates(tt, docRel)) {
      const id = byKey.get(docKey(docRoot, c));
      if (id) return id;
    }
    return 0;
  };
  let id = tryCands(t);
  if (!id && !/\.(md|markdown)$/i.test(t)) id = tryCands(t + ".md"); // [[wiki名]] 补 .md
  return id;
}

/** 全量重建引用边（解析态 links_json → doc_links；dangling 不入）。 */
export function rebuildAllLinks(db: DatabaseSync, roots: string[]): { edges: number; dangling: number } {
  const docs = db.prepare("SELECT id, root, relpath, links_json FROM docs WHERE deleted=0").all() as any[];
  const byKey = new Map<string, number>();
  for (const d of docs) byKey.set(docKey(d.root, d.relpath), d.id);
  db.exec("DELETE FROM doc_links");
  const ins = db.prepare("INSERT OR REPLACE INTO doc_links(from_id, to_id, weight) VALUES(?,?,?)");
  const counts = new Map<string, number>();
  let dangling = 0;
  for (const d of docs) {
    let links: RawLink[] = [];
    try { links = JSON.parse(d.links_json || "[]"); } catch { /* 坏行容忍 */ }
    for (const lk of links) {
      const toId = resolveLink(lk, d.root, d.relpath, byKey, roots);
      if (!toId) { dangling++; continue; }
      if (toId === d.id) continue; // 自链不计
      const k = d.id + KEYSEP + toId;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of counts) {
    const parts = k.split(KEYSEP);
    ins.run(Number(parts[0]), Number(parts[1]), Math.min(n, 5));
  }
  return { edges: counts.size, dangling };
}

/** PageRank（damping 0.85，悬挂均摊，L1<1e-7 或 30 轮），写回 rank/rank_norm。 */
export function computeRank(db: DatabaseSync): void {
  const ids = (db.prepare("SELECT id FROM docs WHERE deleted=0").all() as any[]).map((r) => r.id);
  const N = ids.length;
  if (!N) return;
  const idx = new Map<number, number>(ids.map((id, i) => [id, i]));
  const out = new Float64Array(N);
  const edges: { f: number; t: number; w: number }[] = [];
  for (const e of db.prepare("SELECT from_id, to_id, weight FROM doc_links").all() as any[]) {
    const f = idx.get(e.from_id);
    const t = idx.get(e.to_id);
    if (f === undefined || t === undefined) continue;
    edges.push({ f, t, w: e.weight });
    out[f] += e.weight;
  }
  const d = 0.85;
  let r = new Float64Array(N).fill(1 / N);
  const base = (1 - d) / N;
  for (let it = 0; it < 30; it++) {
    let danglingMass = 0;
    for (let i = 0; i < N; i++) if (out[i] === 0) danglingMass += r[i];
    const nr = new Float64Array(N).fill(base + (d * danglingMass) / N);
    for (const e of edges) nr[e.t] += (d * r[e.f] * e.w) / out[e.f];
    let diff = 0;
    for (let i = 0; i < N; i++) diff += Math.abs(nr[i] - r[i]);
    r = nr;
    if (diff < 1e-7) break;
  }
  let max = 0;
  for (const v of r) if (v > max) max = v;
  const setR = db.prepare("UPDATE docs SET rank=?, rank_norm=? WHERE id=?");
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) setR.run(r[i], max > 0 ? r[i] / max : 0, ids[i]);
  db.exec("COMMIT");
}

// ───────────────────────── 查询 ─────────────────────────

export interface TagRef { key: string; display: string; source: string }
export interface DocItem {
  id: number; root: string; relpath: string; title: string;
  mtimeMs: number; size: number; rankNorm: number;
  tags: TagRef[]; snippet?: string; score?: number;
  /** sort=smart 时的综合分（[0,1]，公式见 smartScoreBrowse/Search；docs/aiti-doc-center-smart-ranking-plan.md §3） */
  smartScore?: number;
}
export interface Facet { key: string; display: string; count: number }
export interface QueryResult { items: DocItem[]; total: number; facets: Facet[] }

export interface QueryOpts {
  q?: string; tag?: string; dir?: string;
  sort?: string; limit?: number; offset?: number; withSnippet?: boolean;
  /** 动态 tag 层（方案绑定/会话继承）命中并集：与静态 tag 过滤 OR（§4.7，不入 doc_tags） */
  extraTagIds?: number[];
  /** 多选 tag（AND 语义）：每个集合 = 该 tag 命中的 doc_id 并集（静态+动态，由调用方解析）；任一空集 → 零结果 */
  tagIdSets?: number[][];
  /** workspace 过滤：绝对路径前缀（root+relpath 前缀匹配，默认当前会话 workspace） */
  under?: string;
  /** sort=smart 的方案绑定集合（小写绝对路径；plan 数据在扩展层不入库，调用方传入） */
  planPaths?: Set<string>;
  /** smart 排序权重（缺省 DEFAULT_SMART_WEIGHTS；index.ts 从 features.json rank.* 读入） */
  smart?: SmartWeights;
}

// ───────────────────────── smart 综合排序（docs/aiti-doc-center-smart-ranking-plan.md §3） ─────────────────────────

export interface SmartWeights {
  now: number; halfLifeDays: number;
  wFresh: number; wRank: number; wPlan: number;
  /** 有 q 时相关性权重（fresh/rank 平分余量）；无 q 浏览不用 */
  wRel?: number;
}

export function defaultSmartWeights(): SmartWeights {
  return { now: Date.now(), halfLifeDays: 45, wFresh: 0.45, wRank: 0.35, wPlan: 0.2, wRel: 0.7 };
}

/** 新鲜度：半衰期指数衰减（ES decay 的 exp 形态），1 天≈0.985 · 1 周≈0.90 · 1 月≈0.63（halfLife=45d） */
export function freshDecay(mtimeMs: number, now: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, now - mtimeMs) / 86400000;
  const hl = halfLifeDays > 0 ? halfLifeDays : 45;
  return Math.pow(0.5, ageDays / hl);
}

/** 浏览视图（无 q）：score = wFresh·fresh + wRank·rank_norm + wPlan·isPlan */
export function smartScoreBrowse(mtimeMs: number, rankNorm: number, isPlan: boolean, w: SmartWeights): number {
  return w.wFresh * freshDecay(mtimeMs, w.now, w.halfLifeDays)
    + w.wRank * (rankNorm || 0)
    + w.wPlan * (isPlan ? 1 : 0);
}

/** 搜索视图（有 q）：score = wRel·relNorm(fused min-max) + 余量均分给 fresh/rank —— 相关性主导（QDF 共识） */
export function smartScoreSearch(
  fused: number, fusedMin: number, fusedMax: number,
  mtimeMs: number, rankNorm: number, w: SmartWeights,
): number {
  const span = Math.max(fusedMax - fusedMin, 1e-9);
  const relNorm = (fused - fusedMin) / span;
  const wRel = w.wRel === undefined ? 0.7 : w.wRel;
  const rest = (1 - wRel) / 2;
  return wRel * relNorm + rest * freshDecay(mtimeMs, w.now, w.halfLifeDays) + rest * (rankNorm || 0);
}

function sortSql(sort: string | undefined): string {
  switch (sort) {
    case "title": return "d.title COLLATE NOCASE ASC";
    case "rank": return "d.rank_norm DESC, d.mtime_ms DESC";
    case "rel": return "d.rank_norm DESC, d.mtime_ms DESC"; // 无 q 时 rel 退化为 rank
    default: return "d.mtime_ms DESC";
  }
}

function fetchTagsForIds(db: DatabaseSync, ids: number[]): Map<number, TagRef[]> {
  const map = new Map<number, TagRef[]>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const inQ = chunk.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT dt.doc_id, tg.key, tg.display, dt.source FROM doc_tags dt
       JOIN tags tg ON tg.id = dt.tag_id WHERE dt.doc_id IN (${inQ})
       ORDER BY dt.doc_id, dt.rowid`).all(...chunk) as any[];
    for (const r of rows) {
      const arr = map.get(r.doc_id) ?? [];
      arr.push({ key: r.key, display: r.display, source: r.source });
      map.set(r.doc_id, arr);
    }
  }
  return map;
}

function facetTags(db: DatabaseSync, ids: number[]): Facet[] {
  const counts = new Map<string, Facet>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const inQ = chunk.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT tg.key, tg.display, COUNT(DISTINCT dt.doc_id) c FROM doc_tags dt
       JOIN tags tg ON tg.id = dt.tag_id WHERE dt.doc_id IN (${inQ})
       GROUP BY tg.id`).all(...chunk) as any[];
    for (const r of rows) {
      const prev = counts.get(r.key);
      if (prev) prev.count += r.c;
      else counts.set(r.key, { key: r.key, display: r.display, count: r.c });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 24);
}

export function queryDocs(db: DatabaseSync, opts: QueryOpts): QueryResult {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = String(opts.q ?? "").trim();
  const conds: string[] = ["d.deleted=0"];
  let params: any[] = [];
  if (opts.tag) {
    const key = opts.tag.toLowerCase();
    const sub = `(SELECT dt.doc_id FROM doc_tags dt JOIN tags tg ON tg.id=dt.tag_id
      WHERE tg.key=? OR substr(tg.key, 1, length(?)+1) = ? || '/')`;
    if (opts.extraTagIds?.length) {
      conds.push(`(d.id IN ${sub} OR d.id IN (${opts.extraTagIds.slice(0, 5000).map(Number).join(",")}))`);
    } else {
      conds.push(`d.id IN ${sub}`);
    }
    params.push(key, key, key);
  }
  if (opts.dir) {
    const dir = opts.dir.replace(/\/+$/, "");
    conds.push("substr(d.relpath, 1, ?) = ?");
    params.push(dir.length + 1, dir + "/");
  }
  if (opts.under) {
    const u = opts.under.replace(/[\\%_]/g, (ch) => "\\" + ch).replace(/\/+$/, "");
    conds.push("(d.root || '/' || d.relpath) LIKE ? ESCAPE '\\'");
    params.push(u + "/%");
  }
  let rows: any[] = [];
  let total = 0;
  let allIds: number[] = [];
  if (opts.tagIdSets?.length) {
    for (const set of opts.tagIdSets) {
      if (!set.length) return { items: [], total: 0, facets: [] }; // AND 语义：一个 tag 零命中即空
      conds.push(`d.id IN (${set.slice(0, 5000).map(Number).join(",")})`);
    }
  }
  // 词级长短分类：trigram FTS 只匹配 ≥3 码点的词；<3 码点（如 2 字中文词）匹配不到，
  // 短词走 doc_bigrams 精确索引（2 码点）或 title/relpath LIKE（1 码点，字段短、快）。
  const words = q.split(/\s+/).filter(Boolean);
  const longWords = words.filter((w) => [...w].length >= 3);
  const shortWords = words.filter((w) => [...w].length < 3);
  const useFts = longWords.length > 0;
  const escLike = (s: string) => s.replace(/[\\%_]/g, (ch) => "\\" + ch);
  // §4.9 文件名优先：fts/bigrams 索引不含 relpath（path 列 UNINDEXED、gramSrc 无 relpath），
  // 2 字中文文件名关键词（方案/计划/模型…）搜不到、≥3 字符文件名关键词依赖 title≈文件名才命中。
  // 这里把「所有词都命中 relpath/title」作为与正文匹配并列的 OR 路径：
  //   - nameCond：词级 AND（每个词都要在 relpath 或 title 里），escLike 防 %_ 通配注入
  //   - nameHit：排序加权——全词命中 relpath=3 / 全词命中 title=2，使文件名命中组排在纯正文命中前
  const nameWords = words.length ? words : [];
  const nameConds = nameWords.map(() => "(d.relpath LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')");
  const nameParams = nameWords.flatMap((w) => {
    const like = "%" + escLike(w) + "%";
    return [like, like];
  });
  const nameCond = nameConds.length ? nameConds.join(" AND ") : "";
  const nameHit = (r: any): number => {
    if (!nameWords.length) return 0;
    const rp = String(r.relpath ?? "").toLowerCase();
    const ti = String(r.title ?? "").toLowerCase();
    const allIn = (s: string) => nameWords.every((w) => s.includes(w.toLowerCase()));
    return (allIn(rp) ? 3 : 0) + (allIn(ti) ? 2 : 0);
  };
  // smart 排序共用：方案命中（planPaths 归一化小写绝对路径集合，条目大小写不敏感）+ 权重
  const planSet = opts.planPaths && opts.planPaths.size
    ? new Set([...opts.planPaths].map((p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()))
    : null;
  const isPlanRow = (r: any): boolean => {
    if (!planSet) return false;
    const abs = String(r.root ?? "") + "/" + String(r.relpath ?? "");
    return planSet.has(abs.replace(/\\/g, "/").toLowerCase());
  };
  const smartW = (): SmartWeights => opts.smart ?? defaultSmartWeights();
  if (q) {
    if (useFts) {
      const matchExpr = longWords.map((w) => '"' + w.replace(/"/g, '""') + '"').join(" AND ");
      // 短词（trigram 匹配不到）：2 码点走 doc_bigrams（正文 AND）；1 码点无正文索引路径 → 只进名字路径
      const shortConds: string[] = [];
      const shortParams: any[] = [];
      for (const w of shortWords) {
        if ([...w].length === 2) {
          const g = [...extractBigrams(w)][0];
          if (g) { shortConds.push("d.id IN (SELECT doc_id FROM doc_bigrams WHERE gram=?)"); shortParams.push(g); }
        }
      }
      const snip = opts.withSnippet ? ", snippet(fts, 3, '<mark>', '</mark>', '…', 12) AS snip" : "";
      // 正文路径：fts MATCH（长词）+ 2 码点短词 bigram + 过滤（与旧语义一致）
      const bodyWhere = ["fts MATCH ?", ...shortConds, ...conds].join(" AND ");
      const bodyRows = db.prepare(
        `SELECT d.id, d.root, d.relpath, d.title, d.mtime_ms, d.size, d.rank_norm, bm25(fts) AS b25 ${snip}
         FROM fts JOIN docs d ON d.id = fts.doc_id
         WHERE ${bodyWhere}`).all(matchExpr, ...shortParams, ...params) as any[];
      // 名字路径：所有词命中 relpath/title——MATCH 不能与 LIKE 直接 OR（SQLite 限制），拆两次查询 JS 合并
      const nameRows = nameCond ? db.prepare(
        `SELECT d.id, d.root, d.relpath, d.title, d.mtime_ms, d.size, d.rank_norm, NULL AS b25, NULL AS snip
         FROM docs d WHERE (${nameCond}) AND ${conds.join(" AND ")}`).all(...nameParams, ...params) as any[] : [];
      const byId = new Map<any, any>();
      for (const r of bodyRows) byId.set(r.id, r);            // 正文路径优先（带 b25/snippet）
      for (const r of nameRows) if (!byId.has(r.id)) byId.set(r.id, r);
      rows = [...byId.values()];
      total = rows.length;
      allIds = rows.map((r) => r.id);
      const sort = opts.sort ?? "rel";
      const fused = (r: any) => (r.b25 != null ? -r.b25 : -(r.rank_norm ?? 0)) + 0.3 * (r.rank_norm ?? 0);
      if (sort === "mtime") rows.sort((a, b) => b.mtime_ms - a.mtime_ms);
      else if (sort === "title") rows.sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? "")));
      else if (sort === "rank") rows.sort((a, b) => b.rank_norm - a.rank_norm);
      else if (sort === "smart") {
        // 相关性主导（§3.2）：0.7·relNorm + 0.15·fresh + 0.15·rank
        const w = smartW();
        const fusedVals = rows.map(fused);
        const fMin = Math.min(...fusedVals);
        const fMax = Math.max(...fusedVals);
        for (const r of rows) r._smart = smartScoreSearch(fused(r), fMin, fMax, r.mtime_ms, r.rank_norm ?? 0, w);
        rows.sort((a, b) => (b._smart - a._smart) || (b.mtime_ms - a.mtime_ms) || (a.id - b.id));
      }
      else rows.sort((a, b) => (nameHit(b) - nameHit(a)) || (fused(b) - fused(a))); // rel = 文件名/标题优先 + 融合分（§4.9）
      rows = rows.slice(offset, offset + limit);
    } else {
      // 全短词：2 码点走 doc_bigrams（正文，精确、走 gram 索引）；1 码点无正文索引路径；
      // 文件名/标题匹配统一由 nameCond 承担（relpath/title 短字段 LIKE，快）。
      // 不再对 fts 虚拟表正文 LIKE——901MB 库上 `fts.body LIKE '%词%'` 是 279s 级全表扫描（实测）。
      const bigrams: string[] = [];
      for (const w of shortWords) {
        if ([...w].length === 2) {
          const g = [...extractBigrams(w)][0];
          if (g) bigrams.push(g);
        }
      }
      let qBlock = "";
      const qParams: any[] = [];
      if (bigrams.length) {
        if (bigrams.length === 1) {
          qBlock = "d.id IN (SELECT doc_id FROM doc_bigrams WHERE gram=?)";
          qParams.push(bigrams[0]);
        } else {
          const qs = bigrams.map(() => "?").join(",");
          qBlock = `d.id IN (SELECT doc_id FROM doc_bigrams WHERE gram IN (${qs}) GROUP BY doc_id HAVING COUNT(DISTINCT gram)=${bigrams.length})`;
          qParams.push(...bigrams);
        }
      }
      const whereQ = qBlock ? `((${qBlock}) OR (${nameCond}))` : `(${nameCond})`;
      const allParams = [...qParams, ...nameParams, ...params];
      total = (db.prepare(`SELECT COUNT(*) c FROM docs d WHERE ${whereQ} AND ${conds.join(" AND ")}`).get(...allParams) as any).c;
      const s = opts.sort ?? "rel";
      rows = db.prepare(
        `SELECT d.id, d.root, d.relpath, d.title, d.mtime_ms, d.size, d.rank_norm
         FROM docs d WHERE ${whereQ} AND ${conds.join(" AND ")}`).all(...allParams) as any[];
      allIds = rows.map((r) => r.id);
      // JS 排序 + 分页（SQL 侧不再 ORDER BY/LIMIT——文件名/标题加权需 JS 算，命中量小）
      if (s === "mtime") rows.sort((a, b) => b.mtime_ms - a.mtime_ms);
      else if (s === "title") rows.sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? "")));
      else if (s === "rank") rows.sort((a, b) => b.rank_norm - a.rank_norm);
      else if (s === "smart") {
        // 全短词无 bm25 相关性 → 退化浏览公式（fresh/rank/plan 加权）
        const w = smartW();
        for (const r of rows) r._smart = smartScoreBrowse(r.mtime_ms, r.rank_norm ?? 0, isPlanRow(r), w);
        rows.sort((a, b) => (b._smart - a._smart) || (b.mtime_ms - a.mtime_ms) || (a.id - b.id));
      }
      else rows.sort((a, b) => (nameHit(b) - nameHit(a)) || (b.rank_norm - a.rank_norm) || (b.mtime_ms - a.mtime_ms)); // rel = 文件名/标题优先 + rank 融合（§4.9）
      rows = rows.slice(offset, offset + limit);
    }
  } else {
    total = (db.prepare(`SELECT COUNT(*) c FROM docs d WHERE ${conds.join(" AND ")}`).get(...params) as any).c;
    const s = opts.sort ?? "rel";
    if (s === "smart") {
      // 浏览视图综合分（§3.2）：全量拉基础行 JS 计分排序（数千内 <10ms；数万级再上 SQL 预剪枝）
      rows = db.prepare(
        `SELECT d.id, d.root, d.relpath, d.title, d.mtime_ms, d.size, d.rank_norm
         FROM docs d WHERE ${conds.join(" AND ")}`).all(...params) as any[];
      const w = smartW();
      for (const r of rows) r._smart = smartScoreBrowse(r.mtime_ms, r.rank_norm ?? 0, isPlanRow(r), w);
      rows.sort((a, b) => (b._smart - a._smart) || (b.mtime_ms - a.mtime_ms) || (a.id - b.id));
      rows = rows.slice(offset, offset + limit);
    } else {
      rows = db.prepare(
        `SELECT d.id, d.root, d.relpath, d.title, d.mtime_ms, d.size, d.rank_norm
         FROM docs d WHERE ${conds.join(" AND ")} ORDER BY ${sortSql(opts.sort)} LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as any[];
    }
    allIds = rows.map((r) => r.id);
  }
  const tagsById = fetchTagsForIds(db, rows.map((r) => r.id));
  const items: DocItem[] = rows.map((r) => ({
    id: r.id,
    root: r.root,
    relpath: r.relpath,
    title: r.title || r.relpath.split("/").pop() || r.relpath,
    mtimeMs: r.mtime_ms,
    size: r.size,
    rankNorm: r.rank_norm,
    tags: tagsById.get(r.id) ?? [],
    snippet: r.snip ?? undefined,
    score: r.b25 !== undefined ? -r.b25 + 0.3 * (r.rank_norm ?? 0) : undefined,
    smartScore: r._smart ?? undefined,
  }));
  return { items, total, facets: facetTags(db, allIds) };
}

export function searchSnippets(db: DatabaseSync, q: string, limit = 10): QueryResult {
  return queryDocs(db, { q, withSnippet: true, sort: "rel", limit });
}

// ───────────────────────── tags 视图 ─────────────────────────

export function tagsAll(db: DatabaseSync, under?: string): { key: string; display: string; count: number; tier: number }[] {
  const u = under ? under.replace(/[\\%_]/g, (ch) => "\\" + ch).replace(/\/+$/, "") + "/%" : "";
  // tier = 来源重要度（§tag 云排序）：用户手打(frontmatter/ui/db)=0 < inline=2 < path=4（取最小）
  const rows = db.prepare(
    `SELECT tg.key, tg.display, COUNT(DISTINCT dt.doc_id) c,
            MIN(CASE dt.source WHEN 'frontmatter' THEN 0 WHEN 'ui' THEN 0 WHEN 'db' THEN 0
                WHEN 'plan' THEN 1 WHEN 'inline' THEN 2 WHEN 'session' THEN 3 ELSE 4 END) tier
     FROM tags tg
     JOIN doc_tags dt ON dt.tag_id = tg.id
     JOIN docs d ON d.id = dt.doc_id AND d.deleted = 0
     ${u ? "WHERE (d.root || '/' || d.relpath) LIKE ? ESCAPE '\\'" : ""}
     GROUP BY tg.id ORDER BY c DESC, tg.key`).all(...(u ? [u] : [])) as any[];
  return rows.map((r) => ({ key: r.key, display: r.display, count: r.c, tier: r.tier ?? 4 }));
}

export interface TagTreeNode { key: string; display: string; count: number; children: TagTreeNode[]; tier?: number; src?: string }

export function tagTree(flat: { key: string; display: string; count: number; tier?: number }[]): TagTreeNode[] {
  const root: TagTreeNode[] = [];
  const byKey = new Map<string, TagTreeNode>();
  for (const f of flat) {
    const segs = f.key.split("/");
    let acc = "";
    let level = root;
    for (const seg of segs) {
      acc = acc ? acc + "/" + seg : seg;
      let cur = byKey.get(acc);
      if (!cur) {
        cur = { key: acc, display: seg, count: 0, children: [], tier: f.tier };
        byKey.set(acc, cur);
        level.push(cur);
      }
      if (f.tier !== undefined && (cur.tier === undefined || f.tier < cur.tier)) cur.tier = f.tier; // 父节点取子树最小 tier
      level = cur.children;
    }
    const leaf = byKey.get(f.key);
    if (leaf) leaf.count = f.count;
  }
  const sortRec = (ns: TagTreeNode[]) => {
    ns.sort((a, b) => (a.tier ?? 4) - (b.tier ?? 4) || b.count - a.count || a.display.localeCompare(b.display));
    ns.forEach((n) => sortRec(n.children));
  };
  sortRec(root);
  return root;
}

// ───────────────────────── 详情 ─────────────────────────

export function docDetail(db: DatabaseSync, id: number, roots: string[]) {
  const d = db.prepare(
    `SELECT id, root, relpath, title, mtime_ms, size, hash, headings_json, links_json,
            word_count, deleted, indexed_at, rank, rank_norm FROM docs WHERE id=?`).get(id) as any;
  if (!d) return null;
  const tags = fetchTagsForIds(db, [id]).get(id) ?? [];
  const sessions = db.prepare(
    "SELECT session_id, first_op, last_op, op_count FROM doc_sessions WHERE doc_id=? ORDER BY last_op DESC").all(id);
  const backlinks = db.prepare(
    `SELECT d2.id, d2.root, d2.relpath, d2.title, l.weight FROM doc_links l
     JOIN docs d2 ON d2.id = l.from_id WHERE l.to_id=? AND d2.deleted=0 ORDER BY l.weight DESC`).all(id);
  const outlinks = db.prepare(
    `SELECT d2.id, d2.root, d2.relpath, d2.title, l.weight FROM doc_links l
     JOIN docs d2 ON d2.id = l.to_id WHERE l.from_id=? AND d2.deleted=0 ORDER BY l.weight DESC`).all(id);
  const byKey = new Map<string, number>();
  for (const r of db.prepare("SELECT id, root, relpath FROM docs WHERE deleted=0").all() as any[]) {
    byKey.set(docKey(r.root, r.relpath), r.id);
  }
  let links: RawLink[] = [];
  try { links = JSON.parse(d.links_json || "[]"); } catch { /* 容忍 */ }
  const externals: string[] = [];
  for (const lk of links) {
    const toId = resolveLink(lk, d.root, d.relpath, byKey, roots);
    if (!toId) externals.push(lk.kind === "at" ? "@" + lk.target : lk.target);
  }
  return {
    id: d.id, root: d.root, relpath: d.relpath,
    title: d.title || d.relpath.split("/").pop(),
    mtimeMs: d.mtime_ms, size: d.size, hash: d.hash,
    headings: JSON.parse(d.headings_json || "[]"),
    wordCount: d.word_count, deleted: d.deleted, indexedAt: d.indexed_at,
    rank: d.rank, rankNorm: d.rank_norm,
    tags, sessions, backlinks, outlinks, externals,
  };
}
