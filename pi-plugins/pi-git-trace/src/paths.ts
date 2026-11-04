/** 路径/目录约定：dataDir（§3.6）、追踪数据、workspace 配置（§7.2）。 */
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** pi-web 与 pi 扩展共享的 dataDir（PI_WEB_DATA_DIR 可覆盖，缺省 ~/.pi/web/data） */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_WEB_DATA_DIR;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), ".pi", "web", "data");
}

/** 本扩展的全部可写元数据根（台账、workspace 配置；§3.6：不依赖 store 存在） */
export function traceDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataDir(env), "aiti-git-trace");
}

/** 单会话台账文件：<dataDir>/aiti-git-trace/state/ops/<sessionId>.jsonl（数据分层：台账不可再生 → state/，与 pi-web-ext/aiti-git-trace 2026-09 state 层迁移对齐；写==读同源：统一经本函数） */
export function ledgerFileFor(dataDir: string, sessionId: string): string {
  return path.join(dataDir, "aiti-git-trace", "state", "ops", `${sessionId}.jsonl`);
}

/** workspaceKey = 主仓根（无 git 则 cwd）规范路径哈希前 16 位（§7.2） */
export function workspaceKey(workspaceRoot: string): string {
  return crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

/** workspace 关注路径配置文件：<dataDir>/aiti-git-trace/cache/workspaces/<key>.json（数据分层对齐） */
export function workspaceConfigFile(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(traceDataDir(env), "cache", "workspaces", `${workspaceKey(workspaceRoot)}.json`);
}

/** 追踪仓分支名：refs/heads/aiti/<sid 短 id>（§3.3） */
export function sessionBranch(sessionId: string): string {
  const short = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 16) || "s";
  return `refs/heads/aiti/${short}`;
}
