/**
 * session-manager extension — tag tree pure functions.
 *
 * Tag model (see docs/all-sessions-panel.zh-CN.md §3.2/§5): internal node tree
 * (id/name/color/parentId/sortOrder), path strings ("项目A/todo") are the
 * input/output form. Sessions attach LEAF node ids. Colors are persisted at
 * creation (first use) with a default from the built-in palette / common-name
 * map, editable later.
 */

export interface TagNode {
  id: string;
  name: string;
  color: string;
  parentId: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface TagData {
  /** optimistic-lock version (server increments on every mutation). */
  version: number;
  favoriteIds: string[];
  tags: TagNode[];
  sessionTags: Record<string, string[]>;
}

export interface TagTreeNode {
  node: TagNode;
  children: TagTreeNode[];
}

export const TAG_PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#22c55e", "#10b981", "#06b6d4",
  "#3b82f6", "#6366f1", "#8b5cf6", "#d946ef", "#ec4899", "#64748b",
];

/** Common-name → default color (lowercase keys). */
export const TAG_DEFAULT_COLORS: Record<string, string> = {
  todo: "#f59e0b",
  bugfix: "#ef4444",
  bug: "#ef4444",
  urgent: "#ef4444",
  feature: "#22c55e",
  review: "#8b5cf6",
  docs: "#3b82f6",
  test: "#06b6d4",
  refactor: "#64748b",
  chore: "#64748b",
  紧急: "#ef4444",
  评审: "#8b5cf6",
  文档: "#3b82f6",
  测试: "#06b6d4",
  功能: "#22c55e",
  重构: "#64748b",
  杂务: "#64748b",
  已解决: "#22c55e",
  未解决: "#64748b",
  已完成: "#22c55e",
  未完成: "#64748b",
  resolved: "#22c55e",
  unresolved: "#64748b",
};

/** Default color for a NEW tag: common-name hit, else stable palette hash. */
export function defaultColorFor(name: string): string {
  const hit = TAG_DEFAULT_COLORS[name.trim().toLowerCase()];
  if (hit) return hit;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

export function newTagId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyTagData(): TagData {
  return { version: 0, favoriteIds: [], tags: [], sessionTags: {} };
}

export function byIdMap(data: TagData): Map<string, TagNode> {
  return new Map(data.tags.map((t) => [t.id, t]));
}

/** Walk parents to build "项目A/todo" (output form). */
export function tagPath(node: TagNode, byId: Map<string, TagNode>): string {
  const segs: string[] = [];
  let cur: TagNode | undefined = node;
  while (cur) {
    segs.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return segs.join("/");
}

/** Parse an input path: segments non-empty, no leading/trailing/double slash. */
export function parseTagPath(input: string): string[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.includes("//")) return null;
  const segs = trimmed.split("/").map((s) => s.trim());
  if (segs.some((s) => !s)) return null;
  if (segs.length > 8 || trimmed.length > 100) return null;
  return segs;
}

/**
 * find-or-create the node chain for a path. New nodes get their default color
 * immediately (persisted — "首次使用即创建，创建即落库默认颜色"). Returns null
 * for invalid input; duplicates are resolved by (parentId, name) case-insensitively.
 */
export function findOrCreateTagPath(data: TagData, path: string): { data: TagData; leafId: string } | null {
  const segs = parseTagPath(path);
  if (!segs) return null;
  let tags = [...data.tags];
  let parentId: string | null = null;
  let leafId = "";
  for (const name of segs) {
    const existing = tags.find(
      (t) => t.parentId === parentId && t.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      parentId = existing.id;
      leafId = existing.id;
      continue;
    }
    const node: TagNode = {
      id: newTagId(),
      name,
      color: defaultColorFor(name),
      parentId,
      sortOrder: tags.filter((t) => t.parentId === parentId).length,
      createdAt: new Date().toISOString(),
    };
    tags.push(node);
    parentId = node.id;
    leafId = node.id;
  }
  return { data: { ...data, tags }, leafId };
}

/** Node id + all descendants (filter match / subtree delete). */
export function descendants(nodeId: string, byId: Map<string, TagNode>): string[] {
  const out = [nodeId];
  let i = 0;
  while (i < out.length) {
    const parent = out[i++];
    for (const t of byId.values()) {
      if (t.parentId === parent && !out.includes(t.id)) out.push(t.id);
    }
  }
  return out;
}

/** OR semantics; a session tag matches when it or any of its ancestors is selected. */
export function matchTagFilter(
  sessionTagIds: string[],
  selectedIds: string[],
  byId: Map<string, TagNode>,
): boolean {
  if (selectedIds.length === 0) return true;
  const selected = new Set(selectedIds);
  for (const sid of sessionTagIds) {
    let cur = byId.get(sid);
    while (cur) {
      if (selected.has(cur.id)) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return false;
}

/** Sessions tagged with node (or any descendant). */
export function tagUsageCount(data: TagData, nodeId: string): number {
  const byId = byIdMap(data);
  const set = new Set(descendants(nodeId, byId));
  let count = 0;
  for (const tags of Object.values(data.sessionTags)) {
    if (tags.some((t) => set.has(t))) count++;
  }
  return count;
}

/** Rename a node; rejects same-name sibling. null = conflict/invalid. */
export function renameTagNode(data: TagData, id: string, newName: string): TagData | null {
  const name = newName.trim();
  if (!name || name.includes("/")) return null;
  const byId = byIdMap(data);
  const node = byId.get(id);
  if (!node) return null;
  const clash = data.tags.some(
    (t) => t.id !== id && t.parentId === node.parentId && t.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) return null;
  return { ...data, tags: data.tags.map((t) => (t.id === id ? { ...t, name } : t)) };
}

/** Delete a node (+subtree); clean sessionTags references and favorites. */
export function deleteTagNode(data: TagData, id: string, subtree: boolean): TagData {
  const byId = byIdMap(data);
  const doomed = new Set(subtree ? descendants(id, byId) : [id]);
  const tags = data.tags.filter((t) => !doomed.has(t.id));
  const sessionTags: Record<string, string[]> = {};
  for (const [sid, ids] of Object.entries(data.sessionTags)) {
    const kept = ids.filter((t) => !doomed.has(t));
    if (kept.length) sessionTags[sid] = kept;
  }
  return { ...data, tags, sessionTags };
}

export function setTagColor(data: TagData, id: string, color: string): TagData | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return { ...data, tags: data.tags.map((t) => (t.id === id ? { ...t, color } : t)) };
}

export function toggleFavorite(data: TagData, sessionId: string, on: boolean): TagData {
  const has = data.favoriteIds.includes(sessionId);
  if (on && !has) return { ...data, favoriteIds: [...data.favoriteIds, sessionId] };
  if (!on && has) return { ...data, favoriteIds: data.favoriteIds.filter((x) => x !== sessionId) };
  return data;
}

/** Assign (or remove) a leaf tag id on a session; returns null if tagId unknown. */
export function setSessionTag(data: TagData, sessionId: string, tagId: string, on: boolean): TagData | null {
  const byId = byIdMap(data);
  if (!byId.has(tagId)) return null;
  const current = data.sessionTags[sessionId] ?? [];
  const has = current.includes(tagId);
  if (on && !has) return { ...data, sessionTags: { ...data.sessionTags, [sessionId]: [...current, tagId].slice(0, 20) } };
  if (!on && has) {
    const kept = current.filter((x) => x !== tagId);
    const sessionTags = { ...data.sessionTags };
    if (kept.length) sessionTags[sessionId] = kept;
    else delete sessionTags[sessionId];
    return { ...data, sessionTags };
  }
  return data;
}

/** Build the tree for the manager view. */
export function buildTagTree(data: TagData): TagTreeNode[] {
  const map = new Map<string, TagTreeNode>();
  for (const t of data.tags) map.set(t.id, { node: t, children: [] });
  const roots: TagTreeNode[] = [];
  for (const t of data.tags) {
    const tn = map.get(t.id)!;
    if (t.parentId && map.has(t.parentId)) map.get(t.parentId)!.children.push(tn);
    else roots.push(tn);
  }
  const sort = (ns: TagTreeNode[]) => {
    ns.sort((a, b) => a.node.sortOrder - b.node.sortOrder || a.node.name.localeCompare(b.node.name));
    ns.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Validate + normalize incoming data (server PUT / client cache). null = reject. */
export function validateTagData(raw: unknown): TagData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === "number" && Number.isFinite(r.version) ? r.version : 0;

  const favoriteIds = Array.isArray(r.favoriteIds)
    ? [...new Set(r.favoriteIds.filter((x): x is string => typeof x === "string"))]
    : [];

  const tags: TagNode[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.tags)) {
    for (const t of r.tags) {
      if (!t || typeof t !== "object") continue;
      const tr = t as Record<string, unknown>;
      if (typeof tr.id !== "string" || !tr.id || seen.has(tr.id)) continue;
      if (typeof tr.name !== "string" || !tr.name.trim() || tr.name.includes("/")) continue;
      if (typeof tr.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(tr.color)) continue;
      const parentId = typeof tr.parentId === "string" && tr.parentId ? tr.parentId : null;
      seen.add(tr.id);
      tags.push({
        id: tr.id,
        name: tr.name,
        color: tr.color,
        parentId,
        sortOrder: typeof tr.sortOrder === "number" ? tr.sortOrder : 0,
        createdAt: typeof tr.createdAt === "string" ? tr.createdAt : new Date().toISOString(),
      });
    }
  }

  // Cycle / dangling-parent guard + §3.2 scale cap (≤500 nodes).
  if (tags.length > 500) return null;
  const byId = new Map(tags.map((t) => [t.id, t]));
  for (const t of tags) {
    const chain = new Set<string>();
    let cur = t.parentId;
    while (cur) {
      if (chain.has(cur) || !byId.has(cur)) return null;
      chain.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
  }

  const sessionTags: Record<string, string[]> = {};
  if (r.sessionTags && typeof r.sessionTags === "object") {
    for (const [sid, ids] of Object.entries(r.sessionTags as Record<string, unknown>)) {
      if (typeof sid !== "string" || !Array.isArray(ids)) continue;
      const kept = [...new Set(ids.filter((x): x is string => typeof x === "string" && byId.has(x)))].slice(0, 20);
      if (kept.length) sessionTags[sid] = kept;
    }
  }

  return { version, favoriteIds, tags, sessionTags };
}
