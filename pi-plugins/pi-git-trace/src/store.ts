/**
 * store 定位与初始化（§3.1/§3.2/§3.3；v3.1 §13：顶层 .aiti-trace）。
 *
 * 位置表：
 *   cwd 自带合法 .git            → <cwd>/.aiti-trace
 *   cwd 是某仓子目录             → <repoRoot>/.aiti-trace（work-tree=repoRoot）
 *   无任何外层 git 仓            → loose 模式自动建仓（§13.4，预算内；engine 决策）
 * 严禁凭空造 .git/：非法 .git 目录会遮蔽 git 向上层找仓；.aiti-trace 无此风险。
 *
 * 顶层化的可见性义务（§13.3，.git/aiti 时代免费）：
 *   ① store 自身 info/exclude 加 .aiti-trace/（实证：git 不自动排除非 .git 名 gitdir，
 *      ls-files --others 会把 store 内部文件当 untracked 吸入）
 *   ② 项目仓 .git/info/exclude 加 .aiti-trace/（用户 git status 干净；幂等托管块）
 */
import fs from "node:fs";
import path from "node:path";
import { HermeticGit, execFileAsync, userRepoLsFiles } from "./git-wrap.ts";
import { isValidGitDir, resolveRepoRoot } from "./recognition.ts";
import { BUILTIN_EXCLUDES, renderExcludesFile } from "./excludes.ts";
import { sessionBranch } from "./paths.ts";
import type { StoreHandle } from "./types.ts";

export interface InitStoreOptions {
  sessionId: string;
  builtinExcludes?: boolean;
  extraExcludes?: string[];
  includeExtra?: string[];
  /** scope=cwd 时 work-tree 取会话目录而非仓根（巨型仓，§9） */
  scope?: "repo" | "cwd";
}

/** 追踪仓路径（v3.1 §13.2）：<repoRoot>/.aiti-trace */
export function storeGitDir(repoRoot: string): string {
  return path.join(repoRoot, ".aiti-trace");
}

/** 项目仓 info/exclude 的可见性托管块（.aiti-trace/ 不进用户 git） */
export function excludeStoreInProjectRepo(repoRoot: string): void {
  try {
    const infoDir = path.join(repoRoot, ".git", "info");
    fs.mkdirSync(infoDir, { recursive: true });
    const file = path.join(infoDir, "exclude");
    let prev = "";
    try { prev = fs.readFileSync(file, "utf8"); } catch { /* new */ }
    if (prev.includes(".aiti-trace/")) return;
    const re = /# --- aiti store visibility ---[\s\S]*?# --- end aiti store visibility ---\n?/;
    const block = ["# --- aiti store visibility ---", ".aiti-trace/", "# --- end aiti store visibility ---", ""].join("\n");
    fs.writeFileSync(file, re.test(prev) ? prev.replace(re, block) : prev + (prev && !prev.endsWith("\n") ? "\n" : "") + block);
  } catch { /* 可见性失败不阻塞建仓 */ }
}

/**
 * store 自携带免打扰声明（AI grep/搜索自动跳过 store 内部）：
 *   - <gitDir>/.gitignore = `*`：git 感知工具（rg/git grep/VS Code 等）进入 store 目录时全忽略
 *   - <gitDir>/.ignore    = `*`：rg 专属兜底（--no-ignore-vcs / 非 git 目录场景下 .gitignore 失效，.ignore 仍生效）
 * 幂等：已含 `*` 行则不重写（保留用户手工内容）；失败不阻塞建仓。
 * 安全：store 作为 --git-dir 使用时 .gitignore 不影响任何 git 操作——work-tree 是 repoRoot，
 *       且 .aiti-trace/ 已被 store 自身 info/exclude 整目录排除（§13.3①），git 根本不会进入该目录。
 */
export function ensureStoreSelfIgnore(gitDir: string): void {
  try {
    for (const name of [".gitignore", ".ignore"]) {
      const file = path.join(gitDir, name);
      let prev = "";
      try { prev = fs.readFileSync(file, "utf8"); } catch { /* new */ }
      if (prev.split("\n").map((l) => l.trim()).includes("*")) continue;
      const header = name === ".gitignore" ? "# aiti-trace store self-ignore (managed)\n" : "";
      const next = prev + (prev && !prev.endsWith("\n") ? "\n" : "") + header + "*\n";
      if (next !== prev) fs.writeFileSync(file, next);
    }
  } catch { /* 免打扰声明失败不阻塞建仓 */ }
}

/**
 * 在（已存在的）目录上初始化独立 git 库。此时该目录为空、尚无任何 git 语义，
 * 用 `--git-dir <path> init` 直指我们的路径（不涉及用户仓任何文件）；
 * 若 git 版本行为差异导致未生成 HEAD，回退为对路径显式 `git init <path>`。
 * 两条路径都只触碰 <repoRoot>/.aiti-trace 自身。（异步：不阻塞事件循环）
 */
async function initStoreDir(gitDir: string): Promise<void> {
  fs.mkdirSync(gitDir, { recursive: true });
  let ok = true;
  try {
    await execFileAsync("git", ["--git-dir", gitDir, "init", "--quiet"], { timeoutMs: 30_000 });
  } catch {
    ok = false;
  }
  if (!ok || !fs.existsSync(path.join(gitDir, "HEAD"))) {
    try {
      await execFileAsync("git", ["init", "--quiet", gitDir], { timeoutMs: 30_000 });
    } catch { /* 下方 HEAD 检查兜底 */ }
  }
  if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
    throw new Error(`aiti-git-trace: store init failed at ${gitDir}`);
  }
}

/** 幂等初始化一个 StoreHandle（主/副通用）。已初始化则直接复用。异步：不阻塞事件循环。 */
export async function ensureStore(opts: {
  repoRoot: string;
  sessionId: string;
  role: "primary" | "secondary";
  scope?: "repo" | "cwd";
  builtinExcludes?: boolean;
  extraExcludes?: string[];
  includeExtra?: string[];
}): StoreHandle {
  const repoRoot = path.resolve(opts.repoRoot);
  const gitDir = storeGitDir(repoRoot);
  const isNew = !isValidGitDir(gitDir);
  if (isNew) await initStoreDir(gitDir);

  const workTree = opts.scope === "cwd" ? process.cwd() : repoRoot;
  const branch = sessionBranch(opts.sessionId);
  const indexFile = path.join(gitDir, `index-${opts.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
  const git = new HermeticGit(() => ({ gitDir, workTree, indexFile }));

  // hermetic：config 全部写死在 store（wrapper 环境不读任何用户/系统配置）
  // v3.1：幂等确保（不任 isNew）——手工 mv 迁移的 store 缺 config 也能即迁即用（§13.2）
  // 性能（2026-09-12）：7 个 git config 调用曾是每次 ensureStore 的固定开销（7 个 git 进程）。
  // 现改为「文件指纹标记」：config 写全过一次后落 `<gitDir>/.aiti-cfg-v2` 标记，后续 0 git 调用。
  // 兼容：手工 mv 来的 store 无标记 → 首见时补写一遍（幂等安全）。
  const cfgMark = path.join(gitDir, ".aiti-cfg-v2");
  if (!fs.existsSync(cfgMark)) {
    for (const [k, v] of Object.entries({
      "user.name": "aiti-trace",
      "user.email": "aiti@local",
      "core.autocrlf": "false",
      "core.fsmonitor": "off",
      "gc.auto": "0",
      "status.showUntrackedFiles": "all",
      "core.quotePath": "false",
    })) {
      await git.run(["config", k, v]);
    }
    try { fs.writeFileSync(cfgMark, String(Date.now())); } catch { /* 标记写失败仅致下次重复写 config（幂等） */ }
  }

  // 项目仓可见性（§13.3②）：每次幂等确保（不任 isNew——mv 迁移的存量 store 也要补）
  if (isValidGitDir(path.join(repoRoot, ".git"))) excludeStoreInProjectRepo(repoRoot);
  // store 自携带免打扰声明（.aiti-trace/.gitignore + .ignore = *）：每次幂等确保（存量 store 也补）
  ensureStoreSelfIgnore(gitDir);
  // 内置排除 → info/exclude 托管块（§3.4① 所有 store 统一写；旧版仅 primary 的假设不成立——副 store 亦可能含大量 untracked）
  // v3.1：托管块每次幂等重写（审核发现④）；让位检查仅 isNew（存量 store 保留上次结果，代价可控）
  if (opts.builtinExcludes ?? true) {
    let dropped = new Set<string>();
    if (isNew) {
      for (const pat of [...BUILTIN_EXCLUDES, ...(opts.extraExcludes ?? [])]) {
        if (!pat.endsWith("/")) continue; // 仅目录型模式做让位；文件型/通配代价高且影响小
        if ((await userRepoLsFiles(repoRoot, pat)).length > 0) dropped.add(pat);
      }
    }
    const infoDir = path.join(gitDir, "info");
    fs.mkdirSync(infoDir, { recursive: true });
    const exclPath = path.join(infoDir, "exclude");
    let prev = "";
    try { prev = fs.readFileSync(exclPath, "utf8"); } catch { /* new */ }
    // 幂等：替换托管块，保留块外的手工行（含 excludeNestedInParent 的嵌套仓条目）
    const re = /# --- aiti managed v1 ---[\s\S]*?# --- end aiti managed ---\n?/;
    const block = renderExcludesFile({ extraExcludes: opts.extraExcludes, includeExtra: opts.includeExtra, dropped }).replace(/^# aiti-excludes v[^\n]*\n/, "");
    const next = re.test(prev) ? prev.replace(re, block) : prev + block;
    if (next !== prev) fs.writeFileSync(exclPath, next);
  }

  return { root: repoRoot, gitDir, workTree, branch, role: opts.role };
}

/**
 * 嵌套仓注册（§3.3）：路径写入父 store 的 info/exclude（去重），嵌套仓按 §3.7
 * 另建独立 store（调用方用 ensureStore(role:"secondary")）。
 */
export function excludeNestedInParent(parent: StoreHandle, relDir: string): void {
  const infoDir = path.join(parent.gitDir, "info");
  fs.mkdirSync(infoDir, { recursive: true });
  const file = path.join(infoDir, "exclude");
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    /* new file */
  }
  const entry = `${relDir.replace(/\/+$/, "")}/`;
  if (!lines.includes(entry)) {
    lines.push(`# aiti nested repo (auto)`, entry);
    fs.writeFileSync(file, lines.join("\n") + "\n");
  }
}

export { resolveRepoRoot, isValidGitDir };
