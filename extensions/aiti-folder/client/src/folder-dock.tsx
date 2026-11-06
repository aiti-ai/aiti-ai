/**
 * aiti-folder · 文件夹 dock faces —— 左栏文件区块（sidebar 统一 dock 方案 §3.5 + v2 多实例升级）。
 *
 * v2（2026-09-15）：文件夹区块从「编排器 props.blocks 常驻」升级为「本扩展动态注册的
 * dockable slot faces」——同一 itemKey 三面：
 *   · sidebarExplorerDock 栈 face（FolderDockBlock，gate = sidebar 族任意落位）
 *   · dialogs 浮窗 face（FolderFloatFace，gate = floating；data-ext-float 交 aiti-float 接管）
 *   · rightFileDock 右栏 face（FolderDockRightFace，gate = docked:right-panel）
 * itemKey 统一 = `aiti-folder:folder:<path>`（= 注册复合 id，dock 链路约定）——⋮ 菜单与
 * 全站 dockable 面板统一（浮窗/左栏·区块/右栏·面板/上移/下移/关闭）+ 本扩展专属「钉住」。
 *
 * 生命周期：项目切换 → 编排器调 syncFolderForCwd(cwd) 自动开新文件夹实例（已在清单则
 * 尊重现状）；未钉实例保留最多 3 个（FIFO 自动关闭挤出；钉住豁免配额）。清单单一事实源
 * = localStorage（跨 bundle 收敛——本扩展与 session-manager 经构建期内联各持一份模块，
 * localStorage + 事件保证两份收敛）+ window 事件广播（事件驱动零轮询）。
 */
import { useState, useEffect } from "react";
import { openFile, openFolder, getFeatures, apiUrl, t } from "./host-shim";
import { lastSeg } from "./lib";
import { FolderIcon, CaretIcon, MiSearch, MiRefresh, CheckIcon, PlusIcon, TerminalIcon, ChangesIcon, MiEye } from "./icons";
import { WorkspaceDropdown } from "./folder-switcher";
import {
  DockBody, closePanel, present, useGate, useGateSidebar,
  sidebarZoneOf, seedBlockCollapsedDefault, seedDockDefault, declareDockZones,
  declareDockWindowOpener, dockIconEl,
  SIDEBAR_COLLAPSE_PREFIX, clearDockPref,
  useDockHeaderStateOf, requestDockCommand,
} from "../../../_shared/ext-float-dock";
import { openViewerWindow } from "../../../_shared/open-viewer-window";
import type { DockZone, DockHeaderAction } from "../../../_shared/ext-float-dock";

/* ── 多实例清单（v2 条目带钉标；旧格式 string[] 兼容读）── */
const INSTANCES_KEY = "pi:sidebar-dock:folders";
export const INSTANCES_EVENT = "pi:sidebar-dock:folders-changed";
/** 未钉实例保留上限缺省值（FIFO：超限挤掉最旧未钉并关其面板；钉住豁免）。
 *  实际值读 session-manager feature `behavior.folder-quota`（extman 可改，默认 3）。
 *  ⚠ 配额强制只发生在 session-manager bundle 内联副本（+ 选择器/项目切换都在那边）——
 *  feature 也声明在 session-manager（getFeatures 只读声明方自己的 feature）。
 *  aiti-folder 自身副本读到空 → 回落缺省，无害。 */
const DEFAULT_MAX_UNPINNED = 3;

function maxUnpinnedFolders(): number {
  let raw: unknown;
  try { raw = getFeatures()["behavior.folder-quota"]; } catch { /* ignore */ }
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_UNPINNED;
  return Math.min(9, Math.max(1, n)); // 夹取 1..9；非法（含空串/0/非数字）回落 3
}

/** 清单条目（pin=1 已钉）。 */
export interface FolderEntry { p: string; pin?: 1 }

/* ── 显示忽略项（单 folder 粒度，与钉住同构：root 路径 → 开关；跨 bundle 收敛同款）──
 *  localStorage `pi:folder:show-ignored` = { [rootPath]: 1 }，每个 folder 面板独立；
 *  开启后目录列表请求带 hidden=1（宿主上游参数名；置灰条目前端按 hidden==="ignored" 识别）。 */
const SHOW_IGNORED_KEY = "pi:folder:show-ignored";
export const SHOW_IGNORED_EVENT = "pi:folder:show-ignored-changed";

function readShowIgnoredMap(): Record<string, unknown> {
  try {
    const raw = JSON.parse(localStorage.getItem(SHOW_IGNORED_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch { return {}; }
}
/** 某 folder（root 路径）是否开启「显示忽略项」 */
export function isShowIgnored(path: string): boolean {
  return !!readShowIgnoredMap()[path];
}
/** 翻转并返回新状态；localStorage + 事件广播（跨 bundle/跨 tab 收敛） */
export function toggleShowIgnored(path: string): boolean {
  const map = readShowIgnoredMap();
  const on = !map[path];
  const next = { ...map };
  if (on) next[path] = 1; else delete next[path];
  try { localStorage.setItem(SHOW_IGNORED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  try { window.dispatchEvent(new Event(SHOW_IGNORED_EVENT)); } catch { /* ignore */ }
  return on;
}
/** 显示忽略项状态 hook（⋮ 菜单 active 态；toggle 经事件回灌刷新，同钉住 INSTANCES_EVENT 机制） */
export function useShowIgnored(path: string): boolean {
  const [on, setOn] = useState<boolean>(() => isShowIgnored(path));
  useEffect(() => {
    const sync = () => setOn(isShowIgnored(path));
    window.addEventListener(SHOW_IGNORED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(SHOW_IGNORED_EVENT, sync); window.removeEventListener("storage", sync); };
  }, [path]);
  return on;
}

function normalizeEntries(raw: unknown): FolderEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FolderEntry[] = [];
  for (const x of raw) {
    if (typeof x === "string") out.push({ p: x });
    else if (x && typeof x === "object" && typeof (x as Record<string, unknown>).p === "string") {
      const e = x as FolderEntry;
      out.push(e.pin ? { p: e.p, pin: 1 } : { p: e.p });
    }
  }
  return out;
}

export function readFolderEntries(): FolderEntry[] {
  try { return normalizeEntries(JSON.parse(localStorage.getItem(INSTANCES_KEY) ?? "[]")); }
  catch { return []; }
}
function writeFolderEntries(entries: FolderEntry[]): void {
  try { localStorage.setItem(INSTANCES_KEY, JSON.stringify(entries)); } catch { /* ignore */ }
  try { window.dispatchEvent(new Event(INSTANCES_EVENT)); } catch { /* ignore */ }
}
/** 纯路径清单（遍历/展示用；钉标走 readFolderPins/isFolderPinned）。 */
export function readFolderInstances(): string[] { return readFolderEntries().map((e) => e.p); }
export function readFolderPins(): Set<string> {
  return new Set(readFolderEntries().filter((e) => e.pin).map((e) => e.p));
}

/** 区块 itemKey（faces 注册复合 id = itemKey，dock 方案链路约定；尾斜杠归一）。 */
export function folderItemKey(path: string): string {
  return `aiti-folder:folder:${path.replace(/[\\/]+$/, "")}`;
}

/** 文件夹「新窗口打开」（独立 viewer 窗；与 folder-browser 的目录菜单同链路）。 */
function openFolderWindow(p: string, cwd?: string): void {
  openViewerWindow(apiUrl, { path: p, kind: "folder", cwd });
}

/** 声明单实例可停靠位/默认位 + 播种默认折叠（幂等；添加与注册两侧都调）。
 *  文件夹默认折叠 = 政策延续（用户手动展开/折叠后永不覆盖）。
 *  同时声明「新窗口打开」能力（B 图标；据 2026-09-15 拍板仅文件/文件夹支持）。 */
export function declareFolderInstance(path: string): void {
  const key = folderItemKey(path);
  const zones: DockZone[] = [sidebarZoneOf(key), "right-panel"];
  seedBlockCollapsedDefault(key, true);
  seedDockDefault(key, sidebarZoneOf(key)); // 首次 open 直达左栏区块位（用户偏好优先）
  declareDockZones(key, zones, sidebarZoneOf(key));
  declareDockWindowOpener(key, () => openFolderWindow(path));
}

/** 添加实例（同路径去重）+ 未钉 FIFO 配额（>3 挤最旧未钉：移出清单 + 关其面板）。 */
export function addFolderInstance(path: string): void {
  const p = (path || "").trim();
  if (!p) return;
  declareFolderInstance(p);
  const entries = readFolderEntries();
  if (entries.some((e) => e.p === p)) return;
  let next: FolderEntry[] = [...entries, { p }];
  const unpinned = next.filter((e) => !e.pin);
  const victims = unpinned.slice(0, Math.max(0, unpinned.length - maxUnpinnedFolders()));
  if (victims.length > 0) {
    const victimSet = new Set(victims.map((e) => e.p));
    next = next.filter((e) => !victimSet.has(e.p));
    for (const v of victims) {
      try { present(folderItemKey(v.p), "close"); } catch { /* ignore */ }
      declareDockWindowOpener(folderItemKey(v.p), null); // FIFO 挤出同步注销新窗口能力
    }
  }
  writeFolderEntries(next);
}

/** 钉住切换（钉住 = 豁免 FIFO 自动关闭配额；跨刷新持久）。
 *  清单缺席（旧式 folder tab / 「打开上级目录」开的临时 tab 等非 dock 实例）→ 追加钉住条目：
 *  钉住语义 = 「保留为区块」，不能静默 no-op（否则 tab 菜单「钉住」看似无效，2026-09-18）。 */
export function toggleFolderPin(path: string): void {
  const p = (path || "").trim();
  if (!p) return;
  const entries = readFolderEntries();
  if (!entries.some((e) => e.p === p)) {
    writeFolderEntries([...entries, { p, pin: 1 }]);
    return;
  }
  writeFolderEntries(entries.map((e) => (e.p === p ? (e.pin ? { p } : { p, pin: 1 }) : e)));
}
export function isFolderPinned(path: string): boolean {
  return readFolderPins().has((path || "").trim());
}

/** 项目切换联动：当前 cwd 的文件夹区块**必定打开**（用户拍板 2026-09-15）：
 *  不管之前是否被拆出（浮窗/右栏）或关闭过——不在清单则加（含配额），然后无条件
 *  present(open) 带到面前（落位尊重用户偏好：浮窗偏好回浮窗、右栏偏好激活右栏 tab，
 *  均可见；栈位幂等无闪烁）。关闭过的切回来也重开，用户不用找「去哪了」。
 *  auto 标记 = 非用户打开（项目联动/刷新恢复）：小屏侧栏 overlay 不被拉起。 */
export function syncFolderForCwd(cwd: string | null | undefined): void {
  openFolderInstance(cwd, { auto: true });
}

/** ＋ 选择器/添加入口：不存在则加（含配额），已存在则按用户偏好重新带到面前。 */
export function openFolderInstance(path: string, opts?: { auto?: boolean }): void {
  const p = (path || "").trim();
  if (!p) return;
  addFolderInstance(p);
  try { present(folderItemKey(p), "open", opts); } catch { /* ignore */ }
}

/** 显式落位打开（pathPicker 顶栏选择器用）：加入清单 + 直接 dock 到指定区。
 *  dock tab 走宿主 TabBar 渲染——⇱ 位置菜单（浮窗/左栏/右栏/上移/下移）/✕/双击拆窗
 *  全套齐全；与旧式宿主 openFolder 文件夹 tab（无 dock 菜单）的本质区别在此。
 *  auto = 恢复性落位（宿主 select:false 后台打开）：宿主据此不拉小屏右栏、不递增 reveal。 */
export function openFolderDocked(path: string, zone: DockZone = "right-panel", opts?: { auto?: boolean }): void {
  const p = (path || "").trim();
  if (!p) return;
  addFolderInstance(p);
  try { present(folderItemKey(p), `dock:${zone}`, opts); } catch { /* ignore */ }
}

/** 移除实例（⋮「关闭」= 关面板 + 移出清单——与 FIFO 自动关闭同款对外语义）。 */
export function removeFolderInstance(path: string): void {
  const p = (path || "").trim();
  if (!p) return;
  writeFolderEntries(readFolderEntries().filter((e) => e.p !== p));
  try { present(folderItemKey(p), "close"); } catch { /* ignore */ }
  declareDockWindowOpener(folderItemKey(p), null); // 注销「新窗口打开」能力
}

/** 实例清单 hook（localStorage + 变更事件/跨 tab 订阅）。 */
export function useFolderInstances(): string[] {
  const [list, setList] = useState<string[]>(() => readFolderInstances());
  useEffect(() => {
    const sync = () => setList(readFolderInstances());
    sync();
    window.addEventListener(INSTANCES_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(INSTANCES_EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return list;
}

/** 钉标 hook（⋮ 菜单 active 态；toggle 经事件回灌）。 */
function useFolderPinned(path: string): boolean {
  const [pinned, setPinned] = useState<boolean>(() => isFolderPinned(path));
  useEffect(() => {
    const sync = () => setPinned(isFolderPinned(path));
    sync();
    window.addEventListener(INSTANCES_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(INSTANCES_EVENT, sync); window.removeEventListener("storage", sync); };
  }, [path]);
  return pinned;
}

/* ── 关闭即清形态偏好（用户拍板 2026-09-15）：文件夹面板任何路径关闭（浮窗 ✕ /
 *  TabBar ✕ / ⋮ 关闭 / FIFO 挤出）→ 清 dockpref，下次 open/刷新自动入栈回落默认位——
 *  避免「拉成浮窗关掉，刷新又弹出」；要浮窗再点一次 ⋮ 浮窗即可。
 *  停靠右栏且一直开着的偏好照旧跨刷新保留（没关就不清）。
 *  CHANGE_EVENT 同名同义（float 状态机与 _shared 降级层都发；双 bundle 各装一份监听，
 *  删同一 key 幂等无害）。 */
if (typeof window !== "undefined") {
  try {
    window.addEventListener("piwe-float-present-change", ((e: CustomEvent<{ key?: string; state?: string }>) => {
      const d = (e as CustomEvent<{ key?: string; state?: string }>).detail;
      if (!d || d.state !== "closed" || typeof d.key !== "string" || !d.key.startsWith("aiti-folder:folder:")) return;
      clearDockPref(d.key);
    }) as EventListener);
  } catch { /* ignore */ }
}

/** 旧 blockKey（folder:<path>，v1 props.blocks 时代）折叠记忆一次性迁移到 v2 itemKey
 *  （模块级 once 守卫；旧 key 保留不删——回滚旧宿主仍可读）。 */
let legacyFolderMigrated = false;
function migrateFolderCollapseKeys(): void {
  if (legacyFolderMigrated) return;
  legacyFolderMigrated = true;
  for (const p of readFolderInstances()) {
    const oldKey = `folder:${p.replace(/[\\/]+$/, "")}`;
    const newKey = folderItemKey(p);
    try {
      const old = localStorage.getItem(SIDEBAR_COLLAPSE_PREFIX + oldKey);
      if (old !== null && localStorage.getItem(SIDEBAR_COLLAPSE_PREFIX + newKey) === null) {
        localStorage.setItem(SIDEBAR_COLLAPSE_PREFIX + newKey, old);
      }
    } catch { /* ignore */ }
  }
}

/* ── FolderBrowser 懒加载（~113K 大头按需 import；同 entry.tsx D3 拆包范式——
 *   必须以组件渲染，严禁普通函数调用把 FolderBrowser 的 ~50 hooks 并进本壳） ── */
let FolderBrowserComp: ((props: any) => unknown) | null = null;
function FolderBrowserLazy(props: Record<string, unknown>) {
  const [, force] = useState(0);
  useEffect(() => {
    let alive = true;
    import("./folder-browser").then((m) => {
      if (!alive) return;
      FolderBrowserComp = m.FolderBrowser;
      force((n) => n + 1);
    });
    return () => { alive = false; };
  }, []);
  const Comp = FolderBrowserComp;
  return Comp ? <Comp {...(props as any)} /> : null;
}

/** 浏览器内容（三面共用）：窄容器 dense 适配（工具栏横向可滚）。
 *  dockItemKey 仅左栏区块 face 传（v3 单行化：工具条整行移除、按钮上提 dock 头）。 */
function FolderBrowserPane(props: {
  path: string;
  cwd?: string;
  onOpenFile?: (path: string) => void;
  onOpenFolder?: (path: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  gitRefreshKey?: number;
  dockItemKey?: string;
  /** 本 folder 的「显示忽略项」开关（单 folder 粒度；开启后列表带忽略条目置灰显示） */
  showIgnored?: boolean;
}) {
  const path = props.path;
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <FolderBrowserLazy
        dense
        filePath={path}
        cwd={props.cwd || path}
        onOpenFile={props.onOpenFile || ((p: string) => openFile(p))}
        onOpenFolder={props.onOpenFolder || ((p: string) => openFolder(p))}
        onAtMention={props.onAtMention}
        gitRefreshKey={props.gitRefreshKey}
        dockItemKey={props.dockItemKey}
        showIgnored={props.showIgnored === true}
      />
    </div>
  );
}

/** dock 头标题位 = 目录切换器（v3 §2.8）：显示当前目录名，点击弹 workspace 列表 /
 *  自定义路径 / 上一级；选择经 requestDockCommand 回内容执行（setRoot / parent）。 */
function FolderTitleSwitcher(props: { path: string; hasParent: boolean; onPick: (p: string) => void; onParent: () => void }) {
  const [open, setOpen] = useState(false);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: any) => { if (el && !el.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, el]);
  const norm = props.path.replace(/[\\/]+$/, "");
  const name = lastSeg(norm) || norm || "…";
  return (
    <span ref={setEl} style={{ position: "relative", display: "inline-flex", minWidth: 0, flex: "0 1 auto" }}>
      <button
        type="button" onClick={() => setOpen((v) => !v)} title={props.path}
        aria-label={"切换目录：" + props.path} aria-expanded={open ? "true" : "false"}
        style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, maxWidth: 170, padding: "2px 4px 2px 0", background: "none", border: "none", borderRadius: 5, color: "var(--text, #222)", cursor: "pointer", fontSize: 13, fontWeight: 500, fontFamily: "inherit" }}
      >
        <FolderIcon open={true} size={13} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1 }}>{name}</span>
        <CaretIcon />
      </button>
      {open ? (
        <WorkspaceDropdown
          selected={props.path}
          onSelect={(p) => { setOpen(false); if (p) props.onPick(p); }}
          onClose={() => setOpen(false)}
          extraTopItem={props.hasParent ? { label: "↑ " + t("files.parentDir"), onClick: () => { setOpen(false); props.onParent(); } } : undefined}
        />
      ) : null}
    </span>
  );
}

/** face 按钮事件 → 头行按钮矩形（dock 模式 plus 弹层锚点）。 */
function anchorRectOf(ev: unknown): { left: number; right: number; top: number; bottom: number } | undefined {
  try {
    const el = (ev as any)?.currentTarget as HTMLElement | undefined;
    if (!el || typeof el.getBoundingClientRect !== "function") return undefined;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  } catch { return undefined; }
}

/** 扩展 ctx（syncFolderDockFaces 注册时存）——face 经 ctx.getExtService 读宿主 "pi-web.ui"
 *  客户端服务（AppShell §7-4 hostUiRef：与 sidebarContent extra 同集，ref 委托最新渲染闭包）。 */
let folderExtCtx: Record<string, unknown> | null = null;

/** 三面 face 共用的宿主回调解析链（2026-09-16）：
 *  1) 插槽 rp（显式契约——session-manager slotExtra 全套透传，左栏栈路径）；
 *  2) "pi-web.ui" 服务兜底（onAtMention/onOpenFile/onOpenFolder/explorerRefreshKey/
 *     selectedCwd——右栏 dock tab（宿主 TabBody）与浮窗（dialogs slot）的渲染点不传 extra，
 *     此前 rp.onAtMention 恒 undefined → 右栏/浮窗形态 @ 能力整组静默消失；服务化后
 *     宿主无需逐插槽喂回调）。
 *  onOpenFile/onOpenFolder 消费前兜底 lastSeg fileName（缺省致宿主
 *  FileIcons.getFileIcon(undefined) 白屏，0ea18e37 教训；与 session-manager slotExtra 同口径）。 */
interface HostFaceCbs {
  cwd?: string;
  gitRefreshKey?: number;
  onOpenFile: (p: string) => void;
  onOpenFolder: (p: string, name?: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
}
function resolveHostFace(rp: Record<string, unknown> | null | undefined): HostFaceCbs {
  let hostUi: { get?: (name: string) => unknown; } | undefined;
  try {
    const getSvc = folderExtCtx?.getExtService as ((k: string) => unknown) | undefined;
    hostUi = getSvc ? getSvc("pi-web.ui") as { get?: (name: string) => unknown; } : undefined;
  } catch { /* 服务缺席/未就绪——rp 通道仍在 */ }
  const get = (name: string): unknown => {
    try { return hostUi?.get?.(name); } catch { return undefined; }
  };
  const fileNameOf = (p: string) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
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

/** 三面共用内容 props（编排器经 DockStack slotExtra 透传；缺席回退本扩展 shim）。 */
type FolderFaceProps = {
  path: string;
  cwd?: string;
  onOpenFile?: (path: string) => void;
  onOpenFolder?: (path: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  gitRefreshKey?: number;
};

/** 左栏栈 face（sidebarExplorerDock slot item render；gate = sidebar 族任意落位）。
 *  ⋮ 菜单与 dockable 全站统一（浮窗/左栏·区块/右栏·面板/上移/下移）+「钉住」+「关闭」
 *  （关闭 = 关面板并移出清单——FIFO 自动关闭的对外同款语义）。 */
export function FolderDockBlock(props: FolderFaceProps) {
  const path = props.path;
  const norm = path.replace(/[\\/]+$/, "");
  const itemKey = folderItemKey(path);
  const dockedZone = useGateSidebar(itemKey);
  const pinned = useFolderPinned(path);
  const showIgnored = useShowIgnored(path);
  // v3 单行化（§2.8）：按钮由本 face 声明（未挂载也能显示；点击未挂载命令 → store 展开+排队），
  // 状态/命令/菜单项由 FolderBrowser 注册；标题位 = 目录切换器。
  const st = useDockHeaderStateOf(itemKey);
  if (!dockedZone) return null;
  const title = lastSeg(norm) || norm;
  const gitCount = typeof st.gitCount === "number" ? st.gitCount : 0;
  const rootPath = typeof st.root === "string" && st.root ? st.root : norm;
  const actions: DockHeaderAction[] = [
    { id: "search", title: t("sidebar.searchFiles"), icon: <MiSearch/>, active: st.searchOpen === true, visibility: "always", onClick: () => { requestDockCommand(itemKey, "search"); } },
    { id: "terminal", title: t("files.openTerminal"), icon: <TerminalIcon/>, visibility: "always", onClick: () => { requestDockCommand(itemKey, "terminal"); } },
    { id: "refresh", title: t("sidebar.refreshExplorer"), icon: st.refreshDone === true ? <CheckIcon/> : <MiRefresh/>, done: st.refreshDone === true, visibility: "always", onClick: () => { requestDockCommand(itemKey, "refresh"); } },
    { id: "plus", title: t("files.newFile") + " / " + t("files.uploadFile"), icon: <PlusIcon/>, visibility: "expanded", onClick: (ev?: unknown) => { requestDockCommand(itemKey, "plus", { anchor: anchorRectOf(ev) }); } },
    { id: "changes", title: t("sidebar.changedFiles", { count: gitCount }), icon: <ChangesIcon/>, badge: gitCount > 0 ? gitCount : undefined, active: st.changesOpen === true, visibility: "expanded", onClick: () => { requestDockCommand(itemKey, "changes"); } },
    { id: "at", title: t("files.insertPath"), icon: <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1 }}>@</span>, visibility: "expanded", onClick: () => { requestDockCommand(itemKey, "at"); } },
  ];
  return (
    <DockBody
      itemKey={itemKey}
      blockKey={itemKey}
      title={title}
      chrome="section"
      kind="dockable"
      zones={[sidebarZoneOf(itemKey), "right-panel"]}
      defaultZone={sidebarZoneOf(itemKey)}
      headerActions={actions}
      renderTitle={() => (
        <FolderTitleSwitcher
          path={rootPath}
          hasParent={st.hasParent === true}
          onPick={(p) => requestDockCommand(itemKey, "setRoot", p)}
          onParent={() => requestDockCommand(itemKey, "parent")}
        />
      )}
      extraMenuItems={[
        { label: "钉住", icon: dockIconEl("pin", 13), active: pinned, alwaysRun: true, run: () => toggleFolderPin(path) },
        { label: "显示忽略项", icon: <MiEye />, active: showIgnored, alwaysRun: true, run: () => toggleShowIgnored(path) },
      ]}
      onNewWindow={() => openFolderWindow(norm, props.cwd)}
      onClose={() => removeFolderInstance(path)}
    >
      <FolderBrowserPane {...props} dockItemKey={itemKey} showIgnored={showIgnored} />
    </DockBody>
  );
}

/** 浮窗 face（dialogs slot item render；gate = floating）。标准浮窗壳（遮罩+面板），
 *  data-ext-float 属性交 aiti-float 接管（拖拽/缩放/位置持久化）。 */
export function FolderFloatFace(props: FolderFaceProps) {
  const key = folderItemKey(props.path);
  const open = useGate(key, "float");
  // 钩子须无条件：放在 gate 早退之后，关闭态（1 钩）→ 打开态（2 钩）同实例重渲染即 React「钩子数变多」崩
  const showIgnored = useShowIgnored(props.path);
  if (!open) return null;
  const norm = props.path.replace(/[\\/]+$/, "");
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 311, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => closePanel(key)}
    >
      <div
        data-ext-float="1"
        data-ext-float-key={key}
        data-ext-float-dock={`${sidebarZoneOf(key)} right-panel`}
        data-ext-float-dock-default={sidebarZoneOf(key)}
        style={{
          position: "fixed", width: "min(760px, 94vw)", height: "min(560px, 84vh)",
          display: "flex", flexDirection: "column", overflow: "hidden",
          background: "var(--bg-panel, #1a1a1a)", border: "1px solid var(--border, #444)",
          borderRadius: 12, boxShadow: "0 18px 60px rgba(0,0,0,0.4)", color: "var(--text, #ddd)",
        }}
        onClick={(e: any) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 6px", flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lastSeg(norm) || norm}</h3>
          <button
            type="button" aria-label="显示忽略项" title={showIgnored ? "隐藏被忽略项" : "显示被忽略项"}
            onClick={() => toggleShowIgnored(props.path)}
            style={{ background: "none", border: "none", color: showIgnored ? "var(--accent, #2563eb)" : "var(--text-muted, #888)", cursor: "pointer", padding: "2px 6px", display: "inline-flex", alignItems: "center", fontFamily: "inherit" }}
          ><MiEye /></button>
          <button
            type="button" aria-label="关闭" title="关闭" onClick={() => closePanel(key)}
            style={{ background: "none", border: "none", color: "var(--text-muted, #888)", cursor: "pointer", fontSize: 14, padding: "2px 8px", fontFamily: "inherit" }}
          >✕</button>
        </div>
        <FolderBrowserPane {...props} showIgnored={showIgnored} />
      </div>
    </div>
  );
}

/** 右栏 tab face（rightFileDock slot item render；gate = docked:right-panel）。
 *  chrome="tab"：无头行——页签行 ⇱（位置菜单）/✕ + 双击拆窗由宿主 TabBar 承担。
 *  collapsed 恒 false：折叠记忆按 itemKey 跨面共享（左栏区块播种默认折叠），
 *  而 tab face 无头行可展开——不覆盖则 DockBody「!collapsed && children」恒空壳。 */
export function FolderDockRightFace(props: FolderFaceProps) {
  const key = folderItemKey(props.path);
  const open = useGate(key, { dock: "right-panel" });
  // 同 FolderFloatFace：两个钩子必须在 gate 早退之前（条件钩子 = 重开 tab 即崩）
  const showIgnored = useShowIgnored(props.path);
  const pinned = useFolderPinned(props.path);
  if (!open) return null;
  return (
    <DockBody
      itemKey={key}
      chrome="tab"
      kind="dockable"
      zones={[sidebarZoneOf(key), "right-panel"]}
      defaultZone={sidebarZoneOf(key)}
      collapsed={false}
      extraMenuItems={[
        { label: "钉住", icon: dockIconEl("pin", 13), active: pinned, alwaysRun: true, run: () => toggleFolderPin(props.path) },
        { label: "显示忽略项", icon: <MiEye />, active: showIgnored, alwaysRun: true, run: () => toggleShowIgnored(props.path) },
      ]}
      onNewWindow={() => openFolderWindow(props.path.replace(/[\\/]+$/, ""), props.cwd)}
    >
      <FolderBrowserPane {...props} showIgnored={showIgnored} />
    </DockBody>
  );
}

/* ── 动态 faces 注册（aiti-folder entry 调用；instances 变化 → 重注册 + 差量 dispose）──
 *  注册 id 约定（createDockFaces 同款）：宿主 registerItems 自动拼 extId:itemId =
 *  itemKey —— raw id 必须不带扩展前缀（folder:<path>），拼后 = folderItemKey(p)，
 *  与 present 状态机/折叠/排序 key 精确一致；传带前缀 id 会双前缀断链（dock tab 链断裂）。
 *  registerExtUiItems 幂等覆盖不删旧项 → 收缩时对差量集合显式 disposeItems + 关面板
 *  （被挤出/移除实例若停在浮窗/右栏，宿主 tab/浮窗即时消隐）。 */
let prevFacePaths: string[] | null = null;
/** 常驻自动入栈由编排器驱动（stackApi 上线后 present，免「present 早于 float 状态机安装
 *  落进降级 store」竞态）；本模块只负责声明落位/默认折叠 + 三面注册。 */

/** 注册 raw id（无扩展前缀；宿主拼后 = folderItemKey）。 */
function folderRawId(path: string): string {
  return `folder:${path.replace(/[\\/]+$/, "")}`;
}

/* ── faces 注册项按路径缓存（render/meta 引用恒定）───────────────────────────────
 *  宿主 ExtSlot 以 `<it.render .../>` 渲染注册项——render 是**元素类型**，重注册换新闭包
 *  会被 React 视作换组件类型 → 卸载重挂整棵子树（FolderBrowser 的 root/展开集/滚动/
 *  搜索态全丢）。而 INSTANCES_EVENT 在「钉住」翻转时也触发本模块重注册——旧实现下点
 *  一下钉住，文件夹就被打回清单登记路径（root 重新播种 root0），表现为「钉住没反应，
 *  folder 改回旧值」。缓存后同一路径的 render/meta 引用恒定：重注册时宿主
 *  registerExtUiItems 的 unchanged 判定成立（或仅差量项变）→ 既有区块零重挂。
 *  ⚠ 缓存不可因「路径清单未变」而跳过重注册（扩展 disable/import 复用同 URL 模块实例
 *  时 modules 表虽被反卷、本模块内存仍在——跳过会导致 faces 永不回装）；保留每次全量
 *  重注册，靠引用恒定免重挂。
 *  faceOf 闭包只捕不可变路径 p；宿主 ctx 经模块级 folderExtCtx 读最新（重载后同步更新）。 */
type FolderFaceItem = { id: string; render: (rp: any) => unknown; meta?: Record<string, unknown> };
const faceItemsCache = new Map<string, { stack: FolderFaceItem; float: FolderFaceItem; right: FolderFaceItem }>();

function buildFaceItems(p: string): { stack: FolderFaceItem; float: FolderFaceItem; right: FolderFaceItem } {
  const title = lastSeg(p.replace(/[\\/]+$/, "")) || p;
  const rawId = folderRawId(p); // 宿主拼 extId: 前缀后 = folderItemKey(p)（注册 raw id 约定）
  // 三面共用解析：插槽 rp → pi-web.ui 服务兜底（resolveHostFace，含 fileName 兜底包装）
  const faceOf = (rp: any) => ({ path: p, ...resolveHostFace(rp) });
  const stack: FolderFaceItem = {
    id: rawId,
    render: (rp: any) => {
      const f = faceOf(rp);
      return <FolderDockBlock path={f.path} cwd={f.cwd} onOpenFile={f.onOpenFile} onOpenFolder={f.onOpenFolder} onAtMention={f.onAtMention} gitRefreshKey={f.gitRefreshKey} />;
    },
    meta: { title, priority: 2 },
  };
  const float: FolderFaceItem = {
    id: rawId,
    render: (rp: any) => {
      const f = faceOf(rp);
      return <FolderFloatFace path={f.path} cwd={f.cwd} onOpenFile={f.onOpenFile} onOpenFolder={f.onOpenFolder} onAtMention={f.onAtMention} gitRefreshKey={f.gitRefreshKey} />;
    },
    meta: { label: "文件夹", title },
  };
  const right: FolderFaceItem = {
    id: rawId,
    render: (rp: any) => {
      const f = faceOf(rp);
      return <FolderDockRightFace path={f.path} cwd={f.cwd} onOpenFile={f.onOpenFile} onOpenFolder={f.onOpenFolder} onAtMention={f.onAtMention} gitRefreshKey={f.gitRefreshKey} />;
    },
    meta: { title },
  };
  const entry = { stack, float, right };
  faceItemsCache.set(p, entry);
  return entry;
}

function faceItemsOf(p: string) {
  return faceItemsCache.get(p) ?? buildFaceItems(p);
}

export function syncFolderDockFaces(ctx: Record<string, unknown>): void {
  folderExtCtx = ctx; // face 渲染时读宿主 pi-web.ui 服务用（resolveHostFace）
  const register = ctx.registerItems as ((slot: string, items: FolderFaceItem[]) => void) | undefined;
  const dispose = ctx.disposeItems as ((slot: string, ids: string[]) => void) | undefined;
  migrateFolderCollapseKeys();
  const paths = readFolderInstances();
  const stackItems: FolderFaceItem[] = [];
  const floatItems: FolderFaceItem[] = [];
  const rightItems: FolderFaceItem[] = [];
  for (const p of paths) {
    declareFolderInstance(p);
    const { stack, float, right } = faceItemsOf(p);
    stackItems.push(stack);
    floatItems.push(float);
    rightItems.push(right);
  }
  if (prevFacePaths) {
    for (const p of prevFacePaths) {
      if (paths.includes(p)) continue;
      faceItemsCache.delete(p); // 移除路径：渲染闭包缓存一并回收（重新加入时重建）
      const raw = folderRawId(p);
      try { dispose?.("sidebarExplorerDock", [raw]); dispose?.("dialogs", [raw]); dispose?.("rightFileDock", [raw]); } catch { /* ignore */ }
      try { present(folderItemKey(p), "close"); } catch { /* ignore */ }
    }
  }
  try { register?.("sidebarExplorerDock", stackItems); } catch { /* ignore */ }
  try { register?.("dialogs", floatItems); } catch { /* ignore */ }
  try { register?.("rightFileDock", rightItems); } catch { /* ignore */ }
  prevFacePaths = paths;
}
