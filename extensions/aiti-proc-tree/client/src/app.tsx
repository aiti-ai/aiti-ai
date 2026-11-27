/**
 * aiti-proc-tree · client panel (dock summary + floating tree + detail drawer).
 *
 * Lifecycle discipline (same as aiti-sysmon): sampling runs only while the panel
 * is visible — the dock block collapsed or the browser tab hidden stops the loop.
 * The server holds no timers; the client cadence is the only sampling driver.
 */
import { useEffect, useMemo, useState, apiUrl, t, extFeatures, onFeatureChange, getExtService, ensureMaterialized } from "./host-shim";
import { usePresent, useBlockCollapsed, DockBody, isSidebarDockState, sidebarZoneOf, declareDockZones, seedDockDefault, seedBlockCollapsedDefault, present } from "../../../_shared/ext-float-dock";
import { uiAlert, uiConfirm } from "../../../_shared/ui-dialogs";
import { fmtBytes, fmtCpu, fmtDuration } from "../../core.cjs";

export const PT_KEY = "aiti-proc-tree:panel";

export function ptIconUrl(): string {
  return apiUrl("/api/extensions/aiti-proc-tree/assets/icons/process-tree.svg");
}

// ---------------------------------------------------------------- types

interface ProcNode {
  pid: number;
  ppid: number;
  parentPid: number;
  kind: string;
  owner: string;
  label: string;
  sessionId?: string;
  cwd?: string;
  user?: string;
  state?: string;
  cpu: number | null;
  mem: number | null;
  etimeMs: number | null;
  cmd?: string;
  canKill: boolean;
  protectedReason?: string;
  instance: string;
  source: string;
  transport?: string;
  url?: string;
  socket?: string;
  attached?: boolean;
  hasChildren?: boolean;
}

interface TreeData {
  ts: number;
  instance: { selfPid: number; cliPid: number; port: number | null; mode: string };
  sampling: { firstTick: boolean; scanned: number; visible: number; approxCpu: boolean; truncated: boolean; limit: number };
  stats: { total: number; cpu: number; mem: number; killable: number };
  nodes: ProcNode[];
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// ---------------------------------------------------------------- polling

function useSnapshot(enabled: boolean, intervalSec: number, limit: number) {
  const [data, setData] = useState<TreeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<boolean>(() => typeof document !== "undefined" && document.hidden);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (!enabled || hidden) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const q = new URLSearchParams();
        q.set("limit", String(limit));
        const r = await fetch(apiUrl("/api/extensions/aiti-proc-tree/tree?" + q.toString()), { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = (await r.json()) as TreeData;
        if (!stopped) { setData(j); setError(null); }
      } catch (e: any) {
        if (!stopped) setError(String(e?.message || e));
      }
      if (!stopped) timer = setTimeout(tick, Math.max(1, intervalSec) * 1000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, hidden, intervalSec, limit]);

  return { data, error };
}

// ---------------------------------------------------------------- tree helpers

interface Group { key: string; label: string; roots: ProcNode[] }

function groupOf(node: ProcNode): { key: string; label: string } {
  if (node.kind === "host") return { key: "host", label: "宿主" };
  if (node.kind === "terminal") return { key: "terminal", label: "终端" };
  if (node.kind === "agent") return { key: "agent", label: "外部 Agent" };
  if (node.kind === "subagent") return { key: "subagent", label: "子代理" };
  if (node.kind === "tunnel") return { key: "tunnel", label: "隧道" };
  // Helper rows stay with their owner: aiti-cmd pty-host wrappers are terminals,
  // service-tunnels helpers are tunnels, agent-starter wrappers host external agents.
  if (node.kind === "helper") {
    if (node.owner === "service-tunnels") return { key: "tunnel", label: "隧道" };
    if (node.owner === "aiti-cmd") return { key: "terminal", label: "终端" };
    return { key: "agent", label: "外部 Agent" };
  }
  return { key: "other", label: "其它" };
}

type SortKey = "name" | "pid" | "cpu" | "mem" | "etime";

/** Windows Task Manager semantics: click a header to sort, click again to flip;
 *  name/pid start ascending, numeric columns start descending. */
function sortNodes(list: ProcNode[], key: SortKey, dir: 1 | -1): ProcNode[] {
  const val = (n: ProcNode): number => {
    if (key === "cpu") return n.cpu == null ? -1 : n.cpu;
    if (key === "mem") return n.mem == null ? -1 : n.mem;
    if (key === "etime") return n.etimeMs == null ? -1 : n.etimeMs;
    return n.pid;
  };
  return list.slice().sort((a, b) => {
    if (key === "name") {
      const r = a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
      return (r * dir) || a.pid - b.pid;
    }
    return (val(a) - val(b)) * dir || a.pid - b.pid;
  });
}

function SortArrow(props: { active: boolean; dir: 1 | -1 }) {
  // Only the active column renders an arrow (others keep the width so headers
  // do not shift when the sort column changes).
  if (!props.active) return <span style={{ display: "inline-block", width: 8 }} />;
  return (
    <span style={{ display: "inline-block", width: 8, fontSize: 8, lineHeight: 1 }}>
      {props.dir === 1 ? "▲" : "▼"}
    </span>
  );
}

function buildIndex(nodes: ProcNode[]) {
  const byPid = new Map<number, ProcNode>();
  for (const n of nodes) byPid.set(n.pid, n);
  const children = new Map<number, ProcNode[]>();
  const roots: ProcNode[] = [];
  for (const n of nodes) {
    const parent = n.parentPid && byPid.has(n.parentPid) ? n.parentPid : 0;
    if (parent) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(n);
    } else {
      roots.push(n);
    }
  }
  return { byPid, children, roots };
}

function matchNode(n: ProcNode, q: string): boolean {
  const needle = q.toLowerCase();
  return String(n.pid) === needle
    || n.label.toLowerCase().includes(needle)
    || (n.sessionId || "").toLowerCase().includes(needle)
    || (n.owner || "").toLowerCase().includes(needle)
    || (n.url || "").toLowerCase().includes(needle);
}

/** Keep matches + their ancestor chain; roots stay in original order. */
function filterVisible(nodes: ProcNode[], q: string): ProcNode[] {
  if (!q.trim()) return nodes;
  const byPid = new Map(nodes.map((n) => [n.pid, n]));
  const keep = new Set<number>();
  for (const n of nodes) {
    if (!matchNode(n, q.trim())) continue;
    keep.add(n.pid);
    let p = n.parentPid;
    let guard = 0;
    while (p && byPid.has(p) && guard++ < 64) {
      keep.add(p);
      p = byPid.get(p)!.parentPid;
    }
  }
  return nodes.filter((n) => keep.has(n.pid));
}

// ---------------------------------------------------------------- colors / atoms

function kindColor(kind: string): string {
  if (kind === "host") return "var(--accent,#4c8bf5)";
  if (kind === "terminal") return "#3fb950";
  if (kind === "agent") return "#a371f7";
  if (kind === "subagent") return "#d29922";
  if (kind === "tunnel" || kind === "helper") return "#39c5cf";
  return "var(--text-dim,#9aa0a6)";
}

function Dot(props: { color: string; title?: string }) {
  return <span title={props.title} style={{ display: "inline-block", width: 7, height: 7, borderRadius: 999, background: props.color, flexShrink: 0 }} />;
}

function Triangle(props: { open: boolean; onClick: (e: any) => void }) {
  return (
    <span onClick={props.onClick} style={{ width: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0, color: "var(--text-dim,#888)" }}>
      <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" style={{ transform: props.open ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>
        <path d="M9 6l6 6-6 6" />
      </svg>
    </span>
  );
}

// ---------------------------------------------------------------- row

/** Compact column mode: below this container width the numeric columns shrink and
 *  the action column collapses into the ⋯ menu (no hover-only buttons on touch). */
const COMPACT_W = 480;

function useCompact(): boolean {
  const [compact, setCompact] = useState(() => (typeof window !== "undefined" ? window.innerWidth <= COMPACT_W : false));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: " + COMPACT_W + "px)");
    const on = () => setCompact(mq.matches);
    on();
    try { mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }
    catch { mq.addListener(on); return () => mq.removeListener(on); }
  }, []);
  return compact;
}

function ProcRow(props: {
  node: ProcNode;
  depth: number;
  expanded: Set<number>;
  toggle: (pid: number) => void;
  onSelect: (pid: number) => void;
  onKill: (node: ProcNode, mode: "single" | "subtree") => void;
  onTerminal: (node: ProcNode) => void;
  hasChildren: boolean;
  selected: number | null;
  compact: boolean;
}) {
  const { node, depth, expanded, toggle, onSelect, onKill, onTerminal, hasChildren, selected, compact } = props;
  const [hover, setHover] = useState(false);
  const open = expanded.has(node.pid);
  const dim = node.state === "Z" || node.state === "zombie";
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => { if (node.pid > 0) onSelect(node.pid); }}
      onDoubleClick={() => { if (node.kind === "terminal" && node.sessionId) onTerminal(node); }}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "3px 8px 3px " + (8 + depth * 14) + "px",
        borderBottom: "1px solid color-mix(in srgb, var(--border,#333) 45%, transparent)",
        background: selected === node.pid ? "color-mix(in srgb, var(--accent,#4c8bf5) 14%, transparent)" : hover ? "var(--bg-hover,rgba(255,255,255,0.04))" : "transparent",
        cursor: "pointer", fontSize: 12, minHeight: 26,
      }}
    >
      {hasChildren ? <Triangle open={open} onClick={(e: any) => { e.stopPropagation(); toggle(node.pid); }} /> : <span style={{ width: 14, flexShrink: 0 }} />}
      <Dot color={kindColor(node.kind)} title={node.kind} />
      <span style={{ flex: "1 1 auto", minWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: dim ? 0.55 : 1 }}>
        {node.label}
        {node.instance === "detached" ? <span style={{ marginLeft: 5, fontSize: 9, color: "var(--text-dim,#888)" }}>detached</span> : null}
        {node.attached ? <span style={{ marginLeft: 5, fontSize: 9, color: "var(--text-dim,#888)" }}>attached</span> : null}
        {node.instance === "external" ? <span style={{ marginLeft: 5, fontSize: 9, color: "var(--text-dim,#888)" }}>ext</span> : null}
      </span>
      <span style={{ width: compact ? 48 : 62, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-dim,#9aa0a6)" }}>{node.pid}</span>
      <span style={{ width: compact ? 40 : 52, textAlign: "right", fontVariantNumeric: "tabular-nums", color: (node.cpu || 0) >= 70 ? "#d4574e" : "var(--text)" }}>{fmtCpu(node.cpu)}</span>
      <span style={{ width: compact ? 46 : 66, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-dim,#9aa0a6)" }}>{compact ? fmtBytes(node.mem, 0) : fmtBytes(node.mem)}</span>
      <span style={{ width: compact ? 44 : 66, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-dim,#9aa0a6)" }}>{compact ? fmtDuration(node.etimeMs).replace(/ \d+s$/, "") : fmtDuration(node.etimeMs)}</span>
      <span style={{ width: compact ? 22 : 56, display: "flex", justifyContent: "flex-end", gap: 2, flexShrink: 0 }}>
        {/* Touch: always-visible (hover is unreliable); desktop: hover-only to keep rows calm. */}
        {compact || hover ? (
          <>
            {node.canKill ? (
              <button type="button" title={t("结束进程")} onClick={(e: any) => { e.stopPropagation(); onKill(node, "single"); }}
                style={{ width: 20, height: 20, padding: 0, border: "none", borderRadius: 4, background: "none", color: "#d4574e", cursor: "pointer", fontSize: 12 }}>✕</button>
            ) : null}
            <button type="button" title={t("查看详情")} onClick={(e: any) => { e.stopPropagation(); onSelect(node.pid); }}
              style={{ width: 20, height: 20, padding: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim,#888)", cursor: "pointer", fontSize: 12 }}>⋯</button>
          </>
        ) : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- detail drawer

function DetailDrawer(props: { pid: number; onClose: () => void; onTerminal: (node: ProcNode) => void; onOpenSession: (node: ProcNode) => void; onKill: (node: ProcNode, mode: "single" | "subtree") => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    setData(null);
    setError(null);
    fetch(apiUrl("/api/extensions/aiti-proc-tree/node/" + props.pid), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((j) => { if (!stopped) setData(j); })
      .catch((e) => { if (!stopped) setError(String(e?.message || e)); });
    return () => { stopped = true; };
  }, [props.pid]);

  const node: ProcNode | undefined = data?.node;
  const env: Record<string, string> = data?.detail?.env || {};
  return (
    <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: 320, borderLeft: "1px solid var(--border,#333)", background: "var(--bg-panel,var(--bg,elevated))", display: "flex", flexDirection: "column", zIndex: 2, fontSize: 11 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: "1px solid var(--border,#333)" }}>
        <Dot color={kindColor(node?.kind || "unknown")} />
        <strong style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node ? node.label : t("详情")}</strong>
        {node && node.kind === "terminal" && node.sessionId ? (
          <button type="button" onClick={() => props.onTerminal(node)} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4 }}>{t("打开终端")}</button>
        ) : null}
        {node && (node.kind === "agent" || node.kind === "helper") && node.sessionId && node.owner === "agent-starter" ? (
          <button type="button" title={t("打开对应会话")} onClick={() => props.onOpenSession(node)} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4 }}>{t("打开会话")}</button>
        ) : null}
        <button type="button" onClick={props.onClose} style={{ fontSize: 12, padding: "0 4px", background: "none", border: "none", cursor: "pointer", color: "var(--text-dim,#888)" }}>✕</button>
      </div>
      {node ? (
        <div style={{ display: "flex", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border,#333)" }}>
          {node.canKill ? (
            <>
              <button type="button" onClick={() => props.onKill(node, "single")}
                style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid #d4574e", color: "#d4574e", background: "none", cursor: "pointer" }}>
                {t("结束进程")}
              </button>
              <button type="button" onClick={() => props.onKill(node, "subtree")}
                style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, border: "1px solid #d4574e", color: "#fff", background: "#d4574e", cursor: "pointer" }}>
                {t("结束子树")}
              </button>
            </>
          ) : (
            <span style={{ fontSize: 10, color: "var(--text-dim,#888)" }} title={node.protectedReason}>
              {node.protectedReason === "host" ? t("宿主进程默认禁止结束") : t("不可结束") + (node.protectedReason ? " · " + node.protectedReason : "")}
            </span>
          )}
          <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--text-dim,#888)" }}>
            {t("确认结束")} · {t("TERM→KILL")}
          </span>
        </div>
      ) : null}
      <div style={{ flex: 1, overflow: "auto", padding: "8px 10px" }}>
        {error ? <div style={{ color: "#d4574e" }}>{error}</div> : null}
        {!data && !error ? <div style={{ color: "var(--text-dim,#888)" }}>{t("加载中")}</div> : null}
        {data ? (
          <>
            <Field k={t("PID")} v={String(data.pid)} />
            <Field k={t("状态")} v={(data.detail?.state || node?.state || "") + (node?.owner ? " · " + node.owner : "")} />
            <Field k={t("用户")} v={data.detail?.user || node?.user || ""} />
            <Field k={t("工作目录")} v={data.detail?.cwd || node?.cwd || ""} />
            <Field k={t("来源")} v={(node?.source || "") + (node?.transport ? " · " + node.transport : "")} />
            {node?.url ? <Field k="URL" v={node.url} /> : null}
            {node?.socket ? <Field k={t("套接字 / Unit")} v={node.socket} /> : null}
            <div style={{ marginTop: 8, color: "var(--text-dim,#888)" }}>{t("命令行")}</div>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "3px 0 8px", fontSize: 10, lineHeight: 1.35 }}>{data.detail?.cmd || "—"}</pre>
            <div style={{ color: "var(--text-dim,#888)" }}>{t("环境变量")}（{t("白名单")}）</div>
            <div style={{ margin: "3px 0 8px" }}>
              {Object.keys(env).length === 0 ? <span style={{ color: "var(--text-dim,#888)" }}>—</span> : null}
              {Object.entries(env).map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 6, padding: "1px 0" }}>
                  <span style={{ color: "var(--text-dim,#888)", flexShrink: 0 }}>{k}</span>
                  <span style={{ wordBreak: "break-all", opacity: 0.9 }}>{v}</span>
                </div>
              ))}
            </div>
            {data.parent ? <Field k={t("父进程")} v={data.parent.label + " (" + data.parent.pid + ")"} /> : null}
            <div style={{ color: "var(--text-dim,#888)", marginTop: 4 }}>{t("子进程")}（{Array.isArray(data.children) ? data.children.length : 0}）</div>
            {(data.children || []).map((c: any) => (
              <div key={c.pid} style={{ padding: "1px 0", opacity: 0.9 }}>{c.label} <span style={{ color: "var(--text-dim,#888)" }}>({c.pid})</span></div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Open the pi session this agent node belongs to (host pi-web.session service). */
function openAgentSession(node: ProcNode): void {
  if (!node.sessionId) return;
  const svc = getExtService<any>("pi-web.session");
  if (svc && typeof svc.open === "function") { svc.open(node.sessionId); return; }
  try { console.warn("[aiti-proc-tree] pi-web.session.open unavailable; cannot open session " + node.sessionId); } catch { /* noop */ }
}

function Field(props: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "2px 0" }}>
      <span style={{ color: "var(--text-dim,#888)", width: 78, flexShrink: 0 }}>{props.k}</span>
      <span style={{ wordBreak: "break-all" }}>{props.v || "—"}</span>
    </div>
  );
}

// ---------------------------------------------------------------- main app

function ProcTreeApp(props: { embedded?: boolean; enabledOverride?: boolean }) {
  const embedded = props.embedded === true;
  const compact = useCompact();
  const features = extFeatures();
  const [intervalSec, setIntervalSec] = useState<number>(() => num(features.interval, 2, 1, 30));
  const [limit, setLimit] = useState<number>(() => num(features.limit, 200, 0, 2000));
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const applySort = (key: SortKey) => {
    if (key === sortKey) { setSortDir((d) => (d === 1 ? -1 : 1)); return; }
    setSortKey(key);
    setSortDir(key === "name" || key === "pid" ? 1 : -1);
  };
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [expandedOnce, setExpandedOnce] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const off = onFeatureChange(() => {
      const f = extFeatures();
      setIntervalSec(num(f.interval, 2, 1, 30));
      setLimit(num(f.limit, 200, 0, 2000));
    });
    return off;
  }, []);

  const enabled = props.enabledOverride !== false && !paused;
  const { data, error } = useSnapshot(enabled, intervalSec, limit);

  // First data arrival: expand depth 0 and 1 once so the tree is not a flat list.
  useEffect(() => {
    if (!data || expandedOnce) return;
    const byPid = new Map(data.nodes.map((n) => [n.pid, n]));
    const roots = data.nodes.filter((n) => !n.parentPid || !byPid.has(n.parentPid));
    const next = new Set<number>();
    for (const root of roots) {
      if (root.hasChildren) next.add(root.pid);
      for (const child of data.nodes) {
        if (child.parentPid === root.pid && child.hasChildren) next.add(child.pid);
      }
    }
    setExpanded(next);
    setExpandedOnce(true);
  }, [data, expandedOnce]);

  const filtered = useMemo(() => (data ? filterVisible(data.nodes, search) : []), [data, search]);
  const index = useMemo(() => buildIndex(filtered), [filtered]);
  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    const roots = sortNodes(index.roots, sortKey, sortDir);
    for (const root of roots) {
      const g = groupOf(root);
      if (!map.has(g.key)) map.set(g.key, { key: g.key, label: g.label, roots: [] });
      map.get(g.key)!.roots.push(root);
    }
    const order = ["host", "terminal", "agent", "subagent", "tunnel", "other"];
    return order.map((k) => map.get(k)).filter(Boolean) as Group[];
  }, [index, sortKey, sortDir]);

  const toggle = (pid: number) => {
    const next = new Set(expanded);
    if (next.has(pid)) next.delete(pid); else next.add(pid);
    setExpanded(next);
  };
  const toggleGroup = (key: string) => {
    const next = new Set(collapsedGroups);
    if (next.has(key)) next.delete(key); else next.add(key);
    setCollapsedGroups(next);
  };

  const openTerminal = (node: ProcNode) => {
    if (!node.sessionId) return;
    ensureMaterialized("aiti-cmd");
    const svc = getExtService<(sid: string, label?: string) => void>("aiti-cmd.open-session");
    if (typeof svc === "function") { svc(node.sessionId, node.label); return; }
    const legacy = (window as any).__aitiCmd;
    if (legacy && typeof legacy.openSession === "function") legacy.openSession(node.sessionId, node.label);
    else setToast(t("打开终端") + " · aiti-cmd");
  };

  const openServices = () => {
    ensureMaterialized("service-tunnels");
    const svc = getExtService<(tab?: string, opts?: any) => void>("service-tunnels.open-dialog");
    if (typeof svc === "function") svc("ports");
    else setToast(t("打开服务面板") + " · service-tunnels");
  };

  const doKill = async (node: ProcNode, mode: "single" | "subtree") => {
    const target = node.label + " · PID " + node.pid;
    const ok = await uiConfirm({
      title: mode === "subtree" ? t("结束子树") : t("结束进程"),
      message: t("将结束 {n} 个进程（含 {m} 个子进程）", { n: 1, m: mode === "subtree" ? "…" : 0 }) + "  " + target,
      detail: node.cmd || node.cwd || "",
      danger: true,
      confirmText: t("确认结束"),
      cancelText: t("取消"),
    });
    if (!ok) return;
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-proc-tree/kill"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pids: [node.pid], mode, confirm: true, allowHost: false }),
      });
      const j = await r.json();
      if (!r.ok) { await uiAlert({ message: String(j.error || r.status), kind: "error" }); return; }
      const denied = Array.isArray(j.denied) ? j.denied : [];
      const results = Array.isArray(j.results) ? j.results : [];
      const failed = results.filter((x: any) => !x.ok);
      if (denied.length) {
        const reason = denied[0].reason;
        await uiAlert({
          message: reason === "host" ? t("宿主进程默认禁止结束") : t("不可结束") + " · " + reason,
          kind: reason === "host" ? "warn" : "error",
        });
        return;
      }
      if (failed.length) { await uiAlert({ message: t("部分失败") + " · " + failed.map((x: any) => x.pid).join(", "), kind: "error" }); }
      setToast(t("已结束") + " · " + node.label);
      window.setTimeout(() => setToast(null), 2500);
    } catch (e: any) {
      await uiAlert({ message: String(e?.message || e), kind: "error" });
    }
  };

  const renderChildren = (parent: ProcNode, depth: number): any[] => {
    const kids = sortNodes(index.children.get(parent.pid) || [], sortKey, sortDir);
    const out: any[] = [];
    for (const kid of kids) {
      out.push(
        <ProcRow
          key={kid.pid}
          node={kid}
          depth={depth}
          expanded={expanded}
          toggle={toggle}
          onSelect={setSelected}
          onKill={doKill}
          onTerminal={openTerminal}
          hasChildren={Boolean(index.children.get(kid.pid)?.length)}
          selected={selected}
          compact={compact}
        />,
      );
      if (expanded.has(kid.pid)) out.push(...renderChildren(kid, depth + 1));
    }
    return out;
  };

  const body = (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", height: embedded ? "auto" : "100%", minHeight: 0 }}>
      {embedded ? null : (
        <div
          data-ext-float-drag="1"
          style={{
            display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
            height: 36, padding: "0 8px 0 12px",
            borderBottom: "1px solid var(--border,#333)", cursor: "move", userSelect: "none",
          }}
        >
          <Dot color={kindColor("host")} />
          <span style={{ fontWeight: 600, fontSize: 12 }}>{t("子进程管理")}</span>
          <span style={{ color: "var(--text-dim,#888)", fontSize: 10 }}>{data ? data.stats.total + " " + t("个进程") : ""}</span>
          {/* Spacer keeps the injected chrome (⇱/⛶ from aiti-float, 🔧/🤖 from helpers)
              flush against our close button: schedule's header contract. */}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            aria-label={t("关闭")}
            title={t("关闭")}
            onClick={() => { try { present(PT_KEY, "close"); } catch { /* ignore */ } }}
            style={{ width: 26, height: 26, padding: 0, border: "none", borderRadius: 6, background: "none", color: "var(--text-muted,var(--text-dim,#888))", cursor: "pointer", fontSize: 13, flexShrink: 0 }}
          >✕</button>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border,#333)", flexWrap: "wrap" }}>
        <input
          value={search}
          onChange={(e: any) => setSearch(e.target.value)}
          placeholder={t("搜索 PID / 命令 / 名称")}
          style={{ flex: "1 1 120px", minWidth: 90, fontSize: 11, padding: "3px 6px", borderRadius: 5, border: "1px solid var(--border,#333)", background: "var(--bg,input)", color: "inherit" }}
        />
        <select value={String(intervalSec)} onChange={(e: any) => setIntervalSec(num(e.target.value, 2, 1, 30))}
          title={t("刷新间隔")} style={{ fontSize: 11, padding: "2px 4px", borderRadius: 5 }}>
          {[1, 2, 3, 5, 10].map((s) => <option key={s} value={String(s)}>{s}s</option>)}
        </select>
        <button type="button" onClick={() => setPaused((p) => !p)} style={{ fontSize: 11, padding: "2px 6px", borderRadius: 5 }}>
          {paused ? t("恢复") : t("暂停")}
        </button>
      </div>

      <div style={{ flex: embedded ? "0 0 auto" : 1, overflow: "auto", minHeight: 0 }}>
        {error ? <div style={{ padding: 8, color: "#d4574e", fontSize: 11 }}>{t("错误")} · {error}</div> : null}
        {!data && !error ? <div style={{ padding: 10, color: "var(--text-dim,#888)", fontSize: 11 }}>{t("加载中")}</div> : null}
        {data && data.nodes.length === 0 ? <div style={{ padding: 10, color: "var(--text-dim,#888)", fontSize: 11 }}>{t("空")}</div> : null}
        {data && data.nodes.length > 0 ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", fontSize: 10, color: "var(--text-dim,#888)", borderBottom: "1px solid var(--border,#333)", position: "sticky", top: 0, background: "var(--bg,elevated)", zIndex: 1 }}>
              <span style={{ width: 14, flexShrink: 0 }} />
              <span
                onClick={() => applySort("name")}
                title={t("按名称排序")}
                style={{ flex: "1 1 auto", minWidth: 90, cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 2 }}
              >{t("名称")}<SortArrow active={sortKey === "name"} dir={sortDir} /></span>
              {([
                ["pid", "PID", compact ? 48 : 62, false],
                ["cpu", "CPU", compact ? 40 : 52, false],
                ["mem", compact ? t("内存").slice(0, 2) : t("内存"), compact ? 46 : 66, true],
                ["etime", compact ? t("时长").slice(0, 1) : t("时长"), compact ? 44 : 66, true],
              ] as Array<[SortKey, string, number, boolean]>).map(([key, label, width, right]) => (
                <span
                  key={key}
                  onClick={() => applySort(key)}
                  title={right ? t("点击排序（再次点击切换升/降序）") : t("点击排序")}
                  style={{ width, textAlign: "right", cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}
                >{label}<SortArrow active={sortKey === key} dir={sortDir} /></span>
              ))}
              <span style={{ width: compact ? 22 : 56 }} />
            </div>
            {groups.map((g) => {
              const gcollapsed = collapsedGroups.has(g.key);
              return (
                <div key={g.key}>
                  <div onClick={() => toggleGroup(g.key)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 8px", fontSize: 10, color: "var(--text-dim,#888)", background: "color-mix(in srgb, currentColor 4%, transparent)", cursor: "pointer", userSelect: "none" }}>
                    <Triangle open={!gcollapsed} onClick={(e: any) => { e.stopPropagation(); toggleGroup(g.key); }} />
                    <strong>{t(g.label)}</strong>
                    <span>· {g.roots.length}</span>
                  </div>
                  {gcollapsed ? null : g.roots.map((root) => (
                    <div key={root.pid}>
                      <ProcRow node={root} depth={0} expanded={expanded} toggle={toggle} onSelect={setSelected} onKill={doKill} onTerminal={openTerminal} hasChildren={Boolean(index.children.get(root.pid)?.length)} selected={selected} compact={compact} />
                      {expanded.has(root.pid) ? renderChildren(root, 1) : null}
                    </div>
                  ))}
                </div>
              );
            })}
          </>
        ) : null}
      </div>

      {data ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderTop: "1px solid var(--border,#333)", fontSize: 10, color: "var(--text-dim,#888)", flexWrap: "wrap" }}>
          <span>{data.stats.total} {t("个进程")}</span>
          <span>CPU {fmtCpu(data.stats.cpu)}</span>
          <span>{t("内存")} {fmtBytes(data.stats.mem)}</span>
          {data.sampling.approxCpu ? <span title="ps pcpu is a lifetime average">≈</span> : null}
          {data.sampling.firstTick ? <span>{t("首轮采样中，CPU 将在下一轮显示")}</span> : null}
          {data.sampling.truncated ? <span>{t("已截断", { n: data.sampling.limit })}</span> : null}
          {paused ? <span>{t("已暂停")}</span> : null}
          <span style={{ marginLeft: "auto" }}>{data.instance.mode} · {data.instance.selfPid}</span>
        </div>
      ) : null}

      {toast ? <div style={{ position: "absolute", left: 10, bottom: 28, padding: "4px 8px", borderRadius: 6, background: "color-mix(in srgb, var(--accent,#4c8bf5) 20%, transparent)", fontSize: 10 }}>{toast}</div> : null}

      {selected != null ? (
        <DetailDrawer
          pid={selected}
          onClose={() => setSelected(null)}
          onTerminal={(node) => { openTerminal(node); }}
          onOpenSession={openAgentSession}
          onKill={doKill}
        />
      ) : null}
    </div>
  );

  if (!embedded) return body;
  // Dock summary: totals + top processes, plus an explicit "open panel" action.
  return (
    <div style={{ fontSize: 11 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 2px 6px" }}>
        <span style={{ fontWeight: 600 }}>{t("子进程管理")}</span>
        <button type="button" onClick={() => present(PT_KEY, "float")} style={{ marginLeft: "auto", fontSize: 10, padding: "1px 6px", borderRadius: 4 }}>
          {t("详情")}
        </button>
      </div>
      {data ? (
        <div style={{ display: "flex", gap: 8, color: "var(--text-dim,#888)", flexWrap: "wrap", marginBottom: 6 }}>
          <span>{data.stats.total} {t("个进程")}</span>
          <span>CPU {fmtCpu(data.stats.cpu)}</span>
          <span>{t("内存")} {fmtBytes(data.stats.mem)}</span>
        </div>
      ) : null}
      {data ? sortNodes(index.roots, "cpu", -1).slice(0, 4).map((n) => (
        <div key={n.pid} style={{ display: "flex", alignItems: "center", gap: 5, padding: "1px 0" }}>
          <Dot color={kindColor(n.kind)} />
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.label}</span>
          <span style={{ color: "var(--text-dim,#888)" }}>{fmtCpu(n.cpu)}</span>
        </div>
      )) : null}

    </div>
  );
}

// ---------------------------------------------------------------- slot faces

/** Sidebar dock face (static item id "panel"); auto-docked like the Tasks block. */
export function ProcTreeDockFace() {
  const st = usePresent(PT_KEY);
  const open = isSidebarDockState(st);
  const collapsed = useBlockCollapsed(PT_KEY)[0];
  if (!open) return null;
  return (
    <DockBody itemKey={PT_KEY} title={t("子进程管理")} icon={{ url: ptIconUrl() }} chrome="section" kind="dockable"
      zones={[sidebarZoneOf(PT_KEY)]} defaultZone={sidebarZoneOf(PT_KEY)}>
      <ProcTreeApp embedded enabledOverride={!collapsed} />
    </DockBody>
  );
}

/** Floating panel (pages slot, data-ext-float contract). */
export function ProcTreePage() {
  const st = usePresent(PT_KEY);
  if (st !== "floating") return null;
  return (
    <div
      data-ext-float="1"
      data-ext-float-key={PT_KEY}
      data-ext-float-w={980}
      data-ext-float-h={640}
      data-ext-float-full="1"
      data-ext-float-dock={`${sidebarZoneOf(PT_KEY)} right-panel`}
      data-ext-float-dock-default={sidebarZoneOf(PT_KEY)}
      style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 420, minHeight: 320, background: "var(--bg,elevated)", border: "1px solid var(--border,#333)", borderRadius: 10, overflow: "hidden", boxShadow: "0 18px 50px rgba(0,0,0,0.45)" }}
    >
      <ProcTreeApp />
    </div>
  );
}

/** Register dock zones/defaults + auto-dock once (entry calls this). */
export function initProcTreeDock(): void {
  const zone = sidebarZoneOf(PT_KEY);
  declareDockZones(PT_KEY, [zone], zone);
  seedDockDefault(PT_KEY, zone);
  seedBlockCollapsedDefault(PT_KEY, true);
}
