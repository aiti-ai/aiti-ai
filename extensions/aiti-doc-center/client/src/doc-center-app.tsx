/**
 * doc-center-app.tsx —— 📚文档中心 弹窗（JSX 版，方案 §7）
 *
 * 三栏：tag 树（🏷/📁 视图）｜文档列表（搜索 snippet 高亮/融合分排序/分页）｜详情侧栏
 * 响应式（容器实测 ≤700px，ResizeObserver）：收起左栏（tag 云/树），搜索行「🏷 标签」按钮弹出
 * 同款过滤层（tag 云 + 树）；宽容器无独立标签条——已选 chips 并入左栏顶部，省一行高度。
 * 四视图：🏷 tags / 📁 目录 / 🕒 时间 / 🧵 session（M3）
 * SSE：scan 进度 + 索引变更自动刷新（零轮询）。
 * 状态徽标：方案/评审中|已实施|已过时（§2.2，静态层 front-matter）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, appendText, openFile, extSvc } from "./host-shim";
import { buildAtText, openNewSessionWithExtSvc } from "../../../_shared/new-session-cwd";
import { usePresent, useGate, DockBody, openFloat, closePanel } from "../../../_shared/ext-float-dock";

const API = (p: string) => apiUrl("/api/extensions/aiti-doc-center" + p);

// ---------- icons（lucide 线条风格） ----------
const ICONS: Record<string, string[]> = {
  book: ["M12 7v14", "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"],
  search: ["m21 21-4.3-4.3", "circle:11,11,8"],
  refresh: ["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M3 21v-5h5"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  chevR: ["m9 18 6-6-6-6"],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z", "M14 2v4a2 2 0 0 0 2 2h4"],
  copy: ["rect:9,9,13,13,2,2", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  open: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
};
function Ic({ size, paths, style }: { size: number; paths: string[]; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden style={style}>
      {paths.map((d, i) => d.startsWith("circle:")
        ? (() => { const [, cx, cy, r] = d.split(/[:;,]/).map(Number); return <circle key={i} cx={cx} cy={cy} r={r} />; })()
        : d.startsWith("rect:")
          ? (() => { const [, x, y, w, h, rx, ry] = d.split(/[:;,]/).map(Number); return <rect key={i} x={x} y={y} width={w} height={h} rx={rx} ry={ry} />; })()
          : <path key={i} d={d} />)}
    </svg>
  );
}

// ---------- 小工具 ----------
function fmtSize(n?: number): string {
  if (!n && n !== 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
function fmtDay(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function monthKey(ts?: number): string {
  if (!ts) return "?";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function relTime(ts?: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60e3) return Math.max(1, Math.round(diff / 1e3)) + "s";
  if (diff < 3600e3) return Math.round(diff / 60e3) + "m";
  if (diff < 86400e3) return Math.round(diff / 86400e3) + "h";
  return Math.round(diff / 86400e3) + "d";
}
const SOURCE_TIER: Record<string, number> = { frontmatter: 0, ui: 0, db: 0, plan: 1, inline: 2, session: 3, path: 4 };
function sortTags<T extends { source?: string }>(tags: T[] | undefined): T[] {
  return (tags ?? []).slice().sort((a, b) => (SOURCE_TIER[a.source ?? "path"] ?? 4) - (SOURCE_TIER[b.source ?? "path"] ?? 4));
}
const SOURCE_COLORS: Record<string, string> = {
  frontmatter: "var(--ok, #10b981)", inline: "#a78bfa", path: "#64748b", ui: "#3b82f6", db: "var(--warn, #f59e0b)", plan: "var(--warn, #f59e0b)", session: "#06b6d4",
};
const chipStyle = (color: string): React.CSSProperties => ({
  fontSize: 10, padding: "1px 6px", borderRadius: 5, cursor: "pointer",
  background: color + "22", color, border: "none", whiteSpace: "nowrap", flexShrink: 0,
});

/** snippet 高亮：按 <mark> 标记拆成文本节点（禁 dangerouslySetInnerHTML，§5 安全）。 */
function Snippet({ text }: { text?: string }) {
  if (!text) return null as any;
  const parts: any[] = [];
  let hl = false;
  let k = 0;
  for (const seg of text.split(/(<\/?mark>)/)) {
    if (seg === "<mark>") { hl = true; continue; }
    if (seg === "</mark>") { hl = false; continue; }
    if (!seg) continue;
    parts.push(hl
      ? <mark key={k++} style={{ background: "rgba(250,204,21,.4)", color: "inherit", borderRadius: 2, padding: "0 1px" }}>{seg}</mark>
      : <span key={k++}>{seg}</span>);
  }
  return <>{parts}</>;
}

/** 方案状态（§2.2）：返回 [后缀, 徽标文案, 颜色]；未标注返回 null。 */
function planStatusOf(tags: { key: string }[], planTag: string): [string, string, string] | null {
  for (const t of tags ?? []) {
    if (t.key === planTag + "/已实施") return ["已实施", "已实施", "var(--ok, #10b981)"];
    if (t.key === planTag + "/评审中") return ["评审中", "评审中", "var(--warn, #f59e0b)"];
    if (t.key === planTag + "/已过时") return ["已过时", "已过时", "#8a8a8a"];
  }
  return null;
}

// ---------- 详情操作（@ 引用 / @到新会话 / 打开） ----------
/** 文档绝对路径（root + relpath，去 root 尾斜杠）。 */
function docAbs(doc: { root?: string; relpath?: string }): string {
  return String(doc.root || "").replace(/\/+$/, "") + "/" + doc.relpath;
}
/** @ 提及文本：会话 cwd 下取相对路径（与 pi-web handleAtMention 同格式），跨 workspace 回退绝对路径；
 *  引用格式（空格加引号）与宿主 buildAtMentionText / _shared buildAtText 同源。 */
function docAtText(doc: { root?: string; relpath?: string; title?: string }): string {
  const abs = docAbs(doc);
  const cwd = String((window as any).__piWebCwd || "");
  const shown = cwd && abs.startsWith(cwd) ? abs.slice(cwd.length).replace(/^[/\\]+/, "") : abs;
  // 提及 token 本身须保持纯路径（宿主 @ 解析约定），标题以《》放在 @ 前
  const mention = buildAtText(shown);
  return doc.title ? `《${doc.title}》${mention}` : mention;
}

// ---------- tag 树面板（🏷/📁 共用；📁 模式点击走 dir 过滤） ----------
interface TagNode { key: string; display: string; count: number; children: TagNode[]; src?: string }
function TagTreePanel({ tree, pickedSet, onPick, planTag, dirMode, onRename }: {
  tree: TagNode[]; pickedSet: Set<string>; onPick: (key: string) => void; planTag: string; dirMode: boolean;
  onRename?: (key: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const isPlan = (k: string) => k === planTag || k.startsWith(planTag + "/");
  // 方案分组置顶（不受 tier 排序影响）
  const planNodes = tree.filter((n) => isPlan(n.key));
  const restNodes = tree.filter((n) => !isPlan(n.key));
  const render = (ns: TagNode[], depth: number): any =>
    ns.map((n) => {
      const open = !collapsed.has(n.key);
      const selected = pickedSet.has(n.key);
      const plan = isPlan(n.key);
      const sessionSrc = n.src === "session";
      const color = plan ? "var(--warn, #f59e0b)" : sessionSrc ? "#06b6d4" : selected ? "var(--text)" : "var(--text-muted)";
      return (
        <div key={n.key}>
          <div onClick={() => onPick(dirMode ? n.key : selected ? "" : n.key)}
            title={sessionSrc ? "来自 All Sessions 会话标签继承" : plan ? "方案（plan-first 绑定派生）" : undefined}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", marginLeft: depth * 10, borderRadius: 6,
              cursor: "pointer", background: selected ? "rgba(99,102,241,.14)" : "transparent",
              color, fontWeight: plan && depth === 0 ? 700 : 400 }}>
            {n.children.length > 0
              ? <span onClick={(e) => { e.stopPropagation(); setCollapsed((s) => { const c = new Set(s); if (c.has(n.key)) c.delete(n.key); else c.add(n.key); return c; }); }}
                  style={{ display: "inline-flex", flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}>
                  <Ic size={11} paths={ICONS.chevR} /></span>
              : <span style={{ width: 11, flexShrink: 0 }} />}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {depth === 0 && plan ? "◫ " : sessionSrc ? "◎ " : ""}{dirMode ? n.key : n.display}
            </span>
            <span style={{ marginLeft: "auto", fontSize: 10, opacity: 0.7, flexShrink: 0 }}>{n.count}</span>
            {!dirMode && onRename && (
              <span onClick={(e) => { e.stopPropagation(); onRename(n.key); }}
                title="重命名 tag（子 tag 一并迁移；文件 front-matter 同步改写）"
                style={{ flexShrink: 0, fontSize: 10, opacity: 0.45, cursor: "pointer", padding: "0 2px" }}>✎</span>
            )}
          </div>
          {open && n.children.length > 0 && render(n.children, depth + 1)}
        </div>
      );
    });
  return <div style={{ fontSize: 12 }}>{render(planNodes, 0)}{render(restNodes, 0)}</div>;
}

// ---------- tag 云（点击过滤；宽容器嵌左栏、窄容器进弹出层，query 过滤共用） ----------
function TagCloud({ tags, pickedSet, onToggle, query, limit = 32 }: {
  tags: any[]; pickedSet: Set<string>; onToggle: (k: string) => void; query?: string; limit?: number;
}) {
  const shown = tags
    .filter((f: any) => !query || f.key.includes(query.toLowerCase()) || f.display.includes(query))
    .slice(0, limit);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 7px" }}>
      {shown.map((f: any) => {
        const on = pickedSet.has(f.key);
        const size = 10 + Math.min(7, Math.round(Math.sqrt(f.count) / 1.6));
        const color = on ? "#6366f1" : f.src === "plan" ? "var(--warn, #f59e0b)" : f.src === "session" ? "#06b6d4" : "var(--text)";
        return (
          <span key={f.key} title={f.key + " · " + f.count + " 篇"} onClick={() => onToggle(f.key)}
            style={{ fontSize: size, lineHeight: 1.35, cursor: "pointer", color,
              fontWeight: on ? 700 : Math.round(Math.sqrt(f.count)) > 8 ? 600 : 400, opacity: on ? 1 : 0.85 }}>
            #{f.display}
          </span>
        );
      })}
    </div>
  );
}

// ---------- 主弹窗 ----------
function DocCenterDialog({ onClose, initialUnder, embedded }: { onClose: () => void; initialUnder?: string; embedded?: boolean }) {
  type View = "tags" | "dir" | "time" | "session";
  const [under, setUnder] = useState(() => {
    try { return localStorage.getItem("aiti-doc-center:ws-under") || initialUnder || ""; } catch { return initialUnder || ""; }
  }); // workspace 过滤：上次选择优先，否则当前会话 workspace
  const [wsOpen, setWsOpen] = useState(false);
  const [wsRect, setWsRect] = useState<{ left: number; top: number } | null>(null);
  const wsRef = useRef<HTMLSpanElement | null>(null);
  const pickUnder = (p: string) => {
    setUnder(p);
    try { localStorage.setItem("aiti-doc-center:ws-under", p); } catch { /* ignore */ }
  };
  const [view, setView] = useState<View>("tags");
  const [q, setQ] = useState("");
  const [qLive, setQLive] = useState("");
  const [tagSel, setTagSel] = useState<string[]>([]); // 多选 tag（AND 过滤）
  const [tagSelOpen, setTagSelOpen] = useState(false);
  const [tagSelRect, setTagSelRect] = useState<{ left: number; top: number } | null>(null);
  const tagSelRef = useRef<HTMLSpanElement | null>(null);
  const [tagSelQuery, setTagSelQuery] = useState("");
  // 窄容器按弹窗实际宽度判定（浮窗/右栏停靠/embedded 通用；初值用窗口宽兜底，挂载后 ResizeObserver 实测）
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 700);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [dirFilter, setDirFilter] = useState("");
  const [sort, setSort] = useState("smart"); // 默认综合（时间×引用×方案加权，docs/aiti-doc-center-smart-ranking-plan.md）
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [tree, setTree] = useState<TagNode[]>([]);
  const [planTag, setPlanTag] = useState("方案");
  const [sel, setSel] = useState<any>(null); // 详情
  const [scanP, setScanP] = useState<{ running: boolean; done: number; total: number } | null>(null);
  const [stats, setStats] = useState<any>(null);
  const limit = 60;
  const liveRef = useRef(true);

  const [flatTags, setFlatTags] = useState<any[]>([]);
  const refreshTags = useCallback(async () => {
    try {
      const d = await fetch(API("/tags" + (under ? "?under=" + encodeURIComponent(under) : ""))).then((r) => r.json());
      if (!liveRef.current) return;
      setTree(d.tree || []);
      setFlatTags(d.tags || []);
      if (d.planTag) setPlanTag(d.planTag);
    } catch { /* ignore */ }
  }, [under]);
  // M5：tag 批量重命名（文件 front-matter 同步改写；inline/path 来源仅迁 DB）
  // ⚠ fetchPage 必须声明在本 useCallback 之前：deps 数组渲染期读 fetchPage，
  //   声明在后会 TDZ 崩溃（Cannot access 'fetchPage' before initialization）。
  const fetchPage = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ limit: String(limit), offset: String(offset), sort });
      if (q.trim()) { p.set("q", q.trim()); p.set("snippet", "1"); }
      for (const tg of tagSel) p.append("tag", tg);
      if (dirFilter) p.set("dir", dirFilter);
      if (under) p.set("under", under);
      const d = await fetch(API("/docs?" + p.toString())).then((r) => r.json());
      if (!liveRef.current) return;
      setTotal(d.total || 0);
      setItems((prev) => (append ? prev.concat(d.items || []) : d.items || []));
    } catch { if (liveRef.current) setItems([]); }
    finally { if (liveRef.current) setLoading(false); }
  }, [q, tagSel, dirFilter, sort, under]);
  const renameTag = useCallback(async (key: string) => {
    const nk = window.prompt("重命名 tag（子 tag 一并迁移；front-matter 来源同步改写文件）", key);
    if (!nk || nk === key) return;
    try {
      const d = await fetch(API("/tags/rename"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, newKey: nk }) }).then((r) => r.json());
      if (d?.ok) { void refreshTags(); void fetchPage(0, false); }
      else window.alert("重命名失败：" + ((d && d.error) || "?"));
    } catch (e: any) { window.alert("重命名失败：" + (e.message || e)); }
  }, [refreshTags, fetchPage]);
  // M5：标签清单导出（markdown 下载）
  const exportTags = useCallback(() => {
    fetch(API("/tags/export" + (under ? "?under=" + encodeURIComponent(under) : "")))
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "doc-tags.md"; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      })
      .catch(() => {});
  }, [under]);

  // 搜索防抖（350ms）
  useEffect(() => {
    const t = setTimeout(() => setQ(qLive), 350);
    return () => clearTimeout(t);
  }, [qLive]);
  useEffect(() => { liveRef.current = true; return () => { liveRef.current = false; }; }, []);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof (window as any).ResizeObserver !== "function") {
      const on = () => setNarrow(window.innerWidth <= 700); // 无 RO 环境兜底：按窗口宽
      window.addEventListener("resize", on);
      return () => window.removeEventListener("resize", on);
    }
    const ro = new ResizeObserver((es) => { for (const en of es) setNarrow((en.contentRect.width || 0) <= 700); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { fetchPage(0, false); }, [q, tagSel, dirFilter, sort, fetchPage]);
  useEffect(() => { refreshTags(); }, [refreshTags]);

  // workspace / 标签下拉：外点关闭（均渲染在弹窗外的 fixed 层）
  useEffect(() => {
    if (!wsOpen && !tagSelOpen) return;
    const close = (e: MouseEvent) => {
      const tg = e.target as Element | null;
      if (wsRef.current?.contains(tg)) return;
      if (tagSelRef.current?.contains(tg)) return;
      if (tg?.closest?.("[data-ws-dropdown]") || tg?.closest?.("[data-tag-sel-dropdown]")) return;
      setWsOpen(false); setTagSelOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [wsOpen, tagSelOpen]);

  // stats + SSE（零轮询：scan/索引事件才刷新）
  useEffect(() => {
    fetch(API("/stats")).then((r) => r.json()).then((d) => { if (liveRef.current) setStats(d); }).catch(() => {});
    let es: EventSource | null = null;
    try { es = new EventSource(API("/events")); } catch { /* ignore */ }
    if (es) es.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "scan-start") setScanP({ running: true, done: 0, total: m.total || 0 });
        else if (m.type === "scan-progress") setScanP({ running: true, done: m.done || 0, total: m.total || 0 });
        else if (m.type === "scan-done") {
          setScanP(null);
          fetchPage(0, false); refreshTags();
          fetch(API("/stats")).then((r) => r.json()).then((d2) => { if (liveRef.current) setStats(d2); }).catch(() => {});
        } else if (m.type === "doc-updated" || m.type === "graph-updated") {
          fetchPage(0, false); refreshTags();
        }
      } catch { /* 非 JSON */ }
    };
    return () => { try { es?.close(); } catch { /* ignore */ } };
  }, [fetchPage, refreshTags]);

  const openDetail = async (id: number) => {
    try {
      const d = await fetch(API("/docs/" + id)).then((r) => r.json());
      if (liveRef.current) setSel(d.doc || null);
    } catch { /* ignore */ }
  };
  // —— 详情操作：@ 引用 / @到新会话 / 打开（宿主公共接口 + pi-web:new-session 通道）——
  const atCurrent = (doc: any) => { appendText(docAtText(doc)); };
  const atNewSession = async (doc: any) => {
    // 文档 workspace：root 是扫描根容器（如 ~/workspace），真实项目目录取第一级；
    // 口径与 /workspaces 候选一致
    const seg = String(doc.relpath || "").split("/")[0];
    const docWs = seg ? doc.root + "/" + seg : doc.root;
    // 不随便切目录：文档在当前 CWD 或其关注路径（aiti-git-trace watchPaths）范围内
    // → 保持当前 workspace；只在文档属于别的仓库时才切过去。能力收口
    // session-manager.mention 服务（缺失降级 _shared 同源实现）——判定同 editor/folder
    await openNewSessionWithExtSvc({
      text: docAtText(doc), targetDir: docWs, targetPath: docAbs(doc), currentCwd: initialUnder, apiUrl, extSvc,
    });
    // 浮窗态：新会话在弹窗后面，收起露出；dock 态：保留文档中心页签（同 openDoc 口径）
    if (!embedded) onClose();
  };
  const openDoc = (doc: any) => {
    openFile(docAbs(doc), doc.title || String(doc.relpath || "").split("/").pop());
    // 浮窗态：文件标签页在弹窗后面，收起露出；dock 态（右侧页签）：文件页签在右栏新开，
    // 保留文档中心页签（closePanel 会把 dock tab 整个关掉，像被文档页签替换）
    if (!embedded) onClose();
  };
  // 打开会话：未归档 → pi-web:open-session { id }（AppShell SPA 内切换通道，与子代理舰队同款）；
  // 已归档 → sm:open-archived { id }（session-manager 归档查看器，只读）——归档会话 jsonl 已进
  // .pwarc 容器，宿主 /api/sessions 扫不到，原通道会静默失败。
  const openSessionById = (sid: string, archived?: boolean) => {
    try {
      if (archived) window.dispatchEvent(new CustomEvent("sm:open-archived", { detail: { id: sid } }));
      else window.dispatchEvent(new CustomEvent("pi-web:open-session", { detail: { id: sid } }));
    } catch { /* ignore */ }
    onClose(); // 目标界面（消息区/归档查看器）在弹窗后面：收起露出
  };
  const collect = async () => {
    try { await fetch(API("/scan"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch { /* ignore */ }
  };

  const secHead: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4, margin: "10px 0 4px" };
  const listRow: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 8, padding: "7px 10px", cursor: "pointer", background: "transparent" };
  const viewTabs: { id: View; label: string }[] = [
    { id: "tags", label: "tags" }, { id: "dir", label: "目录" }, { id: "time", label: "时间" }, { id: "session", label: "会话" },
  ];
  // workspace 过滤 + 收集控件（浮窗在标题栏、embedded 在搜索行复用同一份——v3.1 三层工具条收敛）
  const wsControls = (
    <>
      {/* workspace 过滤（自绘 WsMenu：当前会话 + 已选持久 + git-trace 追踪仓 + 其他有文档目录） */}
      <span ref={wsRef} style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
        <button onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const w = Math.min(320, window.innerWidth * 0.8);
          setWsRect({ left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)), top: r.bottom + 4 });
          setWsOpen((v) => !v);
        }}
          title={under ? "workspace：" + under + "（点击切换/移除已选）" : "workspace：全部（默认当前会话；点击选择并记忆）"}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 6, fontSize: 11.5,
            cursor: "pointer", border: "1px solid " + (under ? "#6366f1" : "var(--border)"),
            background: under ? "rgba(99,102,241,.14)" : "transparent", color: under ? "#6366f1" : "var(--text-muted)",
            maxWidth: 180, whiteSpace: "nowrap" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{under ? under.split("/").filter(Boolean).pop() : "全部"}</span>
        </button>
      </span>
      {scanP?.running && (
        <span style={{ fontSize: 11, color: "#3b82f6" }}>⟳ 收集中 {scanP.done}/{scanP.total}</span>
      )}
      <button onClick={collect} title="立即收集整理（增量扫描）"
        style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 6, fontSize: 11.5, cursor: "pointer", background: "#3b82f6", border: "1px solid var(--border)", color: "#fff", whiteSpace: "nowrap" }}>
        <Ic size={12} paths={ICONS.refresh} />收集
      </button>
    </>
  );

  return (
    <>
    {wsOpen && wsRect && (
      <div data-ws-dropdown style={{ position: "fixed", left: wsRect.left, top: wsRect.top, width: "min(340px,86vw)", zIndex: 2147483200 }}>
        <WsMenu currentCwd={initialUnder} under={under} onPick={pickUnder} onClose={() => setWsOpen(false)} />
      </div>
    )}
    {tagSelOpen && tagSelRect && (
      <div data-tag-sel-dropdown style={{ position: "fixed", left: tagSelRect.left, top: tagSelRect.top, width: "min(340px,86vw)", zIndex: 2147483200 }}>
        {/* 窄容器标签过滤层 = 左栏同款内容（tag 云 + 树）；过滤框吸顶 */}
        <div style={{ maxHeight: "min(60vh,460px)", overflowY: "auto", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.12)", overflowX: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--bg)", zIndex: 1 }}>
            <input value={tagSelQuery} onChange={(e) => setTagSelQuery(e.target.value)} placeholder="过滤标签…"
              style={{ flex: 1, minWidth: 0, boxSizing: "border-box", fontSize: 11.5, padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", outline: "none" }} />
            {tagSel.length > 0 && (
              <span onClick={() => setTagSel([])} title="清除全部已选标签" style={{ fontSize: 10.5, color: "#3b82f6", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>✕ 清除({tagSel.length})</span>
            )}
          </div>
          {flatTags.length > 0 && (
            <div style={{ padding: "6px 8px" }}>
              <TagCloud tags={flatTags} pickedSet={new Set(tagSel)} query={tagSelQuery}
                onToggle={(k) => setTagSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : s.concat(k)))} />
            </div>
          )}
          <div style={{ padding: "0 6px 6px", fontSize: 12 }}>
            <TagTreePanel tree={tree} pickedSet={view === "dir" ? new Set(dirFilter ? [dirFilter] : []) : new Set(tagSel)}
              onPick={(k) => (view === "dir"
                ? setDirFilter(dirFilter === k ? "" : k)
                : setTagSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : s.concat(k))))}
              planTag={planTag} dirMode={view === "dir"} />
          </div>
          {tree.length === 0 && flatTags.length === 0 && <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>暂无 tag</div>}
          {flatTags.length > 0 && tagSelQuery && !flatTags.some((f: any) => f.key.includes(tagSelQuery.toLowerCase()) || f.display.includes(tagSelQuery)) && (
            <div style={{ padding: 12, fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>无匹配标签</div>
          )}
        </div>
      </div>
    )}
    {/* data-ext-float-key：状态机 key（aiti-doc-center:docs）与框架包装层 data-ext-item（复合 id
        aiti-doc-center:aiti-doc-center-page）不同名——缺省时 aiti-float 的 ✕ 拦截器/停靠偏好/位置
        持久化全落到错误 key：点关闭 present 到从未 open 的 key，面板永远关不掉（2026-09-08 修复） */}
    <div ref={rootRef} data-ext-float={embedded ? undefined : "1"} {...(embedded ? {} : { "data-ext-float-key": DOCS_KEY, "data-ext-float-w": 1080, "data-ext-float-h": 680, "data-ext-float-full": "1", "data-ext-float-dock": "right-panel", "data-ext-float-dock-default": "right-panel" })}
      style={(embedded
        ? { position: "relative", inset: "auto", width: "100%", height: "100%", maxWidth: "none", maxHeight: "none",
            display: "flex", flexDirection: "column", overflow: "hidden",
            background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", border: "none",
            borderRadius: 0, boxShadow: "none", fontFamily: "inherit" }
        : { position: "fixed", right: 18, bottom: 70, width: 1080, maxWidth: "96vw", maxHeight: "84vh",
            display: "flex", flexDirection: "column", zIndex: 2147483101, overflow: "hidden",
            background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", border: "1px solid var(--border,#e0e0e0)",
            borderRadius: 16, boxShadow: "0 16px 64px rgba(0,0,0,.25)", fontFamily: "inherit" })}>

      {/* 标题栏（首子元素 = aiti-float 拖拽把手）；embedded（右栏停靠）不渲染——页签行已有
          ⇱/✕，标题与 tab 重复、内部 ✕ 会双关闭，WsMenu/收集 并入搜索行（v3.1 工具条收敛） */}
      {!embedded && (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", borderBottom: "1px solid var(--border)", background: "var(--bg-subtle,#f5f5f5)", flexShrink: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
          <Ic size={15} paths={ICONS.book} />文档中心
        </span>
        {stats && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{stats.docs} 篇 · {stats.tags} tags · {stats.links} 链接</span>}
        <span style={{ flex: 1 }} />
        {wsControls}
        <button onClick={onClose} aria-label="关闭" title="关闭 (ESC)"
          style={{ padding: "3px 6px", borderRadius: 6, cursor: "pointer", background: "transparent", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
          <Ic size={12} paths={ICONS.x} />
        </button>
      </div>
      )}

      {/* 搜索行；embedded 时尾部挂 workspace/收集控件（标题栏不渲染，见上） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 260px", minWidth: 180 }}>
          <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", display: "inline-flex" }}><Ic size={13} paths={ICONS.search} /></span>
          <input value={qLive} onChange={(e) => setQLive(e.target.value)} placeholder="搜索文件名/标题/正文/tag…（空格 = AND，文件名命中优先）"
            style={{ width: "100%", boxSizing: "border-box", padding: "5px 8px 5px 26px", borderRadius: 8, fontSize: 12.5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }} />
        </div>
        <div style={{ display: "flex", gap: 2, background: "var(--bg-subtle,#f5f5f5)", borderRadius: 8, padding: 2 }}>
          {viewTabs.map((v) => (
            <button key={v.id} onClick={() => setView(v.id)}
              style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11.5, cursor: "pointer",
                border: "none", background: view === v.id ? "var(--bg,#fff)" : "transparent",
                color: view === v.id ? "var(--text)" : "var(--text-muted)",
                boxShadow: view === v.id ? "0 1px 3px rgba(0,0,0,.12)" : "none" }}>
              {v.label}
            </button>
          ))}
        </div>
        {/* 窄容器：左栏收起，标签按钮弹出 tag 云过滤层（宽容器过滤入口在左栏） */}
        {narrow && (view === "tags" || view === "dir") && (
          <span ref={tagSelRef} style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
            <button onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const w = Math.min(340, window.innerWidth * 0.86);
              setTagSelRect({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), top: r.bottom + 4 });
              setTagSelOpen((v) => !v);
            }}
              title={view === "dir" ? "目录过滤（弹出）" : "标签过滤（弹出 tag 云）"}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 6, fontSize: 11.5,
                cursor: "pointer", border: "1px solid " + (view === "dir" ? (dirFilter ? "#6366f1" : "var(--border)") : (tagSel.length ? "#6366f1" : "var(--border)")),
                background: view === "dir" ? (dirFilter ? "rgba(99,102,241,.14)" : "transparent") : (tagSel.length ? "rgba(99,102,241,.14)" : "transparent"),
                color: view === "dir" ? (dirFilter ? "#6366f1" : "var(--text-muted)") : (tagSel.length ? "#6366f1" : "var(--text-muted)"),
                whiteSpace: "nowrap" }}>
              {view === "dir" ? "目录" : "标签"}{view === "dir" ? (dirFilter ? " (1)" : "") : (tagSel.length ? ` (${tagSel.length})` : "")} ▾
            </button>
          </span>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value)}
          style={{ padding: "4px 6px", borderRadius: 6, fontSize: 11.5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}>
          <option value="smart">综合</option>
          <option value="rel">相关度</option>
          <option value="mtime">更新时间</option>
          <option value="rank">权重</option>
          <option value="title">标题</option>
        </select>
        {embedded && wsControls}
      </div>

      {/* 三栏主体（宽容器：标签过滤入口在左栏顶部 chips + tag 云；窄容器：搜索行「🏷 标签」按钮弹出过滤层） */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* 左栏：tag 树 / 目录树（tags/dir 视图；窄容器隐藏，由搜索行按钮弹出层接管） */}
        {(view === "tags" || view === "dir") && !narrow && (
          <div style={{ width: 224, flexShrink: 0, borderRight: "1px solid var(--border)", overflowY: "auto", padding: "8px 6px" }}>
            {(tagSel.length > 0 || dirFilter) && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, padding: "2px 4px 6px", borderBottom: "1px solid var(--border)", marginBottom: 6 }}>
                {sortTags(tagSel.map((k) => ({ key: k, display: (flatTags.find((f) => f.key === k) || { display: k }).display, source: "ui" }))).map((t: any) => (
                  <span key={t.key} style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 5, background: "#6366f122", color: "#6366f1", display: "inline-flex", alignItems: "center", gap: 3, minWidth: 0 }}>
                    #{t.display}
                    <span onClick={() => setTagSel((s) => s.filter((x) => x !== t.key))} title="移除" style={{ cursor: "pointer", fontWeight: 700 }}>×</span>
                  </span>
                ))}
                {dirFilter && (
                  <span title={dirFilter} style={{ fontSize: 10.5, padding: "1px 6px", borderRadius: 5, background: "#6366f122", color: "#6366f1", display: "inline-flex", alignItems: "center", gap: 3, maxWidth: "100%", minWidth: 0 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dirFilter}</span>
                    <span onClick={() => setDirFilter("")} title="移除" style={{ cursor: "pointer", fontWeight: 700, flexShrink: 0 }}>×</span>
                  </span>
                )}
                <span onClick={() => { setTagSel([]); setDirFilter(""); }} title="清除全部过滤" style={{ fontSize: 10.5, color: "#3b82f6", cursor: "pointer", marginLeft: "auto", flexShrink: 0 }}>清除</span>
              </div>
            )}
            {view === "tags" && flatTags.length > 0 && (
              <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: 6, marginBottom: 6 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)", letterSpacing: 0.4, margin: "4px 4px 4px", display: "flex", alignItems: "center" }}>
                  <span style={{ flex: 1 }}>tag 云（点击过滤）</span>
                  <span onClick={exportTags} title="导出标签清单（markdown：标签→文档列表）" style={{ fontWeight: 400, cursor: "pointer", color: "#3b82f6" }}>⇩ 清单</span>
                </div>
                <div style={{ padding: "0 4px" }}>
                  <TagCloud tags={flatTags} pickedSet={new Set(tagSel)}
                    onToggle={(k) => setTagSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : s.concat(k)))} />
                </div>
              </div>
            )}
            <TagTreePanel tree={tree} pickedSet={view === "tags" ? new Set(tagSel) : new Set(dirFilter ? [dirFilter] : [])}
              onRename={view === "tags" ? renameTag : undefined}
              onPick={(k) => (view === "tags"
                ? setTagSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : s.concat(k)))
                : setDirFilter(dirFilter === k ? "" : k))}
              planTag={planTag} dirMode={view === "dir"} />
            {tree.length === 0 && flatTags.length === 0 && <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>暂无 tag</div>}
          </div>
        )}

        {/* 中栏：列表 */}
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "8px 10px" }}>
          {view === "session" ? (
            <SessionView onOpen={openDetail} onOpenSession={openSessionById} selectedId={sel?.id} />
          ) : view === "time" ? (
            <TimeView onOpen={openDetail} planTag={planTag} selectedId={sel?.id} />
          ) : (
            <>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
                {loading ? "加载中…" : `${total} 篇${q.trim() ? "（相关度=融合分：bm25+权重）" : ""}`}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {items.map((it) => {
                  const st = planStatusOf(it.tags, planTag);
                  return (
                    <div key={it.id} onClick={() => openDetail(it.id)}
                      style={{ ...listRow, borderColor: sel?.id === it.id ? "#6366f1" : "var(--border)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {st && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 5, background: st[2] + "22", color: st[2], flexShrink: 0 }}>{st[1]}</span>}
                        <span style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</span>
                        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-muted)", flexShrink: 0 }}>{fmtDay(it.mtimeMs)} · {relTime(it.mtimeMs)}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, overflow: "hidden" }}>
                        <span style={{ fontSize: 10.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>{it.relpath}</span>
                        {sortTags((it.tags || []).filter((t: any) => t.source !== "path")).slice(0, 4).map((t: any) => (
                          <span key={t.key} style={chipStyle(SOURCE_COLORS[t.source] || "#64748b")}>#{t.display}</span>
                        ))}
                      </div>
                      {it.snippet && (
                        <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 3, overflow: "hidden" }}>
                          <Snippet text={it.snippet} />
                        </div>
                      )}
                    </div>
                  );
                })}
                {items.length < total && (
                  <button onClick={() => fetchPage(items.length, true)} disabled={loading}
                    style={{ padding: 6, borderRadius: 8, cursor: "pointer", border: "1px dashed var(--border)", background: "transparent", color: "var(--text-muted)", fontSize: 12 }}>
                    {loading ? "加载中…" : `加载更多（${items.length}/${total}）`}
                  </button>
                )}
                {!loading && items.length === 0 && (
                  <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 12.5 }}>无匹配文档</div>
                )}
              </div>
            </>
          )}
        </div>

        {/* 右栏：详情 */}
        {sel && (
          <div style={{ width: 300, flexShrink: 0, borderLeft: "1px solid var(--border)", overflowY: "auto", padding: "10px 12px", fontSize: 12 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, flex: 1, minWidth: 0 }}>{sel.title}</div>
              <button onClick={() => setSel(null)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, flexShrink: 0 }}>
                <Ic size={13} paths={ICONS.x} />
              </button>
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 10.5, margin: "3px 0 8px", wordBreak: "break-all" }}>{sel.relpath}</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
              <button title="引用到当前会话输入框（@ 路径，不发送）" onClick={() => atCurrent(sel)}
                style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", borderRadius: 6, fontSize: 10.5, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)" }}>
                <span style={{ fontWeight: 700, fontSize: 11.5 }}>@</span>引用
              </button>
              <button title="新建会话并预填引用（文档在当前工作区/其关注路径内则保持当前 workspace，否则切到文档所在目录）" onClick={() => atNewSession(sel)}
                style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", borderRadius: 6, fontSize: 10.5, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)" }}>
                <span style={{ fontWeight: 700, fontSize: 11.5 }}>@</span>新会话
              </button>
              <button title="在右侧文件标签页打开" onClick={() => openDoc(sel)}
                style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", borderRadius: 6, fontSize: 10.5, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)" }}>
                <Ic size={11} paths={ICONS.open} />打开
              </button>
              <button title="复制绝对路径" onClick={() => { try { navigator.clipboard.writeText(sel.root + "/" + sel.relpath); } catch { /* ignore */ } }}
                style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", borderRadius: 6, fontSize: 10.5, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)" }}>
                <Ic size={11} paths={ICONS.copy} />路径
              </button>
              {(sel.sessions || []).length > 0 && (
                <button title={(sel.sessions[0].archived ? "打开创建/触达此文档的会话（已归档：在 All Sessions 归档查看器打开）" : "打开创建/触达此文档的会话（最近：" + (sel.sessions[0].name || String(sel.sessions[0].session_id).slice(0, 8)) + (sel.sessions.length > 1 ? "，共 " + sel.sessions.length + " 个，见下方关联会话）" : "）"))}
                  onClick={() => openSessionById(String(sel.sessions[0].session_id), !!sel.sessions[0].archived)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 8px", borderRadius: 6, fontSize: 10.5, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)" }}>
                  <Ic size={11} paths={ICONS.chat} />{sel.sessions[0].archived ? "会话" : "会话"}
                </button>
              )}
            </div>
            {/* [P1-5 状态 tag 自检] 方案/* 生命周期 tag 应有且仅有一个；>1 → 一键修复
                （保留第一个，其余经 PUT /docs/<id>/tags remove 写回 front-matter；
                正文内联 #tag 形态的重复需手动删——writeTagsToPath 只改 front-matter） */}
            {(() => {
              const st = [...new Set((sel.tags || []).map((t: any) => String(t.key ?? "")).filter((k) => k.startsWith("方案/")))];
              if (st.length <= 1) return null;
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, padding: "5px 8px", border: "1px solid color-mix(in srgb, var(--warn, #f59e0b) 40%, transparent)", background: "color-mix(in srgb, var(--warn, #f59e0b) 8%, transparent)", borderRadius: 6, fontSize: 11 }}>
                  <span style={{ color: "#f59e09", minWidth: 0 }}>⚠ {st.length} 个 方案/* 状态 tag（{st.join("、")}）</span>
                  <button title={"保留「" + st[0] + "」，移除 " + st.slice(1).join("、") + "（写回 front-matter；正文内联 #tag 需手动删）"}
                    onClick={async () => {
                      try {
                        await fetch(API("/docs/" + sel.id + "/tags"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ remove: st.slice(1) }) });
                        const d = await fetch(API("/docs/" + sel.id)).then((r: any) => r.json());
                        if (liveRef.current) setSel(d.doc || null);
                      } catch { /* ignore */ }
                    }}
                    style={{ marginLeft: "auto", flexShrink: 0, padding: "2px 8px", borderRadius: 6, fontSize: 10.5, fontWeight: 700, cursor: "pointer", border: "1px solid color-mix(in srgb, var(--warn, #f59e0b) 50%, transparent)", background: "transparent", color: "#f59e09" }}>
                    一键修复
                  </button>
                </div>
              );
            })()}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
              {sortTags(sel.tags).map((t: any) => (
                <span key={t.source + t.key} title={"来源: " + t.source} style={chipStyle(SOURCE_COLORS[t.source] || "#64748b")}>
                  #{t.display}
                </span>
              ))}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
              更新 {fmtDay(sel.mtimeMs)} · {fmtSize(sel.size)} · {sel.wordCount ?? 0} 字符 · 权重 {(sel.rankNorm ?? 0).toFixed(3)}
            </div>

            {(sel.headings || []).length > 0 && (
              <>
                <div style={secHead}>大纲</div>
                {(sel.headings as any[]).map((h, i) => (
                  <div key={i} style={{ paddingLeft: (h.level - 1) * 10, fontSize: 11.5, padding: "1.5px 0", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {h.level === 1 ? "▎" : h.level === 2 ? "▪" : "·"} {h.text}
                  </div>
                ))}
              </>
            )}
            {(sel.outlinks || []).length > 0 && (
              <>
                <div style={secHead}>引用 ({sel.outlinks.length})</div>
                {(sel.outlinks as any[]).slice(0, 12).map((o, i) => (
                  <div key={i} onClick={() => openDetail(o.id)} style={{ fontSize: 11, cursor: "pointer", color: "#3b82f6", padding: "1.5px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <Ic size={10} paths={ICONS.link} style={{ verticalAlign: -1, marginRight: 3 }} />{o.title || o.relpath}
                  </div>
                ))}
              </>
            )}
            {(sel.backlinks || []).length > 0 && (
              <>
                <div style={secHead}>被引用 ({sel.backlinks.length})</div>
                {(sel.backlinks as any[]).slice(0, 12).map((o, i) => (
                  <div key={i} onClick={() => openDetail(o.id)} style={{ fontSize: 11, cursor: "pointer", color: "#3b82f6", padding: "1.5px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <Ic size={10} paths={ICONS.link} style={{ verticalAlign: -1, marginRight: 3 }} />{o.title || o.relpath}
                  </div>
                ))}
              </>
            )}
            {(sel.sessions || []).length > 0 && (
              <>
                <div style={secHead}>关联会话</div>
                {(sel.sessions as any[]).slice(0, 8).map((s: any, i: number) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <div title={(s.name ? s.name + "\n" : "") + "session " + String(s.session_id) + (s.archived ? "（已归档：点击在 All Sessions 归档查看器打开）" : "")}
                      onClick={() => openSessionById(String(s.session_id), !!s.archived)}
                      style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: "#3b82f6", cursor: "pointer", padding: "1.5px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.archived ? <span style={{ fontSize: 10, marginRight: 3 }}>📦</span> : null}{s.name || String(s.session_id).slice(0, 8)}
                    </div>
                    <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{s.op_count} 次触达</span>
                    <span title="复制 session id" onClick={(e) => { e.stopPropagation(); try { navigator.clipboard.writeText(String(s.session_id)); } catch { /* ignore */ } }}
                      style={{ fontSize: 10, color: "#3b82f6", cursor: "pointer", flexShrink: 0, padding: "0 2px" }}>⧉</span>
                  </div>
                ))}
              </>
            )}
            {(sel.externals || []).length > 0 && (
              <>
                <div style={secHead}>外链/断链 ({sel.externals.length})</div>
                {(sel.externals as string[]).slice(0, 8).map((x, i) => (
                  <div key={i} style={{ fontSize: 10.5, color: "var(--text-muted)", opacity: 0.7, padding: "1px 0", wordBreak: "break-all" }}>{x}</div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
    </>
  );
}

/** 📁 workspace 菜单（自绘）：候选必须位于扫描根下。
 *  分组：全部 → 当前会话 → 已选（localStorage 持久）→ 🧲 git-trace 追踪仓库 → 其他有文档目录。
 *  选择即记忆进「已选」；默认过滤 = 上次选择，否则当前会话 workspace。 */
const WS_PIN_KEY = "aiti-doc-center:ws-pinned";
function wsPinnedLoad(): string[] {
  try { return JSON.parse(localStorage.getItem(WS_PIN_KEY) || "[]"); } catch { return []; }
}
function wsPinnedSave(list: string[]): void {
  try { localStorage.setItem(WS_PIN_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
function WsMenu({ currentCwd, under, onPick, onClose }: { currentCwd: string; under: string; onPick: (p: string) => void; onClose: () => void }) {
  const [list, setList] = useState<{ path: string; docs: number; tracked: boolean }[] | null>(null);
  const [pinned, setPinned] = useState<string[]>(wsPinnedLoad);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(API("/workspaces")).then((r) => r.json()).then((d) => { if (live) setList(d.workspaces || []); }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  const pick = (p: string) => {
    if (p) {
      const next = [p].concat(wsPinnedLoad().filter((x) => x !== p));
      setPinned(next); wsPinnedSave(next);
    }
    onPick(p); onClose();
  };
  const unpin = (p: string, e: any) => {
    e.stopPropagation();
    const next = pinned.filter((x) => x !== p);
    setPinned(next); wsPinnedSave(next);
    if (under === p) onPick(""); // 取消当前过滤目标
  };
  const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
  const tracked = (list ?? []).filter((w) => w.tracked && !pinned.includes(w.path) && w.path !== currentCwd);
  const others = (list ?? []).filter((w) => !w.tracked && !pinned.includes(w.path) && w.path !== currentCwd);
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "6px 10px", background: "transparent", border: "none", borderTop: "1px solid var(--border)", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11.5 };
  const secHead: React.CSSProperties = { fontSize: 10, fontWeight: 700, color: "var(--text-muted)", padding: "6px 10px 2px" };
  const row = (p: string, label: string, opts?: { docs?: number; tracked?: boolean; unpin?: boolean }) => (
    <div key={p} onClick={() => pick(p)} style={{ ...rowStyle, background: under === p ? "rgba(99,102,241,.14)" : "transparent" }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{under === p ? "✓ " : ""}{label}</span>
      {opts?.tracked ? <span title="aiti-git-trace 追踪动过的仓库" style={{ fontSize: 10, color: "var(--ok, #10b981)", flexShrink: 0 }}>🧲</span> : null}
      {typeof opts?.docs === "number" && opts.docs > 0 ? <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{opts.docs}</span> : null}
      {opts?.unpin ? <span onClick={(e) => unpin(p, e)} title="从已选移除" style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0, padding: "0 2px" }}>✕</span> : null}
    </div>
  );
  return (
    <div style={{ maxHeight: "min(60vh,480px)", overflowY: "auto", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.12)", overflowX: "hidden" }}>
      <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)", fontSize: 10.5, color: "var(--text-muted)" }}>
        workspace 过滤（默认当前会话；选择会记住）
      </div>
      {row("", "全部 workspace")}
      {currentCwd && row(currentCwd, "● 当前：" + base(currentCwd))}
      {pinned.length > 0 && <div style={secHead}>已选</div>}
      {pinned.map((p) => row(p, base(p), { unpin: true }))}
      {tracked.length > 0 && <div style={secHead}>git-trace 追踪仓库</div>}
      {tracked.slice(0, 12).map((w) => row(w.path, base(w.path), { docs: w.docs, tracked: true }))}
      {tracked.length > 12 && <div style={{ padding: "4px 10px", fontSize: 10.5, color: "var(--text-muted)" }}>…其余 {tracked.length - 12} 个（输入框过滤即将支持）</div>}
      {showAll ? others.map((w) => row(w.path, base(w.path), { docs: w.docs })).concat(
        <div key="less" onClick={() => setShowAll(false)} style={{ padding: "4px 10px", fontSize: 10.5, color: "#3b82f6", cursor: "pointer" }}>收起</div>
      ) : others.length > 0 ? (
        <div onClick={() => setShowAll(true)} style={{ padding: "4px 10px", fontSize: 10.5, color: "#3b82f6", cursor: "pointer" }}>显示其他有文档目录（{others.length}）…</div>
      ) : null}
      {list !== null && list.length === 0 && <div style={{ padding: 12, fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>暂无候选（收集后出现）</div>}
    </div>
  );
}

/** 🧵 会话视图：行 = All Sessions 左列表同款信息（名称/运行中/收藏/标签），点开看该会话触达的文档；↗ 直接打开会话。 */
function SessionView({ onOpen, onOpenSession, selectedId }: { onOpen: (id: number) => void; onOpenSession: (sid: string, archived?: boolean) => void; selectedId?: number }) {
  const [sessions, setSessions] = useState<any[] | null>(null);
  const [openSid, setOpenSid] = useState("");
  const [docs, setDocs] = useState<any[]>([]);
  // aiti-plan-first 绑定标：绑定方案的会话行显示 📋（数据=plan-first bindings 出口）
  const [planBindings, setPlanBindings] = useState<Record<string, { planRel?: string }>>({});
  useEffect(() => {
    fetch(apiUrl("/api/extensions/aiti-plan-first/bindings")).then((r) => r.json()).then((d) => { if (d?.ok) setPlanBindings(d.bindings ?? {}); }).catch(() => {});
  }, []);
  useEffect(() => {
    let live = true;
    fetch(API("/sessions-view")).then((r) => r.json()).then((d) => { if (live) setSessions(d.sessions || []); }).catch(() => { if (live) setSessions([]); });
    return () => { live = false; };
  }, []);
  const openSession = async (sid: string) => {
    if (openSid === sid) { setOpenSid(""); return; }
    setOpenSid(sid);
    try {
      const d = await fetch(API("/sessions/" + encodeURIComponent(sid) + "/docs")).then((r) => r.json());
      setDocs(d.docs || []);
    } catch { setDocs([]); }
  };
  if (sessions === null) return <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 12.5 }}>加载中…</div>;
  if (!sessions.length) return (
    <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 12.5 }}>
      暂无会话关联——数据来自 aiti-git-trace 台账回填（每轮扫描有界补 3 个会话），AI 会话写过的文档会逐步出现
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>点击会话查看它触达的文档；↗ 直接打开会话</div>
      {sessions.map((s: any) => (
        <div key={s.sid}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 6, border: "1px solid " + (openSid === s.sid ? "#6366f1" : "var(--border)"), opacity: s.live ? 1 : 0.6 }}>
            <span onClick={() => openSession(s.sid)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
              <Ic size={11} paths={ICONS.chevR} style={{ flexShrink: 0, transform: openSid === s.sid ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
              <span title={s.running ? "运行中" : "空闲"} style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: s.running ? "var(--ok, #10b981)" : "var(--text-muted)", boxShadow: s.running ? "0 0 4px var(--ok, #10b981)" : "none" }} />
              {s.favorite ? <span title="收藏" style={{ flexShrink: 0, fontSize: 11 }}>⭐</span> : null}
              {planBindings[s.sid] ? (
                <span title={"方案先行：已绑定 " + (planBindings[s.sid].planRel || "")} style={{ flexShrink: 0, fontSize: 10, color: "#3fb950", border: "1px solid #3fb95055", borderRadius: 4, padding: "0 4px", lineHeight: 1.5 }}>📋</span>
              ) : null}
              <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.sid + (s.archived ? "（已归档：消息区不可打开，↗ 在归档查看器打开）" : s.live ? "" : "（历史）")}>
                {s.name}
                {s.archived ? <span style={{ color: "#8b5cf6", fontSize: 10 }}>（归档）</span> : !s.live ? <span style={{ color: "var(--text-muted)", fontSize: 10 }}>（历史）</span> : null}
              </span>
            </span>
            <span style={{ display: "flex", gap: 3, flexShrink: 0, overflow: "hidden" }}>
              <span title={s.archived ? "已归档：在 All Sessions 归档查看器打开" : "打开此会话"} onClick={() => onOpenSession(s.sid, !!s.archived)}
                style={{ fontSize: 10, color: s.archived ? "#8b5cf6" : "#3b82f6", cursor: "pointer", flexShrink: 0 }}>{s.archived ? "📦" : "↗"}</span>
              {(s.tags || []).slice(0, 3).map((t: string) => (
                <span key={t} style={{ fontSize: 9.5, padding: "0 5px", borderRadius: 4, background: "rgba(6,182,212,.14)", color: "#06b6d4", whiteSpace: "nowrap" }}>#{t}</span>
              ))}
            </span>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", flexShrink: 0 }}>{s.docs} 篇</span>
            <span title="点击复制会话 id（去 All Sessions 面板打开）" onClick={() => { try { navigator.clipboard.writeText(s.sid); } catch { /* ignore */ } }}
              style={{ fontSize: 10, color: "#3b82f6", cursor: "pointer", flexShrink: 0 }}>⧉</span>
          </div>
          {openSid === s.sid && (
            <div style={{ marginLeft: 16, borderLeft: "2px solid var(--border)", paddingLeft: 8, marginTop: 3, display: "flex", flexDirection: "column", gap: 3 }}>
              {docs.map((d: any) => (
                <div key={d.id} onClick={() => onOpen(d.id)}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 6px", borderRadius: 5, cursor: "pointer",
                    border: "1px solid " + (selectedId === d.id ? "#6366f1" : "transparent") }}>
                  <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title || d.relpath}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{d.opCount} 次触达</span>
                </div>
              ))}
              {!docs.length && <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 4 }}>该会话触达的 md 均不在当前扫描根内</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 🕒 时间视图：按月分组（sort=mtime 拉近期 300 篇）。 */
function TimeView({ onOpen, planTag, selectedId }: { onOpen: (id: number) => void; planTag: string; selectedId?: number }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(API("/docs?sort=mtime&limit=300")).then((r) => r.json()).then((d) => { if (live) setItems(d.items || []); }).catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  if (loading) return <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 12.5 }}>加载中…</div>;
  const groups = new Map<string, any[]>();
  for (const it of items) {
    const k = monthKey(it.mtimeMs);
    const arr = groups.get(k) ?? [];
    arr.push(it);
    groups.set(k, arr);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {[...groups.entries()].map(([k, arr]) => (
        <div key={k}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)", margin: "4px 0 5px" }}>{k}（{arr.length}）</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {arr.map((it) => {
              const st = planStatusOf(it.tags, planTag);
              return (
                <div key={it.id} onClick={() => onOpen(it.id)}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 6, cursor: "pointer",
                    border: "1px solid " + (selectedId === it.id ? "#6366f1" : "var(--border)") }}>
                  {st && <span style={{ fontSize: 9.5, padding: "0 5px", borderRadius: 4, background: st[2] + "22", color: st[2], flexShrink: 0 }}>{st[1]}</span>}
                  <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{it.relpath.split("/").slice(0, 2).join("/")}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {items.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>暂无文档</div>}
    </div>
  );
}

/** pages 槽：监听打开事件（跨模块实例可靠——顶栏按钮挂载两份且各有模块实例）。 */
const DOCS_KEY = "aiti-doc-center:docs";
export function DocCenterPageSlot(props?: any) {
  // aiti-float dock v0.5.x 状态机单源（§3.4 模式①/②）：present() 取代私有 open 布尔。
  // embedded（rightFileDock face）：仅 docked 渲染、内嵌样式；页面 face：floating 渲染浮窗、docked 让位。
  const embedded = Boolean(props?.embedded);
  const state = usePresent(DOCS_KEY);
  const open = embedded ? state.startsWith("docked:") : state === "floating";
  useEffect(() => {
    const l = () => openFloat(DOCS_KEY);
    window.addEventListener("aiti-doc-center:open", l);
    return () => window.removeEventListener("aiti-doc-center:open", l);
  }, []);
  useEffect(() => {
    if (!open || embedded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closePanel(DOCS_KEY); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, embedded]);
  if (!open) return null;
  const initialUnder = String(props?.currentSession?.cwd || "");
  return <DocCenterDialog embedded={embedded} initialUnder={initialUnder} onClose={() => closePanel(DOCS_KEY)} />;
}

/** aiti-float dock v0.5.x：rightFileDock face——DocCenterDialog 内嵌实例（仅 docked 挂载）。 */
export function DockDocs() {
  const docked = useGate(DOCS_KEY, { dock: "right-panel" });
  if (!docked) return null;
  return (
    <DockBody itemKey={DOCS_KEY} zone="right-panel" title="文档" chrome="tab">
      <DocCenterPageSlot embedded />
    </DockBody>
  );
}
