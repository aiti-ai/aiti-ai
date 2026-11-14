/**
 * aiti-git-ops · git 写引擎核心（方案 docs/aiti-git-ops-shared-plan.md §1）
 *
 * 设计要点：
 * - 白名单子命令 + 每入口手写参数拼装，不经手用户原始 args（杜绝 --exec/--upload-pack 注入面）；
 * - ref 形参数一律先过基础校验（拒前置 "-"/控制字符/空白）+ rev-parse --verify --end-of-options
 *   解析（旧 git 无该标志时自动回退）/ check-ref-format 原生校验（分支/tag 名，unicode 合法名放行）；
 * - checkout 家族永不传 -f；reset 仅 --mixed；clean 不在白名单（untracked 走隔离区）；
 * - 路径输出一律 -z（NUL 分隔、永不引号化——中文/空格/引号/换行文件名原样透传；
 *   porcelain v1 默认 core.quotePath=true 会把非 ASCII 路径打成八进制转义，v1 行解析不可救）；
 * - 同仓写操作 + 预检读全部经 queueRepo 串行（§1.7）；
 * - 全部 execFileAsync（数组参数、无 shell——Windows 兼容天然合规，见 docs/windows-compat-lessons.md §0）；
 * - 审计 jsonl（state 层 5MB 滚动）+ 事件 onChanged 回调（index.ts 接 event-bus topic）。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, cp, appendFile, stat } from "node:fs/promises";
import { dirname, join, isAbsolute, relative, resolve as pathResolve } from "node:path";
import { execFileAsync, queueRepo } from "@aiti-ai/ext-shared/exec-async";

// ── 结构化错误 ───────────────────────────────────────────────────────────────

export interface GitOpsFail extends Error {
  status: number;
  conflict?: boolean;
  files?: string[];
  detail?: string;
}

export function fail(status: number, message: string, extra: Partial<GitOpsFail> = {}): never {
  const e = new Error(message) as GitOpsFail;
  e.status = status;
  Object.assign(e, extra);
  throw e;
}

const gitErr = (e: unknown, fallback: string): never => {
  const err = e as { stderr?: string; message?: string };
  const detail = err?.stderr ? "：" + String(err.stderr).split("\n").filter(Boolean).slice(0, 3).join("；")
    : err?.message ? "：" + err.message : "";
  fail(500, fallback + detail);
};

/** git 旧版本不认识新子命令/开关时的错误特征（restore 2.23 / stash push 2.13 / --end-of-options 2.24） */
const looksLikeUnknownOption = (e: unknown): boolean => {
  const s = String((e as { stderr?: string })?.stderr || "") + String((e as Error)?.message || "");
  return /unknown (option|switch)|unrecognized|unknown argument|^usage: /im.test(s);
};

// ── 引擎配置（index.ts startup 注入；state/cache 目录分层） ──────────────────

let stateDir = "";
let cacheDir = "";
let onChanged: ((repo: string, kind: string, summary: string) => void) | null = null;
let auditSource = "unknown";

export function initGitEngine(opts: {
  stateDir: string;
  cacheDir: string;
  onChanged?: (repo: string, kind: string, summary: string) => void;
  source?: string;
}) {
  stateDir = opts.stateDir;
  cacheDir = opts.cacheDir;
  onChanged = opts.onChanged ?? null;
  auditSource = opts.source ?? "unknown";
}

// 数据分层：审计（state，不可再生）→ <stateDir>/aiti-git-ops/git-ops.jsonl；
// 隔离区（cache，可整体 rm -rf 自愈）→ <cacheDir>/aiti-git-ops/discarded/<ts>/<rel>
const auditFile = () => join(stateDir, "aiti-git-ops", "git-ops.jsonl");
const quarantineRoot = () => join(cacheDir, "aiti-git-ops", "discarded");
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

async function audit(entry: Record<string, unknown>) {
  if (!stateDir) return;
  try {
    await mkdir(dirname(auditFile()), { recursive: true });
    const f = auditFile();
    try {
      const s = await stat(f);
      if (s.size > AUDIT_MAX_BYTES) await rename(f, f + ".1"); // 滚动（保留一代）
    } catch { /* 不存在 */ }
    await appendFile(f, JSON.stringify({ ts: new Date().toISOString(), source: auditSource, ...entry }) + "\n");
  } catch { /* 审计失败不阻断操作 */ }
}

const changed = (repo: string, kind: string, summary: string) => {
  try { abCache.delete(repo); } catch { /* 缓存失效失败不阻断 */ } // commit/sync 后 ahead-behind 立即新鲜
  try { onChanged?.(repo, kind, summary); } catch { /* 事件失败不阻断 */
  }
};

// ahead-behind 60s 内存 TTL（freshness 数据无需重启存续；§1.4 的 cache/ 磁盘缓存留 M2 按需）。
// ⚠ 声明须先于 changed() 引用之外的可读位置——运行时经 changed() 失效。
const abCache = new Map<string, { v: [number, number] | null; at: number }>();
const AB_TTL_MS = 60_000;

export const repoTopic = (repo: string) => "aiti-git-ops:changed:" + createHash("sha1").update(repo).digest("hex").slice(0, 12);

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** 仓库根解析：cwd 必须是绝对路径且落在 git 仓内；返回 toplevel */
export async function repoRoot(cwd: string): Promise<string> {
  if (!cwd || typeof cwd !== "string" || !isAbsolute(cwd)) fail(400, "cwd 必须是绝对路径");
  try {
    const out = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 15_000 });
    const root = out.trim();
    if (!root) fail(400, "不是 git 仓库: " + cwd);
    return root;
  } catch (e) {
    const first = String((e as { stderr?: string })?.stderr || "").split("\n").filter(Boolean)[0];
    fail(400, "不是 git 仓库: " + cwd + (first ? `（${first}）` : ""));
  }
}

const run = (repo: string, args: string[], timeoutMs = 120_000) =>
  execFileAsync("git", args, { cwd: repo, timeoutMs });

/** 路径穿越防护（拷自 aiti-git-review 生产验证实现） */
export function safeRel(base: string, target: string): string {
  const abs = pathResolve(base, target);
  const rel = relative(pathResolve(base), abs);
  // 不得用 pathResolve(rel)===abs 兜底——cwd 恰为 repo 根时会误判穿越
  if (rel.startsWith("..") || rel.startsWith("/") || isAbsolute(rel)) throw new Error("path outside repo: " + target);
  return rel === "" ? "." : rel;
}

/** ref 形参基础校验：拒前置 "-"（选项注入）、控制字符、空白、超长。
 *  unicode 分支名（如「分支-01」）是 git 合法 ref，放行——选项注入面已由
 *  「无 shell + 数组参数 + 值位拼装 + rev-parse --end-of-options」挡死，字符集不再人为收窄。 */
const CTL_RE = /[\u0000-\u001f\u007f]/;
export function assertSafeRef(ref: string, what = "ref"): string {
  if (typeof ref !== "string" || !ref || ref.length > 200 || ref.startsWith("-") || CTL_RE.test(ref) || /\s/.test(ref)) {
    fail(400, `非法 ${what}: ${JSON.stringify(ref)}`);
  }
  return ref;
}

/** 分支/tag 名校验：基础校验 + git 原生 check-ref-format（全量规则：..、.lock、@{ 等由 git 拒） */
export async function assertBranchName(repo: string, name: string, kind: "branch" | "tag" = "branch") {
  assertSafeRef(name, kind === "tag" ? "tag 名" : "分支名");
  const args = kind === "tag" ? ["check-ref-format", `refs/tags/${name}`] : ["check-ref-format", "--branch", name];
  try {
    await run(repo, args, 15_000);
  } catch {
    fail(400, `非法${kind === "tag" ? " tag" : "分支"}名: ${JSON.stringify(name)}`);
  }
  return name;
}

/** 任意 ref → commit sha（存在性 + 注入双验证；旧 git 无 --end-of-options 自动回退） */
export async function resolveCommit(repo: string, ref: string): Promise<string> {
  assertSafeRef(ref);
  const tryParse = (flag: boolean) =>
    run(repo, flag ? ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`] : ["rev-parse", "--verify", `${ref}^{commit}`], 15_000);
  try {
    return (await tryParse(true)).trim();
  } catch (e) {
    if (looksLikeUnknownOption(e)) {
      try { return (await tryParse(false)).trim(); } catch { /* 落到 404 */ }
    }
    fail(404, "ref 不存在或不是 commit: " + ref);
  }
}

async function headSha(repo: string): Promise<string> {
  try {
    return (await run(repo, ["rev-parse", "HEAD"], 15_000)).trim();
  } catch (e) {
    gitErr(e, "无 HEAD（空仓库？）");
  }
}

// ── status / diff 路径解析（一律 -z：NUL 分隔、不引号化，全文件名形态安全） ───

export interface StatusEntry { xy: string; path: string }

/**
 * `git status --porcelain -z` 解析。记录形态：
 *   `XY <path>\0`；rename/copy 为 `XY <to>\0<from>\0`（注意 -z 下 to 在前）。
 * path 为 TO（rename 覆盖面以新路径为准）；未跟踪目录保持 `dir/` 尾斜杠形态。
 */
export function parseStatusZ(out: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const toks = out.split("\0");
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    const xy = t.slice(0, 2);
    const p = t.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // 跳过 FROM 路径（下一 token）
    entries.push({ xy, path: p });
  }
  return entries;
}

async function statusEntries(repo: string): Promise<StatusEntry[]> {
  return parseStatusZ(await run(repo, ["status", "--porcelain", "-z"], 15_000));
}

// ── checkout 预检管道（§1.3） ────────────────────────────────────────────────

/**
 * dirty ∩ affected 预检。返回冲突文件列表；空数组 = 放行。
 * 豁免：目标 commit 与当前 HEAD 相同（必然无文件变化）。
 */
export async function precheckConflict(repo: string, targetSha: string): Promise<string[]> {
  const head = await headSha(repo);
  if (head === targetSha) return [];
  const dirty = (await statusEntries(repo)).map((e) => e.path);
  const affected = (await run(repo, ["diff", "--name-only", "--no-renames", "-z", "HEAD", targetSha], 30_000))
    .split("\0").filter(Boolean);
  const aff = new Set(affected);
  return dirty.filter((p) => aff.has(p) || aff.has(p.replace(/\/$/, "")));
}

// ── API 实现（每个入口手写参数拼装） ─────────────────────────────────────────

export interface Refs {
  repo: string;
  current: string | null;
  detached: boolean;
  /** HEAD 全 sha（detached 时为该 commit；空仓库 null）——plan baseHEAD/回滚用 */
  head: string | null;
  branches: string[];
  remotes: string[];
  tags: string[];
  aheadBehind: [number, number] | null;
  dirtyCount: number;
  dirtyFiles: { xy: string; path: string }[];
}

// ahead-behind 60s 内存 TTL（freshness 数据无需重启存续；§1.4 的 cache/ 磁盘缓存留 M2 按需）

export async function gitRefs(cwd: string): Promise<Refs> {
  const repo = await repoRoot(cwd);
  const eachRef = async (pattern: string, cap: number) =>
    (await run(repo, ["for-each-ref", "--format=%(refname:short)", `--count=${cap}`, pattern], 30_000))
      .split("\n").map((s) => s.trim()).filter(Boolean);
  let current: string | null = null;
  let detached = false;
  try {
    current = (await run(repo, ["symbolic-ref", "--short", "HEAD"], 15_000)).trim();
  } catch {
    detached = true;
    current = (await headSha(repo)).slice(0, 12);
  }
  let ab = abCache.get(repo);
  if (!ab || Date.now() - ab.at > AB_TTL_MS) {
    let v: [number, number] | null = null;
    try {
      const parts = (await run(repo, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], 30_000)).trim().split(/\s+/);
      if (parts.length === 2) v = [Number(parts[0]), Number(parts[1])];
    } catch { /* 无 upstream */ }
    ab = { v, at: Date.now() };
    abCache.set(repo, ab);
  }
  const dirty = await statusEntries(repo);
  let head: string | null = null;
  try {
    head = (await run(repo, ["rev-parse", "HEAD"], 15_000)).trim() || null;
  } catch { /* 空仓库无 HEAD */ }
  return {
    repo, current, detached, head,
    branches: await eachRef("refs/heads", 500),
    remotes: await eachRef("refs/remotes", 200),
    tags: await eachRef("refs/tags", 200),
    aheadBehind: ab.v,
    dirtyCount: dirty.length,
    // 部分暂存勾选清单（cap 200 防超大脏区；xy 供 UI 标 staged/??）
    dirtyFiles: dirty.slice(0, 200).map((e) => ({ xy: e.xy, path: e.path })),
  };
}

/**
 * stash 条目文件清单（部分提取勾选用）：tracked = diff name-only（该 stash 的已跟踪改动）；
 * untracked = ls-tree 第三父（仅 -u 入 stash 的条目有）。条目保留不 drop 的提取语义见 stashApply。
 */
export async function stashFiles(cwd: string, index: number): Promise<{ tracked: string[]; untracked: string[] }> {
  const repo = await repoRoot(cwd);
  const ref = stashRef(index);
  let tracked: string[] = [];
  try {
    tracked = (await run(repo, ["diff", "--name-only", "--no-renames", "-z", `${ref}^`, ref], 30_000)).split("\0").filter(Boolean);
  } catch (e) {
    gitErr(e, "stash 文件清单失败");
  }
  let untracked: string[] = [];
  try {
    untracked = (await run(repo, ["ls-tree", "-r", "-z", "--name-only", `${ref}^3`], 30_000)).split("\0").filter(Boolean);
  } catch { /* 该 stash 无未跟踪部分 */ }
  return { tracked, untracked };
}

/**
 * 图谱分页。注意：`git log --graph` 与 `--skip` 不兼容（静默返回空，实测 git 2.48），
 * 改为 --max-count=(skip+count+1) 后本地切片；是否还有下一页用 rev-list --count 判断。
 */
export async function gitLog(cwd: string, cursor: number, count = 50): Promise<{ lines: string[]; nextCursor: number | null }> {
  const repo = await repoRoot(cwd);
  const skip = Number.isInteger(cursor) && cursor > 0 ? cursor : 0;
  const out = await run(repo, ["log", "--graph", "--oneline", "--date-order", `--max-count=${skip + count + 1}`], 60_000);
  const all = out.split("\n");
  if (all[all.length - 1] === "") all.pop();
  const lines = all.slice(skip, skip + count);
  let nextCursor: number | null = null;
  if (lines.length === count) {
    try {
      const total = Number((await run(repo, ["rev-list", "--count", "HEAD"], 30_000)).trim());
      if (skip + count < total) nextCursor = skip + count;
    } catch { /* 空仓库 */ }
  }
  return { lines, nextCursor };
}

/** checkout 家族统一入口（永不 -f；mode=stash-then-switch 时先 stash 后切） */
export async function gitCheckout(cwd: string, ref: string, mode?: string): Promise<{ ok: true; branch: string }> {
  const repo = await repoRoot(cwd);
  assertSafeRef(ref, "ref");
  return queueRepo(repo, async () => {
    const sha = await resolveCommit(repo, ref);
    // mode=stash-then-switch 是 409 三选一里用户确认后的重入——不再拦，直接 stash 后切
    if (mode !== "stash-then-switch") {
      const conflict = await precheckConflict(repo, sha);
      if (conflict.length > 0) fail(409, "脏文件与目标分支改动重叠", { conflict: true, files: conflict });
    } else {
      try {
        await run(repo, ["stash", "push", "--include-untracked", "-m", "aiti-git-ops: switch to " + ref]);
      } catch (e) {
        gitErr(e, "stash 失败（切换中止，工作区未动）");
      }
    }
    try {
      await run(repo, ["checkout", ref]);
    } catch (e) {
      gitErr(e, "checkout 失败");
    }
    await audit({ repo, cmd: "checkout", ref, mode: mode ?? "direct" });
    changed(repo, "branch", "checkout " + ref);
    return { ok: true as const, branch: ref };
  });
}

export async function gitBranchCreate(cwd: string, name: string, from?: string, checkout = true): Promise<{ ok: true; branch: string }> {
  const repo = await repoRoot(cwd);
  await assertBranchName(repo, name);
  return queueRepo(repo, async () => {
    const fromSha = await resolveCommit(repo, from || "HEAD");
    // 预检豁免（v2）：from === 当前 HEAD 时建并检出永不改文件
    if (checkout && fromSha !== (await headSha(repo))) {
      const conflict = await precheckConflict(repo, fromSha);
      if (conflict.length > 0) fail(409, "脏文件与起点 commit 改动重叠", { conflict: true, files: conflict });
    }
    try {
      if (checkout) await run(repo, ["checkout", "-b", name, fromSha]);
      else await run(repo, ["branch", name, fromSha]);
    } catch (e) {
      gitErr(e, "建分支失败");
    }
    await audit({ repo, cmd: "branch-create", name, from: fromSha, checkout });
    changed(repo, "branch", "create " + name);
    return { ok: true as const, branch: name };
  });
}

export async function gitBranchDelete(cwd: string, name: string): Promise<{ ok: true }> {
  const repo = await repoRoot(cwd);
  await assertBranchName(repo, name);
  return queueRepo(repo, async () => {
    try {
      await run(repo, ["branch", "-d", name]);
    } catch (e) {
      gitErr(e, "删除失败（-d 安全删：未合并的分支会被 git 拒绝）");
    }
    await audit({ repo, cmd: "branch-delete", name });
    changed(repo, "branch", "delete " + name);
    return { ok: true as const };
  });
}

export async function gitTags(cwd: string): Promise<{ tags: { name: string; type: string; date: string }[] }> {
  const repo = await repoRoot(cwd);
  const out = await run(repo, ["for-each-ref", "--count=200", "--format=%(refname:short)%09%(objecttype)%09%(creatordate:iso8601)", "refs/tags"], 30_000);
  const tags = out.split("\n").filter(Boolean).map((l) => {
    const [name, type, date] = l.split("\t");
    return { name, type, date };
  });
  return { tags };
}

export async function gitTagCreate(cwd: string, name: string, ref?: string, opts?: { annotate?: boolean; message?: string }): Promise<{ ok: true }> {
  const repo = await repoRoot(cwd);
  await assertBranchName(repo, name, "tag");
  return queueRepo(repo, async () => {
    const args = ["tag"];
    if (opts?.annotate || opts?.message) args.push("-a", "-m", opts?.message || name);
    args.push(name);
    if (ref) args.push(await resolveCommit(repo, ref));
    try {
      await run(repo, args);
    } catch (e) {
      gitErr(e, "建 tag 失败");
    }
    await audit({ repo, cmd: "tag-create", name, ref: ref || "HEAD" });
    changed(repo, "branch", "tag " + name);
    return { ok: true as const };
  });
}

// ── commit 详情 / cherry-pick（图谱 commit 卡，方案 docs/aiti-git-ops-commit-card-plan.md）──

export interface CommitFile { path: string; oldPath?: string; status: string; additions: number; deletions: number }

export interface CommitInfo {
  sha: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  parents: string[];
  /** merge commit（files = 与第一父的 diff） */
  merge: boolean;
  files: CommitFile[];
  additions: number;
  deletions: number;
}

/** 空树 sha（root commit 的 diff base；对象不必存在于 odb，git 特判。sha256 仓库不同——极端边界，报错透出） */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function commitParents(repo: string, sha: string): Promise<string[]> {
  try {
    return (await run(repo, ["rev-list", "--parents", "-n", "1", sha], 15_000)).trim().split(/\s+/).slice(1).filter(Boolean);
  } catch (e) {
    gitErr(e, "读取 parent 失败");
  }
}

/**
 * commit 文件清单：name-status（状态 + old/new）× numstat（增删行数）两路合并。
 * `-z` rename 记录 token 序（2026-09-19 git 2.48 fixture 实测钉死，勿凭文档记忆改）：
 *   name-status = `R100\0<old>\0<new>\0`；numstat = `<add>\t<del>\t\0<old>\0<new>\0`（path 位空）。
 */
async function commitFileList(repo: string, base: string, sha: string): Promise<CommitFile[]> {
  const statusOut = await run(repo, ["diff", "--name-status", "-z", "-M", base, sha], 30_000).catch((e) => gitErr(e, "读取 commit 状态失败"));
  const numOut = await run(repo, ["diff", "--numstat", "-z", "-M", base, sha], 30_000).catch((e) => gitErr(e, "读取 commit 文件清单失败"));
  const ns: { status: string; path: string; oldPath?: string }[] = [];
  {
    const toks = statusOut.split("\0");
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t) continue;
      const letter = t[0] || "?";
      const first = toks[++i] ?? "";
      if (letter === "R" || letter === "C") {
        const second = toks[++i] ?? "";
        ns.push({ status: letter, path: second || first, oldPath: second ? first : undefined });
      } else {
        ns.push({ status: letter, path: first });
      }
    }
  }
  const counts = new Map<string, { a: number; d: number }>();
  {
    const toks = numOut.split("\0");
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t) continue;
      const i1 = t.indexOf("\t");
      const i2 = i1 >= 0 ? t.indexOf("\t", i1 + 1) : -1;
      if (i1 < 0 || i2 < 0) continue; // 防御：畸形记录跳过
      const rec = { a: Number(t.slice(0, i1)) || 0, d: Number(t.slice(i1 + 1, i2)) || 0 };
      const pathPart = t.slice(i2 + 1);
      if (pathPart === "") {
        const oldP = toks[++i] ?? "";
        const newP = toks[++i] ?? "";
        counts.set(oldP, rec);
        counts.set(newP, rec);
      } else {
        counts.set(pathPart, rec);
      }
    }
  }
  return ns.map((e) => {
    const c = counts.get(e.path) ?? counts.get(e.oldPath ?? "") ?? { a: 0, d: 0 };
    return { path: e.path, oldPath: e.oldPath, status: e.status, additions: c.a, deletions: c.d };
  });
}

/** commit 元信息 + 变更文件清单（merge 取第一父 diff——与 GitHub 一致；root commit 对空树） */
export async function gitCommitShow(cwd: string, ref: string): Promise<CommitInfo> {
  const repo = await repoRoot(cwd);
  const sha = await resolveCommit(repo, ref);
  // 字段分隔用 %x1f（单元分隔符）：subject/body 可含 \t 与任意可打印字符
  const meta = await run(repo, ["show", "-s", "--format=%x1f%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P", sha], 15_000).catch((e) => gitErr(e, "读取 commit 失败"));
  const f = meta.split("\x1f");
  const parents = (f[7] ?? "").split(/\s+/).filter(Boolean);
  const base = parents[0] || EMPTY_TREE_SHA;
  const files = await commitFileList(repo, base, sha);
  return {
    sha,
    author: f[2] ?? "",
    email: f[3] ?? "",
    date: f[4] ?? "",
    subject: f[5] ?? "",
    body: (f[6] ?? "").replace(/\n$/, ""),
    parents,
    merge: parents.length > 1,
    files,
    additions: files.reduce((s, x) => s + x.additions, 0),
    deletions: files.reduce((s, x) => s + x.deletions, 0),
  };
}

/** 单文件 patch 面板内嵌查看上限（截断在行边界；完整审阅引导跳 aiti-git-review） */
const COMMIT_DIFF_MAX_BYTES = 400 * 1024;

export async function gitCommitDiff(cwd: string, ref: string, paths: unknown): Promise<{ patch: string; truncated: boolean }> {
  const repo = await repoRoot(cwd);
  const sha = await resolveCommit(repo, ref);
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 4) fail(400, "paths 必须是 1-4 个文件路径（rename 传 [新路径, 旧路径]）");
  const rels = paths.map((p) => {
    if (typeof p !== "string" || !p) fail(400, "path 必须是非空字符串");
    try {
      return safeRel(repo, p);
    } catch {
      fail(400, "路径越界: " + p);
    }
  });
  const parents = await commitParents(repo, sha);
  const base = parents[0] || EMPTY_TREE_SHA;
  let out = "";
  try {
    out = await run(repo, ["diff", base, sha, "--", ...rels], 60_000);
  } catch (e) {
    gitErr(e, "读取 diff 失败");
  }
  const buf = Buffer.from(out, "utf8");
  if (buf.length <= COMMIT_DIFF_MAX_BYTES) return { patch: out, truncated: false };
  const cut = buf.subarray(0, COMMIT_DIFF_MAX_BYTES).toString("utf8");
  const nl = cut.lastIndexOf("\n");
  return { patch: (nl > 0 ? cut.slice(0, nl) : cut) + "\n…（已截断）", truncated: true };
}

/**
 * cherry-pick 到当前分支。冲突（CHERRY_PICK_HEAD 在位）→ 409 + 未合并文件清单——
 * 仓库留在 cherry-pick 中间态，UI 必须给出 abort 出口（opts.abort → --abort）。
 */
export async function gitCherryPick(cwd: string, ref: string, opts?: { abort?: boolean }): Promise<{ ok: true; sha?: string }> {
  const repo = await repoRoot(cwd);
  return queueRepo(repo, async () => {
    if (opts?.abort) {
      try {
        await run(repo, ["cherry-pick", "--abort"]);
      } catch (e) {
        gitErr(e, "终止 cherry-pick 失败（没有进行中的 cherry-pick？）");
      }
      await audit({ repo, cmd: "cherry-pick-abort" });
      changed(repo, "commit", "cherry-pick abort");
      return { ok: true as const };
    }
    const sha = await resolveCommit(repo, ref);
    try {
      await run(repo, ["cherry-pick", sha]);
    } catch (e) {
      const inPick = await run(repo, ["rev-parse", "--verify", "-q", "CHERRY_PICK_HEAD"], 15_000).then(() => true, () => false);
      if (inPick) {
        const files = (await run(repo, ["diff", "--name-only", "--diff-filter=U", "-z"], 30_000)).split("\0").filter(Boolean);
        fail(409, "cherry-pick 冲突（可用「终止 cherry-pick」回到原状）", { conflict: true, files });
      }
      gitErr(e, "cherry-pick 失败（工作区有未提交改动？）");
    }
    await audit({ repo, cmd: "cherry-pick", sha });
    changed(repo, "commit", "cherry-pick " + sha.slice(0, 8));
    return { ok: true as const, sha };
  });
}

// ── 暂存 / 丢弃 / 提交 ──────────────────────────────────────────────────────

const relPaths = (repo: string, paths: unknown): string[] => {
  if (!Array.isArray(paths) || paths.length === 0) fail(400, "paths 必须是非空数组");
  return paths.map((p) => {
    if (typeof p !== "string") fail(400, "path 必须是字符串");
    try {
      return safeRel(repo, p);
    } catch {
      fail(400, "路径越界: " + p);
    }
  });
};

/** 嵌套去重：勾选了 ["dir", "dir/f.txt"] 时丢弃 dir/f.txt（dir 搬走后子路径已不存在） */
function dedupNested(paths: string[]): string[] {
  const sorted = [...paths].sort();
  const out: string[] = [];
  for (const p of sorted) {
    if (out.length === 0 || !p.startsWith(out[out.length - 1] + "/")) out.push(p);
  }
  return out;
}

/** 旧 git（<2.23）无 restore 时的回退：reset（index）/ checkout（worktree）等价形态 */
async function restoreOrLegacy(repo: string, trackedArgs: string[][], legacyArgs: string[][]): Promise<void> {
  try {
    for (const a of trackedArgs) await run(repo, a);
  } catch (e) {
    if (!looksLikeUnknownOption(e)) gitErr(e, "git restore 失败");
    for (const a of legacyArgs) await run(repo, a);
  }
}

export async function gitStage(cwd: string, paths: string[]): Promise<{ ok: true }> {
  const repo = await repoRoot(cwd);
  const rels = relPaths(repo, paths);
  return queueRepo(repo, async () => {
    try {
      await run(repo, ["add", "--", ...rels]);
    } catch (e) {
      gitErr(e, "暂存失败");
    }
    await audit({ repo, cmd: "stage", paths: rels });
    changed(repo, "stage", `stage ${rels.length} 文件`);
    return { ok: true as const };
  });
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<{ ok: true }> {
  const repo = await repoRoot(cwd);
  const rels = relPaths(repo, paths);
  return queueRepo(repo, async () => {
    await restoreOrLegacy(repo, [["restore", "--staged", "--", ...rels]], [["reset", "-q", "--", ...rels]]);
    await audit({ repo, cmd: "unstage", paths: rels });
    changed(repo, "stage", `unstage ${rels.length} 文件`);
    return { ok: true as const };
  });
}

/**
 * 丢弃工作区改动（IDE 语义：暂存区+工作区一起丢）。
 * 全版本原语组合（不依赖 restore——Apple Git 2.24 的 restore --worktree --staged
 * 无 --source 时 worktree 从 index 取内容，新增文件删不掉，实测 mac）：
 *   reset -q（全部 unstage）→ ls-tree HEAD 分流：在 HEAD 的 checkout 恢复内容；
 *   不在 HEAD（staged 新增）的 fs.rm 删文件。untracked 整树搬隔离区（EXDEV 回退 cp+rm）。
 */
export async function gitDiscard(cwd: string, paths: string[]): Promise<{ ok: true; quarantined: string[] }> {
  const repo = await repoRoot(cwd);
  const rels = dedupNested(relPaths(repo, paths));
  return queueRepo(repo, async () => {
    const entries = await statusEntries(repo);
    const untrackedSet = new Set(entries.filter((e) => e.xy === "??").map((e) => e.path));
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const rel of rels) {
      if (untrackedSet.has(rel) || untrackedSet.has(rel + "/")) untracked.push(rel);
      else tracked.push(rel);
    }
    const quarantined: string[] = [];
    if (tracked.length > 0) {
      await run(repo, ["reset", "-q", "--", ...tracked]);
      let headFiles = new Set<string>();
      try {
        const ls = await run(repo, ["ls-tree", "-r", "-z", "--name-only", "HEAD"], 30_000);
        headFiles = new Set(ls.split("\0").filter(Boolean));
      } catch { /* 空仓库无 HEAD：tracked 全是新增 */ }
      const inHead = tracked.filter((p) => headFiles.has(p));
      const added = tracked.filter((p) => !headFiles.has(p));
      if (inHead.length > 0) {
        try {
          await run(repo, ["checkout", "--", ...inHead]);
        } catch (e) {
          gitErr(e, "丢弃已跟踪文件改动失败");
        }
      }
      for (const p of added) {
        await rm(join(repo, p), { force: true, recursive: false });
      }
    }
    if (untracked.length > 0) {
      if (!cacheDir) fail(500, "cacheDir 未配置，无法隔离未跟踪文件");
      const ts = Date.now();
      for (const rel of untracked) {
        const src = join(repo, rel);
        const dest = join(quarantineRoot(), String(ts), rel);
        await mkdir(dirname(dest), { recursive: true });
        try {
          await rename(src, dest);
        } catch (e) {
          if ((e as { code?: string })?.code === "EXDEV") {
            await cp(src, dest, { recursive: true, errorOnExist: true, force: false });
            await rm(src, { recursive: true, force: true });
          } else {
            gitErr(e, "隔离区搬移失败: " + rel);
          }
        }
        quarantined.push(dest);
      }
    }
    await audit({ repo, cmd: "discard", paths: rels, quarantined });
    changed(repo, "stage", `discard ${rels.length} 文件`);
    return { ok: true as const, quarantined };
  });
}

/**
 * 将路径追加进仓库 .gitignore（变更列表「加入 .gitignore」动作，主要面向 untracked 新文件）。
 * 规则：条目 = 相对仓库根的正斜杠路径（.gitignore 在根，相对语义精确命中）；
 * 已存在等值行（trim 后比对）则跳过；原文件末尾无换行时先补换行再追加。
 */
export async function gitIgnoreAdd(cwd: string, paths: string[]): Promise<{ ok: true; added: string[]; skipped: string[] }> {
  const repo = await repoRoot(cwd);
  const rels = relPaths(repo, paths);
  return queueRepo(repo, async () => {
    const giPath = join(repo, ".gitignore");
    let existing = "";
    try {
      existing = await readFile(giPath, "utf8");
    } catch { /* 无 .gitignore：新建 */ }
    const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const added: string[] = [];
    const skipped: string[] = [];
    let content = existing;
    if (content && !content.endsWith("\n")) content += "\n";
    for (const rel of rels) {
      const entry = rel.replace(/\\/g, "/");
      if (lines.has(entry)) {
        skipped.push(entry);
        continue;
      }
      lines.add(entry);
      content += entry + "\n";
      added.push(entry);
    }
    if (added.length > 0) {
      await appendFile(giPath, added.map((e) => e + "\n").join(""), "utf8");
      await audit({ repo, cmd: "ignore-add", paths: added });
      changed(repo, "stage", `ignore +${added.length}`);
    }
    return { ok: true as const, added, skipped };
  });
}

export async function gitCommit(cwd: string, message?: string, amend = false): Promise<{ ok: true; sha: string; summary: string }> {
  const repo = await repoRoot(cwd);
  if (!amend && (!message || typeof message !== "string")) fail(400, "缺少提交消息");
  return queueRepo(repo, async () => {
    const args = ["commit"];
    if (amend) {
      args.push("--amend");
      if (message) args.push("-m", message);
      else args.push("--no-edit");
    } else args.push("-m", message as string);
    try {
      await run(repo, args);
    } catch (e) {
      gitErr(e, "提交失败（无暂存内容？）");
    }
    const sha = (await run(repo, ["rev-parse", "HEAD"], 15_000)).trim();
    const summary = (await run(repo, ["log", "-1", "--pretty=%s"], 15_000)).trim();
    await audit({ repo, cmd: "commit", sha, message: summary });
    changed(repo, "commit", "commit: " + summary);
    return { ok: true as const, sha, summary };
  });
}

// ── plan 逐组执行（断点续跑） ────────────────────────────────────────────────

export interface PlanGroup { files: string[]; message: string }

export async function gitPlanExecute(cwd: string, groups: PlanGroup[]): Promise<{ ok: boolean; completed: number; failedGroup: number | null; shas: string[]; error?: string }> {
  const repo = await repoRoot(cwd);
  if (!Array.isArray(groups) || groups.length === 0) fail(400, "groups 必须是非空数组");
  return queueRepo(repo, async () => {
    const shas: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g || !Array.isArray(g.files) || g.files.length === 0 || !g.message) {
        return { ok: false, completed: i, failedGroup: i, shas, error: `第 ${i + 1} 组格式非法（files 非空 + message 必填）` };
      }
      const rels = relPaths(repo, g.files);
      try {
        await run(repo, ["add", "--", ...rels]);
        await run(repo, ["commit", "-m", g.message]);
        shas.push((await run(repo, ["rev-parse", "HEAD"], 15_000)).trim());
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        await audit({ repo, cmd: "plan-execute", failedGroup: i, error: err.stderr || err.message });
        return { ok: false, completed: i, failedGroup: i, shas, error: String(err.stderr || err.message || "").split("\n")[0] };
      }
    }
    await audit({ repo, cmd: "plan-execute", groups: groups.length, shas });
    changed(repo, "commit", `plan execute ${groups.length} 组`);
    return { ok: true, completed: groups.length, failedGroup: null, shas };
  });
}

/** 回滚本计划 = reset --mixed <baseHEAD>（仅显式按钮调用；禁 --hard） */
export async function gitPlanRollback(cwd: string, baseHEAD: string): Promise<{ ok: true }> {
  const repo = await repoRoot(cwd);
  return queueRepo(repo, async () => {
    const sha = await resolveCommit(repo, baseHEAD);
    try {
      await run(repo, ["reset", "--mixed", sha]);
    } catch (e) {
      gitErr(e, "回滚失败");
    }
    await audit({ repo, cmd: "plan-rollback", baseHEAD: sha });
    changed(repo, "commit", "plan rollback");
    return { ok: true as const };
  });
}

// ── stash 家族 ──────────────────────────────────────────────────────────────

const stashRef = (index: number) => {
  if (!Number.isInteger(index) || index < 0) fail(400, "index 必须是非负整数");
  return `stash@{${index}}`;
};

export async function stashList(cwd: string): Promise<{ items: { ref: string; sha: string; date: string; message: string }[] }> {
  const repo = await repoRoot(cwd);
  let out = "";
  try {
    // -z：记录 NUL 结尾（消息可含任意字符不串行）；%s 为 subject（无换行），\t 分隔前 3 字段
    out = await run(repo, ["stash", "list", "-z", "--date=iso", "--pretty=format:%gd%x09%H%x09%cd%x09%s"], 30_000);
  } catch (e) {
    gitErr(e, "stash list 失败");
  }
  const items = out.split("\0").filter(Boolean).map((rec) => {
    const parts = rec.split("\t");
    return { ref: parts[0], sha: parts[1], date: parts[2], message: parts.slice(3).join("\t") };
  });
  return { items };
}

export async function stashPush(cwd: string, opts: { message?: string; includeUntracked?: boolean; paths?: string[] }): Promise<{ ok: true; hadChanges: boolean }> {
  const repo = await repoRoot(cwd);
  return queueRepo(repo, async () => {
    const args = ["stash", "push"];
    if (opts.includeUntracked) args.push("--include-untracked");
    if (opts.message) args.push("-m", opts.message);
    let rels: string[] | null = null;
    if (opts.paths) {
      rels = relPaths(repo, opts.paths);
      args.push("--", ...rels);
    }
    // 失败必须透传（pathspec 不匹配/锁冲突等）——静默 ok 会让 UI 误报「已暂存」
    let out = "";
    try {
      out = await run(repo, args);
    } catch (e) {
      gitErr(e, "stash push 失败");
    }
    const hadChanges = !/No local changes to save/i.test(out);
    await audit({ repo, cmd: "stash-push", paths: rels ?? "(all)", hadChanges });
    if (hadChanges) changed(repo, "stash", "stash push");
    return { ok: true as const, hadChanges };
  });
}

export async function stashApply(cwd: string, index: number, opts: { pop?: boolean; paths?: string[] }): Promise<{ ok: true }> {
  const repo = await repoRoot(cwd);
  const ref = stashRef(index);
  return queueRepo(repo, async () => {
    if (opts.paths) {
      // 部分提取：tracked restore --source（旧 git 回退 checkout <ref> --）；
      // untracked checkout <stash>^3（第三父）；条目保留不 drop
      const rels = dedupNested(relPaths(repo, opts.paths));
      const wanted = new Set(rels);
      const untracked = new Set<string>();
      try {
        const ls = await run(repo, ["ls-tree", "-r", "-z", "--name-only", `${ref}^3`], 30_000);
        for (const l of ls.split("\0").filter(Boolean)) if (wanted.has(l)) untracked.add(l);
      } catch { /* 该 stash 无未跟踪部分 */ }
      const tracked = rels.filter((p) => !untracked.has(p));
      await restoreOrLegacy(
        repo,
        tracked.length > 0 ? [["restore", "--source", ref, "--", ...tracked]] : [],
        tracked.length > 0 ? [["checkout", ref, "--", ...tracked]] : [],
      );
      for (const p of untracked) {
        try {
          await run(repo, ["checkout", `${ref}^3`, "--", p]);
        } catch (e) {
          gitErr(e, "部分提取失败: " + p);
        }
      }
      await audit({ repo, cmd: "stash-apply", index, paths: rels, partial: true });
      changed(repo, "stash", "stash apply (partial)");
      return { ok: true as const };
    }
    try {
      await run(repo, opts.pop ? ["stash", "pop", ref] : ["stash", "apply", ref]);
    } catch (e) {
      // pop 冲突时 git 自动保留条目——错误透传给 UI 引导「从 stash 建分支」
      gitErr(e, (opts.pop ? "pop" : "apply") + " 失败（冲突时条目保留）");
    }
    await audit({ repo, cmd: "stash-apply", index, pop: !!opts.pop });
    changed(repo, "stash", opts.pop ? "stash pop" : "stash apply");
    return { ok: true as const };
  });
}

export async function stashDrop(cwd: string, index: number): Promise<{ ok: true; sha: string }> {
  const repo = await repoRoot(cwd);
  const ref = stashRef(index);
  return queueRepo(repo, async () => {
    // locale 无关的 sha 来源：drop 前解析（drop 后该 ref 已清，rev-parse 必失败；
    // 输出括号在本地化 git 下是全角「（）」，半角正则不可依赖——只作补充）。
    let sha = "";
    try { sha = (await run(repo, ["rev-parse", ref], 10_000)).trim(); } catch { /* 无此条目 */ }
    let out = "";
    try {
      out = await run(repo, ["stash", "drop", ref]);
    } catch (e) {
      gitErr(e, "drop 失败");
    }
    if (!sha) sha = (out.match(/\(([0-9a-f]{7,40})\)/))?.[1] ?? "";
    await audit({ repo, cmd: "stash-drop", index, sha });
    changed(repo, "stash", "stash drop");
    return { ok: true as const, sha };
  });
}

export async function stashBranch(cwd: string, index: number, name: string): Promise<{ ok: true }> {
  const repo = await repoRoot(cwd);
  const ref = stashRef(index);
  await assertBranchName(repo, name);
  return queueRepo(repo, async () => {
    try {
      await run(repo, ["stash", "branch", name, ref]);
    } catch (e) {
      gitErr(e, "stash branch 失败");
    }
    await audit({ repo, cmd: "stash-branch", index, name });
    changed(repo, "stash", "stash branch " + name);
    return { ok: true as const };
  });
}

// ── 远端同步 ────────────────────────────────────────────────────────────────

async function currentBranch(repo: string): Promise<string> {
  try {
    return (await run(repo, ["symbolic-ref", "--short", "HEAD"], 15_000)).trim();
  } catch {
    fail(400, "detached HEAD，无法同步");
  }
}

export async function gitPush(cwd: string, opts: { remote?: string; branch?: string; setUpstream?: boolean }): Promise<{ ok: true; output: string }> {
  const repo = await repoRoot(cwd);
  return queueRepo(repo, async () => {
    const remote = assertSafeRef(opts.remote || "origin", "remote");
    const branch = assertSafeRef(opts.branch || (await currentBranch(repo)), "branch");
    const hasUpstream = await run(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"], 15_000).then(() => true, () => false);
    const args = ["push", "--atomic"];
    if (opts.setUpstream || !hasUpstream) args.push("-u", remote, branch);
    else args.push(remote, branch);
    let out = "";
    try {
      out = await run(repo, args, 300_000);
    } catch (e) {
      gitErr(e, "push 失败");
    }
    await audit({ repo, cmd: "push", remote, branch });
    changed(repo, "sync", `push ${remote}/${branch}`);
    return { ok: true as const, output: out.trim().split("\n").slice(-5).join("\n") };
  });
}

export async function gitPull(cwd: string, opts: { mode?: "ff-only" | "rebase" | "merge" }): Promise<{ ok: true; output: string }> {
  const repo = await repoRoot(cwd);
  const mode = opts.mode || "ff-only";
  return queueRepo(repo, async () => {
    const args = ["pull"];
    if (mode === "rebase") args.push("--rebase");
    else if (mode === "merge") args.push("--no-ff");
    else args.push("--ff-only");
    let out = "";
    try {
      out = await run(repo, args, 300_000);
    } catch (e) {
      gitErr(e, `pull 失败（${mode}）`);
    }
    await audit({ repo, cmd: "pull", mode });
    changed(repo, "sync", "pull " + mode);
    return { ok: true as const, output: out.trim().split("\n").slice(-5).join("\n") };
  });
}

export async function gitFetch(cwd: string, remote?: string): Promise<{ ok: true }> {
  const repo = await repoRoot(cwd);
  const r = assertSafeRef(remote || "origin", "remote");
  return queueRepo(repo, async () => {
    try {
      await run(repo, ["fetch", r], 300_000);
    } catch (e) {
      gitErr(e, "fetch 失败");
    }
    await audit({ repo, cmd: "fetch", remote: r });
    return { ok: true as const };
  });
}
