/**
 * .vscode/mcp.json 自动配置：merge 写入 aiti 条目（保留既有 servers/其他配置）
 * - 原子写：tmp + rename（Windows 顺序见 windows-compat-lessons §0）
 * - 既有文件含注释/非法 JSON → 不覆盖，报错让用户手动处理（绝不 clobber）
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { join } from "path";

export interface McpUpsertResult {
  ok: boolean;
  file: string;
  action: "created" | "updated" | "error";
  message?: string;
}

export function upsertMcpConfig(wsRoot: string, shimPath: string, bridgeBase: string): McpUpsertResult {
  const dir = join(wsRoot, ".vscode");
  const file = join(dir, "mcp.json");
  mkdirSync(dir, { recursive: true });

  let cfg: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, file, action: "error", message: "existing mcp.json top level is not an object — resolve it manually and retry" };
        }
        cfg = parsed as Record<string, unknown>;
      } catch (e) {
        return {
          ok: false,
          file,
          action: "error",
          message: `existing mcp.json is not valid JSON (comments?): ${(e as Error).message} — add the aiti entry manually, or tidy it up and retry`,
        };
      }
    }
  }

  const servers = (cfg.servers && typeof cfg.servers === "object" && !Array.isArray(cfg.servers)
    ? cfg.servers
    : {}) as Record<string, unknown>;
  const existed = "aiti" in servers;
  // stdio shim：URL 不落配置，agent 启动带 env AITI_BRIDGE_URL 即接入（桥换端口/迁移零改配置）
  servers.aiti = {
    type: "stdio",
    command: "node",
    args: [shimPath],
    env: { AITI_BRIDGE_URL: bridgeBase },
  };
  cfg.servers = servers;

  const body = JSON.stringify(cfg, null, 2) + "\n";
  const tmp = file + ".aiti-tmp";
  writeFileSync(tmp, body, "utf8");
  try {
    renameSync(tmp, file);
  } catch {
    // Windows rename 覆盖偶发 EPERM → 直接写兜底
    writeFileSync(file, body, "utf8");
    unlinkQuiet(tmp);
  }
  return { ok: true, file, action: existed ? "updated" : "created" };
}

function unlinkQuiet(p: string): void {
  try { unlinkSync(p); } catch { /* ignore */ }
}
