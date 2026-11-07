/**
 * UsageBadge —— 后端会话用量徽标（自 pi-web core ChatWindow 内联块外迁，agent 能力 UI 去核化 P3；
 * 方案 docs/pi-web-agent-capability-ui-ext-plan.md §2.2）。
 *
 * 数据源：chatOverlay 插槽 extra.backendUsage（core get_usage 协议拉取，展示归本扩展——
 * 用量展示域归口 aiti-provider-usage）。空数据（新建会话/无 getUsage 能力）不渲染。
 * 点击动线：经 "pi-web.composer" 服务的 openSessionInfo 打开宿主会话信息面板
 * （「剩余额度」面板所在地，与本扩展 sessionInfoPanel 面板同域）。
 */

import type { ReactNode } from "react";

export interface BackendUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  credits?: { remaining?: number; usedPercent?: number; unit?: string };
  quotaExceeded?: boolean;
  buckets?: Array<{ name: string; remaining?: number; total?: number }>;
}

const BUCKET_LABELS: Record<string, string> = {
  user_quota: "基础", add_on_quota: "扩展", org_resource_package: "组织",
};

function fmtMoney(v: number, digits = 2): string {
  return `$${v.toFixed(digits)}`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function UsageBadge({ backendUsage }: { backendUsage: BackendUsage | null | undefined }): ReactNode {
  if (!backendUsage) return null;
  const credits = backendUsage.credits;
  const creditsExhausted = backendUsage.quotaExceeded && (credits?.remaining == null || credits.remaining <= 0);
  return (
    <div style={{
      position: "fixed", top: 52, right: 16, zIndex: 200,
      display: "flex", alignItems: "center", gap: 6,
      padding: "3px 10px", borderRadius: 12,
      background: "var(--bg-panel)", border: "1px solid var(--border)",
      fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)",
    }}>
      <span title="Backend usage (last turn)" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {backendUsage.inputTokens != null && <span>↑{fmtTokens(backendUsage.inputTokens)} </span>}
        {backendUsage.outputTokens != null && <span>↓{backendUsage.outputTokens} </span>}
        {backendUsage.costUsd != null && backendUsage.costUsd > 0 && <span>{fmtMoney(backendUsage.costUsd, 4)}</span>}
        {credits && (credits.remaining != null || backendUsage.quotaExceeded) && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{
              fontWeight: 600,
              color: creditsExhausted ? "var(--danger, #ef4444)" : "var(--text)",
            }}>
              {creditsExhausted
                ? "⊘ 配额耗尽"
                : `◈ ${credits.remaining != null ? credits.remaining : "?"}${credits.usedPercent != null ? ` (${credits.usedPercent}%)` : ""}${credits.unit ? ` ${credits.unit}` : ""}`}
            </span>
            {backendUsage.buckets && backendUsage.buckets.length > 0 && (
              <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
                {backendUsage.buckets.map((b, i) => (
                  <span key={b.name}>
                    {i > 0 && " · "}
                    {BUCKET_LABELS[b.name] ?? b.name} {b.remaining ?? 0}/{b.total ?? "?"}
                  </span>
                ))}
              </span>
            )}
          </span>
        )}
      </span>
    </div>
  );
}
