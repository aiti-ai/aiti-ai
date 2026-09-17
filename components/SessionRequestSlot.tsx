"use client";

/**
 * SessionRequestSlot —— 会话请求卡接管缝（agent 能力 UI 去核化，方案
 * docs/pi-web-agent-capability-ui-ext-plan.md §2.1）。
 *
 * 职责仅两件事，能力 UI 本体在扩展：
 *   1. 路由：useExtSlotItems("sessionRequestCard") 按 meta.kinds/backend/priority 选唯一接管 item，
 *      经 <ExtSlot only> 渲染（aiti-session-cards：interaction:* + permission；aiti-zcode-agent
 *      client：provider_headers）；
 *   2. 兜底：无接管者时渲染极简卡（标题 + 摘要 + 最小作答），保证 respondInteraction/
 *      respondPermission/respondProviderHeaders 三 capability 永不裸奔——扩展缺失/禁用/路由
 *      未命中都落到这里（fail-open 到 core，不 fail-blank）。
 *
 * 数据源：useAgentSession 的 sessionRequest（三协议事件家族派生单状态）+ respondToSessionRequest
 * （统一作答分派）。协议（事件名/命令名/SessionHandle）不在本文件——core 只做状态与分派。
 */

import { useMemo } from "react";
import type { ReactNode } from "react";
import { ExtSlot, useExtSlotItems } from "./ExtSlots";
import { MarkdownBody } from "./MarkdownBody";
import type { SessionRequestAnswer, SessionRequestCardSlotProps, SessionRequestPayload } from "@/lib/ext/types";
import { hasExtRender, type ExtUiItemRegistered } from "@/lib/ext-ui-store";

/** 路由：meta.kinds ∋ request.kind 且 backend 匹配（未声明/* 通配）的条目中取 priority 最高者。 */
export function pickSessionRequestCard(
  items: ExtUiItemRegistered[],
  request: Pick<SessionRequestPayload, "kind">,
  backendSource?: string,
): ExtUiItemRegistered | null {
  let winner: ExtUiItemRegistered | null = null;
  let winnerPriority = -Infinity;
  for (const it of items) {
    // 无 render 的（声明式）条目不参与：ExtSlot 会把它过滤掉，若被选为 winner 会「命中即空白」
    // 且兜底卡被跳过——这里对齐 ExtSlot 的 hasExtRender 过滤，保证 fail-open 落兜底。
    if (!hasExtRender(it)) continue;
    const kinds = it.meta?.kinds;
    if (!Array.isArray(kinds) || !kinds.includes(request.kind)) continue;
    const backend = it.meta?.backend;
    if (backend !== undefined && backend !== "*" && backend !== backendSource) continue;
    const priority = typeof it.meta?.priority === "number" ? it.meta.priority : 0;
    if (!winner || priority > winnerPriority) {
      winner = it;
      winnerPriority = priority;
    }
  }
  return winner;
}

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

function permissionOptionLabel(o: { kind?: string; name?: string }): string {
  if (o.name) return o.name;
  const map: Record<string, string> = {
    allow_once: "本次允许", allow_always: "总是允许",
    reject_once: "本次拒绝", reject_always: "总是拒绝",
  };
  return map[String(o.kind ?? "")] ?? String(o.kind ?? "选择");
}

const buttonBase = "cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = `${buttonBase} border-transparent bg-[#22c55e] text-white hover:bg-[#16a34a]`;
const dangerButton = `${buttonBase} border-[#ef444466] text-[#ef4444] hover:bg-[#ef444411]`;
const neutralButton = `${buttonBase} border-[var(--border)] text-[var(--text-muted)] hover:bg-[#3b82f611]`;

function CardShell({ children, width, borderColor, testId, floatKey }: { children: ReactNode; width: string; borderColor: string; testId: string; floatKey?: string }) {
  return (
    <div
      data-testid={testId}
      // aiti-float 浮窗契约（方案 §2.1「兜底卡与扩展现有卡继续走 data-ext-float」）：interaction
      // 家族给 key（与扩展内同 key——拖拽位置跨 ext/兜底延续）；permission/provider_headers
      // 原 core 卡无浮窗契约，保持无属性。未装 aiti-float 时下面的 fixed 样式兜底居中。
      data-ext-float={floatKey ? "1" : undefined}
      data-ext-float-key={floatKey}
      data-ext-float-autoh={floatKey ? "1" : undefined}
      data-ext-float-pos={floatKey ? "asis" : undefined}
      data-ext-float-full={floatKey ? "small" : undefined}
      style={{
        position: "fixed", bottom: 140, left: 0, right: 0, margin: "0 auto", zIndex: 260,
        width, maxHeight: "86vh", overflowY: "auto",
        background: "var(--bg-panel)", border: `1px solid ${borderColor}`,
        borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        padding: "12px 14px", fontFamily: "var(--font-mono)",
      }}
    >
      {children}
    </div>
  );
}

function CardHeader({ icon, title, meta, toolName }: { icon: string; title: string; meta?: string; toolName?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 14 }}>{icon}</span>
      <strong style={{ fontSize: 13, color: "var(--text)" }}>{title}</strong>
      {meta && <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}>{meta}</span>}
      {toolName && <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--accent)" }}>{toolName}</span>}
    </div>
  );
}

const preStyle = {
  maxHeight: 140, overflowY: "auto", fontSize: 11, background: "var(--bg)", borderRadius: 6,
  padding: "6px 8px", margin: "0 0 8px", whiteSpace: "pre-wrap", wordBreak: "break-all",
  color: "var(--text-muted)",
} as const;

/** 极简兜底卡（扩展缺席时的应急 UI）：每家族只保标题 + 摘要 + 最小作答动作；
 *  完整交互（方案反馈/问题选项/验证码）在扩展卡里。onRespond = 插槽 respond（单参；requestId 由宿主持有）。 */
export function MinimalRequestCard({ request, onRespond }: {
  request: SessionRequestPayload;
  onRespond: (answer: SessionRequestAnswer) => Promise<boolean>;
}) {
  const isPlan = request.kind === "interaction:plan_approval";
  const isAsk = request.kind === "interaction:ask_user";
  const isOpenUrl = request.kind === "interaction:open_url";
  const openUrlTarget = request.url ?? request.launchUrl;
  const copyUrlTarget = request.launchUrl ?? request.url;

  if (request.family === "permission") {
    const summary = permissionInputSummary(request.input);
    const options = request.options?.length ? request.options : null;
    return (
      <CardShell width="min(480px, 92vw)" borderColor="#f59e0b88" testId="session-request-fallback-card">
        <CardHeader icon="🔐" title="工具授权请求" toolName={request.toolName} />
        {summary && (
          <div style={{ fontSize: 12, color: "var(--text)", background: "var(--bg)", borderRadius: 6, padding: "6px 8px", margin: "0 0 6px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{summary}</div>
        )}
        {request.input != null && (
          <pre style={preStyle}>{typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2)}</pre>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {options
            ? options.map((o) => {
              const deny = String(o.kind ?? "").startsWith("reject");
              return (
                <button key={String(o.optionId ?? o.kind ?? o.name)} type="button"
                  className={deny ? dangerButton : primaryButton}
                  onClick={() => void onRespond({ action: deny ? "decline" : "accept", optionId: o.optionId })}>
                  {permissionOptionLabel(o)}
                </button>
              );
            })
            : (<>
              <button type="button" className={dangerButton} onClick={() => void onRespond({ action: "decline" })}>拒绝</button>
              <button type="button" className={primaryButton} onClick={() => void onRespond({ action: "accept" })}>允许</button>
            </>)}
        </div>
      </CardShell>
    );
  }

  if (request.family === "provider_headers") {
    // 验证码无法兜底（要跑官方 SDK）：给「取消」收口轮次，正卡在 aiti-zcode-agent client。
    return (
      <CardShell width="min(480px, 92vw)" borderColor="#f59e0b88" testId="session-request-fallback-card">
        <CardHeader icon="🔐" title="套餐通道安全验证" meta={request.reason === "captcha-retry" ? "重试验证" : "模型请求"} />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
          需要验证码组件（zcode 扩展 client 未加载）。可取消本轮，或在扩展管理启用 aiti-zcode-agent 后重试。
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className={neutralButton} onClick={() => void onRespond({ action: "decline" })}>取消本轮</button>
        </div>
      </CardShell>
    );
  }

  // interaction 家族（plan_approval / ask_user / open_url / generic）
  return (
    <CardShell width={isPlan ? "min(680px, 94vw)" : "min(560px, 92vw)"} borderColor={isPlan ? "#8b5cf688" : "#3b82f688"} testId="session-request-fallback-card" floatKey="piweb-interaction-card">
      <CardHeader icon={isPlan ? "📋" : isAsk ? "❓" : isOpenUrl ? "🔐" : "💬"}
        title={isPlan ? "方案审批" : isAsk ? "需要你的输入" : isOpenUrl ? "登录授权" : "交互请求"}
        toolName={request.toolName} />
      {request.prompt && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, whiteSpace: "pre-wrap" }}>{request.prompt}</div>
      )}
      {isPlan && request.plan && (
        <div style={{ maxHeight: "44vh", overflowY: "auto", background: "var(--bg)", borderRadius: 8, padding: "10px 12px", marginBottom: 8, border: "1px solid var(--border)" }}>
          <MarkdownBody className="markdown-assistant text-[13px]">{request.plan}</MarkdownBody>
        </div>
      )}
      {isAsk && request.questions && request.questions.length > 0 && (
        <div style={{ maxHeight: "30vh", overflowY: "auto", marginBottom: 8 }}>
          {request.questions.map((q, qi) => (
            <div key={`${qi}-${q.question.slice(0, 24)}`} style={{ fontSize: 12, color: "var(--text)", marginBottom: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {q.header && <span style={{ color: "var(--text-muted)", marginRight: 6 }}>[{q.header}]</span>}
              {q.question}
              {q.options.length > 0 && (
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                  选项：{q.options.map((o) => o.label).join(" / ")}（完整选项交互请启用 aiti-session-cards 扩展）
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {isOpenUrl && (openUrlTarget ?? copyUrlTarget) && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all", maxHeight: 80, overflowY: "auto" }}>
            {openUrlTarget ?? copyUrlTarget}
          </div>
        </div>
      )}
      {request.kind === "interaction:generic" && request.input != null && (
        <pre style={preStyle}>{typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2)}</pre>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {isOpenUrl && (
          <>
            <button type="button" className={neutralButton}
              onClick={() => { void navigator.clipboard?.writeText(copyUrlTarget ?? "").catch(() => {}); }}>
              复制链接
            </button>
            <button type="button" className={neutralButton} onClick={() => void onRespond({ action: "accept" })}>关闭</button>
            <button type="button" className={primaryButton} disabled={!openUrlTarget}
              onClick={() => openUrlTarget && window.open(openUrlTarget, "_blank", "noopener,noreferrer")}>
              打开登录页
            </button>
          </>
        )}
        {isPlan && (<>
          <button type="button" className={dangerButton} onClick={() => void onRespond({ action: "decline" })}>拒绝</button>
          <button type="button" className={primaryButton} onClick={() => void onRespond({ action: "accept" })}>批准方案</button>
        </>)}
        {isAsk && (<>
          <button type="button" className={dangerButton} onClick={() => void onRespond({ action: "decline" })}>跳过</button>
          <button type="button" className={primaryButton} onClick={() => void onRespond({ action: "accept" })}>提交</button>
        </>)}
        {request.kind === "interaction:generic" && (<>
          <button type="button" className={dangerButton} onClick={() => void onRespond({ action: "decline" })}>拒绝</button>
          <button type="button" className={primaryButton} onClick={() => void onRespond({ action: "accept" })}>接受</button>
        </>)}
      </div>
    </CardShell>
  );
}

/** 接缝宿主组件：扩展路由优先，未命中落兜底卡。ChatWindow 单点挂载。 */
export function SessionRequestCardHost({ request, respond, backendSource, currentSession }: SessionRequestCardSlotProps) {
  const items = useExtSlotItems("sessionRequestCard");
  const winner = useMemo(
    () => (request ? pickSessionRequestCard(items, request, backendSource) : null),
    [items, request, backendSource],
  );
  if (!request) return null;
  if (winner) {
    return (
      <ExtSlot
        name="sessionRequestCard"
        currentSession={currentSession}
        only={winner.id}
        extra={{ request, respond, backendSource }}
      />
    );
  }
  return <MinimalRequestCard request={request} onRespond={respond} />;
}
