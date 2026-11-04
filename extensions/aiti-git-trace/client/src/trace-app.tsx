/**
 * aiti-git-trace · client 入口薄壳（2026-09-13 薄壳拆分）
 *
 * 薄壳只做「零/低成本」的事：会话状态接线、工具条入口、徽标、回撤后验横幅，
 * 以及把重面板（关注路径 / 时间线 / 回撤对话框，~1.2k 行）换成**懒加载包装**：
 *   - 点工具条 / 徽标 / 横幅按钮 → openPanel 事件 → 薄壳桥（替面板翻 float 状态）
 *     → 动态 import ./panels → 面板挂载并重放事件数据；
 *   - 停靠面（rightFileDock / sidebarExplorerDock）→ 面渲染时才加载；
 *   - forkGate → requestForkDialog（用到才加载，弹窗就绪后照旧走三选项）。
 * 拆包动机：开页不再为未使用的面板付 ~60KB；panels chunk 由服务端批量包外置为
 * 相对引用（client-bundle 只在交互时按需拉取）。
 *
 * 跨扩展对接点（window）：__aitiGitTraceForkDialog（兼容转调）、__aitiGitTraceBanner。
 */
import { useState, useEffect, t } from "./host-shim";
import { usePresent, openFloat, isSidebarDockState } from "../../../_shared/ext-float-dock";
import {
  OPEN_EVENT, TIMELINE_KEY, WATCH_KEY, openPanel,
  bindSession, getSessionId, fetchOpsCached,
  btnStyle, chipStyle,
} from "./common";

// 会话服务接线继续由薄壳承担（entry.tsx 调用；重面板只读同一份模块态）
export { installSessionService } from "./common";

// ---------- 重面板懒加载桥 ----------

type PanelsModule = {
  WatchPanelSlot: any; WatchDockLeft: any; WatchDockRight: any;
  TimelineSlot: any; TimelineDockRight: any; TimelineDockLeft: any;
  ForkDialogSlot: any;
  requestForkDialog: (params: any) => Promise<any>;
};

const panelsNeedSubs = new Set<() => void>();
let panelsPromise: Promise<PanelsModule> | null = null;
let panelsReady = false;
let forkNeeded = false;

function notifyPanelsNeed(): void {
  for (const cb of [...panelsNeedSubs]) { try { cb(); } catch { /* noop */ } }
}

/** 加载重面板 chunk（幂等；失败允许重试——下次交互再触发）。 */
export function loadPanels(): Promise<PanelsModule> {
  if (!panelsPromise) {
    panelsPromise = (import("./panels") as Promise<PanelsModule>).then((m) => {
      panelsReady = true;
      notifyPanelsNeed();
      return m;
    }).catch((e) => {
      panelsPromise = null;
      throw e;
    });
  }
  return panelsPromise;
}

function keyOfKind(kind: string): string {
  return kind === "timeline" ? TIMELINE_KEY : kind === "watch" ? WATCH_KEY : "aiti-git-trace:" + kind;
}

/**
 * open 事件桥：面板监听只在其「面」被渲染时才存在（closed 态没有任何面板组件挂载），
 * 所以桥不能只看 chunk 是否已加载——必须看该 kind 当前是否有挂载中的面（mountedKinds）：
 *   - 有面挂载：只翻状态（面板自己的监听会拿 data）；
 *   - 无面挂载：翻状态 + 暂存 data（面板挂载后 useReplayOpen 重放）+ 触发 chunk 加载。
 */
const pendingOpen = new Map<string, any>();
const mountedKinds = new Map<string, number>();
function markKindMounted(kind: string, active: boolean): () => void {
  if (!active) return () => {};
  mountedKinds.set(kind, (mountedKinds.get(kind) ?? 0) + 1);
  return () => {
    const n = (mountedKinds.get(kind) ?? 1) - 1;
    if (n <= 0) mountedKinds.delete(kind);
    else mountedKinds.set(kind, n);
  };
}
if (typeof window !== "undefined") {
  window.addEventListener(OPEN_EVENT, (e: any) => {
    const d = e?.detail || {};
    if (!d.kind) return;
    const kind = String(d.kind);
    if ((mountedKinds.get(kind) ?? 0) === 0) pendingOpen.set(kind, d.data);
    openFloat(keyOfKind(kind));
    void loadPanels().catch(() => { /* 加载失败：面板不可用（等价于从未打开） */ });
  }, true);
}

/** enabled 时才加载并取回重面板组件（返回 null 表示尚未就绪）。 */
function useHeavyComponent(enabled: boolean, which: keyof PanelsModule): any {
  const [Comp, setComp] = useState<any>(null);
  useEffect(() => {
    if (!enabled || Comp) return;
    let alive = true;
    void loadPanels().then((m) => { if (alive) setComp(() => (m as any)[which]); }).catch(() => { /* 下次再试 */ });
    return () => { alive = false; };
  }, [enabled, which, Comp]);
  return Comp;
}

/** 面板挂载后重放「薄壳期捕获的 open 数据」（面板自己的 OPEN_EVENT 监听此刻已注册）。 */
function useReplayOpen(kind: string, Comp: any): void {
  useEffect(() => {
    if (!Comp || !pendingOpen.has(kind)) return;
    const data = pendingOpen.get(kind);
    pendingOpen.delete(kind);
    try { window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { kind, data } })); } catch { /* noop */ }
  }, [Comp, kind]);
}

/** 面激活判定（与重面板内部 gate 一致）：float=浮窗态；right=右栏 tab；left=sidebar 族停靠。
 *  只有「面真的会被渲染」才加载 chunk——例如 dockpref=right-panel 但右栏 tab 未激活时不加载。 */
function faceActive(face: "float" | "right" | "left", st: string): boolean {
  if (face === "float") return st === "floating";
  if (face === "right") return st === "docked:right-panel";
  return isSidebarDockState(st);
}

/** 浮动面板包装（dialogs 槽常挂）：浮窗态才加载渲染。 */
function floatPanel(kind: string, which: keyof PanelsModule) {
  return function LazyFloatPanel(props?: any) {
    const presented = usePresent(keyOfKind(kind));
    const active = faceActive("float", presented);
    useEffect(() => markKindMounted(kind, active), [kind, active]);
    const Comp = useHeavyComponent(active, which);
    useReplayOpen(kind, Comp);
    return Comp ? <Comp {...(props ?? {})} /> : null;
  };
}

/** 停靠面包装：面被宿主渲染 = 用户正在看 → 挂载即加载（仍按状态二次确认）。 */
function dockFace(kind: string, face: "right" | "left", which: keyof PanelsModule) {
  return function LazyDockFace(props?: any) {
    const presented = usePresent(keyOfKind(kind));
    const active = faceActive(face, presented);
    useEffect(() => markKindMounted(kind, active), [kind, active]);
    const Comp = useHeavyComponent(active, which);
    useReplayOpen(kind, Comp);
    return Comp ? <Comp {...(props ?? {})} /> : null;
  };
}

export const WatchPanelSlot = floatPanel("watch", "WatchPanelSlot");
export const WatchDockLeft = dockFace("watch", "left", "WatchDockLeft");
export const WatchDockRight = dockFace("watch", "right", "WatchDockRight");
export const TimelineSlot = floatPanel("timeline", "TimelineSlot");
export const TimelineDockRight = dockFace("timeline", "right", "TimelineDockRight");
export const TimelineDockLeft = dockFace("timeline", "left", "TimelineDockLeft");

/** 回撤对话框包装：forkGate 请求时加载渲染。 */
export function ForkDialogSlot(): any {
  const [needed, setNeeded] = useState(forkNeeded);
  useEffect(() => {
    if (needed) return;
    const cb = () => setNeeded(true);
    panelsNeedSubs.add(cb);
    return () => { panelsNeedSubs.delete(cb); };
  }, [needed]);
  const Comp = useHeavyComponent(needed, "ForkDialogSlot");
  return Comp ? <Comp /> : null;
}

/** forkGate 入口（entry.tsx 调用）：用到才加载重面板，弹窗 Promise 语义与原实现一致。 */
export async function requestForkDialog(params: any): Promise<any> {
  forkNeeded = true;
  notifyPanelsNeed();
  const m = await loadPanels();
  return m.requestForkDialog(params);
}

// ---------- 工具条按钮 ----------

const toolbarBtnStyle: any = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 36, height: 36, padding: 0, background: "none",
  borderRight: "1px solid var(--border)", color: "var(--text-muted)",
  cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1, transition: "color 0.12s",
};
const svgProps = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as any;

// 工具条按钮（⎇ 关注路径 / ⎇ 时间线）：纯静态组件，与 config/git-review 等扩展按钮同款注册方式。
// feature 门控（trace.watchUI / trace.timelineUI，默认关）由宿主统一处理：registerItems 条目带 feature，
// 关 → 宿主过滤不渲染（顶栏行/⋯菜单/自定义面板都不进，extman 变更实时生效）——扩展无需自己注册/注销或在组件内门控。

export function WatchToolbarButton(props?: any) { bindSession(props);
  return (
    <button style={toolbarBtnStyle} title={t("gt.watch.title")} onClick={() => openPanel("watch")}>
      <svg {...svgProps}><line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
    </button>
  );
}

export function TimelineToolbarButton(props?: any) { bindSession(props);
  return (
    <button style={toolbarBtnStyle} title={t("gt.timeline.title")} onClick={() => openPanel("timeline", { sessionId: getSessionId() })}>
      <svg {...svgProps}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
    </button>
  );
}

// composerTools 插槽入口（输入框下方控制行，与压缩/导入同排；32×32 图标按钮与原生兄弟一致）——时间线主入口
export function TimelineComposerButton(props?: any) { bindSession(props);
  const sid = props?.sessionId || getSessionId(); // composerTools extra 直传 sessionId（chatInputTop 同款）
  return (
    <button
      title={t("gt.timeline.title")}
      aria-label={t("gt.timeline.title")}
      onClick={() => openPanel("timeline", { sessionId: sid })}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        width: 32, height: 32, padding: 0,
        background: "none", border: "none", borderRadius: 9,
        color: "var(--text-muted)", cursor: "pointer",
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    </button>
  );
}

// ---------- 回撤后验横幅（§5.4 兜底） ----------

export function BannerSlot(): any {
  const [info, setInfo] = useState<any>(null);
  useEffect(() => {
    (window as any).__aitiGitTraceBanner = (i: any) => setInfo(i || null);
    return () => { try { delete (window as any).__aitiGitTraceBanner; } catch {} };
  }, []);
  if (!info) return null;
  return (
    <div style={{ margin: "6px 12px", padding: "6px 12px", borderRadius: 8, border: "1px solid #d4a72c", color: "#9a6700", background: "var(--bg-panel)", display: "flex", gap: 10, alignItems: "center" }}>
      <span>{String(t("gt.banner.text")).replace("{n}", String(info.count ?? "?"))}</span>
      <button style={btnStyle} onClick={() => openPanel("timeline", { sessionId: info.sessionId })}>{t("gt.timeline.title")}</button>
      <button style={btnStyle} onClick={() => setInfo(null)}>{t("gt.common.close")}</button>
    </div>
  );
}

// ---------- 用户消息徽标 ----------

// 取数走 common.fetchOpsCached 共享缓存（§11.3 性能审计合并：此前徽标独立一份 TTL 缓存，
// 与 footer 各拉一次 /ops；现单缓存 + ETag 再校验，live 失效走 invalidateOpsCache）

export function MessageBadge(props?: any): any {
  bindSession(props);
  const entryId = String(props?.entryId || "");
  const [ops, setOps] = useState<any[] | null>(null);
  useEffect(() => {
    if (!entryId) return;
    let dead = false;
    const sid = getSessionId();
    if (!sid) return;
    fetchOpsCached(sid).then((list) => { if (!dead) setOps(list); });
    return () => { dead = true; };
  }, [entryId]);
  if (!entryId || ops === null) return null;
  // 与时间线增量口径一致：纯基线 op（before=null）/无变更 op 不计入徽标
  const hasDelta = (row: any) => (row.leaks || []).length > 0
    || (row.stores || []).some((s: any) => s.before && (s.files ? (s.files.M || 0) + (s.files.A || 0) + (s.files.D || 0) : 0) > 0);
  const mine = ops.filter((row: any) => (row.entryId === entryId || row.userEntryId === entryId) && hasDelta(row));
  if (mine.length === 0) return null; // 该消息无被追踪操作：不渲染（避免噪音）
  return (
    // 场景 3：徽标带 entryId 打开 → 总览自动过滤到该轮
    <button style={chipStyle} title={"aiti-git-trace：" + mine.length + " 个被追踪操作（点击看时间线）"}
      onClick={() => openPanel("timeline", { sessionId: getSessionId(), entryId })}>⎇ {mine.length}</button>
  );
}
