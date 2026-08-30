/**
 * session-run-quiescence —— 跨实例单写者检查（fork/clone 前置）。
 *
 * 背景（2026-08-30 孤儿 run 实证，session 73927991）：dev 与 prod 两个 pi-web
 * 实例共用同一 ~/.pi/agent/sessions 目录。会话的 run 可能跑在**另一个实例**
 * （prod 拉起的 pi 子进程）里——其内存运行态（isStreaming 等）对本实例的
 * wrapper 完全不可见 → 本实例的「运行中禁止 fork」守卫失效 → fork 会在
 * 对方正流式写文件时并发读取/复制（数据竞争 + 路由悬挂）。
 *
 * 机制：fork/clone 真正动手前，对会话文件做两次 stat 采样（间隔 700ms），
 * size 或 mtime 有变化 = 活跃写入中 → 抛错拒绝。同实例运行中场景由
 * isSessionRunningForReplacement（内存态）先行拦截，本检查是跨实例兜底。
 *
 * 残余竞态（已知、可接受）：写入者恰好静默 >700s…… 不，>700ms 的间隙内
 * 仍可能漏检；v2 方向是共享盘上的跨实例 run claim 文件（flock/pid 探活），
 * 见 docs 复盘。文件不存在（新会话）→ 视为静默。
 */

import { stat } from "node:fs/promises";

const QUIESCENCE_WINDOW_MS = 700;

export async function assertSessionFileQuiescent(sessionFile: string): Promise<void> {
  let a: { size: number; mtimeMs: number };
  try {
    a = await stat(sessionFile);
  } catch {
    return; // 文件不存在/不可读 → 没有写入者
  }
  await new Promise((resolve) => setTimeout(resolve, QUIESCENCE_WINDOW_MS));
  let b: { size: number; mtimeMs: number };
  try {
    b = await stat(sessionFile);
  } catch {
    return;
  }
  if (b.size !== a.size || b.mtimeMs !== a.mtimeMs) {
    throw new Error(
      "Cannot fork: the session is being actively written by another process "
      + "(another pi-web instance is running this session?) — abort that run first",
    );
  }
}
