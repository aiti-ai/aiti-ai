/**
 * aiti-model-check · 模型可用性管理 UI（📡）—— JSX 版（自手写 h() 版迁移，功能一比一）。
 *
 * 功能：状态总览（✅ 可用 / 🔴 429限流(预计恢复) / ⚠️ 异常 / ⚪ 未探测）· 一键探测 · 历史时间线
 * 架构：toolbar 📡 按钮（feature 门控）→ 独立置顶 dialog（pages slot）；
 *       App 同时导出 window.__aitiModelCheckApp 供 aiti-model-wizard「检查」tab 内嵌。
 */
import { useState, useEffect, useCallback } from "react";
import { apiUrl, extSvc } from "./host-shim";
// dock v3（P3 批）：显隐收口展示状态机（P3 保守：无 default，左栏可选）
import { useGate, usePresent, DockBody, openFloat, closePanel, isSidebarDockState, sidebarZoneOf } from "../../../_shared/ext-float-dock";
// dock 头工具条 v3：face 声明按钮（探测/刷新），内容实现命令 + 状态上报
import { useDockCommands, useDockHeaderState, useDockHeaderStateOf, requestDockCommand, writeBlockCollapsed } from "../../../_shared/ext-float-dock";
import type { DockHeaderAction } from "../../../_shared/ext-float-dock";

export const MC_KEY = "aiti-model-check:panel";
import { fmtUnitPrice } from "./money";

declare global {
  interface Window {
    __aitiModelCheckOpen?: () => void;
    __aitiModelCheckApp?: (props: { open: boolean; onClose: () => void; embedded?: boolean; onGotoWizard?: (tab?: string) => void; onCleanupEdit?: (payload: any) => void }) => unknown;
    __aitiModelWizardOpen?: () => void;
    __aitiModelWizardOpenTab?: (t?: string) => void;
    // 模型向导 App 挂载期间注册：直接弹该模型的参数浮窗（查看/编辑）。未注册（向导未打开）→ 眼睛回退本面板信息弹层
    __aitiModelWizardViewParams?: (provider: string, id: string) => void;
    // 一键编辑交接信箱：检查面板写入 → 向导 openTab("status") 后消费（App 就绪即 applyCleanupEdit）
    __aitiModelWizardCleanupEdit?: { ts: number; source: string; statuses: Record<string, { s: string; kind?: string; label?: string }> } | null;
  }
}

const api = (p: string, init?: RequestInit) =>
  fetch(apiUrl("/api/extensions/aiti-model-check" + p), { cache: "no-store", ...init });
const jsonBody = (o: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

// register 上下文（feature 门控 / onFeatureChange 用；entry.tsx 里 setMcCtx(ctx)）
let mcCtx: Record<string, any> | null = null;
export function setMcCtx(ctx: Record<string, any>) { mcCtx = ctx; }

// ── 限流到期提醒（recover）：mc:recover 订阅 + 浏览器通知（entry 调用 initRecoverWatcher）────
// 服务端纯时间检查的产物（长期限流模型的预计恢复时间到点）→ 页面常驻监听：
// 浏览器系统通知（点击打开面板）+ window 事件转发（面板打开时就地刷新待验证列表）。
export type RecoverAlert = { provider: string; model: string; alertAt: number; limitedSince?: number; limitedMs?: number };

function subscribeRecoverEvents(cb: (frame: any) => void): () => void {
  // 事件总线 topics 唯一（白名单 mc:recover）；总线未启用 → no-op（面板记录兜底）
  const topicsSvc = extSvc<((h: (f: any) => void, types: string[]) => { off: () => void }) | undefined>("aiti-event-bus.subscribe-topics");
  if (!topicsSvc) return () => {};
  const sub = topicsSvc((frame: any) => { if (frame && frame.type === "mc:recover") { try { cb(frame); } catch { /* noop */ } } }, ["mc:recover"]);
  return () => { try { sub.off(); } catch { /* noop */ } };
}

const fmtRecoverDur = (ms: number) => {
  if (ms == null || ms < 0) return "-";
  const h = ms / 3600000;
  if (h < 48) return (Math.round(h * 10) / 10) + " 小时";
  return Math.floor(h / 24) + " 天 " + Math.round(h % 24) + " 小时";
};

/** 浏览器通知（页面开着即收）：每个到点模型一条，tag 去重；点击打开模型检查面板。 */
function showRecoverNotifications(alerts: RecoverAlert[]) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const a of alerts || []) {
      const n = new Notification("⏰ " + a.provider + "/" + a.model + " 限流预计已恢复", {
        body: "记录的预计恢复时间 " + new Date(a.alertAt).toLocaleString("zh-CN", { hour12: false }) + " 已到点"
          + (a.limitedMs ? "（已持续限流 " + fmtRecoverDur(a.limitedMs) + "）" : "") + " · 打开面板点「测」验证",
        tag: "mc-recover-" + a.provider + "/" + a.model,
      });
      n.onclick = () => { try { window.focus(); window.__aitiModelCheckOpen?.(); n.close(); } catch { /* noop */ } };
    }
  } catch { /* 通知不可用（权限/环境）→ 静默，面板记录兜底 */ }
}

/** 页面级恢复提醒监听（entry register 调用一次）：mc:recover → 浏览器通知 + window 事件转发。 */
export function initRecoverWatcher(): () => void {
  return subscribeRecoverEvents((frame: any) => {
    const alerts: RecoverAlert[] = Array.isArray(frame.alerts) ? frame.alerts : [];
    showRecoverNotifications(alerts);
    try { window.dispatchEvent(new CustomEvent("aiti-model-check:recover", { detail: frame })); } catch { /* noop */ }
  });
}

/** 浏览器通知权限（需用户手势里调用；permission 非 default 时无操作）。 */
export async function askNotifyPermission() {
  try { if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission(); } catch { /* noop */ }
}
// UI feature（extman 管理）：顶部工具条是否单独显示「📡 模型」按钮。默认隐藏（从模型向导「检查」入口进入）。
// 稳定机制：host 统一拉取（manifest）填共享 store；extman 变更 → host 原地 patch → ctx.onFeatureChange 通知——扩展零请求/零轮询。
export const featToolbar = () =>
  (typeof mcCtx?.getFeatures === "function" ? mcCtx.getFeatures() : {})["behavior.showToolbar"] === true;

// lucide 图标（2026-09 契约：统一 icons/*.svg 文件——deploy 从 _shared/icons 拷进扩展目录；
// mask 渲染与宿主 renderExtItemIcon 同款，currentColor 继承行内红绿状态色；apiUrl 保 /dev 前缀安全）
const Ic = ({ size, paths }: { size: number; paths: string }) => {
  const mask = `url("${apiUrl("/api/extensions/aiti-model-check/assets/" + paths)}")`;
  return (
    <span aria-hidden style={{
      display: "inline-block", width: size, height: size, flexShrink: 0, verticalAlign: "middle",
      background: "currentColor",
      WebkitMaskImage: mask, maskImage: mask,
      WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
      WebkitMaskPosition: "center", maskPosition: "center",
      WebkitMaskSize: "contain", maskSize: "contain",
    }} />
  );
};

/** 👁 查看按钮：统一 SVG 眼 + ≥20px 点击区 + hover 底色（与模型向导 EyeBtn 同款） */
const EyeBtn = ({ title, onClick }: { title: string; onClick: () => void }) => (
  <button title={title} aria-label={title}
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 20,
      border: "none", borderRadius: 4, background: "none", cursor: "pointer", color: "var(--accent,#2563eb)",
      padding: 0, flexShrink: 0 }}
    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(37,99,235,.14)"; }}
    onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}>
    <Ic size={13} paths={"icons/eye.svg"} />
  </button>
);

const C: Record<string, any> = {
  root: { position: "fixed", right: 18, bottom: 70, width: 620, maxWidth: "92vw", maxHeight: "calc(100dvh - 96px)",
    display: "flex", flexDirection: "column", zIndex: 2147483101, background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)",
    border: "1px solid var(--border,#e0e0e0)", borderRadius: 16, boxShadow: "0 16px 64px rgba(0,0,0,.25)",
    font: "13px/1.5 system-ui, -apple-system, sans-serif", overflow: "hidden" },
  head: { display: "flex", alignItems: "center", gap: 8, paddingTop: 10, paddingBottom: 10, paddingLeft: 14, paddingRight: 14, borderBottom: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f5f5f5)" },
  tabs: { display: "flex", gap: 4, flex: 1, overflowX: "auto" },
  tab: { padding: "5px 12px", border: "none", borderRadius: 8, cursor: "pointer", background: "transparent", color: "var(--text,#1a1a1a)", fontWeight: 500 },
  tabOn: { background: "var(--accent,#2563eb)", color: "#fff" },
  body: { paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12, overflow: "auto", flex: 1 },
  btn: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, whiteSpace: "nowrap", flexShrink: 0, padding: "5px 12px", borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border,#e0e0e0)", borderRadius: 8, cursor: "pointer", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontWeight: 500 },
  btnPrimary: { background: "var(--accent,#2563eb)", borderColor: "var(--accent,#2563eb)", color: "#fff" },
  row: { padding: "7px 8px", borderBottom: "1px solid var(--border,#e0e0e0)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  mono: { font: "11.5px/1.5 ui-monospace, monospace", wordBreak: "break-all" },
  msg: { padding: "6px 10px", borderRadius: 8, background: "var(--bg-subtle,#f5f5f5)", marginBottom: 8, fontSize: 12 },
  badge: { padding: "1px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600 },
};

const badge = (m: any) => {
  // 状态徽标：可用(绿) / 限流与欠费、key 错(红) / 其余异常、未探测(橙) / 待测试（已配置未探测，灰）。
  // 订阅登录型（OAuth，qoder/github-copilot…）：协议特殊不走探针 → 专属紫色「订阅」徽标。
  if (m.subscription) return { ...C.badge, background: "rgba(99,102,241,.13)", color: "#4f46e5" };
  const s = m.lastOk ? "ok" : m.rateLimited ? "rl" : m.lastProbedAt ? "err" : "never";
  const hot = m.pending ? { bg: "rgba(156,163,175,.18)", fg: "#6b7280" }
    : s === "ok" ? { bg: "rgba(34,197,94,.15)", fg: "#16a34a" }
    : s === "rl" || (s === "err" && (m.lastKind === "auth" || m.lastKind === "billing")) ? { bg: "rgba(239,68,68,.15)", fg: "#dc2626" }
    : { bg: "rgba(245,158,11,.15)", fg: "#d97706" };
  return { ...C.badge, background: hot.bg, color: hot.fg };
};

// 统一精准原因标签：可用/限流/待测试/未探测固定文案；订阅 provider 显示「订阅」；异常按 core 分类（欠费/key 不对/无权限/不存在/服务端错/网络不通/超时…）
const statusLabel = (m: any) => {
  if (m.subscription) return "订阅";
  if (m.lastOk) return "可用";
  if (m.rateLimited) return "限流";
  if (m.pending) return "待测试";
  if (!m.lastProbedAt) return "未探测";
  if (m.lastLabel) return m.lastLabel;
  // 旧记录无 label 时按状态码兜底
  const s = m.lastStatus || 0;
  if (s === 401) return "key 不对"; if (s === 402) return "欠费"; if (s === 403) return /region|not available in your (region|area|country|location)/i.test(m.lastError || "") ? "模型不可用" : "无权限"; if (s === 404) return "不存在";
  if (s >= 500 && s < 600) return "服务端错"; if (s === 0) return "网络不通";
  return "异常";
};

// 恢复时间显示：远期带日期 + 相对剩余（如 "08-24 08:00（约 4 天 23 小时后）"），近期只显示时分秒
const fmtPredict = (ts: number) => {
  if (!ts) return "未知";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  const local = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  const diffMs = ts - Date.now();
  if (diffMs <= 0) return local + "（已过恢复点）";
  if (diffMs < 6 * 3600 * 1000) return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  return local + "（约 " + (h >= 24 ? Math.floor(h / 24) + " 天 " + (h % 24) + " 小时" : h + " 小时") + (m ? " " + m + " 分" : "") + " 后）";
};

// 检查时间（相对）：按「从小往大，落在小的显示小的」只显示一个单位——<100 分钟显示分钟、<48 小时显示小时、否则显示天；鼠标悬停看精确时间
const fmtAgo = (ts: number) => {
  if (!ts) return "-";
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 100) return min < 1 ? "刚刚" : min + " 分钟前";
  const hr = Math.floor((Date.now() - ts) / 3600000);
  if (hr < 48) return hr + " 小时前";
  return Math.floor((Date.now() - ts) / 86400000) + " 天前";
};
const agoTitle = (ts: number) => "执行检查 " + new Date(ts).toLocaleString("zh-CN", { hour12: false });

type ProbeScope = null | { all?: boolean; provider: string | null; model: string | null };

// App 双形态：独立浮窗（默认）/ 内嵌（embedded=true，由 aiti-model-wizard「检查」tab 渲染）。
// 内嵌时：无外框/关闭按钮，紧凑头（标题+子 tab）+ body 不自带滚动（外层统一滚）。
// window.__aitiModelCheckApp = App —— 向导嵌入渲染用（同一宿主 React，跨扩展 h 无碍）。
// onCleanupEdit：内嵌模式下「🛠 一键编辑」回调（宿主向导接手：切到已配置模型 + 按检查结果预选）。
export function App({ open, onClose, embedded, onGotoWizard, onCleanupEdit, hideTitle, dockItemKey }: { open: boolean; onClose: () => void; embedded?: boolean; onGotoWizard?: (tab?: string) => void; onCleanupEdit?: (payload: any) => void; hideTitle?: boolean; dockItemKey?: string }) {
  const dockKey = typeof dockItemKey === "string" && dockItemKey ? dockItemKey : undefined;
  const dockHoist = Boolean(dockKey);
  const [tab, setTab] = useState("status");
  // 小屏（窄窗口）→ 全屏弹层：标题、tab 切换、关闭按钮常驻可见（同 aiti-model-wizard）
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const upd = () => setSmall(mq.matches);
    upd();
    if (mq.addEventListener) mq.addEventListener("change", upd); else (mq as any).addListener(upd);
    return () => { if (mq.removeEventListener) mq.removeEventListener("change", upd); else (mq as any).removeListener(upd); };
  }, []);
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [histFilter, setHistFilter] = useState<{ provider: string; model: string } | null>(null); // 点模型名进历史时的筛选
  const [provFilter, setProvFilter] = useState(""); // "" = 全部 provider
  const [expanded, setExpanded] = useState<Record<string, boolean>>({}); // provider 树展开状态
  // 👁 模型信息弹层：{provider, model, loading, params, baseUrl, api, readOnly, crossFrom, error, m}
  // m = 检查面板的合并模型条目（探测状态/分 key/运行期错误都从它渲染）；params = 向导 /modelParams 反填结果
  const [info, setInfo] = useState<any>(null);
  // 当前探测范围：null=空闲；{all:true}=探测全部；{provider,model}=单模型；{provider,model:null}=该 provider 下全部。
  // 用于给受影响的模型行 / provider 头行就地显示「测试中…」，而不是只有顶部一条处理中提示。
  const [probing, setProbing] = useState<ProbeScope>(null);
  // 检查联动：探测完成后向导扫描发现「未启用的新模型」→ 就地提示横幅 {total, text}
  const [nmTip, setNmTip] = useState<any>(null);

  // 👁 查看模型信息：探测状态（本地已有）+ 模型参数（拉向导 /modelParams：五源反填窗口/上限/价格/模态）。
  // combo（引擎路由虚拟模型）与订阅 provider 不拉参数——前者无真实参数，后者参数由引擎管理。
  const openInfo = async (m: any) => {
    setInfo({ provider: m.provider, model: m.model, loading: !m.combo && !m.subscription, params: null, error: null, m });
    if (m.combo || m.subscription) return;
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-model-wizard/modelParams?provider=" + encodeURIComponent(m.provider) + "&id=" + encodeURIComponent(m.model)), { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || !d.ok) {
        setInfo((prev: any) => prev && prev.provider === m.provider && prev.model === m.model
          ? { ...prev, loading: false, params: null, error: (d && d.error) || "模型参数不可用（aiti-model-wizard 扩展未启用？）" } : prev);
        return;
      }
      const found = (d.models || []).find((x: any) => x.id === m.model) || null;
      setInfo((prev: any) => prev && prev.provider === m.provider && prev.model === m.model
        ? { ...prev, loading: false, params: found, baseUrl: d.baseUrl, api: d.api, readOnly: !!d.readOnly, crossFrom: d.crossFilled && d.crossFilled[m.model] }
        : prev);
    } catch (e: any) {
      setInfo((prev: any) => prev && prev.provider === m.provider && prev.model === m.model
        ? { ...prev, loading: false, params: null, error: "模型参数加载失败（aiti-model-wizard 未启用？）：" + (e.message || e) } : prev);
    }
  };
  const closeInfo = () => setInfo(null);

  // 🛠 一键编辑：按当前检查结果生成预选 payload 交给模型向导——切到「已配置模型」（模型列表），
  // 每家 provider 勾选=保留（可用/限流/未测），硬性异常（key 不对/欠费/无权限/不存在）取消勾选，
  // 用户核对后点保存才生效（向导侧保存链路自带刷新代理）。内嵌走回调；独立浮窗经全局信箱 + openTab("status")。
  const doCleanupEdit = () => {
    if (!data || !data.state) { setMsg("请先等状态加载完成再点「一键编辑」"); return; }
    const state = data.state || {};
    const statuses: Record<string, any> = {};
    const push = (m: any) => {
      if (!m || !m.provider || !m.model || m.runtimeOnly || m.combo) return;
      statuses[m.provider + "/" + m.model] = {
        s: m.pending ? "pending" : (m.lastOk ? "ok" : m.rateLimited ? "rl" : m.lastProbedAt ? "err" : "never"),
        kind: m.lastKind || "", label: statusLabel(m),
      };
    };
    for (const e of (data.models || [])) push((state.models || {})[e.provider + "/" + e.model] || e);
    for (const m of Object.values(state.models || {})) push(m);
    const payload = { ts: Date.now(), source: "aiti-model-check", statuses };
    if (embedded && typeof onCleanupEdit === "function") { try { onCleanupEdit(payload); } catch (e: any) { setMsg("一键编辑失败：" + (e.message || e)); } return; }
    try {
      // DI 方案 P2：services 通道优先（信箱 deposit + openTab），旧全局兜底（双轨过渡）
      const dep = extSvc<(p: any) => void>("aiti-model-wizard.cleanupEdit");
      if (typeof dep === "function") dep(payload); else window.__aitiModelWizardCleanupEdit = payload;
      const w = extSvc("aiti-model-wizard.openTab") || window.__aitiModelWizardOpenTab
        || extSvc("aiti-model-wizard.open") || window.__aitiModelWizardOpen;
      if (typeof w === "function") { onClose(); setTimeout(() => (w as any)("status"), 30); }
      else { try { dep?.(null); } catch {} delete window.__aitiModelWizardCleanupEdit; setMsg("未找到模型向导（aiti-model-wizard 扩展未加载，先部署/reload）"); }
    } catch (e: any) { setMsg("打开模型管理失败：" + (e.message || e)); }
  };

  const load = useCallback(async () => {
    if (!open) return;
    setBusy(true); setMsg("");
    try { setData(await (await api("/status")).json()); } catch (e: any) { setMsg("加载失败：" + (e.message || e)); }
    setBusy(false);
    // 限流到期提醒补发（纯时间检查、幂等）：页面不在线期间到点的提醒，打开面板时让服务端补发一次（浏览器通知）
    void (async () => {
      try {
        const r = await (await api("/recover-check", { method: "POST" })).json();
        if (r && r.ok && r.recover) setData((prev: any) => (prev ? { ...prev, recover: r.recover } : prev));
      } catch { /* 补发失败不影响面板 */ }
    })();
  }, [open]);

  useEffect(() => { load(); }, [open, load]);
  // 限流到期提醒：entry 页面级监听收到 mc:recover → 就地刷新（待验证列表/最近提醒）
  useEffect(() => {
    const onRec = () => { void load(); };
    window.addEventListener("aiti-model-check:recover", onRec);
    return () => window.removeEventListener("aiti-model-check:recover", onRec);
  }, [load]);
  // 零轮询：打开 / 切到 status 标签 / 探测完成后都已拉取；探测结果是快照，不持续变化

  // 检查模型更新（联动/手工触发）：让模型向导同步扫描各已配置 provider 的 /models，
  // 发现「未启用的新模型」（前日基线 vs 今日 - 已配置）就地横幅提示。无论探测全部还是单模型都触发
  // （向导侧带 5min 新鲜度节流：快照新就直接用现有结果，不会反复打厂商接口）；
  // 向导扩展未加载/禁用/失败 → 静默跳过，不影响检查本身。
  // 原为纯后台静默扫描（无显式反馈）；manual=true 由用户手工触发：force 绕过新鲜度节流真重扫，
  // 并把结果显式反馈（发现 N 个 / 无新模型 / 失败）。
  const [nmChecking, setNmChecking] = useState(false); // 检查模型更新进行中（按钮转圈文案）
  const doNewModelsCheck = async (manual = false) => {
    if (manual) { setNmChecking(true); setMsg("正在检查模型更新（拉各已配置 provider 的 /models 对比前日基线）…"); }
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-model-wizard/new-models/refresh"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wait: true, force: !!manual }), cache: "no-store",
      });
      const d = await r.json();
      if (!d || !d.ok) { setNmTip(null); if (manual) setMsg("检查模型更新失败：" + ((d && d.error) || "向导扩展未就绪")); return; }
      if (d.total > 0) {
        const parts = Object.entries(d.providers || {}).map(([p, v]: any) =>
          p + "：" + (v.newModels || []).slice(0, 5).join("、") + ((v.newModels || []).length > 5 ? " 等 " + v.newModels.length + " 个" : ""));
        setNmTip({ total: d.total, text: parts.join(" · ") });
        if (manual) setMsg("检查模型更新：发现 " + d.total + " 个未启用的新模型（点「去启用」到已配置页查看）");
      } else {
        setNmTip(null);
        if (manual) setMsg("检查模型更新完成：没有发现新模型" + (d.scanned ? "（已重扫）" : "（距上次扫描 <5min，用现有快照）"));
      }
    } catch (e: any) { setNmTip(null); if (manual) setMsg("检查模型更新失败：" + (e.message || e)); }
    finally { if (manual) setNmChecking(false); }
  };

  const doProbe = async (provider: string | null, model: string | null) => {
    setBusy(true); setMsg("探测中…（每条 10s 超时，全量约几秒~几十秒）");
    setProbing({ all: !provider && !model, provider: provider || null, model: model || null });
    try {
      const r = await api("/probe", { method: "POST", ...jsonBody({ provider, model }) });
      const d = await r.json();
      if (!d.ok) { setMsg("探测失败：" + (d.error || JSON.stringify(d))); }
      else {
        const subs = (d.subscriptions || []).filter((s: any) => s && s.provider);
        if (!d.probed && subs.length) {
          // 纯订阅 provider：只做订阅状态检查（无逐模型探针结果）
          setMsg(subs.map((s: any) => (s.ok ? "✅ " + s.provider + " 订阅" + (s.text ? " · " + s.text : "") : "❌ " + s.provider + " 订阅" + (s.label ? " · " + s.label : "") + (s.error ? " · " + s.error : ""))).join("；"));
        } else {
          setMsg("已探测 " + d.probed + " 个模型（" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "）" + (subs.length ? " · " + subs.map((s: any) => (s.ok ? "✅ " + s.provider : "❌ " + s.provider)).join(" ") : ""));
        }
        load(); void doNewModelsCheck();
      }
    } catch (e: any) { setMsg("探测失败：" + (e.message || e)); }
    setProbing(null); setBusy(false);
  };
  // dock 头工具条 v3：命令实现（探测/刷新）+ 状态上报（busy/tab/provider 计数）
  useDockCommands(dockKey, dockKey ? {
    probe: () => {
      try { writeBlockCollapsed(dockKey, false); } catch { /* ignore */ }
      void doProbe(provFilter || null, null);
    },
    refresh: () => { void load(); },
  } : null);
  useDockHeaderState(dockKey, dockKey ? { busy, tab } : null);

  const loadHist = async (provider: string | null, model: string | null) => {
    setBusy(true); setMsg("");
    try {
      const q = new URLSearchParams();
      if (provider) q.set("provider", provider); if (model) q.set("model", model); q.set("limit", "40");
      setData(await (await api("/history?" + q.toString())).json());
    } catch (e: any) { setMsg("历史加载失败：" + (e.message || e)); }
    setBusy(false);
  };

  // 余额：现查（refresh=1）或读缓存，结果塞回 data.state.balances 供渲染
  const checkBal = async (refresh: boolean) => {
    setBusy(true); setMsg(refresh ? "查询余额/套餐用量中（并行 GET，几秒）…" : "加载余额…");
    try {
      const r = await api("/balance" + (refresh ? "?refresh=1" : ""), { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) { setMsg("余额查询失败：" + (d.error || JSON.stringify(d))); return; }
      // 并入现有数据（/status 里 state.balances 会随之更新）
      setData((prev: any) => {
        const st = (prev && prev.state && prev.state.balances) ? prev : { state: { models: (prev && prev.state && prev.state.models) || {} } };
        return { ...st, state: { ...st.state, balances: (d.balances || []).reduce((o: any, b: any) => { o[b.provider] = b; return o; }, st.state.balances || {}) } };
      });
      setMsg(refresh ? "已查余额（" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "）" : "（缓存）");
    } catch (e: any) { setMsg("余额查询失败：" + (e.message || e)); }
    setBusy(false);
  };

  // 跳转到 aiti-model-wizard（开机向导：添加 provider/模型）。targetTab 可指定落地 tab（如 "status"=已配置，新模型启用入口）。
  // 嵌入模式：向导就在外层 → 回调切到指定 tab（宿主旧版忽略参数回退「添加」）；独立浮窗：先关本面板再打开向导，避免两层弹窗叠着。
  const gotoWizard = (targetTab?: string) => {
    if (embedded && typeof onGotoWizard === "function") { try { onGotoWizard(targetTab); } catch {} return; }
    try {
      // DI 方案 P2：services 通道优先，旧全局兜底
      const w = targetTab ? (extSvc("aiti-model-wizard.openTab") || window.__aitiModelWizardOpenTab || extSvc("aiti-model-wizard.open") || window.__aitiModelWizardOpen)
        : (extSvc("aiti-model-wizard.open") || window.__aitiModelWizardOpen);
      if (typeof w === "function") { onClose(); setTimeout(() => (w as any)(targetTab), 30); }
      else setMsg("未找到模型向导（aiti-model-wizard 扩展未加载，先部署/reload）");
    } catch (e: any) { setMsg("打开模型向导失败：" + (e.message || e)); }
  };

  const st = (m: any) => m.lastOk ? "ok" : m.rateLimited ? "rl" : m.lastProbedAt ? "err" : "never";
  const fmtMs = (ms: number) => ms == null ? "-" : ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
  // ── 限流到期提醒（recover）：开关解析（模型级 > provider 级 > 默认）/ 切换 / 到点判定 ──
  const recoverCfg = (data && data.recover) || null;
  const recoverOn = (provider: string, model?: string): boolean => {
    const r = recoverCfg || {};
    if (r.enabled === false) return false;
    if (model && r.models && Object.prototype.hasOwnProperty.call(r.models, provider + "/" + model)) return !!r.models[provider + "/" + model];
    if (r.providers && Object.prototype.hasOwnProperty.call(r.providers, provider)) return !!r.providers[provider];
    return r.notifyDefault !== false;
  };
  const toggleRecover = async (level: "model" | "provider", provider: string, model?: string) => {
    const next = !recoverOn(provider, model);
    try {
      const d = await (await api("/recover-notify", { method: "POST", ...jsonBody({ level, provider, model, value: next }) })).json();
      if (d && d.ok) {
        setData((prev: any) => (prev ? { ...prev, recover: d.recover } : prev));
        setMsg(next ? "已开启" + (level === "model" ? "该模型" : "该 provider ") + "的限流到期提醒" : "已关闭" + (level === "model" ? "该模型" : "该 provider ") + "的限流到期提醒");
      } else setMsg("开关保存失败：" + ((d && d.error) || "未知错误"));
    } catch (e: any) { setMsg("开关保存失败：" + (e.message || e)); }
  };
  // 到点且未验证（纯时间判定；与服务端 due 一致）
  const alertDue = (m: any) => !!(m && m.alertAt && !m.lastOk && m.alertAt <= Date.now());
  // 该模型是否在当前探测范围内（配合 probing 状态 → 行内显示「测试中…」）
  const isProbing = (m: any) => !!probing && (
    probing.all ? true :
    probing.model ? (m.provider === probing.provider && m.model === probing.model) :
    m.provider === probing.provider);

  // 运行期错误徽标：来自代理真实流量的非 2xx/3xx（带 key 归因），不主动探测也知道；
  // 只提示不标记（探测才是权威）。主导类别取最近事件状态：⚡ 限流（红，1h 内）/ 💸 欠费 / 🔑 key 无效 /
  // ⚠️ 服务端错 / 🔌 网络错（橙）；title 带按状态分类计数 + key 明细 + 引导重检。
  const rtErrMeta: Record<string, { label: string; color: string }> = {
    "429": { label: "限流", color: "#dc2626" }, "401": { label: "key 无效", color: "#dc2626" },
    "402": { label: "欠费", color: "#dc2626" }, "403": { label: "无权限", color: "#dc2626" },
    "404": { label: "不存在", color: "#d97706" },
  };
  const rtErrInfo = (status: number) => {
    const s = Number(status) || 0;
    const known = rtErrMeta[String(s)];
    if (known) return { icon: s === 429 ? "⚡" : s === 402 ? "💸" : s === 401 ? "🔑" : "⛔", ...known };
    if (s >= 500) return { icon: "⚠️", label: s === 502 || s === 504 ? "网络/超时" : "服务端错", color: "#d97706" };
    return { icon: "⚠️", label: "异常", color: "#d97706" };
  };
  const rtBadge = (m: any) => {
    const rt = m.runtimeErrors;
    if (!rt || !rt.count24h) return null;
    const capped = rt.count24h >= 80 ? "+" : "";
    const info = rtErrInfo(rt.lastStatus);
    const hot = rt.count1h > 0;
    // 主导类别：若最近状态不是 429 但 1h 内有 429，仍以限流为主显（限流是瞬态最常见）
    const has429 = rt.byStatus && rt.byStatus["429"] && rt.byStatus["429"].count1h > 0;
    const kind = has429 ? rtErrInfo(429) : info;
    const byStatus = Object.entries(rt.byStatus || {}).sort((a: any, b: any) => (b[1].count24h || 0) - (a[1].count24h || 0))
      .map(([s, b]: any) => rtErrInfo(Number(s)).icon + " " + (rtErrMeta[String(s)] ? rtErrMeta[String(s)].label : "HTTP " + s) + " ×" + b.count24h).join("，");
    const keyDetail = Object.entries(rt.keys || {}).sort((a: any, b: any) => (b[1].count24h || 0) - (a[1].count24h || 0)).slice(0, 4)
      .map(([n, k]: any) => n + " ×" + k.count24h).join("，");
    const tip = "运行期错误观测（带外 · " + (rt.lastSrc === "session" ? "直连模型会话事件，无 key 归因" : "多 key/聚合代理真实流量") + "，非主动探测）：近 1 小时 " + rt.count1h + " 次 / 24 小时 " + rt.count24h + capped + " 次错误"
      + (byStatus ? "\n" + byStatus : "")
      + (rt.lastAt ? "\n最近 " + new Date(rt.lastAt).toLocaleString("zh-CN", { hour12: false }) + (rt.lastKey ? " · key " + rt.lastKey : "") : "")
      + (keyDetail ? "\nkeys：" + keyDetail : "")
      + "\n可能仍处于故障中——点「测」重检确认当前可用性";
    const label = kind.icon + " " + kind.label + " ×" + (has429 && kind.icon === "⚡" && rt.byStatus["429"].count1h > 0 ? rt.byStatus["429"].count1h + "/1h" : rt.count24h + "/24h" + capped);
    return (
      <span style={{ ...C.badge, background: hot ? "rgba(220,38,38,.15)" : "rgba(245,158,11,.15)", color: hot ? "#dc2626" : kind.color, cursor: "default" }} title={tip}>
        {label}
      </span>
    );
  };

  // 分 key 快照（m.keys，core 写入）：≥2 个 key 时每 key 一行（状态点 + 名 + HTTP/耗时/标签/恢复时间）；
  // 运行期错误观测（m.runtimeErrors.keys，代理真实流量非 2xx/3xx 的 key 归因）追加在对应 key 行尾分类标。
  // App 级：状态行与 👁 模型信息弹层共用。
  const keyBadges = (m: any) => {
    const keys = m.keys && Object.keys(m.keys);
    const rtKeys = (m.runtimeErrors && m.runtimeErrors.keys) || {};
    const rtOnly = Object.keys(rtKeys).filter((n: string) => !keys || !keys.includes(n)); // 只在运行时观测到的 key
    if ((!keys || keys.length < 2) && !rtOnly.length) return null;
    const names: string[] = [...(keys || []), ...rtOnly];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 3, paddingLeft: 10, borderLeft: "2px solid var(--border,#e0e0e0)" }}>
        {names.map((name: string) => {
          const k = m.keys && m.keys[name];
          const rk = rtKeys[name];
          const color = k ? (k.ok ? "#16a34a" : (k.rateLimited || k.status === 429) ? "#dc2626" : "#d97706") : rk ? "#d97706" : "#9ca3af";
          const tip = name + ": " + (k ? "HTTP " + (k.status || "-") + (k.label ? " · " + k.label : "") + (k.predictedAvailableAt ? " · 恢复 " + fmtPredict(k.predictedAvailableAt) : "") : "运行时观测（未分 key 探测）")
            + (rk ? "\n⚡ 近 1h " + rk.count1h + " 次 / 24h " + rk.count24h + " 次错误（真实流量 · 最近 HTTP " + (rk.lastStatus || "-") + "）· 最近 " + new Date(rk.lastAt).toLocaleString("zh-CN", { hour12: false })
              + Object.entries(rk.byStatus || {}).map(([s, b]: any) => "\n  " + rtErrInfo(Number(s)).icon + " HTTP " + s + " ×" + b.count24h).join("") : "");
          return (
            <span key={name} title={tip} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, color, fontWeight: 600, lineHeight: "14px" }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: color, display: "inline-block", flexShrink: 0 }} />
              <span style={{ fontFamily: "ui-monospace,monospace" }}>{name}</span>
              {k && k.label ? <span style={{ fontWeight: 400 }}>{" " + k.label}</span> : null}
              {k && k.latencyMs ? <span style={{ fontWeight: 400, color: "var(--text-subtle,#666)" }}>{" " + (k.latencyMs < 1000 ? k.latencyMs + "ms" : (k.latencyMs / 1000).toFixed(1) + "s")}</span> : null}
              {k && k.predictedAvailableAt && !k.ok ? <span style={{ fontWeight: 400 }}>{" · 恢复 " + fmtPredict(k.predictedAvailableAt)}</span> : null}
              {rk ? <span style={{ fontWeight: 600, color: rk.count1h > 0 ? "#dc2626" : "#d97706" }} title={"近 24h " + rk.count24h + " 次错误（真实流量）"}>{rtErrInfo(rk.lastStatus).icon + "×" + rk.count24h + (rk.count24h >= 80 ? "+" : "")}</span> : null}
            </span>
          );
        })}
      </div>
    );
  };

  // 限流到期提醒区块：待验证清单（到点未验证；探测后自动消失）+ 生效阈值 + 浏览器通知权限 + 最近提醒
  const renderRecover = () => {
    const r = recoverCfg;
    if (!r) return null;
    const pending: any[] = Array.isArray(r.pending) ? r.pending : [];
    const alerts: any[] = Array.isArray(r.alerts) ? r.alerts : [];
    const recent = alerts.slice(-5).reverse();
    const th = Number(r.minLimitedHours) || 72;
    const thrTxt = th >= 24 ? (Math.round((th / 24) * 10) / 10) + " 天" : th + " 小时";
    const notifDenied = typeof Notification === "undefined" || Notification.permission === "denied";
    const notifOk = typeof Notification !== "undefined" && Notification.permission === "granted";
    return (
      <div style={{ marginBottom: 8 }}>
        {pending.length ? (
          <div style={{ padding: "6px 10px", borderRadius: 8, marginBottom: 6, fontSize: 12, background: "rgba(245,158,11,.1)", border: "1px solid rgba(245,158,11,.4)", color: "#b45309" }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>{"限流到期待验证 " + pending.length + " 个（已过记录的预计恢复时间；纯时间提示，尚未探测）："}</div>
            {pending.slice(0, 6).map((d: any) => (
              <div key={d.provider + "/" + d.model} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 1 }}>
                <span style={{ fontWeight: 600 }}>{d.provider + "/" + d.model}</span>
                <span style={{ color: "var(--text-subtle,#666)" }}>{"预计恢复 " + fmtPredict(d.alertAt) + (d.limitedMs ? " · 已持续限流 " + fmtRecoverDur(d.limitedMs) : "")}</span>
                <button style={{ ...C.btn, padding: "1px 8px", fontSize: 11 }} onClick={() => doProbe(d.provider, d.model)} disabled={busy} title="现在真的探测一次，验证是否已恢复">测</button>
              </div>
            ))}
            {pending.length > 6 ? <div style={{ color: "var(--text-subtle,#666)" }}>{"…另有 " + (pending.length - 6) + " 个"}</div> : null}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 11.5, color: "var(--text-subtle,#666)" }}>
          <span title="长期限流（已持续 ≥ 阈值）的模型在其记录的预计恢复时间到点时提醒；纯时间检查，不自动探测；逐模型/逐 provider 可用行尾 🔔 关闭">
            {"限流到期提醒：" + (r.enabled ? "开" : "关（extman 功能管理）") + " · 阈值 " + thrTxt}
          </span>
          {r.enabled && !notifOk ? (
            <button style={{ ...C.btn, padding: "1px 8px", fontSize: 11 }} onClick={() => { void askNotifyPermission(); }}
              title={notifDenied ? "浏览器已拒绝通知权限（需在浏览器设置里放行）" : "授权后，页面开着时到期提醒会以系统通知弹出"}>
              {notifDenied ? "浏览器通知被拒" : "开启浏览器通知"}
            </button>
          ) : null}
          {notifOk ? <span title="页面开着时到期提醒会以系统通知弹出；面板「待验证」始终可见">浏览器通知已开</span> : null}
          {recent.length ? (
            <span title={recent.map((a: any) => fmtAgo(a.at) + " " + a.provider + "/" + a.model + "（限流 " + fmtRecoverDur(a.limitedMs) + "）").join("\n")}>
              {"最近提醒：" + recent.slice(0, 3).map((a: any) => a.model + "（" + fmtAgo(a.at) + "）").join(" · ")}
            </span>
          ) : null}
        </div>
      </div>
    );
  };

  const renderStatus = () => {
    if (!data || !data.state) return null; // 防御：data 不是 /status 响应（如误置历史数据）时不渲染
    const state = data.state || { models: {} };
    const stateModels = Object.values(state.models || {});
    const rtErr = (state.runtimeErrors && state.runtimeErrors.models) || {}; // 运行期错误观测（带外）
    // 合并：已配置模型（含从未探测的 → 合成 pending 条目显示「待测试」）+ 仅存在于 state 的残留模型。
    // 这样 provider 列与 models 的 provider 列表一致，不漏已配置但未检查的 provider（如 custom）。
    const seen = new Set<string>();
    const allModels: any[] = [];
    for (const e of (data.models || [])) {
      const key = e.provider + "/" + e.model;
      // 防御：服务端 /status 的 models 是 models.json + 运行时 provider 合并产物，
      // 一旦某 provider 同时命中 models.json 与运行时快照，同一 (provider, model)
      // 可能短暂出现两条。列表行 key 用 `${provider}/${model}`，重复会触发 React
      // "two children with the same key" 告警（且会重复渲染）。此处按模型去重只留一条。
      if (seen.has(key)) continue;
      seen.add(key);
      const stEntry = (state.models || {})[key];
      const m = stEntry || Object.assign({}, e, { pending: true, lastProbedAt: 0, lastOk: null, lastStatus: 0, lastLatencyMs: null, rateLimited: false, predictedAvailableAt: null, lastText: "", lastError: "", recoveredAt: null, history: [] });
      m.runtimeErrors = rtErr[key];
      allModels.push(m);
    }
    for (const m of stateModels) {
      const key = m.provider + "/" + m.model;
      m.runtimeErrors = rtErr[key];
      if (!seen.has(key)) allModels.push(m);
      else seen.add(key);
    }
    // 仅存在于运行时观测的模型（已删除/不再配置但代理日志里刚出过错）→ 合成只读行，不遗漏信号
    for (const [key, rt] of Object.entries(rtErr)) {
      if (seen.has(key)) continue;
      const [provider, model] = key.split("/");
      allModels.push({ provider, model, runtimeOnly: true, runtimeErrors: rt });
    }
    const provs = [...new Set(allModels.map((m) => m.provider))];
    const models = provFilter ? allModels.filter((m) => m.provider === provFilter) : allModels;
    // 排序：可用（ok）最前且组内按「最近可用/最近检查」倒序 → 限流 → 未探测 → 报错（err）固定排最后。
    const sortRank: Record<string, number> = { ok: 0, rl: 1, never: 2, err: 3 };
    models.sort((a, b) => {
      const ra = sortRank[st(a)] ?? 3, rb = sortRank[st(b)] ?? 3;
      if (ra !== rb) return ra - rb;
      return (b.lastProbedAt || 0) - (a.lastProbedAt || 0); // 同组内：最近检查的排前面（ok 组即「最近可用」优先）
    });
    // 按 provider 分组（树）
    const groups: Record<string, any[]> = {};
    for (const m of models) (groups[m.provider] = groups[m.provider] || []).push(m);
    // provider 排序：与模型同规则——有可用模型的在前（组内按最近可用倒序）→ 限流 → 未探测 → 全报错的排最后。
    const provRank = (p: string) => {
      const g = groups[p] || [];
      if (g.some((m) => st(m) === "ok")) return 0;
      if (g.some((m) => st(m) === "rl")) return 1;
      if (g.some((m) => st(m) === "never")) return 2;
      return 3; // 全部报错
    };
    const provOrder = provs.slice().sort((p1, p2) => {
      const r1 = provRank(p1), r2 = provRank(p2);
      if (r1 !== r2) return r1 - r2;
      const recent = (p: string, s: string | null) => Math.max(0, ...(groups[p] || []).filter((m) => (s ? st(m) === s : true)).map((m) => m.lastProbedAt || 0));
      return recent(p2, r1 === 0 ? "ok" : null) - recent(p1, r1 === 0 ? "ok" : null); // 可用组按「最近可用」倒序，其余按「最近检查」倒序
    });
    const selStyle = { padding: "5px 10px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontSize: 12.5, cursor: "pointer", maxWidth: 180 };
    const rowNode = (m: any) => {
      const s = st(m);
      // 行内结构变量：keys 判定改为 ≥2 探测 key 或有运行时观测 key
      const keys = (m.keys && Object.keys(m.keys).length >= 2) || (m.runtimeErrors && Object.keys(m.runtimeErrors.keys || {}).length) ? m.keys || {} : null;
      // 结构上保证分 key 块独占整行：行内容包进内层 flex，keys 块作为兄弟块垂直跟随，
      // 不依赖 flex-wrap 的换行行为（嵌在向导/小屏等宿主里也稳定）。
      return (
        <div key={m.provider + "/" + m.model} style={{ padding: "7px 8px", borderBottom: "1px solid var(--border,#e0e0e0)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {isProbing(m)
              ? <span style={{ ...C.badge, background: "rgba(37,99,235,.15)", color: "#2563eb" }} title="正在探测…（每条最长 10s）">测试中</span>
              : m.runtimeOnly
                ? <span style={{ ...C.badge, background: "rgba(156,163,175,.18)", color: "#6b7280" }} title="该模型不在当前配置里（可能已删除），但代理真实流量仍观测到 429">未配置</span>
                : <span style={badge(m)}>{statusLabel(m)}</span>}
            {rtBadge(m)}
            {m.blockedAt ? <span style={{ ...C.badge, background: "rgba(220,38,38,.15)", color: "#dc2626" }} title={"运行中被大量 429 阻断标记为不可用（" + new Date(m.blockedAt).toLocaleString("zh-CN", { hour12: false }) + " · " + (m.blockedCount || 1) + " 次）"}>⛔ 运行阻断</span> : null}
            {alertDue(m) ? <span style={{ ...C.badge, background: "rgba(245,158,11,.18)", color: "#b45309" }} title={"记录的预计恢复时间 " + new Date(m.alertAt).toLocaleString("zh-CN", { hour12: false }) + " 已到点（纯时间提示，未探测验证）——点「测」验证"}>预计已恢复 · 待验证</span> : null}
            <span style={{ fontWeight: 600, cursor: "pointer" }} title="看历史" onClick={() => { setHistFilter({ provider: m.provider, model: m.model }); setTab("history"); loadHist(m.provider, m.model); }}>{m.model}</span>
            {!m.runtimeOnly ? <EyeBtn title={"查看 " + m.model + " 模型信息（探测状态 / 参数 / 分 key）"} onClick={() => openInfo(m)} /> : null}
            {m.combo ? (
              <>
                <span style={{ ...C.badge, background: "rgba(99,102,241,.13)", color: "#4f46e5", cursor: "default" }}
                  title={"模型聚合（虚拟模型）＝ " + (m.comboMembers || []).join(" + ") + "；由 pi-models-combo 引擎路由：同会话粘性（TTL " + (m.comboTtl || 15) + " 分钟内固定同一成员，最大化 prompt cache），429 冷却/权重占比自动切换"}>
                  🧩 {(m.comboMembers || []).join(" + ")}</span>
                <span style={{ fontSize: 11, color: "var(--text-subtle,#888)", cursor: "default" }} title="聚合组模型由引擎路由（粘性+权重），探测请针对其成员真实模型">引擎路由 · 不直接探测</span>
              </>
            ) : null}
            {m.subscription ? (
              <>
                <span style={{ ...C.badge, background: "rgba(99,102,241,.13)", color: "#4f46e5", cursor: "default" }} title="订阅/OAuth 登录型 provider（凭据在 auth.json，由模型向导「订阅服务」登录）">订阅</span>
                <span style={{ fontSize: 11, color: "var(--text-subtle,#888)", cursor: "default" }} title="订阅 provider 由厂商/引擎接入（qoder WASM 加密 / github Copilot 模型 id 映射），不直接发标准探针；请在 provider 行点「检查订阅」看订阅状态">登录凭据驱动 · 不直接探测</span>
              </>
            ) : null}
            {!keys && !m.combo && !m.subscription ? <span style={{ ...C.mono, color: "var(--text-subtle,#666)" }}>{"HTTP " + (m.lastStatus || "-") + " · " + fmtMs(m.lastLatencyMs)}</span> : null}
            {m.lastProbedAt ? <span style={{ ...C.mono, color: "var(--text-subtle,#666)" }} title={agoTitle(m.lastProbedAt)}>{fmtAgo(m.lastProbedAt) + " 检查"}</span> : null}
            {m.runtimeErrors && m.runtimeErrors.lastAt ? <span style={{ ...C.mono, color: "var(--text-subtle,#666)" }} title={"运行期最近一次错误（代理真实流量 · HTTP " + (m.runtimeErrors.lastStatus || "-") + "）"}>{fmtAgo(m.runtimeErrors.lastAt) + " 出错"}</span> : null}
            {s === "rl" ? <span style={{ color: "#dc2626" }}>{"预计恢复 " + fmtPredict(m.predictedAvailableAt)}</span> : null}
            {s === "rl" && m.limitedSince ? <span style={{ color: "var(--text-subtle,#666)", fontSize: 11 }} title={"本轮连续限流起点 " + new Date(m.limitedSince).toLocaleString("zh-CN", { hour12: false })}>{"已持续 " + fmtRecoverDur(Date.now() - m.limitedSince)}</span> : null}
            {m.lastError ? <span style={{ color: "var(--text-subtle,#666)", fontSize: 11 }}>{m.lastError.slice(0, 80)}</span> : null}
            {!m.combo && !m.subscription && !m.runtimeOnly ? (
              <button style={{ ...C.btn, padding: "2px 7px", opacity: recoverOn(m.provider, m.model) ? 1 : 0.45, color: recoverOn(m.provider, m.model) && s === "rl" ? "#b45309" : undefined }}
                onClick={() => toggleRecover("model", m.provider, m.model)}
                title={"限流到期提醒：" + (recoverOn(m.provider, m.model) ? "开——该模型限流持续 ≥ 阈值且预计恢复时间到点时提醒（点此关闭）" : "关（点此开启）")}>
                {"🔔"}
              </button>
            ) : null}
            {!m.combo && !m.subscription && !m.runtimeOnly ? <button style={C.btn} onClick={() => doProbe(m.provider, m.model)} disabled={busy} title="探测该模型">测</button> : null}
          </div>
          {keys ? keyBadges(m) : null}
        </div>
      );
    };
    return (
      <div>
        {renderRecover()}
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select value={provFilter} onChange={(e) => setProvFilter(e.target.value)} style={selStyle} title="只探测该 provider">
            <option key="__all__" value="">全部 provider</option>
            {provOrder.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {/* dock 模式：探测已上提 dock 头（头工具条 v3），此处不再重复 */}
          {!dockHoist ? (
          <button style={{ ...C.btn, ...C.btnPrimary }} onClick={() => doProbe(provFilter || null, null)} disabled={busy}>
            <Ic size={13} paths={"icons/search.svg"} />{" "}{provFilter ? "探测 " + provFilter : "探测全部"}
          </button>
          ) : null}
          <button style={C.btn} onClick={() => gotoWizard()} title="跳转 aiti-model-wizard：搜索/添加 AI 提供商与模型（开机向导）">
            <Ic size={13} paths={"icons/wand.svg"} />{" "}配置更多模型
          </button>
          <button style={C.btn} onClick={() => doNewModelsCheck(true)} disabled={busy || nmChecking}
            title="手工触发『检查模型更新』（原为后台静默扫描）：拉已配置 provider 的 /models 对比前日基线，发现未启用的新模型">
            <Ic size={13} paths={"icons/refresh.svg"} />{" "}{nmChecking ? "检查中…" : "检查模型更新"}
          </button>
          <button style={{ ...C.btn, ...C.btnPrimary }} onClick={doCleanupEdit} disabled={busy || !data || !data.state}
            title="一键整理：切到已配置模型（模型管理·模型列表），按检查结果预选——可用/限流/未测保留勾选，硬性异常（key 不对/欠费/无权限/不存在）取消勾选；逐家核对后点保存即生效">
            <Ic size={13} paths={"icons/edit.svg"} />{" "}一键编辑
          </button>
          <span style={{ color: "var(--text-subtle,#666)" }}>
            {provFilter ? "" + provFilter + " · " + models.length + " 个模型" : "共 " + (data.models || []).length + " 个已配置 · 状态更新 " + (state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "-")}
          </span>
        </div>
        {models.length === 0
          ? <div style={C.msg}>{provFilter ? "该 provider 还没有探测记录 —— 点「🔍 探测 " + provFilter + "」" : "还没有探测记录 —— 点「探测全部」开始（或 AI 说「检查模型可用性」）"}</div>
          : <div>{provOrder.map((p) => {
              const g = groups[p];
              const open = provFilter ? true : !!expanded[p]; // 单选 provider 时强制展开
              // provider 汇总：可用/限流/未探测固定；异常按 kind 细分（欠费、key 不对…），不再笼统"异常"
              const gSub = !!(g[0] && g[0].subscription); // 订阅登录型 provider（协议特殊，不逐模型探测）
              const cnt = (s: string) => g.filter((m) => st(m) === s).length;
              const colorOf: Record<string, string> = { ok: "#16a34a", rl: "#dc2626", never: "var(--text-subtle,#666)", auth: "#dc2626", billing: "#dc2626" };
              const segs: { key: string; text: string; color: string }[] = [];
              if (gSub) {
                segs.push({ key: "sub", text: g.length + " 订阅", color: "#4f46e5" });
              } else {
                if (cnt("ok")) segs.push({ key: "ok", text: cnt("ok") + " 可用", color: colorOf.ok });
                if (cnt("rl")) segs.push({ key: "rl", text: cnt("rl") + " 限流", color: colorOf.rl });
                // 异常细分：按 kind 聚合并排序显示
                const errKinds: Record<string, { n: number; label: string }> = {};
                for (const m of g) {
                  if (st(m) !== "err") continue;
                  const k = m.lastKind || "other";
                  const label = m.lastLabel || "异常";
                  errKinds[k] = errKinds[k] || { n: 0, label };
                  errKinds[k].n++;
                }
                const hot = (k: string) => k === "auth" || k === "billing" || k === "rate";
                for (const k of Object.keys(errKinds)) segs.push({ key: k, text: errKinds[k].n + " " + errKinds[k].label, color: hot(k) ? colorOf.auth : "#d97706" });
                const pendN = g.filter((m) => m.pending).length;
                if (pendN) segs.push({ key: "pending", text: pendN + " 待测试", color: "#9ca3af" });
                if (cnt("never") - pendN) segs.push({ key: "never", text: (cnt("never") - pendN) + " 未探测", color: colorOf.never });
              }
              const sumParts = segs.map((s, i) => [
                i > 0 ? <span key={"sep" + i} style={{ color: "var(--text-subtle,#666)" }}> · </span> : null,
                <span key={s.key} style={{ color: s.color, fontWeight: 600 }}>{s.text}</span>,
              ]).flat();
              const summaryNode = sumParts.length ? sumParts : [<span key="none" style={{ color: "var(--text-subtle,#666)" }}>无记录</span>];
              // 该 provider 下限流模型的最早恢复时间（有 429 且带 predictedAvailableAt 时）
              const rlP = g.filter((m) => st(m) === "rl" && m.predictedAvailableAt).map((m) => m.predictedAvailableAt);
              const earliest = rlP.length ? Math.min(...rlP) : null;
              // 运行期错误观测（带外）：该组内有错误的模型数 + 组内 1h 总次数
              const rtN = g.filter((m) => m.runtimeErrors && m.runtimeErrors.count24h > 0).length;
              const rt1h = g.reduce((s: number, m: any) => s + ((m.runtimeErrors && m.runtimeErrors.count1h) || 0), 0);
              const provBusy = g.some(isProbing); // 该 provider 下有模型在探测 → 头行也提示测试中
              const subSt = gSub ? (state.subscriptions && state.subscriptions[p]) || null : null; // provider 级订阅状态（qoder 配额 / 登录态）
              return (
                <div key={p} style={{ marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg-subtle,#f5f5f5)", borderRadius: 8, cursor: "pointer", flexWrap: "wrap" }}
                    onClick={() => setExpanded((e) => ({ ...e, [p]: !e[p] }))} title="点击展开/收起">
                    <span style={{ width: 14, fontSize: 11, color: "var(--text-subtle,#666)" }}>{open ? "▾" : "▸"}</span>
                    <span style={{ fontWeight: 700 }}>{p}</span>
                    {gSub ? <span style={{ ...C.badge, background: "rgba(99,102,241,.13)", color: "#4f46e5" }}>订阅</span> : null}
                    <span style={{ fontSize: 12 }}>({" "}{summaryNode}{" "})</span>
                    {provBusy ? <span style={{ color: "#2563eb", fontSize: 12, fontWeight: 600 }}>测试中…</span> : null}
                    {subSt ? (
                      <span style={{ color: subSt.ok ? (subSt.exhausted ? "#d97706" : "#15803d") : "#b91c1c", fontSize: 12, fontWeight: 600 }}
                        title={(subSt.error || subSt.text || "") + " · " + (subSt.checkedAt ? new Date(subSt.checkedAt).toLocaleString("zh-CN", { hour12: false }) : "")}>
                        {subSt.ok ? (subSt.exhausted ? "⚠️ " : "✅ ") : "❌ "}{(subSt.label || "订阅")}{subSt.ok && subSt.text ? " · " + subSt.text : ""}
                      </span>
                    ) : null}
                    {earliest ? <span style={{ color: "#dc2626", fontSize: 12 }}>{"最早恢复 " + fmtPredict(earliest)}</span> : null}
                    {rtN ? (
                      <span style={{ color: rt1h ? "#dc2626" : "#d97706", fontSize: 12, fontWeight: 600, cursor: "default" }}
                        title={"运行期错误观测（带外 · 多 key/聚合代理真实流量非 2xx/3xx，非主动探测）：" + rtN + " 个模型 24h 内有错误" + (rt1h ? "，近 1 小时 " + rt1h + " 次" : "") + "——可能仍故障中，建议重检"}>
                        {"⚡ " + rtN + " 模型运行异常" + (rt1h ? " ×" + rt1h + "/1h" : "")}
                      </span>
                    ) : null}
                    {gSub ? null : (
                      <button style={{ ...C.btn, padding: "2px 7px", opacity: recoverOn(p) ? 1 : 0.45 }}
                        onClick={(e) => { e.stopPropagation(); void toggleRecover("provider", p); }}
                        title={"provider 级限流到期提醒：" + (recoverOn(p) ? "开（点此关闭；未单独设置的模型随之）" : "关（点此开启）")}>{"🔔"}</button>
                    )}
                    <button style={{ ...C.btn, marginLeft: "auto" }} onClick={(e) => { e.stopPropagation(); doProbe(p, null); }} disabled={busy} title={gSub ? "检查该订阅 provider 的订阅状态（qoder 查配额余量 / 其余查登录态）" : "探测该 provider 下所有模型（" + g.length + " 个）"}>{gSub ? "检查订阅" : "测全部"}</button>
                  </div>
                  {open ? <div style={{ paddingLeft: 10, borderLeft: "2px solid var(--border,#e0e0e0)", margin: "2px 0 2px 6px" }}>{g.map(rowNode)}</div> : null}
                </div>
              );
            })}
          </div>}
        <div style={{ marginTop: 10, color: "var(--text-subtle,#666)", fontSize: 11 }}>
          provider 树：点行展开/收起（默认收起）· 每行有「测」=探测该 provider · 模型行「测」=单模型 · 点模型名看历史 · 排序：可用优先（最近可用在前），报错排最后
        </div>
        {renderBlocked(state)}
        {renderRuntime(state)}
      </div>
    );
  };

  // 运行期错误观测汇总：代理真实流量的非 2xx/3xx（带 key 归因，按状态分类）——
  // 临时故障可能尚未反映到探测状态；与「运行期阻断记录」不同：只是观测，不标记模型不可用（探测才是权威）。
  const renderRuntime = (state: any) => {
    const rt = state && state.runtimeErrors;
    const list: any[] = rt && rt.models ? Object.values(rt.models).filter((m: any) => m.count24h > 0)
      .sort((a: any, b: any) => b.count1h - a.count1h || b.count24h - a.count24h) : [];
    if (!list.length) return null;
    const clsOf = (m: any) => Object.entries(m.byStatus || {})
      .sort((a: any, b: any) => (b[1].count24h || 0) - (a[1].count24h || 0))
      .map(([s, b]: any) => { const i = rtErrInfo(Number(s)); return i.icon + (rtErrMeta[String(s)] ? rtErrMeta[String(s)].label : "HTTP " + s) + "×" + b.count24h; })
      .join(" · ");
    return (
      <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.25)", fontSize: 11.5 }}>
        <div style={{ fontWeight: 600, color: "#b45309", marginBottom: 4 }}>运行期错误观测（带外 · 多 key/聚合代理真实流量的非 2xx/3xx，带 key 归因；只提示不标记，权威确认请点「测」或 model_probe）：</div>
        {list.slice(0, 8).map((m: any) => {
          const capped = m.count24h >= 80 ? "+" : "";
          const info = rtErrInfo(m.lastStatus);
          const cls = clsOf(m);
          const keys = Object.entries(m.keys || {}).sort((a: any, b: any) => (b[1].count24h || 0) - (a[1].count24h || 0)).slice(0, 3)
            .map(([n, k]: any) => rtErrInfo(k.lastStatus).icon + n + " ×" + k.count24h).join("，");
          return (
            <div key={m.provider + "/" + m.model} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 2, alignItems: "center" }}>
              <span style={{ fontWeight: 600 }}>{info.icon + " " + m.provider + "/" + m.model}</span>
              <span style={{ color: m.count1h > 0 ? "#dc2626" : "#d97706", fontWeight: 600 }}>{"1h ×" + m.count1h + " · 24h ×" + m.count24h + capped}</span>
              {cls ? <span style={{ color: "var(--text-subtle,#666)" }}>{cls}</span> : null}
              {m.lastAt ? <span style={{ ...C.mono, color: "var(--text-subtle,#666)" }}>{"最近 " + new Date(m.lastAt).toLocaleString("zh-CN", { hour12: false })}</span> : null}
              {keys ? <span style={{ ...C.mono, color: "var(--text-subtle,#666)" }}>keys：{keys}</span> : null}
              {!m.runtimeOnly ? <button style={{ ...C.btn, padding: "1px 8px", fontSize: 10.5 }} onClick={() => doProbe(m.provider, m.model)} disabled={busy}>重检</button> : null}
            </div>
          );
        })}
        {list.length > 8 ? <div style={{ color: "var(--text-subtle,#666)" }}>{"…另有 " + (list.length - 8) + " 个模型"}</div> : null}
      </div>
    );
  };

  // 运行期被阻断的执行记录（大量 429 导致任务中断 → 自动标记模型不可用）
  const renderBlocked = (state: any) => {
    const list = (state && Array.isArray(state.blockedExecutions) ? state.blockedExecutions : []);
    if (!list.length) return null;
    return (
      <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "rgba(220,38,38,.06)", border: "1px solid rgba(220,38,38,.22)", fontSize: 11.5 }}>
        <div style={{ fontWeight: 600, color: "#b91c1c", marginBottom: 4 }}>⛔ 运行期阻断记录（执行中大量 429 导致任务中断 → 已通知模型检查并标记不可用）：</div>
        {list.slice(-5).map((b: any) => (
          <div key={b.at + b.provider + b.model} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
            <span style={{ ...C.mono, color: "var(--text-subtle,#666)" }}>{new Date(b.at).toLocaleString("zh-CN", { hour12: false })}</span>
            <span style={{ fontWeight: 600 }}>{(b.provider + "/" + b.model) || "?"}</span>
            <span style={{ color: "#b91c1c" }}>{b.count + " 次 429"}</span>
            {b.marked ? <span style={{ color: "#b91c1c", fontWeight: 600 }}>已标记不可用</span> : <span style={{ color: "var(--text-subtle,#666)" }}>未达标记线（不误标）</span>}
            {b.errorSummary ? <span style={{ ...C.mono, color: "var(--text-subtle,#666)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>{b.errorSummary}</span> : null}
          </div>
        ))}
      </div>
    );
  };

  const renderHistory = () => {
    if (!data) return null;
    const hist = data.history || [];
    if (!hist.length) {
      // 订阅模型（协议特殊）不逐模型探针 → 无历史；引导看 provider 行订阅状态
      const subModel = histFilter && Array.isArray(data.models)
        ? (data.models as any[]).find((m: any) => m.provider === histFilter.provider && m.model === histFilter.model && m.subscription)
        : null;
      return <div style={C.msg}>{subModel ? "订阅模型走引擎接入，不逐模型探针（无逐模型历史）——看 provider 行「检查订阅」的订阅状态" : "暂无历史（先探测）"}</div>;
    }
    return (
      <div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button style={C.btn} onClick={() => { setTab("status"); load(); }}>← 返回状态</button>
          <button style={C.btn} onClick={() => { setHistFilter(null); loadHist(null, null); }} disabled={busy}>全部</button>
          {histFilter ? <span style={{ color: "var(--text-subtle,#666)" }}>{"筛选: " + histFilter.provider + "/" + histFilter.model}</span> : null}
          <span style={{ marginLeft: "auto", color: "var(--text-subtle,#666)" }}>{hist.length + " 条"}</span>
        </div>
        {hist.slice().reverse().map((x: any, i: number) => (
          <div key={i} style={C.row}>
            <span style={{ display: "flex" }}><Ic size={14} paths={x.ok ? "icons/check-circle.svg" : x.status === 429 ? "icons/x-circle.svg" : "icons/alert.svg"} /></span>
            <span style={{ fontWeight: 600 }}>{x.provider + "/" + x.model}</span>
            <span style={{ ...C.mono, color: "var(--text-subtle,#666)" }} title={agoTitle(x.ts)}>{fmtAgo(x.ts) + " 检查 · HTTP " + (x.status || "net") + " · " + fmtMs(x.latencyMs)}</span>
            {x.ok ? <span style={C.mono}>{JSON.stringify(x.text || "")}</span>
              : <span style={{ color: "#dc2626" }}>{x.label || (x.status === 429 ? "限流" : statusLabel({ lastOk: 0, lastProbedAt: 1, rateLimited: 0, lastLabel: null, lastStatus: x.status }))}</span>}
            {x.status === 429 ? <span style={{ color: "#dc2626" }}>{"预计恢复 " + fmtPredict(x.predictedAvailableAt)}</span> : null}
          </div>
        ))}
      </div>
    );
  };

  const renderBalance = () => {
    const balances = (data && data.state && data.state.balances) || {};
    const recs = Object.values(balances);
    // 合并：已配置 provider（含未查的 → 合成 pending 条目显示「待查」）+ 仅有余额记录的 provider。
    // 与状态页同规则：provider 列与 models 的 provider 列表一致，不漏已配置但未查询的 provider。
    const provs = [...new Set([...((data && data.models) || []).map((m: any) => m.provider), ...recs.map((b: any) => b.provider)])].sort();
    const list: any[] = provs.map((p) => balances[p] || { provider: p, pending: true });
    const cnt = (f: (b: any) => boolean) => list.filter(f).length;
    return (
      <div>
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button style={{ ...C.btn, ...C.btnPrimary }} onClick={() => checkBal(true)} disabled={busy}><Ic size={13} paths={"icons/wand.svg"} />{" "}查全部余额</button>
          <button style={C.btn} onClick={() => checkBal(false)} disabled={busy}><Ic size={13} paths={"icons/search.svg"} />{" "}读缓存</button>
          <span style={{ color: "var(--text-subtle,#666)" }}>{"可查 " + cnt((b) => b.ok && !b.exhausted) + " · ❌ 用满 " + cnt((b) => b.ok && b.exhausted) + " · ⚪ 无接口 " + cnt((b) => b.unsupported) + " · ⚠️ 失败 " + cnt((b) => !b.pending && !b.ok && !b.unsupported) + " · ⚪ 待查 " + cnt((b) => b.pending)}</span>
        </div>
        {list.length === 0 ? <div style={C.msg}>还没有余额记录 —— 点「查全部余额」</div> : null}
        {list.map((b, i) => {
          if (b.pending) {
            // 已配置但未查询余额 → 待查（灰）
            return (
              <div key={"b" + i} style={C.row}>
                <span style={{ display: "flex", color: "#9ca3af" }}><Ic size={14} paths={"icons/radio-dot.svg"} /></span>
                <span style={{ fontWeight: 600 }}>{b.provider}</span>
                <span style={{ background: "var(--bg-subtle,#f5f5f5)", borderRadius: 6, padding: "0 6px", color: "var(--text-subtle,#666)", fontSize: 11 }}>待查</span>
                <span style={{ color: "var(--text-subtle,#666)" }}>尚未查询余额</span>
                <button style={{ ...C.btn, marginLeft: "auto" }} onClick={() => checkBal(true)} disabled={busy} title="查询该 provider 余额（按全部 provider 查）">查</button>
              </div>
            );
          }
          // 用满/限流（任意窗口用满即不可用）→ 红色不可用；查询失败 → 红；无接口 → 灰
          const unusable = (b.ok && b.exhausted) || (!b.ok && !b.unsupported);
          const icon = <Ic size={14} paths={b.unsupported ? "icons/alert.svg" : unusable ? "icons/x-circle.svg" : "icons/check-circle.svg"} />;
          const color = b.unsupported ? "#9ca3af" : unusable ? "#dc2626" : "#16a34a";
          return (
            <div key={"b" + i} style={C.row}>
              <span style={{ display: "flex", color }}>{icon}</span>
              <span style={{ fontWeight: 600 }}>{b.provider}</span>
              {b.label ? <span style={{ background: "var(--bg-subtle,#f5f5f5)", borderRadius: 6, padding: "0 6px", color: "var(--text-subtle,#666)", fontSize: 11 }}>{b.label}</span> : null}
              {b.ok ? <span style={{ color, fontWeight: 600 }}>{b.text || ""}</span> : <span style={{ color: "var(--text-subtle,#666)" }}>{b.reason || b.text || ""}</span>}
              {b.checkedAt ? <span style={{ marginLeft: "auto", color: "var(--text-subtle,#666)", fontSize: 11 }}>{new Date(b.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}</span> : null}
            </div>
          );
        })}
      </div>
    );
  };

  // token 数简写（信息弹层参数区）：131072 → 128k / 1048576 → 1M
  const fmtTokN = (n: any) => (n == null || n === "") ? "-" : Number(n) >= 1000000 ? (Math.round(Number(n) / 100000) / 10) + "M" : Math.round(Number(n) / 1000) + "k";
  // 👁 模型信息弹层：检查状态（快照：探测/分 key/运行期观测）+ 模型参数（向导 /modelParams 五源反填：窗口/上限/模态/价格）
  const infoNode = info ? (() => {
    const m = info.m || {};
    const infoRow = (k: string, v: any, key?: string) => (
      <div key={key || k} style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.7 }}>
        <span style={{ color: "var(--text-subtle,#666)", flexShrink: 0, minWidth: 64 }}>{k}</span>
        <span style={{ minWidth: 0, wordBreak: "break-all" }}>{v}</span>
      </div>
    );
    const p = info.params;
    const cost = (p && p.cost) || {};
    const kb = keyBadges(m);
    const rt = m.runtimeErrors;
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 2147483200, background: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
        onClick={(e) => { if (e.target === e.currentTarget) closeInfo(); }}>
        <div style={{ width: "min(600px, 96vw)", maxHeight: "86dvh", overflow: "auto", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", border: "1px solid var(--border,#e0e0e0)", borderRadius: 14, boxShadow: "0 16px 64px rgba(0,0,0,.3)", font: "13px/1.5 system-ui, -apple-system, sans-serif", padding: 14 }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Ic size={14} paths={"icons/eye.svg"} />
            <span style={{ fontWeight: 700, fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "ui-monospace,monospace" }}>{info.provider + " / " + info.model}</span>
            {!m.runtimeOnly ? <span style={badge(m)}>{statusLabel(m)}</span> : null}
            <button style={C.btn} onClick={closeInfo} aria-label="关闭"><Ic size={12} paths={"icons/x.svg"} /></button>
          </div>

          <div style={{ fontWeight: 650, fontSize: 12, marginBottom: 4 }}>检查状态</div>
          {infoRow("探测", m.runtimeOnly ? "未配置（可能已删除，但代理真实流量仍观测到错误）"
            : m.lastProbedAt ? "HTTP " + (m.lastStatus || "-") + " · " + fmtMs(m.lastLatencyMs) + " · " + new Date(m.lastProbedAt).toLocaleString("zh-CN", { hour12: false })
            : m.pending ? "已配置，未探测（列表行点「测」开始）" : "未探测")}
          {m.rateLimited ? infoRow("预计恢复", <span style={{ color: "#dc2626" }}>{fmtPredict(m.predictedAvailableAt)}</span>) : null}
          {m.lastError ? infoRow("错误", <span style={{ color: "#dc2626" }}>{m.lastError}</span>) : null}
          {m.lastText && m.lastOk ? infoRow("响应", <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 11 }}>{String(m.lastText).slice(0, 120)}</span>) : null}
          {m.combo ? infoRow("聚合", <span>{"🧩 " + (m.comboMembers || []).join(" + ") + "（引擎路由：粘性 + 权重，不直接探测）"}</span>) : null}
          {m.subscription ? infoRow("订阅", "订阅登录型 provider（凭据在 auth.json，不直接探测；provider 行可「检查订阅」）") : null}
          {m.blockedAt ? infoRow("阻断", <span style={{ color: "#dc2626" }}>{new Date(m.blockedAt).toLocaleString("zh-CN", { hour12: false }) + " 因大量 429 被标记不可用（" + (m.blockedCount || 1) + " 次）"}</span>) : null}
          {kb ? <div style={{ marginTop: 2 }}>{kb}</div> : null}
          {rt && rt.count24h ? infoRow("运行观测", <span style={{ color: rt.count1h ? "#dc2626" : "#d97706" }}>{"近 1h " + rt.count1h + " 次 / 24h " + rt.count24h + " 次错误（代理真实流量）" + (rt.lastAt ? " · 最近 " + new Date(rt.lastAt).toLocaleString("zh-CN", { hour12: false }) + " HTTP " + (rt.lastStatus || "-") : "")}</span>) : null}

          <div style={{ fontWeight: 650, fontSize: 12, margin: "10px 0 4px" }}>模型参数</div>
          {info.loading ? <div style={{ color: "var(--text-subtle,#666)", fontSize: 12 }}>加载中…（模型管理五源反填）</div>
            : info.error ? <div style={{ padding: "6px 9px", borderRadius: 8, background: "rgba(245,158,11,.1)", border: "1px solid rgba(245,158,11,.35)", color: "#b45309", fontSize: 12 }}>{"⚠️ " + info.error}</div>
            : p ? (
              <>
                {info.crossFrom ? <div style={{ marginBottom: 4, fontSize: 11, color: "#b45309" }}>{"本 provider 未收录该模型，参数借其它网关同 id 条目互证（" + info.crossFrom + "）—— 价格以该网关为准"}</div> : null}
                {infoRow("显示名", p.name || "-")}
                {infoRow("上下文", fmtTokN(p.contextWindow) + (p.contextWindow ? " tokens" : ""))}
                {infoRow("最大输出", fmtTokN(p.maxTokens) + (p.maxTokens ? " tokens" : ""))}
                {infoRow("模态", (Array.isArray(p.input) ? p.input.join(" / ") : "-") + " → " + (Array.isArray(p.output) ? p.output.join(" / ") : "text"))}
                {infoRow("推理", p.reasoning ? "支持推理" : "—")}
                {infoRow("价格", "输入 " + fmtUnitPrice(cost.input) + " · 输出 " + fmtUnitPrice(cost.output) + (cost.cacheRead != null ? " · 缓存读 " + fmtUnitPrice(cost.cacheRead) : "") + "（$/M tokens）")}
                {info.baseUrl ? infoRow("端点", <span style={{ fontFamily: "ui-monospace,monospace" }}>{info.baseUrl + (info.api ? " · " + info.api : "")}</span>) : null}
                {info.readOnly ? <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-subtle,#666)" }}>只读 · 目录反填（该 provider 未写入 models.json，参数由引擎/目录管理）</div> : null}
              </>
            ) : null}

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {!m.combo && !m.subscription ? (
              <button style={{ ...C.btn, ...C.btnPrimary }} title="在模型管理中查看/编辑该模型完整参数（窗口/上限/价格/兼容层）"
                onClick={() => {
                  const viewParams = extSvc<(p: string, id: string) => void>("aiti-model-wizard.viewParams") || window.__aitiModelWizardViewParams; // DI 方案 P2 双轨
                  if (typeof viewParams === "function") { try { viewParams(info.provider, info.model); closeInfo(); return; } catch { /* 回退跳转 */ } }
                  gotoWizard("status");
                }}>编辑参数</button>
            ) : null}
            <button style={C.btn} onClick={() => { const pf = { provider: info.provider, model: info.model }; setHistFilter(pf); setTab("history"); closeInfo(); loadHist(pf.provider, pf.model); }}>检查历史</button>
            <button style={C.btn} disabled={busy} onClick={() => { doProbe(info.provider, info.model); closeInfo(); }} title="立即重测该模型可用性">重新探测</button>
            <button style={{ ...C.btn, marginLeft: "auto" }} onClick={closeInfo}>关闭</button>
          </div>
        </div>
      </div>
    );
  })() : null;

  // 小屏全屏交给 aiti-float 的 data-ext-float-full 标记；small 只管安全区内边距与标题文案
  const headStyle = small ? { ...C.head, paddingTop: "max(10px, env(safe-area-inset-top, 0px))" } : C.head;
  const bodyStyle = small ? { ...C.body, paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))" } : C.body;
  // 嵌入模式：body 不自带 padding/滚动（外层向导 body 统一负责），避免双层滚动条
  const embedBodyStyle = { padding: 0, overflow: "visible", flex: 1, minHeight: 0 };
  const tabsRow = (
    <div style={C.tabs}>
      {[["status", "状态"], ["balance", "余额"], ["history", "历史"]].map(([k, label]) => (
        <button key={k} style={{ ...C.tab, ...(tab === k ? C.tabOn : {}) }}
          onClick={() => { setTab(k); if (k === "status") load(); else if (k === "balance") checkBal(false); else { setHistFilter(null); loadHist(null, null); } }}>
          {label}
        </button>
      ))}
    </div>
  );
  const bodyNode = (
    <div key={"body-" + tab} style={embedded ? embedBodyStyle : bodyStyle}>
      {busy ? <div style={{ color: "var(--text-subtle,#666)", marginBottom: 6 }}>处理中…</div> : null}
      {msg ? <div style={C.msg}>{msg}</div> : null}
      {nmTip ? (
        <div style={{ padding: "6px 10px", borderRadius: 8, marginBottom: 8, fontSize: 12, background: "rgba(34,197,94,.1)", border: "1px solid rgba(34,197,94,.35)", color: "#15803d", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 0 }}>{"检查时发现 " + nmTip.total + " 个未启用的新模型：" + nmTip.text}</span>
          <button style={{ ...C.btn, flexShrink: 0 }} onClick={() => gotoWizard("status")} title="打开模型向导 · 已配置页查看并启用">去启用</button>
          <button style={{ ...C.btn, flexShrink: 0, padding: "2px 8px" }} onClick={() => setNmTip(null)} aria-label="关闭">✕</button>
        </div>
      ) : null}
      {tab === "status" ? renderStatus() : tab === "balance" ? renderBalance() : renderHistory()}
    </div>
  );
  // 嵌入：紧凑头（标题 + 子 tab，无外框/关闭）+ 内容；外层容器由宿主（向导）提供
  if (embedded) {
    return (
      <>
        {infoNode}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingBottom: 8, marginBottom: 8, borderBottom: "1px solid var(--border,#e0e0e0)" }}>
            {/* hideTitle：dock face 语境——DockBody section 头行已有同名标题，双标题收敛（v3.1） */}
            {hideTitle ? null : <span style={{ fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}><Ic size={14} paths={"icons/radio.svg"} />模型可用性</span>}
            {tabsRow}
          </div>
          {bodyNode}
        </div>
      </>
    );
  }
  return (
    <>
      {infoNode}
      <div style={C.root} data-ext-float="1" data-ext-float-key={MC_KEY} data-ext-float-dock={`${sidebarZoneOf(MC_KEY)} right-panel`} data-ext-float-dock-default={sidebarZoneOf(MC_KEY)} data-ext-float-w={620} data-ext-float-autoh="1" data-ext-float-full="1">
        <div style={headStyle}>
          <span style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic size={15} paths={"icons/radio.svg"} />{small ? null : "模型可用性"}
          </span>
          {tabsRow}
          <button style={C.btn} onClick={() => onClose()} aria-label="关闭"><Ic size={12} paths={"icons/x.svg"} /></button>
        </div>
        {bodyNode}
      </div>
    </>
  );
}

// toolbar 按钮（feature 门控：behavior.showToolbar 开启才显示）
export function ModelButton() {
  const open = () => { try { window.__aitiModelCheckOpen && window.__aitiModelCheckOpen(); } catch {} };
  const [show, setShow] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    // 初始：读 host 共享 feature store（manifest 已统一拉取，无独立请求）
    setShow(featToolbar());
    // 变更：订阅 host 统一通知（extman 改 → host patch store → 通知）
    const unsub = typeof mcCtx?.onFeatureChange === "function"
      ? mcCtx.onFeatureChange(() => { if (alive) setShow(featToolbar()); })
      : null;
    return () => { alive = false; if (unsub) unsub(); };
  }, []);
  // feature 关闭（默认）→ 不展示：模型检查从模型向导「检查」入口进入
  if (!show) return null;
  // 顶栏按钮样式与系统内建按钮一致（AppShell topbarRowBtnStyle：flex 居中 + fixed 36×36）
  return (
    <button
      title="模型可用性（探测 / 429 限流识别）"
      onClick={open}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      }}
    >
      {/* lucide radio：信号探测——与系统内建线条图标同风格 */}
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path key="p1" d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
        <path key="p2" d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
        <circle key="c1" cx={12} cy={12} r={2} />
        <path key="p3" d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
        <path key="p4" d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1" />
      </svg>
    </button>
  );
}

export function ModelDialog() { return renderModelDialog("float"); }
export function ModelCheckDockFace() { return renderModelDialog("dock"); }
export function ModelCheckDockRight() { return renderModelDialog("right"); }

function renderModelDialog(face?: string) {
  const st = usePresent(MC_KEY);
  // 头行按钮状态（内容上报）；hook 必须在早退之前调用（hook 顺序稳定）
  const hs = useDockHeaderStateOf(MC_KEY);
  // 三面（本批 P4）：float=浮窗 / right=右栏 tab / dock=左栏区块（sidebar 族任意落位）
  const open = face === "float" ? st === "floating"
    : face === "right" ? st === "docked:right-panel"
    : isSidebarDockState(st);
  const floating = face === "float";
  useEffect(() => {
    window.__aitiModelCheckOpen = () => openFloat(MC_KEY);
    // DI 方案 P2：services 通道双轨注册（旧全局保留至消费方迁完；旧宿主 no-op）
    const disposeSvc = (typeof mcCtx?.registerExtService === "function")
      ? mcCtx.registerExtService("aiti-model-check.open", window.__aitiModelCheckOpen) : null;
    return () => { try { disposeSvc?.(); } catch {} delete window.__aitiModelCheckOpen; };
  }, []);
  if (!open) return null;
  const app = <App open={true} onClose={() => closePanel(MC_KEY)} embedded={!floating} hideTitle={!floating} dockItemKey={floating ? undefined : MC_KEY} />;
  if (floating) return app;
  const mcInner = (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontSize: 13 }}>
      {app}
    </div>
  );
  const mcZones: any[] = [sidebarZoneOf(MC_KEY), "right-panel"];
  // 右栏 tab face（chrome="tab"：无头行）
  if (face === "right") {
    return (
      <DockBody itemKey={MC_KEY} zone="right-panel" title="模型可用性" chrome="tab"
        zones={mcZones} defaultZone={sidebarZoneOf(MC_KEY)}>{mcInner}</DockBody>
    );
  }
  // 左栏区块 face：统一头行（标题 + 业务按钮 + ⇱ detach + ⋮）；zone 用规范值 sidebar:<key>
  const actions: DockHeaderAction[] = [
    { id: "probe", title: "探测全部", icon: <Ic size={12} paths={"icons/search.svg"} />, disabled: hs.busy === true, visibility: "always", onClick: () => { requestDockCommand(MC_KEY, "probe"); } },
    { id: "refresh", title: "刷新状态", icon: <Ic size={12} paths={"icons/refresh.svg"} />, disabled: hs.busy === true, visibility: "always", onClick: () => { requestDockCommand(MC_KEY, "refresh"); } },
  ];
  return (
    <DockBody itemKey={MC_KEY} title="模型可用性" chrome="section" kind="dockable"
      zones={mcZones} defaultZone={sidebarZoneOf(MC_KEY)}
      headerActions={actions}>
      {mcInner}
    </DockBody>
  );
}

// 顶部工具条按钮注册同步：仅当 behavior.showToolbar 开启时才注册（默认关）。
// 关 → 不注册 → 不进顶栏行 / ⋯ 菜单 / 顶栏自定义面板（否则会以空壳/文字残留，即使 ModelButton 返回 null）。
// 开↔关动态生效：extman 变更 → ctx.onFeatureChange → 重新注册/注销。
let toolbarRegistered = false;
// 懒加载 v2 M3批②：toolbar 门控静态化——注册恒声明式（无 render），feature 开关交给
// 宿主按 ui.toolbar[].feature 统一过滤（patchExtFeature → bump 即时显隐），客户端不再动态注册/反注册。
export function syncToolbar() {
  const ctx = mcCtx;
  if (!ctx) return;
  ctx.registerItems("toolbar", [{
    id: "aiti-model-check-open",
    meta: {
      label: "模型检查",
      title: "aiti-model-check：模型可用性探测 / 429 限流识别 / 可用时间",
      icon: "icons/radio.svg",
      // 点击转发（静态入口）与 extman「打开」（meta.open 优先）双通道同路。
      onClick: () => { try { window.__aitiModelCheckOpen && window.__aitiModelCheckOpen(); } catch {} },
      open: () => { try { window.__aitiModelCheckOpen && window.__aitiModelCheckOpen(); } catch {} },
    },
    feature: "behavior.showToolbar",
  }]);
}
