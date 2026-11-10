/**
 * aiti-devtools 扩展 · 桥适配层（薄）
 *
 * 桥核心唯一来源：packages/aiti-devtools-core/src/bridge.ts（createBridge）——
 * 会话/claim/SSE、MCP JSON-RPC、agent 注册/推送、AI 宿主页注册（aiPageReg）、exec 路由
 * 全在 core。本文件只做三件事：
 *   1) 打包部署：core bridge.ts 随扩展一起拷贝（deploy-ext.mjs），相对导入——不依赖宿主装 aiti-devtools-core
 *   2) 路径适配：扩展 API 的 /api/extensions/aiti-devtools/mcp/<path> → 剥前缀转 core handle()
 *   3) 进程内 agent 扩展点透传（方案 M：registerAgent/setAgentSink/answer → server.agent 用）
 *
 * 任何宿主（其他 AI 控制台/iframe 平台）接入都可参照本文件的薄适配方式。
 */
import { createBridge } from "./bridge-core.js";

export function createBridgeExt(cacheDir = "", busPublish?: (type: string, data?: Record<string, unknown>) => void) {
  // busPublish（统一 SSE 端口适配）：宿主 event-bus publish 出口——传入后页面可经
  // POST /bridge/attach-bus 把桥下行流注册到总线专属 topic（bridge-<instanceId>），
  // 少占一条独立 EventSource；不传（独立桥/未接线）= 自带 SSE，零变化。
  const bridge = createBridge(cacheDir, { name: "aiti-devtools", busPublish });
  return {
    handle: bridge.handle,
    sessions: bridge.sessions,
    tools: bridge.tools,
    callTool: bridge.callTool,
    // 方案 M：宿主进程内 agent（pi-web server.agent 扩展点直调；core 提供通用实现）
    registerAgent: bridge.registerAgent,
    setAgentSink: bridge.setAgentSink,
    answer: bridge.answer,
    // pair 设备互连（fed 联邦代理要读本桥 peers/files registry）
    pair: bridge.pair,
    // 绑定 agent 默认目标页（交互工具 pageId 未指定时定向到它）
    bindAgentPage: bridge.bindAgentPage,
    // 清理 agent 所有绑定数据（session 结束时调）
    clearAgent: bridge.clearAgent,
  };
}
