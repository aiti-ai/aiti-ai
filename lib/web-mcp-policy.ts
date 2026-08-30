/**
 * web-mcp-policy —— Web 会话默认不加载 MCP 适配器（pi-mcp-adapter）。
 *
 * 背景（2026-08-30「新会话 / fork 卡死」定位，session 73927991）：
 * settings.json packages 里的 npm:pi-mcp-adapter 让**每个 pi-web 会话创建**
 * 都加载 shared-global ~/.config/mcp/mcp.json（TUI 场景的 12 个 MCP server，
 * 多为 `npx -y @latest` stdio：chrome-devtools / playwright / computer-use /
 * zai / aiti-testagent…），并在创建路径里逐个解析 + 拉起 + 握手——实测冷路径
 * 4min02s（15:37:44→15:41:52，journal 里 [aiti-devtools] 桥就绪 /
 * [aiti-testagent] IDE 就绪 落在窗口正中），热路径 1.5s。期间该会话所有 API
 * （上下文加载 / get_state / fork）排队等待 → 前端表现为「正在加载会话…」
 * 永久转圈 = 用户口中的"卡死"。adapter 的 session_start 还会在 pi-web 每次
 * wrapper 重建时杀掉并全量重启 MCP runtime（"MCP extension session
 * restarted"），叠加 10 分钟空闲回收 / HMR / 扩展 reload，让重建频繁发生。
 *
 * Web 会话的工具面走方案 M 进程内注入（pi-web-ext 经 collectAgentTools 注入
 * aiti_* customTools），不依赖 TUI 的 MCP server；fork/新会话只是更常触发
 * 新建 wrapper 的操作，才显得"一点新会话就卡死"。
 *
 * 策略：Web 会话默认剔除 pi-mcp-adapter 扩展（整个移除，不初始化——同
 * ext-conflicts 的移除语义）；TUI/CLI 不受影响（仍走 ~/.pi/agent 全量加载）。
 * 需要在 Web 会话里用 MCP 时设 PI_WEB_LOAD_MCP=1 恢复旧行为。
 *
 * 无轮询：仅在扩展加载结果组装（会话创建）路径上调用。
 */

import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { pathScopedPackageName, sourcePackageName } from "./ext-conflicts.ts";

const MCP_ADAPTER_PACKAGE = "pi-mcp-adapter";
/** 裸名包的 node_modules 路径（pathScopedPackageName 只识别 @scope/name）。 */
const MCP_ADAPTER_PATH_RE = /(?:^|\/)node_modules\/pi-mcp-adapter\//;

/** Web 会话剔除 MCP 适配器；PI_WEB_LOAD_MCP=1 时原样返回（恢复旧行为）。 */
export function dropMcpAdapterForWebSessions(base: LoadExtensionsResult): LoadExtensionsResult {
  if (process.env.PI_WEB_LOAD_MCP === "1") return base;

  const isAdapter = (extension: LoadExtensionsResult["extensions"][number]): boolean => {
    if (sourcePackageName(extension.sourceInfo?.source ?? "") === MCP_ADAPTER_PACKAGE) return true;
    const path = extension.resolvedPath ?? extension.path ?? "";
    if (pathScopedPackageName(path) === MCP_ADAPTER_PACKAGE) return true;
    if (MCP_ADAPTER_PATH_RE.test(path.replaceAll("\\\\", "/"))) return true;
    return false;
  };

  const removed = new Set<string>();
  for (const extension of base.extensions) {
    if (isAdapter(extension)) removed.add(extension.path);
  }
  if (removed.size === 0) return base;

  return {
    ...base,
    extensions: base.extensions.filter((extension) => !removed.has(extension.path)),
    errors: base.errors.filter((error) => !removed.has(error.path)),
  };
}
