/**
 * Relay — agent-to-agent 消息互通（cc-connect bot-to-bot 对齐）。
 *
 * 把一条消息投递给目标 live 会话（任意后端），等待其回合结束并回收
 * 最终 assistant 文本。发起方可以是：前端编排、另一个会话经 API 调用、
 * 或未来的 agent 自治工具。
 *
 * 约束（Phase 1）：
 *   - 目标必须存活且空闲；忙时拒绝（不排队——排队语义归各后端队列）
 *   - 回复文本 = 本轮 assistant 增量累积；不含历史
 *   - 不自动注入回发起方会话（调用方决定如何使用回复）
 */

import { getHandle } from "./handle-store.ts";
import type { SessionHandle } from "./types";

export interface RelayResult {
  ok: boolean;
  /** 目标本轮的最终 assistant 文本（成功时有）。 */
  reply?: string;
  /** 目标 id（回传便于审计）。 */
  to?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Send `message` to the target live session and collect its reply.
 *
 * Flow: subscribe → prompt(target) → accumulate message_update deltas →
 * resolve on agent_settled (or timeout / backend death).
 */
export async function relayToSession(
  to: string,
  message: string,
  options: { timeoutMs?: number; images?: never[] } = {},
): Promise<RelayResult> {
  const handle = getHandle(to);
  if (!handle) {
    return { ok: false, error: `target session not found or dead: ${to}` };
  }
  if (handle.isRunning()) {
    return { ok: false, to, error: "target is busy (running a turn)" };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let replyText = "";
  let settled = false;
  let backendDead: string | null = null;

  const unsubscribe = handle.subscribe((event) => {
    const type = String(event.type ?? "");
    if (type === "session_backend_dead") {
      backendDead = String(event.reason ?? "backend died");
      return;
    }
    // 兼容两种流式事件名：adapter 归一化的 message_update 与原生 delta 字段
    if (type === "message_update" && typeof event.delta === "string") {
      replyText += event.delta;
      return;
    }
    if (type === "agent_message_chunk") {
      const block = (event.contentBlock ?? event.content ?? {}) as Record<string, unknown>;
      if (typeof block.text === "string") replyText += block.text;
      return;
    }
    if (type === "assistant_message" && typeof event.text === "string") {
      replyText = event.text; // 完整帧覆盖增量
    }
  });

  try {
    // 发送（prompt 内部处理 preflight/queue 语义）
    await handle.prompt(message);
  } catch (e) {
    unsubscribe();
    return { ok: false, to, error: e instanceof Error ? e.message : String(e) };
  }

  // 等 settle
  const startedAt = Date.now();
  while (!settled && !backendDead && Date.now() - startedAt < timeoutMs) {
    if (!handle.isRunning() && replyText !== "") break;
    await sleep(200);
    // 再查一次事件里可能已经置位的状态
    if (!handle.alive()) backendDead = "target died mid-turn";
  }
  unsubscribe();

  if (backendDead) return { ok: false, to, error: `target died: ${backendDead}` };
  if (!settled && Date.now() - startedAt >= timeoutMs && handle.isRunning()) {
    return { ok: false, to, error: `timeout after ${timeoutMs}ms (target still running)` };
  }

  // 兜底：settle 事件可能在订阅窗口外——问一次 getLastAssistantText 类能力
  if (!replyText) {
    const t = await safeLastText(handle);
    if (t) replyText = t;
  }

  return { ok: true, to, reply: replyText.trim() || "(empty reply)" };
}

/** 目标若实现 getLastAssistantText 类查询则兜底取值（可选能力，缺失静默）。 */
async function safeLastText(handle: SessionHandle): Promise<string | undefined> {
  try {
    const r = (await (handle as unknown as {
      send?: (cmd: Record<string, unknown>) => Promise<unknown>;
    }).send?.({ type: "get_last_assistant_text" })) as { text?: string } | undefined;
    return r?.text || undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
