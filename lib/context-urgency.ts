/** 上下文紧迫度色阶唯一来源（方案 docs/context-compaction-urgency-plan.md §3.1）：
 *  顶栏指示 / 会话信息面板 / ChatInput 两处压缩按钮全部消费这一个函数，
 *  阈值前三档与顶栏原有分档一致（>70 黄 / >90 红），第四档 critical 为新增。 */
export type CtxUrgencyLevel = "calm" | "warn" | "urgent" | "critical";

export interface CtxUrgency {
  level: CtxUrgencyLevel;
  /** 主色（文字/图标） */
  color: string;
  /** 按钮淡底 */
  bg: string;
  /** 按钮描边 */
  border: string;
}

/** critical 档呼吸动画名（@keyframes 定义在 app/globals.css，带 prefers-reduced-motion 关闭）。 */
export const CTX_BREATHE_ANIMATION = "ctx-urgency-breathe";

/** critical 档动画 shorthand（供内联 style 的 animation 字段直接引用）。 */
export const CTX_BREATHE_CSS = `${CTX_BREATHE_ANIMATION} 1.2s ease-in-out infinite alternate`;

const CALM: CtxUrgency = { level: "calm", color: "var(--text-muted)", bg: "none", border: "var(--border)" };
const WARN: CtxUrgency = { level: "warn", color: "rgba(234,179,8,0.95)", bg: "rgba(234,179,8,0.1)", border: "rgba(234,179,8,0.4)" };
const URGENT: CtxUrgency = { level: "urgent", color: "#ef4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.35)" };
const CRITICAL: CtxUrgency = { level: "critical", color: "#dc2626", bg: "rgba(220,38,38,0.1)", border: "rgba(220,38,38,0.4)" };

/** percent 为 null/undefined（未知）按 calm 灰兜底；阈值边界：>70 warn、>90 urgent、>97 critical。 */
export function contextUrgency(percent: number | null | undefined): CtxUrgency {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return CALM;
  if (percent > 97) return CRITICAL;
  if (percent > 90) return URGENT;
  if (percent > 70) return WARN;
  return CALM;
}
