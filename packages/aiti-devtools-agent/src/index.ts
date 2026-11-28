/**
 * aiti-devtools-agent · 多 agent 宿主接线框架
 *
 * 把「桥 ⇄ agent 会话」的接线逻辑做成载体无关的包，供 pi / DSH / 其他 agent 宿主复用：
 *   - AgentBridgeClient  桥 HTTP/SSE 协议客户端（callTool/register/probe/answer/agent SSE 流）
 *   - AgentHost          宿主能力契约（工具注册/会话标识/模型注入/通知）
 *   - mapBridgeTools / wrapToolResult  桥工具 → 宿主工具定义/返回值 通用映射
 *   - jsonSchemaToTypeBox  桥 inputSchema → typebox（宿主 parameters）
 *
 * 每个 agent 宿主只写一个薄 adapter（实现 AgentHost + 桥 URL 解析），不再各抄一套 tools/session/interact。
 */
export { AgentBridgeClient } from "./bridge-client.ts";
export type {
  AgentCallOptions,
  AgentCallResult,
  AgentRegisterOptions,
  AgentRegistered,
  AgentStreamMessage,
  BridgeTool,
} from "./bridge-client.ts";
export {
  mapBridgeTools,
  wrapToolResult,
} from "./agent-host.ts";
export type {
  AgentHost,
  HostToolDef,
  HostToolResult,
  MapBridgeToolsOptions,
} from "./agent-host.ts";
// 注：jsonSchemaToTypeBox 需 typebox（宿主提供），作可选子路径导出（import { jsonSchemaToTypeBox } from "aiti-devtools-agent/schema"）。
