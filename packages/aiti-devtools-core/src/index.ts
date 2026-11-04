/**
 * aiti-devtools-core · 公共包
 *
 * aiti-devtools 的 MCP server 核心（桥）+ 载体无关公共能力，供所有载体复用：
 *   - pi-web 扩展（bridge.ts，HTTP 层由 pi-web 托管）
 *   - pi 扩展 aiti-devtools-pi（内嵌桥 + registerTool 直连，经 http.ts 起 node:http server）
 *   - aiti-devtools-vite / webpack 等 dev server 载体（connect.ts 中间件）
 *   - 独立桥 CLI（aiti-bridge.mjs）
 *
 * 导出：
 *   createBridge(dataDir)          —— 桥核心（页面连接/SSE/工具执行/MCP JSON-RPC）
 *   startHttpServer(...)           —— node:http 适配 + 静态资源（无构建载体）
 *   connectBridge(...)             —— Connect 中间件适配（vite/webpack/express 载体）
 *   resolveEndpoints(...)          —— 地址协商解析（bridge/aiUrl/裸地址 → 端点）
 *   registerMcp / unregisterMcp    —— MCP 配置注册（常见 agent 工具；vite/CLI/扩展三处复用）
 */
export { createBridge } from "./bridge.ts";
export {
  rewriteMessage, withSourceTag, stripOrphanTags, replaceTag, clipUrl,
  PLACEHOLDER_RE, ORPHAN_NOTICE,
  type RewriteCandidate, type RewriteOptions,
} from "./send-rewrite.ts";
export type { HttpBridgeHandle, HttpBridgeOptions, StaticFile } from "./http.ts";
export { startHttpServer, readBody } from "./http.ts";
export { connectBridge } from "./connect.ts";
export type { ConnectBridgeOptions, ConnectMiddleware } from "./connect.ts";
export { resolveEndpoints, normalizeBridgeUrl, hasBridgePathSignature, sameOrigin, probeBridge } from "./endpoints.ts";
export type { ResolveEndpointsInput, ResolvedEndpoints, EndpointsKind } from "./endpoints.ts";
export { registerMcp, unregisterMcp, registerAitiShim, unregisterAitiShim, autoRegisterAitiShim, resolveShimPathAuto, MCP_TARGETS, detectStructureKey } from "./mcp-config.ts";
export type { RegisterMcpOptions, RegisterMcpResult, McpTargetFile, RegisterShimOptions, AutoRegisterAitiShimOptions } from "./mcp-config.ts";
export { loadAssets, ASSET_NAMES } from "./assets.ts";
export { aitiMiddleware, patchProcessHttp } from "./install.ts";
export type { AitiMiddlewareOptions, PatchProcessHttpOptions } from "./install.ts";
export { htmlInjectMiddleware, launcherTag } from "./inject-html.ts";
export type { HtmlInjectOptions, HtmlInjectMiddleware } from "./inject-html.ts";
