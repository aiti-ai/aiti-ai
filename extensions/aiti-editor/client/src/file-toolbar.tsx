/**
 * aiti-editor · 文件编辑/预览窗口通用顶栏——文本编辑与二进制预览共用的公共能力：
 *   状态点 · 路径 · ‹› 同目录深度遍历 + 计数 · 通知 · @ 提及 · 下载 · ⋯ 菜单
 *   （下载/复制路径/重命名/在目录打开 为默认项；导出等经 menuTop 注入）
 * 通过 modes/rightExtra/trailing 承载视图差异（模式切换/保存按钮/类型·大小）；leading 留静态自定义元素。
 * 零依赖、内联样式，样式值与 editor-app 的 T.* 保持一致。
 *
 * 小屏收敛：顶栏宽度不足（ResizeObserver 实测 < COMPACT_AT）时进入 compact 态——
 * ‹› 遍历/计数/⬇/↗/类型·大小 标签全部收进 ⋯ 菜单（‹› 变「上一个/下一个文件」菜单项），
 * 只留 状态点 + 路径 + @ + 插槽（保存/模式切换）+ ⋯；@ 是最高优先级动作恒留外面。
 * 更小屏（< MODE_DROPDOWN_AT）：modes 模式切换（编辑/分栏/预览）从内联 tabs 变下拉，进一步省空间。
 */
import { useState, useEffect, useRef } from "react";
import { extSvc } from "./host-shim";
import { dismissOnBack } from "../../../_shared/overlay-back-client";

export type MenuAction = { label: string; title?: string; /** 可选图标（ReactNode，如 aiti-git-review 的统一 GrEyeIcon）；渲染在文案左侧 */ icon?: any; onClick: () => void };

/** 顶栏宽度低于该值（px）判定为小屏 compact 态：次要按钮收进 ⋯ 菜单 */
const COMPACT_AT = 620;
/** 顶栏宽度低于该值（px）：modes 模式切换从内联 tabs 变下拉（很小屏进一步省空间） */
const MODE_DROPDOWN_AT = 500;

/** 终端图标（> _ 线稿）；与 aiti-folder 菜单图标体系对齐 */
function TerminalIcon() {
  return <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>;
}

// ── 菜单线稿图标（feather 风格 13px · stroke currentColor）——⋯ 菜单统一图标体系，与 aiti-folder 一致 ──
function mkMenuIcon(render: () => any) {
  return function MenuIcon({ size = 13 }: { size?: number } = {}) {
    // render() 渲染时才创建元素（模块顶层时宿主 ctx.h 未注入）；size 供工具栏按钮放大（默认菜单 13px）
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden>{render()}</svg>;
  };
}
// 图标内部一律用 Fragment（<>…</>）而非裸数组：数组子元素无 key 会触发 React
// "Each child in a list should have a unique key" dev 告警；Fragment 编译为
// jsxs(Fragment,…) → host-shim 的 jsxs 会对静态子元素打 validated 标记，告警消除。
export const MiAt = mkMenuIcon(() => <><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></>);
export const MiInfo = mkMenuIcon(() => <><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></>);
export const MiDownload = mkMenuIcon(() => <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></>);
export const MiCopy = mkMenuIcon(() => <><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>);
export const MiClipboard = mkMenuIcon(() => <><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></>);
export const MiExternal = mkMenuIcon(() => <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></>);
export const MiPencil = mkMenuIcon(() => <><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></>);
export const MiMove = mkMenuIcon(() => <><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></>);
export const MiFolder = mkMenuIcon(() => <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></>);
export const MiChevronL = mkMenuIcon(() => <><polyline points="15 18 9 12 15 6"/></>);
export const MiChevronR = mkMenuIcon(() => <><polyline points="9 18 15 12 9 6"/></>);
export const MiFileText = mkMenuIcon(() => <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></>);
export const MiPin = mkMenuIcon(() => <><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></>);
export const MiX = mkMenuIcon(() => <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>);
export const MiCloseLeft = mkMenuIcon(() => <><line x1="3" y1="4" x2="3" y2="20"/><path d="m12 7-5 5 5 5"/><path d="M17 12H7"/></>);
export const MiCloseRight = mkMenuIcon(() => <><line x1="21" y1="4" x2="21" y2="20"/><path d="m12 7 5 5-5 5"/><path d="M7 12h10"/></>);
export const MiCloseAll = mkMenuIcon(() => <><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></>);
export const MiSave = mkMenuIcon(() => <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></>);
export const MiSaveAs = mkMenuIcon(() => <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><line x1="12" y1="16" x2="12" y2="10"/></>);
export const MiRefresh = mkMenuIcon(() => <><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></>);

const S: Record<string, any> = {
  bar: { display: "flex", alignItems: "center", gap: 8, padding: "5px 12px",
    borderBottom: "1px solid var(--border,#e0e0e0)", fontSize: 11,
    color: "var(--text-dim,#666)", background: "var(--bg,#fff)", flexShrink: 0 },
  path: { fontFamily: "var(--font-mono, ui-monospace, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  btn: { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px",
    border: "1px solid var(--border,#d0d0d0)", borderRadius: 7, cursor: "pointer",
    background: "var(--bg-selected,#eef2ff)", color: "var(--text,#1a1a1a)",
    fontSize: 11, fontWeight: 500, fontFamily: "inherit" },
};
S.btnD = { ...S.btn, opacity: 0.5, cursor: "not-allowed", background: "var(--bg,#fff)" };

export function FileToolbar(props: {
  filePath: string;
  /** 状态点（缺省灰点=只读预览）；color/title 自定 */
  dot?: { title: string; color: string };
  /** ‹› 同目录深度遍历：siblings 清单 + 当前索引（-1=不在清单内）+ 步进回调 */
  nav?: { siblings: string[] | null; index: number; insertPos?: number; onStep: (d: number) => void };
  /** 瞬时通知（复制成功/重命名结果等） */
  notice?: { kind: string; text: string } | null;
  /** 左侧插槽：静态自定义元素（模式切换请用 modes——小屏自动变下拉） */
  leading?: any;
  /** 模式切换（markdown 编辑/分栏/预览等）：普通宽度渲染内联 tabs，很小屏（< MODE_DROPDOWN_AT）自动变下拉（当前项 ✓）。
   *  item.disabled = 禁用态（如无 edit 能力时「编辑」项），disabledTitle 替代 title 说明禁用原因。 */
  modes?: { items: { label: string; value: string; title?: string; disabled?: boolean; disabledTitle?: string }[]; value: string; onChange: (v: string) => void };
  /** 「打开方式」（M0 多编辑器仲裁，§1.4 位置 A）：命中队列全列；行点击 = 仅本次切换，
   *  ★ 点击 = 设为默认（服务端持久化）。items.length > 1 时才渲染 ▦ 按钮。 */
  openWith?: {
    items: Array<{ id: string; displayName: string; source?: string; badge: string; active: boolean; isDefault: boolean }>;
    onPick: (id: string) => void;
    onSetDefault: (id: string) => void;
  };
  /** 保存 / 另存为（⋯ 菜单项；提供即显示——编辑型工具条传入，只读查看器不传） */
  onSave?: () => void;
  onSaveAs?: () => void;
  /** 「关于编辑器」（M0）：当前生效编辑器的名称/能力/限制/依赖；提供即显示 ⋯ 菜单项。 */
  about?: {
    name: string;
    id: string;
    source?: string;
    summary?: string;
    capabilities?: string[];
    limits?: string[];
    vendor?: string;
    license?: string;
  };
  /** @ 提及（不传则不显示按钮） */
  onMention?: () => void;
  mentionTitle?: string;
  /** @ 到新会话（⋯ 菜单项）：新建会话并插入 @ 引用 */
  onMentionNewSession?: () => void;
  /** 文件信息（⋯ 菜单项）：弹出文件信息面板 */
  onFileInfo?: () => void;
  /** 右侧按钮插槽：保存 / 扩展注册动作 */
  rightExtra?: any;
  /** 最右信息：二进制类型的「图片 · 1.2 MB」标签 */
  trailing?: any;
  /** 紧跟文件名/‹›遍历之后的信息位（类型·大小·时长·实时态）——compact 仍显示，窄时省略号收敛 */
  infoAfterNav?: any;
  /** ⋯ 菜单顶部追加项（如 markdown 导出），渲染在默认项之前 */
  menuTop?: MenuAction[];
  /** 顶栏独立快捷下载按钮（⬇）；不设则仅 ⋯ 菜单内有「下载文件」；compact 态收进菜单 */
  downloadBtn?: boolean;
  onDownload?: () => void;
  onCopyPath?: () => void;
  /** 复制内容（⋯ 菜单项）：复制文件全部文本到剪贴板；只传给文本视图（大小限制由调用方负责） */
  onCopyContent?: () => void;
  onRename?: () => void;
  onOpenDir?: () => void;
  /** 移动到（⋯ 菜单项）：把当前文件移到目标目录（两级选择 workspace → 目录） */
  onMove?: () => void;
  /** 在独立窗口打开（pi-web /viewer：只含文件查看器的浏览器窗口）；不传则不显示 */
  onNewWindow?: () => void;
  /** 重新加载（⋯ 菜单项）：从磁盘重读最新内容；不传则不显示（aiti-folder 等其他使用方零影响） */
  onReload?: () => void;
  /** 关闭动作组（2026-09-15 拍板）：提供即渲染一排 4 图标（关闭左侧/自己/右侧/全部）；
   *  大屏在工具条右端常驻，compact 收进 ⋯ 菜单（同款图标排，名称+图标右对齐）。 */
  closeActions?: { left?: () => void; self?: () => void; right?: () => void; all?: () => void };
  /** 打开终端（当前文件所在目录；Unix=bash / Windows=PowerShell）；顶栏快捷按钮 + ⋯ 菜单项，compact 收进菜单 */
  onTerminal?: () => void;
}) {
  const { filePath, dot, nav, notice, leading, modes, openWith, about, onSave, onSaveAs, onMention, mentionTitle, onMentionNewSession, onFileInfo, rightExtra, trailing, menuTop, infoAfterNav } = props;
  const closeActions = props.closeActions;
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // 小屏系统返回 = 关闭「关于」弹窗
  useEffect(() => {
    if (!aboutOpen) return;
    return dismissOnBack(() => extSvc("pi-web.overlayBack"), () => setAboutOpen(false));
  }, [aboutOpen]);
  const barRef = useRef<any>(null);
  // 打开方式下拉（点外部关闭）
  const [owOpen, setOwOpen] = useState(false);
  useEffect(() => {
    if (!owOpen) return;
    const h = (e: any) => { if (!(e.target as Element).closest?.("[data-openwith-dd]")) setOwOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [owOpen]);
  // 小屏收敛：顶栏实测宽度 < COMPACT_AT → 次要按钮收进 ⋯ 菜单；< MODE_DROPDOWN_AT → modes 变下拉
  // （同一次 RO 实测派生两档，事件驱动非轮询）
  const [compact, setCompact] = useState(false);
  const [tiny, setTiny] = useState(false);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const update = () => { setCompact(el.clientWidth < COMPACT_AT); setTiny(el.clientWidth < MODE_DROPDOWN_AT); };
    update();
    let ro: any = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(update);
      ro.observe(el);
    } else {
      window.addEventListener("resize", update);
    }
    return () => { if (ro) ro.disconnect(); else window.removeEventListener("resize", update); };
  }, []);

  // modes 下拉（很小屏态）：点外部关闭
  const [modeOpen, setModeOpen] = useState(false);
  useEffect(() => {
    if (!modeOpen) return;
    const h = (e: any) => { if (!(e.target as Element).closest?.("[data-modes-dd]")) setModeOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [modeOpen]);
  // 当前模式项（下拉触发按钮文案用）；无 modes 或 value 不在清单内时取第一项展示
  const curMode = modes ? (modes.items.find((m) => m.value === modes.value) || modes.items[0]) : null;

  const menuItem = (a: MenuAction, key?: string | number) => (
    <button key={key} type="button" title={a.title || undefined}
      onClick={() => { a.onClick && a.onClick(); setMenuOpen(false); }}
      style={{ ...S.btn, padding: "5px 12px", background: "transparent", border: "none", justifyContent: "flex-start", width: "100%", textAlign: "left" }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {a.icon ? <span style={{ display: "inline-flex", flexShrink: 0 }}>{a.icon}</span> : null}
        {a.label}
      </span>
    </button>
  );
  const divider = <div style={{ height: 1, background: "var(--border,#eee)", margin: "2px 4px" }} />;

  // ── 关闭图标排（2026-09-15 拍板：关闭左侧 / 关闭自己 / 关闭右侧 / 全部关闭 = 一排
  //   无歧义图标；大屏工具条常驻 + compact 收进 ⋯ 菜单，hover tooltip 兜底）──
  const closeBtn = (fn: (() => void) | undefined, title: string, icon: any, size = 22) => fn ? (
    <button type="button" title={title} aria-label={title}
      onClick={() => { setMenuOpen(false); fn(); }}
      onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-hover,#f3f4f6)"; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.background = "transparent"; }}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: size, height: size, padding: 0, border: "none", borderRadius: 6,
        background: "transparent", color: "var(--text-muted,#777)", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}
    >{icon}</button>
  ) : null;
  const closeIconRow = closeActions ? (
    <div data-ext-close-icon-row="1" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "5px 10px" }}>
      <span style={{ fontSize: 12, color: "var(--text-dim,#888)", flexShrink: 0, userSelect: "none" }}>关闭</span>
      <div style={{ display: "flex", gap: 6, marginLeft: "auto", flexShrink: 0 }}>
        {closeBtn(closeActions.left, "关闭左侧", <MiCloseLeft size={16} />, 28)}
        {closeBtn(closeActions.self, "关闭", <MiX size={16} />, 28)}
        {closeBtn(closeActions.right, "关闭右侧", <MiCloseRight size={16} />, 28)}
        {closeBtn(closeActions.all, "关闭全部", <MiCloseAll size={16} />, 28)}
      </div>
    </div>
  ) : null;

  const sibIndex = nav ? nav.index : -1;
  const hasSibs = !!nav && !!nav.siblings && nav.siblings.length > 0;
  // 不在清单内时用插入点定位计数
  let posLabel = "";
  if (hasSibs) {
    const n = nav!.siblings!.length;
    const idx = nav!.index >= 0 ? nav!.index : Math.max(nav!.insertPos ?? 0, 0);
    posLabel = (idx >= n ? n : idx + (nav!.index >= 0 ? 1 : 0)) + "/" + n;
  }
  const navDisabled = !hasSibs;

  // ⋯ 菜单内容（大屏 = 全量功能入口；小屏额外承载被收敛进来的顶栏按钮）
  const menu = (
    <div style={{ position: "absolute", top: "100%", right: 0, zIndex: 100,
      display: "flex", flexDirection: "column", gap: 2, padding: 6, minWidth: 170,
      background: "var(--bg,#fff)", border: "1px solid var(--border,#d0d0d0)", borderRadius: 10,
      boxShadow: "0 4px 12px rgba(0,0,0,0.15)", fontSize: 12 }}>
      {/* ── 菜单分组重排（2026-09-16 用户拍板）：钉住 → 关闭排 → 导航（上/下一个文件）
       *    → 保存组（保存/另存/下载）→ @ 组（当前会话/新会话）→ 查看 → 整理 → 打开。
       *    关闭排与导航由 compact 专属改为常驻（菜单=全量命令中心；工具条按钮仍按 compact 收敛）。── */}
      {(menuTop || []).map((a, i) => menuItem(a, "menuTop-" + i))}
      {(menuTop || []).length > 0 && divider}
      {closeIconRow}
      {closeIconRow && divider}
      {hasSibs && nav && (
        <>
          {menuItem({ label: "上一个文件", title: "同目录深度遍历（原 ‹ 按钮）", icon: <MiChevronL />, onClick: () => nav.onStep(-1) })}
          {menuItem({ label: "下一个文件", title: "同目录深度遍历（原 › 按钮）", icon: <MiChevronR />, onClick: () => nav.onStep(1) })}
          {divider}
        </>
      )}
      {/* 保存组：保存 / 另存为 / 下载 / 重新加载 */}
      {onSave && menuItem({ label: "保存", title: "保存当前编辑内容（Ctrl+S）", icon: <MiSave />, onClick: onSave })}
      {onSaveAs && menuItem({ label: "另存为…", title: "把当前内容保存为新文件", icon: <MiSaveAs />, onClick: onSaveAs })}
      {props.onDownload && menuItem({ label: "下载文件", icon: <MiDownload />, onClick: props.onDownload })}
      {props.onReload && menuItem({ label: "重新加载", title: "从磁盘重读最新内容（有未保存编辑时会先询问：合并/加载磁盘/保留）", icon: <MiRefresh />, onClick: props.onReload })}
      {(onSave || onSaveAs || props.onDownload) && divider}
      {/* @ 组：当前会话 / 新会话 */}
      {onMention && menuItem({ label: "@ 提及", title: mentionTitle || "提及文件——将当前文件写入聊天输入框", icon: <MiAt />, onClick: onMention })}
      {onMentionNewSession && menuItem({ label: "@ 到新会话", title: "新建会话并在输入框插入当前文件的 @ 引用", icon: <MiAt />, onClick: onMentionNewSession })}
      {(onMention || onMentionNewSession) && divider}
      {/* 查看组 */}
      {about && menuItem({ label: "关于编辑器…", title: about.name + "——能力与限制", icon: <MiInfo />, onClick: () => setAboutOpen(true) })}
      {onFileInfo && menuItem({ label: "文件信息", title: "查看文件大小 / 修改时间等信息", icon: <MiInfo />, onClick: onFileInfo })}
      {props.onCopyPath && menuItem({ label: "复制路径", icon: <MiCopy />, onClick: props.onCopyPath })}
      {props.onCopyContent && menuItem({ label: "复制内容", title: "复制文件全部内容到剪贴板（超过 1MB 拒绝）", icon: <MiClipboard />, onClick: props.onCopyContent })}
      {(about || onFileInfo || props.onCopyPath || props.onCopyContent) && divider}
      {/* 整理组 */}
      {props.onRename && menuItem({ label: "重命名...", icon: <MiPencil />, onClick: props.onRename })}
      {props.onMove && menuItem({ label: "移动到...", title: "把当前文件移到其他目录", icon: <MiMove />, onClick: props.onMove })}
      {props.onOpenDir && menuItem({ label: "在目录打开", icon: <MiFolder />, onClick: props.onOpenDir })}
      {(props.onRename || props.onMove || props.onOpenDir) && divider}
      {/* 打开组 */}
      {props.onNewWindow && menuItem({ label: "在新窗口打开", title: "独立查看窗口（只有文件的浏览器窗口）", icon: <MiExternal />, onClick: props.onNewWindow })}
      {props.onTerminal && menuItem({ label: "打开终端", title: "在当前文件所在目录打开终端（Unix=bash / Windows=PowerShell）", icon: <TerminalIcon />, onClick: props.onTerminal })}
    </div>
  );

  return (
    <div ref={barRef} style={S.bar}>
      {/* 状态点 */}
      <span title={(dot && dot.title) || "只读预览"}
        style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
          background: (dot && dot.color) || "var(--border,#e0e0e0)" }} />
      {/* 文件名（完整路径进 title 悬浮）——信息紧随其后，长路径不再挤爆工具条 */}
      <span style={{ ...S.path, flex: "0 1 auto", minWidth: 40, maxWidth: "42%" }} title={filePath}>{filePath.split("/").pop() || filePath}</span>
      {/* ‹› 同目录深度遍历（compact 收进菜单） */}
      {nav && !compact && (
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          <button type="button" title="上一个文件（深度遍历）" disabled={navDisabled}
            onClick={() => nav.onStep(-1)}
            style={{ ...(navDisabled ? S.btnD : S.btn), padding: "3px 9px", display: "inline-flex", alignItems: "center" }}><MiChevronL size={14} /></button>
          <button type="button" title="下一个文件（深度遍历）" disabled={navDisabled}
            onClick={() => nav.onStep(1)}
            style={{ ...(navDisabled ? S.btnD : S.btn), padding: "3px 9px", display: "inline-flex", alignItems: "center" }}><MiChevronR size={14} /></button>
        </div>
      )}
      {hasSibs && !compact && (
        <span title={sibIndex >= 0
          ? ("深度遍历共 " + nav!.siblings!.length + " 个文件（仅文件，不含文件夹）")
          : ("当前文件不在遍历清单内，按路径序定位相邻文件（共 " + nav!.siblings!.length + " 个）")}
          style={{ flexShrink: 0, color: sibIndex >= 0 ? "var(--text-dim,#888)" : "var(--text-muted,#aaa)", fontSize: 10, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
          {posLabel}
        </span>
      )}
      {/* 信息位：类型 · 大小 · 时长 · 实时态（紧随文件名/‹›遍历之后） */}
      {infoAfterNav}
      {/* 弹性占位：把右侧按钮簇推到最右 */}
      <span style={{ flex: "1 1 auto", minWidth: 8 }} />
      {/* 通知（可收缩：行宽不够时自身省略号收敛，绝不把右侧按钮簇/⋮ 顶出可视区） */}
      {notice && <span style={{ color: notice.kind === "err" ? "var(--danger, #f87171)" : notice.kind === "ok" ? "var(--ok, #4ade80)" : "var(--warn, #f59e0b)", marginRight: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: compact ? 90 : 160, flexShrink: 1, minWidth: 0 }}>{notice.text}</span>}
      {/* 模式切换（编辑/分栏/预览等）：普通宽度内联 tabs；很小屏（< MODE_DROPDOWN_AT）变下拉进一步省空间 */}
      {modes && !tiny && (
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {modes.items.map((m) => (
            <button key={m.value} type="button" title={(m.disabled ? m.disabledTitle : m.title) || undefined} disabled={m.disabled}
              onClick={() => modes.onChange(m.value)}
              style={m.disabled ? { ...S.btn, opacity: 0.45, cursor: "not-allowed", background: "transparent", border: "none", color: "var(--text-muted,#888)" }
                : modes.value === m.value
                  ? { ...S.btn, background: "var(--bg-selected,#eef2ff)" }
                  : { ...S.btn, background: "transparent", border: "none", color: "var(--text-muted,#888)" }}
            >{m.label}</button>
          ))}
        </div>
      )}
      {modes && tiny && curMode && (
        <div data-modes-dd="1" style={{ position: "relative", flexShrink: 0 }}>
          <button type="button" title="视图模式" onClick={() => setModeOpen(!modeOpen)}
            style={{ ...S.btn, padding: "3px 8px", gap: 3 }}>{curMode.label}<span style={{ fontSize: 9, lineHeight: 1, opacity: 0.7 }}>{modeOpen ? "▲" : "▼"}</span></button>
          {modeOpen && (
            <div style={{ position: "absolute", top: "100%", left: 0, zIndex: 100,
              display: "flex", flexDirection: "column", gap: 2, padding: 6, minWidth: 110,
              background: "var(--bg,#fff)", border: "1px solid var(--border,#d0d0d0)", borderRadius: 10,
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)", fontSize: 12 }}>
              {modes.items.map((m) => {
                const cur = m.value === modes.value;
                return (
                  <button key={m.value} type="button" title={(m.disabled ? m.disabledTitle : m.title) || undefined} disabled={m.disabled}
                    onClick={() => { setModeOpen(false); modes.onChange(m.value); }}
                    style={{ ...S.btn, justifyContent: "flex-start", textAlign: "left", width: "100%",
                      background: "transparent", border: "none", padding: "5px 12px",
                      opacity: m.disabled ? 0.45 : 1, cursor: m.disabled ? "not-allowed" : "pointer",
                      fontWeight: cur ? 600 : 400, color: cur ? "var(--accent,#4f8ef7)" : "var(--text,#1a1a1a)" }}
                  >{m.label}{cur ? "  ✓" : ""}</button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {/* 左侧插槽（静态自定义元素） */}
      {leading}
      {/* 打开方式（▦，M0 多编辑器仲裁；多 provider 命中时才出现）：行点击=仅本次，★=设为默认 */}
      {openWith && openWith.items.length > 1 && (
        <div data-openwith-dd="1" style={{ position: "relative", flexShrink: 0 }}>
          <button type="button" title="打开方式（本文件类型有多个编辑器）" onClick={() => setOwOpen(!owOpen)}
            style={{ ...S.btn, padding: "3px 8px", fontSize: 13 }}>▦</button>
          {owOpen && (
            <div style={{ position: "absolute", top: "100%", right: 0, zIndex: 120,
              display: "flex", flexDirection: "column", gap: 1, padding: 6, minWidth: 240,
              background: "var(--bg,#fff)", border: "1px solid var(--border,#d0d0d0)", borderRadius: 10,
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)", fontSize: 12 }}>
              <div style={{ padding: "3px 8px 5px", fontWeight: 600, fontSize: 11, color: "var(--text-dim,#888)" }}>
                {"打开方式（★ = 设为默认）"}
              </div>
              {openWith.items.map((it) => (
                <div key={it.id}
                  title={it.active ? "当前生效" : "点击用此编辑器打开（仅本次）"}
                  onClick={() => { if (!it.active) { setOwOpen(false); openWith.onPick(it.id); } }}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 6,
                    cursor: it.active ? "default" : "pointer",
                    background: it.active ? "var(--bg-selected,#eef2ff)" : "transparent" }}
                  onMouseEnter={(e: any) => { if (!it.active) e.currentTarget.style.background = "var(--bg-hover,#f3f4f6)"; }}
                  onMouseLeave={(e: any) => { if (!it.active) e.currentTarget.style.background = "transparent"; }}>
                  <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    fontWeight: it.active ? 600 : 400, color: it.active ? "var(--accent,#4f8ef7)" : "var(--text,#1a1a1a)" }}>
                    {it.displayName}
                    {it.source ? <span style={{ color: "var(--text-dim,#888)", fontWeight: 400 }}> · {it.source}</span> : null}
                  </span>
                  <span title={it.badge.includes("✏️") ? (it.badge.includes("👁") ? "预览 + 编辑" : "编辑") : "预览"}
                    style={{ flexShrink: 0, fontSize: 11 }}>{it.badge}</span>
                  {it.active ? <span style={{ flexShrink: 0, color: "var(--accent,#4f8ef7)", fontSize: 11 }}>✓</span> : null}
                  <button type="button" title={it.isDefault ? "当前默认（点击无变化）" : "设为 " + it.displayName + " 为默认（持久化）"}
                    onClick={(e) => { e.stopPropagation(); if (!it.isDefault) { openWith.onSetDefault(it.id); setOwOpen(false); } }}
                    style={{ flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", fontSize: 13,
                      color: it.isDefault ? "var(--warn, #f59e0b)" : "var(--text-muted,#aaa)", padding: "0 2px", lineHeight: 1 }}>
                    {it.isDefault ? "★" : "☆"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* @ 提及（最高优先级：任何宽度恒留外面） */}
      {onMention && (
        <button type="button" title={mentionTitle || "提及文件——将当前文件写入聊天输入框"}
          onClick={onMention}
          style={{ ...S.btn, padding: "2px 8px", fontSize: 13, flexShrink: 0, fontFamily: "inherit" }}>{"\u0040"}</button>
      )}
      {/* 快捷下载（可选；compact 收进菜单——菜单内本就有「下载文件」） */}
      {props.downloadBtn && props.onDownload && !compact && (
        <button type="button" title="下载文件" onClick={props.onDownload}
          style={{ ...S.btn, padding: "3px 8px", fontSize: 13, flexShrink: 0 }}>⬇</button>
      )}
      {/* 右侧插槽（保存/扩展动作） */}
      {rightExtra}
      {/* 独立窗口快捷打开（B 图形 SVG，与 dock 图标规范统一；compact 收进菜单） */}
      {props.onNewWindow && !compact && (
        <button type="button" title="在新窗口打开（独立查看窗口）" onClick={props.onNewWindow}
          style={{ ...S.btn, padding: "3px 8px", display: "inline-flex", alignItems: "center", flexShrink: 0 }}><MiExternal size={14} /></button>
      )}
      {/* 终端快捷打开（🖥；compact 收进菜单——菜单内本就有「打开终端」） */}
      {props.onTerminal && !compact && (
        <button type="button" title="打开终端（当前文件所在目录）" onClick={props.onTerminal}
          style={{ ...S.btn, padding: "3px 8px", fontSize: 13, flexShrink: 0 }}>🖥</button>
      )}
      {/* 关闭图标排（左侧/自己/右侧/全部；大屏常驻，compact 收进 ⋯ 菜单） */}
      {closeActions && !compact && (
        <div data-ext-close-toolbar-row="1" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
          {closeBtn(closeActions.left, "关闭左侧", <MiCloseLeft size={14} />)}
          {closeBtn(closeActions.self, "关闭", <MiX size={14} />)}
          {closeBtn(closeActions.right, "关闭右侧", <MiCloseRight size={14} />)}
          {closeBtn(closeActions.all, "关闭全部", <MiCloseAll size={14} />)}
        </div>
      )}
      {/* 更多菜单（⋮，2026-09-16 重排）：钉住 → 关闭排 → 上/下一文件 → 保存组 → @组 → 查看/整理/打开 */}
      <div style={{ position: "relative", flexShrink: 0 }}>
        <button type="button" onClick={() => setMenuOpen(!menuOpen)}
          style={{ ...S.btn, padding: "4px 8px", fontWeight: 700 }} title="更多">⋮</button>
        {menuOpen && menu}
      </div>
      {/* 最右信息标签（compact 收进「文件信息」） */}
      {!compact && trailing}
      {/* 关于编辑器弹窗（⋯ 菜单触发；能力/限制/依赖/许可） */}
      {aboutOpen && about && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setAboutOpen(false); }}
          style={{ position: "fixed", inset: 0, zIndex: 900, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
        >
          <div style={{ width: 430, maxWidth: "94vw", maxHeight: "86vh", overflowY: "auto", padding: "16px 18px", borderRadius: 12,
            background: "var(--bg,#fff)", border: "1px solid var(--border,#ddd)", boxShadow: "0 12px 40px rgba(0,0,0,0.25)", fontSize: 13 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{about.name}</span>
              {about.source ? <span style={{ fontSize: 11, color: "var(--text-dim,#888)" }}>来自扩展 {about.source}</span> : null}
            </div>
            <div style={{ fontFamily: "var(--font-mono,ui-monospace,monospace)", fontSize: 11, color: "var(--text-dim,#888)", marginBottom: 10, wordBreak: "break-all" }}>{about.id}</div>
            {about.summary && <div style={{ marginBottom: 12, lineHeight: 1.5 }}>{about.summary}</div>}
            {(about.capabilities || []).length > 0 && (
              <>
                <div style={{ fontWeight: 600, fontSize: 12, margin: "10px 0 4px", color: "var(--text-dim,#888)" }}>能力</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {about.capabilities!.map((c, i) => (
                    <div key={i} style={{ display: "flex", gap: 6, lineHeight: 1.45 }}>
                      <span style={{ color: "#16a34a", flexShrink: 0 }}>✓</span><span>{c}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {(about.limits || []).length > 0 && (
              <>
                <div style={{ fontWeight: 600, fontSize: 12, margin: "12px 0 4px", color: "var(--text-dim,#888)" }}>限制</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {about.limits!.map((c, i) => (
                    <div key={i} style={{ display: "flex", gap: 6, lineHeight: 1.45 }}>
                      <span style={{ color: "#d97706", flexShrink: 0 }}>⚠</span><span>{c}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {(about.vendor || about.license) && (
              <div style={{ marginTop: 12, paddingTop: 8, borderTop: "1px solid var(--border,#eee)", fontSize: 11, color: "var(--text-dim,#888)" }}>
                {about.vendor ? <div>实现：{about.vendor}</div> : null}
                {about.license ? <div>许可：{about.license}</div> : null}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" onClick={() => setAboutOpen(false)} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 12px",
                border: "1px solid var(--border,#d0d0d0)", borderRadius: 7, cursor: "pointer", background: "var(--bg-selected,#eef2ff)",
                color: "var(--text,#1a1a1a)", fontSize: 12, fontWeight: 500, fontFamily: "inherit" }}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
