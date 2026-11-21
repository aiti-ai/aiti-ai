/**
 * aiti-model-wizard · 模型添加开机向导（🧙）—— JSX 版（自手写 h() 版迁移，功能一比一）
 *
 * 功能：
 *   - 添加：搜索（中/英/别名/模型id）→ 提供商详情（api 地址/注册说明/领 token 链接）→ 填 token → 测试（2xx/429 通过）→ 选/输模型 → 写 models.json
 *   - 自定义：贴 baseUrl → 反向匹配 / 自动探测（用户漏 v1/v2 也能补）→ 同凭据/测试/选模型/保存
 *   - 已配置：列出 providers（token 打码）→ 改 token（留空保留）/ 删除
 *   - 无模型时顶部 banner 引导
 * 架构：toolbar 🧙 按钮 → 独立置顶 dialog（pages slot）+ banners
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { apiUrl, extSvc, regSvc, getCtx, t as ti, srvFix } from "./host-shim";
import { uiConfirm } from "../../../_shared/ui-dialogs";
import { api, jsonBody, Ic, ICONS, LINK, genName, fetchNewModelsOnce, fetchNewModelsWithToast, invalidateNewModels } from "./wizard-lib";
import { ProviderAvatar } from "./provider-icons";
import { MultiKeyStatusSummary, MultiKeyStatusDialog, MultiKeyStatusRows } from "./multi-key-status";
import { EnabledScopeBlock, resyncEnabledModels } from "./enabled-scope";
import { ensureStyles } from "./amw-styles";
// aiti-float dock v3（P1 批）：显隐收口展示状态机 + 右栏停靠容器
import { useGate, DockBody, openFloat, closePanel } from "../../../_shared/ext-float-dock";

/** 面板 itemKey（浮窗壳 data-ext-float-key 既有值；rightFileDock 注册 raw itemId "shell-v2" 拼后一致） */
export const WIZARD_KEY = "aiti-model-wizard:shell-v2";

// cleanupEdit 信箱（DI 方案 P2：entry 经 services 通道注册 deposit；App 挂载前 deposit 也不丢）
let cleanupEditMailbox: any = null;
export function depositCleanupEdit(p: unknown): void { cleanupEditMailbox = p; }

// ── availability 推送订阅（pi-web 页面事件流统一承载）────────────────────────
// HTTP/1.1 浏览器每主机仅 6 条并发连接；availability SSE 的订阅实例（Banner/Reminder/
// 向导对话框…）若各自建连，叠加 running/events、plan-first 等长连接会耗尽连接池——
// availability 推送：pi-web 页面事件流（agent/running/events 统一帧，type=mc:avail；
// 与侧栏运行状态共享同一条 SSE，无独立连接）。客户端缺席 → 无实时推送，手动刷新兜底。
type AvailCb = (frame?: any) => void;
function subscribeAvailabilityEvents(cb: AvailCb): () => void {
  // 事件总线 topics 唯一（2026-09-09 拍板）：白名单 mc:avail；禁止任何兑底（全帧/core route 均已删）。
  // topics 服务缺席（event-bus 未启用）→ 不订阅（返回 no-op）。
  const client = (() => {
    const topicsSvc = extSvc<((h: (f: any) => void, types: string[]) => { off: () => void }) | undefined>("aiti-event-bus.subscribe-topics");
    return topicsSvc ? { subscribePageFrames: (h: (f: any) => void) => topicsSvc(h, ["mc:avail"]).off } : null;
  })();
  if (!client?.subscribePageFrames) return () => {};
  return client.subscribePageFrames((frame: any) => {
    if (frame && frame.type === "mc:avail") { try { cb(frame); } catch { /* noop */ } }
  });
}

declare global {
  interface Window {
    __aitiModelWizardOpen?: () => void;
    __aitiModelWizardOpenTab?: (t?: string, provider?: string) => void;
    __aitiModelCheckOpen?: () => void;
    __aitiModelCheckApp?: any;
    __aitiHelperInvoke?: (opts?: Record<string, unknown>) => boolean;
    // App 挂载期间注册：直接弹本面板的模型参数浮窗（aiti-model-check「👁」等外部复用）
    __aitiModelWizardViewParams?: (provider: string, id: string) => void;
    // 一键编辑信箱：aiti-model-check「🛠 一键编辑」写入 → openTab("status") → App 就绪（st 加载完）后消费
    __aitiModelWizardCleanupEdit?: any;
  }
}

// 一键整理：硬性失败类别（探测确认、与 key/模型本身相关，保存时删除）——
// 401 key 不对 / 402 欠费 / 403 无权限·地区不可用 / 404 不存在。
// 限流（429 可恢复）/ 5xx·网络·超时（暂时性）/ 未探测（未知）一律保留，避免误删。
const CLEANUP_HARD_FAIL_KINDS = ["auth", "billing", "permission", "region", "notfound"];

/** minIntervalMs 输入框值归一：""→undefined（默认 auto，按 rpm 折算）；"auto"→"auto"；0→0（关闭匀速=突发滑窗）；正整数→毫秒；非法→undefined */
const mivNorm = (v: any): number | "auto" | undefined => {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  if (s === "auto") return "auto";
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

// 模型版本提取：v4 / v4.2 / 1-5(1.5) / k2 / r1 / 4o / qwen3；排除 6 位日期后缀（如 240428）
const modelVersion = (id: string) => {
  const s = String(id || "").toLowerCase(); let major = 0, minor = 0;
  const v = s.match(/v(\d+)/);
  if (v) {
    major = +v[1];
    const m2 = s.match(/v\d+\.(\d+)/) || s.match(/v\d+-(\d{1,2})(?!\d)/);
    if (m2) minor = +m2[1];
  } else {
    const n = s.match(/(?:^|[-_])([a-z]+)(\d{1,2})-(\d{1,2})(?=[-_.]|$)/) || s.match(/(?:^|[-_])([a-z]+)(\d{1,2})\.(\d)(?=[-_.]|$)/);
    if (n && +n[2] < 100 && +n[3] < 100) { major = +n[2]; minor = +n[3]; }
    else { const n2 = s.match(/(?:^|[-_])([a-z]+)(\d{1,2})(?:o)?(?=[-_.]|$)/); if (n2 && +n2[2] < 100) major = +n2[2]; }
  }
  return major * 100 + minor;
};
const cmpModel = (x: string, y: string) => { const va = modelVersion(x), vb = modelVersion(y); if (va !== vb) return vb - va; return x < y ? -1 : x > y ? 1 : 0; };

/** 反填来源摘要（#3）：[{id, fills:{field:源}}] → "glm-5(cost←models.dev·ctx←厂商models)、k3(推理←内置目录)"（截断） */
const FIELD_ABBR = { contextWindow: "ctx", maxTokens: "out", reasoning: ti("mw.a.1"), input: ti("mw.a.2"), cost: "cost", compat: ti("mw.a.3"), thinkingLevelMap: ti("mw.a.4"), samplingParams: ti("mw.a.5"), name: ti("mw.a.6"), api: "api", baseUrl: ti("mw.a.7") } as const;
const summarizeFills = (fills: any): string => {
  if (!Array.isArray(fills) || !fills.length) return "";
  const parts = fills.slice(0, 4).map((f: any) => {
    const srcs = Object.entries(f.fills || {}).map(([k, v]) => ((FIELD_ABBR as any)[k] || k) + "←" + v).join("·");
    return f.id + "（" + srcs + "）";
  });
  const more = fills.length > 4 ? ti("mw.a.8") + fills.length + ti("mw.a.9") : "";
 return (ti("mw.a.10") + parts.join(", ") + more).slice(0, 220);
};

/** 弹出 ai-helper（model-params-fill skill 预选 + 提示词预填），让用户点击让 AI 上网查权威数据补全缺参数的模型。
 *  能力：AI 按 skill 手册上网查权威数据 → 写入 ~/.pi/agent/models-store.json（运行时权威模型库）→
 *  回填已打开的「模型参数」弹窗 → 用户点击保存生效。dialogEl = 向导弹窗根节点（fill 回填定位用）。 */
function invokeAiHelperForMissing(provider: string, missing: { id: string; name?: string }[], dialogEl?: HTMLElement | null) {
  const w = window as any;
  // DI 方案 P2：services 通道优先，旧全局兜底
  const invokeFn = extSvc<(opts?: Record<string, unknown>) => boolean>("aiti-helper.invoke") || w.__aitiHelperInvoke;
  if (typeof invokeFn !== "function") return false;
  const ids = missing.map((m) => m.id).join("、");
  const prompt = [
    ti("mw.a.11") + provider + ti("mw.a.12"),
    ids,
    ti("mw.a.13"),
    ti("mw.a.14") + provider + ti("mw.a.15"),
    ti("mw.a.16"),
    ti("mw.a.17"),
  ].join("\n");
  try {
    invokeFn({
      extId: "aiti-model-wizard",
      extName: ti("mw.a.18"),
      helperId: "model-params-fill",
      message: prompt,
      autoSend: true,  // 预填后自动发送：AI 直接开查，用户无需再点「生成」
      placeholder: ti("mw.a.19"),
      contextLabel: ti("mw.a.20") + provider + " · " + ids,
      dialogEl: dialogEl || null,
    });
    return true;
  } catch { return false; }
}

// ── 一键体检 / 设置面板（P1-A/P1-C，2026-09-17）共用小助手 ──
const fmtLat = (ms: any) => (ms == null || ms === "" ? "" : Number(ms) < 1000 ? Number(ms) + "ms" : (Number(ms) / 1000).toFixed(1) + "s");
const fmtTimeStr = (ts: any) => (ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
/** UsageReport → 余额短文案（前 3 个 bucket；currency=$x/$y、percent=标签 n%、count=剩余/上限） */
const usageText = (entry: any) => {
  const r = entry && entry.report;
  if (!r) return "";
  const buckets = Array.isArray(r.buckets) ? r.buckets : [];
  const parts: string[] = [];
  for (const b of buckets.slice(0, 3)) {
    if (!b) continue;
    if (b.unit === "currency") {
      const cur = b.currency || "$";
      parts.push((b.remaining != null ? cur + Number(b.remaining).toFixed(2) : "?") + (b.limit != null ? " / " + cur + Number(b.limit).toFixed(2) : ""));
    } else if (b.unit === "percent") {
      parts.push((b.label ? b.label + " " : "") + (b.remaining != null ? Number(b.remaining).toFixed(0) + "%" : "?"));
    } else {
      parts.push((b.label ? b.label + " " : "") + (b.remaining != null ? Number(b.remaining).toLocaleString() : "?") + (b.limit != null ? "/" + Number(b.limit).toLocaleString() : ""));
    }
  }
  if (!parts.length) return r.exhausted ? ti("mw.a.21") : "";
  return parts.join(" · ") + (buckets.length > 3 ? ti("mw.a.8") + buckets.length + ti("mw.a.22") : "");
};

/** 一键体检报告卡（P1-A）：逐 provider 探测结论（延迟/HTTP/明细），失败行可直达详情修复 */
function CheckupDialog({ st, onClose, onFix, onRerun }: { st: any; onClose: () => void; onFix: (provider: string) => void; onRerun: () => void }) {
  const res = st && st.res;
  const rows = res && Array.isArray(res.results) ? res.results : [];
  return (
    <div className="amw-overlay" onClick={(e) => { if (e.target === e.currentTarget && !st?.running) onClose(); }}>
      <div {...({
        "data-ext-float": "1",
        "data-ext-float-key": "aiti-model-wizard:checkup-dialog",
        "data-ext-float-w": 600,
        "data-ext-float-autoh": "1",
        "data-ext-float-full": "1",
        "data-ext-float-max": "0",
      } as any)} onClick={(e) => e.stopPropagation()} className="amw-float-panel" style={{ width: "min(600px, 100%)", maxHeight: "84dvh", padding: 14, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <Ic size={14} paths={ICONS.stethoscope} />
          <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{ti("mw.a.23") + (st?.running ? ti("mw.a.24") : "")}</span>
          <button className="amw-btn" onClick={onClose} aria-label={ti("mw.a.25")}><Ic size={12} paths={ICONS.x} /></button>
        </div>
        {st?.running ? (
          <div className="amw-note">{ti("mw.tx.1")}</div>
        ) : !res || !res.ok ? (
          <div className="amw-note is-err">{"❌ " + ((res && res.error) || ti("mw.a.26"))}</div>
        ) : (
          <>
            <div className="amw-note" style={{ marginBottom: 8 }}>
              {"✅ " + res.pass + ti("mw.a.27") + (res.rateLimited || 0) + ti("mw.a.28") + (res.fail || 0) + ti("mw.a.29") + (res.skip ? " · ⏭ " + res.skip + ti("mw.a.30") : "")}
              {ti("mw.a.31")}
            </div>
            <div style={{ overflow: "auto", flex: 1, minHeight: 80, display: "flex", flexDirection: "column", gap: 3 }} aria-live="polite">
              {rows.map((r: any) => (
                <div key={r.provider} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 8px", borderRadius: 8, border: "1px solid var(--border,#eee)", fontSize: 11.5 }}>
                  <span style={{ flexShrink: 0, fontWeight: 700, color: r.skipped ? "var(--text-subtle,#999)" : r.pass ? (r.rateLimited ? "#d97706" : "#16a34a") : "#dc2626" }}>
                    {r.skipped ? "⏭" : r.pass ? (r.rateLimited ? "🟡" : "✅") : "❌"}
                  </span>
                  <span className="amw-mono" style={{ fontWeight: 650, flexShrink: 0, minWidth: 90 }}>{r.provider}</span>
                  <span style={{ flex: 1, minWidth: 0, color: r.skipped ? "var(--text-subtle,#999)" : "var(--text-muted,#555)", wordBreak: "break-all" }}>
                    {r.skipped ? r.reason
                      : (r.status ? "HTTP " + r.status + " · " : ti("mw.a.32")) + (r.latencyMs != null ? fmtLat(r.latencyMs) + " · " : "") + (r.detail || "")
                      + (r.model ? ti("mw.a.33") + r.model + "）" : "")}
                  </span>
                  {!r.skipped && r.masked ? <span className="amw-mono" style={{ flexShrink: 0, color: "var(--text-subtle,#999)" }}>{r.keyName + " " + r.masked}</span> : null}
                  {!r.skipped && !r.pass ? (
                    <button className="amw-btn" style={{ padding: "1px 8px", fontSize: 10.5, flexShrink: 0 }} onClick={() => onFix(r.provider)}>{ti("mw.tx.2")}</button>
                  ) : null}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10, flexShrink: 0 }}>
              <button className="amw-btn" onClick={onRerun}>{ti("mw.tx.3")}</button>
              <button className="amw-btn is-ok" onClick={onClose}>{ti("mw.tx.4")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 向导设置面板（P1-C）：/config 的三组可视化（新模型提醒 / 目录 / 探测与测试），保存即时生效 */
const SETTINGS_FLOAT_PROPS: any = {
  "data-ext-float": "1",
  "data-ext-float-key": "aiti-model-wizard:settings",
  "data-ext-float-w": 520,
  "data-ext-float-autoh": "1",
  "data-ext-float-full": "1",
  "data-ext-float-max": "0",
};
/** 设置面板数字输入行（模块级组件：放对话框内部会因每次渲染组件身份变化导致输入失焦） */
function SetNum({ label, hint, value, onChange }: { label: string; hint?: string; value: any; onChange: (v: string) => void }) {
  const lbl = { fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 } as any;
  return (
    <div>
      <label style={lbl}>{label}</label>
      <input className="amw-input" style={{ width: "100%" }} type="number" min={0} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
      {hint ? <span style={{ fontSize: 10, color: "var(--text-dim,#9ca3af)" }}>{hint}</span> : null}
    </div>
  );
}
function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<any>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [catBusy, setCatBusy] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const d = srvFix(await (await api("/config")).json());
        if (d && d.ok) setCfg(d.config); else setErr((d && d.error) || ti("mw.a.34"));
      } catch (e: any) { setErr(String(e.message || e)); }
    })();
  }, []);
  const upd = (section: string, key: string, v: any) => setCfg((prev: any) => ({ ...(prev || {}), [section]: { ...((prev || {})[section] || {}), [key]: v } }));
  const save = async () => {
    if (!cfg) return;
    setSaving(true); setErr(""); setMsg("");
    try {
      const d = srvFix(await (await api("/config", { method: "POST", ...jsonBody({ set: cfg }) })).json());
      if (d && d.ok) { setMsg(ti("mw.a.35")); setTimeout(onClose, 700); }
      else setErr((d && d.error) || ti("mw.a.36"));
    } catch (e: any) { setErr(String(e.message || e)); }
    setSaving(false);
  };
  const refreshCatalog = async () => {
    setCatBusy(true); setMsg(""); setErr("");
    try {
      const d = srvFix(await (await api("/refresh-catalog", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json());
      setMsg(d && d.ok ? ti("mw.a.37") + (d.providers ?? "?") + ti("mw.a.38") + (d.source || "?") + " · " + fmtLat(d.elapsedMs) + "）" : "❌ " + ((d && d.error) || ti("mw.a.39")));
    } catch (e: any) { setErr(String(e.message || e)); }
    setCatBusy(false);
  };
  const r = cfg && cfg.reminder, cat = cfg && cfg.catalog, pr = cfg && cfg.probe, ts = cfg && cfg.test;
  // label 样式（原与 SetNum 共享同名局部变量；SetNum 抽模块级组件后本组件需自持——缺失会 ReferenceError: lbl is not defined）
  const lbl = { fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 } as any;
  const panel = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <Ic size={14} paths={ICONS.settings} />
        <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{ti("mw.tx.5")}</span>
        <button className="amw-btn" onClick={onClose} aria-label={ti("mw.a.25")}><Ic size={12} paths={ICONS.x} /></button>
      </div>
      {err ? <div className="amw-note is-err" style={{ marginBottom: 6 }}>{"❌ " + err}</div> : null}
      {msg ? <div className="amw-note is-ok" style={{ marginBottom: 6 }}>{msg}</div> : null}
      {!cfg ? <div style={{ color: "var(--text-subtle,#666)", fontSize: 12 }}>{ti("mw.tx.6")}</div> : (
        <div style={{ overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div className="amw-section" style={{ margin: "0 0 5px" }}>{ti("mw.tx.7")}</div>
            <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center", marginBottom: 6 }}>
              <input type="checkbox" checked={r?.enabled !== false} onChange={(e) => upd("reminder", "enabled", e.target.checked)} />{ti("mw.tx.207")}
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <SetNum label={ti("mw.a.40")} value={r ? Math.round((r.checkIntervalMs || 1800000) / 60000) : ""} onChange={(v) => upd("reminder", "checkIntervalMs", Math.max(1, Math.floor(Number(v) || 0)) * 60000)} />
              <SetNum label={ti("mw.a.41")} value={r ? Math.round((r.fetchTimeoutMs || 8000) / 1000) : ""} onChange={(v) => upd("reminder", "fetchTimeoutMs", Math.max(1, Math.floor(Number(v) || 0)) * 1000)} />
              <SetNum label={ti("mw.a.42")} hint={ti("mw.a.43")} value={r ? r.maxPerDay ?? "" : ""} onChange={(v) => upd("reminder", "maxPerDay", Math.max(0, Math.floor(Number(v) || 0)))} />
              <SetNum label={ti("mw.a.44")} value={r ? Math.round((r.minGapMs || 30000) / 1000) : ""} onChange={(v) => upd("reminder", "minGapMs", Math.max(0, Math.floor(Number(v) || 0)) * 1000)} />
              <SetNum label={ti("mw.a.45")} value={r ? Math.round((r.toastMs || 10000) / 1000) : ""} onChange={(v) => upd("reminder", "toastMs", Math.max(1, Math.floor(Number(v) || 0)) * 1000)} />
            </div>
          </div>
          <div>
            <div className="amw-section" style={{ margin: "0 0 5px" }}>{ti("mw.tx.8")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div><label style={lbl}>{ti("mw.tx.9")}</label><input className="amw-input" style={{ width: "100%", fontFamily: "ui-monospace,monospace" }} value={cat?.primaryUrl ?? ""} onChange={(e) => upd("catalog", "primaryUrl", e.target.value)} /></div>
              <div><label style={lbl}>{ti("mw.tx.10")}</label><input className="amw-input" style={{ width: "100%", fontFamily: "ui-monospace,monospace" }} value={cat?.mirrorUrl ?? ""} onChange={(e) => upd("catalog", "mirrorUrl", e.target.value)} /></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end" }}>
                <SetNum label={ti("mw.a.46")} value={cat ? cat.ttlHours ?? "" : ""} onChange={(v) => upd("catalog", "ttlHours", Math.max(1, Math.floor(Number(v) || 0)))} />
                <button className="amw-btn" disabled={catBusy} style={{ marginBottom: 14 }} title={ti("mw.a.47")} onClick={refreshCatalog}>{catBusy ? ti("mw.a.48") : ti("mw.a.49")}</button>
              </div>
            </div>
          </div>
          <div>
            <div className="amw-section" style={{ margin: "0 0 5px" }}>{ti("mw.tx.11")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <SetNum label={ti("mw.a.50")} hint={ti("mw.a.51")} value={ts ? Math.round((ts.timeoutMs || 12000) / 1000) : ""} onChange={(v) => upd("test", "timeoutMs", Math.max(1, Math.floor(Number(v) || 0)) * 1000)} />
              <SetNum label={ti("mw.a.52")} value={pr ? Math.round((pr.timeoutMs || 12000) / 1000) : ""} onChange={(v) => upd("probe", "timeoutMs", Math.max(1, Math.floor(Number(v) || 0)) * 1000)} />
              <SetNum label={ti("mw.a.53")} hint={ti("mw.a.54")} value={pr ? pr.maxTokens ?? "" : ""} onChange={(v) => upd("probe", "maxTokens", Math.max(1, Math.floor(Number(v) || 0)))} />
            </div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10, flexShrink: 0 }}>
        <button className="amw-btn" onClick={onClose}>{ti("mw.tx.12")}</button>
        <button className="amw-btn is-ok" disabled={!cfg || saving} onClick={save}>{saving ? ti("mw.a.55") : ti("mw.a.56")}</button>
      </div>
    </>
  );
  return (
    <div className="amw-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div {...SETTINGS_FLOAT_PROPS} onClick={(e) => e.stopPropagation()} className="amw-float-panel" style={{ width: "min(520px, 100%)", maxHeight: "84dvh", padding: 14, display: "flex", flexDirection: "column" }}>
        {panel}
      </div>
    </div>
  );
}

/** 模型聚合 · 成员选择器：搜索过滤已配置 provider×model，点击加入聚合组 */
function MemberPicker({ pool, exclude, onPick }: { pool: any[]; exclude: string[]; onPick: (m: any) => void }) {
  const [q, setQ] = useState("");
  // Collapsed until asked for: an expanded wall of candidate chips made the editor read as
  // one dense form (adding a member looked like yet another field).
  const [open, setOpen] = useState(false);
  // Multi-word AND match (e.g. "openrouter glm", "glm free"); cap at 200 while searching, and show
  // only the first 12 when idle so the picker does not flood the editor (typing narrows it).
  const kws = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const MATCH_CAP = 200;
  const COLLAPSED_CAP = 12;
  const all = pool.filter((m: any) => {
    if ((m.keyCount ?? 0) < 1) return false; // 无 key 成员必然被引擎拒绝，不展示
    if (exclude.includes(m.provider + "/" + m.model)) return false;
    if (!kws.length) return true;
    const hay = (m.provider + "/" + m.model + " " + (m.name || "")).toLowerCase();
    return kws.every((k) => hay.includes(k));
  });
  const cap = kws.length ? MATCH_CAP : COLLAPSED_CAP;
  const cands = all.slice(0, cap);
  // 防御：成员池来自 /combos（运行时 provider 合并产物），若同一 `provider/model` 出现两条
  // （如 models.json 与运行时快照都命中），候选 key 用 `${provider}/${model}` 会触发 React
  // "two children with the same key" 告警。先按 key 去重只保一条，零回归。
  const candKeys = new Set<string>();
  const candsDedup = cands.filter((m: any) => {
    const k = m.provider + "/" + m.model;
    if (candKeys.has(k)) return false;
    candKeys.add(k);
    return true;
  });
  if (!open) {
    return (
      <button className="amw-btn amw-combo-addmember" disabled={!pool.length}
        title={pool.length ? ti("mw.tx.223") : ti("mw.a.59")}
        onClick={() => setOpen(true)}>
        ＋ {ti("mw.tx.223")}
      </button>
    );
  }
  return (
    <div className="amw-combo-picker">
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input className="amw-input" style={{ flex: 1, padding: "4px 8px", fontSize: 12 }} value={q} placeholder={ti("mw.a.57")}
          autoFocus onChange={(e) => setQ(e.target.value)} />
        <button className="amw-btn" style={{ padding: "3px 9px", fontSize: 11 }} onClick={() => setOpen(false)}>{ti("mw.tx.224")}</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
        {candsDedup.map((m: any) => (
          // Keep the filter open after a pick so several members can be added in a row.
          <button key={m.provider + "/" + m.model} title={"ctx=" + (m.contextWindow ?? "?") + " · out=" + (m.maxTokens ?? "?") + " · keys=" + m.keyCount}
            style={{ padding: "2px 9px", borderRadius: 999, border: "1px solid rgba(99,102,241,.3)", background: "rgba(99,102,241,.06)", fontSize: 11, cursor: "pointer", fontFamily: "ui-monospace,monospace" }}
            onClick={() => onPick(m)}>
            {m.provider}/{m.model}
          </button>
        ))}
        {!cands.length ? <span style={{ fontSize: 11, color: "var(--text-subtle,#999)" }}>{pool.length ? ti("mw.a.58") : ti("mw.a.59")}</span>
        : all.length > cap ? <span style={{ fontSize: 11, color: "var(--text-subtle,#999)" }}>{ti("mw.a.60") + all.length + ti("mw.a.61") + cap + ti("mw.a.62")}</span> : null}
      </div>
    </div>
  );
}

/** 订阅登录型：授权码/PAT 粘贴输入（allowEmpty 时空提交=继续浏览器流程） */
function OauthCodeInput({ onSubmit, placeholder, allowEmpty }: { onSubmit: (v: string) => void; placeholder?: string; allowEmpty?: boolean }) {
  const [v, setV] = useState("");
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
      <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} value={v} placeholder={placeholder || ""}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (allowEmpty || v.trim())) onSubmit(v); }} />
      <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff" }} disabled={!allowEmpty && !v.trim()} onClick={() => onSubmit(v)}>{ti("mw.tx.13")}</button>
    </div>
  );
}

/** 模型参数查看/编辑弹窗（#5）：只读态一键进编辑；可改 name/能力/窗口/maxTokens/cost/
 *  thinkingLevelMap/compat（DeepSeek 思考·developer 角色）/模型级 headers/API 覆盖。
 *  保存走现有 /save（models:[单模型]，按 id 合并不动其它模型；元数据字段显式传入优先）。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const API_OVERRIDE_OPTIONS = ["openai-completions", "anthropic-messages", "openai-responses", "google-generative-ai"];
// 模型参数二次窗口的 aiti-float 契约：独立持久化键（嵌套在向导弹窗内，不能沿用父级 data-ext-item 的键）、
// 初始宽 620、autoh 自适应高度（只读清单/编辑表单内容高度不定）、小屏全屏（data-ext-float-full 托管）。
const PARAM_FLOAT_PROPS: any = {
  "data-ext-float": "1",
  "data-ext-float-key": "aiti-model-wizard:param-dialog",
  "data-ext-float-w": 620,
  "data-ext-float-autoh": "1",
  "data-ext-float-full": "1",
};
// 二次弹窗全屏遮罩：amw-overlay 类（fixed 视口铺满；zIndex 低于 toast、高于向导其余内容；
// 面板由 aiti-float 接管拖拽/缩放/持久化）
// 保存确认二次弹窗的 aiti-float 契约：独立持久化键（不与主窗/参数窗撞）、窄 440、autoh、小屏全屏；
// max=0：小确认窗不需要全屏按钮（且标题栏无关闭钮，自动注入位置会很怪）。
const SAVE_FLOAT_PROPS: any = {
  "data-ext-float": "1",
  "data-ext-float-key": "aiti-model-wizard:save-dialog",
  "data-ext-float-w": 440,
  "data-ext-float-autoh": "1",
  "data-ext-float-full": "1",
  "data-ext-float-max": "0",
};
/** 🩺 发起一次可用性探测（与「模型检查」同款探针/同库存储：POST aiti-model-check /probe → probeAndRecord → state.models + history）。
 *  返回 { r }（单模型结果：ok/status/latencyMs/label/error/predictedAvailableAt/perKey）或 { error }。 */
async function probeModelNow(provider: string, model: string): Promise<{ r?: any; error?: string }> {
  try {
    const d = await srvFix(await (await fetch(apiUrl("/api/extensions/aiti-model-check/probe"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, model }),
    })).json());
    const r = d && Array.isArray(d.results) ? d.results.find((x: any) => x.provider === provider && x.model === model) : null;
    if (!d || !d.ok) return { error: (d && d.error) || ti("mw.a.63") };
    if (!r) return { error: (d && d.reason) || ti("mw.a.64") };
    return { r };
  } catch (e: any) { return { error: ti("mw.a.65") + ((e && e.message) || e) };
  }
}

/** 🩺 探测结果就地展示：可用绿 / 429 黄（带预计恢复）/ 失败红（带原因），多 key 逐 key 一行 */
function ProbeOut({ r }: { r: any }) {
  const fmtMs = (ms: any) => (ms == null || ms === "" ? "" : Number(ms) < 1000 ? Number(ms) + "ms" : (Number(ms) / 1000).toFixed(1) + "s");
  const keys = Array.isArray(r.perKey) ? r.perKey : [];
  return (
    <span style={{ minWidth: 0, display: "inline-flex", flexDirection: "column", gap: 1 }}>
      {r.ok ? (
        <span style={{ color: "#16a34a", fontWeight: 650, fontSize: 11.5 }}>
          {ti("mw.a.66") + (r.status ? " · HTTP " + r.status : "") + (r.latencyMs != null ? " · " + fmtMs(r.latencyMs) : "")}
        </span>
      ) : r.status === 429 ? (
        <span style={{ color: "#d97706", fontWeight: 650, fontSize: 11.5 }}>
          {ti("mw.a.67") + (r.predictedAvailableAt ? ti("mw.a.68") + new Date(r.predictedAvailableAt).toLocaleString("zh-CN", { hour12: false }) : "")}
        </span>
      ) : (
        <span style={{ color: "#dc2626", fontWeight: 650, fontSize: 11.5 }}>
          {("❌ " + (r.label || ti("mw.a.69")) + (r.status ? " · HTTP " + r.status : "") + (r.latencyMs != null ? " · " + fmtMs(r.latencyMs) : ""))}
        </span>
      )}
      {r.error ? <span style={{ color: r.ok ? "var(--text-subtle,#666)" : "#dc2626", fontSize: 11, wordBreak: "break-all" }}>{String(r.error).slice(0, 160)}</span> : null}
      {keys.length >= 2 ? keys.map((k: any) => (
        <span key={k.keyName || k.name} style={{ fontSize: 10.5, fontWeight: 600, color: k.ok ? "#16a34a" : k.status === 429 ? "#d97706" : "#dc2626" }}>
          {"　" + (k.ok ? "✅" : k.status === 429 ? "🟡" : "❌") + " " + (k.keyName || k.name || "key") + " · HTTP " + (k.status || "net") + " · " + fmtMs(k.latencyMs) + (k.label ? " · " + k.label : "")}
        </span>
      )) : null}
    </span>
  );
}

/** 模型参数浮窗（旧入口）：浮层 + 浮动面板，内核是 ParamPanel（B 阶段起也可内联进双栏详情）。 */
function ParamDialog(props: { data: any; onClose: () => void; onSaved?: (resp?: any) => void; dialogEl?: HTMLElement | null }) {
  return (
    <div className="amw-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div {...PARAM_FLOAT_PROPS} onClick={(e) => e.stopPropagation()} className="amw-float-panel" style={{ width: "min(620px, 100%)", maxHeight: "84dvh", padding: 14 }}>
        <ParamPanel {...props} />
      </div>
    </div>
  );
}

/** 模型参数面板（读/编一体）。embedded=true → 内联于双栏详情右侧（B 阶段）；否则作为浮层面板内容。
 *  ai-helper 回填契约（G3）：回填目标从「弹窗」改为「详情面板」——dialogEl 仍由调用方传入可定位根节点。 */
function ParamPanel({ data, onClose, onSaved, dialogEl, embedded }: { data: any; onClose: () => void; onSaved?: (resp?: any) => void; dialogEl?: HTMLElement | null; embedded?: boolean }) {
  const [edit, setEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [draft, setDraft] = useState<any>(() => {
    if (!data.params) return null;
    const d0 = JSON.parse(JSON.stringify(data.params));
    try { d0.imageMaxBytes = d0.inputLimits && d0.inputLimits.images && d0.inputLimits.images.resize ? d0.inputLimits.images.resize.maxBytes : ""; } catch {}
    return d0;
  });
  // 🩺 可用性测试（与「模型检查」同款探针 + 同库存储）：测完立即就地展示；探测事件经 availability SSE 同步树上的 可用/限流/异常 点
  const [probeSt, setProbeSt] = useState<any>(null); // null | {busy} | {done:r} | {error}
  const doModelProbe = async () => {
    setProbeSt({ busy: true });
    const out = await probeModelNow(data.provider, data.id);
    setProbeSt(out.r ? { done: out.r } : { error: out.error });
  };
  // 测试入口只放独立弹窗（右上角工具条）；嵌入详情页已有「重检」，不重复显示
  // 模型级 headers 行级编辑器（空名行不落盘）
  const [hdrRows, setHdrRows] = useState<{ k: string; v: string }[]>(() =>
    Object.entries((data.params && data.params.headers) || {}).map(([k, v]: any) => ({ k, v: String(v) })));
  // 数据是异步拉的（挂载时 params 常为 null）：params 到位/切换模型时重置草稿与编辑态
  // （useState 惰性初始化只跑一次，不重置的话 draft 永远停在 null → 弹窗永不出现）
  useEffect(() => {
    if (data.params) {
      const d0 = JSON.parse(JSON.stringify(data.params));
      // G4：从 inputLimits 派生 imageMaxBytes 展示值（编辑草稿读写同一键）
      try { d0.imageMaxBytes = d0.inputLimits && d0.inputLimits.images && d0.inputLimits.images.resize ? d0.inputLimits.images.resize.maxBytes : ""; } catch {}
      setDraft(d0);
    } else setDraft(null);
    setHdrRows(Object.entries((data.params && data.params.headers) || {}).map(([k, v]: any) => ({ k, v: String(v) })));
    setEdit(!!data.autoEdit);   // autoEdit=true → 直接进编辑态（AI 补参数回填用）
    setErrMsg("");
    setProbeSt(null);           // 切换模型 → 清掉上一个模型的测试结果
  }, [data.provider, data.id, data.params, data.autoEdit]);
  // 数据未就位（加载中/取不到）：给明确反馈而不是静默空白（此前直接 return null，用户点了没反应）
  if (!draft || data.loading || data.error) {
    const inner = (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <Ic size={14} paths={ICONS.card} />
          <span className="amw-mono" style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{ti("mw.a.70") + data.id}</span>
          {embedded
            ? <button className="amw-btn" onClick={onClose}>{ti("mw.tx.14")}</button>
            : <button className="amw-btn" onClick={onClose} aria-label={ti("mw.a.25")}><Ic size={12} paths={ICONS.x} /></button>}
        </div>
        {data.loading ? <div style={{ color: "var(--text-subtle,#666)", fontSize: 12 }}>{ti("mw.tx.6")}</div>
          : data.error ? <div style={{ color: "#dc2626", fontSize: 12 }}>{"❌ " + data.error}</div>
          : <div style={{ color: "var(--text-subtle,#666)", fontSize: 12 }}>{data.readOnly ? ti("mw.a.71") : ti("mw.a.72")}</div>}
        {!data.loading && !data.error && data.readOnly ? (
          <div style={{ marginTop: 10 }}>
            <button className="amw-btn is-ok" onClick={() => invokeAiHelperForMissing(data.provider, [{ id: data.id }], dialogEl || null)}>{ti("mw.tx.15")}</button>
          </div>
        ) : null}
      </>
    );
    if (embedded) return <div style={{ padding: 14 }}>{inner}</div>;
    return (
      <div className="amw-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="amw-float-panel" style={{ width: "min(420px, 100%)", padding: 14 }}>{inner}</div>
      </div>
    );
  }
  const D = (patch: any) => setDraft((prev: any) => ({ ...prev, ...patch }));
  const cost = draft.cost || {};
  const setCost = (k: string, v: string) => {
    const next = { ...cost };
    if (v.trim() === "") delete next[k]; else next[k] = Number(v);
    D({ cost: Object.keys(next).length ? next : {} });
  };
  const tlm = draft.thinkingLevelMap || {};
  const setTlm = (level: string, v: string) => {
    const next = { ...tlm };
    if (v.trim() === "") delete next[level]; else next[level] = v.trim();
    D({ thinkingLevelMap: next });
  };
  const hasDeepseek = !!(draft.compat && draft.compat.thinkingFormat === "deepseek");
  const setDeepseek = (on: boolean) => {
    const rest = { ...(draft.compat || {}) } as any;
    if (on) { rest.thinkingFormat = "deepseek"; rest.requiresReasoningContentOnAssistantMessages = true; }
    else { delete rest.thinkingFormat; delete rest.requiresReasoningContentOnAssistantMessages; }
    D({ compat: rest });
  };
  const devRoleOff = !!(draft.compat && draft.compat.supportsDeveloperRole === false);
  const setCompat = (patch: any) => D({ compat: { ...(draft.compat || {}), ...patch } });
  const delCompatKey = (key: string) => {
    const rest = { ...(draft.compat || {}) } as any;
    delete rest[key];
    D({ compat: rest });
  };
  const save = async () => {
    setSaving(true); setErrMsg("");
    try {
      const m: any = { id: draft.id };
      if (String(draft.name || "").trim()) m.name = String(draft.name).trim();
      // G4：模型级 baseUrl 覆盖（空 = 跟随 provider，不发）
      if (String(draft.baseUrl || "").trim()) m.baseUrl = String(draft.baseUrl).trim().replace(/\/+$/, "");
      m.reasoning = !!draft.reasoning;
      // 保留 image 之外的模态（如 audio）：只增删 image 位，不整表覆盖
      const baseInput = Array.isArray(draft.input) ? draft.input.filter((x) => x !== "image") : ["text"];
      const wantsImage = Array.isArray(draft.input) && draft.input.includes("image");
      m.input = wantsImage ? [...new Set(["text", ...baseInput, "image"])] : [...new Set(["text", ...baseInput])];
      if (Number(draft.contextWindow) > 0) m.contextWindow = Number(draft.contextWindow);
      if (Number(draft.maxTokens) > 0) m.maxTokens = Number(draft.maxTokens);
      const c = draft.cost || {};
      if (["input", "output", "cacheRead", "cacheWrite"].every((k) => Number.isFinite(Number(c[k])))) m.cost = { input: Number(c.input), output: Number(c.output), cacheRead: Number(c.cacheRead), cacheWrite: Number(c.cacheWrite) };
      if (Object.keys(tlm).length) m.thinkingLevelMap = tlm; // 空时不发（upsert 无法删字段，发了反而落空对象）
      const comp: any = { ...(draft.compat || {}) };
      if (!hasDeepseek) { delete comp.thinkingFormat; delete comp.requiresReasoningContentOnAssistantMessages; }
      if (!devRoleOff) delete comp.supportsDeveloperRole;
      if (Object.keys(comp).length) m.compat = comp; // 同上：空覆盖集不发
      const headers: any = {};
      for (const r of hdrRows) { if (r.k.trim() && r.v.trim()) headers[r.k.trim()] = r.v.trim(); }
      m.headers = headers;
      // G4：图片大小上限（inputLimits.images.resize.maxBytes）——空 = 删除覆盖；正整数字节校验
      const imgRaw = String(draft.imageMaxBytes ?? "").trim();
      if (imgRaw === "") {
        // 清理空容器（images/resize/inputLimits 逐级剥）。全空时发 {} 强制覆盖——
        // 反填链对 undefined 字段会从已存/目录回填（backfillModelMeta 只填 undefined），
        // 不发会把旧 maxBytes 原样恢复，删除语义失效。
        const il = (draft.inputLimits && typeof draft.inputLimits === "object") ? JSON.parse(JSON.stringify(draft.inputLimits)) : null;
        if (il && il.images && il.images.resize) { delete il.images.resize.maxBytes; if (!Object.keys(il.images.resize).length) delete il.images.resize; }
        if (il && il.images && !Object.keys(il.images).length) delete il.images;
        m.inputLimits = (il && Object.keys(il).length) ? il : {};
      } else if (/^\d+$/.test(imgRaw) && Number(imgRaw) >= 1) {
        const il = (draft.inputLimits && typeof draft.inputLimits === "object") ? JSON.parse(JSON.stringify(draft.inputLimits)) : {};
        il.images = { ...(il.images || {}), resize: { ...((il.images || {}).resize || {}), maxBytes: Number(imgRaw) } };
        m.inputLimits = il;
      } else { setErrMsg(ti("mw.a.73")); setSaving(false); return; }
      if (draft.api) m.api = draft.api;
      const d = srvFix(await (await api("/save", { method: "POST", ...jsonBody({ provider: data.provider, baseUrl: data.baseUrl, api: data.api || "openai-completions", keepKey: true, models: [m] }) })).json());
      if (d.ok) { onSaved && onSaved(d); onClose(); }
      else setErrMsg(d.error || ti("mw.a.36"));
    } catch (e: any) { setErrMsg(String(e.message || e)); }
    setSaving(false);
  };
  const lbl = { fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 } as any;
  const panel = (
    <>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <Ic size={14} paths={ICONS.card} />
          <span className="amw-mono" style={{ fontWeight: 700, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(edit ? ti("mw.a.74") : ti("mw.a.70")) + (draft.id || data.id)}</span>
          {data.readOnly ? <span className="amw-tag is-ro">{ti("mw.tx.16")}</span>
            : !edit ? <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => setEdit(true)}>{ti("mw.tx.17")}</button> : null}
          {!embedded ? (
            <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, fontWeight: 650 }}
              disabled={!!(probeSt && probeSt.busy)} onClick={doModelProbe}
              title={ti("mw.a.75")}>
              {(probeSt && probeSt.busy) ? ti("mw.a.76") : ti("mw.a.77")}
            </button>
          ) : null}
          {embedded
            ? <button className="amw-btn" onClick={onClose}>{ti("mw.tx.14")}</button>
            : <button className="amw-btn" onClick={onClose} aria-label={ti("mw.a.25")}><Ic size={12} paths={ICONS.x} /></button>}
        </div>
        {/* 🩺 测试结果行：仅独立弹窗显示，测完立即就地展示（读/编两态都在） */}
        {!embedded && probeSt ? (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap", padding: "6px 9px", border: "1px solid var(--border,#eee)", borderRadius: 8, background: "var(--bg-subtle,#fafafa)", marginBottom: 8 }}>
            {probeSt.busy ? <span style={{ color: "var(--text-subtle,#666)", fontSize: 11.5 }}>{ti("mw.a.78") + data.id + ti("mw.a.79")}</span> : null}
            {probeSt.done ? <ProbeOut r={probeSt.done} /> : null}
            {probeSt.error ? <span style={{ color: "#b45309", fontSize: 11.5, minWidth: 0, wordBreak: "break-all" }}>{"⚠️ " + probeSt.error}</span> : null}
          </div>
        ) : null}
        <div style={{ overflow: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="amw-mono" style={{ fontSize: 11, color: "var(--text-subtle,#666)", wordBreak: "break-all" }}>{"provider: " + data.provider + " · api: " + (data.api || "—")}</div>
          {data.crossFrom ? <div style={{ padding: "4px 8px", borderRadius: 8, background: "color-mix(in srgb, var(--warn, #f59e0b) 12%, transparent)", color: "#b45309", fontSize: 11 }}>{ti("mw.a.80") + data.crossFrom + ti("mw.a.81")}</div> : null}
        {edit ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div><label style={lbl}>{ti("mw.tx.18")}</label><input className="amw-input" style={{ width: "100%" }} value={draft.name || ""} onChange={(e) => D({ name: e.target.value })} placeholder="Display name" /></div>
              <div><label style={lbl}>{ti("mw.a.560")}</label><input className="amw-input" style={{ width: "100%" }} type="number" value={draft.contextWindow ?? ""} onChange={(e) => D({ contextWindow: e.target.value ? Number(e.target.value) : "" })} placeholder="128000" /></div>
              <div><label style={lbl}>{ti("mw.tx.19")}</label><input className="amw-input" style={{ width: "100%" }} type="number" value={draft.maxTokens ?? ""} onChange={(e) => D({ maxTokens: e.target.value ? Number(e.target.value) : "" })} placeholder="16384" /></div>
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={!!draft.reasoning} onChange={(e) => D({ reasoning: e.target.checked })} />{ti("mw.tx.20")}</label>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={Array.isArray(draft.input) && draft.input.includes("image")} onChange={(e) => D({ input: e.target.checked ? ["text", "image"] : ["text"] })} />{ti("mw.tx.21")}</label>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center", marginLeft: "auto" }}>{ti("mw.a.95")}
                <select className="amw-input" style={{width: 190}} value={draft.api || ""} onChange={(e) => D({ api: e.target.value })}>
                  <option value="">{ti("mw.tx.22")}</option>
                  {API_OVERRIDE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            </div>
            {/* G4：模型级 baseUrl 覆盖 / 图片大小上限 / Claude 自适应思考（原生高级设置三件套补齐） */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={lbl}>{ti("mw.tx.23")}</label>
                <input className="amw-input" style={{ width: "100%", fontFamily: "ui-monospace,monospace" }} value={draft.baseUrl || ""}
                  onChange={(e) => D({ baseUrl: e.target.value })} placeholder={(data.baseUrl || "https://api.example.com/v1")} />
              </div>
              {((Array.isArray(draft.input) && draft.input.includes("image")) || (draft.inputLimits && draft.inputLimits.images && draft.inputLimits.images.resize && draft.inputLimits.images.resize.maxBytes !== undefined)) ? (
                <div>
                  <label style={lbl}>{ti("mw.tx.24")}</label>
                  <input className="amw-input" style={{ width: "100%" }} type="text" inputMode="numeric" value={draft.imageMaxBytes ?? ""}
                    onChange={(e) => D({ imageMaxBytes: e.target.value })} placeholder="4718592" />
                  <span style={{ fontSize: 10, color: "var(--text-subtle,#666)" }}>{ti("mw.tx.25")} <code>inputLimits.images.resize.maxBytes</code></span>
                </div>
              ) : null}
            </div>
            {(draft.api || data.api) === "anthropic-messages" && !!draft.reasoning ? (
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center" }}>
                <input type="checkbox" checked={!!(draft.compat && draft.compat.forceAdaptiveThinking)} onChange={(e) => setCompat({ forceAdaptiveThinking: e.target.checked || undefined })} />
                {ti("mw.tx.183")}<code className="amw-mono" style={{ fontSize: 10, color: "var(--text-subtle,#666)" }}>compat.forceAdaptiveThinking</code>
              </label>
            ) : null}
            <div>
              <div className="amw-section" style={{margin: "0 0 4px"}}>{ti("mw.tx.26")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                {["input", "output", "cacheRead", "cacheWrite"].map((k) => (
                  <div key={k}><label style={lbl}>{k}</label><input className="amw-input" style={{ width: "100%" }} type="number" step="0.01" value={cost[k] ?? ""} onChange={(e) => setCost(k, e.target.value)} placeholder="0" /></div>
                ))}
              </div>
            </div>
            <div>
              <div className="amw-section" style={{margin: "0 0 4px"}}>{ti("mw.tx.27")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6 }}>
                {THINKING_LEVELS.map((lv) => (
                  <div key={lv}><label style={lbl}>{lv}</label><input className="amw-input" style={{ width: "100%" }} value={tlm[lv] ?? ""} onChange={(e) => setTlm(lv, e.target.value)} placeholder="—" /></div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={hasDeepseek} onChange={(e) => setDeepseek(e.target.checked)} />{ti("mw.tx.28")}</label>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={!devRoleOff} onChange={(e) => e.target.checked ? delCompatKey("supportsDeveloperRole") : setCompat({ supportsDeveloperRole: false })} />{ti("mw.tx.29")}</label>
            </div>
            <div>
              <div className="amw-section" style={{margin: "0 0 4px"}}>{ti("mw.tx.30")}</div>
              {hdrRows.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                  <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} placeholder="Header-Name" value={r.k} onChange={(e) => setHdrRows((prev) => prev.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
                  <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} placeholder="value" value={r.v} onChange={(e) => setHdrRows((prev) => prev.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
                  <button className="amw-btn" style={{ padding: "2px 8px", color: "#dc2626" }} onClick={() => setHdrRows((prev) => prev.filter((_x, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => setHdrRows((prev) => [...prev, { k: "", v: "" }])}>{ti("mw.tx.31")}</button>
            </div>
          </>
        ) : (() => {
          const fmtVal = (v: any): string | null => {
            if (v === undefined || v === null) return null;
            if (typeof v === "boolean") return v ? ti("mw.a.82") : ti("mw.a.83");
            if (typeof v === "number") return v.toLocaleString();
            if (Array.isArray(v)) return v.join("，") || ti("mw.a.84");
            if (typeof v === "object") return Object.keys(v).length ? JSON.stringify(v) : null;
            return String(v);
          };
          const FIELDS: [string, string][] = [
            ["id", ti("mw.a.85")], ["name", ti("mw.a.86")], ["reasoning", ti("mw.a.1")],
            ["contextWindow", ti("mw.a.87")], ["maxTokens", ti("mw.a.88")],
            ["input", ti("mw.a.89")], ["cost", ti("mw.a.90")], ["compat", ti("mw.a.91")],
            ["inputLimits", ti("mw.a.92")],
            ["thinkingLevelMap", ti("mw.a.93")], ["samplingParams", ti("mw.a.94")], ["api", ti("mw.a.95")], ["baseUrl", "Base URL"],
          ];
          return FIELDS.map(([k, label]) => {
            const v = fmtVal(k === "id" ? draft.id : draft[k]);
            if (v === null) return null;
            return (
              <div key={k} style={{ padding: "5px 6px", borderTop: "1px solid var(--border,#eee)", display: "flex", gap: 8, fontSize: 12 }}>
                <span style={{ width: "min(160px, 42%)", flexShrink: 0, color: "var(--text-subtle,#666)" }}>{label}</span>
                <span className="amw-mono" style={{flex: 1, whiteSpace: "pre-wrap"}}>{v}</span>
              </div>
            );
          });
        })()}
        </div>
        {edit ? (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10, alignItems: "center", flexShrink: 0 }}>
            {errMsg ? <span style={{ color: "#dc2626", fontSize: 11, flex: 1 }}>{errMsg}</span> : <span style={{ flex: 1 }} />}
            <button className="amw-btn" disabled={saving} onClick={() => { setDraft(data.params ? JSON.parse(JSON.stringify(data.params)) : null); setHdrRows(Object.entries((data.params && data.params.headers) || {}).map(([k, v]: any) => ({ k, v: String(v) }))); setErrMsg(""); setEdit(false); }}>{ti("mw.tx.12")}</button>
            <button className="amw-btn is-ok" disabled={saving} onClick={save}>{saving ? ti("mw.a.55") : ti("mw.a.96")}</button>
          </div>
        ) : null}
    </>
  );
  if (embedded) {
    return <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 14 }}>{panel}</div>;
  }
  return (
    <div className="amw-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div {...PARAM_FLOAT_PROPS} onClick={(e) => e.stopPropagation()} className="amw-float-panel" style={{ width: "min(620px, 100%)", maxHeight: "84dvh", padding: 14 }}>
        {panel}
      </div>
    </div>
  );
}

/** 👁 查看参数按钮：统一 SVG 眼 + ≥20px 点击区 + hover 底色（此前 12×12 裸 SVG，点击区过小且无反馈） */
function EyeBtn({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button title={title} aria-label={title}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 20,
        border: "none", borderRadius: 4, background: "none", cursor: "pointer", color: "var(--accent,#2563eb)",
        padding: 0, flexShrink: 0 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(37,99,235,.14)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}>
      <Ic size={13} paths={ICONS.eye} />
    </button>
  );
}

/** 步骤标题：数字徽标 + 短标题 +（次要提示与主标题分离，不再塞一长串进 heading）+ 右侧插槽 */
function StepHead({ n, title, hint, right }: { n: number | string; title: string; hint?: string; right?: any }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, margin: "16px 0 8px", minHeight: 24 }}>
      <span style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--accent,#2563eb)", color: "#fff", fontSize: 11, fontWeight: 700,
        display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{n}</span>
      <span style={{ fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{title}</span>
      {hint ? <span style={{ color: "var(--text-subtle,#999)", fontSize: 11, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</span> : null}
      {right ? <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>{right}</span> : null}
    </div>
  );
}

// ── provider/模型级请求头：行数组 ↔ 对象（空名/空值行不落盘；masked 行=打码回显未动，保存时服务端原值回填） ──
type HeaderRowUI = { k: string; v: string; masked?: boolean };
const headersToRows = (h: any): HeaderRowUI[] => Object.entries(h || {}).map(([k, v]) => ({ k, v: String(v) }));
const rowsToHeaders = (rows: HeaderRowUI[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) { const k = r.k.trim(); if (k && r.v.trim()) out[k] = r.v; }
  return out;
};
/** 请求头行编辑器（新增自定义 provider / 已配置编辑流共用）；masked 行编辑后自动去掉 masked。 */
function HeaderRowsEditor({ rows, onChange, hint }: { rows: HeaderRowUI[]; onChange: (rows: HeaderRowUI[]) => void; hint?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input className="amw-input" style={{ flex: 1, fontFamily: "ui-monospace,monospace" }} placeholder="Header-Name" value={r.k} readOnly={!!r.masked}
            title={r.masked ? ti("mw.a.97") : undefined}
            onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
          <input className="amw-input" style={{ flex: 1, fontFamily: "ui-monospace,monospace" }} placeholder={r.masked ? ti("mw.a.98") : "value"} value={r.v}
            title={r.masked ? ti("mw.a.99") : undefined}
            onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, k: x.k, v: e.target.value, masked: false } : x))} />
          <button className="amw-btn" style={{ padding: "2px 8px", color: "#dc2626" }} title={ti("mw.a.100")} onClick={() => onChange(rows.filter((_x, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="amw-btn" style={{ padding: "3px 12px", fontSize: 11, alignSelf: "flex-start" }} onClick={() => onChange([...rows, { k: "", v: "" }])}>{ti("mw.tx.31")}</button>
      {hint ? <div style={{ fontSize: 10.5, color: "var(--text-subtle,#777)" }}>{hint}</div> : null}
    </div>
  );
}
/** 已配置编辑流的 provider 请求头编辑器（决策 2B：打码回显）——初值来自 /status 的 headers/maskedHeaders；
 *  masked 行未动 → 值以掩码保留并在 maskedHeaders 名单里回传（服务端原值回填）。 */
function EditHeadersEditor({ initialHeaders, initialMasked, onChange }: {
  initialHeaders?: Record<string, string>;
  initialMasked?: string[];
  onChange: (headers: Record<string, string>, maskedHeaders: string[]) => void;
}) {
  const maskedSet = new Set(initialMasked || []);
  const [rows, setRows] = useState<HeaderRowUI[]>(() => headersToRows(initialHeaders).map((r) => maskedSet.has(r.k) ? { ...r, masked: true } : r));
  const apply = (next: HeaderRowUI[]) => {
    setRows(next);
    onChange(rowsToHeaders(next), next.filter((r) => r.masked && r.v.trim() && r.k.trim()).map((r) => r.k.trim()));
  };
  return (
    <>
      <HeaderRowsEditor rows={rows} onChange={apply} hint={ti("mw.a.101")} />
      <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, marginTop: 6 }} title={ti("mw.a.102")}
        onClick={() => apply([])}>{ti("mw.tx.32")}</button>
    </>
  );
}

export function App({ open, onClose, initialTab, initialProvider, embedded, variant, cwd }: { open: boolean; onClose: () => void; initialTab?: string; initialProvider?: string | null; embedded?: boolean; variant?: "float" | "settings"; cwd?: string | null }) {
  const isSettings = variant === "settings"; // 设置页签接管态：剥头部关闭按钮（外层设置面板有自己的 ✕）；cwd 供启用作用域（项目 scope）
  // C 阶段：tab 语义 = 主视图 + 当前打开的浮层（status=无浮层；add/subs/combo/check=对应浮层）。
  // 主视图恒为双栏（renderStatus）；旧页签内容全部转浮层，旧 setTab("combo") 等跳转语义自动变为「打开对应浮层」。
  const [tab, setTab] = useState(initialTab || "status");
  // 头部功能菜单（辅助操作弹出）：收纳全部功能切换，点外部/Esc 关闭
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);
  // 小屏（窄窗口）→ 全屏弹层：标题、tab 切换、关闭按钮常驻可见。
  // 根因：右下角锚定 bottom:70 + maxHeight:90vh 时，短视口会把 head 顶出可视区上方（title 消失、无法关闭/切换）。
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const upd = () => setSmall(mq.matches);
    upd();
    if (mq.addEventListener) mq.addEventListener("change", upd); else (mq as any).addListener(upd);
    return () => { if (mq.removeEventListener) mq.removeEventListener("change", upd); else (mq as any).removeListener(upd); };
  }, []);
  // 添加流
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any>(null);
  const [nativeProv, setNativeProv] = useState<any[] | null>(null); // pi 内置 provider（/api/auth/providers 的 apiKeyProviders，auth 声明动态读出）
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState<any>(null);            // 选中的 provider 卡
  const [searchDetect, setSearchDetect] = useState<any>(null);  // 反向命中项自动探测结果（搜索 tab）
  const [token, setToken] = useState("");
  // 订阅登录型（authType=oauth）：详情(ref) + SSE 登录流状态
  const [oauthLs, setOauthLs] = useState<any>({ phase: "idle" });
  const oauthEsRef = useRef<any>(null);
  // 订阅服务 tab：pi 运行时全部 OAuth provider（含扩展注册的）+ 展开中的登录面板
  const [subList, setSubList] = useState<any[] | null>(null);
  const [subActive, setSubActive] = useState<string | null>(null);
  const [keyRows, setKeyRows] = useState<any[]>([]);        // 多 key（可选）：[{name, key, rpm, minIntervalMs}]
  const [mkOpen, setMkOpen] = useState(false);              // multi-key card collapsed by default (declutter)
  const [regOpenId, setRegOpenId] = useState("");           // info-card register note expanded id (single-line ellipsis by default)
  const [keyTests, setKeyTests] = useState<any>({});        // 编辑流多 key 测试：provider → {busy, results?, error?}
  const [testRes, setTestRes] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [known, setKnown] = useState<string[]>([]);          // 可选模型
  const [checked, setChecked] = useState<string[]>([]);      // 已勾选模型 id
  const [discBusy, setDiscBusy] = useState(false); // 添加流：拉取 /models 中
  const [discMsg, setDiscMsg] = useState("");       // 添加流：拉取 /models 结果反馈
  const [modelFilter, setModelFilter] = useState(""); // 模型列表搜索过滤（只影响显示，勾选仍按全量）
  const [manual, setManual] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");       // 行内反馈消息（持续显示，手动点下次操作才清）
  const [missingInfo, setMissingInfo] = useState<any>(null);  // 缺参数的模型 {provider, models:[{id,name}]}（保存后弹 AI 助手补全）
  const rootRef = useRef<HTMLDivElement | null>(null);       // 向导弹窗根节点（ai-helper fill 回填定位 dialogEl 用）
  const [toast, setToast] = useState<any>(null);            // {msg, ok} 顶部覆盖层，自动 4s 消失
  const [reverseRes, setReverseRes] = useState<any>(null);  // URL 输入的自动反向匹配+探测结果 {candidates, detect, url, usedKey}
  const [probeKey, setProbeKey] = useState("");        // 带 key 重新探测的输入
  const [reprobing, setReprobing] = useState(false);
  const [provHeaders, setProvHeaders] = useState<HeaderRowUI[]>([]);   // 自定义 provider 请求头（新增流草稿）
  const [headersTouched, setHeadersTouched] = useState(false);         // 未动 = 保存/测试不传（避免覆盖同名已存头）
  const [customDetect, setCustomDetect] = useState<any>(null);         // 自定义面板「🔍 探测」结果
  const [customDetecting, setCustomDetecting] = useState(false);
  const [provNameTouched, setProvNameTouched] = useState(false);       // 名称被手改后不再跟随 baseUrl 自动生成
  const [rec, setRec] = useState<any>(null);                // 推荐提供商卡片（未搜索时展示）
  const [aff, setAff] = useState<any>(null);                // 厂商推广链接（affiliate 配置）
  const [st, setSt] = useState<any>(null);
  const [editTok, setEditTok] = useState<any>({});
  const [editModels, setEditModels] = useState<any>({});   // provider → 模型草稿数组（未展开时用 p.models）
  const [editFields, setEditFields] = useState<any>({});   // provider → { baseUrl?, api? } 字段草稿
  const [newModel, setNewModel] = useState("");       // 待添加模型 id 输入
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // 编辑流多 key 管理：provider → { list: [{name,key(masked),rpm,minIntervalMs}], show, newName, newKey, newRpm, newMiv, busy, error }
  const [editKeys, setEditKeys] = useState<any>({});
  const [cat, setCat] = useState<any>(null);
  const [provName, setProvName] = useState("");        // 添加流：provider 名（自动生成可改）
  const [saveDlg, setSaveDlg] = useState<any>(null);        // 保存确认弹窗 {name, baseUrl, api, modelCount}
  const [saveForce, setSaveForce] = useState(false);        // G3：「测试失败仍要保存」复选框（enabled:false 落盘）
  // P2-A 导入导出（G6）：{phase:"paste"|"preview", text, rows, errors, conflictCount, applying, result}
  const [impDlg, setImpDlg] = useState<any>(null);
  const [selNode, setSelNode] = useState<any>(null);               // B 阶段双栏：左树选中节点 { type: "provider"|"model", provider, id? }
  const [treeQ, setTreeQ] = useState("");                         // 左树搜索（多词 AND 匹配 provider/模型 id）
  // Provider row collapsed state (persisted in localStorage; default rule: collapse a provider holding more than 3 models, force-expand while searching or on selection).
  const [treeCollapsed, setTreeCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("pi:model-wizard:tree-collapsed") || "{}") || {}; } catch { return {}; }
  });
  const setTreeCollapsedP = (provider: string, collapsed: boolean) => {
    setTreeCollapsed((prev) => {
      const next = { ...prev, [provider]: collapsed };
      try { localStorage.setItem("pi:model-wizard:tree-collapsed", JSON.stringify(next)); } catch { /* storage blocked */ }
      return next;
    });
  };
  // status legend chips (footer bar): "" | ok | rl | bad | rt | untested; single-select toggle
  const [treeStatusFilter, setTreeStatusFilter] = useState("");
  const [editAvail, setEditAvail] = useState<any>({});      // provider → {models[], checked[]} 刷新出的可选模型
  const [availFilter, setAvailFilter] = useState<any>({});  // provider → 刷新列表搜索词
  const [refreshBusy, setRefreshBusy] = useState<any>({});  // provider → 刷新中
  const [newInfo, setNewInfo] = useState<any>(null);        // 新模型检测结果 {total, providers: {p:{count,newModels}}}
  const [nmSel, setNmSel] = useState<any>({});              // provider → 勾选的新模型 id 数组（缺省=全选）
  const [nmMeta, setNmMeta] = useState<any>({});            // provider → {id: 元数据}（modelParams 拉取，更多信息展示用）
  const [nmBusy, setNmBusy] = useState("");             // 正在一键启用的 provider
  const [chk, setChk] = useState<any>(null);                 // aiti-model-check 状态（已配置页卡片的状态概要来源）
  // 千/兆 token 数简写（ctx/out 标签用）。原版定义在 renderStatus 内——提升到 App 级，
  // renderEditControls 的「新」标 tags 也引用它（原版引用外层同名变量属潜在 ReferenceError，此处顺带修正）。
  const fmtTok = (n: number) => !n ? "" : n >= 1000000 ? (Math.round(n / 100000) / 10) + "M" : Math.round(n / 1000) + "k";

  const [checkAvail, setCheckAvail] = useState<boolean | null>(null); // null=加载中/未知, true=可用, false=未启用(aiti-model-check)
  const loadCheck = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/extensions/aiti-model-check/status"), { cache: "no-store" });
      if (!res.ok) { setCheckAvail(false); setChk(null); return; } // 404/5xx → 检查扩展未启用
      const d = srvFix(await res.json());
      setCheckAvail(true);
      setChk(d && d.state && d.models ? d : null);
    } catch { setCheckAvail(false); setChk(null); }
  }, []);
  // 运行期错误观测实时性（事件驱动零轮询）：向导打开期间订阅 aiti-model-check 的 availability SSE，
  // 代理真实流量出现 429（tailer 摄入）/探测/阻断标记变化都会推送 → 就地重拉 chk，树上 ⚡/状态点实时更新。
  // （连接为页面级单例，见 subscribeAvailabilityEvents——不再每实例独立建连）
  useEffect(() => {
    if (!open || checkAvail === false) return;
    return subscribeAvailabilityEvents(() => void loadCheck());
  }, [open, checkAvail, loadCheck]);
  // 运行期错误观测（带外）：state.runtimeErrors.models["provider/id"]——代理真实流量非 2xx/3xx（带 key 归因）
  const rtOf = useCallback((provider: string, id: string) => {
    const rt = chk && chk.state && chk.state.runtimeErrors;
    return rt && rt.models ? rt.models[provider + "/" + id] : null;
  }, [chk]);
  // 运行期错误主导类别：最近事件状态 → {icon,label,color,hot}；429=⚡限流 / 402=💸欠费 / 401=🔑key 无效 / ⛔无权限 / ⚠️服务端错 / 🔌网络错
  const rtErrInfo = useCallback((status: number): { icon: string; label: string; color: string } => {
    const s = Number(status) || 0;
    if (s === 429) return { icon: "⚡", label: ti("mw.a.103"), color: "#dc2626" };
    if (s === 402) return { icon: "💸", label: ti("mw.a.104"), color: "#dc2626" };
    if (s === 401) return { icon: "🔑", label: ti("mw.a.105"), color: "#dc2626" };
    if (s === 403) return { icon: "⛔", label: ti("mw.a.106"), color: "#dc2626" };
    if (s >= 500) return { icon: "⚠️", label: s === 502 || s === 504 ? ti("mw.a.107") : ti("mw.a.108"), color: "#d97706" };
    return { icon: "⚠️", label: s ? "HTTP " + s : ti("mw.a.69"), color: "#d97706" };
  }, []);
  const rtTip = useCallback((rt: any) =>
    ti("mw.a.109") + rt.count1h + ti("mw.a.110") + rt.count24h + ti("mw.a.111")
    + Object.entries(rt.byStatus || {}).map(([s, b]: any) => "\n  " + rtErrInfo(Number(s)).icon + " " + rtErrInfo(Number(s)).label + " ×" + b.count24h).join("")
    + (rt.lastAt ? ti("mw.a.112") + new Date(rt.lastAt).toLocaleString("zh-CN", { hour12: false }) + (rt.lastKey ? " · key " + rt.lastKey : "") : "")
    + ti("mw.a.113"), [rtErrInfo]);
  // 余额/欠费快照（aiti-model-check /balance，服务端 TTL 缓存；失效字段 exhausted 已内置欠费归一）
  const [bals, setBals] = useState<any>(null);
  const loadBalances = useCallback(async () => {
    try {
      const d = srvFix(await srvFix(await (await fetch(apiUrl("/api/extensions/aiti-model-check/balance"), { cache: "no-store" })).json()));
      if (d && d.ok) { const m: any = {}; for (const b of d.balances || []) m[b.provider] = b; setBals(m); }
    } catch { setBals(null); }
  }, []);
  // ── 一键体检 + 测试留存（P1-A）／ 余额健康条（P1-B）／ 设置面板（P1-C）2026-09-17 ──
  // last-test.json 的客户端缓存：provider → 最近一次向导测试结论（服务端打码）
  const [lastTestMap, setLastTestMap] = useState<any>({});
  const loadLastTest = useCallback(async () => {
    try { const d = srvFix(await (await api("/last-test")).json()); if (d && d.ok) setLastTestMap(d.providers || {}); } catch {}
  }, []);
  // 一键体检：null=未开过；{running} | {running:false, res}
  const [checkupSt, setCheckupSt] = useState<any>(null);
  const runCheckup = async () => {
    if (checkupSt && checkupSt.running) return;
    setCheckupSt({ running: true });
    try {
      const d = srvFix(await (await api("/checkup", { method: "POST", ...jsonBody({}) })).json());
      setCheckupSt({ running: false, res: d });
      if (d && d.ok) {
        setMsg(ti("mw.a.114") + d.pass + ti("mw.a.115") + (d.rateLimited || 0) + ti("mw.a.116") + (d.fail || 0) + ti("mw.a.29") + (d.skip ? " · " + d.skip + ti("mw.a.30") : ""));
        loadLastTest();
      } else setMsg(ti("mw.a.117") + ((d && d.error) || ""));
    } catch (e: any) { setCheckupSt({ running: false, res: null }); setMsg(ti("mw.a.117") + (e?.message || e)); }
  };
  // 余额健康条（aiti-provider-usage 服务，服务端软依赖）：provider → {phase, entry?, capturedAt?, error?}
  const [usageMap, setUsageMap] = useState<any>({});
  const loadUsage = useCallback(async (provider: string, force?: boolean) => {
    setUsageMap((prev: any) => ({ ...prev, [provider]: { phase: "loading" } }));
    try {
      const d = srvFix(await (await api("/usage?provider=" + encodeURIComponent(provider) + (force ? "&force=1" : ""))).json());
      if (!d || !d.ok) { setUsageMap((prev: any) => ({ ...prev, [provider]: { phase: "err", message: (d && d.error) || ti("mw.a.118") } })); return; }
      if (d.available === false) { setUsageMap((prev: any) => ({ ...prev, [provider]: { phase: "na" } })); return; }
      setUsageMap((prev: any) => ({ ...prev, [provider]: { phase: "ok", entry: d.entry, capturedAt: d.capturedAt, error: d.error } }));
    } catch (e: any) { setUsageMap((prev: any) => ({ ...prev, [provider]: { phase: "err", message: String(e.message || e) } })); }
  }, []);
  // 选中 provider 详情时按需拉余额（缺省不拉，避免面板打开就打 N 家查询；provider-usage 有 TTL 不算重）
  useEffect(() => {
    if (!open || !selNode || selNode.type !== "provider") return;
    const pp = (st?.providers || []).find((x: any) => x.provider === selNode.provider);
    if (pp && !pp.runtime && !pp.combo && pp.authType !== "oauth" && !usageMap[selNode.provider]) void loadUsage(selNode.provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selNode, st]);
  // 详情健康条「重测」：只传 provider，服务端用已存凭据兜底并自动留存结论
  const [quickTest, setQuickTest] = useState<any>({}); // provider → {busy, res?}
  const runQuickTest = async (p: any) => {
    const provider = p.provider;
    setQuickTest((prev: any) => ({ ...prev, [provider]: { busy: true } }));
    try {
      const body: any = { provider, baseUrl: p.baseUrl, api: p.api || "openai-completions", ...(p.keyCount > 1 ? { allKeys: true } : {}) };
      const d = srvFix(await (await api("/test", { method: "POST", ...jsonBody(body) })).json());
      setQuickTest((prev: any) => ({ ...prev, [provider]: { busy: false, res: d } }));
      loadLastTest();
    } catch (e: any) { setQuickTest((prev: any) => ({ ...prev, [provider]: { busy: false, res: { pass: false, error: String(e.message || e) } } })); }
  };
  // 订阅登出（P0-B）：provider → busy
  const [logoutBusy, setLogoutBusy] = useState<string>("");
  const doOauthLogout = async (pid: string, pname: string) => {
    const okr = await uiConfirm({ title: ti("mw.a.119") + (pname || pid) + "？", message: ti("mw.a.120"), danger: true, confirmText: ti("mw.a.121") });
    if (!okr) return;
    setLogoutBusy(pid);
    try {
      const d = srvFix(await (await api("/oauth-logout", { method: "POST", ...jsonBody({ provider: pid }) })).json());
      if (d && d.ok) {
        delete oauthInfoRef.current[pid];
        setSubActive(null);
        await loadSubs(); loadStatus();
        try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
        setToast({ msg: ti("mw.a.122") + (pname || pid), ok: true }); setTimeout(() => setToast(null), 4000);
      } else { setToast({ msg: ti("mw.a.123") + ((d && d.error) || ""), ok: false }); setTimeout(() => setToast(null), 5000); }
    } catch (e: any) { setToast({ msg: ti("mw.a.123") + (e?.message || e), ok: false }); setTimeout(() => setToast(null), 5000); }
    setLogoutBusy("");
  };
  // 设置面板（P1-C）：开关 + 组件自取 /config
  const [cfgOpen, setCfgOpen] = useState(false);
  // 可用性徽标（模型树上）：🟢 可用 / 🟠 限流 / 🔴 异常（可能欠费/失效）/ 无标 = 未测
  const [probeBusy, setProbeBusy] = useState<Record<string, boolean>>({}); // "provider" | "provider/model"
  const runCheck = async (provider: string, model?: string) => {
    const key = model ? provider + "/" + model : provider;
    setProbeBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const d = srvFix(await srvFix(await (await fetch(apiUrl("/api/extensions/aiti-model-check/probe"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(model ? { provider, model } : { provider }) })).json()));
      setMsg(d.ok ? ti("mw.a.124") + (d.probed ?? "?") + ti("mw.a.125") : ti("mw.a.65") + (d.error || ""));
      await loadCheck(); await loadBalances();
    } catch (e: any) { setMsg(ti("mw.a.65") + (e?.message || e)); }
    finally { setProbeBusy((prev) => { const n = { ...prev }; delete n[key]; return n; }); }
  };
  const checkDot = (provider: string, id: string) => {
    if (probeBusy[provider + "/" + id]) return <span style={{ fontSize: 9, color: "var(--warn, #f59e0b)", flexShrink: 0 }} title={ti("mw.a.126")}>⏳</span>;
    const ck = chk && chk.state && chk.state.models ? chk.state.models[provider + "/" + id] : null;
    const rt = rtOf(provider, id); // 运行期错误观测（带外）：真实流量出错，未探测也可能故障中
    const rtDot = rt && rt.count24h > 0 ? (
      <span style={{ fontSize: 9, color: rt.count1h > 0 ? "#dc2626" : "#d97706", flexShrink: 0, cursor: "default" }} title={rtTip(rt)}>{rtErrInfo(rt.lastStatus).icon}</span>
    ) : null;
    const dot = !ck ? null
      : ck.lastOk ? <span className="amw-vdot" style={{ background: "#16a34a" }} title={ti("mw.a.127")} />
      : ck.rateLimited ? <span className="amw-vdot" style={{ background: "var(--warn, #f59e0b)" }} title={ti("mw.a.128")} />
      : <span className="amw-vdot" style={{ background: "var(--danger, #ef4444)" }} title={ti("mw.a.129")} />;
    if (!dot && !rtDot) return null;
    return <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>{dot}{rtDot}</span>;
  };

  const loadNewInfo = useCallback(async () => {
    try { const d = srvFix(await (await api("/new-models")).json()); setNewInfo(d && d.ok ? d : null); } catch {}
  }, []);

  const ackNew = useCallback(async () => {
    try {
      const d = srvFix(await (await api("/new-models/ack", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json());
      if (d && d.ok) {
        setNewInfo((prev: any) => ({ ...(prev || {}), ok: true, scanning: false, total: d.total || 0, providers: d.providers || {} }));
        invalidateNewModels(); // 工具栏徽标同步消失
      }
    } catch {}
  }, []);

  // 新模型元数据（更多信息展示）：有新增时拉各 provider 的 modelParams
  useEffect(() => {
    if (!newInfo || !newInfo.total) return;
    let dead = false;
    (async () => {
      for (const name of Object.keys(newInfo.providers || {})) {
        try {
          const d = srvFix(await (await api("/modelParams?provider=" + encodeURIComponent(name))).json());
          if (dead || !d || !d.ok) continue;
          const map: any = {};
          for (const m of d.models || []) map[m.id] = m;
          setNmMeta((prev: any) => ({ ...prev, [name]: map }));
        } catch {}
      }
    })();
    return () => { dead = true; };
  }, [newInfo]);

  const loadStatus = useCallback(async () => {
    try { const d = srvFix(await (await api("/status")).json()); setSt(d); return d; } catch { return null; }
  }, []);
  // 刷新运行中代理：从 models.json 重新加载某 provider（或不传=全部）的槽位配置（多 key / 聚合改动后立即生效，不重启会话）
  const doRefreshProxies = useCallback(async (provider?: string) => {
    setBusy(true);
    try {
      const d = srvFix(await (await api("/refresh", { method: "POST", ...jsonBody(provider ? { provider } : {}) })).json());
      const names = ((d && d.refreshed) || []).length ? "：" + (d.refreshed || []).join(", ") : "";
      setToast({ msg: (d && d.ok ? ti("mw.a.130") : ti("mw.a.131") + ((d && d.error) || ti("mw.a.132"))) + (d && d.ok ? names : ""), ok: !!(d && d.ok) });
      setTimeout(() => setToast(null), 4000);
    } catch (e: any) {
      setToast({ msg: ti("mw.a.133") + ((e && e.message) || e), ok: false });
      setTimeout(() => setToast(null), 4000);
    }
    setBusy(false);
    loadStatus();
  }, [loadStatus]);
  // 临时禁用/启用单个模型（models.json 模型条目 enabled:false 标记，不删除；组合成员同步跳过）
  const doToggleModel = useCallback(async (provider: string, model: string, enabled: boolean) => {
    setBusy(true);
    try {
      const d = srvFix(await (await api("/model-enable", { method: "POST", ...jsonBody({ provider, model, enabled }) })).json());
      if (d.ok) {
        setToast({ msg: (enabled ? ti("mw.a.134") : ti("mw.a.135")) + provider + "/" + model + ti("mw.a.136"), ok: true });
        try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
        // 同步草稿缓存的 enabled 标记（若有缓存），详情面板视觉即时更新
        setEditModels((prev: any) => {
          const arr = prev[provider];
          if (!Array.isArray(arr)) return prev;
          return { ...prev, [provider]: arr.map((x: any) => (typeof x === "string" ? x : x.id) === model ? { id: model, enabled: !enabled } : x) };
        });
      } else setToast({ msg: "❌ " + (d.error || ti("mw.a.137")), ok: false });
      setTimeout(() => setToast(null), 4000);
    } catch (e: any) {
      setToast({ msg: ti("mw.a.138") + (e.message || e), ok: false });
      setTimeout(() => setToast(null), 4000);
    }
    setBusy(false);
    loadStatus();
  }, [loadStatus]);
  // 临时禁用/启用 provider（enabled:false 标记，不删除配置；立即停/建代理）
  const doToggleProvider = useCallback(async (provider: string, enabled: boolean) => {
    setBusy(true);
    try {
      const d = srvFix(await (await api("/enable", { method: "POST", ...jsonBody({ provider, enabled }) })).json());
      if (d.ok) {
        setToast({ msg: (enabled ? ti("mw.a.134") : ti("mw.a.135")) + provider + ti("mw.a.136"), ok: true });
        try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
      } else setToast({ msg: "❌ " + (d.error || ti("mw.a.137")), ok: false });
      setTimeout(() => setToast(null), 4000);
    } catch (e: any) {
      setToast({ msg: ti("mw.a.138") + (e.message || e), ok: false });
      setTimeout(() => setToast(null), 4000);
    }
    setBusy(false);
    loadStatus();
  }, [loadStatus]);
  // probe-cap（maxTokens 实测校正）："provider/id" → { phase: "probing"|"done", corrected? }（⏳/✓↓/! 徽标）
  const [capProbes, setCapProbes] = useState<any>({});
  const capProbesRef = useRef<any>({});
  useEffect(() => { capProbesRef.current = capProbes; }, [capProbes]);
  // 对刚保存的模型逐个实测上限；虚报被拒时服务端已直接回写 models.json → 刷新状态
  const runProbeCaps = useCallback(async (provider: string, ids: string[]) => {
    for (const id of ids) {
      if (!id || capProbesRef.current[provider + "/" + id]) continue;
      setCapProbes((prev: any) => ({ ...prev, [provider + "/" + id]: { phase: "probing" } }));
      try {
        const d = srvFix(await (await api("/probe-cap", { method: "POST", ...jsonBody({ provider, model: id }) })).json());
        setCapProbes((prev: any) => ({ ...prev, [provider + "/" + id]: d.ok && !d.skipped ? { phase: "done", corrected: !!d.corrected, detail: d.detail } : { phase: "done", skipped: true, detail: d.detail || d.error } }));
      } catch (e: any) {
        setCapProbes((prev: any) => ({ ...prev, [provider + "/" + id]: { phase: "done", error: String(e.message || e) } }));
      }
    }
    loadStatus(); // 校正已回写 models.json → 刷新卡片
  }, [loadStatus]);
  // 一级撤销：上次保存可回滚（保存成功后置位，撤销/新保存覆盖后失效）。
  // 另在进入「已配置」页时查一次 /undo-status：页面刷新后 in-session 状态丢了但服务端快照还在
  const [undoInfo, setUndoInfo] = useState<string | null>(null); // 提示文案（受影响 provider）
  useEffect(() => {
    if (tab !== "status" || undoInfo) return;
    api("/undo-status").then((r2) => srvFix(r2.json())).then((d) => {
      if (d && d.ok) setUndoInfo(ti("mw.a.139") + (d.providers || []).join(", ") + "）");
    }).catch(() => {});
  }, [tab, undoInfo]);
  const undoSave = useCallback(async () => {
    try {
      const d = srvFix(await (await api("/undo", { method: "POST" })).json());
      if (d.ok) { setUndoInfo(null); setMsg(ti("mw.a.140") + (d.restored || []).join(", ") + ti("mw.a.141")); loadStatus(); try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {} }
      else setMsg(ti("mw.a.142") + (d.error || ""));
    } catch (e: any) { setMsg(ti("mw.a.142") + (e.message || e)); }
  }, [loadStatus]);


  const enableNewModels = useCallback(async (prov: string, selIds: string[]) => {
    const p = st && st.providers.find((x: any) => x.provider === prov);
    if (!p) return;
    setNmBusy(prov);
    try {
      const merged = [...new Set([...(p.models || []), ...selIds])];
      const res = await api("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: prov, baseUrl: p.baseUrl, api: p.api, keepKey: true, models: merged }) });
      const d = srvFix(await res.json());
      if (d && d.ok) {
        const da = srvFix(await (await api("/new-models/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: prov, ids: selIds }) })).json());
        // 用 ack 响应（重算后的剩余待告知集）同步本地状态：已启用的模型从通知里移除，
        // 该 provider 无剩余新模型则整行消失，全部清完则横幅收起
        if (da && da.ok) setNewInfo((prev: any) => (prev ? { ...prev, total: da.total || 0, providers: da.providers || {} } : prev));
        // 清该 provider 的勾选残留：恢复「缺省=全选」语义，下次新模型到来时默认勾上
        setNmSel((prev: any) => { if (!(prov in prev)) return prev; const n = { ...prev }; delete n[prov]; return n; });
        invalidateNewModels();
        await Promise.all([loadStatus(), loadCheck()]);
        setMsg(ti("mw.a.143") + prov + ti("mw.a.144") + selIds.length + ti("mw.a.145"));
      } else setMsg(ti("mw.a.146") + ((d && d.error) || ""));
    } catch (e) { setMsg(ti("mw.a.146") + e); }
    setNmBusy("");
  }, [st, loadStatus, loadCheck]);

  // 忽略单个 provider 的新模型（其他 provider 下次继续展示）：按 provider+ids 定向 ack
  const ignoreNew = useCallback(async (prov: string) => {
    const v = newInfo && newInfo.providers && newInfo.providers[prov];
    const ids = (v && v.newModels) || [];
    if (!ids.length) return;
    try {
      const d = srvFix(await (await api("/new-models/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: prov, ids }) })).json());
      if (d && d.ok) {
        setNewInfo((prev: any) => (prev ? { ...prev, total: d.total || 0, providers: d.providers || {} } : prev));
        // 同上：忽略整批后清勾选残留，恢复缺省全选
        setNmSel((prev: any) => { if (!(prov in prev)) return prev; const n = { ...prev }; delete n[prov]; return n; });
        invalidateNewModels();
      }
    } catch {}
  }, [newInfo]);
  const loadCatalog = useCallback(async () => {
    try { const d = srvFix(await (await api("/catalog")).json()); setCat(d); } catch {}
  }, []);
  // 手动刷新 models.dev 目录（justget 官方+镜像竞速；服务端 single-flight 去重）→ 完成后重拉目录状态
  const [catRefreshing, setCatRefreshing] = useState(false);
  const [catMsg, setCatMsg] = useState("");
  const doRefreshCatalog = useCallback(async () => {
    setCatRefreshing(true); setCatMsg("");
    try {
      const r = srvFix(await (await api("/refresh-catalog", { method: "POST" })).json());
      if (!r.ok) throw new Error(r.error || ti("mw.a.147"));
      await loadCatalog();
      setCatMsg(ti("mw.a.148") + (r.providers ? " · " + r.providers + ti("mw.a.38") + Math.round((r.bytes || 0) / 1024) + "KB" : ""));
    } catch (e: any) { setCatMsg(ti("mw.a.131") + ((e && e.message) || e)); }
    finally { setCatRefreshing(false); }
  }, [loadCatalog]);
  // ── 浏览目录：全部 models.dev 提供商按名称首字符分组展开（models.dev 顶层即提供商、无更细分类），
  // 展开懒加载 /provider?id= 显示基本信息 + 已知模型清单，点「＋ 添加」进入接入流程 ──
  const [browse, setBrowse] = useState(false);
  const [browseQ, setBrowseQ] = useState("");
  const [browseOpen, setBrowseOpen] = useState<any>({});     // id → 是否展开
  const [browseDetail, setBrowseDetail] = useState<any>({}); // id → { loading? | error? | models:[{id,name}] }
  const browseGroups = () => {
    const kw = browseQ.trim().toLowerCase();
    const list = ((cat && cat.providers) || []).filter((p: any) => !kw
      || [p.name, p.cnName, p.id, p.baseUrl].some((s: any) => String(s || "").toLowerCase().includes(kw)));
    list.sort((x: any, y: any) => { const a = String(x.cnName || x.name || x.id), b = String(y.cnName || y.name || y.id); return a < b ? -1 : a > b ? 1 : 0; });
    const groups: any = {};
    for (const p of list) {
      const ch = String(p.name || p.id || "").trim().charAt(0).toUpperCase();
      const g = /[A-Z]/.test(ch) ? ch : "#";
      (groups[g] = groups[g] || []).push(p);
    }
    return Object.entries(groups).sort(([a], [b]: any) => (a === "#" ? 1 : b === "#" ? -1 : a < b ? -1 : 1));
  };
  const browseToggleProv = async (id: string) => {
    const opening = !browseOpen[id];
    setBrowseOpen((prev: any) => ({ ...prev, [id]: opening }));
    if (!opening || browseDetail[id]) return;
    setBrowseDetail((prev: any) => ({ ...prev, [id]: { loading: true } }));
    try {
      const d = srvFix(await (await api("/provider?id=" + encodeURIComponent(id))).json());
      setBrowseDetail((prev: any) => ({ ...prev, [id]: d && d.ok ? { models: (d.provider && d.provider.models) || [] } : { error: (d && d.error) || ti("mw.a.149") } }));
    } catch (e: any) { setBrowseDetail((prev: any) => ({ ...prev, [id]: { error: String(e.message || e) } })); }
  };
  const pickBrowse = (p: any) => {
    const det = browseDetail[p.id];
    pickProvider(det && det.models && det.models.length ? { ...p, models: det.models } : p);
  };
  // 查看某模型完整参数（models.json + 内置目录合并）→ 弹只读窗口；autoEdit=true 直接进编辑态（AI 补参数回填用）
  const [viewParam, setViewParam] = useState<any>(null); // { provider, id, params, baseUrl, api, readOnly, loading, error, autoEdit }
  const viewModelParams = useCallback(async (provider: string, id: string, autoEdit?: boolean, embedded?: boolean) => {
    setViewParam({ provider, id, params: null, loading: true, error: null, readOnly: false, autoEdit: !!autoEdit, embedded: !!embedded });
    try {
      const d = srvFix(await (await api("/modelParams?provider=" + encodeURIComponent(provider) + "&id=" + encodeURIComponent(id))).json());
      const found = d && d.models && d.models.find((m: any) => m.id === id);
      setViewParam({ provider, id, params: found || null, baseUrl: d && d.baseUrl, api: d && d.api, readOnly: !!(d && d.readOnly), crossFrom: d && d.crossFilled ? d.crossFilled[id] : undefined, loading: false, error: d && d.error, autoEdit: !!autoEdit, embedded: !!embedded });
    } catch (e: any) {
      setViewParam({ provider, id, params: null, loading: false, error: (e && e.message) || String(e), readOnly: false, autoEdit: !!autoEdit, embedded: !!embedded });
    }
  }, []);

  const loadRecommend = useCallback(async () => {
    try { const d = srvFix(await (await api("/recommend")).json()); setRec(d.cards || []); } catch {}
  }, []);
  // 推荐卡片选形态（如 ark 按量 / Coding 套餐）→ 直接进入 token 流程
  const loadAffiliate = useCallback(async () => {
    try { const d = srvFix(await (await api("/affiliate")).json()); setAff(d.items || {}); } catch {}
  }, []);
  const pickPlan = (pl: any) => {
    const p = pl.provider;
    setSel({ ...p, id: "plan-" + pl.id, name: p.name, cnName: p.cnName || "", baseUrl: p.baseUrl, apiType: p.apiType, doc: p.doc || "", signupUrl: p.signupUrl || "", tokenUrl: p.tokenUrl || "", register: p.register || "", models: p.models || [] });
    setToken(""); setTestRes(null); setChecked([]); setManual(""); setSavedMsg(""); setSearchDetect(null); setReverseRes(null);
    setKnown((p.models || []).map((m: any) => m.id));
    // declutter: no more guidance msg here (address/api live in the info card, actions live in step headings)
  };
  // 清空选择回到搜索/推荐（已选状态不再显示列表，避免无从配置）
  const resetSel = () => { setSel(null); setToken(""); setTestRes(null); setChecked([]); setManual(""); setModelFilter(""); setSavedMsg(""); setSearchDetect(null); setReverseRes(null); setResults(null); setProbeKey(""); setProvName(""); setSaveDlg(null); setMsg(""); setDiscMsg(""); setProvHeaders([]); setHeadersTouched(false); setCustomDetect(null); setProvNameTouched(false); };
  /** 进入自定义端面板（「＋ 自定义」按钮 / 列表末尾常驻卡共用；决策 1A：直接进面板）。
   *  初值：当前输入（URL 形态）或已有探测结果；全部字段可在面板里再改。 */
  const startCustom = () => {
    const raw = q.trim();
    const isUrl = /^https?:\/\//i.test(raw);
    const det = reverseRes && reverseRes.detect && reverseRes.detect.ok ? reverseRes.detect : null;
    const baseUrl = (det && (det.suggestedBaseUrl || det.baseUrl)) || (isUrl ? raw : "");
    const apiType = (det && det.api) || "openai-completions";
    setSel({ id: "custom", name: genName(baseUrl) || ti("mw.a.152"), cnName: "", baseUrl, apiType, doc: "", signupUrl: "", tokenUrl: "", register: "", models: [] });
    setToken(""); setTestRes(null); setChecked([]); setManual(""); setSavedMsg("");
    setKnown(det && det.models ? det.models.map((m: any) => m.id) : []);
    setProvName(genName(baseUrl) || "custom"); setProvNameTouched(false);
    setProvHeaders([]); setHeadersTouched(false); setCustomDetect(det ? { api: det.api, baseUrl: det.baseUrl, rawBaseUrl: det.rawBaseUrl, hint: det.hint } : null);
    setMsg(ti("mw.a.153") + (det ? ti("mw.a.154") : ""));
  };
  /** 自定义面板「🔍 探测」：带当前 token/请求头重探（探测链路透传 headers）。 */
  const detectCustom = async () => {
    const u = String((sel && sel.baseUrl) || "").trim();
    if (!u) return;
    setCustomDetecting(true); setCustomDetect(null);
    try {
      const d = srvFix(await (await api("/detect", { method: "POST", ...jsonBody({ baseUrl: u, apiKey: token || undefined, headers: rowsToHeaders(provHeaders) }) })).json());
      setCustomDetect(d.ok ? { api: d.api, baseUrl: d.baseUrl, rawBaseUrl: d.rawBaseUrl, hint: d.hint, providerGuess: d.providerGuess, models: d.models || null, modelCount: d.modelCount, modelsError: d.modelsError, brands: d.brands || [], openApi: d.openApi } : { error: d.hint || ti("mw.a.155") });
    } catch (e: any) { setCustomDetect({ error: String(e?.message || e) }); }
    setCustomDetecting(false);
  };
  const applyCustomDetect = () => {
    const d = customDetect;
    if (!d || d.error || !d.api) return;
    const base = d.baseUrl || (sel && sel.baseUrl);
    setSel((prev: any) => ({ ...prev, baseUrl: base, apiType: d.api }));
    if (d.models && d.models.length) setKnown((prev) => [...new Set([...prev, ...d.models.map((m: any) => m.id)])]);
    setMsg(ti("mw.a.156") + base + "（" + d.api + "）");
  };

  useEffect(() => { if (open) { loadStatus(); loadCatalog(); loadRecommend(); loadAffiliate(); loadNewInfo(); loadCheck(); loadBalances(); loadLastTest(); } }, [open, initialTab, loadStatus, loadCatalog, loadRecommend, loadAffiliate, loadNewInfo, loadCheck, loadBalances, loadLastTest]);
  // C4：openTab("status") 落地 —— 等 /status 与新模型检测就绪后，选中指定 provider 或首个有新模型的 provider（事件驱动，非轮询）
  const initSelDoneRef = useRef(false);
  useEffect(() => {
    if (!open) { initSelDoneRef.current = false; return; }
    if (initialTab !== "status" || initSelDoneRef.current) return;
    if (!st || !newInfo) return; // 就绪前不动作，就绪后一次性选中（不轮询）
    initSelDoneRef.current = true;
    const prov = initialProvider || Object.keys(newInfo.providers || {}).find((k: string) => newInfo.providers[k] && newInfo.providers[k].count > 0);
    if (prov && st.providers.some((x: any) => x.provider === prov)) selectNode({ type: "provider", provider: prov });
  }, [open, initialTab, initialProvider, st, newInfo]);
  // sel.baseUrl 变化 → 自动生成 provider 名（探测细化 /v1→/v3 时跟着更新；用户手改后不再覆盖）
  useEffect(() => {
    if (sel && sel.baseUrl && !provNameTouched) setProvName(genName(sel.baseUrl));
  }, [sel && sel.baseUrl, provNameTouched]);
  const normUrl = (u: string) => String(u || "").trim().toLowerCase().replace(/\/+$/, "");
  const doSearch = async (e?: any) => {
    if (e) e.preventDefault();
    const query = q.trim();
    if (!query) return;
    setSearching(true); setMsg(""); setResults(null); setSel(null); setTestRes(null); setSearchDetect(null); setReverseRes(null);
    let ranReverse = false;
    try {
      const d = srvFix(await (await api("/search?q=" + encodeURIComponent(query))).json());
      const res = d.results || [];
      // [native] pi 内置 provider（auth 声明，46+ 家：Bedrock/Azure/Cerebras/…）并入搜索结果：
      // 仅未配置的；目录已命中同 id 的不重复（目录版带完整预填与注册说明，优先）。
      try {
        let np = nativeProv;
        if (!np) {
          const ad = srvFix(await srvFix(await (await fetch(apiUrl("/api/auth/providers"), { cache: "no-store" })).json()));
          np = (ad.apiKeyProviders || []).map((p: any) => ({ id: p.id, name: p.displayName, cnName: "", modelCount: p.modelCount || 0, configured: !!p.configured, source: "native" }));
          setNativeProv(np);
        }
        const lq = query.trim().toLowerCase();
        const hitIds = new Set(res.map((r: any) => String(r.id).toLowerCase()));
        const extras = np.filter((p: any) => !p.configured && !hitIds.has(String(p.id).toLowerCase())
          && (!lq || String(p.id).toLowerCase().includes(lq) || String(p.name).toLowerCase().includes(lq)));
        if (extras.length) res.push(...extras.map((p: any) => ({ ...p, native: true })));
      } catch {}
      setResults(res);
      // 输入是 URL/域名：目录未 100% 精准命中 → 自动启动反向匹配 + 自动探测（两个结果一起输出）
      const isUrlLike = /^https?:\/\//i.test(query) || (/[a-z0-9.-]+\.[a-z]{2,}/i.test(query) && query.split(/\s+/).length === 1);
      if (isUrlLike) {
        const exact = res.some((r: any) => r.matchedBaseUrl && normUrl(r.matchedBaseUrl) === normUrl(query));
        if (!exact) { ranReverse = true; await autoReverse(query); }
      }
      if (!res.length && !ranReverse) setMsg(ti("mw.a.157"));
      else if (!res.length && ranReverse) setMsg(ti("mw.a.158"));
    } catch (e2: any) { setMsg(ti("mw.a.159") + (e2.message || e2)); }
    setSearching(false);
  };
  // URL 自动反向匹配 + 自动探测（并行）：目录候选 + 探测结果一起输出；无 key 时网关统一 401 无法
  // 区分真实路径 → 提示填 key 精探
  const autoReverse = async (query: string) => {
    try {
      const d = srvFix(await (await api("/reverse", { method: "POST", ...jsonBody({ baseUrl: query }) })).json());
      const item = (d.urls && d.urls[0]) || {};
      const res = { url: item.url || query, candidates: item.candidates || [], detect: item.detect || d.detect || null, usedKey: !!item.usedKey, probeModel: item.probeModel || "" };
      setReverseRes(res);
      if (res.detect && res.detect.ok) {
        const db = res.detect.suggestedBaseUrl || res.detect.baseUrl || query;
        const top = (res.candidates || [])[0];
        if (top && top.score >= 100) {
          // 目录精确命中（归一化含端点尾巴剥净后比对 100 分）→ 自动选中该品牌，不落「自定义」
          setSel({ id: top.id, name: top.name, cnName: top.cnName || "", baseUrl: db, apiType: res.detect.api, doc: top.doc || "", signupUrl: top.signupUrl || "", tokenUrl: top.tokenUrl || "", register: top.register || "", env: top.env || "", models: top.models || [] });
          setKnown([...new Set([...(top.models || []).map((m: any) => m.id || m), ...(res.detect.models || []).map((m: any) => m.id)])]);
          setMsg(ti("mw.a.160") + (top.cnName || top.name) + ti("mw.a.161") + db + "（api=" + res.detect.api + ti("mw.a.162"));
        } else {
          setSel({ id: "custom", name: ti("mw.a.163"), cnName: "", baseUrl: db, apiType: res.detect.api, doc: "", signupUrl: "", tokenUrl: "", register: "", models: [] });
          if (res.detect.models && res.detect.models.length) setKnown(res.detect.models.map((m: any) => m.id));
          setMsg(res.usedKey
            ? ti("mw.a.164") + db + "（api=" + res.detect.api + ti("mw.a.165")
            : ti("mw.a.166") + db + "（api=" + res.detect.api + ti("mw.a.167"));
        }
      } else {
        setMsg((res.detect && res.detect.hint) ? ti("mw.a.168") + String(res.detect.hint).slice(0, 90) : ti("mw.a.169"));
      }
    } catch (e2: any) { setMsg(ti("mw.a.170") + (e2.message || e2)); }
  };
  // 用户填 key 后重新反向匹配+探测（精准定位真实路径，如火山 api/plan → api/plan/v3）
  const doReverseWithKey = async () => {
    const key = probeKey.trim();
    if (!key || !reverseRes) return;
    setReprobing(true); setMsg("");
    try {
      const d = srvFix(await (await api("/reverse", { method: "POST", ...jsonBody({ baseUrl: reverseRes.url, apiKey: key }) })).json());
      const item = (d.urls && d.urls[0]) || {};
      const res = { url: item.url || reverseRes.url, candidates: item.candidates || [], detect: item.detect || d.detect || null, usedKey: true, probeModel: item.probeModel || "" };
      setReverseRes(res);
      if (res.detect && res.detect.ok) {
        const db = res.detect.suggestedBaseUrl || res.detect.baseUrl || reverseRes.url;
        const top = (res.candidates || [])[0];
        if (top && top.score >= 100) {
          // 同上：精确命中 → 切换到该品牌（保留用户已勾模型与已填 token）
          setSel((prev: any) => ({ ...(prev || {}), id: top.id, name: top.name, cnName: top.cnName || "", baseUrl: db, apiType: res.detect.api, doc: top.doc || "", signupUrl: top.signupUrl || "", tokenUrl: top.tokenUrl || "", register: top.register || "", env: top.env || "", models: top.models || [] }));
          setKnown((prev: any) => [...new Set([...prev, ...(top.models || []).map((m: any) => m.id || m), ...(res.detect.models || []).map((m: any) => m.id)])]);
          setMsg(ti("mw.a.171") + (top.cnName || top.name) + "」· " + db + "（" + res.detect.api + ti("mw.a.172"));
        } else {
          setSel((prev: any) => ({ ...(prev || {}), id: "custom", name: ti("mw.a.173"), cnName: "", baseUrl: db, apiType: res.detect.api, doc: "", signupUrl: "", tokenUrl: "", register: "", models: [] }));
          if (res.detect.models && res.detect.models.length) setKnown(res.detect.models.map((m: any) => m.id));
          setMsg(ti("mw.a.174") + db + "（" + res.detect.api + ti("mw.a.175"));
        }
      } else {
        setMsg((res.detect && res.detect.hint) ? ti("mw.a.176") + String(res.detect.hint).slice(0, 90) : ti("mw.a.177"));
      }
    } catch (e2: any) { setMsg(ti("mw.a.178") + (e2.message || e2)); }
    setReprobing(false);
  };
  // 应用自动探测结果（reverseRes）到 sel
  const applyReverseDetect = () => {
    const cd = reverseRes && reverseRes.detect;
    if (!cd || !cd.ok || !cd.api) return;
    const db = cd.suggestedBaseUrl || cd.baseUrl;
    setSel((prev: any) => ({ ...prev, baseUrl: db, apiType: cd.api }));
    if (cd.models && cd.models.length) setKnown(cd.models.map((m: any) => m.id));
    setMsg(ti("mw.a.156") + db + "（" + cd.api + ti("mw.a.179"));
  };
  const pickProvider = (p: any) => {
    if (p.native) {
      // pi 内置 provider：baseUrl 由用户按官方文档填（Bedrock/Azure 等端点形态特殊），
      // api 默认 openai-completions（可在详情改）；key 保存后模型清单由运行时自动加载。
      setSel({ id: p.id, name: p.name, cnName: "", baseUrl: "", apiType: "openai-completions", doc: p.doc || "", signupUrl: "", tokenUrl: "", register: "", models: [], native: true, modelCount: p.modelCount });
      setToken(""); setTestRes(null); setChecked([]); setManual(""); setSavedMsg(""); setSearchDetect(null); setDiscMsg("");
      setMsg(ti("mw.a.180"));
      return;
    }
    const base = p.reverseInputUrl || p.baseUrl;   // 反向命中 → 保留用户贴的地址（套餐防混，探测再权威确认）
    setSel({ ...p, baseUrl: base }); setToken(""); setTestRes(null); setChecked([]); setManual(""); setSavedMsg(""); setSearchDetect(null); setDiscMsg("");
    setKnown((p.models || []).map((m: any) => m.id));
    if (token) doDiscover(base, p.apiType, token);
    if (p.reverseInputUrl) doSearchDetect(p.reverseInputUrl);
  };
  const doSearchDetect = async (u: string) => {
    try {
      const d = srvFix(await (await api("/detect", { method: "POST", ...jsonBody({ baseUrl: u, apiKey: token || undefined }) })).json());
      setSearchDetect(d.ok ? { api: d.api, baseUrl: d.baseUrl, suggestedBaseUrl: d.suggestedBaseUrl, hint: d.hint, providerGuess: d.providerGuess, models: d.models || null, modelCount: d.modelCount, modelsError: d.modelsError, brands: d.brands || [], openApi: d.openApi } : { error: d.hint || ti("mw.a.155") });
    } catch (e2: any) { setSearchDetect({ error: String(e2.message || e2) }); }
  };
  const applySearchDetect = () => {
    const cd = searchDetect;
    if (!cd || cd.error || !cd.api) return;
    const db = cd.suggestedBaseUrl || cd.baseUrl;
    setSel((prev: any) => ({ ...prev, baseUrl: db, apiType: cd.api }));
    if (cd.models && cd.models.length) setKnown(cd.models.map((m: any) => m.id));
    setMsg(ti("mw.a.156") + db + "（" + cd.api + "）");
  };
  // 拉厂商 /models 实时列表合并进可选集（silent=true：测试连接通过后自动拉，不弹反馈）
  const doDiscover = async (baseUrl: string, apiType: string, key: string, silent?: boolean, headers?: Record<string, string>) => {
    if (!silent) { setDiscBusy(true); setDiscMsg(""); }
    try {
      const r = await api("/discover", { method: "POST", ...jsonBody({ baseUrl, api: apiType, apiKey: key, headers }) });
      const d = srvFix(await r.json());
      if (d.ok && d.models && d.models.length) {
        const ids = (sel && sel.models || []).map((m: any) => m.id);
        const before = known.length;
        const fresh = d.models.map((m: any) => m.id).filter((id: string) => !ids.includes(id));
        setKnown((prev) => { const all = [...ids, ...d.models.map((m: any) => m.id)]; return [...new Set(all)]; });
        if (!silent) setDiscMsg(ti("mw.a.181") + d.models.length + ti("mw.a.182") + fresh.length + ti("mw.a.183") + before + ti("mw.a.184"));
      } else if (!silent) setDiscMsg(ti("mw.a.185") + (d.error || ti("mw.a.186")));
      return d;
    } catch (e: any) { if (!silent) setDiscMsg(ti("mw.a.185") + (e.message || e)); return null; }
    finally { if (!silent) setDiscBusy(false); }
  };
  // 刷新模型（多 key 感知）：token + 多 key 行依次试，任一把成功即停；全部失败才报错
  const doDiscoverCreds = async (baseUrl: string, apiType: string, headers?: Record<string, string>) => {
    const creds = [token.trim(), ...keyRows.map((r) => (r.key || "").trim())].filter(Boolean);
    if (!creds.length) return;
    setDiscBusy(true); setDiscMsg("");
    let last: any = null;
    for (let i = 0; i < creds.length; i++) {
      last = await doDiscover(baseUrl, apiType, creds[i], true, headers);
      if (last && last.ok && last.models && last.models.length) {
        setDiscMsg(ti("mw.a.181") + last.models.length + ti("mw.a.187") + (i + 1) + ti("mw.a.188") + (creds.length > 1 ? ti("mw.a.189") + creds.length + ti("mw.a.190") : "") + ti("mw.a.191"));
        setDiscBusy(false);
        return;
      }
    }
    setDiscMsg(ti("mw.a.185") + ((last && last.error) || ti("mw.a.192")) + (creds.length > 1 ? ti("mw.a.193") + creds.length + ti("mw.a.194") : ti("mw.a.195")));
    setDiscBusy(false);
  };
  const doTest = async (baseUrl: string, apiType: string, key: string, model?: string | null, headers?: Record<string, string>) => {
    setTesting(true); setTestRes(null); setSavedMsg("");
    try {
      const r = await api("/test", { method: "POST", ...jsonBody({ baseUrl, api: apiType, apiKey: key, model: model || null, headers }) });
      const d = srvFix(await r.json());
      // 通过即尝试拉模型列表：无已知模型（model=null）时也必须拉，否则用户只能一个个手动输入。
      // （此前仅当 model 非空才 discover —— URL 探测无 key 时 known 为空 → model=null → 模型永远不加载）
      if (d.pass && d.status !== 429) doDiscover(baseUrl, apiType, key, true, headers);
      setTestRes(d);
    } catch (e: any) { setTestRes({ pass: false, detail: ti("mw.a.196") + (e.message || e) }); }
    setTesting(false);
  };
  // 凭据测试：顶部 token + 多 key 行合并成一次分 key 测试（只填 token 或只填行都能测）；
  // 单凭据走原单测路径（带 model 探针），多凭据用 /test 的 keys 数组逐个串行测；任一通过即用那把 key 拉模型列表
  const doTestCreds = async (baseUrl: string, apiType: string, headers?: Record<string, string>) => {
    const rows = [
      ...(token.trim() ? [{ name: "token", key: token.trim() }] : []),
      ...keyRows.map((r, i) => ({ name: (r.name || "").trim() || "key-" + (i + 1), key: (r.key || "").trim() })).filter((k) => k.key),
    ];
    if (!rows.length) return;
    if (rows.length === 1) { await doTest(baseUrl, apiType, rows[0].key, known[0] || null, headers); return; }
    setTesting(true); setTestRes(null); setSavedMsg("");
    try {
      const d = srvFix(await (await api("/test", { method: "POST", ...jsonBody({ baseUrl, api: apiType, keys: rows, headers }) })).json());
      setTestRes(d);
      const okRow = (d.results || []).map((x: any, i: number) => ({ ...x, raw: rows[i] && rows[i].key })).find((x: any) => x.pass);
      if (okRow) doDiscover(baseUrl, apiType, okRow.raw, true, headers);
    } catch (e: any) { setTestRes({ pass: false, detail: ti("mw.a.196") + (e.message || e) }); }
    setTesting(false);
  };
  const toggleModel = (id: string) => {
    setChecked((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };
  // 模型列表搜索过滤（大小写不敏感子串；多个空格分词 AND 匹配；空 = 全部）+ 按版本从高到低（deepseek-v4 在 deepseek-v3 前）
  const filteredModels = () => {
    const kw = modelFilter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = kw.length ? known.filter((id) => kw.every((k) => id.toLowerCase().includes(k))) : known.slice();
    return list.sort(cmpModel);
  };
  const addManual = () => {
    const ids = manual.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return;
    setKnown((prev) => [...new Set([...prev, ...ids])]);
    setChecked((prev) => [...new Set([...prev, ...ids])]);
    setManual("");
  };
  const doSave = async (provider: string, baseUrl: string, apiType: string, key: string, keepKey: boolean, enabled?: boolean) => {
    setSaving(true); setSavedMsg(""); setToast(null);
    const models = checked.map((id) => ({ id }));
    const body: any = { provider, baseUrl, api: apiType, models, keepKey: !!keepKey };
    // G3 保存闸门：显式 false =「测试失败仍要保存」→ 服务端落 enabled:false（禁用态）
    if (enabled === false) body.enabled = false;
    // 自定义端点的 provider 级请求头（未动则不发，避免覆盖同名已存头；决策 2B/3B）
    if (headersTouched && sel && sel.id === "custom") body.headers = rowsToHeaders(provHeaders);
    if (key) body.apiKey = key;
    // 多 key（可选）：有合法 key 的行 → 随 provider 写进 models.json 的 apiKeys（名字自动补全）
    const validKeys = keyRows.map((r, i) => ({ name: (r.name || "").trim() || "key-" + (i + 1), key: (r.key || "").trim(), rpm: r.rpm ? Math.max(1, Math.floor(Number(r.rpm) || 0)) : undefined, minIntervalMs: mivNorm(r.minIntervalMs) })).filter((k) => k.key);
    if (validKeys.length) body.keys = validKeys;
    try {
      const r = await api("/save", { method: "POST", ...jsonBody(body) });
      const d = srvFix(await r.json());
      if (d.ok) {
        const fillTxt = summarizeFills(d.fills);
        const miss = Array.isArray(d.missingParams) ? d.missingParams.filter((m: any) => m && m.id) : [];
        const okMsg = ti("mw.a.197") + d.provider + " · " + d.modelCount + ti("mw.a.198") + (fillTxt ? " · " + fillTxt : "") + (miss.length ? " · ⚠️ " + miss.length + ti("mw.a.199") : "");
        setSavedMsg(okMsg);
        setToast({ msg: okMsg + ti("mw.a.200"), ok: true });
        setTimeout(() => setToast(null), 4000);
        setUndoInfo(d.undoable ? (ti("mw.a.201") + d.provider + "」") : null);
        // 缺参数的模型（所有源都查不到，被落裸条目）→ 自动弹 ai-helper（model-params-fill skill 预选 + 提示词预填），
        // 让用户点击让 AI 上网查权威数据 → 写 models-store.json → 回填参数弹窗；同时打开第一个缺参模型参数弹窗（编辑态）供回填
        if (miss.length) {
          setMissingInfo({ provider: d.provider, models: miss });
          const first = miss[0];
          setTimeout(() => {
            if (first) void viewModelParams(d.provider, first.id, true);
            invokeAiHelperForMissing(d.provider, miss, rootRef.current);
          }, 250);
        } else setMissingInfo(null);
        loadStatus();
        loadNewInfo();
        // maxTokens 实测校正（#4）：对刚保存的模型逐个发最小探针，虚报被拒时服务端自动回写真实上限
        void runProbeCaps(d.provider, checked);
        try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
        // 双栏收尾：关闭添加浮层回主视图，选中新建的 provider（st 刷新后详情自动就位）
        setTab("status");
        selectNode({ type: "provider", provider: d.provider });
      } else {
        const err = ti("mw.a.202") + (d.error || ti("mw.a.132"));
        setSavedMsg(err);
        setToast({ msg: err, ok: false });
      }
    } catch (e: any) {
      const err = ti("mw.a.202") + (e.message || e);
      setSavedMsg(err);
      setToast({ msg: err, ok: false });
    }
    setSaving(false);
  };

  const doDelete = async (provider: string) => {
    if (!(await uiConfirm({ message: ti("mw.a.203") + provider + "？", danger: true }))) return;
    setBusy(true); setMsg("");
    try {
      const d = srvFix(await (await api("/delete", { method: "POST", ...jsonBody({ provider }) })).json());
      setMsg(d.ok ? ti("mw.a.204") + provider : ti("mw.a.205") + (d.error || ""));
      if (d.ok && selNode && selNode.provider === provider) setSelNode(null); // 双栏：删中的 provider 清空选中
      loadStatus();
      loadNewInfo();
      try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
    } catch (e: any) { setMsg(ti("mw.a.206") + (e.message || e)); }
    setBusy(false);
  };
  const doSaveEdit = async (provider: string, p: any) => {
    setBusy(true); setMsg("");
    const newTok = (editTok[provider] || "").trim();
    const f = editFields[provider] || {};
    // 新 provider 名：草稿有 name 用草稿（可改名），否则原 provider 名
    const newName = (f.name !== undefined && String(f.name).trim()) ? String(f.name).trim() : provider;
    // 模型：刷新出的可选列表（checked）优先；其次展开编辑过的草稿（replaceModels）；否则沿用现有
    const avail = editAvail[provider];
    const draft = editModels[provider];
    let models: any[], replaced = false;
    let listExtras: any[] = [];
    if (avail) {
      // 厂商 /models 富字段（discoverStored 返回的 contextWindow/maxTokens）作为独立反填源透传，
      // 不塞进 models（保持 incoming 干净，服务端优先级：existing > store > listExtras > md > 兜底）
      const byId = new Map((avail.objs || []).map((o: any) => [o.id, o]));
      models = avail.checked.map((id: string) => {
        const o = byId.get(id);
        if (o && (o.contextWindow || o.maxTokens)) listExtras.push({ id, contextWindow: o.contextWindow, maxTokens: o.maxTokens });
        return { id };
      });
      replaced = true;
    }
    else if (Array.isArray(draft)) { models = draft.map((m: any) => ({ id: typeof m === "string" ? m : m.id })); replaced = true; }
    else { models = (p.models || []).map((m: any) => ({ id: typeof m === "string" ? m : m.id })); }
    // 保留已配置模型的临时禁用标记（独立 /model-enable 设置的 enabled:false 不被整存清除）
    const disabledMap = new Map((p.models || []).filter((m: any) => m && typeof m === "object" && m.enabled === false).map((m: any) => [String(m.id), true]));
    if (disabledMap.size) models = models.map((m: any) => (disabledMap.has(String(m.id)) ? { ...m, enabled: false } : m));
    // 字段：展开编辑过则用草稿（回退现有），否则原值
    const hdrDraft = (editFields[provider] || {}).headers; // provider 级请求头草稿（undefined=未动，保留旧值）
    const hdrMasked = (editFields[provider] || {}).headersMasked; // 打码回显名字清单（未动行由服务端原值回填，决策 2B）
    // ⚠️ 注意：这里不能用 `api` 作局部变量名——会遮蔽外层 fetch 助手 api()，
    // 导致保存时 "api is not a function"（已配置→编辑→保存 全部失败）。用 apiType。
    const baseUrl = (f.baseUrl !== undefined ? f.baseUrl : p.baseUrl || "").replace(/\/+$/, "");
    const apiType = f.api !== undefined ? f.api : (p.api || "openai-completions");
    try {
      const d = srvFix(await (await api("/save", { method: "POST", ...jsonBody({ provider: newName, renameFrom: provider, baseUrl, api: apiType, keepKey: !newTok, models, replaceModels: replaced, ...(hdrDraft ? { headers: hdrDraft, ...(Array.isArray(hdrMasked) ? { maskedHeaders: hdrMasked } : {}) } : {}), ...(listExtras.length ? { listExtras } : {}), ...(newTok ? { apiKey: newTok } : {}) }) })).json());
      setMsg(d.ok ? ti("mw.a.197") + newName + "（" + models.length + ti("mw.a.207") + (newTok ? ti("mw.a.208") : "") + (newName !== provider ? ti("mw.a.209") + provider + ti("mw.a.210") : "") + (summarizeFills(d.fills) ? " · " + summarizeFills(d.fills) : "") + "）" : ti("mw.a.205") + (d.error || ""));
      if (d.ok) {
        setUndoInfo(ti("mw.a.211") + newName + "」");
        const ids = models.map((m: any) => m.id);
        if (replaced && ids.length) void runProbeCaps(newName, ids); // 新勾选的模型实测上限
        // G6 改名跟随：enabledModels 模式同步重写（宿主 resync op；失败静默不阻塞改名主流程）
        if (newName !== provider) void resyncEnabledModels([{ from: provider, to: newName }], cwd ?? null);
        // 缺参数模型 → 自动弹 ai-helper 补全（同 doSave）
        const miss = Array.isArray(d.missingParams) ? d.missingParams.filter((m: any) => m && m.id) : [];
        if (miss.length) {
          setMissingInfo({ provider: newName, models: miss });
          const first = miss[0];
          setTimeout(() => {
            if (first) void viewModelParams(newName, first.id, true);
            invokeAiHelperForMissing(newName, miss, rootRef.current);
          }, 250);
        } else setMissingInfo(null); // 无缺参 → 清残留 banner（与 doSave 对称）
      }
      setEditTok((prev: any) => ({ ...prev, [provider]: "" }));
      if (replaced) setEditModels((prev: any) => ({ ...prev, [provider]: models.map((m: any) => m.id) }));
      setEditAvail((prev: any) => { const { [provider]: _drop, ...rest } = prev; return rest; });
      // 改名后同步左树选中到新名（双栏选中跟随）
      setSelNode((prev: any) => (prev && prev.provider === provider ? { ...prev, provider: newName } : prev));
      loadStatus();
      loadNewInfo();
      invalidateNewModels(); // 工具栏徽标同步（新模型已配置 → 待告知集减少）
      try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
    } catch (e: any) { setMsg(ti("mw.a.202") + (e.message || e)); }
    setBusy(false);
  };
  // 首次增删时草稿尚未初始化，必须沿用界面显示的现有模型；空草稿则表示用户已清空，不可回退。
  const removeEditModel = (provider: string, id: string, currentModels: any[]) => {
    setEditModels((prev: any) => ({ ...prev, [provider]: (prev[provider] ?? currentModels ?? []).filter((x: any) => (typeof x === "string" ? x : x.id) !== id) }));
  };
  const addEditModel = (provider: string, currentModels: any[]) => {
    const ids = newModel.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return;
    setEditModels((prev: any) => {
      const current = prev[provider] ?? currentModels ?? [];
      const existingIds = new Set(current.map((m: any) => typeof m === "string" ? m : m.id));
      return { ...prev, [provider]: [...current, ...[...new Set(ids)].filter((id) => !existingIds.has(id))] };
    });
    setNewModel("");
  };
  // 编辑流：用存储 key（或刚填的新 key）刷新可选模型列表，勾选后保存
  const refreshEditModels = async (provider: string, p: any) => {
    setRefreshBusy((prev: any) => ({ ...prev, [provider]: true })); setMsg("");
    try {
      const d = srvFix(await (await api("/discoverStored", { method: "POST", ...jsonBody({ provider, apiKey: (editTok[provider] || "").trim() || undefined, headers: (editFields[provider] || {}).headers, maskedHeaders: (editFields[provider] || {}).headersMasked }) })).json());
      if (d.ok && d.models && d.models.length) {
        const cur = ((editModels[provider] ?? p.models) || []).map((m: any) => (typeof m === "string" ? m : m.id));
        const available = d.models.map((m: any) => m.id);
        // 新模型检测：相对前日基线新增且未配置的模型 → 自动预勾选（用户点保存即直接启用）
        const newOnes = Array.isArray(d.newModels) ? d.newModels : [];
        const curChecked = [...new Set([...cur.filter((id: string) => available.includes(id)), ...newOnes])];
        setEditAvail((prev: any) => ({ ...prev, [provider]: { models: available, objs: d.models, checked: curChecked, newModels: newOnes } }));
        setAvailFilter((prev: any) => ({ ...prev, [provider]: "" }));
        setMsg(newOnes.length
          ? ti("mw.a.212") + available.length + ti("mw.a.213") + newOnes.length + ti("mw.a.214")
          : ti("mw.a.212") + available.length + ti("mw.a.215") + curChecked.length + ti("mw.a.216"));
      } else setMsg(ti("mw.a.217") + (d.error || ""));
    } catch (e: any) { setMsg(ti("mw.a.217") + (e.message || e)); }
    setRefreshBusy((prev: any) => ({ ...prev, [provider]: false }));
  };
  const toggleEditAvail = (provider: string, id: string) => {
    setEditAvail((prev: any) => {
      const av = prev[provider]; if (!av) return prev;
      const has = av.checked.includes(id);
      return { ...prev, [provider]: { ...av, checked: has ? av.checked.filter((x: string) => x !== id) : [...av.checked, id] } };
    });
  };
  const editAvailList = (provider: string) => {
    const av = editAvail[provider]; if (!av) return [];
    const kw = (availFilter[provider] || "").trim().toLowerCase();
    const list = kw ? av.models.filter((id: string) => id.toLowerCase().includes(kw)) : av.models;
    // 新识别的模型排最前（保持其余相对顺序）
    const nw = av.newModels || [];
    return [...list].sort((x: string, y: string) => (nw.includes(y) ? 1 : 0) - (nw.includes(x) ? 1 : 0));
  };
  // ── 一键整理（来自 aiti-model-check「🛠 一键编辑」按钮）────────────────────────────
  // 语义：按探测结果预选每家 provider 的模型勾选列表——硬性异常（key 不对/欠费/无权限/不存在/地区限制）
  // 取消勾选（保存即从 models.json 删除），可用/限流/未测/暂时性错误保留。用户核对后点保存才生效：
  // 复用「刷新可选模型」的 editAvail 勾选 UI 与 doSaveEdit 保存链路（写 models.json + 刷新代理，立即生效）。
  const [cleanupEdit, setCleanupEdit] = useState<any>(null); // {ts, plan:[{provider,keep,remove,soft,skip?,saved?}]}
  const [cleanupBusy, setCleanupBusy] = useState<any>(null); // {cur, done, total} 逐家保存进行中
  const applyCleanupEdit = (payload: any) => {
    if (!st) return; // st 未就绪（理论上信箱消费已守卫；双保险）
    const statuses = (payload && payload.statuses) || {};
    const plan: any[] = [];
    for (const p of st.providers || []) {
      if (p.combo) { plan.push({ provider: p.provider, keep: [], remove: [], soft: [], skip: "combo" }); continue; }
      if (p.authType === "oauth") { plan.push({ provider: p.provider, keep: [], remove: [], soft: [], skip: "oauth" }); continue; }
      if (p.runtime) { plan.push({ provider: p.provider, keep: [], remove: [], soft: [], skip: "runtime" }); continue; }
      const ids = (p.models || []).map((m: any) => (typeof m === "string" ? m : m.id));
      const keep: string[] = [], remove: any[] = [], soft: any[] = [];
      for (const id of ids) {
        const info = statuses[p.provider + "/" + id];
        if (info && info.s === "err" && CLEANUP_HARD_FAIL_KINDS.includes(info.kind)) remove.push({ id, label: info.label || ti("mw.a.69") });
        else if (info && info.s === "err") soft.push({ id, label: info.label || ti("mw.a.69") }); // transient errors (5xx/network/timeout) -> keep but warn
        else keep.push(id);
      }
      plan.push({ provider: p.provider, keep, remove, soft });
    }
    setCleanupEdit({ ts: (payload && payload.ts) || Date.now(), plan });
    setTab("status"); setMsg("");
    // 预填各 provider 勾选列表（editAvail 与「刷新可选模型」同一结构 → 编辑区直接呈现勾选框）
    setEditAvail((prev: any) => {
      const next = { ...prev };
      for (const e of plan) {
        if (e.skip) continue;
        const p = (st.providers || []).find((x: any) => x.provider === e.provider);
        const ids = ((p && p.models) || []).map((m: any) => (typeof m === "string" ? m : m.id));
        next[e.provider] = { models: ids, objs: [], checked: e.keep.slice(), newModels: [] };
      }
      return next;
    });
    const nRemove = plan.reduce((s: number, e: any) => s + (e.remove || []).length, 0);
    setMsg(nRemove
      ? ti("mw.a.218") + nRemove + ti("mw.a.219")
      : ti("mw.a.220"));
  };
  // 有改动的家数（预选了移除且仍有保留、尚未保存）——「全部保存」按钮文案与可用性
  const cleanupPending = cleanupEdit ? cleanupEdit.plan.filter((e: any) => !e.skip && !e.saved && e.remove.length && e.keep.length) : [];
  const cleanupSaveOne = async (e: any) => {
    const p = st && (st.providers || []).find((x: any) => x.provider === e.provider);
    if (!p) return;
    setCleanupBusy({ cur: e.provider, done: 0, total: 1 });
    await doSaveEdit(e.provider, p);
    setCleanupBusy(null);
    setCleanupEdit((prev: any) => prev && ({ ...prev, plan: prev.plan.map((x: any) => (x.provider === e.provider ? { ...x, remove: [], soft: [], saved: true } : x)) }));
  };
  const cleanupSaveAll = async () => {
    if (!cleanupEdit || !st || !cleanupPending.length) return;
    const targets = cleanupPending.slice();
    setCleanupBusy({ cur: targets[0].provider, done: 0, total: targets.length });
    let removed = 0;
    for (let i = 0; i < targets.length; i++) {
      const e = targets[i];
      const p = (st.providers || []).find((x: any) => x.provider === e.provider);
      if (!p) continue;
      setCleanupBusy({ cur: e.provider, done: i, total: targets.length });
      await doSaveEdit(e.provider, p);
      removed += e.remove.length;
    }
    setCleanupBusy(null);
    setCleanupEdit(null);
    setToast({ msg: ti("mw.a.221") + targets.length + ti("mw.a.222") + removed + ti("mw.a.223"), ok: true });
    setTimeout(() => setToast(null), 6000);
  };
  const cleanupCancel = () => {
    setCleanupEdit(null);
    // 仅清理本次预填产生的勾选草稿（用户已自己「刷新可选模型」的列表无法区分，一并清除——取消即放弃未保存改动）
    if (cleanupEdit) setEditAvail((prev: any) => {
      const next = { ...prev };
      for (const e of cleanupEdit.plan) { if (!e.skip) delete next[e.provider]; }
      return next;
    });
    setMsg(ti("mw.a.224"));
  };
  // 独立路径消费：检查面板 deposit（services 信箱 / window.__aitiModelWizardCleanupEdit 双轨）+ openTab("status")
  // → App 就绪（st 加载完）后应用。（内嵌模式不走信箱：检查 tab 经 onCleanupEdit 回调直呼 applyCleanupEdit）
  useEffect(() => {
    if (!open || !st) return;
    const g = cleanupEditMailbox ?? window.__aitiModelWizardCleanupEdit;
    if (!g) return;
    cleanupEditMailbox = null;
    delete window.__aitiModelWizardCleanupEdit;
    try { applyCleanupEdit(g); } catch (e) { console.error(ti("mw.a.225"), e); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, st, initialTab]);
  // 👁 模型参数查看入口（供 aiti-model-check「眼睛」等外部复用）：App 挂载期间有效，
  // 调用即弹本面板的模型参数浮窗（查看/编辑）；未挂载时调用方回退自身信息弹层。
  useEffect(() => {
    if (!open) return;
    window.__aitiModelWizardViewParams = (provider: string, id: string) => { void viewModelParams(provider, id); };
    const d = regSvc("aiti-model-wizard.viewParams", window.__aitiModelWizardViewParams); // DI 方案 P2 双轨
    return () => { try { d?.(); } catch {} delete window.__aitiModelWizardViewParams; };
  }, [open, viewModelParams]);
  // ── 编辑流多 key 管理（复用后端 /keys 端点：list 打码 / add 增量 / remove 按名）──
  // 多 key 连接测试：用 models.json 已存全部 key 逐个串行测（不只用第一个），返回每 key 一条结果
  const doTestStored = async (p: any) => {
    const prov = p.provider;
    const f = editFields[prov] || {};
    const baseUrl = String(f.baseUrl !== undefined ? f.baseUrl : p.baseUrl || "").replace(/\/+$/, "");
    const apiType = String(f.api !== undefined ? f.api : p.api || "openai-completions");
    setKeyTests((prev: any) => ({ ...prev, [prov]: { busy: true } }));
    try {
      const d = srvFix(await (await api("/test", { method: "POST", ...jsonBody({ baseUrl, api: apiType, provider: prov, allKeys: true, headers: (editFields[prov] || {}).headers, maskedHeaders: (editFields[prov] || {}).headersMasked }) })).json());
      if (!d.ok && !d.results) setKeyTests((prev: any) => ({ ...prev, [prov]: { busy: false, error: d.error || d.detail || ti("mw.a.226") } }));
      else setKeyTests((prev: any) => ({ ...prev, [prov]: { busy: false, results: d.results || [], passCount: d.passCount, total: d.total } }));
    } catch (e: any) { setKeyTests((prev: any) => ({ ...prev, [prov]: { busy: false, error: (e && e.message) || String(e) } })); }
  };
  const editKeysInit = (provider: string, keys: any[]) => {
    const cur = editKeys[provider];
    setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(cur || {}), list: keys, error: "" } }));
  };
  const loadEditKeys = async (provider: string) => {
    setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: true, error: "" } }));
    try {
      const d = srvFix(await (await api("/keys?provider=" + encodeURIComponent(provider))).json());
      setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), list: (d && d.keys) || [], busy: false, error: "" } }));
      return d && d.keys ? d.keys : [];
    } catch (e: any) { setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (e && e.message) || String(e) } })); return []; }
  };
  const editKeyAdd = async (provider: string) => {
    const e = editKeys[provider] || {};
    const name = (e.newName || "").trim() || "key-" + ((e.list || []).length + 1);
    const key = (e.newKey || "").trim();
    if (!key) return;
    setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: true, error: "" } }));
    try {
      const d = srvFix(await (await api("/keys", { method: "POST", ...jsonBody({ provider, action: "add", name, key, rpm: e.newRpm, minIntervalMs: mivNorm(e.newMiv) }) })).json());
      if (d && d.ok) {
        await loadEditKeys(provider);
        setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), newName: "", newKey: "", newRpm: "", newMiv: "", busy: false } }));
        loadStatus();
      } else { setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (d && d.error) || ti("mw.a.227") } })); }
    } catch (e: any) { setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (e && e.message) || String(e) } })); }
  };
  const editKeySave = async (provider: string, k: any) => {
    const e0 = editKeys[provider] || {};
    const row = (e0.rows || {})[k.name] || {};
    const newName = (row.name || "").trim();
    const newKey = (row.key || "").trim();
    const rpm = row.rpm !== undefined ? String(row.rpm).trim() : undefined;
    const miv = row.minIntervalMs !== undefined ? String(row.minIntervalMs).trim() : undefined;
    if (!newName && !newKey && rpm === undefined && miv === undefined) return;
    setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: true, error: "" } }));
    try {
      const d = srvFix(await (await api("/keys", { method: "POST", ...jsonBody({ provider, action: "update", name: k.name, ...(newName && newName !== k.name ? { newName } : {}), newKey, rpm, minIntervalMs: miv !== undefined ? mivNorm(miv) : undefined }) })).json());
      if (d && d.ok) {
        await loadEditKeys(provider);
        const rest = { ...((editKeys[provider] || {}).rows || {}) };
        delete rest[k.name];
        setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), rows: rest, busy: false } }));
        loadStatus();
      } else setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (d && d.error) || ti("mw.a.36") } }));
    } catch (e2: any) { setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (e2 && e2.message) || String(e2) } })); }
  };
  const editKeyRemove = async (provider: string, name: string) => {
    setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: true, error: "" } }));
    try {
      const d = srvFix(await (await api("/keys", { method: "POST", ...jsonBody({ provider, action: "remove", name }) })).json());
      if (d && d.ok) { await loadEditKeys(provider); setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false } })); loadStatus(); }
      else setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (d && d.error) || ti("mw.a.228") } }));
    } catch (e: any) { setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (e && e.message) || String(e) } })); }
  };
  // 单把 key 临时禁用/启用（enabled:false 标记，不删除；不参与轮转，随时可切回）
  const editKeyToggle = async (provider: string, name: string, enabled: boolean) => {
    setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: true, error: "" } }));
    try {
      const d = srvFix(await (await api("/keys", { method: "POST", ...jsonBody({ provider, action: "update", name, enabled }) })).json());
      if (d && d.ok) { await loadEditKeys(provider); setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false } })); loadStatus(); }
      else setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (d && d.error) || ti("mw.a.229") } }));
    } catch (e: any) { setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (e && e.message) || String(e) } })); }
  };

  // 编辑流多 key 折叠区 UI
  const renderEditKeys = (p: any) => {
    const e = editKeys[p.provider] || {};
    const list = e.list || [];
    const hasKeys = list.length > 0 || (p.keyCount || 0) > 0;
    // 已配置多 key 时默认展开（用户显式折叠后记住）；无 key 默认收起
    const open = e.show !== undefined ? e.show : hasKeys;
    const setE = (patch: any) => setEditKeys((prev: any) => ({ ...prev, [p.provider]: { ...(prev[p.provider] || {}), ...patch } }));
    // 刷新 = 两件事：① 重拉 models.json 的 key 列表（外部改动立即可见）② 刷新运行中代理（立即生效）
    const doKeysRefresh = async () => {
      setE({ busy: true, error: "", refreshOut: "" });
      await loadEditKeys(p.provider);
      try {
        const d = srvFix(await (await api("/refresh", { method: "POST", ...jsonBody({ provider: p.provider }) })).json());
        const names = ((d && d.refreshed) || []).length ? "（" + (d.refreshed || []).join(", ") + "）" : "";
        setE({ busy: false, refreshOut: d && d.ok ? ti("mw.a.230") + names : ti("mw.a.231") + ((d && d.error) || ti("mw.a.132")) });
      } catch (e2: any) {
        setE({ busy: false, refreshOut: ti("mw.a.231") + ((e2 && e2.message) || e2) });
      }
      loadStatus();
    };
    return (
      <div style={{ marginTop: 10, borderTop: "1px solid var(--border,#eee)", paddingTop: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6, padding: "7px 10px", border: "1px solid rgba(99,102,241,.4)", borderRadius: 9, background: "rgba(99,102,241,.05)", flexWrap: "wrap" }}>
          <button className="amw-btn" style={{ padding: "3px 11px", fontSize: 11, fontWeight: 650 }} onClick={() => { if (!open) loadEditKeys(p.provider); setE({ show: !open }); }}>
            {open ? ti("mw.a.232") : ti("mw.a.233") + (list.length ? "（" + list.length + ti("mw.a.234") : "")}
          </button>
          <button className="amw-btn" style={{ padding: "3px 11px", fontSize: 11 }} disabled={e.busy} title={ti("mw.a.235")}
            onClick={doKeysRefresh}>
            {e.busy ? ti("mw.a.48") : (<><Ic size={11} paths={ICONS.refresh} /> {ti("mw.tx.33")}</>)}
          </button>
          <span style={{ color: "var(--text-subtle,#666)", fontSize: 10.5 }}>{ti("mw.tx.34")}</span>
        </div>
        {e.error ? <div className="amw-note is-err">❌ {e.error}</div> : null}
        {e.refreshOut && !e.error ? <div style={{ fontSize: 11, marginBottom: 4, color: e.refreshOut.startsWith("⚠️") ? "#d97706" : "#15803d" }}>{e.refreshOut}</div> : null}
        {open ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {list.length ? list.map((k: any, i: number) => {
              const row = (e.rows || {})[k.name] || {};
              const rowSet = (patch: any) => setE({ rows: { ...(e.rows || {}), [k.name]: { ...row, ...patch } } });
              const dirty = ((row.name || "").trim() && row.name.trim() !== k.name) || ((row.key || "").trim() !== "") || (row.rpm !== undefined && String(row.rpm).trim() !== String(k.rpm ?? "")) || (row.minIntervalMs !== undefined && String(row.minIntervalMs).trim() !== String(k.minIntervalMs ?? ""));
              return (
                <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 11, flexWrap: small ? "wrap" : "nowrap", ...(k.enabled === false ? { background: "rgba(127,127,127,.09)", borderRadius: 6, padding: "2px 4px" } : {}) }}>
                  <span style={{ width: 16, flexShrink: 0, textAlign: "right", color: "var(--text-subtle,#aaa)", fontSize: 10 }}>{i + 1}</span>
                  <input className="amw-input" disabled={k.enabled === false} style={{flex: small ? "1 1 40%" : "0 0 88px", minWidth: small ? 0 : 88, fontFamily: "ui-monospace,monospace", ...(k.enabled === false ? { color: "var(--text-subtle,#999)" } : {})}} title={ti("mw.a.236")} value={row.name ?? k.name} onChange={(ev) => rowSet({ name: ev.target.value })} />
                  <input className="amw-input" disabled={k.enabled === false} style={{flex: small ? "1 1 50%" : "1 1 auto", minWidth: small ? 0 : 120, fontFamily: "ui-monospace,monospace", ...(k.enabled === false ? { color: "var(--text-subtle,#999)" } : {})}} type="password" placeholder={k.key ? ti("mw.a.237") + k.key + ti("mw.a.238") : "API key"} value={row.key || ""} onChange={(ev) => rowSet({ key: ev.target.value })} />
                  <input className="amw-input" disabled={k.enabled === false} style={{width: 56, flexShrink: 0}} type="number" min={1} placeholder="rpm" title={ti("mw.a.239")} value={row.rpm !== undefined ? row.rpm : (k.rpm || "")} onChange={(ev) => rowSet({ rpm: ev.target.value })} />
                  <input className="amw-input" disabled={k.enabled === false} style={{width: 72, flexShrink: 0}} placeholder={ti("mw.a.240")} title={ti("mw.a.241")} value={row.minIntervalMs !== undefined ? row.minIntervalMs : (k.minIntervalMs ?? "")} onChange={(ev) => rowSet({ minIntervalMs: ev.target.value })} />
                  <button className="amw-btn" style={{ padding: "2px 8px", flexShrink: 0 }} title={dirty ? ti("mw.a.242") : ti("mw.a.243")} disabled={e.busy || !dirty} onClick={() => editKeySave(p.provider, k)}>💾</button>
                  <button className="amw-btn" style={{ padding: "2px 8px", flexShrink: 0, ...(k.enabled === false ? { color: "#b45309", borderColor: "var(--warn, #f59e0b)", background: "color-mix(in srgb, var(--warn, #f59e0b) 12%, transparent)" } : {}) }}
                    title={k.enabled === false ? ti("mw.a.244") : ti("mw.a.245")}
                    disabled={e.busy} onClick={() => editKeyToggle(p.provider, k.name, k.enabled === false)}>
                    {k.enabled === false ? "▶" : "⏸"}
                  </button>
                  <button className="amw-btn" style={{ padding: "2px 8px", flexShrink: 0 }} title={ti("mw.a.246")} disabled={e.busy} onClick={() => editKeyRemove(p.provider, k.name)}>✕</button>
                </div>
              );
            }) : e.busy ? <div style={{ color: "var(--text-subtle,#999)", fontSize: 11 }}>{ti("mw.tx.6")}</div> : <div style={{ color: "var(--text-subtle,#999)", fontSize: 11 }}>{ti("mw.tx.35")}</div>}
            <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4, flexWrap: small ? "wrap" : "nowrap" }}>
              <input className="amw-input" style={{flex: small ? "1 1 40%" : "0 0 88px", minWidth: small ? 0 : 88, fontFamily: "ui-monospace,monospace"}} placeholder={ti("mw.a.247")} value={e.newName || ""} onChange={(ev) => setE({ newName: ev.target.value })} />
              <input className="amw-input" style={{flex: small ? "1 1 50%" : "1 1 auto", minWidth: small ? 0 : 120, fontFamily: "ui-monospace,monospace"}} type="password" placeholder={ti("mw.a.248")} value={e.newKey || ""} onChange={(ev) => setE({ newKey: ev.target.value })} />
              <input className="amw-input" style={{width: 56, flexShrink: 0}} type="number" min={1} placeholder="rpm" value={e.newRpm || ""} onChange={(ev) => setE({ newRpm: ev.target.value })} />
              <input className="amw-input" style={{width: 72, flexShrink: 0}} placeholder={ti("mw.a.240")} title={ti("mw.a.249")} value={e.newMiv || ""} onChange={(ev) => setE({ newMiv: ev.target.value })} />
              <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "4px 10px", flexShrink: 0 }} disabled={e.busy || !((e.newKey || "").trim())} onClick={() => editKeyAdd(p.provider)}>{ti("mw.tx.36")}</button>
            </div>
          </div>
        ) : null}
      </div>
    );
  };
  // probe-cap 徽标（⏳ 实测中 / ✓↓ 已下调 / ✓ 实测通过 / ! 失败）
  const capBadge = (provider: string, id: string) => {
    const cp = capProbes[provider + "/" + id];
    if (!cp) return null;
    const t = cp.phase === "probing"
      ? <span title={ti("mw.a.250")} style={{ color: "var(--warn, #f59e0b)" }}>⏳</span>
      : cp.corrected ? <span title={cp.detail || ti("mw.a.251")} style={{ color: "var(--ok, #10b981)", fontWeight: 700 }}>↓</span>
      : cp.error || (!cp.skipped && !cp.corrected) ? <span title={cp.detail || cp.error || ti("mw.a.252")} style={{ color: "var(--danger, #ef4444)" }}>!</span>
      : null;
    return t;
  };
  // 编辑控件（大屏 inline / 小屏整屏 共用）：名称 / 模型（刷新可选）/ 连接配置 / 操作
  const renderEditControls = (p: any) => {
    // 订阅登录型：凭据由登录流程管理（auth.json），不提供 models.json 编辑/保存——
    // 同名写入会与扩展注册的 provider 冲突，覆盖坏登录链路
    if (p.authType === "oauth") {
      const pid = p.oauthProviderId || p.provider;
      return (
        <div data-amw-edit="1" style={{ marginTop: 10, borderTop: "1px solid var(--border,#eee)", paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: "var(--text-subtle,#666)", marginBottom: 6 }}>
            {ti("mw.tx.184")}
          </div>
          {oauthLoginPanel({ id: pid, name: p.provider })}
        </div>
      );
    }
    const draft = editModels[p.provider] ?? p.models ?? [];
    const apiOpts = ["openai-completions", "anthropic-messages", "openai-responses", "google-generative-ai"];
    const setField = (fid: string, v: string) => setEditFields((prev: any) => ({ ...prev, [p.provider]: { ...(prev[p.provider] || {}), [fid]: v } }));
    const eff = (fid: string, fallback: any) => (editFields[p.provider] && editFields[p.provider][fid] !== undefined ? editFields[p.provider][fid] : fallback);
    const avail = editAvail[p.provider];
    const availIds = avail ? editAvailList(p.provider) : [];
    const availChecked = avail ? avail.checked : [];
    const availNew = avail ? (avail.newModels || []) : [];
    return (
      <div data-amw-edit="1" style={{ marginTop: 10, borderTop: "1px solid var(--border,#eee)", paddingTop: 10 }}>
        {/* ── 名称（改名）── */}
        <div className="amw-section" style={{margin: "0 0 6px"}}>{ti("mw.tx.37")}</div>
        <input className="amw-input" style={{width: "100%", marginBottom: 10, fontWeight: 600}} value={eff("name", p.provider)} onChange={(e) => setField("name", e.target.value)} placeholder={p.provider} />
        {/* ── 模型（刷新可选 / 增删）── */}
        <div className="amw-section" style={{margin: "0 0 6px"}}>{ti("mw.a.253") + (avail ? availChecked.length + ti("mw.a.254") + avail.models.length + ti("mw.a.255") : draft.length + ti("mw.a.9")) + "）"}</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "3px 10px" }} onClick={() => refreshEditModels(p.provider, p)} disabled={!!refreshBusy[p.provider]}>
            {refreshBusy[p.provider] ? ti("mw.a.48") : (<><Ic size={12} paths={ICONS.refresh} />{" "}{ti("mw.tx.185")}</>)}
          </button>
          {avail ? <button className="amw-btn" onClick={() => setEditAvail((prev: any) => { const { [p.provider]: _drop, ...rest } = prev; return rest; })}>{ti("mw.tx.38")}</button> : null}
          {avail ? <input className="amw-input" style={{flex: 1, minWidth: 140}} placeholder={ti("mw.a.256")} value={availFilter[p.provider] || ""} onChange={(e) => setAvailFilter((prev: any) => ({ ...prev, [p.provider]: e.target.value }))} /> : null}
          {avail ? <button className="amw-btn" style={{ padding: "2px 10px" }} title={ti("mw.a.257")} onClick={() => setEditAvail((prev: any) => ({ ...prev, [p.provider]: { ...prev[p.provider], checked: [...new Set([...availChecked, ...availIds])] } }))}>{ti("mw.tx.39")}</button> : null}
          {avail ? <button className="amw-btn" style={{ padding: "2px 10px" }} title={ti("mw.a.258")} onClick={() => setEditAvail((prev: any) => {
            const av = prev[p.provider];
            const inv = availIds.filter((id) => !av.checked.includes(id));
            return { ...prev, [p.provider]: { ...av, checked: [...av.checked.filter((id: string) => !availIds.includes(id)), ...inv] } };
          })}>{ti("mw.tx.40")}</button> : null}
          {avail ? <button className="amw-btn" style={{ padding: "2px 10px" }} title={ti("mw.a.259")} onClick={() => setEditAvail((prev: any) => ({ ...prev, [p.provider]: { ...prev[p.provider], checked: prev[p.provider].checked.filter((id: string) => !availIds.includes(id)) } }))}>{ti("mw.tx.41")}</button> : null}
        </div>
        {avail ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, maxHeight: 190, overflow: "auto", border: "1px solid var(--border,#eee)", borderRadius: 8, padding: 6 }}>
            {availIds.length ? availIds.map((id) => {
              const nmd = (nmMeta[p.provider] || {})[id];
              const isNew = availNew.includes(id);
              const mtags = isNew && nmd ? [nmd.contextWindow ? fmtTok(nmd.contextWindow) + " ctx" : "", nmd.reasoning ? ti("mw.a.1") : ""].filter(Boolean) : [];
              return (
                <label key={id} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 8, border: isNew ? "1px solid color-mix(in srgb, var(--ok, #22c55e) 50%, transparent)" : "1px solid var(--border,#e0e0e0)", cursor: "pointer", background: availChecked.includes(id) ? "rgba(37,99,235,.12)" : (isNew ? "color-mix(in srgb, var(--ok, #22c55e) 7%, transparent)" : "var(--bg,#fff)") }}>
                  <input type="checkbox" checked={availChecked.includes(id)} onChange={() => toggleEditAvail(p.provider, id)} style={{ margin: 0 }} />
                  <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 11 }}>{id}</span>
                  <EyeBtn title={ti("mw.a.260") + id + ti("mw.a.261")} onClick={() => viewModelParams(p.provider, id)} />
                  {capBadge(p.provider, id)}
                  {mtags.length ? <span style={{ color: "var(--text-muted, #6b7280)", fontSize: 9 }}>{mtags.join(" · ")}</span> : null}
                  {isNew ? <span style={{ padding: "0 5px", borderRadius: 6, background: "color-mix(in srgb, var(--ok, #22c55e) 16%, transparent)", color: "#15803d", fontSize: 9, fontWeight: 700 }}>{ti("mw.tx.42")}</span> : null}
                </label>
              );
            }) : <span style={{ color: "var(--text-subtle,#999)", fontSize: 11 }}>{ti("mw.tx.43")}</span>}
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, maxHeight: 150, overflow: "auto" }}>
              {draft.length ? draft.map((id: any) => {
                const mid = typeof id === "string" ? id : (id && id.id);
                const mEn = !(typeof id === "object" && id && id.enabled === false);
                return (
                <span key={mid} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 8, border: mEn ? "1px solid var(--border,#e0e0e0)" : "1px dashed var(--warn, #f59e0b)", background: mEn ? "var(--bg-subtle,#f5f5f5)" : "color-mix(in srgb, var(--warn, #f59e0b) 10%, transparent)", fontSize: 11, fontFamily: "ui-monospace,monospace", ...(mEn ? {} : { color: "#b45309" }) }}>
                  {mid}
                  {!mEn ? <span style={{ fontSize: 9, color: "#b45309", fontWeight: 700 }}>{ti("mw.a.495")}</span> : null}
                  {capBadge(p.provider, mid)}
                  <EyeBtn title={ti("mw.a.262")} onClick={() => viewModelParams(p.provider, mid)} />
                  <button style={{ border: "none", background: "none", cursor: "pointer", color: "#d97706", padding: 0, fontSize: 12, lineHeight: 1 }}
                    title={mEn ? ti("mw.a.263") : ti("mw.a.264")}
                    onClick={() => doToggleModel(p.provider, mid, !mEn)}>{mEn ? "⏸" : "▶"}</button>
                  <button style={{ border: "none", background: "none", cursor: "pointer", color: "#dc2626", padding: 0, fontSize: 12, lineHeight: 1 }} onClick={() => removeEditModel(p.provider, mid, p.models)} aria-label={ti("mw.a.265") + mid}>✕</button>
                </span>
                );
              }) : <span style={{ color: "var(--text-subtle,#999)", fontSize: 11 }}>{ti("mw.tx.44")}</span>}
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} placeholder={ti("mw.a.266")} value={newModel} onChange={(e) => setNewModel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addEditModel(p.provider, p.models); }} />
              <button className="amw-btn" onClick={() => addEditModel(p.provider, p.models)}>{ti("mw.tx.36")}</button>
            </div>
          </div>
        )}
        {/* ── 连接配置 ── */}
        <div className="amw-section" style={{margin: "0 0 6px"}}>{ti("mw.tx.45")}</div>
        <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>Base URL</label>
        <input className="amw-input" style={{width: "100%", marginBottom: 6, fontFamily: "ui-monospace,monospace"}} placeholder="https://api.example.com/v1" value={eff("baseUrl", p.baseUrl || "")} onChange={(e) => setField("baseUrl", e.target.value)} />
        <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>{ti("mw.tx.46")}</label>
        <select className="amw-input" style={{width: "100%", marginBottom: 6}} value={eff("api", p.api || "openai-completions")} onChange={(e) => setField("api", e.target.value)}>
          {apiOpts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }} title={ti("mw.tx.47") + ti("mw.tx.48") + "）"}>{ti("mw.tx.229")}</label>
        <input className="amw-input" style={{width: "100%", fontFamily: "ui-monospace,monospace"}} type="password" placeholder={p.apiKeyMasked ? ti("mw.a.267") + p.apiKeyMasked + "）" : ti("mw.a.268")} value={editTok[p.provider] || ""} onChange={(e) => setEditTok((prev: any) => ({ ...prev, [p.provider]: e.target.value }))} />
        <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", margin: "8px 0 3px" }}>{ti("mw.tx.49")}</label>
        <EditHeadersEditor key={p.provider} initialHeaders={eff("headers", p.headers)} initialMasked={eff("headersMasked", p.maskedHeaders)}
          onChange={(headers, maskedHeaders) => setEditFields((prev: any) => ({ ...prev, [p.provider]: { ...(prev[p.provider] || {}), headers, headersMasked: maskedHeaders } }))} />
        {/* ── 连接测试（用已配置的全部 key，逐个测）── */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "3px 10px" }} title={ti("mw.tx.51")} disabled={!!(keyTests[p.provider] && keyTests[p.provider].busy)} onClick={() => doTestStored(p)}>
            {(keyTests[p.provider] && keyTests[p.provider].busy) ? ti("mw.a.76") : (<>{ti("mw.tx.50")}</>)}
          </button>
        </div>
        {keyTests[p.provider] && keyTests[p.provider].error ? <div className="amw-note is-err" style={{marginTop: 4}}>❌ {keyTests[p.provider].error}</div> : null}
        {keyTests[p.provider] && keyTests[p.provider].results ? testBadge({ multiKey: true, results: keyTests[p.provider].results, passCount: keyTests[p.provider].passCount, total: keyTests[p.provider].total }) : null}
        {renderEditKeys(p)}
        {/* ── 操作 ── */}
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <button className="amw-btn is-ok" onClick={() => doSaveEdit(p.provider, p)} disabled={busy}>{ti("mw.tx.52")}</button>
          <button className="amw-btn" onClick={() => { setEditFields((prev: any) => { const { [p.provider]: _drop, ...rest } = prev; return rest; }); setEditAvail((prev: any) => { const { [p.provider]: _drop2, ...rest } = prev; return rest; }); setEditModels((prev: any) => { const { [p.provider]: _drop3, ...rest } = prev; return rest; }); }}>{ti("mw.tx.12")}</button>
        </div>
      </div>
    );
  };
  // 小屏：整屏编辑视图（带返回）
  // ---- 渲染 ----
  // 提供商信息卡：地址/api 一行 chip，链接统一图标+文字按钮（对齐、等高），注册说明独立小字——不再一行一个图标链接乱排
  const infoLink = (icon: string[], label: string, url: string) => (
    <a href={LINK(url)} target="_blank" rel="noreferrer"
      style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 8, fontSize: 13,
        color: "var(--accent,#2563eb)", textDecoration: "none", background: "var(--bg,#fff)", border: "1px solid var(--border,#e5e5e5)" }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(99,102,241,.55)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border,#e5e5e5)"; }}>
      <Ic size={12} paths={icon} />{label}
    </a>
  );
  const providerInfo = (p: any) => {
    const hasChips = !!p.baseUrl || !!(p.models && p.models.length);
    const hasLinks = !!(p.doc || p.signupUrl || p.tokenUrl);
    if (!hasChips && !hasLinks && !p.register) return null; // 自定义端点初值全空 → 不渲染空壳卡片
    const regPid = String(p.id || p.baseUrl || "reg");
    const regOpen = regOpenId === regPid;
    return (
      <div style={{ border: "1px solid var(--border,#eee)", borderRadius: 10, padding: "10px 12px", background: "var(--bg-subtle,#fafafa)", marginBottom: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {p.baseUrl ? <span title={p.baseUrl + " · " + p.apiType} className="amw-mono" style={{ padding: "3px 10px", borderRadius: 999, background: "var(--bg,#fff)", border: "1px solid var(--border,#e5e5e5)", fontSize: 11, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.baseUrl}<span style={{ color: "var(--text-subtle,#999)" }}>{" · " + p.apiType}</span></span> : null}
          {(p.models && p.models.length) ? <span style={{ fontSize: 11, color: "var(--text-subtle,#666)", flexShrink: 0 }}>{ti("mw.a.269") + p.models.length + ti("mw.a.9")}</span> : null}
        </div>
        {hasLinks ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: p.baseUrl ? 8 : 0 }}>
            {p.doc ? infoLink(ICONS.file, ti("mw.a.270"), p.doc) : null}
            {p.signupUrl ? infoLink(ICONS.pencil, ti("mw.a.271"), p.signupUrl) : null}
            {p.tokenUrl ? infoLink(ICONS.key, ti("mw.a.272"), p.tokenUrl) : null}
          </div>
        ) : null}
        {/* register note: single-line ellipsis by default (full text on hover, click to expand) */}
        {p.register ? <div title={p.register} onClick={() => setRegOpenId(regOpen ? "" : regPid)}
          style={{ marginTop: 8, fontSize: 11, lineHeight: 1.55, color: "var(--text-subtle,#666)", cursor: regOpen ? "auto" : "pointer", ...(regOpen ? {} : { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }) }}>{p.register}</div> : null}
      </div>
    );
  };

  // ---- 订阅登录型 provider（authType=oauth）：详情（账号/credits/模型）+ 内嵌 SSE 登录流 ----
  const oauthInfoRef = useRef<Record<string, any>>({});
  const [oauthInfoVer, setOauthInfoVer] = useState(0); // 触发重渲染的版本号
  const checkOauthStatus = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    for (const id of ids) {
      try {
        const d = srvFix(await (await api("/oauth-info?id=" + encodeURIComponent(id))).json());
        if (d.ok) { oauthInfoRef.current[id] = d; setOauthInfoVer((v) => v + 1); }
      } catch {}
    }
  }, []);
  const stopOauthLogin = () => { oauthEsRef.current?.close(); oauthEsRef.current = null; setOauthLs({ phase: "idle" }); };
  const startOauthLogin = useCallback((providerId: string) => {
    oauthEsRef.current?.close();
    setOauthLs({ phase: "connecting" });
    const es = new EventSource(apiUrl("/api/auth/login/" + encodeURIComponent(providerId)));
    oauthEsRef.current = es;
    es.onmessage = (e) => {
      let data: any; try { data = JSON.parse(e.data); } catch { return; }
      if (data.type === "auth") {
        setOauthLs({ phase: "auth", url: data.url, instructions: data.instructions ?? "", token: data.token });
        try { window.open(data.url, "_blank", "noopener,noreferrer"); } catch {}
      } else if (data.type === "device_code") {
        setOauthLs({ phase: "device_code", userCode: data.userCode, verificationUri: data.verificationUri });
      } else if (data.type === "prompt_request") {
        setOauthLs({ phase: "prompt", message: data.message ?? "", placeholder: data.placeholder ?? "", token: data.token });
      } else if (data.type === "select_request") {
        // 账号/组织/套餐选择型（与 pi-web 内置登录面板同语义）：展示选项列表，点选后 POST {token, code}
        setOauthLs({ phase: "select", message: data.message ?? "", options: Array.isArray(data.options) ? data.options : [], token: data.token });
      } else if (data.type === "progress") {
        setOauthLs((prev: any) => (prev.phase === "prompt" || prev.phase === "auth" || prev.phase === "select" ? prev : { phase: "progress", message: data.message ?? "" }));
      } else if (data.type === "success") {
        es.close(); oauthEsRef.current = null; setOauthLs({ phase: "success" }); checkOauthStatus([providerId]);
      } else if (data.type === "error") {
        es.close(); oauthEsRef.current = null; setOauthLs({ phase: "error", message: data.message ?? "" });
      } else if (data.type === "cancelled") {
        es.close(); oauthEsRef.current = null; setOauthLs({ phase: "idle" });
      }
    };
    es.onerror = () => { es.close(); oauthEsRef.current = null; setOauthLs((prev: any) => (prev.phase === "success" ? prev : { phase: "error", message: ti("mw.a.273") })); };
  }, [checkOauthStatus]);
  useEffect(() => () => { oauthEsRef.current?.close(); }, []);

  const testBadge = (t: any) => {
    if (!t) return null;
    if (t.multiKey && Array.isArray(t.results)) {
      const all = t.passCount === t.total;
      return (
        <div className={"amw-note " + (all ? "is-ok" : t.passCount > 0 ? "is-warn" : "is-err")} style={{ marginTop: 4 }}>
          {(all ? "✅" : t.passCount > 0 ? "🟡" : "❌") + ti("mw.a.274") + t.passCount + "/" + t.total + ti("mw.a.275")}
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 3 }}>
            {t.results.map((x: any) => (
              <div key={x.name} style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, color: x.pass ? ("var(--ok,#15803d)") : ("var(--err,#b91c1c)") }}>
                {x.pass ? (x.rateLimited ? "🟡" : "✅") : "❌"} {x.name}（{x.masked}）· HTTP {x.status ?? "net"}{x.latencyMs != null ? " · " + (x.latencyMs / 1000).toFixed(1) + "s" : ""}{x.detail ? " · " + x.detail : ""}
              </div>
            ))}
          </div>
        </div>
      );
    }
    return t.pass
      ? <div className={"amw-note " + (t.rateLimited ? "is-warn" : "is-ok")}>{t.rateLimited ? ti("mw.a.276") + t.detail : ti("mw.a.277") + t.status + " · " + t.detail + " · " + (t.latencyMs != null ? t.latencyMs + "ms" : "") + "）"}</div>
      : <div className="amw-note is-err">{ti("mw.a.278") + (t.status || "net") + "）· " + (t.detail || t.error || "")}</div>;
  };

  /** 订阅登录型（authType=oauth）面板：替代 token 输入流 */
  // ── 订阅服务 tab：列出 pi 运行时全部 OAuth 登录型提供商，一键登录/查看状态 ──
  const OAUTH_META: Record<string, string> = {
    "anthropic": ti("mw.a.279"),
    "openai-codex": ti("mw.a.280"),
    "github-copilot": ti("mw.a.281"),
    "xai": ti("mw.a.282"),
    "openrouter": ti("mw.a.283"),
    "radius": ti("mw.a.284"),
    "kimi-coding": ti("mw.a.285"),
    "qoder": ti("mw.a.286"),
    "qoder-cn": ti("mw.a.287"),
  };
  // ── G3 凭据管理（docs/aiti-model-wizard-settings-takeover-plan.md）：apiKey 型内置 provider 的
  // auth.json key 管理（宿主 /api/auth/api-key/<id> POST 保存·更换 / DELETE 移除）。
  // native provider 添加流与状态页 api_key 详情共用 saveAuthKey/removeAuthKey。 ──
  const [akList, setAkList] = useState<any[] | null>(null);        // apiKeyProviders（/api/auth/providers）
  const [akDraft, setAkDraft] = useState<Record<string, string>>({}); // pid → 新 key 草稿（不回显旧值）
  const [akBusy, setAkBusy] = useState<string>("");                // 进行中的 pid
  const [akMsg, setAkMsg] = useState<Record<string, string>>({});  // pid → 行内反馈
  const saveAuthKey = async (id: string, key: string): Promise<boolean> => {
    const k = (key || "").trim();
    if (!k) { setAkMsg((m) => ({ ...m, [id]: ti("mw.a.288") })); return false; }
    setAkBusy(id); setAkMsg((m) => ({ ...m, [id]: "" }));
    try {
      const r = await fetch(apiUrl("/api/auth/api-key/" + encodeURIComponent(id)), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: k }) });
      const d = srvFix(await r.json()) as { success?: boolean; error?: string };
      if (!r.ok || d.error) { setAkMsg((m) => ({ ...m, [id]: "❌ " + (d.error || "HTTP " + r.status) })); return false; }
      setAkDraft((prev) => { const { [id]: _drop, ...rest } = prev; return rest; });
      setAkMsg((m) => ({ ...m, [id]: ti("mw.a.289") }));
      try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
      void loadStatus();
      return true;
    } catch (e: any) { setAkMsg((m) => ({ ...m, [id]: "❌ " + (e.message || e) })); return false; }
    finally { setAkBusy(""); }
  };
  const removeAuthKey = async (id: string): Promise<boolean> => {
    setAkBusy(id); setAkMsg((m) => ({ ...m, [id]: "" }));
    try {
      const r = await fetch(apiUrl("/api/auth/api-key/" + encodeURIComponent(id)), { method: "DELETE" });
      const d = srvFix(await r.json()) as { success?: boolean; error?: string };
      if (!r.ok || d.error) { setAkMsg((m) => ({ ...m, [id]: "❌ " + (d.error || "HTTP " + r.status) })); return false; }
      setAkMsg((m) => ({ ...m, [id]: ti("mw.a.290") }));
      try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
      void loadStatus();
      return true;
    } catch (e: any) { setAkMsg((m) => ({ ...m, [id]: "❌ " + (e.message || e) })); return false; }
    finally { setAkBusy(""); }
  };
  // apiKey 型行内编辑器（订阅页 / 状态页 api_key 详情共用）
  const apiKeyRow = (id: string, displayName: string, configured: boolean, compact?: boolean) => (
    <div style={compact ? { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 } : { display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: configured ? "var(--ok, #4ade80)" : "var(--border,#ddd)", flexShrink: 0 }} title={configured ? ti("mw.a.291") : ti("mw.a.292")} />
      <input className="amw-input" style={{ flex: 1, minWidth: 160, fontFamily: "ui-monospace,monospace" }} type="password"
        placeholder={configured ? ti("mw.a.293") : "sk-…"} value={akDraft[id] || ""}
        onChange={(e) => setAkDraft((prev) => ({ ...prev, [id]: e.target.value }))}
        onKeyDown={(e: any) => { if (e.key === "Enter" && (akDraft[id] || "").trim()) void saveAuthKey(id, akDraft[id]); }} />
      <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", flexShrink: 0 }} disabled={akBusy === id || !(akDraft[id] || "").trim()}
        onClick={() => void saveAuthKey(id, akDraft[id])}>{akBusy === id ? ti("mw.a.55") : ti("mw.a.56")}</button>
      {configured ? (
        <button className="amw-btn" style={{ color: "#dc2626", flexShrink: 0 }} disabled={akBusy === id} title={ti("mw.a.294")}
          onClick={() => void removeAuthKey(id)}>{akBusy === id ? "…" : ti("mw.a.295")}</button>
      ) : null}
      {akMsg[id] ? <span style={{ fontSize: 11, color: akMsg[id].startsWith("✅") ? "#16a34a" : "#dc2626", flexBasis: "100%" }}>{akMsg[id]}</span> : null}
    </div>
  );

  const loadSubs = useCallback(async () => {
    try {
      const d = srvFix(await srvFix(await (await fetch(apiUrl("/api/auth/providers"), { cache: "no-store" })).json()));
      setSubList(Array.isArray(d.providers) ? d.providers : []);
      setAkList(Array.isArray(d.apiKeyProviders) ? d.apiKeyProviders : []);
    } catch { setSubList([]); setAkList([]); }
  }, []);
  // initialTab==='subs' 直开订阅 tab 时也必须拉列表（此前只有手动点 tab 才触发 → 永远「加载中…」）。
  // 独立 effect 放在 loadSubs 定义之后——塞进上面的开屏 effect 会因 deps 提前求值撞 TDZ。
  useEffect(() => { if (open && initialTab === "subs") loadSubs(); }, [open, initialTab, loadSubs]);
  // ---- 订阅型「可用模型」渲染共用 ----
  // 来源标注：runtime = /oauth-info 从 /api/models（pi ModelRuntime）取 → 选择器里真能选到；
  // catalog = 目录静态清单（运行时未注册该 provider）→ id 可能与选择器实际不符，刷新也不会变。
  const modelSourceTag = (source?: string) => (
    source === "runtime"
      ? <span style={{ fontWeight: 400, fontSize: 11, color: "var(--text-subtle,#666)" }}> {ti("mw.tx.53")}</span>
      : <span style={{ fontWeight: 400, fontSize: 11, color: "var(--warn,#b45309)" }}> {ti("mw.tx.54")}</span>
  );
  // 厂商常返回混淆 id（如 Qoder 网关的 dmodel/gm51model），而选择器里显示的是 display name
  // （DeepSeek-V4-Pro/GLM-5.2）→ pill 同时给出两者，用户才认得出该选哪个。
  const normMid = (s: any) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const renderModelPills = (pid: string, models: any[], source?: string, related?: any[]) => (
    <div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {(models || []).map((m: any, i: number) => {
          const mid = typeof m === "string" ? m : m.id;
          const mname = (m && typeof m === "object" && m.name && String(m.name) !== String(mid)) ? String(m.name) : "";
          // name 只是 id 的美化写法（Qwen 3.6 Flash · Qoder CN ← qwen3.6-flash）时不重复展示
          const redundant = !!mname && normMid(mname).startsWith(normMid(mid));
          const label = !mname || redundant ? mid : (mid + "（" + mname + "）");
          return <span key={mid + "#" + i} className="amw-mono" title={mname ? (mid + " · " + mname) : mid} style={{ padding: "1px 8px", borderRadius: 999, background: "var(--bg-subtle,#f5f5f5)", fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4 }}>
            {label}
            <EyeBtn title={ti("mw.a.260") + mid + ti("mw.a.296")} onClick={() => viewModelParams(pid, mid)} />
          </span>;
        })}
      </div>
      {source === "catalog" ? (
        <div style={{ fontSize: 11, color: "var(--warn,#b45309)", marginTop: 3 }}>{ti("mw.tx.186", { pid })}</div>
      ) : null}
      {related && related.length ? (
        <div style={{ fontSize: 11, color: "var(--text-subtle,#666)", marginTop: 3 }}>
          {ti("mw.tx.187")}{related.map((r: any) => r.provider + "（" + r.count + ti("mw.a.297")).join(" · ")}
        </div>
      ) : null}
    </div>
  );

  const renderSubscriptions = () => {
    if (!subList) return <div className="amw-note">{ti("mw.tx.6")}</div>;
    const oauthEmpty = !subList.length;
    return (
      <div>
        {oauthEmpty ? <div className="amw-note">{ti("mw.tx.55")}</div> : (
        <>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span className="amw-section" style={{margin: 0, flex: 1}}>{ti("mw.a.298") + subList.length + ti("mw.a.299")}</span>
          <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => { loadSubs(); checkOauthStatus(subActive ? [subActive] : []); }}>{ti("mw.tx.56")}</button>
        </div>
        <div className="amw-note">{ti("mw.tx.57")}</div>
        {subList.map((pr: any) => {
          const pid = pr.id;
          const active = subActive === pid;
          void oauthInfoVer;
          const d = oauthInfoRef.current[pid];
          const info = d?.info;
          const cr = info?.credits;
          const models = (d?.models && d.models.length ? d.models : []);
          return (
            <div key={pid} className="amw-card" style={{ cursor: "default", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <ProviderAvatar id={pid} name={pr.name || pid} size={26} radius={8} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 13 }}>{pr.name || pid}</div>
                  <div style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{OAUTH_META[pid] || ti("mw.a.300")}</div>
                </div>
                <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "3px 10px", fontSize: 11 }}
                  onClick={() => { setSubActive(active ? null : pid); checkOauthStatus([pid]); if (!active) startOauthLogin(pid); }}>
                  {ti("mw.tx.188")}
                </button>
                <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }}
                  title={ti("mw.a.301")}
                  onClick={() => { setSubActive(active ? null : pid); checkOauthStatus([pid]); }}>
                  {active ? ti("mw.a.302") : ti("mw.a.303")}
                </button>
                {(info?.loggedIn || pr.loggedIn) ? (
                  <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, color: "#dc2626" }} disabled={logoutBusy === pid}
                    title={ti("mw.a.304")}
                    onClick={() => void doOauthLogout(pid, pr.name || pid)}>
                    {logoutBusy === pid ? ti("mw.a.305") : ti("mw.a.121")}
                  </button>
                ) : null}
              </div>
              {(info?.loggedIn || pr.loggedIn) ? (
                <div className="amw-note is-ok" style={{marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center"}}>
                  <span>{ti("mw.tx.58")}</span>
                  {info?.account?.name ? <span>👤 {info.account.name}{info.account.plan ? " · " + info.account.plan : ""}</span> : null}
                  {cr ? <span><b>{cr.remaining}</b> / {cr.total} {cr.unit}{cr.expiresAt ? ti("mw.a.306") + new Date(cr.expiresAt).toLocaleDateString() : ""}</span> : null}
                  {info?.addOn ? <span title={ti("mw.a.307")}>{ti("mw.tx.189")} {info.addOn.remaining}/{info.addOn.total}{info.addOn.used != null ? ti("mw.a.308") + info.addOn.used + "）" : ""}</span> : null}
                  {info?.packages?.length ? <span title={ti("mw.a.309")}>🎁 {info.packages.map((p: any) => p.name + " " + p.remaining + "/" + p.total).join(" · ")}</span> : null}
                  {cr?.exceeded ? <span style={{ color: "#dc2626", fontWeight: 700 }}>{ti("mw.tx.59")}</span> : null}
                </div>
              ) : active ? <div className="amw-note is-warn">{ti("mw.tx.60")}</div> : null}
              {active ? oauthLoginPanel({ id: pid, name: pr.name || pid }) : null}
              {active && models.length ? (
                <div style={{ marginTop: 6 }}>
                  <div style={{ color: "var(--text-subtle,#666)", fontSize: 11, marginBottom: 3 }}>{ti("mw.tx.190", { n: models.length })}{modelSourceTag(d?.modelsSource)}</div>
                  {renderModelPills(pid, models, d?.modelsSource, d?.related)}
                </div>
              ) : null}
            </div>
          );
        })}
        </>
        )}
        {/* ── G3：API Key 型内置 provider（auth.json key 托管）——凭据管理段（docs/aiti-model-wizard-settings-takeover-plan.md）── */}
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border,#eee)", paddingTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span className="amw-section" style={{ margin: 0, flex: 1 }}>{ti("mw.a.310") + ((akList && akList.length) || 0) + ti("mw.a.311")}</span>
            <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={loadSubs}>{ti("mw.tx.56")}</button>
          </div>
          <div className="amw-note">{ti("mw.tx.61")}</div>
          {!akList ? <div className="amw-note">{ti("mw.tx.6")}</div>
            : !akList.length ? <div className="amw-note">{ti("mw.tx.62")}</div>
            : akList.map((pr: any) => (
              <div key={pr.id} className="amw-card" style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <ProviderAvatar id={pr.id} name={pr.displayName || pr.id} size={24} radius={7} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 12.5 }}>{pr.displayName || pr.id}</div>
                    <div style={{ color: "var(--text-subtle,#666)", fontSize: 10.5 }}>{(pr.modelCount === 1 ? ti("mw.a.312") : (pr.modelCount || 0) + ti("mw.a.198")) + (pr.supportsOAuth ? ti("mw.a.313") : "")}</div>
                  </div>
                </div>
                {apiKeyRow(pr.id, pr.displayName || pr.id, !!pr.configured, true)}
              </div>
            ))}
        </div>
      </div>
    );
  };

  const oauthLoginPanel = (p: any) => {
    const pid = p.oauthProviderId || p.id;
    void oauthInfoVer; // 订阅 ref 变更触发重渲染
    const d = oauthInfoRef.current[pid];
    const info = d?.info;
    const ls = oauthLs;
    const working = ls.phase === "connecting" || ls.phase === "progress" || ls.phase === "auth" || ls.phase === "device_code" || ls.phase === "prompt" || ls.phase === "select";
    const cr = info?.credits;
    const models = (d?.models && d.models.length ? d.models : (p.models || []));
    // 来源：/oauth-info 拿到运行时清单才是「选择器里直接选」的那份；否则只是静态兜底
    const msrc = (d?.models && d.models.length) ? (d.modelsSource || "catalog") : "catalog";
    return (
      <div>
        <div className="amw-section">{ti("mw.tx.63")}</div>
        <div className="amw-note">{ti("mw.tx.64")}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
          <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff" }} onClick={() => startOauthLogin(pid)} disabled={working}>
            {ti("mw.tx.191", { name: p.name || pid })}
          </button>
          {working ? <button className="amw-btn" onClick={stopOauthLogin}>{ti("mw.tx.12")}</button> : null}
          <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => checkOauthStatus([pid])}>{info ? ti("mw.a.314") : ti("mw.a.315")}</button>
          {info?.loggedIn || (p as any).loggedIn ? (
            <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, color: "#dc2626" }} disabled={logoutBusy === pid}
              title={ti("mw.a.316")}
              onClick={() => void doOauthLogout(pid, p.name || pid)}>
              {logoutBusy === pid ? ti("mw.a.305") : ti("mw.a.121")}
            </button>
          ) : null}
          {info ? (info.loggedIn ? <span className="amw-note is-ok">{ti("mw.tx.58")}</span> : <span className="amw-note is-warn">{ti("mw.tx.65")}</span>) : null}
        </div>
        {info?.loggedIn ? (
          <div className="amw-note is-ok" style={{display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center"}}>
            {info.account?.name ? <span>👤 {info.account.name}{info.account.plan ? " · " + info.account.plan : ""}</span> : null}
            {info.account?.email ? <span>{info.account.email}</span> : null}
            {cr ? <span><b>{cr.remaining}</b> / {cr.total} {cr.unit}{cr.used != null ? ti("mw.a.308") + cr.used + "）" : ""}{cr.expiresAt ? ti("mw.a.306") + new Date(cr.expiresAt).toLocaleDateString() : ""}</span> : null}
            {info?.addOn ? <span title={ti("mw.a.307")}>{ti("mw.tx.66")} <b>{info.addOn.remaining}</b> / {info.addOn.total} {info.addOn.unit}{info.addOn.used != null ? ti("mw.a.308") + info.addOn.used + "）" : ""}</span> : null}
            {info?.packages?.length ? <span title={ti("mw.a.309")}>🎁 {info.packages.map((p: any) => p.name + " " + p.remaining + "/" + p.total).join(" · ")}</span> : null}
            {cr?.exceeded ? <span style={{ color: "#dc2626", fontWeight: 700 }}>{ti("mw.tx.59")}</span> : null}
          </div>
        ) : null}
        {info?.loggedIn && !info.credits && !info.quotaError ? <div className="amw-note">{ti("mw.tx.67")}</div> : null}
        {info?.quotaError ? <div className="amw-note is-warn">{ti("mw.tx.192")}{info.quotaError}</div> : null}
        {info?.loggedIn && models.length ? (
          <div style={{ marginBottom: 6 }}>
            <div className="amw-section" style={{margin: "0 0 4px"}}>{ti("mw.tx.193", { n: models.length })}{modelSourceTag(msrc)}</div>
            {renderModelPills(pid, models, msrc, d?.related)}
          </div>
        ) : null}
        {ls.phase === "connecting" ? <div className="amw-note">{ti("mw.tx.68")}</div> : null}
        {ls.phase === "progress" ? <div className="amw-note">{ls.message}</div> : null}
        {ls.phase === "auth" ? (
          <div className="amw-note">
            {ti("mw.tx.194")}<a href={LINK(ls.url)} target="_blank" rel="noreferrer" className="amw-link">{ls.url}</a><br />
            {ti("mw.tx.195")}
            <OauthCodeInput onSubmit={(v) => submitOauthCode(pid, ls.token, v)} placeholder="http://localhost:…/callback?code=…" />
          </div>
        ) : null}
        {ls.phase === "device_code" ? (
          <div className="amw-note">
            {ti("mw.tx.196", { code: ls.userCode })} <b>{ls.userCode}</b>：<a href={LINK(ls.verificationUri)} target="_blank" rel="noreferrer" className="amw-link">{ls.verificationUri}</a>
          </div>
        ) : null}
        {ls.phase === "prompt" ? (
          <div className="amw-note">
            {ls.message}
            <OauthCodeInput onSubmit={(v) => submitOauthCode(pid, ls.token, v)} placeholder={ls.placeholder || ti("mw.a.317")} allowEmpty />
          </div>
        ) : null}
        {ls.phase === "select" ? (
          <div className="amw-note">
            {ls.message || ti("mw.a.318")}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {(ls.options || []).map((o: any) => (
                <button key={o.id} className="amw-btn" style={{ textAlign: "left", padding: "7px 10px" }} onClick={() => submitOauthCode(pid, ls.token, o.id)}>{o.label || o.id}</button>
              ))}
            </div>
          </div>
        ) : null}
        {ls.phase === "success" ? <div className="amw-note is-ok">{ti("mw.tx.69")}</div> : null}
        {ls.phase === "error" ? <div className="amw-note is-err">❌ {ls.message}</div> : null}
      </div>
    );
  };

  const credTestSave = (p: any) => {
    const validKeyRows = keyRows.filter((r) => (r.key || "").trim());
    const hdrs = p.id === "custom" && headersTouched ? rowsToHeaders(provHeaders) : undefined;
    // G3：pi 内置 provider（apiKey 型）走 auth.json 托管——不落 models.json、无需选模型；
    // 模型清单由 pi 内置目录自动加载（Bedrock/Azure 等特殊端点形态由此正常工作）。
    if (p.native) {
      return (
        <div>
          <div className="amw-section" style={{ margin: "12px 0 6px" }}>{"🔑 " + (p.name || p.id) + ti("mw.a.319")}</div>
          <div className="amw-note">{ti("mw.tx.70")}</div>
          {apiKeyRow(p.id, p.name || p.id, false)}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border,#eee)" }}>
            <span style={{ fontSize: 11, color: "var(--text-subtle,#666)" }}>{ti("mw.tx.71")}</span>
          </div>
        </div>
      );
    }
    return (
    <div>
      {p.id === "custom" ? (
        <>
          <div className="amw-section" style={{ margin: "12px 0 6px" }}>{ti("mw.tx.72")}</div>
          <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>Base URL</label>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input className="amw-input" style={{ flex: 1, fontFamily: "ui-monospace,monospace" }} placeholder="https://api.example.com/v1" value={p.baseUrl || ""}
              onChange={(e) => setSel((prev: any) => ({ ...(prev || {}), baseUrl: e.target.value }))} />
            <button className="amw-btn" style={{ flexShrink: 0 }} disabled={!p.baseUrl?.trim() || customDetecting}
              title={ti("mw.a.320")} onClick={detectCustom}>{customDetecting ? ti("mw.a.126") : ti("mw.a.321")}</button>
          </div>
          <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>{ti("mw.tx.46")}</label>
          <select className="amw-input" style={{ width: "100%", marginBottom: 8 }} value={p.apiType || "openai-completions"}
            onChange={(e) => setSel((prev: any) => ({ ...(prev || {}), apiType: e.target.value }))}>
            {["openai-completions", "anthropic-messages", "openai-responses", "google-generative-ai"].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {p.apiType === "anthropic-messages" && /\/v1\/?$/i.test(String(p.baseUrl || "")) ? (
            <div className="amw-note is-warn" style={{ marginBottom: 6 }} title={ti("mw.a.322")}>{ti("mw.tx.73")}</div>
          ) : null}
          <div className="amw-section" style={{ margin: "0 0 6px" }}>{ti("mw.tx.74")}</div>
          <HeaderRowsEditor rows={provHeaders} hint={ti("mw.a.323")}
            onChange={(rows) => { setProvHeaders(rows); setHeadersTouched(true); }} />
          {customDetect ? <div style={{ marginTop: 8 }}>{renderDetectCard(customDetect, applyCustomDetect)}</div> : null}
          <div style={{ borderBottom: "1px solid var(--border,#eee)", margin: "12px 0 2px" }} />
        </>
      ) : null}
      <StepHead n={1} title={ti("mw.a.324")} />
      <input className="amw-input" style={{width: "100%", height: 32, fontWeight: 600}} title={ti("mw.a.325")} value={provName || genName(p.baseUrl) || "custom"} onChange={(e) => { setProvName(e.target.value); setProvNameTouched(true); }} placeholder={ti("mw.a.326")} />

      <StepHead n={2} title={ti("mw.a.327")}
        hint={ti("mw.a.328")}
        right={testRes ? <span style={{ fontSize: 11, fontWeight: 700, color: testRes.pass ? "#16a34a" : "#dc2626", whiteSpace: "nowrap" }}>{testRes.pass ? ti("mw.a.329") : ti("mw.a.330")}</span> : null} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input className="amw-input" style={{flex: 1, height: 32, fontFamily: "ui-monospace,monospace"}} type="password" placeholder={ti("mw.a.331")}
          title={ti("mw.tx.76") + ti("mw.tx.48") + ti("mw.tx.77")}
          value={token} onChange={(e) => setToken(e.target.value)} />
        <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", height: 32, flexShrink: 0 }} title={ti("mw.a.332")}
          onClick={() => doTestCreds(p.baseUrl, p.apiType, hdrs)} disabled={testing || (!token.trim() && !validKeyRows.length)}>
          {testing ? ti("mw.a.76") : (<><Ic size={13} paths={ICONS.search} />{ti("mw.tx.75")}</>)}
        </button>
      </div>

      {/* ── multi-key rotation: collapsed one-liner by default; expand for editor + note ── */}
      <div style={{ marginTop: 12, border: "1px solid rgba(99,102,241,.45)", borderRadius: 10, background: "rgba(99,102,241,.05)", padding: "10px 12px" }}>
        <div onClick={() => setMkOpen((v) => !v)} title={ti("mw.tx.80")}
          style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", cursor: "pointer" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 700, fontSize: 12.5, color: "#4f46e5" }}><Ic size={14} paths={ICONS.key} />{ti("mw.tx.78")}</span>
          <span style={{ padding: "1px 8px", borderRadius: 999, border: "1px solid rgba(79,70,229,.35)", color: "#4f46e5", fontSize: 9.5 }}>{ti("mw.tx.228")}</span>
          {validKeyRows.length ? <span style={{ padding: "1px 8px", borderRadius: 999, background: "rgba(79,70,229,.14)", color: "#4f46e5", fontSize: 10.5, fontWeight: 700 }}>{validKeyRows.length + ti("mw.a.190")}</span> : null}
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-subtle,#777)" }}>{mkOpen ? "▾" : "▸"}</span>
        </div>
        {mkOpen ? <>
          <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-subtle,#777)" }}>{ti("mw.tx.80")}</div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {keyRows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input className="amw-input" style={{width: 64, fontFamily: "ui-monospace,monospace"}} placeholder={ti("mw.a.6")} value={r.name} onChange={(e) => setKeyRows((prev) => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} type="password" placeholder="API key（sk-…）" value={r.key} onChange={(e) => setKeyRows((prev) => prev.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
              <input className="amw-input" style={{width: 56}} type="number" min={1} placeholder="rpm" title={ti("mw.a.239")} value={r.rpm || ""} onChange={(e) => setKeyRows((prev) => prev.map((x, j) => j === i ? { ...x, rpm: e.target.value } : x))} />
              <input className="amw-input" style={{width: 72}} placeholder={ti("mw.a.240")} title={ti("mw.a.333")} value={r.minIntervalMs ?? ""} onChange={(e) => setKeyRows((prev) => prev.map((x, j) => j === i ? { ...x, minIntervalMs: e.target.value } : x))} />
              <button className="amw-btn" style={{ padding: "2px 8px" }} title={ti("mw.a.334")} onClick={() => setKeyRows((prev) => prev.filter((_x, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="amw-btn" style={{ padding: "3px 12px", fontSize: 11, alignSelf: "flex-start" }} onClick={() => setKeyRows((prev) => [...prev, { name: "key-" + (prev.length + 1), key: "", rpm: "", minIntervalMs: "" }])}>{ti("mw.tx.81")}</button>
          </div>
        </> : null}
      </div>
      {testBadge(testRes)}

      <StepHead n={3} title={ti("mw.a.335")} hint={known.length ? ti("mw.a.336") : undefined}
        right={<>
          <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "3px 10px", fontSize: 11 }} title={ti("mw.a.337")} disabled={discBusy || (!token.trim() && !validKeyRows.length)} onClick={() => doDiscoverCreds(p.baseUrl, p.apiType, hdrs)}>
            {discBusy ? ti("mw.a.338") : (<><Ic size={11} paths={ICONS.refresh} />{ti("mw.tx.82")}</>)}
          </button>
          {known.length ? <span style={{ fontSize: 11, color: "var(--text-subtle,#666)", whiteSpace: "nowrap" }}>{ti("mw.a.339") + checked.length + " / " + known.length}</span> : null}
        </>} />
      {known.length ? (
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input className="amw-input" style={{flex: 1, minWidth: 180}} placeholder={ti("mw.a.340")} value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} />
            <button className="amw-btn" style={{ padding: "3px 11px" }} onClick={() => setChecked([...new Set([...checked, ...filteredModels()])])}>{ti("mw.tx.39")}</button>
            <button className="amw-btn" style={{ padding: "3px 11px" }} onClick={() => setChecked((prev) => [...prev.filter((id) => !filteredModels().includes(id)), ...filteredModels().filter((id) => !prev.includes(id))])}>{ti("mw.tx.40")}</button>
            <button className="amw-btn" style={{ padding: "3px 11px" }} onClick={() => setChecked((prev) => prev.filter((id) => !filteredModels().includes(id)))}>{ti("mw.tx.41")}</button>
            {modelFilter.trim() ? <span style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{ti("mw.a.341") + filteredModels().length + " / " + known.length}</span> : null}
          </div>
          {discMsg ? <div className={"amw-note " + (discMsg.startsWith("✅") ? "is-ok" : "is-err")} style={{ marginBottom: 6 }}>{discMsg}</div> : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, maxHeight: 220, overflow: "auto", padding: 2 }}>
            {filteredModels().map((id) => (
              <label key={id} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)", cursor: "pointer", background: checked.includes(id) ? "rgba(37,99,235,.12)" : "var(--bg,#fff)" }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(99,102,241,.55)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border,#e0e0e0)"; }}>
                <input type="checkbox" checked={checked.includes(id)} onChange={() => toggleModel(id)} style={{ margin: 0 }} />
                <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 11 }}>{id}</span>
                <EyeBtn title={ti("mw.a.260") + id + ti("mw.a.342")} onClick={() => viewModelParams(sel.id || p.name || "custom", id)} />
              </label>
            ))}
          </div>
        </div>
      ) : <div className="amw-note">{ti("mw.tx.83")}</div>}
      <div style={{ display: "flex", gap: 6, marginBottom: 2, alignItems: "center" }}>
        <input className="amw-input" style={{flex: 1}} placeholder={ti("mw.a.343")} title={ti("mw.a.630")} value={manual} onChange={(e) => setManual(e.target.value)} />
        <button className="amw-btn" onClick={addManual}>{ti("mw.tx.36")}</button>
      </div>

      {/* 底部操作条：提示居左，主按钮右对齐加大（符合习惯的确认位置） */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border,#eee)" }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text-subtle,#666)", lineHeight: 1.5 }}>
          {checked.length ? ti("mw.a.339") + checked.length + ti("mw.a.198") : ti("mw.a.344")}
          {validKeyRows.length ? ti("mw.a.345") + validKeyRows.length + ti("mw.a.190") : ""}
          {!token && !validKeyRows.length ? ti("mw.a.346") : ""}
        </span>
        <button className="amw-btn is-ok" style={{ height: 36, padding: "0 20px", fontSize: 13.5, fontWeight: 700, flexShrink: 0 }}
          onClick={() => { setSaveForce(false); setSaveDlg({ name: (provName || genName(p.baseUrl) || "custom"), baseUrl: p.baseUrl, api: p.apiType, modelCount: checked.length }); }}
          disabled={saving || !checked.length}>
          {saving ? ti("mw.a.55") : checked.length ? ti("mw.a.347") + checked.length + ti("mw.a.198") : ti("mw.a.348")}
        </button>
      </div>
      {savedMsg ? <div className={"amw-note " + (savedMsg.startsWith("✅") ? "is-ok" : "is-err")} style={{ marginTop: 8 }}>{savedMsg}</div> : null}
    </div>
    );
  };

  // 保存确认弹窗：展示自动生成的 provider 名，用户可修改后确认
  // ── P2-A 脱敏导出/导入（G6）：导出白名单字段永无明文 key；导入差异预览 → /save-batch（undo 一步回整批）──
  const doExport = useCallback(async () => {
    try {
      const d = srvFix(await (await api("/export")).json());
      if (!d || !d.ok) { setToast({ msg: ti("mw.a.349") + ((d && d.error) || "?"), ok: false }); setTimeout(() => setToast(null), 4000); return; }
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "aiti-models-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      const cnt = Object.keys(d.providers || {}).length;
      setToast({ msg: ti("mw.a.350") + cnt + ti("mw.a.351") + (Array.isArray(d.skippedCombos) && d.skippedCombos.length ? ti("mw.a.352") + d.skippedCombos.length + ti("mw.a.353") : ""), ok: true });
      setTimeout(() => setToast(null), 4000);
    } catch (e: any) {
      setToast({ msg: ti("mw.a.349") + (e.message || e), ok: false });
      setTimeout(() => setToast(null), 4000);
    }
  }, []);
  const doImportParse = useCallback(async (text: string) => {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch (e: any) { setToast({ msg: ti("mw.a.354") + (e.message || e), ok: false }); setTimeout(() => setToast(null), 4000); return; }
    const providers = parsed && parsed.providers && typeof parsed.providers === "object" ? parsed.providers : parsed;
    setImpDlg((prev: any) => ({ ...(prev || {}), phase: "preview", text, rows: null, applying: false }));
    try {
      const d = srvFix(await (await api("/import", { method: "POST", ...jsonBody({ providers, apply: false }) })).json());
      if (!d || !d.ok) { setToast({ msg: ti("mw.a.355") + ((d && d.error) || "?"), ok: false }); setTimeout(() => setToast(null), 4000); setImpDlg(null); return; }
      setImpDlg((prev: any) => ({ ...(prev || {}), phase: "preview", rows: d.rows || [], errors: d.errors || [], conflictCount: d.conflictCount || 0 }));
    } catch (e: any) {
      setToast({ msg: ti("mw.a.355") + (e.message || e), ok: false }); setTimeout(() => setToast(null), 4000); setImpDlg(null);
    }
  }, []);
  const doImportApply = useCallback(async () => {
    setImpDlg((prev: any) => ({ ...(prev || {}), applying: true }));
    let parsed: any;
    try { parsed = JSON.parse((impDlg && impDlg.text) || ""); } catch { setImpDlg(null); return; }
    const providers = parsed && parsed.providers && typeof parsed.providers === "object" ? parsed.providers : parsed;
    try {
      const d = srvFix(await (await api("/import", { method: "POST", ...jsonBody({ providers, apply: true }) })).json());
      setImpDlg(null);
      if (d && d.ok) {
        const okN = (d.results || []).filter((x: any) => x.ok).length;
        setToast({ msg: ti("mw.a.356") + okN + ti("mw.a.357"), ok: true });
        setTimeout(() => setToast(null), 4500);
        loadStatus();
      } else {
        setToast({ msg: ti("mw.a.358") + ((d && d.error) || "?"), ok: false });
        setTimeout(() => setToast(null), 4500);
      }
    } catch (e: any) {
      setImpDlg(null);
      setToast({ msg: ti("mw.a.358") + (e.message || e), ok: false });
      setTimeout(() => setToast(null), 4500);
    }
  }, [impDlg]);
  const renderImportDlg = () => {
    const rows: any[] = impDlg?.rows || [];
    const kindColor: any = { new: "#16a34a", same: "#b45309", conflict: "#dc2626" };
    const kindLabel: any = { new: ti("mw.a.359"), same: ti("mw.a.360"), conflict: ti("mw.a.361") };
    return (
      <div className="amw-overlay" onClick={(e) => { if (e.target === e.currentTarget) setImpDlg(null); }}>
        <div {...{ "data-ext-float": "1", "data-ext-float-key": "aiti-model-wizard:import-dialog", "data-ext-float-w": 560, "data-ext-float-autoh": "1" }} onClick={(e) => e.stopPropagation()} className="amw-float-panel" style={{ width: "min(560px, 100%)", padding: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}><Ic size={14} paths={ICONS.file} />{ti("mw.tx.84")}</div>
          {impDlg.phase === "paste" ? (
            <>
              <div className="amw-note" style={{ marginBottom: 6 }}>{ti("mw.tx.85")}</div>
              <input type="file" accept=".json,application/json" style={{ fontSize: 11, marginBottom: 6 }}
                onChange={async (e) => {
                  const f = e.target.files && e.target.files[0];
                  if (!f) return;
                  const text = await f.text();
                  setImpDlg((prev: any) => ({ ...(prev || { phase: "paste" }), phase: "paste", text }));
                  void doImportParse(text);
                }} />
              <textarea
                className="amw-input amw-mono"
                style={{ width: "100%", minHeight: 180, fontSize: 11, whiteSpace: "pre", overflowX: "auto" }}
                placeholder={'{ "aitiModelWizardExport": 1, "providers": { … } }'}
                value={impDlg.text || ""}
                onChange={(e) => setImpDlg((prev: any) => ({ ...(prev || { phase: "paste" }), phase: "paste", text: e.target.value }))}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                <button className="amw-btn" onClick={() => setImpDlg(null)}>{ti("mw.tx.12")}</button>
                <button className="amw-btn is-ok" disabled={!(impDlg.text || "").trim()} onClick={() => void doImportParse(impDlg.text)}>{ti("mw.tx.86")}</button>
              </div>
            </>
          ) : (
            <>
              <div className="amw-note" style={{ marginBottom: 6 }}>
                {ti("mw.a.362") + rows.length + ti("mw.a.363") + rows.filter((r) => r.kind === "new").length + ti("mw.a.364") + rows.filter((r) => r.kind === "same").length + ti("mw.a.365") + (impDlg.conflictCount || 0) + ti("mw.a.366")}
              </div>
              <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
                {rows.map((r) => (
                  <div key={r.name} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 8px", borderBottom: "1px solid var(--border)", fontSize: 11.5 }}>
                    <span style={{ flexShrink: 0, padding: "1px 7px", borderRadius: 8, color: "#fff", background: kindColor[r.kind], fontSize: 10 }}>{kindLabel[r.kind]}</span>
                    <span style={{ fontWeight: 600, minWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-subtle,#666)" }}>
                      {r.kind === "conflict" && r.reason ? r.reason : r.modelsExisting + " → " + r.modelsIncoming + ti("mw.a.207")}
                    </span>
                    {r.keepKey ? <span style={{ flexShrink: 0, fontSize: 10, color: "#16a34a" }}>{ti("mw.tx.87")}</span> : null}
                  </div>
                ))}
                {!rows.length ? <div style={{ padding: 10, fontSize: 11, color: "var(--text-subtle,#666)" }}>{ti("mw.tx.88")}</div> : null}
              </div>
              {(impDlg.errors || []).length ? <div className="amw-note is-warn" style={{ marginTop: 6, fontSize: 11 }}>{impDlg.errors.join("；")}</div> : null}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                <button className="amw-btn" onClick={() => setImpDlg((prev: any) => ({ ...(prev || {}), phase: "paste" }))} disabled={impDlg.applying}>{ti("mw.tx.89")}</button>
                <button className="amw-btn is-ok" disabled={impDlg.applying || !rows.length} onClick={() => void doImportApply()}>{impDlg.applying ? ti("mw.a.367") : ti("mw.a.368") + rows.length + ti("mw.a.369")}</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderSaveDlg = () => {
    const validKeyRowsDlg = keyRows.filter((r) => (r.key || "").trim());
    // G3 保存闸门（docs/aiti-model-wizard-uiue-gap-plan.md P0-A）：按测试态渲染状态条——
    // 未测试=黄条+[先测试]；失败=红条+「仍要保存」复选框（enabled:false 落盘）；通过=绿条
    const lt = lastTestMap[String(saveDlg.name || "").trim()];
    const ltPass = !!(lt && lt.pass === true);
    const ltFail = !!(lt && lt.pass === false);
    const barStyle = { padding: "6px 9px", borderRadius: 6, fontSize: 11, marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const };
    return (
    <div className="amw-overlay" onClick={(e) => { if (e.target === e.currentTarget) setSaveDlg(null); }}>
      <div {...SAVE_FLOAT_PROPS} onClick={(e) => e.stopPropagation()} className="amw-float-panel" style={{ width: "min(440px, 100%)", padding: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><Ic size={14} paths={ICONS.tag} />{ti("mw.tx.90")}</div>
        <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>{ti("mw.tx.91")}</label>
        <input className="amw-input" style={{width: "100%", marginBottom: 8, fontWeight: 600}} value={saveDlg.name} onChange={(e) => setSaveDlg((prev: any) => ({ ...prev, name: e.target.value }))} />
        <div className="amw-mono" style={{ fontSize: 11, color: "var(--text-subtle,#666)", marginBottom: 4, wordBreak: "break-all" }}>{"baseUrl: " + saveDlg.baseUrl}</div>
        <div style={{ fontSize: 11, color: "var(--text-subtle,#666)", marginBottom: 8 }}>{"api: " + saveDlg.api + ti("mw.a.370") + saveDlg.modelCount + ti("mw.a.9") + (token ? ti("mw.a.371") : validKeyRowsDlg.length ? ti("mw.a.345") + validKeyRowsDlg.length + ti("mw.a.372") : ti("mw.a.346"))}</div>
        {ltPass ? (
          <div style={{ ...barStyle, background: "rgba(22,163,74,.12)", color: "#16a34a" }}>{ti("mw.tx.198")}{lt.latencyMs != null ? " (" + lt.latencyMs + "ms)" : ""} — safe to save</div>
        ) : ltFail ? (
          <div style={{ ...barStyle, background: "rgba(220,38,38,.12)", color: "#dc2626" }}>
            <span style={{ minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis" }}>{ti("mw.a.373") + String(lt.detail || "").slice(0, 80)}</span>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", flexShrink: 0, color: "var(--text,#333)" }}>
              <input type="checkbox" checked={saveForce} onChange={(e) => setSaveForce(e.target.checked)} />
              {ti("mw.a.375")}
            </label>
          </div>
        ) : (
          <div style={{ ...barStyle, background: "color-mix(in srgb, var(--warn, #f59e0b) 14%, transparent)", color: "#b45309" }}>
            <span style={{ flex: "1 1 auto" }}>{ti("mw.tx.92")}</span>
            <button
              className="amw-btn"
              style={{ flexShrink: 0, padding: "3px 10px" }}
              disabled={testing}
              onClick={async () => { await doTest(saveDlg.baseUrl, saveDlg.api, token || undefined, null); await loadLastTest(); }}
            >{testing ? ti("mw.a.76") : ti("mw.a.374")}</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="amw-btn" onClick={() => { setSaveForce(false); setSaveDlg(null); }} disabled={saving}>{ti("mw.tx.12")}</button>
          <button
            className="amw-btn is-ok"
            disabled={saving || !saveDlg.name.trim() || !checked.length || (ltFail && !saveForce)}
            onClick={() => {
              const nm = saveDlg.name.trim();
              const force = ltFail && saveForce;
              setSaveForce(false); setSaveDlg(null);
              doSave(nm, saveDlg.baseUrl, saveDlg.api, token, !token, force ? false : undefined);
            }}
          >{saving ? ti("mw.a.55") : ltFail && saveForce ? ti("mw.a.375") : ti("mw.a.376")}</button>
        </div>
      </div>
    </div>
  );
  };

  const renderDetectCard = (cd: any, onApply: () => void) => {
    if (!cd) return null;
    if (cd.error) return <div className="amw-note is-err">{"❌ " + cd.error}</div>;
    const rows: any[] = [];
    if (cd.brands && cd.brands.length) {
      for (const b of cd.brands) {
        if (b.provider) rows.push({ text: (<><Ic size={11} paths={ICONS.tag} />{ti("mw.a.377") + [b.provider.cnName, b.provider.name].filter(Boolean).join(" / ")}</>), src: b.source === "openapi" ? ti("mw.a.378") : ti("mw.a.379"), strong: true });
        else if (b.source === "openapi" && b.title) rows.push({ text: (<><Ic size={11} paths={ICONS.file} />{" OpenAPI: " + b.title}</>), src: ti("mw.a.380"), strong: false });
      }
    }
    if (!rows.length && cd.providerGuess) rows.push({ text: (<><Ic size={11} paths={ICONS.tag} />{" " + (cd.providerGuess.confident ? ti("mw.a.381") : ti("mw.a.382")) + [cd.providerGuess.cnName, cd.providerGuess.name].filter(Boolean).join(" / ")}</>), src: cd.providerGuess.confident ? ti("mw.a.383") : ti("mw.a.384"), strong: cd.providerGuess.confident });
    return (
      <div>
        <div className="amw-note is-ok">{"✅ " + cd.hint}</div>
        {rows.map((r, i) => (
          <div key={i} style={{ marginBottom: 4, fontSize: 12 }}>
            <span style={{ padding: "2px 8px", borderRadius: 8, background: r.strong ? "rgba(37,99,235,.1)" : "color-mix(in srgb, var(--warn, #f59e0b) 14%, transparent)", color: r.strong ? "var(--accent,#2563eb)" : "#b45309", marginRight: 6 }}>{r.text}</span>
            <span style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{r.src}</span>
          </div>
        ))}
        {cd.models && cd.models.length ? <div style={{ marginBottom: 4, fontSize: 12, color: "#16a34a" }}>{ti("mw.a.385") + cd.modelCount + ti("mw.a.386")}</div>
          : cd.modelsError ? <div style={{ marginBottom: 4, fontSize: 11, color: "var(--text-subtle,#666)" }}>{ti("mw.a.387") + cd.modelsError.slice(0, 90)}</div> : null}
        <div style={{ display: "flex", gap: 6, margin: "8px 0", alignItems: "center", flexWrap: "wrap" }}>
          {cd.baseUrl ? <span className="amw-mono" style={{ padding: "3px 8px", borderRadius: 8, background: "var(--bg-subtle,#f5f5f5)" }}>{"api=" + cd.api + " · baseUrl=" + cd.baseUrl}</span> : null}
          {cd.api ? <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff" }} onClick={onApply}>{ti("mw.tx.93")}</button> : null}
        </div>
      </div>
    );
  };

  const submitOauthCode = useCallback(async (providerId: string, token2: string, code: string) => {
    setOauthLs({ phase: "progress", message: ti("mw.a.388") });
    try {
      const res = await fetch(apiUrl("/api/auth/login/" + encodeURIComponent(providerId)), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token2, code }),
      });
      if (!res.ok) {
        const d = srvFix(await res.json()).catch(() => ({} as any));
        setOauthLs({ phase: "error", message: d.error ?? ti("mw.a.389") + res.status });
      }
    } catch (e) {
      setOauthLs({ phase: "error", message: e instanceof Error ? e.message : ti("mw.a.390") });
    }
  }, []);

  // 选中的是订阅登录型 → 查询登录状态
  useEffect(() => {
    if (sel?.authType === "oauth") checkOauthStatus([sel.oauthProviderId || sel.id]);
  }, [sel?.id, sel?.authType, checkOauthStatus]);

  // 浏览目录列表：按首字符分组（models.dev 无更细分类）→ 展开显示基本信息 + 已知模型清单；点「＋ 添加」/模型进入接入流程
  const renderBrowse = () => {
    if (!cat || !Array.isArray(cat.providers)) return <div className="amw-note">{ti("mw.tx.94")}</div>;
    const groups = browseGroups() as any;
    const total = groups.reduce((s: number, [, ps]: any) => s + ps.length, 0);
    if (!total) return <div className="amw-note">{ti("mw.tx.95")}</div>;
    return (
      <div style={{ marginBottom: 4 }}>
        <div className="amw-section" style={{marginTop: 4}}>{ti("mw.a.391") + cat.count + ti("mw.a.392")}</div>
        <input className="amw-input" style={{width: "100%", marginBottom: 8}} placeholder={ti("mw.a.393")} value={browseQ} onChange={(e) => setBrowseQ(e.target.value)} />
        <div style={{ maxHeight: "min(52dvh, 460px)", overflow: "auto", border: "1px solid var(--border,#eee)", borderRadius: 10, padding: "0 8px" }}>
          {groups.map(([g, provs]: any) => (
            <div key={g}>
              <div style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--bg,#fff)", fontWeight: 700, fontSize: 12, color: "var(--text-subtle,#666)", padding: "6px 2px", borderBottom: "1px solid var(--border,#eee)" }}>{g}<span style={{ fontWeight: 400, marginLeft: 6, fontSize: 10.5 }}>{provs.length + ti("mw.a.394")}</span></div>
              {provs.map((p: any) => {
                const open = !!browseOpen[p.id];
                const det = browseDetail[p.id] || {};
                const logo = (p.cnName || p.name || "?").trim().charAt(0).toUpperCase();
                return (
                  <div key={p.id} style={{ borderBottom: "1px solid var(--border,#f4f4f4)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 2px", cursor: "pointer", borderRadius: 8 }}
                      onClick={() => browseToggleProv(p.id)} title={open ? ti("mw.a.302") : ti("mw.a.395")}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-subtle,#f7f7fb)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}>
                      <span style={{ width: 13, color: "var(--text-subtle,#999)", fontSize: 11, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
                      <ProviderAvatar id={p.id} name={[p.cnName, p.name].filter(Boolean).join(" / ")} size={22} radius={7} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {[p.cnName, p.name].filter(Boolean).join(" / ") || p.id}
                          {p.hasCn ? <span style={{ marginLeft: 6, padding: "0 6px", borderRadius: 8, background: "rgba(37,99,235,.1)", color: "var(--accent,#2563eb)", fontSize: 9 }}>{ti("mw.tx.96")}</span> : null}
                        </div>
                        <div className="amw-mono" style={{ fontSize: 10.5, color: "var(--text-subtle,#999)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {p.baseUrl || p.id}{det.models && det.models.length ? " · " + det.models.length + ti("mw.a.207") : ""}
                        </div>
                      </div>
                      <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); pickBrowse(p); }}>{ti("mw.tx.36")}</button>
                    </div>
                    {open ? (
                      <div style={{ padding: "0 2px 8px 43px" }}>
                        {det.loading ? <div style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{ti("mw.tx.97")}</div>
                          : det.error ? <div className="amw-note is-err" style={{fontSize: 11}}>{"❌ " + det.error}</div> : null}
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 11, marginBottom: 3, alignItems: "center" }}>
                          {p.apiType ? <span className="amw-mono" style={{color: "var(--text-subtle,#666)"}}>{"api: " + p.apiType}</span> : null}
                          {p.doc ? <a href={LINK(p.doc)} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid var(--border,#e0e0e0)", background: "var(--bg,#fff)", color: "var(--accent,#2563eb)", fontSize: 12, textDecoration: "none" }} title={ti("mw.a.396")}>{ti("mw.tx.98")}</a> : null}
                          {p.signupUrl ? <a href={LINK(p.signupUrl)} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid color-mix(in srgb, var(--ok, #22c55e) 40%, transparent)", background: "color-mix(in srgb, var(--ok, #22c55e) 6%, transparent)", color: "#15803d", fontSize: 12, fontWeight: 600, textDecoration: "none" }} title={ti("mw.a.397")}>{ti("mw.tx.99")}</a> : null}
                          {p.tokenUrl ? <a href={LINK(p.tokenUrl)} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid rgba(99,102,241,.4)", background: "rgba(99,102,241,.06)", color: "#4f46e5", fontSize: 12, fontWeight: 600, textDecoration: "none" }} title={ti("mw.a.398")}>{ti("mw.tx.100")}</a> : null}
                        </div>
                        {p.register ? <div style={{ fontSize: 11, color: "var(--text-subtle,#555)", margin: "2px 0" }}>{String(p.register).slice(0, 160)}</div> : null}
                        {det.models && det.models.length ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                            {det.models.map((m: any, i: number) => (
                              <span key={(m.id || "") + "#" + i} title={(m.name && m.name !== m.id ? m.name + " — " : "") + ti("mw.a.399")} onClick={() => pickBrowse(p)}
                                className="amw-mono" style={{ padding: "2px 8px", borderRadius: 8, border: "1px solid var(--border,#e5e5e5)", background: "var(--bg-subtle,#fafafa)", fontSize: 11, cursor: "pointer" }}
                                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(99,102,241,.5)"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.borderColor = ""; }}>
                                {m.id}{m.name && m.name !== m.id ? <span style={{ color: "var(--text-subtle,#999)" }}>{" · " + m.name}</span> : null}
                              </span>
                            ))}
                          </div>
                        ) : !det.loading && !det.error ? <div style={{ color: "var(--text-subtle,#999)", fontSize: 11 }}>{ti("mw.tx.101")}</div> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderAdd = () => (
    <div>
      {/* 已选中 provider → 只显示配置区（隐藏搜索/推荐列表，避免无从配置）；「更换」回搜索 */}
      {sel ? (
        <div style={{ marginTop: 4 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}><ProviderAvatar id={sel.id} name={[sel.cnName, sel.name].filter(Boolean).join(" / ")} size={24} radius={8} /><span style={{ fontWeight: 700, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[sel.cnName, sel.name].filter(Boolean).join(" / ")}</span></span>
            <button className="amw-btn" style={{ flexShrink: 0 }} title={ti("mw.a.400")} onClick={resetSel}>{ti("mw.tx.102")}</button>
          </div>
          {providerInfo(sel)}
          {sel.authType === "oauth" ? oauthLoginPanel(sel) : credTestSave(sel)}
        </div>
      ) : (
        <div>
          <StepHead n={1} title={ti("mw.a.401")} />
          <form style={{ display: "flex", gap: 8, marginBottom: 10 }} onSubmit={doSearch}>
            <input className="amw-input" style={{flex: 1}} title={ti("mw.a.402")} placeholder={ti("mw.a.403")} value={q} onChange={(e) => { setQ(e.target.value); setSearchDetect(null); setReverseRes(null); }} />
            <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff" }} disabled={searching}>{searching ? ti("mw.a.404") : <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.search} />{ti("mw.tx.103")}</span>}</button>
            {/* 常驻「＋ 自定义」：不搜索也能直接进面板（2026-09-17 拍板） */}
            <button type="button" className="amw-btn" style={{ flexShrink: 0 }} title={ti("mw.a.405")} onClick={startCustom}>{ti("mw.tx.104")}</button>
          </form>
          {cat ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: cat.cache && cat.cache.stale ? "#b45309" : "var(--text-subtle,#666)", fontSize: 11, marginBottom: 8 }}>
              {(() => { const c = cat.cache || {}; const hours = c.ageMs != null ? c.ageMs / 3600000 : null;
                const ageTxt = hours == null ? "" : hours < 1 ? ti("mw.a.406") : hours < 48 ? Math.round(hours) + ti("mw.a.407") : Math.round(hours / 24) + ti("mw.a.408");
                return [
                  <span key="t">{ti("mw.a.409") + cat.count + ti("mw.a.410") + (c.from === "cache" ? (ageTxt ? ageTxt : ti("mw.a.411")) : c.from === "snapshot" ? ti("mw.a.412") : c.from === "none" ? ti("mw.a.413") : c.from || "")
                    + (c.stale && c.from !== "none" ? ti("mw.a.414") : "")
                    + (c.from === "none" ? ti("mw.a.415") : "")}</span>,
                  <button key="btn" className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} disabled={catRefreshing} onClick={doRefreshCatalog} title={ti("mw.a.416")}>{catRefreshing ? ti("mw.a.48") : ti("mw.a.417")}</button>,
                  <button key="browse" className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => setBrowse((v) => !v)} title={ti("mw.a.418")}>{browse ? ti("mw.a.419") : ti("mw.a.420")}</button>,
                ]; })()}
              {catMsg ? <span style={{ color: catMsg.startsWith("✅") ? "#15803d" : "#b91c1c" }}>{catMsg}</span> : null}
            </div>
          ) : null}
          {/* 浏览目录开启 → 替换热门推荐区位置；关闭时未搜索才展示推荐卡片。 */}
          {!results && browse ? renderBrowse() : (!results && rec && rec.length ? (
            <div style={{ marginBottom: 4 }}>
              <div className="amw-section" style={{marginTop: 4}} title={ti("mw.tx.227")}>{ti("mw.tx.105")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(228px,1fr))", gap: 7 }}>
                {rec.map((c: any) => {
                  const logo = (c.main.cnName || c.main.name || "?").trim().charAt(0).toUpperCase();
                  return (
                    <div key={c.id} style={{ border: "1px solid var(--border,#e3e3e3)", borderRadius: 12, padding: "8px 10px", background: "var(--bg,#fff)", boxShadow: "0 1px 3px rgba(0,0,0,.05)", transition: "all .15s" }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(99,102,241,.5)"; e.currentTarget.style.boxShadow = "0 3px 12px rgba(99,102,241,.16)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = ""; e.currentTarget.style.boxShadow = ""; }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                        <ProviderAvatar id={c.id} name={c.main.cnName || c.main.name} size={22} radius={7} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 650, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.main.cnName || c.main.name}</div>
                          <div style={{ fontSize: 10, color: "var(--text-subtle,#999)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.main.name || ""}</div>
                        </div>
                      </div>
                      <div title={c.main.register || ti("mw.a.421")} style={{ fontSize: 10.5, color: "var(--text-subtle,#777)", margin: "0 0 5px", lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.main.register || ti("mw.a.421")}</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                        {c.main.doc ? <a href={LINK(c.main.doc)} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid var(--border,#e0e0e0)", background: "var(--bg,#fff)", color: "var(--accent,#2563eb)", fontSize: 12, textDecoration: "none" }} title={ti("mw.a.396")}>{ti("mw.tx.106")}</a> : null}
                        {c.main.signupUrl ? <a href={LINK(c.main.signupUrl)} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid color-mix(in srgb, var(--ok, #22c55e) 40%, transparent)", background: "color-mix(in srgb, var(--ok, #22c55e) 6%, transparent)", color: "#15803d", fontSize: 12, fontWeight: 600, textDecoration: "none" }} title={ti("mw.a.397")}>{ti("mw.tx.99")}</a> : null}
                        {c.main.tokenUrl ? <a href={LINK(c.main.tokenUrl)} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid rgba(99,102,241,.4)", background: "rgba(99,102,241,.06)", color: "#4f46e5", fontSize: 12, fontWeight: 600, textDecoration: "none" }} title={ti("mw.a.398")}>{ti("mw.tx.100")}</a> : null}
                      </div>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {c.plans.map((pl: any) => (
                          <button key={pl.id} style={{ padding: "3px 10px", fontSize: 11, borderRadius: 7, border: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f7f7f9)", color: "var(--text-muted,#555)", cursor: "pointer", transition: "all .12s" }}
                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(99,102,241,.55)"; e.currentTarget.style.color = "#4f46e5"; e.currentTarget.style.background = "var(--bg,#fff)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border,#e0e0e0)"; e.currentTarget.style.color = ""; e.currentTarget.style.background = ""; }}
                            title={pl.provider.baseUrl + "（" + pl.provider.apiType + "）"} onClick={() => pickPlan(pl)}>{pl.label}</button>
                        ))}
                        {aff && aff[c.id] && aff[c.id].link ? (
                          <a key={"aff-" + c.id} href={aff[c.id].link} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", padding: "3px 10px", fontSize: 11, fontWeight: 600, borderRadius: 7, background: "color-mix(in srgb, var(--ok, #22c55e) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--ok, #22c55e) 35%, transparent)", color: "#15803d", textDecoration: "none" }} title={aff[c.id].note || ti("mw.a.422")}>{ti("mw.tx.107")}</a>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null)}
          {!results ? null : results.length === 0
            ? <div className="amw-note">{ti("mw.tx.108")}</div>
            : results.map((p: any) => (
              <div key={p.id} className={"amw-card" + (sel && sel.id === p.id ? " is-on" : "")} onClick={() => pickProvider(p)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600 }}>{[p.cnName, p.name].filter(Boolean).join(" / ")}{p.hasCn ? <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "rgba(37,99,235,.1)", color: "var(--accent,#2563eb)", fontSize: 10 }}>{ti("mw.tx.96")}</span> : null}{p.native ? <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "rgba(22,163,74,.12)", color: "#15803d", fontSize: 10 }}>{ti("mw.tx.109")}</span> : null}{p.matched && p.matched !== "text" ? <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "color-mix(in srgb, var(--warn, #f59e0b) 14%, transparent)", color: "#b45309", fontSize: 10 }}><Ic size={10} paths={ICONS.refresh} />{ti("mw.a.423") + p.reverseScore}</span> : null}</span>
                  <span className="amw-mono" style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{p.matchedBaseUrl || p.baseUrl || ""}</span>
                </div>
                <div title={p.native ? ti("mw.a.424") + p.modelCount + ti("mw.a.425") : ([p.register || p.doc || ""].filter(Boolean)[0] || "")} style={{ color: "var(--text-subtle,#555)", fontSize: 11, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.native ? ti("mw.a.424") + p.modelCount + ti("mw.a.425") : ([p.register || p.doc || ""].filter(Boolean)[0] || (p.models && p.models.length ? ti("mw.a.426") + p.models.length + ti("mw.a.9") : ti("mw.a.427")))}</div>
              </div>
            ))}
          {searchDetect ? <div style={{ marginTop: 8 }}>{renderDetectCard(searchDetect, applySearchDetect)}</div> : null}
          {reverseRes ? (
            <div style={{ marginTop: 8 }}>
              {reverseRes.candidates && reverseRes.candidates.length ? (
                <div>
                  <StepHead n={2} title={ti("mw.a.428")} hint={ti("mw.a.429")} />
                  {reverseRes.candidates.map((cand: any) => (
                    <div key={cand.id} className={"amw-card" + (sel && sel.id === cand.id ? " is-on" : "")} onClick={() => { setSel({ ...cand, baseUrl: cand.matchedBaseUrl || cand.baseUrl }); setToken(""); setTestRes(null); setChecked([]); setManual(""); setKnown((cand.models || []).map((m: any) => m.id)); }}>
                      <div style={{ fontWeight: 600 }}>{[cand.cnName, cand.name].filter(Boolean).join(" / ") + ti("mw.a.430") + cand.score + "）"}</div>
                      <div className="amw-mono" style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{cand.matchedBaseUrl || cand.baseUrl}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              {reverseRes.detect ? <div style={{ marginTop: 6 }}>{renderDetectCard(reverseRes.detect, applyReverseDetect)}</div> : null}
              {!reverseRes.usedKey ? (
                <div style={{ marginTop: 8, padding: 10, border: "1px dashed var(--border,#e0e0e0)", borderRadius: 8 }}>
                  <div style={{ fontSize: 12, marginBottom: 6, color: "var(--text-subtle,#666)" }} title={ti("mw.a.431")}>{ti("mw.tx.110")}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} type="password" placeholder="API key / token" value={probeKey} onChange={(e) => setProbeKey(e.target.value)} />
                    <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff" }} onClick={doReverseWithKey} disabled={reprobing || !probeKey.trim()}>{reprobing ? ti("mw.a.432") : ti("mw.a.433")}</button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {/* 常驻自定义入口（最末）：有没有匹配到都在（2026-09-17 拍板「有没有匹配到都加」） */}
          <div className="amw-card" style={{ marginTop: 8, borderStyle: "dashed", display: "flex", alignItems: "center", gap: 10 }} onClick={startCustom}
            title={ti("mw.a.434")}>
            <span style={{ width: 28, height: 28, borderRadius: 8, background: "var(--bg-subtle,#f5f5f5)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Ic size={14} paths={ICONS.plus} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{ti("mw.tx.111")}</div>
              <div style={{ fontSize: 11, color: "var(--text-subtle,#666)" }}>{ti("mw.a.435")}</div>
            </div>
            <span className="amw-btn" style={{ flexShrink: 0 }}>{ti("mw.tx.112")}</span>
          </div>
        </div>
      )}
    </div>
  );

  // ── B 阶段双栏：选中 / 左树 / 右详情 ──────────────────────────────
  const selectNode = (node: any) => {
    setSelNode(node);
    if (node?.type === "provider") {
      const p = st && st.providers.find((x: any) => x.provider === node.provider);
      if (p && !p.runtime) {
        if (p.keyCount > 0) loadEditKeys(node.provider); // 多 key 已配置 → 自动加载
        if (p.authType === "oauth") checkOauthStatus([p.oauthProviderId || node.provider]); // 订阅型 → 拉登录态
        const hasNew = newInfo && newInfo.providers && newInfo.providers[node.provider] && newInfo.providers[node.provider].count > 0;
        if (hasNew && !editAvail[node.provider] && !refreshBusy[node.provider]) refreshEditModels(node.provider, p);
      }
    } else if (node?.type === "model") {
      void viewModelParams(node.provider, node.id, false, true); // embedded=true：进详情面板而非浮窗
    } else {
      setViewParam((prev: any) => (prev && prev.embedded ? null : prev)); // 只清内联态，不动浮窗
    }
  };

  const renderTree = () => {
    // 搜索过滤：多词 AND 匹配 provider 名 / 模型 id；provider 命中展开全部模型，仅模型命中则只显示匹配行
    const kws = treeQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (provider: string, id?: string) => (provider + " " + (id || "")).toLowerCase();
    // legend-chip filter (single-select toggle); predicate mirrors the per-model dot in checkDot
    const stMatch = (provider: string, id: string, f: string) => {
      const ck = chk && chk.state && chk.state.models ? chk.state.models[provider + "/" + id] : null;
      const rt = rtOf(provider, id);
      if (f === "ok") return !!ck && ck.lastOk;
      if (f === "rl") return !!ck && ck.rateLimited;
      if (f === "bad") return !!ck && !ck.lastOk && !ck.rateLimited;
      if (f === "rt") return !!(rt && rt.count24h > 0);
      if (f === "untested") return !ck && !(rt && rt.count24h > 0);
      return true;
    };
    const sf = treeStatusFilter;
    const provs = (kws.length
      ? st.providers.filter((p: any) => {
          const pMatch = kws.every((k) => hay(p.provider).includes(k));
          if (pMatch) return true;
          const ids = (p.models || []).map((m: any) => (typeof m === "string" ? m : m.id));
          return ids.some((id: string) => kws.every((k) => hay(p.provider, id).includes(k)));
        })
      : st.providers
    ).filter((p: any) => {
      if (!sf) return true;
      const ids = (p.models || []).map((m: any) => (typeof m === "string" ? m : m.id));
      return ids.some((id: string) => stMatch(p.provider, id, sf));
    });
    return (
    <aside className="amw-sidebar">
      <div className="amw-sidebar-search">
        <div style={{ position: "relative" }}>
          <input className="amw-input" style={{ width: "100%", paddingRight: 26 }} placeholder={ti("mw.a.436")}
            value={treeQ} onChange={(e) => setTreeQ(e.target.value)} />
          {treeQ ? (
            <button className="amw-close" style={{ position: "absolute", right: 3, top: "50%", transform: "translateY(-50%)", width: 20, height: 20, fontSize: 13 }}
              onClick={() => setTreeQ("")} aria-label={ti("mw.a.437")} title={ti("mw.a.437")}>✕</button>
          ) : null}
        </div>
      </div>
      <div className="amw-sidebar-list">
        <div className="amw-group-label">{ti("mw.a.440") + st.providers.length + (kws.length ? ti("mw.a.441") + provs.length + "/" + st.providers.length + " provider" : "")}</div>
        {checkAvail === false ? (
          <div style={{ padding: "0 8px 4px", fontSize: 11, color: "#d97706", lineHeight: 1.5, display: "flex", alignItems: "flex-start", gap: 4 }}>
            <span>{ti("mw.tx.113")}</span>
          </div>
        ) : null}
        {!provs.length ? (
          <div style={{ padding: "14px 8px", fontSize: 11, color: "var(--text-dim,#9ca3af)", textAlign: "center" }}>{ti("mw.a.443") + treeQ.trim() + "」"}</div>
        ) : provs.map((p: any) => {
          const allIds = (p.models || []).map((m: any) => (typeof m === "string" ? m : m.id));
          const selUnder = !!selNode && selNode.provider === p.provider;
          // provider 名命中 → 全量模型；否则只显示命中的模型
          const pNameHit = !kws.length || kws.every((k) => hay(p.provider).includes(k));
          let ids = pNameHit ? allIds : allIds.filter((id: string) => kws.every((k) => hay(p.provider, id).includes(k)));
          if (sf) ids = ids.filter((id: string) => stMatch(p.provider, id, sf));
          const ni = newInfo && newInfo.providers && newInfo.providers[p.provider];
          const agg = aggCheck(p.provider);
          const bal = bals && bals[p.provider];
          const isProvSel = selNode?.type === "provider" && selNode.provider === p.provider;
          const allCount = allIds.length;
          const isCollapsed = (kws.length || selUnder) ? false : (treeCollapsed[p.provider] ?? allCount > 3);
          return (
            <div key={p.provider}>
              <button className="amw-sb-item" aria-current={isProvSel ? "page" : undefined}
                title={(p.baseUrl || "") + " · " + (p.api || "") + (bal && bal.text ? "\n💰 " + bal.text : "")}
                onClick={() => { selectNode({ type: "provider", provider: p.provider }); if (isCollapsed) setTreeCollapsedP(p.provider, true); }}>
                <ProviderAvatar id={p.provider} name={p.provider} size={16} radius={5} />
                <span className="amw-sb-text is-grow">{p.provider}</span>
                {probeBusy[p.provider] ? <span style={{ fontSize: 11, color: "var(--warn, #f59e0b)", flexShrink: 0 }} title={ti("mw.a.126")}>⏳</span>
                  : agg && (agg.ok || agg.rl || agg.err) ? (
                  <span style={{ fontSize: 11, display: "inline-flex", gap: 3, flexShrink: 0 }}>
                    {agg.ok > 0 ? <span style={{ color: "#16a34a", fontWeight: 600 }}>{agg.ok}✓</span> : null}
                    {agg.rl > 0 ? <span style={{ color: "var(--warn, #f59e0b)", fontWeight: 600 }}>{agg.rl}{ti("mw.tx.199")}</span> : null}
                    {agg.err > 0 ? <span style={{ color: "var(--danger, #ef4444)", fontWeight: 600 }}>{agg.err}✗</span> : null}
                  </span>
                ) : null}
                {(() => {
                  // 向导测试留存徽标（P1-A）：last-test.json 最近结论（延迟/通过/限流/失败）。
                  // model-check 已有该 provider 探测聚合时让位（避免同屏两套 ✓/✗ 语义打架）。
                  const lt = lastTestMap[p.provider];
                  if (!lt || (agg && (agg.ok || agg.rl || agg.err))) return null;
                  const age = lt.ts ? ti("mw.a.444") + fmtTimeStr(lt.ts) : "";
                  const okTxt = lt.rateLimited ? ti("mw.a.445") : ti("mw.a.446");
                  if (lt.pass && !lt.partial) {
                    return <span style={{ fontSize: 10, color: lt.rateLimited ? "#d97706" : "#16a34a", fontWeight: 600, flexShrink: 0, cursor: "default" }}
                      title={ti("mw.a.447") + okTxt + (lt.latencyMs != null ? " · " + fmtLat(lt.latencyMs) : "") + age + (lt.keyName ? " · key " + lt.keyName : "")}>
                      {lt.rateLimited ? "🟡" : "✓"}{lt.latencyMs != null ? " " + fmtLat(lt.latencyMs) : ""}</span>;
                  }
                  return <span style={{ fontSize: 10, color: lt.partial ? "#d97706" : "#dc2626", fontWeight: 600, flexShrink: 0, cursor: "default" }}
                    title={ti("mw.a.447") + (lt.detail || (lt.partial ? ti("mw.a.448") : ti("mw.a.449"))) + age}>
                    {lt.partial ? "🟡" : "✗"}</span>;
                })()}
                {bal && bal.exhausted ? <span className="amw-chip is-err" title={bal.text || ti("mw.a.450")}>💸</span> : null}
                {(() => {
                  // 运行期错误观测（带外 · 代理真实流量非 2xx/3xx）：该 provider 组 24h 计数徽标（主导类别图标）
                  const rt = chk && chk.state && chk.state.runtimeErrors && chk.state.runtimeErrors.models;
                  if (!rt) return null;
                  let c1h = 0, c24 = 0, lastStatus = 0, lastAt = 0;
                  for (const [k, m] of Object.entries(rt as Record<string, any>)) {
                    if (!k.startsWith(p.provider + "/")) continue;
                    c1h += m.count1h || 0; c24 += m.count24h || 0;
                    if (m.lastAt > lastAt) { lastAt = m.lastAt; lastStatus = m.lastStatus || 0; }
                  }
                  if (!c24) return null;
                  const info = rtErrInfo(lastStatus);
                  return <span style={{ fontSize: 10, flexShrink: 0, cursor: "default", color: c1h ? "#dc2626" : "#d97706", fontWeight: 600 }}
                    title={rtTip({ count1h: c1h, count24h: c24, byStatus: null, lastAt, lastStatus })}>{info.icon}{c24}</span>;
                })()}
                {p.combo ? <span className="amw-tag is-combo">🧩</span> : null}
                {p.enabled === false ? <span className="amw-tag" style={{ color: "#b45309", borderColor: "var(--warn, #f59e0b)", background: "color-mix(in srgb, var(--warn, #f59e0b) 14%, transparent)" }} title={ti("mw.a.451")}>{ti("mw.a.495")}</span> : null}
                {(() => {
                  // 树上禁用 key 数徽标：不点详情也能看到有 key 处于禁用态
                  const dis = (p.keys || []).filter((k: any) => k && k.enabled === false).length;
                  if (!dis) return null;
                  return <span style={{ fontSize: 9, flexShrink: 0, color: "#b45309", border: "1px solid color-mix(in srgb, var(--warn, #f59e0b) 50%, transparent)", background: "color-mix(in srgb, var(--warn, #f59e0b) 12%, transparent)", borderRadius: 5, padding: "0 4px", cursor: "default" }}
                    title={dis + ti("mw.a.452")}>🔑⏸{dis}</span>;
                })()}
                {p.authType === "oauth" ? <span className="amw-tag is-oauth">🔐</span> : null}
                {p.runtime ? <span className="amw-tag is-ro">{ti("mw.tx.117")}</span> : null}
                {ni && ni.count > 0 ? <span className="amw-tag is-new">{"+" + ni.count}</span> : null}
                {isCollapsed && allCount ? <span className="amw-sb-count">{allCount}</span> : null}
                <span role="button" tabIndex={-1} className="amw-tree-toggle" aria-expanded={!isCollapsed}
                  title={isCollapsed ? ti("mw.tx.209", { n: allCount }) : ti("mw.tx.208", { n: allCount })}
                  onClick={(e) => { e.stopPropagation(); setTreeCollapsedP(p.provider, !isCollapsed); }}>{isCollapsed ? "▸" : "▾"}</span>
              </button>
              {!isCollapsed && ids.map((id: string) => {
                const isModelSel = selNode?.type === "model" && selNode.provider === p.provider && selNode.id === id;
                const probe = capProbes[p.provider + "/" + id];
                const mDef = (p.models || []).find((m: any) => (typeof m === "string" ? m : m && m.id) === id);
                const mEn = !(mDef && typeof mDef === "object" && mDef.enabled === false);
                return (
                  <button key={id} className="amw-sb-item is-indent" aria-current={isModelSel ? "page" : undefined}
                    onClick={() => selectNode({ type: "model", provider: p.provider, id })}>
                    <span className="amw-sb-text is-grow" style={{ color: mEn ? "var(--text-muted)" : "#b45309", ...(mEn ? {} : { textDecoration: "line-through", opacity: 0.55 }) }}>{id}</span>
                    {!mEn ? <span style={{ fontSize: 9, color: "#b45309", flexShrink: 0 }} title={ti("mw.a.453")}>⏸</span> : null}
                    {checkDot(p.provider, id)}
                    {probe?.phase === "probing" ? <span style={{ fontSize: 9, color: "var(--warn, #f59e0b)", flexShrink: 0 }} title={ti("mw.a.454")}>⏳</span> : null}
                    {probe?.phase === "done" && !probe.error ? <span style={{ fontSize: 9, color: "var(--ok, #10b981)", flexShrink: 0 }} title={probe.corrected ? ti("mw.a.455") : ti("mw.a.456")}>{probe.corrected ? "↓" : "✓"}</span> : null}
                    {probe?.phase === "done" && probe.error ? <span style={{ fontSize: 9, color: "var(--danger, #ef4444)", flexShrink: 0 }} title={probe.error}>!</span> : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
    );
  };

  const renderDetailPane = () => {
    const p = selNode ? (st?.providers || []).find((x: any) => x.provider === selNode.provider) : null;
    if (!selNode || !p) {
      return (
        <div className="amw-detail" style={{ flex: 1, minWidth: 0 }}>
          <div className="amw-empty">{ti("mw.tx.118")}</div>
        </div>
      );
    }
    // 小屏钻取返回条（大屏无）
    const back = !small ? null : (
      <div className="amw-header" style={{ padding: "6px 10px" }}>
        <button className="amw-btn" onClick={() => selectNode(selNode.type === "model" ? { type: "provider", provider: selNode.provider } : null)}>{ti("mw.tx.14")}</button>
        <span style={{ fontWeight: 650, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selNode.type === "model" ? selNode.id : selNode.provider}</span>
      </div>
    );
    // 模型详情：内联 ParamPanel（不再是浮窗）
    if (selNode.type === "model") {
      const fresh = viewParam && viewParam.provider === selNode.provider && viewParam.id === selNode.id;
      const mk = selNode.provider + "/" + selNode.id;
      const ck = chk && chk.state && chk.state.models ? chk.state.models[mk] : null;
      const probing = !!probeBusy[mk];
      return (
        <div className="amw-detail" style={{ flex: 1, minWidth: 0, padding: 0, display: "flex", flexDirection: "column" }}>
          {back}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--border,#eee)", flexShrink: 0 }}>
            <span className="amw-mono" style={{ fontWeight: 650, fontSize: 12.5 }}>{selNode.id}</span>
            {probing ? <span style={{ fontSize: 11, color: "var(--warn, #f59e0b)" }}>{ti("mw.a.126")}</span>
              : checkAvail === false ? <span style={{ fontSize: 11, color: "#d97706" }}>{ti("mw.tx.119")}</span>
              : ck ? <span style={{ fontSize: 11, fontWeight: 600, color: ck.lastOk ? "#16a34a" : ck.rateLimited ? "var(--warn, #f59e0b)" : "var(--danger, #ef4444)" }}>{ck.lastOk ? ti("mw.a.457") : ck.rateLimited ? ti("mw.a.458") : ti("mw.a.459")}</span>
              : <span style={{ fontSize: 11, color: "var(--text-dim,#999)" }}>{ti("mw.a.475")}</span>}
            {(() => {
              const rt = rtOf(selNode.provider, selNode.id);
              if (!rt || !rt.count24h) return null;
              const hot = rt.count1h > 0;
              const info = rtErrInfo(rt.lastStatus);
              return (
                <span style={{ fontSize: 10.5, fontWeight: 600, color: hot ? "#dc2626" : info.color, cursor: "default" }}
                  title={rtTip(rt)}>
                  {info.icon + ti("mw.a.460") + info.label + " ×" + rt.count24h + (hot ? "（1h×" + rt.count1h + "）" : "")}
                </span>
              );
 })()}
            <div style={{ flex: 1 }} />
            <button className="amw-btn" style={{ padding: "3px 8px" }} disabled={checkAvail === false || probing} title={checkAvail === false ? ti("mw.a.461") : ti("mw.a.462")} onClick={() => void runCheck(selNode.provider, selNode.id)}>
              {probing ? ti("mw.a.126") : (<><Ic size={12} paths={ICONS.stethoscope} /> {ti("mw.tx.120")}</>)}
            </button>
          </div>
          <ParamPanel
            embedded
            data={fresh ? viewParam : { provider: selNode.provider, id: selNode.id, loading: true }}
            dialogEl={rootRef.current}
            onClose={() => selectNode({ type: "provider", provider: selNode.provider })}
            onSaved={(resp: any) => {
              // 参数保存成功 → 同步缺参 banner（与主渲染 ParamDialog 的 onSaved 同语义）
              const savedId = selNode.id;
              const left = resp && Array.isArray(resp.missingParams) ? resp.missingParams.map((x: any) => x && x.id).filter(Boolean) : [];
              setMissingInfo((prev: any) => {
                if (!prev || !savedId) return prev;
                if (left.includes(savedId)) return prev;
                const models = (prev.models || []).filter((x: any) => x.id !== savedId);
                return models.length ? { ...prev, models } : null;
              });
              loadStatus();
              if (savedId) void runProbeCaps(selNode.provider, [savedId]);
            }}
          />
        </div>
      );
    }
    // provider 详情：头部（品牌/标签/检查概要/动作）+ 连接与模型编辑
    const ni = newInfo && newInfo.providers && newInfo.providers[p.provider];
    const agg = aggCheck(p.provider);
    const segs: any[] = [];
    if (agg) {
      if (agg.ok) segs.push({ t: agg.ok + ti("mw.a.275"), c: "#16a34a" });
      if (agg.rl) segs.push({ t: agg.rl + ti("mw.a.463"), c: "#dc2626" });
      if (agg.err) segs.push({ t: agg.err + ti("mw.a.464"), c: "#d97706" });
      if (agg.pend) segs.push({ t: agg.pend + ti("mw.a.465"), c: "#9ca3af" });
    }
    // 运行期错误观测（带外 · 代理真实流量非 2xx/3xx）：与探测状态独立，临时故障可能尚未反映到探测
    {(() => {
      const rt = chk && chk.state && chk.state.runtimeErrors && chk.state.runtimeErrors.models;
      if (!rt) return;
      let n = 0, c1h = 0, c24 = 0;
      for (const [k, m] of Object.entries(rt as Record<string, any>)) {
        if (!k.startsWith(p.provider + "/") || !m.count24h) continue;
        n++; c1h += m.count1h || 0; c24 += m.count24h || 0;
      }
      if (n) segs.push({ t: "⚡ " + n + ti("mw.a.466") + c24 + "/24h" + (c1h ? "（1h×" + c1h + "）" : ""), c: c1h ? "#dc2626" : "#d97706" });
    })()}
    const ids = (p.models || []).map((m: any) => (typeof m === "string" ? m : m.id));
    return (
      <div className="amw-detail" style={{ flex: 1, minWidth: 0, padding: 0, display: "flex", flexDirection: "column" }}>
        {back}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <ProviderAvatar id={p.provider} name={p.provider} size={34} radius={10} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="amw-detail-title">{p.provider}</span>
                {p.combo ? <span className="amw-tag is-combo">{ti("mw.a.596")}</span> : null}
                {p.authType === "oauth" ? <span className="amw-tag is-oauth">{ti("mw.a.593")}</span> : null}
                {p.runtime ? <span className="amw-tag is-ro">{ti("mw.tx.121")}</span> : null}
                {ni && ni.count > 0 ? <span className="amw-tag is-new">{"+" + ni.count}</span> : null}
              </div>
              <div style={{ fontSize: 11, display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                {segs.length ? segs.map((s, i) => <span key={i} style={{ color: s.c, fontWeight: 600 }}>{(i ? " · " : "") + s.t}</span>) : checkAvail === false ? <span style={{ color: "#d97706" }}>{ti("mw.tx.122")}</span> : <span style={{ color: "var(--text-subtle,#999)" }}>{ti("mw.tx.123")}</span>}
                <span style={{ color: "var(--text-subtle,#999)" }}>{p.runtime ? ids.length + ti("mw.a.467") : ids.length + ti("mw.a.468") + (p.hasKey ? (p.keyCount > 1 ? p.keyCount + " keys" : ti("mw.a.469")) : ti("mw.a.470"))}</span>
                {(() => {
                  // 禁用 key 计数徽标：禁用态只在「多 Key 轮转」折叠区可见，摘要层面
                  // 不提示的话"是否禁用"完全不可知（keys 由 /status 带出，maskKeyEntry 保留 enabled）
                  const dis = (p.keys || []).filter((k: any) => k && k.enabled === false).length;
                  if (!dis) return null;
                  return <span className="amw-tag" style={{ color: "#b45309", borderColor: "var(--warn, #f59e0b)", background: "color-mix(in srgb, var(--warn, #f59e0b) 14%, transparent)" }}
                    title={ti("mw.a.471") + dis + ti("mw.a.472")}>{ti("mw.tx.200", { n: dis })}</span>;
                })()}
                {(() => {
                  // 健康条（P1-A/P1-B）：①向导测试留存结论 + 就地重测（服务端自动留存）
                  // ②余额：aiti-provider-usage 服务优先（富 bucket），缺席回退 model-check 文案
                  // 订阅登录型不进此条（无 baseUrl 可测，登录态/credits 在「订阅」页管理）
                  if (p.runtime || p.combo || p.authType === "oauth") return null;
                  const lt = lastTestMap[p.provider];
                  const qt = quickTest[p.provider];
                  const us = p.authType === "oauth" ? null : usageMap[p.provider];
                  const bal = bals && bals[p.provider];
                  const bad = !!(agg && agg.err > 0); // 非 429 异常 → 疑似欠费/失效（修正“余额正常”误报）
                  const uText = usageText(us && us.entry);
                  const uBad = !!(us && us.entry && (us.entry.report && us.entry.report.exhausted || us.entry.status === "query-failed"));
                  const balBad = !!(bal && bal.exhausted) || bad;
                  const hasAny = lt || qt || us || bal || bad;
                  if (!hasAny) {
                    return (
                      <span style={{ width: "100%", display: "inline-flex", alignItems: "center", gap: 8, color: "var(--text-subtle,#999)", flexWrap: "wrap" }}>
                        <span>{ti("mw.tx.124")}</span>
                      </span>
                    );
                  }
                  return (
                    <span style={{ width: "100%", display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", rowGap: 3 }}>
                      {/* ① 向导测试结论（留存）+ 重测 */}
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <span style={{ color: !lt ? "var(--text-subtle,#999)" : lt.pass ? (lt.rateLimited ? "#d97706" : "#16a34a") : lt.partial ? "#d97706" : "#dc2626", fontWeight: 600 }}
                          title={lt ? (ti("mw.a.473") + (lt.detail || "") + (lt.ts ? ti("mw.a.444") + fmtTimeStr(lt.ts) : "") + (lt.keyName ? " · key " + lt.keyName : "")) : ti("mw.a.474")}>
                          {"🩺 " + (!lt ? ti("mw.a.475") : lt.pass && !lt.partial ? (lt.rateLimited ? ti("mw.a.476") : ti("mw.a.446")) : lt.partial ? ti("mw.a.477") : ti("mw.a.449")) + (lt && lt.latencyMs != null ? " · " + fmtLat(lt.latencyMs) : "")}
                        </span>
                        <button className="amw-btn" style={{ padding: "1px 8px", fontSize: 10.5 }} disabled={!!(qt && qt.busy)}
                          title={ti("mw.a.478")}
                          onClick={() => void runQuickTest(p)}>{qt && qt.busy ? ti("mw.a.76") : ti("mw.a.479")}</button>
                      </span>
                      {/* ② 余额：provider-usage 优先；qt.res 测试反馈行内展示 */}
                      {us && us.phase === "ok" && us.entry && us.entry.status === "ready" && uText ? (
                        <span style={{ color: uBad ? "#dc2626" : "var(--text-subtle,#999)", fontWeight: uBad ? 600 : 400, cursor: "default" }}
                          title={(us.entry.report && Array.isArray(us.entry.report.buckets) ? us.entry.report.buckets.map((b: any) => (b.label || b.id) + ": " + [b.used != null ? ti("mw.a.480") + b.used : "", b.remaining != null ? ti("mw.a.481") + b.remaining : "", b.limit != null ? ti("mw.a.482") + b.limit : ""].filter(Boolean).join("/")).join("\n") : "")
                            + (us.capturedAt ? ti("mw.a.483") + fmtTimeStr(us.capturedAt) + ti("mw.a.484") : "")}>
                          {"💰 " + (uBad ? ti("mw.a.485") : ti("mw.a.486")) + uText}
                        </span>
                      ) : us && us.phase === "loading" ? <span style={{ color: "var(--text-subtle,#999)" }}>{ti("mw.tx.125")}</span>
                        : us && (us.phase === "err" || (us.phase === "ok" && us.error)) ? (
                          <span style={{ display: "inline-flex", gap: 5, alignItems: "center", color: "#d97706" }}>
                            <span title={us.message || us.error}>{ti("mw.tx.126")}</span>
                            <button className="amw-btn" style={{ padding: "1px 8px", fontSize: 10.5 }} onClick={() => void loadUsage(p.provider, true)}>{ti("mw.tx.127")}</button>
                          </span>
                        ) : us && us.phase === "na" ? null
                        : (bal || bad) ? (
                          <span style={{ color: balBad ? "#dc2626" : "var(--text-subtle,#999)", fontWeight: balBad ? 600 : 400 }}>
                            {"💰 " + (bal && bal.exhausted ? ti("mw.a.487") : bad ? ti("mw.a.488") : (bal && bal.text) || ti("mw.a.489"))}
                          </span>
                        ) : null}
                      {qt && qt.res ? testBadge(qt.res) : null}
                    </span>
                  );
                })()}
              </div>
            </div>
            <button className="amw-btn" style={{ padding: "3px 8px" }} disabled={checkAvail === false || !!probeBusy[p.provider]} title={checkAvail === false ? ti("mw.a.461") : ti("mw.a.490")} onClick={() => void runCheck(p.provider)}>
              {probeBusy[p.provider] ? ti("mw.a.126") : (<><Ic size={12} paths={ICONS.stethoscope} /> {ti("mw.tx.120")}</>)}
            </button>
            {p.runtime ? null : <button className="amw-btn" style={{ padding: "3px 8px" }} title={ti("mw.a.491")} onClick={() => doRefreshProxies(p.provider)}><Ic size={12} paths={ICONS.refresh} /></button>}
            {p.runtime || p.authType === "oauth" ? null : (
              <button className="amw-btn" style={{ padding: "3px 8px", ...(p.enabled === false ? { color: "#b45309", borderColor: "var(--warn, #f59e0b)", background: "color-mix(in srgb, var(--warn, #f59e0b) 12%, transparent)" } : {}) }}
                title={p.enabled === false ? ti("mw.a.492") : ti("mw.a.493")}
                onClick={() => doToggleProvider(p.provider, p.enabled === false)}>
                {p.enabled === false ? ti("mw.a.494") : ti("mw.a.495")}
              </button>
            )}
            {p.runtime || p.authType === "oauth" ? null : <button className="amw-btn is-danger" style={{ padding: "3px 8px" }} title={ti("mw.a.496")} onClick={() => doDelete(p.provider)}><Ic size={12} paths={ICONS.trash} /></button>}
          </div>
          {p.combo ? (
            <div className="amw-note" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1 }}>{ti("mw.tx.128")}</span>
              <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => void openComboEditorFor(p.provider)}>{ti("mw.tx.129")}</button>
            </div>
          ) : null}
          {p.authType === "oauth" ? (
            <div className="amw-note" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1 }}>{ti("mw.tx.130")}</span>
              {p.hasKey ? (
                <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, color: "#dc2626" }} disabled={logoutBusy === p.provider}
                  title={ti("mw.a.316")}
                  onClick={() => void doOauthLogout(p.provider, p.name || p.provider)}>
                  {logoutBusy === p.provider ? ti("mw.a.305") : ti("mw.a.121")}
                </button>
              ) : null}
              <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => { setTab("subs"); loadSubs(); }}>{ti("mw.tx.131")}</button>
            </div>
          ) : null}
          {p.runtime ? (
            <div className="amw-note" style={{ marginBottom: 0 }}>{ti("mw.tx.132")}</div>
          ) : null}
          {p.authType === "api_key" ? (
            <div className="amw-note" style={{ marginBottom: 0 }}>
              {ti("mw.tx.201")}
              {apiKeyRow(p.provider, p.provider, true, true)}
            </div>
          ) : null}
          {!p.combo ? renderEditControls(p) : null}
          {/* G1+G2 启用作用域（G5 cwd 由宿主 settingsModels 契约透传；浮窗态 cwd=null=全局 scope） */}
          {/* Combo groups own no key and their virtual models are provided by the runtime engine;
              the host enabled-models view cannot list them, so the empty state here was misleading. */}
          {p.combo ? null : <EnabledScopeBlock providerId={p.provider} cwd={cwd ?? null} />}
        </div>
      </div>
    );
  };

  const renderStatus = () => {
    if (!st) return <div className="amw-note">{ti("mw.tx.6")}</div>;
    if (!st.providers.length) return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
        <div className="amw-note" style={{ marginBottom: 0 }}>{ti("mw.a.497") + (st.file || "")}</div>
        <button className="amw-btn is-primary" onClick={() => { setTab("add"); setMsg(""); }}>{ti("mw.tx.133")}</button>
      </div>
    );
    // 新模型醒目横幅：每个新模型可勾选 + 元数据标签；一键启用 / 编辑 / 知道了（不自动清）
    const niTotal = newInfo && newInfo.total ? newInfo.total : 0;
    const niRows = niTotal && newInfo.providers ? Object.entries(newInfo.providers) : [];
    const isSel = (prov: string, id: string) => {
      const e = nmSel[prov];
      return e ? e.includes(id) : true; // 缺省全选
    };
    const toggleSel = (prov: string, id: string, all: string[]) => setNmSel((prev: any) => {
      const cur = prev[prov] !== undefined ? prev[prov].slice() : all.slice();
      const i = cur.indexOf(id);
      if (i >= 0) cur.splice(i, 1); else cur.push(id);
      return { ...prev, [prov]: cur };
    });
    // 批量选择：all=该 provider 的全部新模型；undefined 语义=缺省全选，操作后落为显式数组
    const selAllNew = (prov: string, all: string[]) => setNmSel((prev: any) => ({ ...prev, [prov]: all.slice() }));
    const selInvNew = (prov: string, all: string[]) => setNmSel((prev: any) => {
      const cur = prev[prov] !== undefined ? prev[prov].slice() : all.slice();
      return { ...prev, [prov]: all.filter((id) => !cur.includes(id)) };
    });
    const selNoneNew = (prov: string) => setNmSel((prev: any) => ({ ...prev, [prov]: [] }));
    const openEdit = (prov: string) => {
      selectNode({ type: "provider", provider: prov });
      // 反馈保障：从新模型 toast 打开向导时 C4 已自动选中首个新模型 provider，此处再点「编辑」selNode
      // 不变 → 视觉零反馈，像「按钮无效」（旧版整屏编辑视图必有反馈，重构后同 provider 重复选中就丢了）。
      // 补：滚动详情面板到可视区并定位到编辑区 + 高亮脉冲，保证任何情况下点了都有明确回应。
      requestAnimationFrame(() => setTimeout(() => {
        const pane = rootRef.current && (rootRef.current.querySelector(".amw-detail") as HTMLElement | null);
        if (!pane) return;
        try { pane.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch { /* 老浏览器降级为无滚动 */ }
        const editBlock = rootRef.current && (rootRef.current.querySelector("[data-amw-edit]") as HTMLElement | null);
        const target = editBlock || pane;
        try { if (editBlock) editBlock.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { /* 同上 */ }
        target.style.transition = "box-shadow .3s ease";
        target.style.boxShadow = "0 0 0 3px rgba(37,99,235,.55)";
        setTimeout(() => { target.style.boxShadow = ""; }, 900);
      }, 30));
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
        {cleanupEdit ? (
          // 🛠 一键整理横幅（来自模型检查「一键编辑」）：预选结果总览 + 逐家编辑/保存 + 全部保存/取消
          <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 10, background: "rgba(37,99,235,.08)", border: "1px solid rgba(37,99,235,.4)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: "var(--accent,#2563eb)", flex: 1, minWidth: 220 }}>
                {ti("mw.a.498") + new Date(cleanupEdit.ts).toLocaleTimeString("zh-CN", { hour12: false }) + ti("mw.a.499")}
              </span>
              {cleanupBusy ? (
                <span style={{ fontSize: 12, color: "var(--accent,#2563eb)", fontWeight: 600 }}>{ti("mw.a.500") + (cleanupBusy.done + 1) + "/" + cleanupBusy.total + " · " + cleanupBusy.cur + "…"}</span>
              ) : (
                <>
                  <button className="amw-btn is-ok" disabled={busy || !cleanupPending.length}
                    title={cleanupPending.length ? ti("mw.a.501") : ti("mw.a.502")}
                    onClick={cleanupSaveAll}>{ti("mw.a.503") + cleanupPending.length + ti("mw.a.504")}</button>
                  <button className="amw-btn" disabled={busy || !!cleanupBusy} title={ti("mw.a.505")} onClick={cleanupCancel}>{ti("mw.tx.12")}</button>
                </>
              )}
            </div>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
              {cleanupEdit.plan.map((e: any) => (
                <div key={e.provider} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11.5, padding: "2px 0" }}>
                  <span style={{ fontWeight: 650 }}>{e.provider}</span>
                  {e.skip === "combo" ? <span style={{ color: "var(--text-subtle,#666)" }}>{ti("mw.tx.134")}</span>
                    : e.skip === "oauth" ? <span style={{ color: "var(--text-subtle,#666)" }}>{ti("mw.tx.135")}</span>
                    : e.skip === "runtime" ? <span style={{ color: "var(--text-subtle,#666)" }}>{ti("mw.tx.136")}</span>
                    : e.saved ? <span style={{ color: "#16a34a", fontWeight: 600 }}>{ti("mw.tx.137")}</span>
                    : <>
                      <span style={{ color: "#16a34a" }}>{ti("mw.a.506") + e.keep.length}</span>
                      {e.remove.length ? (
                        <span style={{ color: "#dc2626" }} title={ti("mw.a.507") + e.remove.map((r: any) => r.id + "（" + r.label + "）").join("、")}>
                          {ti("mw.a.265") + e.remove.length + "：" + e.remove.slice(0, 4).map((r: any) => r.id + "（" + r.label + "）").join("、") + (e.remove.length > 4 ? ti("mw.a.508") : "")}
                        </span>
                      ) : null}
                      {e.soft.length ? (
                        <span style={{ color: "#d97706" }} title={ti("mw.a.509") + e.soft.map((r: any) => r.id + "（" + r.label + "）").join("、")}>
                          {ti("mw.a.510") + e.soft.length + ti("mw.a.511")}
                        </span>
                      ) : null}
                      {e.remove.length && !e.keep.length ? (
                        <span style={{ color: "#dc2626", fontWeight: 600 }} title={ti("mw.a.512")}>{ti("mw.tx.138")}</span>
                      ) : null}
                      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
                        <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} title={ti("mw.a.513")} onClick={() => openEdit(e.provider)}>{ti("mw.tx.17")}</button>
                        {e.remove.length && e.keep.length ? (
                          <button className="amw-btn is-ok" style={{ padding: "2px 10px", fontSize: 11 }} disabled={busy || !!cleanupBusy} onClick={() => cleanupSaveOne(e)}>{ti("mw.a.56")}</button>
                        ) : null}
                      </span>
                    </>}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-subtle,#666)" }}>
              {ti("mw.tx.202")}
            </div>
          </div>
        ) : null}
        {niRows.length ? (
          <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 10, background: "color-mix(in srgb, var(--ok, #22c55e) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--ok, #22c55e) 40%, transparent)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: "#15803d", flex: 1 }}>{ti("mw.a.514") + niTotal + ti("mw.a.515")}</span>
              <button className="amw-btn" style={{ padding: "3px 10px", fontSize: 11 }} title={ti("mw.a.516")} onClick={() => ackNew()}>{ti("mw.tx.139")}</button>
            </div>
            {niRows.map(([name, v]: any) => {
              const all = v.newModels || [];
              return (
                <div key={name} style={{ marginTop: 8, padding: "7px 9px", background: "rgba(255,255,255,.6)", borderRadius: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 650, fontSize: 12, color: "#15803d", flex: 1 }}>{name + ti("mw.a.517") + v.count}</span>
                    <button disabled={nmBusy === name || !all.length} onClick={() => selAllNew(name, all)} title={ti("mw.a.518")} className="amw-btn" style={{ padding: "2px 8px", fontSize: 11 }}>{ti("mw.tx.39")}</button>
                    <button disabled={nmBusy === name || !all.length} onClick={() => selInvNew(name, all)} title={ti("mw.a.519")} className="amw-btn" style={{ padding: "2px 8px", fontSize: 11 }}>{ti("mw.tx.40")}</button>
                    <button disabled={nmBusy === name || !all.length} onClick={() => selNoneNew(name)} title={ti("mw.a.520")} className="amw-btn" style={{ padding: "2px 8px", fontSize: 11 }}>{ti("mw.tx.41")}</button>
                    <button disabled={nmBusy === name || !all.length}
                      onClick={() => enableNewModels(name, nmSel[name] !== undefined ? nmSel[name] : all)}
                      className="amw-btn" style={{ background: nmBusy === name ? "#9ca3af" : "#16a34a", color: "#fff", border: "none", borderRadius: 6, padding: "3px 10px", fontSize: 11, fontWeight: 650, cursor: "pointer" }}>
                      {nmBusy === name ? ti("mw.a.521") : ti("mw.a.522")}
                    </button>
                    <button onClick={() => openEdit(name)} title={ti("mw.a.523")} className="amw-btn" style={{ padding: "3px 10px", fontSize: 11 }}>{ti("mw.tx.17")}</button>
                    <button disabled={nmBusy === name || !all.length}
                      onClick={() => ignoreNew(name)} title={ti("mw.a.524")}
                      className="amw-btn" style={{ padding: "3px 10px", fontSize: 11 }}>{ti("mw.tx.140")}</button>
                  </div>
                  {all.map((id: string) => {
                    const md = (nmMeta[name] || {})[id] || null;
                    const tags = [];
                    if (md && md.contextWindow) tags.push(fmtTok(md.contextWindow) + " ctx");
                    if (md && md.maxTokens) tags.push(fmtTok(md.maxTokens) + " out");
                    if (md && md.reasoning) tags.push(ti("mw.a.1"));
                    if (md && Array.isArray(md.input)) tags.push(md.input.join("/"));
                    return (
                      <label key={id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, padding: "2px 0 2px 2px", cursor: "pointer" }}>
                        <input type="checkbox" checked={isSel(name, id)} onChange={() => toggleSel(name, id, all)} />
                        <span className="amw-mono" style={{fontWeight: 600}}>{id}</span>
                        {tags.length ? <span style={{ color: "var(--text-muted, #6b7280)", fontSize: 10 }}>{tags.join(" · ")}</span> : null}
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          {([["ok", ti("mw.a.66"), "#16a34a", ti("mw.a.127")], ["rl", ti("mw.a.103"), "var(--warn, #f59e0b)", ti("mw.a.128")], ["bad", ti("mw.tx.114"), "var(--danger, #ef4444)", ti("mw.a.129")], ["rt", ti("mw.tx.115"), "#d97706", ti("mw.a.442")], ["untested", ti("mw.a.475"), "var(--text-dim,#9ca3af)", ti("mw.tx.116")]] as [string, string, string, string][]).map(([key, label, color, tip]) => (
            <button key={key} className="amw-legend-chip" aria-pressed={treeStatusFilter === key}
              title={tip}
              style={treeStatusFilter === key ? { borderColor: "var(--accent, #2563eb)", color: "var(--accent, #2563eb)", background: "color-mix(in srgb, var(--accent, #2563eb) 10%, transparent)" } : undefined}
              onClick={() => setTreeStatusFilter(treeStatusFilter === key ? "" : key)}>
              <span className="amw-vdot" style={{ background: color }} />{label}
            </button>
          ))}
          <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} disabled={!!(checkupSt && checkupSt.running)}
            title={ti("mw.a.438")}
            onClick={runCheckup}>
            {(checkupSt && checkupSt.running) ? ti("mw.a.439") : ti("mw.a.23")}
          </button>
          <span style={{ color: "var(--text-subtle,#666)", fontSize: 11, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ti("mw.a.525") + st.providers.length + ti("mw.a.526") + st.file}</span>
          {undoInfo ? <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, color: "#b45309" }} title={ti("mw.a.527") + undoInfo + ti("mw.a.528")} onClick={undoSave}>{ti("mw.tx.141")}</button> : null}
          <button className="amw-btn" title={ti("mw.a.529")} onClick={() => doRefreshProxies()}><Ic size={12} paths={ICONS.refresh} /> {ti("mw.tx.142")}</button>
          <button className="amw-btn" onClick={loadStatus} disabled={busy}>{ti("mw.tx.33")}</button>
        </div>
        {small ? (
          // B4 小屏钻取：无选中 → 整屏树；有选中 → 整屏详情（带返回条）；高度由 CSS 小屏媒体查询弹性填充（aiti-float 全屏同断点）
          selNode ? renderDetailPane() : (
            <div className="amw-split-box">
              {renderTree()}
            </div>
          )
        ) : (
          <div className="amw-split-box">
            {renderTree()}
            {renderDetailPane()}
          </div>
        )}
      </div>
    );
  };

  // ── 模型聚合 tab：组合 provider 列表 + 编辑器（虚拟模型 = 多真实成员，粘性+权重路由）──
  const [comboData, setComboData] = useState<any>(null);          // {combos, members}
  // ── 免费模型页签（免费包列表/安装状态/操作中/页内提示/卸载二次确认 id）──
  const [freeItems, setFreeItems] = useState<any[]>([]);
  const [freeLoading, setFreeLoading] = useState(false);
  const [freeBusy, setFreeBusy] = useState<string>("");          // "<id>:<action>" 操作中
  const [freeMsg, setFreeMsg] = useState("");
  const [freeConfirm, setFreeConfirm] = useState("");            // 待二次确认卸载的包 id
  const [comboEditor, setComboEditor] = useState<any>(null);      // {provider, displayName, renameFrom?, models:[{id,members:[{provider,model,weight}],stickyTtlMin}], confirmDiff}
  const [sStatusOpen, setSStatusOpen] = useState(false);          // 聚合/多key 运行状态详情弹窗
  // ── 免费模型页签：列表（含 installed 徽标）+ 一键安装/更新/卸载（转发 pi-web /api/plugins，scope=global）──
  const loadFree = useCallback(async () => {
    setFreeLoading(true);
    try { const d = srvFix(await (await api("/free-models")).json()); setFreeItems(d && d.ok ? Object.entries(d.items || {}).map(([id, it]: any) => ({ id, ...it })) : []); } catch { setFreeItems([]); } finally { setFreeLoading(false); }
  }, []);
  const freeAction = useCallback(async (id: string, action: string) => {
    setFreeBusy(id + ":" + action); setFreeMsg(""); setFreeConfirm("");
    try {
      const d = srvFix(await (await api("/free-install", { method: "POST", ...jsonBody({ id, action }) })).json());
      if (!d.ok) setFreeMsg("❌ " + (d.error || ti("mw.a.137")));
      else setFreeMsg("✅ " + (d.message || ti("mw.a.530")));
    } catch (err: any) { setFreeMsg("❌ " + (err?.message || String(err))); } finally { setFreeBusy(""); loadFree(); }
  }, [loadFree]);

  const loadCombos = useCallback(async () => {
    try {
      const d = srvFix(await (await api("/combos")).json());
      const data = d && d.ok ? d : null;
      setComboData(data);
      return data;
    } catch { return null; }
  }, []);
  const comboPoolMap = new Map<string, any>();
  for (const m of (comboData?.members || [])) comboPoolMap.set(m.provider + "/" + m.model, m);

  // 编辑器内：单个虚拟模型的差异告警分级（🔴阻止 / 🟡需勾选确认 / 🟢提示）
  const comboWarns = (vm: any, poolMap: Map<string, any> = comboPoolMap): { block: string[]; warn: string[]; hint: string[] } => {
    const block: string[] = [], warn: string[] = [], hint: string[] = [];
    if (!vm.members.length) block.push(ti("mw.a.531"));
    else if (!vm.members.some((r: any) => r.enabled !== false)) block.push(ti("mw.a.532"));
    const metas = vm.members.map((r: any) => poolMap.get(r.provider + "/" + r.model)).filter(Boolean);
    if (metas.length !== vm.members.length) block.push(ti("mw.a.533"));
    const apis = [...new Set(metas.map((m: any) => m.api))];
    if (apis.length > 1) block.push(ti("mw.a.534") + apis.join(" vs ") + ti("mw.a.535"));
    const ctxs = metas.map((m: any) => m.contextWindow).filter((x: any) => typeof x === "number");
    if (ctxs.length >= 2 && Math.min(...ctxs) < Math.max(...ctxs) / 2) warn.push(ti("mw.a.536"));
    const outs = metas.map((m: any) => m.maxTokens).filter((x: any) => typeof x === "number");
    if (outs.length >= 2 && Math.min(...outs) * 1.2 < Math.max(...outs)) warn.push(ti("mw.a.537"));
    const vis = metas.map((m: any) => (m.input || []).includes("image"));
    if (vis.length >= 2 && vis.some((v: boolean) => v !== vis[0])) warn.push(ti("mw.a.538"));
    if (vis.length >= 1 && vis.every((v: boolean) => !v) && vm.members.length >= 1) hint.push(ti("mw.a.539"));
    // —— types（承接类别）——
    const enabledRefs = vm.members.filter((r: any) => r.enabled !== false);
    // ① 无成员承接纯文本：全部启用成员都显式排除了 text（仅图形/仅媒体）→ 纯文本请求无成员可用
    const hasText = enabledRefs.some((r: any) => !Array.isArray(r.types) || r.types.length === 0 || r.types.includes("text"));
    if (enabledRefs.length >= 1 && !hasText) warn.push(ti("mw.a.540"));
    // ② 死配置：types 含 vision 但模型 input 无 image → 带图请求仍被能力过滤排除，勾选永不生效
    for (const r of enabledRefs) {
      if (Array.isArray(r.types) && r.types.includes("vision")) {
        const m = poolMap.get(r.provider + "/" + r.model);
        if (m && !(m.input || []).includes("image")) warn.push(ti("mw.tx.203", { id: r.provider + "/" + r.model }));
      }
    }
    return { block, warn, hint };
  };

  // Warning-acknowledgement baseline (fix: editing an existing combo always kept Save disabled) --
  // warnings present when the editor opens are recorded into ackWarn; as long as this edit keeps
  // the enabled member set and warning categories unchanged, no re-confirmation is needed.
  // New members or new warning kinds still require an explicit acknowledgement.
  const comboWarnSig = (warns: string[]) => warns.slice().sort().join("\u0001");
  const comboMemberSig = (vm: any) => (vm.members || [])
    .filter((r: any) => r.enabled !== false)
    .map((r: any) => r.provider + "/" + r.model).sort().join(",");
  const comboNeedsConfirm = (vm: any) => {
    const w = comboWarns(vm);
    if (!w.warn.length) return false;
    const ack = vm.ackWarn;
    return !(ack && ack.sig === comboWarnSig(w.warn) && ack.members === comboMemberSig(vm));
  };

  /** Build editor state from a combo provider entry; `members` overrides the member pool for
   *  callers that just fetched it (state's comboPoolMap would still be one render behind). */
  const buildComboEditor = (cb: any, members?: any[]) => {
    const poolMap = new Map<string, any>();
    for (const m of (members || comboData?.members || [])) poolMap.set(m.provider + "/" + m.model, m);
    const models = (cb.models || []).map((m: any) => {
      const vm: any = { id: m.id, stickyTtlMin: m.stickyTtlMin ?? undefined, ...(m.enabled === false ? { enabled: false } : {}), members: (m.members || []).map((r: any) => ({ provider: r.provider, model: r.model, weight: r.weight, ...(Array.isArray(r.types) && r.types.length > 0 ? { types: r.types } : {}), ...(r.enabled === false ? { enabled: false } : {}) })) };
      // Baseline pre-existing differences as acknowledged; otherwise the editor opens with Save already blocked
      return { ...vm, ackWarn: { sig: comboWarnSig(comboWarns(vm, poolMap).warn), members: comboMemberSig(vm) } };
    });
    return { provider: cb.providerId, displayName: cb.name, renameFrom: cb.providerId, models };
  };

  /** Open the combo editor for one provider id (deep-link from the provider detail pane). */
  const openComboEditorFor = async (providerId: string) => {
    setTab("combo");
    const d = await loadCombos();
    const cb = (d?.combos || []).find((c: any) => c.providerId === providerId);
    if (cb) setComboEditor(buildComboEditor(cb, d?.members));
    // When the combo is gone the freshly loaded list stays; the editor simply does not open.
  };

  const renderCombos = () => {
    const ed = comboEditor;
    const pool = comboData?.members || [];
    const doSaveCombo = async () => {
      if (!ed) return;
      setBusy(true);
      try {
        const d = srvFix(await (await api("/combo-save", { method: "POST", ...jsonBody({ provider: String(ed.provider || "").trim() || String(ed.displayName || "").trim(), displayName: ed.displayName, renameFrom: ed.renameFrom, models: ed.models }) })).json());
        if (!d.ok) {
          // Mirror failures into the toast: the message banner sits at the top while Save is at the bottom
          const m = "❌ " + (d.error || ti("mw.a.36"));
          setMsg(m); setToast({ msg: m, ok: false }); setTimeout(() => setToast(null), 5000);
          return;
        }
        setComboEditor(null);
        const okMsg = ti("mw.a.541") + d.provider + "（" + d.modelCount + ti("mw.a.542");
        setMsg(okMsg); setToast({ msg: okMsg, ok: true }); setTimeout(() => setToast(null), 4000);
        await loadCombos(); loadStatus();
        // 广播模型变更 → pi-web 刷新模型列表（新会话 dropdown 立即出现聚合模型）
        try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
      } catch (err: any) {
        const m = "❌ " + (err?.message || String(err));
        setMsg(m); setToast({ msg: m, ok: false }); setTimeout(() => setToast(null), 5000);
      } finally { setBusy(false); }
    };

    // ── 编辑器视图 ──
    if (ed) {
      const setVm = (i: number, patch: any) => setComboEditor({ ...ed, models: ed.models.map((m: any, j: number) => j === i ? { ...m, ...patch } : m) });
      const allBlock: string[] = [], allWarn: string[] = [];
      for (const vm of ed.models) { const w = comboWarns(vm); allBlock.push(...w.block); allWarn.push(...w.warn); }
      const effProvider = String(ed.provider || "").trim() || String(ed.displayName || "").trim();
      const nameBad = !effProvider;
      const dupId = new Set<string>(); let idDup = false; let idEmpty = false;
      for (const vm of ed.models) { const k = String(vm.id || "").trim(); if (!k) idEmpty = true; else if (dupId.has(k)) idDup = true; dupId.add(k); }
      // Only newly introduced 🟡 differences require confirmation (pre-existing ones are covered by ackWarn)
      const needConfirm = ed.models.some((vm: any) => comboNeedsConfirm(vm));
      // Explain why Save is disabled (previously a bare greyed-out button with no reason)
      const saveBlockers: string[] = [];
      if (nameBad) saveBlockers.push(ti("mw.tx.146"));
      if (idEmpty) saveBlockers.push(ti("mw.tx.210"));
      if (idDup) saveBlockers.push(ti("mw.tx.211"));
      for (const b of allBlock) if (!saveBlockers.includes(b)) saveBlockers.push(b);
      const canSave = saveBlockers.length === 0 && !needConfirm;
      const saveBlockedReason = [...saveBlockers, ...(needConfirm ? [ti("mw.tx.206", { n: allWarn.length })] : [])].join(" · ");
      return (
        <div className="amw-combo-editor">
          <div className="amw-combo-toolbar">
            <button className="amw-btn" onClick={() => setComboEditor(null)}>‹ {ti("mw.tx.143")}</button>
            <span className="amw-combo-toolbar-title">🧩 {String(ed.displayName || ed.provider || ti("mw.a.596"))}</span>
            {effProvider ? <span className="amw-mono" style={{ fontSize: 10, color: "var(--text-subtle,#999)" }}>{effProvider}</span> : null}
            <div style={{ flex: 1 }} />
            {saveBlockers.length ? <span className="amw-chip is-err" title={saveBlockedReason}>⛔ {saveBlockers.length}</span>
              : needConfirm ? <span className="amw-chip is-warn">{ti("mw.tx.206", { n: allWarn.length })}</span>
              : <span className="amw-chip is-ok">✓ {ti("mw.tx.213")}</span>}
            <button className="amw-btn is-primary" disabled={!canSave || busy} title={canSave ? undefined : saveBlockedReason} onClick={doSaveCombo}>
              {busy ? ti("mw.tx.214") : ti("mw.tx.155")}
            </button>
          </div>
          <div className="amw-hint-lg" style={{ marginBottom: 8 }}>{ti("mw.tx.144")}</div>
          {saveBlockers.length ? (
            <div className="amw-note is-err" style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{ti("mw.tx.212")}</div>
              {saveBlockers.map((b, j) => <div key={j}>· {b}</div>)}
            </div>
          ) : needConfirm ? (
            <div className="amw-note is-warn" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ flex: 1 }}>{ti("mw.tx.206", { n: allWarn.length })}</span>
              <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }}
                onClick={() => setComboEditor({ ...ed, models: ed.models.map((vm: any) => ({ ...vm, ackWarn: { sig: comboWarnSig(comboWarns(vm).warn), members: comboMemberSig(vm) } })) })}>
                {ti("mw.tx.215")}
              </button>
            </div>
          ) : null}
          <div className="amw-combo-sect">
            <span className="amw-step-dot">1</span>
            <span className="amw-combo-sect-title">{ti("mw.tx.216")}</span>
            <span className="amw-combo-sect-hint">{ti("mw.tx.218")}</span>
          </div>
          <div className="amw-card" style={{ padding: "10px 12px", marginBottom: 10 }}>
            <div className="amw-combo-namegrid">
              <label className="amw-field">
                <span className="amw-field-label">{ti("mw.tx.145")}</span>
                <input className="amw-input" value={ed.displayName} placeholder={ti("mw.a.543")}
                  onChange={(e) => setComboEditor({ ...ed, displayName: e.target.value })} />
              </label>
              <label className="amw-field">
                <span className="amw-field-label">provider id</span>
                <input className="amw-input" style={{ fontFamily: "ui-monospace,monospace" }} value={ed.provider} placeholder={ti("mw.a.544")}
                  onChange={(e) => setComboEditor({ ...ed, provider: e.target.value })} />
              </label>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-subtle,#888)", marginTop: 6 }}>{ti("mw.a.627")}</div>
            {nameBad ? <div style={{ fontSize: 11, color: "#dc2626", marginTop: 4 }}>{ti("mw.tx.146")}</div> : null}
          </div>
          <div className="amw-combo-sect">
            <span className="amw-step-dot">2</span>
            <span className="amw-combo-sect-title">{ti("mw.tx.217")}</span>
            <span className="amw-combo-sect-hint">{ti("mw.tx.219")}</span>
          </div>
          {ed.models.map((vm: any, i: number) => {
            const w = comboWarns(vm);
            const metas = vm.members.map((r: any) => ({ r, m: comboPoolMap.get(r.provider + "/" + r.model) })).filter((x: any) => x.m);
            const ctxs = metas.map((x: any) => x.m.contextWindow).filter((x: any) => typeof x === "number");
            const outs = metas.map((x: any) => x.m.maxTokens).filter((x: any) => typeof x === "number");
            const inputs = new Set<string>(); metas.forEach((x: any) => (x.m.input || []).forEach((t: string) => inputs.add(t)));
            const apis = [...new Set(metas.map((x: any) => x.m.api))];
            return (
              <div key={i} className="amw-card" style={{ padding: "10px 12px", marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 650, whiteSpace: "nowrap" }}>#{i + 1} · {ti("mw.tx.220")}</span>
                  <input className="amw-input" style={{width: small ? "auto" : 200, flex: small ? "1 1 140px" : undefined, minWidth: 110, fontFamily: "ui-monospace,monospace"}} value={vm.id} placeholder={ti("mw.a.545")}
                    onChange={(e) => setVm(i, { id: e.target.value })} />
                  {String(vm.id || "").trim() && (String(ed.provider || "").trim() || String(ed.displayName || "").trim()) ? (
                    <span style={{ fontSize: 11, color: "var(--text-subtle,#888)" }}>
                      {ti("mw.tx.204")}<b className="amw-mono" style={{ color: "#4f46e5" }}>{(String(ed.provider || "").trim() || String(ed.displayName || "").trim())}/{String(vm.id).trim()}</b>
                    </span>
                  ) : null}
                  <span style={{ fontSize: 11, color: "var(--text-subtle,#888)", flex: 1 }}>{apis.length === 1 ? ti("mw.a.546") + apis[0] : apis.length ? ti("mw.a.547") : ""}</span>
                  <button className="amw-btn" style={{ padding: "3px 8px", ...(vm.enabled === false ? { color: "#16a34a", borderColor: "var(--ok, #22c55e)" } : { color: "#d97706", borderColor: "var(--warn, #f59e0b)" }) }}
                    title={vm.enabled === false ? ti("mw.a.548") : ti("mw.a.549")}
                    onClick={() => setVm(i, { enabled: vm.enabled === false ? undefined : false })}>
                    {vm.enabled === false ? ti("mw.a.494") : ti("mw.a.495")}
                  </button>
                  {ed.models.length > 1 ? <button className="amw-btn is-danger" style={{ padding: "3px 8px" }} onClick={() => setComboEditor({ ...ed, models: ed.models.filter((_: any, j: number) => j !== i) })}>{ti("mw.tx.148")}</button> : null}
                </div>
                {/* 自动计算预览 */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                  {[ctxs.length ? "ctx ⌊" + Math.min(...ctxs) / 1000 + "k⌋" : null,
                    outs.length ? ti("mw.a.550") + Math.min(...outs) + "⌋" : null,
                    inputs.size ? ti("mw.a.551") + [...inputs].join("+") : null,
                    vm.stickyTtlMin ? ti("mw.a.552") + vm.stickyTtlMin + "min" : ti("mw.a.553")].filter(Boolean).map((t: any, j: number) => (
                    <span key={j} className="amw-pill">{t}</span>
                  ))}
                </div>
                {/* Members list (inline parameters, outliers highlighted) */}
                <div className="amw-combo-subhead">
                  <span>{ti("mw.tx.221")} · {vm.members.length}</span>
                  <span className="amw-combo-subhead-hint">{ti("mw.tx.222")}</span>
                </div>
                {(() => {
                  const mmetas = vm.members.map((r: any) => comboPoolMap.get(r.provider + "/" + r.model)).filter(Boolean);
                  const ctxs = mmetas.map((x: any) => x.contextWindow).filter((x: any) => typeof x === "number");
                  const outs = mmetas.map((x: any) => x.maxTokens).filter((x: any) => typeof x === "number");
                  const ctxMin = ctxs.length ? Math.min(...ctxs) : null;
                  const ctxMax = ctxs.length ? Math.max(...ctxs) : null;
                  const outMin = outs.length ? Math.min(...outs) : null;
                  const outMax = outs.length ? Math.max(...outs) : null;
                  const ctxWarn = !!(ctxs.length >= 2 && ctxMin !== null && ctxMax !== null && ctxMin < ctxMax / 2);
                  const outWarn = !!(outs.length >= 2 && outMin !== null && outMax !== null && outMin * 1.2 < outMax);
                  const someVision = mmetas.some((x: any) => (x.input || []).includes("image"));
                  const fmtK = (n: any) => n == null ? "?" : (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
                  return vm.members.map((r: any, mi: number) => {
                    const meta = comboPoolMap.get(r.provider + "/" + r.model);
                    const rEn = r.enabled !== false; // 成员引用级临时禁用（enabled:false）
                    const cw = meta && typeof meta.contextWindow === "number" ? meta.contextWindow : null;
                    const ot = meta && typeof meta.maxTokens === "number" ? meta.maxTokens : null;
                    const isCtxMin = ctxWarn && cw !== null && cw === ctxMin;   // 拉低组合上下文的最矮成员
                    const isOutMin = outWarn && ot !== null && ot === outMin;    // 拉低最大输出的成员
                    const noVision = someVision && !(meta && (meta.input || []).includes("image")); // 组内有 vision 而它没有
                    const abnormal = isCtxMin || isOutMin || noVision;
                    return (
                    <div key={mi} className="amw-combo-member" title={!rEn ? ti("mw.a.554") : abnormal
                      ? (isCtxMin ? ti("mw.a.555") + fmtK(cw) + ti("mw.a.556") : "")
                        + (isOutMin ? ti("mw.a.557") + fmtK(ot) : "")
                        + (noVision ? ti("mw.a.558") : "")
                      : "ctx=" + fmtK(cw) + " · out=" + fmtK(ot)}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 8, background: "rgba(127,127,127,.06)", marginBottom: 4, flexWrap: small ? "wrap" : "nowrap",
                        ...(abnormal && rEn ? { boxShadow: "inset 0 0 0 1.5px rgba(217,119,6,.55)", background: "rgba(217,119,6,.06)" } : {}),
                        ...(!rEn ? { boxShadow: "inset 0 0 0 1.5px color-mix(in srgb, var(--warn, #f59e0b) 50%, transparent)", background: "color-mix(in srgb, var(--warn, #f59e0b) 8%, transparent)" } : {}) }}>
                      <ProviderAvatar id={r.provider} name={r.provider} size={20} radius={6} />
                      <span style={{ fontSize: 12, fontWeight: 600, flex: "0 0 auto", ...(!rEn ? { color: "#b45309" } : {}) }}>{r.provider}</span>
                      <span className="amw-mono" style={{ fontSize: 12, flex: 1, minWidth: small ? 140 : 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...(!rEn ? { color: "#b45309", textDecoration: "line-through", opacity: 0.7 } : {}) }} title={meta ? "ctx=" + (meta.contextWindow ?? "?") + " · out=" + (meta.maxTokens ?? "?") + " · keys=" + meta.keyCount : ti("mw.a.559")}>{r.model}</span>
                      {!rEn ? <span style={{ fontSize: 9, color: "#b45309", fontWeight: 700, flexShrink: 0 }}>{ti("mw.a.495")}</span> : null}
                      {meta ? <>
                        <span title={ti("mw.a.560")} className="amw-mono" style={{ fontSize: 10, color: isCtxMin ? "#d97706" : "var(--text-subtle,#888)", fontWeight: isCtxMin ? 700 : 400, background: isCtxMin ? "rgba(217,119,6,.14)" : "transparent", padding: "0 4px", borderRadius: 6, flexShrink: 0 }}>{"ctx " + fmtK(cw)}{isCtxMin ? " ⚠" : ""}</span>
                        <span title={ti("mw.a.561")} className="amw-mono" style={{ fontSize: 10, color: isOutMin ? "#d97706" : "var(--text-subtle,#888)", fontWeight: isOutMin ? 700 : 400, background: isOutMin ? "rgba(217,119,6,.14)" : "transparent", padding: "0 4px", borderRadius: 6, flexShrink: 0 }}>{"out " + fmtK(ot)}{isOutMin ? " ⚠" : ""}</span>
                        {(meta.input || []).includes("image") ? <span style={{ fontSize: 10, color: "#15803d", fontWeight: 650, flexShrink: 0 }}>vision</span> : noVision ? <span style={{ fontSize: 10, color: "#d97706", fontWeight: 700, flexShrink: 0 }}>{ti("mw.tx.149")}</span> : null}
                        {meta.reasoning ? <span style={{ fontSize: 10, color: "#7c3aed", fontWeight: 650, flexShrink: 0 }}>{ti("mw.a.1")}</span> : null}
                        <span style={{ fontSize: 10, color: "var(--text-subtle,#999)", flexShrink: 0 }}>{meta.keyCount + " key"}</span>
                      </> : <span style={{ fontSize: 10, color: "#dc2626", fontWeight: 650 }}>{ti("mw.a.559")}</span>}
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-subtle,#777)", whiteSpace: "nowrap", flexShrink: 0 }}>{ti("mw.tx.150")}</span>
                      <input type="number" min={1} step={1} className="amw-input" disabled={!rEn} style={{width: 64, padding: "3px 6px", flexShrink: 0}} value={r.weight ?? 10}
                        title={ti("mw.a.562")}
                        onChange={(e) => { const v = Math.max(1, Math.floor(Number(e.target.value) || 1)); const members = vm.members.map((x: any, j: number) => j === mi ? { ...x, weight: v } : x); setVm(i, { members }); }} />
                      <span style={{ fontSize: 11, color: "var(--text-subtle,#777)", whiteSpace: "nowrap", flexShrink: 0 }} title={ti("mw.a.563")}>{ti("mw.tx.151")}</span>
                      {(() => {
                        const rTypes: string[] = Array.isArray(r.types) ? r.types : [];
                        const hasVision = !!(meta && (meta.input || []).includes("image"));      // 能力决定可勾选项
                        const allOn = rTypes.length === 0;                                        // 未配 = 全收 = 全部可用能力都勾
                        const textOn = allOn || rTypes.includes("text");
                        const visionOn = allOn || rTypes.includes("vision");
                        const otherTypes = rTypes.filter((x) => x !== "text" && x !== "vision"); // UI 不管理的类别（如 other）原样保留不吞
                        const toggle = (ct: string) => {
                          const next = ct === "text" ? { text: !textOn, vision: visionOn } : { text: textOn, vision: !visionOn };
                          const arr: string[] = [];
                          if (next.text) arr.push("text");
                          if (next.vision) arr.push("vision");
                          const final = [...new Set([...arr, ...otherTypes])];
                          const members = vm.members.map((x: any, j: number) => j === mi ? { ...x, types: final.length ? final : undefined } : x);
                          setVm(i, { members });
                        };
                        const chip = (ct: string, ctLabel: string, on: boolean, locked: boolean, tip: string) => (
                          <label key={ct} title={tip}
                            style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 7px", borderRadius: 999, fontSize: 11, cursor: locked || !rEn ? "not-allowed" : "pointer", flexShrink: 0,
                              background: on ? "#2563eb" : "rgba(127,127,127,.12)", color: on ? "#fff" : "var(--text-subtle,#888)", opacity: rEn ? (locked ? 0.8 : 1) : 0.5, userSelect: "none", border: "1px solid " + (on ? "#2563eb" : "transparent") }}>
                            <input type="checkbox" style={{ display: "none" }} checked={on} disabled={locked || !rEn} onChange={() => toggle(ct)} />
                            {ctLabel}{locked ? " 🔒" : ""}
                          </label>
                        );
                        return <>
                          {chip("text", ti("mw.a.564"), textOn, !hasVision, hasVision ? ti("mw.a.565") : ti("mw.a.566"))}
                          {hasVision ? chip("vision", ti("mw.a.567"), visionOn, false, ti("mw.a.568")) : null}
                        </>;
                      })()}
                      {!(Array.isArray(r.types) && r.types.length > 0)
                        ? <span className="amw-chip is-ok" style={{ flexShrink: 0 }} title={ti("mw.a.569")}>{ti("mw.tx.152")}</span>
                        : null}
                      <button className="amw-btn" style={{ padding: "2px 7px", flexShrink: 0, ...(rEn ? { color: "#d97706", borderColor: "var(--warn, #f59e0b)" } : { color: "#16a34a", borderColor: "var(--ok, #22c55e)" }) }}
                        title={rEn ? ti("mw.a.570") : ti("mw.a.571")}
                        onClick={() => setVm(i, { members: vm.members.map((x: any, j: number) => j === mi ? { ...x, enabled: !rEn } : x) })}>{rEn ? "⏸" : "▶"}</button>
                      <button className="amw-btn is-danger" style={{ padding: "2px 7px", flexShrink: 0 }} onClick={() => setVm(i, { members: vm.members.filter((_: any, j: number) => j !== mi) })}>✕</button>
                    </div>
                    );
                  });
                })()}
                {/* 成员选择器 */}
                <MemberPicker pool={pool} exclude={(vm.members || []).map((r: any) => r.provider + "/" + r.model)} onPick={(p: any) => setVm(i, { members: [...(vm.members || []), { provider: p.provider, model: p.model, weight: 10 }] })} />
                {/* stickyTtl 高级项 */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--text-subtle,#777)", whiteSpace: "nowrap" }}>{ti("mw.tx.225")}</span>
                  <input type="number" min={1} className="amw-input" style={{width: 72, padding: "3px 6px"}} value={vm.stickyTtlMin ?? ""} placeholder="15"
                    onChange={(e) => setVm(i, { stickyTtlMin: e.target.value ? Math.max(1, Math.floor(Number(e.target.value) || 15)) : undefined })} />
                </div>
                {/* 警告分级 */}
                {w.block.map((t: string, j: number) => <div key={j} style={{ fontSize: 11, color: "#dc2626", marginTop: 4 }}>🔴 {t}</div>)}
                {w.warn.length ? (
                  <div className="amw-combo-warn">
                    {w.warn.map((t: string, j: number) => <div key={j} style={{ fontSize: 11, color: "#b45309" }}>🟡 {t}</div>)}
                    {comboNeedsConfirm(vm) ? (
                      <label className="amw-combo-confirm">
                        <input type="checkbox" checked={false} onChange={() => setVm(i, { ackWarn: { sig: comboWarnSig(w.warn), members: comboMemberSig(vm) } })} />
                        {ti("mw.tx.205")}
                      </label>
                    ) : (
                      <label className="amw-combo-confirm is-done">
                        <input type="checkbox" checked disabled />
                        {ti("mw.a.626")}
                      </label>
                    )}
                  </div>
                ) : null}
                {w.hint.map((t: string, j: number) => <div key={j} style={{ fontSize: 11, color: "var(--text-subtle,#888)", marginTop: 4 }}>🟢 {t}</div>)}
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="amw-btn" onClick={() => setComboEditor({ ...ed, models: [...ed.models, { id: "", members: [] }] })}>{ti("mw.tx.154")}</button>
            <div style={{ flex: 1 }} />
            {saveBlockers.length ? <span className="amw-chip is-err">{ti("mw.tx.212")}</span>
              : needConfirm ? <span className="amw-chip is-warn">{ti("mw.tx.206", { n: allWarn.length })}</span> : null}
            <button className="amw-btn is-primary" disabled={!canSave || busy} title={canSave ? undefined : saveBlockedReason} onClick={doSaveCombo}>
              {busy ? ti("mw.tx.214") : ti("mw.tx.155")}
            </button>
          </div>
        </div>
      );
    }

    // ── 列表视图 ──
    const combos = comboData?.combos || [];
    return (
      <div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button className="amw-btn is-primary" onClick={() => setComboEditor({ provider: "", displayName: "", models: [{ id: "", members: [] }] })}>{ti("mw.tx.156")}</button>
            <button className="amw-btn" title={ti("mw.a.572")}
              onClick={async () => { setBusy(true); try { const d = srvFix(await (await api("/refresh", { method: "POST" })).json()); setMsg(d.ok ? ti("mw.a.573") + ((d.refreshed || []).join(", ") || ti("mw.a.574")) : "❌ " + (d.error || ti("mw.a.39"))); try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {} } catch (e: any) { setMsg(ti("mw.a.575") + (e?.message || e)); } finally { setBusy(false); } }}>
              <Ic size={12} paths={ICONS.refresh} /> {ti("mw.tx.142")}</button>
            <div style={{ flex: 1 }} />
            <MultiKeyStatusSummary onOpen={() => setSStatusOpen(true)} />
          </div>
          <div className="amw-hint-lg">{ti("mw.tx.157")}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim,#6b7280)", marginTop: 4 }}>{ti("mw.tx.226")}</div>
        </div>
        {!combos.length ? <div className="amw-note">{ti("mw.tx.158")}</div> : null}
        {combos.map((cb: any) => {
          const allMembers = (cb.models || []).flatMap((m: any) => m.members || []);
          const disabledCount = allMembers.filter((r: any) => r.enabled === false).length;
          return (
          <div key={cb.providerId} className="amw-card amw-combo-listcard" style={{ marginBottom: 8, padding: "11px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>🧩</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 650, fontSize: 13 }}>{cb.name}</span>
                  {cb.enabled === false ? <span style={{ fontSize: 10, color: "#b45309", border: "1px solid color-mix(in srgb, var(--warn, #f59e0b) 50%, transparent)", borderRadius: 999, padding: "0 8px", fontWeight: 700 }}>{ti("mw.tx.159")}</span> : null}
                  <span className="amw-mono" style={{fontSize: 10, color: "var(--text-subtle,#999)"}}>{cb.providerId}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-subtle,#888)", marginTop: 3 }}>
                  {cb.models.length + ti("mw.a.576") + (cb.api || "?")}
                  {allMembers.length ? <span> · {allMembers.length}{ti("mw.a.628")}</span> : null}
                  {disabledCount ? <span style={{ color: "#b45309" }}> · {disabledCount}{ti("mw.a.629")}</span> : null}
                </div>
              </div>
              <button className="amw-btn" onClick={() => setComboEditor(buildComboEditor(cb))}>✎ {ti("mw.tx.17")}</button>
              <button className="amw-btn" style={{ padding: "3px 8px", ...(cb.enabled === false ? { color: "#16a34a", borderColor: "var(--ok, #22c55e)" } : { color: "#d97706", borderColor: "var(--warn, #f59e0b)" }) }}
                title={cb.enabled === false ? ti("mw.a.577") : ti("mw.a.578")}
                onClick={() => doToggleProvider(cb.providerId, cb.enabled === false)}>
                {cb.enabled === false ? ti("mw.a.494") : ti("mw.a.495")}
              </button>
              <button className="amw-btn is-danger" style={{ padding: "3px 8px" }} title={ti("mw.a.579")} onClick={() => doDelete(cb.providerId)}><Ic size={12} paths={ICONS.trash} /></button>
            </div>
            {cb.models.map((m: any) => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 7, padding: "6px 8px", borderRadius: 8, background: "rgba(127,127,127,.06)", ...(m.enabled === false ? { opacity: 0.62, boxShadow: "inset 0 0 0 1.5px color-mix(in srgb, var(--warn, #f59e0b) 45%, transparent)" } : {}) }}>
                <span className="amw-mono" style={{fontSize: 12, fontWeight: 700, color: m.enabled === false ? "#b45309" : "#4f46e5"}}>{cb.providerId}/{m.id}</span>
                {m.enabled === false ? <span style={{ fontSize: 10, color: "#b45309", fontWeight: 700 }}>{ti("mw.tx.159")}</span> : null}
                <span style={{ color: "var(--text-subtle,#aaa)", fontSize: 11 }}>＝</span>
                {(m.members || []).map((r: any, j: number) => (
                  <span key={j} className="amw-mono" style={{ padding: "2px 8px", borderRadius: 999, background: r.enabled === false ? "color-mix(in srgb, var(--warn, #f59e0b) 10%, transparent)" : "rgba(127,127,127,.09)", border: r.enabled === false ? "1px dashed var(--warn, #f59e0b)" : "1px solid rgba(127,127,127,.18)", fontSize: 11, ...(r.enabled === false ? { color: "#b45309", textDecoration: "line-through" } : {}) }}>
                    {r.provider}/{r.model}{r.enabled === false ? " ⏸" : ""}{r.weight != null && r.weight !== 10 ? <b style={{ color: "#4f46e5" }}> ×{r.weight}</b> : null}
                    {Array.isArray(r.types) && r.types.length > 0
                      ? <span style={{ fontSize: 10, color: "#0891b2", fontWeight: 650 }}> [{r.types.map((x: string) => x === "text" ? ti("mw.a.564") : x === "vision" ? ti("mw.a.567") : ti("mw.a.580")).join("/")}]</span>
                      : null}
                  </span>
                ))}
              </div>
            ))}
          </div>
          );
        })}
        {sStatusOpen && <MultiKeyStatusDialog onClose={() => setSStatusOpen(false)} />}
      </div>
    );
  };

  // 免费模型页签：说明块（含免费效果声明）+ 卡片列表（名称/desc/note/npm/安装状态徽标 + 安装/更新/卸载）
  const renderFree = () => (
    <div>
      <div className="amw-note" style={{ marginBottom: 10 }}>
        <div>{ti("mw.tx.160")}<b>{ti("mw.tx.161")}</b>{ti("mw.tx.162")}</div>
        <div style={{ marginTop: 4 }}>{ti("mw.tx.163")}<b>{ti("mw.a.103")}</b>{ti("mw.tx.164")}<b>{ti("mw.tx.165")}</b>{ti("mw.tx.166")}</div>
      </div>
      {freeMsg && <div className="amw-note" style={{ marginBottom: 8 }}>{freeMsg}</div>}
      {freeLoading && <div className="amw-note">{ti("mw.tx.6")}</div>}
      {!freeLoading && !freeItems.length && <div className="amw-note">{ti("mw.tx.167")}</div>}
      <div style={{ display: "grid", gap: 8 }}>
        {freeItems.map((it: any) => {
          const busy = freeBusy === it.id + ":install" || freeBusy === it.id + ":update" || freeBusy === it.id + ":remove";
          return (
            <div key={it.id} className="amw-card" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
              <Ic size={18} paths={ICONS.gift} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {it.name || it.id}
                  {it.installed
                    ? <span style={{ marginLeft: 8, fontSize: 11, color: "#16a34a", border: "1px solid rgba(22,163,74,.35)", borderRadius: 999, padding: "1px 8px" }}>{ti("mw.tx.168")}</span>
                    : null}
                </div>
                {it.desc ? <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>{it.desc}</div> : null}
                {it.note ? <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{it.note}</div> : null}
                {Array.isArray(it.models) && it.models.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {it.models.map((m: string, i: number) => (
                      <span key={i} style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999, background: "rgba(127,127,127,.09)", border: "1px solid rgba(127,127,127,.18)", opacity: m.startsWith("…") ? 0.55 : 0.85 }}>{m}</span>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3 }}>
                  <span className="amw-mono" style={{ fontSize: 11, opacity: 0.55 }}>{it.npm}</span>
                  {it.url ? <a href={it.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, opacity: 0.6 }} onMouseDown={(e: any) => e.stopPropagation()}>{ti("mw.tx.169")}</a> : null}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {!it.installed && (
                  <button className="amw-btn is-primary" disabled={busy} onClick={() => freeAction(it.id, "install")}>
                    {busy ? ti("mw.a.581") : ti("mw.a.582")}
                  </button>
                )}
                {it.installed && (
                  <>
                    <button className="amw-btn" disabled={busy} title={ti("mw.a.583")} onClick={() => freeAction(it.id, "update")}>{busy ? "…" : ti("mw.a.584")}</button>
                    <button className="amw-btn" disabled={busy} style={freeConfirm === it.id ? { color: "#dc2626", borderColor: "#dc2626" } : undefined}
                      title={freeConfirm === it.id ? ti("mw.a.585") : ti("mw.a.586")}
                      onClick={() => { if (freeConfirm === it.id) freeAction(it.id, "remove"); else setFreeConfirm(it.id); }}>
                      {busy ? "…" : freeConfirm === it.id ? ti("mw.a.587") : ti("mw.a.588")}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  // 检查 tab：同窗口内嵌 aiti-model-check 的 App（不再关向导开独立浮窗）；
  // 「配置更多模型」回调 → 切回本向导「添加」tab；「🛠 一键编辑」回调 → 切到已配置模型 + 按检查结果预选勾选。
  // 检查扩展是懒加载（immediately:false，pages 不在 INTERACTIVE_SLOTS → 不会自动物化）：
  // 首次进 tab 且 App 缺席时用 M1 跨扩展拉起 API（ensureMaterialized，同 git-review→editor 首例）拉起，
  // 就绪后重渲染直接内嵌；拉起失败才显示报错。
  const [checkExtState, setCheckExtState] = useState<"idle" | "loading" | "done">("idle");
  useEffect(() => {
    if (tab !== "check" || checkExtState !== "idle") return;
    if (typeof extSvc<any>("aiti-model-check.app") === "function" || typeof window.__aitiModelCheckApp === "function") return; // 已就绪无需拉起
    setCheckExtState("loading");
    const ctx = getCtx() as any;
    Promise.resolve(typeof ctx?.ensureMaterialized === "function" ? ctx.ensureMaterialized("aiti-model-check") : false)
      .catch(() => {})
      .finally(() => setCheckExtState("done"));
  }, [tab, checkExtState]);
  const renderCheck = () => {
    const CheckApp = extSvc<any>("aiti-model-check.app") || window.__aitiModelCheckApp || null; // DI 方案 P2 双轨
    if (typeof CheckApp !== "function") {
      return checkExtState === "loading"
        ? <div className="amw-note">{ti("mw.tx.170")}</div>
        : <div className="amw-note">{ti("mw.tx.171")}</div>;
    }
    // t 可选：模型检查「去启用」传 "status" → 关闭检查浮层回主视图并选中新模型 provider；"add" → 打开添加浮层。
    return <CheckApp open={true} embedded={true} onGotoWizard={(t?: string) => { setTab(typeof t === "string" ? t : "status"); setMsg(""); }} onCleanupEdit={(payload: any) => applyCleanupEdit(payload)} />;
  };

  // 已配置 provider 卡片（推荐卡同款风格）：logo + 名称/新增 + 检查状态概要（来自 aiti-model-check）
  // + 模型名预览 + 模型/key 数。技术信息（api/baseUrl/key）与编辑控件点击卡片展开；小屏点击进整屏编辑。
  const aggCheck = (p: string) => {
    if (!chk || !chk.state) return null;
    const cfg = (chk.models || []).filter((m: any) => m.provider === p);
    if (!cfg.length) return null;
    const agg = { ok: 0, rl: 0, err: 0, pend: 0 };
    for (const e of cfg) {
      const r = (chk.state.models || {})[e.provider + "/" + e.model];
      if (!r) { agg.pend++; continue; }
      if (r.lastOk) agg.ok++; else if (r.rateLimited) agg.rl++; else agg.err++;
    }
    return agg;
  };
  // 功能菜单（辅助操作弹出）：主视图头部与各浮层头部共用——功能切换随处可达（含回主视图）；✕ 永远只做关闭
  const funcMenuItems = () => ([
    { key: "status", icon: ICONS.list, label: ti("mw.a.589"), hint: ti("mw.a.590"), go: () => setTab("status") },
    { key: "add", icon: ICONS.plus, label: ti("mw.a.591"), hint: ti("mw.a.592"), go: () => setTab("add") },
    { key: "subs", icon: ICONS.key, label: ti("mw.a.593"), hint: "OAuth", go: () => { setTab("subs"); loadSubs(); } },
    { key: "free", icon: ICONS.gift, label: ti("mw.a.594"), hint: ti("mw.a.595"), go: () => { setTab("free"); loadFree(); } },
    { key: "combo", icon: ICONS.layers, label: ti("mw.a.596"), hint: ti("mw.a.597"), go: () => { setTab("combo"); loadCombos(); } },
    { key: "check", icon: ICONS.stethoscope, label: ti("mw.a.598"), hint: ti("mw.a.599"), go: () => { setTab("check"); loadCheck(); } },
  ] as any[]);
  const funcMenu = () => (
    <div style={{ position: "relative" }} ref={menuRef}>
      <button className="amw-btn amw-tb-btn" aria-haspopup="menu" aria-expanded={menuOpen} title={ti("mw.a.600")} onClick={() => setMenuOpen(!menuOpen)}>☰<span className="amw-tb-label">{ti("mw.tx.172")}</span>▾</button>
      {menuOpen ? (
        <div className="amw-menu" role="menu">
          {funcMenuItems().map((it: any) => (
            <button key={it.key} role="menuitem" className="amw-menu-item"
              style={tab === it.key ? { background: "var(--bg-selected, rgba(37, 99, 235, 0.1))", fontWeight: 600 } : undefined}
              onClick={() => { setMenuOpen(false); setMsg(""); it.go(); }}>
              <span style={{ width: 18, display: "flex", justifyContent: "center" }}>{tab === it.key ? <Ic size={14} paths={ICONS.check} /> : <Ic size={14} paths={it.icon} />}</span>
              <span style={{ flex: 1, textAlign: "left" }}>{it.label}</span>
              <span className="amw-menu-hint">{it.hint}</span>
            </button>
          ))}
          <div className="amw-menu-sep" />
          <button role="menuitem" className="amw-menu-item" onClick={() => { setMenuOpen(false); doRefreshProxies(); }}>
            <span style={{ width: 18, display: "flex", justifyContent: "center" }}><Ic size={14} paths={ICONS.refresh} /></span>
            <span style={{ flex: 1, textAlign: "left" }}>{ti("mw.tx.173")}</span>
            <span className="amw-menu-hint">{ti("mw.tx.174")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );

  // （C 后期迭代）浮层已退役：四个功能视图回歬页签（大屏页签切换 / 小屏 ☰ 菜单切换），
  // 语义约定不变：✕ 永远只关闭整个面板；功能间切换不丢各自视图状态（key 按 tab 重挂）

  // 小屏全屏交给 aiti-float 的 data-ext-float-full 标记；small 只管安全区内边距与标题文案
  const headStyle = small ? { paddingTop: "max(10px, env(safe-area-inset-top, 0px))" } : undefined;
  const bodyStyle = small ? { paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))" } : undefined;
  // 浮动契约（data-ext-float）：面板可拖拽/边缘缩放/位置持久化/点按置前（未装 aiti-float 时回退右下角锚定）；
  // 小屏全屏由 data-ext-float-full 标记托管（aiti-float 跨断点动态切换，无需 key 重挂载）。
  // aiti-float 契约：独立持久化键（v2：960 宽新默认，作废旧 760 存档盒）；拖动/缩放/⛶❐/小屏全屏
  // dock v3：停靠 face（embedded）不声明 float 契约——停靠内容进宿主容器，禁止 float 增强器二次接管
  const floatProps: any = embedded ? {} : { "data-ext-float": "1", "data-ext-float-key": WIZARD_KEY, "data-ext-float-w": 960, "data-ext-float-autoh": "1", "data-ext-float-full": "1" };
  return (
    <div className="amw-shell" {...floatProps} {...(embedded ? { "data-amw-embedded": "1" } : {})} ref={rootRef}>
      <div className="amw-header" style={headStyle}>
        <span className="amw-title"><Ic size={15} paths={ICONS.wand} />{small ? null : <span className="amw-title-text">{ti("mw.a.614")}</span>}</span>
        <div className="amw-tabs">
          {[["status", ti("mw.a.589"), ICONS.list], ["subs", ti("mw.a.601"), ICONS.key], ["free", ti("mw.a.602"), ICONS.gift], ["combo", ti("mw.a.603"), ICONS.layers], ["check", ti("mw.a.604"), ICONS.stethoscope]].map(([k, label, icon]: any) => (
            <button key={k} className={"amw-tab" + (tab === k ? " is-on" : "")} onClick={() => { setTab(k); setMsg(""); if (k === "status") { loadNewInfo(); loadCheck(); } if (k === "subs") loadSubs(); if (k === "free") loadFree(); if (k === "combo") loadCombos(); if (k === "check") loadCheck(); }}><Ic size={11} paths={icon} />{label}</button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button className="amw-btn amw-tb-btn" title={ti("mw.a.605")} onClick={() => setCfgOpen(true)}><Ic size={13} paths={ICONS.settings} /></button>
          <button className="amw-btn amw-tb-btn" title={ti("mw.a.606")} onClick={() => void doExport()}>⇩<span className="amw-tb-label">{ti("mw.tx.175")}</span></button>
          <button className="amw-btn amw-tb-btn" title={ti("mw.a.607")} onClick={() => setImpDlg({ phase: "paste", text: "" })}>⇪<span className="amw-tb-label">{ti("mw.tx.176")}</span></button>
          {funcMenu()}
          {tab === "add" ? (
            <button className="amw-btn is-primary amw-tb-btn" title={ti("mw.a.608")} onClick={() => { setTab("status"); setMsg(""); }} style={{ boxShadow: "inset 0 0 0 2px rgba(255,255,255,.5)" }}>
              ✓<span className="amw-tb-label"> {ti("mw.tx.177")}</span>
            </button>
          ) : (
            <button className="amw-btn is-primary amw-tb-btn" title={ti("mw.a.609")} onClick={() => { setTab("add"); setMsg(""); }}>
              ＋<span className="amw-tb-label"> {ti("mw.tx.178")}<span className="amw-label-long"> provider</span></span>
            </button>
          )}
          {isSettings ? null : <button className="amw-btn" onClick={onClose} aria-label={ti("mw.a.25")} title={ti("mw.a.610")}><Ic size={12} paths={ICONS.x} /></button>}
        </div>
      </div>
      <div key={"body-" + tab} className="amw-body" style={bodyStyle}>
        {busy ? <div style={{ color: "var(--text-subtle,#666)", marginBottom: 6 }}>{ti("mw.tx.179")}</div> : null}
        {msg ? <div className="amw-note">{msg}</div> : null}
        {missingInfo && Array.isArray(missingInfo.models) && missingInfo.models.length ? (
          <div className="amw-note is-warn" style={{marginBottom: 8}}>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>{"⚠️ " + missingInfo.models.length + ti("mw.a.611") + missingInfo.models.map((m: any) => m.id).join("、")}</div>
            <div style={{ fontSize: 11, lineHeight: 1.7, color: "var(--text-subtle,#666)" }}>
              {ti("mw.a.612")}
              <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {missingInfo.models.map((m: any) => (
                  <button key={m.id} className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} onClick={() => void viewModelParams(missingInfo.provider, m.id, true)}>✎ {m.id}</button>
                ))}
                <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} title={ti("mw.a.613")} onClick={() => invokeAiHelperForMissing(missingInfo.provider, missingInfo.models, rootRef.current)}>{ti("mw.tx.180")}</button>
                <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} onClick={() => setMissingInfo(null)}>{ti("mw.a.302")}</button>
              </div>
            </div>
          </div>
        ) : null}
        {tab === "add" ? renderAdd() : tab === "subs" ? renderSubscriptions() : tab === "free" ? renderFree() : tab === "check" ? renderCheck() : tab === "combo" ? renderCombos() : renderStatus()}
      </div>
      {saveDlg ? renderSaveDlg() : null}
      {impDlg ? renderImportDlg() : null}
      {checkupSt && (checkupSt.running || checkupSt.res) ? (
        <CheckupDialog st={checkupSt} onClose={() => setCheckupSt(null)} onFix={(prov: string) => { setCheckupSt(null); selectNode({ type: "provider", provider: prov }); }} onRerun={runCheckup} />
      ) : null}
      {cfgOpen ? <SettingsDialog onClose={() => setCfgOpen(false)} /> : null}
      {toast ? (
        <div style={{ position: "fixed", top: 6, left: "50%", transform: "translateX(-50%)", zIndex: 2147483199, maxWidth: "calc(100vw - 20px)", padding: "7px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600, boxShadow: "0 8px 24px rgba(0,0,0,.25)", background: toast.ok ? "rgba(22,163,74,.97)" : "rgba(220,38,38,.97)", color: "#fff", display: "flex", alignItems: "center", gap: 6 }}>{toast.msg}</div>
      ) : null}
      {viewParam && !viewParam.embedded ? (
        <ParamDialog
          data={viewParam}
          dialogEl={rootRef.current}
          onClose={() => setViewParam(null)}
          onSaved={(resp: any) => {
            // 参数保存成功 → 按响应刷新缺参 banner：本模型已补齐则从列表移除，仍缺则保留（不会误清其它仍缺的模型）
            const savedId = viewParam.id;
            const left = resp && Array.isArray(resp.missingParams) ? resp.missingParams.map((x: any) => x && x.id).filter(Boolean) : [];
            setMissingInfo((prev: any) => {
              if (!prev || !savedId) return prev;
              if (left.includes(savedId)) return prev;
              const models = (prev.models || []).filter((x: any) => x.id !== savedId);
              return models.length ? { ...prev, models } : null;
            });
            viewModelParams(viewParam.provider, viewParam.id);
            loadStatus();
            if (viewParam.id) void runProbeCaps(viewParam.provider, [viewParam.id]);
          }}
        />
      ) : null}
    </div>
  );
}

// toolbar 按钮：触发全局打开（样式与系统内建按钮一致：flex 居中 + fixed 36×36（=系统 TOP_BAR_ICON_BUTTON_SIZE））
export function WizardButton() {
  // 新模型徽标：total>0 就显示（不依赖频控额度）；点击落在已配置页查看并知悉
  const [newTotal, setNewTotal] = useState(0);
  useEffect(() => {
    let dead = false;
    const apply = (d: any) => { if (!dead && d && d.ok) setNewTotal(d.total || 0); };
    fetchNewModelsOnce().then(apply);
    const onChanged = () => { fetchNewModelsOnce().then(apply); };
    window.addEventListener("aiti-model-wizard:new-models-changed", onChanged);
    return () => { dead = true; window.removeEventListener("aiti-model-wizard:new-models-changed", onChanged); };
  }, []);
  const open = () => { try { (window.__aitiModelWizardOpenTab || window.__aitiModelWizardOpen)!(newTotal ? "status" : undefined); } catch {} };
  return (
    <button
      title={newTotal ? ti("mw.shell.newFound", { n: newTotal }) : ti("mw.shell.title")}
      onClick={open}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", position: "relative",
        width: 36, height: 36, padding: 0,
        background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      }}
    >
      {/* lucide wand-sparkles：添加向导（魔杖+星星）——与系统内建线条图标同风格 */}
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path key="p1" d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" />
        <path key="p2" d="m14 7 3 3" />
        <path key="p3" d="M5 6v4" />
        <path key="p4" d="M19 14v4" />
        <path key="p5" d="M10 2v2" />
        <path key="p6" d="M7 8H3" />
        <path key="p7" d="M21 16h-4" />
        <path key="p8" d="M11 3H9" />
      </svg>
      {newTotal > 0 ? (
        <span key="badge" style={{
          position: "absolute", top: 3, right: 4, minWidth: 14, height: 14, padding: "0 3px",
          borderRadius: 999, background: "#dc2626", color: "#fff", fontSize: 9, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none",
          boxShadow: "0 0 0 2px var(--bg,#fff)",
        }}>{newTotal > 99 ? "99+" : String(newTotal)}</span>
      ) : null}
    </button>
  );
}

// pages dialog（dock v3：显隐收口状态机——mailbox/service/薄壳桥全部 openFloat，onClose 走 closePanel）
export function WizardDialog() {
  const open = useGate(WIZARD_KEY, "float");
  const [initTab, setInitTab] = useState("status");
  const [initProvider, setInitProvider] = useState<string | null>(null);
  useEffect(() => {
    window.__aitiModelWizardOpen = () => { setInitTab("status"); setInitProvider(null); openFloat(WIZARD_KEY); };
    // C4 兼容映射：t="status" → 主视图并选中（模型有变动的 provider 或指定 provider）；t="add"/无参 → 主视图+添加浮层（旧默认）
    window.__aitiModelWizardOpenTab = (t?: string, provider?: string) => { setInitTab(t || "add"); setInitProvider(provider || null); openFloat(WIZARD_KEY); };
    // [D1 拆包] 薄壳桥：薄壳按钮点击（先于全局注册的时序）经 shellApplyOpen/shellPendingOpen 打开
    shellApplyOpen = (t?: string, provider?: string | null) => { setInitTab(t || "status"); setInitProvider(provider ?? null); openFloat(WIZARD_KEY); };
    if (shellPendingOpen) { const po = shellPendingOpen; shellPendingOpen = null; shellApplyOpen(po.tab, po.provider); }
    // DI 方案 P2：services 通道双轨注册（旧全局保留至消费方迁完；旧宿主 no-op）
    const d1 = regSvc("aiti-model-wizard.open", window.__aitiModelWizardOpen);
    const d2 = regSvc("aiti-model-wizard.openTab", window.__aitiModelWizardOpenTab);
    return () => { try { d1?.(); d2?.(); } catch {} delete window.__aitiModelWizardOpen; delete window.__aitiModelWizardOpenTab; };
  }, []);
  if (!open) return null;
  return <App open={true} initialTab={initTab} initialProvider={initProvider} onClose={() => closePanel(WIZARD_KEY)} />;
}

/** 停靠 face（rightFileDock item "shell-v2" → 复合 id = WIZARD_KEY）：仅 docked:right-panel 渲染。
 *  embedded=true：App 壳剥 float 契约与 fixed 锚定，铺满 DockBody（amw-styles 对应规则）。 */
export function WizardDockFace() {
  const docked = useGate(WIZARD_KEY, { dock: "right-panel" });
  if (!docked) return null;
  return (
    <DockBody itemKey={WIZARD_KEY} zone="right-panel" title={ti("mw.a.614")} chrome="tab"
      zones={["right-panel"]} defaultZone="right-panel">
      <App open={true} initialTab="status" initialProvider={null} embedded onClose={() => closePanel(WIZARD_KEY)} />
    </DockBody>
  );
}

// ═══ [D1 拆包] 薄壳桥（docs/aiti-ext-lazy-loading-plan.md D1）═══
// 重 chunk 首载（薄壳按钮点击 / new-models 事件预热）时自注册全部插槽；
// 薄壳的打开请求早于 WizardDialog 挂载时暂存 pendingOpen，挂载即消费。
let heavySlotsRegistered = false;
let shellApplyOpen: ((tab?: string, provider?: string | null) => void) | null = null;
let shellPendingOpen: { tab?: string; provider?: string | null } | null = null;

export function initHeavySlots(ctx: any): void {
  if (heavySlotsRegistered) return;
  heavySlotsRegistered = true;
  // cleanupEdit 信箱 service（原 entry 启动注册——随重 chunk 首载延迟，见薄壳注释）
  try { ctx.registerExtService?.("aiti-model-wizard.cleanupEdit", depositCleanupEdit); } catch {}
  ensureStyles(); // 自持样式层（amw-* 类）：重 chunk 首载时注入，先于任何 UI 渲染
  ctx.registerItems?.("pages", [{ id: "aiti-model-wizard-dialog", render: WizardDialog }]);
  // 默认浮窗（2026-11）：不再 seedDockDefault 右栏——用户无偏好时 open 直达浮窗；
  // 需要 dock 仍可从 DockStack ⇱ 菜单显式停靠（dock:zone 会记忆偏好，此后 open 回 dock）。
  // 一次性迁移：清掉历史 seedDockDefault 已写入的默认 right-panel 偏好（仅此一次，尊重此后用户显式选择）。
  try {
    if (!localStorage.getItem("aiti-model-wizard:default-float-migrated")) {
      if (localStorage.getItem("pi-web:ext-float:dockpref:v1:aiti-model-wizard") === "right-panel") {
        localStorage.removeItem("pi-web:ext-float:dockpref:v1:aiti-model-wizard");
      }
      localStorage.setItem("aiti-model-wizard:default-float-migrated", "1");
    }
  } catch { /* ignore */ }
  ctx.registerItems?.("rightFileDock", [{ id: "shell-v2", render: WizardDockFace, meta: { title: "i18n:it.shell.title" } }]);
  ctx.registerItems?.("pages", [{ id: "aiti-model-wizard-reminder", render: ReminderToast }]);
  ctx.registerItems?.("banners", [{ id: "aiti-model-wizard-banner", render: Banner }]);
  ctx.registerItems?.("sessionStats", [{ id: "aiti-model-wizard-multikey-status", render: MultiKeyStatusRows, meta: { label: "i18n:it.multikey-status.label.2" } }]); // same id as the thin-shell entry's slot entry: registerExtUiItems idempotently overwrites/upgrades (thin-shell direct version → full version); duplicate registrations converge naturally
}

export function openWizardFromShell(tab?: string, provider?: string | null): void {
  if (shellApplyOpen) shellApplyOpen(tab, provider);
  else shellPendingOpen = { tab: tab ?? "status", provider: provider ?? null };
}

// banners：无模型 / 所有模型不可用 引导
// 显示条件（只在这两种时候出现）：① 还没有任何已配置 provider；② 所有已配置模型都不可用（全部限流或异常——
// 依据 aiti-model-check 的探测/运行监测记录，有任一可用或任一未探测则不算全部不可用，避免误报）。
// 场景 ② 提供「查看模型检查」入口看检查记录（探测历史 / 429 恢复时间 / 运行期被阻断标记）。
export function Banner() {
  const [state, setState] = useState<any>({ noModels: false, allUnavailable: false, avail: null });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let dead = false;
    // 最近一帧 mc:avail 数据（后台标签页也收帧，只是不渲染；回前台用最近帧补一次，不反查）
    let latestAvail: any = null;
    // availability 数据应用（事件帧优先）：noModels 分支独立不受影响
    const applyAvail = (av: any) => {
      if (dead || !av || av.ok === false) return;
      latestAvail = av;
      if (document.hidden) return; // 后台不渲染，回前台 visibilitychange 用最近帧补
      setState((s) => ({ ...s, noModels: false, allUnavailable: !!av.allUnavailable, avail: av }));
      setReady(true);
    };
    // 兜底拉取：仅当从未收到 mc:avail 帧且页面可见时拉一次（此后全事件驱动，零常驻反查）
    const pullAvailOnce = async () => {
      if (dead || document.hidden || latestAvail) return;
      try {
        const av = srvFix(await srvFix(await (await fetch(apiUrl("/api/extensions/aiti-model-check/availability"), { cache: "no-store" })).json()));
        applyAvail(av);
      } catch { /* 无帧也无拉取 → 横幅不显示，等事件 */ }
    };
    // noModels 判定（挂载 / 模型配置变更 / 回前台）：拉 wizard/status 一次。
    // light=1：跳过服务端 runtime 合并（自 fetch /api/models ~350ms 主因）——
    // 这里只判 providers 空否；打开向导面板的 openTab("status") 走完整 /status。
    const checkModels = async () => {
      try {
        const d = srvFix(await (await api("/status?light=1")).json());
        if (dead) return;
        const noModels = d && Array.isArray(d.providers) && d.providers.length === 0;
        if (noModels) { setState({ noModels: true, allUnavailable: false, avail: null }); setReady(true); return; }
        setState((s) => (s.noModels ? { ...s, noModels: false } : s));
        setReady(true);
        pullAvailOnce();
      } catch { if (!dead) { setState({ noModels: false, allUnavailable: false, avail: null }); setReady(true); } }
    };
    checkModels();
    // 事件驱动（替代固定轮询 + 常驻反查）：
    // ① mc:avail 帧自带 availability 快照（ok/noModels/allUnavailable/rateLimited… 平铺在帧上）→
    //    直接消费，不再 fetch availability；后台标签页跳过渲染（无观众空转），回前台用最近帧补。
    // ② pi-web:models-changed → 重新判 noModels（模型配置变更会触发 model-check 重探并广播 mc:avail 覆盖 allUnavailable）。
    // ③ visibilitychange 回前台兜底：用最近帧刷新，无帧才拉一次。
    const unSubAvail = subscribeAvailabilityEvents((frame) => { if (!dead) applyAvail(frame); });
    const onChanged = () => { if (!dead) void checkModels(); };
    window.addEventListener("pi-web:models-changed", onChanged);
    const onVis = () => {
      if (dead || document.visibilityState !== "visible") return;
      if (latestAvail) applyAvail(latestAvail); // 回前台用最近帧刷新（零反查）
      else pullAvailOnce();                     // 从未收到帧 → 兜底拉一次
      void checkModels();                       // 后台期间可能配置变更，补一次 noModels 判定
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      dead = true;
      unSubAvail();
      window.removeEventListener("pi-web:models-changed", onChanged);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  if (!ready || (!state.noModels && !state.allUnavailable)) return null;
  const openWizard = () => { try { window.__aitiModelWizardOpen && window.__aitiModelWizardOpen(); } catch {} };
  // DI 方案 P2：services 通道优先，旧全局兜底（双轨过渡）
  const openCheck = () => { const f = extSvc<() => void>("aiti-model-check.open") || window.__aitiModelCheckOpen; try { f && f(); } catch {} };
  const hasCheck = () => { try { const f = extSvc<() => void>("aiti-model-check.open") || window.__aitiModelCheckOpen; return typeof f === "function"; } catch { return false; } };
  const avail = state.allUnavailable && state.avail ? state.avail : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 12px", margin: "6px 0 0", flexWrap: "wrap", background: state.allUnavailable ? "rgba(220,38,38,.07)" : "rgba(37,99,235,.08)", border: "1px solid " + (state.allUnavailable ? "rgba(220,38,38,.3)" : "rgba(37,99,235,.25)"), borderRadius: 10, fontSize: 12.5 }}>
      <span style={{ fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={14} paths={ICONS.wand} />{state.allUnavailable ? ti("mw.a.615") : ti("mw.a.616")}</span>
      <span style={{ color: "var(--text-subtle,#666)" }}>{state.allUnavailable
        ? (avail ? "（" + avail.rateLimited + ti("mw.a.116") + avail.errorCount + ti("mw.a.464") + (avail.lastBlocked && avail.lastBlocked.marked ? ti("mw.a.617") : "") + ti("mw.a.618") : ti("mw.a.619"))
        : ti("mw.a.620")}</span>
      {state.allUnavailable && hasCheck() ? <button className="amw-btn" style={{ background: "#dc2626", color: "#fff", padding: "3px 10px" }} onClick={openCheck}>{ti("mw.tx.181")}</button> : null}
      <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "3px 10px" }} onClick={openWizard}>{state.allUnavailable ? ti("mw.a.621") : ti("mw.a.622")}</button>
    </div>
  );
}

// 新模型检测 toast：只在页面加载时随共享的一次请求判定（?toast=1 消费频控额度）。
// 放行 → 顶部 toast 展示 10 秒；被频控挡下 → 静默（工具栏徽标仍然可见）。
export function ReminderToast() {
  const [toast, setToast] = useState<string | null>(null);
  // 已处置抑制标志：向导内「知道了/启用/忽略」ack 成功 → 事件关闭 toast 后不再允许任何路径重弹
  const silencedRef = useRef(false);
  useEffect(() => {
    let dead = false;
    const showFrom = (d: any): boolean => {
      if (dead || silencedRef.current || !d) return false;
      try { console.log("[aiti-model-wizard] toast-check:", JSON.stringify({ scanning: d.scanning, total: d.total, allowed: d.toast && d.toast.allowed, reason: d.toast && d.toast.reason })); } catch {}
      if (!d.total || !d.toast || !d.toast.allowed) return false;
      const entries = Object.entries(d.providers || {}).slice(0, 3);
      const names = entries.map(([name, v]: any) => name + "+" + v.count).join("、");
      const sum = entries.reduce((s: number, [, v]: any) => s + v.count, 0);
      // 常驻提示：不自动消失，直到用户点击（进向导）或 ✕（知道了）
      setToast(ti("mw.a.514") + d.total + ti("mw.a.623") + names + (d.total > sum ? "…" : "") + ti("mw.a.624"));
      return true;
    };
    const visibleAtMount = document.visibilityState === "visible";
    let onVis: (() => void) | null = null; // 补弹监听（一次性）；卸载时也要能移除，避免泄漏
    fetchNewModelsOnce({ toast: visibleAtMount }).then((d) => {
      if (showFrom(d)) return;
      // 后台标签页加载时不消费额度；用户首次切回前台 → 补一次 toast 尝试（一次性事件，非轮询）
      if (!visibleAtMount && d && d.total) {
        onVis = () => {
          if (document.visibilityState !== "visible") return;
          document.removeEventListener("visibilitychange", onVis!);
          onVis = null;
          fetchNewModelsWithToast().then((d2) => { showFrom(d2); });
        };
        document.addEventListener("visibilitychange", onVis);
      }
    });
    // 外部已处置（向导内 ackNew/enableNewModels/ignoreNew 成功 → invalidateNewModels 广播）：
    // toast 同步关闭，且置抑制标志——关闭后不得再被 showFrom resolve 重弹
    const onChanged = () => {
      silencedRef.current = true;
      setToast(null);
    };
    window.addEventListener("aiti-model-wizard:new-models-changed", onChanged);
    return () => { dead = true; window.removeEventListener("aiti-model-wizard:new-models-changed", onChanged); if (onVis) document.removeEventListener("visibilitychange", onVis); };
  }, []);
  // ✕ 关闭 = 「知道了，不再提醒」：清待告知集（下次刷新不再弹），不进入向导
  const dismiss = () => {
    silencedRef.current = true; // 先抑制再 ack：ack 广播的事件到来时幂等（toast 已 null）
    setToast(null);
    try { api("/new-models/ack", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(() => invalidateNewModels()).catch(() => {}); } catch {}
  };
  if (!toast) return null;
  return (
    <div
      onClick={() => { setToast(null); try { window.__aitiModelWizardOpenTab && window.__aitiModelWizardOpenTab("status"); } catch {} }}
      style={{ position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 2147483999, maxWidth: "calc(100vw - 24px)",
        padding: "10px 12px 10px 16px", borderRadius: 12, fontSize: 13, fontWeight: 600, cursor: "pointer",
        background: "rgba(22,163,74,.97)", color: "#fff", boxShadow: "0 10px 32px rgba(0,0,0,.3)",
        display: "flex", alignItems: "center", gap: 8, animation: "aitiToastIn .25s ease" }}
    >
      <Ic size={15} paths={ICONS.sparkles} />
      <span>{toast}</span>
      <span style={{ fontSize: 11, fontWeight: 500, opacity: .85, whiteSpace: "nowrap" }}>{ti("mw.tx.182")}</span>
      <button
        title={ti("mw.a.625")} aria-label={ti("mw.a.625")}
        onClick={(e) => { e.stopPropagation(); dismiss(); }}
        style={{ background: "rgba(255,255,255,.18)", border: "none", color: "#fff", width: 20, height: 20,
          borderRadius: "50%", fontSize: 12, lineHeight: 1, cursor: "pointer", display: "flex",
          alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0 }}
      >✕</button>
    </div>
  );
}
