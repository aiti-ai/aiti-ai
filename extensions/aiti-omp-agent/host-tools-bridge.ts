/**
 * P2 host tools 桥接线：把本实例桥（aiti-devtools MCP）的 `aiti_*` 工具注册为
 * omp 宿主工具（set_host_tools）。agent 调用 → host_tool_call 帧 → 本模块经
 * HTTP tools/call 透传给桥 → 结果文本回 host_tool_result。
 *
 * 失败策略：桥不可达 / 无工具 / 注册失败一律静默降级——omp 会话照常可用，
 * 只是少一批 aiti_* 工具（console 记一行）。
 *
 * 拆分自 aiti-pi-agent 的 host-tools-bridge.ts（omp 独有能力）。
 */

import { bridgeEnv } from "@aiti-ai/ext-shared/agent-spawn-env";
import { filterHostToolsByAllow, parseHostToolsAllow, readHostToolsAllow } from "@aiti-ai/ext-shared/host-tools-allow";
import type { HostToolDefinition } from "./fork-rpc/spec.ts";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function mcpEndpoint(): string {
  // 显式 AITI_BRIDGE_URL 优先（测试/特殊部署）；缺省按 pi-web 自身实例推导（与 spawn 注入同源）。
  const explicit = process.env.AITI_BRIDGE_URL;
  if (explicit) return `${explicit.replace(/\/+$/, "")}/mcp/mcp`;
  return `${bridgeEnv().AITI_BRIDGE_URL}/mcp/mcp`;
}

async function mcpRpc(method: string, params?: Record<string, unknown>, id: number | string = 1, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(mcpEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`bridge MCP ${method} -> HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  let payload: string = raw;
  if (contentType.includes("text/event-stream")) {
    // streamable HTTP 可能回 SSE 帧——取最后一条 data: JSON 行
    const lines = raw.split("\n").filter((line) => line.startsWith("data:"));
    payload = lines.length ? lines[lines.length - 1].slice(5).trim() : "";
  }
  if (!payload) return undefined;
  const parsed = JSON.parse(payload) as { result?: Record<string, unknown>; error?: { message?: string } };
  if (parsed.error) throw new Error(parsed.error.message ?? `bridge MCP ${method} error`);
  return parsed.result;
}

/** 拉取桥 MCP 工具清单并注册为宿主工具；返回注册成功的工具名（失败返回空数组）。 */
export async function wireBridgeHostTools(handle: {
  setHostTools(tools: HostToolDefinition[]): Promise<string[]>;
}): Promise<string[]> {
  let seq = 10;
  try {
    const result = await mcpRpc("tools/list");
    const all = Array.isArray(result?.tools) ? (result!.tools as McpTool[]) : [];
    // G1 白名单（docs/pi-web-ext-host-tools-gate-plan.md §G1）：缺省只读子集；feature `hostToolsAllow`=* 恢复全量
    const allow = parseHostToolsAllow(readHostToolsAllow("aiti-omp-agent"));
    const tools = filterHostToolsByAllow(all, allow);
    if (!tools.length) return [];
    if (tools.length !== all.length) {
      console.log(`[aiti-omp-agent] G1 host tools allow=${allow === "all" ? "*" : allow === "readonly" ? "readonly" : "custom"}: ${tools.length}/${all.length} wired`);
    }
    const definitions: HostToolDefinition[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
      async execute(args, signal) {
        const callResult = await mcpRpc("tools/call", { name: tool.name, arguments: args }, ++seq, signal);
        const content = Array.isArray(callResult?.content) ? callResult!.content as Array<{ type?: string; text?: string }> : [];
        const text = content
          .filter((item) => !item.type || item.type === "text")
          .map((item) => item.text ?? "")
          .join("\n")
          .trim();
        if (!text) throw new Error(`Host tool ${tool.name} returned no text output.`);
        return text;
      },
    }));
    const accepted = await handle.setHostTools(definitions);
    if (accepted.length) console.log(`[aiti-omp-agent] omp host tools wired: ${accepted.length} aiti tools`);
    return accepted;
  } catch (caught) {
    console.log(`[aiti-omp-agent] omp host tools unavailable: ${caught instanceof Error ? caught.message : caught}`);
    return [];
  }
}