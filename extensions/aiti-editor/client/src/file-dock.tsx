/**
 * aiti-editor · 文件 dock faces —— 右栏 dock tab / 左栏区块 / 浮窗（folder-dock.tsx 三面模式）。
 * 方案：aiti-work/docs/file-dock-face-plan.md。
 *
 * **二元并存**（与 folder 全量迁移的差异，方案 §2）：普通打开照旧宿主 file tab；宿主
 * file tab ⇱「左栏 · 区块 / 右栏 · 面板」→ dockFile() 显式转 dock face（宿主 tab 移除，
 * 内容留 editorCache 无损）；face 存续期宿主 openFile 守卫改道 openFileFace() 激活；
 * face 关闭 → 移除实例 → 重开回落普通宿主 tab（与 folder「✕ 只关面板实例保留」刻意不同
 * ——文件 ✕ 语义 = 关文件）。
 *
 * itemKey = `aiti-editor:file:<path>`（注册 raw id = `file:<path>`，宿主拼 extId 前缀后
 * 精确相等；与宿主 fileTab id `file:<path>` 同形不同体系，互不相见）。无 FIFO 配额、
 * 无钉住（配额/钉住服务于 folder 左栏栈管理，文件不做）。
 */
import { useState, useEffect } from "react";
import { apiUrl } from "./host-shim";
import { EditorApp } from "./editor-app";
import { MiAt } from "./file-toolbar";
import { buildAtText, openNewSessionWithExtSvc } from "../../../_shared/new-session-cwd";
import {
  DockBody, present, useGate, useGateSidebar, useDockHeaderMenuItems,
  sidebarZoneOf, seedBlockCollapsedDefault, seedDockDefault, declareDockZones,
  declareDockWindowOpener, clearDockPref,
} from "../../../_shared/ext-float-dock";
import { openViewerWindow } from "../../../_shared/open-viewer-window";
import type { DockZone } from "../../../_shared/ext-float-dock";

/* ── 多实例清单（正在以 face 形态存续的文件；路径不带尾斜杠）── */
const INSTANCES_KEY = "pi:sidebar-dock:files";
export const INSTANCES_EVENT = "pi:sidebar-dock:files-changed";

function normPath(path: string): string {
  return (path || "").trim().replace(/[\\/]+$/, "");
}

function readFileInstances(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(INSTANCES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
function writeFileInstances(list: string[]): void {
  try { localStorage.setItem(INSTANCES_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  try { window.dispatchEvent(new Event(INSTANCES_EVENT)); } catch { /* ignore */ }
}

/** 区块 itemKey（faces 注册复合 id = itemKey，dock 方案链路约定）。 */
export function fileItemKey(path: string): string {
  return `aiti-editor:file:${normPath(path)}`;
}
/** 注册 raw id（无扩展前缀；宿主拼后 = fileItemKey）。 */
function fileRawId(path: string): string {
  return `file:${normPath(path)}`;
}
function fileNameOf(path: string): string {
  const p = normPath(path);
  return p.split(/[\\/]/).pop() || p || "…";
}

/** 「新窗口打开」（独立 viewer 窗；aiti-viewer 协议与工具条入口同链路）。 */
function openFileWindow(p: string, cwd?: string): void {
  openViewerWindow(apiUrl, { path: p, kind: "file", cwd });
}

/** 声明单实例可停靠位/默认位（幂等；添加与注册两侧都调）。
 *  文件默认位 = 右栏（主场）；左栏区块默认展开；新窗口能力进 dock ⇱ 菜单首项。 */
export function declareFileInstance(path: string): void {
  const key = fileItemKey(path);
  const zones: DockZone[] = [sidebarZoneOf(key), "right-panel"];
  seedBlockCollapsedDefault(key, false);
  seedDockDefault(key, "right-panel");
  declareDockZones(key, zones, "right-panel");
  declareDockWindowOpener(key, () => openFileWindow(normPath(path)));
}

/** 加入清单（同路径去重）。 */
export function addFileInstance(path: string): void {
  const p = normPath(path);
  if (!p) return;
  declareFileInstance(p);
  const list = readFileInstances();
  if (!list.includes(p)) writeFileInstances([...list, p]);
}

/** 移除实例（任何形态关闭的收尾）：清单删除 + 注销新窗口能力。
 *  present close 由 closed 监听/调用方负责（这里不重复发，避免与进行中的迁移竞态）。 */
export function removeFileInstance(path: string): void {
  const p = normPath(path);
  if (!p) return;
  const list = readFileInstances();
  if (list.includes(p)) writeFileInstances(list.filter((x) => x !== p));
  try { declareDockWindowOpener(fileItemKey(p), null); } catch { /* ignore */ }
}

/** 该 path 是否正以 face 形态存续（宿主 openFile 守卫用）。 */
export function hasFileFace(path: string): boolean {
  return readFileInstances().includes(normPath(path));
}

/** face 存续期把打开带到面前：加入清单（幂等）+ present(open)——落位走 dockpref
 *  （docked 原位激活 / floating 保持浮窗）；auto=恢复性打开（select:false）不拉小屏抽屉。 */
export function openFileFace(path: string, opts?: { auto?: boolean }): void {
  const p = normPath(path);
  if (!p) return;
  addFileInstance(p);
  try { present(fileItemKey(p), "open", opts); } catch { /* ignore */ }
}

/** 宿主 file tab ⇱ 显式停靠：加入清单（faces 同步注册）→ 先关宿主 tab（防双 EditorApp
 *  仲裁冲突；内容在 editorCache 无损）→ present dock:<zone>。zone 接受宿主语义 token
 *  "sidebar"（映射为本实例的 sidebar:<itemKey> 规范 zone——宿主不知道 itemKey）或任意
 *  具体 DockZone。 */
export function dockFile(path: string, zone: DockZone | "sidebar" = "right-panel"): void {
  const p = normPath(path);
  if (!p) return;
  const key = fileItemKey(p);
  const realZone: DockZone = zone === "sidebar" ? sidebarZoneOf(key) : zone;
  addFileInstance(p);
  try {
    const closeTabs = fileDockCtx?.closeFileTabs as ((ids: string[]) => void) | undefined;
    if (typeof closeTabs === "function") closeTabs([fileRawId(p)]);
  } catch { /* ignore */ }
  try { present(key, `dock:${realZone}`); } catch { /* ignore */ }
}

/** 关闭 face（浮窗 ✕/遮罩、左栏 ⋮ 关闭、FileToolbar 关闭自我重路由共用）：
 *  confirmClose 真关语义（脏文件弹自绘确认；放行即标 _sessionRemoveMark → 卸载时
 *  session-files remove）→ 移除实例 + present close。 */
export function closeFileFace(path: string): void {
  const p = normPath(path);
  if (!p) return;
  const confirm = (window as any).__aitiEditor?.confirmClose as ((fp: string, o?: unknown) => Promise<boolean>) | undefined;
  const proceed = () => {
    removeFileInstance(p);
    try { present(fileItemKey(p), "close"); } catch { /* ignore */ }
  };
  if (typeof confirm === "function") {
    Promise.resolve(confirm(p)).then((ok) => { if (ok !== false) proceed(); }).catch(() => {});
  } else {
    proceed();
  }
}

/* ── 关闭即清形态偏好 + 移除实例（folder「关闭即清形态偏好」同款 + 文件版关闭语义）：
 *  任何路径关闭（TabBar ✕ / 浮窗 ✕ / 遮罩 / ⋮ 关闭）→ 清 dockpref + 移出清单——
 *  避免「拉成浮窗关掉，刷新又弹出」；重开回落普通宿主 tab（方案 §2）。 */
const FILE_KEY_PREFIX = "aiti-editor:file:";
if (typeof window !== "undefined") {
  try {
    window.addEventListener("piwe-float-present-change", ((e: CustomEvent<{ key?: string; state?: string }>) => {
      const d = (e as CustomEvent<{ key?: string; state?: string }>).detail;
      if (!d || d.state !== "closed" || typeof d.key !== "string" || !d.key.startsWith(FILE_KEY_PREFIX)) return;
      clearDockPref(d.key);
      removeFileInstance(d.key.slice(FILE_KEY_PREFIX.length));
    }) as EventListener);
  } catch { /* ignore */ }
}

/* ── 扩展 ctx（syncFileDockFaces 注册时存）——face 经 ctx.getExtService 读宿主 "pi-web.ui"
 *  客户端服务（AppShell hostUiRef：与 folder resolveHostFace 同集）+ closeFileTabs 宿主 API。 */
let fileDockCtx: Record<string, unknown> | null = null;

/** face 共用的宿主回调解析链（folder resolveHostFace 同款）：
 *  1) 插槽 rp（显式契约）；2) "pi-web.ui" 服务兜底（右栏 dock tab/浮窗渲染点不传 extra）。
 *  onOpenFile/onOpenFolder 消费前兜底 lastSeg fileName（缺省致宿主 getFileIcon(undefined)
 *  白屏，0ea18e37 教训；与 folder 同口径）。 */
interface HostFaceCbs {
  cwd?: string;
  gitRefreshKey?: number;
  onOpenFile: (p: string) => void;
  onOpenFolder: (p: string, name?: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
}
function resolveFileHost(rp: Record<string, unknown> | null | undefined): HostFaceCbs {
  let hostUi: { get?: (name: string) => unknown } | undefined;
  try {
    const getSvc = fileDockCtx?.getExtService as ((k: string) => unknown) | undefined;
    hostUi = getSvc ? getSvc("pi-web.ui") as { get?: (name: string) => unknown } : undefined;
  } catch { /* 服务缺席/未就绪——rp 通道仍在 */ }
  const get = (name: string): unknown => {
    try { return hostUi?.get?.(name); } catch { return undefined; }
  };
  const openFile = (rp?.onOpenFile ?? get("onOpenFile")) as ((p: string, n?: string) => void) | undefined;
  const openFolder = (rp?.onOpenFolder ?? get("onOpenFolder")) as ((p: string, n?: string) => void) | undefined;
  return {
    cwd: (rp?.cwd ?? get("selectedCwd")) as string | undefined,
    gitRefreshKey: (rp?.gitRefreshKey ?? get("explorerRefreshKey")) as number | undefined,
    onOpenFile: (p: string) => { try { openFile?.(p, fileNameOf(p)); } catch { /* noop */ } },
    onOpenFolder: (p: string, name?: string) => { try { openFolder?.(p, name || fileNameOf(p)); } catch { /* noop */ } },
    onAtMention: (rp?.onAtMention ?? get("onAtMention")) as HostFaceCbs["onAtMention"],
  };
}

/** 三面共用内容 props（编排器 faceOf 解析后透传）。 */
type FileFaceProps = {
  path: string;
  cwd?: string;
  gitRefreshKey?: number;
  onOpenFile?: (path: string) => void;
  onOpenFolder?: (path: string, name?: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
};

/** face 内 EditorApp props：onFaceClose = FileToolbar「关闭」自我重路由（face 态宿主 tab
 *  不存在）+ applyTabCap 跳过 + 钉住项隐藏的 face 态开关（editor-app 消费）。 */
function editorFaceAppProps(props: FileFaceProps, path: string): Record<string, unknown> {
  return {
    filePath: path,
    cwd: props.cwd,
    gitRefreshKey: props.gitRefreshKey,
    onOpenFile: props.onOpenFile,
    onOpenFolder: props.onOpenFolder,
    onAtMention: props.onAtMention,
    onFaceClose: () => closeFileFace(path),
  };
}

/** 左栏栈 face（sidebarExplorerDock slot item render；gate = sidebar 族任意落位）。
 *  chrome="section" 头行只含 文件名/⇱/⋮（不加 headerActions——FileToolbar 保留全量动作、
 *  compact 自适应窄栏；工具条命令上提是 folder v3 的事，文件不跟进，方案 §6）。 */
export function FileDockBlock(props: FileFaceProps) {
  const path = normPath(props.path);
  const key = fileItemKey(path);
  const dockedZone = useGateSidebar(key);
  // ⋮ 头菜单引用组（2026-11-24 用户补齐：与 folder 区块头菜单对齐）——@ 提及（宿主回调，条件渲染）
  // + @ 到新会话（extSvc 缺席时 openNewSessionWithExtSvc 自动降级同源实现）。
  const extSvc = (k: string) => (fileDockCtx as any)?.getExtService?.(k);
  useDockHeaderMenuItems(key, [
    ...(props.onAtMention ? [{
      kind: "item" as const, id: "at", label: "@ 到聊天", icon: <MiAt />,
      run: () => { try { props.onAtMention!(path, false); } catch { /* noop */ } },
    }] : []),
    {
      kind: "item" as const, id: "atn", label: "@ 到新会话", icon: <MiAt />,
      run: () => { void openNewSessionWithExtSvc({ text: buildAtText(path), targetDir: path.slice(0, path.lastIndexOf("/")) || path, targetPath: path, currentCwd: props.cwd, apiUrl, extSvc }); },
    },
    { kind: "sep" as const },
    {
      kind: "item" as const, id: "cp", label: "复制路径",
      run: () => { try { navigator.clipboard?.writeText(path); } catch { /* noop */ } },
    },
  ]);
  if (!dockedZone) return null;
  return (
    <DockBody
      itemKey={key}
      blockKey={key}
      title={fileNameOf(path)}
      chrome="section"
      kind="dockable"
      zones={[sidebarZoneOf(key), "right-panel"]}
      defaultZone="right-panel"
      onNewWindow={() => openFileWindow(path, props.cwd)}
      onClose={() => closeFileFace(path)}
    >
      <EditorApp {...(editorFaceAppProps(props, path) as any)} />
    </DockBody>
  );
}

/** 浮窗 face（dialogs slot item render；gate = floating）。标准浮窗壳（遮罩+面板），
 *  data-ext-float 属性交 aiti-float 接管（拖拽/缩放/位置持久化）。✕/遮罩 = 确认关闭。 */
export function FileFloatFace(props: FileFaceProps) {
  const path = normPath(props.path);
  const key = fileItemKey(path);
  const open = useGate(key, "float");
  if (!open) return null;
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 311, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => closeFileFace(path)}
    >
      <div
        data-ext-float="1"
        data-ext-float-key={key}
        data-ext-float-dock={`${sidebarZoneOf(key)} right-panel`}
        data-ext-float-dock-default="right-panel"
        style={{
          position: "fixed", width: "min(900px, 94vw)", height: "min(680px, 84vh)",
          display: "flex", flexDirection: "column", overflow: "hidden",
          background: "var(--bg-panel, #1a1a1a)", border: "1px solid var(--border, #444)",
          borderRadius: 12, boxShadow: "0 18px 60px rgba(0,0,0,0.4)", color: "var(--text, #ddd)",
        }}
        onClick={(e: any) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 6px", flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={path}>{fileNameOf(path)}</h3>
          <button
            type="button" aria-label="关闭" title="关闭" onClick={() => closeFileFace(path)}
            style={{ background: "none", border: "none", color: "var(--text-muted, #888)", cursor: "pointer", fontSize: 14, padding: "2px 8px", fontFamily: "inherit" }}
          >✕</button>
        </div>
        <EditorApp {...(editorFaceAppProps(props, path) as any)} />
      </div>
    </div>
  );
}

/** 右栏 tab face（rightFileDock slot item render；gate = docked:right-panel）。
 *  chrome="tab"：无头行——页签 ⇱（位置菜单四连）/✕（宿主特判脏确认）/双击浮窗由宿主
 *  TabBar 承担（folder 同款）。collapsed 恒 false：tab face 无头行可展开。 */
export function FileDockRightFace(props: FileFaceProps) {
  const path = normPath(props.path);
  const key = fileItemKey(path);
  const open = useGate(key, { dock: "right-panel" });
  if (!open) return null;
  return (
    <DockBody
      itemKey={key}
      chrome="tab"
      kind="dockable"
      zones={[sidebarZoneOf(key), "right-panel"]}
      defaultZone="right-panel"
      collapsed={false}
      onNewWindow={() => openFileWindow(path, props.cwd)}
    >
      <EditorApp {...(editorFaceAppProps(props, path) as any)} />
    </DockBody>
  );
}

/* ── 动态 faces 注册（entry 调用；instances 变化 → 重注册 + 差量 dispose）──
 *  注册 raw id 约定（folder-dock 同款）：宿主 registerItems 自动拼 extId:itemId =
 *  itemKey——raw id 必须不带扩展前缀（file:<path>），传带前缀 id 会双前缀断链。
 *  registerExtUiItems 幂等覆盖不删旧项 → 收缩时对差量集合显式 disposeItems + 关面板。 */
let prevFacePaths: string[] | null = null;

export function syncFileDockFaces(ctx: Record<string, unknown>): void {
  fileDockCtx = ctx;
  const register = ctx.registerItems as ((slot: string, items: Array<{ id: string; render: (props: any) => unknown; meta?: Record<string, unknown> }>) => void) | undefined;
  const dispose = ctx.disposeItems as ((slot: string, ids: string[]) => void) | undefined;
  const paths = readFileInstances();
  const stackItems: Array<{ id: string; render: (props: any) => unknown; meta?: Record<string, unknown> }> = [];
  const floatItems: typeof stackItems = [];
  const rightItems: typeof stackItems = [];
  for (const p of paths) {
    const title = fileNameOf(p);
    declareFileInstance(p);
    // 三面共用解析：插槽 rp（回调契约）→ pi-web.ui 服务兜底（resolveFileHost，
    // 含 fileName 兜底包装）；path 恒取实例路径（rp 不供 path）
    const faceOf = (rp: any): FileFaceProps => {
      const f = resolveFileHost(rp);
      return { path: normPath(p), cwd: f.cwd, gitRefreshKey: f.gitRefreshKey, onOpenFile: f.onOpenFile, onOpenFolder: f.onOpenFolder, onAtMention: f.onAtMention };
    };
    const rawId = fileRawId(p);
    stackItems.push({
      id: rawId,
      render: (rp: any) => <FileDockBlock {...(faceOf(rp) as any)} />,
      meta: { title, priority: 2 },
    });
    floatItems.push({
      id: rawId,
      render: (rp: any) => <FileFloatFace {...(faceOf(rp) as any)} />,
      meta: { label: "文件", title },
    });
    rightItems.push({
      id: rawId,
      render: (rp: any) => <FileDockRightFace {...(faceOf(rp) as any)} />,
      meta: { title },
    });
  }
  if (prevFacePaths) {
    for (const p of prevFacePaths) {
      if (paths.includes(p)) continue;
      const raw = fileRawId(p);
      try { dispose?.("sidebarExplorerDock", [raw]); dispose?.("dialogs", [raw]); dispose?.("rightFileDock", [raw]); } catch { /* ignore */ }
      try { present(fileItemKey(p), "close"); } catch { /* ignore */ }
    }
  }
  try { register?.("sidebarExplorerDock", stackItems); } catch { /* ignore */ }
  try { register?.("dialogs", floatItems); } catch { /* ignore */ }
  try { register?.("rightFileDock", rightItems); } catch { /* ignore */ }
  // 刷新回归（方案 §4）：实例在清单 = face 应存活（任何关闭路径都会移除实例）。
  // 本扩展是懒加载——物化后首帧 dock 机器内存态已复位 closed，而 dockpref 持久；
  // 按 pref + 已播种默认位重 present open（auto=恢复性打开，不拉小屏抽屉/不递增 reveal）。
  if (prevFacePaths === null) {
    for (const p of paths) {
      try { present(fileItemKey(p), "open", { auto: true }); } catch { /* ignore */ }
    }
  }
  prevFacePaths = paths;
}

/** 实例清单 hook（localStorage + 变更事件/跨 tab 订阅；本扩展 UI 需要时用）。 */
export function useFileInstances(): string[] {
  const [list, setList] = useState<string[]>(() => readFileInstances());
  useEffect(() => {
    const sync = () => setList(readFileInstances());
    sync();
    window.addEventListener(INSTANCES_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(INSTANCES_EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return list;
}
