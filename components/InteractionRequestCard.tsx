"use client";

/**
 * InteractionRequestCard —— 交互元语请求卡（pi-web 通用元语；外部后端适配器映射自有协议到这里）。
 *
 * 数据源：useAgentSession 的 interactionRequest（handle 事件 type="interaction_request"）。
 * 形态按 kind 分：
 *   - plan_approval：方案审批（zcode ExitPlanMode 适配）——方案全文 markdown + 批准/反馈后拒绝/拒绝。
 *     「带反馈提交」在 zcode 语义里是 deny+reason=反馈 → agent 收到反馈继续修改方案（不是直接终止）。
 *   - ask_user：问题询问（zcode AskUserQuestion 适配）——每组问题选项按钮（单选/多选）+ 提交/跳过。
 *   - open_url：OAuth 登录链接（omp login 适配）——完整 URL + 打开登录页/复制短链/关闭；单向无需作答
 *     （agent 轮询授权完成自动继续，关闭仅清本卡）。
 *   - generic / permission：自由形态兜底——prompt + input JSON + 接受/拒绝。
 *
 * 回答经 respond_interaction 命令 → SessionHandle.respondInteraction（capability: respondInteraction）。
 * 交互事件只有一轮生命周期：后端 resolve/清理/turn 收口会广播 interaction_expired，各端同步清卡。
 */

import { useMemo, useState } from "react";
import { MarkdownBody } from "./MarkdownBody";

export interface InteractionQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

export interface InteractionRequestInfo {
  requestId: string;
  kind: "plan_approval" | "ask_user" | "permission" | "open_url" | "generic";
  toolName?: string;
  prompt?: string;
  plan?: string;
  /** open_url：登录授权完整 URL（打开登录页用它）。 */
  url?: string;
  /** open_url：本机短链（长 OAuth URL 的代理/重定向壳；复制粘贴优先用它）。 */
  launchUrl?: string;
  questions?: InteractionQuestion[];
  input?: unknown;
}

export function InteractionRequestCard({ request, onRespond }: {
  request: InteractionRequestInfo;
  onRespond: (requestId: string, answer: {
    action: "accept" | "decline";
    answers?: Record<string, string | string[]>;
    message?: string;
  }) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [planFeedback, setPlanFeedback] = useState<string | null>(null);
  /** 每题选中：单选存 label，多选存 label 集合（question 文本为键）。 */
  const [picks, setPicks] = useState<Record<string, string | string[]>>({});
  /** open_url 复制成功的瞬时反馈。 */
  const [copied, setCopied] = useState(false);

  const isPlan = request.kind === "plan_approval";
  const isAsk = request.kind === "ask_user";
  const isOpenUrl = request.kind === "open_url";
  /** 打开登录页用完整 URL；复制优先本机短链（长 OAuth URL 手抄易截断）。 */
  const openUrlTarget = request.url ?? request.launchUrl;
  const copyUrlTarget = request.launchUrl ?? request.url;
  const questions = useMemo(() => request.questions ?? [], [request.questions]);
  /** ask_user 是否已答完所有题（多选至少一项；单选必选其一）。 */
  const allAnswered = questions.length === 0 || questions.every((q) => {
    const v = picks[q.question];
    return Array.isArray(v) ? v.length > 0 : typeof v === "string";
  });

  const respond = async (action: "accept" | "decline", extra?: { answers?: Record<string, string | string[]>; message?: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      await onRespond(request.requestId, { action, ...extra });
    } finally {
      setBusy(false);
    }
  };

  const pickOption = (q: InteractionQuestion, label: string) => {
    setPicks((prev) => {
      if (q.multiSelect) {
        const cur = Array.isArray(prev[q.question]) ? (prev[q.question] as string[]) : [];
        return { ...prev, [q.question]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      }
      return { ...prev, [q.question]: prev[q.question] === label ? label : label };
    });
  };

  const buttonBase = "cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div
      data-testid="interaction-request-card"
      style={{
        position: "fixed",
        bottom: 140,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 260,
        width: isPlan ? "min(680px, 94vw)" : "min(560px, 92vw)",
        background: "var(--bg-panel)",
        border: `1px solid ${isPlan ? "#8b5cf688" : "#3b82f688"}`,
        borderRadius: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        padding: "12px 14px",
        fontFamily: "var(--font-mono)",
      }}
    >
      {/* 标题行 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 14 }}>{isPlan ? "📋" : isAsk ? "❓" : isOpenUrl ? "🔐" : "💬"}</span>
        <strong style={{ fontSize: 13, color: "var(--text)" }}>
          {isPlan ? "方案审批" : isAsk ? "需要你的输入" : isOpenUrl ? "登录授权" : "交互请求"}
        </strong>
        {request.toolName && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--accent)" }}>{request.toolName}</span>
        )}
      </div>

      {request.prompt && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, whiteSpace: "pre-wrap" }}>{request.prompt}</div>
      )}

      {/* plan_approval：方案全文 markdown */}
      {isPlan && request.plan && (
        <div style={{
          maxHeight: "44vh", overflowY: "auto", background: "var(--bg)", borderRadius: 8,
          padding: "10px 12px", marginBottom: 8, border: "1px solid var(--border)",
        }}>
          <MarkdownBody className="markdown-assistant text-[13px]">{request.plan}</MarkdownBody>
        </div>
      )}

      {/* plan 反馈输入（反馈后拒绝 = agent 收到反馈继续修改方案） */}
      {isPlan && planFeedback !== null && (
        <textarea
          autoFocus
          value={planFeedback}
          onChange={(e) => setPlanFeedback(e.target.value)}
          placeholder="告诉 agent 方案哪里需要修改（将作为拒绝理由回给 agent）…"
          rows={3}
          style={{
            width: "100%", marginBottom: 8, borderRadius: 8, border: "1px solid var(--border)",
            background: "var(--bg)", color: "var(--text)", fontSize: 12, padding: "8px 10px", resize: "vertical",
          }}
        />
      )}

      {/* ask_user：问题 + 选项 */}
      {isAsk && questions.map((q, qi) => (
        <div key={`${qi}-${q.question.slice(0, 24)}`} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 6 }}>
            {q.header && <span style={{ color: "var(--text-muted)", marginRight: 6 }}>[{q.header}]</span>}
            {q.question}
            {q.multiSelect && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 6 }}>（多选）</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {q.options.map((opt) => {
              const cur = picks[q.question];
              const selected = Array.isArray(cur) ? cur.includes(opt.label) : cur === opt.label;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => pickOption(q, opt.label)}
                  style={{
                    textAlign: "left", cursor: "pointer", borderRadius: 8, padding: "6px 10px",
                    border: `1px solid ${selected ? "#3b82f6" : "var(--border)"}`,
                    background: selected ? "rgba(59,130,246,0.12)" : "var(--bg)",
                    color: "var(--text)",
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600, marginRight: 8 }}>
                    {selected ? "◉" : q.multiSelect ? "○" : "◯"} {opt.label}
                  </span>
                  {opt.description && (
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{opt.description}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* open_url：登录授权链接（单向卡——打开/复制链接，无需作答） */}
      {isOpenUrl && (openUrlTarget ?? copyUrlTarget) && (
        <div style={{ marginBottom: 8 }}>
          <div style={{
            background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
            padding: "8px 10px", fontSize: 11, color: "var(--text-muted)",
            wordBreak: "break-all", maxHeight: 80, overflowY: "auto",
          }}>
            {openUrlTarget ?? copyUrlTarget}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            点击「打开登录页」在浏览器完成授权，agent 检测到授权后会自动继续；弹窗被拦截时复制链接手动打开。
          </div>
        </div>
      )}

      {/* open_url 无 url/launchUrl 时的原始负载兜底 */}
      {isOpenUrl && !(openUrlTarget ?? copyUrlTarget) && request.input != null && (
        <pre style={{
          maxHeight: 160, overflowY: "auto", fontSize: 11, background: "var(--bg)", borderRadius: 6,
          padding: "6px 8px", margin: "0 0 8px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text-muted)",
        }}>
          {typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2)}
        </pre>
      )}

      {/* generic 兜底：原始 input */}
      {request.kind === "generic" && request.input != null && (
        <pre style={{
          maxHeight: 160, overflowY: "auto", fontSize: 11, background: "var(--bg)", borderRadius: 6,
          padding: "6px 8px", margin: "0 0 8px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text-muted)",
        }}>
          {typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2)}
        </pre>
      )}

      {/* 动作区 */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
        {isPlan && (
          planFeedback === null ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setPlanFeedback("")}
              className={`${buttonBase} border-[#f59e0b66] text-[#f59e0b] hover:bg-[#f59e0b11]`}
            >
              反馈修改意见
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !planFeedback.trim()}
              title={!planFeedback.trim() ? "请填写反馈内容" : "作为拒绝理由回给 agent 继续修改方案"}
              onClick={() => void respond("accept", { message: planFeedback.trim() })}
              className={`${buttonBase} border-[#f59e0b66] text-[#f59e0b] hover:bg-[#f59e0b11]`}
            >
              提交反馈
            </button>
          )
        )}
        {isAsk && (
          <button
            type="button"
            disabled={busy}
            title="拒绝回答（agent 会收到拒绝）"
            onClick={() => void respond("decline")}
            className={`${buttonBase} border-[#ef444466] text-[#ef4444] hover:bg-[#ef444411]`}
          >
            跳过
          </button>
        )}
        {isAsk && (
          <button
            type="button"
            disabled={busy || !allAnswered}
            title={!allAnswered ? "请先完成所有问题的选择" : undefined}
            onClick={() => void respond("accept", { answers: picks })}
            className={`${buttonBase} border-transparent bg-[#22c55e] text-white hover:bg-[#16a34a]`}
          >
            提交回答
          </button>
        )}
        {isPlan && planFeedback === null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void respond("decline")}
            className={`${buttonBase} border-[#ef444466] text-[#ef4444] hover:bg-[#ef444411]`}
          >
            拒绝
          </button>
        )}
        {isPlan && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void respond("accept")}
            className={`${buttonBase} border-transparent bg-[#22c55e] text-white hover:bg-[#16a34a]`}
          >
            批准方案
          </button>
        )}
        {isOpenUrl && (
          <>
            <button
              type="button"
              disabled={busy || !copyUrlTarget}
              title="复制授权链接（优先本机短链，避免长 URL 截断）"
              onClick={() => {
                if (!copyUrlTarget) return;
                void navigator.clipboard?.writeText(copyUrlTarget).catch(() => {});
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
              className={`${buttonBase} border-[var(--border)] text-[var(--text-muted)] hover:bg-[#3b82f611]`}
            >
              {copied ? "已复制 ✓" : "复制链接"}
            </button>
            <button
              type="button"
              disabled={busy}
              title="仅清掉本卡；agent 检测到授权完成会自动继续"
              onClick={() => void respond("accept")}
              className={`${buttonBase} border-[var(--border)] text-[var(--text-muted)] hover:bg-[#3b82f611]`}
            >
              关闭
            </button>
            <button
              type="button"
              disabled={busy || !openUrlTarget}
              title={openUrlTarget ?? undefined}
              onClick={() => openUrlTarget && window.open(openUrlTarget, "_blank", "noopener,noreferrer")}
              className={`${buttonBase} border-transparent bg-[#22c55e] text-white hover:bg-[#16a34a]`}
            >
              打开登录页
            </button>
          </>
        )}
        {request.kind === "generic" && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond("decline")}
              className={`${buttonBase} border-[#ef444466] text-[#ef4444] hover:bg-[#ef444411]`}
            >
              拒绝
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond("accept")}
              className={`${buttonBase} border-transparent bg-[#22c55e] text-white hover:bg-[#16a34a]`}
            >
              接受
            </button>
          </>
        )}
      </div>
    </div>
  );
}
