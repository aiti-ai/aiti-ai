/**
 * PermissionCard —— 工具授权请求卡（自 pi-web core ChatWindow 内联块外迁，aiti-session-cards 接管；
 * 方案 docs/pi-web-agent-capability-ui-ext-plan.md §3.1）。
 *
 * 数据源：sessionRequestCard 插槽 extra（permission 家族）。按钮集来自宿主透传 options
 * （ACP optionId/kind——「总是允许」等协议语义经 optionId 透传）；无 options 回退 允许/拒绝。
 * 结构化渲染（权限 UI 契约）：摘要单行 + 完整入参折叠详情，替代裸 JSON。
 */

import { useState } from "react";
import type { SessionRequestCardProps } from "./types";

/** 入参摘要（单行；常见字符串键拼接——与原 core 实现同形）。 */
function permissionInputSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    const rec = input as Record<string, unknown>;
    const parts = ["command", "path", "file_path", "url", "pattern", "query", "description"]
      .filter((k) => typeof rec[k] === "string" && rec[k])
      .map((k) => `${k}: ${String(rec[k])}`);
    return parts.join("  ");
  } catch {
    return "";
  }
}

/** 宿主选项按钮文案（kind → 中文标签；name 优先）。 */
function permissionOptionLabel(o: { kind?: string; name?: string }): string {
  if (o.name) return o.name;
  const map: Record<string, string> = {
    allow_once: "本次允许", allow_always: "总是允许",
    reject_once: "本次拒绝", reject_always: "总是拒绝",
  };
  return map[String(o.kind ?? "")] ?? String(o.kind ?? "选择");
}

export default function PermissionCard({ request, respond }: SessionRequestCardProps) {
  const [busy, setBusy] = useState(false);
  const summary = permissionInputSummary(request.input);
  const options = request.options?.length ? request.options : null;

  const answer = async (action: "accept" | "decline", optionId?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await respond({ action, optionId });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="permission-request-card"
      style={{
        position: "fixed", bottom: 140, left: "50%", transform: "translateX(-50%)", zIndex: 260,
        width: "min(480px, 92vw)", maxHeight: "86vh", overflowY: "auto",
        background: "var(--bg-panel)", border: "1px solid #f59e0b88",
        borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.35)", padding: "12px 14px", fontFamily: "var(--font-mono)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 14 }}>🔐</span>
        <strong style={{ fontSize: 13, color: "var(--text)" }}>工具授权请求</strong>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--accent)" }}>{request.toolName}</span>
      </div>
      {summary && (
        <div style={{ fontSize: 12, color: "var(--text)", background: "var(--bg)", borderRadius: 6,
          padding: "6px 8px", margin: "0 0 6px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{summary}</div>
      )}
      {request.input != null && (
        <details style={{ margin: "0 0 8px" }}>
          <summary style={{ fontSize: 11, color: "var(--text-muted)", cursor: "pointer", userSelect: "none" }}>详情（完整入参）</summary>
          <pre style={{ maxHeight: 160, overflowY: "auto", fontSize: 11, background: "var(--bg)", borderRadius: 6,
            padding: "6px 8px", margin: "6px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text-muted)" }}>
            {typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2)}
          </pre>
        </details>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {options
          ? options.map((o) => {
            const deny = String(o.kind ?? "").startsWith("reject");
            return (
              <button key={String(o.optionId ?? o.kind ?? o.name)} type="button" disabled={busy}
                onClick={() => void answer(deny ? "decline" : "accept", o.optionId)}
                style={{ padding: "5px 14px", borderRadius: 7, border: deny ? "1px solid #ef444466" : "none",
                  background: deny ? "none" : "#22c55e", color: deny ? "#ef4444" : "#fff",
                  cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                {permissionOptionLabel(o)}
              </button>
            );
          })
          : (<>
            <button type="button" disabled={busy} onClick={() => void answer("decline")}
              style={{ padding: "5px 14px", borderRadius: 7, border: "1px solid #ef444466",
                background: "none", color: "#ef4444", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
              拒绝
            </button>
            <button type="button" disabled={busy} onClick={() => void answer("accept")}
              style={{ padding: "5px 14px", borderRadius: 7, border: "none",
                background: "#22c55e", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
              允许
            </button>
          </>)}
      </div>
    </div>
  );
}
