/**
 * 路径探测：桥 / stdio shim 的安装态优先，仓库检出兜底（跨平台：os.homedir()，禁手拼 /home/xxx）
 */
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

/** 候选（按优先级）：① extman reconcile 安装态 ② 本仓库检出（开发机兜底） */
const INSTALLED = join(homedir(), ".pi", "web", "node_modules", "@aiti-ai", "aiti-bridge");
const REPO = join(homedir(), "workspace", "aiti-ai", "packages", "aiti-bridge");

/** 桥：自带（vsix dist/bridge/aiti-bridge/bin）> 安装态 > 仓库检出 */
export function resolveBridgePath(override?: string, extRoot?: string): string | undefined {
  if (override && override.trim()) return override.trim();
  const list = [
    ...(extRoot ? [join(extRoot, "dist", "bridge", "aiti-bridge", "bin", "aiti-bridge.mjs")] : []),
    join(INSTALLED, "bin", "aiti-bridge.mjs"),
    join(REPO, "bin", "aiti-bridge.mjs"),
  ];
  return list.find((p) => existsSync(p));
}

/** shim：自带（dist/bridge 根）> 安装态 bin > 仓库 bin（两种布局位置不同，单独列） */
export function resolveShimPath(override?: string, extRoot?: string): string | undefined {
  if (override && override.trim()) return override.trim();
  const list = [
    ...(extRoot ? [join(extRoot, "dist", "bridge", "aiti-mcp-shim.cjs")] : []),
    join(INSTALLED, "bin", "aiti-mcp-shim.cjs"),
    join(REPO, "bin", "aiti-mcp-shim.cjs"),
  ];
  return list.find((p) => existsSync(p));
}
