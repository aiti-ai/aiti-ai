/**
 * aiti-git-trace · 共享层（薄壳与重面板共用）
 *
 * 拆包契约（2026-09-13 薄壳拆分）：本文件只放两侧都要用的东西——session 状态、
 * API 小工具、open 事件/浮动键、样式。**不得 import 重面板模块**（panels.tsx 反向依赖本文件）。
 */
import { useState, useEffect, apiUrl } from "./host-shim";
import { usePresent, openFloat, closePanel } from "../../../_shared/ext-float-dock";

export const TIMELINE_KEY = "aiti-git-trace:timeline";
export const WATCH_KEY = "aiti-git-trace:watch";

// ---------- 小工具 ----------

export const OPEN_EVENT = "aiti-git-trace-open";
export function openPanel(kind: string, data?: any) {
  (window as any).dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { kind, data } }));
}

/** dock v3：kind → itemKey 映射 + 状态机收口（CustomEvent 只作入口总线，开/关走 openFloat/closePanel）。
 *  开/关走 openFloat/closePanel；open 态 = 非 closed（浮窗与停靠都算开，effect 数据加载照旧）。
 *  返回 [open, setOpen, presented]——presented 供渲染分面（floating / docked:<zone>）。 */
export function useOpenKind(kind: string, onData?: (d: any) => void): [boolean, (v: boolean) => void, string] {
  const key = kind === "timeline" ? TIMELINE_KEY : kind === "watch" ? WATCH_KEY : "aiti-git-trace:" + kind;
  const st = usePresent(key);
  const open = st !== "closed";
  useEffect(() => {
    const fn = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.kind === kind) { onData && onData(d.data); openFloat(key); }
      else if (d.kind === null) { closePanel(TIMELINE_KEY); closePanel(WATCH_KEY); }
    };
    (window as any).addEventListener(OPEN_EVENT, fn);
    return () => (window as any).removeEventListener(OPEN_EVENT, fn);
  }, []);
  const setOpen = (v: boolean) => { if (v) openFloat(key); else closePanel(key); };
  return [open, setOpen, st];
}

export const EXT_API = "/api/extensions/aiti-git-trace";

export async function apiGet(path: string): Promise<any> {
  const r = await fetch(apiUrl(EXT_API + path), { headers: { accept: "application/json" } });
  return r.json();
}
export async function apiPost(path: string, body: any, method = "POST"): Promise<any> {
  const r = await fetch(apiUrl(EXT_API + path), {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}

// ---------- /ops 共享取数（§11.3 性能审计：badge/footer 此前各持独立缓存，每开页重复拉一次） ----------
const OPS_TTL_MS = 4000;

/** 台账 ops 共享取数（badge/footer 同一缓存）：TTL 内直用；过期带 If-None-Match 再校验
 *  （服务端台账未变 → 304 零传输续用）；失败保留旧 rows 防闪空。缓存挂 SHARED 单例
 *  （本模块双实例约束，见 SHARED 注释）。 */
export function fetchOpsCached(sid: string): Promise<any[]> {
  if (!sid) return Promise.resolve([]);
  const now = Date.now();
  const c = SHARED.opsCache;
  if (c && c.sid === sid && now - c.at < OPS_TTL_MS) return Promise.resolve(c.rows);
  if (SHARED.opsInflight && SHARED.opsInflight.sid === sid) return SHARED.opsInflight.promise;
  const headers: Record<string, string> = { accept: "application/json" };
  if (c && c.sid === sid && c.etag) headers["if-none-match"] = c.etag;
  const promise = fetch(apiUrl(EXT_API + "/ops?session=" + encodeURIComponent(sid)), { headers })
    .then(async (r) => {
      if (r.status === 304 && SHARED.opsCache && SHARED.opsCache.sid === sid) {
        SHARED.opsCache.at = Date.now();
        return SHARED.opsCache.rows;
      }
      const body = await r.json().catch(() => null);
      const rows = (body && body.ops) || [];
      SHARED.opsCache = { sid, at: Date.now(), etag: r.headers.get("etag"), rows };
      return rows;
    })
    .catch(() => (SHARED.opsCache && SHARED.opsCache.sid === sid ? SHARED.opsCache.rows : []));
  SHARED.opsInflight = { sid, promise };
  const clearInflight = () => { if (SHARED.opsInflight && SHARED.opsInflight.sid === sid) SHARED.opsInflight = null; };
  promise.then(clearInflight, clearInflight);
  return promise;
}

/** SSE op 事件失效：清指定会话缓存条目（下一次取全量 200）。sid 空 = 全清。 */
export function invalidateOpsCache(sid?: string): void {
  if (SHARED.opsCache && (!sid || SHARED.opsCache.sid === sid)) SHARED.opsCache = null;
}

/** 宿主每次渲染都会下发 currentSession——组件挂载时捕获到模块级，供 getSessionId() 使用 */
/**
 * 宿主每次渲染都会下发 currentSession——组件挂载时捕获，供 getSessionId() 使用。
 *
 * ⚠ 薄壳拆分后本模块存在两份实例（批量包内联的 shell 副本 + panels chunk 经相对
 * import 拉起的 entry 文件副本）——可变状态必须挂 globalThis 单例共享，否则
 * 面板侧读不到会话（会打出无 session 的幻影请求）。
 */
const SHARED: {
  current: { id?: string; cwd?: string; name?: string; firstMessage?: string } | null;
  svc: { id: string; cwd: string } | null;
  svcInstalled: boolean;
  opsCache: { sid: string; at: number; etag: string | null; rows: any[] } | null;
  opsInflight: { sid: string; promise: Promise<any[]> } | null;
} = ((globalThis as any).__aitiGitTraceShared ??= { current: null, svc: null, svcInstalled: false, opsCache: null, opsInflight: null });

export function bindSession(props?: any): void {
  const cs = props?.currentSession;
  if (cs && (cs.id || cs.cwd || cs.name)) SHARED.current = { id: cs.id, cwd: cs.cwd, name: cs.name, firstMessage: cs.firstMessage };
}

// ── 统一会话状态服务（pi-web.session，方案 docs/pi-web-session-state-and-perf-plan.md §4）──
// 仅在 phase=active 时使用 canonical sessionId；**禁止 URL ?session= 未验证兜底**
//（会话已删除时打出幻影请求）。消费范式：判空降级 + onExtServiceChange 等待。
function applySessionSnapshot(snap: any): void {
  SHARED.svc = snap && snap.phase === "active" && snap.sessionId
    ? { id: String(snap.sessionId), cwd: String(snap.session?.cwd ?? "") }
    : null;
}
/** 挂载统一会话服务订阅（entry.tsx 调用一次；服务缺席时静默降级到 props 通道）。 */
export function installSessionService(ctx: Record<string, any>): void {
  if (SHARED.svcInstalled) return;
  SHARED.svcInstalled = true;
  const attach = (): boolean => {
    const svc = ctx.getExtService?.("pi-web.session");
    if (!svc?.subscribe) return false;
    svc.subscribe(applySessionSnapshot);
    return true;
  };
  if (!attach()) {
    ctx.onExtServiceChange?.((key: string, phase: string) => {
      if (key === "pi-web.session" && phase === "up") attach();
    });
  }
}

export function getSessionId(): string {
  // 1) 统一服务（active canonical，唯一权威）；2) 插槽 props（已解析值）；3) 不做 URL 兜底
  if (SHARED.svc?.id) return SHARED.svc.id;
  if (SHARED.current?.id) return String(SHARED.current.id);
  return "";
}
export function getCwd(): string {
  return String(SHARED.svc?.cwd || SHARED.current?.cwd || "");
}

export const panelStyle: any = {
  position: "fixed", right: 18, top: 64, zIndex: 10050, width: 460, maxWidth: "92vw",
  maxHeight: "78vh", overflow: "auto", background: "var(--bg-panel)", color: "var(--text)",
  border: "1px solid var(--border)", borderRadius: 10, padding: 14,
  boxShadow: "0 8px 32px rgba(0,0,0,.45)", fontSize: 13, lineHeight: 1.5,
};
export const btnStyle: any = {
  cursor: "pointer", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--bg-panel)", color: "inherit", padding: "3px 10px", fontSize: 12,
};
export const chipStyle: any = { ...btnStyle, padding: "1px 7px", fontSize: 11, opacity: 0.9 };
export const inputStyle: any = {
  borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)",
  color: "inherit", padding: "4px 8px", fontSize: 12, width: "100%", boxSizing: "border-box",
};
/** float 契约滚动层：float 给面板根补 display:flex/column + overflow:hidden，内容区必须自带滚动（docs/aiti-web-ext-float-dialogs.md） */
export const scrollLayerStyle: any = { flex: 1, minHeight: 0, overflowY: "auto" };

export const badgeStyle = (kind: string): any => ({
  cursor: "pointer", marginLeft: 6, padding: "0 6px", borderRadius: 8, fontSize: 11,
  border: "1px solid", ...(kind === "cross" ? { color: "#9a6700", borderColor: "#d4a72c" }
    : kind === "leak" ? { color: "#cf222e", borderColor: "#f1c1c1" }
    : { color: "var(--text-dim)", borderColor: "var(--border)" }),
});

/** 时间格式：今天显示 HH:MM，更早显示日期（文件视图行尾/触达行用） */
export function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toTimeString().slice(0, 5)
    : d.toLocaleDateString();
}
