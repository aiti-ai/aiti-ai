/**
 * aiti-cmd · 常用命令存储（~/.pi/web/data/aiti-cmd/config/commands.json）
 *
 * v2：树形分组。结构 { version, groups: GroupItem[], commands: CommandItem[] }
 *   - groups：树（parentId 引用，根 parentId=null）
 *   - commands.groupId：所属分组（null=未分组）
 * CRUD + 原子写（临时文件 + rename）；{xxx} 占位符自动提取。
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

export interface CommandItem {
  id: string;
  name: string;
  cmd: string;
  cwd?: string;
  tags?: string[];
  env?: Record<string, string>;
  confirm?: boolean;
  /** 从 cmd 提取的占位符（运行前填参数） */
  params?: string[];
  /** 所属分组（null=未分组） */
  groupId?: string | null;
  /** 沙箱模式：none=无沙箱（默认）；bwrap-ro=只读+工作目录可写；bwrap-offline=只读+断网；bwrap-tmp=临时可写盘（退出即丢） */
  sandbox?: "none" | "bwrap-ro" | "bwrap-offline" | "bwrap-tmp";
  /** 是否参与 aiti-ai-input 智能提示（suggest 联想/补全的来源；false=不提示；缺省/true=提示，默认开）
   * 自动来源（source=ai-message/clipboard）未显式指定时默认 false（系统创建的条目不污染提示来源） */
  suggest?: boolean;
  createdAt: number;
  lastRunAt?: number;
  runCount?: number;
  source?: "manual" | "ai-message" | "clipboard";
}

/** 合法沙箱模式（存储白名单；未知值一律丢弃→undefined） */
export const SANDBOX_MODES = ["none", "bwrap-ro", "bwrap-offline", "bwrap-tmp"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];
export function normSandbox(v: unknown): SandboxMode | undefined {
  return (SANDBOX_MODES as readonly string[]).includes(String(v)) ? (v as SandboxMode) : undefined;
}

/** 提取 {xxx} 占位符（排除 ${var} shell 变量） */
export function extractParams(cmd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\{([a-zA-Z_][\w.-]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

export function createStore(configDir: string) {
  const file = path.join(configDir, "commands.json");
  fs.mkdirSync(configDir, { recursive: true });

  function load(): { groups: GroupItem[]; commands: CommandItem[] } {
    try {
      if (!fs.existsSync(file)) return { groups: [], commands: [] };
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const groups = Array.isArray(data.groups) ? data.groups : [];
      const commands = Array.isArray(data.commands) ? data.commands : [];
      return { groups, commands };
    } catch {
      return { groups: [], commands: [] };
    }
  }
  function save(groups: GroupItem[], commands: CommandItem[]) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, groups, commands }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function genId(prefix: string) {
    return prefix + "_" + randomBytes(6).toString("hex");
  }

  // 存量迁移：自动来源（非 manual）且未显式设置 suggest 的命令 → 默认不参与智能提示（一次）
  function migrateAutoSuggest() {
    const { groups, commands } = load();
    let changed = false;
    for (const c of commands) {
      if (c.suggest === undefined && c.source && c.source !== "manual") { c.suggest = false; changed = true; }
    }
    if (changed) save(groups, commands);
  }
  migrateAutoSuggest();

  // ---------- 命令 ----------
  function list(): CommandItem[] {
    return load().commands.sort((a, b) => (b.lastRunAt || b.createdAt) - (a.lastRunAt || a.createdAt));
  }
  function get(id: string): CommandItem | null {
    return load().commands.find((c) => c.id === id) || null;
  }
  function create(input: Partial<CommandItem> & { name: string; cmd: string }): CommandItem {
    const { groups, commands } = load();
    const item: CommandItem = {
      id: genId("c"),
      name: String(input.name || input.cmd).trim(),
      cmd: input.cmd,
      cwd: input.cwd || undefined,
      tags: input.tags || [],
      env: input.env || undefined,
      confirm: input.confirm ?? false,
      params: extractParams(input.cmd),
      groupId: input.groupId || null,
      sandbox: normSandbox(input.sandbox),
      // 显式 suggest 优先；缺省时手动创建的默认开、自动来源（ai-message/clipboard）默认关
      suggest: input.suggest !== undefined ? input.suggest !== false : (!input.source || input.source === "manual"),
      createdAt: Date.now(),
      lastRunAt: undefined,
      runCount: 0,
      source: input.source || "manual",
    };
    commands.push(item);
    save(groups, commands);
    return item;
  }
  function update(id: string, patch: Partial<CommandItem>): CommandItem | null {
    const { groups, commands } = load();
    const idx = commands.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    // 防御清洗：tags 可能以逗号字符串传入（客户端表单原始值）——统一成 string[]
    if (typeof clean.tags === "string") clean.tags = (clean.tags as string).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (clean.cwd === "") clean.cwd = undefined;
    const next = { ...commands[idx], ...clean, id };
    if (clean.cmd !== undefined) next.params = extractParams(next.cmd);
    if (clean.name === undefined) next.name = next.name || next.cmd;
    if (clean.groupId !== undefined) next.groupId = clean.groupId || null;
    if (clean.sandbox !== undefined) next.sandbox = normSandbox(clean.sandbox);
    next.cwd = next.cwd || undefined;
    commands[idx] = next;
    save(groups, commands);
    return next;
  }
  function touchRun(id: string): void {
    const { groups, commands } = load();
    const idx = commands.findIndex((c) => c.id === id);
    if (idx < 0) return;
    commands[idx].lastRunAt = Date.now();
    commands[idx].runCount = (commands[idx].runCount || 0) + 1;
    save(groups, commands);
  }
  function remove(id: string): boolean {
    const { groups, commands } = load();
    const idx = commands.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    commands.splice(idx, 1);
    save(groups, commands);
    return true;
  }

  // ---------- 分组（树） ----------
  function listGroups(): GroupItem[] {
    return load().groups;
  }
  function createGroup(name: string, parentId: string | null): GroupItem {
    const { groups, commands } = load();
    if (parentId && !groups.some((g) => g.id === parentId)) parentId = null;
    const g: GroupItem = { id: genId("g"), name: String(name || "新分组").trim(), parentId, sort: 0, createdAt: Date.now() };
    groups.push(g);
    save(groups, commands);
    return g;
  }
  function updateGroup(id: string, patch: Partial<GroupItem>): GroupItem | null {
    const { groups, commands } = load();
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
    save(groups, commands);
    return groups[idx];
  }
  /** 删除分组（级联：子孙分组一并删；其下命令移入未分组） */
  function removeGroup(id: string): boolean {
    const { groups, commands } = load();
    if (!groups.some((g) => g.id === id)) return false;
    const doomed = new Set<string>();
    const walk = (gid: string) => {
      for (const g of groups) if (g.parentId === gid && !doomed.has(g.id)) { doomed.add(g.id); walk(g.id); }
    };
    doomed.add(id);
    walk(id);
    const rest = groups.filter((g) => !doomed.has(g.id));
    const nextCommands = commands.map((c) => (c.groupId && doomed.has(c.groupId) ? { ...c, groupId: null } : c));
    save(rest, nextCommands);
    return true;
  }

  /** 分组路径（用于 UI 显示/选择），如 "构建 / 前端" */
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

  return { list, get, create, update, touchRun, remove, listGroups, createGroup, updateGroup, removeGroup, groupPath };
}

export type CommandStore = ReturnType<typeof createStore>;
