/**
 * aiti-git-trace WP-A —— 归属解析（方案 §3.7 / §7.1）。
 * 供 WP-B 接入：识别路径 → 最近外层 git 仓（带缓存）；目录向下扫一层找嵌套仓。
 *
 * 合法 `.git` = 目录且含 HEAD（`.git` 是文件 = worktree 指针，按方案视为非仓、继续向上）。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

/** p/.git 是否为合法 git 目录（目录且含 HEAD）。 */
export function isValidGitDir(p: string): boolean {
  try {
    const g = path.join(p, ".git");
    return statSync(g).isDirectory() && existsSync(path.join(g, "HEAD"));
  } catch {
    return false;
  }
}

const defaultCache = new Map<string, string>();

/**
 * 向上走查最近合法 `.git`，返回该仓根（含 .git 的目录）；到根都没有 → null。
 * 结果（含沿途中间目录）写入 cache，命中即短路。
 * 只缓存正向命中（v3.1 审核）：负结果不缓存——loose 目录后来 git init 后
 * 同进程新会话必须立刻看到仓（null 缓存永不失效会把它锁死在 loose）。
 */
export function resolveRepoRoot(
  p: string,
  cache: Map<string, string> = defaultCache,
): string | null {
  let cur = path.resolve(p);
  const seen: string[] = [];
  try {
    while (true) {
      const hit = cache.get(cur);
      if (hit !== undefined) {
        for (const k of seen) cache.set(k, hit);
        return hit;
      }
      seen.push(cur);
      if (isValidGitDir(cur)) {
        for (const k of seen) cache.set(k, cur);
        return cur;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch {
    // fs 意外按无仓处理
  }
  return null;
}

/** dir 下的一层子目录中含合法 `.git` 者（不递归；跳过 .git 本身）。失败返回空数组。 */
export function findNestedRepos(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== ".git" && isValidGitDir(path.join(dir, e.name)))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** 清空默认缓存（测试用；也可自带 cache Map 注入 resolveRepoRoot）。 */
export function clearResolveCache(): void {
  defaultCache.clear();
}
