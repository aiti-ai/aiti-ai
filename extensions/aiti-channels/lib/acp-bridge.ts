/**
 * aiti-channels · ACP 会话 ↔ pi-web 会话桥接（P4 核心）
 *
 * 方向：cc-connect（IM 消息）→ 连接器 → 本扩展 ACP server → 这里 → pi-web 真会话。
 * 桥目标 = pi-web 进程内本地会话（方案 M）：经 globalThis.__piLocalSessionFactory
 * （pi-web instrumentation 安装，lib/rpc-manager.ts installLocalSessionFactory）
 * 创建/打开真实 pi 会话——落盘、索引、UI 全部原生，用户可在 pi-web 界面同时查看/互动。
 *
 * 会话映射：一个 ACP session = 一个 pi-web 会话（cc-connect 每个 IM 会话 spawn
 * 一个连接器进程 → session/new 一次）。映射持久化在 <dataDir>/acp/sessions.json，
 * pi-web 重启后 session/load 可按 sessionFile 重开（registry 命中时直接复用 UI
 * 已打开的 wrapper——同一个会话，UI 与 IM 双端全互动）。
 *
 * 事件翻译（pi 词汇表 → ACP session/update）：
 *   message_update(text_delta)            → agent_message_chunk
 *   tool_execution_start                  → tool_call (in_progress)
 *   tool_execution_update                 → tool_call_update (in_progress + 输出)
 *   tool_execution_end                    → tool_call_update (completed/failed)
 *   agent_settled / aborted               → prompt 完成（end_turn / cancelled）
 *
 * 工具审批：桥有 session/request_permission 全套管道（协议面见 acp-server.ts）——
 * 收到会话的 permission_request 事件时向 ACP 客户端（cc-connect）发起反向请求，
 * IM 弹批准卡，决定经 wrapper.respondPermission?.() 回灌。pi 会话目前没有审批
 * 事件（pi SDK 无审批闸），所以今天这条链路处于待命状态：管道就位，等 pi 侧
 * 事件出现即生效（事件形状按 pi-web SessionHandle 事件流契约 type="permission_request"）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { getDataDir } from "./manager.ts";

export const ACP_BRIDGE_VERSION = "0.2.0";
const MAX_TOOL_CONTENT = 2000;

// ---------------------------------------------------------------------------
// 人闸（session/request_permission）类型
// ---------------------------------------------------------------------------

/** 一次待批准的工具调用（ACP toolCall 块；与 cc-connect 解析面同构） */
export type PermissionToolCall = {
  toolCallId: string;
  title: string;
  kind?: string;
  rawInput?: unknown;
};

/** 客户端（IM 侧）对一次人闸的决定：selected=选了某选项；cancelled=取消/无果 */
export type PermissionOutcome = { outcome: "selected" | "cancelled"; optionId?: string };

/** 人闸通道：ACP 连接在线时由 server 注入（callClient 实现）；离线为 null */
export type PermissionAsk = (toolCall: PermissionToolCall) => Promise<PermissionOutcome | null>;

// ---------------------------------------------------------------------------
// 工厂缝（pi-web 宿主）
// ---------------------------------------------------------------------------

type LocalSessionFactory = {
  start(
    sessionId: string,
    sessionFile: string,
    cwd: string | undefined,
    options?: Record<string, unknown>,
  ): Promise<{ session: WrapperLike; realSessionId: string }>;
};

type Listener = (event: Record<string, unknown>) => void;

/** AgentSessionWrapper 我们用到的面（结构化，不 import 宿主类型——扩展惯例） */
type WrapperLike = {
  sessionId: string;
  onEvent(listener: Listener): () => void;
  send(command: Record<string, unknown>): Promise<unknown>;
  isAlive(): boolean;
  isRunning(): boolean;
  /** pi AgentSession——取 sessionFile 用（inner.sessionManager.getSessionFile()） */
  inner?: { sessionManager?: { getSessionFile?: () => string | undefined } };
  /**
   * 工具授权回灌（pi-web SessionHandle 同名能力；wrapper 现未实现——pi 会话
   * 目前无审批闸）。出现 permission_request 事件且本方法缺席时，IM 侧决定无处
   * 回灌，桥记日志并放弃（不阻塞轮次）。
   */
  respondPermission?(requestId: string, decision: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }): Promise<boolean>;
};

function factory(): LocalSessionFactory {
  const f = (globalThis as Record<string, unknown>).__piLocalSessionFactory as LocalSessionFactory | undefined;
  if (!f) {
    throw new Error(
      "__piLocalSessionFactory 未安装：pi-web 未加载 lib/rpc-manager（主 realm），或 pi-web 未重启使顶层 install 生效",
    );
  }
  return f;
}

// ---------------------------------------------------------------------------
// 持久化注册表：<dataDir>/acp/sessions.json
// ---------------------------------------------------------------------------

export type BridgedSessionInfo = {
  acpSessionId: string;
  piSessionId: string;
  sessionFile: string;
  cwd: string;
  createdAt: string;
};

function registryFile(): string {
  // fallback 与 acp-server.acpSocketPath 的 homedir 兜底保持一致——相对路径会让
  // registry 落进 pi-web 进程 cwd（如 ~/workspace/pi-prod/.pi/...）源码树
  return path.join(getDataDir() || path.join(homedir(), ".pi", "web", "data", "aiti-channels", "config"), "acp", "sessions.json");
}

function readRegistry(): BridgedSessionInfo[] {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeRegistry(list: BridgedSessionInfo[]) {
  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------------------
// 运行时（globalThis 单例——reload 复用，socket/会话不中断）
// ---------------------------------------------------------------------------

type EmitFn = (update: Record<string, unknown>) => void;

type RuntimeSession = {
  info: BridgedSessionInfo;
  wrapper: WrapperLike | null;
  unsubscribe: (() => void) | null;
  /** 当前 prompt 的更新出口（ACP 连接）；null = 无人在看（后台跑完照常落盘） */
  emit: EmitFn | null;
  /** 当前 prompt 的 ACP 连接人闸通道；与 emit 同生命周期（session/prompt 注入） */
  permissionAsk: PermissionAsk | null;
  /** pending prompt 完成器（收到轮末 stopReason 对象） */
  settle: ((result: { stopReason: "end_turn" | "cancelled" | "refusal" }) => void) | null;
  aborted: boolean;
  /** 本轮是否已发过 text delta（message_end fallback 用，防重复；turn 结束 reset） */
  emittedText: boolean;
};

type RuntimeState = { sessions: Map<string, RuntimeSession> };

// 无版本号 key：reload 复用同一运行时（旧桥闭包继续服务已连连接器，socket 不断）
const RT_KEY = "__aitiChannelsAcpBridge";

function rt(): RuntimeState {
  const g = globalThis as Record<string, unknown>;
  if (!g[RT_KEY]) g[RT_KEY] = { sessions: new Map<string, RuntimeSession>() };
  return g[RT_KEY] as RuntimeState;
}

// ---------------------------------------------------------------------------
// 事件翻译
// ---------------------------------------------------------------------------

function textDeltaOf(ev: Record<string, unknown>): string | null {
  // 只处理 assistant 消息（user message 也会发 message_update，要过滤）
  const role = (ev.message as { role?: string } | undefined)?.role || (ev.role as string | undefined);
  if (role && role !== "assistant") return null;
  // 规范化形状（handle 层）：{ delta: string }
  if (typeof ev.delta === "string") return ev.delta;
  // pi 原生形状：{ assistantMessageEvent: { type: "text_delta", delta } }
  const ame = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
  if (ame && ame.type === "text_delta" && typeof ame.delta === "string") return ame.delta;
  return null;
}

/** message_end 完整文本（reasoning 模型等不流式 text delta 时，本轮回复只在 message_end；仅 assistant） */
function messageEndText(ev: Record<string, unknown>): string | null {
  const role = (ev.message as { role?: string } | undefined)?.role || (ev.role as string | undefined);
  if (role && role !== "assistant") return null;
  if (typeof ev.text === "string" && ev.text) return ev.text;
  const msg = ev.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = msg?.content?.find((b) => b.type === "text")?.text;
  return text || null;
}

const KIND_MAP: Array<[RegExp, string]> = [
  [/read/i, "read"],
  [/edit|write|patch/i, "edit"],
  [/bash|exec|run/i, "execute"],
  [/grep|glob|find|search|ls|tree/i, "search"],
  [/fetch|http|web/i, "fetch"],
  [/think|plan/i, "think"],
];

function kindOf(toolName: string): string {
  for (const [re, kind] of KIND_MAP) if (re.test(toolName)) return kind;
  return "other";
}

function truncate(s: string): string {
  return s.length > MAX_TOOL_CONTENT ? s.slice(0, MAX_TOOL_CONTENT) + "…(截断)" : s;
}

function toolContent(text: unknown): Array<Record<string, unknown>> | undefined {
  if (text === undefined || text === null || text === "") return undefined;
  const s = typeof text === "string" ? text : JSON.stringify(text);
  if (!s) return undefined;
  return [{ type: "content", content: { type: "text", text: truncate(s) } }];
}

/** pi 工具事件 → ACP update（message_update/message_end 在 attach 分流处理，不在此） */
function translateEvent(ev: Record<string, unknown>): Record<string, unknown> | null {
  const type = String(ev.type ?? "");
  if (type === "tool_execution_start") {
    const toolName = String(ev.toolName ?? "tool");
    return {
      sessionUpdate: "tool_call",
      toolCallId: String(ev.toolCallId ?? randomUUID()),
      title: `${toolName} ${truncate(JSON.stringify(ev.args ?? {}))}`,
      kind: kindOf(toolName),
      status: "in_progress",
      rawInput: ev.args ?? {},
    };
  }
  if (type === "tool_execution_update") {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: String(ev.toolCallId ?? ""),
      status: "in_progress",
      ...(toolContent(ev.partialResult) ? { content: toolContent(ev.partialResult) } : {}),
    };
  }
  if (type === "tool_execution_end") {
    const result = ev.result as { output?: unknown; content?: unknown } | undefined;
    const text = result && typeof result === "object" && "output" in result ? result.output : ev.result;
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: String(ev.toolCallId ?? ""),
      status: ev.isError ? "failed" : "completed",
      ...(toolContent(text) ? { content: toolContent(text) } : {}),
    };
  }
  return null;
}

/** turn 结束判定：settled / aborted / agent_end /（错误收尾） */
function isTurnEnd(type: string): boolean {
  return type === "agent_settled" || type === "agent_end";
}

// ---------------------------------------------------------------------------
// 核心操作
// ---------------------------------------------------------------------------

function attach(runtime: RuntimeSession, wrapper: WrapperLike) {
  runtime.wrapper = wrapper;
  runtime.unsubscribe?.();
  runtime.unsubscribe = wrapper.onEvent((ev) => {
    const type = String(ev.type ?? "");
    const emit = (u: Record<string, unknown>) => { if (runtime.emit) try { runtime.emit(u); } catch { /* 连接断不影响会话 */ } };
    // 文本流式：message_update text delta → agent_message_chunk
    if (type === "message_update") {
      const delta = textDeltaOf(ev);
      if (delta) { runtime.emittedText = true; emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } }); }
      return;
    }
    // message_end fallback：本轮没经 delta 流式（reasoning 模型等）→ 发完整文本作单 chunk
    if (type === "message_end") {
      if (!runtime.emittedText) {
        const text = messageEndText(ev);
        if (text) { runtime.emittedText = true; emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }); }
      }
      return;
    }
    // 人闸：会话请求工具授权 → ACP 反向请求（IM 批准卡）→ 决定回灌会话。
    // pi 会话目前不发该事件（无审批闸）；事件形状按 SessionHandle 事件流契约预留。
    if (type === "permission_request") {
      void handlePermissionRequest(runtime, ev);
      return;
    }
    // 工具事件
    if (type.startsWith("tool_execution")) {
      const update = translateEvent(ev);
      if (update) emit(update);
      return;
    }
    if (isTurnEnd(type)) {
      runtime.emittedText = false; // reset for next turn
      if (runtime.settle) {
        const settle = runtime.settle;
        runtime.settle = null;
        runtime.emit = null;
        runtime.permissionAsk = null;
        settle({ stopReason: runtime.aborted ? "cancelled" : "end_turn" });
      }
    }
  });
}

/**
 * 人闸触发点：permission_request 事件 → ACP session/request_permission（IM 卡）
 * → 决定回灌 wrapper.respondPermission。ACP 连接离线（无 IM 在看）或请求失败时
 * 不产生决定，pi 侧行为不受影响（今天=等价无操作；未来 pi 有审批闸时由 pi 侧
 * 超时策略接管）。
 */
async function handlePermissionRequest(runtime: RuntimeSession, ev: Record<string, unknown>): Promise<void> {
  const ask = runtime.permissionAsk;
  const requestId = String(ev.requestId ?? "");
  if (!ask) {
    console.log(`[aiti-channels][acp] permission_request ${requestId.slice(0, 8)} 无 ACP 连接在看（无 IM 人闸），跳过`);
    return;
  }
  const input = (ev.input ?? {}) as Record<string, unknown>;
  const toolCall: PermissionToolCall = {
    toolCallId: requestId || randomUUID(),
    title: String(ev.toolName ?? ev.prompt ?? "permission"),
    kind: "other",
    rawInput: input,
  };
  const outcome = await ask(toolCall);
  const allow = outcome?.outcome === "selected" && outcome.optionId === "allow";
  console.log(`[aiti-channels][acp] permission ${toolCall.toolCallId.slice(0, 8)} IM 决定=${allow ? "allow" : "deny/none"}`);
  const respond = runtime.wrapper?.respondPermission?.bind(runtime.wrapper);
  if (!respond) {
    console.log(`[aiti-channels][acp] permission ${toolCall.toolCallId.slice(0, 8)} wrapper 无 respondPermission 能力（pi 侧暂无审批闸），决定无处回灌`);
    return;
  }
  try {
    await respond(requestId, allow ? { behavior: "allow" } : { behavior: "deny", message: "IM 侧拒绝（aiti-channels 人闸）" });
  } catch (e) {
    console.error(`[aiti-channels][acp] permission 回灌失败:`, e instanceof Error ? e.message : e);
  }
}

/**
 * 人闸直入口（供未来 pi 侧事件源 / 测试调用）：对该桥接会话发起一次 IM 批准卡。
 * 返回 null = 没有 ACP 连接在线（没人能批准）。
 */
export function requestPermission(acpSessionId: string, toolCall: PermissionToolCall): Promise<PermissionOutcome | null> {
  const runtime = rt().sessions.get(acpSessionId);
  if (!runtime?.permissionAsk) return Promise.resolve(null);
  return runtime.permissionAsk(toolCall);
}

export function listSessions(): BridgedSessionInfo[] {
  return readRegistry();
}

export function getRuntime(acpSessionId: string): RuntimeSession | undefined {
  return rt().sessions.get(acpSessionId);
}

/** session/new：新建 pi-web 会话（cwd 必须存在） */
export async function createSession(cwd: string): Promise<RuntimeSession> {
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`cwd 不存在：${cwd}`);
  const f = factory();
  const tempKey = `__acp__${randomUUID()}`;
  const { session: wrapper } = await f.start(tempKey, "", cwd, {});
  const sessionFile = wrapper?.inner?.sessionManager?.getSessionFile?.() ?? "";
  const info: BridgedSessionInfo = {
    acpSessionId: randomUUID(),
    piSessionId: wrapper.sessionId,
    sessionFile,
    cwd,
    createdAt: new Date().toISOString(),
  };
  const runtime: RuntimeSession = { info, wrapper: null, unsubscribe: null, emit: null, permissionAsk: null, settle: null, aborted: false, emittedText: false };
  attach(runtime, wrapper);
  rt().sessions.set(info.acpSessionId, runtime);
  writeRegistry([...readRegistry().filter((x) => x.acpSessionId !== info.acpSessionId), info]);
  return runtime;
}

/** session/load：按 acpSessionId 重挂（pi-web 重启后 / 已有 runtime 复用） */
export async function reattach(acpSessionId: string): Promise<RuntimeSession> {
  const existing = rt().sessions.get(acpSessionId);
  if (existing && existing.wrapper?.isAlive()) return existing;
  const info = readRegistry().find((x) => x.acpSessionId === acpSessionId);
  if (!info) throw new Error(`unknown session: ${acpSessionId}`);
  // 用真实 piSessionId 作 registry key：UI 已打开同一会话时直接复用其 wrapper
  const f = factory();
  const { session: wrapper } = await f.start(info.piSessionId, info.sessionFile, undefined, {});
  const runtime: RuntimeSession = { info, wrapper: null, unsubscribe: null, emit: null, permissionAsk: null, settle: null, aborted: false, emittedText: false };
  attach(runtime, wrapper);
  rt().sessions.set(acpSessionId, runtime);
  return runtime;
}

/** session/prompt：发文本并等一轮结束。emit 接收 ACP update 对象；
 *  permissionAsk 为本轮提供人闸通道（ACP 连接的 session/request_permission 实现）。 */
export async function prompt(
  acpSessionId: string,
  text: string,
  emit: EmitFn,
  permissionAsk?: PermissionAsk,
): Promise<{ stopReason: "end_turn" | "cancelled" | "refusal" }> {
  let runtime = rt().sessions.get(acpSessionId);
  if (!runtime || !runtime.wrapper?.isAlive()) runtime = await reattach(acpSessionId);
  if (runtime.settle) throw new Error("session busy：上一轮还没结束（session/cancel 可打断）");
  console.log(`[aiti-channels][acp] bridge.prompt pi=${runtime.info.piSessionId.slice(0, 12)} running=${runtime.wrapper!.isRunning()} len=${text.length}`);
  runtime.emit = emit;
  runtime.permissionAsk = permissionAsk ?? null;
  runtime.aborted = false;
  const done = new Promise<{ stopReason: "end_turn" | "cancelled" | "refusal" }>((resolve) => {
    runtime!.settle = resolve;
  });
  await runtime.wrapper!.send({ type: "prompt", message: text });
  return done;
}

/** session/cancel：打断当前轮（没在跑则无操作） */
export async function cancel(acpSessionId: string): Promise<void> {
  const runtime = rt().sessions.get(acpSessionId);
  if (!runtime?.wrapper) return;
  if (!runtime.settle) return;
  runtime.aborted = true;
  try { await runtime.wrapper.send({ type: "abort" }); } catch { /* 尽力 */ }
}
