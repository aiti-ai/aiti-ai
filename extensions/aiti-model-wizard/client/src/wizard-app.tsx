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
import { apiUrl, extSvc, regSvc, getCtx } from "./host-shim";
import { uiConfirm } from "../../../_shared/ui-dialogs";
import { api, jsonBody, Ic, ICONS, LINK, genName, fetchNewModelsOnce, fetchNewModelsWithToast, invalidateNewModels } from "./wizard-lib";
import { ProviderAvatar } from "./provider-icons";
import { MultiKeyStatusSummary, MultiKeyStatusDialog, MultiKeyStatusRows } from "./multi-key-status";
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
const FIELD_ABBR = { contextWindow: "ctx", maxTokens: "out", reasoning: "推理", input: "输入", cost: "cost", compat: "兼容", thinkingLevelMap: "思考映射", samplingParams: "采样", name: "名", api: "api", baseUrl: "地址" } as const;
const summarizeFills = (fills: any): string => {
  if (!Array.isArray(fills) || !fills.length) return "";
  const parts = fills.slice(0, 4).map((f: any) => {
    const srcs = Object.entries(f.fills || {}).map(([k, v]) => ((FIELD_ABBR as any)[k] || k) + "←" + v).join("·");
    return f.id + "（" + srcs + "）";
  });
  const more = fills.length > 4 ? " 等 " + fills.length + " 个" : "";
 return ("🪄 自动反填：" + parts.join(", ") + more).slice(0, 220);
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
    "我在模型向导里保存了 provider「" + provider + "」，但以下模型在所有数据源（models.json / 内置目录 models-store / 厂商 /models / models.dev / OpenRouter / LiteLLM）都查不到参数，被保存成了裸条目（缺 contextWindow / maxTokens 等）：",
    ids,
    "请按 model-params-fill 手册：1) 上网查权威数据（官方文档 / /models 接口 / models.dev / OpenRouter）；",
    "2) 把权威数据写入 ~/.pi/agent/models-store.json（provider=" + provider + " 的 models 数组，只增改目标模型，勿动其它条目）；",
    "3) 在模型向导已打开的「模型参数」弹窗里回填这些参数，让我点击保存生效。",
    "权威来源请标注。查不到的字段宁缺毋滥，绝不瞎编。",
  ].join("\n");
  try {
    invokeFn({
      extId: "aiti-model-wizard",
      extName: "模型添加向导",
      helperId: "model-params-fill",
      message: prompt,
      autoSend: true,  // 预填后自动发送：AI 直接开查，用户无需再点「生成」
      placeholder: "AI 正在查权威数据并补全参数…",
      contextLabel: "模型缺参数 · " + provider + " · " + ids,
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
  if (!parts.length) return r.exhausted ? "已用尽" : "";
  return parts.join(" · ") + (buckets.length > 3 ? " 等 " + buckets.length + " 项" : "");
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
          <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{"🩺 一键体检" + (st?.running ? " · 进行中…" : "")}</span>
          <button className="amw-btn" onClick={onClose} aria-label="关闭"><Ic size={12} paths={ICONS.x} /></button>
        </div>
        {st?.running ? (
          <div className="amw-note">正在逐 provider 串行探测（每家最长约 12 秒；跳过聚合组/禁用/无凭据）……测完自动出报告并留存结论。</div>
        ) : !res || !res.ok ? (
          <div className="amw-note is-err">{"❌ " + ((res && res.error) || "体检失败")}</div>
        ) : (
          <>
            <div className="amw-note" style={{ marginBottom: 8 }}>
              {"✅ " + res.pass + " 可用 · 🟡 " + (res.rateLimited || 0) + " 限流 · ❌ " + (res.fail || 0) + " 失败" + (res.skip ? " · ⏭ " + res.skip + " 跳过" : "")}
              {"　（结论已留存，树上徽标/详情健康条同步）"}
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
                      : (r.status ? "HTTP " + r.status + " · " : "网络异常 · ") + (r.latencyMs != null ? fmtLat(r.latencyMs) + " · " : "") + (r.detail || "")
                      + (r.model ? "（探针 " + r.model + "）" : "")}
                  </span>
                  {!r.skipped && r.masked ? <span className="amw-mono" style={{ flexShrink: 0, color: "var(--text-subtle,#999)" }}>{r.keyName + " " + r.masked}</span> : null}
                  {!r.skipped && !r.pass ? (
                    <button className="amw-btn" style={{ padding: "1px 8px", fontSize: 10.5, flexShrink: 0 }} onClick={() => onFix(r.provider)}>去修</button>
                  ) : null}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10, flexShrink: 0 }}>
              <button className="amw-btn" onClick={onRerun}>↻ 重跑体检</button>
              <button className="amw-btn is-ok" onClick={onClose}>完成</button>
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
        const d = await (await api("/config")).json();
        if (d && d.ok) setCfg(d.config); else setErr((d && d.error) || "读取配置失败");
      } catch (e: any) { setErr(String(e.message || e)); }
    })();
  }, []);
  const upd = (section: string, key: string, v: any) => setCfg((prev: any) => ({ ...(prev || {}), [section]: { ...((prev || {})[section] || {}), [key]: v } }));
  const save = async () => {
    if (!cfg) return;
    setSaving(true); setErr(""); setMsg("");
    try {
      const d = await (await api("/config", { method: "POST", ...jsonBody({ set: cfg }) })).json();
      if (d && d.ok) { setMsg("✅ 已保存，即时生效"); setTimeout(onClose, 700); }
      else setErr((d && d.error) || "保存失败");
    } catch (e: any) { setErr(String(e.message || e)); }
    setSaving(false);
  };
  const refreshCatalog = async () => {
    setCatBusy(true); setMsg(""); setErr("");
    try {
      const d = await (await api("/refresh-catalog", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
      setMsg(d && d.ok ? "✅ 目录已刷新（" + (d.providers ?? "?") + " 家 · " + (d.source || "?") + " · " + fmtLat(d.elapsedMs) + "）" : "❌ " + ((d && d.error) || "刷新失败"));
    } catch (e: any) { setErr(String(e.message || e)); }
    setCatBusy(false);
  };
  const r = cfg && cfg.reminder, cat = cfg && cfg.catalog, pr = cfg && cfg.probe, ts = cfg && cfg.test;
  const panel = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <Ic size={14} paths={ICONS.settings} />
        <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>⚙ 向导设置</span>
        <button className="amw-btn" onClick={onClose} aria-label="关闭"><Ic size={12} paths={ICONS.x} /></button>
      </div>
      {err ? <div className="amw-note is-err" style={{ marginBottom: 6 }}>{"❌ " + err}</div> : null}
      {msg ? <div className="amw-note is-ok" style={{ marginBottom: 6 }}>{msg}</div> : null}
      {!cfg ? <div style={{ color: "var(--text-subtle,#666)", fontSize: 12 }}>加载中…</div> : (
        <div style={{ overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div className="amw-section" style={{ margin: "0 0 5px" }}>🔔 新模型检测与提醒</div>
            <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center", marginBottom: 6 }}>
              <input type="checkbox" checked={r?.enabled !== false} onChange={(e) => upd("reminder", "enabled", e.target.checked)} />启用后台扫描与提醒
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <SetNum label="扫描间隔（分钟）" value={r ? Math.round((r.checkIntervalMs || 1800000) / 60000) : ""} onChange={(v) => upd("reminder", "checkIntervalMs", Math.max(1, Math.floor(Number(v) || 0)) * 60000)} />
              <SetNum label="单家拉取超时（秒）" value={r ? Math.round((r.fetchTimeoutMs || 8000) / 1000) : ""} onChange={(v) => upd("reminder", "fetchTimeoutMs", Math.max(1, Math.floor(Number(v) || 0)) * 1000)} />
              <SetNum label="toast 每日上限" hint="超出后静默（徽标不受影响）" value={r ? r.maxPerDay ?? "" : ""} onChange={(v) => upd("reminder", "maxPerDay", Math.max(0, Math.floor(Number(v) || 0)))} />
              <SetNum label="toast 最小间隔（秒）" value={r ? Math.round((r.minGapMs || 30000) / 1000) : ""} onChange={(v) => upd("reminder", "minGapMs", Math.max(0, Math.floor(Number(v) || 0)) * 1000)} />
              <SetNum label="toast 展示时长（秒）" value={r ? Math.round((r.toastMs || 10000) / 1000) : ""} onChange={(v) => upd("reminder", "toastMs", Math.max(1, Math.floor(Number(v) || 0)) * 1000)} />
            </div>
          </div>
          <div>
            <div className="amw-section" style={{ margin: "0 0 5px" }}>📖 目录（models.dev）</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div><label style={lbl}>主源 URL</label><input className="amw-input" style={{ width: "100%", fontFamily: "ui-monospace,monospace" }} value={cat?.primaryUrl ?? ""} onChange={(e) => upd("catalog", "primaryUrl", e.target.value)} /></div>
              <div><label style={lbl}>镜像 URL（竞速兜底）</label><input className="amw-input" style={{ width: "100%", fontFamily: "ui-monospace,monospace" }} value={cat?.mirrorUrl ?? ""} onChange={(e) => upd("catalog", "mirrorUrl", e.target.value)} /></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end" }}>
                <SetNum label="缓存 TTL（小时）" value={cat ? cat.ttlHours ?? "" : ""} onChange={(v) => upd("catalog", "ttlHours", Math.max(1, Math.floor(Number(v) || 0)))} />
                <button className="amw-btn" disabled={catBusy} style={{ marginBottom: 14 }} title="立即重新下载目录（官方 + 镜像竞速）" onClick={refreshCatalog}>{catBusy ? "刷新中…" : "↻ 立即刷新"}</button>
              </div>
            </div>
          </div>
          <div>
            <div className="amw-section" style={{ margin: "0 0 5px" }}>🔍 探测与测试</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <SetNum label="连接测试超时（秒）" hint="一键体检同用" value={ts ? Math.round((ts.timeoutMs || 12000) / 1000) : ""} onChange={(v) => upd("test", "timeoutMs", Math.max(1, Math.floor(Number(v) || 0)) * 1000)} />
              <SetNum label="端点探测超时（秒）" value={pr ? Math.round((pr.timeoutMs || 12000) / 1000) : ""} onChange={(v) => upd("probe", "timeoutMs", Math.max(1, Math.floor(Number(v) || 0)) * 1000)} />
              <SetNum label="探针 maxTokens" hint="测试连接的最小探针输出上限" value={pr ? pr.maxTokens ?? "" : ""} onChange={(v) => upd("probe", "maxTokens", Math.max(1, Math.floor(Number(v) || 0)))} />
            </div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10, flexShrink: 0 }}>
        <button className="amw-btn" onClick={onClose}>取消</button>
        <button className="amw-btn is-ok" disabled={!cfg || saving} onClick={save}>{saving ? "保存中…" : "💾 保存"}</button>
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
  // 多词 AND 匹配（如 "openrouter glm"、"glm free"），上限放宽到 200 并在截断时明示
  const kws = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const MATCH_CAP = 200;
  const all = pool.filter((m: any) => {
    if ((m.keyCount ?? 0) < 1) return false; // 无 key 成员必然被引擎拒绝，不展示
    if (exclude.includes(m.provider + "/" + m.model)) return false;
    if (!kws.length) return true;
    const hay = (m.provider + "/" + m.model + " " + (m.name || "")).toLowerCase();
    return kws.every((k) => hay.includes(k));
  });
  const cands = all.slice(0, MATCH_CAP);
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
  return (
    <div style={{ marginTop: 6, borderTop: "1px dashed var(--border-subtle,#e5e7eb)", paddingTop: 6 }}>
      <input className="amw-input" style={{width: "100%", padding: "4px 8px", fontSize: 12}} value={q} placeholder="搜索成员（已配置 provider/模型）…"
        onChange={(e) => setQ(e.target.value)} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
        {candsDedup.map((m: any) => (
          // 点击后保留搜索条件，便于连续点选多个成员
          <button key={m.provider + "/" + m.model} title={"ctx=" + (m.contextWindow ?? "?") + " · out=" + (m.maxTokens ?? "?") + " · keys=" + m.keyCount}
            style={{ padding: "2px 9px", borderRadius: 999, border: "1px solid rgba(99,102,241,.3)", background: "rgba(99,102,241,.06)", fontSize: 11, cursor: "pointer", fontFamily: "ui-monospace,monospace" }}
            onClick={() => onPick(m)}>
            {m.provider}/{m.model}
          </button>
        ))}
        {!cands.length ? <span style={{ fontSize: 11, color: "var(--text-subtle,#999)" }}>{pool.length ? "无匹配成员" : "没有可作成员的已配置模型——先在「添加」页配置真实模型"}</span>
        : all.length > MATCH_CAP ? <span style={{ fontSize: 11, color: "var(--text-subtle,#999)" }}>{"共 " + all.length + " 个匹配，仅显示前 " + MATCH_CAP + " 个——请输入关键字缩小范围"}</span> : null}
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
      <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff" }} disabled={!allowEmpty && !v.trim()} onClick={() => onSubmit(v)}>提交</button>
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
    const d = await (await fetch(apiUrl("/api/extensions/aiti-model-check/probe"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, model }),
    })).json();
    const r = d && Array.isArray(d.results) ? d.results.find((x: any) => x.provider === provider && x.model === model) : null;
    if (!d || !d.ok) return { error: (d && d.error) || "探测不可用（aiti-model-check 未启用？）" };
    if (!r) return { error: (d && d.reason) || "无探测结果（该模型可能不在运行清单里）" };
    return { r };
  } catch (e: any) { return { error: "探测失败：" + ((e && e.message) || e) };
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
          {"✅ 可用" + (r.status ? " · HTTP " + r.status : "") + (r.latencyMs != null ? " · " + fmtMs(r.latencyMs) : "")}
        </span>
      ) : r.status === 429 ? (
        <span style={{ color: "#d97706", fontWeight: 650, fontSize: 11.5 }}>
          {"🟡 限流（key/端点正确，稍后重试即可）" + (r.predictedAvailableAt ? " · 预计恢复 " + new Date(r.predictedAvailableAt).toLocaleString("zh-CN", { hour12: false }) : "")}
        </span>
      ) : (
        <span style={{ color: "#dc2626", fontWeight: 650, fontSize: 11.5 }}>
          {("❌ " + (r.label || "异常") + (r.status ? " · HTTP " + r.status : "") + (r.latencyMs != null ? " · " + fmtMs(r.latencyMs) : ""))}
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
  const [draft, setDraft] = useState<any>(() => (data.params ? JSON.parse(JSON.stringify(data.params)) : null));
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
    setDraft(data.params ? JSON.parse(JSON.stringify(data.params)) : null);
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
          <span className="amw-mono" style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{"模型参数 · " + data.id}</span>
          {embedded
            ? <button className="amw-btn" onClick={onClose}>← 返回</button>
            : <button className="amw-btn" onClick={onClose} aria-label="关闭"><Ic size={12} paths={ICONS.x} /></button>}
        </div>
        {data.loading ? <div style={{ color: "var(--text-subtle,#666)", fontSize: 12 }}>加载中…</div>
          : data.error ? <div style={{ color: "#dc2626", fontSize: 12 }}>{"❌ " + data.error}</div>
          : <div style={{ color: "var(--text-subtle,#666)", fontSize: 12 }}>{data.readOnly ? "目录未收录该模型的详细参数（仅 id 清单）。" : "未取到该模型参数——provider 的模型清单为空或模型已被移除。"}</div>}
        {!data.loading && !data.error && data.readOnly ? (
          <div style={{ marginTop: 10 }}>
            <button className="amw-btn is-ok" onClick={() => invokeAiHelperForMissing(data.provider, [{ id: data.id }], dialogEl || null)}>🤖 AI 帮我补参数（查权威数据 → 写 models-store）</button>
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
      if (draft.api) m.api = draft.api;
      const d = await (await api("/save", { method: "POST", ...jsonBody({ provider: data.provider, baseUrl: data.baseUrl, api: data.api || "openai-completions", keepKey: true, models: [m] }) })).json();
      if (d.ok) { onSaved && onSaved(d); onClose(); }
      else setErrMsg(d.error || "保存失败");
    } catch (e: any) { setErrMsg(String(e.message || e)); }
    setSaving(false);
  };
  const lbl = { fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 } as any;
  const panel = (
    <>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <Ic size={14} paths={ICONS.card} />
          <span className="amw-mono" style={{ fontWeight: 700, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(edit ? "编辑模型 · " : "模型参数 · ") + (draft.id || data.id)}</span>
          {data.readOnly ? <span className="amw-tag is-ro">只读 · 目录反填</span>
            : !edit ? <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => setEdit(true)}>✎ 编辑</button> : null}
          {!embedded ? (
            <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, fontWeight: 650 }}
              disabled={!!(probeSt && probeSt.busy)} onClick={doModelProbe}
              title="发起可用性探测（与「检查」页同款探针，结果写入同一份状态/历史，树上 可用/限流/异常 标记同步更新）——测完立即就地展示">
              {(probeSt && probeSt.busy) ? "⏳ 测试中…" : "🩺 测试"}
            </button>
          ) : null}
          {embedded
            ? <button className="amw-btn" onClick={onClose}>← 返回</button>
            : <button className="amw-btn" onClick={onClose} aria-label="关闭"><Ic size={12} paths={ICONS.x} /></button>}
        </div>
        {/* 🩺 测试结果行：仅独立弹窗显示，测完立即就地展示（读/编两态都在） */}
        {!embedded && probeSt ? (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap", padding: "6px 9px", border: "1px solid var(--border,#eee)", borderRadius: 8, background: "var(--bg-subtle,#fafafa)", marginBottom: 8 }}>
            {probeSt.busy ? <span style={{ color: "var(--text-subtle,#666)", fontSize: 11.5 }}>{"正在探测 " + data.id + " …（单条最长约 10 秒）"}</span> : null}
            {probeSt.done ? <ProbeOut r={probeSt.done} /> : null}
            {probeSt.error ? <span style={{ color: "#b45309", fontSize: 11.5, minWidth: 0, wordBreak: "break-all" }}>{"⚠️ " + probeSt.error}</span> : null}
          </div>
        ) : null}
        <div style={{ overflow: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="amw-mono" style={{ fontSize: 11, color: "var(--text-subtle,#666)", wordBreak: "break-all" }}>{"provider: " + data.provider + " · api: " + (data.api || "—")}</div>
          {data.crossFrom ? <div style={{ padding: "4px 8px", borderRadius: 8, background: "rgba(245,158,11,.12)", color: "#b45309", fontSize: 11 }}>{"⚠️ 本 provider 目录未收录该模型，参数借其它网关同 id 条目互证（来源：" + data.crossFrom + "）—— 价格以该网关为准"}</div> : null}
        {edit ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <div><label style={lbl}>显示名</label><input className="amw-input" style={{ width: "100%" }} value={draft.name || ""} onChange={(e) => D({ name: e.target.value })} placeholder="Display name" /></div>
              <div><label style={lbl}>上下文窗口</label><input className="amw-input" style={{ width: "100%" }} type="number" value={draft.contextWindow ?? ""} onChange={(e) => D({ contextWindow: e.target.value ? Number(e.target.value) : "" })} placeholder="128000" /></div>
              <div><label style={lbl}>最大输出 maxTokens</label><input className="amw-input" style={{ width: "100%" }} type="number" value={draft.maxTokens ?? ""} onChange={(e) => D({ maxTokens: e.target.value ? Number(e.target.value) : "" })} placeholder="16384" /></div>
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={!!draft.reasoning} onChange={(e) => D({ reasoning: e.target.checked })} />推理（reasoning）</label>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={Array.isArray(draft.input) && draft.input.includes("image")} onChange={(e) => D({ input: e.target.checked ? ["text", "image"] : ["text"] })} />图片输入</label>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center", marginLeft: "auto" }}>API 覆盖
                <select className="amw-input" style={{width: 190}} value={draft.api || ""} onChange={(e) => D({ api: e.target.value })}>
                  <option value="">（跟随 provider）</option>
                  {API_OVERRIDE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            </div>
            <div>
              <div className="amw-section" style={{margin: "0 0 4px"}}>成本（$/M tokens，四项都填才生效）</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                {["input", "output", "cacheRead", "cacheWrite"].map((k) => (
                  <div key={k}><label style={lbl}>{k}</label><input className="amw-input" style={{ width: "100%" }} type="number" step="0.01" value={cost[k] ?? ""} onChange={(e) => setCost(k, e.target.value)} placeholder="0" /></div>
                ))}
              </div>
            </div>
            <div>
              <div className="amw-section" style={{margin: "0 0 4px"}}>思考级别映射（留空=删除该级）</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 6 }}>
                {THINKING_LEVELS.map((lv) => (
                  <div key={lv}><label style={lbl}>{lv}</label><input className="amw-input" style={{ width: "100%" }} value={tlm[lv] ?? ""} onChange={(e) => setTlm(lv, e.target.value)} placeholder="—" /></div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={hasDeepseek} onChange={(e) => setDeepseek(e.target.checked)} />DeepSeek 思考兼容</label>
              <label style={{ fontSize: 12, display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={!devRoleOff} onChange={(e) => e.target.checked ? delCompatKey("supportsDeveloperRole") : setCompat({ supportsDeveloperRole: false })} />支持 developer 角色</label>
            </div>
            <div>
              <div className="amw-section" style={{margin: "0 0 4px"}}>请求头（模型级，空行忽略）</div>
              {hdrRows.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                  <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} placeholder="Header-Name" value={r.k} onChange={(e) => setHdrRows((prev) => prev.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
                  <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} placeholder="value" value={r.v} onChange={(e) => setHdrRows((prev) => prev.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
                  <button className="amw-btn" style={{ padding: "2px 8px", color: "#dc2626" }} onClick={() => setHdrRows((prev) => prev.filter((_x, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => setHdrRows((prev) => [...prev, { k: "", v: "" }])}>＋ 加一行</button>
            </div>
          </>
        ) : (() => {
          const fmtVal = (v: any): string | null => {
            if (v === undefined || v === null) return null;
            if (typeof v === "boolean") return v ? "✅ 是" : "⬜ 否";
            if (typeof v === "number") return v.toLocaleString();
            if (Array.isArray(v)) return v.join("，") || "（空）";
            if (typeof v === "object") return Object.keys(v).length ? JSON.stringify(v) : null;
            return String(v);
          };
          const FIELDS: [string, string][] = [
            ["id", "模型 id"], ["name", "名称"], ["reasoning", "推理"],
            ["contextWindow", "上下文窗口（contextWindow）"], ["maxTokens", "最大输出（maxTokens）"],
            ["input", "输入（input）"], ["cost", "成本（cost）"], ["compat", "兼容（compat）"],
            ["thinkingLevelMap", "思考级别映射"], ["samplingParams", "采样参数"], ["api", "API 覆盖"], ["baseUrl", "Base URL"],
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
            <button className="amw-btn" disabled={saving} onClick={() => { setDraft(data.params ? JSON.parse(JSON.stringify(data.params)) : null); setHdrRows(Object.entries((data.params && data.params.headers) || {}).map(([k, v]: any) => ({ k, v: String(v) }))); setErrMsg(""); setEdit(false); }}>取消</button>
            <button className="amw-btn is-ok" disabled={saving} onClick={save}>{saving ? "保存中…" : "💾 保存修改"}</button>
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
            title={r.masked ? "打码回显的行不可改名（服务端按名回填原值）——如需改名请删除后新增" : undefined}
            onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
          <input className="amw-input" style={{ flex: 1, fontFamily: "ui-monospace,monospace" }} placeholder={r.masked ? "（已存值，不改则保留）" : "value"} value={r.v}
            title={r.masked ? "打码回显：不修改则保存时保留原值" : undefined}
            onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, k: x.k, v: e.target.value, masked: false } : x))} />
          <button className="amw-btn" style={{ padding: "2px 8px", color: "#dc2626" }} title="删除此行（保存时移除该头）" onClick={() => onChange(rows.filter((_x, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="amw-btn" style={{ padding: "3px 12px", fontSize: 11, alignSelf: "flex-start" }} onClick={() => onChange([...rows, { k: "", v: "" }])}>＋ 加一行</button>
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
      <HeaderRowsEditor rows={rows} onChange={apply} hint="敏感头（Authorization/Key/Token…）打码回显：不修改则保存时保留原值；删除行=删除该头" />
      <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, marginTop: 6 }} title="清空本 provider 的全部已存请求头（保存后生效）"
        onClick={() => apply([])}>🗑 清除已存请求头</button>
    </>
  );
}

export function App({ open, onClose, initialTab, initialProvider, embedded }: { open: boolean; onClose: () => void; initialTab?: string; initialProvider?: string | null; embedded?: boolean }) {
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
      const d = await res.json();
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
    if (s === 429) return { icon: "⚡", label: "限流", color: "#dc2626" };
    if (s === 402) return { icon: "💸", label: "欠费", color: "#dc2626" };
    if (s === 401) return { icon: "🔑", label: "key 无效", color: "#dc2626" };
    if (s === 403) return { icon: "⛔", label: "无权限", color: "#dc2626" };
    if (s >= 500) return { icon: "⚠️", label: s === 502 || s === 504 ? "网络/超时" : "服务端错", color: "#d97706" };
    return { icon: "⚠️", label: s ? "HTTP " + s : "异常", color: "#d97706" };
  }, []);
  const rtTip = useCallback((rt: any) =>
    "⚡ 运行期错误观测（带外 · 代理真实流量非 2xx/3xx，非主动探测）：近 1 小时 " + rt.count1h + " 次 / 24 小时 " + rt.count24h + " 次"
    + Object.entries(rt.byStatus || {}).map(([s, b]: any) => "\n  " + rtErrInfo(Number(s)).icon + " " + rtErrInfo(Number(s)).label + " ×" + b.count24h).join("")
    + (rt.lastAt ? "\n最近 " + new Date(rt.lastAt).toLocaleString("zh-CN", { hour12: false }) + (rt.lastKey ? " · key " + rt.lastKey : "") : "")
    + "——可能仍处于故障中，建议重检确认", [rtErrInfo]);
  // 余额/欠费快照（aiti-model-check /balance，服务端 TTL 缓存；失效字段 exhausted 已内置欠费归一）
  const [bals, setBals] = useState<any>(null);
  const loadBalances = useCallback(async () => {
    try {
      const d = await (await fetch(apiUrl("/api/extensions/aiti-model-check/balance"), { cache: "no-store" })).json();
      if (d && d.ok) { const m: any = {}; for (const b of d.balances || []) m[b.provider] = b; setBals(m); }
    } catch { setBals(null); }
  }, []);
  // ── 一键体检 + 测试留存（P1-A）／ 余额健康条（P1-B）／ 设置面板（P1-C）2026-09-17 ──
  // last-test.json 的客户端缓存：provider → 最近一次向导测试结论（服务端打码）
  const [lastTestMap, setLastTestMap] = useState<any>({});
  const loadLastTest = useCallback(async () => {
    try { const d = await (await api("/last-test")).json(); if (d && d.ok) setLastTestMap(d.providers || {}); } catch {}
  }, []);
  // 一键体检：null=未开过；{running} | {running:false, res}
  const [checkupSt, setCheckupSt] = useState<any>(null);
  const runCheckup = async () => {
    if (checkupSt && checkupSt.running) return;
    setCheckupSt({ running: true });
    try {
      const d = await (await api("/checkup", { method: "POST", ...jsonBody({}) })).json();
      setCheckupSt({ running: false, res: d });
      if (d && d.ok) {
        setMsg("🩺 体检完成：" + d.pass + " 可用 · " + (d.rateLimited || 0) + " 限流 · " + (d.fail || 0) + " 失败" + (d.skip ? " · " + d.skip + " 跳过" : ""));
        loadLastTest();
      } else setMsg("❌ 体检失败：" + ((d && d.error) || ""));
    } catch (e: any) { setCheckupSt({ running: false, res: null }); setMsg("❌ 体检失败：" + (e?.message || e)); }
  };
  // 余额健康条（aiti-provider-usage 服务，服务端软依赖）：provider → {phase, entry?, capturedAt?, error?}
  const [usageMap, setUsageMap] = useState<any>({});
  const loadUsage = useCallback(async (provider: string, force?: boolean) => {
    setUsageMap((prev: any) => ({ ...prev, [provider]: { phase: "loading" } }));
    try {
      const d = await (await api("/usage?provider=" + encodeURIComponent(provider) + (force ? "&force=1" : ""))).json();
      if (!d || !d.ok) { setUsageMap((prev: any) => ({ ...prev, [provider]: { phase: "err", message: (d && d.error) || "查询失败" } })); return; }
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
      const d = await (await api("/test", { method: "POST", ...jsonBody(body) })).json();
      setQuickTest((prev: any) => ({ ...prev, [provider]: { busy: false, res: d } }));
      loadLastTest();
    } catch (e: any) { setQuickTest((prev: any) => ({ ...prev, [provider]: { busy: false, res: { pass: false, error: String(e.message || e) } } })); }
  };
  // 订阅登出（P0-B）：provider → busy
  const [logoutBusy, setLogoutBusy] = useState<string>("");
  const doOauthLogout = async (pid: string, pname: string) => {
    const okr = await uiConfirm({ title: "登出 " + (pname || pid) + "？", message: "登出后该 provider 的全部模型立即不可用（凭据从 auth.json 清除）；随时可重新登录恢复。", danger: true, confirmText: "登出" });
    if (!okr) return;
    setLogoutBusy(pid);
    try {
      const d = await (await api("/oauth-logout", { method: "POST", ...jsonBody({ provider: pid }) })).json();
      if (d && d.ok) {
        delete oauthInfoRef.current[pid];
        setSubActive(null);
        await loadSubs(); loadStatus();
        try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
        setToast({ msg: "🔓 已登出 " + (pname || pid), ok: true }); setTimeout(() => setToast(null), 4000);
      } else { setToast({ msg: "❌ 登出失败：" + ((d && d.error) || ""), ok: false }); setTimeout(() => setToast(null), 5000); }
    } catch (e: any) { setToast({ msg: "❌ 登出失败：" + (e?.message || e), ok: false }); setTimeout(() => setToast(null), 5000); }
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
      const d = await (await fetch(apiUrl("/api/extensions/aiti-model-check/probe"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(model ? { provider, model } : { provider }) })).json();
      setMsg(d.ok ? "🩺 探测完成：" + (d.probed ?? "?") + " 项，树上标记已更新" : "❌ 探测失败：" + (d.error || ""));
      await loadCheck(); await loadBalances();
    } catch (e: any) { setMsg("❌ 探测失败：" + (e?.message || e)); }
    finally { setProbeBusy((prev) => { const n = { ...prev }; delete n[key]; return n; }); }
  };
  const checkDot = (provider: string, id: string) => {
    if (probeBusy[provider + "/" + id]) return <span style={{ fontSize: 9, color: "#f59e0b", flexShrink: 0 }} title="探测中…">⏳</span>;
    const ck = chk && chk.state && chk.state.models ? chk.state.models[provider + "/" + id] : null;
    const rt = rtOf(provider, id); // 运行期错误观测（带外）：真实流量出错，未探测也可能故障中
    const rtDot = rt && rt.count24h > 0 ? (
      <span style={{ fontSize: 9, color: rt.count1h > 0 ? "#dc2626" : "#d97706", flexShrink: 0, cursor: "default" }} title={rtTip(rt)}>{rtErrInfo(rt.lastStatus).icon}</span>
    ) : null;
    const dot = !ck ? null
      : ck.lastOk ? <span className="amw-vdot" style={{ background: "#16a34a" }} title="可用（最近探测通过）" />
      : ck.rateLimited ? <span className="amw-vdot" style={{ background: "#f59e0b" }} title="限流中（429）——key 额度/速率受限" />
      : <span className="amw-vdot" style={{ background: "#ef4444" }} title="异常（非 429）——可能欠费/失效，建议重检" />;
    if (!dot && !rtDot) return null;
    return <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>{dot}{rtDot}</span>;
  };

  const loadNewInfo = useCallback(async () => {
    try { const d = await (await api("/new-models")).json(); setNewInfo(d && d.ok ? d : null); } catch {}
  }, []);

  const ackNew = useCallback(async () => {
    try {
      const d = await (await api("/new-models/ack", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
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
          const d = await (await api("/modelParams?provider=" + encodeURIComponent(name))).json();
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
    try { const d = await (await api("/status")).json(); setSt(d); return d; } catch { return null; }
  }, []);
  // 刷新运行中代理：从 models.json 重新加载某 provider（或不传=全部）的槽位配置（多 key / 聚合改动后立即生效，不重启会话）
  const doRefreshProxies = useCallback(async (provider?: string) => {
    setBusy(true);
    try {
      const d = await (await api("/refresh", { method: "POST", ...jsonBody(provider ? { provider } : {}) })).json();
      const names = ((d && d.refreshed) || []).length ? "：" + (d.refreshed || []).join(", ") : "";
      setToast({ msg: (d && d.ok ? "🔄 已刷新代理" : "❌ 刷新失败：" + ((d && d.error) || "未知错误")) + (d && d.ok ? names : ""), ok: !!(d && d.ok) });
      setTimeout(() => setToast(null), 4000);
    } catch (e: any) {
      setToast({ msg: "❌ 刷新代理失败：" + ((e && e.message) || e), ok: false });
      setTimeout(() => setToast(null), 4000);
    }
    setBusy(false);
    loadStatus();
  }, [loadStatus]);
  // 临时禁用/启用单个模型（models.json 模型条目 enabled:false 标记，不删除；组合成员同步跳过）
  const doToggleModel = useCallback(async (provider: string, model: string, enabled: boolean) => {
    setBusy(true);
    try {
      const d = await (await api("/model-enable", { method: "POST", ...jsonBody({ provider, model, enabled }) })).json();
      if (d.ok) {
        setToast({ msg: (enabled ? "▶ 已启用 " : "⏸ 已禁用 ") + provider + "/" + model + "（临时，未删除配置）", ok: true });
        try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
        // 同步草稿缓存的 enabled 标记（若有缓存），详情面板视觉即时更新
        setEditModels((prev: any) => {
          const arr = prev[provider];
          if (!Array.isArray(arr)) return prev;
          return { ...prev, [provider]: arr.map((x: any) => (typeof x === "string" ? x : x.id) === model ? { id: model, enabled: !enabled } : x) };
        });
      } else setToast({ msg: "❌ " + (d.error || "操作失败"), ok: false });
      setTimeout(() => setToast(null), 4000);
    } catch (e: any) {
      setToast({ msg: "❌ 操作失败：" + (e.message || e), ok: false });
      setTimeout(() => setToast(null), 4000);
    }
    setBusy(false);
    loadStatus();
  }, [loadStatus]);
  // 临时禁用/启用 provider（enabled:false 标记，不删除配置；立即停/建代理）
  const doToggleProvider = useCallback(async (provider: string, enabled: boolean) => {
    setBusy(true);
    try {
      const d = await (await api("/enable", { method: "POST", ...jsonBody({ provider, enabled }) })).json();
      if (d.ok) {
        setToast({ msg: (enabled ? "▶ 已启用 " : "⏸ 已禁用 ") + provider + "（临时，未删除配置）", ok: true });
        try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
      } else setToast({ msg: "❌ " + (d.error || "操作失败"), ok: false });
      setTimeout(() => setToast(null), 4000);
    } catch (e: any) {
      setToast({ msg: "❌ 操作失败：" + (e.message || e), ok: false });
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
        const d = await (await api("/probe-cap", { method: "POST", ...jsonBody({ provider, model: id }) })).json();
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
    api("/undo-status").then((r2) => r2.json()).then((d) => {
      if (d && d.ok) setUndoInfo("上次保存（" + (d.providers || []).join(", ") + "）");
    }).catch(() => {});
  }, [tab, undoInfo]);
  const undoSave = useCallback(async () => {
    try {
      const d = await (await api("/undo", { method: "POST" })).json();
      if (d.ok) { setUndoInfo(null); setMsg("↩ 已撤销上次保存（恢复 " + (d.restored || []).join(", ") + "），刷新页面生效"); loadStatus(); try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {} }
      else setMsg("撤销失败：" + (d.error || ""));
    } catch (e: any) { setMsg("撤销失败：" + (e.message || e)); }
  }, [loadStatus]);


  const enableNewModels = useCallback(async (prov: string, selIds: string[]) => {
    const p = st && st.providers.find((x: any) => x.provider === prov);
    if (!p) return;
    setNmBusy(prov);
    try {
      const merged = [...new Set([...(p.models || []), ...selIds])];
      const res = await api("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: prov, baseUrl: p.baseUrl, api: p.api, keepKey: true, models: merged }) });
      const d = await res.json();
      if (d && d.ok) {
        const da = await (await api("/new-models/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: prov, ids: selIds }) })).json();
        // 用 ack 响应（重算后的剩余待告知集）同步本地状态：已启用的模型从通知里移除，
        // 该 provider 无剩余新模型则整行消失，全部清完则横幅收起
        if (da && da.ok) setNewInfo((prev: any) => (prev ? { ...prev, total: da.total || 0, providers: da.providers || {} } : prev));
        // 清该 provider 的勾选残留：恢复「缺省=全选」语义，下次新模型到来时默认勾上
        setNmSel((prev: any) => { if (!(prov in prev)) return prev; const n = { ...prev }; delete n[prov]; return n; });
        invalidateNewModels();
        await Promise.all([loadStatus(), loadCheck()]);
        setMsg("✅ 已启用 " + prov + " 的 " + selIds.length + " 个新模型，刷新页面后生效");
      } else setMsg("❌ 启用失败：" + ((d && d.error) || ""));
    } catch (e) { setMsg("❌ 启用失败：" + e); }
    setNmBusy("");
  }, [st, loadStatus, loadCheck]);

  // 忽略单个 provider 的新模型（其他 provider 下次继续展示）：按 provider+ids 定向 ack
  const ignoreNew = useCallback(async (prov: string) => {
    const v = newInfo && newInfo.providers && newInfo.providers[prov];
    const ids = (v && v.newModels) || [];
    if (!ids.length) return;
    try {
      const d = await (await api("/new-models/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: prov, ids }) })).json();
      if (d && d.ok) {
        setNewInfo((prev: any) => (prev ? { ...prev, total: d.total || 0, providers: d.providers || {} } : prev));
        // 同上：忽略整批后清勾选残留，恢复缺省全选
        setNmSel((prev: any) => { if (!(prov in prev)) return prev; const n = { ...prev }; delete n[prov]; return n; });
        invalidateNewModels();
      }
    } catch {}
  }, [newInfo]);
  const loadCatalog = useCallback(async () => {
    try { const d = await (await api("/catalog")).json(); setCat(d); } catch {}
  }, []);
  // 手动刷新 models.dev 目录（justget 官方+镜像竞速；服务端 single-flight 去重）→ 完成后重拉目录状态
  const [catRefreshing, setCatRefreshing] = useState(false);
  const [catMsg, setCatMsg] = useState("");
  const doRefreshCatalog = useCallback(async () => {
    setCatRefreshing(true); setCatMsg("");
    try {
      const r = await (await api("/refresh-catalog", { method: "POST" })).json();
      if (!r.ok) throw new Error(r.error || "下载失败");
      await loadCatalog();
      setCatMsg("✅ 目录已刷新" + (r.providers ? " · " + r.providers + " 家 · " + Math.round((r.bytes || 0) / 1024) + "KB" : ""));
    } catch (e: any) { setCatMsg("❌ 刷新失败：" + ((e && e.message) || e)); }
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
      const d = await (await api("/provider?id=" + encodeURIComponent(id))).json();
      setBrowseDetail((prev: any) => ({ ...prev, [id]: d && d.ok ? { models: (d.provider && d.provider.models) || [] } : { error: (d && d.error) || "加载失败" } }));
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
      const d = await (await api("/modelParams?provider=" + encodeURIComponent(provider) + "&id=" + encodeURIComponent(id))).json();
      const found = d && d.models && d.models.find((m: any) => m.id === id);
      setViewParam({ provider, id, params: found || null, baseUrl: d && d.baseUrl, api: d && d.api, readOnly: !!(d && d.readOnly), crossFrom: d && d.crossFilled ? d.crossFilled[id] : undefined, loading: false, error: d && d.error, autoEdit: !!autoEdit, embedded: !!embedded });
    } catch (e: any) {
      setViewParam({ provider, id, params: null, loading: false, error: (e && e.message) || String(e), readOnly: false, autoEdit: !!autoEdit, embedded: !!embedded });
    }
  }, []);

  const loadRecommend = useCallback(async () => {
    try { const d = await (await api("/recommend")).json(); setRec(d.cards || []); } catch {}
  }, []);
  // 推荐卡片选形态（如 ark 按量 / Coding 套餐）→ 直接进入 token 流程
  const loadAffiliate = useCallback(async () => {
    try { const d = await (await api("/affiliate")).json(); setAff(d.items || {}); } catch {}
  }, []);
  const pickPlan = (pl: any) => {
    const p = pl.provider;
    setSel({ ...p, id: "plan-" + pl.id, name: p.name, cnName: p.cnName || "", baseUrl: p.baseUrl, apiType: p.apiType, doc: p.doc || "", signupUrl: p.signupUrl || "", tokenUrl: p.tokenUrl || "", register: p.register || "", models: p.models || [] });
    setToken(""); setTestRes(null); setChecked([]); setManual(""); setSavedMsg(""); setSearchDetect(null); setReverseRes(null);
    setKnown((p.models || []).map((m: any) => m.id));
    setMsg("已选「" + pl.label + "」：" + p.baseUrl + "（" + p.apiType + "）—— 填入 token 后点「测试连接」");
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
    setSel({ id: "custom", name: genName(baseUrl) || "自定义端点", cnName: "", baseUrl, apiType, doc: "", signupUrl: "", tokenUrl: "", register: "", models: [] });
    setToken(""); setTestRes(null); setChecked([]); setManual(""); setSavedMsg("");
    setKnown(det && det.models ? det.models.map((m: any) => m.id) : []);
    setProvName(genName(baseUrl) || "custom"); setProvNameTouched(false);
    setProvHeaders([]); setHeadersTouched(false); setCustomDetect(det ? { api: det.api, baseUrl: det.baseUrl, rawBaseUrl: det.rawBaseUrl, hint: det.hint } : null);
    setMsg("自定义端点：填 Base URL / API 类型 / 请求头 → 测试连接 → 选模型保存" + (det ? "（已预填探测结果，可改）" : ""));
  };
  /** 自定义面板「🔍 探测」：带当前 token/请求头重探（探测链路透传 headers）。 */
  const detectCustom = async () => {
    const u = String((sel && sel.baseUrl) || "").trim();
    if (!u) return;
    setCustomDetecting(true); setCustomDetect(null);
    try {
      const d = await (await api("/detect", { method: "POST", ...jsonBody({ baseUrl: u, apiKey: token || undefined, headers: rowsToHeaders(provHeaders) }) })).json();
      setCustomDetect(d.ok ? { api: d.api, baseUrl: d.baseUrl, rawBaseUrl: d.rawBaseUrl, hint: d.hint, providerGuess: d.providerGuess, models: d.models || null, modelCount: d.modelCount, modelsError: d.modelsError, brands: d.brands || [], openApi: d.openApi } : { error: d.hint || "未探测到可辨识端点" });
    } catch (e: any) { setCustomDetect({ error: String(e?.message || e) }); }
    setCustomDetecting(false);
  };
  const applyCustomDetect = () => {
    const d = customDetect;
    if (!d || d.error || !d.api) return;
    const base = d.baseUrl || (sel && sel.baseUrl);
    setSel((prev: any) => ({ ...prev, baseUrl: base, apiType: d.api }));
    if (d.models && d.models.length) setKnown((prev) => [...new Set([...prev, ...d.models.map((m: any) => m.id)])]);
    setMsg("已应用探测端点：" + base + "（" + d.api + "）");
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
      const d = await (await api("/search?q=" + encodeURIComponent(query))).json();
      const res = d.results || [];
      // [native] pi 内置 provider（auth 声明，46+ 家：Bedrock/Azure/Cerebras/…）并入搜索结果：
      // 仅未配置的；目录已命中同 id 的不重复（目录版带完整预填与注册说明，优先）。
      try {
        let np = nativeProv;
        if (!np) {
          const ad = await (await fetch(apiUrl("/api/auth/providers"), { cache: "no-store" })).json();
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
      if (!res.length && !ranReverse) setMsg("未命中 —— 检查拼写（或贴完整 API 地址，会自动反向匹配+探测）；也可用「＋ 自定义」手工接入");
      else if (!res.length && ranReverse) setMsg("目录未收录该地址 —— 已自动反向匹配+探测（见下方卡片，可直接用探测结果）；未识别就点最下方「🛠 自定义端点」手工接入");
    } catch (e2: any) { setMsg("搜索失败：" + (e2.message || e2)); }
    setSearching(false);
  };
  // URL 自动反向匹配 + 自动探测（并行）：目录候选 + 探测结果一起输出；无 key 时网关统一 401 无法
  // 区分真实路径 → 提示填 key 精探
  const autoReverse = async (query: string) => {
    try {
      const d = await (await api("/reverse", { method: "POST", ...jsonBody({ baseUrl: query }) })).json();
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
          setMsg("✅ 已识别为「" + (top.cnName || top.name) + "」（地址精确命中）：" + db + "（api=" + res.detect.api + "）—— 填 token 后点「测试连接」");
        } else {
          setSel({ id: "custom", name: "自定义端点（自动探测）", cnName: "", baseUrl: db, apiType: res.detect.api, doc: "", signupUrl: "", tokenUrl: "", register: "", models: [] });
          if (res.detect.models && res.detect.models.length) setKnown(res.detect.models.map((m: any) => m.id));
          setMsg(res.usedKey
            ? "✅ 已带 key 探测端点：" + db + "（api=" + res.detect.api + "）—— 填 token 后点「测试连接」即可保存"
            : "✅ 已探测端点：" + db + "（api=" + res.detect.api + "）—— ⚠️ 无 key 仅判断 api 类型，建议填 key 精探确认");
        }
      } else {
        setMsg((res.detect && res.detect.hint) ? "探测未识别端点：" + String(res.detect.hint).slice(0, 90) : "反向匹配与自动探测均未命中 —— 检查地址（可去掉 /v1 /v2 再试），或点最下方「🛠 自定义端点」手工接入");
      }
    } catch (e2: any) { setMsg("自动反向匹配失败：" + (e2.message || e2)); }
  };
  // 用户填 key 后重新反向匹配+探测（精准定位真实路径，如火山 api/plan → api/plan/v3）
  const doReverseWithKey = async () => {
    const key = probeKey.trim();
    if (!key || !reverseRes) return;
    setReprobing(true); setMsg("");
    try {
      const d = await (await api("/reverse", { method: "POST", ...jsonBody({ baseUrl: reverseRes.url, apiKey: key }) })).json();
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
          setMsg("✅ 带 key 探测确认：「" + (top.cnName || top.name) + "」· " + db + "（" + res.detect.api + "）—— 继续测试/保存即可");
        } else {
          setSel((prev: any) => ({ ...(prev || {}), id: "custom", name: "自定义端点（带 key 探测）", cnName: "", baseUrl: db, apiType: res.detect.api, doc: "", signupUrl: "", tokenUrl: "", register: "", models: [] }));
          if (res.detect.models && res.detect.models.length) setKnown(res.detect.models.map((m: any) => m.id));
          setMsg("✅ 带 key 探测确认端点：" + db + "（" + res.detect.api + "）—— 继续填 token / 测试即可");
        }
      } else {
        setMsg((res.detect && res.detect.hint) ? "带 key 探测未识别：" + String(res.detect.hint).slice(0, 90) : "带 key 探测仍未命中 —— 检查 key 和地址，或点最下方「🛠 自定义端点」手工接入");
      }
    } catch (e2: any) { setMsg("带 key 探测失败：" + (e2.message || e2)); }
    setReprobing(false);
  };
  // 应用自动探测结果（reverseRes）到 sel
  const applyReverseDetect = () => {
    const cd = reverseRes && reverseRes.detect;
    if (!cd || !cd.ok || !cd.api) return;
    const db = cd.suggestedBaseUrl || cd.baseUrl;
    setSel((prev: any) => ({ ...prev, baseUrl: db, apiType: cd.api }));
    if (cd.models && cd.models.length) setKnown(cd.models.map((m: any) => m.id));
    setMsg("已应用探测端点：" + db + "（" + cd.api + "）—— 填 token 测试");
  };
  const pickProvider = (p: any) => {
    if (p.native) {
      // pi 内置 provider：baseUrl 由用户按官方文档填（Bedrock/Azure 等端点形态特殊），
      // api 默认 openai-completions（可在详情改）；key 保存后模型清单由运行时自动加载。
      setSel({ id: p.id, name: p.name, cnName: "", baseUrl: "", apiType: "openai-completions", doc: p.doc || "", signupUrl: "", tokenUrl: "", register: "", models: [], native: true, modelCount: p.modelCount });
      setToken(""); setTestRes(null); setChecked([]); setManual(""); setSavedMsg(""); setSearchDetect(null); setDiscMsg("");
      setMsg("pi 内置 provider —— 填 Base URL（见官方文档）与 API Key 后保存，模型清单由运行时加载");
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
      const d = await (await api("/detect", { method: "POST", ...jsonBody({ baseUrl: u, apiKey: token || undefined }) })).json();
      setSearchDetect(d.ok ? { api: d.api, baseUrl: d.baseUrl, suggestedBaseUrl: d.suggestedBaseUrl, hint: d.hint, providerGuess: d.providerGuess, models: d.models || null, modelCount: d.modelCount, modelsError: d.modelsError, brands: d.brands || [], openApi: d.openApi } : { error: d.hint || "未探测到可辨识端点" });
    } catch (e2: any) { setSearchDetect({ error: String(e2.message || e2) }); }
  };
  const applySearchDetect = () => {
    const cd = searchDetect;
    if (!cd || cd.error || !cd.api) return;
    const db = cd.suggestedBaseUrl || cd.baseUrl;
    setSel((prev: any) => ({ ...prev, baseUrl: db, apiType: cd.api }));
    if (cd.models && cd.models.length) setKnown(cd.models.map((m: any) => m.id));
    setMsg("已应用探测端点：" + db + "（" + cd.api + "）");
  };
  // 拉厂商 /models 实时列表合并进可选集（silent=true：测试连接通过后自动拉，不弹反馈）
  const doDiscover = async (baseUrl: string, apiType: string, key: string, silent?: boolean, headers?: Record<string, string>) => {
    if (!silent) { setDiscBusy(true); setDiscMsg(""); }
    try {
      const r = await api("/discover", { method: "POST", ...jsonBody({ baseUrl, api: apiType, apiKey: key, headers }) });
      const d = await r.json();
      if (d.ok && d.models && d.models.length) {
        const ids = (sel && sel.models || []).map((m: any) => m.id);
        const before = known.length;
        const fresh = d.models.map((m: any) => m.id).filter((id: string) => !ids.includes(id));
        setKnown((prev) => { const all = [...ids, ...d.models.map((m: any) => m.id)]; return [...new Set(all)]; });
        if (!silent) setDiscMsg("✅ 已拉取 /models " + d.models.length + " 个（新增 " + fresh.length + " · 原 " + before + " 个），目录旧模型已补全");
      } else if (!silent) setDiscMsg("❌ 拉取失败：" + (d.error || "未返回模型（检查 token 或地址）"));
      return d;
    } catch (e: any) { if (!silent) setDiscMsg("❌ 拉取失败：" + (e.message || e)); return null; }
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
        setDiscMsg("✅ 已拉取 /models " + last.models.length + " 个（用第 " + (i + 1) + " 把凭据" + (creds.length > 1 ? " · 共 " + creds.length + " 把" : "") + "），目录旧模型已补全");
        setDiscBusy(false);
        return;
      }
    }
    setDiscMsg("❌ 拉取失败：" + ((last && last.error) || "全部凭据均未拉到模型") + (creds.length > 1 ? "（已依次试 " + creds.length + " 把 key）" : "（检查 key 或地址）"));
    setDiscBusy(false);
  };
  const doTest = async (baseUrl: string, apiType: string, key: string, model?: string | null, headers?: Record<string, string>) => {
    setTesting(true); setTestRes(null); setSavedMsg("");
    try {
      const r = await api("/test", { method: "POST", ...jsonBody({ baseUrl, api: apiType, apiKey: key, model: model || null, headers }) });
      const d = await r.json();
      // 通过即尝试拉模型列表：无已知模型（model=null）时也必须拉，否则用户只能一个个手动输入。
      // （此前仅当 model 非空才 discover —— URL 探测无 key 时 known 为空 → model=null → 模型永远不加载）
      if (d.pass && d.status !== 429) doDiscover(baseUrl, apiType, key, true, headers);
      setTestRes(d);
    } catch (e: any) { setTestRes({ pass: false, detail: "请求失败：" + (e.message || e) }); }
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
      const d = await (await api("/test", { method: "POST", ...jsonBody({ baseUrl, api: apiType, keys: rows, headers }) })).json();
      setTestRes(d);
      const okRow = (d.results || []).map((x: any, i: number) => ({ ...x, raw: rows[i] && rows[i].key })).find((x: any) => x.pass);
      if (okRow) doDiscover(baseUrl, apiType, okRow.raw, true, headers);
    } catch (e: any) { setTestRes({ pass: false, detail: "请求失败：" + (e.message || e) }); }
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
      const d = await r.json();
      if (d.ok) {
        const fillTxt = summarizeFills(d.fills);
        const miss = Array.isArray(d.missingParams) ? d.missingParams.filter((m: any) => m && m.id) : [];
        const okMsg = "✅ 已保存 " + d.provider + " · " + d.modelCount + " 个模型" + (fillTxt ? " · " + fillTxt : "") + (miss.length ? " · ⚠️ " + miss.length + " 个模型缺参数" : "");
        setSavedMsg(okMsg);
        setToast({ msg: okMsg + " → 已写入 models.json，立即生效", ok: true });
        setTimeout(() => setToast(null), 4000);
        setUndoInfo(d.undoable ? ("已保存「" + d.provider + "」") : null);
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
        const err = "❌ 保存失败：" + (d.error || "未知错误");
        setSavedMsg(err);
        setToast({ msg: err, ok: false });
      }
    } catch (e: any) {
      const err = "❌ 保存失败：" + (e.message || e);
      setSavedMsg(err);
      setToast({ msg: err, ok: false });
    }
    setSaving(false);
  };

  const doDelete = async (provider: string) => {
    if (!(await uiConfirm({ message: "删除 provider " + provider + "？", danger: true }))) return;
    setBusy(true); setMsg("");
    try {
      const d = await (await api("/delete", { method: "POST", ...jsonBody({ provider }) })).json();
      setMsg(d.ok ? "已删除 " + provider : "失败：" + (d.error || ""));
      if (d.ok && selNode && selNode.provider === provider) setSelNode(null); // 双栏：删中的 provider 清空选中
      loadStatus();
      loadNewInfo();
      try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
    } catch (e: any) { setMsg("删除失败：" + (e.message || e)); }
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
      const d = await (await api("/save", { method: "POST", ...jsonBody({ provider: newName, renameFrom: provider, baseUrl, api: apiType, keepKey: !newTok, models, replaceModels: replaced, ...(hdrDraft ? { headers: hdrDraft, ...(Array.isArray(hdrMasked) ? { maskedHeaders: hdrMasked } : {}) } : {}), ...(listExtras.length ? { listExtras } : {}), ...(newTok ? { apiKey: newTok } : {}) }) })).json();
      setMsg(d.ok ? "已保存 " + newName + "（" + models.length + " 模型" + (newTok ? " · token 已更新" : "") + (newName !== provider ? " · 已从 " + provider + " 改名" : "") + (summarizeFills(d.fills) ? " · " + summarizeFills(d.fills) : "") + "）" : "失败：" + (d.error || ""));
      if (d.ok) {
        setUndoInfo("已编辑「" + newName + "」");
        const ids = models.map((m: any) => m.id);
        if (replaced && ids.length) void runProbeCaps(newName, ids); // 新勾选的模型实测上限
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
    } catch (e: any) { setMsg("保存失败：" + (e.message || e)); }
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
      const d = await (await api("/discoverStored", { method: "POST", ...jsonBody({ provider, apiKey: (editTok[provider] || "").trim() || undefined, headers: (editFields[provider] || {}).headers, maskedHeaders: (editFields[provider] || {}).headersMasked }) })).json();
      if (d.ok && d.models && d.models.length) {
        const cur = ((editModels[provider] ?? p.models) || []).map((m: any) => (typeof m === "string" ? m : m.id));
        const available = d.models.map((m: any) => m.id);
        // 新模型检测：相对前日基线新增且未配置的模型 → 自动预勾选（用户点保存即直接启用）
        const newOnes = Array.isArray(d.newModels) ? d.newModels : [];
        const curChecked = [...new Set([...cur.filter((id: string) => available.includes(id)), ...newOnes])];
        setEditAvail((prev: any) => ({ ...prev, [provider]: { models: available, objs: d.models, checked: curChecked, newModels: newOnes } }));
        setAvailFilter((prev: any) => ({ ...prev, [provider]: "" }));
        setMsg(newOnes.length
          ? "✅ 已拉取 " + available.length + " 个可选模型 —— ✨ 发现 " + newOnes.length + " 个新模型，已自动勾选（带「新」标），点保存即可启用"
          : "✅ 已拉取 " + available.length + " 个可选模型（已保留原勾选 " + curChecked.length + " 个）—— 勾选后点保存");
      } else setMsg("刷新模型失败：" + (d.error || ""));
    } catch (e: any) { setMsg("刷新模型失败：" + (e.message || e)); }
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
        if (info && info.s === "err" && CLEANUP_HARD_FAIL_KINDS.includes(info.kind)) remove.push({ id, label: info.label || "异常" });
        else if (info && info.s === "err") soft.push({ id, label: info.label || "异常" }); // 暂时性错误（5xx/网络/超时）→ 保留但提示
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
      ? "🛠 一键整理就绪：已按检查结果取消勾选 " + nRemove + " 个硬性异常模型（key 不对/欠费/不存在等）——核对后点「保存」生效；限流/未测/暂时性错误默认保留"
      : "🛠 一键整理：没有发现硬性异常模型（限流/未测/暂时性错误均保留）——如需调整可逐家「编辑」");
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
    setToast({ msg: "✅ 一键整理完成：" + targets.length + " 个 provider 已保存，移除 " + removed + " 个异常模型（代理已刷新，立即生效）", ok: true });
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
    setMsg("已取消一键整理（未保存任何改动）");
  };
  // 独立路径消费：检查面板 deposit（services 信箱 / window.__aitiModelWizardCleanupEdit 双轨）+ openTab("status")
  // → App 就绪（st 加载完）后应用。（内嵌模式不走信箱：检查 tab 经 onCleanupEdit 回调直呼 applyCleanupEdit）
  useEffect(() => {
    if (!open || !st) return;
    const g = cleanupEditMailbox ?? window.__aitiModelWizardCleanupEdit;
    if (!g) return;
    cleanupEditMailbox = null;
    delete window.__aitiModelWizardCleanupEdit;
    try { applyCleanupEdit(g); } catch (e) { console.error("[aiti-model-wizard] 一键整理应用失败", e); }
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
      const d = await (await api("/test", { method: "POST", ...jsonBody({ baseUrl, api: apiType, provider: prov, allKeys: true, headers: (editFields[prov] || {}).headers, maskedHeaders: (editFields[prov] || {}).headersMasked }) })).json();
      if (!d.ok && !d.results) setKeyTests((prev: any) => ({ ...prev, [prov]: { busy: false, error: d.error || d.detail || "测试失败" } }));
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
      const d = await (await api("/keys?provider=" + encodeURIComponent(provider))).json();
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
      const d = await (await api("/keys", { method: "POST", ...jsonBody({ provider, action: "add", name, key, rpm: e.newRpm, minIntervalMs: mivNorm(e.newMiv) }) })).json();
      if (d && d.ok) {
        await loadEditKeys(provider);
        setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), newName: "", newKey: "", newRpm: "", newMiv: "", busy: false } }));
        loadStatus();
      } else { setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (d && d.error) || "add 失败" } })); }
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
      const d = await (await api("/keys", { method: "POST", ...jsonBody({ provider, action: "update", name: k.name, ...(newName && newName !== k.name ? { newName } : {}), newKey, rpm, minIntervalMs: miv !== undefined ? mivNorm(miv) : undefined }) })).json();
      if (d && d.ok) {
        await loadEditKeys(provider);
        const rest = { ...((editKeys[provider] || {}).rows || {}) };
        delete rest[k.name];
        setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), rows: rest, busy: false } }));
        loadStatus();
      } else setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (d && d.error) || "保存失败" } }));
    } catch (e2: any) { setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (e2 && e2.message) || String(e2) } })); }
  };
  const editKeyRemove = async (provider: string, name: string) => {
    setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: true, error: "" } }));
    try {
      const d = await (await api("/keys", { method: "POST", ...jsonBody({ provider, action: "remove", name }) })).json();
      if (d && d.ok) { await loadEditKeys(provider); setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false } })); loadStatus(); }
      else setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (d && d.error) || "删除失败" } }));
    } catch (e: any) { setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (e && e.message) || String(e) } })); }
  };
  // 单把 key 临时禁用/启用（enabled:false 标记，不删除；不参与轮转，随时可切回）
  const editKeyToggle = async (provider: string, name: string, enabled: boolean) => {
    setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: true, error: "" } }));
    try {
      const d = await (await api("/keys", { method: "POST", ...jsonBody({ provider, action: "update", name, enabled }) })).json();
      if (d && d.ok) { await loadEditKeys(provider); setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false } })); loadStatus(); }
      else setEditKeys((prev: any) => ({ ...prev, [provider]: { ...(prev[provider] || {}), busy: false, error: (d && d.error) || "切换失败" } }));
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
        const d = await (await api("/refresh", { method: "POST", ...jsonBody({ provider: p.provider }) })).json();
        const names = ((d && d.refreshed) || []).length ? "（" + (d.refreshed || []).join(", ") + "）" : "";
        setE({ busy: false, refreshOut: d && d.ok ? "🔄 列表已刷新 · 代理已刷新" + names : "⚠️ 列表已刷新，代理刷新失败：" + ((d && d.error) || "未知错误") });
      } catch (e2: any) {
        setE({ busy: false, refreshOut: "⚠️ 列表已刷新，代理刷新失败：" + ((e2 && e2.message) || e2) });
      }
      loadStatus();
    };
    return (
      <div style={{ marginTop: 10, borderTop: "1px solid var(--border,#eee)", paddingTop: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6, padding: "7px 10px", border: "1px solid rgba(99,102,241,.4)", borderRadius: 9, background: "rgba(99,102,241,.05)", flexWrap: "wrap" }}>
          <button className="amw-btn" style={{ padding: "3px 11px", fontSize: 11, fontWeight: 650 }} onClick={() => { if (!open) loadEditKeys(p.provider); setE({ show: !open }); }}>
            {open ? "▾ 收起" : "🔑 多 Key 轮转" + (list.length ? "（" + list.length + " 把）" : "")}
          </button>
          <button className="amw-btn" style={{ padding: "3px 11px", fontSize: 11 }} disabled={e.busy} title="① 重新读取 models.json 的 key 列表（外部改动立即可见）② 刷新运行中代理（立即生效）"
            onClick={doKeysRefresh}>
            {e.busy ? "刷新中…" : (<><Ic size={11} paths={ICONS.refresh} /> 刷新</>)}
          </button>
          <span style={{ color: "var(--text-subtle,#666)", fontSize: 10.5 }}>多个 key 自动轮转分摊限流 · 每把可设 rpm 上限 + 等间距间隔（留空=auto 按 rpm 折算 · 0=突发滑窗 · 数字=毫秒）· 刷新 = 重读列表 + 刷新代理</span>
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
                  <input className="amw-input" disabled={k.enabled === false} style={{flex: small ? "1 1 40%" : "0 0 88px", minWidth: small ? 0 : 88, fontFamily: "ui-monospace,monospace", ...(k.enabled === false ? { color: "var(--text-subtle,#999)" } : {})}} title="key 名称（轮转/识别用）" value={row.name ?? k.name} onChange={(ev) => rowSet({ name: ev.target.value })} />
                  <input className="amw-input" disabled={k.enabled === false} style={{flex: small ? "1 1 50%" : "1 1 auto", minWidth: small ? 0 : 120, fontFamily: "ui-monospace,monospace", ...(k.enabled === false ? { color: "var(--text-subtle,#999)" } : {})}} type="password" placeholder={k.key ? "当前 " + k.key + "（留空=保留）" : "API key"} value={row.key || ""} onChange={(ev) => rowSet({ key: ev.target.value })} />
                  <input className="amw-input" disabled={k.enabled === false} style={{width: 56, flexShrink: 0}} type="number" min={1} placeholder="rpm" title="每分钟请求上限（可选）" value={row.rpm !== undefined ? row.rpm : (k.rpm || "")} onChange={(ev) => rowSet({ rpm: ev.target.value })} />
                  <input className="amw-input" disabled={k.enabled === false} style={{width: 72, flexShrink: 0}} placeholder="间隔ms·0=突发" title="等间距节流（默认匀速）三种填法：\n① 留空 = auto：按 rpm 自动折算（60000÷rpm，rpm30→每2s一个），默认\n② 0 = 关闭匀速：仅 rpm 滑动窗口（突发模式，允许瞬间打满配额）\n③ 数字 = 固定间隔毫秒（如 2000 = 每2s一个）\n与 rpm 同时生效，取最大等待" value={row.minIntervalMs !== undefined ? row.minIntervalMs : (k.minIntervalMs ?? "")} onChange={(ev) => rowSet({ minIntervalMs: ev.target.value })} />
                  <button className="amw-btn" style={{ padding: "2px 8px", flexShrink: 0 }} title={dirty ? "保存修改（改名/换 key/改 rpm/改间隔，立即写入 models.json）" : "无改动"} disabled={e.busy || !dirty} onClick={() => editKeySave(p.provider, k)}>💾</button>
                  <button className="amw-btn" style={{ padding: "2px 8px", flexShrink: 0, ...(k.enabled === false ? { color: "#b45309", borderColor: "#f59e0b", background: "rgba(245,158,11,.12)" } : {}) }}
                    title={k.enabled === false ? "临时禁用中（不参与轮转，配置未删除）——点击重新启用" : "临时禁用此 key（不参与轮转，配置未删除，随时可一键启用）"}
                    disabled={e.busy} onClick={() => editKeyToggle(p.provider, k.name, k.enabled === false)}>
                    {k.enabled === false ? "▶" : "⏸"}
                  </button>
                  <button className="amw-btn" style={{ padding: "2px 8px", flexShrink: 0 }} title="删除此 key（立即写入 models.json）" disabled={e.busy} onClick={() => editKeyRemove(p.provider, k.name)}>✕</button>
                </div>
              );
            }) : e.busy ? <div style={{ color: "var(--text-subtle,#999)", fontSize: 11 }}>加载中…</div> : <div style={{ color: "var(--text-subtle,#999)", fontSize: 11 }}>（还没有多 key —— 下方添加）</div>}
            <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4, flexWrap: small ? "wrap" : "nowrap" }}>
              <input className="amw-input" style={{flex: small ? "1 1 40%" : "0 0 88px", minWidth: small ? 0 : 88, fontFamily: "ui-monospace,monospace"}} placeholder="名（默认自动 key-N）" value={e.newName || ""} onChange={(ev) => setE({ newName: ev.target.value })} />
              <input className="amw-input" style={{flex: small ? "1 1 50%" : "1 1 auto", minWidth: small ? 0 : 120, fontFamily: "ui-monospace,monospace"}} type="password" placeholder="新 API key（sk-…）" value={e.newKey || ""} onChange={(ev) => setE({ newKey: ev.target.value })} />
              <input className="amw-input" style={{width: 56, flexShrink: 0}} type="number" min={1} placeholder="rpm" value={e.newRpm || ""} onChange={(ev) => setE({ newRpm: ev.target.value })} />
              <input className="amw-input" style={{width: 72, flexShrink: 0}} placeholder="间隔ms·0=突发" title="等间距节流：留空 = auto（按 rpm 折算，默认匀速）；0 = 突发滑窗；数字 = 固定毫秒" value={e.newMiv || ""} onChange={(ev) => setE({ newMiv: ev.target.value })} />
              <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "4px 10px", flexShrink: 0 }} disabled={e.busy || !((e.newKey || "").trim())} onClick={() => editKeyAdd(p.provider)}>＋ 添加</button>
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
      ? <span title="实测验证 maxTokens 上限…" style={{ color: "#f59e0b" }}>⏳</span>
      : cp.corrected ? <span title={cp.detail || "元数据虚报，已自动下调并回写"} style={{ color: "#10b981", fontWeight: 700 }}>✓↓</span>
      : cp.error || (!cp.skipped && !cp.corrected) ? <span title={cp.detail || cp.error || "实测失败"} style={{ color: "#ef4444" }}>!</span>
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
            订阅登录型 provider：凭据由登录流程管理（auth.json、自动刷新），不走 models.json、无 key 可改 —— 下方可直接查看登录态 / 账号 / 额度，需要时重新登录 / 换号。
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
        <div className="amw-section" style={{margin: "0 0 6px"}}>名称（改后即重命名 provider）</div>
        <input className="amw-input" style={{width: "100%", marginBottom: 10, fontWeight: 600}} value={eff("name", p.provider)} onChange={(e) => setField("name", e.target.value)} placeholder={p.provider} />
        {/* ── 模型（刷新可选 / 增删）── */}
        <div className="amw-section" style={{margin: "0 0 6px"}}>{"模型（" + (avail ? availChecked.length + " 已选 / " + avail.models.length + " 可选" : draft.length + " 个") + "）"}</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "3px 10px" }} onClick={() => refreshEditModels(p.provider, p)} disabled={!!refreshBusy[p.provider]}>
            {refreshBusy[p.provider] ? "刷新中…" : (<><Ic size={12} paths={ICONS.refresh} />{" "}刷新可选模型</>)}
          </button>
          {avail ? <button className="amw-btn" onClick={() => setEditAvail((prev: any) => { const { [p.provider]: _drop, ...rest } = prev; return rest; })}>收起列表</button> : null}
          {avail ? <input className="amw-input" style={{flex: 1, minWidth: 140}} placeholder="🔍 过滤可选模型" value={availFilter[p.provider] || ""} onChange={(e) => setAvailFilter((prev: any) => ({ ...prev, [p.provider]: e.target.value }))} /> : null}
          {avail ? <button className="amw-btn" style={{ padding: "2px 10px" }} title="勾选当前筛选出的全部（保留筛选外已选）" onClick={() => setEditAvail((prev: any) => ({ ...prev, [p.provider]: { ...prev[p.provider], checked: [...new Set([...availChecked, ...availIds])] } }))}>全选</button> : null}
          {avail ? <button className="amw-btn" style={{ padding: "2px 10px" }} title="当前筛选范围内反选" onClick={() => setEditAvail((prev: any) => {
            const av = prev[p.provider];
            const inv = availIds.filter((id) => !av.checked.includes(id));
            return { ...prev, [p.provider]: { ...av, checked: [...av.checked.filter((id: string) => !availIds.includes(id)), ...inv] } };
          })}>反选</button> : null}
          {avail ? <button className="amw-btn" style={{ padding: "2px 10px" }} title="取消当前筛选范围内的勾选（筛选外不受影响）" onClick={() => setEditAvail((prev: any) => ({ ...prev, [p.provider]: { ...prev[p.provider], checked: prev[p.provider].checked.filter((id: string) => !availIds.includes(id)) } }))}>清空</button> : null}
        </div>
        {avail ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, maxHeight: 190, overflow: "auto", border: "1px solid var(--border,#eee)", borderRadius: 8, padding: 6 }}>
            {availIds.length ? availIds.map((id) => {
              const nmd = (nmMeta[p.provider] || {})[id];
              const isNew = availNew.includes(id);
              const mtags = isNew && nmd ? [nmd.contextWindow ? fmtTok(nmd.contextWindow) + " ctx" : "", nmd.reasoning ? "推理" : ""].filter(Boolean) : [];
              return (
                <label key={id} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 8, border: isNew ? "1px solid rgba(34,197,94,.5)" : "1px solid var(--border,#e0e0e0)", cursor: "pointer", background: availChecked.includes(id) ? "rgba(37,99,235,.12)" : (isNew ? "rgba(34,197,94,.07)" : "var(--bg,#fff)") }}>
                  <input type="checkbox" checked={availChecked.includes(id)} onChange={() => toggleEditAvail(p.provider, id)} style={{ margin: 0 }} />
                  <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 11 }}>{id}</span>
                  <EyeBtn title={"查看 " + id + " 参数（目录反填，未配置也可看）"} onClick={() => viewModelParams(p.provider, id)} />
                  {capBadge(p.provider, id)}
                  {mtags.length ? <span style={{ color: "#6b7280", fontSize: 9 }}>{mtags.join(" · ")}</span> : null}
                  {isNew ? <span style={{ padding: "0 5px", borderRadius: 6, background: "rgba(34,197,94,.16)", color: "#15803d", fontSize: 9, fontWeight: 700 }}>新</span> : null}
                </label>
              );
            }) : <span style={{ color: "var(--text-subtle,#999)", fontSize: 11 }}>（无匹配）</span>}
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, maxHeight: 150, overflow: "auto" }}>
              {draft.length ? draft.map((id: any) => {
                const mid = typeof id === "string" ? id : (id && id.id);
                const mEn = !(typeof id === "object" && id && id.enabled === false);
                return (
                <span key={mid} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 8, border: mEn ? "1px solid var(--border,#e0e0e0)" : "1px dashed #f59e0b", background: mEn ? "var(--bg-subtle,#f5f5f5)" : "rgba(245,158,11,.10)", fontSize: 11, fontFamily: "ui-monospace,monospace", ...(mEn ? {} : { color: "#b45309" }) }}>
                  {mid}
                  {!mEn ? <span style={{ fontSize: 9, color: "#b45309", fontWeight: 700 }}>⏸ 禁用</span> : null}
                  {capBadge(p.provider, mid)}
                  <EyeBtn title="查看/编辑完整参数（窗口/上下文/成本等）" onClick={() => viewModelParams(p.provider, mid)} />
                  <button style={{ border: "none", background: "none", cursor: "pointer", color: "#d97706", padding: 0, fontSize: 12, lineHeight: 1 }}
                    title={mEn ? "临时禁用此模型（从可用列表隐藏、组合成员跳过，不删除配置）" : "重新启用此模型（恢复可见）"}
                    onClick={() => doToggleModel(p.provider, mid, !mEn)}>{mEn ? "⏸" : "▶"}</button>
                  <button style={{ border: "none", background: "none", cursor: "pointer", color: "#dc2626", padding: 0, fontSize: 12, lineHeight: 1 }} onClick={() => removeEditModel(p.provider, mid, p.models)} aria-label={"移除 " + mid}>✕</button>
                </span>
                );
              }) : <span style={{ color: "var(--text-subtle,#999)", fontSize: 11 }}>（无模型）</span>}
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} placeholder="添加模型 id（逗号分隔，如 glm-4.7,kimi-k3）" value={newModel} onChange={(e) => setNewModel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addEditModel(p.provider, p.models); }} />
              <button className="amw-btn" onClick={() => addEditModel(p.provider, p.models)}>＋ 添加</button>
            </div>
          </div>
        )}
        {/* ── 连接配置 ── */}
        <div className="amw-section" style={{margin: "0 0 6px"}}>连接配置</div>
        <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>Base URL</label>
        <input className="amw-input" style={{width: "100%", marginBottom: 6, fontFamily: "ui-monospace,monospace"}} placeholder="https://api.example.com/v1" value={eff("baseUrl", p.baseUrl || "")} onChange={(e) => setField("baseUrl", e.target.value)} />
        <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>API 类型</label>
        <select className="amw-input" style={{width: "100%", marginBottom: 6}} value={eff("api", p.api || "openai-completions")} onChange={(e) => setField("api", e.target.value)}>
          {apiOpts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>API Key（留空=保留原 key；支持字面量 / 环境变量名 / <code className="amw-mono">!命令</code>）</label>
        <input className="amw-input" style={{width: "100%", fontFamily: "ui-monospace,monospace"}} type="password" placeholder={p.apiKeyMasked ? "保留原 key（" + p.apiKeyMasked + "）" : "粘贴新 key / ENV_NAME / !cmd"} value={editTok[p.provider] || ""} onChange={(e) => setEditTok((prev: any) => ({ ...prev, [p.provider]: e.target.value }))} />
        <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", margin: "8px 0 3px" }}>请求头（provider 级；不改则保留已存）</label>
        <EditHeadersEditor key={p.provider} initialHeaders={eff("headers", p.headers)} initialMasked={eff("headersMasked", p.maskedHeaders)}
          onChange={(headers, maskedHeaders) => setEditFields((prev: any) => ({ ...prev, [p.provider]: { ...(prev[p.provider] || {}), headers, headersMasked } }))} />
        {/* ── 连接测试（用已配置的全部 key，逐个测）── */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "3px 10px" }} disabled={!!(keyTests[p.provider] && keyTests[p.provider].busy)} onClick={() => doTestStored(p)}>
            {(keyTests[p.provider] && keyTests[p.provider].busy) ? "测试中…" : (<>🔌 测试连接（全部已存 key）</>)}
          </button>
          <span style={{ color: "var(--text-subtle,#666)", fontSize: 10 }}>逐个串行测 models.json 已配的多把 key（非只第一个），每把单独出结果</span>
        </div>
        {keyTests[p.provider] && keyTests[p.provider].error ? <div className="amw-note is-err" style={{marginTop: 4}}>❌ {keyTests[p.provider].error}</div> : null}
        {keyTests[p.provider] && keyTests[p.provider].results ? testBadge({ multiKey: true, results: keyTests[p.provider].results, passCount: keyTests[p.provider].passCount, total: keyTests[p.provider].total }) : null}
        {renderEditKeys(p)}
        {/* ── 操作 ── */}
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <button className="amw-btn is-ok" onClick={() => doSaveEdit(p.provider, p)} disabled={busy}>💾 保存（模型 + 配置）</button>
          <button className="amw-btn" onClick={() => { setEditFields((prev: any) => { const { [p.provider]: _drop, ...rest } = prev; return rest; }); setEditAvail((prev: any) => { const { [p.provider]: _drop2, ...rest } = prev; return rest; }); setEditModels((prev: any) => { const { [p.provider]: _drop3, ...rest } = prev; return rest; }); }}>取消</button>
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
    return (
      <div style={{ border: "1px solid var(--border,#eee)", borderRadius: 10, padding: "10px 12px", background: "var(--bg-subtle,#fafafa)", marginBottom: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {p.baseUrl ? <span title={p.baseUrl + " · " + p.apiType} className="amw-mono" style={{ padding: "3px 10px", borderRadius: 999, background: "var(--bg,#fff)", border: "1px solid var(--border,#e5e5e5)", fontSize: 11, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.baseUrl}<span style={{ color: "var(--text-subtle,#999)" }}>{" · " + p.apiType}</span></span> : null}
          {(p.models && p.models.length) ? <span style={{ fontSize: 11, color: "var(--text-subtle,#666)", flexShrink: 0 }}>{"目录模型 " + p.models.length + " 个"}</span> : null}
        </div>
        {hasLinks ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: p.baseUrl ? 8 : 0 }}>
            {p.doc ? infoLink(ICONS.file, "官网文档", p.doc) : null}
            {p.signupUrl ? infoLink(ICONS.pencil, "注册账号", p.signupUrl) : null}
            {p.tokenUrl ? infoLink(ICONS.key, "获取 Token", p.tokenUrl) : null}
          </div>
        ) : null}
        {p.register ? <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.55, color: "var(--text-subtle,#666)" }}>{p.register}</div> : null}
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
        const d = await (await api("/oauth-info?id=" + encodeURIComponent(id))).json();
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
    es.onerror = () => { es.close(); oauthEsRef.current = null; setOauthLs((prev: any) => (prev.phase === "success" ? prev : { phase: "error", message: "连接中断" })); };
  }, [checkOauthStatus]);
  useEffect(() => () => { oauthEsRef.current?.close(); }, []);

  const testBadge = (t: any) => {
    if (!t) return null;
    if (t.multiKey && Array.isArray(t.results)) {
      const all = t.passCount === t.total;
      return (
        <div className={"amw-note " + (all ? "is-ok" : t.passCount > 0 ? "is-warn" : "is-err")} style={{ marginTop: 4 }}>
          {(all ? "✅" : t.passCount > 0 ? "🟡" : "❌") + " 分 key 测试：" + t.passCount + "/" + t.total + " 可用"}
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
      ? <div className={"amw-note " + (t.rateLimited ? "is-warn" : "is-ok")}>{t.rateLimited ? "🟡 通过（429 限流）——key/端点正确，稍后重试即可 · " + t.detail : "✅ 通过（HTTP " + t.status + " · " + t.detail + " · " + (t.latencyMs != null ? t.latencyMs + "ms" : "") + "）"}</div>
      : <div className="amw-note is-err">{"❌ 失败（HTTP " + (t.status || "net") + "）· " + (t.detail || t.error || "")}</div>;
  };

  /** 订阅登录型（authType=oauth）面板：替代 token 输入流 */
  // ── 订阅服务 tab：列出 pi 运行时全部 OAuth 登录型提供商，一键登录/查看状态 ──
  const OAUTH_META: Record<string, string> = {
    "anthropic": "Claude Pro/Max 订阅 · claude.ai 账号授权",
    "openai-codex": "ChatGPT Plus/Pro 订阅 · OpenAI 官方背书第三方接入",
    "github-copilot": "GitHub Copilot 订阅 · github.com 授权",
    "xai": "xAI Grok/X Premium 订阅",
    "openrouter": "OpenRouter 账号授权（PKCE，充值计费）",
    "radius": "Radius 动态网关",
    "kimi-coding": "Kimi Code 订阅 · auth.kimi.com 设备码登录",
    "qoder": "Qoder 国际订阅 · 浏览器设备码 / PAT。Free 无 credits，付费额度才可推理",
    "qoder-cn": "Qoder CN 国内 · Pro+ credits 在此区。PAT 入口：账号页 → 集成；本机 qoderclicn 登录可自动导入。仅限本人自用",
  };
  const loadSubs = useCallback(async () => {
    try {
      const d = await (await fetch(apiUrl("/api/auth/providers"), { cache: "no-store" })).json();
      setSubList(Array.isArray(d.providers) ? d.providers : []);
    } catch { setSubList([]); }
  }, []);
  // initialTab==='subs' 直开订阅 tab 时也必须拉列表（此前只有手动点 tab 才触发 → 永远「加载中…」）。
  // 独立 effect 放在 loadSubs 定义之后——塞进上面的开屏 effect 会因 deps 提前求值撞 TDZ。
  useEffect(() => { if (open && initialTab === "subs") loadSubs(); }, [open, initialTab, loadSubs]);
  // ---- 订阅型「可用模型」渲染共用 ----
  // 来源标注：runtime = /oauth-info 从 /api/models（pi ModelRuntime）取 → 选择器里真能选到；
  // catalog = 目录静态清单（运行时未注册该 provider）→ id 可能与选择器实际不符，刷新也不会变。
  const modelSourceTag = (source?: string) => (
    source === "runtime"
      ? <span style={{ fontWeight: 400, fontSize: 11, color: "var(--text-subtle,#666)" }}> · 运行时实时</span>
      : <span style={{ fontWeight: 400, fontSize: 11, color: "var(--warn,#b45309)" }}> · ⚠ 目录静态清单</span>
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
            <EyeBtn title={"查看 " + mid + " 参数（目录反填，只读）"} onClick={() => viewModelParams(pid, mid)} />
          </span>;
        })}
      </div>
      {source === "catalog" ? (
        <div style={{ fontSize: 11, color: "var(--warn,#b45309)", marginTop: 3 }}>⚠ 这是目录静态清单，运行时未注册「{pid}」的这些 id —— 选择器里可能找不到，点「刷新」也不会变。</div>
      ) : null}
      {related && related.length ? (
        <div style={{ fontSize: 11, color: "var(--text-subtle,#666)", marginTop: 3 }}>
          同账号其它 provider：{related.map((r: any) => r.provider + "（" + r.count + " 个）").join(" · ")}
        </div>
      ) : null}
    </div>
  );

  const renderSubscriptions = () => {
    if (!subList) return <div className="amw-note">加载中…</div>;
    if (!subList.length) return <div className="amw-note">未发现订阅登录型提供商。</div>;
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span className="amw-section" style={{margin: 0, flex: 1}}>{"🔐 订阅登录型提供商（" + subList.length + "）—— 无需 API token，点登录获取凭据"}</span>
          <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => { loadSubs(); checkOauthStatus(subActive ? [subActive] : []); }}>刷新列表</button>
        </div>
        <div className="amw-note">这些提供商走订阅/OAuth 登录（凭据存 auth.json 自动刷新），与 token 型 provider 并列使用。仅限本人账号自用，禁止共享/转售。</div>
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
                  <div style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{OAUTH_META[pid] || "OAuth 登录"}</div>
                </div>
                <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "3px 10px", fontSize: 11 }}
                  onClick={() => { setSubActive(active ? null : pid); checkOauthStatus([pid]); if (!active) startOauthLogin(pid); }}>
                  🔐 登录
                </button>
                <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }}
                  title="查看登录状态 / 账号 / credits"
                  onClick={() => { setSubActive(active ? null : pid); checkOauthStatus([pid]); }}>
                  {active ? "收起" : "详情"}
                </button>
                {(info?.loggedIn || pr.loggedIn) ? (
                  <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, color: "#dc2626" }} disabled={logoutBusy === pid}
                    title="登出：清除该 provider 的登录凭据（auth.json），其全部模型立即不可用；可随时重新登录"
                    onClick={() => void doOauthLogout(pid, pr.name || pid)}>
                    {logoutBusy === pid ? "登出中…" : "登出"}
                  </button>
                ) : null}
              </div>
              {(info?.loggedIn || pr.loggedIn) ? (
                <div className="amw-note is-ok" style={{marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center"}}>
                  <span>✅ 已登录</span>
                  {info?.account?.name ? <span>👤 {info.account.name}{info.account.plan ? " · " + info.account.plan : ""}</span> : null}
                  {cr ? <span><b>{cr.remaining}</b> / {cr.total} {cr.unit}{cr.expiresAt ? " · 到期 " + new Date(cr.expiresAt).toLocaleDateString() : ""}</span> : null}
                  {info?.addOn ? <span title="额外购买的加量包">➕ 加量包 {info.addOn.remaining}/{info.addOn.total}{info.addOn.used != null ? "（已用 " + info.addOn.used + "）" : ""}</span> : null}
                  {info?.packages?.length ? <span title="专属资源包（选定系列模型时优先抵扣）">🎁 {info.packages.map((p: any) => p.name + " " + p.remaining + "/" + p.total).join(" · ")}</span> : null}
                  {cr?.exceeded ? <span style={{ color: "#dc2626", fontWeight: 700 }}>额度已用完</span> : null}
                </div>
              ) : active ? <div className="amw-note is-warn">未登录 —— 点「登录」开始</div> : null}
              {active ? oauthLoginPanel({ id: pid, name: pr.name || pid }) : null}
              {active && models.length ? (
                <div style={{ marginTop: 6 }}>
                  <div style={{ color: "var(--text-subtle,#666)", fontSize: 11, marginBottom: 3 }}>可用模型（{models.length}）：{modelSourceTag(d?.modelsSource)}</div>
                  {renderModelPills(pid, models, d?.modelsSource, d?.related)}
                </div>
              ) : null}
            </div>
          );
        })}
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
        <div className="amw-section">🔐 订阅登录型 · 无需 API token</div>
        <div className="amw-note">订阅制提供商：点「登录」获取凭据（自动存入 auth.json 并刷新，无需手动保存）。仅限本人账号自用，禁止共享/转售。</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
          <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff" }} onClick={() => startOauthLogin(pid)} disabled={working}>
            🔐 登录 {p.name || pid}
          </button>
          {working ? <button className="amw-btn" onClick={stopOauthLogin}>取消</button> : null}
          <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => checkOauthStatus([pid])}>{info ? "刷新信息" : "刷新状态"}</button>
          {info?.loggedIn || (p as any).loggedIn ? (
            <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, color: "#dc2626" }} disabled={logoutBusy === pid}
              title="登出：清除该 provider 的登录凭据（auth.json），其全部模型立即不可用"
              onClick={() => void doOauthLogout(pid, p.name || pid)}>
              {logoutBusy === pid ? "登出中…" : "登出"}
            </button>
          ) : null}
          {info ? (info.loggedIn ? <span className="amw-note is-ok">✅ 已登录</span> : <span className="amw-note is-warn">未登录</span>) : null}
        </div>
        {info?.loggedIn ? (
          <div className="amw-note is-ok" style={{display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center"}}>
            {info.account?.name ? <span>👤 {info.account.name}{info.account.plan ? " · " + info.account.plan : ""}</span> : null}
            {info.account?.email ? <span>{info.account.email}</span> : null}
            {cr ? <span><b>{cr.remaining}</b> / {cr.total} {cr.unit}{cr.used != null ? "（已用 " + cr.used + "）" : ""}{cr.expiresAt ? " · 到期 " + new Date(cr.expiresAt).toLocaleDateString() : ""}</span> : null}
            {info?.addOn ? <span title="额外购买的加量包">➕ 加量包 <b>{info.addOn.remaining}</b> / {info.addOn.total} {info.addOn.unit}{info.addOn.used != null ? "（已用 " + info.addOn.used + "）" : ""}</span> : null}
            {info?.packages?.length ? <span title="专属资源包（选定系列模型时优先抵扣）">🎁 {info.packages.map((p: any) => p.name + " " + p.remaining + "/" + p.total).join(" · ")}</span> : null}
            {cr?.exceeded ? <span style={{ color: "#dc2626", fontWeight: 700 }}>额度已用完</span> : null}
          </div>
        ) : null}
        {info?.loggedIn && !info.credits && !info.quotaError ? <div className="amw-note">该账号无 credits 信息（Free 账号或接口不可用）</div> : null}
        {info?.quotaError ? <div className="amw-note is-warn">credits 查询失败：{info.quotaError}</div> : null}
        {info?.loggedIn && models.length ? (
          <div style={{ marginBottom: 6 }}>
            <div className="amw-section" style={{margin: "0 0 4px"}}>可用模型（{models.length} 个，选择器里直接选）{modelSourceTag(msrc)}</div>
            {renderModelPills(pid, models, msrc, d?.related)}
          </div>
        ) : null}
        {ls.phase === "connecting" ? <div className="amw-note">连接登录服务…</div> : null}
        {ls.phase === "progress" ? <div className="amw-note">{ls.message}</div> : null}
        {ls.phase === "auth" ? (
          <div className="amw-note">
            已打开授权页：<a href={LINK(ls.url)} target="_blank" rel="noreferrer" className="amw-link">{ls.url}</a><br />
            登录完成后浏览器会跳到一个打不开的 localhost 地址——把那个完整地址粘贴到这里提交：
            <OauthCodeInput onSubmit={(v) => submitOauthCode(pid, ls.token, v)} placeholder="http://localhost:…/callback?code=…" />
          </div>
        ) : null}
        {ls.phase === "device_code" ? (
          <div className="amw-note">
            打开授权页并输入码 <b>{ls.userCode}</b>：<a href={LINK(ls.verificationUri)} target="_blank" rel="noreferrer" className="amw-link">{ls.verificationUri}</a>
          </div>
        ) : null}
        {ls.phase === "prompt" ? (
          <div className="amw-note">
            {ls.message}
            <OauthCodeInput onSubmit={(v) => submitOauthCode(pid, ls.token, v)} placeholder={ls.placeholder || "留空直接提交 = 浏览器登录"} allowEmpty />
          </div>
        ) : null}
        {ls.phase === "select" ? (
          <div className="amw-note">
            {ls.message || "请选择："}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {(ls.options || []).map((o: any) => (
                <button key={o.id} className="amw-btn" style={{ textAlign: "left", padding: "7px 10px" }} onClick={() => submitOauthCode(pid, ls.token, o.id)}>{o.label || o.id}</button>
              ))}
            </div>
          </div>
        ) : null}
        {ls.phase === "success" ? <div className="amw-note is-ok">✅ 登录成功！上方已显示账号与可用模型。</div> : null}
        {ls.phase === "error" ? <div className="amw-note is-err">❌ {ls.message}</div> : null}
      </div>
    );
  };

  const credTestSave = (p: any) => {
    const validKeyRows = keyRows.filter((r) => (r.key || "").trim());
    const hdrs = p.id === "custom" && headersTouched ? rowsToHeaders(provHeaders) : undefined;
    return (
    <div>
      {p.id === "custom" ? (
        <>
          <div className="amw-section" style={{ margin: "12px 0 6px" }}>🔧 连接配置（自定义端点）</div>
          <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>Base URL</label>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input className="amw-input" style={{ flex: 1, fontFamily: "ui-monospace,monospace" }} placeholder="https://api.example.com/v1" value={p.baseUrl || ""}
              onChange={(e) => setSel((prev: any) => ({ ...(prev || {}), baseUrl: e.target.value }))} />
            <button className="amw-btn" style={{ flexShrink: 0 }} disabled={!p.baseUrl?.trim() || customDetecting}
              title="用当前地址 + token/请求头重新探测 api 类型与真实地址（漏 /v1 /v2 也能补）" onClick={detectCustom}>{customDetecting ? "探测中…" : "🔍 探测"}</button>
          </div>
          <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>API 类型</label>
          <select className="amw-input" style={{ width: "100%", marginBottom: 8 }} value={p.apiType || "openai-completions"}
            onChange={(e) => setSel((prev: any) => ({ ...(prev || {}), apiType: e.target.value }))}>
            {["openai-completions", "anthropic-messages", "openai-responses", "google-generative-ai"].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {p.apiType === "anthropic-messages" && /\/v1\/?$/i.test(String(p.baseUrl || "")) ? (
            <div className="amw-note is-warn" style={{ marginBottom: 6 }} title="pi 的 Anthropic 请求 = baseUrl + /v1/messages；base 带 /v1 会变成 /v1/v1/messages（404）。建议去掉尾部 /v1。">⚠️ Anthropic 的 Base URL 不要带尾部 /v1（运行时会在其后拼 /v1/messages）</div>
          ) : null}
          <div className="amw-section" style={{ margin: "0 0 6px" }}>请求头（可选）</div>
          <HeaderRowsEditor rows={provHeaders} hint="仅本 provider 的请求携带（如 User-Agent / x-opencode-session）；空行忽略"
            onChange={(rows) => { setProvHeaders(rows); setHeadersTouched(true); }} />
          {customDetect ? <div style={{ marginTop: 8 }}>{renderDetectCard(customDetect, applyCustomDetect)}</div> : null}
          <div style={{ borderBottom: "1px solid var(--border,#eee)", margin: "12px 0 2px" }} />
        </>
      ) : null}
      <StepHead n={1} title="提供商名称" hint="写入 models.json 的标识 · 自动生成可改" />
      <input className="amw-input" style={{width: "100%", height: 32, fontWeight: 600}} value={provName || genName(p.baseUrl) || "custom"} onChange={(e) => { setProvName(e.target.value); setProvNameTouched(true); }} placeholder="provider 名（用于 models.json 标识）" />

      <StepHead n={2} title="凭据与连接测试"
        hint="支持字面量（sk-…）· 环境变量名 · !命令"
        right={testRes ? <span style={{ fontSize: 11, fontWeight: 700, color: testRes.pass ? "#16a34a" : "#dc2626", whiteSpace: "nowrap" }}>{testRes.pass ? "✅ 已连通" : "❌ 未通过"}</span> : null} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input className="amw-input" style={{flex: 1, height: 32, fontFamily: "ui-monospace,monospace"}} type="password" placeholder="粘贴 API token —— 仅用于测试/保存，不回显" value={token} onChange={(e) => setToken(e.target.value)} />
        <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", height: 32, flexShrink: 0 }} title="顶部 token + 下方多 key 行一起逐个串行测，每把单独出结果"
          onClick={() => doTestCreds(p.baseUrl, p.apiType, hdrs)} disabled={testing || (!token.trim() && !validKeyRows.length)}>
          {testing ? "测试中…" : (<><Ic size={13} paths={ICONS.search} />测试连接</>)}
        </button>
      </div>
      <div style={{ color: "var(--text-subtle,#999)", fontSize: 10.5, marginTop: 4 }}>环境变量名（如 OPENROUTER_KEY）或 <code className="amw-mono">!命令</code>（取 stdout）：保存时原样写入 models.json 由 pi 解析</div>

      {/* ── 多 Key 轮转：产品亮点，常驻卡片展示（不再藏进折叠区）── */}
      <div style={{ marginTop: 12, border: "1px solid rgba(99,102,241,.45)", borderRadius: 10, background: "rgba(99,102,241,.05)", padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 700, fontSize: 12.5, color: "#4f46e5" }}><Ic size={14} paths={ICONS.key} />多 Key 自动轮转</span>
          <span style={{ padding: "1px 8px", borderRadius: 999, background: "#4f46e5", color: "#fff", fontSize: 9.5, fontWeight: 700 }}>✨ 亮点</span>
          {validKeyRows.length ? <span style={{ padding: "1px 8px", borderRadius: 999, background: "rgba(79,70,229,.14)", color: "#4f46e5", fontSize: 10.5, fontWeight: 700 }}>{validKeyRows.length + " 把"}</span> : null}
          <span style={{ fontSize: 10.5, color: "var(--text-subtle,#777)", flex: 1, minWidth: 180 }}>多把 key 分摊限流、用尽自动切换 · 每把可设 rpm 上限 + 等间距间隔（留空=auto · 0=突发 · 数字=毫秒）</span>
        </div>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {keyRows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input className="amw-input" style={{width: 64, fontFamily: "ui-monospace,monospace"}} placeholder="名" value={r.name} onChange={(e) => setKeyRows((prev) => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} type="password" placeholder="API key（sk-…）" value={r.key} onChange={(e) => setKeyRows((prev) => prev.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
              <input className="amw-input" style={{width: 56}} type="number" min={1} placeholder="rpm" title="每分钟请求上限（可选）" value={r.rpm || ""} onChange={(e) => setKeyRows((prev) => prev.map((x, j) => j === i ? { ...x, rpm: e.target.value } : x))} />
              <input className="amw-input" style={{width: 72}} placeholder="间隔ms·0=突发" title="等间距节流（默认匀速）三种填法：留空 = auto（按 rpm 折算 60000÷rpm，rpm30→每2s）；0 = 关闭匀速（突发滑窗）；数字 = 固定间隔毫秒。与 rpm 取最大等待" value={r.minIntervalMs ?? ""} onChange={(e) => setKeyRows((prev) => prev.map((x, j) => j === i ? { ...x, minIntervalMs: e.target.value } : x))} />
              <button className="amw-btn" style={{ padding: "2px 8px" }} title="删除此 key" onClick={() => setKeyRows((prev) => prev.filter((_x, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="amw-btn" style={{ padding: "3px 12px", fontSize: 11, alignSelf: "flex-start" }} onClick={() => setKeyRows((prev) => [...prev, { name: "key-" + (prev.length + 1), key: "", rpm: "", minIntervalMs: "" }])}>＋ 添加一把 key</button>
        </div>
      </div>
      {testBadge(testRes)}

      <StepHead n={3} title="选择模型" hint={known.length ? "勾选要启用的模型 · 👁 可看参数详情" : undefined}
        right={<>
          <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "3px 10px", fontSize: 11 }} title="用已填凭据（token + 多 key 行）逐把拉厂商 /models 实时列表，任一把成功即用（目录旧也能补全）" disabled={discBusy || (!token.trim() && !validKeyRows.length)} onClick={() => doDiscoverCreds(p.baseUrl, p.apiType, hdrs)}>
            {discBusy ? "拉取中…" : (<><Ic size={11} paths={ICONS.refresh} />刷新模型</>)}
          </button>
          {known.length ? <span style={{ fontSize: 11, color: "var(--text-subtle,#666)", whiteSpace: "nowrap" }}>{"已选 " + checked.length + " / " + known.length}</span> : null}
        </>} />
      {known.length ? (
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input className="amw-input" style={{flex: 1, minWidth: 180}} placeholder="🔍 搜索过滤模型（如 glm / flash / free…）" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} />
            <button className="amw-btn" style={{ padding: "3px 11px" }} onClick={() => setChecked([...new Set([...checked, ...filteredModels()])])}>全选</button>
            <button className="amw-btn" style={{ padding: "3px 11px" }} onClick={() => setChecked((prev) => [...prev.filter((id) => !filteredModels().includes(id)), ...filteredModels().filter((id) => !prev.includes(id))])}>反选</button>
            <button className="amw-btn" style={{ padding: "3px 11px" }} onClick={() => setChecked((prev) => prev.filter((id) => !filteredModels().includes(id)))}>清空</button>
            {modelFilter.trim() ? <span style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{"筛中 " + filteredModels().length + " / " + known.length}</span> : null}
          </div>
          {discMsg ? <div className={"amw-note " + (discMsg.startsWith("✅") ? "is-ok" : "is-err")} style={{ marginBottom: 6 }}>{discMsg}</div> : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, maxHeight: 220, overflow: "auto", padding: 2 }}>
            {filteredModels().map((id) => (
              <label key={id} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 9px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)", cursor: "pointer", background: checked.includes(id) ? "rgba(37,99,235,.12)" : "var(--bg,#fff)" }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(99,102,241,.55)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border,#e0e0e0)"; }}>
                <input type="checkbox" checked={checked.includes(id)} onChange={() => toggleModel(id)} style={{ margin: 0 }} />
                <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 11 }}>{id}</span>
                <EyeBtn title={"查看 " + id + " 参数（窗口/能力/价格，目录反填；未收录按同 id 跨网关互证）"} onClick={() => viewModelParams(sel.id || p.name || "custom", id)} />
              </label>
            ))}
          </div>
        </div>
      ) : <div className="amw-note">暂无已知模型 —— 填好 token 点「测试连接」或「刷新模型」自动拉取 /models 列表（目录列表可能过时，以实时拉取为准）</div>}
      <div style={{ display: "flex", gap: 6, marginBottom: 2, alignItems: "center" }}>
        <input className="amw-input" style={{flex: 1}} placeholder="手动补充模型 id（逗号分隔，如 deepseek-chat,deepseek-reasoner）" value={manual} onChange={(e) => setManual(e.target.value)} />
        <button className="amw-btn" onClick={addManual}>＋ 添加</button>
      </div>

      {/* 底部操作条：提示居左，主按钮右对齐加大（符合习惯的确认位置） */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border,#eee)" }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text-subtle,#666)", lineHeight: 1.5 }}>
          {checked.length ? "已选 " + checked.length + " 个模型" : "先在 ③ 勾选模型"}
          {validKeyRows.length ? " · 多 key " + validKeyRows.length + " 把" : ""}
          {!token && !validKeyRows.length ? " · ⚠️ 未填凭据（同名校已存 key 会保留）" : ""}
          <br />保存后刷新页面模型即生效
        </span>
        <button className="amw-btn is-ok" style={{ height: 36, padding: "0 20px", fontSize: 13.5, fontWeight: 700, flexShrink: 0 }}
          onClick={() => { setSaveForce(false); setSaveDlg({ name: (provName || genName(p.baseUrl) || "custom"), baseUrl: p.baseUrl, api: p.apiType, modelCount: checked.length }); }}
          disabled={saving || !checked.length}>
          {saving ? "保存中…" : checked.length ? "💾 保存 " + checked.length + " 个模型" : "💾 保存到配置"}
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
      const d = await (await api("/export")).json();
      if (!d || !d.ok) { setToast({ msg: "导出失败：" + ((d && d.error) || "?"), ok: false }); setTimeout(() => setToast(null), 4000); return; }
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "aiti-models-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      const cnt = Object.keys(d.providers || {}).length;
      setToast({ msg: "✅ 已导出 " + cnt + " 个 provider（无明文 key）" + (Array.isArray(d.skippedCombos) && d.skippedCombos.length ? " · 聚合组 " + d.skippedCombos.length + " 个未含" : ""), ok: true });
      setTimeout(() => setToast(null), 4000);
    } catch (e: any) {
      setToast({ msg: "导出失败：" + (e.message || e), ok: false });
      setTimeout(() => setToast(null), 4000);
    }
  }, []);
  const doImportParse = useCallback(async (text: string) => {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch (e: any) { setToast({ msg: "JSON 解析失败：" + (e.message || e), ok: false }); setTimeout(() => setToast(null), 4000); return; }
    const providers = parsed && parsed.providers && typeof parsed.providers === "object" ? parsed.providers : parsed;
    setImpDlg((prev: any) => ({ ...(prev || {}), phase: "preview", text, rows: null, applying: false }));
    try {
      const d = await (await api("/import", { method: "POST", ...jsonBody({ providers, apply: false }) })).json();
      if (!d || !d.ok) { setToast({ msg: "预览失败：" + ((d && d.error) || "?"), ok: false }); setTimeout(() => setToast(null), 4000); setImpDlg(null); return; }
      setImpDlg((prev: any) => ({ ...(prev || {}), phase: "preview", rows: d.rows || [], errors: d.errors || [], conflictCount: d.conflictCount || 0 }));
    } catch (e: any) {
      setToast({ msg: "预览失败：" + (e.message || e), ok: false }); setTimeout(() => setToast(null), 4000); setImpDlg(null);
    }
  }, []);
  const doImportApply = useCallback(async () => {
    setImpDlg((prev: any) => ({ ...(prev || {}), applying: true }));
    let parsed: any;
    try { parsed = JSON.parse((impDlg && impDlg.text) || ""); } catch { setImpDlg(null); return; }
    const providers = parsed && parsed.providers && typeof parsed.providers === "object" ? parsed.providers : parsed;
    try {
      const d = await (await api("/import", { method: "POST", ...jsonBody({ providers, apply: true }) })).json();
      setImpDlg(null);
      if (d && d.ok) {
        const okN = (d.results || []).filter((x: any) => x.ok).length;
        setToast({ msg: "✅ 已导入 " + okN + " 个 provider（/undo 可一步回整批）", ok: true });
        setTimeout(() => setToast(null), 4500);
        loadStatus();
      } else {
        setToast({ msg: "导入失败：" + ((d && d.error) || "?"), ok: false });
        setTimeout(() => setToast(null), 4500);
      }
    } catch (e: any) {
      setImpDlg(null);
      setToast({ msg: "导入失败：" + (e.message || e), ok: false });
      setTimeout(() => setToast(null), 4500);
    }
  }, [impDlg]);
  const renderImportDlg = () => {
    const rows: any[] = impDlg?.rows || [];
    const kindColor: any = { new: "#16a34a", same: "#b45309", conflict: "#dc2626" };
    const kindLabel: any = { new: "新增", same: "覆盖", conflict: "⚠ 冲突" };
    return (
      <div className="amw-overlay" onClick={(e) => { if (e.target === e.currentTarget) setImpDlg(null); }}>
        <div {...{ "data-ext-float": "1", "data-ext-float-key": "aiti-model-wizard:import-dialog", "data-ext-float-w": 560, "data-ext-float-autoh": "1" }} onClick={(e) => e.stopPropagation()} className="amw-float-panel" style={{ width: "min(560px, 100%)", padding: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}><Ic size={14} paths={ICONS.file} />⇪ 导入 provider 配置</div>
          {impDlg.phase === "paste" ? (
            <>
              <div className="amw-note" style={{ marginBottom: 6 }}>粘贴导出的 JSON（⇩ 导出文件；无明文 key——导入后现有 key 保留，缺 key 的新 provider 落禁用态需补 key）。也可选本地文件：</div>
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
                <button className="amw-btn" onClick={() => setImpDlg(null)}>取消</button>
                <button className="amw-btn is-ok" disabled={!(impDlg.text || "").trim()} onClick={() => void doImportParse(impDlg.text)}>解析预览</button>
              </div>
            </>
          ) : (
            <>
              <div className="amw-note" style={{ marginBottom: 6 }}>
                {"差异预览：" + rows.length + " 条（新增 " + rows.filter((r) => r.kind === "new").length + " · 覆盖 " + rows.filter((r) => r.kind === "same").length + " · 冲突 " + (impDlg.conflictCount || 0) + "）。确认后走批量保存，/undo 可一步回整批。"}
              </div>
              <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
                {rows.map((r) => (
                  <div key={r.name} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 8px", borderBottom: "1px solid var(--border)", fontSize: 11.5 }}>
                    <span style={{ flexShrink: 0, padding: "1px 7px", borderRadius: 8, color: "#fff", background: kindColor[r.kind], fontSize: 10 }}>{kindLabel[r.kind]}</span>
                    <span style={{ fontWeight: 600, minWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-subtle,#666)" }}>
                      {r.kind === "conflict" && r.reason ? r.reason : r.modelsExisting + " → " + r.modelsIncoming + " 模型"}
                    </span>
                    {r.keepKey ? <span style={{ flexShrink: 0, fontSize: 10, color: "#16a34a" }}>保留现有 key</span> : null}
                  </div>
                ))}
                {!rows.length ? <div style={{ padding: 10, fontSize: 11, color: "var(--text-subtle,#666)" }}>无可导入条目</div> : null}
              </div>
              {(impDlg.errors || []).length ? <div className="amw-note is-warn" style={{ marginTop: 6, fontSize: 11 }}>{impDlg.errors.join("；")}</div> : null}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                <button className="amw-btn" onClick={() => setImpDlg((prev: any) => ({ ...(prev || {}), phase: "paste" }))} disabled={impDlg.applying}>返回修改</button>
                <button className="amw-btn is-ok" disabled={impDlg.applying || !rows.length} onClick={() => void doImportApply()}>{impDlg.applying ? "导入中…" : "确认导入（" + rows.length + " 条）"}</button>
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
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><Ic size={14} paths={ICONS.tag} />确认保存 —— 提供商名称</div>
        <label style={{ fontSize: 11, color: "var(--text-subtle,#666)", display: "block", marginBottom: 3 }}>名称（自动生成，可修改；用于 models.json 标识）</label>
        <input className="amw-input" style={{width: "100%", marginBottom: 8, fontWeight: 600}} value={saveDlg.name} onChange={(e) => setSaveDlg((prev: any) => ({ ...prev, name: e.target.value }))} />
        <div className="amw-mono" style={{ fontSize: 11, color: "var(--text-subtle,#666)", marginBottom: 4, wordBreak: "break-all" }}>{"baseUrl: " + saveDlg.baseUrl}</div>
        <div style={{ fontSize: 11, color: "var(--text-subtle,#666)", marginBottom: 8 }}>{"api: " + saveDlg.api + " · 模型 " + saveDlg.modelCount + " 个" + (token ? " · 已填 token" : validKeyRowsDlg.length ? " · 多 key " + validKeyRowsDlg.length + " 把（随保存写入）" : " · ⚠️ 未填凭据（同名校已存 key 会保留）")}</div>
        {ltPass ? (
          <div style={{ ...barStyle, background: "rgba(22,163,74,.12)", color: "#16a34a" }}>✅ 最近测试通过{lt.latencyMs != null ? "（" + lt.latencyMs + "ms）" : ""}——可保存</div>
        ) : ltFail ? (
          <div style={{ ...barStyle, background: "rgba(220,38,38,.12)", color: "#dc2626" }}>
            <span style={{ minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis" }}>{"❌ 最近测试失败：" + String(lt.detail || "").slice(0, 80)}</span>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", flexShrink: 0, color: "var(--text,#333)" }}>
              <input type="checkbox" checked={saveForce} onChange={(e) => setSaveForce(e.target.checked)} />
              仍要保存（禁用态）
            </label>
          </div>
        ) : (
          <div style={{ ...barStyle, background: "rgba(245,158,11,.14)", color: "#b45309" }}>
            <span style={{ flex: "1 1 auto" }}>⚠️ 尚未测试——保存后立即生效，建议先测一次</span>
            <button
              className="amw-btn"
              style={{ flexShrink: 0, padding: "3px 10px" }}
              disabled={testing}
              onClick={async () => { await doTest(saveDlg.baseUrl, saveDlg.api, token || undefined, null); await loadLastTest(); }}
            >{testing ? "测试中…" : "先测试"}</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="amw-btn" onClick={() => { setSaveForce(false); setSaveDlg(null); }} disabled={saving}>取消</button>
          <button
            className="amw-btn is-ok"
            disabled={saving || !saveDlg.name.trim() || !checked.length || (ltFail && !saveForce)}
            onClick={() => {
              const nm = saveDlg.name.trim();
              const force = ltFail && saveForce;
              setSaveForce(false); setSaveDlg(null);
              doSave(nm, saveDlg.baseUrl, saveDlg.api, token, !token, force ? false : undefined);
            }}
          >{saving ? "保存中…" : ltFail && saveForce ? "💾 仍要保存（禁用态）" : "💾 确认保存"}</button>
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
        if (b.provider) rows.push({ text: (<><Ic size={11} paths={ICONS.tag} />{" 品牌：" + [b.provider.cnName, b.provider.name].filter(Boolean).join(" / ")}</>), src: b.source === "openapi" ? "OpenAPI 声明" : "模型前缀", strong: true });
        else if (b.source === "openapi" && b.title) rows.push({ text: (<><Ic size={11} paths={ICONS.file} />{" OpenAPI: " + b.title}</>), src: "未匹配目录", strong: false });
      }
    }
    if (!rows.length && cd.providerGuess) rows.push({ text: (<><Ic size={11} paths={ICONS.tag} />{" " + (cd.providerGuess.confident ? "品牌：" : "疑似：") + [cd.providerGuess.cnName, cd.providerGuess.name].filter(Boolean).join(" / ")}</>), src: cd.providerGuess.confident ? "地址匹配" : "同域名（可能是其它套餐）", strong: cd.providerGuess.confident });
    return (
      <div>
        <div className="amw-note is-ok">{"✅ " + cd.hint}</div>
        {rows.map((r, i) => (
          <div key={i} style={{ marginBottom: 4, fontSize: 12 }}>
            <span style={{ padding: "2px 8px", borderRadius: 8, background: r.strong ? "rgba(37,99,235,.1)" : "rgba(245,158,11,.14)", color: r.strong ? "var(--accent,#2563eb)" : "#b45309", marginRight: 6 }}>{r.text}</span>
            <span style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{r.src}</span>
          </div>
        ))}
        {cd.models && cd.models.length ? <div style={{ marginBottom: 4, fontSize: 12, color: "#16a34a" }}>{"📦 模型列表已拉取（" + cd.modelCount + " 个）—— 在下方「③ 选择模型」勾选即可"}</div>
          : cd.modelsError ? <div style={{ marginBottom: 4, fontSize: 11, color: "var(--text-subtle,#666)" }}>{"模型列表：" + cd.modelsError.slice(0, 90)}</div> : null}
        <div style={{ display: "flex", gap: 6, margin: "8px 0", alignItems: "center", flexWrap: "wrap" }}>
          {cd.baseUrl ? <span className="amw-mono" style={{ padding: "3px 8px", borderRadius: 8, background: "var(--bg-subtle,#f5f5f5)" }}>{"api=" + cd.api + " · baseUrl=" + cd.baseUrl}</span> : null}
          {cd.api ? <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff" }} onClick={onApply}>用此端点继续</button> : null}
        </div>
      </div>
    );
  };

  const submitOauthCode = useCallback(async (providerId: string, token2: string, code: string) => {
    setOauthLs({ phase: "progress", message: "验证中…" });
    try {
      const res = await fetch(apiUrl("/api/auth/login/" + encodeURIComponent(providerId)), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token2, code }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as any));
        setOauthLs({ phase: "error", message: d.error ?? "服务端错误 " + res.status });
      }
    } catch (e) {
      setOauthLs({ phase: "error", message: e instanceof Error ? e.message : "网络错误" });
    }
  }, []);

  // 选中的是订阅登录型 → 查询登录状态
  useEffect(() => {
    if (sel?.authType === "oauth") checkOauthStatus([sel.oauthProviderId || sel.id]);
  }, [sel?.id, sel?.authType, checkOauthStatus]);

  // 浏览目录列表：按首字符分组（models.dev 无更细分类）→ 展开显示基本信息 + 已知模型清单；点「＋ 添加」/模型进入接入流程
  const renderBrowse = () => {
    if (!cat || !Array.isArray(cat.providers)) return <div className="amw-note">目录未加载 —— 点「↻ 刷新目录」拉取 models.dev 后重试</div>;
    const groups = browseGroups() as any;
    const total = groups.reduce((s: number, [, ps]: any) => s + ps.length, 0);
    if (!total) return <div className="amw-note">无匹配提供商</div>;
    return (
      <div style={{ marginBottom: 4 }}>
        <div className="amw-section" style={{marginTop: 4}}>{"📚 全部目录（" + cat.count + " 家 · models.dev 无细分分类，按首字符分组；点「＋ 添加」直接接入）"}</div>
        <input className="amw-input" style={{width: "100%", marginBottom: 8}} placeholder="🔍 过滤提供商（中英文名 / ID / API 地址）" value={browseQ} onChange={(e) => setBrowseQ(e.target.value)} />
        <div style={{ maxHeight: "min(52dvh, 460px)", overflow: "auto", border: "1px solid var(--border,#eee)", borderRadius: 10, padding: "0 8px" }}>
          {groups.map(([g, provs]: any) => (
            <div key={g}>
              <div style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--bg,#fff)", fontWeight: 700, fontSize: 12, color: "var(--text-subtle,#666)", padding: "6px 2px", borderBottom: "1px solid var(--border,#eee)" }}>{g}<span style={{ fontWeight: 400, marginLeft: 6, fontSize: 10.5 }}>{provs.length + " 家"}</span></div>
              {provs.map((p: any) => {
                const open = !!browseOpen[p.id];
                const det = browseDetail[p.id] || {};
                const logo = (p.cnName || p.name || "?").trim().charAt(0).toUpperCase();
                return (
                  <div key={p.id} style={{ borderBottom: "1px solid var(--border,#f4f4f4)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 2px", cursor: "pointer", borderRadius: 8 }}
                      onClick={() => browseToggleProv(p.id)} title={open ? "收起" : "展开基本信息与模型列表"}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-subtle,#f7f7fb)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}>
                      <span style={{ width: 13, color: "var(--text-subtle,#999)", fontSize: 11, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
                      <ProviderAvatar id={p.id} name={[p.cnName, p.name].filter(Boolean).join(" / ")} size={22} radius={7} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {[p.cnName, p.name].filter(Boolean).join(" / ") || p.id}
                          {p.hasCn ? <span style={{ marginLeft: 6, padding: "0 6px", borderRadius: 8, background: "rgba(37,99,235,.1)", color: "var(--accent,#2563eb)", fontSize: 9 }}>国内</span> : null}
                        </div>
                        <div className="amw-mono" style={{ fontSize: 10.5, color: "var(--text-subtle,#999)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {p.baseUrl || p.id}{det.models && det.models.length ? " · " + det.models.length + " 模型" : ""}
                        </div>
                      </div>
                      <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); pickBrowse(p); }}>＋ 添加</button>
                    </div>
                    {open ? (
                      <div style={{ padding: "0 2px 8px 43px" }}>
                        {det.loading ? <div style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>加载模型列表…</div>
                          : det.error ? <div className="amw-note is-err" style={{fontSize: 11}}>{"❌ " + det.error}</div> : null}
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 11, marginBottom: 3, alignItems: "center" }}>
                          {p.apiType ? <span className="amw-mono" style={{color: "var(--text-subtle,#666)"}}>{"api: " + p.apiType}</span> : null}
                          {p.doc ? <a href={LINK(p.doc)} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid var(--border,#e0e0e0)", background: "var(--bg,#fff)", color: "var(--accent,#2563eb)", fontSize: 12, textDecoration: "none" }} title="打开官网/文档（新窗口）">🌐 官网/文档</a> : null}
                          {p.signupUrl ? <a href={LINK(p.signupUrl)} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid rgba(34,197,94,.4)", background: "rgba(34,197,94,.06)", color: "#15803d", fontSize: 12, fontWeight: 600, textDecoration: "none" }} title="打开注册页（新窗口）">📝 注册</a> : null}
                          {p.tokenUrl ? <a href={LINK(p.tokenUrl)} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid rgba(99,102,241,.4)", background: "rgba(99,102,241,.06)", color: "#4f46e5", fontSize: 12, fontWeight: 600, textDecoration: "none" }} title="打开取 token 页（新窗口）">🔑 取 token</a> : null}
                        </div>
                        {p.register ? <div style={{ fontSize: 11, color: "var(--text-subtle,#555)", margin: "2px 0" }}>{String(p.register).slice(0, 160)}</div> : null}
                        {det.models && det.models.length ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                            {det.models.map((m: any, i: number) => (
                              <span key={(m.id || "") + "#" + i} title={(m.name && m.name !== m.id ? m.name + " — " : "") + "点击选用该提供商接入"} onClick={() => pickBrowse(p)}
                                className="amw-mono" style={{ padding: "2px 8px", borderRadius: 8, border: "1px solid var(--border,#e5e5e5)", background: "var(--bg-subtle,#fafafa)", fontSize: 11, cursor: "pointer" }}
                                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(99,102,241,.5)"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.borderColor = ""; }}>
                                {m.id}{m.name && m.name !== m.id ? <span style={{ color: "var(--text-subtle,#999)" }}>{" · " + m.name}</span> : null}
                              </span>
                            ))}
                          </div>
                        ) : !det.loading && !det.error ? <div style={{ color: "var(--text-subtle,#999)", fontSize: 11 }}>（目录无已知模型——添加后可用「刷新模型」实时拉取 /models）</div> : null}
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
            <button className="amw-btn" style={{ flexShrink: 0 }} title="清空当前选择，重新搜索 / 换一家" onClick={resetSel}>更换</button>
          </div>
          {providerInfo(sel)}
          {sel.authType === "oauth" ? oauthLoginPanel(sel) : credTestSave(sel)}
        </div>
      ) : (
        <div>
          <StepHead n={1} title="搜索提供商" hint="中英文名 / 别名 / 模型 id；贴 API 地址自动反向匹配+探测（漏 /v1 /v2 也能补）" />
          <form style={{ display: "flex", gap: 8, marginBottom: 10 }} onSubmit={doSearch}>
            <input className="amw-input" style={{flex: 1}} placeholder="DeepSeek / 智谱 GLM / qwen… 或贴 https://api.xxx.com/v1" value={q} onChange={(e) => { setQ(e.target.value); setSearchDetect(null); setReverseRes(null); }} />
            <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff" }} disabled={searching}>{searching ? "搜…" : <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.search} />搜索</span>}</button>
            {/* 常驻「＋ 自定义」：不搜索也能直接进面板（2026-09-17 拍板） */}
            <button type="button" className="amw-btn" style={{ flexShrink: 0 }} title="不搜索直接手工添加自定义端点（Base URL / API 类型 / 请求头）" onClick={startCustom}>＋ 自定义</button>
          </form>
          {cat ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: cat.cache && cat.cache.stale ? "#b45309" : "var(--text-subtle,#666)", fontSize: 11, marginBottom: 8 }}>
              {(() => { const c = cat.cache || {}; const hours = c.ageMs != null ? c.ageMs / 3600000 : null;
                const ageTxt = hours == null ? "" : hours < 1 ? "刚刚更新" : hours < 48 ? Math.round(hours) + " 小时前" : Math.round(hours / 24) + " 天前";
                return [
                  <span key="t">{"目录 " + cat.count + " 家 · models.dev " + (c.from === "cache" ? (ageTxt ? ageTxt : "缓存") : c.from === "snapshot" ? "内嵌快照（旧，启动时自动拉新）" : c.from === "none" ? "未缓存" : c.from || "")
                    + (c.stale && c.from !== "none" ? " · ⚠ 已超 TTL（保存未知模型时会自动强刷，或点右侧手动刷新）" : "")
                    + (c.from === "none" ? "（搜索为空时点右侧按钮拉取）" : "")}</span>,
                  <button key="btn" className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} disabled={catRefreshing} onClick={doRefreshCatalog} title="重新下载 models.dev 目录（官方 + Gitee 镜像竞速）">{catRefreshing ? "刷新中…" : "↻ 刷新目录"}</button>,
                  <button key="browse" className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => setBrowse((v) => !v)} title="浏览目录全部提供商（按首字符分组展开，点添加直接接入）">{browse ? "▾ 收起目录" : "📖 浏览目录"}</button>,
                ]; })()}
              {catMsg ? <span style={{ color: catMsg.startsWith("✅") ? "#15803d" : "#b91c1c" }}>{catMsg}</span> : null}
            </div>
          ) : null}
          {/* 浏览目录开启 → 替换热门推荐区位置；关闭时未搜索才展示推荐卡片。 */}
          {!results && browse ? renderBrowse() : (!results && rec && rec.length ? (
            <div style={{ marginBottom: 4 }}>
              <div className="amw-section" style={{marginTop: 4}}>✨ 热门提供商（点下方套餐直接接入；多形态选对应套餐）</div>
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
                      <div style={{ fontSize: 10.5, color: "var(--text-subtle,#777)", margin: "0 0 5px", lineHeight: 1.4, height: 29, overflow: "hidden" }}>{(c.main.register || "点选下方套餐接入").slice(0, 110)}</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                        {c.main.doc ? <a href={LINK(c.main.doc)} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid var(--border,#e0e0e0)", background: "var(--bg,#fff)", color: "var(--accent,#2563eb)", fontSize: 12, textDecoration: "none" }} title={"打开官网/文档（新窗口）"}>🌐 官网</a> : null}
                        {c.main.signupUrl ? <a href={LINK(c.main.signupUrl)} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid rgba(34,197,94,.4)", background: "rgba(34,197,94,.06)", color: "#15803d", fontSize: 12, fontWeight: 600, textDecoration: "none" }} title={"打开注册页（新窗口）"}>📝 注册</a> : null}
                        {c.main.tokenUrl ? <a href={LINK(c.main.tokenUrl)} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: "1px solid rgba(99,102,241,.4)", background: "rgba(99,102,241,.06)", color: "#4f46e5", fontSize: 12, fontWeight: 600, textDecoration: "none" }} title={"打开取 token 页（新窗口）"}>🔑 取 token</a> : null}
                      </div>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {c.plans.map((pl: any) => (
                          <button key={pl.id} style={{ padding: "3px 10px", fontSize: 11, borderRadius: 7, border: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f7f7f9)", color: "var(--text-muted,#555)", cursor: "pointer", transition: "all .12s" }}
                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(99,102,241,.55)"; e.currentTarget.style.color = "#4f46e5"; e.currentTarget.style.background = "var(--bg,#fff)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border,#e0e0e0)"; e.currentTarget.style.color = ""; e.currentTarget.style.background = ""; }}
                            title={pl.provider.baseUrl + "（" + pl.provider.apiType + "）"} onClick={() => pickPlan(pl)}>{pl.label}</button>
                        ))}
                        {aff && aff[c.id] && aff[c.id].link ? (
                          <a key={"aff-" + c.id} href={aff[c.id].link} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", padding: "3px 10px", fontSize: 11, fontWeight: 600, borderRadius: 7, background: "rgba(34,197,94,.08)", border: "1px solid rgba(34,197,94,.35)", color: "#15803d", textDecoration: "none" }} title={aff[c.id].note || "通过本链接注册，双方得免费额度（新窗口）"}>🎁 有礼</a>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null)}
          {!results ? null : results.length === 0
            ? <div className="amw-note">目录未命中 —— 贴完整 API 地址会自动反向匹配+自动探测</div>
            : results.map((p: any) => (
              <div key={p.id} className={"amw-card" + (sel && sel.id === p.id ? " is-on" : "")} onClick={() => pickProvider(p)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600 }}>{[p.cnName, p.name].filter(Boolean).join(" / ")}{p.hasCn ? <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "rgba(37,99,235,.1)", color: "var(--accent,#2563eb)", fontSize: 10 }}>国内</span> : null}{p.native ? <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "rgba(22,163,74,.12)", color: "#15803d", fontSize: 10 }}>pi 内置</span> : null}{p.matched && p.matched !== "text" ? <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "rgba(245,158,11,.14)", color: "#b45309", fontSize: 10 }}><Ic size={10} paths={ICONS.refresh} />{" 地址反向命中 " + p.reverseScore}</span> : null}</span>
                  <span className="amw-mono" style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{p.matchedBaseUrl || p.baseUrl || ""}</span>
                </div>
                <div style={{ color: "var(--text-subtle,#555)", fontSize: 11, marginTop: 4, maxHeight: 30, overflow: "hidden" }}>{p.native ? "pi 内置 provider · " + p.modelCount + " 个模型 · 填 API Key 接入" : ([p.register || p.doc || ""].filter(Boolean)[0] || (p.models && p.models.length ? "已知模型 " + p.models.length + " 个" : "点击查看详情"))}</div>
              </div>
            ))}
          {searchDetect ? <div style={{ marginTop: 8 }}>{renderDetectCard(searchDetect, applySearchDetect)}</div> : null}
          {reverseRes ? (
            <div style={{ marginTop: 8 }}>
              {reverseRes.candidates && reverseRes.candidates.length ? (
                <div>
                  <StepHead n={2} title="反向匹配候选" hint="目录 · 100=地址完全一致 · 30=同域名其它套餐/版本，以探测结果为准" />
                  {reverseRes.candidates.map((cand: any) => (
                    <div key={cand.id} className={"amw-card" + (sel && sel.id === cand.id ? " is-on" : "")} onClick={() => { setSel({ ...cand, baseUrl: cand.matchedBaseUrl || cand.baseUrl }); setToken(""); setTestRes(null); setChecked([]); setManual(""); setKnown((cand.models || []).map((m: any) => m.id)); }}>
                      <div style={{ fontWeight: 600 }}>{[cand.cnName, cand.name].filter(Boolean).join(" / ") + "（匹配度 " + cand.score + "）"}</div>
                      <div className="amw-mono" style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{cand.matchedBaseUrl || cand.baseUrl}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              {reverseRes.detect ? <div style={{ marginTop: 6 }}>{renderDetectCard(reverseRes.detect, applyReverseDetect)}</div> : null}
              {!reverseRes.usedKey ? (
                <div style={{ marginTop: 8, padding: 10, border: "1px dashed var(--border,#e0e0e0)", borderRadius: 8 }}>
                  <div style={{ fontSize: 12, marginBottom: 6, color: "var(--text-subtle,#666)" }} title="无 key 探测只能判断 api 类型，真实版本路径（/v1 /v2 /v3）可能不准；key 只用于探测，不回传">⚠️ 无 key 仅判断 api 类型，填 key 精探更准</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input className="amw-input" style={{flex: 1, fontFamily: "ui-monospace,monospace"}} type="password" placeholder="API key / token" value={probeKey} onChange={(e) => setProbeKey(e.target.value)} />
                    <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff" }} onClick={doReverseWithKey} disabled={reprobing || !probeKey.trim()}>{reprobing ? "精探中…" : "🔍 带 key 精探"}</button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {/* 常驻自定义入口（最末）：有没有匹配到都在（2026-09-17 拍板「有没有匹配到都加」） */}
          <div className="amw-card" style={{ marginTop: 8, borderStyle: "dashed", display: "flex", alignItems: "center", gap: 10 }} onClick={startCustom}
            title="不搜索也能直接进入自定义端点面板（Base URL / API 类型 / 请求头）">
            <span style={{ width: 28, height: 28, borderRadius: 8, background: "var(--bg-subtle,#f5f5f5)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Ic size={14} paths={ICONS.plus} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>🛠 自定义端点（手工配置）</div>
              <div style={{ fontSize: 11, color: "var(--text-subtle,#666)" }}>{"目录没收录？贴过地址？都从这里进：手工填 Base URL / API 类型 / 请求头，无需目录匹配"}</div>
            </div>
            <span className="amw-btn" style={{ flexShrink: 0 }}>进入</span>
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
    const provs = kws.length
      ? st.providers.filter((p: any) => {
          const pMatch = kws.every((k) => hay(p.provider).includes(k));
          if (pMatch) return true;
          const ids = (p.models || []).map((m: any) => (typeof m === "string" ? m : m.id));
          return ids.some((id: string) => kws.every((k) => hay(p.provider, id).includes(k)));
        })
      : st.providers;
    return (
    <aside className="amw-sidebar">
      <div className="amw-sidebar-search">
        <div style={{ position: "relative" }}>
          <input className="amw-input" style={{ width: "100%", paddingRight: 26 }} placeholder="🔍 搜索 provider / 模型 id…（多词空格分隔）"
            value={treeQ} onChange={(e) => setTreeQ(e.target.value)} />
          {treeQ ? (
            <button className="amw-close" style={{ position: "absolute", right: 3, top: "50%", transform: "translateY(-50%)", width: 20, height: 20, fontSize: 13 }}
              onClick={() => setTreeQ("")} aria-label="清除搜索" title="清除搜索">✕</button>
          ) : null}
        </div>
        <button className="amw-btn" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={!!(checkupSt && checkupSt.running)}
          title="逐个已配置 provider 发一个真实探针（跳过聚合组/禁用/无凭据；结论留存，树上/详情显示延迟）"
          onClick={runCheckup}>
          {(checkupSt && checkupSt.running) ? "⏳ 体检中…" : "🩺 一键体检"}
        </button>
      </div>
      <div className="amw-sidebar-list">
        <div className="amw-group-label">{"已配置 · " + st.providers.length + (kws.length ? " · 过滤 " + provs.length + "/" + st.providers.length + " provider" : "")}</div>
        {checkAvail === false ? (
          <div style={{ padding: "0 8px 4px", fontSize: 11, color: "#d97706", lineHeight: 1.5, display: "flex", alignItems: "flex-start", gap: 4 }}>
            <span>⚠️ 检查未启用——可用性/余额不可见。请在「扩展管理」启用 aiti-model-check 后刷新。</span>
          </div>
        ) : chk ? (
          <div style={{ padding: "0 8px 4px", fontSize: 11, color: "var(--text-dim,#9ca3af)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", whiteSpace: "nowrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><span className="amw-vdot" style={{ background: "#16a34a" }} />可用</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><span className="amw-vdot" style={{ background: "#f59e0b" }} />限流</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><span className="amw-vdot" style={{ background: "#ef4444" }} />异常/欠费</span>
            <span title="运行期错误观测（带外）：代理真实流量里的非 2xx/3xx（429 限流/402 欠费/401 key 无效/5xx 等，带 key 归因），未探测也能看到">⚡ 运行异常</span>
            <span>无标 = 未测</span>
          </div>
        ) : null}
        {!provs.length ? (
          <div style={{ padding: "14px 8px", fontSize: 11, color: "var(--text-dim,#9ca3af)", textAlign: "center" }}>{"无匹配「" + treeQ.trim() + "」"}</div>
        ) : provs.map((p: any) => {
          const allIds = (p.models || []).map((m: any) => (typeof m === "string" ? m : m.id));
          // provider 名命中 → 全量模型；否则只显示命中的模型
          const pNameHit = !kws.length || kws.every((k) => hay(p.provider).includes(k));
          const ids = pNameHit ? allIds : allIds.filter((id: string) => kws.every((k) => hay(p.provider, id).includes(k)));
          const ni = newInfo && newInfo.providers && newInfo.providers[p.provider];
          const agg = aggCheck(p.provider);
          const bal = bals && bals[p.provider];
          const isProvSel = selNode?.type === "provider" && selNode.provider === p.provider;
          return (
            <div key={p.provider}>
              <button className="amw-sb-item" aria-current={isProvSel ? "page" : undefined}
                title={(p.baseUrl || "") + " · " + (p.api || "") + (bal && bal.text ? "\n💰 " + bal.text : "")}
                onClick={() => selectNode({ type: "provider", provider: p.provider })}>
                <ProviderAvatar id={p.provider} name={p.provider} size={16} radius={5} />
                <span className="amw-sb-text is-grow">{p.provider}</span>
                {probeBusy[p.provider] ? <span style={{ fontSize: 11, color: "#f59e0b", flexShrink: 0 }} title="探测中…">⏳</span>
                  : agg && (agg.ok || agg.rl || agg.err) ? (
                  <span style={{ fontSize: 11, display: "inline-flex", gap: 3, flexShrink: 0 }}>
                    {agg.ok > 0 ? <span style={{ color: "#16a34a", fontWeight: 600 }}>{agg.ok}✓</span> : null}
                    {agg.rl > 0 ? <span style={{ color: "#f59e0b", fontWeight: 600 }}>{agg.rl}限</span> : null}
                    {agg.err > 0 ? <span style={{ color: "#ef4444", fontWeight: 600 }}>{agg.err}✗</span> : null}
                  </span>
                ) : null}
                {(() => {
                  // 向导测试留存徽标（P1-A）：last-test.json 最近结论（延迟/通过/限流/失败）。
                  // model-check 已有该 provider 探测聚合时让位（避免同屏两套 ✓/✗ 语义打架）。
                  const lt = lastTestMap[p.provider];
                  if (!lt || (agg && (agg.ok || agg.rl || agg.err))) return null;
                  const age = lt.ts ? " · 测于 " + fmtTimeStr(lt.ts) : "";
                  const okTxt = lt.rateLimited ? "429 限流（key/端点正确）" : "通过";
                  if (lt.pass && !lt.partial) {
                    return <span style={{ fontSize: 10, color: lt.rateLimited ? "#d97706" : "#16a34a", fontWeight: 600, flexShrink: 0, cursor: "default" }}
                      title={"向导测试：" + okTxt + (lt.latencyMs != null ? " · " + fmtLat(lt.latencyMs) : "") + age + (lt.keyName ? " · key " + lt.keyName : "")}>
                      {lt.rateLimited ? "🟡" : "✓"}{lt.latencyMs != null ? " " + fmtLat(lt.latencyMs) : ""}</span>;
                  }
                  return <span style={{ fontSize: 10, color: lt.partial ? "#d97706" : "#dc2626", fontWeight: 600, flexShrink: 0, cursor: "default" }}
                    title={"向导测试：" + (lt.detail || (lt.partial ? "部分 key 失败" : "失败")) + age}>
                    {lt.partial ? "🟡" : "✗"}</span>;
                })()}
                {bal && bal.exhausted ? <span className="amw-chip is-err" title={bal.text || "余额不足"}>💸</span> : null}
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
                {p.enabled === false ? <span className="amw-tag" style={{ color: "#b45309", borderColor: "#f59e0b", background: "rgba(245,158,11,.14)" }} title="临时禁用中（配置未删除，点击详情页可重新启用）">⏸ 禁用</span> : null}
                {(() => {
                  // 树上禁用 key 数徽标：不点详情也能看到有 key 处于禁用态
                  const dis = (p.keys || []).filter((k: any) => k && k.enabled === false).length;
                  if (!dis) return null;
                  return <span style={{ fontSize: 9, flexShrink: 0, color: "#b45309", border: "1px solid rgba(245,158,11,.5)", background: "rgba(245,158,11,.12)", borderRadius: 5, padding: "0 4px", cursor: "default" }}
                    title={dis + " 把 key 临时禁用中（详情页「多 Key 轮转」可启用）"}>🔑⏸{dis}</span>;
                })()}
                {p.authType === "oauth" ? <span className="amw-tag is-oauth">🔐</span> : null}
                {p.runtime ? <span className="amw-tag is-ro">⚡ 运行时</span> : null}
                {ni && ni.count > 0 ? <span className="amw-tag is-new">{"+" + ni.count}</span> : null}
              </button>
              {ids.map((id: string) => {
                const isModelSel = selNode?.type === "model" && selNode.provider === p.provider && selNode.id === id;
                const probe = capProbes[p.provider + "/" + id];
                const mDef = (p.models || []).find((m: any) => (typeof m === "string" ? m : m && m.id) === id);
                const mEn = !(mDef && typeof mDef === "object" && mDef.enabled === false);
                return (
                  <button key={id} className="amw-sb-item is-indent" aria-current={isModelSel ? "page" : undefined}
                    onClick={() => selectNode({ type: "model", provider: p.provider, id })}>
                    <span className="amw-sb-text is-grow" style={{ color: mEn ? "var(--text-muted)" : "#b45309", ...(mEn ? {} : { textDecoration: "line-through", opacity: 0.55 }) }}>{id}</span>
                    {!mEn ? <span style={{ fontSize: 9, color: "#b45309", flexShrink: 0 }} title="临时禁用中（未删除，详情页可重新启用）">⏸</span> : null}
                    {checkDot(p.provider, id)}
                    {probe?.phase === "probing" ? <span style={{ fontSize: 9, color: "#f59e0b", flexShrink: 0 }} title="实测最大输出中">⏳</span> : null}
                    {probe?.phase === "done" && !probe.error ? <span style={{ fontSize: 9, color: "#10b981", flexShrink: 0 }} title={probe.corrected ? "实测已校正 maxTokens" : "实测通过"}>{probe.corrected ? "✓↓" : "✓"}</span> : null}
                    {probe?.phase === "done" && probe.error ? <span style={{ fontSize: 9, color: "#ef4444", flexShrink: 0 }} title={probe.error}>!</span> : null}
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
          <div className="amw-empty">← 从左侧选择 provider / 模型查看与编辑详情</div>
        </div>
      );
    }
    // 小屏钻取返回条（大屏无）
    const back = !small ? null : (
      <div className="amw-header" style={{ padding: "6px 10px" }}>
        <button className="amw-btn" onClick={() => selectNode(selNode.type === "model" ? { type: "provider", provider: selNode.provider } : null)}>← 返回</button>
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
            {probing ? <span style={{ fontSize: 11, color: "#f59e0b" }}>⏳ 探测中…</span>
              : checkAvail === false ? <span style={{ fontSize: 11, color: "#d97706" }}>⚠️ 检查未启用</span>
              : ck ? <span style={{ fontSize: 11, fontWeight: 600, color: ck.lastOk ? "#16a34a" : ck.rateLimited ? "#f59e0b" : "#ef4444" }}>{ck.lastOk ? "● 可用" : ck.rateLimited ? "● 限流" : "● 异常（可能欠费/失效）"}</span>
              : <span style={{ fontSize: 11, color: "var(--text-dim,#999)" }}>未测</span>}
            {(() => {
              const rt = rtOf(selNode.provider, selNode.id);
              if (!rt || !rt.count24h) return null;
              const hot = rt.count1h > 0;
              const info = rtErrInfo(rt.lastStatus);
              return (
                <span style={{ fontSize: 10.5, fontWeight: 600, color: hot ? "#dc2626" : info.color, cursor: "default" }}
                  title={rtTip(rt)}>
                  {info.icon + " 运行" + info.label + " ×" + rt.count24h + (hot ? "（1h×" + rt.count1h + "）" : "")}
                </span>
              );
 })()}
            <div style={{ flex: 1 }} />
            <button className="amw-btn" style={{ padding: "3px 8px" }} disabled={checkAvail === false || probing} title={checkAvail === false ? "需先启用 aiti-model-check（扩展管理）" : "探测此模型可用性"} onClick={() => void runCheck(selNode.provider, selNode.id)}>
              {probing ? "⏳ 探测中…" : (<><Ic size={12} paths={ICONS.stethoscope} /> 重检</>)}
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
      if (agg.ok) segs.push({ t: agg.ok + " 可用", c: "#16a34a" });
      if (agg.rl) segs.push({ t: agg.rl + " 限流", c: "#dc2626" });
      if (agg.err) segs.push({ t: agg.err + " 异常", c: "#d97706" });
      if (agg.pend) segs.push({ t: agg.pend + " 待测试", c: "#9ca3af" });
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
      if (n) segs.push({ t: "⚡ " + n + " 模型运行异常 ×" + c24 + "/24h" + (c1h ? "（1h×" + c1h + "）" : ""), c: c1h ? "#dc2626" : "#d97706" });
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
                {p.combo ? <span className="amw-tag is-combo">🧩 模型聚合</span> : null}
                {p.authType === "oauth" ? <span className="amw-tag is-oauth">🔐 订阅登录</span> : null}
                {p.runtime ? <span className="amw-tag is-ro">⚡ 运行时注册</span> : null}
                {ni && ni.count > 0 ? <span className="amw-tag is-new">{"✨ +" + ni.count}</span> : null}
              </div>
              <div style={{ fontSize: 11, display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                {segs.length ? segs.map((s, i) => <span key={i} style={{ color: s.c, fontWeight: 600 }}>{(i ? " · " : "") + s.t}</span>) : checkAvail === false ? <span style={{ color: "#d97706" }}>⚠️ 检查未启用（启用 aiti-model-check 后显示可用性）</span> : <span style={{ color: "var(--text-subtle,#999)" }}>未检查</span>}
                <span style={{ color: "var(--text-subtle,#999)" }}>{p.runtime ? ids.length + " 模型 · 扩展动态注册（只读）" : ids.length + " 模型 · " + (p.hasKey ? (p.keyCount > 1 ? p.keyCount + " keys" : "已配 key") : "⚠️ 无 key")}</span>
                {(() => {
                  // 禁用 key 计数徽标：禁用态只在「多 Key 轮转」折叠区可见，摘要层面
                  // 不提示的话"是否禁用"完全不可知（keys 由 /status 带出，maskKeyEntry 保留 enabled）
                  const dis = (p.keys || []).filter((k: any) => k && k.enabled === false).length;
                  if (!dis) return null;
                  return <span className="amw-tag" style={{ color: "#b45309", borderColor: "#f59e0b", background: "rgba(245,158,11,.14)" }}
                    title={"有 " + dis + " 把 key 临时禁用中（不参与轮转，配置未删除）——展开下方「多 Key 轮转」可查看 / 一键启用"}>🔑⏸ {dis} 禁用</span>;
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
                        <span>🩺 尚未测试连接（点右侧「测试」验证 key/端点，结论将留存）</span>
                      </span>
                    );
                  }
                  return (
                    <span style={{ width: "100%", display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", rowGap: 3 }}>
                      {/* ① 向导测试结论（留存）+ 重测 */}
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <span style={{ color: !lt ? "var(--text-subtle,#999)" : lt.pass ? (lt.rateLimited ? "#d97706" : "#16a34a") : lt.partial ? "#d97706" : "#dc2626", fontWeight: 600 }}
                          title={lt ? ("上次向导测试：" + (lt.detail || "") + (lt.ts ? " · 测于 " + fmtTimeStr(lt.ts) : "") + (lt.keyName ? " · key " + lt.keyName : "")) : "尚未用向导测过该 provider"}>
                          {"🩺 " + (!lt ? "未测" : lt.pass && !lt.partial ? (lt.rateLimited ? "🟡 429 通过" : "✓ 通过") : lt.partial ? "🟡 部分 key 失败" : "✗ 失败") + (lt && lt.latencyMs != null ? " · " + fmtLat(lt.latencyMs) : "")}
                        </span>
                        <button className="amw-btn" style={{ padding: "1px 8px", fontSize: 10.5 }} disabled={!!(qt && qt.busy)}
                          title="用已存凭据发一个真实探针（多 key 逐把测）；结论自动留存并更新树上徽标"
                          onClick={() => void runQuickTest(p)}>{qt && qt.busy ? "⏳ 测试中…" : "重测"}</button>
                      </span>
                      {/* ② 余额：provider-usage 优先；qt.res 测试反馈行内展示 */}
                      {us && us.phase === "ok" && us.entry && us.entry.status === "ready" && uText ? (
                        <span style={{ color: uBad ? "#dc2626" : "var(--text-subtle,#999)", fontWeight: uBad ? 600 : 400, cursor: "default" }}
                          title={(us.entry.report && Array.isArray(us.entry.report.buckets) ? us.entry.report.buckets.map((b: any) => (b.label || b.id) + ": " + [b.used != null ? "已用 " + b.used : "", b.remaining != null ? "余 " + b.remaining : "", b.limit != null ? "限 " + b.limit : ""].filter(Boolean).join("/")).join("\n") : "")
                            + (us.capturedAt ? "\n更新于 " + fmtTimeStr(us.capturedAt) + "（服务端缓存 5 分钟）" : "")}>
                          {"💰 " + (uBad ? "额度受限：" : "余额：") + uText}
                        </span>
                      ) : us && us.phase === "loading" ? <span style={{ color: "var(--text-subtle,#999)" }}>💰 余额查询中…</span>
                        : us && (us.phase === "err" || (us.phase === "ok" && us.error)) ? (
                          <span style={{ display: "inline-flex", gap: 5, alignItems: "center", color: "#d97706" }}>
                            <span title={us.message || us.error}>💰 余额暂不可用</span>
                            <button className="amw-btn" style={{ padding: "1px 8px", fontSize: 10.5 }} onClick={() => void loadUsage(p.provider, true)}>重查</button>
                          </span>
                        ) : us && us.phase === "na" ? null
                        : (bal || bad) ? (
                          <span style={{ color: balBad ? "#dc2626" : "var(--text-subtle,#999)", fontWeight: balBad ? 600 : 400 }}>
                            {"💰 " + (bal && bal.exhausted ? "已欠费/余额不足" : bad ? "存在异常模型（可能欠费/失效）" : (bal && bal.text) || "正常")}
                          </span>
                        ) : null}
                      {qt && qt.res ? testBadge(qt.res) : null}
                    </span>
                  );
                })()}
              </div>
            </div>
            <button className="amw-btn" style={{ padding: "3px 8px" }} disabled={checkAvail === false || !!probeBusy[p.provider]} title={checkAvail === false ? "需先启用 aiti-model-check（扩展管理）" : "发起可用性探测（更新树上的 可用/限流/异常 标记，可能需数十秒）"} onClick={() => void runCheck(p.provider)}>
              {probeBusy[p.provider] ? "⏳ 探测中…" : (<><Ic size={12} paths={ICONS.stethoscope} /> 重检</>)}
            </button>
            {p.runtime ? null : <button className="amw-btn" style={{ padding: "3px 8px" }} title="刷新该 provider 的运行中代理（改 models.json / 多 key 后立即生效，不重启会话）" onClick={() => doRefreshProxies(p.provider)}><Ic size={12} paths={ICONS.refresh} /></button>}
            {p.runtime || p.authType === "oauth" ? null : (
              <button className="amw-btn" style={{ padding: "3px 8px", ...(p.enabled === false ? { color: "#b45309", borderColor: "#f59e0b", background: "rgba(245,158,11,.12)" } : {}) }}
                title={p.enabled === false ? "临时禁用中——模型已从列表隐藏、代理已停（配置未删除）。点击重新启用" : "临时禁用（不删除配置）：模型从列表隐藏、代理停止，随时可一键启用"}
                onClick={() => doToggleProvider(p.provider, p.enabled === false)}>
                {p.enabled === false ? "▶ 启用" : "⏸ 禁用"}
              </button>
            )}
            {p.runtime ? null : <button className="amw-btn is-danger" style={{ padding: "3px 8px" }} title="删除 provider" onClick={() => doDelete(p.provider)}><Ic size={12} paths={ICONS.trash} /></button>}
          </div>
          {p.combo ? (
            <div className="amw-note" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1 }}>🧩 聚合组成员 / 权重 / 粘性在「模型聚合」页编辑</span>
              <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => { setTab("combo"); loadCombos(); }}>去编辑</button>
            </div>
          ) : null}
          {p.authType === "oauth" ? (
            <div className="amw-note" style={{ marginBottom: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flex: 1 }}>🔐 登录态 / 账号额度在「订阅服务」页管理</span>
              <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} onClick={() => { setTab("subs"); loadSubs(); }}>去管理</button>
            </div>
          ) : null}
          {p.runtime ? (
            <div className="amw-note" style={{ marginBottom: 0 }}>⚡ 运行时注册 provider：由 pi 扩展（如 pi-freeflow）动态注册，模型经 /api/models 实时可见；不受 models.json 管理，这里只读展示。</div>
          ) : null}
          {!p.combo ? renderEditControls(p) : null}
        </div>
      </div>
    );
  };

  const renderStatus = () => {
    if (!st) return <div className="amw-note">加载中…</div>;
    if (!st.providers.length) return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
        <div className="amw-note" style={{ marginBottom: 0 }}>{"还没有配置任何 provider —— 点下方按钮搜索或贴 API 地址添加。models.json：" + (st.file || "")}</div>
        <button className="amw-btn is-primary" onClick={() => { setTab("add"); setMsg(""); }}>＋ 添加 provider</button>
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
                {"🛠 一键整理（基于 " + new Date(cleanupEdit.ts).toLocaleTimeString("zh-CN", { hour12: false }) + " 模型检查）：已按探测结果预选——硬性异常取消勾选，限流/未测/暂时性错误保留"}
              </span>
              {cleanupBusy ? (
                <span style={{ fontSize: 12, color: "var(--accent,#2563eb)", fontWeight: 600 }}>{"💾 保存中 " + (cleanupBusy.done + 1) + "/" + cleanupBusy.total + " · " + cleanupBusy.cur + "…"}</span>
              ) : (
                <>
                  <button className="amw-btn is-ok" disabled={busy || !cleanupPending.length}
                    title={cleanupPending.length ? "逐个保存有改动的 provider（写 models.json + 刷新代理，立即生效）" : "没有需要保存的改动（无硬性异常模型）"}
                    onClick={cleanupSaveAll}>{"💾 全部保存（" + cleanupPending.length + " 家有改动）"}</button>
                  <button className="amw-btn" disabled={busy || !!cleanupBusy} title="放弃本次预选（不保存任何改动）" onClick={cleanupCancel}>取消</button>
                </>
              )}
            </div>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
              {cleanupEdit.plan.map((e: any) => (
                <div key={e.provider} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11.5, padding: "2px 0" }}>
                  <span style={{ fontWeight: 650 }}>{e.provider}</span>
                  {e.skip === "combo" ? <span style={{ color: "var(--text-subtle,#666)" }}>🧩 聚合组——不参与（在「聚合」页管理）</span>
                    : e.skip === "oauth" ? <span style={{ color: "var(--text-subtle,#666)" }}>🔐 订阅登录——不参与（凭据由登录流程管理）</span>
                    : e.skip === "runtime" ? <span style={{ color: "var(--text-subtle,#666)" }}>⚡ 运行时注册——不参与（由扩展动态注册，只读）</span>
                    : e.saved ? <span style={{ color: "#16a34a", fontWeight: 600 }}>✅ 已保存</span>
                    : <>
                      <span style={{ color: "#16a34a" }}>{"保留 " + e.keep.length}</span>
                      {e.remove.length ? (
                        <span style={{ color: "#dc2626" }} title={"保存后将从 models.json 删除：" + e.remove.map((r: any) => r.id + "（" + r.label + "）").join("、")}>
                          {"移除 " + e.remove.length + "：" + e.remove.slice(0, 4).map((r: any) => r.id + "（" + r.label + "）").join("、") + (e.remove.length > 4 ? " 等" : "")}
                        </span>
                      ) : null}
                      {e.soft.length ? (
                        <span style={{ color: "#d97706" }} title={"暂时性错误（服务端/网络/超时类），默认保留——如确认不再需要，可在编辑区手工取消勾选：" + e.soft.map((r: any) => r.id + "（" + r.label + "）").join("、")}>
                          {"⚠️ 暂时异常 " + e.soft.length + " 保留"}
                        </span>
                      ) : null}
                      {e.remove.length && !e.keep.length ? (
                        <span style={{ color: "#dc2626", fontWeight: 600 }} title="该 provider 下所有模型都是硬性异常：请检查 key/余额后重测，或确认后整家删除">⚠️ 全部硬性异常——未预选（编辑区手工处理）</span>
                      ) : null}
                      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
                        <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11 }} title="展开该 provider 编辑区（已按预选勾好，可再调整后保存）" onClick={() => openEdit(e.provider)}>编辑</button>
                        {e.remove.length && e.keep.length ? (
                          <button className="amw-btn is-ok" style={{ padding: "2px 10px", fontSize: 11 }} disabled={busy || !!cleanupBusy} onClick={() => cleanupSaveOne(e)}>💾 保存</button>
                        ) : null}
                      </span>
                    </>}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-subtle,#666)" }}>
              预选只改勾选状态，不写配置——逐家或「全部保存」后才写入 models.json 并刷新代理（可撤销：保存后点「↩ 撤销上次保存」）
            </div>
          </div>
        ) : null}
        {niRows.length ? (
          <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 10, background: "rgba(34,197,94,.1)", border: "1px solid rgba(34,197,94,.4)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: "#15803d", flex: 1 }}>{"✨ 发现 " + niTotal + " 个新模型"}</span>
              <button className="amw-btn" style={{ padding: "3px 10px", fontSize: 11 }} title="清除提醒，不再标注这些新模型" onClick={() => ackNew()}>知道了</button>
            </div>
            {niRows.map(([name, v]: any) => {
              const all = v.newModels || [];
              return (
                <div key={name} style={{ marginTop: 8, padding: "7px 9px", background: "rgba(255,255,255,.6)", borderRadius: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 650, fontSize: 12, color: "#15803d", flex: 1 }}>{name + " · 新增 " + v.count}</span>
                    <button disabled={nmBusy === name || !all.length} onClick={() => selAllNew(name, all)} title="勾选全部新模型" className="amw-btn" style={{ padding: "2px 8px", fontSize: 11 }}>全选</button>
                    <button disabled={nmBusy === name || !all.length} onClick={() => selInvNew(name, all)} title="在全部新模型范围内反选" className="amw-btn" style={{ padding: "2px 8px", fontSize: 11 }}>反选</button>
                    <button disabled={nmBusy === name || !all.length} onClick={() => selNoneNew(name)} title="全部取消勾选（不启用）" className="amw-btn" style={{ padding: "2px 8px", fontSize: 11 }}>清空</button>
                    <button disabled={nmBusy === name || !all.length}
                      onClick={() => enableNewModels(name, nmSel[name] !== undefined ? nmSel[name] : all)}
                      className="amw-btn" style={{ background: nmBusy === name ? "#9ca3af" : "#16a34a", color: "#fff", border: "none", borderRadius: 6, padding: "3px 10px", fontSize: 11, fontWeight: 650, cursor: "pointer" }}>
                      {nmBusy === name ? "启用中…" : "⚡ 启用所选"}
                    </button>
                    <button onClick={() => openEdit(name)} title="展开编辑该 provider（可看全部模型/改 key）" className="amw-btn" style={{ padding: "3px 10px", fontSize: 11 }}>编辑</button>
                    <button disabled={nmBusy === name || !all.length}
                      onClick={() => ignoreNew(name)} title="忽略该 provider 的这些新模型（其他 provider 下次继续提醒）"
                      className="amw-btn" style={{ padding: "3px 10px", fontSize: 11 }}>忽略</button>
                  </div>
                  {all.map((id: string) => {
                    const md = (nmMeta[name] || {})[id] || null;
                    const tags = [];
                    if (md && md.contextWindow) tags.push(fmtTok(md.contextWindow) + " ctx");
                    if (md && md.maxTokens) tags.push(fmtTok(md.maxTokens) + " out");
                    if (md && md.reasoning) tags.push("推理");
                    if (md && Array.isArray(md.input)) tags.push(md.input.join("/"));
                    return (
                      <label key={id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, padding: "2px 0 2px 2px", cursor: "pointer" }}>
                        <input type="checkbox" checked={isSel(name, id)} onChange={() => toggleSel(name, id, all)} />
                        <span className="amw-mono" style={{fontWeight: 600}}>{id}</span>
                        {tags.length ? <span style={{ color: "#6b7280", fontSize: 10 }}>{tags.join(" · ")}</span> : null}
                      </label>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ color: "var(--text-subtle,#666)", fontSize: 11, flex: 1 }}>{"已配置 " + st.providers.length + " 个 provider · " + st.file}</span>
          {undoInfo ? <button className="amw-btn" style={{ padding: "2px 10px", fontSize: 11, color: "#b45309" }} title={"撤销上次保存（" + undoInfo + "）——恢复保存前的 provider 条目"} onClick={undoSave}>↩ 撤销上次保存</button> : null}
          <button className="amw-btn" title="从 models.json 重新加载所有运行中代理的槽位配置（多 key / 聚合改动后立即生效，不重启会话）" onClick={() => doRefreshProxies()}><Ic size={12} paths={ICONS.refresh} /> 刷新代理</button>
          <button className="amw-btn" onClick={loadStatus} disabled={busy}>刷新</button>
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
    try { const d = await (await api("/free-models")).json(); setFreeItems(d && d.ok ? Object.entries(d.items || {}).map(([id, it]: any) => ({ id, ...it })) : []); } catch { setFreeItems([]); } finally { setFreeLoading(false); }
  }, []);
  const freeAction = useCallback(async (id: string, action: string) => {
    setFreeBusy(id + ":" + action); setFreeMsg(""); setFreeConfirm("");
    try {
      const d = await (await api("/free-install", { method: "POST", ...jsonBody({ id, action }) })).json();
      if (!d.ok) setFreeMsg("❌ " + (d.error || "操作失败"));
      else setFreeMsg("✅ " + (d.message || "已完成"));
    } catch (err: any) { setFreeMsg("❌ " + (err?.message || String(err))); } finally { setFreeBusy(""); loadFree(); }
  }, [loadFree]);

  const loadCombos = useCallback(async () => {
    try { const d = await (await api("/combos")).json(); setComboData(d && d.ok ? d : null); } catch {}
  }, []);
  const comboPoolMap = new Map<string, any>();
  for (const m of (comboData?.members || [])) comboPoolMap.set(m.provider + "/" + m.model, m);

  // 编辑器内：单个虚拟模型的差异告警分级（🔴阻止 / 🟡需勾选确认 / 🟢提示）
  const comboWarns = (vm: any): { block: string[]; warn: string[]; hint: string[] } => {
    const block: string[] = [], warn: string[] = [], hint: string[] = [];
    if (!vm.members.length) block.push("至少一个成员");
    else if (!vm.members.some((r: any) => r.enabled !== false)) block.push("所有成员已禁用——至少保留一个启用的成员（临时全停请用聚合组级禁用）");
    const metas = vm.members.map((r: any) => comboPoolMap.get(r.provider + "/" + r.model)).filter(Boolean);
    if (metas.length !== vm.members.length) block.push("存在已失效的成员引用");
    const apis = [...new Set(metas.map((m: any) => m.api))];
    if (apis.length > 1) block.push("跨协议成员（" + apis.join(" vs ") + "）——仅支持同协议聚合");
    const ctxs = metas.map((m: any) => m.contextWindow).filter((x: any) => typeof x === "number");
    if (ctxs.length >= 2 && Math.min(...ctxs) < Math.max(...ctxs) / 2) warn.push("上下文窗口悬殊（最矮 < 最高一半）：取最小值，长会话可能提前裁剪");
    const outs = metas.map((m: any) => m.maxTokens).filter((x: any) => typeof x === "number");
    if (outs.length >= 2 && Math.min(...outs) * 1.2 < Math.max(...outs)) warn.push("最大输出差异 >20%：取最小值");
    const vis = metas.map((m: any) => (m.input || []).includes("image"));
    if (vis.length >= 2 && vis.some((v: boolean) => v !== vis[0])) warn.push("能力不一致（部分成员无 vision）：带图请求会自动避开无 vision 成员");
    if (vis.length >= 1 && vis.every((v: boolean) => !v) && vm.members.length >= 1) hint.push("全部成员均无 vision：不能处理图片输入");
    // —— types（承接类别）——
    const enabledRefs = vm.members.filter((r: any) => r.enabled !== false);
    // ① 无成员承接纯文本：全部启用成员都显式排除了 text（仅图形/仅媒体）→ 纯文本请求无成员可用
    const hasText = enabledRefs.some((r: any) => !Array.isArray(r.types) || r.types.length === 0 || r.types.includes("text"));
    if (enabledRefs.length >= 1 && !hasText) warn.push("无成员承接纯文本请求（全部仅图形/仅媒体）：不带图的会话将无可用成员——确认仍要保存？");
    // ② 死配置：types 含 vision 但模型 input 无 image → 带图请求仍被能力过滤排除，勾选永不生效
    for (const r of enabledRefs) {
      if (Array.isArray(r.types) && r.types.includes("vision")) {
        const m = comboPoolMap.get(r.provider + "/" + r.model);
        if (m && !(m.input || []).includes("image")) warn.push(`成员 ${r.provider}/${r.model} types 含「图形」但模型不支持图片输入——带图请求仍会被能力过滤排除，该勾选不会生效`);
      }
    }
    return { block, warn, hint };
  };

  const renderCombos = () => {
    const ed = comboEditor;
    const pool = comboData?.members || [];
    const doSaveCombo = async () => {
      if (!ed) return;
      setBusy(true);
      try {
        const d = await (await api("/combo-save", { method: "POST", ...jsonBody({ provider: String(ed.provider || "").trim() || String(ed.displayName || "").trim(), displayName: ed.displayName, renameFrom: ed.renameFrom, models: ed.models }) })).json();
        if (!d.ok) { setMsg("❌ " + (d.error || "保存失败")); return; }
        setComboEditor(null); setMsg("✅ 聚合组已保存：" + d.provider + "（" + d.modelCount + " 个虚拟模型）——已刷新运行中代理，新会话模型列表立即可见");
        await loadCombos(); loadStatus();
        // 广播模型变更 → pi-web 刷新模型列表（新会话 dropdown 立即出现聚合模型）
        try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {}
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
      // 每个「含 🟡 警告」的虚拟模型都必须单独勾选确认（ed.confirmDiff 是无效字段——此前导致保存永远被禁）
      const needConfirm = ed.models.some((vm: any) => { const w = comboWarns(vm); return w.warn.length > 0 && !vm.confirmDiff; });
      const canSave = !nameBad && !idEmpty && !idDup && allBlock.length === 0 && !needConfirm;
      return (
        <div>
          <div style={{ marginBottom: 6 }}>
            <button className="amw-btn" onClick={() => setComboEditor(null)}>← 返回列表</button>
          </div>
          <div className="amw-hint-lg" style={{ marginBottom: 8 }}>虚拟模型 = 多个真实成员组成一个可调用模型；同会话粘性路由（TTL 内固定同一成员，最大化 prompt cache），429 冷却自动切换</div>
          <div className="amw-card" style={{ padding: "10px 12px", marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 650, whiteSpace: "nowrap" }}>聚合组名称</span>
              <input className="amw-input" style={{flex: "1 1 140px", minWidth: 120}} value={ed.displayName} placeholder="显示名（如：快速组）"
                onChange={(e) => setComboEditor({ ...ed, displayName: e.target.value })} />
              <span style={{ fontSize: 12, fontWeight: 650, whiteSpace: "nowrap" }}>provider id</span>
              <input className="amw-input" style={{width: 160, minWidth: 120, fontFamily: "ui-monospace,monospace"}} value={ed.provider} placeholder="留空=同显示名"
                onChange={(e) => setComboEditor({ ...ed, provider: e.target.value })} />
            </div>
            {nameBad ? <div style={{ fontSize: 11, color: "#dc2626", marginTop: 4 }}>🔴 显示名 / provider id 至少填一个</div> : null}
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
                  <span style={{ fontSize: 12, fontWeight: 650, whiteSpace: "nowrap" }}>虚拟模型 id</span>
                  <input className="amw-input" style={{width: small ? 130 : 200, minWidth: 110, fontFamily: "ui-monospace,monospace"}} value={vm.id} placeholder="如 fast"
                    onChange={(e) => setVm(i, { id: e.target.value })} />
                  {String(vm.id || "").trim() && (String(ed.provider || "").trim() || String(ed.displayName || "").trim()) ? (
                    <span style={{ fontSize: 11, color: "var(--text-subtle,#888)" }}>
                      模型列表中将显示：<b className="amw-mono" style={{ color: "#4f46e5" }}>{(String(ed.provider || "").trim() || String(ed.displayName || "").trim())}/{String(vm.id).trim()}</b>
                    </span>
                  ) : null}
                  <span style={{ fontSize: 11, color: "var(--text-subtle,#888)", flex: 1 }}>{apis.length === 1 ? "协议 " + apis[0] : apis.length ? "⚠️ 混合协议" : ""}</span>
                  <button className="amw-btn" style={{ padding: "3px 8px", ...(vm.enabled === false ? { color: "#16a34a", borderColor: "#22c55e" } : { color: "#d97706", borderColor: "#f59e0b" }) }}
                    title={vm.enabled === false ? "临时禁用中（此虚拟模型从列表隐藏，配置未删除）——点击重新启用" : "临时禁用此虚拟模型（从模型列表隐藏，不删除配置，随时可启用）"}
                    onClick={() => setVm(i, { enabled: vm.enabled === false ? undefined : false })}>
                    {vm.enabled === false ? "▶ 启用" : "⏸ 禁用"}
                  </button>
                  {ed.models.length > 1 ? <button className="amw-btn is-danger" style={{ padding: "3px 8px" }} onClick={() => setComboEditor({ ...ed, models: ed.models.filter((_: any, j: number) => j !== i) })}>删模型</button> : null}
                </div>
                {/* 自动计算预览 */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                  {[ctxs.length ? "ctx ⌊" + Math.min(...ctxs) / 1000 + "k⌋" : null,
                    outs.length ? "输出 ⌊" + Math.min(...outs) + "⌋" : null,
                    inputs.size ? "能力 " + [...inputs].join("+") : null,
                    vm.stickyTtlMin ? "粘性 TTL " + vm.stickyTtlMin + "min" : "粘性 TTL 15min(默认)"].filter(Boolean).map((t: any, j: number) => (
                    <span key={j} className="amw-pill">{t}</span>
                  ))}
                </div>
                {/* 成员列表（行内显示参数并标注拖后腿的异常成员） */}
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
                    <div key={mi} title={!rEn ? "临时禁用中（不参与路由，配置未删除）" : abnormal
                      ? (isCtxMin ? "⚠️ 上下文最短：把组合 contextWindow 拉低到 " + fmtK(cw) + "（长会话可能提前裁剪）" : "")
                        + (isOutMin ? " ⚠️ 最大输出最小：" + fmtK(ot) : "")
                        + (noVision ? " ⚠️ 无 vision：带图请求会自动避开它" : "")
                      : "ctx=" + fmtK(cw) + " · out=" + fmtK(ot)}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 8, background: "rgba(127,127,127,.06)", marginBottom: 4, flexWrap: small ? "wrap" : "nowrap",
                        ...(abnormal && rEn ? { boxShadow: "inset 0 0 0 1.5px rgba(217,119,6,.55)", background: "rgba(217,119,6,.06)" } : {}),
                        ...(!rEn ? { boxShadow: "inset 0 0 0 1.5px rgba(245,158,11,.5)", background: "rgba(245,158,11,.08)" } : {}) }}>
                      <ProviderAvatar id={r.provider} name={r.provider} size={20} radius={6} />
                      <span style={{ fontSize: 12, fontWeight: 600, flex: "0 0 auto", ...(!rEn ? { color: "#b45309" } : {}) }}>{r.provider}</span>
                      <span className="amw-mono" style={{ fontSize: 12, flex: 1, minWidth: small ? 140 : 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...(!rEn ? { color: "#b45309", textDecoration: "line-through", opacity: 0.7 } : {}) }} title={meta ? "ctx=" + (meta.contextWindow ?? "?") + " · out=" + (meta.maxTokens ?? "?") + " · keys=" + meta.keyCount : "已失效"}>{r.model}</span>
                      {!rEn ? <span style={{ fontSize: 9, color: "#b45309", fontWeight: 700, flexShrink: 0 }}>⏸ 禁用</span> : null}
                      {meta ? <>
                        <span title="上下文窗口" className="amw-mono" style={{ fontSize: 10, color: isCtxMin ? "#d97706" : "var(--text-subtle,#888)", fontWeight: isCtxMin ? 700 : 400, background: isCtxMin ? "rgba(217,119,6,.14)" : "transparent", padding: "0 4px", borderRadius: 6, flexShrink: 0 }}>{"ctx " + fmtK(cw)}{isCtxMin ? " ⚠" : ""}</span>
                        <span title="最大输出" className="amw-mono" style={{ fontSize: 10, color: isOutMin ? "#d97706" : "var(--text-subtle,#888)", fontWeight: isOutMin ? 700 : 400, background: isOutMin ? "rgba(217,119,6,.14)" : "transparent", padding: "0 4px", borderRadius: 6, flexShrink: 0 }}>{"out " + fmtK(ot)}{isOutMin ? " ⚠" : ""}</span>
                        {(meta.input || []).includes("image") ? <span style={{ fontSize: 10, color: "#15803d", fontWeight: 650, flexShrink: 0 }}>👁 vision</span> : noVision ? <span style={{ fontSize: 10, color: "#d97706", fontWeight: 700, flexShrink: 0 }}>无 vision ⚠</span> : null}
                        {meta.reasoning ? <span style={{ fontSize: 10, color: "#7c3aed", fontWeight: 650, flexShrink: 0 }}>🧠 推理</span> : null}
                        <span style={{ fontSize: 10, color: "var(--text-subtle,#999)", flexShrink: 0 }}>{meta.keyCount + " key"}</span>
                      </> : <span style={{ fontSize: 10, color: "#dc2626", fontWeight: 650 }}>已失效</span>}
                      <span style={{ fontSize: 11, color: "var(--text-subtle,#777)", whiteSpace: "nowrap", flexShrink: 0 }}>权重</span>
                      <input type="number" min={1} step={1} className="amw-input" disabled={!rEn} style={{width: 64, padding: "3px 6px", flexShrink: 0}} value={r.weight ?? 10}
                        title="默认 10；按权重占比随机选点（成员级）"
                        onChange={(e) => { const v = Math.max(1, Math.floor(Number(e.target.value) || 1)); const members = vm.members.map((x: any, j: number) => j === mi ? { ...x, weight: v } : x); setVm(i, { members }); }} />
                      <span style={{ fontSize: 11, color: "var(--text-subtle,#777)", whiteSpace: "nowrap", flexShrink: 0 }} title="该成员承接哪些请求类别（按模型能力自动过滤：没声明的能力不显示可勾选项；全部勾选 = 承接全部，与不限定等价）">承接</span>
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
                          {chip("text", "文本", textOn, !hasVision, hasVision ? "取消 = 该成员只接带图请求（仅图形）" : "基础类别：所有模型都处理纯文本，不可取消")}
                          {hasVision ? chip("vision", "图形", visionOn, false, "取消 = 该成员不收带图请求（仅文本）") : null}
                        </>;
                      })()}
                      {!(Array.isArray(r.types) && r.types.length > 0)
                        ? <span style={{ fontSize: 10, color: "var(--text-subtle,#999)", whiteSpace: "nowrap", flexShrink: 0 }} title="全部可勾类别已勾选 = 承接全部请求（与不限定等价；将来新增类别自动承接）">全收</span>
                        : null}
                      <button className="amw-btn" style={{ padding: "2px 7px", flexShrink: 0, ...(rEn ? { color: "#d97706", borderColor: "#f59e0b" } : { color: "#16a34a", borderColor: "#22c55e" }) }}
                        title={rEn ? "临时禁用此成员（不参与路由，配置未删除，随时可启用）" : "重新启用此成员（恢复参与路由）"}
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
                  <span style={{ fontSize: 11, color: "var(--text-subtle,#777)", whiteSpace: "nowrap" }}>粘性空闲 TTL（分钟，默认 15）</span>
                  <input type="number" min={1} className="amw-input" style={{width: 72, padding: "3px 6px"}} value={vm.stickyTtlMin ?? ""} placeholder="15"
                    onChange={(e) => setVm(i, { stickyTtlMin: e.target.value ? Math.max(1, Math.floor(Number(e.target.value) || 15)) : undefined })} />
                </div>
                {/* 警告分级 */}
                {w.block.map((t: string, j: number) => <div key={j} style={{ fontSize: 11, color: "#dc2626", marginTop: 4 }}>🔴 {t}</div>)}
                {w.warn.length ? (
                  <div style={{ marginTop: 6 }}>
                    {w.warn.map((t: string, j: number) => <div key={j} style={{ fontSize: 11, color: "#d97706" }}>🟡 {t}</div>)}
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 4, fontSize: 11, cursor: "pointer", color: "#d97706", fontWeight: 600 }}>
                      <input type="checkbox" checked={!!vm.confirmDiff} onChange={(e) => setVm(i, { confirmDiff: e.target.checked })} />
                      我已知悉上述差异，仍要保存
                    </label>
                  </div>
                ) : null}
                {w.hint.map((t: string, j: number) => <div key={j} style={{ fontSize: 11, color: "var(--text-subtle,#888)", marginTop: 4 }}>🟢 {t}</div>)}
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="amw-btn" onClick={() => setComboEditor({ ...ed, models: [...ed.models, { id: "", members: [], confirmDiff: false }] })}>＋ 加一个虚拟模型</button>
            <div style={{ flex: 1 }} />
            {allWarn.length ? <span style={{ fontSize: 11, color: "#d97706" }}>{allWarn.length} 项差异待确认</span> : null}
            <button className="amw-btn is-primary" style={{ opacity: canSave ? 1 : 0.45 }} disabled={!canSave || busy} onClick={doSaveCombo}>💾 保存聚合组</button>
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
            <button className="amw-btn is-primary" onClick={() => setComboEditor({ provider: "", displayName: "", models: [{ id: "", members: [] }] })}>＋ 新建聚合组</button>
            <button className="amw-btn" title="从 models.json 重新加载所有运行中代理的槽位配置（聚合/多key 改动后立即生效，不重启会话）"
              onClick={async () => { setBusy(true); try { const d = await (await api("/refresh", { method: "POST" })).json(); setMsg(d.ok ? "🔄 已刷新代理：" + ((d.refreshed || []).join(", ") || "(无)") : "❌ " + (d.error || "刷新失败")); try { window.dispatchEvent(new CustomEvent("pi-web:models-changed")); } catch {} } catch (e: any) { setMsg("❌ 刷新失败: " + (e?.message || e)); } finally { setBusy(false); } }}>
              <Ic size={12} paths={ICONS.refresh} /> 刷新代理</button>
            <div style={{ flex: 1 }} />
            <MultiKeyStatusSummary onOpen={() => setSStatusOpen(true)} />
          </div>
          <div className="amw-hint-lg">把多个真实模型聚成一个虚拟模型暴露给 pi；需要 pi-models-combo 引擎（多 key 代理）在运行时接管路由。同协议才能同组。</div>
        </div>
        {!combos.length ? <div className="amw-note">还没有聚合组。点「新建聚合组」把已配置的多个模型组合成一个虚拟模型。</div> : null}
        {combos.map((cb: any) => (
          <div key={cb.providerId} className="amw-card" style={{ marginBottom: 8, padding: "11px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>🧩</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 650, fontSize: 13 }}>{cb.name}</span>
                  {cb.enabled === false ? <span style={{ fontSize: 10, color: "#b45309", border: "1px solid rgba(245,158,11,.5)", borderRadius: 999, padding: "0 8px", fontWeight: 700 }}>⏸ 已禁用</span> : null}
                  <span className="amw-mono" style={{fontSize: 10, color: "var(--text-subtle,#999)"}}>{cb.providerId}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-subtle,#888)", marginTop: 3 }}>
                  {cb.models.length + " 个虚拟模型 · 协议 " + (cb.api || "?")}
                </div>
              </div>
              <button className="amw-btn" onClick={() => setComboEditor({
                provider: cb.providerId, displayName: cb.name, renameFrom: cb.providerId,
                models: cb.models.map((m: any) => ({ id: m.id, stickyTtlMin: m.stickyTtlMin ?? undefined, ...(m.enabled === false ? { enabled: false } : {}), members: (m.members || []).map((r: any) => ({ provider: r.provider, model: r.model, weight: r.weight, ...(Array.isArray(r.types) && r.types.length > 0 ? { types: r.types } : {}), ...(r.enabled === false ? { enabled: false } : {}) })) })),
              })}>编辑</button>
              <button className="amw-btn" style={{ padding: "3px 8px", ...(cb.enabled === false ? { color: "#16a34a", borderColor: "#22c55e" } : { color: "#d97706", borderColor: "#f59e0b" }) }}
                title={cb.enabled === false ? "临时禁用中（模型从列表隐藏、代理已停，配置未删除）——点击重新启用" : "临时禁用整个聚合组（不删除配置，模型从列表隐藏、代理停止，随时可一键启用）"}
                onClick={() => doToggleProvider(cb.providerId, cb.enabled === false)}>
                {cb.enabled === false ? "▶ 启用" : "⏸ 禁用"}
              </button>
              <button className="amw-btn is-danger" style={{ padding: "3px 8px" }} title="删除聚合组" onClick={() => doDelete(cb.providerId)}><Ic size={12} paths={ICONS.trash} /></button>
            </div>
            {cb.models.map((m: any) => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 7, padding: "6px 8px", borderRadius: 8, background: "rgba(127,127,127,.06)", ...(m.enabled === false ? { opacity: 0.62, boxShadow: "inset 0 0 0 1.5px rgba(245,158,11,.45)" } : {}) }}>
                <span className="amw-mono" style={{fontSize: 12, fontWeight: 700, color: m.enabled === false ? "#b45309" : "#4f46e5"}}>{cb.providerId}/{m.id}</span>
                {m.enabled === false ? <span style={{ fontSize: 10, color: "#b45309", fontWeight: 700 }}>⏸ 已禁用</span> : null}
                <span style={{ color: "var(--text-subtle,#aaa)", fontSize: 11 }}>＝</span>
                {(m.members || []).map((r: any, j: number) => (
                  <span key={j} className="amw-mono" style={{ padding: "2px 8px", borderRadius: 999, background: r.enabled === false ? "rgba(245,158,11,.10)" : "rgba(127,127,127,.09)", border: r.enabled === false ? "1px dashed #f59e0b" : "1px solid rgba(127,127,127,.18)", fontSize: 11, ...(r.enabled === false ? { color: "#b45309", textDecoration: "line-through" } : {}) }}>
                    {r.provider}/{r.model}{r.enabled === false ? " ⏸" : ""}{r.weight != null && r.weight !== 10 ? <b style={{ color: "#4f46e5" }}> ×{r.weight}</b> : null}
                    {Array.isArray(r.types) && r.types.length > 0
                      ? <span style={{ fontSize: 10, color: "#0891b2", fontWeight: 650 }}> [{r.types.map((x: string) => x === "text" ? "文本" : x === "vision" ? "图形" : "媒体").join("/")}]</span>
                      : null}
                  </span>
                ))}
              </div>
            ))}
          </div>
        ))}
        {sStatusOpen && <MultiKeyStatusDialog onClose={() => setSStatusOpen(false)} />}
      </div>
    );
  };

  // 免费模型页签：说明块（含免费效果声明）+ 卡片列表（名称/desc/note/npm/安装状态徽标 + 安装/更新/卸载）
  const renderFree = () => (
    <div>
      <div className="amw-note" style={{ marginBottom: 10 }}>
        <div>🎁 免费模型来自第三方 pi 扩展，安装即用、无需 API Key；安装后<b>新会话</b>生效。</div>
        <div style={{ marginTop: 4 }}>⚠️ 免费 AI 通常是<b>限流</b>或<b>降级</b>了的，除非赶上新模型测试大放送，一般效果不好——适合试用与轻量任务，重要工作请用付费模型。</div>
      </div>
      {freeMsg && <div className="amw-note" style={{ marginBottom: 8 }}>{freeMsg}</div>}
      {freeLoading && <div className="amw-note">加载中…</div>}
      {!freeLoading && !freeItems.length && <div className="amw-note">暂无免费模型（中心配置为空或加载失败）</div>}
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
                    ? <span style={{ marginLeft: 8, fontSize: 11, color: "#16a34a", border: "1px solid rgba(22,163,74,.35)", borderRadius: 999, padding: "1px 8px" }}>已安装 ✓</span>
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
                  {it.url ? <a href={it.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, opacity: 0.6 }} onMouseDown={(e: any) => e.stopPropagation()}>官网/仓库 ↗</a> : null}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {!it.installed && (
                  <button className="amw-btn is-primary" disabled={busy} onClick={() => freeAction(it.id, "install")}>
                    {busy ? "安装中…" : "安装"}
                  </button>
                )}
                {it.installed && (
                  <>
                    <button className="amw-btn" disabled={busy} title="重新安装最新版" onClick={() => freeAction(it.id, "update")}>{busy ? "…" : "更新"}</button>
                    <button className="amw-btn" disabled={busy} style={freeConfirm === it.id ? { color: "#dc2626", borderColor: "#dc2626" } : undefined}
                      title={freeConfirm === it.id ? "再点一次确认卸载" : "卸载（新会话起不再加载）"}
                      onClick={() => { if (freeConfirm === it.id) freeAction(it.id, "remove"); else setFreeConfirm(it.id); }}>
                      {busy ? "…" : freeConfirm === it.id ? "确认卸载" : "卸载"}
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
        ? <div className="amw-note">⏳ 正在加载模型检查（aiti-model-check）…</div>
        : <div className="amw-note">⚠️ 未能加载模型检查（aiti-model-check 拉起失败，请刷新页面重试）</div>;
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
    { key: "status", icon: ICONS.list, label: "模型列表", hint: "主视图", go: () => setTab("status") },
    { key: "add", icon: ICONS.plus, label: "添加 provider", hint: "目录/贴地址", go: () => setTab("add") },
    { key: "subs", icon: ICONS.key, label: "订阅登录", hint: "OAuth", go: () => { setTab("subs"); loadSubs(); } },
    { key: "free", icon: ICONS.gift, label: "免费模型", hint: "一键安装", go: () => { setTab("free"); loadFree(); } },
    { key: "combo", icon: ICONS.layers, label: "模型聚合", hint: "组合模型", go: () => { setTab("combo"); loadCombos(); } },
    { key: "check", icon: ICONS.stethoscope, label: "模型检查", hint: "可用性监测", go: () => { setTab("check"); loadCheck(); } },
  ] as any[]);
  const funcMenu = () => (
    <div style={{ position: "relative" }} ref={menuRef}>
      <button className="amw-btn amw-tb-btn" aria-haspopup="menu" aria-expanded={menuOpen} title="功能菜单（切换/返回各功能）" onClick={() => setMenuOpen(!menuOpen)}>☰<span className="amw-tb-label">功能</span>▾</button>
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
            <span style={{ flex: 1, textAlign: "left" }}>刷新全部代理</span>
            <span className="amw-menu-hint">即时生效</span>
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
        <span className="amw-title"><Ic size={15} paths={ICONS.wand} />{small ? null : <span className="amw-title-text">模型管理</span>}</span>
        <div className="amw-tabs">
          {[["status", "模型列表", ICONS.list], ["subs", "订阅", ICONS.key], ["free", "免费", ICONS.gift], ["combo", "聚合", ICONS.layers], ["check", "检查", ICONS.stethoscope]].map(([k, label, icon]: any) => (
            <button key={k} className={"amw-tab" + (tab === k ? " is-on" : "")} onClick={() => { setTab(k); setMsg(""); if (k === "status") { loadNewInfo(); loadCheck(); } if (k === "subs") loadSubs(); if (k === "free") loadFree(); if (k === "combo") loadCombos(); if (k === "check") loadCheck(); }}><Ic size={11} paths={icon} />{label}</button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button className="amw-btn amw-tb-btn" title="向导设置（新模型提醒 / 目录 / 探测与测试超时）" onClick={() => setCfgOpen(true)}><Ic size={13} paths={ICONS.settings} /></button>
          <button className="amw-btn amw-tb-btn" title="导出 provider 配置（脱敏 JSON——无明文 key，P2-A）" onClick={() => void doExport()}>⇩<span className="amw-tb-label">导出</span></button>
          <button className="amw-btn amw-tb-btn" title="导入 provider 配置（差异预览 + 批量保存，可 undo）" onClick={() => setImpDlg({ phase: "paste", text: "" })}>⇪<span className="amw-tb-label">导入</span></button>
          {funcMenu()}
          {tab === "add" ? (
            <button className="amw-btn is-primary amw-tb-btn" title="返回模型列表" onClick={() => { setTab("status"); setMsg(""); }} style={{ boxShadow: "inset 0 0 0 2px rgba(255,255,255,.5)" }}>
              ✓<span className="amw-tb-label"> 添加中</span>
            </button>
          ) : (
            <button className="amw-btn is-primary amw-tb-btn" title="添加 provider（目录搜索 / 贴地址）" onClick={() => { setTab("add"); setMsg(""); }}>
              ＋<span className="amw-tb-label"> 添加<span className="amw-label-long"> provider</span></span>
            </button>
          )}
          <button className="amw-btn" onClick={onClose} aria-label="关闭" title="关闭模型管理面板"><Ic size={12} paths={ICONS.x} /></button>
        </div>
      </div>
      <div key={"body-" + tab} className="amw-body" style={bodyStyle}>
        {busy ? <div style={{ color: "var(--text-subtle,#666)", marginBottom: 6 }}>处理中…</div> : null}
        {msg ? <div className="amw-note">{msg}</div> : null}
        {missingInfo && Array.isArray(missingInfo.models) && missingInfo.models.length ? (
          <div className="amw-note is-warn" style={{marginBottom: 8}}>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>{"⚠️ " + missingInfo.models.length + " 个模型在所有数据源都查不到参数（已落裸条目，pi 按 128k/16k 硬默认用）：" + missingInfo.models.map((m: any) => m.id).join("、")}</div>
            <div style={{ fontSize: 11, lineHeight: 1.7, color: "var(--text-subtle,#666)" }}>
              {"已自动唤起 AI 助手（skill：model-params-fill）正在上网查权威数据 → 写入 ~/.pi/agent/models-store.json → 回填参数弹窗。AI 完成后打开各模型「✎ 编辑参数」核对并保存；下次保存会自动反填。"}
              <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {missingInfo.models.map((m: any) => (
                  <button key={m.id} className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} onClick={() => void viewModelParams(missingInfo.provider, m.id, true)}>✎ {m.id}</button>
                ))}
                <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} title="重新弹出 AI 助手" onClick={() => invokeAiHelperForMissing(missingInfo.provider, missingInfo.models, rootRef.current)}>🤖 重新唤 AI</button>
                <button className="amw-btn" style={{ padding: "2px 9px", fontSize: 11 }} onClick={() => setMissingInfo(null)}>收起</button>
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
      title={newTotal ? "aiti-model-wizard：发现 " + newTotal + " 个新模型，点击查看" : "aiti-model-wizard：添加 AI 提供商/模型"}
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
    <DockBody itemKey={WIZARD_KEY} zone="right-panel" title="模型管理" chrome="tab"
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
  ctx.registerItems?.("rightFileDock", [{ id: "shell-v2", render: WizardDockFace, meta: { title: "模型管理" } }]);
  ctx.registerItems?.("pages", [{ id: "aiti-model-wizard-reminder", render: ReminderToast }]);
  ctx.registerItems?.("banners", [{ id: "aiti-model-wizard-banner", render: Banner }]);
  ctx.registerItems?.("sessionStats", [{ id: "aiti-model-wizard-multikey-status", render: MultiKeyStatusRows, meta: { label: "聚合 / 多key运行状态" } }]); // 与薄壳 entry 壳条目同 id：registerExtUiItems 幂等覆盖升级（薄壳直连版 → 完整版），重复注册天然收敛
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
        const av = await (await fetch(apiUrl("/api/extensions/aiti-model-check/availability"), { cache: "no-store" })).json();
        applyAvail(av);
      } catch { /* 无帧也无拉取 → 横幅不显示，等事件 */ }
    };
    // noModels 判定（挂载 / 模型配置变更 / 回前台）：拉 wizard/status 一次。
    // light=1：跳过服务端 runtime 合并（自 fetch /api/models ~350ms 主因）——
    // 这里只判 providers 空否；打开向导面板的 openTab("status") 走完整 /status。
    const checkModels = async () => {
      try {
        const d = await (await api("/status?light=1")).json();
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
      <span style={{ fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={14} paths={ICONS.wand} />{state.allUnavailable ? "所有模型都不可用" : "还没有可用模型"}</span>
      <span style={{ color: "var(--text-subtle,#666)" }}>{state.allUnavailable
        ? (avail ? "（" + avail.rateLimited + " 限流 · " + avail.errorCount + " 异常" + (avail.lastBlocked && avail.lastBlocked.marked ? " · 运行期被大量 429 阻断标记" : "") + "）检查记录看恢复时间，或换个模型" : "各模型均不可用（429 限流 / 出错），检查记录看恢复时间，或换个模型")
        : "添加 AI 提供商：搜索或贴 API 地址 → 填 token → 测试 → 选模型"}</span>
      {state.allUnavailable && hasCheck() ? <button className="amw-btn" style={{ background: "#dc2626", color: "#fff", padding: "3px 10px" }} onClick={openCheck}>查看模型检查</button> : null}
      <button className="amw-btn" style={{ background: "var(--accent,#2563eb)", color: "#fff", padding: "3px 10px" }} onClick={openWizard}>{state.allUnavailable ? "去换模型" : "去添加"}</button>
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
      setToast("✨ 发现 " + d.total + " 个新模型（" + names + (d.total > sum ? "…" : "") + "）· 点击查看");
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
      <span style={{ fontSize: 15 }}>✨</span>
      <span>{toast}</span>
      <span style={{ fontSize: 11, fontWeight: 500, opacity: .85, whiteSpace: "nowrap" }}>点击查看</span>
      <button
        title="知道了，不再提醒" aria-label="知道了，不再提醒"
        onClick={(e) => { e.stopPropagation(); dismiss(); }}
        style={{ background: "rgba(255,255,255,.18)", border: "none", color: "#fff", width: 20, height: 20,
          borderRadius: "50%", fontSize: 12, lineHeight: 1, cursor: "pointer", display: "flex",
          alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0 }}
      >✕</button>
    </div>
  );
}
