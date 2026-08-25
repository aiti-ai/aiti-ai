/**
 * lib/subagent.ts —— 子代理入口（子代理 = fork 出的完整落盘 session + parent 标记）
 *
 * 设计原则（与 pi-subagents 原版对齐）：子代理和真实 agent session 区别越小越好——
 * 复用完整会话创建流程（createAgentSessionServices + createAgentSessionFromServices +
 * startRpcSession），落盘、索引、统计、消息查看、扩展通知全部共用；唯一差别是
 * session header 里带 parentSession 标记（指向父 session 文件），前端据此识别
 * 「它是谁的子代理」。
 *
 * 机制：
 *   1. SessionManager.create(cwd).newSession({ parentSession: 父session文件 })
 *      → fork 一个空 session，header 自动写 parentSession（同 /fork 从头分叉）
 *   2. startRpcSession(forkFile, ..., { subagent: { systemPrompt, excludeTools } })
 *      → 复用完整会话创建（落盘/registry/扩展通知）；注入 agent 定义 systemPrompt
 *   3. wrapper.send({ type: "prompt", message: task }) 驱动执行
 *   4. 订阅 agent_settled / prompt_done → getLastAssistantText() 拿最终输出
 *
 * 暴露：globalThis.__piSubagentFactory（aiti-subagents 扩展经此调用，与桥同模式）。
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

export interface SubagentAgentDef {
  name: string;
  systemPrompt: string;
  /** 可选：指定模型（provider/modelId 或裸 modelId，未解析到则继承父） */
  modelId?: string;
  /** 可选：工具白名单（不传 = 全开，继承全部系统/扩展工具） */
  tools?: string[];
  /** 可选：工具黑名单（默认全开；如排除交互类 user_*） */
  excludeTools?: string[];
}

export interface CreateSubagentOptions {
  /** 父 session 文件绝对路径（parentSession 标记来源） */
  parentSessionFile: string;
  /** 子代理工作目录（fork 的 cwd；通常与父一致） */
  cwd: string;
  /** agent 定义 */
  agent: SubagentAgentDef;
  /** 子代理任务（作为首条 user 消息驱动执行） */
  task: string;
  /** 超时 ms（默认 10 分钟） */
  timeoutMs?: number;
}

export interface SubagentResult {
  sessionId: string;
  sessionFile: string;
  output: string;
  parentSessionFile: string;
  agent: string;
  /** 结果状态：completed / error / timeout / aborted */
  status: "completed" | "error" | "timeout" | "aborted";
}

const SUBAGENT_TIMEOUT_DEFAULT = 10 * 60 * 1000;

/**
 * 创建并运行一个子代理 session（fork + 完整会话流程 + agent 定义控制）。
 * 返回子 session 的最终输出（会话已落盘，消息历史可查、统计共用）。
 */
export async function createSubagentSession(options: CreateSubagentOptions): Promise<SubagentResult> {
  const { parentSessionFile, cwd, agent, task, timeoutMs = SUBAGENT_TIMEOUT_DEFAULT } = options;

  // 1. fork 空 session + parent 标记（同 /fork 从头分叉：SessionManager.create + newSession）
  const sm = SessionManager.create(cwd, undefined, { id: randomUUID() });
  sm.newSession({ parentSession: parentSessionFile });
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) throw new Error("子代理 fork 失败：未生成 session 文件");

  // 2. 复用完整会话创建流程（落盘/registry/扩展通知）+ agent 定义控制
  // 惰性加载 rpc-manager（instrumentation 启动时静态解析会失败；运行时再 import 则无此问题）
  // 用 @/ 别名（turbopack 对相对 .js 后缀解析在 instrumentation 环境不稳定）
  const { startRpcSession } = await import("@/lib/rpc-manager");
  const { session: wrapper, realSessionId } = await startRpcSession(
    `__subagent__${randomUUID()}`,
    sessionFile,
    cwd,
    {
      ...(agent.modelId ? { initialModel: parseModelId(agent.modelId) } : {}),
      // tools 白名单（非空 → 激活这些 + 扩展工具；空数组 → 全禁；缺省 → 全开）
      ...(agent.tools ? { toolNames: agent.tools } : {}),
      subagent: {
        systemPrompt: agent.systemPrompt,
        ...(agent.excludeTools?.length ? { excludeTools: agent.excludeTools } : {}),
      },
    },
  );

  // 3. 驱动执行 + 订阅结果
  return new Promise<SubagentResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      teardown();
      resolve({
        sessionId: realSessionId,
        sessionFile,
        output: wrapper.inner.getLastAssistantText() ?? "",
        parentSessionFile,
        agent: agent.name,
        status: "timeout",
      });
    }, timeoutMs);

    const teardown = () => {
      clearTimeout(timer);
      unsubscribe();
    };

    // agent_settled：一轮完整执行结束（含重试/压缩后）
    const unsubscribe = wrapper.onEvent((event) => {
      if (settled) return;
      if (event.type === "agent_settled") {
        settled = true;
        teardown();
        resolve({
          sessionId: realSessionId,
          sessionFile,
          output: wrapper.inner.getLastAssistantText() ?? "",
          parentSessionFile,
          agent: agent.name,
          status: "completed",
        });
      }
    });

    // 4. 发送任务
    void wrapper.send({ type: "prompt", message: task }).catch((err) => {
      if (settled) return;
      settled = true;
      teardown();
      resolve({
        sessionId: realSessionId,
        sessionFile,
        output: "",
        parentSessionFile,
        agent: agent.name,
        status: "error",
      });
    });
  });
}

/** 解析 "provider/modelId" 或裸 "modelId" 为 startRpcSession 的 initialModel 格式 */
function parseModelId(raw: string): { provider: string; modelId: string } {
  const idx = raw.indexOf("/");
  if (idx > 0) return { provider: raw.slice(0, idx), modelId: raw.slice(idx + 1) };
  // 裸 modelId：provider 留空，由 startRpcSession 按 modelId 解析
  return { provider: "", modelId: raw };
}

/** 挂到 globalThis：aiti-subagents 扩展经此调用（与桥 globalThis.__aitiBridges 同模式） */
export function installSubagentFactory(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.__piSubagentFactory) {
    g.__piSubagentFactory = {
      create: createSubagentSession,
    };
  }
}

// 声明 globalThis 类型（供 TS）
declare global {
  // eslint-disable-next-line no-var
  var __piSubagentFactory: { create: typeof createSubagentSession } | undefined;
}
