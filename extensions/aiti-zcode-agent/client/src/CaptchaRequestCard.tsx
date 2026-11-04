/**
 * CaptchaRequestCard —— start-plan 验证码求解卡（zcode 套餐通道协议桥，自 pi-web core
 * ProviderHeadersRequestCard 外迁——谁的能力谁渲染；方案
 * docs/pi-web-agent-capability-ui-ext-plan.md §3.2，协议桥原方案 docs/aiti-zcode-startplan-captcha-bridge-plan.md §3.2）。
 *
 * 数据源：sessionRequestCard 插槽 extra（provider_headers 家族，kind="provider_headers"、
 * 注册 meta.backend="zcode"——只有 zcode 会话的验证码请求由本卡认领）。
 * 三态：
 *   1. 无感（traceless_passed，桌面同款常态）：隐藏容器 init 官方 AliyunCaptcha SDK，
 *      captchaVerifyParam 自动回传 → respond（→ respond_provider_headers 命令）。
 *   2. 交互（interactive_displayed）：SDK 自带滑块 UI 在卡片内弹出，用户完成后自动回传。
 *   3. 失败/取消：SDK 报错或用户取消 → respond error/decline，轮次人话收口。
 *
 * 合规：跑的是官方 SDK（o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js）、
 * 用户自己的浏览器会话，与桌面端用户行为同构；无签名伪造/参数重放/自动化滑块。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionRequestCardProps } from "./types";

/** 官方 SDK 脚本地址（桌面端同款，asar 实证 fX 常量）。 */
const CAPTCHA_SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

export interface ProviderHeadersRequestInfo {
  requestId: string;
  providerId: string;
  modelRef?: string;
  reason: "model-request" | "captcha-retry";
  captchaConfig: { sceneId: string; prefix: string; region: string };
}

/** 官方 SDK 的全局 init 函数（脚本加载后出现）。
 * 注意：官方 V3 架构验证通过回调参数名是 `success`（入参 = captchaVerifyParam 字符串，可直接回传）；
 * 另兼容历史 `captchaVerifyCallback` 别名（对象/字符串双形态）。
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

/** 从 SDK 回调提取 captchaVerifyParam（官方 success 直传字符串；对象形态兜底兼容大小写字段）。 */
function extractCaptchaParam(p: unknown): string {
  if (typeof p === "string") return p.trim();
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    const v = o.captchaVerifyParam ?? o.CaptchaVerifyParam ?? o.verifyParam;
    return typeof v === "string" ? v.trim() : "";
  }
  return "";
}

/** 挂载 SDK 脚本（单例；加载前先写全局 AliyunCaptchaConfig，V3 架构要求先于脚本设置 region/prefix）。 */
function loadCaptchaSdk(region: string, prefix: string): Promise<InitAliyunCaptcha> {
  const w = window as unknown as {
    initAliyunCaptcha?: InitAliyunCaptcha;
    AliyunCaptchaConfig?: { region: string; prefix: string };
    __piCaptchaSdkPromise?: Promise<InitAliyunCaptcha>;
  };
  if (w.initAliyunCaptcha) return Promise.resolve(w.initAliyunCaptcha);
  if (w.__piCaptchaSdkPromise) return w.__piCaptchaSdkPromise;
  // V3 架构：身份标/region 必须以全局变量形式先于脚本写入（每次调用都刷新，防 config 变化不生效）
  w.AliyunCaptchaConfig = { region, prefix };
  w.__piCaptchaSdkPromise = new Promise<InitAliyunCaptcha>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CAPTCHA_SDK_URL}"]`);
    const el = existing ?? document.createElement("script");
    const done = () => {
      if (w.initAliyunCaptcha) resolve(w.initAliyunCaptcha);
      else reject(new Error("AliyunCaptcha.js 加载完成但 initAliyunCaptcha 缺失"));
    };
    el.addEventListener("load", done, { once: true });
    el.addEventListener("error", () => reject(new Error("AliyunCaptcha.js 加载失败（网络不可达 o.alicdn.com）")), { once: true });
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
          // SDK 弹层锚点：隐藏按钮 + 卡片内容器（interactive 时 SDK 自己弹 popup）
          element: "#pi-captcha-element",
          button: "#pi-captcha-button",
          // 官方 success 回调入参即 captchaVerifyParam 字符串（V3 架构）；直接回传
          success: (captchaVerifyParam) => {
            const param = (captchaVerifyParam ?? "").trim();
            if (!cancelled) void answer({ captchaVerifyParam: param, region: req.captchaConfig.region });
          },
          // 兼容历史 captchaVerifyCallback 别名（对象/字符串双形态）
          captchaVerifyCallback: (p) => {
            const param = extractCaptchaParam(p);
            if (!cancelled) void answer({ captchaVerifyParam: param, region: req.captchaConfig.region });
          },
          // 验证不通过：SDK 会自动刷新重试（官方语义），不打断流程，只留日志
          fail: () => {
            console.info("[aiti-zcode-agent] 安全验证未通过，SDK 自动刷新重试");
          },
          onError: (err) => {
            if (cancelled) return;
            setPhase("error");
            setErrorText(err instanceof Error ? err.message : String(err));
          },
          getInstance: (instance) => {
            instanceRef.current = instance;
            // popup 模式由按钮点击触发验证流：程序化触发一次——无感（智能验证）即自动回传
            // captchaVerifyParam；高风险才弹滑块（滑块由真人完成，此处不代答）。
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
      try { instanceRef.current?.destroy?.(); } catch { /* 已销毁 */ }
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
        <span style={{ fontSize: 14 }}>🔐</span>
        <strong style={{ fontSize: 13, color: "var(--text)" }}>套餐通道安全验证</strong>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}>
          {req.reason === "captcha-retry" ? "重试验证" : "模型请求"}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
        {phase === "error"
          ? "验证组件加载失败，可重试。"
          : phase === "interactive"
            ? "请在下方完成安全验证（通常为滑块）。"
            : "正在建立安全验证（通常无感通过，请稍候）…"}
      </div>
      {/* 官方 SDK 挂载点：无感时不可见；interactive 时 SDK 在 element 容器弹滑块 */}
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
            重试
          </button>
        )}
      </div>
      {busy && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>正在回传验证结果…</div>}
    </div>
  );
}
