/**
 * aiti-quickstart · quickstart-logic —— 纯逻辑层（零 JSX、零 ctx，可单测）。
 *
 * 内容：
 *   - widget 元数据常量（manifest 静态条目与 client 注册条目共用，杜绝漂移）；
 *   - 侧栏引导卡关闭态存取（localStorage）；
 *   - openQuickstart 目标 cwd 解析链（**URL 规范：cwd 不进 URL**——来源 =
 *     tab-session 记忆 → window.__piWebCwd → 最近项目 → home 兜底）；
 *   - v2 工作区获取：git URL 解析（arg-array 安全）/ 目录名防覆盖顺延 /
 *     初次使用状态机 / 获取历史 + 目录扫描合并。
 */

export const EXT_ID = "aiti-quickstart";
/** client 服务 key：session-manager 编排器消费（renderQuickstart → DockStack filler）。 */
export const SERVICE_KEY = "aiti-quickstart.api";
/** sidebarFooter 条目 id（manifest 静态条目与 client 注册条目必须同 id——接管语义）。 */
export const FOOTER_ITEM_ID = "quickstart-open";
/** 引导卡关闭态（客户端偏好，与 dock 折叠键同范式：pi:<ext>:<purpose>）。 */
export const DISMISS_KEY = "pi:quickstart:sidebar-dismissed";

/** widget 多语标题 key（qs.guideTitle / qs.shortcutsTitle / qs.rt.title / qs.examplesTitle）。 */
export const WIDGET_TITLE_KEYS: Record<string, string> = {
  guide: "qs.guideTitle",
  shortcuts: "qs.shortcutsTitle",
  streaming: "qs.rt.title",
  examples: "qs.examplesTitle",
};

export interface QuickstartWidgetMeta {
  id: string;
  areas: Array<"top" | "bottom">;
  defaultArea: "top" | "bottom";
  /** 1..8（桌面 8 列 / 手机 4 列，宿主 clamp）。 */
  w: number;
  /** 1..3（宿主 clamp）。 */
  h: number;
  priority: number;
}

/**
 * widget 元数据（manifest ui.newSessionWidgets 静态条目与 client 注册条目共用）。
 * 布局语义见宿主 lib/new-session-widgets.ts（normalizeWidgetItem 越界钳制 + ⚙ 自定义偏好）。
 */
export const WIDGET_METAS: QuickstartWidgetMeta[] = [
  // guide priority -1（非 0）：宿主 builtin:recent 同为 p0 且注册序在前——recent(w4)
  // 先占行1 后 guide(w8) 掉行2、shortcuts 掉行3，三行叠加超 top 区 min(300px,38vh)
  // 内滚上限 → 快捷操作卡裁切需滚动（2026-11-07 用户实测）。-1 让 guide 先占行1
  // 独占整行；h=1：宿主网格 gridAutoRows: minmax(64px,auto)，行高按内容自动撑开。
  // areas 全开双区（2026-11-07 用户问「能否移动」）：⚙ 面板可跨 top/bottom 挪动，
  // defaultArea 保持各自语义默认（挪动后 pref 持久化）。
  { id: "guide", areas: ["top", "bottom"], defaultArea: "top", w: 8, h: 1, priority: -1 },
  // shortcuts w8（2026-11-07 用户拍板：与快速上手同宽整行）；4 列 kbd 行式 ×2 行（8 项）。
  { id: "shortcuts", areas: ["top", "bottom"], defaultArea: "top", w: 8, h: 1, priority: 10 },
  // streaming p15（shortcuts 10 与 examples 20 之间）：任务运行时概念卡——图标/配色
  // 复刻宿主 ChatInput 流式按钮区（fork/侧聊/插队/排队/继续），卡片即按钮图例。
  { id: "streaming", areas: ["top", "bottom"], defaultArea: "top", w: 8, h: 1, priority: 15 },
  { id: "examples", areas: ["top", "bottom"], defaultArea: "bottom", w: 8, h: 1, priority: 20 },
];

/** 任务运行时卡行 key（descKey 为对应描述 key；图标/配色在组件层与宿主流式按钮对齐）。
 *  行序 = 流式按钮出现序（fork → 侧聊 → 插队 → 排队）+ 继续。 */
export const RUNTIME_ROWS: Array<{ key: string; descKey: string }> = [
  { key: "qs.rt.fork", descKey: "qs.rt.forkDesc" },
  { key: "qs.rt.sideChat", descKey: "qs.rt.sideChatDesc" },
  { key: "qs.rt.steer", descKey: "qs.rt.steerDesc" },
  { key: "qs.rt.followUp", descKey: "qs.rt.followUpDesc" },
  { key: "qs.rt.continue", descKey: "qs.rt.continueDesc" },
];

/* ── 引导卡关闭态（localStorage 单一事实源；无事件广播——filler 重渲染时现读） ── */

export function readSidebarDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarDismissed(dismissed: boolean): void {
  try {
    if (dismissed) localStorage.setItem(DISMISS_KEY, "1");
    else localStorage.removeItem(DISMISS_KEY);
  } catch {
    /* ignore */
  }
}

/* ── openQuickstart 目标 cwd 解析链 ── */

export interface QuickstartCwdSource {
  /** 当前标签页 tab-session 记忆的 composer cwd（pi-web:tab-open-session kind:"new"；欢迎页态）。 */
  tabCwd: string | null;
  /** 当前会话 cwd（window.__piWebCwd；会话视图态）。 */
  sessionCwd: string | null;
  /** 最近项目根（/api/sessions 派生 top1；见 topRecentRoot）。 */
  recentRoot: string | null;
  /** home 兜底（宿主共享单例 pi-web.home.ensure() 结果）。 */
  home: string | null;
}

/**
 * 解析「重返快速上手页」的目标 cwd。**cwd 不进 URL（pi-web URL 规范）**——
 * 来源全部是内存/存储态：tab-session 记忆 → 当前会话 cwd → 最近项目 → home。
 */
export function resolveQuickstartCwd(src: QuickstartCwdSource): string | null {
  const cwd = (src.tabCwd && src.tabCwd.trim())
    || (src.sessionCwd && src.sessionCwd.trim())
    || (src.recentRoot && src.recentRoot.trim())
    || (src.home && src.home.trim())
    || "";
  return cwd || null;
}

/** 从 /api/sessions 行派生最近项目根 top1（与宿主 getRecentProjects 同语义：projectRoot ?? cwd，去重按 modified 降序）。 */
export function topRecentRoot(sessions: Array<{ cwd?: string; projectRoot?: string | null; modified?: string | number | null }>): string | null {
  const best = new Map<string, number>();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const root = (s.projectRoot && String(s.projectRoot).trim()) || (s.cwd && String(s.cwd).trim()) || "";
    if (!root) continue;
    const t = typeof s.modified === "number" ? s.modified : (s.modified ? Date.parse(String(s.modified)) : 0);
    const prev = best.get(root) ?? -1;
    if (t > prev) best.set(root, t);
  }
  let top: { root: string; t: number } | null = null;
  for (const [root, t] of best) if (!top || t > top.t) top = { root, t };
  return top?.root ?? null;
}

/* ── v2：git URL 解析（clone）── */

export interface ParsedGitUrl {
  /** 传给 git clone 的实际 URL/路径。 */
  ref: string;
  /** #fragment 指定的分支（https 形态）。 */
  branch?: string;
  /** 从 URL 尾段派生的目录名（[A-Za-z0-9._-] 清洗）。 */
  name: string;
  /** 本地路径形态（非远程）。 */
  local: boolean;
}

function nameFromGitUrl(url: string): string {
  const clean = url.replace(/[\\/]+$/, "").replace(/\.git$/, "");
  const tail = clean.split(/[\\/]/).pop() ?? clean;
  return tail.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "") || "workspace";
}

/** git clone 前导控制字符/引号拒绝（URL 永远走 arg-array，但仍拒绝以 - 开头的选项注入面）。 */
function isUnsafeGitArg(s: string): boolean {
  return /^-/.test(s) || /[\u0000-\u001f\u007f]/.test(s);
}

/**
 * 解析 git 来源（参照 aiti-extman parseInstallSource 的 git 分支形状 + 本地路径放宽）：
 *   - `https://host/…/repo.git[#branch]`（github/gitlab 无 .git 亦可）
 *   - `git@host:path(/repo.git)`
 *   - `git:<url>[#branch]`
 *   - 本地绝对路径（`/…`、`~/…`、盘符）——内网/测试友好
 * 返回 null = 不识别（调用方 400）。分支/URL 均过 isUnsafeGitArg（防选项注入）。
 */
export function parseGitUrl(source: string): ParsedGitUrl | null {
  const s = (source ?? "").trim();
  if (!s) return null;

  const gitPrefix = s.match(/^git:(.+?)(?:#([^#]+))?$/);
  if (gitPrefix) {
    const ref = gitPrefix[1];
    const branch = gitPrefix[2];
    if (isUnsafeGitArg(ref) || (branch && isUnsafeGitArg(branch))) return null;
    return { ref, branch: branch || undefined, name: nameFromGitUrl(ref), local: !/^[a-z]+:\/\//i.test(ref) };
  }

  if (/^git@[\w.-]+:/.test(s)) {
    if (isUnsafeGitArg(s)) return null;
    return { ref: s, name: nameFromGitUrl(s), local: false };
  }

  if (/^https?:\/\//i.test(s) && (/\.git(?:#|$|\/)/.test(s) || /github\.com\//i.test(s) || /gitlab\.com\//i.test(s))) {
    const hash = s.indexOf("#");
    const url = hash > 0 ? s.slice(0, hash) : s;
    const branch = hash > 0 ? s.slice(hash + 1) : undefined;
    if (isUnsafeGitArg(url) || (branch && isUnsafeGitArg(branch))) return null;
    return { ref: url, branch: branch || undefined, name: nameFromGitUrl(url), local: false };
  }

  // 本地路径（绝对 / ~ 展开 / 盘符）——存在性由 git 自身报错
  if (/^\//.test(s) || /^~[\\/]/.test(s) || /^[A-Za-z]:[\\/]/.test(s)) {
    if (isUnsafeGitArg(s)) return null;
    return { ref: s, name: nameFromGitUrl(s), local: true };
  }

  return null;
}

/* ── v2：目录名防覆盖顺延（upload pickFinalName 同款语义） ── */

/** 冲突顺延：name → name-2 → name-3…（永不覆盖；exists 由调用方注入便于单测）。 */
export function pickFinalName(base: string, exists: (name: string) => boolean): string {
  if (!exists(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/* ── v2：初次使用状态机 ── */

export type OnboardingState = "fresh" | "hasWorkspace" | "full";

export interface OnboardingInput {
  /** 当前欢迎页 cwd（宿主 slot extra 提供；null = 未选工作区）。 */
  cwd: string | null;
  /** 最近项目根数（/api/sessions 派生；0 = 无任何历史）。 */
  recentRootCount: number;
  /** 可用模型数（POST /api/models 的 modelList.length）。 */
  modelCount: number;
}

/**
 * 初次使用三态：
 *   - fresh：无 cwd 且无历史（真首次）→ 大按钮流（获取工作区 / 配置模型）；
 *   - hasWorkspace：有 cwd 或有历史，但模型未配置 → 上次工作区 + 配置模型引导；
 *   - full：工作区 + 模型齐备 → v1 四步卡。
 */
export function deriveOnboardingState(input: OnboardingInput): OnboardingState {
  const hasWorkspace = Boolean(input.cwd && input.cwd.trim()) || input.recentRootCount > 0;
  const hasModel = input.modelCount > 0;
  if (!hasWorkspace) return "fresh";
  return hasModel ? "full" : "hasWorkspace";
}

/* ── v2：获取历史 + 目录扫描合并 ── */

export type WorkspaceSource = "clone" | "upload" | "local" | "new" | "scan";

export interface WorkspaceRecord {
  id: string;
  source: WorkspaceSource;
  root: string;
  name: string;
  /** epoch ms。 */
  time: number;
  /** clone 来源 URL（仅 clone）。 */
  url?: string;
}

/**
 * 历史 + 目录扫描合并：按 root 去重（记录优先于扫描——记录带来源语义），
 * 记录在前、扫描按 time 降序殿后；各截 topLimit。
 */
export function mergeWorkspaceHistory(
  recorded: WorkspaceRecord[],
  scanned: Array<{ root: string; time: number }>,
  topLimit = 8,
): WorkspaceRecord[] {
  const seen = new Set<string>();
  const out: WorkspaceRecord[] = [];
  for (const r of Array.isArray(recorded) ? recorded : []) {
    const root = String(r?.root ?? "").trim();
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const name = String(r?.name ?? "").trim() || (root.split(/[\\/]/).filter(Boolean).pop() ?? root);
    out.push({ ...r, root, name });
  }
  const scannedSorted = [...(Array.isArray(scanned) ? scanned : [])]
    .filter((s) => s?.root && !seen.has(s.root))
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  for (const s of scannedSorted) {
    if (seen.has(s.root)) continue;
    seen.add(s.root);
    out.push({
      id: `scan:${s.root}`,
      source: "scan",
      root: s.root,
      name: s.root.split(/[\\/]/).filter(Boolean).pop() ?? s.root,
      time: s.time ?? 0,
    });
  }
  return out.slice(0, Math.max(1, topLimit));
}

/** 快捷键提示拆分："Ctrl+Alt+N 新建会话" → { kbd: "Ctrl+Alt+N", desc: "新建会话" }；
 *  无空格（单符号已含语义，如 "@"）→ { kbd: s, desc: "" }。供快捷操作卡行式布局
 *  （kbd 胶囊 + 描述文字，与 guide 步骤行节奏统一）。 */
export function splitKbdHint(hint: string): { kbd: string; desc: string } {
  const str = (hint ?? "").trim();
  const i = str.indexOf(" ");
  if (i <= 0) return { kbd: str, desc: "" };
  return { kbd: str.slice(0, i), desc: str.slice(i + 1).trim() };
}

/** 组合 id 判定（宿主插槽 id 形态 = "extId:itemId"）。 */
export function isQuickstartWidgetId(compositeId: string): boolean {
  return typeof compositeId === "string" && compositeId.startsWith(`${EXT_ID}:`);
}
