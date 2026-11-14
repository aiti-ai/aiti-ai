/**
 * aiti-git-review · Git 代码审核扩展（专职审核，不提交）
 *
 * 设计：docs/aiti-git-review-plan.md
 * 能力（M1 后端）：
 *   - 只读 git 封装（status/diff/log/show/rev-parse/merge-base/ls-files，固定参数保证输出稳定）
 *   - 变更集：`git diff HEAD --numstat -z`（改/删/重命名）+ `git ls-files --others`（未跟踪新文件）
 *     + 无 HEAD（首个 commit 前）降级（空树基线）
 *   - `hasChanges` 轻量探测（path 范围敏感）——入口点击时对准仓库；无变更也开选择器（可切版本审历史）
 *   - diff 结构化（hunks/segments 带 old/new 行号，供 Monaco diff 与 AI 定位）
 *   - 任务持久化（<extRoot>/state/aiti-git-review/tasks/<taskId>.json，含 boundSessionId + scope；三目录对称 2026-09-13）
 *   - agentTools(info) 按会话门控（日常会话零工具，评审任务会话才注入 aiti_review_*）
 *   - ai 帮助点声明（skills/pre-review，M3 补 SKILL.md）
 */
import { execFileAsync } from "@aiti-ai/ext-shared/exec-async";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, rmSync } from "node:fs";
import { join as pathJoin, dirname as pathDirname, resolve as pathResolve, relative as pathRelative, sep as pathSep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
// @ts-ignore 纯 JS 模块（与 lib/*.test.mjs 共用；trace 任务源/编外仓支持，docs/aiti-git-trace-plan.md §6）
import { findSubcommand, withRepoOpts, normalizeSource } from "./lib/git-args.mjs";
// @ts-ignore
import { parseLedger, groupRevisions } from "./lib/trace-ledger.mjs";

let configDir = "";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/** 读 JSON body（空/坏 body 归一 {}）。带路径的接口一律 POST+body——路径不进 URL，避免落入隧道/代理 access log。 */
const readBody = async (req: Request): Promise<any> => { try { return await req.json(); } catch { return {}; } };

/** 只读 git 白名单（严禁任何写子命令） */
const READ_ONLY = new Set(["status", "diff", "log", "show", "rev-parse", "merge-base", "ls-files", "hash-object", "for-each-ref"]);

/** 编外仓（trace）选项：gitDir 必带，workTree 可选（docs/aiti-git-trace-plan.md §6.1） */
type GitOpts = { gitDir?: string; workTree?: string };

/** 稳定输出参数：无颜色、无外置 diff 工具、无 textconv（保证解析一致）。
 *  opts.gitDir 存在时前插 `--git-dir=…/--work-tree=…`（单参数形式）→ 审 aiti-git-trace 编外追踪仓；
 *  注入参数以 `-` 开头，白名单子命令探测不受影响。 */
async function git(repo: string, args: string[], opts?: GitOpts): Promise<string> {
  const fullArgs = withRepoOpts(args, opts);
  const cmd = findSubcommand(fullArgs);
  if (!READ_ONLY.has(cmd)) throw new Error("only read-only git commands allowed: " + cmd);
  try {
    const out = await execFileAsync("git", fullArgs, {
      cwd: repo,
      maxBuffer: 64 * 1024 * 1024,
    });
    return out;
  } catch (e: any) {
    if (e && e.stderr) {
      const msg = String(e.stderr).trim().split("\n")[0] || "git error";
      throw new Error(msg);
    }
    throw e;
  }
}

/** 路径穿越防护：确保 target 在 base 内且返回相对 base 的路径。target 可为绝对或相对（相对则按 base 下解析） */
function safeRel(base: string, target: string): string {
  const abs = pathResolve(base, target);
  const rel = pathRelative(pathResolve(base), abs);
  // 穿越判定：只看相对结果是否逃出 base（.. 前缀 / 绝对路径）。
  // 不得用 pathResolve(rel)===abs 兜底——服务进程 cwd 恰为 repo 根时，相对路径
  // 会恰好解析回 abs（如 pi-web dev server），被误判为穿越（2026-08-30 实测回归）。
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error("path outside repo: " + target);
  }
  return rel === "" ? "." : rel;
}

function taskDir(): string {
  // 评审任务=不可再生持久数据 → state 层（<extRoot>/state 下；configDir = <extRoot>/config）
  const d = pathJoin(pathDirname(configDir), "state", "aiti-git-review", "tasks");
  mkdirSync(d, { recursive: true });
  return d;
}
function taskFile(taskId: string): string {
  return pathJoin(taskDir(), taskId.replace(/[^A-Za-z0-9_-]/g, "") + ".json");
}

// ── 版本基线（refs）：审核目标可从「工作区 vs HEAD」扩展到任意版本 ──
//   base = 旧侧（branch/tag/commitid；缺省 HEAD，无 HEAD 用空树）
//   ref2 = 新侧版本（设置即「两版本对比」模式：新侧内容取 ref2 而非工作区）
type Refs = { base?: string | null; ref2?: string | null };

/** 校验并解析 ref（branch/tag/commitid 均可）→ commit sha；非法/不存在抛错。--end-of-options 防选项注入 */
async function resolveRef(repo: string, ref: string, opts?: GitOpts): Promise<string> {
  const r = String(ref || "").trim();
  if (!r || /\s/.test(r) || r.includes("..")) throw new Error("非法版本号：" + ref);
  try {
    return (await git(repo, ["rev-parse", "--verify", "--end-of-options", r + "^{commit}"], opts)).trim();
  } catch (e) {
    throw new Error("无法解析版本「" + r + "」（branch/tag/commitid 均可）");
  }
}

/** 列出可选版本：本地分支 + tag + 远程分支（选择器 datalist 用；上限 500 条防超大仓库拖垮 UI） */
async function listRefs(repo: string, opts?: GitOpts): Promise<{ name: string; kind: string }[]> {
  const out: { name: string; kind: string }[] = [];
  const raw = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"], opts);
  for (const refname of raw.split("\n")) {
    const rn = refname.trim();
    if (!rn || rn.endsWith("^{}")) continue; // annotated tag 解引用条目跳过
    const kind = rn.startsWith("refs/heads/") ? "branch" : rn.startsWith("refs/tags/") ? "tag" : "remote";
    out.push({ name: rn.replace(/^refs\/(heads|tags|remotes)\//, ""), kind });
    if (out.length >= 500) break;
  }
  return out;
}

/** 校验 open/files 传入的版本参数 → Refs（base/ref2 空串视为未设置；range 模式缺省 base=HEAD） */
async function validateRefs(repo: string, base: unknown, ref2: unknown, opts?: GitOpts): Promise<Refs> {
  const b = String(base || "").trim();
  const r2 = String(ref2 || "").trim();
  if (r2) {
    await resolveRef(repo, r2, opts);
    if (b && b !== "HEAD") await resolveRef(repo, b, opts);
    return { base: b || "HEAD", ref2: r2 };
  }
  if (b) { await resolveRef(repo, b, opts); return { base: b }; }
  return {};
}

/** 旧侧 tree 参数：refs.base 优先；否则 HEAD；无 HEAD（首个 commit 前）用空树 */
async function oldTreeArg(repo: string, refs?: Refs | null, opts?: GitOpts): Promise<string> {
  if (refs && refs.base) return refs.base;
  return (await hasHead(repo, opts)) ? "HEAD" : (await git(repo, ["hash-object", "-t", "tree", "/dev/null"], opts)).trim();
}

/** 读某侧文件全文：old 侧读 base tree（git show）；new 侧默认工作区，两版本模式读 ref2 tree */
async function readSideContent(repo: string, file: string, side: string, refs?: Refs | null, opts?: GitOpts): Promise<string> {
  if (side === "old") return git(repo, ["show", (await oldTreeArg(repo, refs, opts)) + ":" + file], opts);
  // ↑ git/show 为异步调用，模板串需先求值 tree 参数
  if (refs && refs.ref2) return git(repo, ["show", refs.ref2 + ":" + file], opts);
  return readFileSync(pathJoin(repo, file), "utf8");
}

/** 任务级 Refs 视图（task JSON 直接带 base/ref2 字段） */
function taskRefs(task: any): Refs {
  return task ? { base: task.base || null, ref2: task.ref2 || null } : {};
}

/** trace 任务的 git 注入选项（source=trace → 编外追踪仓；repo 任务 → undefined 原样） */
function taskOpts(task: any): GitOpts | undefined {
  return task && task.source === "trace" && task.gitDir ? { gitDir: String(task.gitDir), workTree: String(task.repo || "") } : undefined;
}

/**
 * anchor 标志行快照：该行 + 前后各 3 行内容（新侧=工作区/ref2；old 侧读 base tree）。
 * 行号只是定位，anchor 才是「这句话指哪」的可靠凭据（边审边改行号漂移后靠 anchor 重映射）。
 */
async function anchorOf(repo: string, file: string, side: string, line: number, refs?: Refs | null, opts?: GitOpts): Promise<{ text: string; before: string[]; after: string[] }> {
  const EMPTY = { text: "", before: [], after: [] };
  if (!line || line < 1) return EMPTY;
  let lines: string[] = [];
  try {
    lines = (await readSideContent(repo, file, side, refs, opts)).split("\n");
  } catch (e) { return EMPTY; }
  const i = line - 1;
  return {
    text: lines[i] !== undefined ? lines[i] : "",
    before: [i - 3, i - 2, i - 1].filter((k) => k >= 0 && k < lines.length).map((k) => lines[k]),
    after: [i + 1, i + 2, i + 3].filter((k) => k >= 0 && k < lines.length).map((k) => lines[k]),
  };
}

/** 原子写：先写临时文件再 rename，避免写一半崩溃损坏任务 JSON */
function writeTask(task: any) {
  const fp = taskFile(task.id);
  const tmp = fp + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(task, null, 2));
  renameSync(tmp, fp);
  notifyTaskChanged(task); // 事件总线广播 gr:task：通知打开该任务的客户端拉取最新（事件驱动，替代客户端轮询）
}

function notifyTaskChanged(task: any) {
  // 帧上总线唯一通道（aiti-event-bus，帧契约 gr:task；2026-09-09 拍板：自建 SSE 双轨已删，
  // 订阅端 topics 唯一、禁止任何兜底）。
  try { (globalThis as any).__piPageEvents?.publish("gr:task", { taskId: task.id, revision: task.revision }); } catch {}
}

/** 任务内容哈希：基于所有选中文件的 modified（new 侧）+ original（old 侧）算摘要。
 *  内容变了 → 行号漂移 → 拉取标注时用 anchor 重映射。 */
async function computeDiffHash(task: any): Promise<string> {
  if (!task || !task.repo) return "";
  const parts: string[] = [];
  for (const f of task.files || []) {
    try {
      const d = await structuredDiff(task.repo, f.path, f.oldPath, taskRefs(task), taskOpts(task));
      if (d) parts.push(f.path + "\x00" + (d.modified || "") + "\x00" + (d.original || ""));
    } catch (e) {}
  }
  return createHash("sha1").update(parts.join("\x01")).digest("hex");
}

/** 锚点重映射：行号只是参考，anchor 标志行才是「这句话指哪」的凭据。
 *  比对任务保存时内容哈希（task.diffHash）与当前工作区；变了 → 对每条标注用 anchor 在最新内容重定位。
 *  整段精确匹配 → 更新行号；找不到/已删 → 标 stale（保留原文）。 */
async function remapAnnotations(task: any): Promise<boolean> {
  const annos = task.annotations || [];
  if (annos.length === 0) return false;
  // 当前内容哈希（tasks 只对选中文件；标注可能在未选中文件上，用全量）
  let changed = false;
  for (const a of annos) {
    const isOld = a.side === "old";
    let lines: string[] = [];
    try {
      lines = (await readSideContent(task.repo, a.file, isOld ? "old" : "new", taskRefs(task), taskOpts(task))).split("\n");
    } catch (e) { lines = []; }
    // 构建标志段：before + text + after 的完整序列
    const anchor = a.anchor || {};
    const before = Array.isArray(anchor.before) ? anchor.before : [];
    const after = Array.isArray(anchor.after) ? anchor.after : [];
    const text = String(anchor.text || "");
    const seq = [...before, text, ...after].filter((s) => s !== undefined && s !== null && s !== "");
    if (seq.length === 0) continue;
    const target = lines.filter((_l, idx) => !(idx >= lines.length - 1 && lines[idx] === ""));
    // 分级命中：① 完整锚点序列（before+text+after 连续匹配）→ 精确定位；② 仅 text 单行仍在 → 该行还在，行号漂移但可更新；③ 都不命中 → 标 stale
    const seqHit = findAnchorSeq(target, seq);
    let hit = seqHit;
    let textIdx = hit >= 0 ? hit + before.filter((s) => s !== "").length : -1;
    if (hit < 0 && text) {
      const tIdx = target.findIndex((l) => l === text);
      if (tIdx >= 0) { hit = tIdx; textIdx = tIdx; }
    }
    if (textIdx >= 0 && hit >= 0) {
      // 命中位置 → 定位到 text 所在行；范围标注（lineEnd）平移同样 delta（保持 span 长度）
      const lineNo = textIdx + 1;
      if (isOld) {
        if (a.oldLine !== lineNo) {
          if (a.oldLineEnd) a.oldLineEnd = lineNo + (a.oldLineEnd - a.oldLine);
          a.oldLine = lineNo; changed = true;
        }
      } else {
        if (a.newLine !== lineNo) {
          if (a.newLineEnd) a.newLineEnd = lineNo + (a.newLineEnd - a.newLine);
          a.newLine = lineNo; changed = true;
        }
      }
      if (a.stale) { a.stale = false; changed = true; }
    } else {
      // 找不到 → 原文已删/行已漂移，标 stale（保留原文，不丢 label）
      if (!a.stale) { a.stale = true; changed = true; }
    }
  }
  if (changed) { task.diffHash = await computeDiffHash(task); task._dirty = true; }
  return changed;
}

/** 在 lines 里找 seq 的连续匹配起点（支持空字符串通配）；返回起点 index 或 -1 */
function findAnchorSeq(lines: string[], seq: string[]): number {
  for (let i = 0; i + seq.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < seq.length; j++) {
      if (seq[j] === "") continue; // 通配空行
      if (lines[i + j] !== seq[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/** 从标注列表里过滤已在面板展示的旧 stale 标记（重映射后自动清除） */
/** 汇总文本：`# 审核结论 <repo>` + `file#line [severity] comment` 长结论 */
function reviewLabel(task: any): string {
  if (task && task.promptLabel) return String(task.promptLabel); // prompt 范围任务（操作时间线整组评审）
  if (task && task.ref2) return (task.base || "HEAD") + " → " + task.ref2;
  if (task && task.base) return "工作区 vs " + task.base;
  return "未提交变更";
}

/** trace 任务的回滚/历史对照说明（进汇总 → 交给 AI；红线：操作对象是 worktree 真实文件，不是项目 git 历史） */
function traceGuide(task: any): string {
  const sid = String(task.sessionId || "");
  const sid16 = sid.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 16) || "s";
  const root = task.storeRoot || task.repo || "";
  const gd = task.gitDir ? String(task.gitDir) : root + "/.aiti-trace";
  return [
    "## 回滚/历史对照说明（AI 必读）",
    "- 回滚标记的操作对象是**工作区真实文件**（worktree 下的文件内容）；不是项目自身的 git 历史——绝不要对项目仓执行 checkout/reset/revert。",
    "- 对照历史用编外追踪仓（独立 git 库，与项目 git 完全隔离）：GIT_DIR=`" + gd + "`、work-tree=`" + root + "`。只读查询例：`git --git-dir=" + gd + " diff <base>..<target> -- <file>`。",
    "- 会话分支：refs/heads/aiti/" + sid16 + "；锚点 tag：aiti/" + sid16 + "/before-N、after-N（N=台账 op 号；台账 ~/.pi/web/data/aiti-git-trace/ops/" + sid + ".jsonl）。",
    "- 标 [程序已执行✓] 的条目**不要重复操作**；标 [待执行] 的逐条恢复=按追踪仓 diff 逆向编辑真实文件。",
  ].join("\n");
}

async function buildSummary(task: any): Promise<string> {
  const repo = task && task.repo ? (task.repo.split("/").slice(-2).join("/") || task.repo) : "";
  const anno = (task.annotations || []).filter((a: any) => !a.resolved)
    // 只汇入已勾选（selected）文件的标注——与页面勾选一致，排除的文件不入终审清单
    .filter((a: any) => (task.files || []).some((f: any) => f.path === a.file && f.selected));
  // 增删行统计（已勾选文件）：+N/-M（numstat 口径，新增文件全算 +）
  let adds = 0, dels = 0;
  for (const f of (task.files || []).filter((x: any) => x.selected)) {
    try {
      // R 文件双路径保 rename 配对（单路径会把重命名误算成全新增）；两版本模式 diff 两端，否则旧侧 tree vs 工作区
      const refs = taskRefs(task);
      const treeArgs = refs.ref2 ? [String(refs.base || "HEAD"), refs.ref2] : [(await oldTreeArg(task.repo, refs, taskOpts(task)))];
      const st = (await git(task.repo, ["diff", ...treeArgs, "--numstat", "--", ...(f.oldPath ? [f.oldPath, f.path] : [f.path])], taskOpts(task))).trim();
      const m = /^(\d+|-)	(\d+|-)	/.exec(st || "");
      if (m) { adds += m[1] === "-" ? 0 : parseInt(m[1], 10); dels += m[2] === "-" ? 0 : parseInt(m[2], 10); }
      else if (f.status === "A") { try { const c = await readSideContent(task.repo, f.path, "new", taskRefs(task), taskOpts(task)); adds += c === "" ? 0 : c.split("\n").length; } catch (e) {} }
    } catch (e) {}
  }
  const added = task.files ? task.files.filter((f: any) => f.status === "A" || f.status === "binary").length : 0;
  const sevLabel: any = { must: "必须", suggest: "建议", question: "疑问" };
  const lines = anno.map((a: any) => {
    const ln = a.side === "old" ? a.oldLine : a.newLine;
    const end = a.side === "old" ? a.oldLineEnd : a.newLineEnd;
    const range = end && end > ln ? ln + "-" + end : (ln || "?");
    return (a.file || "") + "#L" + range + " [" + (sevLabel[a.severity] || a.severity) + "] " + (a.text || "");
  });
  // 回滚标记（trace 任务专属；标注式——先标记，提交时按开关由程序执行或交 AI）
  const marks = (task.rollmarks || []) as any[];
  const markLines = marks.map((m) => {
    const st = m.status === "executed" ? "程序已执行✓" : m.status === "failed" ? "程序执行✗：" + (m.result || "失败") : "待执行（交 AI）";
    return "↩ " + m.file + (m.hunkIdx && m.hunkIdx.length ? "（第 " + m.hunkIdx.map((i: number) => i + 1).join(",") + " 块）" : "（整文件）") + " [" + st + "]";
  });
  return [
    "# 审核结论 " + repo + "（" + reviewLabel(task) + "）",
    "## 变更概览（文件数 " + ((task.files || []).filter((f: any) => f.selected).length) + " / +" + adds + "/-" + dels + " / 标注 " + anno.length + (marks.length ? " / 回滚标记 " + marks.length : "") + "）",
    "",
    ...lines,
    ...(markLines.length ? ["", "## 回滚标记（" + marks.length + " 个文件）", ...markLines] : []),
    ...(markLines.length && task.source === "trace" ? ["", traceGuide(task)] : []),
    "",
    "## 整体结论",
    "（用户未补充整体结论）",
  ].join("\n");
}
function loadTask(taskId: string): any {
  const fp = taskFile(taskId);
  if (!existsSync(fp)) return null;
  try {
    const t = JSON.parse(readFileSync(fp, "utf8"));
    if (t) t.source = normalizeSource(t.source); // 旧任务无 source 字段 → "repo"（向后兼容）
    return t;
  } catch (e) { return null; }
}

/** 仓库最新默认模式任务（base/ref2 均空；ai-prebind 复用避免每次预审堆新任务）。
 *  版本对比任务（range/base）不入候选——预审未提交变更不能绑到历史范围任务上 */
function latestTaskOf(repo: string): any | null {
  let latest: { m: number; t: any } | null = null;
  try {
    for (const f of readdirSync(taskDir())) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(readFileSync(pathJoin(taskDir(), f), "utf8"));
        if (t && t.repo === repo && !t.base && !t.ref2 && (!latest || t.createdAt > latest.m)) latest = { m: t.createdAt, t };
      } catch (e) {}
    }
  } catch (e) {}
  return latest ? latest.t : null;
}

/** 最近一次审核任务的 repo（mtime 最新；toolbar 无会话 cwd 时的探测/打开兜底） */
function latestTaskRepo(): string | null {
  let latest: { m: number; repo: string } | null = null;
  try {
    for (const f of readdirSync(taskDir())) {
      if (!f.endsWith(".json")) continue;
      try {
        const st = statSync(pathJoin(taskDir(), f));
        const t = JSON.parse(readFileSync(pathJoin(taskDir(), f), "utf8"));
        if (t && t.repo && (!latest || st.mtimeMs > latest.m)) latest = { m: st.mtimeMs, repo: t.repo };
      } catch (e) {}
    }
  } catch (e) {}
  return latest ? latest.repo : null;
}

/** 仓库根探测：git -C <folder> rev-parse --show-toplevel（自动找 .git），返回 { repo, root } */
async function openRepo(folder: string): Promise<{ repo: string; root: string }> {
  const abs = pathResolve(folder);
  const out = (await git(abs, ["rev-parse", "--show-toplevel"])).trim();
  if (!out) throw new Error("not a git repo: " + folder);
  return { repo: out, root: abs };
}

/** 无 HEAD（首个 commit 前）判定 */
async function hasHead(repo: string, opts?: GitOpts): Promise<boolean> {
  try { await git(repo, ["rev-parse", "--verify", "HEAD"], opts); return true; }
  catch (e) { return false; }
}

/** 变更集：git diff <基线> --numstat -z（改/删/重命名）+ untracked（未跟踪新文件）。
 *  refs.base 指定基线（branch/tag/commitid；缺省 HEAD/空树）；refs.ref2 设置即两版本对比模式（无 untracked）。 */
async function changeSet(repo: string, refs?: Refs | null, opts?: GitOpts): Promise<{ files: any[]; hasHead: boolean }> {
  const range = !!(refs && refs.ref2);
  const head = await hasHead(repo, opts);
  const files: any[] = [];
  const seen = new Set<string>();

  // 1) 已跟踪变更（两版本模式 diff base..ref2；否则旧侧 tree（base/HEAD/空树）vs 工作区）
  let diffOut = "";
  if (range) {
    diffOut = await git(repo, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--numstat", "-z", String(refs!.base || "HEAD"), refs!.ref2!], opts);
  } else {
    diffOut = await git(repo, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--numstat", "-z", await oldTreeArg(repo, refs, opts)], opts);
  }
  // --numstat -z 输出（实测两种形态）：<add>\t<del>\t<path>\0；
  // 重命名/复制：<add>\t<del>\t\0<旧路径>\0<新路径>\0（tab 后直接 NUL，路径各占后续段）。
  // 判定依据 = m[3] 是否为空串（旧启发式"下一段非 numstat 格式即重命名"会把 binary 的 -\t-\t 前缀误判成重命名段）
  const parts = diffOut.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    const adds = m[1], dels = m[2], p = m[3];
    if (p === "") {
      // 重命名/复制：旧路径 = parts[i+1]，新路径 = parts[i+2]（记录 oldPath 供 structuredDiff 双路径取 rename pair）
      if (i + 2 >= parts.length) continue;
      const oldName = parts[i + 1], newName = parts[i + 2];
      i += 2;
      if (seen.has(newName)) continue;
      seen.add(newName);
      files.push({ path: newName, oldPath: oldName, status: "R" });
    } else {
      if (seen.has(p)) continue;
      seen.add(p);
      files.push({ path: p, status: (adds === "-" || dels === "-") ? "binary" : "M" });
    }
  }

  // 2) 未跟踪文件（untracked 不纳入就漏审全新文件；仅工作区模式——两版本模式新侧是 ref2 tree，不存在 untracked）
  if (!range) {
    const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"], opts))
      .split("\0").filter(Boolean);
    for (const u of untracked) {
      if (seen.has(u)) continue;
      seen.add(u);
      files.push({ path: u, status: "A" }); // 未跟踪 = 全新文件（全文为新内容）
    }
  }

  return { files, hasHead: head };
}

/** 单文件变更状态（供 hasChanges / 入口按钮显隐） */
async function fileStatus(repo: string, rel: string): Promise<string | null> {
  const head = await hasHead(repo);
  const tracked = (await git(repo, ["ls-files", "-z", "--", rel])).split("\0").filter(Boolean);
  if (tracked.length > 0) {
    const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--numstat", "-z"];
    const tree = head ? "HEAD" : (await git(repo, ["hash-object", "-t", "tree", "/dev/null"])).trim();
    const out = (await git(repo, [...args, tree, "--", rel])).trim();
    if (out) return "M";
    return null;
  }
  // untracked or deleted
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--", rel])).split("\0").filter(Boolean);
  return untracked.length > 0 ? "A" : null;
}

/**
 * diff 结构化：解析 `git diff --no-color -U3 -- <file>` → hunks/segments，
 * 并附带完整 original（old 侧）与 modified（new 侧=工作区）文本供 Monaco diff editor 使用。
 * 重命名文件（R）传 oldPath：diff pathspec 用双路径保 rename 配对（单路径会退化成纯删/纯增），
 * original 从旧路径 `git show <tree>:<oldPath>` 取。
 */
async function structuredDiff(repo: string, rel: string, oldPath?: string, refs?: Refs | null, opts?: GitOpts): Promise<any> {
  const range = !!(refs && refs.ref2);
  const tree = await oldTreeArg(repo, refs, opts); // 两版本模式作 diff 第一端（base），否则旧侧基线 tree
  const out = await git(repo, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", ...(range ? [tree, refs!.ref2!] : [tree]), "--", ...(oldPath ? [oldPath, rel] : [rel])], opts);
  // 无 diff 输出：可能是 untracked 新文件（git diff 不含未跟踪文件）→ 构造全新增 diff
  if (!out.trim()) {
    try {
      const content = await readSideContent(repo, rel, "new", refs, opts);
      const lineCount = content === "" ? 0 : content.split("\n").length;
      return {
        file: rel, status: "A",
        original: "", modified: content,
        hunks: lineCount > 0 ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lineCount, header: "", segments: content.split("\n").map((l: string, i: number) => ({ type: "add", newLine: i + 1, text: l })) }] : [],
      };
    } catch (e) {
      return null; // 文件不存在 → 无变更
    }
  }
  if (/^Binary files .* differ$/m.test(out)) return { file: rel, status: "binary", hunks: [] };

  const lines = out.split("\n");
  const isNew = /^diff --git a\/\S+ b\/(.+)$/.test(lines[0] || "");
  let status = "M";

  // 完整文本：old = git show <base tree>:<file>（R 文件用旧路径——新路径在 tree 不存在）；new = ref2 tree 或工作区读（若存在）
  let original = "", modified = "";
  try { original = await readSideContent(repo, oldPath || rel, "old", refs, opts); } catch (e) { original = ""; } // 新增文件在 tree 中不存在
  try { modified = await readSideContent(repo, rel, "new", refs, opts); } catch (e) { modified = ""; } // 删除文件新侧不存在

  if (isNew) {
    const oldName = /^--- a\/(.*)$/.exec(lines.find((l) => l.startsWith("--- a/")) || "")?.[1] || "";
    const newName = /^\+\+\+ b\/(.*)$/.exec(lines.find((l) => l.startsWith("+++ b/")) || "")?.[1] || "";
    if (!oldName && newName) status = "A";
    else if (oldName && !newName) status = "D";
    else if (oldName !== newName) status = "R";
  }
  const hunks: any[] = [];
  let cur: any = null;

  for (const line of lines) {
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hm) {
      if (cur) hunks.push(cur);
      cur = {
        oldStart: parseInt(hm[1], 10), oldLines: parseInt(hm[2] || "1", 10),
        newStart: parseInt(hm[3], 10), newLines: parseInt(hm[4] || "1", 10),
        header: hm[5],
        segments: [],
      };
      continue;
    }
    if (!cur) continue;
    const seg = cur.segments;
    if (line.startsWith("+")) {
      const t = line.slice(1);
      seg.push({ type: "add", newLine: nextNew(cur), text: t });
    } else if (line.startsWith("-")) {
      const t = line.slice(1);
      seg.push({ type: "del", oldLine: nextOld(cur), text: t });
    } else {
      // 上下文（` ` 前缀或空行等）
      const t = line.startsWith(" ") ? line.slice(1) : line;
      seg.push({ type: "ctx", oldLine: nextOld(cur), newLine: nextNew(cur), text: t });
    }
  }
  if (cur) hunks.push(cur);
  return { file: rel, status, hunks, original, modified };
}

/** 段推进：ctx 行同时推 old/new；add 只推 new；del 只推 old（git diff hunk 内两侧各自连续计数） */
function nextOld(h: any): number | undefined {
  for (let i = h.segments.length - 1; i >= 0; i--) {
    if (typeof h.segments[i].oldLine === "number") return h.segments[i].oldLine + 1;
  }
  return h.oldStart;
}
function nextNew(h: any): number | undefined {
  for (let i = h.segments.length - 1; i >= 0; i--) {
    if (typeof h.segments[i].newLine === "number") return h.segments[i].newLine + 1;
  }
  return h.newStart;
}

// ── agentTools 门控（M1 骨架；M4 注入完整 aiti_review_* 工具） ──
const reviewBindings = new Map<string, string>(); // sessionId → taskId
let pendingReviewCwd: string | null = null;        // 建会话瞬间门控（launch-session）
let pendingTaskId: string | null = null;           // ai-prebind（ai-helper 帮助点链）预备的任务；agentTools 命中门控时懒绑定并清除

// ── AI 分组精修（git-ops M4 补遗）：会话 settle 事件驱动等待（非轮询） ──
interface RefinePending {
  resolve: (text: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const refinePending = new Map<string, RefinePending>(); // sessionId → 等待者（onAgentSettled 送达）
const REFINE_TIMEOUT_MS = 180_000;

/** spawn 一个 prompt 会话并等待 `onAgentSettled` 送达最终回答（单 deadline 超时；事件驱动，非轮询）。
 *  通道由 AI 精修（groupReview）与 AI 生成提交信息（commitMessage）共用——等待表按 sessionId 区分。 */
async function spawnPromptAndWait(opts: { origin: string; basePath: string; cwd: string; message: string; timeoutMsg: string }): Promise<string> {
  const origin = String(opts.origin || "").replace(/\/$/, "");
  const basePath = String(opts.basePath || "");
  if (!origin || !opts.cwd) throw new Error("origin/cwd required");
  return new Promise<string>((resolve, reject) => {
    // 单个 deadline 定时器：超时放弃等待（会话不强行杀，留在会话列表供查看）
    const timer = setTimeout(() => reject(new Error(opts.timeoutMsg)), REFINE_TIMEOUT_MS);
    timer.unref?.();
    fetch(origin + basePath + "/api/agent/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: opts.cwd, type: "prompt", message: opts.message }),
    }).then(async (resp) => {
      const data = await resp.json().catch(() => null);
      const sid = String(data && (data.sessionId || (data.session && data.session.id)) || "");
      if (!sid) { clearTimeout(timer); reject(new Error("agent/new 未返回 sessionId")); return; }
      refinePending.set(sid, { resolve, reject, timer });
    }).catch((e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

/** AI 生成提交信息（folder CommitDialog）的上下文收集：只读 AGENTS.md + 勾选文件 diff（含 untracked）+ 最近提交风格。
 *  设计：docs/aiti-folder-commit-ai-message-plan.md——不做任何 git 写操作；体积限制在 lib/ai-commit 组装层。 */
async function collectCommitContext(opts: { cwd: string; files: string[]; amend?: boolean }): Promise<{
  cwd: string; files: any[]; agentsMds: { path: string; content: string }[]; recentSubjects: string[]; amendOriginal: string | null;
}> {
  const cwd = String(opts.cwd || "");
  if (!cwd) throw new Error("cwd required");
  const { repo } = await openRepo(cwd);
  const { COMMIT_LIMITS, splitDiffOutput } = await import("./lib/ai-commit");
  const amend = !!opts.amend;

  // 勾选文件（仓库相对路径；去重 + 越界防护；空集报错）
  const requested = Array.from(new Set((opts.files ?? []).map((f) => String(f || "").trim()).filter(Boolean))).slice(0, COMMIT_LIMITS.maxFiles);
  if (requested.length === 0) throw new Error("files required");
  const safeFiles: string[] = [];
  for (const f of requested) {
    try { safeFiles.push(safeRel(repo, f)); } catch { /* 越界/非法路径：跳过 */ }
  }
  if (safeFiles.length === 0) throw new Error("no valid files");

  // 未跟踪文件判定（-z 输出，异常文件名安全）
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...safeFiles]).catch(() => ""))
    .split("\0").filter(Boolean);
  const untrackedSet = new Set(untracked);
  const trackedFiles = safeFiles.filter((f) => !untrackedSet.has(f));

  // 已跟踪变更 diff（批量一次——Windows 逐文件 spawn 太慢；空 pathspec 会输出全量，务必跳过空集）
  const head = await hasHead(repo);
  let diffOut = "";
  if (trackedFiles.length > 0) {
    if (amend && head) {
      try {
        await git(repo, ["rev-parse", "--verify", "HEAD~1"]);
        diffOut = await git(repo, ["diff", "HEAD~1", "--no-color", "--no-ext-diff", "--", ...trackedFiles]).catch(() => "");
      } catch { /* 首笔无 parent：落到 HEAD/空树分支 */ }
    }
    if (!diffOut && head) {
      diffOut = await git(repo, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--", ...trackedFiles]).catch(() => "");
    }
    if (!diffOut && !head) {
      // 首笔提交前（罕见）：index↔空树 + 工作区↔index 两段合并
      const a = await git(repo, ["diff", "--cached", "--no-color", "--no-ext-diff", "--", ...trackedFiles]).catch(() => "");
      const b = await git(repo, ["diff", "--no-color", "--no-ext-diff", "--", ...trackedFiles]).catch(() => "");
      diffOut = (a + "\n" + b).trim();
    }
  }
  const tracked = splitDiffOutput(diffOut).map((s: { path: string; diff: string }) => ({ path: s.path, status: "M", diff: s.diff }));

  // 未跟踪文件内容（二进制/超大只标注，不读大文件——服务端同步读红线）
  const newFiles: any[] = [];
  for (const f of untracked.sort()) {
    let diff = "";
    let binary = false;
    let omitted = false;
    try {
      const st = statSync(pathJoin(repo, f));
      if (!st.isFile() || st.size > 256 * 1024) {
        omitted = true;
      } else {
        const buf = readFileSync(pathJoin(repo, f));
        if (buf.includes(0)) binary = true;
        else diff = buf.toString("utf8");
      }
    } catch { continue; }
    newFiles.push({ path: f, status: "??", diff, isNew: true, binary, omitted });
  }

  // AGENTS.md：git root → cwd 各级（含中间目录）
  const agentsMds: { path: string; content: string }[] = [];
  const rootAbs = pathResolve(repo);
  let cur = pathResolve(cwd);
  const chain: string[] = [];
  while (true) {
    chain.unshift(cur);
    if (cur === rootAbs) break;
    const parent = pathDirname(cur);
    if (parent === cur || !(parent === rootAbs || parent.startsWith(rootAbs + pathSep))) break;
    cur = parent;
  }
  for (const dir of chain) {
    if (agentsMds.length >= COMMIT_LIMITS.maxAgentsFiles) break;
    const p = pathJoin(dir, "AGENTS.md");
    try {
      if (!existsSync(p)) continue;
      const st = statSync(p);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      agentsMds.push({ path: pathRelative(rootAbs, p) || "AGENTS.md", content: readFileSync(p, "utf8") });
    } catch { /* 读取失败：跳过 */ }
  }

  // 最近提交风格（最多 8 条 subject）+ amend 原提交信息
  const recentSubjects = (await git(repo, ["log", "-8", "--format=%s"]).catch(() => ""))
    .split("\n").map((s) => s.trim()).filter(Boolean);
  let amendOriginal: string | null = null;
  if (amend) amendOriginal = (await git(repo, ["log", "-1", "--format=%B"]).catch(() => "")).trim() || null;

  return { cwd: repo, files: [...tracked, ...newFiles], agentsMds, recentSubjects, amendOriginal };
}

/** 任务 GC：30 天前创建且无标注/无汇总/无绑定会话 → 删（探测/误开残留；有内容的一律保留） */
function gcTasks() {
  const CUT = 30 * 24 * 3600 * 1000;
  let removed = 0;
  try {
    for (const f of readdirSync(taskDir())) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(readFileSync(pathJoin(taskDir(), f), "utf8"));
        if (!t || !t.id) continue;
        const hasContent = (t.annotations && t.annotations.length) || t.summary || t.boundSessionId;
        if (!hasContent && Date.now() - (t.createdAt || 0) > CUT) {
          try { rmSync(pathJoin(taskDir(), f)); removed++; } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {}
  if (removed > 0) console.log("[aiti-git-review] GC：清理 " + removed + " 个过期空任务");
}

/** 按会话恢复绑定（reload/重启后从任务 JSON 读 boundSessionId） */
function restoreBindings() {
  try {
    for (const f of readdirSync(taskDir())) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(readFileSync(pathJoin(taskDir(), f), "utf8"));
        if (t && t.boundSessionId) reviewBindings.set(String(t.boundSessionId), String(t.id));
      } catch (e) {}
    }
  } catch (e) {}
}

// ── 扩展声明 ──
export default {
  id: "aiti-git-review",
  name: "Git 代码审核",
  icon: "icon.svg",
  client: "dist/aiti-git-review-client.mjs",

  // AI 自管理清单（ai-helper 标准流程，M3 补 skills/pre-review/SKILL.md）
  ai: {
    manage: false,
    intro: "git 代码审核：打开审核任务、按文件/目录审未提交变更或任意版本（工作区 vs branch/tag/commitid、两版本互比）、行标注汇总、AI 预审（skills/pre-review）",
    skills: "skills",
  },

  ui: {
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    toolbar: [
      { id: "aiti-git-review-open", label: "审核", title: "aiti-git-review：审核变更（未提交 / 指定基线 / 两版本对比）", icon: "icons/eye.svg" },
    ],
    dialogs: [{ id: "aiti-git-review-dialog", label: "aiti-git-review" }],
    rightFileDock: [{ id: "workspace", label: "审查" }],
    i18n: {
      en: {
        "gr.title": "Git Code Review",
        "gr.picker.new": "New review",
        "gr.picker.selectFiles": "Select files",
        "gr.picker.repo": "Repo path (or pick from the workspace switcher)",
        "gr.picker.pickWs": "Pick workspace",
        "gr.picker.probe": "Probe",
        "gr.picker.aiPre": "AI pre-review (background)",
        "gr.picker.create": "Create review session",
        "gr.picker.creating": "Creating…",
        "gr.picker.open": "Open existing",
        "gr.picker.tasks": "tasks",
        "gr.picker.otherRepos": "({n} in other repos)",
        "gr.picker.noChanges": "No uncommitted changes (or repo path not found)",
        "gr.picker.enterRepo": "Enter a repo path, then probe",
        "gr.picker.files": "{s}/{n} files",
        "gr.picker.search": "Search path…",
        "gr.picker.all": "All",
        "gr.picker.clear": "None",
        "gr.picker.selectAllVisible": "Select all visible files",
        "gr.picker.clearSel": "Clear selection",
        "gr.picker.del": "Delete this review (annotations are deleted with it)",
        "gr.picker.needRepo": "Pick a repo and at least one file",
        "gr.picker.wt": "Worktree",
        "gr.picker.range": "Two refs",
        "gr.picker.basePh": "Base: branch/tag/commit (empty = HEAD)",
        "gr.picker.ref2Ph": "Target: branch/tag/commit",
        "gr.picker.swapRefs": "Swap the two sides",
        "gr.picker.needRef2": "Fill in the target ref first",
        "gr.nav.prev": "Previous change (cross-file; Shift+F7)",
        "gr.nav.next": "Next change (cross-file; F7)",
        "gr.view.mode": "diff view mode",
        "gr.anno.mode": "Annotate mode",
        "gr.anno.sev.must": "Must",
        "gr.anno.sev.suggest": "Suggest",
        "gr.anno.sev.question": "Question",
        "gr.anno.submit": "OK ⏭",
        "gr.anno.placeholder": "Comment @L{pos}… (Enter = submit & next; empty = skip)",
        "gr.anno.noLine": "No annotatable line in this block",
        "gr.tabs.anno": "Annotate",
        "gr.tabs.all": "All",
        "gr.tabs.summary": "Summary",
      },
      "zh-CN": {
        "gr.title": "Git 代码审核",
        "gr.picker.new": "新建审查",
        "gr.picker.selectFiles": "选文件",
        "gr.picker.repo": "仓库路径（也可从左侧切换器选）",
        "gr.picker.pickWs": "选工作区",
        "gr.picker.probe": "探测",
        "gr.picker.aiPre": "AI 先预审（后台标注）",
        "gr.picker.create": "创建审查会话",
        "gr.picker.creating": "创建中…",
        "gr.picker.open": "打开现有",
        "gr.picker.tasks": "个任务",
        "gr.picker.otherRepos": "（其他仓库 {n}）",
        "gr.picker.noChanges": "无未提交变更（或仓库路径不存在）",
        "gr.picker.enterRepo": "输入仓库路径后探测",
        "gr.picker.search": "搜路径…",
        "gr.picker.all": "全选",
        "gr.picker.clear": "清空",
        "gr.picker.selectAllVisible": "全选当前可见文件",
        "gr.picker.clearSel": "清空选择",
        "gr.picker.del": "删除此审查任务（标注库随任务删除）",
        "gr.picker.needRepo": "先选仓库与至少一个文件",
        "gr.picker.wt": "工作区",
        "gr.picker.range": "两版本",
        "gr.picker.basePh": "基线：branch/tag/commit（留空 = HEAD）",
        "gr.picker.ref2Ph": "目标版本：branch/tag/commit",
        "gr.picker.swapRefs": "交换两端",
        "gr.picker.needRef2": "先填目标版本",
        "gr.nav.prev": "上一条变更（跨文件；Shift+F7）",
        "gr.nav.next": "下一条变更（跨文件；F7）",
        "gr.view.mode": "diff 视图模式",
        "gr.anno.mode": "加注模式",
        "gr.anno.sev.must": "必须",
        "gr.anno.sev.suggest": "建议",
        "gr.anno.sev.question": "疑问",
        "gr.anno.submit": "确定 ⏭",
        "gr.anno.placeholder": "评论 @{pos}…（Enter 提交并下一块；空 = 本块无问题直接过）",
        "gr.anno.noLine": "此块无可标注行",
        "gr.tabs.anno": "标注",
        "gr.tabs.all": "全部",
        "gr.tabs.summary": "汇总",
      },
    },
  },

  server: {
    startup(ctx: any) {
      configDir = ctx.configDir || "";
      restoreBindings();
      gcTasks(); // 过期清理：30 天前创建、无标注/无汇总/无绑定会话的任务——防探测残留堆积
      console.log("[aiti-git-review] 就绪 · configDir=" + configDir + " · 绑定会话=" + reviewBindings.size);
      // aiReview 服务出口：提交分组 AI 精修（git-ops M4 补遗）+ AI 生成提交信息（folder CommitDialog）——
      // 均 spawn prompt 会话 + onAgentSettled 事件驱动取回答（单 deadline 超时，非轮询）。缺席时 folder 按钮隐藏。
      try {
        ctx?.services?.provide?.("aiti-git-review.aiReview", {
          groupReview: async (opts: { origin: string; basePath: string; cwd: string; groups: unknown[]; excluded?: string[] }) => {
            const { buildRefinePrompt, parseRefineJson, sanitizeRefineInput } = await import("./lib/ai-refine");
            const input = sanitizeRefineInput({ cwd: opts.cwd, groups: opts.groups as any, excluded: opts.excluded });
            const prompt = buildRefinePrompt(input);
            const origin = String(opts.origin || "").replace(/\/$/, "");
            const basePath = String(opts.basePath || "");
            if (!origin || !input.cwd) throw new Error("origin/cwd required");
            const text = await spawnPromptAndWait({
              origin, basePath, cwd: input.cwd, message: prompt,
              timeoutMsg: "AI 精修超时（180s）——AI 会话仍保留，可稍后查看其回答",
            });
            const parsed = parseRefineJson(text);
            if (!parsed) throw new Error("AI 回答未通过 JSON 契约校验——保留启发式分组即可");
            return parsed;
          },
          /** AI 生成提交信息（folder CommitDialog，docs/aiti-folder-commit-ai-message-plan.md）：
           *  服务端只读收集 AGENTS.md + 勾选文件 diff + 最近提交风格 → spawn prompt 会话等待回答 →
           *  parseCommitText 清理后返回 { message }；folder 只做 UI 与中继。 */
          commitMessage: async (opts: { origin: string; basePath: string; cwd: string; files: string[]; amend?: boolean }) => {
            const { buildCommitPrompt, parseCommitText, sanitizeCommitInput } = await import("./lib/ai-commit");
            const ctxInput = await collectCommitContext({ cwd: opts.cwd, files: opts.files, amend: opts.amend });
            const prompt = buildCommitPrompt(sanitizeCommitInput(ctxInput));
            const text = await spawnPromptAndWait({
              origin: opts.origin, basePath: opts.basePath, cwd: ctxInput.cwd, message: prompt,
              timeoutMsg: "AI 生成提交信息超时（180s）——AI 会话仍保留，可稍后查看其回答",
            });
            const message = parseCommitText(text);
            if (!message) throw new Error("AI 回答为空或未通过提交信息格式清理——请重试");
            return { message };
          },
        });
        console.log("[aiti-git-review] services 已注册：aiti-git-review.aiReview（groupReview + commitMessage）");
      } catch (e) {
        console.warn("[aiti-git-review] services.provide(aiReview) 失败", e);
      }
    },

    async api(req: Request, ctx: any) {
      const p = ctx.path || [];
      if (!configDir) return json({ ok: false, error: "扩展未初始化" }, 500);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });

      try {
        // POST /hasChanges { path?, base? } → 轻量探测（path 可为文件/目录/repo 根；无变更→false，供入口按钮显隐）
        // path 为空：用最近一次审核任务的 repo 兜底（toolbar 无当前会话 cwd 时的稳定目标）
        if (p[0] === "hasChanges" && req.method === "POST") {
          const body = await readBody(req);
          let q = typeof body?.path === "string" ? body.path : "";
          const base = typeof body?.base === "string" ? body.base : "";
          if (!q && !base) {
            const latest = latestTaskRepo();
            if (latest) q = latest;
            else return json({ ok: true, hasChanges: false, repo: null, file: "." });
          }
          const repo = base ? (await openRepo(base)).repo : (await openRepo(q)).repo;
          const rel = q ? safeRel(repo, q) : ".";
          const { files } = await changeSet(repo);
          const matched = files.some((f) => {
            if (!rel || rel === ".") return true;
            return f.path === rel || f.path.startsWith(rel.replace(/\/$/, "") + "/");
          });
          return json({ ok: true, hasChanges: matched, repo, file: rel });
        }

        // POST /open { path?, scope?: { kind, path } } → 建立审核任务（默认 repo 全部）
        // POST /files { path, base?, ref2? } → 轻量变更文件列表（选择器新建区探测；不建任务）：[{path,status}]
        //   base/ref2：指定基线/两版本对比（branch/tag/commitid；非法版本号报 400）
        if (p[0] === "files" && req.method === "POST") {
          const body = await readBody(req);
          const q = typeof body?.path === "string" ? body.path : "";
          if (!q) return json({ ok: false, error: "需要 path" }, 400);
          try {
            const { repo } = await openRepo(q);
            const refs = await validateRefs(repo, typeof body?.base === "string" ? body.base : undefined, typeof body?.ref2 === "string" ? body.ref2 : undefined);
            const { files } = await changeSet(repo, refs);
            return json({ ok: true, repo, files: files.map((f: any) => ({ path: f.path, status: f.status })) });
          } catch (e: any) {
            return json({ ok: false, error: (e && e.message) || String(e) }, 400);
          }
        }

        // POST /refs { path } → 列可选版本（分支+tag+远程分支）+ 最近 commit 按天分组用（带日期）；选择器树形 autocomplete 用
        if (p[0] === "refs" && req.method === "POST") {
          const body = await readBody(req);
          const q = typeof body?.path === "string" ? body.path : "";
          if (!q) return json({ ok: false, error: "需要 path" }, 400);
          const { repo } = await openRepo(q);
          let head = "";
          try { head = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(); } catch (e) {}
          // 最近 commit（短哈希可直接作 ref 用；date=提交日期 YYYY-MM-DD，前端按天分组）
          let commits: { id: string; date: string; subject: string }[] = [];
          try {
            commits = (await git(repo, ["log", "-n", "100", "--format=%h%x09%cs%x09%s"]))
              .split("\n").filter(Boolean)
              .map((l: string) => {
                const i = l.indexOf("\t"), j = l.indexOf("\t", i + 1);
                return { id: l.slice(0, i), date: j >= 0 ? l.slice(i + 1, j) : "", subject: j >= 0 ? l.slice(j + 1) : "" };
              });
          } catch (e) {}
          return json({ ok: true, repo, head, refs: await listRefs(repo), commits });
        }

        if (p[0] === "open" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          // trace 任务源（docs/aiti-git-trace-plan.md §6.2/6.3）：审 aiti-git-trace 编外追踪仓的任意 op 区间。
          // storeRoot = 编外仓所属的用户仓根；base/target = trace 分支上的 commit（台账 before/after，§3.6）。
          // 之后 diff/加注/汇总全部走既有两版本对比代码（gitDir 注入），零分叉。
          if (body && body.source === "trace") {
            const storeRoot = String(body.storeRoot || "");
            const sessionId = String(body.sessionId || "");
            const base = String(body.base || "");
            const target = String(body.target || "");
            if (!storeRoot || !sessionId || !base || !target) return json({ ok: false, error: "trace 任务需要 storeRoot/sessionId/base/target" }, 400);
            // §13.2：store 顶层 <root>/.aiti-trace（独立 git 库，与项目 git 完全隔离）
            const gitDir = pathJoin(storeRoot, ".aiti-trace");
            if (!existsSync(gitDir)) return json({ ok: false, error: "追踪仓不存在：" + gitDir }, 404);
            const opts = { gitDir, workTree: storeRoot };
            let refs: Refs;
            try {
              refs = await validateRefs(storeRoot, base, target, opts);
            } catch (e: any) {
              return json({ ok: false, error: "trace commit 校验失败：" + ((e && e.message) || e) }, 400);
            }
            // 可选 files 过滤（aiti-git-trace 文件视图「看此文件 diff」）：只保留命中 path/oldPath 的变更
            const allowFiles = Array.isArray(body.files) && body.files.length > 0
              ? new Set((body.files as unknown[]).map((f) => String(f)))
              : null;
            let files = (await changeSet(storeRoot, refs, opts)).files;
            if (allowFiles) files = files.filter((f: any) => allowFiles.has(f.path) || (f.oldPath && allowFiles.has(f.oldPath)));
            if (files.length === 0) return json({ ok: false, error: (allowFiles ? "所选文件在此区间无变更（" : "该区间无文件变更（") + base + " → " + target + "）" }, 404);
            const task: any = {
              id: randomUUID().slice(0, 8), createdAt: Date.now(), repo: storeRoot, hasHead: true,
              source: "trace", gitDir, storeRoot, sessionId,
              promptLabel: body.label ? String(body.label) : undefined,
              base: refs.base || null, ref2: refs.ref2 || null,
              scope: { kind: "repo", path: "" },
              files: files.map((f: any) => ({ path: f.path, oldPath: f.oldPath || undefined, status: f.status, selected: true })),
              annotations: [], revision: 0, summary: "", diffHash: null, boundSessionId: null,
            };
            task.diffHash = await computeDiffHash(task);
            writeTask(task);
            return json({ ok: true, task });
          }
          const scope = body && body.scope && body.scope.path ? body.scope : { kind: "repo", path: "" };
          const rawFolder = (body && body.path) || (scope && scope.path) || "";
          if (!rawFolder) return json({ ok: false, error: "需要 path" }, 400);
          // scope.kind=file：仓库探测用父目录（path 可能是文件）——仅当无 body.path
          const folder = (!body || !body.path) && scope && scope.kind === "file"
            ? (rawFolder.lastIndexOf("/") > 0 ? rawFolder.slice(0, rawFolder.lastIndexOf("/")) : "/")
            : rawFolder;
          const { repo } = await openRepo(folder);
          // 版本参数：base = 基线（branch/tag/commitid；缺省 HEAD）；ref2 设置即两版本对比模式
          let refs: Refs;
          try {
            refs = await validateRefs(repo, body && body.base, body && body.ref2);
          } catch (e: any) {
            return json({ ok: false, error: (e && e.message) || String(e) }, 400);
          }
          const { files, hasHead } = await changeSet(repo, refs);
          // 文件白名单（选择器逐个勾选）优先；否则按 scope 过滤
          const allow = Array.isArray(body && body.files) && body.files.length > 0
            ? new Set((body!.files as string[]).map((f: string) => safeRel(repo, String(f))))
            : null;
          const relScope = scope && scope.path ? safeRel(repo, scope.path) : ".";
          const scoped = allow
            ? files.filter((f: any) => allow.has(f.path))
            : relScope === "."
              ? files
              : files.filter((f: any) => f.path === relScope || f.path.startsWith(relScope.replace(/\/$/, "") + "/"));
          if (scoped.length === 0) return json({ ok: false, error: "范围内无变更" + (refs.ref2 ? "（" + (refs.base || "HEAD") + " → " + refs.ref2 + "）" : ""), hasHead }, 404);
          const taskId = randomUUID().slice(0, 8);
          const task = {
            id: taskId, createdAt: Date.now(), repo, hasHead,
            base: refs.base || null, ref2: refs.ref2 || null,
            scope: allow ? { kind: "repo", path: "" } : { kind: scope.kind || "repo", path: relScope === "." ? "" : relScope },
            files: scoped.map((f: any) => ({ path: f.path, oldPath: f.oldPath || undefined, status: f.status, selected: true })),
            annotations: [], revision: 0, summary: "", diffHash: null, boundSessionId: null,
          };
          task.diffHash = await computeDiffHash(task); // 记录基线内容哈希，供后续 anchor 重映射比对漂移
          writeTask(task);
          // 可选：同时开 AI 预审会话（选择器勾选「AI 先预审」）——复用 launch-session 逻辑但不需 summary
          let aiSessionId: string | null = null;
          if (body && body.aiPre) {
            try {
              const origin = String((body && body.origin) || "");
              const basePath = String((body && body.basePath) || "");
              pendingReviewCwd = repo;
              pendingTaskId = taskId;
              const url = origin + basePath + "/api/agent/new";
              const resp = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  cwd: repo, type: "prompt",
                  message: "【预审任务】你是代码预审员，会话已绑定审核任务 " + taskId + "。审核范围：" + reviewLabel({ base: refs.base || null, ref2: refs.ref2 || null }) + "。请：\n1. aiti_review_status 摸底变更集\n2. 逐文件 aiti_review_diff 读 diff，对每个确凿问题用 aiti_review_comment 标到具体行（severity：must=必改/suggest=建议/question=疑问）\n3. 先 aiti_review_comments 查已有标注避免重复\n4. 结束时汇总：哪些 must 必改、哪些可缓、整体结论\n\n铁律：只标注和建议，绝不修改代码。行号以最新 diff 为准。" + (body && body.source === "trace" ? "\n\n【追踪仓说明】对照历史用独立追踪仓 GIT_DIR=" + repo + "/.aiti-trace（work-tree=" + repo + "；分支 refs/heads/aiti/<会话短id>；锚点 tag aiti/<会话短id>/before-N、after-N）。审核/回滚的操作对象是工作区真实文件，不是项目自身 git 历史——不要对项目仓执行 checkout/reset/revert。" : ""),
                }),
              }).catch(() => null);
              const data = resp ? await resp.json().catch(() => null) : null;
              const sid = data && (data.sessionId || (data.session && data.session.id));
              if (sid) {
                aiSessionId = String(sid);
                task.boundSessionId = aiSessionId;
                writeTask(task);
                reviewBindings.set(aiSessionId, taskId);
              }
            } finally { pendingReviewCwd = null; }
          }
          return json({ ok: true, task, aiSessionId });
        }

        // POST /diff { task, file } → 单文件结构化 diff
        if (p[0] === "diff" && req.method === "POST") {
          const body = await readBody(req);
          const task = loadTask(typeof body?.task === "string" ? body.task : "");
          const file = typeof body?.file === "string" ? body.file : "";
          if (!task) return json({ ok: false, error: "task not found" }, 404);
          const rel = safeRel(task.repo, file);
          const fe = (task.files || []).find((f: any) => f.path === rel);
          const d = await structuredDiff(task.repo, rel, fe && fe.oldPath, taskRefs(task), taskOpts(task));
          if (!d) return json({ ok: false, error: "no diff for " + rel }, 404);
          return json({ ok: true, file: rel, diff: d });
        }

        // POST /annotations { taskId, revision?, ops: [{op:'add'|'update'|'delete', ...}] }
        //   add: { file, side:'new'|'old', line, severity, text }
        //   update: { id, severity?, text?, resolved? }
        //   delete: { id }
        // revision 乐观锁：冲突（rev 不符）→ 409 返回最新 revision + task，让 client 合并重试
        if (p[0] === "annotations" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          const task = loadTask((body && body.taskId) || "");
          if (!task) return json({ ok: false, error: "task not found" }, 404);
          const reqRev = body && body.revision;
          if (typeof reqRev === "number" && reqRev !== task.revision) {
            return json({ ok: false, conflict: true, revision: task.revision, task }, 409);
          }
          const ops = (body && body.ops) || [];
          for (const op of ops) {
            if (!op || !op.op) continue;
            if (op.op === "add" && op.file) {
              const side = op.side === "old" ? "old" : "new";
              const line = Math.max(1, parseInt(op.line, 10) || 1);
              // 行范围（可选 lineEnd > line）：标注指向一个连续行段（起点 anchor 锚定，remap 平移保持 span）
              const endRaw = parseInt(op.lineEnd, 10) || 0;
              const lineEnd = endRaw > line ? endRaw : null;
              task.annotations.push({
                id: randomUUID().slice(0, 8),
                file: safeRel(task.repo, op.file),
                side,
                newLine: side === "new" ? line : null,
                oldLine: side === "old" ? line : null,
                newLineEnd: side === "new" ? lineEnd : null,
                oldLineEnd: side === "old" ? lineEnd : null,
                severity: op.severity || "suggest",
                text: String(op.text || ""),
                author: "human",
                resolved: false,
                ts: Date.now(),
                anchor: await anchorOf(task.repo, safeRel(task.repo, op.file), side, line, taskRefs(task), taskOpts(task)),
              });
            } else if (op.op === "update" && op.id) {
              const a = task.annotations.find((x: any) => x.id === op.id);
              if (a) {
                if (op.severity) a.severity = op.severity;
                if (op.text !== undefined) a.text = String(op.text);
                if (op.resolved !== undefined) a.resolved = !!op.resolved;
              }
            } else if (op.op === "delete" && op.id) {
              task.annotations = task.annotations.filter((x: any) => x.id !== op.id);
            }
          }
          task.revision++;
          writeTask(task);
          return json({ ok: true, revision: task.revision, task });
        }

        // POST /launch-session { taskId, origin, basePath } → 开启新会话（预审主通道）
        // POST /rollmarks { taskId, marks: [{file, hunkIdx, status?, result?}] } → 整体替换回滚标记
        // （标注式回滚：先标记→明确展示/可取消→提交时按开关由程序执行或打包给 AI）
        if (p[0] === "rollmarks" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          const task = loadTask((body && body.taskId) || "");
          if (!task) return json({ ok: false, error: "task not found" }, 404);
          task.rollmarks = (Array.isArray(body && body.marks) ? body.marks : []).map((m: any) => ({
            file: String(m.file || ""),
            hunkIdx: Array.isArray(m.hunkIdx) ? m.hunkIdx.map((i: any) => parseInt(i, 10) || 0) : [],
            status: m.status === "executed" || m.status === "failed" ? m.status : "marked",
            result: m.result ? String(m.result) : undefined,
            markedAt: Date.now(),
          })).filter((m: any) => m.file);
          task.revision = (task.revision || 0) + 1;
          writeTask(task);
          notifyTaskChanged(task);
          return json({ ok: true, task });
        }

        //   服务端调 {origin}{basePath}/api/agent/new { cwd, type:'prompt', message: summary, system }
        //   → 拿 sessionId → 写 task.boundSessionId → 返回给 client 跳转
        //   时序：fetch 前先设 pendingReviewCwd（agent/new 建会话期间 agentTools 命中门控），返回后清除
        if (p[0] === "launch-session" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          const task = loadTask((body && body.taskId) || "");
          if (!task) return json({ ok: false, error: "task not found" }, 404);
          const origin = String((body && body.origin) || "");
          const basePath = String((body && body.basePath) || "");
          if (!origin) return json({ ok: false, error: "需要 origin" }, 400);
          // 客户端编辑框当前内容优先 → 已保存的 task.summary → 现生成（避免用户刚改的汇总被旧值覆盖）
          const summary = typeof (body && body.summary) === "string" && body.summary.trim()
            ? String(body.summary)
            : (task.summary || (await buildSummary(task)));
          if (!task.summary) task.summary = summary;
          pendingReviewCwd = task.repo; // 建会话窗口门控（P-A 修复：必须在 fetch 前）
          const url = origin + basePath + "/api/agent/new";
          try {
            const resp = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                cwd: task.repo,
                type: "prompt",
                message: summary + "\n\n【预审任务】你是代码预审员。用户已审出上面汇总（file#line [severity]）。请：\n1. 用 aiti_review_diff 读变更文件真实代码，逐条核对标注（行号可能已漂移，以内容/标志行为准）\n2. 用 aiti_review_comment 补充新标注、aiti_review_comment_update 修订已有标注（severity/文字/标记解决）、aiti_review_comments 查现有标注避免重复\n3. 核对完输出终审建议（直接回复，列出每条最终结论）\n\n铁律：你是预审员，只标注和给建议，**绝不修改代码**。",
                system: undefined,
              }),
            }).catch((e) => null);
            const data = resp ? await resp.json().catch(() => null) : null;
            const sessionId = data && (data.sessionId || (data.session && data.session.id));
            if (!sessionId) return json({ ok: false, error: "建会话失败: " + JSON.stringify(data).slice(0, 200) }, 500);
            task.boundSessionId = String(sessionId);
            writeTask(task);
            reviewBindings.set(String(sessionId), task.id);
            return json({ ok: true, sessionId, task });
          } finally {
            pendingReviewCwd = null;
          }
        }

        // POST /ai-prebind { path } → ai-helper 帮助点链预备（通用契约：扩展自有帮助点在 invoke 建会前调，
        //   本扩展用它解决「工具只在建会时注入」的时序：复用最新任务或新建任务 → 开 pending 门控窗口 →
        //   agentTools 命中时懒绑定 sessionId→task 并持久化，工具随之注入该会话）
        if (p[0] === "ai-prebind" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          const q = String((body && body.path) || "");
          if (!q) return json({ ok: false, error: "需要 path" }, 400);
          const { repo } = await openRepo(q);
          // 复用该仓库最新任务（避免每次预审都堆新任务）；无则建全仓任务
          let task = latestTaskOf(repo);
          if (!task) {
            const { files, hasHead } = await changeSet(repo);
            if (files.length === 0) return json({ ok: false, error: "该仓库无未提交变更" }, 404);
            task = {
              id: randomUUID().slice(0, 8), createdAt: Date.now(), repo, hasHead,
              scope: { kind: "repo", path: "" },
              files: files.map((f: any) => ({ path: f.path, oldPath: f.oldPath || undefined, status: f.status, selected: true })),
              annotations: [], revision: 0, summary: "", diffHash: null, boundSessionId: null,
            };
            task.diffHash = await computeDiffHash(task);
            writeTask(task);
          }
          pendingReviewCwd = repo;
          pendingTaskId = task.id;
          return json({ ok: true, taskId: task.id, repo, files: task.files.length });
        }

        // DELETE /task?id= → 删除任务（选择器 🗑；有绑定 AI 会话也一并解绑——标注库随任务删）
        if (p[0] === "task" && req.method === "DELETE") {
          const id = (ctx.searchParams.get("id") || "").replace(/[^A-Za-z0-9_-]/g, "");
          if (!id) return json({ ok: false, error: "需要 id" }, 400);
          const fp = taskFile(id);
          if (!existsSync(fp)) return json({ ok: false, error: "task not found" }, 404);
          const t = loadTask(id);
          try { rmSync(fp); } catch (e: any) { return json({ ok: false, error: (e && e.message) || String(e) }, 500); }
          if (t && t.boundSessionId) reviewBindings.delete(String(t.boundSessionId));
          return json({ ok: true });
        }

        // POST /tasks { repo? } → 任务列表（id/repo/scope/文件数/标注数/创建时间/boundSessionId），新→旧——「打开现有审查」入口
        if (p[0] === "tasks" && req.method === "POST") {
          const body = await readBody(req);
          const repoFilter = typeof body?.repo === "string" ? body.repo : "";
          const out: any[] = [];
          try {
            for (const f of readdirSync(taskDir())) {
              if (!f.endsWith(".json")) continue;
              try {
                const t = JSON.parse(readFileSync(pathJoin(taskDir(), f), "utf8"));
                if (!t || !t.id) continue;
                if (repoFilter && t.repo !== repoFilter) continue;
                out.push({
                  id: t.id, repo: t.repo, scope: t.scope || { kind: "repo", path: "" },
                  base: t.base || null, ref2: t.ref2 || null,
                  files: (t.files || []).length, annotations: (t.annotations || []).length,
                  createdAt: t.createdAt, hasSummary: !!t.summary, boundSessionId: t.boundSessionId || null,
                });
              } catch (e) {}
            }
          } catch (e) {}
          out.sort((a: any, b: any) => b.createdAt - a.createdAt);
          return json({ ok: true, tasks: out });
        }

        // GET /summary?task= → 服务端兜底汇总（client 主要前端拼接，这里备用/导出）
        if (p[0] === "summary" && req.method === "GET") {
          const task = loadTask(ctx.searchParams.get("task") || "");
          if (!task) return json({ ok: false, error: "task not found" }, 404);
          return json({ ok: true, summary: await buildSummary(task) });
        }

        // POST /save { taskId, ...patch } → 保存任务（annotations/summary/...）
        if (p[0] === "save" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          const task = loadTask((body && body.taskId) || "");
          if (!task) return json({ ok: false, error: "task not found" }, 404);
          const allowed = ["annotations", "summary", "files", "revision"];
          for (const k of allowed) if (body && k in body) task[k] = body[k];
          writeTask(task);
          return json({ ok: true, task });
        }

        // GET /annotations?task= → 拉取标注（先做 anchor 重映射：内容漂移则更新行号/标 stale）
        if (p[0] === "annotations" && req.method === "GET") {
          const task = loadTask(ctx.searchParams.get("task") || "");
          if (!task) return json({ ok: false, error: "task not found" }, 404);
          try {
            const cur = await computeDiffHash(task);
            // 内容变了 → 重映射；否则只在首次进入（无 diffHash）时建立基线
            if (task.diffHash && task.diffHash !== cur) await remapAnnotations(task);
            else if (!task.diffHash) task.diffHash = cur;
            if (task._dirty) { writeTask(task); task._dirty = false; }
          } catch (e) {}
          return json({ ok: true, task });
        }

        // GET /load?task= → 读任务
        if (p[0] === "load" && req.method === "GET") {
          const task = loadTask(ctx.searchParams.get("task") || "");
          if (!task) return json({ ok: false, error: "task not found" }, 404);
          try {
            const cur = await computeDiffHash(task);
            if (task.diffHash && task.diffHash !== cur) await remapAnnotations(task);
            else if (!task.diffHash) task.diffHash = cur;
            if (task._dirty) { writeTask(task); task._dirty = false; }
          } catch (e) {}
          return json({ ok: true, task });
        }

        // POST /trace-revisions { sessionId, storeRoot? } → trace 台账「消息→操作」两级分组（修订选择器数据源）。
        // 台账读取：真实 <dataRoot>/aiti-git-trace/state/ops/<sid>.jsonl 优先 → mock fixture configDir/aiti-git-review/fixtures/trace-<sid>.jsonl。
        // 选两节点即 base/target（trace 任务的 refs）；diff/加注/汇总与 repo 任务同一套代码（gitDir 注入，§6.1）。
        if (p[0] === "trace-revisions" && req.method === "POST") {
          const body = await readBody(req);
          const safeId = String(body?.sessionId || "").replace(/[^A-Za-z0-9_-]/g, "");
          if (!safeId) return json({ ok: false, error: "需要 sessionId" }, 400);
          const real = pathJoin(pathDirname(pathDirname(configDir)), "aiti-git-trace", "state", "ops", safeId + ".jsonl");
          const fixture = pathJoin(configDir, "aiti-git-review", "fixtures", "trace-" + safeId + ".jsonl");
          const fp = existsSync(real) ? real : existsSync(fixture) ? fixture : null;
          if (!fp) return json({ ok: false, error: "trace 台账不存在（真实与 fixture 均无）：" + safeId }, 404);
          const storeRoot = typeof body?.storeRoot === "string" ? body.storeRoot : "";
          const ops = parseLedger(readFileSync(fp, "utf8"));
          return json({ ok: true, sessionId: safeId, ledger: fp === real ? "real" : "fixture", messages: groupRevisions(ops, storeRoot || undefined) });
        }

        return json({ ok: false, error: "not found" }, 404);
      } catch (e: any) {
        return json({ ok: false, error: (e && e.message) || String(e) }, 400);
      }
    },

    agent: {
      /** AI 分组精修等待兑现（git-ops M4 补遗）：宿主在会话 settle 时直送最终回答文本——
       *  事件驱动（非轮询）；未命中等待请求即静默返回。幂等：重复 settle 只兑现一次（已删表项）。 */
      onAgentSettled(info: { sessionId: string; text: string }) {
        const sid = String((info && info.sessionId) || "");
        const w = refinePending.get(sid);
        if (!w) return;
        refinePending.delete(sid);
        clearTimeout(w.timer);
        w.resolve(String((info && info.text) || ""));
      },

      agentTools(info: { sessionId?: string; cwd?: string }) {
        // 门控：已绑定评审任务的会话 / 建 ai-helper 预审会话的短暂窗口（pendingTaskId 懒绑定+持久化）→ 注入；否则 []（日常零工具）
        const sid = (info && info.sessionId) || "";
        const cwd = (info && info.cwd) || "";
        if (!reviewBindings.has(sid) && !(pendingReviewCwd && pendingReviewCwd === cwd)) return [];
        // ai-prebind 窗口命中：懒绑定（sessionId→task）并持久化，后续重建/GC 重开也能拿回工具
        if (!reviewBindings.has(sid) && pendingTaskId) {
          const t = loadTask(pendingTaskId);
          if (t) {
            t.boundSessionId = sid;
            writeTask(t);
            reviewBindings.set(sid, pendingTaskId);
            console.log("[aiti-git-review] ai-prebind 懒绑定: " + sid.slice(0, 8) + " → 任务 " + pendingTaskId);
          }
          pendingTaskId = null;
          pendingReviewCwd = null; // 单次消费：防同 cwd 并发建会误绑
        }

        return [
          {
            name: "aiti_review_status",
            label: "aiti_review_status",
            description: "列审核任务变更集（文件+状态），AI 摸底。参数 taskId（缺省取会话绑定任务）。",
            parameters: { type: "object", properties: { taskId: { type: "string" } } },
            async execute(_id: string, params: any) {
              const task = resolveTask(sid, params);
              if (!task) return { content: [{ type: "text", text: "未找到审核任务（需 taskId 或会话已绑定任务）" }], isError: true } as never;
              // 首行带对比范围：两版本/指定基线任务让 AI 明确知道在比哪两个版本
              const scope = task.ref2 ? "对比范围：" + (task.base || "HEAD") + " → " + task.ref2 : task.base ? "对比范围：工作区 vs " + task.base : "对比范围：未提交变更（vs HEAD）";
              return { content: [{ type: "text", text: scope + "\n" + JSON.stringify(task.files.map((f: any) => ({ path: f.path, status: f.status, selected: f.selected })), null, 2) }] } as never;
            },
          },
          {
            name: "aiti_review_diff",
            label: "aiti_review_diff",
            description: "取审核任务某文件的结构化 diff（hunks/segments 带 old/new 行号），AI 定位问题行。参数 taskId, file。",
            parameters: { type: "object", properties: { taskId: { type: "string" }, file: { type: "string" } }, required: ["file"] },
            async execute(_id: string, params: any) {
              const task = resolveTask(sid, params);
              if (!task) return { content: [{ type: "text", text: "未找到审核任务" }], isError: true } as never;
              try {
                const rel = safeRel(task.repo, String(params.file));
                // 只审已勾选（selected）文件：用户在工作区勾掉的文件不再进入 AI 视野
                const fe = (task.files || []).find((f: any) => f.path === rel);
                if (!fe) return { content: [{ type: "text", text: "文件不在任务变更集内：" + rel }], isError: true } as never;
                if (!fe.selected) return { content: [{ type: "text", text: "该文件已被用户从审查范围勾除（selected=false），跳过：" + rel }] } as never;
                const d = await structuredDiff(task.repo, rel, fe.oldPath, taskRefs(task), taskOpts(task));
                if (!d) return { content: [{ type: "text", text: "该文件无变更：" + params.file }] } as never;
                return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] } as never;
              } catch (e: any) {
                return { content: [{ type: "text", text: "读取 diff 失败：" + ((e && e.message) || e) }], isError: true } as never;
              }
            },
          },
          {
            name: "aiti_review_comment",
            label: "aiti_review_comment",
            description: "AI 在审核任务标注：文件 + 新侧行号（可选 lineEnd 指定行范围 26-28）+ severity（must/suggest/question）+ 评论 → 写入同一标注库（服务端自动快照 anchor 标志行）。返回新建标注 + 该行±3 行上下文供确认。参数 taskId, file, line, lineEnd?, severity, text。",
            parameters: { type: "object", properties: { taskId: { type: "string" }, file: { type: "string" }, line: { type: "number" }, lineEnd: { type: "number" }, severity: { type: "string", enum: ["must", "suggest", "question"] }, text: { type: "string" } }, required: ["file", "line", "text"] },
            async execute(_id: string, params: any) {
              const task = resolveTask(sid, params);
              if (!task) return { content: [{ type: "text", text: "未找到审核任务" }], isError: true } as never;
              const file = safeRel(task.repo, String(params.file || ""));
              const fe = (task.files || []).find((f: any) => f.path === file);
              if (!fe) {
                return { content: [{ type: "text", text: "文件不在任务变更集内：" + file }], isError: true } as never;
              }
              if (!fe.selected) return { content: [{ type: "text", text: "该文件已被用户从审查范围勾除，不能在其上标注。换 selected 文件或提示用户重新勾选。" + file }] } as never;
              const line = Math.max(1, parseInt(params.line, 10) || 1);
              const endRaw = parseInt(params.lineEnd, 10) || 0;
              const lineEnd = endRaw > line ? endRaw : null;
              const sev = ["must", "suggest", "question"].includes(params.severity) ? params.severity : "suggest";
              const anno = {
                id: randomUUID().slice(0, 8),
                file, side: "new", newLine: line, oldLine: null, newLineEnd: lineEnd, oldLineEnd: null,
                severity: sev, text: String(params.text || ""), author: "ai",
                resolved: false, ts: Date.now(),
                anchor: await anchorOf(task.repo, file, "new", line, taskRefs(task), taskOpts(task)),
              };
              task.annotations.push(anno);
              task.revision++;
              writeTask(task);
              // 行上下文（该行±3 行，供 AI 确认没标错行）
              let context = "";
              try {
                const lines = readFileSync(pathJoin(task.repo, file), "utf8").split("\n");
                context = lines.slice(Math.max(0, line - 4), line + 3).map((l: string, i: number) => (line - 3 + i) + ": " + l).join("\n");
              } catch (e) {}
              return { content: [{ type: "text", text: JSON.stringify({ ok: true, annotation: anno, lineContext: context }, null, 2) }] } as never;
            },
          },
          {
            name: "aiti_review_comments",
            label: "aiti_review_comments",
            description: "读审核任务现有标注（可按文件/未解决过滤），避免重复标注、在已有批注上补充。参数 taskId, file?, onlyOpen?。",
            parameters: { type: "object", properties: { taskId: { type: "string" }, file: { type: "string" }, onlyOpen: { type: "boolean" } } },
            async execute(_id: string, params: any) {
              const task = resolveTask(sid, params);
              if (!task) return { content: [{ type: "text", text: "未找到审核任务" }], isError: true } as never;
              let list = task.annotations || [];
              if (params.file) {
                const rel = safeRel(task.repo, String(params.file));
                list = list.filter((a: any) => a.file === rel);
              }
              if (params.onlyOpen) list = list.filter((a: any) => !a.resolved);
              return { content: [{ type: "text", text: list.length ? JSON.stringify(list, null, 2) : "（暂无标注）" }] } as never;
            },
          },
          {
            name: "aiti_review_comment_update",
            label: "aiti_review_comment_update",
            description: "修订已有标注（含 AI 自己标的）：改文字/severity/标记解决。参数 taskId, annotationId, text?, severity?, resolved?。",
            parameters: { type: "object", properties: { taskId: { type: "string" }, annotationId: { type: "string" }, text: { type: "string" }, severity: { type: "string" }, resolved: { type: "boolean" } }, required: ["annotationId"] },
            async execute(_id: string, params: any) {
              const task = resolveTask(sid, params);
              if (!task) return { content: [{ type: "text", text: "未找到审核任务" }], isError: true } as never;
              const a = task.annotations.find((x: any) => x.id === params.annotationId);
              if (!a) return { content: [{ type: "text", text: "标注不存在：" + params.annotationId }], isError: true } as never;
              if (params.text !== undefined) a.text = String(params.text);
              if (params.severity && ["must", "suggest", "question"].includes(params.severity)) a.severity = params.severity;
              if (params.resolved !== undefined) a.resolved = !!params.resolved;
              task.revision++;
              writeTask(task);
              return { content: [{ type: "text", text: JSON.stringify({ ok: true, annotation: a }) }] } as never;
            },
          },
          {
            name: "aiti_review_summarize",
            label: "aiti_review_summarize",
            description: "汇总审核任务全部标注为「file#line [severity] comment」长结论（终审清单）。参数 taskId。",
            parameters: { type: "object", properties: { taskId: { type: "string" } } },
            async execute(_id: string, params: any) {
              const task = resolveTask(sid, params);
              if (!task) return { content: [{ type: "text", text: "未找到审核任务" }], isError: true } as never;
              return { content: [{ type: "text", text: await buildSummary(task) }] } as never;
            },
          },
          // 工具清单见 docs/aiti-git-review-plan.md §6
        ];
      },
    },
  },
};

function resolveTask(sessionId: string, params: any): any {
  const taskId = (params && params.taskId) || reviewBindings.get(sessionId) || "";
  return taskId ? loadTask(taskId) : null;
}