/**
 * aiti-git-review · git 参数构造（纯函数，index.ts 与单测共用）。
 *
 * trace 任务源（docs/aiti-git-trace-plan.md §6.1）：aiti-git-trace 的编外追踪仓
 * `<repoRoot>/.aiti-trace`（§13.2 顶层独立 git 库）——同一份只读白名单封装，靠显式
 * `--git-dir/--work-tree` 前插即可审它（白名单子命令探测不受影响：注入参数均以 `-` 开头）。
 */

/** 白名单子命令探测：第一个非 `-` 开头参数；`-C <dir>` 的值一并跳过（原实现只跳 flag 本身，
 *  会把路径值误判成子命令——本次顺手修正，index.ts 从未用过 -C 两段式，无行为回归） */
export function findSubcommand(args) {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (typeof a !== "string") continue;
    if (a === "-C") { i++; continue; } // -C <dir>：跳过成对值
    if (!a.startsWith("-")) return a;
  }
  return list[0] || "";
}

/** 注入编外仓选项：有 gitDir 时参数前插 --git-dir=…/--work-tree=…（单参数形式，以 - 开头——
 *  两段式 "--git-dir <path>" 的路径值会被子命令探测误判成子命令，白名单直接拒掉，勿改回） */
export function withRepoOpts(args, opts) {
  const list = Array.isArray(args) ? args : [];
  if (!opts || !opts.gitDir) return list;
  const out = ["--git-dir=" + String(opts.gitDir)];
  if (opts.workTree) out.push("--work-tree=" + String(opts.workTree));
  return [...out, ...list];
}

/** 任务 source 归一：缺省/非法 → "repo"（旧任务 JSON 向后兼容） */
export function normalizeSource(source) {
  return source === "trace" ? "trace" : "repo";
}
