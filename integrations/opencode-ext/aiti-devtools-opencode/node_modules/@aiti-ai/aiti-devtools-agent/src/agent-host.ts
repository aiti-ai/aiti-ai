/**
 * aiti-devtools-agent · AgentHost 契约 + 通用工具映射（宿主无关）
 *
 * 每个 agent 宿主（pi-web / pi / DSH / …）实现一个 AgentHost，桥接「桥」与「宿主 agent 会话」：
 *   - 工具注册（桥 16 个 aiti_* → 宿主工具定义）
 *   - 会话生命周期（注册 / 推送注入模型 / 完成回桥）
 *   - 人机交互（user_confirm/choose/input/presence/notify）
 *
 * 通用模板（mapBridgeTools / wrapToolResult）屏蔽「桥 MCP 形状 → 宿主工具定义/返回值」差异，
 * 宿主只需提供：工具注册 API + 会话标识 + 模型注入 API。
 */
import type { AgentCallResult, BridgeTool } from "./bridge-client.ts";

/** 宿主侧的工具定义（适配各宿主 registerTool 的契约） */
export interface HostToolDef {
  name: string;
  description: string;
  /** 宿主 tool 参数 schema（typebox / JSON Schema 直通，由宿主 parameters 映射决定） */
  parameters: unknown;
  /** 可选：宿主需要 output 声明（如 DSH 的 output:{schema,render}） */
  output?: { schema: unknown; render: (args: Record<string, unknown>, value: unknown) => unknown[] };
  /** 宿主执行该工具（参数已就绪，signal 为宿主停止信号） */
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/** 宿主工具执行结果（桥结果 → 宿主工具返回值；多数宿主只要 content text + isError） */
export interface HostToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

/** 宿主能力契约（各 agent 宿主实现） */
export interface AgentHost {
  /** 宿主标识（pi-web / pi / dsh / …）——桥里 agentId 用 */
  readonly kind: string;
  /** 当前 agent 会话标识（模型某轮执行时有值） */
  currentSession(): { agentId: string; sessionId: string; cwd?: string } | null;
  /** 宿主如何注册一个工具 */
  registerTool(def: HostToolDef): void;
  /** 宿主如何把推文注入模型（模型立即看到并行动） */
  injectToModel(agentKey: string, text: string, opts?: { steer?: boolean }): void;
  /** 宿主非阻塞通知（告知用户一条消息） */
  notify(text: string, kind?: "info" | "warning"): void;
}

/** 工具映射模板选项 */
export interface MapBridgeToolsOptions {
  /** 工具名前缀（默认 "aiti_"） */
  prefix?: string;
  /** 桥 inputSchema → 宿主 parameters（默认原样 JSON Schema；pi 传 typebox 映射） */
  parameters?: (schema: Record<string, unknown>) => unknown;
  /** 可选：宿主需要 output 声明（DSH 传） */
  output?: (tool: BridgeTool) => { schema: unknown; render: (args: Record<string, unknown>, value: unknown) => unknown[] };
  /** 描述后缀（注明宿主来源，避免与 MCP 同名工具歧义） */
  descriptionSuffix?: string;
  /** 宿主执行桥工具（含取消信号透传） */
  execute: (tool: BridgeTool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/** 把桥工具定义映射成宿主工具定义并逐个注册（遍历 bridge.tools()；回调内部处理幂等/去重） */
export function mapBridgeTools(bridgeTools: BridgeTool[], host: AgentHost, opts: MapBridgeToolsOptions): void {
  const prefix = opts.prefix ?? "aiti_";
  const parameters = opts.parameters ?? ((s) => s);
  const descriptionSuffix = opts.descriptionSuffix ? "（" + opts.descriptionSuffix + "）" : "";
  for (const t of bridgeTools) {
    const name = prefix + t.name;
    const description = t.description + descriptionSuffix;
    const def: HostToolDef = {
      name,
      description,
      parameters: parameters(t.inputSchema || { type: "object", properties: {} }),
      ...(opts.output ? { output: opts.output(t) } : {}),
      execute: async (args, signal) => opts.execute(t, args || {}, signal),
    };
    host.registerTool(def);
  }
}

/** 桥工具执行结果 → 宿主工具返回（content text + isError；供 pi 等多宿主直接用） */
export function wrapToolResult(r: AgentCallResult): HostToolResult {
  if (!r.ok) {
    return { content: [{ type: "text", text: r.error || "未知错误" }], details: {}, isError: true };
  }
  return {
    content: [{ type: "text", text: r.result ?? "" }],
    details: {},
    ...(r.isError ? { isError: true as const } : {}),
  };
}
