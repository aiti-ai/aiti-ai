/**
 * aiti-folder · 项目/目录切换器（FolderSwitcher）——自手写版迁移 + 组件化重构
 *
 * 同款左上角项目切换器：历史目录（/api/sessions，已知 workspace 优先）+ 过滤 +
 * 运行/未读状态图标 + 使用默认目录（/api/default-cwd）+ 自定义路径浏览（/api/cwd/browse）。
 * 两种形态：compact（顶栏 36×36 图标按钮）/ 非 compact（FolderBrowser 头部全宽按钮）。
 * 唯一约定：选中只调 onSelect（改本调用方展示），不切 cwd。
 *
 * WorkspaceDropdown：弹出菜单部分抽成独立导出组件——其他扩展 client（如
 * session-manager 的目录过滤）可构建期内联复用同一弹窗（见其 entry.tsx 的
 * host-shim ctx 双注入约定）。selected 为当前高亮路径；onSelect 只回传不落库。
 */
import { useState, useEffect, useRef, useLayoutEffect } from "react";
import { clampToViewport, fixedOrigin } from "../../../_shared/popup-anchor";
import { dedupeFetch } from "../../../_shared/dedupe-fetch";
import { apiUrl, extSvc } from "./host-shim";
import { ct as t } from "./comp-i18n"; // 组件自带多语：内置字典优先，回落宿主 t
import { displayCwd, loadUnread, recentProjects, projectActivity } from "./lib";
import { FolderIcon, CaretIcon, CheckIcon, PathLabel, ActivityBadges } from "./icons";
import { DirectoryBrowser } from "./directory-browser";

/** 弹出菜单（已知 workspace 列表优先）。需挂在 position:relative 容器内。
 *  allOption：传入则在列表顶部渲染「全部」行，选中回传 onSelect("")。
 *  width：可选，覆盖菜单宽度（默认左对齐 = 内容自然宽，下限触发器宽、上限 min(480px, 视口-16px)；
 *  右对齐 min(320px,80vw)）；长路径场景可传如 "min(480px,90vw)" 显示全。 */
export function WorkspaceDropdown({ selected, onSelect, onClose, align = "left", showUseDefault = true, allOption, width, extraTopItem }: {
  selected?: string;
  onSelect: (p: string) => void;
  onClose: () => void;
  align?: "left" | "right";
  showUseDefault?: boolean;
  allOption?: { label: string };
  width?: number | string;
  /** 列表顶部附加项（dock 头目录切换器的「上一级」等） */
  extraTopItem?: { label: string; onClick: () => void };
}) {
  const selectedStr = selected || "";
  const [home, setHome] = useState("");
  const [projects, setProjects] = useState<{ key: string; root: string }[]>([]);
  const [filter, setFilter] = useState("");
  const [activity, setActivity] = useState(new Map());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // —— 弹层一律固定定位（2026-09：不再受任何容器钳制）——旧版 absolute 锚定 + 越视口才
  // 转 fixed 的兜底，探测不到祖先裁剪：左栏 sidebar-container（宽度动画 overflow:hidden）
  // → StackCell → DockBody 全链 hidden，弹层 rect 仍在视口内但被裁没（点了显示不出来）。
  // 现一律 position:fixed 锚定触发按钮矩形（父级 position:relative wrapper）：渲染后测量
  // 触发器/自身 → 宽度落定（显式 width 优先 / 右锚定 min(320px,80vw) / 左锚定按内容自然宽，
  // 下限=触发器宽、上限=min(480px, 视口-16px)——窄触发器不再把路径截断）→ 下开（底部装不下
  // 且上方空间更大则上翻）→ 视口钳制；transformed 祖先构成 fixed
  // containing block 时按其原点校正（popup-anchor.fixedOrigin）。每渲染复测（projects
  // 异步到齐后高度变化跟随重钳），值不变即 bail 不循环；useLayoutEffect 绘制前同步，无闪烁。
  const ddRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = ddRef.current;
    const anchor = el?.parentElement;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const gap = 4, pad = 8;
    if (width !== undefined) el.style.width = typeof width === "number" ? `${width}px` : width;
    else if (align === "right") el.style.width = "min(320px,80vw)";
    else {
      // 左锚定不再拉伸至触发器宽（窄触发器 → 路径全截断）：先以 max-content 量内容自然宽，
      // 最终 = clamp(自然宽, min(触发器宽, maxW), maxW)，maxW = min(480px, 视口-2pad)。
      el.style.width = "max-content";
      const natural = el.getBoundingClientRect().width;
      const maxW = Math.min(480, window.innerWidth - pad * 2);
      el.style.width = `${Math.min(Math.max(natural, Math.min(a.width, maxW)), maxW)}px`;
    }
    const m = el.getBoundingClientRect();
    let left = align === "right" ? a.right - m.width : a.left;
    let top = a.bottom + gap;
    const below = window.innerHeight - pad - top;
    const above = a.top - gap - pad;
    if (m.height > below && above > below) top = a.top - gap - m.height; // 上翻
    const c = clampToViewport(left, top, m.width, m.height, pad);
    const o = fixedOrigin(el);
    const next = { left: c.left - o.x, top: c.top - o.y, width: m.width };
    setPos((cur) => cur && cur.left === next.left && cur.top === next.top && cur.width === next.width ? cur : next);
  });
  // fixed 弹层不随内容滚动（滞留旧位 = 错位）——任意容器滚动即关；弹层内部滚动（项目列表/
  // DirectoryBrowser）豁免。
  useEffect(() => {
    const onScroll = (e: Event) => {
      if (ddRef.current && e.target instanceof Node && ddRef.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [onClose]);
  // home 目录：优先宿主共享服务 pi-web.home（lib/home-dir 单例，跨全部消费面一次请求）；
  // 旧宿主/服务缺席 → 回退自拉（dedupeFetch 兜同窗口多实例）。
  useEffect(()=>{ let alive = true;
    const svc = extSvc<{ ensure: () => Promise<string | null> }>("pi-web.home");
    const p = svc?.ensure
      ? svc.ensure()
      : dedupeFetch(apiUrl("/api/home")).then(r=>r.json()).then((d: any)=> (d?.home as string) ?? null).catch(()=>null);
    void p.then((dir)=>{ if (alive && dir) setHome(dir); });
    return ()=>{ alive = false; };
  }, []);
  useEffect(()=>{ const unread=loadUnread();
    dedupeFetch(apiUrl("/api/sessions"),{cache:"no-store"}).then(r=>r.json()).then(d=>{ const s=d.sessions||[]; setProjects(recentProjects(s)); setActivity(projectActivity(s, new Set(d.runningSessionIds||[]), unread)); }).catch(()=>{});
  }, []);
  const showFilter = projects.length>=8;
  // 筛选框聚焦：仅非小屏自动聚焦（≤640px 手机/窄屏不弹键盘遮挡列表；用户点输入框再聚焦）
  useEffect(() => {
    if (!showFilter) return;
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches) return;
    filterRef.current?.focus();
  }, [showFilter]);
  const visible = showFilter && filter.trim() ? projects.filter(p=>displayCwd(p.root,home)!.toLowerCase().includes(filter.trim().toLowerCase())) : projects;
  const handleDefault = async ()=>{ setBusy(true); try{ const r=await fetch(apiUrl("/api/default-cwd"),{method:"POST"}); const d=await r.json(); if(d.cwd){ onSelect(d.cwd); onClose();} }catch{} finally{ setBusy(false);} };
  const dropdownStyle: Record<string, any> = {
    position: "fixed", zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
    boxShadow: "0 6px 20px rgba(0,0,0,0.10)", overflow: "hidden",
    // 首帧离屏（布局期测量后落位，绘制前同步无闪烁）
    ...(pos ? { left: pos.left, top: pos.top, width: pos.width } : { left: -99999, top: -99999 }),
  };
  return (
    <div ref={ddRef} style={dropdownStyle}>
      {showFilter ? (
        <div style={{ padding:"6px 8px", borderBottom:"1px solid var(--border)" }}>
          <input ref={filterRef} value={filter} onChange={e=>setFilter(e.target.value)} onKeyDown={e=>{ if(e.key==="Escape"){ setFilter(""); onClose(); } }} placeholder={t("sidebar.filterProjects")}
            style={{ width:"100%", fontSize:11, fontFamily:"var(--font-mono)", padding:"5px 8px", border:"1px solid var(--border)", borderRadius:5, outline:"none", background:"var(--bg)", color:"var(--text)", boxSizing:"border-box" }} />
        </div>
      ) : null}
      <div style={{ maxHeight:"min(50vh,380px)", overflowY:"auto" }}>
        {extraTopItem ? (
          <button key="__extra_top__" type="button" onClick={()=>extraTopItem.onClick()}
            style={{ display:"flex", alignItems:"center", gap:7, width:"100%", padding:"8px 10px", background:"var(--bg)", borderLeft:"none", borderRight:"none", borderTop:"none", borderBottom:"1px solid var(--border)", color:"var(--text-muted)", cursor:"pointer", textAlign:"left", fontSize:11 }}>
            <PathLabel text={extraTopItem.label} style={{flex:1}} />
          </button>
        ) : null}
        {allOption ? (
          <button key="__all__" type="button" onClick={()=>{ onSelect(""); setFilter(""); onClose(); }}
            style={{ display:"flex", alignItems:"center", gap:7, width:"100%", padding:"8px 10px", background:"var(--bg)", borderLeft:"none", borderRight:"none", borderTop:"none", borderBottom:"1px solid var(--border)", color: !selectedStr ? "var(--text)" : "var(--text-muted)", cursor:"pointer", textAlign:"left", fontSize:11 }}>
            {!selectedStr ? <CheckIcon /> : <span style={{width:10,flexShrink:0}} />}
            <FolderIcon open={false} />
            <PathLabel text={allOption.label} style={{flex:1}} />
          </button>
        ) : null}
        {visible.map(p=>{ const cur = p.root===selectedStr; return (
          <button key={p.key} type="button" onClick={()=>{ onSelect(p.root); setFilter(""); onClose(); }} title={p.root}
            style={{ display:"flex", alignItems:"center", gap:7, width:"100%", padding:"8px 10px", background:"var(--bg)", borderLeft:"none", borderRight:"none", borderTop:"none", borderBottom:"1px solid var(--border)", color:cur?"var(--text)":"var(--text-muted)", cursor:"pointer", textAlign:"left", fontSize:11, fontFamily:"var(--font-mono)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {cur?<CheckIcon />:<span style={{width:10,flexShrink:0}} />}
            <PathLabel text={displayCwd(p.root,home)} style={{flex:1}} />
            <ActivityBadges act={activity.get(p.key)} t={t} />
          </button>
        ); })}
        {visible.length===0 && filter.trim() ? <div style={{ padding:"8px 10px", fontSize:11, color:"var(--text-dim)" }}>{t("sidebar.noMatchingProjects")}</div> : null}
      </div>
      {showUseDefault ? (
        <button type="button" onClick={e=>{ e.stopPropagation(); void handleDefault(); }} disabled={busy}
          style={{ display:"flex", alignItems:"center", gap:7, width:"100%", padding:"8px 10px", background:"none", borderLeft:"none", borderBottom:"none", borderTop:visible.length>0?"1px solid var(--border)":"none", color:"var(--text-muted)", cursor:"pointer", textAlign:"left", fontSize:11 }}>
          <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}><path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z"/></svg>
          {t("sidebar.useDefaultDirectory")}
        </button>
      ) : null}
      <button type="button" onClick={e=>{ e.stopPropagation(); setPickerOpen(true); }}
        style={{ display:"flex", alignItems:"center", gap:7, width:"100%", padding:"8px 10px", background:"none", border:"none", color:"var(--text-muted)", cursor:"pointer", textAlign:"left", fontSize:11 }}>
        <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" style={{flexShrink:0}}><line x1="5" y1="1" x2="5" y2="9"/><line x1="1" y1="5" x2="9" y2="5"/></svg>
        {t("sidebar.customPath")}
      </button>
      {pickerOpen ? <DirectoryBrowser initialPath={selectedStr} onSelect={(p)=>{ setPickerOpen(false); onClose(); onSelect(p); }} onCancel={()=>setPickerOpen(false)} /> : null}
    </div>
  );
}

export function FolderSwitcher({ path, onSelect, compact }: { path?: string; onSelect?: (p: string) => void; compact?: boolean }) {
  const pathStr = path || ""; const onSelectFn = onSelect || (()=>{}); const isCompact = compact === true;
  const [open, setOpen] = useState(false);
  const [home, setHome] = useState("");
  const ddRef = useRef<HTMLDivElement | null>(null);
  useEffect(()=>{ let alive = true;
    const svc = extSvc<{ ensure: () => Promise<string | null> }>("pi-web.home");
    const p = svc?.ensure
      ? svc.ensure()
      : dedupeFetch(apiUrl("/api/home")).then(r=>r.json()).then((d: any)=> (d?.home as string) ?? null).catch(()=>null);
    void p.then((dir)=>{ if (alive && dir) setHome(dir); });
    return ()=>{ alive = false; };
  }, []);
  useEffect(()=>{ if(!open) return; const h2=(e:any)=>{ if(ddRef.current && !ddRef.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown",h2); return ()=>document.removeEventListener("mousedown",h2); }, [open]);
  const triggerStyle: Record<string, any> = isCompact
    ? { display:"flex", alignItems:"center", justifyContent:"center", width:36, height:36, padding:0, background:"var(--bg-selected)", borderTop:"none", borderRight:"none", borderBottom:"none", borderLeft:"1px solid var(--border)", color:"var(--text)", cursor:"pointer", flexShrink:0, transition:"color 0.12s" }
    : { width:"100%", display:"flex", alignItems:"center", gap:6, padding:"6px 10px", background:"var(--bg-hover)", border:"1px solid var(--border)", borderRadius:7, cursor:"pointer", fontSize:12, color:"var(--text)", textAlign:"left", transition:"border-color 0.15s, background 0.15s" };
  return (
    <div ref={ddRef} style={{ position:"relative", flex:isCompact?undefined:"0 1 auto", minWidth:isCompact?undefined:0, maxWidth:isCompact?undefined:"60%" }}>
      <button type="button" onClick={()=>setOpen(v=>!v)} title={isCompact?t("files.openFolder"):pathStr} aria-label={isCompact?t("files.openFolder"):undefined} style={triggerStyle}>
        {isCompact ? (
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
            <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        ) : null}
        {!isCompact ? <FolderIcon open={true} /> : null}
        {!isCompact ? <PathLabel text={displayCwd(pathStr, home)} style={{ flex:1, fontFamily:"var(--font-mono)", fontSize:11, color:"var(--text)" }} /> : null}
        {!isCompact ? <CaretIcon /> : null}
      </button>
      {open ? (
        <WorkspaceDropdown
          selected={pathStr}
          onSelect={(p)=>{ onSelectFn(p); setOpen(false); }}
          onClose={()=>setOpen(false)}
          align={isCompact ? "right" : "left"}
        />
      ) : null}
    </div>
  );
}
