/**
 * bridge-url —— 桥地址协商（纯函数，无依赖；aiti-devtools-pi 专用）
 *
 * 背景（2026-09-15 实锤）：pi-web 侧 `_shared/agent-spawn-env.ts` 注入的
 * `AITI_BRIDGE_URL = <piWebSelfBase>/api/extensions/aiti-devtools` 是**给
 * aiti-mcp-shim 的「扩展路径签名」形态**（shim 自行归一为 `<extBase>/mcp/mcp`）。
 * 本扩展（AgentBridgeClient）直接拿它当桥 base 会 404：
 *   POST <base>/bridge/agent/register → not found: bridge/agent/register
 * （pi-web 扩展路由要求 mcp/ 前缀才进桥：`p[0] === "mcp"`）。
 * 且 bootstrapBridge 会把该值写回 settings.json 形成自固化。
 *
 * 本模块把「一个地址」归一到本扩展需要的桥 base（含 /mcp 段），与 shim 的
 * EXT_PATH_SIG 语义对齐：
 *   …/api/extensions/aiti-devtools[/mcp[/mcp]][/…] → …/api/extensions/aiti-devtools/mcp
 *   其余形态（独立桥 …/aiti、裸 origin、非法 URL）原样返回。
 */

/** pi-web 扩展路径签名（与 aiti-mcp-shim 的 EXT_PATH_SIG 同值） */
export const PI_WEB_EXT_PATH_SIG = "/api/extensions/aiti-devtools";

/** 归一为桥 base：识别 pi-web 扩展路径签名 → `<extBase>/mcp`；否则原样返回。 */
export function normalizeBridgeBase(url: string): string {
  try {
    const u = new URL(url);
    const idx = u.pathname.indexOf(PI_WEB_EXT_PATH_SIG);
    if (idx < 0) return url;
    const extBase = u.origin + u.pathname.slice(0, idx + PI_WEB_EXT_PATH_SIG.length);
    return extBase + "/mcp";
  } catch {
    return url;
  }
}
