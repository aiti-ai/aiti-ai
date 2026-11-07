/**
 * InteractionRequestCard —— 交互元语请求卡（自 pi-web core 外迁，aiti-session-cards 接管；
 * 方案 docs/pi-web-agent-capability-ui-ext-plan.md §3.1。原组件 components/InteractionRequestCard.tsx）。
 *
 * 数据源：sessionRequestCard 插槽 extra（request = useAgentSession 派生单状态；respond = 统一作答分派）。
 * 形态按 kind 分：
 *   - interaction:plan_approval：方案审批（zcode ExitPlanMode 适配）——方案全文 markdown + 批准/反馈后拒绝/拒绝。
 *     「带反馈提交」在 zcode 语义里是 deny+reason=反馈 → agent 收到反馈继续修改方案。
 *   - interaction:ask_user：问题询问（zcode AskUserQuestion 适配）——选项按钮（单选/多选）+ 提交/跳过。
 *   - interaction:tool_auth：工具授权（CC 族 can_use_tool 兜底形态，如 EnterPlanMode）——input 摘要 + 拒绝/允许。
 *   - interaction:open_url：OAuth 登录链接（omp login 适配）——打开登录页/复制短链/关闭；单向无需作答。
 *   - interaction:generic：自由形态兜底——prompt + input 摘要 + 接受/拒绝。
 * 红线：正文为空的卡不许裸奔——plan 缺方案正文、tool_auth、generic 一律退到 input 摘要 + 默认作答按钮。
 *
 * 交互事件只有一轮生命周期：后端 resolve/清理/turn 收口广播 interaction_expired，宿主清 sessionRequest。
 */

import { useMemo, useState } from "react";
import { MiniMarkdown } from "./minimarkdown";
import type { SessionRequestCardProps, SessionRequestQuestion } from "./types";

const SUMMARY_KEYS = ["reason", "command", "path", "file_path", "url", "pattern", "query", "description"];

/** agent 工具授权负载 → 人话摘要：已知键逐行挑出，allowedPrompts 单列，其余退 JSON。 */
function askSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) lines.push(`${key}: ${value.trim()}`);
  }
  const prompts = obj.allowedPrompts;
  if (Array.isArray(prompts)) {
    for (const item of prompts) {
      const entry = item as { prompt?: unknown; tool?: unknown };
      if (typeof entry?.prompt !== "string") continue;
      lines.push(`允许命令: ${entry.prompt}${typeof entry.tool === "string" ? `（${entry.tool}）` : ""}`);
    }
  }
  return lines.length ? lines.join("\n") : JSON.stringify(input, null, 2);
}

export default function InteractionRequestCard({ request, respond }: SessionRequestCardProps) {
  const [busy, setBusy] = useState(false);
  const [planFeedback, setPlanFeedback] = useState<string | null>(null);
  /** ask_user 附加说明（可选）——随回答经 respond message → zcode annotations.notes 回给 agent。 */
  const [note, setNote] = useState("");
  /** 每题选中：单选存 label，多选存 label 集合（question 文本为键）。 */
  const [picks, setPicks] = useState<Record<string, string | string[]>>({});
  /** open_url 复制成功的瞬时反馈。 */
  const [copied, setCopied] = useState(false);

  const isPlan = request.kind === "interaction:plan_approval";
  const isAsk = request.kind === "interaction:ask_user";
  const isToolAuth = request.kind === "interaction:tool_auth";
  const isGeneric = request.kind === "interaction:generic";
  const isOpenUrl = request.kind === "interaction:open_url";
  /** 无专属正文的形态（tool_auth/generic，以及 plan 缺方案正文）→ input 摘要兜住，卡不空跑。 */
  const summaryText = askSummary(request.input);
  const showSummary = !!summaryText && (isToolAuth || isGeneric || (isPlan && !request.plan));
  /** 打开登录页用完整 URL；复制优先本机短链（长 OAuth URL 手抄易截断）。 */
  const openUrlTarget = request.url ?? request.launchUrl;
  const copyUrlTarget = request.launchUrl ?? request.url;
  const questions = useMemo(() => request.questions ?? [], [request.questions]);
  /** ask_user 是否已答完所有题（多选至少一项；单选必选其一）。 */
  const allAnswered = questions.length === 0 || questions.every((q) => {
    const v = picks[q.question];
    return Array.isArray(v) ? v.length > 0 : typeof v === "string";
  });

  const respondWith = async (action: "accept" | "decline", extra?: { answers?: Record<string, string | string[]>; message?: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      await respond({ action, ...extra });
    } finally {
      setBusy(false);
    }
  };

  const pickOption = (q: SessionRequestQuestion, label: string) => {
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
      // aiti-float 浮窗契约：装了 aiti-float 即可拖拽/置前/位置持久化（未装时下面样式兜底居中）。
      // 居中必须用 left/right+margin（无 transform）——float 接管 left/top 但不清 transform，
      // translateX(-50%) 会把接管后的面板持续偏移半个宽度。
      // autoh：问题数不定高度随内容；pos=asis：首次浮窗化保持当前渲染位（不跳屏幕中心）。
      data-ext-float="1"
      data-ext-float-key="piweb-interaction-card"
      data-ext-float-autoh="1"
      data-ext-float-pos="asis"
      data-ext-float-full="small"
      style={{
        position: "fixed",
        bottom: 140,
        left: 0,
        right: 0,
        margin: "0 auto",
        zIndex: 260,
        width: isPlan ? "min(680px, 94vw)" : "min(560px, 92vw)",
        maxHeight: "86vh",
        overflowY: "auto",
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
        <span style={{ fontSize: 14 }}>{isPlan ? "📋" : isAsk ? "❓" : (isToolAuth || isOpenUrl) ? "🔐" : "💬"}</span>
        <strong style={{ fontSize: 13, color: "var(--text)" }}>
          {isPlan ? "方案审批" : isAsk ? "需要你的输入" : isToolAuth ? "工具授权" : isOpenUrl ? "登录授权" : "交互请求"}
        </strong>
        {request.toolName && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--accent)" }}>{request.toolName}</span>
        )}
      </div>

      {request.prompt && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, whiteSpace: "pre-wrap" }}>{request.prompt}</div>
      )}

      {/* plan_approval：方案全文 markdown（扩展自带 MiniMarkdown——React 转义，零 HTML 直插） */}
      {isPlan && request.plan && (
        <div style={{
          maxHeight: "44vh", overflowY: "auto", background: "var(--bg)", borderRadius: 8,
          padding: "10px 12px", marginBottom: 8, border: "1px solid var(--border)",
        }}>
          <MiniMarkdown text={request.plan} />
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

      {/* ask_user：问题 + 选项（可滚容器——float 接管后根节点 overflow:hidden，长问卷在此滚动）。
       * 视觉对齐 aiti-user-* 问答面板契约：问题区左强调条 + 高对比、选项全宽 + 数字徽标、主操作绿。 */}
      {isAsk && (
        <div style={{ maxHeight: "44vh", overflowY: "auto" }}>
          {questions.map((q, qi) => (
            <div key={`${qi}-${q.question.slice(0, 24)}`} style={{ marginBottom: 10 }}>
              <div style={{
                fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 6, lineHeight: 1.6,
                whiteSpace: "pre-wrap", wordBreak: "break-word",
                background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                borderLeft: "3px solid var(--accent)", borderRadius: 6, padding: "8px 10px",
              }}>
                {q.header && <span style={{ color: "var(--text-muted)", marginRight: 6 }}>[{q.header}]</span>}
                {q.question}
                {q.multiSelect && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 6 }}>（多选）</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {q.options.map((opt, oi) => {
                  const cur = picks[q.question];
                  const selected = Array.isArray(cur) ? cur.includes(opt.label) : cur === opt.label;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => pickOption(q, opt.label)}
                      style={{
                        display: "flex", alignItems: "center", gap: 8, textAlign: "left", width: "100%",
                        cursor: "pointer", borderRadius: 8, padding: "6px 10px",
                        border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                        background: selected ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg)",
                        color: "var(--text)",
                      }}
                    >
                      <span style={{
                        flex: "0 0 auto", minWidth: 18, height: 18, padding: "0 4px", borderRadius: 5,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        fontSize: 11, fontWeight: 700, boxSizing: "border-box",
                        background: selected ? "var(--accent)" : "color-mix(in srgb, var(--accent) 18%, transparent)",
                        color: selected ? "#fff" : "var(--text-muted)",
                      }}>
                        {oi + 1}
                      </span>
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
        </div>
      )}

      {/* ask_user 附加说明（可选）：补充上下文/自定义回答，经 message → annotations.notes 回给 agent */}
      {isAsk && (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="附加说明（可选）：补充上下文、修正选项含义，或写出选项之外的回答…"
          rows={2}
          style={{
            width: "100%", marginBottom: 8, borderRadius: 8, border: "1px solid var(--border)",
            background: "var(--bg)", color: "var(--text)", fontSize: 12, padding: "7px 10px", resize: "vertical",
          }}
        />
      )}

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

      {/* 无专属正文形态（tool_auth / generic / plan 缺正文）：input 摘要 */}
      {showSummary && (
        <pre style={{
          maxHeight: 160, overflowY: "auto", fontSize: 11, background: "var(--bg)", borderRadius: 6,
          padding: "6px 8px", margin: "0 0 8px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text-muted)",
        }}>
          {summaryText}
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
              className={`${buttonBase} border-[#f59e0b66] text-[var(--warn, #f59e0b)] hover:bg-[#f59e0b11]`}
            >
              反馈修改意见
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !planFeedback.trim()}
              title={!planFeedback.trim() ? "请填写反馈内容" : "作为拒绝理由回给 agent 继续修改方案"}
              onClick={() => void respondWith("accept", { message: planFeedback.trim() })}
              className={`${buttonBase} border-[#f59e0b66] text-[var(--warn, #f59e0b)] hover:bg-[#f59e0b11]`}
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
            onClick={() => void respondWith("decline")}
            className={`${buttonBase} border-[#ef444466] text-[var(--danger, #ef4444)] hover:bg-[#ef444411]`}
          >
            跳过
          </button>
        )}
        {isAsk && (
          <button
            type="button"
            disabled={busy || !allAnswered}
            title={!allAnswered ? "请先完成所有问题的选择" : undefined}
            onClick={() => void respondWith("accept", { answers: picks, message: note.trim() || undefined })}
            className={`${buttonBase} border-transparent bg-[var(--ok, #22c55e)] text-white hover:bg-[#16a34a]`}
          >
            提交回答
          </button>
        )}
        {isToolAuth && (
          <>
            <button
              type="button"
              disabled={busy}
              title="拒绝本次工具调用（agent 收到拒绝理由后继续）"
              onClick={() => void respondWith("decline")}
              className={`${buttonBase} border-[#ef444466] text-[var(--danger, #ef4444)] hover:bg-[#ef444411]`}
            >
              拒绝
            </button>
            <button
              type="button"
              disabled={busy}
              title="允许 agent 执行该工具并继续"
              onClick={() => void respondWith("accept")}
              className={`${buttonBase} border-transparent bg-[var(--ok, #22c55e)] text-white hover:bg-[#16a34a]`}
            >
              允许
            </button>
          </>
        )}
        {isPlan && planFeedback === null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void respondWith("decline")}
            className={`${buttonBase} border-[#ef444466] text-[var(--danger, #ef4444)] hover:bg-[#ef444411]`}
          >
            拒绝
          </button>
        )}
        {isPlan && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void respondWith("accept")}
            className={`${buttonBase} border-transparent bg-[var(--ok, #22c55e)] text-white hover:bg-[#16a34a]`}
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
              onClick={() => void respondWith("accept")}
              className={`${buttonBase} border-[var(--border)] text-[var(--text-muted)] hover:bg-[#3b82f611]`}
            >
              关闭
            </button>
            <button
              type="button"
              disabled={busy || !openUrlTarget}
              title={openUrlTarget ?? undefined}
              onClick={() => openUrlTarget && window.open(openUrlTarget, "_blank", "noopener,noreferrer")}
              className={`${buttonBase} border-transparent bg-[var(--ok, #22c55e)] text-white hover:bg-[#16a34a]`}
            >
              打开登录页
            </button>
          </>
        )}
        {isGeneric && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respondWith("decline")}
              className={`${buttonBase} border-[#ef444466] text-[var(--danger, #ef4444)] hover:bg-[#ef444411]`}
            >
              拒绝
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respondWith("accept")}
              className={`${buttonBase} border-transparent bg-[var(--ok, #22c55e)] text-white hover:bg-[#16a34a]`}
            >
              接受
            </button>
          </>
        )}
      </div>
    </div>
  );
}
