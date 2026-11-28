/**
 * aiti-folder · 目录浏览器（fileViewer folder 接管）——自手写版迁移，一比一
 *
 * 完整对等原核心 FolderViewer：树行内展开、文件行→开文件、子文件夹行「打开」→开新 tab、
 * @mention、git 状态徽标 + 目录「含变更」点。工具栏：+ 菜单（新建/上传）、变更面板、刷新。
 * 开放点：window.__aitiFolder.registerAction（其他扩展注册目录级工具条按钮）。
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { apiUrl, t, getFileTabs, closeFileTabs, extSvc, extEnsureMaterialized, openFileDiff, openFile } from "./host-shim";
import { useDockCommands, useDockHeaderState, useDockHeaderMenuItems, writeBlockCollapsed, usePresent, closePanel } from "@aiti-ai/ext-shared/ext-float-dock";
import type { DockMenuItem } from "@aiti-ai/ext-shared/ext-float-dock";
import { lastSeg, normSlash, dirOf, relTo, relFromBase, joinPath, buildGitByPath, buildChangedDirs, fetchEntries, peekEntries, fetchList, peekList, recentProjects, displayCwd, buildSearchTree, invalidateEntries, groupContentMatches, type SearchTreeNode } from "./lib";
import { watchDir } from "./folder-watch";
import { GitBadge, FolderIcon, FileIcon, CaretIcon, CheckIcon, MiRefresh, MiExternal, MiPencil, MiMove, MiAt, MiInfo, MiDownload, MiUpload, MiTrash, MiFilePlus, MiFolderPlus, MiFolderUp, MiCopy, MiCopyTo, MiArrowUp, MiSearch, MiPin, MiPinOff, MiEyeOff, MiPlus, MiMinus, MiGitCompare, MiUndo, MiX, MiCloseLeft, MiCloseRight, MiCloseAll, MiFolderOpen, PlusIcon, TerminalIcon, ChangesIcon } from "./icons";
import { EXT_LANG, LANG_COLOR } from "./lib";
import { FolderSwitcher } from "./folder-switcher";
import { isFolderPinned, toggleFolderPin, folderItemKey, removeFolderInstance } from "./folder-dock";
import { DirectoryPicker } from "./directory-picker";
import { openViewerWindow } from "@aiti-ai/ext-shared/open-viewer-window";
import { clampToViewport, fixedOrigin, zoomFactorOf } from "@aiti-ai/ext-shared/popup-anchor";
import { buildAtText, openNewSessionWithExtSvc } from "@aiti-ai/ext-shared/new-session-cwd";
import { useFolderGit, GitBar, CommitDialog } from "./git-toolbar";
import type { FolderGit } from "./git-toolbar";
import { CommitPlanDialog } from "./git-plan";
import { BranchChipBadge, BranchPanel } from "@aiti-ai/ext-shared/git-ops-client/branch-panel";
import { createGitOpsApi } from "@aiti-ai/ext-shared/git-ops-client/api";
import { fetchNestedRepos, invalidateNestedRepos, nestedStatusRows, peekNestedRepos } from "./nested-git";
import { ct } from "./comp-i18n";

// DI 方案 P2：git-review 打开/聚焦（services 通道优先，旧全局兜底）
const grOpen = () => extSvc<(o?: any) => void>("aiti-git-review.open") || (window as any).__aitiGitReviewOpen;
const grWork = () => extSvc<() => void>("aiti-git-review.work") || (window as any).__aitiGitReviewWork;
/** 打开 Git Review（统一入口）：aiti-git-review 是懒加载扩展（immediately:false）——
 *  服务在其 client 加载后才注册；先经宿主 ensureMaterialized 物化（幂等），否则
 *  grOpen() 为 undefined 且 try/catch 静默 = 「点了没反应」（2026-11-24 用户实测修复）。 */
async function openGitReview(scope?: { kind: string; path: string }): Promise<void> {
  try { await extEnsureMaterialized("aiti-git-review"); } catch { /* 旧宿主无通道——继续旧全局兜底 */ }
  const open = grOpen();
  if (open) open(scope ? { scope } : undefined);
  try { grWork() && grWork(); } catch { /* noop */ }
}

// ── 存活缓存：切走再切回不丢状态（宿主切 tab 会卸载 viewer，这里快照 + TTL 恢复）──
// 展开状态按根目录存快照；存活期内切回秒开（目录列表另有 ENTRIES_TTL 缓存），过期自动失效。
export const FOLDER_STATE_TTL = 10 * 60 * 1000; // 10 分钟存活期
const expandedCache = new Map<string, { expanded: string[]; ts: number }>();
function saveExpandedSnapshot(rootPath: string, expanded: Set<string>) {
  const now = Date.now();
  for (const [k, v] of expandedCache) if (now - v.ts > FOLDER_STATE_TTL) expandedCache.delete(k);
  if (expanded.size === 0) return; // 空快照不覆盖旧记录（切根目录重置时误伤）
  expandedCache.set(normSlash(rootPath)!, { expanded: [...expanded], ts: now });
}
function loadExpandedSnapshot(rootPath?: string): Set<string> | null {
  if (!rootPath) return null;
  const hit = expandedCache.get(normSlash(rootPath)!);
  if (!hit || Date.now() - hit.ts > FOLDER_STATE_TTL) return null;
  return new Set(hit.expanded);
}

// ── tab 窗口管理（钉住/关闭族，对齐 aiti-editor ⋯ 菜单 5 条；作用域=folder tab，文件 tab 归 aiti-editor 管）──
// Pin definition is unified = manifest pin flag (localStorage pi:sidebar-dock:folders[@basePath] entry pin) —
// 左栏区块 / 右栏 dock tab / 浮窗三面同状态同展示（一个定义一个展示，用户拍板）；
// 旧式独立 fileViewer folder tab（不进清单）不再有独立内存钉住。
const folderTabId = (p: string) => "folder:" + p;

// 文件行图标：语言色点（无匹配扩展名时回退通用文件图标）
function NodeIcon({ name }: { name: string }) {
  const ext = (lastSeg(name)!.split(".").pop() || "").toLowerCase();
  const lang = EXT_LANG[ext]; const c = lang ? LANG_COLOR[lang] : null;
  return c
    ? <span style={{ width:6, height:6, borderRadius:2, background:c, flexShrink:0, display:"inline-block" }} />
    : <FileIcon />;
}

type TFn = (key: string, params?: Record<string, unknown>) => string;

// ── 工具栏图标按钮（同款 sidebar：变更/上传/刷新）──
function TBtn(o: { key?: string; onClick?: (e: any) => void; disabled?: boolean; title?: string; pressed?: boolean; bg?: string; color?: string; children: any }) {
  return (
    <button key={o.key} type="button" onClick={o.onClick} disabled={o.disabled} title={o.title} aria-pressed={o.pressed?"true":undefined}
      style={{ width:28, height:24, padding:0, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, border:"none", background:o.bg||"transparent", color:o.color||"var(--text-dim)", cursor:o.disabled?"default":"pointer", borderRadius:4, transition:"color 0.12s, background 0.12s" }}>
      {o.children}
    </button>
  );
}

// + 菜单项（下拉通用）
function menuItem(icon: any, label: any, onClick: () => void, key?: string) {
  return <button key={key} type="button" onClick={onClick} style={{ display:"flex", alignItems:"center", gap:7, width:"100%", padding:"5px 10px", border:"none", background:"transparent", color:"var(--text,#222)", cursor:"pointer", textAlign:"left", fontSize:12, borderRadius:6, whiteSpace:"nowrap" }}>{icon ? <span style={{ display:"inline-flex", flexShrink:0, width:13, justifyContent:"center" }}>{icon}</span> : null}{label}</button>;
}

// 菜单分区：分隔线 + 小节标题（10px 淡色，置于每组首项上方；行菜单/根菜单通用）
function menuSep(key: string) {
  return <div key={key} style={{ height:1, background:"var(--border,#eee)", margin:"2px 4px" }} />;
}
// ── 关闭图标排（2026-09-16 关闭族收编：左/自己/右/全部一排图标，markup 对齐 aiti-editor
//    FileToolbar ⋯ 菜单的 closeIconRow——名称左 + 图标右对齐，hover tooltip 兜底）──
function FolderCloseIconRow(props: { left?: () => void; self?: () => void; right?: () => void; all?: () => void; closeTab: () => void; batch: (scope: "left"|"right"|"all") => void; t: TFn }) {
  const { t } = props;
  const btn = (title: string, icon: any, fn: () => void, key: string) => (
    <button key={key} type="button" title={title} aria-label={title}
      onClick={fn}
      onMouseEnter={(e:any)=>{ e.currentTarget.style.background="var(--bg-hover,#f3f4f6)"; }}
      onMouseLeave={(e:any)=>{ e.currentTarget.style.background="transparent"; }}
      style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:28, height:28, padding:0, border:"none", borderRadius:6, background:"transparent", color:"var(--text-muted,#777)", cursor:"pointer", flexShrink:0 }}>{icon}</button>
  );
  return (
    <div data-ext-folder-close-row="1" style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:16, padding:"5px 10px" }}>
      <span style={{ fontSize:12, color:"var(--text-dim,#888)", flexShrink:0, userSelect:"none" }}>{t("i18n.close")}</span>
      <div style={{ display:"flex", gap:6, marginLeft:"auto", flexShrink:0 }}>
        {btn(t("files.closeLeft"), <MiCloseLeft size={16} />, () => props.batch("left"), "cl")}
        {btn(t("i18n.close"), <MiX size={16} />, props.closeTab, "ct")}
        {btn(t("files.closeRight"), <MiCloseRight size={16} />, () => props.batch("right"), "cr")}
        {btn(t("files.closeAll"), <MiCloseAll size={16} />, () => props.batch("all"), "ca")}
      </div>
    </div>
  );
}
// ── 图标排行（2026-11-24 菜单单行化，方案 docs/aiti-menu-single-row-plan.md）：
//    label 居左 + 28×28 线稿图标排居右，markup 对齐 FolderCloseIconRow / aiti-editor closeIconRow。
//    仅收录公众周知动作；hover 背景+字色双变（对齐 dock icons 行），tooltip+aria-label 兜底。
//    actions 构建侧负责条件过滤，行恒非空；onClick 是否关菜单由各动作保真契约决定（见方案 §5）。──
type MenuRowAction = { key: string; title: string; icon: any; onClick: () => void };
function menuActionRow(rowKey: string, label: string, actions: MenuRowAction[]) {
  const btn = (a: MenuRowAction) => (
    <button key={a.key} type="button" title={a.title} aria-label={a.title}
      onClick={(e) => { e.stopPropagation(); a.onClick(); }}
      onMouseEnter={(e:any)=>{ e.currentTarget.style.background="var(--bg-hover,#f3f4f6)"; e.currentTarget.style.color="var(--text,#222)"; }}
      onMouseLeave={(e:any)=>{ e.currentTarget.style.background="transparent"; e.currentTarget.style.color="var(--text-muted,#777)"; }}
      style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", width:22, height:22, padding:0, border:"none", borderRadius:5, background:"transparent", color:"var(--text-muted,#777)", cursor:"pointer", flexShrink:0 }}>{a.icon}</button>
  );
  return (
    <div key={rowKey} data-ext-folder-action-row="1" style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, padding:"3px 10px" }}>
      <span style={{ fontSize:12, color:"var(--text-dim,#888)", flexShrink:0, userSelect:"none" }}>{label}</span>
      <div style={{ display:"flex", gap:4, flexShrink:0 }}>{actions.map(btn)}</div>
    </div>
  );
}

// 剪贴板写文本：clipboard API 优先，execCommand 兜底（非安全上下文）
async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* 落 execCommand 兜底 */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand("copy"); } finally { ta.remove(); }
}

// ── 正文模式 snippet 高亮：doc-center 返回的 <mark>…</mark> 切分渲染为高亮 span，其余走 React 文本转义（零 innerHTML）──
function MarkedText({ text }: { text: string }) {
  const parts: any[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<span key={k++} style={{ background:"rgba(79,142,247,0.22)", borderRadius:2 }}>{m[1]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// ── Content-search line highlight: wraps query hits in highlight spans (case-insensitive split, zero innerHTML, MarkedText-style) ──
function HighlightedLine({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: any[] = [];
  let last = 0, k = 0, idx = lower.indexOf(needle);
  while (idx >= 0) {
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(<span key={k++} style={{ background:"rgba(79,142,247,0.22)", borderRadius:2 }}>{text.slice(idx, idx + needle.length)}</span>);
    last = idx + needle.length;
    idx = lower.indexOf(needle, last);
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// ── 文件/文件夹信息弹层（行菜单「文件信息」）：现拉 entry-info，展示名称/类型/大小/修改时间/条目数 ──
// 所在目录可点击：onOpenFolder 存在时点击打开对应目录（新开 folder tab）
function EntryInfoModal(props: { path: string; onClose: () => void; t: TFn; onOpenFolder?: (p: string, name?: string) => void }) {
  const { path, onClose, t: tt, onOpenFolder } = props;
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let c = false;
    fetch(apiUrl("/api/extensions/aiti-folder/entry-info"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ path }) })
      .then((r) => r.json()).then((d) => { if (!c) { if (d && d.ok) setInfo(d); else setErr((d && d.error) || "HTTP error"); } })
      .catch((e) => { if (!c) setErr(String(e)); });
    return () => { c = true; };
  }, [path]);
  const fmtSize = (n: any) => { if (n == null) return "—"; if (n < 1024) return n + " B"; const u = ["KB", "MB", "GB", "TB"]; let v = n / 1024, i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return v.toFixed(v >= 100 ? 0 : 1) + " " + u[i]; };
  const parentDir = path.slice(0, path.lastIndexOf("/")) || "/";
  const row = (k: string, v: any, mono?: boolean) => (
    <div key={k} style={{ display:"flex", gap:10, alignItems:"baseline" }}>
      <span style={{ width:64, flexShrink:0, color:"var(--text-dim,#888)" }}>{k}</span>
      <span style={{ flex:1, minWidth:0, wordBreak:"break-all", fontFamily: mono ? "var(--font-mono,ui-monospace,monospace)" : undefined }}>{v}</span>
    </div>
  );
  const rowDir = () => (
    <div key="dir" style={{ display:"flex", gap:10, alignItems:"baseline" }}>
      <span style={{ width:64, flexShrink:0, color:"var(--text-dim,#888)" }}>{tt("files.infoParent")}</span>
      {onOpenFolder ? (
        <button type="button" title={tt("files.infoOpenParent")} onClick={()=>{ onClose(); onOpenFolder(parentDir, lastSeg(parentDir) || undefined); }}
          style={{ flex:1, minWidth:0, wordBreak:"break-all", textAlign:"left", padding:0, border:"none", background:"transparent", cursor:"pointer",
            color:"var(--accent,#4f8ef7)", fontFamily:"var(--font-mono,ui-monospace,monospace)", textDecoration:"underline", textDecorationStyle:"dotted", textUnderlineOffset:3 }}>{parentDir}</button>
      ) : (
        <span style={{ flex:1, minWidth:0, wordBreak:"break-all", fontFamily:"var(--font-mono,ui-monospace,monospace)" }}>{parentDir}</span>
      )}
    </div>
  );
  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position:"fixed", inset:0, zIndex:500, background:"rgba(0,0,0,0.35)", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ width:400, maxWidth:"92vw", padding:"16px 18px", borderRadius:12, background:"var(--bg,#fff)", border:"1px solid var(--border,#ddd)", boxShadow:"0 12px 40px rgba(0,0,0,0.25)", fontSize:13 }}>
        <div style={{ fontWeight:600, fontSize:14, marginBottom:10 }}>{tt("files.entryInfo")}</div>
        {err ? <div style={{ color:"var(--danger, #f87171)", fontSize:12 }}>{err}</div>
        : !info ? <div style={{ color:"var(--text-dim,#888)", fontSize:12 }}>…</div>
        : (
          <div style={{ display:"flex", flexDirection:"column", gap:7, fontSize:12 }}>
            {row(tt("files.infoName"), info.name, true)}
            {row(tt("files.infoType"), info.isDir ? tt("files.infoTypeDir") : tt("files.infoTypeFile"))}
            {row(tt("files.infoSize"), fmtSize(info.size))}
            {row(tt("files.infoMtime"), info.mtimeMs ? new Date(info.mtimeMs).toLocaleString() : "—")}
            {rowDir()}
            {info.isDir && info.items != null ? row(tt("files.infoItems"), String(info.items)) : null}
          </div>
        )}
        <div style={{ display:"flex", justifyContent:"flex-end", marginTop:12 }}>
          <button type="button" onClick={onClose} style={{ ...createBtnStyle, background:"transparent", border:"1px solid var(--border,#d0d0d0)", color:"var(--text,#222)" }}>{tt("files.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
const createBtnStyle: Record<string, any> = { height:24, padding:"0 10px", borderRadius:5, cursor:"pointer", fontSize:12, fontWeight:600 };

// ── 移动/复制弹窗（两级选择：先 workspace，再目录）──
// mode="move"：POST /move（renameSync，源消失）；mode="copy"：POST /copy（cpSync，源保留）。
// 默认 workspace = 当前打开的 root（不切 cwd），直接选目录即可确认。目录浏览复用 /api/cwd/browse。
function TransferDialog(props: { path: string; cwd: string; root: string; mode?: "move" | "copy"; t: TFn; onClose: () => void; onMoved: (newPath?: string) => void }) {
  const { path, cwd, root, mode = "move", t: tt, onClose, onMoved } = props;
  const isCopy = mode === "copy";
  const srcName = lastSeg(path) || "";
  const [ws, setWs] = useState<string>(root);        // 当前 workspace（默认=当前打开的 root）
  const [wsList, setWsList] = useState<string[]>([]); // 已知 workspace（sessions 聚合）
  const [home, setHome] = useState("");
  const [wsOpen, setWsOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState(root);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<any>(null);
  const [pickCustom, setPickCustom] = useState(false);
  const loadBrowse = useCallback((target: string) => {
    setLoading(true); setError(null);
    fetch(apiUrl("/api/cwd/browse"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ path: target }) })
      .then(async r => { const d = await r.json(); if(!r.ok || d.error) throw new Error(d.error||("HTTP "+r.status)); setData(d); setBrowsePath(d.path); })
      .catch(e => setError(e&&e.message?e.message:String(e)))
      .finally(()=>setLoading(false));
  }, []);
  useEffect(()=>{
    fetch(apiUrl("/api/home")).then(r=>r.json()).then(d=>{ if(d.home) setHome(d.home); }).catch(()=>{});
    fetch(apiUrl("/api/sessions"),{cache:"no-store"}).then(r=>r.json()).then(d=>{
      const ps = recentProjects(d.sessions||[]).map((p:any)=>p.root).filter(Boolean);
      const seen = new Set<string>(); const list: string[] = [];
      for (const p of [root, ...ps]) { if (!seen.has(p)) { seen.add(p); list.push(p); } }
      setWsList(list);
    }).catch(()=>{});
    loadBrowse(root);
  }, []);
  const switchWs = (p: string) => { setWs(p); setWsOpen(false); loadBrowse(p); };
  const dirs = (data && data.directories) || []; const drives = data && data.drives;
  const doMove = async ()=>{
    if (busy || !browsePath) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(apiUrl(isCopy ? "/api/extensions/aiti-folder/copy" : "/api/extensions/aiti-folder/move"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ path, targetDir: browsePath }) });
      const d = await r.json().catch(()=>({}));
      if (!r.ok || !d.ok) setMsg({ err: d.error || ("HTTP "+r.status) });
      else { onMoved(d.path); onClose(); }
    } catch(e:any){ setMsg({ err: e&&e.message?e.message:String(e) }); }
    finally { setBusy(false); }
  };
  const rowStyle: Record<string, any> = { display:"flex", alignItems:"center", gap:8, width:"100%", padding:"0 12px", height:26, border:"none", background:"transparent", color:"var(--text)", cursor:"pointer", textAlign:"left", fontSize:12 };
  return (
    <div onClick={(e)=>{ if(e.target===e.currentTarget && !busy) onClose(); }} style={{ position:"fixed", inset:0, zIndex:520, background:"rgba(0,0,0,0.35)", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ width:"min(540px,92vw)", maxHeight:"82vh", display:"flex", flexDirection:"column", background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:10, boxShadow:"0 12px 40px rgba(0,0,0,0.3)", overflow:"hidden" }}>
        {/* 标题 */}
        <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", borderBottom:"1px solid var(--border)", background:"var(--bg)", flexShrink:0 }}>
          <span style={{ fontSize:13, fontWeight:600, color:"var(--text)" }}>{tt(isCopy ? "files.copyToTitle" : "files.moveTitle")}</span>
          <span style={{ flex:1, minWidth:0, fontFamily:"var(--font-mono,ui-monospace,monospace)", fontSize:12, color:"var(--text-dim)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={path}>{srcName}</span>
          <button onClick={()=>{ if(!busy) onClose(); }} title={tt("i18n.close")} style={{ height:26, padding:"0 10px", border:"1px solid var(--border)", borderRadius:5, background:"var(--bg-panel)", color:"var(--text)", cursor:"pointer", fontSize:12, flexShrink:0 }}>✕</button>
        </div>
        {/* 一级：workspace 选择（默认当前打开的 workspace；点下拉换其它 workspace） */}
        <div style={{ position:"relative", display:"flex", alignItems:"center", gap:6, padding:"6px 12px", borderBottom:"1px solid var(--border)", background:"var(--bg)", flexShrink:0 }}>
          <span style={{ fontSize:11, color:"var(--text-dim,#888)", fontWeight:600, flexShrink:0 }}>{tt("files.moveWorkspace")}</span>
          <button type="button" onClick={()=>setWsOpen(v=>!v)} title={ws} style={{ flex:1, minWidth:0, display:"flex", alignItems:"center", gap:6, padding:"5px 8px", background:"var(--bg-hover)", border:"1px solid var(--border)", borderRadius:5, cursor:"pointer", fontSize:12, fontFamily:"var(--font-mono,ui-monospace,monospace)", color:"var(--text)", overflow:"hidden" }}>
            <span style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{displayCwd(ws, home)}</span>
            <CaretIcon />
          </button>
          {wsOpen ? (
            <div style={{ position:"absolute", top:"calc(100% + 4px)", left:12, right:12, zIndex:120, maxHeight:"min(44vh,300px)", overflowY:"auto", background:"var(--bg,#fff)", border:"1px solid var(--border,#d0d0d0)", borderRadius:8, boxShadow:"0 6px 20px rgba(0,0,0,0.15)", padding:4 }}>
              {wsList.map((p)=>{ const cur=p===ws; return (
                <button key={p} type="button" onClick={()=>switchWs(p)} title={p}
                  style={{ ...rowStyle, fontFamily:"var(--font-mono,ui-monospace,monospace)", color:cur?"var(--accent)":"var(--text)", fontWeight:cur?600:400 }}>
                  <FolderIcon open={false} />
                  <span style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{displayCwd(p, home)}</span>
                  {cur ? <CheckIcon /> : null}
                </button>
              ); })}
              <button type="button" onClick={()=>{ setWsOpen(false); setPickCustom(true); }} style={rowStyle}>
                <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" style={{flexShrink:0}}><line x1="5" y1="1" x2="5" y2="9"/><line x1="1" y1="5" x2="9" y2="5"/></svg>
                <span style={{ fontSize:12, color:"var(--text-dim)" }}>{tt("sidebar.customPath")}</span>
              </button>
            </div>
          ) : null}
        </div>
        {/* 二级：目录浏览（在所选 workspace 内导航，当前目录=目标） */}
        <div style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 12px", borderBottom:"1px solid var(--border)", flexShrink:0, fontSize:12, color:"var(--text-muted)", fontFamily:"var(--font-mono)", overflowX:"auto", whiteSpace:"nowrap" }}>
          {(data && data.parentPath!=null) ? <button onClick={()=>loadBrowse(data.parentPath)} title={tt("files.parentDir")} style={{ height:22, padding:"0 6px", border:"1px solid var(--border)", borderRadius:4, background:"var(--bg-panel)", color:"var(--text-muted)", cursor:"pointer", fontSize:12, flexShrink:0, display:"inline-flex", alignItems:"center" }}><MiArrowUp size={12} /></button> : null}
          <span title={browsePath} style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{browsePath||"/"}</span>
        </div>
        <div style={{ flex:1, overflowY:"auto", padding:"4px 0" }}>
          {loading ? <div style={{ padding:"12px", fontSize:12, color:"var(--text-dim)" }}>{tt("files.loading")}</div> : null}
          {error ? <div style={{ padding:"12px", fontSize:12, color:"var(--danger, #f87171)" }}>{error}</div> : null}
          {(!loading && !error && drives && drives.length>0) ? drives.map((d:any)=> <button key={d.path} onClick={()=>loadBrowse(d.path)} style={rowStyle}><FolderIcon open={false} /><span style={{fontSize:12}}>{d.name}</span></button>) : null}
          {(!loading && !error && dirs.length===0 && (!drives||drives.length===0)) ? <div style={{ padding:"12px", fontSize:12, color:"var(--text-dim)" }}>{tt("files.noSubdirs")}</div> : null}
          {(!loading && !error) ? dirs.map((d:any)=> (
            <button key={d.path} onClick={()=>loadBrowse(d.path)} title={d.path} style={rowStyle}>
              <FolderIcon open={false} />
              <span style={{ flex:1, fontSize:12, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.name}</span>
              <span style={{fontSize:10,color:"var(--text-dim)"}}>→</span>
            </button>
          )) : null}
        </div>
        {/* 底部：目标路径 + 操作 */}
        <div style={{ display:"flex", flexDirection:"column", gap:6, padding:"8px 12px", borderTop:"1px solid var(--border)", background:"var(--bg)", flexShrink:0 }}>
          {msg ? <div style={{ fontSize:11, color: msg.err?"var(--danger, #f87171)":"var(--ok, #4ade80)" }}>{msg.err||msg.ok}</div> : null}
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ flex:1, minWidth:0, fontFamily:"var(--font-mono,ui-monospace,monospace)", fontSize:11, color:"var(--text-dim,#888)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={browsePath}>→ {tt("files.moveTarget")}: {browsePath||"/"}</span>
            <button onClick={()=>{ if(!busy) onClose(); }} style={{ height:28, padding:"0 12px", border:"1px solid var(--border)", borderRadius:5, background:"var(--bg-panel)", color:"var(--text)", cursor:"pointer", fontSize:12 }}>{tt("files.cancel")}</button>
            <button onClick={()=>void doMove()} disabled={busy||!browsePath} style={{ height:28, padding:"0 12px", border:"none", borderRadius:5, background:"var(--accent,#4f8ef7)", color:"#fff", cursor:busy?"default":"pointer", fontSize:12, fontWeight:600, opacity:(busy||!browsePath)?0.6:1 }}>{busy?"…":tt(isCopy ? "files.copyHere" : "files.moveHere")}</button>
          </div>
        </div>
      </div>
      {pickCustom ? <DirectoryPicker initialPath={ws} onSelect={(p)=>{ setPickCustom(false); switchWs(p); }} onCancel={()=>setPickCustom(false)} /> : null}
    </div>
  );
}

// ── 独立窗口打开（pi-web /viewer 路由：只含文件查看器的浏览器窗口）──
// 换票+握手+窗口尺寸收敛在 _shared/open-viewer-window（aiti-editor 与 aiti-folder 同用）。
// 注意不能带 noopener——子窗需要 window.opener 发握手（同源可信）。
function openNewWindow(kind: "file" | "folder", p: string, winCwd?: string) {
  openViewerWindow(apiUrl, { path: p, kind, cwd: winCwd });
}

// ── 打开终端：独立查看窗（有 opener）→ postMessage 请主窗口的 aiti-cmd 代开，等回执；
// 主窗口优先宿主 pi-web.ui.onOpenTerminal（右侧工作区终端 tab，同 cwd 复用已开 tab；AppShell 单一入口）；
// 服务缺席再查 __aitiCmd（遗留兜底）；都没有回退服务端 open-terminal（桌面环境弹系统终端窗）。
// CWD=文件夹自身；选中文件=父目录（服务端判定）。返回错误文案，null=成功。
export async function openTerminal(p: string, name?: string): Promise<string | null> {
  // 独立查看窗判定在前（有 opener = 非主窗口）：请主窗口（opener）的 aiti-cmd 代开，等回执。
  const openerWin: any = (window as any).opener;
  if (openerWin && !openerWin.closed) {
    return new Promise((resolve) => {
      const reqId = "ot-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const shellName = name || lastSeg(p) || "bash";
      const onMsg = (ev: MessageEvent) => {
        if (ev.origin !== location.origin || ev.source !== openerWin) return;
        const m: any = ev.data;
        if (!m || m.source !== "aiti-cmd" || m.type !== "open-shell-result" || m.reqId !== reqId) return;
        window.removeEventListener("message", onMsg);
        resolve(m.ok ? null : (m.error || "创建终端失败"));
      };
      window.addEventListener("message", onMsg);
      try {
        openerWin.postMessage({ source: "aiti-ext", type: "open-shell", reqId, cwd: p, name: shellName }, location.origin);
      } catch (e:any) {
        window.removeEventListener("message", onMsg);
        resolve(e && e.message ? e.message : String(e));
        return;
      }
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve("主窗口未响应（aiti-cmd 未启用？）"); }, 4000);
    });
  }
  // 主窗口：宿主统一入口（右侧工作区终端 tab；同 cwd 复用已开 tab，AppShell 单一入口防双开）。
  // onOpenTerminal(cwd, forceNew?) 为 void 无回执，调用即成功。
  // ⚠ __aitiCmd 全局已被宿主废弃（aiti-cmd 懒加载 v2 不再注入，实测恒 undefined）；
  // 掉到服务端回退会在「服务器」桌面弹终端窗，远程访问时用户不可见（曾表现为「点开终端失效」）。
  try {
    const hostUi = extSvc<{ get?: (name: string) => unknown }>("pi-web.ui");
    const open = hostUi?.get?.("onOpenTerminal") as ((cwd: string, forceNew?: boolean) => void) | undefined;
    if (typeof open === "function") { open(p); return null; }
  } catch { /* 服务缺席——走后续回退 */ }
  const bridge = (window as any).__aitiCmd;
  if (bridge && typeof bridge.openShell === "function") {
    const r = await bridge.openShell(p, name || lastSeg(p) || "bash");
    return r && r.ok ? null : (r && r.error) || "创建终端失败";
  }
  try {
    const r = await fetch(apiUrl("/api/extensions/aiti-folder/open-terminal"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ path: p }) });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) return (d && d.error) || "HTTP " + r.status;
    return null;
  } catch (e:any) {
    return e && e.message ? e.message : String(e);
  }
}
// ── Open in the OS file manager: a directory opens itself; an entry opens its folder with the
// entry selected (Windows /select, · macOS -R; Linux has no select verb) ──
// Only the server can raise that window (the browser has no such API), so this calls the
// extension's own endpoint. The host's /api/open-in-explorer is not used on purpose: it decides
// availability by a loopback Host, so behind a reverse proxy (Host stays the public origin) it answers
// 403 "remote" — i.e. nothing happens on the usual access path.
// Returns the error text, or null on success.
export async function openInFileManager(p: string): Promise<string | null> {
  try {
    const r = await fetch(apiUrl("/api/extensions/aiti-folder/open-in-file-manager"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ path: p }) });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) return (d && d.error) || "HTTP " + r.status;
    return null;
  } catch (e:any) {
    return e && e.message ? e.message : String(e);
  }
}
function NewWindowIcon() {
  return <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>;
}
// ── 审核之眼（Git Review 统一图标）──
// 线稿 = aiti-git-review extman 注册的 icon.svg（feather eye），与聊天窗工具条/编辑器菜单
// 的 GrEyeIcon 同一形状（aiti-git-review/client/src/git-review-app.tsx 导出同款）。勿单改此处形状。
function GrEyeIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// 开放点数据/注册已抽到 ./folder-actions（拆包共享模块——与薄入口同实例，见该文件头）
import { folderActions } from "./folder-actions";

// ── 目录行「+」菜单：对该目录新建文件/文件夹、上传文件/文件夹（目标=该目录，非根）。──
// 菜单用 fixed 视口定位（树容器 overflow 滚动会裁剪 absolute 弹层）；hovered 传入以在
// 菜单打开后鼠标移出时保持渲染（否则 onMouseLeave 卸载弹层）。
function DirOpsMenu(props: { dir: string; hovered: boolean; onChanged: (dir: string) => void; onRefresh?: () => void; onOpenFile?: (p: string) => void; onOpenFolder?: (p: string, name?: string) => void; onAtMention?: (rel: string, b: boolean) => void; onTrash?: (o: { path: string; name: string; isDir: boolean }) => void; t: TFn; root: string; cwd: string; /** Git Review scope: nested-repo rows pass their own dir (plan §3.5); default = open root */ gitScope?: string }) {
  const { dir, hovered, onChanged, onRefresh, onOpenFile, onAtMention, onTrash, t: tt, root, cwd, gitScope } = props;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string | null>(null); // "file" | "folder" | null
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<any>(null);
  const [renameMode, setRenameMode] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null), dirRef = useRef<HTMLInputElement | null>(null);
  useEffect(()=>{ if(!open) return; const h=(e:any)=>{ if(!(e.target as Element).closest?.("[data-dirops]")) setOpen(false); }; const w=()=>setOpen(false); document.addEventListener("mousedown",h); document.addEventListener("wheel", w, {passive:true} as any); return ()=>{ document.removeEventListener("mousedown",h); document.removeEventListener("wheel", w); }; }, [open]);
  const doCreate = async ()=>{
    const n = name.trim(); if(!n||!kind||busy) return;
    const endpoint = kind==="file" ? "/api/extensions/aiti-folder/create-file" : "/api/extensions/aiti-folder/create-folder";
    setBusy(true);
    try{
      const r = await fetch(apiUrl(endpoint), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ dir, name:n }) });
      const d = await r.json().catch(()=>({}));
      if(!r.ok || !d.ok) setMsg({err: d.error || ("HTTP "+r.status)});
      else {
        setMsg({ok: (kind==="file"?tt("files.newFile"):tt("files.newFolder"))+" ✓"});
        setOpen(false); setKind(null); setName(""); setPos(null);
        onChanged?.(dir);
        if(kind==="file" && d.path && onOpenFile) onOpenFile(d.path);
      }
    }catch(e:any){ setMsg({err: e&&e.message?e.message:String(e)}); }
    finally{ setBusy(false); }
  };
  const doUpload = async (ev: any, isDirUpload: boolean)=>{
    const files = Array.from(ev.target.files||[]); ev.target.value="";
    if(files.length===0||busy) return;
    setBusy(true); setMsg(null);
    try{
      if(isDirUpload){
        const fd = new FormData(); fd.append("dir", dir);
        for(const f of files as any[]){ const rel=(f.webkitRelativePath||f.name||"").replace(/\\/g,"/"); fd.append("files", f, rel||f.name); }
        const r = await fetch(apiUrl("/api/extensions/aiti-folder/upload-tree"), { method:"POST", body:fd });
        const d = await r.json().catch(()=>({}));
        if(!r.ok || !d.ok) setMsg({err: d.error||("HTTP "+r.status)});
        else { setMsg({ok: "↑"+(d.uploaded||[]).length+" / 跳"+(d.skipped||[]).length}); setOpen(false); onChanged?.(dir); }
      } else {
        const fd = new FormData(); fd.append("directory", dir); (files as any[]).forEach(f=>fd.append("files", f, f.name));
        const r = await fetch(apiUrl("/api/files/upload?conflict=skip"), { method:"POST", body:fd });
        const d = await r.json().catch(()=>({}));
        if(!r.ok && !d.conflicts) setMsg({err: d.error||("HTTP "+r.status)});
        else { setMsg({ok: "↑"+(d.uploaded||[]).length+" / 跳"+(d.skipped||[]).length}); setOpen(false); onChanged?.(dir); }
      }
    }catch(e:any){ setMsg({err: e&&e.message?e.message:String(e)}); }
    finally{ setBusy(false); }
  };
  const doAt = ()=>{ if(!onAtMention) return; onAtMention(relTo(dir,cwd),false); setOpen(false); };
  // 复制路径（绝对路径）：菜单保持开，反馈写菜单底部 msg 行
  const doCopyPath = ()=>{ copyTextToClipboard(dir).then(()=>setMsg({ok: tt("files.copyDone")}), (e:any)=>setMsg({err:(e&&e.message)?e.message:tt("files.copyFailed")})); };
  const doTrash = ()=>{ if(!onTrash) return; onTrash({path:dir, name:lastSeg(dir)!, isDir:true}); setOpen(false); };
  const doDownload = async ()=>{ try{
    // 两步下载：POST 换票据（路径不进 URL，避免落入隧道/代理 access log）→ 带 ticket 的 GET 流式下载
    const r = await fetch(apiUrl("/api/extensions/aiti-folder/archive-ticket"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ path: dir }) });
    const d = await r.json().catch(()=>({} as any));
    if (!r.ok || !d.ok || !d.ticket) { setMsg({err:d.error||("HTTP "+r.status)}); setOpen(false); return; }
    const a=document.createElement("a"); a.href=apiUrl("/api/extensions/aiti-folder/archive?ticket="+encodeURIComponent(d.ticket)); a.download=lastSeg(dir)+".tar.gz"; a.click(); }catch(_){/* noop */} setOpen(false); };
  const doRename = ()=>{ setRenameMode(true); setRenameName(lastSeg(dir)||""); };
  const doRenameDir = async ()=>{ const n=renameName.trim(); if(!n||!renameMode||busy) return; setBusy(true); try{ const r=await fetch(apiUrl("/api/extensions/aiti-folder/rename"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:dir,newName:n})}); const d=await r.json().catch(()=>({})); if(!r.ok||!d.ok) setMsg({err:d.error||("HTTP "+r.status)}); else{ setMsg({ok:(tt("files.renameSuccess") as string)||"✓"}); setRenameMode(false); setRenameName(""); setOpen(false); onChanged?.(dir); } }catch(e:any){ setMsg({err:e&&e.message?e.message:String(e)}); }finally{ setBusy(false); } };
  // @ 到新session：目录【全路径】引用（新会话 cwd 可能不同，相对引用不可靠；
  // relTo(root,cwd) 在 root==cwd 时返回空串→"@/ "丢路径，2026-09-08 修）写 pending composer 预填文本，
  // 再切新建会话页（宿主 ChatInput 挂载后消费插入，不自动发送）
  // 不随便切 CWD：目标目录在当前 CWD/关注路径内 → 保持；只在属于别的仓库时才切（doc-center 同款）
  const doAtNew = async ()=>{ try{
    const p = dir + "/";
    const text = buildAtText(p);
    await openNewSessionWithExtSvc({ text, targetDir: dir, targetPath: dir, currentCwd: cwd, apiUrl, extSvc });
  }catch{/* noop */} setOpen(false); };
  const [infoOpen, setInfoOpen] = useState(false);
  // 移动/复制弹窗：null=关，"move"/"copy"=弹窗模式（共用 TransferDialog）
  const [transfer, setTransfer] = useState<null | "move" | "copy">(null);
  const toggle = (e: any)=>{
    e.stopPropagation();
    if(open){ setOpen(false); return; }
    const r = e.currentTarget.getBoundingClientRect();
    // 菜单固定视口定位：left 夹在视口内；底部空间不足时向上翻转，避免被屏幕裁掉。
    // 估算菜单高度：4 图标排 + 6 文字行 + Git + 5 分隔线 + padding + msg 行 + 输入框态更高。
    // 写得稍大一些（400）确保翻转判断不会被低估值误导；翻转后顶部也不够就贴顶。
    const mh = 400;
    const menuWidth = 230;
    const left = Math.max(8, Math.min(r.right - menuWidth, window.innerWidth - menuWidth - 8));
    const overflowDown = r.bottom + 4 + mh > window.innerHeight;
    const overflowUp = r.top - mh - 4 < 0;
    let top: number;
    if (overflowDown && !overflowUp) {
      // 翻转向上
      top = Math.max(8, r.top - mh - 4);
    } else if (overflowDown && overflowUp) {
      // 上下都不够：贴顶，给用户滚动的余地（菜单高度超出视口本身就极少见）
      top = 8;
    } else {
      top = r.bottom + 4;
    }
    // Panel UI scale (zoomed panel containers): viewport-space estimates must be
    // divided back before being written as insets (see popup-anchor.zoomFactorOf).
    const zoomFactor = zoomFactorOf(e.currentTarget);
    setPos({ left: left / zoomFactor, top: top / zoomFactor });
    setOpen(true);
  };
  const visible = hovered || open || !!transfer;
  return (
    <div data-dirops={1} onClick={e=>e.stopPropagation()} style={{ position:"absolute", right:4, top:1, zIndex:40, display: visible?undefined:"none" }}>
      <button type="button" onClick={toggle} title={tt("files.rename")+" / "+tt("files.insertPath")+" / "+tt("files.download")+" / "+tt("files.trash")+" / "+tt("files.newFile")}
        style={{ width:24, height:22, padding:0, display:"flex", alignItems:"center", justifyContent:"center", border:"1px solid var(--border)", borderRadius:4, background: open?"var(--bg-selected)":"var(--bg-panel)", color: open?"var(--accent)":"var(--text-dim)", cursor:"pointer", fontSize:14, fontWeight:700, lineHeight:1, transition:"color 0.12s, background 0.12s" }}>⋮</button>
      {open ? (
        <div style={{ position:"fixed", left:pos!.left, top:pos!.top, zIndex:400, minWidth:220, padding:6, background:"var(--bg,#fff)", border:"1px solid var(--border,#d0d0d0)", borderRadius:10, boxShadow:"0 4px 12px rgba(0,0,0,0.15)", fontSize:12, display:"flex", flexDirection:"column", gap:2 }}>
          {kind ? (
            <div style={{display:"flex",flexDirection:"column",gap:6,padding:"2px 2px 4px"}}>
              <div style={{fontSize:11,color:"var(--text-dim,#888)",fontWeight:600}}>{kind==="file"?tt("files.newFile"):tt("files.newFolder")}</div>
              <input autoFocus value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter") void doCreate(); if(e.key==="Escape") setKind(null); }} placeholder={tt("files.namePlaceholderFile")}
                style={{width:"100%",boxSizing:"border-box",fontSize:12,fontFamily:"var(--font-mono,ui-monospace,monospace)",padding:"5px 8px",border:"1px solid var(--border,#d0d0d0)",borderRadius:5,outline:"none",background:"var(--bg,#fff)",color:"var(--text,#222)"}} />
              <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                <button type="button" onClick={()=>setKind(null)} style={{...createBtnStyle,background:"transparent",border:"1px solid var(--border,#d0d0d0)",color:"var(--text,#222)"}}>{tt("files.cancel")}</button>
                <button type="button" onClick={()=>void doCreate()} disabled={!name.trim()||busy} style={{...createBtnStyle,background:"var(--accent,#4f8ef7)",color:"#fff",border:"none",opacity:!name.trim()||busy?0.5:1}}>{busy?"…":tt("files.create")}</button>
              </div>
            </div>
          ) : (renameMode ? (
            <div style={{display:"flex",flexDirection:"column",gap:6,padding:"2px 2px 4px"}}>
              <div style={{fontSize:11,color:"var(--text-dim,#888)",fontWeight:600}}>{tt("files.rename")}</div>
              <input autoFocus value={renameName} onChange={e=>setRenameName(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter") void doRenameDir(); if(e.key==="Escape") setRenameMode(false); }} placeholder={(tt("files.renamePlaceholder") as string)||"输入新文件名"}
                style={{width:"100%",boxSizing:"border-box",fontSize:12,fontFamily:"var(--font-mono,ui-monospace,monospace)",padding:"5px 8px",border:"1px solid var(--border,#d0d0d0)",borderRadius:5,outline:"none",background:"var(--bg,#fff)",color:"var(--text,#222)"}} />
              <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                <button type="button" onClick={()=>setRenameMode(false)} style={{...createBtnStyle,background:"transparent",border:"1px solid var(--border,#d0d0d0)",color:"var(--text,#222)"}}>{tt("files.cancel")}</button>
                <button type="button" onClick={()=>void doRenameDir()} disabled={!renameName.trim()||busy} style={{...createBtnStyle,background:"var(--accent,#4f8ef7)",color:"#fff",border:"none",opacity:!renameName.trim()||busy?0.5:1}}>{busy?"…":tt("files.confirm")}</button>
              </div>
            </div>
          ) : [
            // ── 浏览/窗口排（2026-11-24 菜单单行化，方案 docs/aiti-menu-single-row-plan.md §3.1/§5.1）──
            menuActionRow("row-browse", tt("files.menuBrowse"), [
              { key:"rf", title: tt("files.refresh"), icon:<MiRefresh/>, onClick: ()=>{ setOpen(false); onRefresh && onRefresh(); } },
              // 不关菜单：EntryInfoModal 挂本组件内，受 visible=hovered||open 控制（保真契约 §5.1#4）
              { key:"info", title: tt("files.entryInfo"), icon:<MiInfo/>, onClick: ()=>setInfoOpen(true) },
            ]),
            menuActionRow("row-window", tt("files.menuWindow"), [
              { key:"nw", title: tt("files.openNewWindow"), icon:<NewWindowIcon/>, onClick: ()=>{ setOpen(false); openNewWindow("folder", dir); } },
              { key:"ot", title: tt("files.openTerminal"), icon:<TerminalIcon/>, onClick: ()=>{ setOpen(false); void openTerminal(dir).then(err=>{ if (err) setMsg({ err }); }); } },
              { key:"fm", title: tt("files.openInFileManager"), icon:<MiFolderOpen/>, onClick: ()=>{ setOpen(false); void openInFileManager(dir).then(err=>{ if (err) setMsg({ err }); }); } },
            ]),
            // ── 路径引用（特色区置顶）──
            menuSep("s-ref"),
            onAtMention ? menuItem(<MiAt/>, tt("files.insertPath"), doAt, "at") : null,
            menuItem(<MiCopy/>, tt("files.copyPath"), doCopyPath, "cp"),
            menuItem(<MiAt/>, tt("files.atNewSession"), doAtNew, "atn"),
            // ── Git（特色第二段）──
            root ? menuSep("s-git") : null,
            root ? (
              <button type="button" key="gr" onClick={(e)=>{e.stopPropagation();setOpen(false);void openGitReview({ kind: "directory", path: gitScope || root });}} style={{display:"flex",alignItems:"center",gap:6,width:"100%",padding:"5px 10px",border:"none",background:"transparent",color:"var(--accent)",cursor:"pointer",textAlign:"left",fontSize:12,borderRadius:6,whiteSpace:"nowrap"}}>
                <GrEyeIcon size={13} />
                Git Review
              </button>
            ) : null,
            // ── 新建 / 上传（图标排，惯例位）──
            menuSep("s-new"),
            menuActionRow("row-new", tt("files.menuCreate"), [
              { key:"nf", title: tt("files.newFile"), icon:<MiFilePlus/>, onClick: ()=>{ setKind("file"); setName(""); } },
              { key:"nd", title: tt("files.newFolder"), icon:<MiFolderPlus/>, onClick: ()=>{ setKind("folder"); setName(""); } },
              { key:"uf", title: tt("files.uploadFile"), icon:<MiUpload/>, onClick: ()=>{ setOpen(false); if(fileRef.current) fileRef.current.click(); } },
              { key:"ud", title: tt("files.uploadFolder"), icon:<MiFolderUp/>, onClick: ()=>{ setOpen(false); if(dirRef.current) dirRef.current.click(); } },
            ]),
            // ── 整理（图标排 + 文字行；回收站条件 onTrash）──
            menuSep("s-org"),
            menuActionRow("row-org", tt("files.menuOrganize"), [
              { key:"rn", title: tt("files.rename"), icon:<MiPencil/>, onClick: doRename },
              ...(onTrash ? [{ key:"tr", title: tt("files.trash"), icon:<MiTrash/>, onClick: doTrash }] : []),
            ]),
            menuItem(<MiMove/>, tt("files.move"), ()=>{ setTransfer("move"); }, "mv"),
            menuItem(<MiCopyTo/>, tt("files.copyTo"), ()=>{ setTransfer("copy"); }, "cpto"),
            // ── 导出 ──
            menuSep("s-exp"),
            menuItem(<MiDownload/>, tt("files.download"), doDownload, "dl"),
          ])}
          {msg ? <div style={{fontSize:10,color:msg.err?"var(--danger, #f87171)":"var(--ok, #4ade80)",padding:"2px 4px"}}>{msg.err?msg.err:(msg.ok||"")}</div> : null}
        </div>
      ) : null}
      <input ref={fileRef} type="file" multiple hidden onChange={e=>void doUpload(e,false)} />
      <input ref={dirRef} type="file" multiple hidden webkitdirectory="" onChange={e=>void doUpload(e,true)} />
      {infoOpen ? <EntryInfoModal path={dir} onClose={()=>{ setInfoOpen(false); setOpen(false); }} t={tt} onOpenFolder={props.onOpenFolder} /> : null}
      {transfer ? <TransferDialog path={dir} cwd={cwd} root={root} mode={transfer} t={tt} onClose={()=>{ setTransfer(null); }} onMoved={(newPath)=>{ setTransfer(null); setOpen(false); onChanged?.(dir); }} /> : null}
    </div>
  );
}

// ── 文件行操作区（与文件夹 DirOpsMenu 同款：大屏悬停显示操作按钮；小屏无悬停→点击后部等效悬停，
// 再点「+」展开菜单。点击文件名仍开文件；点击操作区不冒泡到行）。
function FileOpsMenu(props: { filePath: string; cwd: string; root: string; onOpenFile?: (p: string) => void; onOpenFolder?: (p: string, name?: string) => void; onAtMention?: (rel: string, b: boolean) => void; onTrash?: (o: { path: string; name: string; isDir: boolean }) => void; hovered: boolean; t: TFn; onRefresh?: (p?: string) => void; gitIgnore?: (() => void) | null; /** true = render the ⋮ entry only (quick @/trash/download buttons hidden — change rows and git buttons are mutually exclusive to avoid squeeze) */ quickOnly?: boolean; /** change-row git context: when provided the ⋮ menu renders the Git group (stage/diff/discard/gitignore) */ staged?: boolean; gitOp?: (kind: "stage" | "unstage" | "discard", rel: string) => void; /** discard confirm goes through the in-page dialog (host FolderBrowser requestDiscard) */ onRequestDiscard?: (o: { title: string; message: string; run: () => void }) => void; /** Git Review scope（嵌套仓库内文件=嵌套目录；默认=打开的根） */ gitScope?: string }) {
  const { filePath, cwd, root, onOpenFile, onAtMention, onTrash, hovered, t: tt, onRefresh, gitIgnore, quickOnly, staged, gitOp, onRequestDiscard, gitScope } = props;
  const [open, setOpen] = useState(false); const [pos, setPos] = useState<{left:number;top:number}|null>(null);
  const [renameMode, setRenameMode] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [msg, setMsg] = useState<any>(null);
  useEffect(()=>{ if(!open) return; const h=(e:any)=>{ if(!(e.target as Element).closest?.("[data-fileops]")) setOpen(false); }; const w=()=>setOpen(false); document.addEventListener("mousedown",h); document.addEventListener("wheel",w,{passive:true} as any); return ()=>{ document.removeEventListener("mousedown",h); document.removeEventListener("wheel",w); }; }, [open]);
  const toggle = (e:any)=>{ e.stopPropagation(); if(open){ setOpen(false); return; }
    const r=e.currentTarget.getBoundingClientRect();
    // 菜单固定视口定位：left 夹在视口内；底部空间不足时向上翻转，避免被屏幕裁掉。
    // 估算菜单高度：3 图标排 + 6 文字行 + Git + 4 分隔线 + padding + gap + msg 行 ≈ 330，用 360 留 buffer。
    const mh=360; const menuWidth=230; const left=Math.max(8,Math.min(r.right-menuWidth,window.innerWidth-menuWidth-8)); const overflowDown=r.bottom+4+mh>window.innerHeight; const overflowUp=r.top-mh-4<0; let top: number;
    if(overflowDown&&!overflowUp) top=Math.max(8,r.top-mh-4);
    else if(overflowDown&&overflowUp) top=8;
    else top=r.bottom+4;
    const zf=zoomFactorOf(e.currentTarget); // panel UI scale: divide viewport-space back (popup-anchor.zoomFactorOf)
    setPos({left:left/zf,top:top/zf}); setOpen(true); };
  const handleAt = ()=>{ if(!onAtMention) return; onAtMention(relTo(filePath,cwd),false); setOpen(false); };
  // 复制路径（绝对路径）：菜单保持开，反馈写菜单底部 msg 行
  const doCopyPath = ()=>{ copyTextToClipboard(filePath).then(()=>setMsg({ok: tt("files.copyDone")}), (e:any)=>setMsg({err:(e&&e.message)?e.message:tt("files.copyFailed")})); };
  const handleTrash = ()=>{ if(!onTrash) return; onTrash({path:filePath, name:lastSeg(filePath)!, isDir:false}); setOpen(false); };
  const doDownload = ()=>{ try{
    // 两步下载：POST 换票据（路径不进 URL，避免落入隧道/代理 access log）→ 带 ticket 的 GET 流式下载
    fetch(apiUrl("/api/files/ticket"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:filePath})})
      .then(r=>r.json()).then(d=>{ if(!d.ticket) throw new Error(d.error||"no ticket");
        const a=document.createElement("a"); a.href=apiUrl("/api/files/_t/"+encodeURIComponent(d.ticket)); a.download=lastSeg(filePath)!; document.body.appendChild(a); a.click(); a.remove(); })
      .catch(()=>{});
  }catch(_){/* noop */} onRefresh && onRefresh(); setOpen(false); };
  const doRename = ()=>{ setRenameMode(true); setRenameName(lastSeg(filePath)||""); };
  // @ 到新session：文件【全路径】引用（同 DirOpsMenu，相对引用在新会话不可靠）；
  // CWD 判定目标 = 文件所在目录（与 aiti-editor 同口径）；无 cwd 兜底浏览根
  const doAtNew = async ()=>{ try{
    const rel = filePath;
    const text = buildAtText(rel);
    const targetDir = filePath.slice(0, filePath.lastIndexOf("/")) || root;
    await openNewSessionWithExtSvc({ text, targetDir, targetPath: filePath, currentCwd: cwd, apiUrl, extSvc });
  }catch{/* noop */} setOpen(false); };
  const [infoOpen, setInfoOpen] = useState(false);
  // 移动/复制弹窗：null=关，"move"/"copy"=弹窗模式（共用 TransferDialog）
  const [transfer, setTransfer] = useState<null | "move" | "copy">(null);
  const doRenameFile = async ()=>{ const n=renameName.trim(); if(!n||!renameMode) return; try{ const r=await fetch(apiUrl("/api/extensions/aiti-folder/rename"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:filePath,newName:n})}); const d=await r.json().catch(()=>({})); if(!r.ok||!d.ok){ alert(d.error||("HTTP "+r.status)); return; } setRenameMode(false); setRenameName(""); setOpen(false); onRefresh && onRefresh(); }catch(e:any){ alert(e&&e.message?e.message:String(e)); } };
  const visible = hovered || open || !!transfer;
  return (
    <div data-fileops={1} onClick={e=>e.stopPropagation()} style={{ position:"absolute", right:4, top:1, display:"flex", alignItems:"center", gap:3, zIndex:40, visibility:visible?"visible":"hidden" }}>
      {!quickOnly && onAtMention ? <button onClick={e=>{e.stopPropagation(); handleAt();}} title={tt("files.insertPathTitle")} style={{ width:22, height:22, padding:0, display:"flex", alignItems:"center", justifyContent:"center", border:"1px solid var(--border)", borderRadius:4, background:"var(--bg-panel)", color:"var(--accent)", cursor:"pointer", fontSize:12, fontWeight:700, lineHeight:1, flexShrink:0 }}>@</button> : null}
      {!quickOnly && onTrash ? <button onClick={e=>{e.stopPropagation(); handleTrash();}} title={tt("files.trash")} style={{ width:22, height:22, padding:0, display:"flex", alignItems:"center", justifyContent:"center", border:"1px solid var(--border)", borderRadius:4, background:"var(--bg-panel)", color:"var(--danger, #ef4444)", cursor:"pointer", lineHeight:1, flexShrink:0 }}><MiTrash/></button> : null}
      {!quickOnly ? <button onClick={()=>doDownload()} title={tt("files.download")} style={{ width:22, height:22, padding:0, display:"flex", alignItems:"center", justifyContent:"center", border:"1px solid var(--border)", borderRadius:4, background:"var(--bg-panel)", color:"var(--accent)", cursor:"pointer", fontSize:12, fontWeight:700, lineHeight:1, flexShrink:0 }}><MiDownload/></button> : null}
      <button onClick={toggle} title={tt("files.rename")+" / "+tt("files.download")+" / "+tt("files.insertPath")+" / "+tt("files.trash")} style={{ width:24, height:22, padding:0, display:"flex", alignItems:"center", justifyContent:"center", border:"1px solid var(--border)", borderRadius:4, background:open?"var(--bg-selected)":"var(--bg-panel)", color:open?"var(--accent)":"var(--text-dim)", cursor:"pointer", fontSize:14, fontWeight:700, lineHeight:1, flexShrink:0, transition:"color 0.12s, background 0.12s" }}>⋮</button>
      {open ? (
        <div style={{ position:"fixed", left:pos!.left, top:pos!.top, zIndex:400, minWidth:220, padding:6, background:"var(--bg,#fff)", border:"1px solid var(--border,#d0d0d0)", borderRadius:10, boxShadow:"0 4px 12px rgba(0,0,0,0.15)", fontSize:12, display:"flex", flexDirection:"column", gap:2 }}>
          {renameMode ? (
            <div key="ri" style={{display:"flex",flexDirection:"column",gap:6,padding:"2px 2px 4px"}}>
              <div style={{fontSize:11,color:"var(--text-dim,#888)",fontWeight:600}}>{tt("files.rename")}</div>
              <input autoFocus value={renameName} onChange={e=>setRenameName(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter") void doRenameFile(); if(e.key==="Escape") setRenameMode(false); }} placeholder={(tt("files.renamePlaceholder") as string)||"输入新文件名"}
                style={{width:"100%",boxSizing:"border-box",fontSize:12,fontFamily:"var(--font-mono,ui-monospace,monospace)",padding:"5px 8px",border:"1px solid var(--border,#d0d0d0)",borderRadius:5,outline:"none",background:"var(--bg,#fff)",color:"var(--text,#222)"}} />
              <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                <button type="button" onClick={()=>setRenameMode(false)} style={{...createBtnStyle,background:"transparent",border:"1px solid var(--border,#d0d0d0)",color:"var(--text,#222)"}}>{tt("files.cancel")}</button>
                <button type="button" onClick={()=>void doRenameFile()} disabled={!renameName.trim()} style={{...createBtnStyle,background:"var(--accent,#4f8ef7)",color:"#fff",border:"none",opacity:!renameName.trim()?0.5:1}}>{tt("files.confirm")}</button>
              </div>
            </div>
          ) : [
            // ── 浏览/窗口排（2026-11-24 菜单单行化，方案 docs/aiti-menu-single-row-plan.md §3.2/§5.2）──
            menuActionRow("row-browse", tt("files.menuBrowse"), [
              // 不关菜单：EntryInfoModal 挂本组件内，受 visibility=hovered||open 控制（保真契约 §5.2#3）
              { key:"info", title: tt("files.entryInfo"), icon:<MiInfo/>, onClick: ()=>setInfoOpen(true) },
            ]),
            menuActionRow("row-window", tt("files.menuWindow"), [
              { key:"nw", title: tt("files.openNewWindow"), icon:<NewWindowIcon/>, onClick: ()=>{ setOpen(false); openNewWindow("file", filePath); } },
              { key:"ot", title: tt("files.openTerminal"), icon:<TerminalIcon/>, onClick: ()=>{ setOpen(false); void openTerminal(dirOf(filePath), lastSeg(filePath)).then(err=>{ if (err) alert(err); }); } },
              { key:"fm", title: tt("files.openInFileManager"), icon:<MiFolderOpen/>, onClick: ()=>{ setOpen(false); void openInFileManager(filePath).then(err=>{ if (err) alert(err); }); } },
            ]),
            // ── 路径引用（特色区置顶）──
            menuSep("s-ref"),
            onAtMention ? menuItem(<MiAt/>, tt("files.insertPath"), handleAt, "at") : null,
            menuItem(<MiCopy/>, tt("files.copyPath"), doCopyPath, "cp"),
            menuItem(<MiAt/>, tt("files.atNewSession"), doAtNew, "atn"),
            // ── Git（特色第二段）──
            root ? menuSep("s-git") : null,
            root ? (
              <button type="button" key="gr" onClick={(e)=>{ e.stopPropagation(); setOpen(false); void openGitReview({ kind: "directory", path: gitScope || root }); }}
                style={{ display:"flex", alignItems:"center", gap:6, width:"100%", padding:"5px 10px", border:"none", background:"transparent", color:"var(--accent)", cursor:"pointer", textAlign:"left", fontSize:12, borderRadius:6, whiteSpace:"nowrap" }}>
                <GrEyeIcon size={13} />
                Git Review
              </button>
            ) : null,
            // Git 组（变更行：引擎在位时）：暂存/取消暂存（随状态切换）、diff、丢弃（带确认）、加入 .gitignore（untracked）
            // 原行内快捷钮已收编进此组（2026-11-24 用户拍板：行内与菜单统一）
            gitOp ? [
              menuItem(staged ? <MiMinus/> : <MiPlus/>, staged ? tt("files.unstage") : tt("files.stage"), () => gitOp(staged ? "unstage" : "stage", relFromBase(filePath, root) || filePath), "gst"),
              menuItem(<MiGitCompare/>, "查看 Git Diff", () => { try { openFileDiff(filePath, filePath.split("/").pop() || filePath); } catch (_) { /* noop */ } }, "gdf"),
              menuItem(<MiUndo/>, ct("git.discardTitle"), () => { const un = !!gitIgnore; const msg = un ? ct("git.discardUntrackedConfirm") : ct("git.discardConfirm", { path: relFromBase(filePath, root) || filePath }); const run = () => { if (un) { onTrash({ path: filePath, name: filePath.split("/").pop() || filePath, isDir: false }); } else { gitOp("discard", relFromBase(filePath, root) || filePath); } }; if (onRequestDiscard) { onRequestDiscard({ title: ct("git.discardTitle"), message: msg, run }); } else if (window.confirm(msg)) { run(); } }, "gds"),
              gitIgnore ? menuItem(<MiEyeOff/>, tt("files.gitIgnoreAdd"), gitIgnore, "gi") : null,
            ] : null,
            // ── 整理（图标排 + 文字行；回收站条件 onTrash，handleTrash 行为不变）──
            menuSep("s-org"),
            menuActionRow("row-org", tt("files.menuOrganize"), [
              { key:"rn", title: tt("files.rename"), icon:<MiPencil/>, onClick: doRename },
              ...(onTrash ? [{ key:"tr", title: tt("files.trash"), icon:<MiTrash/>, onClick: handleTrash }] : []),
            ]),
            menuItem(<MiMove/>, tt("files.move"), ()=>{ setTransfer("move"); }, "mv"),
            menuItem(<MiCopyTo/>, tt("files.copyTo"), ()=>{ setTransfer("copy"); }, "cpto"),
            // ── 导出 ──
            menuSep("s-exp"),
            menuItem(<MiDownload/>, tt("files.download"), doDownload, "dl"),
          ]}
          {msg ? <div style={{fontSize:10,color:msg.err?"var(--danger, #f87171)":"var(--ok, #4ade80)",padding:"2px 4px"}}>{msg.err?msg.err:(msg.ok||"")}</div> : null}
        </div>
      ) : null}
      {infoOpen ? <EntryInfoModal path={filePath} onClose={()=>{ setInfoOpen(false); setOpen(false); }} t={tt} onOpenFolder={props.onOpenFolder} /> : null}
      {transfer ? <TransferDialog path={filePath} cwd={cwd} root={root} mode={transfer} t={tt} onClose={()=>{ setTransfer(null); }} onMoved={(newPath)=>{ setTransfer(null); setOpen(false); onRefresh && onRefresh(); }} /> : null}
    </div>
  );
}

/** untracked 文件「丢弃」= 移入系统回收站（复用 folder 已有 /trash 端点——不重新发明删除，2026-11-24 用户拍板） */
async function discardUntrackedToTrash(absPath: string): Promise<void> {
  const r = await fetch(apiUrl("/api/extensions/aiti-folder/trash"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [absPath] }) });
  const d = await r.json().catch(() => ({ ok: false, error: "HTTP " + r.status }));
  if (!r.ok || !d.ok) throw new Error(d.error || "HTTP " + r.status);
}

// ── 桶头（已暂存/工作区折叠项）：label (count) + hover 显示批量按钮；
// 点击进 busy 态（spinner 常显直到完成——批量操作慢时给用户明确反馈），完成后恢复 hover 显隐。──
function BucketHead(p: { label: string; count: number; batches?: Array<{ id: string; title: string; label: string; color?: string; confirm?: string; run: () => Promise<void> | void }>; requestDiscard?: (o: { title: string; message: string; run: () => void }) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const busy = busyId !== null;
  const show = busy || hovered;
  return (
    <div onMouseEnter={(e) => setHovered(true)} onMouseLeave={(e) => setHovered(false)}
      style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 10px 1px", fontSize:10, fontWeight:600, letterSpacing:"0.05em", textTransform:"uppercase" as const, color:"var(--text-dim)" }}>
      <span style={{ fontWeight:600 }}>{p.label} ({p.count})</span>
      <span style={{ flex:1 }} />
      {(p.batches || []).map((b) => (
        <button key={b.id} data-batch-btn type="button" title={b.title} aria-label={b.title} disabled={busy}
          onClick={(e) => { e.stopPropagation(); if (busy) return; if (b.confirm && p.requestDiscard) { p.requestDiscard({ title: b.title, message: b.confirm, run: () => { setBusyId(b.id); const t0 = Date.now(); Promise.resolve(b.run()).catch(() => {}).then(async () => { const el = Date.now() - t0; if (el < 450) await new Promise(r2 => setTimeout(r2, 450 - el)); setBusyId(null); }); } }); return; } setBusyId(b.id); const t0 = Date.now(); Promise.resolve(b.run()).catch(() => {}).then(async () => { const el = Date.now() - t0; if (el < 450) await new Promise(r2 => setTimeout(r2, 450 - el)); setBusyId(null); }); }}
          style={{ opacity: (show || busyId === b.id) ? 1 : 0, transition:"opacity 0.12s", border:"none", background:"none", color: busyId === b.id ? "var(--accent)" : (b.color || "var(--text-dim)"), cursor: busy ? "default" : "pointer", fontSize:10, padding:"1px 4px", borderRadius:4, fontFamily:"var(--font-mono)", display:"inline-flex", alignItems:"center", gap:4 }}
        >
          {busyId === b.id ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation:"spin 0.8s linear infinite" }}><path d="M21 12a9 9 0 1 1-5.7-8.4" /></svg>
          ) : b.label}
        </button>
      ))}
    </div>
  );
}

// ── 变更区段文件行：与树内文件行同款 hover 操作区（FileOpsMenu：@/🗑/⬇️/⋮ 菜单）──
// 相对路径显示走 relFromBase（分隔符/大小写兼容 Windows——git status 的 filePath 是
// 服务端 path.resolve 产物反斜杠形式，直接 startsWith(root+"/") 必失败→显示完整绝对路径）。
function ChangedFileRow(o: { st: any; root: string; cwd: string; onOpenFile: (p: string) => void; onOpenFolder?: (p: string, name?: string) => void; onAtMention?: (rel: string, b: boolean) => void; onTrash?: (x: { path: string; name: string; isDir: boolean }) => void; t: TFn; onRefresh: () => void; staged?: boolean; untracked?: boolean; onGitIgnore?: (rel: string) => void; gitOp?: (kind: "stage" | "unstage" | "discard", rel: string) => void; onRequestDiscard?: (o: { title: string; message: string; run: () => void }) => void }) {
  const { st, root, cwd, onOpenFile, onAtMention, onTrash, t: tt, onRefresh, staged, untracked, onGitIgnore, gitOp, onRequestDiscard } = o;
  const [hovered, setHovered] = useState(false);
  const rel = relFromBase(st.filePath, root) || st.filePath;
  const gitBtn = (title: string, label: string, fn: () => void, key: string, color = "var(--text-dim)") => (
    <button key={key} type="button" title={title} aria-label={title}
      onClick={(e) => { e.stopPropagation(); fn(); }}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, border: "none", background: "none", color, cursor: "pointer", borderRadius: 4, fontSize: 11, lineHeight: 1, flexShrink: 0 }}>{label}</button>
  );
  return (
    <div onClick={()=>onOpenFile(st.filePath)} title={st.filePath}
      onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)}
      style={{ position:"relative", display:"flex", alignItems:"center", gap:6, paddingLeft:10, paddingRight:8, height:24, cursor:"pointer", borderRadius:4, userSelect:"none", background:hovered?"var(--bg-hover)":"transparent" }}>
      <GitBadge status={st} t={tt} />
      <span style={{fontSize:12,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{rel}</span>
      {/* hover = git 快捷钮（＋/diff/✕，2026-11-24 用户拍板恢复）+ ⋮（文件动作全量菜单，快捷钮 @/🗑/⬇ 隐藏防叠压） */}
      {gitOp ? (
        <span data-fileops style={{ display:"flex", alignItems:"center", gap:2, opacity:hovered?1:0, transition:"opacity 0.12s", flexShrink:0 }}>
          {gitBtn(staged ? ct("git.unstageTitle") : ct("git.stageTitle"), staged ? "−" : "＋", () => gitOp(staged ? "unstage" : "stage", rel), "st")}
          {gitBtn(ct("git.diffTitle"), "diff", () => { void openGitReview({ kind: "file", path: st.filePath }); }, "df")}
          {gitBtn(ct("git.discardTitle"), "✕", () => { const un = untracked && onTrash; const msg = un ? tt("files.discardUntrackedConfirm") : ct("git.discardConfirm", { path: rel }); if (onRequestDiscard) { onRequestDiscard({ title: tt("files.discardTitle"), message: msg, run: () => { if (un) { onTrash({ path: st.filePath, name: st.filePath.split("/").pop() || st.filePath, isDir: false }); } else { gitOp("discard", rel); } } }); } else if (window.confirm(msg)) { if (un) { onTrash({ path: st.filePath, name: st.filePath.split("/").pop() || st.filePath, isDir: false }); } else { gitOp("discard", rel); } } }, "ds", "#d6a84b")}
        </span>
      ) : null}
      <FileOpsMenu filePath={st.filePath} cwd={cwd} root={root} onOpenFile={onOpenFile} onOpenFolder={o.onOpenFolder} onAtMention={onAtMention} onTrash={onTrash} hovered={hovered} t={tt} onRefresh={onRefresh} staged={staged} gitOp={gitOp} gitIgnore={(untracked && onGitIgnore) ? () => onGitIgnore(rel) : null} quickOnly={!!gitOp} onRequestDiscard={onRequestDiscard} gitScope={root} />
    </div>
  );
}

// ── Changes list (extracted from the root changes section, plan §3.4): shared by the root
// section and nested-repo inline sections. Bucket split by xy (index col non-blank & not '?'
// → staged), batch headers with stage/discard-all, per-row actions via ChangedFileRow —
// behavior identical to the pre-extraction root section. Root mode (nested=false) keeps the
// header line (count + additions/deletions) and the borderBottom; nested mode indents with a
// left rule instead. Engine absent (git.avail !== true) → flat read-only rows (no buckets),
// exactly like before. ──
export function ChangesList(p: {
  root: string; cwd: string; git: FolderGit; files: any[];
  stats?: { additions: number; deletions: number } | null;
  nested?: boolean;
  indent?: number;
  onOpenFile: (p: string) => void;
  onOpenFolder?: (p: string, name?: string) => void;
  onAtMention?: (rel: string, b: boolean) => void;
  onTrash?: (x: { path: string; name: string; isDir: boolean }) => void;
  t: TFn;
  onRefresh: () => void;
  onGitIgnore?: (rel: string) => void;
  onRequestDiscard?: (o: { title: string; message: string; run: () => void }) => void;
  /** batch-op feedback (root: header msg slot; nested: local line) */
  onFeedback?: (m: any) => void;
}) {
  const { git, root } = p;
  const t = p.t;
  const setMsg = p.onFeedback;
  const xyMap = new Map((git.refs?.dirtyFiles ?? []).map((f) => [f.path.replace(/\\/g, "/"), f.xy]));
  const relOf = (filePath: string) => (relFromBase(filePath, root) || filePath).replace(/\\/g, "/");
  const relRows = p.files.map((st: any) => ({ st, rel: relOf(st.filePath) }));
  const isStaged = (rel: string) => { const xy = xyMap.get(rel) ?? xyMap.get(rel + "/"); return !!xy && xy[0] !== " " && xy[0] !== "?"; };
  const stagedRows = git.avail === true ? relRows.filter((r) => isStaged(r.rel)) : [];
  const unstagedRows = relRows.filter((r) => !stagedRows.includes(r));

  const rowEl = (r: { st: any; rel: string }) => (
    <ChangedFileRow key={r.st.filePath} st={r.st} root={root} cwd={p.cwd} onOpenFile={p.onOpenFile} onOpenFolder={p.onOpenFolder} onAtMention={p.onAtMention} onTrash={p.onTrash} t={t} onRefresh={p.onRefresh} untracked={r.st.status === "untracked"} onGitIgnore={p.onGitIgnore} onRequestDiscard={p.onRequestDiscard} gitScope={root}
      staged={git.avail === true ? isStaged(r.rel) : undefined}
      gitOp={git.avail === true ? (kind, rel) => { void git.op(kind, rel); } : undefined} />
  );
  const stats = p.stats;
  return (
    <div style={p.nested
      ? { margin: "1px 0 3px", marginLeft: p.indent || 0, padding: "2px 6px 4px 8px", borderLeft: "2px solid var(--border)" }
      : { padding: "0 4px 2px", borderBottom: "1px solid var(--border)" }}>
      {!p.nested ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", fontSize: 12 }}>
          <span style={{ color: "var(--text-dim)" }}>{t("files.changedCount", { count: p.files.length })}</span>
          {stats ? (
            <>
              <span style={{ color: "var(--ok, #4ade80)", fontFamily: "var(--font-mono)" }}>+{stats.additions}</span>
              <span style={{ color: "var(--danger, #f87171)", fontFamily: "var(--font-mono)" }}>-{stats.deletions}</span>
            </>
          ) : null}
        </div>
      ) : null}
      {git.avail === true && stagedRows.length > 0 ? (
        <BucketHead label={ct("git.stagedBucket")} count={stagedRows.length} requestDiscard={p.onRequestDiscard} batches={[
          // Unstage is lossless (files go back to the worktree): no confirm.
          { id: "unstage-all", title: ct("git.unstageTitle") + " ×" + stagedRows.length, label: "−", run: async () => { const st = await git.opPaths("unstage", stagedRows.map((r) => r.rel)); if (st !== 200) setMsg?.({ err: "HTTP " + st }); else setMsg?.({ ok: ct("git.unstageTitle") + " ✓ ×" + stagedRows.length }); } },
          // Discard-all is destructive: in-page confirm (tracked files restore to the last commit).
          { id: "discard-all", title: ct("git.discardTitle") + " ×" + stagedRows.length, label: "✕", color: "#d6a84b", confirm: ct("git.discardConfirm", { path: stagedRows.length + " 个文件" }), run: async () => { const st = await git.opPaths("discard", stagedRows.map((r) => r.rel)); if (st !== 200) setMsg?.({ err: "HTTP " + st }); } },
        ]} />
      ) : null}
      {(git.avail === true ? stagedRows : []).map(rowEl)}
      {git.avail === true ? (
        <BucketHead label={ct("git.unstagedBucket")} count={unstagedRows.length} requestDiscard={p.onRequestDiscard} batches={[
          // Stage is lossless: no confirm.
          { id: "stage-all", title: ct("git.stageTitle") + " ×" + unstagedRows.length, label: "＋", run: async () => { const st = await git.opPaths("stage", unstagedRows.map((r) => r.rel)); if (st !== 200) setMsg?.({ err: "HTTP " + st }); else setMsg?.({ ok: ct("git.stageTitle") + " ✓ ×" + unstagedRows.length }); } },
          // Discard-all is destructive: in-page confirm (tracked restore to last commit;
          // untracked go to the trash, restorable).
          { id: "discard-all", title: ct("git.discardTitle") + " ×" + unstagedRows.length, label: "✕", color: "#d6a84b", confirm: "将丢弃 " + unstagedRows.length + " 个文件的更改？（未跟踪文件移入回收站，已跟踪文件恢复到上次提交）", run: async () => { const st = await git.opPaths("discard", unstagedRows.map((r) => r.rel)); if (st !== 200) setMsg?.({ err: "HTTP " + st }); } },
        ]} />
      ) : null}
      {unstagedRows.map(rowEl)}
    </div>
  );
}

// ── NestedGit · nested-repo chip + inline changes section (plan §2/§3.3) ──
// Mounted by the parent tree row for children detected as carrying their own .git. Owns a
// useFolderGit(dir) instance: every engine call (stage/commit/push/pull/branch panel) runs with
// cwd = the nested repo, and the engine resolves the repo toplevel from that cwd — so commit
// management is fully scoped to the nested repo with zero new server surface. Engine absent →
// /api/git/status fallback: chip still shows with a read-only file list (no op buttons).
// Rows are reported up via onStatus for the tree badge merge; unmount prunes them.
function NestedGit(p: {
  dir: string;
  /** left margin px (aligns the section under the owning row's children) */
  indent: number;
  /** parent-driven re-probe (refreshKey / subtree refresh / live change) */
  bump: number;
  onStatus: (dir: string, files: any[] | null) => void;
  /** a nested write may move the outer repo's submodule pointer → refresh outer git status */
  onGitChanged: () => void;
  onOpenFile: (p: string) => void;
  onOpenFolder?: (p: string, name?: string) => void;
  onAtMention?: (rel: string, b: boolean) => void;
  onTrash?: (x: { path: string; name: string; isDir: boolean }) => void;
  onRequestDiscard: (o: { title: string; message: string; run: () => void }) => void;
  t: TFn;
  cwd: string;
}) {
  const { dir, t: tt } = p;
  const git = useFolderGit(dir);
  const gitRef = useRef(git); gitRef.current = git;
  const [open, setOpen] = useState(false);
  // Engine-absent fallback: /api/git/status answers repo-ness and provides read-only rows.
  const [fb, setFb] = useState<{ files: any[]; isRepo: boolean } | null>(null);
  const [fbStats, setFbStats] = useState<{ additions: number; deletions: number } | null>(null);
  const [localMsg, setLocalMsg] = useState<any>(null);
  // Parent-driven re-probe (bump > previous keeps the initial mount from double-probing).
  const bumpRef = useRef(p.bump);
  useEffect(() => { if (p.bump > bumpRef.current) { bumpRef.current = p.bump; gitRef.current.refresh(); } }, [p.bump]);
  useEffect(() => {
    if (git.avail !== false) return;
    let c = false;
    fetch(apiUrl("/api/git/status"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir }) })
      .then((r) => r.json()).then((st: any) => {
        if (c) return;
        if (st && st.isGitRepository) { setFb({ files: st.files || [], isRepo: true }); setFbStats({ additions: st.additions || 0, deletions: st.deletions || 0 }); }
        else setFb({ files: [], isRepo: false });
      })
      .catch(() => { if (!c) setFb({ files: [], isRepo: false }); });
    return () => { c = true; };
  }, [git.avail, dir]);
  // Rows reported up for the badge merge; engine rows are synthesized from dirtyFiles, fallback
  // rows come from /api/git/status (absolute already).
  const rows = useMemo(
    () => (git.avail === true ? nestedStatusRows(dir, git.refs?.dirtyFiles) : (fb?.isRepo ? fb.files : [])),
    [git.avail, git.refs?.dirtyFiles, dir, fb],
  );
  const onStatusRef = useRef(p.onStatus); onStatusRef.current = p.onStatus;
  useEffect(() => { onStatusRef.current(dir, rows); }, [dir, rows]);
  useEffect(() => () => onStatusRef.current(dir, null), [dir]);
  const branch = git.avail === true ? (git.refs?.current || null) : (fb ? (fb.isRepo ? "Git" : null) : null);
  if (!branch) return null;
  const count = rows.length;
  const stats = git.avail === true ? null : fbStats;
  return (
    <div data-nested-git={dir} style={{ paddingLeft: p.indent }}>
      {/* Fused header bar (plan §2): chip + (expanded) sync + hover action strip + "…" menu — one line
          in both states; ChangesList follows only when open. */}
      <NestedGitBar dir={dir} open={open} onToggleOpen={() => setOpen((v) => !v)} git={git} count={count}
        onChanged={p.onGitChanged} onRequestDiscard={p.onRequestDiscard} onOpenFile={p.onOpenFile}
        onOpenFolder={p.onOpenFolder} t={tt} />
      {open ? (
        <div>
          {git.avail !== true ? (
            <div title={ct("git.nestedFallbackHint")}
              style={{ padding: "1px 0 2px", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              · {ct("git.nestedFallbackHint")}
            </div>
          ) : null}
          <ChangesList nested indent={p.indent} root={dir} cwd={p.cwd || dir} git={git} files={rows} stats={stats}
            onOpenFile={p.onOpenFile} onOpenFolder={p.onOpenFolder} onAtMention={p.onAtMention} onTrash={p.onTrash}
            t={tt} onRefresh={() => { gitRef.current.refresh(); p.onGitChanged(); }}
            onGitIgnore={git.avail === true ? (rel) => { void gitRef.current.ignoreAdd(rel).then(() => gitRef.current.refresh()); } : undefined}
            onRequestDiscard={p.onRequestDiscard} onFeedback={setLocalMsg} />
          {localMsg ? (
            <div style={{ margin: "0 0 3px", marginLeft: p.indent, fontSize: 10, color: localMsg.err ? "var(--danger, #f87171)" : "var(--ok, #4ade80)" }}>
              {localMsg.err || localMsg.ok || ""}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── NestedGitBar · fused one-line header for a nested repo (merge plan §2/§3) ──
// Chip (click = toggle the inline changes section) + sync counters (expanded, engine only) +
// hover-revealed action strip (grouped plan / ☰ / commit) + "…" menu (7 entries, merge plan §3)
// + BranchPanel / CommitDialog / CommitPlanDialog mounts. Hover matrix follows the tree's own
// design: info always visible, actions appear on hover (opacity transition, BucketHead-style);
// menu-open / busy keep the strip visible. Sync confirm flow mirrors git-toolbar.GitBar (kept
// local on purpose: the root GitBar stays untouched).
function NestedGitBar(p: {
  dir: string;
  open: boolean;
  onToggleOpen: () => void;
  git: FolderGit;
  count: number;
  onChanged: () => void;
  onRequestDiscard: (o: { title: string; message: string; run: () => void }) => void;
  onOpenFile: (p: string) => void;
  onOpenFolder?: (p: string, name?: string) => void;
  t: TFn;
}) {
  const { dir, git, open, t: tt } = p;
  const engine = git.avail === true && !!git.refs?.current;
  const [hovered, setHovered] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [toast, setToast] = useState<{ err?: string; ok?: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelAnchor, setPanelAnchor] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const api = useMemo(() => createGitOpsApi({ apiUrl }), []);
  const branch = git.refs?.current || "";
  const count = p.count;
  const ab = git.refs?.aheadBehind ?? null;
  const chipTitle = ct("git.nestedRepoTip") + " · " + branch + (count ? " · " + count : "");
  const busy = syncBusy;
  const visible = hovered || menuOpen || busy || panelOpen;

  // Outside click / scroll closes the "…" menu (fixed-position menus don't follow container scroll).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: any) => { if (!(e.target as Element).closest?.("[data-nested-git-menu]")) setMenuOpen(false); };
    const onWheel = () => setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("wheel", onWheel, { passive: true } as any);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("wheel", onWheel); };
  }, [menuOpen]);

  // Sync (push/pull) — same confirm flow as git-toolbar.GitBar, scoped to this nested repo.
  const runSync = useCallback(async (kind: "push" | "pull") => {
    if (syncBusy) return;
    setSyncBusy(true); setToast(null);
    try {
      const r = kind === "push" ? await api.push(dir, {}) : await api.pull(dir, "ff-only");
      if (r.status !== 200) { setToast({ err: r.data?.error ?? "HTTP " + r.status }); return; }
      setToast({ ok: kind === "push" ? "push ✓" : "pull ✓" });
      git.refresh();
      p.onChanged();
    } finally { setSyncBusy(false); }
  }, [syncBusy, api, dir, p.onChanged]);

  const toggleMenu = (e: any) => {
    e.stopPropagation();
    if (menuOpen) { setMenuOpen(false); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const mh = 260; const menuWidth = 230;
    const left = Math.max(8, Math.min(r.right - menuWidth, window.innerWidth - menuWidth - 8));
    const overflowDown = r.bottom + 4 + mh > window.innerHeight;
    const overflowUp = r.top - mh - 4 < 0;
    let top: number;
    if (overflowDown && !overflowUp) top = Math.max(8, r.top - mh - 4);
    else if (overflowDown && overflowUp) top = 8;
    else top = r.bottom + 4;
    const zf = zoomFactorOf(e.currentTarget);
    setMenuPos({ left: left / zf, top: top / zf });
    setMenuOpen(true);
  };

  const barBtn = (o: { key: string; title: string; onClick: (e: any) => void; children: any; hover?: boolean; color?: string }) => (
    <button key={o.key} type="button" title={o.title} aria-label={o.title} onClick={o.onClick}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 2, height: 18, padding: "0 4px",
        border: "none", background: "none", color: o.color || "var(--text-dim)", cursor: "pointer", borderRadius: 4,
        fontSize: 10.5, fontFamily: "var(--font-mono)", flexShrink: 0,
        opacity: o.hover ? (visible ? 1 : 0) : 1, transition: "opacity 0.12s, color 0.12s" }}>{o.children}</button>
  );

  const menu = (icon: any, label: string, onClick: () => void, key: string) => (
    <button key={key} type="button" onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "5px 10px", border: "none", background: "transparent", color: "var(--text,#222)", cursor: "pointer", textAlign: "left", fontSize: 12, borderRadius: 6, whiteSpace: "nowrap" }}>
      {icon ? <span style={{ display: "inline-flex", flexShrink: 0, width: 13, justifyContent: "center" }}>{icon}</span> : null}{label}
    </button>
  );

  return (
    <div data-nested-git-bar={dir} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onClick={(e) => e.stopPropagation()}
      style={{ display: "flex", alignItems: "center", gap: 3, paddingTop: 1, minWidth: 0 }}>
      <span onClick={p.onToggleOpen} role="button" aria-expanded={open} title={chipTitle} aria-label={chipTitle}
        style={{ display: "inline-flex", alignItems: "center", maxWidth: "100%", minWidth: 0, cursor: "pointer", flexShrink: 1 }}>
        <BranchChipBadge branch={branch} dirtyCount={count} open={open} title={chipTitle} />
      </span>
      {/* Sync counters: always visible when expanded (engine only) — same semantics as the root GitBar */}
      {open && engine && ab && ab[0] > 0 ? barBtn({ key: "push", title: ct("git.pushTitle"), onClick: () => { if (window.confirm(ct("git.pushConfirm", { count: ab[0] }))) void runSync("push"); }, children: <>{ab[0]}<MiArrowUpSmall /></> }) : null}
      {open && engine && ab && ab[1] > 0 ? barBtn({ key: "pull", title: ct("git.pullTitle"), onClick: () => { if (window.confirm(ct("git.pullConfirm", { count: ab[1] }))) void runSync("pull"); }, children: <><MiArrowDownSmall />{ab[1]}</> }) : null}
      {open && engine && ab && ab[0] === 0 && ab[1] === 0 ? <span style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", flexShrink: 0 }}>✓</span> : null}
      <span style={{ flex: 1, minWidth: 0 }} />
      {/* Hover-revealed action strip (expanded only): grouped plan / ☰ / commit */}
      {open ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
          {engine ? barBtn({ key: "plan", hover: true, title: ct("git.planTitle"), onClick: () => { git.refresh(); setPlanOpen(true); }, children: ct("git.planShort") }) : null}
          {barBtn({ key: "tog", hover: true, title: ct("git.changesToggle"), onClick: p.onToggleOpen, children: "☰" })}
          {engine ? barBtn({ key: "commit", hover: true, title: ct("git.commitTitle"), onClick: () => { git.refresh(); setCommitOpen(true); }, children: ct("git.commitShort") }) : null}
        </span>
      ) : null}
      {/* "…" more menu anchor: present in both states, hover-revealed */}
      <button type="button" title={ct("git.moreActions")} aria-label={ct("git.moreActions")} aria-haspopup="menu" aria-expanded={menuOpen} onClick={toggleMenu}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", height: 18, width: 20, padding: 0,
          border: "none", background: menuOpen ? "var(--bg-selected)" : "none", color: menuOpen ? "var(--accent)" : "var(--text-dim)",
          cursor: "pointer", borderRadius: 4, fontSize: 12, fontWeight: 700, lineHeight: 1, flexShrink: 0,
          opacity: visible ? 1 : 0, transition: "opacity 0.12s" }}>…</button>
      {toast ? (
        <span title={toast.err ?? toast.ok} onClick={() => setToast(null)}
          style={{ fontSize: 10, color: toast.err ? "var(--danger, #f87171)" : "var(--text-dim)", cursor: "pointer", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, fontFamily: "var(--font-mono)", flexShrink: 1 }}>
          {toast.err ? "⚠ " + toast.err : toast.ok}
        </span>
      ) : null}
      {menuOpen ? (
        <div data-nested-git-menu="1" style={{ position: "fixed", left: menuPos!.left, top: menuPos!.top, zIndex: 400, minWidth: 220, padding: 6, background: "var(--bg,#fff)", border: "1px solid var(--border,#d0d0d0)", borderRadius: 10, boxShadow: "0 4px 12px rgba(0,0,0,0.15)", fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }} onClick={(e) => e.stopPropagation()}>
          {engine ? menu(<BranchSvg />, ct("git.branchPanelEntry"), () => {
            const el = document.querySelector(`[data-nested-git-menu="1"]`);
            const r = el ? el.getBoundingClientRect() : null;
            setPanelAnchor(r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null);
            setMenuOpen(false); setPanelOpen(true);
          }, "bp") : null}
          {menu(<GrEyeIcon size={13} />, "Git Review", () => { setMenuOpen(false); void openGitReview({ kind: "directory", path: dir }); }, "gr")}
          {engine ? menu(<MiRefresh />, ct("git.refreshRepo"), () => { setMenuOpen(false); git.refresh(); p.onChanged(); }, "rf") : null}
          {menu(null, ct("git.openAsFolderTab"), () => { setMenuOpen(false); const n = lastSeg(dir) || dir; if (p.onOpenFolder) p.onOpenFolder(dir, n); }, "tab")}
          {menu(<TerminalIcon />, tt("files.openTerminal"), () => { setMenuOpen(false); void openTerminal(dir).then((err) => { if (err) setToast({ err }); }); }, "ot")}
          {menu(<NewWindowIcon />, tt("files.openNewWindow"), () => { setMenuOpen(false); openNewWindow("folder", dir); }, "nw")}
          {open ? menu(<MiArrowUp />, ct("git.collapseChanges"), () => { setMenuOpen(false); p.onToggleOpen(); }, "cl") : null}
        </div>
      ) : null}
      {panelOpen ? (
        <BranchPanel apiUrl={apiUrl} cwd={dir} floatKey="folder-nested-branch-panel" locale={typeof navigator !== "undefined" ? navigator.language : "en"}
          open={panelOpen} onClose={() => setPanelOpen(false)} anchor={panelAnchor} extSvc={extSvc}
          openFile={(fp) => openFile(fp, fp.split("/").pop())}
          onChanged={() => { git.refresh(); p.onChanged(); }} />
      ) : null}
      {commitOpen ? (
        <CommitDialog root={dir} dirtyFiles={git.refs?.dirtyFiles ?? []} onClose={() => setCommitOpen(false)}
          onDone={() => { setCommitOpen(false); git.refresh(); p.onChanged(); }} />
      ) : null}
      {planOpen ? (
        <CommitPlanDialog root={dir} git={git} onClose={() => setPlanOpen(false)} />
      ) : null}
    </div>
  );
}

// Small sync arrows (local copies of git-toolbar's private MiArrowUp/DownSmall, same shapes).
function MiArrowUpSmall() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 11 12 6 7 11" /><line x1="12" y1="6" x2="12" y2="20" /></svg>;
}
function MiArrowDownSmall() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="7 13 12 18 17 13" /><line x1="12" y1="18" x2="12" y2="4" /></svg>;
}

// Small branch glyph for the menu row (same 16-viewBox shape as BranchChipBadge's icon).
function BranchSvg() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ flexShrink: 0 }} aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.8" /><circle cx="4" cy="12.5" r="1.8" /><circle cx="12" cy="3.5" r="1.8" />
      <path d="M4 5.3v5.4M12 5.3c0 3-3 3.6-6 4.1" />
    </svg>
  );
}


function TreeNode(o: any) {
  const node=o.node, depth=o.depth, cwd=o.cwd, expanded=o.expanded, onToggle=o.onToggle, onOpenFile=o.onOpenFile, onOpenFolder=o.onOpenFolder, onAtMention=o.onAtMention, onTrash=o.onTrash, onChanged=o.onChanged, gitByPath=o.gitByPath, changedDirs=o.changedDirs, hlPath=o.highlightPath, tt=o.t, root=o.root;
  const isGitRepo: boolean = o.isGitRepo === true; // parent scan says this dir carries its own .git
  const parentGitScope: string = o.gitScope || root; // nearest repo dir at or above self
  const onNestedStatus: (dir: string, files: any[] | null) => void = o.onNestedStatus || (() => {});
  const onGitChanged: () => void = o.onGitChanged || (() => {});
  const onRequestDiscard: undefined | ((o: { title: string; message: string; run: () => void }) => void) = o.onRequestDiscard;
  const selMode: boolean = o.selMode === true;
  const selSelected: boolean = o.selSelected === true;
  const onSelectRow: undefined | ((fp: string, on: boolean) => void) = o.onSelectRow;
  const showIgnored: boolean = o.showIgnored === true;
  const showIgnoredRef = useRef(showIgnored); showIgnoredRef.current = showIgnored;
  const refreshKey: number = o.refreshKey ?? 0;
  const [children, setChildren] = useState<any[]>(node.children||[]);
  const [loaded, setLoaded] = useState<boolean>(node.loaded||false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  // 子树刷新序号：本节点被强拉时递增，向下传给已挂载的子孙节点，实现只刷本子树不动其他分支
  const [downSeq, setDownSeq] = useState(0);
  const parentSeq: number = o.refreshSeq ?? 0;
  const open = expanded.has(node.fullPath);
  // Only the newest concurrent fetch may land (a late response must not overwrite the list or clear loading).
  const loadGenRef = useRef(0);
  const loadChildren = useCallback(async (force?: boolean)=>{ if(loaded&&!force) return; const gen=++loadGenRef.current; setLoading(true); try{ const e=await fetchEntries(apiUrl, node.fullPath, { force, showIgnored: showIgnoredRef.current }); if(gen!==loadGenRef.current) return; setChildren(e); setLoaded(true);}catch{/* noop */}finally{ if(gen===loadGenRef.current) setLoading(false); } }, [loaded, node.fullPath]);
  useEffect(()=>{ if(open&&!loaded) loadChildren(); }, [open, loaded, loadChildren]);
  // Nested-repo detection among children (plan §3.5): scan once children are listed; forced
  // paths (refresh / live change / parent subtree refresh) invalidate the scan cache first so
  // the rescan is real. scanSeq doubles as the NestedGit re-probe bump.
  const [childRepos, setChildRepos] = useState<string[]>(() => peekNestedRepos(node.fullPath) ?? []);
  const [scanSeq, setScanSeq] = useState(0);
  // Subtree reload with nested-scan invalidation: every forced path goes through here.
  const reloadSubtree = useCallback(()=>{ invalidateNestedRepos(node.fullPath); setScanSeq((s)=>s+1); loadChildren(true); }, [loadChildren, node.fullPath]);
  useEffect(() => {
    if (!loaded) return;
    let c = false;
    fetchNestedRepos(apiUrl, node.fullPath).then((rs) => { if (!c) setChildRepos((prev) => (prev.length === rs.length && prev.every((p, i) => p === rs[i])) ? prev : rs); }).catch(() => { /* keep the previous list */ });
    return () => { c = true; };
  }, [loaded, children, node.fullPath]);
  // 根工具栏「刷新」：refreshKey 变化时已加载过的子树强制重拉（含折叠态，再展开即新内容）
  const rkRef = useRef(refreshKey);
  useEffect(()=>{ if(rkRef.current===refreshKey) return; rkRef.current=refreshKey; if(loaded) reloadSubtree(); }, [refreshKey, loaded, reloadSubtree]);
  // 父节点发起的子树刷新：强拉自己并继续向自己的子树传播
  const seqRef = useRef(parentSeq);
  const downSeqRef = useRef(0);
  useEffect(()=>{ if(seqRef.current===parentSeq) return; seqRef.current=parentSeq; if(loaded){ reloadSubtree(); downSeqRef.current+=1; setDownSeq(downSeqRef.current); } }, [parentSeq, loaded, reloadSubtree]);
  // 目录内发生变更（新建/上传/删除）：已展开时 force 刷新本子树，再冒泡到根刷新。
  const handleChanged = useCallback((changedDir?: string)=>{
    if(changedDir && (changedDir === node.fullPath || changedDir.startsWith(node.fullPath + "/"))) reloadSubtree();
    onChanged?.(changedDir);
  }, [node.fullPath, reloadSubtree, onChanged]);
  // 目录菜单「刷新」：只递归刷新本目录子树（自拉 + 向下传播），不冒泡到根、不闪全树
  const handleRefreshTree = useCallback(()=>{
    reloadSubtree();
    if(loaded){ downSeqRef.current+=1; setDownSeq(downSeqRef.current); }
  }, [loaded, reloadSubtree]);
  // Directory live watch (borrow plan §2.4): watch expanded dirs only (DSH perf discipline); frame →
  // invalidate cache + force-reload this subtree; trailing throttle merges bursts. Ignored dirs are
  // not watched at all: their churn never changes a listing or a git badge. `onLiveChange` lets the
  // root refresh git badges (throttled) without re-fetching the whole tree.
  const watchThrottleRef = useRef(0);
  useEffect(()=>{
    if(!open || !loaded || node.ignored) return;
    return watchDir(node.fullPath, ()=>{
      const now = Date.now();
      if(now - watchThrottleRef.current < 600) return;
      watchThrottleRef.current = now;
      invalidateEntries(node.fullPath);
      reloadSubtree();
      o.onLiveChange?.();
    });
  }, [open, loaded, node.fullPath, node.ignored, reloadSubtree, o.onLiveChange]);
  // 点击处理：点前半段（文件名附近）开文件/展开；点后部触发操作区（小屏无悬停等效）。
  // 搜索结果里的命中目录同样展开（懒加载真实内容）；要新 tab 打开用 hover 的「打开」按钮。
  const handleClick = useCallback(()=>{ if(node.isDir){ const n=!open; onToggle(node.fullPath, n); if(n&&!loaded) loadChildren(); } else { onOpenFile(node.fullPath); } }, [node, open, loaded, loadChildren, onOpenFile, onToggle]);
  const handleRowClick = useCallback((e: any)=>{
    if(node.isDir) return; // 目录行不用
    if(e.target.closest("[data-fileops]")) return; // 点操作区不冒泡
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    // 点后 40% 等效悬停，显示操作区（大小屏一致）
    if(relX>=0.6){ setHovered(true); return; }
    // 点行其余区域 → 开文件
    handleClick();
  }, [node.isDir, handleClick]);
  const norm = normSlash(node.fullPath)!;
  const git = gitByPath.get(norm);
  const containsGit = node.isDir && (git!==undefined || changedDirs.has(norm));
  // Nearest repo dir at or above self: this row's own menus (Git Review) scope there.
  const myScope = isGitRepo ? node.fullPath : parentGitScope;
  const indent = 8 + (depth + 1) * 14;
  return (
    <div key="row">
      <div key="row-inner" data-file-node={node.fullPath} onClick={node.isDir?handleClick:handleRowClick} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)}
        draggable={!node.isDir}
        onDragStart={(e:any)=>{ try { e.dataTransfer.setData("text/plain", buildAtText(node.fullPath) + " "); e.dataTransfer.setData("application/x-aiti-file-path", node.fullPath); e.dataTransfer.effectAllowed = "copyLink"; } catch { /* noop */ } }}
        style={{ position:"relative", display:"flex", alignItems:"center", gap:4, paddingLeft:8+depth*14, paddingRight:8, height:24, cursor:"pointer", background: node.fullPath===hlPath ? "rgba(79,142,247,0.18)" : (selSelected?"rgba(79,142,247,0.10)":(hovered?"var(--bg-hover)":"transparent")), borderRadius:4, userSelect:"none" }}>
        {selMode && !node.isDir ? (
          <input type="checkbox" checked={selSelected} aria-label={tt("sidebar.multiselect")}
            onClick={(e:any)=>e.stopPropagation()}
            onChange={(e:any)=>onSelectRow?.(node.fullPath, e.target.checked === true)}
            style={{ width:11, height:11, margin:0, flexShrink:0, accentColor:"var(--accent)", cursor:"pointer" }} />
        ) : null}
        {node.isDir ? (
          <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0, transform:open?"rotate(90deg)":"none", transition:"transform 0.1s"}}><polyline points="3 2 7 5 3 8"/></svg>
        ) : <span style={{width:10,flexShrink:0}} />}
        <span style={{flexShrink:0, display:"flex", alignItems:"center"}}>{node.isDir?<FolderIcon open={open}/>:(<NodeIcon name={node.name}/>)}</span>
        <span style={{fontSize:12, color: node.ignored ? "var(--text-dim, #777)" : "var(--text)", fontStyle: node.ignored ? "italic" : "normal", opacity: node.ignored ? 0.75 : 1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1}} title={node.ignored ? (node.name === ".git" ? ct("files.ignoredGitInternalTip", { path: node.fullPath }) : ct("files.ignoredByRulesTip", { path: node.fullPath })) : node.fullPath}>{node.name}</span>
        {loading ? <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth={2} strokeLinecap="round" style={{animation:"spin 0.8s linear infinite"}}><path d="M21 12a9 9 0 1 1-5.7-8.4"/></svg> : null}
        {(!hovered && !node.isDir && git) ? <GitBadge status={git} t={tt} /> : null}
        {(!hovered && containsGit) ? (
          <span title={tt("files.containsChangedFiles")} aria-label={tt("files.containsChangedFiles")} style={{width:14,height:14,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{width:6,height:6,borderRadius:"50%",background:"#d6a84b"}} />
          </span>
        ) : null}
        {(node.isDir) ? <DirOpsMenu dir={node.fullPath} hovered={hovered} onChanged={handleChanged} onRefresh={handleRefreshTree} onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onAtMention={onAtMention} onTrash={onTrash} t={tt} root={root} cwd={cwd} gitScope={myScope} /> : null}
        {(node.isDir && hovered) ? (
          <button onClick={e=>{e.stopPropagation(); handleRefreshTree();}} title={tt("files.refresh")} aria-label={tt("files.refresh")}
            style={{position:"absolute",right:128,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",justifyContent:"center",height:20,width:22,padding:0,background:"var(--bg-panel)",border:"1px solid var(--border)",borderRadius:4,color:"var(--text-muted)",cursor:"pointer"}}><MiRefresh/></button>
        ) : null}
        {(node.isDir && hovered && onAtMention) ? (
          <button onClick={e=>{e.stopPropagation(); onAtMention(relTo(node.fullPath,cwd),false);}} title={tt("files.insertPathTitle")}
            style={{position:"absolute",right:80,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",justifyContent:"center",height:20,width:22,padding:0,background:"var(--bg-panel)",border:"1px solid var(--border)",borderRadius:4,color:"var(--accent)",cursor:"pointer",fontSize:11,fontWeight:700}}>@</button>
        ) : null}
        {(node.isDir && hovered) ? (
          <button onClick={e=>{e.stopPropagation(); openNewWindow("folder", node.fullPath);}} title={tt("files.openNewWindow")}
            style={{position:"absolute",right:104,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",justifyContent:"center",height:20,width:22,padding:0,background:"var(--bg-panel)",border:"1px solid var(--border)",borderRadius:4,color:"var(--accent)",cursor:"pointer",fontSize:11}}><NewWindowIcon/></button>
        ) : null}
        {(node.isDir && hovered) ? (
          <button onClick={e=>{e.stopPropagation(); onOpenFolder(node.fullPath, node.name);}} title={tt("files.openInPanel")}
            style={{position:"absolute",right:32,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",justifyContent:"center",height:20,padding:"0 8px",background:"var(--bg-panel)",border:"1px solid var(--border)",borderRadius:4,color:"var(--accent)",cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap"}}>{tt("files.open")}</button>
        ) : null}
        {(!node.isDir && (onAtMention||onTrash)) ? <FileOpsMenu filePath={node.fullPath} cwd={cwd} root={root} onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onAtMention={onAtMention} onTrash={onTrash} hovered={hovered} t={tt} onRefresh={handleChanged} gitScope={parentGitScope} /> : null}
      </div>
      {/* Nested git repo chip + inline changes section (mounted when the parent scan flagged this dir) */}
      {(node.isDir && isGitRepo) ? (
        <NestedGit dir={node.fullPath} indent={indent} bump={scanSeq} onStatus={onNestedStatus} onGitChanged={onGitChanged}
          onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onAtMention={onAtMention} onTrash={onTrash}
          onRequestDiscard={onRequestDiscard || ((o: any) => { try { if (window.confirm(o.message)) o.run(); } catch { /* noop */ } })}
          t={tt} cwd={cwd} />
      ) : null}
      {(node.isDir && open) ? (
        <div key="tree">
          {children.map((ch:any)=> <TreeNode key={ch.fullPath} node={ch} depth={depth+1} cwd={cwd} expanded={expanded} refreshSeq={downSeq} onToggle={onToggle} onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onAtMention={onAtMention} onTrash={onTrash} onChanged={onChanged} onLiveChange={o.onLiveChange} gitByPath={gitByPath} changedDirs={changedDirs} highlightPath={hlPath} t={tt} root={root} showIgnored={showIgnored} selMode={selMode} selSelected={selSelected} onSelectRow={onSelectRow}
            isGitRepo={childRepos.includes(ch.fullPath)}
            gitScope={childRepos.includes(ch.fullPath) ? ch.fullPath : myScope}
            onNestedStatus={onNestedStatus} onGitChanged={onGitChanged} onRequestDiscard={onRequestDiscard} />)}
          {(children.length===0 && loaded) ? <div key="empty" style={{paddingLeft:8+(depth+1)*14,fontSize:11,color:"var(--text-dim)",height:22,display:"flex",alignItems:"center"}}>{tt("files.noFiles")}</div> : null}
        </div>
      ) : null}
    </div>
  );
}


const REFRESH_CSS_ID = "aiti-folder-refresh-css";
/** The calm 2px refresh strip's keyframes (once per document). */
function ensureRefreshCss(): void {
  try {
    if (typeof document === "undefined" || document.getElementById(REFRESH_CSS_ID)) return;
    const el = document.createElement("style");
    el.id = REFRESH_CSS_ID;
    el.textContent = "@keyframes aiti-folder-refresh-pulse { 0%,100% { opacity: .25 } 50% { opacity: .85 } }";
    document.head.appendChild(el);
  } catch { /* no DOM (test stub) */ }
}

export function FolderBrowser(props: any) {
  const dense = props.dense === true; // sidebar 窄容器形态（FolderDockBlock）：工具栏横向可滚
  useEffect(()=>{ ensureRefreshCss(); }, []);
  // 本 folder 的「显示忽略项」开关（单 folder 粒度；开启后请求带 showIgnored=1，忽略条目置灰显示）
  const showIgnored = props.showIgnored === true;
  // v3 dock 头单行化（方案 pi-web-dock-header-toolbar-plan §2.8）：传 dockItemKey = 本实例
  // 嵌入 dock 区块——工具条整行移除（按钮上提头行），命令/状态/菜单经 store 与 face 互通。
  const dockItemKey: string | undefined = typeof props.dockItemKey === "string" && props.dockItemKey ? props.dockItemKey : undefined;
  const dockHoist = Boolean(dockItemKey);
  const root0: string = props.filePath; const cwd: string = props.cwd;
  const onOpenFile = props.onOpenFile || (()=>{}); const onOpenFolder = props.onOpenFolder || (()=>{}); const onAtMention = props.onAtMention;
  // 初始化：存活期内有快照 → 直接恢复展开状态与目录列表（切回零请求秒开，不闪 loading）
  const restoredRef = loadExpandedSnapshot(root0);
  const cachedRootsRef = peekEntries(root0, showIgnored);
  const cachedListRef = peekList(root0, showIgnored);
  const [root, setRoot] = useState(root0);
  const [roots, setRoots] = useState<any[]>(cachedRootsRef ?? []);
  // 可上溯的父目录（后端按允许 file roots 判定；null = 已在可浏览边界，隐藏「上一个目录」按钮）
  const [parent, setParent] = useState<string | null>(cachedListRef?.parentPath ?? null);
  const [loading, setLoading] = useState(!cachedListRef); // Placeholder only without a cached listing (an expanded snapshot alone still counts as a first load).
  const [refreshing, setRefreshing] = useState(false); // Thin top strip: the old tree stays visible while new data loads.
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(()=>restoredRef ?? new Set());
  const [gitFiles, setGitFiles] = useState<any[]>([]);
  const [gitStats, setGitStats] = useState({additions:0,deletions:0});
  const [refreshKey, setRefreshKey] = useState(0);
  const [gitBump, setGitBump] = useState(0); // Directory live change → refresh git badges only, never re-fetch the tree.
  const [refreshDone, setRefreshDone] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<any>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  // dock 模式 + 按钮的头行锚点（face 经 request payload 传入；非 dock 模式用 plusRef 工具栏锚点）
  const [plusAnchor, setPlusAnchor] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null);
  const [newKind, setNewKind] = useState<string | null>(null); // "file" | "folder" | null
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [pendingTrash, setPendingTrash] = useState<any>(null); // { path, name, isDir } | null
  const [trashBusy, setTrashBusy] = useState(false);
  // 页内「放弃更改」确认弹窗（替代 window.confirm——2026-11-24 用户拍板）：{ title, message, run }
  const [pendingDiscard, setPendingDiscard] = useState<{ title: string; message: string; run: () => void } | null>(null);
  const requestDiscard = useCallback((o: { title: string; message: string; run: () => void }) => setPendingDiscard(o), []);
  const [highlightPath, setHighlightPath] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const dirUploadInputRef = useRef<HTMLInputElement | null>(null);
  const plusRef = useRef<HTMLDivElement | null>(null);
  // + 菜单固定定位（2026-09）：absolute 锚定会被两层 overflow 裁掉——dense 工具栏行自身
  // overflowX:auto（CSS 规则另一轴同时变 auto = 滚动容器），外层 sidebar-container/
  // StackCell/DockBody 全 hidden，菜单向下弹即被整段裁没（点了显示不出来）。改 fixed
  // 锚定 + 按钮矩形：首帧离屏 → 测量 → 下开（底部装不下且上方更宽则上翻）→ 视口钳制
  // （popup-anchor；transformed 祖先构成 fixed containing block 时按其原点校正）。
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const [plusPos, setPlusPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!plusOpen) return;
    const menu = plusMenuRef.current;
    if (!menu) return;
    // dock 模式：锚点 = 头行按钮矩形（命令 payload 传入）；非 dock：工具栏 + 按钮
    const a = plusAnchor ?? (plusRef.current ? plusRef.current.getBoundingClientRect() : null);
    if (!a) return;
    const m = menu.getBoundingClientRect();
    const gap = 4, pad = 8;
    let top = a.bottom + gap;
    const below = window.innerHeight - pad - top;
    const above = a.top - gap - pad;
    if (m.height > below && above > below) top = a.top - gap - m.height; // 上翻
    const c = clampToViewport(a.left, top, m.width, m.height, pad);
    const o = fixedOrigin(menu);
    const z = zoomFactorOf(menu);
    const next = { left: (c.left - o.x) / z, top: (c.top - o.y) / z };
    setPlusPos((cur) => (cur && cur.left === next.left && cur.top === next.top) ? cur : next);
  }, [plusOpen, newKind, plusAnchor]);
  // fixed 菜单不随内容滚（工具栏横向滚/树滚 → 滞留旧位 = 错位），任意容器滚动即关。
  useEffect(() => {
    if (!plusOpen) return;
    const onScroll = () => setPlusOpen(false);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [plusOpen]);
  // ⋯ 更多菜单（目录级共享菜单：与文件顶栏 aiti-editor FileToolbar 的 ⋯ 集合对齐 + 目录特有项）
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePos, setMorePos] = useState<{ left: number; top: number } | null>(null);
  const [moreRename, setMoreRename] = useState(false);
  const [moreRenameName, setMoreRenameName] = useState("");
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreInfoOpen, setMoreInfoOpen] = useState(false);
  // 根目录移动/复制弹窗：null=关，"move"/"copy"=弹窗模式（共用 TransferDialog）
  const [moreTransfer, setMoreTransfer] = useState<null | "move" | "copy">(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  // ── 钉住 + 批量关闭（对齐 aiti-editor ⋯ 菜单 5 条；作用域=folder tab）──
  // 钉住定义 = 区块清单 pin（一个定义一个展示，跨面同步）；翻转后事件回灌驱动菜单 ✓ 刷新
  const [, setUiTick] = useState(0);
  // 当前 tab id：fileViewer props.filePath 是 tab 打开路径（内部切根不回写宿主）→ "folder:"+root0 恒可定位本 tab
  const tabId = folderTabId(root0);
  // dock 面板形态感知：非 closed（docked/floating）= 停靠/浮窗面（TabBar id = dock:<key>，
  // 关闭须走状态机 closePanel）；closed = 旧式独立 fileViewer folder tab（走 closeFileTabs）。
  const panelKey = folderItemKey(root0);
  const panelState = usePresent(panelKey);
  const isDockPanel = panelState !== "closed";
  const isTabPinned = () => isFolderPinned(root0);
  const toggleTabPin = () => {
    toggleFolderPin(root0);
    setUiTick((n) => n + 1);
    setUploadMsg({ ok: isFolderPinned(root0) ? t("files.pinDone") : t("files.unpinDone") });
  };
  // 关闭当前 folder 面板/tab（无脏状态，直接关；批量关闭见 batchCloseTabs）
  const closeCurrentTab = () => { if (isDockPanel) closePanel(panelKey); else closeFileTabs([tabId]); };
  // 批量关闭 folder tab：all/left/right；钉住的不关；当前 tab 不在批量范围（用「关闭」单独处理）。
  // 文件 tab 不碰：脏确认归 aiti-editor（其批量关闭也跳过 folder tab，两类 tab 互不越界）
  const batchCloseTabs = (mode: "all" | "left" | "right") => {
    const tabs = getFileTabs().filter((x) => x.kind === "folder");
    const activeIdx = tabs.findIndex((x) => x.id === tabId);
    const targets = tabs.filter((x, i) => {
      if (x.id === tabId) return false;
      const p = x.id.startsWith("folder:") ? x.id.slice("folder:".length) : "";
      if (x.pinned || (p && isFolderPinned(p))) return false; // 钉住不受批量关闭影响
      if (mode === "all") return true;
      if (mode === "left") return i < activeIdx;
      if (mode === "right") return i > activeIdx;
      return false;
    });
    if (targets.length === 0) return;
    closeFileTabs(targets.map((x) => x.id));
    setUploadMsg({ ok: t("files.batchClosed", { count: targets.length }) });
  };
  // ── 文件搜索（对齐 pi-web 原版 FileExplorer）：/api/file-index 复用 @ mention 缓存索引，
  // 结果 buildSearchTree 折叠成树（预展开含匹配的祖先目录；有查询时替换普通树）──
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [dirHits, setDirHits] = useState<Set<string>>(new Set()); // 命中目录（相对路径）——展开时懒加载真实全量内容，区别于纯祖先的过滤视图
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const hasSearchQuery = searchQuery.trim().length > 0;
  // ── 正文模式（P2 文档全文检索，复用 aiti-doc-center services.docs，经本扩展 server 代理）──
  const [searchMode, setSearchMode] = useState<"files" | "fulltext" | "content">("files");
  // ── Content mode (borrow plan §2.5: workspace ripgrep bounded search via this extension's server content-search) ──
  const [contentMatches, setContentMatches] = useState<any[]>([]);
  const [contentTruncated, setContentTruncated] = useState(false);
  const [contentFiles, setContentFiles] = useState(0);
  const [rgAvailable, setRgAvailable] = useState<boolean | null>(null); // null = unknown; false = rg absent (hide the content tab)
  const [docItems, setDocItems] = useState<any[]>([]);
  const [docsAvailable, setDocsAvailable] = useState<boolean | null>(null); // null=未知（页签默认显示；首次请求后由 server available 定）
  const [fullScope, setFullScope] = useState(false); // 跳过当前 root 前缀过滤，看全部 workspace 的命中
  // ── Multi-select batch actions (borrow plan §2.6: check arbitrary files → @ new session / trash; file-row checkboxes) ──
  const [selMode, setSelMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selBusy, setSelBusy] = useState(false);
  const toggleSelectRow = useCallback((fp: string, on: boolean) => {
    setSelectedPaths(prev => { const n = new Set(prev); if (on) n.add(fp); else n.delete(fp); return n; });
  }, []);
  const exitSelMode = useCallback(() => { setSelMode(false); setSelectedPaths(new Set()); }, []);
  // Batch @ into a new session: one @-mention per line (multi-line text brought in at once)
  const batchAtNew = useCallback(async () => {
    if (selectedPaths.size === 0) return;
    try {
      const text = [...selectedPaths].map((p) => buildAtText(p)).join("\n");
      await openNewSessionWithExtSvc({ text, targetDir: root, targetPath: root, currentCwd: cwd, apiUrl, extSvc });
    } catch { /* noop */ }
  }, [selectedPaths, root, cwd]);
  // Batch trash: POST /trash {paths[]} (system trash, recoverable) → invalidate cache + refresh + clear selection
  const batchTrash = useCallback(async () => {
    if (selectedPaths.size === 0 || selBusy) return;
    setSelBusy(true);
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-folder/trash"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: [...selectedPaths] }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setUploadMsg({ err: d.error || ("HTTP " + r.status) }); return; }
      setUploadMsg({ ok: t("sidebar.batchTrashDone", { n: selectedPaths.size }) });
      setSelectedPaths(new Set());
      invalidateEntries(root);
      setRefreshKey(k => k + 1); // the /api/git/status effect depends on refreshKey — badges re-pull with it
    } catch (e: any) { setUploadMsg({ err: e && e.message ? e.message : String(e) }); }
    finally { setSelBusy(false); }
  }, [selectedPaths, selBusy, root]);
  // 最新 root/expanded 镜像：卸载/切根时写快照用
  const stateRef = useRef({ root, expanded });
  stateRef.current = { root, expanded };
  useEffect(() => () => saveExpandedSnapshot(stateRef.current.root, stateRef.current.expanded), []);
  useEffect(()=>{ setRoot(root0); }, [root0]);
  // 切换目录/工作区：搜索展开集按绝对路径存，旧 root 的集合全部失效，清空（输入保留，防抖请求按新 root 自动重发）
  useEffect(()=>{ setSearchExpanded(new Set()); setDirHits(new Set()); setDocItems([]); setContentMatches([]); }, [root0]);
  // 搜索请求（文件模式）：150ms 防抖 + AbortController（仅输入变化竞态取消；切目录立即重搜）。
  // 文件与目录条目都保留——目录命中可展开查看真实全量内容。
  useEffect(() => {
    if (!searchOpen || searchMode !== "files") return;
    const query = searchQuery.trim();
    if (!query) { setSearchPaths([]); setDirHits(new Set()); setSearchLoading(false); setSearchError(false); return; }
    const controller = new AbortController();
    setSearchLoading(true); setSearchError(false);
    const timer = setTimeout(() => {
      // POST body 传 cwd/q：绝对路径不进 URL（访问日志/代理日志安全）
      fetch(apiUrl("/api/file-index"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: root, q: query }),
        signal: controller.signal,
      })
        .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
        .then((d: any) => {
          const ms = (d.matches || []) as any[];   // 文件与目录都保留（目录条目服务端已参与评分 +10）
          setSearchPaths(ms.map((e: any) => e.path as string));
          setDirHits(new Set(ms.filter((e: any) => e.isDir).map((e: any) => e.path as string)));
        })
        .catch(() => { if (!controller.signal.aborted) { setSearchPaths([]); setSearchError(true); } })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [root, searchOpen, searchMode, searchQuery]);
  // 搜索请求（正文模式）：同款防抖，走本扩展 server 代理（server 进程内消费 doc-center services.docs）。
  // server 拉全量（limit 200），当前 root 前缀过滤在客户端做——doc-center 的 under 按「收集时 root」前缀匹配，
  // 子目录 root 下搜不到父 workspace 收集的文档（方案 §5.2）。
  useEffect(() => {
    if (!searchOpen || searchMode !== "fulltext") return;
    const query = searchQuery.trim();
    if (!query) { setDocItems([]); setSearchLoading(false); setSearchError(false); return; }
    const controller = new AbortController();
    setSearchLoading(true); setSearchError(false);
    const timer = setTimeout(() => {
      fetch(apiUrl("/api/extensions/aiti-folder/doc-search"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: query, limit: 200 }),
        signal: controller.signal,
      })
        .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
        .then((d: any) => {
          if (d.available !== true) {
            // doc-center 未装/未启用：隐藏「正文」页签、回落文件模式、通知一次
            setDocsAvailable(false);
            setSearchMode("files");
            setDocItems([]);
            setUploadMsg({ err: t("sidebar.docCenterUnavailable") });
            return;
          }
          setDocsAvailable(true);
          setDocItems(Array.isArray(d.items) ? d.items : []);
        })
        .catch(() => { if (!controller.signal.aborted) { setDocItems([]); setSearchError(true); } })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [root, searchOpen, searchMode, searchQuery]);
  // Content-mode request (borrow plan §2.5): same debounce; server ripgrep bounded (≤200 matches / 60 files / 8s),
  // rg absent → hide the tab and fall back to files mode; stale responses dropped via request seq (spawn cannot AbortController).
  const contentReqSeq = useRef(0);
  useEffect(() => {
    if (!searchOpen || searchMode !== "content") return;
    const query = searchQuery.trim();
    if (!query) { setContentMatches([]); setContentTruncated(false); setContentFiles(0); setSearchLoading(false); setSearchError(false); return; }
    const seq = ++contentReqSeq.current;
    setSearchLoading(true); setSearchError(false);
    const timer = setTimeout(() => {
      fetch(apiUrl("/api/extensions/aiti-folder/content-search"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root, q: query }),
      })
        .then(r => r.json().then((d: any) => ({ status: r.status, d })).catch(() => ({ status: r.status, d: null })))
        .then(({ status, d }) => {
          if (seq !== contentReqSeq.current) return; // stale
          if (d && d.rgMissing) { setRgAvailable(false); setSearchMode("files"); setUploadMsg({ err: t("sidebar.rgUnavailable") }); return; }
          if (status !== 200 || !d?.ok) { setContentMatches([]); setSearchError(true); return; }
          setRgAvailable(true);
          setContentMatches(Array.isArray(d.matches) ? d.matches : []);
          setContentTruncated(d.truncated === true);
          setContentFiles(Number(d.files) || 0);
        })
        .catch(() => { if (seq === contentReqSeq.current) { setContentMatches([]); setSearchError(true); } })
        .finally(() => { if (seq === contentReqSeq.current) setSearchLoading(false); });
    }, 150);
    return () => clearTimeout(timer);
  }, [root, searchOpen, searchMode, searchQuery]);
  // Group content results (keep rg relevance order; 3 preview lines per file)
  const contentGroups = useMemo(() => groupContentMatches(contentMatches, 3), [contentMatches]);
  // 打开搜索条时自动聚焦输入框
  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);
  // 结果渲染成树：含匹配文件的祖先目录自动展开（只增不删，保留用户手动折叠）
  useEffect(() => {
    if (searchPaths.length === 0) return;
    const dirs = new Set<string>();
    for (const relative of searchPaths) {
      const parts = relative.split("/");
      let path = "";
      for (let i = 0; i < parts.length - 1; i++) { path = path ? path + "/" + parts[i] : parts[i]; dirs.add(joinPath(root, path)!); }
    }
    setSearchExpanded(prev => {
      let changed = false; const next = new Set(prev);
      for (const dir of dirs) if (!next.has(dir)) { next.add(dir); changed = true; }
      return changed ? next : prev;
    });
  }, [root, searchPaths]);
  const searchRoots = useMemo(() => {
    // 命中目录（即使无子命中、树角色为叶子）也纠正为目录节点；
    // 展开时懒加载真实全量内容（不过滤）；纯祖先目录保持预填充命中子树（过滤视图）
    const toNode = (n: SearchTreeNode): any => {
      const isHitDir = dirHits.has(n.path);
      return { name: n.name, fullPath: joinPath(root, n.path), isDir: n.isDir || isHitDir, size: 0, children: isHitDir ? [] : n.children.map(toNode), loaded: !isHitDir };
    };
    return buildSearchTree(searchPaths).map(toNode);
  }, [root, searchPaths, dirHits]);
  // 开/关搜索：关闭时清空输入与结果、模式复位文件（下次打开是干净状态）
  const toggleSearch = useCallback(() => {
    if (searchOpen) { setSearchOpen(false); setSearchQuery(""); setSearchPaths([]); setDirHits(new Set()); setDocItems([]); setSearchError(false); setSearchLoading(false); setSearchExpanded(new Set()); setSearchMode("files"); setContentMatches([]); setContentTruncated(false); setContentFiles(0); }
    else setSearchOpen(true);
  }, [searchOpen]);
  // Locate in tree (borrow plan §2.5): close search (normal tree renders again) → reuse the folder-reveal chain (expand ancestors + highlight + scroll)
  const locateInTree = useCallback((target: string) => {
    if (searchOpen) { setSearchOpen(false); setSearchQuery(""); setSearchPaths([]); setDirHits(new Set()); setDocItems([]); setSearchError(false); setSearchLoading(false); setSearchExpanded(new Set()); setSearchMode("files"); setContentMatches([]); setContentTruncated(false); setContentFiles(0); }
    try {
      const detail = { root, target };
      window.dispatchEvent(new CustomEvent("pi-web:folder-reveal", { detail }));
      (window as any).__piFolderRevealLast = { ...detail, ts: Date.now() };
    } catch { /* noop */ }
  }, [searchOpen, root]);
  // 切换文件/正文模式：清两模式各自结果（输入保留，防抖请求按新模式自动重发）
  const switchSearchMode = useCallback((m: "files" | "fulltext" | "content") => {
    if (m === searchMode) return;
    setSearchMode(m); setSearchPaths([]); setDirHits(new Set()); setDocItems([]); setSearchError(false); setSearchLoading(false);
    setContentMatches([]); setContentTruncated(false); setContentFiles(0);
  }, [searchMode]);
  // 正文模式可见集：默认限当前 root 前缀（doc-center 的 under 按收集时 root 前缀匹配，子目录 root 下搜不到父 workspace 的文档，故在客户端过滤）；fullScope 开关看全部
  const visibleDocs = useMemo(() => {
    if (fullScope) return docItems;
    const prefix = (root || "").replace(/\/+$/, "") + "/";
    return docItems.filter(d => typeof d.path === "string" && d.path.startsWith(prefix));
  }, [docItems, fullScope, root]);
  // 「在目录打开」：AppShell 派发 pi-web:folder-reveal → 在 root 内展开到目标并高亮滚动；
  // 新开 tab 时事件可能早于本组件挂载，挂载时从 window.__piFolderRevealLast 重放（10s 内）。
  const revealPath = useCallback((rootPath: string, target: string)=>{
    if(!(target === rootPath || target.startsWith(rootPath + "/"))) return;
    const chain = [target];
    let cur: string | null = target === rootPath ? null : dirOf(target);
    for(let i=0; i<64 && cur; i++){
      if(cur === rootPath){ chain.push(cur); break; }
      if(!(cur.startsWith(rootPath + "/"))) break;
      chain.push(cur);
      const p = dirOf(cur);
      if(!p || p === cur) break;
      cur = p;
    }
    setExpanded(prev => new Set([...prev, ...chain]));
    setHighlightPath(target);
    const started = Date.now();
    const poll = ()=>{
      const el = [...document.querySelectorAll("[data-file-node]")].find(n => n.getAttribute("data-file-node") === target);
      if(el){ el.scrollIntoView({ block:"center", behavior:"smooth" }); return; }
      if(Date.now() - started < 3000) setTimeout(poll, 120);
    };
    setTimeout(poll, 60);
  }, []);
  useEffect(()=>{
    const onReveal = (e: any)=>{ const d = e.detail; if(d && d.root && d.target) revealPath(d.root, d.target); };
    window.addEventListener("pi-web:folder-reveal", onReveal as EventListener);
    const last = (window as any).__piFolderRevealLast;
    if(last && Date.now() - last.ts < 10000 && last.root === root) revealPath(last.root, last.target);
    return ()=>window.removeEventListener("pi-web:folder-reveal", onReveal as EventListener);
  }, [root, revealPath]);
  // + 菜单点外部关闭
  useEffect(()=>{
    if(!plusOpen) return;
    const onDown = (e: any)=>{ if(plusRef.current && !plusRef.current.contains(e.target)) setPlusOpen(false); };
    document.addEventListener("mousedown", onDown);
    return ()=>document.removeEventListener("mousedown", onDown);
  }, [plusOpen]);
  // ⋯ 更多菜单点外部关闭 / 滚动关闭（fixed 定位弹层不随头滚动）
  useEffect(()=>{
    if(!moreOpen) return;
    const onDown = (e: any)=>{ if(moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false); };
    const onWheel = ()=>setMoreOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("wheel", onWheel, { passive: true } as any);
    return ()=>{ document.removeEventListener("mousedown", onDown); document.removeEventListener("wheel", onWheel); };
  }, [moreOpen]);
  const toggleMore = useCallback((e: any)=>{
    if(moreOpen){ setMoreOpen(false); return; }
    const r = e.currentTarget.getBoundingClientRect();
    // 菜单固定视口定位（同 DirOpsMenu）：left 夹在视口内；底部空间不足时向上翻转。
    // 估算菜单高度：3 图标排（含关闭排）+ 7 文字行 + Git + 7 分隔线 + padding + gap ≈ 350，用 420 留 buffer；上下都不够时贴顶。
    const mh = 420;
    const menuWidth = 230;
    const left = Math.max(8, Math.min(r.right - menuWidth, window.innerWidth - menuWidth - 8));
    const overflowDown = r.bottom + 4 + mh > window.innerHeight;
    const overflowUp = r.top - mh - 4 < 0;
    let top: number;
    if (overflowDown && !overflowUp) {
      top = Math.max(8, r.top - mh - 4);
    } else if (overflowDown && overflowUp) {
      top = 8;
    } else {
      top = r.bottom + 4;
    }
    // Panel UI scale (zoomed panel containers): viewport-space estimates must be
    // divided back before being written as insets (see popup-anchor.zoomFactorOf).
    const moreZoom = zoomFactorOf(moreRef.current || document.body);
    setMorePos({ left: left / moreZoom, top: top / moreZoom });
    setMoreOpen(true);
  }, [moreOpen]);
  // 复制路径（对齐文件顶栏「复制路径」；结果走头部通知位，失败显错误）
  const doCopyRoot = useCallback(()=>{
    copyTextToClipboard(root).then(
      ()=>{ setUploadMsg({ ok: t("files.copyDone") }); setMoreOpen(false); },
      ()=>{ setUploadMsg({ err: t("files.copyFailed") }); setMoreOpen(false); }
    );
  }, [root]);
  // 重命名根目录：成功后打开新路径（tab 跟随新名；与子目录重命名行为一致，旧 tab 不强制迁移）
  const doRenameRoot = useCallback(async ()=>{
    const n = moreRenameName.trim();
    if(!n || !moreRename || moreBusy) return;
    setMoreBusy(true);
    try{
      const r = await fetch(apiUrl("/api/extensions/aiti-folder/rename"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ path: root, newName: n }) });
      const d = await r.json().catch(()=>({}));
      if(!r.ok || !d.ok){ setUploadMsg({ err: d.error || t("files.renameFailed") }); return; }
      const parent = root.slice(0, root.lastIndexOf("/")) || "/";
      setMoreOpen(false); setMoreRename(false); setMoreRenameName("");
      setUploadMsg({ ok: t("files.renameSuccess") });
      onOpenFolder(parent + "/" + n, n);
    }catch(e:any){ setUploadMsg({ err: e && e.message ? e.message : String(e) }); }
    finally{ setMoreBusy(false); }
  }, [root, moreRename, moreRenameName, moreBusy, onOpenFolder]);
  // @ 到新 session（目录引用带尾斜杠；【全路径】——新会话 cwd 可能不同，相对引用不可靠；
  // relTo(root,cwd) 在 root==cwd 时返回空串→"@/ "丢路径，2026-09-08 修。同 DirOpsMenu）
  // 不随便切 CWD：目标目录在当前 CWD/关注路径内 → 保持（doc-center 同款判定）
  const doRootAtNew = useCallback(async ()=>{
    try{
      const p = root + "/";
      const text = buildAtText(p);
      await openNewSessionWithExtSvc({ text, targetDir: root, targetPath: root, currentCwd: cwd, apiUrl, extSvc });
    }catch{/* noop */}
    setMoreOpen(false);
  }, [root, cwd]);
  // 打开上级目录并定位本目录（对齐文件顶栏「在目录打开」的 openFolder + folder-reveal 链路）
  const doOpenParent = useCallback(()=>{
    const parent = root.slice(0, root.lastIndexOf("/")) || "/";
    setMoreOpen(false);
    if(parent === root) return;
    if(onOpenFolder) onOpenFolder(parent, lastSeg(parent) || undefined);
    try{
      const detail = { root: parent, target: root };
      window.dispatchEvent(new CustomEvent("pi-web:folder-reveal", { detail }));
      (window as any).__piFolderRevealLast = { ...detail, ts: Date.now() };
    }catch{/* noop */}
  }, [root, onOpenFolder]);
  // 下载根目录打包（同 DirOpsMenu：票据两步下载，路径不进 URL）
  const doDownloadRoot = useCallback(async ()=>{
    setMoreOpen(false);
    try{
      const r = await fetch(apiUrl("/api/extensions/aiti-folder/archive-ticket"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ path: root }) });
      const d = await r.json().catch(()=>({} as any));
      if(!r.ok || !d.ok || !d.ticket){ setUploadMsg({ err: d.error || ("HTTP "+r.status) }); return; }
      const a = document.createElement("a"); a.href = apiUrl("/api/extensions/aiti-folder/archive?ticket="+encodeURIComponent(d.ticket)); a.download = lastSeg(root)+".tar.gz"; a.click();
    }catch{/* noop */}
  }, [root]);
  // ── Silent refresh: the old tree stays visible; swap the fetched listing atomically (identical → no setState) ──
  const sameEntries = (a: any[], b: any[]) =>
    a.length === b.length && a.every((e, i) => e.name === b[i].name && e.isDir === b[i].isDir && e.size === b[i].size);
  const rootsFetchRef = useRef<Promise<void> | null>(null);
  const rootsQueuedRef = useRef(false);
  const rootNowRef = useRef(root); rootNowRef.current = root;
  const showIgnoredNowRef = useRef(showIgnored); showIgnoredNowRef.current = showIgnored;
  const loadRootsFor = useCallback((): Promise<void> => {
    if (rootsFetchRef.current) { rootsQueuedRef.current = true; return rootsFetchRef.current; }
    // Do not flash the strip for a fast local listing: show it only after 150ms.
    const showTimer = setTimeout(()=>setRefreshing(true), 150);
    const reqRoot = root, reqShowIgnored = showIgnored;
    const p = (async () => {
      const list = await fetchList(apiUrl, reqRoot, { force: true, showIgnored: reqShowIgnored });
      // A stale response must not overwrite a different root (tab or switch changed).
      if (rootNowRef.current !== reqRoot || showIgnoredNowRef.current !== reqShowIgnored) return;
      setRoots(prev => sameEntries(prev, list.entries) ? prev : list.entries);
      setParent(list.parentPath ?? null);
      setError(null);
    })().catch((e) => {
      // A failure keeps the tree: the old content stays usable, the error becomes a hint line.
      if (rootNowRef.current !== reqRoot || showIgnoredNowRef.current !== reqShowIgnored) return;
      setError(e && e.message ? e.message : String(e));
    }).finally(() => {
      clearTimeout(showTimer);
      rootsFetchRef.current = null;
      setRefreshing(false);
      setLoading(false);
      // Changes during a fetch schedule one trailing fetch (coalesced, never stacked).
      if (rootsQueuedRef.current) { rootsQueuedRef.current = false; queueMicrotask(() => { void loadRootsRef.current?.(); }); }
    });
    rootsFetchRef.current = p;
    return p;
  }, [root, showIgnored]);
  const loadRootsRef = useRef(loadRootsFor);
  loadRootsRef.current = loadRootsFor;
  // Root / show-ignored switch: show the snapshot first (instant), then fetch fresh data.
  useEffect(()=>{
    const cached = peekList(root, showIgnored);
    setRoots(cached?.entries ?? []);
    setParent(cached?.parentPath ?? null);
    setLoading(!cached);
    setError(null);
    void loadRootsRef.current?.();
  }, [root, showIgnored]);
  // Explicit refresh (button / after a write): loaded subtrees reload too; root list and git state refresh together.
  const refreshSeenRef = useRef(refreshKey);
  useEffect(()=>{
    if(refreshSeenRef.current===refreshKey) return;
    refreshSeenRef.current=refreshKey;
    void loadRootsRef.current?.();
  }, [refreshKey]);
  // Live directory changes: root-list and git-badge refreshes each coalesce (one run per 600ms burst).
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleGit = useCallback(()=>{
    if(gitTimerRef.current) return;
    gitTimerRef.current = setTimeout(()=>{ gitTimerRef.current=null; setGitBump(k=>k+1); }, 600);
  }, []);
  const scheduleLiveRoot = useCallback(()=>{
    if(liveTimerRef.current) return;
    liveTimerRef.current = setTimeout(()=>{
      liveTimerRef.current = null;
      invalidateEntries(root);
      invalidateNestedRepos(root);
      void loadRootsRef.current?.();
      setGitBump(k=>k+1);
    }, 600);
  }, [root]);
  useEffect(()=>()=>{
    if(liveTimerRef.current) clearTimeout(liveTimerRef.current);
    if(gitTimerRef.current) clearTimeout(gitTimerRef.current);
  }, []);
  // Root live watch: a frame refreshes the root list and git badges only (each child watches itself).
  useEffect(()=>{ return watchDir(root, ()=>scheduleLiveRoot()); }, [root, scheduleLiveRoot]);
  // Show-ignored switch → full tree reload (root effect handles the root; loaded subtrees follow refreshKey).
  const showIgnoredPrevRef = useRef(showIgnored);
  useEffect(()=>{ if(showIgnoredPrevRef.current===showIgnored) return; showIgnoredPrevRef.current=showIgnored; setRefreshKey(k=>k+1); }, [showIgnored]);
  // git 工具面（git-ops M3）：引擎在位探测 + refs + `aiti-git-ops:changed:*` topic 订阅；
  // statusBump 追加进 /api/git/status 拉取依赖——引擎写操作/checkout 后树徽标即时刷新（零轮询）。
  const folderGit = useFolderGit(root);
  // ── Nested-repo status merge (plan §3.5): each mounted NestedGit reports its repo's dirty
  // rows here; merged into the badge maps so files inside nested repos get GitBadges and their
  // ancestors get the change dot. Compare-guarded: identical reports keep the Map reference
  // (no render churn); unmount reports null and prunes. ──
  const [nestedFiles, setNestedFiles] = useState<Map<string, any[]>>(() => new Map());
  const handleNestedStatus = useCallback((dir: string, files: any[] | null) => {
    setNestedFiles((prev) => {
      if (!files) { if (!prev.has(dir)) return prev; const n = new Map(prev); n.delete(dir); return n; }
      const cur = prev.get(dir);
      if (cur && cur.length === files.length && cur.every((f, i) => f.filePath === files[i].filePath && f.status === files[i].status)) return prev;
      const n = new Map(prev); n.set(dir, files); return n;
    });
  }, []);
  const nestedRows = useMemo(() => { const out: any[] = []; for (const fs of nestedFiles.values()) out.push(...fs); return out; }, [nestedFiles]);
  const allGitFiles = useMemo(() => (nestedRows.length > 0 ? [...gitFiles, ...nestedRows] : gitFiles), [gitFiles, nestedRows]);
  // Git badges: 250ms debounce + single-flight coalescing (no status/diff pile-up while an agent writes).
  const gitFetchingRef = useRef(false);
  const gitFetchAgainRef = useRef(false);
  const runGitStatusFetch = useCallback(async () => {
    if (gitFetchingRef.current) { gitFetchAgainRef.current = true; return; }
    gitFetchingRef.current = true;
    const reqRoot = root;
    try {
      const r = await fetch(apiUrl("/api/git/status"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ cwd: reqRoot }) });
      const st = await r.json();
      if (rootNowRef.current !== reqRoot) return;
      setGitFiles(st.isGitRepository?st.files:[]);
      setGitStats(st.isGitRepository?{additions:st.additions||0,deletions:st.deletions||0}:{additions:0,deletions:0});
    } catch { /* keep the previous badges */ }
    finally {
      gitFetchingRef.current = false;
      if (gitFetchAgainRef.current) { gitFetchAgainRef.current = false; void runGitStatusFetch(); }
    }
  }, [root]);
  useEffect(()=>{
    const t = setTimeout(()=>{ void runGitStatusFetch(); }, 250);
    return ()=>clearTimeout(t);
  }, [root, refreshKey, props.gitRefreshKey, folderGit.statusBump, gitBump, runGitStatusFetch]);
  const gitByPath = useMemo(()=>buildGitByPath(allGitFiles), [allGitFiles]);
  const changedDirs = useMemo(()=>buildChangedDirs(allGitFiles, root), [allGitFiles, root]);
  // Nested-repo detection for the root listing (plan §3.5): which top-level entries carry .git.
  // The scan cache absorbs redundant calls; explicit refreshes go forced (refreshKey > 0).
  const [rootRepos, setRootRepos] = useState<string[]>(() => peekNestedRepos(root) ?? []);
  useEffect(() => { setRootRepos(peekNestedRepos(root) ?? []); }, [root]);
  useEffect(() => {
    if (roots.length === 0) return;
    let c = false;
    fetchNestedRepos(apiUrl, root, refreshKey > 0 ? { force: true } : undefined)
      .then((rs) => { if (!c) setRootRepos((prev) => (prev.length === rs.length && prev.every((p, i) => p === rs[i])) ? prev : rs); })
      .catch(() => { /* keep the previous list */ });
    return () => { c = true; };
  }, [root, roots, refreshKey]);
  const toggle = useCallback((fp: string,o: boolean)=>{ setExpanded(p=>{ const n=new Set(p); if(o) n.add(fp); else n.delete(fp); return n; }); }, []);
  const doRefresh = useCallback(()=>{ setRefreshKey(k=>k+1); setGitBump(k=>k+1); setRefreshDone(true); setTimeout(()=>setRefreshDone(false), 1500); }, []);
  // 变更文件行「加入 .gitignore」（untracked 新文件）：引擎 ignore-add → 通知位反馈 → 刷新变更
  // （必须定义在 doRefresh 之后：useCallback deps 数组立即求值，const 前置引用会 TDZ 崩溃）
  const handleGitIgnore = useCallback(async (rel: string) => {
    try {
      await folderGit.ignoreAdd(rel);
      setUploadMsg({ ok: t("files.gitIgnoreDone") + " ✓" });
    } catch (e:any) { setUploadMsg({ err: e && e.message ? e.message : String(e) }); }
    doRefresh();
  }, [folderGit, doRefresh]);
  const handleUploadInput = useCallback(async (ev: any)=>{
    const files = Array.from(ev.target.files||[]); ev.target.value="";
    if(files.length===0||uploadBusy) return;
    setUploadBusy(true); setUploadMsg(null);
    try{
      const fd = new FormData(); fd.append("directory", root); (files as any[]).forEach(f=>fd.append("files", f, f.name));
      const r = await fetch(apiUrl("/api/files/upload?conflict=skip"), { method:"POST", body:fd });
      const d = await r.json().catch(()=>({}));
      if(!r.ok && !d.conflicts) { setUploadMsg({err:d.error||("HTTP "+r.status)}); }
      else { setUploadMsg({ up:(d.uploaded||[]).length, skip:(d.skipped||[]).length, err: (d.errors||[]).length }); setRefreshKey(k=>k+1); }
    }catch(e:any){ setUploadMsg({err:e&&e.message?e.message:String(e)}); }
    finally{ setUploadBusy(false); }
  }, [root, uploadBusy]);
  // 上传文件夹：webkitdirectory 多选，按相对路径（含顶层文件夹名）整体上传到 root 下
  const handleDirUploadInput = useCallback(async (ev: any)=>{
    const files = Array.from(ev.target.files||[]); ev.target.value="";
    if(files.length===0||uploadBusy) return;
    setUploadBusy(true); setUploadMsg(null);
    try{
      const fd = new FormData();
      fd.append("dir", root);
      for (const f of files as any[]) {
        const rel = (f.webkitRelativePath||f.name||"").replace(/\\/g,"/");
        fd.append("files", f, rel || f.name);
      }
      const r = await fetch(apiUrl("/api/extensions/aiti-folder/upload-tree"), { method:"POST", body:fd });
      const d = await r.json().catch(()=>({}));
      if(!r.ok || !d.ok) { setUploadMsg({err:d.error||("HTTP "+r.status)}); }
      else { setUploadMsg({ up:(d.uploaded||[]).length, skip:(d.skipped||[]).length, err:(d.errors||[]).length }); setRefreshKey(k=>k+1); }
    }catch(e:any){ setUploadMsg({err:e&&e.message?e.message:String(e)}); }
    finally{ setUploadBusy(false); }
  }, [root, uploadBusy]);
  // 删除 → 移入系统回收站（可恢复）
  const handleTrash = useCallback(async ()=>{
    if(!pendingTrash || trashBusy) return;
    setTrashBusy(true);
    try{
      const r = await fetch(apiUrl("/api/extensions/aiti-folder/trash"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ paths: [pendingTrash.path] }) });
      const d = await r.json().catch(()=>({}));
      if(!r.ok || !d.ok) { setUploadMsg({err:d.error||("HTTP "+r.status)}); }
      else if (d.errors && d.errors.length) { setUploadMsg({err:(d.errors[0].error)||t("files.trashFailed")}); }
      else {
        setUploadMsg({ ok: t("files.trashDone")+" ✓" });
        setRefreshKey(k=>k+1);
        if(pendingTrash.isDir) setExpanded(p=>{ const n=new Set(p); n.delete(pendingTrash.path); return n; });
      }
      setPendingTrash(null);
    }catch(e:any){ setUploadMsg({err:e&&e.message?e.message:String(e)}); setPendingTrash(null); }
    finally{ setTrashBusy(false); }
  }, [pendingTrash, trashBusy]);
  const handleCreate = useCallback(async ()=>{
    const name = newName.trim();
    if(!name||!newKind||createBusy) return;
    const endpoint = newKind==="file" ? "/api/extensions/aiti-folder/create-file" : "/api/extensions/aiti-folder/create-folder";
    setCreateBusy(true);
    try{
      const r = await fetch(apiUrl(endpoint), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ dir: root, name }) });
      const d = await r.json().catch(()=>({}));
      if(!r.ok || !d.ok) { setUploadMsg({err:d.error||("HTTP "+r.status)}); }
      else {
        setUploadMsg({ ok:(newKind==="file"?t("files.newFile"):t("files.newFolder"))+" ✓" });
        setNewKind(null); setNewName(""); setPlusOpen(false);
        setRefreshKey(k=>k+1);
        if(newKind==="file" && d.path) onOpenFile(d.path);
      }
    }catch(e:any){ setUploadMsg({err:e&&e.message?e.message:String(e)}); }
    finally{ setCreateBusy(false); }
  }, [newKind, newName, root, onOpenFile, createBusy]);
  /* ── dock 头命令 / 状态 / 菜单注册（v3；仅 dock 模式）──────────────────────────
   * face 按钮经 requestDockCommand 进来；未挂载时 store 先展开区块并排队，挂载后补跑。
   * 菜单项 = 原工具栏「⋮ 更多」全量并入 dock 头 ⋮ 的「文件操作」段。 */
  const buildDockMenuItems = (): DockMenuItem[] => {
    const items: DockMenuItem[] = [];
    const push = (id: string, label: string, run: () => void, icon?: any) => items.push({ kind: "item", id, label, icon, run });
    // ── 菜单顺序对齐 folder 三菜单定稿（2026-11-24 菜单单行化，方案 docs/aiti-menu-single-row-plan.md §3.3）：
    //    浏览 → 窗口 → 路径引用 → Git → 整理 → 导出；组名标题去除（sep 分段）；
    //    同段多动作合并为 iconsRow（框架 v5 图标排形态，DockMenuItem iconsRow kind），
    //    单动作保持 icon+文字 item 行——形态与工具栏 ⋮ MoreMenu 定稿一致。
    //    钉住/关闭不在此注册：dock 区块形态由 DockBody 区块操作区统一提供（清单 pin/关面板）。──
    items.push({ kind: "iconsRow", label: t("files.menuBrowse"), items: [
      { key: "op", icon: <MiArrowUp/>, label: t("files.openParentDir"), run: () => doOpenParent() },
      { key: "rf", icon: <MiRefresh/>, label: t("files.refresh"), run: () => doRefresh() },
      { key: "info", icon: <MiInfo/>, label: t("files.entryInfo"), run: () => setMoreInfoOpen(true) },
    ] });
    items.push({ kind: "iconsRow", label: t("files.menuWindow"), items: [
      { key: "nw", icon: <NewWindowIcon/>, label: t("files.openNewWindow"), run: () => openNewWindow("folder", root) },
      { key: "ot", icon: <TerminalIcon/>, label: t("files.openTerminal"), run: () => { void openTerminal(root).then((err) => { if (err) setUploadMsg({ err }); }); } },
      { key: "fm", icon: <MiFolderOpen/>, label: t("files.openInFileManager"), run: () => { void openInFileManager(root).then((err) => { if (err) setUploadMsg({ err }); }); } },
      // 关闭归位「窗口」排（2026-11-15 用户拍板：区块段末尾不好找）。语义 = removeFolderInstance
      //（关面板并移出清单，刷新不回弹）——与折叠未挂载态的区块段「关闭」同语义，唯一化。
      // 实例路径从 dockItemKey 反解（浏览子目录后 root 已偏离实例路径，不能拿 root 去匹配清单）。
      { key: "close", icon: <MiX/>, label: t("i18n.close"), run: () => { if (dockItemKey && dockItemKey.startsWith("aiti-folder:folder:")) { removeFolderInstance(dockItemKey.slice("aiti-folder:folder:".length)); } else if (dockItemKey) { closePanel(dockItemKey); } else { closeCurrentTab(); } } },
    ] });
    // 「移动」行占位（含钉住钮，经 DockBody moveRowPin）：前移到窗口排之下（2026-11-24 用户拍板）
    items.push({ kind: "moveRow" });
    items.push({ kind: "sep" });
    // @ 提及（插入路径到聊天）与 @ 到新会话并列（2026-11-24 用户补齐；仅 onAtMention 环境渲染；
    // 头行常驻 @ 按钮仍保留——常驻直达 + 菜单全量命令中心并存，与 MoreMenu/编辑器同哲学）
    if (onAtMention) push("at", t("files.insertPath"), () => { try { onAtMention(relTo(root, cwd || root), false); } catch (_) { /* noop */ } }, <MiAt/>);
    push("cp", t("files.copyPath"), () => { void doCopyRoot(); }, <MiCopy/>);
    push("atn", t("files.atNewSession"), () => { void doRootAtNew(); }, <MiAt/>);
    items.push({ kind: "sep" });
    push("gr", "Git Review", () => { void openGitReview({ kind: "directory", path: root }); }, <GrEyeIcon size={13}/>);
    items.push({ kind: "sep" });
    push("rn", t("files.rename"), () => { setMoreRename(true); setMoreRenameName(lastSeg(root) || ""); }, <MiPencil/>);
    push("mv", t("files.move"), () => { setMoreTransfer("move"); }, <MiMove/>);
    push("cpto", t("files.copyTo"), () => { setMoreTransfer("copy"); }, <MiCopyTo/>);
    items.push({ kind: "sep" });
    push("dl", t("files.download"), () => { void doDownloadRoot(); }, <MiDownload/>);
    return items;
  };
  useDockCommands(dockItemKey, dockItemKey ? {
    search: () => { try { writeBlockCollapsed(dockItemKey, false); } catch { /* ignore */ } toggleSearch(); },
    terminal: () => { void openTerminal(root).then((err) => { if (err) setUploadMsg({ err }); }); },
    refresh: () => doRefresh(),
    multiselect: () => { if (selMode) exitSelMode(); else setSelMode(true); },
    changes: () => setChangesOpen((v) => !v),
    at: () => { try { if (onAtMention) onAtMention(relTo(root, cwd || root), false); } catch { /* ignore */ } },
    plus: (payload?: unknown) => {
      const a = payload && typeof payload === "object" ? (payload as any).anchor : null;
      setPlusAnchor(a && typeof a.left === "number" ? a : null);
      setPlusPos(null);
      setPlusOpen(true);
    },
    setRoot: (payload?: unknown) => {
      const p = typeof payload === "string" ? payload : "";
      if (!p || p === root) return;
      saveExpandedSnapshot(root, expanded);
      setParent(null);
      setRoot(p);
      setExpanded(loadExpandedSnapshot(p) ?? new Set());
    },
    parent: () => {
      // Dock-header switcher "↑ Parent directory" navigates THIS block in place
      // (same semantics as the in-pane ↑ button / setRoot command): prefer the
      // backend-allowed parentPath (naive string parent only as fallback), swap root
      // with expanded-state snapshot round-trip. doOpenParent's "open parent as a new
      // folder + locate" flow stays only for the More-menu "open parent" action.
      const target = (parent ?? root.slice(0, root.lastIndexOf("/"))) || "/";
      if (!target || target === root) { doOpenParent(); return; }
      saveExpandedSnapshot(root, expanded);
      setParent(null);
      setRoot(target);
      setExpanded(loadExpandedSnapshot(target) ?? new Set());
    },
  } : null);
  useDockHeaderState(dockItemKey, dockItemKey ? {
    searchOpen, refreshDone, root, gitCount: gitFiles.length, changesOpen, hasParent: parent != null, selMode,
  } : null);
  useDockHeaderMenuItems(dockItemKey, dockItemKey ? buildDockMenuItems() : null);

  return (
    <div style={{ height:"100%", display:"flex", flexDirection:"column", background:"var(--bg)" }}>
      {/* 头部一行（仅非 dock 模式）：v3 嵌入 dock 区块时整行移除，按钮上提 dock 头（§2.8） */}
      {!dockHoist && (<div style={{ display:"flex", alignItems:"center", gap:4, padding:"4px 8px", borderBottom:"1px solid var(--border)", background:"var(--bg-panel)", flexShrink:0, ...(dense ? { overflowX:"auto" as const, flexWrap:"nowrap" as const, minHeight:33 } : {}) }}>
        {/* 上一个目录：回到允许浏览的父级（后端按 file roots 判定；父级不在允许集合内=已到边界，隐藏） */}
        {parent ? (
          <button type="button" onClick={()=>{ saveExpandedSnapshot(root, expanded); setParent(null); setRoot(parent); setExpanded(loadExpandedSnapshot(parent) ?? new Set()); }} title={t("files.parentDir")} aria-label={t("files.parentDir")}
            style={{ height:22, padding:"0 6px", border:"1px solid var(--border)", borderRadius:4, background:"var(--bg-panel)", color:"var(--text-muted)", cursor:"pointer", fontSize:12, flexShrink:0 }}>↑</button>
        ) : null}
        <FolderSwitcher path={root} onSelect={(p)=>{ saveExpandedSnapshot(root, expanded); setParent(null); setRoot(p); setExpanded(loadExpandedSnapshot(p) ?? new Set()); }} />
        {/* + 菜单：新建文件 / 新建文件夹 / 上传文件 / 上传文件夹 */}
        <div ref={plusRef} style={{ position:"relative", flexShrink:0 }}>
          {TBtn({ key:"plus", onClick:()=>{ if (plusOpen) { setPlusOpen(false); } else { setPlusPos(null); setPlusOpen(true); } }, title:t("files.newFile")+" / "+t("files.newFolder")+" / "+t("files.uploadFile")+" / "+t("files.uploadFolder"), color:plusOpen?"var(--accent)":"var(--text-dim)", bg:plusOpen?"var(--bg-selected)":"transparent", children:<PlusIcon/> })}
        </div>
        <span style={{flex:1}} />
        {/* 开放点：其他扩展的目录级工具条按钮（如 aiti-git-review 的「审此目录」——仅该目录下有变更时 match 返回 true） */}
        {folderActions.filter((a) => { try { return a.match && a.match(root, { gitFiles }); } catch { return false; } }).map((a) =>
          TBtn({ key: String(a.id || a.title || (typeof a.label === "string" ? a.label : "act")), onClick: () => { try { a.onClick(root); } catch {/* noop */} }, title: String(a.title || (typeof a.label === "string" ? a.label : "")), children: a.icon ? a.icon : <span style={{ fontSize: 13, lineHeight: 1 }}>{a.label}</span> }))}
        <input ref={uploadInputRef} type="file" multiple hidden onChange={e=>void handleUploadInput(e)} />
        <input ref={dirUploadInputRef} type="file" multiple hidden webkitdirectory="" onChange={e=>void handleDirUploadInput(e)} />
        {TBtn({ key:"srch", onClick:toggleSearch, title:t("sidebar.searchFiles"), pressed:searchOpen, color:searchOpen?"var(--accent)":"var(--text-dim)", bg:searchOpen?"var(--bg-selected)":"transparent", children:<MiSearch/> })}
        {TBtn({ key:"sel", onClick:()=>{ if (selMode) exitSelMode(); else setSelMode(true); }, title:t("sidebar.multiselectTitle"), pressed:selMode, color:selMode?"var(--accent)":"var(--text-dim)", bg:selMode?"var(--bg-selected)":"transparent",
          children:<svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="3" width="7" height="7" rx="1"/><path d="m6.5 6.5.01 0"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 17h7M17.5 13.5v7"/></svg> })}
        {gitFiles.length>0 ? TBtn({ key:"ch", onClick:()=>setChangesOpen(v=>!v), title:t("sidebar.changedFiles",{count:gitFiles.length}), pressed:changesOpen, color:changesOpen?"var(--accent)":"var(--text-dim)", bg:changesOpen?"var(--bg-selected)":"transparent",
          children: <span style={{position:"relative",display:"inline-flex"}}>
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/></svg>
            <span style={{position:"absolute",top:-6,right:-8,fontSize:9,color:"var(--text-muted)",background:"var(--bg-panel)",border:"1px solid var(--border)",borderRadius:6,padding:"0 3px",lineHeight:1.4}}>{String(gitFiles.length)}</span>
          </span> }) : null}
        {TBtn({ key:"term", onClick:()=>void openTerminal(root).then(err=>{ if (err) setUploadMsg({ err }); }), title:t("files.openTerminal"), children:<TerminalIcon/> })}
        {TBtn({ key:"nw", onClick:()=>openNewWindow("folder", root), title:t("files.openNewWindow"), children:<NewWindowIcon/> })}
        {TBtn({ key:"rf", onClick:doRefresh, title:t("sidebar.refreshExplorer"), color:refreshDone?"var(--ok, #4ade80)":"var(--text-dim)", bg:refreshDone?"color-mix(in srgb, var(--ok, #4ade80) 18%, transparent)":"transparent",
          children: refreshDone
            ? <svg width={13} height={13} viewBox="0 0 24 24" fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--ok, #4ade80)" }}><polyline points="20 6 9 17 4 12"/></svg>
            : <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> })}
        {/* @ 将路径插入聊天：高频动作恒留外面（对齐文件行操作区），不收进 ⋯ 菜单 */}
        {onAtMention ? TBtn({ key:"at", onClick:()=>onAtMention(relTo(root,cwd),false), title:t("files.insertPathTitle"), color:"var(--accent)", children:<span style={{fontSize:12,fontWeight:700,lineHeight:1}}>@</span> }) : null}
        {/* ⋯ 更多菜单：目录级共享菜单（刷新/复制路径/新窗口/重命名/@到新session/信息/上级目录/下载/Git Review）——与文件顶栏 ⋯ 菜单对齐 */}
        <div ref={moreRef} style={{ position:"relative", flexShrink:0 }}>
          {TBtn({ key:"more", onClick:toggleMore, title:t("files.rename")+" / "+t("files.copyPath")+" / "+t("files.entryInfo")+" / "+t("files.download"), color:moreOpen?"var(--accent)":"var(--text-dim)", bg:moreOpen?"var(--bg-selected)":"transparent", children:<span style={{fontSize:14,fontWeight:700,lineHeight:1}}>⋮</span> })}
          {moreOpen ? (
            <div style={{ position:"fixed", left:morePos!.left, top:morePos!.top, zIndex:400, minWidth:220, padding:6, background:"var(--bg,#fff)", border:"1px solid var(--border,#d0d0d0)", borderRadius:10, boxShadow:"0 4px 12px rgba(0,0,0,0.15)", fontSize:12, display:"flex", flexDirection:"column", gap:2 }}>
              {moreRename ? (
                <div style={{display:"flex",flexDirection:"column",gap:6,padding:"2px 2px 4px"}}>
                  <div style={{fontSize:11,color:"var(--text-dim,#888)",fontWeight:600}}>{t("files.rename")}</div>
                  <input autoFocus value={moreRenameName} onChange={e=>setMoreRenameName(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter") void doRenameRoot(); if(e.key==="Escape") setMoreRename(false); }} placeholder={(t("files.renamePlaceholder") as string)||""}
                    style={{width:"100%",boxSizing:"border-box",fontSize:12,fontFamily:"var(--font-mono,ui-monospace,monospace)",padding:"5px 8px",border:"1px solid var(--border,#d0d0d0)",borderRadius:5,outline:"none",background:"var(--bg,#fff)",color:"var(--text,#222)"}} />
                  <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                    <button type="button" onClick={()=>setMoreRename(false)} style={{...createBtnStyle,background:"transparent",border:"1px solid var(--border,#d0d0d0)",color:"var(--text,#222)"}}>{t("files.cancel")}</button>
                    <button type="button" onClick={()=>void doRenameRoot()} disabled={!moreRenameName.trim()||moreBusy} style={{...createBtnStyle,background:"var(--accent,#4f8ef7)",color:"#fff",border:"none",opacity:!moreRenameName.trim()||moreBusy?0.5:1}}>{moreBusy?"…":t("files.confirm")}</button>
                  </div>
                </div>
              ) : [
                // ── 菜单单行化重排（2026-11-24，方案 docs/aiti-menu-single-row-plan.md §3.3/§5.3）：
                //    关闭排 → 浏览排（上级/刷新/信息）→ 窗口排（钉住/新窗口/终端）→ 路径引用 → Git → 整理 → 下载。
                //    钉住移入窗口排（状态切换：未钉 📌 / 已钉 ✓ accent；点击不关菜单，反馈走 uploadMsg）。──
                <FolderCloseIconRow key="close-row" closeTab={()=>{ setMoreOpen(false); closeCurrentTab(); }} batch={(scope)=>{ setMoreOpen(false); batchCloseTabs(scope); }} t={t} />,
                menuSep("s-browse"),
                menuActionRow("row-browse", t("files.menuBrowse"), [
                  { key:"op", title: t("files.openParentDir"), icon:<MiArrowUp/>, onClick: doOpenParent },
                  { key:"rf", title: t("files.refresh"), icon:<MiRefresh/>, onClick: ()=>{ setMoreOpen(false); doRefresh(); } },
                  // 先关菜单再开弹窗：EntryInfoModal 挂 FolderBrowser 根级，不受菜单开关影响（保真契约 §5.3#10）
                  { key:"info", title: t("files.entryInfo"), icon:<MiInfo/>, onClick: ()=>{ setMoreOpen(false); setMoreInfoOpen(true); } },
                ]),
                menuActionRow("row-window", t("files.menuWindow"), [
                  { key:"pin", title: isTabPinned() ? t("files.unpin") : t("files.pin"), icon: isTabPinned() ? <MiPinOff/> : <MiPin/>, onClick: toggleTabPin },
                  { key:"nw", title: t("files.openNewWindow"), icon:<NewWindowIcon/>, onClick: ()=>{ setMoreOpen(false); openNewWindow("folder", root); } },
                  { key:"ot", title: t("files.openTerminal"), icon:<TerminalIcon/>, onClick: ()=>{ setMoreOpen(false); void openTerminal(root).then(err=>{ if (err) setUploadMsg({ err }); }); } },
                  { key:"fm", title: t("files.openInFileManager"), icon:<MiFolderOpen/>, onClick: ()=>{ setMoreOpen(false); void openInFileManager(root).then(err=>{ if (err) setUploadMsg({ err }); }); } },
                ]),
                // ── 路径引用 ──
                menuSep("s-ref"),
                menuItem(<MiCopy/>, t("files.copyPath"), doCopyRoot, "cp"),
                menuItem(<MiAt/>, t("files.atNewSession"), doRootAtNew, "atn"),
                // ── Git ──
                menuSep("s-git"),
                <button type="button" key="gr" onClick={(e)=>{ e.stopPropagation(); setMoreOpen(false); void openGitReview({ kind: "directory", path: root }); }} style={{ display:"flex", alignItems:"center", gap:6, width:"100%", padding:"5px 10px", border:"none", background:"transparent", color:"var(--accent)", cursor:"pointer", textAlign:"left", fontSize:12, borderRadius:6, whiteSpace:"nowrap" }}>
                  <GrEyeIcon size={13} />
                  Git Review
                </button>,
                // ── 整理（重命名/移动到/复制到，全文字行）──
                menuSep("s-org"),
                menuItem(<MiPencil/>, t("files.rename"), ()=>{ setMoreRename(true); setMoreRenameName(lastSeg(root)||""); }, "rn"),
                menuItem(<MiMove/>, t("files.move"), ()=>{ setMoreOpen(false); setMoreTransfer("move"); }, "mv"),
                menuItem(<MiCopyTo/>, t("files.copyTo"), ()=>{ setMoreOpen(false); setMoreTransfer("copy"); }, "cpto"),
                // ── 导出 ──
                menuSep("s-exp"),
                menuItem(<MiDownload/>, t("files.download"), ()=>void doDownloadRoot(), "dl"),
              ]}
            </div>
          ) : null}
        </div>
        {uploadMsg ? <span style={{fontSize:10,color:uploadMsg.err?"var(--danger, #f87171)":(uploadMsg.ok?"var(--ok, #4ade80)":"var(--text-muted)"),overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginLeft:2}} title={String(uploadMsg.err||"")}>{uploadMsg.err ? uploadMsg.err : (uploadMsg.ok ? uploadMsg.ok : ((uploadMsg.up||0)+"↑ / "+(uploadMsg.skip||0)+"跳 / "+(uploadMsg.err||0)+"错"))}</span> : null}
      </div>)}
      {dockHoist && uploadMsg ? (
        <div style={{ padding:"3px 8px", fontSize:10, borderBottom:"1px solid var(--border)", background:"var(--bg-panel)", color: uploadMsg.err ? "var(--danger, #f87171)" : (uploadMsg.ok ? "var(--ok, #4ade80)" : "var(--text-muted)"), overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flexShrink:0 }} title={String(uploadMsg.err||"")}>
          {uploadMsg.err ? uploadMsg.err : (uploadMsg.ok ? uploadMsg.ok : ((uploadMsg.up||0)+"↑ / "+(uploadMsg.skip||0)+"跳 / "+(uploadMsg.err||0)+"错"))}
        </div>
      ) : null}
          {plusOpen ? (
            <div ref={plusMenuRef} style={{ position:"fixed", zIndex:120, minWidth:180, padding:6, background:"var(--bg,#fff)", border:"1px solid var(--border,#d0d0d0)", borderRadius:10, boxShadow:"0 4px 12px rgba(0,0,0,0.15)", fontSize:12, display:"flex", flexDirection:"column", gap:2, ...(plusPos ? { left: plusPos.left, top: plusPos.top } : { left: -99999, top: -99999 }) }}>
              {newKind ? (
                <div style={{ display:"flex", flexDirection:"column", gap:6, padding:"2px 2px 4px" }}>
                  <div style={{fontSize:11,color:"var(--text-dim,#888)",fontWeight:600}}>{newKind==="file"?t("files.newFile"):t("files.newFolder")}</div>
                  <input autoFocus value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter") void handleCreate(); if(e.key==="Escape") setNewKind(null); }} placeholder={newKind==="file"?t("files.namePlaceholderFile"):t("files.namePlaceholderFolder")}
                    style={{ width:"100%", boxSizing:"border-box", fontSize:12, fontFamily:"var(--font-mono,ui-monospace,monospace)", padding:"5px 8px", border:"1px solid var(--border,#d0d0d0)", borderRadius:5, outline:"none", background:"var(--bg,#fff)", color:"var(--text,#222)" }} />
                  <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                    <button type="button" onClick={()=>setNewKind(null)} style={{...createBtnStyle,background:"transparent",border:"1px solid var(--border,#d0d0d0)",color:"var(--text,#222)"}}>{t("files.cancel")}</button>
                    <button type="button" onClick={()=>void handleCreate()} disabled={!newName.trim()||createBusy} style={{...createBtnStyle,background:"var(--accent,#4f8ef7)",color:"#fff",border:"none",opacity:!newName.trim()||createBusy?0.5:1}}>{createBusy?"…":t("files.create")}</button>
                  </div>
                </div>
              ) : [
                menuItem(<MiFilePlus/>, t("files.newFile"), ()=>{ setNewKind("file"); setNewName(""); }, "nf"),
                menuItem(<MiFolderPlus/>, t("files.newFolder"), ()=>{ setNewKind("folder"); setNewName(""); }, "nd"),
                <div key="sep" style={{height:1,background:"var(--border,#eee)",margin:"2px 4px"}} />,
                menuItem(<MiUpload/>, t("files.uploadFile"), ()=>{ setPlusOpen(false); if(uploadInputRef.current) uploadInputRef.current.click(); }, "uf"),
                menuItem(<MiUpload/>, t("files.uploadFolder"), ()=>{ setPlusOpen(false); if(dirUploadInputRef.current) dirUploadInputRef.current.click(); }, "ud"),
              ]}
            </div>
          ) : null}
          {moreInfoOpen ? <EntryInfoModal path={root} onClose={()=>setMoreInfoOpen(false)} t={t} onOpenFolder={onOpenFolder} /> : null}
          {moreTransfer ? <TransferDialog path={root} cwd={cwd} root={root} mode={moreTransfer} t={t} onClose={()=>setMoreTransfer(false)} onMoved={(newPath)=>{ setMoreTransfer(false); if(moreTransfer==="copy"){ setUploadMsg({ ok: t("files.copyDoneAction")+" ✓" }); return; } if(newPath && newPath!==root){ saveExpandedSnapshot(root, expanded); setParent(null); setRoot(newPath); setExpanded(loadExpandedSnapshot(newPath) ?? new Set()); if(onOpenFolder) onOpenFolder(newPath, lastSeg(newPath) || undefined); } else { doRefresh(); } }} /> : null}
      {dockHoist && moreRename ? (
        <div onClick={(e)=>{ if(e.target===e.currentTarget) setMoreRename(false); }} style={{ position:"fixed", inset:0, zIndex:400, background:"rgba(0,0,0,0.35)", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <div style={{ width:"min(420px,92vw)", background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, boxShadow:"0 8px 32px rgba(0,0,0,0.3)", padding:12, display:"flex", flexDirection:"column", gap:8 }}>
            <div style={{ fontSize:12, fontWeight:600, color:"var(--text)" }}>{t("files.rename")}</div>
            <input autoFocus value={moreRenameName} onChange={e=>setMoreRenameName(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter") void doRenameRoot(); if(e.key==="Escape") setMoreRename(false); }}
              placeholder={(t("files.renamePlaceholder") as string)||""}
              style={{ width:"100%", boxSizing:"border-box", fontSize:12, fontFamily:"var(--font-mono,ui-monospace,monospace)", padding:"5px 8px", border:"1px solid var(--border)", borderRadius:5, outline:"none", background:"var(--bg)", color:"var(--text)" }} />
            <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
              <button type="button" onClick={()=>setMoreRename(false)} style={{ ...createBtnStyle, background:"transparent", border:"1px solid var(--border)", color:"var(--text)" }}>{t("files.cancel")}</button>
              <button type="button" onClick={()=>void doRenameRoot()} disabled={!moreRenameName.trim()||moreBusy} style={{ ...createBtnStyle, background:"var(--accent)", color:"#fff", border:"none", opacity:!moreRenameName.trim()||moreBusy?0.5:1 }}>{moreBusy?"…":t("files.confirm")}</button>
            </div>
          </div>
        </div>
      ) : null}
      <div style={{ flex:1, overflowY:"auto", overflowX:"hidden", padding:"2px 0" }}>
        {/* 搜索条 + 结果树（对齐 pi-web 原版：搜索打开时显示在树区顶部；有查询时替换普通树） */}
        {searchOpen ? (
          <div style={{ padding:"6px 8px", borderBottom:"1px solid var(--border)" }}>
            <div style={{ position:"relative" }}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden
                style={{ position:"absolute", left:8, top:"50%", transform:"translateY(-50%)", color:"var(--text-dim)", pointerEvents:"none" }}>
                <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
              </svg>
              <input ref={searchInputRef} value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
                onKeyDown={e=>{ if(e.key==="Escape") toggleSearch(); }}
                placeholder={t("sidebar.searchFilesPlaceholder")} aria-label={t("sidebar.searchFiles")}
                style={{ width:"100%", boxSizing:"border-box", padding:"6px 24px", border:"1px solid var(--border)", borderRadius:5, outline:"none", background:"var(--bg)", color:"var(--text)", fontFamily:"var(--font-mono)", fontSize:11 }} />
              {searchQuery ? (
                <button type="button" onClick={()=>setSearchQuery("")} title={t("sidebar.clearSearch")} aria-label={t("sidebar.clearSearch")}
                  style={{ position:"absolute", right:4, top:"50%", transform:"translateY(-50%)", display:"flex", alignItems:"center", justifyContent:"center", width:18, height:18, padding:0, border:"none", borderRadius:4, background:"none", color:"var(--text-dim)", cursor:"pointer" }}>
                  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                </button>
              ) : null}
            </div>
            {/* Mode tabs (files/content always; docs tab only when doc-center is present) + per-mode hints */}
            {rgAvailable !== false ? (
              <div style={{ display:"flex", alignItems:"center", gap:2, padding:"4px 2px 0" }}>
                {(["files", "fulltext", "content"] as const).filter((m) => m !== "fulltext" || docsAvailable !== false).map((m) => {
                  const label = m === "files" ? t("sidebar.searchTabFiles") : m === "fulltext" ? t("sidebar.searchTabFulltext") : t("sidebar.searchTabContent");
                  const on = searchMode === m;
                  return <button key={m} type="button" onClick={()=>switchSearchMode(m)}
                    style={{ height:18, padding:"0 8px", fontSize:10, border:"none", borderRadius:4, cursor:"pointer", fontWeight:on?600:400,
                      background:on?"var(--bg-selected)":"transparent", color:on?"var(--accent)":"var(--text-dim)" }}>{label}</button>;
                })}
                {searchMode==="fulltext" ? (
                  <span title={t("sidebar.fulltextHintTitle")}
                    style={{ fontSize:9, color:"var(--text-dim)", opacity:0.85, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", minWidth:0, flexShrink:1, marginLeft:2 }}>{t("sidebar.fulltextHint")}</span>
                ) : null}
                {searchMode==="content" ? (
                  <span title={t("sidebar.contentHintTitle")}
                    style={{ fontSize:9, color:"var(--text-dim)", opacity:0.85, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", minWidth:0, flexShrink:1, marginLeft:2 }}>{t("sidebar.contentHint")}</span>
                ) : null}
                <span style={{ flex:1 }} />
                {searchMode==="fulltext" ? (
                  <label title={t("sidebar.fullScopeAll")} style={{ display:"flex", alignItems:"center", gap:3, fontSize:10, color:"var(--text-dim)", cursor:"pointer" }}>
                    <input type="checkbox" checked={fullScope} onChange={e=>setFullScope(e.target.checked)} style={{ width:10, height:10, margin:0, accentColor:"var(--accent)" }} />
                    {t("sidebar.fullScopeAll")}
                  </label>
                ) : null}
              </div>
            ) : null}
            {hasSearchQuery ? (
              <div style={{ paddingTop:3 }}>
                {searchLoading ? <div role="status" style={{ padding:"6px 2px", fontSize:10, color:"var(--text-dim)" }}>{searchMode==="fulltext" ? t("sidebar.searchingDocs") : searchMode==="content" ? t("sidebar.searchingContent") : t("sidebar.searchingFiles")}</div> : null}
                {!searchLoading && searchError ? <div role="alert" style={{ padding:"6px 2px", fontSize:10, color:"var(--danger, #f87171)" }}>{t("i18n.networkError")}</div> : null}
                {!searchLoading && !searchError && (searchMode==="files" ? searchPaths.length===0 : searchMode==="content" ? contentGroups.length===0 : visibleDocs.length===0) ? <div style={{ padding:"6px 2px", fontSize:10, color:"var(--text-dim)" }}>{searchMode==="fulltext" ? t("sidebar.noMatchingDocs") : searchMode==="content" ? t("sidebar.noMatchingContent") : t("sidebar.noMatchingFiles")}</div> : null}
                {!searchLoading && !searchError && searchMode==="files" && searchPaths.length>0 ? (
                  <div>
                    {searchRoots.map((node:any)=> (
                      <TreeNode key={searchQuery+":"+node.fullPath} node={node} depth={0} cwd={cwd||root} expanded={searchExpanded}
                        onToggle={(fp:string,o:boolean)=>setSearchExpanded(prev=>{ const n=new Set(prev); if(o) n.add(fp); else n.delete(fp); return n; })}
                        onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onAtMention={onAtMention} onTrash={setPendingTrash} onChanged={doRefresh} onLiveChange={scheduleGit}
                        gitByPath={gitByPath} changedDirs={changedDirs} t={t} root={root} selMode={selMode} selSelected={selectedPaths.has(node.fullPath)} onSelectRow={toggleSelectRow}
                        isGitRepo={rootRepos.includes(node.fullPath)}
                        gitScope={rootRepos.includes(node.fullPath) ? node.fullPath : root}
                        onNestedStatus={handleNestedStatus} onGitChanged={scheduleGit} onRequestDiscard={requestDiscard} />
                    ))}
                  </div>
                ) : null}
                {!searchLoading && !searchError && searchMode==="fulltext" && visibleDocs.length>0 ? (
                  <div style={{ display:"flex", flexDirection:"column", gap:1 }}>
                    {visibleDocs.map((d:any) => (
                      <div key={d.path} onClick={()=>onOpenFile(d.path)} title={d.path}
                        style={{ display:"flex", flexDirection:"column", gap:1, padding:"3px 10px", cursor:"pointer", borderRadius:4, userSelect:"none" }}
                        onMouseEnter={e=>(e.currentTarget.style.background="var(--bg-hover)")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
                        <div style={{ display:"flex", alignItems:"baseline", gap:6 }}>
                          <span style={{ fontSize:12, color:"var(--text)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{d.title || lastSeg(d.path)}</span>
                          {d.mtimeMs ? <span style={{ fontSize:9, color:"var(--text-dim)", flexShrink:0 }}>{new Date(d.mtimeMs).toLocaleDateString()}</span> : null}
                        </div>
                        <span style={{ fontSize:10, color:"var(--text-dim)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{relTo(d.path, root) || d.path}</span>
                        {d.snippet ? <span style={{ fontSize:11, color:"var(--text-muted)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}><MarkedText text={d.snippet} /></span> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {!searchLoading && !searchError && searchMode==="content" && contentGroups.length>0 ? (
                  <div style={{ display:"flex", flexDirection:"column", gap:1 }}>
                    {contentGroups.map((g:any) => {
                      const rel = relTo(g.path, root) || g.path;
                      return (
                        <div key={g.path} style={{ padding:"2px 4px" }}>
                          {/* File group header: click = locate in tree (close search + expand ancestors + highlight/scroll); opens the file via title row */}
                          <div className="gitops-row" onClick={()=>locateInTree(g.path)}
                            title={t("sidebar.locateInTree") + " · " + g.path}
                            style={{ display:"flex", alignItems:"center", gap:6, padding:"3px 6px", borderRadius:4, cursor:"pointer", userSelect:"none" }}
                            onMouseEnter={e=>(e.currentTarget.style.background="var(--bg-hover)")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
                            <span style={{ fontSize:11.5, color:"var(--text)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1, fontFamily:"var(--font-mono)" }}>{rel}</span>
                            <span style={{ fontSize:9.5, color:"var(--text-dim)", flexShrink:0 }}>{g.count}</span>
                            <span title={t("sidebar.locateInTree")} style={{ fontSize:9.5, color:"var(--text-dim)", flexShrink:0, border:"1px solid var(--border)", borderRadius:4, padding:"0 4px" }}>⌖</span>
                          </div>
                          {g.previews.map((m:any, mi:number) => (
                            <div key={mi} className="gitops-row" onClick={()=>onOpenFile(m.path)}
                              title={t("sidebar.openHitFile") + " · L" + m.line}
                              style={{ display:"flex", alignItems:"baseline", gap:6, padding:"1.5px 6px 1.5px 16px", cursor:"pointer", borderRadius:4, minHeight:16 }}
                              onMouseEnter={e=>(e.currentTarget.style.background="var(--bg-hover)")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
                              <span style={{ fontSize:9.5, color:"var(--text-dim)", fontFamily:"var(--font-mono)", flexShrink:0, minWidth:26, textAlign:"right" }}>{m.line}</span>
                              <span style={{ fontSize:10.5, color:"var(--text-muted)", fontFamily:"var(--font-mono)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1, minWidth:0 }}>
                                <HighlightedLine text={m.text} query={searchQuery} />
                              </span>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                    {contentTruncated ? (
                      <div style={{ padding:"4px 10px", fontSize:9.5, color:"var(--warn, #f59e0b)", opacity:0.9 }}>{t("sidebar.contentTruncated", { files: contentFiles })}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {/* git 工具条（引擎在位才渲染；⎇ 分支面板 / ↑↓ 同步 / ✎ 提交——git-ops M3） */}
        <GitBar root={root} git={folderGit} onChanged={doRefresh} changesOpen={changesOpen} onToggleChanges={() => setChangesOpen((v: boolean) => !v)} />
        {/* Changes section (open on purpose; shares ChangesList with nested-repo inline sections) */}
        {(changesOpen && gitFiles.length>0) ? (
          <ChangesList root={root} cwd={cwd || root} git={folderGit} files={gitFiles} stats={gitStats}
            onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onAtMention={onAtMention} onTrash={setPendingTrash}
            t={t} onRefresh={doRefresh} onGitIgnore={handleGitIgnore} onRequestDiscard={requestDiscard} onFeedback={setUploadMsg} />
        ) : null}
        {/* Thin 2px refresh strip: always reserved (no shift), pulses while loading; the tree never disappears. */}
        <div aria-hidden data-folder-refreshing={refreshing ? "1" : undefined}
          style={{ flexShrink:0, height:2, background:"var(--accent, #4f8ef7)", opacity: refreshing ? 1 : 0, transition:"opacity .15s", animation: refreshing ? "aiti-folder-refresh-pulse 1.1s ease-in-out infinite" : "none" }} />
        {error ? <div role="status" title={error} style={{ padding:"3px 10px", fontSize:10, color:"var(--danger, #f87171)", borderBottom:"1px solid var(--border)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flexShrink:0 }}>{error}</div> : null}
        {/* 树（有搜索查询时隐藏，腾位给结果树；对齐 pi-web (!fileSearchOpen || !hasSearchQuery)） */}
        {!hasSearchQuery ? (loading && roots.length===0 ? <div style={{padding:"12px",fontSize:12,color:"var(--text-dim)"}}>{t("files.loading")}</div>
        : roots.length===0 ? <div style={{padding:"12px",fontSize:12,color:"var(--text-dim)"}}>{t("files.noFiles")}</div>
        : roots.map((node:any)=> <TreeNode key={node.fullPath} node={node} depth={0} cwd={cwd||root} expanded={expanded} refreshKey={refreshKey} onToggle={toggle} onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} onAtMention={onAtMention} onTrash={setPendingTrash} onChanged={doRefresh} onLiveChange={scheduleGit} gitByPath={gitByPath} changedDirs={changedDirs} highlightPath={highlightPath} t={t} root={root} showIgnored={showIgnored} selMode={selMode} selSelected={selectedPaths.has(node.fullPath)} onSelectRow={toggleSelectRow}
          isGitRepo={rootRepos.includes(node.fullPath)}
          gitScope={rootRepos.includes(node.fullPath) ? node.fullPath : root}
          onNestedStatus={handleNestedStatus} onGitChanged={scheduleGit} onRequestDiscard={requestDiscard} />)) : null}
      </div>
      {/* 「放弃更改」页内确认弹窗（替代 window.confirm——2026-11-24 用户拍板） */}
      {pendingDiscard ? (
        <div onClick={(e) => { if (e.target === e.currentTarget) setPendingDiscard(null); }} style={{ position:"fixed", inset:0, zIndex:500, background:"rgba(0,0,0,0.35)", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <div style={{ width:400, padding:"16px 18px", borderRadius:12, background:"var(--bg,#fff)", border:"1px solid var(--border,#ddd)", boxShadow:"0 12px 40px rgba(0,0,0,0.25)", fontSize:13, display:"flex", flexDirection:"column", gap:10 }}>
            <div style={{ fontWeight:600, fontSize:14 }}>{pendingDiscard.title}</div>
            <div style={{ color:"var(--text-dim,#888)", fontSize:12, lineHeight:1.5 }}>{pendingDiscard.message}</div>
            <div style={{ display:"flex", gap:8, justifyContent:"flex-end", marginTop:2 }}>
              <button type="button" onClick={()=>setPendingDiscard(null)} style={{ height:28, padding:"0 12px", borderRadius:5, background:"transparent", border:"1px solid var(--border,#d0d0d0)", color:"var(--text,#222)", cursor:"pointer", fontSize:12 }}>{t("files.cancel")}</button>
              <button type="button" onClick={()=>{ const run = pendingDiscard.run; setPendingDiscard(null); run(); }} style={{ height:28, padding:"0 12px", borderRadius:5, background:"var(--danger, #ef4444)", border:"none", color:"#fff", cursor:"pointer", fontSize:12, fontWeight:600 }}>{ct("git.discardTitle")}</button>
            </div>
          </div>
        </div>
      ) : null}
      {/* 删除确认弹窗（移入系统回收站，可恢复） */}
      {/* Multi-select batch bar (borrow plan §2.6): sticky bottom bar with selected count + actions; rows toggled via checkboxes */}
      {selMode ? (
        <div style={{ flexShrink:0, display:"flex", alignItems:"center", gap:6, padding:"5px 10px", borderTop:"1px solid var(--border)", background:"var(--bg-panel)", fontSize:11 }}>
          <span style={{ color: selectedPaths.size ? "var(--accent)" : "var(--text-dim)", fontWeight:600, flexShrink:0 }}>{t("sidebar.selectedCount", { n: selectedPaths.size })}</span>
          <span style={{ flex:1 }} />
          <button type="button" disabled={selectedPaths.size === 0 || selBusy} onClick={()=>void batchAtNew()} title={t("sidebar.batchAtTitle")}
            style={{ height:22, padding:"0 9px", borderRadius:5, border:"1px solid var(--border)", background:"var(--bg)", color: selectedPaths.size ? "var(--accent)" : "var(--text-dim)", fontSize:11, cursor: selectedPaths.size ? "pointer" : "not-allowed", fontWeight:600 }}>@</button>
          <button type="button" disabled={selectedPaths.size === 0 || selBusy} onClick={()=>void batchTrash()} title={t("sidebar.batchTrashTitle")}
            style={{ height:22, padding:"0 9px", borderRadius:5, border:"1px solid var(--border)", background:"var(--bg)", color: selectedPaths.size ? "var(--danger, #ef4444)" : "var(--text-dim)", fontSize:11, cursor: selectedPaths.size ? "pointer" : "not-allowed" }}>{selBusy ? "…" : t("sidebar.batchTrash")}</button>
          <button type="button" onClick={exitSelMode} title={t("sidebar.batchCancel")}
            style={{ height:22, padding:"0 9px", borderRadius:5, border:"1px solid var(--border)", background:"transparent", color:"var(--text-muted)", fontSize:11, cursor:"pointer" }}>{t("sidebar.batchCancel")}</button>
        </div>
      ) : null}
      {pendingTrash ? (
        <div onClick={(e)=>{ if(e.target===e.currentTarget && !trashBusy) setPendingTrash(null); }} style={{ position:"fixed", inset:0, zIndex:400, background:"rgba(0,0,0,0.35)", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <div style={{ width:360, padding:"16px 18px", borderRadius:12, background:"var(--bg,#fff)", border:"1px solid var(--border,#ddd)", boxShadow:"0 12px 40px rgba(0,0,0,0.25)", fontSize:13, display:"flex", flexDirection:"column", gap:10 }}>
            <div style={{ fontWeight:600, fontSize:14 }}>{t("files.trashConfirmTitle")}</div>
            <div style={{ fontFamily:"var(--font-mono,ui-monospace,monospace)", color:"var(--text-dim,#888)", fontSize:12, wordBreak:"break-all", lineHeight:1.5 }}>{pendingTrash.name}</div>
            <div style={{ color:"var(--text-dim,#888)", fontSize:12 }}>{t("files.trashConfirmBody")}</div>
            <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
              <button type="button" onClick={()=>setPendingTrash(null)} disabled={trashBusy} style={{ height:28, padding:"0 12px", borderRadius:5, background:"transparent", border:"1px solid var(--border,#d0d0d0)", color:"var(--text,#222)", cursor:trashBusy?"default":"pointer", fontSize:12 }}>{t("files.cancel")}</button>
              <button type="button" onClick={()=>void handleTrash()} disabled={trashBusy} style={{ height:28, padding:"0 12px", borderRadius:5, background:"var(--danger, #ef4444)", border:"none", color:"#fff", cursor:trashBusy?"default":"pointer", fontSize:12, fontWeight:600, opacity:trashBusy?0.6:1 }}>{trashBusy?"…":t("files.trash")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
