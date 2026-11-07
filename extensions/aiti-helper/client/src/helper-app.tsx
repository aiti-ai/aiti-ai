/**
 * aiti-helper · AI 输入 dialog + 历史管理 —— JSX 版（自手写 h() 版迁移，功能一比一）。
 *
 * 设计：docs/aiti-ai-helper-plan.md §4.3（invoke → 审核 → 落地）+ §4.4（全局弹窗 AI 按钮）
 * 架构：扩展/用户 → window.__aitiHelperInvoke(...) → 独立置顶弹窗 → invoke → 预览 → 落地
 * 全局弹窗 AI 按钮（MutationObserver 注入）见 ./dialog-ai-button.ts。
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { apiUrl, hostCtx, extSvc } from "./host-shim";
import { dismissOnBack } from "../../../_shared/overlay-back-client";
import { extDisplayName } from "../../../_shared/ext-display-names";

declare global {
  interface Window {
    __aitiHelperInvoke?: (opts?: HelperInvokeOpts) => boolean;
    __aitiSuggestAiFallback?: (q: string) => void;
    __aitiHelperCleanup?: () => void;
    BridgeClient?: { listSessions?: () => Promise<any[]> };
    __AITI_AI_WIN__?: unknown;
  }
}

export interface HelperInvokeOpts {
  system?: string;
  placeholder?: string;
  contextLabel?: string;
  helperId?: string;
  cwd?: string;
  dialogEl?: HTMLElement | null;
  extId?: string;
  extName?: string;
  /** 预填主输入框的提示词（外部 invoke 用，如模型缺参数时预填“帮我补全这些模型的参数…”） */
  message?: string;
  /** 预填后自动发送（无需用户点「生成」）；仅首次 invoke 生效，追问不自动发 */
  autoSend?: boolean;
  [k: string]: unknown;
}

// register 上下文（apiUrl/sendChatMessage 用；entry.tsx 里 setMcCtx(ctx)）
let mcCtx: Record<string, any> | null = null;
export function setMcCtx(ctx: Record<string, any>) { mcCtx = ctx; }

// ==================== 全局状态（跨组件通信：invoke 入口 ↔ dialog 渲染） ====================
export const _state = {
  open: false,
  opts: null as HelperInvokeOpts | null,
  lastResult: "",
  loading: false,
  error: null as string | null,
  historyId: null as string | null,   // 当前结果对应历史记录 id（落地时回传标记）
  sessionId: null as string | null,   // 当前结果对应的 agent 会话 id（追问 steer 同一会话，上下文完整延续）
  dialogEl: null as HTMLElement | null, // 触发本次 invoke 的弹窗元素（fill 回填用）
  pageId: null as string | null,      // 当前发起页面在 aiti-devtools 桥里的 pageId——预取后随 invoke 报告
  isAiWin: false,                     // 是否 AI 主窗口（xxx/ai）
  pos: { x: null as number | null, y: null as number | null }, // 弹窗位置（null=默认右上角）
  compact: false,
  dim: false,                         // 失焦半透明
  activeTab: "ai" as "ai" | "history",
};
const _listeners = new Set<() => void>();
export const notify = () => _listeners.forEach((fn) => fn());
export const closePanel = () => { _state.open = false; notify(); };

// lucide 图标（与系统内建线条图标同风格）
const Ic = ({ size, paths }: { size: number; paths: string[] }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);
const ICONS = {
  // sparkles 已删：AI 星星统一走 SparkIcon（单源 icons/sparkles.svg，见上）
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  help: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"],
  plus: ["M5 12h14", "M12 5v14"],
  bot: ["M12 8V4H8", "M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
  copy: ["M8 8H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2", "M14 2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6l-4-4z", "M14 2v6h6"],
  msg: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
  refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
  expand: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  chevron: ["m9 18 6-6-6-6"],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"],
  wrench: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
};

/** 计算一个不遮挡源弹窗的面板位置（4 角候选 → 选与源弹窗重叠面积最小的） */
function computeAvoidingPos(dialogEl: HTMLElement | null) {
  const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;
  const pw = Math.min(440, Math.max(320, vw - 32));   // 避让模式用窄面板
  const ph = Math.min(Math.round(vh * 0.7), vh - 32);
  let dr: DOMRect | null = null;
  try { if (dialogEl && dialogEl.getBoundingClientRect) dr = dialogEl.getBoundingClientRect(); } catch {}
  if (!dr || dr.width < 50 || dr.height < 50) return null;   // 拿不到盒子 → 走默认右上
  const cand = [
    { x: vw - pw - 16, y: 16, label: "tr" },
    { x: 16, y: 16, label: "tl" },
    { x: vw - pw - 16, y: vh - ph - 16, label: "br" },
    { x: 16, y: vh - ph - 16, label: "bl" },
  ];
  const ov = (c: { x: number; y: number }) => {
    const cx = Math.max(0, Math.min(c.x + pw, dr!.right) - Math.max(c.x, dr!.left));
    const cy = Math.max(0, Math.min(c.y + ph, dr!.bottom) - Math.max(c.y, dr!.top));
    return cx * cy;
  };
  let best = cand[0], bo = ov(best);
  for (const c of cand) { const o = ov(c); if (o < bo) { bo = o; best = c; } }
  return { x: best.x, y: best.y, compact: true };
}

/** 外部调用入口：扩展/弹窗 AI 按钮/suggest 兜底 都经此唤起。
 *
 * [懒加载 v2 拆包] 不再自行挂 window 全局/注册 services——那归薄 entry 的稳定转发入口管
 * （见 entry.tsx）；本函数只装配真身并返回，由薄 entry 在重 chunk 加载完成后接管转发。
 */
export function installInvokeEntry(): (opts: HelperInvokeOpts) => boolean {
  const invoke = function (opts: HelperInvokeOpts = {}) {
    _state.open = true;
    _state.opts = opts;
    _state.lastResult = "";
    _state.loading = false;
    _state.error = null;
    _state.historyId = null;
    _state.sessionId = null;
    _state.activeTab = "ai";
    _state.dim = false;
    // opts.dialogEl：从弹窗 AI 按钮唤起时带上目标弹窗（fill 回填用）+ 避让定位（不遮源弹窗）
    _state.dialogEl = opts.dialogEl || null;
    const avoid = opts.dialogEl ? computeAvoidingPos(opts.dialogEl) : null;
    if (avoid) { _state.pos = { x: avoid.x, y: avoid.y }; _state.compact = true; }
    else { _state.pos = { x: null, y: null }; _state.compact = false; }   // 默认右上
    notify();
    return true;
  };
  return invoke;
}

// 重 chunk 装配防重入（mountHeavyUI 只应执行一次；薄 entry ensureHeavy 单例之外的双保险）
let _heavyMounted = false;

/** [懒加载 v2 拆包] 重 UI 装配：pages slot 注册弹窗 + 装配 invoke 真身。
 * 由薄 entry（entry.tsx）在首次 invoke / 需要弹窗时动态 import 本模块后调用一次；
 * 返回 invoke 真身供薄 entry 接管稳定转发入口。 */
export function mountHeavyUI(): (opts: HelperInvokeOpts) => boolean {
  if (_heavyMounted) {
    // 理论不可达（薄 entry ensureHeavy 单例 + 本标志双保险）；兜底走稳定全局入口
    return (opts) => { try { (window as any).__aitiHelperInvoke(opts); } catch { /* noop */ } return true; };
  }
  _heavyMounted = true;
  const ctx = hostCtx();
  // dialog → pages（不随 session 切换卸载——满足「点击其他 session 弹窗不关闭」）
  ctx?.registerItems?.("pages", [{ id: "aiti-helper-dialog", render: AiHelperDialog }]);
  return installInvokeEntry();
}

function tabStyle(active: boolean) {
  return {
    padding: "3px 10px", borderRadius: 7, cursor: "pointer", fontSize: 12,
    border: "1px solid " + (active ? "var(--accent,#2563eb)" : "transparent"),
    background: active ? "rgba(37,99,235,.12)" : "transparent",
    color: "inherit",
  } as React.CSSProperties;
}
function closeBtnStyle(): React.CSSProperties {
  return { background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 17, padding: "0 4px", lineHeight: 1, flexShrink: 0 };
}
function btnStyle(variant?: string): React.CSSProperties {
  const base: any = { padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12, border: "1px solid var(--border,#e0e0e0)", background: "rgba(128,128,128,.08)", color: "inherit" };
  if (variant === "primary") { base.background = "rgba(37,99,235,.12)"; base.borderColor = "var(--accent,#2563eb)"; base.fontWeight = 500; }
  return base;
}
// 输入框通用样式（新增 skill 表单用）
function inputStyle(): React.CSSProperties {
  return { width: "100%", padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f5f5f5)", color: "inherit", fontSize: 12, outline: "none", boxSizing: "border-box" };
}

// AI 星星图标（SparkIcon）：单源 icons/sparkles.svg（_shared/icons 库经 deploy copyIcons 拷入扩展），
// assets CSS-mask 渲染（currentColor 继承；与 aiti-model-check Ic 同款）。
// 所有 AI 星星（弹窗标题/后台按钮/tab/执行/通用组/弹窗注入 🤖）都指向这一个文件，杜绝 path 手抄漂移
//（曾因 ICONS.sparkles 手抄漏 2 条 path 出现「缺左下小星」的两种星星）。
const SparkIcon = ({ size = 16 }: { size?: number }) => {
  const mask = `url("${apiUrl("/api/extensions/aiti-helper/assets/icons/sparkles.svg")}")`;
  return (
    <span aria-hidden style={{
      display: "inline-block", width: size, height: size, flexShrink: 0, background: "currentColor",
      WebkitMaskImage: mask, maskImage: mask,
      WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
      WebkitMaskPosition: "center", maskPosition: "center",
      WebkitMaskSize: "contain", maskSize: "contain",
    }} />
  );
};

// ==================== 预取当前页面 pageId（发起方来源标注用） ====================
// 当前页面在 aiti-devtools 桥里的 pageId（如 xxx/ai = AI 主窗口、xxx/host = 宿主页）。
// 经 BridgeClient.listSessions 匹配当前页面（self 标记 / url 匹配）异步拿；桥未连通时延迟重试。
export function prefetchPageId() {
  try {
    _state.isAiWin = window.name === "aiti-ai-popup" || !!window.__AITI_AI_WIN__;
  } catch {}
  let tries = 0;
  const attempt = () => {
    tries++;
    try {
      if (!window.BridgeClient || typeof window.BridgeClient.listSessions !== "function") {
        if (tries < 5) setTimeout(attempt, 1200 * tries);  // 桥未注入 → 退避重试
        return;
      }
      window.BridgeClient.listSessions().then((rows) => {
        const active = (rows || []).filter((r: any) => r.active);
        // 优先 url 精确匹配当前页面（多 self/多窗口时并行窗口不抢占）；无 url 匹配再兜底 self
        const cur = active.find((r: any) => r.url && location.href && (r.url === location.href || location.href.startsWith(r.url)))
          || active.find((r: any) => r.self);
        if (cur && cur.pageId) { _state.pageId = cur.pageId; if (cur.self) _state.isAiWin = true; notify(); }
        else if (tries < 5) setTimeout(attempt, 1200 * tries);
      }).catch(() => { if (tries < 5) setTimeout(attempt, 1200 * tries); });
    } catch { if (tries < 5) setTimeout(attempt, 1200 * tries); }
  };
  attempt();
}

// ==================== AI Dialog 组件（独立置顶弹窗） ====================
export function AiHelperDialog(props: Record<string, any>) {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  }, []);

  const isOpen = _state.open;
  const opts = (_state.opts || {}) as HelperInvokeOpts;

  // 小屏系统返回关闭本面板（共享接线层 dismissOnBack，方案 docs/pi-web-mobile-back-dismiss-coverage-plan.md）：
  // 旧宿主/服务缺席/桌面（>640px）自动降级。独立 AI 窗（本面板即整个页面）不接：那里返回应
  // 走浏览器默认（关闭窗口/退站）——用窗口身份判定，不看 _state.isAiWin（它在首次生成后才
  // 被桥 self 页回填，会把普通页误判成 AI 窗、导致第二次打开不再注册）。
  useEffect(() => {
    if (!isOpen) return;
    try {
      if (window.name === "aiti-ai-popup" || !!window.__AITI_AI_WIN__) return;
    } catch { /* 沙箱环境取 window.name 失败：视作普通页 */ }
    return dismissOnBack(() => extSvc("pi-web.overlayBack"), closePanel);
  }, [isOpen]);

  const [input, setInput] = useState("");
  const [followup, setFollowup] = useState("");   // 追问输入
  const [turns, setTurns] = useState<any[]>([]);  // 多轮对话历史 [{message, result, system}]（不含当前轮）

  const [helpers, setHelpers] = useState<any[] | null>(null);
  // 扩展元数据（id → { icon }，来自 /api/extensions/manifest）：分组头显示扩展 logo 用
  const [extMeta, setExtMeta] = useState<Record<string, { icon?: string | null }>>({});
  const [iconFail, setIconFail] = useState<Record<string, boolean>>({});   // logo 加载失败的扩展 → 回退 chevron

  // 外部 invoke 预填（扩展经 window.__aitiHelperInvoke 唤起）：
  //   opts.message → 预填主输入框（用户只需点「生成」）
  //   opts.helperId → 自动选中对应 skill：列表未拉回（首开竞态窗口）时先以乐观占位
  //     立即选中（消灭「打开时未选中」空窗），列表到达后换成真实条目；
  //     列表就位但找不到该 id（如已卸载）也保留占位——生成时 helperId 仍会随请求带後端。
  useEffect(() => {
    const o = _state.opts || {};
    if (o.message) setInput(String(o.message));
    if (!o.helperId) return;
    if (helpers && helpers.length) {
      const hit = helpers.find((x) => x && x.id === o.helperId);
      setSelHelper(hit || { id: o.helperId, title: o.helperId, optimistic: true });
    } else if (!helpers) {
      setSelHelper((prev) => (prev && prev.id === o.helperId ? prev : { id: o.helperId, title: o.helperId, optimistic: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_state.opts, helpers]);
  const [selHelper, setSelHelper] = useState<any>(null);
  const [viewingSkill, setViewingSkill] = useState<any>(null);   // 正在查看的 skill 说明
  const [skillLoading, setSkillLoading] = useState(false);
  const [showSkillForm, setShowSkillForm] = useState(false);     // 新增 skill 表单显隐
  const [skillForm, setSkillForm] = useState({ name: "", owner: "", title: "", summary: "", body: "" });
  const [savingSkill, setSavingSkill] = useState(false);
  const [skillMsg, setSkillMsg] = useState<{ status: string; msg: string } | null>(null);
  const [historyList, setHistoryList] = useState<any[] | null>(null);
  // skills 分组展开/收起：collapsedGroups[groupKey]=true 表示该组被收起；缺省时默认收起、搜索强制展开
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [skillSearch, setSkillSearch] = useState("");
  // 流式监听：monitor = { status, text, thinking, tools[], startedAt } | null。loading 期间在输入框下展示 AI 实时进度
  const [monitor, setMonitor] = useState<any | null>(null);
  // 总线不可用降级提示（有值时显示「无实时推送 + 打开会话」条；拍板：不做任何轮询）
  const [degraded, setDegraded] = useState<string | null>(null);
  // 总线订阅句柄（v2：aiti-event-bus topics helper-<sid>，替代旧 per-session EventSource）
  const monitorRef = useRef<{ off: () => void; sid: string } | null>(null);
  // 后台任务提示（重开弹窗时列未结算的 helper 会话）
  const [bgActive, setBgActive] = useState<any[] | null>(null);
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  const restoredRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // ---- 帮助点分组：按 owner 归类。从弹窗 AI 按钮唤起时 opts.extId = owning 扩展 ----
  // 顺序：本扩展（高亮）→ 通用（owner 为空或 aiti-helper）→ 其他扩展（逐个折叠组）
  const buildGroups = useCallback((list: any[], extId: string, extName: string) => {
    if (!list || !list.length) return [];
    const byOwner = new Map<string, any[]>();
    for (const hp of list) {
      const o = hp.owner || "";
      if (!byOwner.has(o)) byOwner.set(o, []);
      byOwner.get(o)!.push(hp);
    }
    const groups: { key: string; label: string; items: any[]; kind: string; extId: string }[] = [];
    if (extId && byOwner.has(extId)) groups.push({ key: "ext:" + extId, label: "本扩展 · " + extDisplayName(extId, extName || extId), items: byOwner.get(extId)!, kind: "ext", extId });
    const genItems = [...(byOwner.get("") || []), ...(byOwner.get("aiti-helper") || [])];
    if (genItems.length) groups.push({ key: "general", label: "通用 Skills", items: genItems, kind: "general", extId: "aiti-helper" });
    const others = [...byOwner.keys()].filter((o) => o && o !== "aiti-helper" && o !== extId).sort();
    // 分组头显示友好名（id → 双语表），表外扩展回退技术 id
    for (const o of others) groups.push({ key: "other:" + o, label: extDisplayName(o, o), items: byOwner.get(o)!, kind: "other", extId: o });
    return groups;
  }, []);

  // 拉取帮助点列表（打开时拉）
  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    fetch(apiUrl("/api/extensions/aiti-helper/helpers"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive && d.ok) setHelpers(d.helpers || []); })
      .catch(() => {});
    // 扩展清单（拿各扩展 icon 声明，分组头显示 logo）
    fetch(apiUrl("/api/extensions/manifest"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d || !Array.isArray(d.extensions)) return;
        const m: Record<string, { icon?: string | null }> = {};
        for (const e of d.extensions) { if (e && e.id) m[e.id] = { icon: e.icon || null }; }
        setExtMeta(m);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [isOpen]);

  // 历史 tab 打开时拉历史
  useEffect(() => {
    if (!isOpen || _state.activeTab !== "history") return;
    let alive = true;
    fetch(apiUrl("/api/extensions/aiti-helper/history?limit=50"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive && d.ok) setHistoryList(d.history || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isOpen, _state.activeTab]);

  const loading = _state.loading;
  const result = _state.lastResult;
  const err = _state.error;
  const activeTab = _state.activeTab;
  const dim = _state.dim;
  const pos = _state.pos;
  const compact = _state.compact;

  // 收集当前会话完整上下文（传给新 AI session）
  // dialog 挂 pages slot：props.activeCwd = 当前会话工作目录（toolbar slot 只有 currentSession:null）
  const sessionCtx = {
    sessionId: props.currentSession?.id || props.sessionId || null,
    cwd: opts.cwd || props.activeCwd || props.currentSession?.cwd || props.cwd || null,
    sessionName: props.currentSession?.name || props.sessionName || null,
    model: props.model || null,
    inputValue: props.inputValue || null,
    isStreaming: props.isStreaming || false,
  };

  // 结果落地（唯一写入口）：总线 result 帧 / 快照 / origin 恢复都经这里
  const applyResult = useCallback((payload: any) => {
    if (payload && payload.ok) {
      _state.lastResult = payload.text || "";
      _state.historyId = payload.historyId || null;
      _state.error = null;   // 成功必须清旧错误（并发/重试场景下先失败后成功时残留会误导）
    } else {
      _state.error = (payload && payload.error) || "取结果失败";
    }
    _state.loading = false;
    notify();
  }, []);

  // 结果快照（GET /result = 服务端纯快照，永不持连接；方案 docs/aiti-helper-result-event-bus-plan.md）
  //   主通道 = 总线 `helper-<sid>` 的 result 帧（带全文）；本函数只作对齐手段：
  //   ①订阅就绪后对齐 ②丢帧/重连兜底 ③重开弹窗 ④总线不可用降级。同会话并发去重，绝无轮询。
  const fetchInFlight = useRef<string | null>(null);
  const fetchSnapshot = useCallback(async (sid: string, opts?: { silent?: boolean }) => {
    if (fetchInFlight.current === sid) return;
    fetchInFlight.current = sid;
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-helper/invoke/" + encodeURIComponent(sid) + "/result"), { cache: "no-store" });
      const d = await r.json().catch(() => null);
      if (d && d.ok) applyResult(d);              // 已结算（含 history 回落）→ 直接落地
      else if (d && d.code === "running") { /* 仍在执行：保持 loading，继续等 result 帧（不是错误） */ }
      else { _state.error = (d && d.error) || "取结果失败"; _state.loading = false; }
    } catch (e: any) {
      if (!opts?.silent) { _state.error = String(e.message || e); _state.loading = false; }
    } finally {
      if (fetchInFlight.current === sid) fetchInFlight.current = null;
      notify();
    }
  }, [applyResult]);

  // 开监听（v2 总线 topics；方案：进度 plan = aiti-helper-stream-event-bus-migration-plan.md，
  // 结果 plan = docs/aiti-helper-result-event-bus-plan.md §3.3 触发矩阵）：
  //   总线 `helper-<sid>` 帧含进度 + **结果帧（evt:"result"，带全文）**——结果直接落地，不再拉长等待的 /result。
  //   快照对齐（一次性 HTTP，不是轮询）：①订阅 ready 后 ②agent_settled 兜底 ③重连 up ④end ⑤降级。
  const openMonitor = useCallback((sid: string) => {
    if (monitorRef.current) { try { monitorRef.current.off(); } catch {} monitorRef.current = null; }
    setDegraded(null);
    const detach = () => {
      if (monitorRef.current?.sid !== sid) return;
      try { monitorRef.current.off(); } catch {}
      monitorRef.current = null;
    };
    const topics = extSvc<{ subscribeTopics: (h: (f: any) => void, types: string[], onStatus?: (s: string) => void) => { ready: Promise<void>; off: () => void } }>("aiti-event-bus.subscribe-topics");
    // 总线不可用降级（拍板：保持简单，绝不轮询）——提示 + 「打开会话」按钮；再试一次快照（可能已结算）。
    const goDegraded = (why: string) => {
      setDegraded(why);
      setMonitor((m: any) => (m ? { ...m, status: "degraded" } : { status: "degraded" }));
      if (_state.loading && _state.sessionId === sid) void fetchSnapshot(sid, { silent: true });
    };
    if (!topics || typeof topics.subscribeTopics !== "function") { goDegraded("事件总线服务不可用"); return; }
    const onFrame = (frame: any) => {
      const evt = frame?.evt;
      if (evt === "message_start") {
        // 快照：从 message.content 抽已有文本块（重连/接回场景）
        const blocks = frame.message?.content; let txt = ""; const tools: any[] = [];
        if (Array.isArray(blocks)) for (const b of blocks) {
          if (b && b.type === "text" && typeof b.text === "string") txt += b.text;
          if (b && b.type === "toolCall" && b.name) tools.push({ id: b.id || b.toolCallId, name: b.name, status: "running" });
        }
        setMonitor((m: any) => m && ({ ...m, text: txt || m.text, tools: tools.length ? tools : m.tools }));
      } else if (evt === "message_update" && frame.assistantMessageEvent) {
        const ae = frame.assistantMessageEvent;
        if (ae.type === "text_delta") setMonitor((m: any) => m && ({ ...m, status: "thinking", text: (m.text || "") + (ae.delta || "") }));
        else if (ae.type === "thinking_delta") setMonitor((m: any) => m && ({ ...m, thinking: (m.thinking || "") + (ae.delta || "") }));
        else if (ae.type === "toolcall_start") setMonitor((m: any) => m && ({ ...m, status: "tool", tools: [...(m.tools || []), { id: ae.id, name: ae.toolName, status: "running" }] }));
        else if (ae.type === "toolcall_end") setMonitor((m: any) => m && ({ ...m, tools: (m.tools || []).map((t: any) => (ae.toolCall && t.id === (ae.toolCall.id || ae.toolCall.toolCallId)) ? { ...t, status: "done" } : t) }));
      } else if (evt === "tool_execution_update") {
        setMonitor((m: any) => m && ({ ...m, status: "tool", tools: (m.tools || []).map((t: any) => t.id === frame.toolCallId ? { ...t, name: frame.toolName || t.name, status: "running", partial: frame.partialResult } : t) }));
      } else if (evt === "result") {
        // 主通道：结果帧带全文（或明确错误）→ 直接落地，退订收工
        detach();
        applyResult(frame);
      } else if (evt === "agent_settled") {
        // run 真正终态：result 帧可能丢（订阅生效窗口/断线）→ 一次性快照兜底（服务端此时已结算或 3s 内标失败）
        if (_state.loading) void fetchSnapshot(sid);
      } else if (evt === "agent_end") {
        setMonitor((m: any) => m && ({ ...m, status: "done", tools: (m.tools || []).map((t: any) => ({ ...t, status: "done" })) }));
      } else if (evt === "unsupported") {
        // 宿主无 subscribeEvent（旧 pi-web）：无实时推送 → 降级
        goDegraded("宿主不支持实时事件");
      } else if (evt === "end") {
        // 会话结束/回收：未结算 → 快照拿明确终态（no_result / not_found）
        detach();
        if (_state.loading) void fetchSnapshot(sid);
      }
    };
    const sub = topics.subscribeTopics(onFrame, ["helper-" + sid], (status) => {
      // broker 重连中/恢复：仅更新状态文案；重连与重发订阅由 broker 自管
      if (status === "reconnecting") setMonitor((m: any) => m && (m.status === "done" ? m : { ...m, status: "reconnecting" }));
      else if (status === "up") {
        setMonitor((m: any) => m && (m.status === "reconnecting" ? { ...m, status: "thinking" } : m));
        if (_state.loading && _state.sessionId === sid) void fetchSnapshot(sid);   // 断线窗口可能丢帧 → 对齐
      }
    });
    monitorRef.current = { off: () => { try { sub.off(); } catch {} }, sid };
    // 订阅先行、快照对齐：ready 后拉一次——订阅生效前已结算/结果帧已错过，这次快照补齐（唯一空窗）
    sub.ready.then(() => { if (_state.loading && _state.sessionId === sid) void fetchSnapshot(sid); })
      .catch(() => goDegraded("总线连接失败"));
  }, [fetchSnapshot, applyResult]);

  // 后台执行：隐藏弹窗，AI 会话继续在服务端跑；提示用户在哪个 session、可从历史或该会话恢复
  const goBackground = useCallback(() => {
    if (!_state.sessionId || !_state.loading) return;
    const sid = _state.sessionId;
    if (monitorRef.current) { try { monitorRef.current.off(); } catch {} monitorRef.current = null; }   // 退订总线（会话不停）
    _state.open = false;
    notify();
    try {
      const n = new Notification("AI Helper 后台执行中", { body: "任务在 session " + String(sid).slice(0, 8) + " 后台运行。从 🕘 历史或该会话可恢复查看。" });
      void n;
    } catch {}
  }, []);

  // 接回后台任务：点列表里的会话 → 接回总线实时进度
  const restoreActive = useCallback((t: any) => {
    if (!t || !t.sessionId) return;
    const sid = String(t.sessionId);
    _state.sessionId = sid;
    _state.activeTab = "ai";
    _state.loading = true; _state.error = null; _state.lastResult = ""; _state.historyId = null;
    setRestoreNote("已接回后台任务 · 第" + (t.turn || 1) + "轮执行中");
    setMonitor({ status: "connecting", text: "", thinking: "", tools: [], startedAt: Date.now() });
    notify();
    openMonitor(sid);
  }, [openMonitor]);

  // 打开弹窗：若当前会话是 aiti-helper 发起的 → 恢复输入/帮助点/placeholder，并接回总线监听后台任务
  useEffect(() => {
    if (!isOpen) { restoredRef.current = false; setRestoreNote(null); return; }
    if (restoredRef.current) return;
    restoredRef.current = true;
    // 后台任务提示（未结算的 helper 会话）
    fetch(apiUrl("/api/extensions/aiti-helper/active"), { cache: "no-store" })
      .then((r) => r.json()).then((d) => { if (d && d.ok) setBgActive(d.active || []); }).catch(() => {});
    const cur = props.currentSession?.id || props.sessionId || null;
    if (!cur) return;
    // 外部 invoke（带 message，如弹窗 AI 按钮 / autoSend）→ 不恢复原会话输入，该 message 才是本次任务
    if (_state.opts?.message) return;
    let alive = true;
    fetch(apiUrl("/api/extensions/aiti-helper/origin/" + encodeURIComponent(cur)), { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (!alive || !d || !d.ok) return;
        const o = d.origin || {};
        if (o.message) setInput(String(o.message));
        if (o.helperId && helpers && helpers.length) setSelHelper(helpers.find((x) => x.id === o.helperId) || null);
        if (o.placeholder || o.contextLabel) {
          _state.opts = { ...(_state.opts || {}), placeholder: o.placeholder || _state.opts?.placeholder, contextLabel: o.contextLabel || _state.opts?.contextLabel };
        }
        _state.sessionId = cur;
        if (d.status === "running") {
          setRestoreNote("已接回后台任务 · 第" + (o.turn || 1) + "轮执行中");
          _state.loading = true; _state.error = null; _state.lastResult = ""; _state.historyId = null;
          setMonitor({ status: "connecting", text: "", thinking: "", tools: [], startedAt: Date.now() });
          notify();
          openMonitor(cur);
        } else if (d.result) {
          setRestoreNote("已恢复该会话上次结果（第" + (o.turn || 1) + "轮）");
          _state.lastResult = d.result.text || ""; _state.historyId = d.result.historyId || null; _state.loading = false;
          notify();
        } else if (d.failedError) {
          setRestoreNote("该会话本轮未产生结果");
          _state.error = d.failedError; _state.loading = false;
          notify();
        }
        notify();
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [isOpen, helpers, props.currentSession, props.sessionId, openMonitor]);

  // 关闭/卸载：退订总线（会话不停）；loading 状态由快照/result 帧/goBackground/restore 管
  useEffect(() => {
    if (isOpen) return;
    if (monitorRef.current) { try { monitorRef.current.off(); } catch {} monitorRef.current = null; }
  }, [isOpen]);

  const doInvoke = useCallback(async (isFollowup = false) => {
    prefetchPageId();   // 确保发起方 pageId 最新（重试拿桥 sessions 匹配当前页面）
    const text = (isFollowup ? followup : input).trim();
    if (!text || loading) return;
    // 追问：把当前这轮（原要求+结果）并入 turns 作为手工上下文（fallback 用）
    let prevTurns = turns;
    if (isFollowup && result) {
      prevTurns = [...turns, { message: input, result, system: selHelper?.system || opts.system }];
      setTurns(prevTurns);
      setInput(text);            // 主输入框改为追问内容（保持可见）
      setFollowup("");           // 清空追问框
    }
    _state.loading = true; _state.error = null; _state.lastResult = ""; _state.historyId = null; setRestoreNote(null); setDegraded(null); notify();
    setMonitor({ status: "connecting", text: "", thinking: "", tools: [], startedAt: Date.now() });
    try {
      // cwd 兜底：弹窗 🤖 按钮等入口的 opts 不带 cwd，页面无活跃会话时 activeCwd/currentSession 也为 null →
      // 服务端 400「需要 cwd」无法发消息。取 pi-web 默认工作目录（~/pi-cwd-YYYYMMDD，同侧栏「使用默认目录」语义）兜底，
      // 放在 client 做：apiUrl 自带 basePath，且覆盖全部入口（invoke/追问回落新建）。
      let invokeCwd = sessionCtx.cwd;
      if (!invokeCwd) {
        try {
          const dr = await fetch(apiUrl("/api/default-cwd"), { method: "POST" });
          const dd = await dr.json().catch(() => null);
          if (dd && dd.cwd) invokeCwd = String(dd.cwd);
        } catch { /* 兜底失败交给服务端原有报错 */ }
      }
      let data: any = null;
      // 追问优先：复用同一 agent 会话 steer 继续（AI 记得前几轮，上下文完整）——会话被回收则 404 回落
      if (isFollowup && _state.sessionId) {
        const fr = await fetch(apiUrl("/api/extensions/aiti-helper/followup"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: _state.sessionId, message: text, contextLabel: opts.contextLabel || null, cwd: invokeCwd || null }),
        });
        data = await fr.json().catch(() => null);
        if (!data || !data.ok) {
          if (data && data.code === "session_gone") _state.sessionId = null;  // 回收 → 下次新建
          data = null;  // 回落 invoke（带手工 prevTurns）
        }
      }
      if (!data) {
        const r = await fetch(apiUrl("/api/extensions/aiti-helper/invoke"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            system: selHelper?.system || opts.system,
            message: text,
            contextLabel: opts.contextLabel || null,
            helperId: selHelper?.id || opts.helperId || null,
            placeholder: opts.placeholder || null,
            prevTurns,   // 手工上下文（新建 session 时给 AI 前几轮要求与回复）
            sessionCtx: invokeCwd && !sessionCtx.cwd ? { ...sessionCtx, cwd: invokeCwd } : sessionCtx,
            cwd: invokeCwd || null,   // 服务端 sessionCtx.cwd || body.cwd 双兜底
            sourcePageId: _state.pageId || null,   // 发起方 pageId（如 xxx/ai），报告给 AI
            sourceIsAiWin: _state.isAiWin || false,
          }),
        });
        data = await r.json();
      }
      if (!data.ok) throw new Error(data.error + (data.debug ? " | " + JSON.stringify(data.debug) : ""));
      const sid = data.sessionId;
      _state.sessionId = sid;   // 记住 agent 会话（追问/后台/恢复用）
      openMonitor(sid);          // 订阅总线 helper-<sid>：进度 + result 帧（带全文，直接落地）
      notify();
    } catch (e: any) {
      _state.error = String(e.message || e);
      _state.loading = false;
      setMonitor(null);
      notify();
    }
  }, [input, followup, turns, result, loading, opts, sessionCtx, selHelper, openMonitor]);

  // 自动发送：外部 invoke 带 opts.autoSend 时，message 预填落位后自动 doInvoke 一次（同一 opts 只发一次）
  const autoSentRef = useRef<HelperInvokeOpts | null>(null);
  useEffect(() => {
    const o = _state.opts;
    if (!o || !o.autoSend) return;
    if (autoSentRef.current === o) return;   // 已自动发过
    if (!o.message) return;
    // 关键：必须等预填落位——input 已等于 opts.message 才发，否则弹窗若被复用（input 残留旧内容）会误发旧输入
    if (input !== String(o.message)) return;
    autoSentRef.current = o;
    void doInvoke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, _state.opts]);

  // 落地到 API / 回填弹窗表单（帮助点 action）——共享给当前结果与历史恢复
  const [landing, setLanding] = useState<{ status: string; msg: string } | null>(null);
  // 按 label/placeholder/name/id 在弹窗里找表单字段（打分匹配：label 优先，placeholder/name 兜底）
  const findField = useCallback((dialog: HTMLElement, label: string) => {
    const els = dialog.querySelectorAll("input, textarea, select, [contenteditable=\"true\"], [contenteditable=\"plaintext-only\"], [contenteditable=\"\"]");
    const key = String(label).toLowerCase().trim();
    if (!key) return null;
    let best: Element | null = null; let bestScore = 0;
    for (const el of els) {
      const lblEl = el.closest("label");
      const labelText = lblEl ? (lblEl.textContent || "").trim().toLowerCase() : "";
      const ph = (el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("aria-label") || "").toLowerCase();
      const elName = (el.getAttribute("name") || "").toLowerCase();
      const elId = (el.id || "").toLowerCase();
      let score = 0;
      if (labelText === key) score = 4;
      else if (labelText && labelText.includes(key)) score = 3;
      else if (key.includes(labelText) && labelText.length >= 2) score = 2;  // label 是 key 的子串
      if (ph === key) score = Math.max(score, 3);
      else if (ph && ph.includes(key)) score = Math.max(score, 1);
      if (elName === key) score = Math.max(score, 3);
      else if (elName && elName.includes(key)) score = Math.max(score, 1);
      if (elId === key) score = Math.max(score, 3);
      else if (elId && elId.includes(key)) score = Math.max(score, 1);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return bestScore >= 2 ? best : null;  // 只有强匹配（label/精确）才返回，防 placeholder 误伤
  }, []);
  // 写入可编辑元素：React 兼容"真实键入"（等价 CDP Input.insertText）——contenteditable 走 execCommand；input/textarea 原生原型 setter
  const setNativeValue = useCallback((el: any, value: unknown) => {
    const text = String(value == null ? "" : value);
    if (el.isContentEditable || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT" && el.hasAttribute && el.hasAttribute("contenteditable"))) {
      try { el.focus(); } catch {}
      try {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {}
      let done = false;
      try { done = document.execCommand("insertText", false, text); } catch {}
      if (!done) {
        try { el.textContent = text; } catch {}
        try { el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })); }
        catch { try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch {} }
      }
      el.style.outline = "2px solid var(--accent,#2563eb)";
      el.style.outlineOffset = "1px";
      setTimeout(() => { el.style.outline = ""; }, 1800);
      return;
    }
    const proto = (el.tagName === "TEXTAREA")
      ? window.HTMLTextAreaElement.prototype
      : (el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype);
    try {
      const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
      setter.call(el, text);
    } catch { el.value = text; }
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    el.style.outline = "2px solid var(--accent,#2563eb)";
    el.style.outlineOffset = "1px";
    setTimeout(() => { el.style.outline = ""; }, 1800);
  }, []);
  // 回填弹窗表单：AI JSON { field: value } → 按 label 匹配填充
  // action.fields 结构：数组（字符串=直接当 label 匹配）或 [{ key, label }]（AI key → 表单 label）
  const doFill = useCallback((parsed: Record<string, unknown>, action: any) => {
    const dialog = _state.dialogEl;
    if (!dialog || !document.body.contains(dialog)) { setLanding({ status: "err", msg: "原弹窗已关闭，无法回填（请从弹窗 AI 按钮唤起）" }); return 0; }
    const fields = action.fields || null;
    const mapping = action.mapping || null;   // 兼容：{ aiKey: label }
    let filled = 0;
    for (const [aiKey, val] of Object.entries(parsed)) {
      if (val === undefined || val === null) continue;
      // 决定目标 label：fields[{key,label}] → 用其 label；fields[字符串] → 直接当 label；mapping → label；否则用 AI key
      let targetLabel: string | null = null;
      if (Array.isArray(fields) && typeof fields[0] === "object") {
        const f = fields.find((x: any) => x.key === aiKey || (x.label && String(x.label).toLowerCase() === aiKey.toLowerCase()));
        if (f) targetLabel = f.label || aiKey;
      } else if (Array.isArray(fields)) {
        if (!fields.some((x: any) => String(x).toLowerCase() === aiKey.toLowerCase())) continue;  // 不在声明内则跳过
        targetLabel = aiKey;
      } else if (mapping) {
        targetLabel = mapping[aiKey] || aiKey;
      } else { targetLabel = aiKey; }
      const el = findField(dialog, targetLabel || aiKey);
      if (el) { setNativeValue(el, val); filled++; }
    }
    return filled;
  }, [findField, setNativeValue]);
  const doLand = useCallback(async (resultText: string, helper: any, historyId: string | null) => {
    if (!resultText || !helper?.action) { setLanding({ status: "err", msg: "该条无落地动作（自由发挥结果）" }); return; }
    const action = helper.action;
    let parsed: any = null;
    try {
      let t = resultText.trim();
      t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      parsed = JSON.parse(t);
    } catch (e: any) {
      setLanding({ status: "err", msg: "结果不是有效 JSON：" + (e.message || e) });
      return;
    }
    // action: fill → 回填弹窗表单（AI 输出两种：①工具链已填，filled 对象确认；②未填，{字段:值} 让前端兜底）
    if (action.type === "fill") {
      const source = (parsed && typeof parsed === "object" && parsed.filled && typeof parsed.filled === "object")
        ? parsed.filled
        : parsed;
      const filled = doFill(source, action);
      const detail = filled > 0
        ? "已回填 " + filled + " 个表单字段" + (parsed.note ? "（" + parsed.note + "）" : "")
        : (parsed.note ? parsed.note : "没有可回填的字段（AI 输出需为 {字段:值} JSON）");
      setLanding({ status: filled > 0 ? "ok" : "info", msg: detail });
      if (historyId) {
        try { await fetch(apiUrl("/api/extensions/aiti-helper/history/" + historyId + "/land"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ detail }) }); } catch {}
      }
      return;
    }
    // action: api → POST 落地（现状）
    try {
      const body: Record<string, unknown> = {};
      if (action.mapping) {
        for (const [aiKey, apiKey] of Object.entries(action.mapping)) {
          if (parsed[aiKey] !== undefined) body[apiKey as string] = parsed[aiKey];
        }
      } else { Object.assign(body, parsed); }
      // path 支持 {field} 占位符（如 /commands/{id}）：用 body 里的值替换，并从 body 移除
      let path = action.path.startsWith("/api/") ? action.path : "/api/" + action.path;
      const placeholders = path.match(/\{[a-zA-Z0-9_]+\}/g) || [];
      for (const ph of placeholders) {
        const key = ph.slice(1, -1);
        if (body[key] !== undefined) { path = path.replace(ph, encodeURIComponent(String(body[key]))); delete body[key]; }
      }
      const url = apiUrl(path);
      const r = await fetch(url, {
        method: action.method || "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || (d && d.ok === false)) {
        setLanding({ status: "err", msg: "入库失败：" + ((d && d.error) || r.status) });
      } else {
        const detail = "已入库" + (d && d.command ? "：「" + (d.command.name || d.command.cmd) + "」" : "");
        setLanding({ status: "ok", msg: detail });
        if (historyId) {
          try { await fetch(apiUrl("/api/extensions/aiti-helper/history/" + historyId + "/land"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ detail }) }); } catch {}
        }
      }
    } catch (e: any) {
      setLanding({ status: "err", msg: "入库异常：" + (e.message || e) });
    }
  }, [doFill]);

  const adoptChat = useCallback((text: string) => {
    if (!text) return;
    try { mcCtx?.sendChatMessage(text, "steer"); } catch {}
    closePanel();
  }, []);

  const copyResult = useCallback((text: string) => {
    if (!text) return;
    try { navigator.clipboard.writeText(text); } catch {}
  }, []);

  const retry = useCallback(() => {
    if (monitorRef.current) { try { monitorRef.current.off(); } catch {} monitorRef.current = null; }
    setMonitor(null); setRestoreNote(null);
    _state.lastResult = ""; _state.error = null; _state.loading = false; _state.historyId = null; notify();
    setTurns([]); setFollowup("");
    if (taRef.current) taRef.current.focus();
  }, []);

  // 查看某帮助点（skill）的说明：调 /skill/<id> 读 SKILL.md 正文 → 展示说明面板
  const viewSkill = useCallback(async (helper: any) => {
    if (!helper || !helper.id) return;
    setSkillLoading(true);
    setViewingSkill({ id: helper.id, title: helper.title || helper.id, body: "", summary: helper.summary || "" });
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-helper/skill/" + encodeURIComponent(helper.id)), { cache: "no-store" });
      const d = await r.json();
      if (d.ok) setViewingSkill({ id: helper.id, title: d.helper?.title || helper.title || helper.id, body: d.body || "", summary: d.helper?.summary || helper.summary || "", meta: d.meta || {}, tools: d.tools || null });
      else setViewingSkill((v: any) => v && { ...v, body: "", err: d.error || "读取失败" });
    } catch { setViewingSkill((v: any) => v && { ...v, body: "", err: "读取失败" }); }
    setSkillLoading(false);
  }, []);
  const closeSkillView = useCallback(() => setViewingSkill(null), []);

  // 保存用户自定义 skill：POST /user-skills → 写 data 目录 → 刷新帮助点列表
  const saveUserSkill = useCallback(async () => {
    const name = (skillForm.name || "").trim();
    if (!name) { setSkillMsg({ status: "err", msg: "请填写 skill 名" }); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) { setSkillMsg({ status: "err", msg: "skill 名只能用字母/数字/下划线/连字符" }); return; }
    setSavingSkill(true); setSkillMsg(null);
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-helper/user-skills"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, owner: (skillForm.owner || "").trim() || undefined, title: (skillForm.title || name).trim(), summary: (skillForm.summary || "").trim() || undefined, body: skillForm.body || "" }),
      });
      const d = await r.json();
      if (!d.ok) { setSkillMsg({ status: "err", msg: d.error || "保存失败" }); return; }
      setSkillMsg({ status: "ok", msg: "已保存到 data 目录（归属 " + (d.skill?.owner || "aiti-helper") + "）" });
      // 刷新帮助点列表（新 skill 立即出现）
      const hr = await fetch(apiUrl("/api/extensions/aiti-helper/helpers"), { cache: "no-store" });
      const hd = await hr.json();
      if (hd.ok) setHelpers(hd.helpers || []);
      setSkillForm({ name: "", owner: "", title: "", summary: "", body: "" });
    } catch (e: any) { setSkillMsg({ status: "err", msg: "保存失败: " + (e.message || e) }); }
    setSavingSkill(false);
  }, [skillForm]);
  // 关闭新增表单
  const closeSkillForm = useCallback(() => { setShowSkillForm(false); setSkillMsg(null); }, []);

  // 历史恢复：把历史记录载入当前结果视图（含用户输入回填到输入框）
  const restoreHistory = useCallback((h: any) => {
    _state.lastResult = h.result;
    _state.historyId = h.id;
    _state.error = null;
    _state.activeTab = "ai";
    _state.opts = { contextLabel: h.contextLabel || (h.helperId ? h.helperId : null) };
    if (h.message) setInput(h.message);   // 回填用户原始输入（可再编辑/重新生成）
    setTurns([]);                          // 重置对话链（从该条开始继续追问）
    setFollowup("");
    _state.sessionId = h.agentSessionId || null;   // 恢复 agent 会话：追问优先继续同一会话
    if (h.helperId && helpers) setSelHelper(helpers.find((x) => x.id === h.helperId) || null);
    setLanding(null);
    notify();
  }, [helpers]);

  // 拖拽移动
  const onDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, textarea, input, pre, select")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      _state.pos = { x: dragRef.current.origX + dx, y: dragRef.current.origY + dy };
      notify();
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // 失焦半透明：点击 dialog 外部 → dim；内部 → 恢复
  const onOverlayClick = useCallback((e: React.MouseEvent) => {
    const panel = panelRef.current;
    if (panel && panel.contains(e.target as Node)) { _state.dim = false; notify(); }
    else { _state.dim = true; notify(); }
  }, []);

  if (!isOpen) return null;

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };

  // 弹窗定位：pos.x 有值用 pos，否则默认右上角（距顶 72，距右 16）
  const panelLeft = pos.x != null ? pos.x : null;
  const panelTop = pos.y != null ? pos.y : null;

  // ---- skills 分组与搜索（工具条按钮 + 内联 chips 共用）----
  const skillGroups = buildGroups(helpers || [], (opts.extId as string) || "", (opts.extName as string) || "");
  const skillSearchLc = skillSearch.trim().toLowerCase();
  const matchSearch = (hp: any) => !skillSearchLc || (hp.title || "").toLowerCase().includes(skillSearchLc) || (hp.summary || "").toLowerCase().includes(skillSearchLc) || (hp.id || "").toLowerCase().includes(skillSearchLc);
  // 默认全部收起（只显示分组标题=扩展云，点击展开 skills 云）；搜索时强制展开
  const groupIsCollapsed = (g: { key: string }) => (g.key in collapsedGroups) ? !!collapsedGroups[g.key] : true;
  const allExpandedNow = skillGroups.length > 0 && skillGroups.every((g) => !groupIsCollapsed(g));
  const skillToolbar = activeTab === "ai" && !viewingSkill && !showSkillForm && skillGroups.length > 0;

  // 分组头（扩展 pill）：前面显示扩展 logo——icon 声明自 manifest，两种形态：
  //   文件路径（icon.svg）→ <img> 加载扩展资产（失败回退 chevron）；emoji（如 "🚀"）→ 直接渲染。
  // 通用组用 ✨；展开态 accent 高亮。collapsed 时作为 tag 云里的一个 pill。
  const groupHeader = (g: { key: string; label: string; kind: string; extId: string; items: any[] }, collapsed: boolean) => {
    const expanded = !collapsed;
    const rawIcon = extMeta[g.extId]?.icon || (g.extId ? "icon.svg" : null);
    const isFileIcon = !!rawIcon && /\.[a-zA-Z0-9]+$/.test(rawIcon);
    const iconSrc = rawIcon && isFileIcon && g.extId ? apiUrl("/api/extensions/" + g.extId + "/assets/" + rawIcon) : null;
    const showLogo = !!iconSrc && !iconFail[g.extId];
    const emojiIcon = rawIcon && !isFileIcon ? rawIcon : null;
    return (
      <button key={"hdr-" + g.key}
        onClick={() => { setCollapsedGroups((m) => ({ ...m, [g.key]: !collapsed })); notify(); }}
        title={(expanded ? "收起 " : "展开 ") + g.label + " 的 skills"}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", userSelect: "none",
          padding: "3px 8px", borderRadius: 8, fontSize: 11, fontWeight: 700, flexShrink: 0, maxWidth: "100%",
          border: "1px solid " + (g.kind === "ext" || expanded ? "var(--accent,#2563eb)" : "rgba(128,128,128,.38)"),
          background: g.kind === "ext" || expanded ? "rgba(37,99,235,.14)" : "rgba(128,128,128,.18)",
          color: g.kind === "ext" || expanded ? "var(--accent,#2563eb)" : "inherit" }}>
      {showLogo
        ? <img src={iconSrc!} alt="" width={12} height={12}
            onError={() => setIconFail((m) => (m[g.extId] ? m : { ...m, [g.extId]: true }))}
            style={{ width: 12, height: 12, objectFit: "contain", flexShrink: 0, pointerEvents: "none" }} />
        : emojiIcon
          ? <span style={{ fontSize: 11, lineHeight: 1, flexShrink: 0 }}>{emojiIcon}</span>
          : (g.kind === "general"
              ? <span style={{ display: "inline-flex", flexShrink: 0 }}><SparkIcon size={11} /></span>
              : <span style={{ display: "inline-flex", width: 9, flexShrink: 0, transition: "transform .15s", transform: expanded ? "rotate(90deg)" : "none" }}><Ic size={9} paths={ICONS.chevron} /></span>)}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.label}</span>
      <span style={{ fontSize: 10, fontWeight: 600, flexShrink: 0, lineHeight: 1, padding: "2px 5px", borderRadius: 7,
        background: g.kind === "ext" || expanded ? "rgba(37,99,235,.18)" : "rgba(128,128,128,.22)" }}>{g.items.length}</span>
      {/* 工具徽标：该扩展 agent 工具——待启用数（pending>0）琥珀色醒目，全启用显示总数（灰）。无工具不显示 */}
      {(() => {
        const ot = g.items.find((x) => x.ownerTools && x.ownerTools.total > 0)?.ownerTools;
        if (!ot || ot.total <= 0) return null;
        const pend = ot.pending > 0;
        return (
          <span title={`共 ${ot.total} 个 AI 工具，当前待启用 ${ot.pending} 个（默认关；经 🤖 执行该扩展的 skill 时自动带上）`}
            style={{ fontSize: 10, fontWeight: 600, flexShrink: 0, lineHeight: 1, padding: "2px 5px", borderRadius: 7,
              background: pend ? "rgba(250,204,21,.18)" : "rgba(128,128,128,.22)",
              color: pend ? "var(--warn,#b45309)" : "inherit",
              border: pend ? "1px solid rgba(250,204,21,.5)" : "1px solid transparent" }}>
            ({pend ? ot.pending : ot.total})
          </span>
        );
      })()}
      </button>
    );
  };
  const chip = (hp: any, kind: string) => (
    <button key={hp.id}
      onClick={() => {
        setSelHelper(selHelper && selHelper.id === hp.id ? null : hp);
        if (hp.placeholder) { if (_state.opts) _state.opts.placeholder = hp.placeholder; notify(); }
      }}
      title={hp.summary || ""}
      style={{
        // skill chip：与扩展分组头（方角+填充+加粗）反向区分——全圆角、透明底、常规字重、淡描边
        padding: "3px 10px", borderRadius: 999, cursor: "pointer", fontSize: 11, fontWeight: 400,
        border: "1px solid " + (hp.user ? "rgba(250,204,21,.6)" : (selHelper && selHelper.id === hp.id ? "var(--accent,#2563eb)" : "rgba(128,128,128,.32)")),
        background: hp.user ? "rgba(250,204,21,.08)" : (selHelper && selHelper.id === hp.id ? "rgba(37,99,235,.12)" : "transparent"),
        color: "inherit",
      }}>
      {(selHelper && selHelper.id === hp.id ? "✓ " : "") + (hp.user ? "✦ " : "") + hp.title}
    </button>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2147483647, pointerEvents: "none" }} onClick={onOverlayClick}>
      {/* dialog 面板（独立置顶，无遮罩） */}
      <div ref={panelRef}
        onMouseDown={onDragStart}
        style={{
          position: "fixed", zIndex: 2147483647,
          left: panelLeft != null ? panelLeft + "px" : "auto",
          top: panelTop != null ? panelTop + "px" : "72px",
          right: panelLeft != null ? "auto" : "16px",
          width: compact ? "min(420px, 90vw)" : "min(580px, 90vw)", maxHeight: compact ? "70vh" : "78vh", display: "flex", flexDirection: "column",
          background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)",
          border: "1px solid var(--border,#e0e0e0)", borderRadius: 14,
          boxShadow: "0 16px 64px rgba(0,0,0,.25)",
          opacity: dim ? 0.45 : 1, transition: "opacity .2s",
          pointerEvents: "auto", overflow: "hidden",
        }}>
        {/* 标题栏（可拖拽） */}
        <div key="header" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "move",
          padding: "10px 14px", borderBottom: "1px solid var(--border,#e0e0e0)", flexShrink: 0, userSelect: "none" }}>
          <span style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5 }}>
            <SparkIcon size={15} />{" "}AI Helper
          </span>
          {/* tab 切换 */}
          <div key="tabs" style={{ display: "flex", gap: 2, marginLeft: 12 }}>
            <button key="ai" onClick={() => { _state.activeTab = "ai"; notify(); }} title="AI 助手" style={tabStyle(activeTab === "ai")}>
              助手
            </button>
            <button key="hist" onClick={() => { _state.activeTab = "history"; notify(); }} title="执行历史" style={tabStyle(activeTab === "history")}>
              历史
            </button>
          </div>
          {opts.contextLabel
            ? <span key="ctx" style={{ fontSize: 10, opacity: 0.55, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opts.contextLabel}</span>
            : <span key="ctx-empty" style={{ flex: 1 }} />}
          {/* 工具条：展开/收起全部 + 新增 Skill（只在 AI tab 且非子面板时显示） */}
          {skillToolbar ? (
            <button key="sk-expand"
              onClick={() => { setCollapsedGroups(Object.fromEntries(skillGroups.map((g) => [g.key, allExpandedNow]))); notify(); }}
              title={allExpandedNow ? "收起全部" : "展开全部"}
              style={closeBtnStyle()}>
              <Ic size={14} paths={ICONS.expand} />
            </button>
          ) : null}
          {skillToolbar ? (
            <button key="sk-new"
              onClick={() => { setShowSkillForm(true); setSelHelper(null); }}
              title="新增 Skill（存 data 目录）"
              style={closeBtnStyle()}>
              <Ic size={14} paths={ICONS.plus} />
            </button>
          ) : null}
          <button key="close" onClick={closePanel} title="关闭（历史已保存，可随时从 🕘 历史找回）" style={closeBtnStyle()}>
            <Ic size={12} paths={ICONS.x} />
          </button>
        </div>
        {/* 内容区 */}
        <div key="body" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, overflow: "auto", flex: 1 }}>
          {/* ===== AI tab ===== */}
          {activeTab === "ai" ? (viewingSkill ? (
            /* 技能说明面板（查看某帮助点做什么） */
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1, display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.help} />{viewingSkill.title}</span>
                <button onClick={closeSkillView} style={btnStyle()}>← 返回</button>
              </div>
              {viewingSkill.summary ? <div style={{ fontSize: 12, opacity: 0.75, background: "var(--bg-subtle,#f5f5f5)", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)" }}>{viewingSkill.summary}</div> : null}
              {/* 归属扩展的 AI 工具清单（“看看它能做什么”也带上 tools 信息） */}
              {viewingSkill.tools && viewingSkill.tools.total > 0 ? (() => {
                const pend = viewingSkill.tools.pending > 0;
                return (
                  <div style={{ fontSize: 12, background: pend ? "rgba(250,204,21,.08)" : "var(--bg-subtle,#f5f5f5)",
                    border: "1px solid " + (pend ? "rgba(250,204,21,.4)" : "var(--border,#e0e0e0)"), borderRadius: 8, padding: "8px 10px",
                    display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ opacity: 0.9, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Ic size={12} paths={ICONS.wrench} />
                      <span style={{ fontWeight: 600 }}>AI 工具</span>
                      <span style={{ opacity: 0.7 }}>共 {viewingSkill.tools.total} 个{pend ? ` · 当前待启用 ${viewingSkill.tools.pending} 个` : " · 已全部启用"}</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {(viewingSkill.tools.names || []).map((n: string) => (
                        <code key={n} style={{ fontSize: 11, background: "rgba(128,128,128,.14)", padding: "1px 6px", borderRadius: 5,
                          fontFamily: "ui-monospace, SFMono-Regular, monospace", color: "inherit" }}>{n}</code>
                      ))}
                    </div>
                    {pend ? <div style={{ fontSize: 11, opacity: 0.7 }}>默认关：点「执行」经本 skill 建的任务会话会自动带上这些工具（会话级，用完即还原，不全局开启）。</div> : null}
                  </div>
                );
              })() : null}
              {skillLoading ? <div style={{ fontSize: 12, opacity: 0.6 }}>加载说明…</div> : null}
              {viewingSkill.err ? <div style={{ color: "var(--danger, #ef4444)", fontSize: 12 }}>⚠️ {viewingSkill.err}</div> : null}
              {viewingSkill.body ? <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "12px 14px", background: "var(--bg-subtle,#f5f5f5)", color: "inherit", borderRadius: 8, fontSize: 12, lineHeight: 1.6, border: "1px solid var(--border,#e0e0e0)", maxHeight: 320, overflow: "auto", margin: 0 }}>{viewingSkill.body}</pre> : null}
            </div>
          ) : showSkillForm ? (
            /* 新增 skill 表单（用户自己给扩展加 skill，存 data 目录） */
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1, display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.plus} />新增 Skill</span>
                <button onClick={closeSkillForm} style={btnStyle()}>← 返回</button>
              </div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>自定义 skill 存到 data 目录（不覆盖任何扩展的部署产物）；归属扩展不打标签则默认归 ai-helper。</div>
              <label style={{ fontSize: 12, opacity: 0.8 }}>名称（必填，字母/数字/_/-）</label>
              <input value={skillForm.name} onInput={(e: any) => setSkillForm((f) => ({ ...f, name: e.target.value }))} placeholder="如 session-archive-30d" style={inputStyle()} />
              <label style={{ fontSize: 12, opacity: 0.8 }}>归属扩展（不指定归 ai-helper）</label>
              <select value={skillForm.owner} onInput={(e: any) => setSkillForm((f) => ({ ...f, owner: e.target.value }))} style={{ ...inputStyle(), padding: "7px 10px" }}>
                <option key="__none__" value="">（不指定 · 归 ai-helper）</option>
                {(helpers || []).filter((x) => x.owner && x.owner !== "aiti-helper").map((x) => x.owner).filter((v, i, a) => a.indexOf(v) === i).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <label style={{ fontSize: 12, opacity: 0.8 }}>显示标题（可空，默认用名称）</label>
              <input value={skillForm.title} onInput={(e: any) => setSkillForm((f) => ({ ...f, title: e.target.value }))} placeholder="如 AI 帮我归档 30 天会话" style={inputStyle()} />
              <label style={{ fontSize: 12, opacity: 0.8 }}>一句话说明（可空）</label>
              <input value={skillForm.summary} onInput={(e: any) => setSkillForm((f) => ({ ...f, summary: e.target.value }))} placeholder="这个 skill 能做什么" style={inputStyle()} />
              <label style={{ fontSize: 12, opacity: 0.8 }}>正文手册（可空；可让 AI 帮你写）</label>
              <textarea value={skillForm.body} onInput={(e: any) => setSkillForm((f) => ({ ...f, body: e.target.value }))} placeholder="SKILL.md 正文（任务说明、API、输出格式…）。留空则先建骨架，再用「AI 帮我新增/修改 skill」补全。" style={{ ...inputStyle(), minHeight: 90, resize: "vertical", lineHeight: 1.5 }} />
              {skillMsg ? <div style={{ fontSize: 12, padding: "7px 10px", borderRadius: 6, background: skillMsg.status === "ok" ? "color-mix(in srgb, var(--ok, #10b981) 12%, transparent)" : "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)", color: skillMsg.status === "ok" ? "#16a34a" : "#dc2626" }}>{skillMsg.msg}</div> : null}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button onClick={() => saveUserSkill()} disabled={savingSkill} style={btnStyle("primary")}>{savingSkill ? "保存中…" : "保存"}</button>
                <button onClick={() => { setShowSkillForm(false); setSelHelper(helpers && helpers.find((x) => x.id === "skill-manage") || null); }} style={{ ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <Ic size={13} paths={ICONS.bot} />让 AI 写
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {/* 恢复提示 + 后台任务提示 */}
              {restoreNote ? <div style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, background: "rgba(37,99,235,.10)", border: "1px solid rgba(37,99,235,.3)", color: "inherit" }}>↩ {restoreNote}</div> : null}
              {bgActive && bgActive.length ? (
                <div style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, background: "color-mix(in srgb, var(--warn, #f59e0b) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warn, #f59e0b) 35%, transparent)", color: "inherit", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span>{bgActive.length} 个后台任务执行中</span>
                  {bgActive.slice(0, 3).map((t: any) => (
                    <button key={t.sessionId} onClick={() => restoreActive(t)} title="接回此会话的实时进度"
                      style={{ textAlign: "left", background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 11, padding: 0, opacity: 0.8 }}>
                      · {String(t.sessionId).slice(0, 8)}「{(t.message || "").slice(0, 30)}」
                    </button>
                  ))}
                </div>
              ) : null}
              {/* 帮助点选择（分组：本扩展 / 通用 / 其他扩展） */}
              {!skillGroups.length && helpers === null ? <div style={{ fontSize: 12, opacity: 0.6 }}>加载帮助点…</div> : null}
              {!skillGroups.length && helpers !== null ? <div style={{ fontSize: 12, opacity: 0.6 }}>暂无 skills（可新增自定义）</div> : null}
              {skillGroups.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {/* 搜索框 */}
                  <input value={skillSearch}
                    onInput={(e: any) => setSkillSearch(e.target.value)}
                    placeholder="搜索 skills…（标题 / 说明 / id）"
                    style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)",
                      background: "var(--bg-subtle,#f5f5f5)", color: "inherit", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
                  {/* 分组 tag 云：收起的扩展 pill 在同一容器里流式换行（不各占一行）；
                      展开的组 flexBasis:100% 独占整行，header + chips 内联排列 */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    {skillGroups.map((g) => {
                      const items = skillSearchLc ? g.items.filter(matchSearch) : g.items;
                      if (skillSearchLc && !items.length) return null;   // 搜索时无匹配组隐藏
                      const collapsed = groupIsCollapsed(g) && !skillSearchLc;   // 搜索时强制展开
                      return (
                        <div key={g.key} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
                          flexBasis: collapsed ? "auto" : "100%", minWidth: 0, maxWidth: "100%" }}>
                          {groupHeader(g, collapsed)}
                          {collapsed ? null : items.map((hp) => chip(hp, g.kind))}
                        </div>
                      );
                    })}
                    {skillSearchLc && !skillGroups.some((g) => g.items.some(matchSearch))
                      ? <div style={{ fontSize: 12, opacity: 0.55, padding: "4px 2px" }}>无匹配 skill</div> : null}
                  </div>
                </div>
              ) : null}
              {/* 已选帮助点 + 查看说明按钮（输入框上方，较大易点） */}
              {selHelper ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 }}><SparkIcon size={12} />{" 已选：" + selHelper.title}</span>
                  <button onClick={() => viewSkill(selHelper)} title="查看这个帮助点（skill）能做什么"
                    style={{ padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 12, flexShrink: 0,
                      border: "1px dashed var(--border,#e0e0e0)", background: "rgba(128,128,128,.07)", color: "inherit", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Ic size={13} paths={ICONS.help} />看看它能做什么
                  </button>
                </div>
              ) : null}
              {/* 输入框（增高；回车提交，Shift+Enter 换行；双击或 Tab 把 placeholder 复制进输入框） */}
              <textarea ref={taRef} value={input}
                onInput={(e: any) => setInput(e.target.value)}
                placeholder={opts.placeholder || "描述你想让 AI 做什么…"}
                disabled={loading}
                style={{ width: "100%", minHeight: 110, maxHeight: 220, resize: "vertical",
                  padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)",
                  background: "var(--bg-subtle,#f5f5f5)", color: "inherit", fontSize: 13, lineHeight: 1.5,
                  boxSizing: "border-box", outline: "none", opacity: loading ? 0.6 : 1 }}
                onDoubleClick={() => { const ph = opts.placeholder || "描述你想让 AI 做什么…"; if (ph && !input) setInput(ph); }}
                onKeyDown={(e: any) => {
                  const ph = opts.placeholder || "描述你想让 AI 做什么…";
                  if (e.key === "Tab") { e.preventDefault(); if (ph && !input) setInput(ph); return; }
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doInvoke(); }
                }} />
              {/* 执行 + 后台按钮 */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                {/* 后台执行：loading 中可用——隐藏弹窗，会话在服务端继续跑 */}
                {loading ? (
                  <button onClick={goBackground} title="隐藏弹窗，AI 继续在后台执行（可从历史或该会话恢复）"
                    style={{ ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <Ic size={13} paths={ICONS.moon} />后台执行
                  </button>
                ) : <span />}
                <button onClick={() => doInvoke()} disabled={loading || !input.trim()}
                  style={{ padding: "6px 15px", borderRadius: 8, cursor: "pointer",
                    border: "1px solid var(--accent,#2563eb)", background: loading ? "rgba(37,99,235,.08)" : "rgba(37,99,235,.12)",
                    color: "inherit", fontSize: 13, fontWeight: 500, opacity: (loading || !input.trim()) ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 5 }}>
                  {loading ? "执行中…" : (<><SparkIcon size={13} />执行</>)}
                </button>
              </div>
              {/* 流式监听 monitor（loading 中显示 AI 实时进度） */}
              {loading && monitor ? (() => {
                const sl: Record<string, string> = { connecting: "正在连接 AI 会话…", thinking: "AI 思考中…", tool: "调用工具…", done: "完成", reconnecting: "重新连接…", degraded: "无实时推送（任务仍在执行）" };
                return (
                  <div style={{ border: "1px solid var(--border,#e0e0e0)", borderRadius: 8, background: "var(--bg-subtle,#f5f5f5)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: monitor.status === "done" ? "#16a34a" : "var(--accent,#2563eb)", flexShrink: 0, opacity: monitor.status === "done" ? 1 : 0.85 }} />
                      <span style={{ flex: 1 }}>{sl[monitor.status] || "执行中…"}</span>
                      {_state.sessionId ? <span style={{ fontSize: 10, opacity: 0.5 }}>session {String(_state.sessionId).slice(0, 8)}</span> : null}
                    </div>
                    {monitor.tools && monitor.tools.length ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {monitor.tools.map((t: any, i: number) => (
                          <div key={i} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                            <span style={{ color: t.status === "done" ? "#16a34a" : "var(--accent,#2563eb)", flexShrink: 0 }}>{t.status === "done" ? "✓" : "▹"}</span>
                            <span style={{ opacity: 0.85, flexShrink: 0 }}>{t.name}</span>
                            {t.partial ? <span style={{ opacity: 0.5, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{String(t.partial).replace(/\s+/g, " ").slice(0, 80)}</span> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {monitor.text ? (
                      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, fontSize: 12, lineHeight: 1.5, maxHeight: 160, overflow: "auto", color: "inherit" }}>{monitor.text}</pre>
                    ) : (monitor.thinking ? <div style={{ fontSize: 11, opacity: 0.55, fontStyle: "italic", maxHeight: 60, overflow: "auto" }}>💭 {String(monitor.thinking).slice(-200)}</div> : null)}
                  </div>
                );
              })() : null}
              {/* 总线不可用降级（拍板：不做轮询；任务在后台跑，结果可从会话里看） */}
              {degraded ? (
                <div style={{ fontSize: 12, padding: "7px 10px", borderRadius: 6, background: "rgba(234,179,8,.12)", border: "1px solid rgba(234,179,8,.35)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>⚠ {degraded}：无实时推送。任务仍在后台执行，结果就绪后可直接打开会话查看。</span>
                  {_state.sessionId ? (
                    <button onClick={() => window.open(apiUrl("/") + "?session=" + encodeURIComponent(String(_state.sessionId)), "_blank", "noopener")}
                      style={{ ...btnStyle(), flexShrink: 0 }}>打开会话</button>
                  ) : null}
                </div>
              ) : null}
              {/* 错误 */}
              {err ? <div style={{ color: "var(--danger, #ef4444)", fontSize: 12, padding: "7px 10px", background: "color-mix(in srgb, var(--danger, #ef4444) 10%, transparent)", borderRadius: 6 }}>❌ {err}</div> : null}
              {/* 结果预览 */}
              {result ? (
                <div>
                  <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 5, display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={12} paths={ICONS.copy} /> 结果预览（审核后落地；关闭后可在历史找回）</div>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "10px 12px",
                    background: "var(--bg-subtle,#f5f5f5)", color: "inherit", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
                    border: "1px solid var(--border,#e0e0e0)", maxHeight: 220, overflow: "auto", margin: 0 }}>{result}</pre>
                  {/* 操作行 */}
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    {selHelper?.action ? <button onClick={() => doLand(result, selHelper, _state.historyId)} style={btnStyle("primary")}>{selHelper.action.type === "fill" ? "回填弹窗" : "入库"}</button> : null}
                    <button onClick={() => adoptChat(result)} style={{ ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.msg} />填入聊天框</button>
                    <button onClick={() => copyResult(result)} style={{ ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.copy} />复制</button>
                    <button onClick={retry} style={{ ...btnStyle(), display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.refresh} />重来</button>
                  </div>
                  {/* 追问（结果不满意 → 追加要求继续迭代；带上下文） */}
                  <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <input value={followup}
                      onInput={(e: any) => setFollowup(e.target.value)}
                      onKeyDown={(e: any) => { if (e.key === "Enter") { e.preventDefault(); doInvoke(true); } }}
                      placeholder="不满意？输入追加要求继续，如「改成中文输出」「加个确认」「再详细点」…"
                      disabled={loading}
                      style={{ flex: 1, minWidth: 0, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border,#e0e0e0)",
                        background: "var(--bg-subtle,#f5f5f5)", color: "inherit", fontSize: 12, outline: "none" }} />
                    <button onClick={() => doInvoke(true)} disabled={loading || !followup.trim()}
                      style={{ padding: "6px 12px", borderRadius: 8, cursor: "pointer", flexShrink: 0,
                        border: "1px solid var(--accent,#2563eb)", background: loading ? "rgba(37,99,235,.08)" : "rgba(37,99,235,.12)",
                        color: "inherit", fontSize: 12, opacity: (loading || !followup.trim()) ? 0.5 : 1 }}>↪ 追问</button>
                  </div>
                  {/* 对话轮次指示 */}
                  {(_state.sessionId || turns.length) ? (
                    <div style={{ marginTop: 5, fontSize: 10, opacity: 0.55 }}>💬 已{_state.sessionId ? "在同一 AI 会话延续（上下文完整）" : "迭代 " + (turns.length + 1) + " 轮·追问带手工上下文"}</div>
                  ) : null}
                  {/* 落地状态 */}
                  {landing ? (
                    <div style={{ marginTop: 8, fontSize: 12, padding: "7px 10px", borderRadius: 6, background: landing.status === "ok" ? "color-mix(in srgb, var(--ok, #10b981) 12%, transparent)" : "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)", color: landing.status === "ok" ? "#16a34a" : "#dc2626" }}>{landing.msg}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )) : null}
          {/* ===== 历史 tab ===== */}
          {activeTab === "history" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11, opacity: 0.6, display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={12} paths={ICONS.clock} />{" 历史记录（server 持久化，关闭不丢）" + (historyList && historyList.length ? " · " + historyList.length + " 条" : "")}</div>
              {!historyList ? <div style={{ fontSize: 12, opacity: 0.5, padding: 12 }}>加载中…</div> :
               !historyList.length ? <div style={{ fontSize: 12, opacity: 0.5, padding: 12 }}>暂无历史记录。用 ✨ AI 生成一次就有了。</div> :
               historyList.map((rec) => (
                 <div key={rec.id} onClick={() => restoreHistory(rec)} title="点击恢复此结果"
                   style={{ border: "1px solid var(--border,#e0e0e0)", borderRadius: 8, padding: "8px 10px", cursor: "pointer", background: "var(--bg-subtle,#f5f5f5)" }}>
                   <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                     <span style={{ fontSize: 10, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{(rec.contextLabel || rec.helperId || "自由发挥") + (rec.turn && rec.turn > 1 ? " · 第" + rec.turn + "轮" : "") + " · " + fmtTime(rec.at)}</span>
                     <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 9, border: "1px solid " + (rec.landed ? "rgba(22,163,74,.5)" : "rgba(220,38,38,.4)"), color: rec.landed ? "#16a34a" : "#dc2626" }}>{rec.landed ? "已落地" : "未落地"}</span>
                   </div>
                   <div style={{ fontSize: 12, fontWeight: 500, marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: 1.4 }}>💬 {(rec.message || "（早期记录无输入）").slice(0, 200)}</div>
                   <div style={{ fontSize: 11, opacity: 0.75, marginTop: 3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{(rec.result || "").slice(0, 200)}</div>
                   {rec.landed && rec.landDetail ? <div style={{ fontSize: 10, color: "#16a34a", marginTop: 4 }}>{rec.landDetail}</div> : null}
                 </div>
               ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

