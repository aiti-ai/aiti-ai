/**
 * 上游 pi-subagents detached run 判活（aiti-subagents-fork-upstream-core-plan §5.4 / 上游
 * extension-api.md "Host session lifetime" 警告的实现）。
 *
 * 背景：pi-web 会话 idle GC（10 分钟）只看父会话自身 isRunning()。父会话委派
 * background 子代理后必然 idle —— 若按 idle 回收 wrapper，上游扩展的 completion
 * watcher / wait 订阅随之销毁，症状是"后台子代理永不回话"（工作不丢——detached
 * 子进程继续跑完并落盘，但通知与等待链路断掉）。
 *
 * 判活规则（照上游文档清单实现）：
 *   - 扫临时目录下各 pi-subagents-<scope> 域内的 async-subagent-runs/<runId>/status.json
 *   - state 为 queued 或 running 才可能是活 run（paused/complete/failed 均已终态）
 *   - status.sessionId 与宿主会话匹配两种形式：文件路径优先（getSessionFile()），
 *     未持久化会话退化为裸 sessionId
 *   - 活性以 runner pid 为权威（pid 存活 = live；长静默工具调用期间 status 文件
 *     不重写，file age 不是心跳）；无 pid 的活状态保守视为 live（宁可续命不可误杀）
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LIVE_STATES = new Set(["queued", "running"]);

function pidAlive(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return true; // 无 pid → 保守视为活
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 该会话是否还有存活的 detached 子代理。
 * @param sessionFile 会话文件路径（getSessionFile()，可能为空）
 * @param sessionId   会话 uuid（getSessionId()）
 * @returns true = 有活 run，宿主应续命不回收。任何读取异常都保守返回 true。
 */
export function hasLiveDetachedRuns(sessionFile: string, sessionId: string): boolean {
  if (!sessionFile && !sessionId) return false;
  let tmpEntries: string[];
  try {
    tmpEntries = readdirSync(tmpdir());
  } catch {
    return true; // 判活不可用 → 保守续命
  }
  for (const name of tmpEntries) {
    if (!name.startsWith("pi-subagents-")) continue;
    const runsDir = join(tmpdir(), name, "async-subagent-runs");
    let runIds: string[];
    try {
      runIds = readdirSync(runsDir);
    } catch {
      continue; // 该 scope 无 async 目录
    }
    for (const runId of runIds) {
      let status: Record<string, unknown>;
      try {
        status = JSON.parse(readFileSync(join(runsDir, runId, "status.json"), "utf8")) as Record<string, unknown>;
      } catch {
        continue; // 未落盘/损坏的目录不阻断
      }
      if (!LIVE_STATES.has(String(status.state ?? ""))) continue;
      const sid = String(status.sessionId ?? "");
      if ((sessionFile && sid === sessionFile) || (sessionId && sid === sessionId)) {
        return pidAlive(status.pid);
      }
    }
  }
  return false;
}
