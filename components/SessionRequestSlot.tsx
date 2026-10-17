"use client";

/**
 * SessionRequestSlot — the session request card takeover seam (agent capability UI moved out of
 * core to extensions; see the agent-capability-UI extension plan doc §2.1).
 *
 * Two responsibilities only; the capability UI itself lives in extensions:
 *   1. Routing: useExtSlotItems("sessionRequestCard") picks the single takeover item by
 *      meta.kinds/backend/priority, rendered via <ExtSlot only> (the session-cards extension:
 *      interaction:* + permission; the zcode-agent extension client: provider_headers);
 *   2. Fallback: with no taker, render a minimal card (title + summary + minimal answering) so
 *      the respondInteraction/respondPermission/respondProviderHeaders capabilities are never
 *      left bare — missing/disabled extensions and routing misses all land here (fail-open to
 *      core, not fail-blank).
 *
 * Data sources: useAgentSession's sessionRequest (a single state derived from the three
 * protocol event families) + respondToSessionRequest (unified answer dispatch). The protocol
 * (event names/command names/SessionHandle) is not in this file — core only does state and
 * dispatch.
 */

import { useMemo } from "react";
import type { ReactNode } from "react";
import { ExtSlot, useExtSlotItems } from "./ExtSlots";
import { MarkdownBody } from "./MarkdownBody";
import { useI18n } from "@/hooks/useI18n";
import type { SessionRequestAnswer, SessionRequestCardSlotProps, SessionRequestPayload } from "@/lib/ext/types";
import { hasExtRender, type ExtUiItemRegistered } from "@/lib/ext-ui-store";

type Translate = ReturnType<typeof useI18n>["t"];

/** Routing: among entries whose meta.kinds contains request.kind and whose backend matches (undeclared or /* wildcard), take the highest priority. */
export function pickSessionRequestCard(
  items: ExtUiItemRegistered[],
  request: Pick<SessionRequestPayload, "kind">,
  backendSource?: string,
): ExtUiItemRegistered | null {
  let winner: ExtUiItemRegistered | null = null;
  let winnerPriority = -Infinity;
  for (const it of items) {
    // Entries without a render (declarative) don't participate: ExtSlot filters them out, so if
    // one were picked as winner the result would be "matched but blank" and the fallback card
    // would be skipped — mirror ExtSlot's hasExtRender filter here to guarantee fail-open to the
    // fallback.
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

/** One-line human summary of an ask payload (shared by the permission card and the body-less
 *  interaction shapes). Returns "" when nothing matches — callers fall back to raw JSON. */
function askInputSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    const rec = input as Record<string, unknown>;
    const parts = ["reason", "command", "path", "file_path", "url", "pattern", "query", "description"]
      .filter((k) => typeof rec[k] === "string" && rec[k])
      .map((k) => `${k}: ${String(rec[k])}`);
    return parts.join("  ");
  } catch {
    return "";
  }
}

function permissionOptionLabel(o: { kind?: string; name?: string }, t: Translate): string {
  if (o.name) return o.name;
  const map: Record<string, string> = {
    allow_once: "sessionReq.allowOnce", allow_always: "sessionReq.allowAlways",
    reject_once: "sessionReq.rejectOnce", reject_always: "sessionReq.rejectAlways",
  };
  const key = map[String(o.kind ?? "")];
  return key ? t(key) : String(o.kind ?? t("sessionReq.select"));
}

const buttonBase = "cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = `${buttonBase} border-transparent bg-[#22c55e] text-white hover:bg-[#16a34a]`;
const dangerButton = `${buttonBase} border-[#ef444466] text-[#ef4444] hover:bg-[#ef444411]`;
const neutralButton = `${buttonBase} border-[var(--border)] text-[var(--text-muted)] hover:bg-[#3b82f611]`;

function CardShell({ children, width, borderColor, testId, floatKey }: { children: ReactNode; width: string; borderColor: string; testId: string; floatKey?: string }) {
  return (
    <div
      data-testid={testId}
      // Floating-dialog extension contract (plan §2.1: "the fallback card and the extensions'
      // existing cards keep using data-ext-float"): the interaction family gets a key (the same
      // key as inside the extension — the drag position persists across ext/fallback); the
      // original core permission/provider_headers cards had no floating contract and stay
      // attribute-less. Without the floating-dialog extension installed, the fixed style below
      // centers as a fallback.
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

/** Minimal fallback card (emergency UI when extensions are absent): each family keeps only
 *  title + summary + minimal answering actions; full interactions (plan feedback/question
 *  options/captcha) live in the extension cards. onRespond = the slot's respond (single arg;
 *  the requestId is held by the host). */
export function MinimalRequestCard({ request, onRespond }: {
  request: SessionRequestPayload;
  onRespond: (answer: SessionRequestAnswer) => Promise<boolean>;
}) {
  const isPlan = request.kind === "interaction:plan_approval";
  const isAsk = request.kind === "interaction:ask_user";
  const isToolAuth = request.kind === "interaction:tool_auth";
  const isGeneric = request.kind === "interaction:generic";
  const isOpenUrl = request.kind === "interaction:open_url";
  /** 无专属正文的形态（tool_auth/generic/plan 缺方案正文）→ input 摘要兜底，卡不空跑。 */
  const showSummary = isToolAuth || isGeneric || (isPlan && !request.plan);
  /** 没有专属作答动作的形态，一律给默认 拒绝/允许——挂起的 ask 不能没有出口。 */
  const defaultActions = isToolAuth || isGeneric;
  const openUrlTarget = request.url ?? request.launchUrl;
  const copyUrlTarget = request.launchUrl ?? request.url;
  const { t } = useI18n();

  if (request.family === "permission") {
    const summary = askInputSummary(request.input);
    const options = request.options?.length ? request.options : null;
    return (
      <CardShell width="min(480px, 92vw)" borderColor="#f59e0b88" testId="session-request-fallback-card">
        <CardHeader icon="🔐" title={t("sessionReq.toolAuth")} toolName={request.toolName} />
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
                  {permissionOptionLabel(o, t)}
                </button>
              );
            })
            : (<>
              <button type="button" className={dangerButton} onClick={() => void onRespond({ action: "decline" })}>{t("sessionReq.deny")}</button>
              <button type="button" className={primaryButton} onClick={() => void onRespond({ action: "accept" })}>{t("sessionReq.allow")}</button>
            </>)}
        </div>
      </CardShell>
    );
  }

  if (request.family === "provider_headers") {
    // Captcha can't be handled by the fallback (it needs the official SDK): offer "Cancel" to
    // close out the turn; the full card lives in the zcode-agent extension client.
    return (
      <CardShell width="min(480px, 92vw)" borderColor="#f59e0b88" testId="session-request-fallback-card">
        <CardHeader icon="🔐" title={t("sessionReq.providerVerify")} meta={request.reason === "captcha-retry" ? t("sessionReq.retryVerify") : t("sessionReq.modelRequest")} />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
          {t("sessionReq.captchaRequired")}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className={neutralButton} onClick={() => void onRespond({ action: "decline" })}>{t("sessionReq.cancelTurn")}</button>
        </div>
      </CardShell>
    );
  }

  // interaction family (plan_approval / ask_user / tool_auth / open_url / generic)
  return (
    <CardShell width={isPlan ? "min(680px, 94vw)" : "min(560px, 92vw)"} borderColor={isPlan ? "#8b5cf688" : "#3b82f688"} testId="session-request-fallback-card" floatKey="piweb-interaction-card">
      <CardHeader icon={isPlan ? "📋" : isAsk ? "❓" : (isToolAuth || isOpenUrl) ? "🔐" : "💬"}
        title={isPlan ? t("sessionReq.planApproval") : isAsk ? t("sessionReq.needInput") : isToolAuth ? t("sessionReq.toolAuth") : isOpenUrl ? t("sessionReq.loginAuth") : t("sessionReq.interaction")}
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
                  {t("sessionReq.options", { options: q.options.map((o) => o.label).join(" / ") })}
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
      {showSummary && request.input != null && (
        <pre style={preStyle}>{askInputSummary(request.input) || JSON.stringify(request.input, null, 2)}</pre>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {isOpenUrl && (
          <>
            <button type="button" className={neutralButton}
              onClick={() => { void navigator.clipboard?.writeText(copyUrlTarget ?? "").catch(() => {}); }}>
              {t("sessionReq.copyLink")}
            </button>
            <button type="button" className={neutralButton} onClick={() => void onRespond({ action: "accept" })}>{t("sessionReq.close")}</button>
            <button type="button" className={primaryButton} disabled={!openUrlTarget}
              onClick={() => openUrlTarget && window.open(openUrlTarget, "_blank", "noopener,noreferrer")}>
              {t("sessionReq.openLoginPage")}
            </button>
          </>
        )}
        {isPlan && (<>
          <button type="button" className={dangerButton} onClick={() => void onRespond({ action: "decline" })}>{t("sessionReq.deny")}</button>
          <button type="button" className={primaryButton} onClick={() => void onRespond({ action: "accept" })}>{t("sessionReq.approvePlan")}</button>
        </>)}
        {isAsk && (<>
          <button type="button" className={dangerButton} onClick={() => void onRespond({ action: "decline" })}>{t("sessionReq.skip")}</button>
          <button type="button" className={primaryButton} onClick={() => void onRespond({ action: "accept" })}>{t("sessionReq.submit")}</button>
        </>)}
        {defaultActions && (<>
          <button type="button" className={dangerButton} onClick={() => void onRespond({ action: "decline" })}>{t("sessionReq.deny")}</button>
          <button type="button" className={primaryButton} onClick={() => void onRespond({ action: "accept" })}>
            {isToolAuth ? t("sessionReq.allow") : t("sessionReq.accept")}
          </button>
        </>)}
      </div>
    </CardShell>
  );
}

/** Seam host component: extension routing first, falling back to the minimal card on a miss. Mounted at a single point in ChatWindow. */
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
