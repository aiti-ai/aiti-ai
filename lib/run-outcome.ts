/**
 * 会话运行终态（run outcome）——「最近一次运行的结果」的单一判定来源。
 *
 * 背景：会话文件里最后一条 assistant 消息自带结果语义（stopReason / errorMessage），
 * 但此前没有任何地方读取它——run 失败后通知照样报「任务完成」。本模块提供纯函数：
 * 会话文件推导（session-reader）与运行时 wrapper 内存判定（rpc-manager）共用同一规则。
 *
 * 判定对照（只看**最后一条** assistant 消息——steer 打断等中间态会被后续消息覆盖）：
 *   error                  → failed（带 errorMessage）
 *   aborted                → aborted（用户主动停止）
 *   stop / length          → completed
 *   toolUse / pending / deferred 等未达终态 → interrupted
 *   无 assistant 消息       → undefined（不标记）
 *
 * 注意：`interrupted` 是文件层客观状态；会话当前是否在运行由调用方（running 集）优先覆盖。
 */

export type SessionRunStatus = "completed" | "failed" | "aborted" | "interrupted";

/** 会话最近一次运行的终态（SessionInfo.lastRun）。error 为 errorMessage 原文，展示侧自行截断。 */
export interface SessionLastRun {
  status: SessionRunStatus;
  /** 终态消息时间（ISO 8601）。 */
  at: string;
  /** 仅 failed 时有值。 */
  error?: string;
}

/** 判定输入的最小消息形状（pi 消息与本地解析消息的公共子集）。 */
export interface RunOutcomeMessageLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

function statusForStopReason(stopReason: string | undefined): SessionRunStatus {
  switch (stopReason) {
    case "error":
      return "failed";
    case "aborted":
      return "aborted";
    case "stop":
    case "length":
      return "completed";
    default:
      // toolUse / pending / deferred / 未知值：run 未达终态
      return "interrupted";
  }
}

/**
 * 从消息序列推导最近一次运行终态。无 assistant 消息时返回 undefined。
 *
 * @param messages 会话消息（按时间正序）
 * @param fallbackAt 终态消息缺 timestamp 时的兜底时间（ISO）；缺省时返回 undefined 语义（仅当消息也没有时间）
 */
export function deriveRunOutcome(
  messages: ReadonlyArray<RunOutcomeMessageLike> | undefined | null,
  fallbackAt?: string,
): SessionLastRun | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const at = typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? new Date(message.timestamp).toISOString()
      : fallbackAt;
    if (!at) return undefined;
    const status = statusForStopReason(message.stopReason);
    return {
      status,
      at,
      ...(status === "failed" && typeof message.errorMessage === "string" && message.errorMessage.trim()
        ? { error: message.errorMessage }
        : {}),
    };
  }
  return undefined;
}

/** 错误摘要（通知/行内展示）：压平换行与连续空白，超长截断加省略号（按码点截断，emoji 安全）。 */
export function truncateRunError(error: string | undefined, max = 120): string {
  if (!error) return "";
  const flat = error.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max - 1).join("")}…`;
}

/** lastRun 是否需要通知（completed/failed 通知；aborted 用户主动停止不通知；interrupted 无通知时点）。 */
export function runOutcomeNotifies(status: SessionRunStatus): boolean {
  return status === "completed" || status === "failed";
}
