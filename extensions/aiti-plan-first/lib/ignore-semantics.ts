/**
 * ignore 语义共享模块（.gitignore / .aitiignore / .dockerignore 实用子集）
 *
 * ⭐ 权威源：本文件。副本同步至消费扩展（改这里务必三处同步）：
 *   - aiti-doc-center/lib/ignore-semantics.ts（walkFiles 收集器）
 *   - aiti-plan-first/lib/ignore-semantics.ts（选择器 fs walk 兜底 + session-md .aitiignore 过滤）
 *   - aiti-git-trace 不用本模块（.gitignore/.aitiignore 经 git 排除机制：ls-files
 *     --exclude-standard / --exclude-per-directory，见其 §16.3 listMd v2）
 *
 * 语义（gitignore 实用子集，Linux 大小写敏感）：
 *   - `#` 注释、空行跳过；`!` 负规则（后命中覆盖先行）
 *   - 尾 `/` 仅目录（目录与其内容经 (?:/.*)? 一并命中）
 *   - 含 `/`（含首 `/`）= 锚定到 ignore 文件所在目录；无斜杠 = 任意深度 basename
 *   - 「两个星号 + 斜杠」前缀 = 任意深度；中段同款 = 零或多目录；尾段 = 目录下任意；星/问号 = 单层通配
 *   - 分段构建保证段边界（skills 通配不误吞 skillsfoo；a 加双星加 b 不误吞 a 加 xb）
 *
 * API：
 *   compileIgnoreGlob(glob)            单条 glob → RegExp
 *   compileIgnoreLines(text)           多行 ignore 文本 → IgnoreRule[]
 *   matchRules(rules, rel)             后命中覆盖先行；null = 无规则命中（调用方决定默认值）
 */

export interface IgnoreRule { neg: boolean; dirOnly: boolean; re: RegExp }

function escSeg(seg: string): string {
  let r = "";
  for (const ch of seg) {
    if (ch === "*") r += "[^/]*";
    else if (ch === "?") r += "[^/]";
    else r += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return r;
}

/** 单条 gitignore 式 glob → 正则（分段构建保证段边界） */
export function compileIgnoreGlob(glob: string): RegExp {
  let body = glob;
  let pre = "";
  let tail = "(?:/.*)?";
  if (body === "**") return /^.*$/;
  const anchored = body.includes("/");
  if (body.endsWith("/**")) { body = body.slice(0, -3); tail = "/.*"; }
  else if (body.endsWith("/")) { body = body.slice(0, -1); tail = "/.*"; }
  if (!anchored) pre += "(?:.*/)?"; // 无斜杠 → 任意深度
  if (body.startsWith("**/")) { pre += "(?:.*/)?"; body = body.slice(3); }
  else if (body.startsWith("**")) { pre += ".*"; body = body.slice(2); }
  if (!body) return new RegExp("^" + pre + (tail === "/.*" ? "/.*" : "") + "$");
  if (body.startsWith("/")) body = body.slice(1); // 锚定：去根斜杠（/sub/x.md → sub/x.md）
  const segs = body.split("/**/");
  return new RegExp("^" + pre + segs.map(escSeg).join("(?:.*/)?") + tail + "$");
}


export function compileIgnoreLines(text: string): IgnoreRule[] {
  const out: IgnoreRule[] = [];
  for (let raw of String(text || "").split(/\r?\n/)) {
    raw = raw.replace(/\s+$/, "");
    if (!raw || raw.startsWith("#")) continue;
    let neg = false;
    if (raw.startsWith("!")) { neg = true; raw = raw.slice(1); }
    let dirOnly = raw.endsWith("/");
    if (dirOnly) raw = raw.slice(0, -1);
    if (!raw) continue;
    out.push({ neg, dirOnly, re: compileIgnoreGlob(raw) });
  }
  return out;
}

/** 规则匹配：后命中覆盖先行（含 ! 否定）；无命中返回 null（调用方决定默认值） */
export function matchRules(rules: IgnoreRule[], rel: string): boolean | null {
  let decision: boolean | null = null;
  for (const r of rules) {
    if (r.re.test(rel)) decision = !r.neg;
  }
  return decision;
}
