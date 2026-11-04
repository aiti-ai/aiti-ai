/**
 * 版本引用文本构造（docs/aiti-git-trace-timeline-file-actions-plan.md §3）。
 *
 * 纯函数：无 React、无宿主 ctx 依赖，可直 node:test 单测。
 * buildAtText（@ token 格式：空格加引号、目录尾斜杠）复用 _shared/new-session-cwd
 * （与 aiti-doc-center / 宿主 buildAtMentionText 同源）。
 */
import { buildAtText } from "../../../_shared/new-session-cwd.ts";

export interface VersionMentionInput {
  /** 相对 root 的路径（@ token 用；buildAtText 决定引号格式） */
  path: string;
  /** 原仓 root（绝对路径，构造边路仓 gitDir=<root>/.aiti-trace） */
  root: string;
  /** before commit（完整 hash；可空=首触无基线） */
  base?: string | null;
  /** after commit（完整 hash；可空=loose 工作区无 commit） */
  target?: string | null;
  /** 行号（行级引用用；文件级引用不传） */
  line?: number | null;
  /** 行类型（决定行号归属 + 标注） */
  lineKind?: "new" | "old" | "context" | "hunk" | "other";
}

const SHORT = (h?: string | null): string => (h ? String(h).slice(0, 7) : "");
const trimSlash = (p: string): string => String(p || "").replace(/\/+$/, "");

/**
 * 构造带版本信息的引用文本：@ token（纯路径，宿主可点击解析）+ 附文（边路仓 git 命令）。
 *
 * 关键：after commit 在边路仓 .aiti-trace 里，原工作区仓没有此 commit——AI 在原仓跑 git show
 * 会扑空。故附文给出指向边路仓的完整命令（--git-dir=<root>/.aiti-trace --work-tree=<root>），
 * AI 直接复制可执行，能 show/diff 出历史版本。
 */
export function buildVersionMention(inp: VersionMentionInput): string {
  const at = buildAtText(inp.path);
  const root = trimSlash(inp.root);
  const gitDir = `${root}/.aiti-trace`;
  const target = inp.target || null;
  const base = inp.base || null;
  if (!target) {
    return at + `（⏱ 时间线工作区版本，无边路 commit；可能非当前文件）`;
  }
  const parts: string[] = [`after=${SHORT(target)}`];
  if (base && base !== target) parts.push(`base=${SHORT(base)}`);
  if (inp.line != null) {
    const kindTag = inp.lineKind === "old" ? "(旧文件)" : inp.lineKind === "new" ? "(新文件)" : "";
    parts.push(`行${inp.line}${kindTag}`);
  }
  const showCmd = `git --git-dir=${gitDir} --work-tree=${root} show ${target}:${inp.path}`;
  const diffCmd = (base && base !== target)
    ? `\n或查看区间 diff：\ngit --git-dir=${gitDir} --work-tree=${root} diff ${base}..${target} -- ${inp.path}`
    : "";
  return at + `\n（⏱ 时间线历史版本 ${parts.join(" ")}；非当前文件，边路仓查看：\n${showCmd}${diffCmd}）`;
}

export interface DiffLineInfo {
  line: number | null;
  lineKind: "new" | "old" | "context" | "hunk" | "other";
}

/**
 * 从 unified diff 行列表 + 点击索引，推算行号信息。
 * 解析 `@@ -a,b +c,d @@` hunk 头 + 行前缀（+/−/空）累加。
 * hunk 头之前的行（diff --git / index 等）→ other。
 */
export function resolveDiffLineInfo(lines: string[], index: number): DiffLineInfo {
  let newLine = 0, oldLine = 0, inHunk = false;
  for (let i = 0; i <= index && i < lines.length; i++) {
    const ln = lines[i] || "";
    const m = ln.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      oldLine = parseInt(m[1], 10);
      newLine = parseInt(m[3], 10);
      inHunk = true;
      if (i === index) return { line: null, lineKind: "hunk" };
      continue;
    }
    if (!inHunk) continue;
    if (i === index) {
      if (ln.startsWith("+")) return { line: newLine, lineKind: "new" };
      if (ln.startsWith("-")) return { line: oldLine, lineKind: "old" };
      return { line: newLine, lineKind: "context" };
    }
    if (ln.startsWith("+")) newLine++;
    else if (ln.startsWith("-")) oldLine++;
    else { newLine++; oldLine++; }
  }
  return { line: null, lineKind: "other" };
}
