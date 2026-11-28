/**
 * StatsChip —— 会话统计行尾部的账号剩余额度指示（sessionStatsInline 插槽）。
 *
 * 数据 = extra.backendUsage（core get_usage 协议拉取的快照，宿主 ChatWindow 经
 * onBackendUsageChange 上提到 AppShell 再由插槽下发）；本扩展只负责展示。
 * 空数据（新建会话 / 无 getUsage 能力）返回 null。窄屏（isMobile/isCompact）
 * 返回 null，行宽留给上下文百分比（与 sysmon chips 同口径）。
 *
 * 契约：inline content only（span）——挂载在宿主统计 <button> 内，点击冒泡打开
 * 会话信息面板（面板里的「剩余额度」明细即本扩展 sessionInfoPanel）。
 */

import type { ReactNode } from "react";
import { t } from "./host-shim";

export interface BackendUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  credits?: { remaining?: number; used?: number; usedPercent?: number; unit?: string; expiresAt?: number };
  quotaExceeded?: boolean;
  buckets?: Array<{ name: string; remaining?: number; total?: number; used?: number; usedPercent?: number }>;
  plan?: string;
  provider?: string;
}

/** Last visible snapshot, kept at module scope so the registered item's
 *  `meta.tooltip` callback can read it on hover (host appends the line to the
 *  stats button's own tooltip). */
let latest: BackendUsage | null = null;

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function missing(v: number | undefined): string {
  return v == null ? "?" : String(v);
}

/** One-line quota summary for the stats tooltip, e.g.
 *  `quota: 665 credits (93%) · 基础 0/6000 · 扩展 665/3400`. */
export function usageTooltipLine(): string | null {
  const u = latest;
  if (!u) return null;
  const parts: string[] = [];
  const c = u.credits;
  if (u.quotaExceeded && (c?.remaining == null || c.remaining <= 0)) parts.push(t("providerUsage.quotaExceeded"));
  if (c?.remaining != null) {
    parts.push(`${c.remaining}${c.unit ? ` ${c.unit}` : ""}${c.usedPercent != null ? ` (${c.usedPercent}%)` : ""}`);
  } else if (c?.usedPercent != null) {
    parts.push(`${c.usedPercent}%`);
  }
  for (const b of u.buckets ?? []) {
    parts.push(`${bucketLabel(b.name)} ${missing(b.remaining)}/${missing(b.total)}`);
  }
  return parts.length ? `${t("providerUsage.chip.tooltip")}: ${parts.join(" · ")}` : null;
}

export function bucketLabel(name: string): string {
  const key = `providerUsage.bucket.${name}`;
  const label = t(key);
  return label === key ? name : label;
}

export function StatsChip(props: {
  backendUsage?: BackendUsage | null;
  isMobile?: boolean;
  isCompact?: boolean;
}): ReactNode {
  const usage = props.backendUsage ?? null;
  const credits = usage?.credits;
  const hasData = Boolean(usage && (credits || usage.quotaExceeded));
  const visible = hasData && !props.isMobile && !props.isCompact;
  latest = visible ? usage : null;
  if (!visible || !usage) return null;

  const exhausted = Boolean(usage.quotaExceeded && (credits?.remaining == null || credits.remaining <= 0));
  const pct = credits?.usedPercent;
  const color = exhausted || (pct != null && pct >= 90)
    ? "var(--danger, #ef4444)"
    : pct != null && pct >= 70
      ? "var(--warn, #d97706)"
      : "var(--text-muted, #9aa0a6)";
  // ONE remaining-capacity value: the merged remaining when known, else the
  // used percentage; exhausted → ⊘ (the tooltip carries the detail).
  const text = exhausted
    ? "⊘"
    : credits?.remaining != null
      ? `◈${credits.remaining}`
      : pct != null
        ? `◈${pct}%`
        : "◈";

  return (
    <span
      data-provider-usage-chip
      style={{
        display: "flex", alignItems: "center", flexShrink: 0,
        fontSize: 10, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
        color,
      }}
    >
      {text}
    </span>
  );
}

export function fmtLastTurn(usage: BackendUsage): string | null {
  const parts: string[] = [];
  if (usage.inputTokens != null) parts.push(`↑${fmtTokens(usage.inputTokens)}`);
  if (usage.outputTokens != null) parts.push(`↓${usage.outputTokens}`);
  if (usage.costUsd != null && usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts.length ? parts.join(" ") : null;
}