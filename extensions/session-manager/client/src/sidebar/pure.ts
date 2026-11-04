/**
 * sidebar/pure —— SidebarDock 的纯逻辑层（自包含，零宿主源码 import）。
 *
 * 全部从宿主 pi-web components/SessionSidebar.tsx + lib/* 复制（2026-09-06 基线），
 * 上游演进时按 diff 手工同步。为什么复制而不是 import：扩展 client 必须独立运行
 * （作者拍板），宿主源码路径不是扩展的稳定依赖。
 */

// ---------- SessionInfo（宿主 lib/types 复制，dock 所需字段） ----------

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string;
  relation?:
    | { kind: "fork"; originSessionId?: string }
    | {
        kind: "subagent";
        parentSessionId: string;
        profile: string;
        description: string;
        status: string;
      };
  projectRoot?: string;
  projectKey?: string;
  branch?: string;
  isWorktree?: boolean;
  transient?: boolean;
  agent?: string;
  /** 最近一次运行终态（宿主推导，见 pi-web lib/run-outcome.ts）：异常（failed/aborted/
   *  interrupted）才展示标记；completed 不占位；会话运行时以运行中指示优先。 */
  lastRun?: SessionLastRun;
  /** 服务端 /sessions 拆分返回的归档标志（live 行无此字段；dock 只消费纯 live 列表）。 */
  archived?: boolean;
}

export interface SessionLastRun {
  status: "completed" | "failed" | "aborted" | "interrupted";
  at: string;
  /** 仅 failed 有值（errorMessage 原文）。 */
  error?: string;
}

/** 错误摘要：压平换行与连续空白，超长按码点截断加省略号（emoji 安全）。 */
export function truncateRunErrorText(error: string | undefined, max = 80): string {
  if (!error) return "";
  const flat = error.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

export interface RecentProject {
  key: string;
  root: string;
}

export interface ProjectSelection {
  key: string;
  root: string;
}

export const projectSelection = (root: string, key: string): ProjectSelection => ({ key, root });

// ---------- 会话列表虚拟化（宿主 SessionSidebar 同一套窗口数学） ----------

export const SESSION_LIST_ITEM_HEIGHT = 54;

export function getSessionListIndices(count: number, scrollTop: number, viewportHeight: number, focusedIndex = -1): number[] {
  const overscan = 8;
  const visibleCount = Math.ceil((viewportHeight || 600) / SESSION_LIST_ITEM_HEIGHT) + overscan * 2;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / SESSION_LIST_ITEM_HEIGHT) - overscan, count - visibleCount));
  const end = Math.min(count, start + visibleCount);
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
  if (focusedIndex >= end && focusedIndex < count) indices.push(focusedIndex);
  return indices;
}

// ---------- 树（宿主 buildSessionTree / flattenSessionTree 复制） ----------

export interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

export function buildSessionTree(sessions: SessionInfo[], pinnedIds?: ReadonlySet<string>): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null;
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => {
      if (pinnedIds && pinnedIds.size) {
        const pa = pinnedIds.has(a.session.id) ? 1 : 0;
        const pb = pinnedIds.has(b.session.id) ? 1 : 0;
        if (pa !== pb) return pb - pa;
      }
      return b.session.modified.localeCompare(a.session.modified);
    });
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

export interface FlatTreeRow { node: SessionTreeNode; depth: number; }

export function flattenSessionTree(nodes: SessionTreeNode[], depth: number, collapsedIds: Set<string>, out: FlatTreeRow[] = []): FlatTreeRow[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children.length > 0 && !collapsedIds.has(node.session.id)) {
      flattenSessionTree(node.children, depth + 1, collapsedIds, out);
    }
  }
  return out;
}

// ---------- 置顶（固定 tag「📌 置顶」承载；方案 docs/session-manager-sidebar-dock-pin-plan.md） ----------

/** 固定置顶 tag 名（语言中性纯 emoji：tag 名在各环境同形，不写死中文「置顶」；
 *  UI 文字按钮/菜单/徽标 title 走 t() 多语翻译 sm.pin/sm.unpin/sm.pinned）。
 *  服务端 tag 节点 id 由服务端生成，客户端按名字契约定位。 */
export const PIN_TAG_NAME = "📌";

/** 在 tag 树根层按名字找固定置顶 tag。找不到（未建/被删/被改名）返回 null。 */
export function findPinTagId(data: any): string | null {
  if (!data?.tags?.length) return null;
  const byId = new Map((data.tags as any[]).map((n: any) => [n.id, n]));
  const hit = (data.tags as any[]).find(
    (n: any) => n.name === PIN_TAG_NAME && (!n.parentId || !byId.has(n.parentId)),
  );
  return hit ? String(hit.id) : null;
}

/** 反查所有打了置顶 tag 的会话 id 集合（跨设备共享：数据来自服务端 tagData）。 */
export function pinnedSessionIds(data: any): Set<string> {
  const out = new Set<string>();
  const pinId = findPinTagId(data);
  if (!pinId) return out;
  for (const [sid, ids] of Object.entries(data?.sessionTags ?? {})) {
    if (Array.isArray(ids) && (ids as string[]).includes(pinId)) out.add(String(sid));
  }
  return out;
}

/** 单个会话是否已置顶。 */
export function isSessionPinned(data: any, sessionId: string): boolean {
  const pinId = findPinTagId(data);
  if (!pinId) return false;
  const ids = data?.sessionTags?.[sessionId];
  return Array.isArray(ids) && (ids as string[]).includes(pinId);
}

// ---------- 项目分组（宿主 lib/project-groups + lib/workspace-memory 复制） ----------

/**
 * Windows 路径比较归一化：win32 文件系统大小写不敏感 + 分隔符双义（\ 或 /），
 * 比较 key 统一为「/ 分隔 + 小写折叠」；posix 路径大小写敏感，原样返回。
 * 背景：服务端 projectIdentityKey 的 win32 语义（normalize+lowercase）与行
 * projectRoot/cwd 原始形态不同形，dock 聚合 /sessions 曾丢 projectKey 字段 →
 * sessionsForProject 精确 === 过滤全部不匹配 → 列表闪现后被清空（2026-09-08）。
 * 此处兜底归一化，行 key 无论落 projectKey/projectRoot/cwd 哪种形态都同形可比。
 */
export function normalizeWorkspaceKey(key: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(key) || key.includes("\\")) {
    return key.replace(/\\/g, "/").toLowerCase();
  }
  return key;
}

export function workspaceKeyOf(session: {
  cwd: string;
  projectRoot?: string | null;
  projectKey?: string | null;
}): string {
  return normalizeWorkspaceKey(session.projectKey ?? session.projectRoot ?? session.cwd);
}

export function getRecentProjects(sessions: readonly SessionInfo[]): RecentProject[] {
  const latestByProject = new Map<string, { root: string; modified: string }>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const key = workspaceKeyOf(session);
    const previous = latestByProject.get(key);
    if (!previous || session.modified > previous.modified) {
      latestByProject.set(key, { root, modified: session.modified });
    }
  }
  return [...latestByProject.entries()]
    .sort((a, b) => b[1].modified.localeCompare(a[1].modified))
    .map(([key, { root }]) => ({ key, root }));
}

export function getProjectActivity(
  sessions: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
): Map<string, { running: number; unread: number }> {
  const counts = new Map<string, { running: number; unread: number }>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    let entry = counts.get(key);
    if (!entry) {
      entry = { running: 0, unread: 0 };
      counts.set(key, entry);
    }
    if (runningSessionIds.has(session.id)) entry.running++;
    if (unreadSessionIds.has(session.id)) entry.unread++;
  }
  return counts;
}

export function sessionsForProject(
  sessions: readonly SessionInfo[],
  projectKey: string,
): SessionInfo[] {
  return sessions.filter((session) => workspaceKeyOf(session) === projectKey);
}

// ---------- 项目钉住（favoriteIds 的 "ws:" 命名空间；方案 docs/session-manager-project-pin-order-plan.md） ----------

/**
 * 项目钉住载体：`tagData.favoriteIds` 里的 `"ws:<projectKey>"` 项。
 * 选它而非 `sessionTags` 的原因：favoriteIds 是有序字符串数组、无外键校验、
 * 且不受服务端懒 GC（GC 只清 sessionTags 里已消失的会话键）影响；数组相对顺序即钉内顺序。
 * 与「会话收藏」同池共存，靠 `ws:` 前缀划分命名空间（消费方一律按前缀过滤）。
 */
export const PROJECT_PIN_PREFIX = "ws:";

/** 钉住条目 id（键按 normalizeWorkspaceKey 归一：Windows 大小写/分隔符不同形态只钉一份）。 */
export function projectPinId(key: string): string {
  return PROJECT_PIN_PREFIX + normalizeWorkspaceKey(key);
}

/** favoriteIds 项 → 归一化钉住条目 id（非 `ws:` 项/空键 → null）。
 *  读侧一律走它：历史数据里可能有未归一形态（手改/旧客户端），不归一会「已钉但判不出」。 */
function normalizedPinEntry(entry: unknown): string | null {
  if (typeof entry !== "string" || !entry.startsWith(PROJECT_PIN_PREFIX)) return null;
  const key = normalizeWorkspaceKey(entry.slice(PROJECT_PIN_PREFIX.length));
  return key ? PROJECT_PIN_PREFIX + key : null;
}

/** favoriteIds 里的项目钉住项（剥前缀、保序、去重；会话收藏项跳过）。 */
export function pinnedProjectKeys(data: any): string[] {
  const raw = data?.favoriteIds;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw as unknown[]) {
    const entry = normalizedPinEntry(item);
    if (!entry) continue;
    const key = entry.slice(PROJECT_PIN_PREFIX.length);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function isProjectPinned(data: any, key: string): boolean {
  const raw = data?.favoriteIds;
  if (!Array.isArray(raw)) return false;
  const pin = projectPinId(key);
  return (raw as unknown[]).some((item) => normalizedPinEntry(item) === pin);
}

/**
 * 项目列表排序：钉住段按 pinnedKeys 序在前，其余保持入参序（活跃降序）。
 * pinnedKeys 里的幽灵键（项目已无会话/已删除）忽略；空 pinnedKeys 是恒等映射。
 */
export function orderProjects<T extends { key: string }>(
  projects: readonly T[],
  pinnedKeys: readonly string[],
): T[] {
  if (pinnedKeys.length === 0) return [...projects];
  const pinned = new Set(pinnedKeys);
  const head: T[] = [];
  const moved = new Set<string>();
  for (const key of pinnedKeys) {
    const hit = projects.find((p) => p.key === key);
    if (hit && !moved.has(key)) {
      moved.add(key);
      head.push(hit);
    }
  }
  return [...head, ...projects.filter((p) => !pinned.has(p.key))];
}

/**
 * 钉段内上移/下移（delta=-1/+1）后的新 favoriteIds：只重排 `ws:` 项，
 * 会话收藏项留在原位（相对顺序不变）。目标未钉 / 越界 → null（无事可做）。
 */
export function reorderPinnedFavorites(
  favoriteIds: readonly string[],
  key: string,
  delta: number,
): string[] | null {
  const pin = projectPinId(key);
  const slots: number[] = [];
  favoriteIds.forEach((item, i) => {
    if (normalizedPinEntry(item)) slots.push(i);
  });
  const at = slots.findIndex((i) => normalizedPinEntry(favoriteIds[i]) === pin);
  if (at < 0) return null;
  const to = at + delta;
  if (to < 0 || to >= slots.length) return null;
  const next = [...favoriteIds] as string[];
  // 换位同时写回归一形态（历史遗留的大小写/分隔符形态借此收敛）
  next[slots[at]] = normalizedPinEntry(favoriteIds[slots[to]])!;
  next[slots[to]] = pin;
  return next;
}

// ---------- 展示工具 ----------

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel). */
export function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

type Locale = string;

/** 宿主 lib/i18n/format formatRelativeTime 复制（Intl 相对时间）。 */
export function formatRelativeTime(date: Date | string, locale: Locale, now = new Date()): string {
  const target = date instanceof Date ? date : new Date(date);
  const diffMs = target.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const [unit, divisor] = absMs < 60_000
    ? ["second", 1_000]
    : absMs < 3_600_000
      ? ["minute", 60_000]
      : absMs < 86_400_000
        ? ["hour", 3_600_000]
        : ["day", 86_400_000];
  const value = Math.round(diffMs / divisor);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit as Intl.RelativeTimeFormatUnit);
}

// ---------- skill 展开还原（宿主 lib/slash-display 复制） ----------

const SKILL_EXPANSION_RE = /^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to [^\n]+\.\n\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/;

export function skillExpansionToCommand(text: string): string | null {
  const match = text.match(SKILL_EXPANSION_RE);
  if (!match) return null;
  const [, name, , , args] = match;
  return args ? `/skill:${name} ${args}` : `/skill:${name}`;
}

// ---------- localStorage 契约（键与宿主共享，语义互通） ----------

export const HIDDEN_WORKSPACES_KEY = "pi-web:hidden-workspaces";
export const WORKSPACES_CHANGED_EVENT = "pi-web:workspaces-changed";
const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
export const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
export const PROJECTS_COLLAPSED_KEY = "pi-web:sidebar-projects-collapsed";

function readRawStorage(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function loadHiddenWorkspaces(): Set<string> {
  return new Set(readRawStorage(HIDDEN_WORKSPACES_KEY));
}

export function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch { /* best-effort */ }
}

export function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}
