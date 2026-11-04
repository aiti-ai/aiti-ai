/**
 * aiti-folder · 线条图标与小组件（自手写版迁移，一比一）
 */
import { lastSeg, EXT_LANG, LANG_COLOR, GIT_COLORS, GIT_KEYS } from "./lib";

type TFn = (key: string, params?: Record<string, unknown>) => string;

export function FileIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export function FileLangDot({ name }: { name: string }) {
  const ext = (lastSeg(name)!.split(".").pop() || "").toLowerCase();
  const lang = EXT_LANG[ext]; if (!lang) return null;
  const c = LANG_COLOR[lang]; if (!c) return null;
  return <span style={{ width:6, height:6, borderRadius:2, background:c, flexShrink:0, display:"inline-block" }} />;
}

export function FolderIcon({ open }: { open?: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
      <path d={ open ? "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" : "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" } />
    </svg>
  );
}

export function CaretIcon() {
  return <svg width={9} height={9} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}><polyline points="2 3.5 5 6.5 8 3.5" /></svg>;
}

export function CheckIcon() {
  return <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>;
}

/* ── 工具条图标（v3：folder-dock 头行按钮与 FolderBrowser 工具栏共用） ── */
export function PlusIcon() {
  return <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
}

export function TerminalIcon() {
  return <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
}

/** 变更面板图标（git changes：圆点 + 出入线）。 */
export function ChangesIcon() {
  return <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/></svg>;
}

export function PathLabel({ text, style }: { text?: string; style?: any }) {
  return (
    <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", display:"block", minWidth:0, lineHeight:1.35, direction:"rtl", textAlign:"left", ...(style||{}) }}>
      <span style={{ unicodeBidi:"plaintext" }}>{text}</span>
    </span>
  );
}

export function ActivityBadges({ act, t }: { act?: { running: number; unread: number }; t: TFn }) {
  if (!act || (act.running===0 && act.unread===0)) return null;
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, flexShrink:0, marginLeft:6 }}>
      {act.running>0 ? (
        <span title={t("sidebar.agentRunning")} style={{ display:"inline-flex", alignItems:"center", gap:3, color:"var(--accent)", fontSize:10, fontFamily:"var(--font-mono)" }}>
          <svg width={10} height={10} viewBox="0 0 24 24" fill="none" aria-hidden style={{display:"block"}}>
            <g><path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" />
            <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" /></g>
          </svg>
          {String(act.running)}
        </span>
      ) : null}
      {act.unread>0 ? (
        <span title={t("sidebar.newSessionActivity")} style={{ display:"inline-flex", alignItems:"center", gap:3, color:"#0891b2", fontSize:10, fontFamily:"var(--font-mono)" }}>
          <span style={{ width:6, height:6, borderRadius:"50%", background:"currentColor", display:"inline-block" }} />{String(act.unread)}
        </span>
      ) : null}
    </span>
  );
}

export function GitBadge({ status, t }: { status: { status: string; code: string }; t: TFn }) {
  return (
    <span title={t(GIT_KEYS[status.status]||status.status)} aria-label={t(GIT_KEYS[status.status]||status.status)}
      style={{ width:14, height:14, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", color:GIT_COLORS[status.status]||"var(--text-dim)", fontFamily:"var(--font-mono)", fontSize:11, fontWeight:600 }}>
      {status.code}
    </span>
  );
}

// ── 菜单线稿图标（feather 风格 13px · stroke currentColor）——菜单项统一图标体系（弃 emoji） ──
function mkMenuIcon(render: () => any) {
  return function MenuIcon({ size = 13 }: { size?: number }) {
    // render() 必须在渲染时调用：模块顶层创建 JSX 时宿主 ctx.h 尚未注入，元素会全变 undefined
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden>{render()}</svg>
    );
  };
}
// 图标内部一律用 Fragment（<>…</>）而非裸数组：数组子元素无 key 会触发 React
// "Each child in a list should have a unique key" dev 告警；Fragment 编译为
// jsxs(Fragment,…) → host-shim 的 jsxs 会对静态子元素打 validated 标记，告警消除。
// （2026-09-06 实证：host ctx.h = React.createElement，Fragment 真渲染；aiti-editor
// 同款改法浏览器已验。旧注“不渲染 Fragment/svg 会空”为当时误判，已废弃。）
export const MiRefresh = mkMenuIcon(() => <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>);
export const MiExternal = mkMenuIcon(() => <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></>);
export const MiPencil = mkMenuIcon(() => <><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></>);
export const MiMove = mkMenuIcon(() => <><polyline points="5 9 2 12 5 15" /><polyline points="9 5 12 2 15 5" /><polyline points="15 19 12 22 9 19" /><polyline points="19 9 22 12 19 15" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="12" y1="2" x2="12" y2="22" /></>);
export const MiAt = mkMenuIcon(() => <><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>);
export const MiInfo = mkMenuIcon(() => <><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></>);
export const MiDownload = mkMenuIcon(() => <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>);
export const MiUpload = mkMenuIcon(() => <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>);
export const MiTrash = mkMenuIcon(() => <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></>);
export const MiTerminal = mkMenuIcon(() => <><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>);
export const MiFilePlus = mkMenuIcon(() => <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" /></>);
export const MiFolderPlus = mkMenuIcon(() => <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></>);
export const MiCopy = mkMenuIcon(() => <><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
// 复制到（copy + 右向箭头，与纯复制路径区分）
export const MiCopyTo = mkMenuIcon(() => <><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /><line x1="12" y1="15.5" x2="18.5" y2="15.5" /><polyline points="16 13 18.5 15.5 16 18" /></>);
export const MiArrowUp = mkMenuIcon(() => <><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></>);
export const MiFolder = mkMenuIcon(() => <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>);
export const MiChevronL = mkMenuIcon(() => <><polyline points="15 18 9 12 15 6" /></>);
export const MiChevronR = mkMenuIcon(() => <><polyline points="9 18 15 12 9 6" /></>);
export const MiFileText = mkMenuIcon(() => <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>);
export const MiSearch = mkMenuIcon(() => <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>);
// 显示忽略项（lucide eye 线稿）
export const MiEye = mkMenuIcon(() => <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>);
// ── tab 窗口管理（钉住/关闭族）——与 aiti-editor file-toolbar 同款线稿，菜单视觉一致 ──
export const MiPin = mkMenuIcon(() => <><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></>);
export const MiX = mkMenuIcon(() => <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>);
export const MiCloseLeft = mkMenuIcon(() => <><line x1="3" y1="4" x2="3" y2="20"/><path d="m12 7-5 5 5 5"/><path d="M17 12H7"/></>);
export const MiCloseRight = mkMenuIcon(() => <><line x1="21" y1="4" x2="21" y2="20"/><path d="m12 7 5 5-5 5"/><path d="M7 12h10"/></>);
export const MiCloseAll = mkMenuIcon(() => <><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></>);
