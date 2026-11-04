/**
 * WP-A seam：正式实现位于 lib/recognize.ts / lib/resolve.ts（WP-A 交付）。
 * 本文件负责装配：ensureWired() 动态接入 lib 实现；未就绪时回退本地兜底
 * （engine 仅依赖本文件，切换无感）。
 */
import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import type { RecognitionApi, RepoResolverApi } from "./types.ts";

/** 合法 git 目录：存在且为目录且含 HEAD（§3.1） */
export function isValidGitDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && existsSync(path.join(p, "HEAD"));
  } catch {
    return false;
  }
}

/** 本地兜底：向上走查最近合法 .git 仓根；无则 null（§3.1 位置表） */
export function resolveRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const g = path.join(dir, ".git");
    if (existsSync(g)) {
      try {
        if (statSync(g).isDirectory() && isValidGitDir(g)) return dir;
        // .git 是文件（worktree 指针）或目录非法（缺 HEAD）→ 继续向上走查
      } catch {
        /* continue */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 本地兜底：dir 直接子目录中的 git 仓（一次 readdir，§3.7 向下扫一层） */
export function findNestedRepos(dir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (isValidGitDir(path.join(dir, n, ".git"))) out.push(path.join(dir, n));
  }
  return out;
}

/** parent 是否包含 target（含相等）。纯字符串判定（lib 实现的本地镜像，engine leak 守卫用） */
export function isWithinPath(parent: string, target: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

const localResolver: RepoResolverApi = { resolveRepoRoot, findNestedRepos };

let recognition: RecognitionApi | null = null;
let resolver: RepoResolverApi = localResolver;
let libRec: any = null;
let wired = false;

/** WP-A lib 就绪后接入（幂等；失败保持本地兜底） */
export async function ensureWired(): Promise<void> {
  if (wired) return;
  wired = true;
  try {
    const [rec, res] = await Promise.all([
      import("../lib/recognize.ts") as Promise<any>,
      import("../lib/resolve.ts") as Promise<any>,
    ]);
    libRec = rec;
    recognition = {
      parseToolPath: (input, cwd) => ({
        abs: rec.parseToolWritePath(input as Record<string, unknown> | undefined, cwd),
      }),
      parseBashTargets: (command, cwd) => {
        const r = rec.parseBashTargets(command, cwd);
        // P0-3b 命中仓判定消费：逃逸写目标 + 切目录 + 全部写目标（含 cwd 内——子仓按需注册靠它）
        return {
          absolutePaths: [...new Set([
            ...(r?.cwdEscapes ?? []),
            ...(r?.switchedDirs ?? []),
            ...(r?.writeTargets ?? []),
          ])],
        };
      },
    };
    resolver = {
      resolveRepoRoot: (p) => res.resolveRepoRoot(p),
      findNestedRepos: (d) => res.findNestedRepos(d),
    };
  } catch {
    /* lib 未合并：保持本地兜底（WP-A 合入后自动切换） */
  }
}

/** 测试/手动注入 */
export function setWpA(api: { recognition?: RecognitionApi; resolver?: RepoResolverApi }): void {
  if (api.recognition) recognition = api.recognition;
  if (api.resolver) resolver = api.resolver;
}

export function getRecognition(): RecognitionApi | null {
  return recognition;
}

export function getResolver(): RepoResolverApi {
  return resolver;
}

/**
 * [P0-1] bash 只读短路判定（lib 实现；lib 缺席/异常时保守返回 maybe-write）。
 * 返回 "readonly" 时整个 op 不记账（0 条 git 命令、不消费 op 号、不识别/不注册副仓）。
 */
export function classifyBashMutability(command: string): "readonly" | "maybe-write" {
  try {
    const r = libRec?.classifyBashMutability?.(command);
    if (r === "readonly" || r === "maybe-write") return r;
  } catch { /* 保守 */ }
  return "maybe-write";
}
