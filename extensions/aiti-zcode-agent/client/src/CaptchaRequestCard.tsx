/**
 * CaptchaRequestCard — start-plan captcha challenge card (zcode plan-channel protocol bridge,
 * migrated out of pi-web core ProviderHeadersRequestCard — the capability owner renders it;
 * plan docs/pi-web-agent-capability-ui-ext-plan.md §3.2, original bridge plan
 * docs/aiti-zcode-startplan-captcha-bridge-plan.md §3.2).
 *
 * Data source: sessionRequestCard slot extra (provider_headers family, kind="provider_headers",
 * registered meta.backend="zcode" — only captcha requests from zcode sessions are claimed here).
 * Three phases:
 *   1. Traceless (traceless_passed, the desktop-normal path): init the official AliyunCaptcha SDK
 *      in a hidden container, captchaVerifyParam flows back automatically → respond
 *      (→ respond_provider_headers command).
 *   2. Interactive (interactive_displayed): the SDK's own slider UI pops up inside the card;
 *      completing it flows back automatically.
 *   3. Failure/cancel: SDK error or user cancel → respond error/decline, the turn ends with a
 *      plain-language message.
 *
 * Compliance: runs the official SDK (o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js)
 * in the user's own browser session, isomorphic to desktop user behavior; no signature forging /
 * parameter replay / automated slider solving.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./host-shim";
import type { SessionRequestCardProps } from "./types";

/** Official SDK script URL (same as desktop; verified against the asar fX constant). */
const CAPTCHA_SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

export interface ProviderHeadersRequestInfo {
  requestId: string;
  providerId: string;
  modelRef?: string;
  reason: "model-request" | "captcha-retry";
  captchaConfig: { sceneId: string; prefix: string; region: string };
}

/** Global init function of the official SDK (appears after the script loads).
 * Note: in the official V3 architecture the success-callback parameter name is `success`
 * (its argument = the captchaVerifyParam string, ready to send back as-is);
 * the legacy `captchaVerifyCallback` alias (object/string dual shape) is also supported.
 */
type InitAliyunCaptcha = (config: {
  SceneId: string;
  prefix: string;
  region: string;
  mode: "popup";
  element: string;
  button: string;
  success: (captchaVerifyParam: string) => void;
  captchaVerifyCallback: (param: unknown) => void;
  fail: () => void;
  onError: (err: unknown) => void;
  getInstance: (instance: { destroy?: () => void }) => void;
}) => void;

/** Extract captchaVerifyParam from an SDK callback (official success passes a string; object shape
 * falls back across case variants of the field name). */
function extractCaptchaParam(p: unknown): string {
  if (typeof p === "string") return p.trim();
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    const v = o.captchaVerifyParam ?? o.CaptchaVerifyParam ?? o.verifyParam;
    return typeof v === "string" ? v.trim() : "";
  }
  return "";
}

/** Mount the SDK script (singleton; writes the global AliyunCaptchaConfig before loading —
 * the V3 architecture requires region/prefix to be set before the script executes). */
function loadCaptchaSdk(region: string, prefix: string): Promise<InitAliyunCaptcha> {
  const w = window as unknown as {
    initAliyunCaptcha?: InitAliyunCaptcha;
    AliyunCaptchaConfig?: { region: string; prefix: string };
    __piCaptchaSdkPromise?: Promise<InitAliyunCaptcha>;
  };
  if (w.initAliyunCaptcha) return Promise.resolve(w.initAliyunCaptcha);
  if (w.__piCaptchaSdkPromise) return w.__piCaptchaSdkPromise;
  // V3 architecture: identity token/region must be written to globals BEFORE the script
  // (refreshed on every call so config changes take effect)
  w.AliyunCaptchaConfig = { region, prefix };
  w.__piCaptchaSdkPromise = new Promise<InitAliyunCaptcha>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CAPTCHA_SDK_URL}"]`);
    const el = existing ?? document.createElement("script");
    const done = () => {
      if (w.initAliyunCaptcha) resolve(w.initAliyunCaptcha);
      else reject(new Error(t("zc.captcha.err.initMissing")));
    };
    el.addEventListener("load", done, { once: true });
    el.addEventListener("error", () => reject(new Error(t("zc.captcha.err.loadFailed"))), { once: true });
    if (!existing) {
      el.src = CAPTCHA_SDK_URL;
      document.head.appendChild(el);
    }
  });
  return w.__piCaptchaSdkPromise;
}

export default function CaptchaRequestCard({ request, respond }: SessionRequestCardProps) {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"init" | "interactive" | "error">("init");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const answeredRef = useRef(false);
  const instanceRef = useRef<{ destroy?: () => void } | null>(null);

  const req = request as unknown as ProviderHeadersRequestInfo;

  const answer = useCallback(async (payload: { captchaVerifyParam?: string; region?: string; error?: string; cancel?: boolean }) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    setBusy(true);
    try {
      if (payload.error) await respond({ action: "decline", error: payload.error });
      else if (payload.cancel) await respond({ action: "decline" });
      else await respond({ action: "accept", captchaVerifyParam: payload.captchaVerifyParam, region: payload.region });
    } finally {
      setBusy(false);
    }
  }, [respond]);

  useEffect(() => {
    let cancelled = false;
    setPhase("init");
    setErrorText(null);
    answeredRef.current = false;
    loadCaptchaSdk(req.captchaConfig.region, req.captchaConfig.prefix)
      .then((init) => {
        if (cancelled) return;
        instanceRef.current?.destroy?.();
        init({
          SceneId: req.captchaConfig.sceneId,
          prefix: req.captchaConfig.prefix,
          region: req.captchaConfig.region,
          mode: "popup",
          // SDK popup anchors: hidden button + the card's content container (in interactive
          // phase the SDK pops its own slider over the element)
          element: "#pi-captcha-element",
          button: "#pi-captcha-button",
          // Official success callback receives the captchaVerifyParam string directly (V3); send it back
          success: (captchaVerifyParam) => {
            const param = (captchaVerifyParam ?? "").trim();
            if (!cancelled) void answer({ captchaVerifyParam: param, region: req.captchaConfig.region });
          },
          // Legacy captchaVerifyCallback alias (object/string dual shape)
          captchaVerifyCallback: (p) => {
            const param = extractCaptchaParam(p);
            if (!cancelled) void answer({ captchaVerifyParam: param, region: req.captchaConfig.region });
          },
          // Verification not passed: the SDK refreshes and retries automatically (official
          // semantics) — do not interrupt the flow, just log it
          fail: () => {
            console.info("[aiti-zcode-agent] captcha not passed; SDK refreshes and retries automatically");
          },
          onError: (err) => {
            if (cancelled) return;
            setPhase("error");
            setErrorText(err instanceof Error ? err.message : String(err));
          },
          getInstance: (instance) => {
            instanceRef.current = instance;
            // popup mode starts the verification flow on button click: trigger it
            // programmatically once — traceless (smart verification) returns the
            // captchaVerifyParam automatically; only high-risk cases pop the slider
            // (solved by the human user; never answered programmatically here).
            setTimeout(() => {
              document.getElementById("pi-captcha-button")?.click();
            }, 50);
          },
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setPhase("error");
        setErrorText(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      try { instanceRef.current?.destroy?.(); } catch { /* already destroyed */ }
      instanceRef.current = null;
    };
  }, [req.requestId, req.captchaConfig.sceneId, req.captchaConfig.prefix, req.captchaConfig.region, answer, retryNonce]);

  return (
    <div
      data-testid="provider-headers-request-card"
      style={{
        position: "fixed",
        bottom: 140,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 260,
        width: "min(560px, 92vw)",
        background: "var(--bg-panel)",
        border: "1px solid #f59e0b88",
        borderRadius: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
        padding: "12px 14px",
        fontFamily: "var(--font-mono)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ display: "flex", color: "var(--warn, #fbbf24)" }}><svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
        <strong style={{ fontSize: 13, color: "var(--text)" }}>{t("zc.captcha.title")}</strong>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}>
          {req.reason === "captcha-retry" ? t("zc.captcha.reason.retry") : t("zc.captcha.reason.modelRequest")}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
        {phase === "error"
          ? t("zc.captcha.msg.loadFailed")
          : phase === "interactive"
            ? t("zc.captcha.msg.interactive")
            : t("zc.captcha.msg.verifying")}
      </div>
      {/* Official SDK mount point: invisible when traceless; in interactive phase the SDK pops the slider inside the element */}
      <div id="pi-captcha-element" style={{ minHeight: phase === "interactive" ? 80 : 0 }} />
      <button id="pi-captcha-button" type="button" style={{ display: "none" }} />
      {errorText && (
        <div style={{ fontSize: 11, color: "#dc2626", marginBottom: 8 }}>{errorText}</div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {phase === "error" && (
          <button
            type="button"
            data-testid="provider-headers-retry"
            onClick={() => setRetryNonce((n) => n + 1)}
            style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}
          >
            {t("zc.captcha.retry")}
          </button>
        )}
      </div>
      {busy && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>{t("zc.captcha.msg.responding")}</div>}
    </div>
  );
}
