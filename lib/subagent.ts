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
  /** 中止信号：触发时停止子代理（标记 aborted + 关闭 wrapper） */
  signal?: AbortSignal;
  /** 可选：子代理运行期控制回调（wrapper 就绪即调用，供运行中 steer/abort）。 */
  onControl?: (control: SubagentControl) => void;
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

/**
 * 子代理运行中控制句柄（在子代理 session 创建成功后立即回调给调用方，
 * 用于运行中注入 steer / abort —— 对齐 pi-subagents 生态的 steer_subagent 语义）。
 * 只在子代理 wrapper 运行期有效；完成后 steer 变 no-op（被 settle guard 拦截）。
 */
export interface SubagentControl {
  sessionId: string;
  /** 运行中注入一条导向消息（rpc-manager 的 type:"steer" 通道 → inner.steer）。 */
  steer: (text: string) => Promise<void>;
  /** 主动中止子代理（等价 signal abort，会标记 aborted 并返回当前输出）。 */
  abort: () => void;
  /** 当前是否仍在运行（settle 后 false）。 */
  isRunning: () => boolean;
}

const SUBAGENT_TIMEOUT_DEFAULT = 10 * 60 * 1000;

/**
 * 创建并运行一个子代理 session（fork + 完整会话流程 + agent 定义控制）。
 * 返回子 session 的最终输出（会话已落盘，消息历史可查、统计共用）。
 */
export async function createSubagentSession(options: CreateSubagentOptions): Promise<SubagentResult> {
  const { parentSessionFile, cwd, agent, task, timeoutMs = SUBAGENT_TIMEOUT_DEFAULT, signal, onControl } = options;

  // 1. fork 空 session + parent 标记（同 /fork 从头分叉：SessionManager.create + newSession）
  const sm = SessionManager.create(cwd, undefined, { id: randomUUID() });
  sm.newSession({ parentSession: parentSessionFile });
  // 强制落盘：无 assistant 消息时 SessionManager 惰性不写盘，文件不存在则
  // startRpcSession 打开时会重建（parentSession header 丢失）。同 pi-web fork 的
  // _rewriteFile 处理（rpc-manager case "fork"）。
  try {
    (sm as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
    (sm as unknown as { flushed?: boolean }).flushed = true;
  } catch (e) {
    console.warn("[subagent] fork 强制落盘失败（继续）:", e instanceof Error ? e.message : e);
  }
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
      // fork 出的新文件必属本地，跳过桥占用检查
      skipBridgeCheck: true,
      subagent: {
        systemPrompt: agent.systemPrompt,
        ...(agent.excludeTools?.length ? { excludeTools: agent.excludeTools } : {}),
      },
    },
  );

  // 3. 驱动执行 + 订阅结果
  return new Promise<SubagentResult>((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    let onAbort: (() => void) | null = null;
    let liveWrapper: typeof wrapper | null = wrapper;

    // 运行中控制句柄：wrapper 就绪即回调，供扩展侧实现 steer_subagent / background 模式。
    // steer 走 rpc-manager type:"steer" 通道；abort 复用 signal 中止路径（标记 aborted + 返回当前输出）。
    if (onControl) {
      onControl({
        sessionId: realSessionId,
        steer: async (text: string) => {
          if (settled || !liveWrapper) return;
          // 不吞异常：让调用方（扩展 steerRun）能感知注入失败（如 session 正在替换/关闭）
          await liveWrapper.send({ type: "steer", message: text });
        },
        abort: () => {
          if (settled) return;
          void wrapper.send({ type: "abort" }).catch(() => {});
          finish("aborted", wrapper.inner.getLastAssistantText() ?? "");
        },
        isRunning: () => !settled,
      });
    }

    // 收尾：清 timer + 退订事件 + 关闭 wrapper（文件保留，仅移出活跃 registry，不积累）
    const teardown = () => {
      clearTimeout(timer);
      unsubscribe();
      liveWrapper = null;
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      void wrapper.shutdown("idle").catch((err) => {
        console.warn("[subagent] wrapper shutdown 失败:", err instanceof Error ? err.message : err);
      });
    };

    const finish = (status: "completed" | "timeout" | "error" | "aborted", out: string) => {
      if (settled) return;
      settled = true;
      teardown();
      resolve({
        sessionId: realSessionId,
        sessionFile,
        output: out,
        parentSessionFile,
        agent: agent.name,
        status,
      });
    };

    const timer = setTimeout(() => {
      finish("timeout", wrapper.inner.getLastAssistantText() ?? "");
    }, timeoutMs);

    // 中止信号：停止子代理（用户点 Fleet「停」/ 父会话 abort）
    if (signal) {
      if (signal.aborted) {
        finish("aborted", "");
      } else {
        onAbort = () => {
          void wrapper.send({ type: "abort" }).catch(() => {});
          finish("aborted", wrapper.inner.getLastAssistantText() ?? "");
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // agent_settled：一轮完整执行结束（含重试/压缩后）
    unsubscribe = wrapper.onEvent((event) => {
      if (event.type === "agent_settled") {
        finish("completed", wrapper.inner.getLastAssistantText() ?? "");
      }
    });

    // 4. 发送任务
    void wrapper.send({ type: "prompt", message: task }).catch((err) => {
      console.warn("[subagent] send 失败:", err instanceof Error ? err.message : err);
      finish("error", "");
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
