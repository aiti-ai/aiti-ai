/**
 * aiti-prompts · prompt 收藏存储（~/.pi/web/data/aiti-prompts/config/prompts.json）
 *
 * v1：树形分组。结构 { version, groups: GroupItem[], prompts: PromptItem[] }
 *   - groups：树（parentId 引用，根 parentId=null）
 *   - prompts.groupId：所属分组（null=未分组）
 * CRUD + 原子写（临时文件 + rename）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export interface GroupItem {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  createdAt: number;
}

export interface PromptItem {
  id: string;
  name: string;
  text: string;
  /** 所属分组（null=未分组） */
  groupId?: string | null;
  tags?: string[];
  /** 来源：manual=手工添加 · input=收藏输入 · session=会话提取 */
  source?: "manual" | "input" | "session";
  /** 来源溯源（会话提取时：sessionId/sessionName/cwd/entryId） */
  meta?: Record<string, unknown>;
  /** 是否参与 aiti-ai-input 智能提示（suggest 联想/补全的来源；false=不提示；缺省/true=提示，默认开）
   * 会话来源（source=session：消息收藏/会话提取）未显式指定时默认 false（系统自动导入的条目不污染提示来源） */
  suggest?: boolean;
  createdAt: number;
  lastUsedAt?: number;
  useCount?: number;
}

export function createStore(configDir: string) {
  const file = path.join(configDir, "prompts.json");
  fs.mkdirSync(configDir, { recursive: true });

  function load(): { groups: GroupItem[]; prompts: PromptItem[] } {
    try {
      if (!fs.existsSync(file)) return { groups: [], prompts: [] };
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const groups = Array.isArray(data.groups) ? data.groups : [];
      const prompts = Array.isArray(data.prompts) ? data.prompts : [];
      return { groups, prompts };
    } catch {
      return { groups: [], prompts: [] };
    }
  }
  function save(groups: GroupItem[], prompts: PromptItem[]) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, groups, prompts }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function genId(prefix: string) {
    return prefix + "_" + randomBytes(6).toString("hex");
  }

  // 存量迁移：会话来源（source=session）且未显式设置 suggest 的 prompt → 默认不参与智能提示（一次）
  function migrateAutoSuggest() {
    const { groups, prompts } = load();
    let changed = false;
    for (const p of prompts) {
      if (p.suggest === undefined && p.source === "session") { p.suggest = false; changed = true; }
    }
    if (changed) save(groups, prompts);
  }
  migrateAutoSuggest();

  // ---------- prompt ----------
  function list(): PromptItem[] {
    return load().prompts.sort((a, b) => (b.lastUsedAt || b.createdAt) - (a.lastUsedAt || a.createdAt));
  }
  function get(id: string): PromptItem | null {
    return load().prompts.find((p) => p.id === id) || null;
  }
  function create(input: Partial<PromptItem> & { name: string; text: string }): PromptItem {
    const { groups, prompts } = load();
    const item: PromptItem = {
      id: genId("p"),
      name: String(input.name || firstLine(input.text)).trim(),
      text: input.text,
      groupId: input.groupId || null,
      tags: input.tags || [],
      source: input.source || "manual",
      meta: input.meta || undefined,
      // 显式 suggest 优先；缺省时手动/收藏输入默认开、会话来源（session）默认关
      suggest: input.suggest !== undefined ? input.suggest !== false : (!input.source || input.source === "manual" || input.source === "input"),
      createdAt: Date.now(),
      lastUsedAt: undefined,
      useCount: 0,
    };
    prompts.push(item);
    save(groups, prompts);
    return item;
  }
  function update(id: string, patch: Partial<PromptItem>): PromptItem | null {
    const { groups, prompts } = load();
    const idx = prompts.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...prompts[idx], ...clean, id };
    if (clean.name === undefined) next.name = next.name || firstLine(next.text);
    if (clean.groupId !== undefined) next.groupId = clean.groupId || null;
    prompts[idx] = next;
    save(groups, prompts);
    return next;
  }
  /** 记录一次使用（发送成功后调用） */
  function touchUse(id: string): void {
    const { groups, prompts } = load();
    const idx = prompts.findIndex((p) => p.id === id);
    if (idx < 0) return;
    prompts[idx].lastUsedAt = Date.now();
    prompts[idx].useCount = (prompts[idx].useCount || 0) + 1;
    save(groups, prompts);
  }
  function remove(id: string): boolean {
    const { groups, prompts } = load();
    const idx = prompts.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    prompts.splice(idx, 1);
    save(groups, prompts);
    return true;
  }

  // ---------- 分组（树） ----------
  function listGroups(): GroupItem[] {
    return load().groups;
  }
  function createGroup(name: string, parentId: string | null): GroupItem {
    const { groups, prompts } = load();
    if (parentId && !groups.some((g) => g.id === parentId)) parentId = null;
    const g: GroupItem = { id: genId("g"), name: String(name || "新分组").trim(), parentId, sort: 0, createdAt: Date.now() };
    groups.push(g);
    save(groups, prompts);
    return g;
  }
  function updateGroup(id: string, patch: Partial<GroupItem>): GroupItem | null {
    const { groups, prompts } = load();
    const idx = groups.findIndex((g) => g.id === id);
    if (idx < 0) return null;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    let parentId = clean.parentId !== undefined ? clean.parentId : groups[idx].parentId;
    // 防环：不能把分组移到自己的子孙下
    if (parentId) {
      const desc = new Set<string>();
      const walk = (gid: string) => {
        for (const g of groups) if (g.parentId === gid && !desc.has(g.id)) { desc.add(g.id); walk(g.id); }
      };
      walk(id);
      if (desc.has(parentId)) parentId = groups[idx].parentId;
    }
    groups[idx] = { ...groups[idx], ...clean, id, parentId };
    save(groups, prompts);
    return groups[idx];
  }
  /** 删除分组（级联：子孙分组一并删；其下 prompt 移入未分组） */
  function removeGroup(id: string): boolean {
    const { groups, prompts } = load();
    if (!groups.some((g) => g.id === id)) return false;
    const doomed = new Set<string>();
    const walk = (gid: string) => {
      for (const g of groups) if (g.parentId === gid && !doomed.has(g.id)) { doomed.add(g.id); walk(g.id); }
    };
    doomed.add(id);
    walk(id);
    const rest = groups.filter((g) => !doomed.has(g.id));
    const nextPrompts = prompts.map((p) => (p.groupId && doomed.has(p.groupId) ? { ...p, groupId: null } : p));
    save(rest, nextPrompts);
    return true;
  }

  /** 分组路径（用于 UI 显示/选择），如 "代码评审 / 前端" */
  function groupPath(id: string | null | undefined): string {
    if (!id) return "未分组";
    const { groups } = load();
    const parts: string[] = [];
    let cur = groups.find((g) => g.id === id);
    let guard = 0;
    while (cur && guard++ < 20) {
      parts.unshift(cur.name);
      cur = cur.parentId ? groups.find((g) => g.id === cur!.parentId) : undefined;
    }
    return parts.join(" / ") || "未分组";
  }

  /** 导入（merge：按 id 去重追加；replace：清空后整体替换）。prompts.groupId 不存在时置 null 避免丢失 */
  function importData(input: { groups?: GroupItem[]; prompts?: PromptItem[] }, mode: "merge" | "replace" = "merge"): { groups: number; prompts: number; skippedGroups: number; skippedPrompts: number } {
    const { groups, prompts } = load();
    if (mode === "replace") {
      const g = (Array.isArray(input.groups) ? input.groups : []).filter((x) => x && x.id && x.name);
      const p = (Array.isArray(input.prompts) ? input.prompts : []).filter((x) => x && x.id && x.text);
      save(g, p);
      return { groups: g.length, prompts: p.length, skippedGroups: 0, skippedPrompts: 0 };
    }
    const haveG = new Set(groups.map((x) => x.id));
    const haveP = new Set(prompts.map((x) => x.id));
    let skippedGroups = 0, skippedPrompts = 0;
    const newGroups: GroupItem[] = [];
    for (const g of Array.isArray(input.groups) ? input.groups : []) {
      if (g && g.id && g.name && !haveG.has(g.id)) { newGroups.push(g); haveG.add(g.id); }
      else skippedGroups++;
    }
    const validGroups = new Set(haveG);
    const newPrompts: PromptItem[] = [];
    for (const p of Array.isArray(input.prompts) ? input.prompts : []) {
      if (!p || !p.id || !p.text) { skippedPrompts++; continue; }
      if (haveP.has(p.id)) { skippedPrompts++; continue; }
      // groupId 必须是最终存在的分组，否则置 null（防导入后显示不出来）
      const item = { ...p, groupId: p.groupId && validGroups.has(p.groupId) ? p.groupId : null };
      newPrompts.push(item); haveP.add(p.id);
    }
    save([...groups, ...newGroups], [...prompts, ...newPrompts]);
    return { groups: newGroups.length, prompts: newPrompts.length, skippedGroups, skippedPrompts };
  }

  return { list, get, create, update, touchUse, remove, listGroups, createGroup, updateGroup, removeGroup, groupPath, importData };
}

/** 自动命名：首行（去空行）截断 40 字符 */
export function firstLine(text: string): string {
  const line = String(text || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
  return line.length > 40 ? line.slice(0, 40) + "…" : line;
}

export type PromptStore = ReturnType<typeof createStore>;
