/**
 * External-session placeholder files（外部会话 pi 站位文件）。
 *
 * 外部 agent 会话（cursor/claude/codex/qoder… 经 sessionProviders 驱动，复合 id
 * "<agent>:<sid>"）此前只以内存 handle 的瞬时行出现在侧栏（getHandleSessionInfos、
 * transient）——重启即消失，pi 会话宇宙里没有它们的任何痕迹。
 *
 * 站位文件 = 在 pi 会话目录落一个真实 .jsonl（header + session_info，不含对话），
 * 给外部会话一个持久锚点：
 *   - 磁盘扫描天然列出（/api/sessions 的 persistedSessions 段），重启仍在；
 *   - header 带 agent/extId 标记 → 打开一律路由到真实 agent 后端
 *     （lib/session resolvePlaceholderSession → openExternalSession），
 *     站位文件本身永不被当作本地会话打开（不落元数据空壳）；
 *   - 删除只删站位文件 + 注册表项，外部原始数据（cursor store.db 等）永不动。
 *
 * 写入时机（防孤儿站位）：
 *   - resume（⚡接管历史 / ?session= 恢复）：handle 创建即写（extId 已知）；
 *   - fresh（欢迎页新建）：等 session_backend_ready（真实 chatId 换绑）才写——
 *     从未发出首条消息的空会话不留站位（此时仍是内存瞬时行，与 pi 自家
 *     「首条回复才落盘」同节奏）。换绑时站位键随迁移（new- 占位键 → 真实复合 id）。
 *
 * 注册表：~/.pi/web{,-dev}/data/external-session-placeholders.json（extId → uuid/path）。
 * 只做加速索引（抑制瞬时行、列表标注 agent）；文件 header 自带标记，注册表丢失
 * 也能按 uuid 反查（readSessionHeader → extId），最坏退回旧行为。
 *
 * 文件格式沿用 session-manager 导入流程（lib/agents/to-pi.ts）验证过的布局：
 *   {"type":"session","version":3,"id":<uuid>,"timestamp":...,"cwd":...,"agent":...,"extId":...}
 *   {"type":"session_info","name":"[agent] …","importedFrom":"<agent>:<sid>","external":true,…}
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataRoot } from "../ext/data-dir.ts";

export interface ExternalPlaceholder {
  /** pi 站位会话 id（= 文件名尾 uuid = header.id）。侧栏行的对外身份。 */
  uuid: string;
  /** 站位文件绝对路径。 */
  path: string;
  /** 外部复合 id："cursor:<chatId>"。extId 变更（new- 换绑）以它为键。 */
  extId: string;
  /** agent 键（cursor/claude/codex/...），前端徽标与外部模型目录路由用。 */
  agent: string;
  /** 展示名（"[agent] …"）。 */
  name?: string;
  /** 原始项目 cwd（header.cwd 用；文件落盘在 encodeCwd(cwd) 目录下）。 */
  cwd: string;
  /** 子代理站位：父会话文件路径（header.parentSession，徽标/父子树用）。 */
  parentSessionFile?: string;
  /** 换绑前的 new- 占位复合 id（别名键）：浏览器未迁移的 ?session= URL 靠它解析回本会话。 */
  aliases?: string[];
  created: string;
}

interface RegistryFile {
  version: 1;
  sessions: ExternalPlaceholder[];
}

const g = globalThis as typeof globalThis & {
  __externalPlaceholders?: { mtimeMs: number; map: Map<string, ExternalPlaceholder> };
};

function registryFile(): string {
  return join(dataRoot(), "external-session-placeholders.json");
}

function registryMtime(): number {
  try { return statSync(registryFile()).mtimeMs; } catch { return -1; }
}

/**
 * 注册表按 mtime 懒重读：文件被其它进程（另一 pi-web 实例/CLI 脚本）写入时，
 * 本进程下一次访问自动拿到新内容——进程常驻 + 双实例共享注册表的安全做法。
 */
function loadRegistry(): Map<string, ExternalPlaceholder> {
  const mtime = registryMtime();
  const cached = g.__externalPlaceholders;
  if (cached && cached.mtimeMs === mtime) return cached.map;
  const map = new Map<string, ExternalPlaceholder>();
  if (mtime >= 0) {
    try {
      const raw = JSON.parse(readFileSync(registryFile(), "utf8")) as RegistryFile;
      for (const s of raw.sessions ?? []) {
        if (s && typeof s === "object" && s.extId && s.uuid) {
          map.set(s.extId, s);
          // 别名键展开 → 同一记录（占位 id 换绑后旧 ?session= URL 继续可解析）
          for (const a of s.aliases ?? []) {
            if (a && a !== s.extId) map.set(a, s);
          }
        }
      }
    } catch {
      /* 损坏 → 空表（header 标记兜底，见模块注释） */
    }
  }
  g.__externalPlaceholders = { mtimeMs: mtime, map };
  return map;
}

function persistRegistry(map: Map<string, ExternalPlaceholder>): void {
  try {
    mkdirSync(dataRoot(), { recursive: true });
    // map 值含别名键的重复引用（同记录多键）——按对象身份去重后落盘
    const payload: RegistryFile = { version: 1, sessions: [...new Set(map.values())] };
    const file = registryFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, file);
  } catch {
    /* best-effort：注册表写失败不阻断站位文件本身 */
  }
}

/** session-manager 同款 cwd 编码：/home/w/x → --home-wind-x。 */
function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";
}

/** pi 文件名时间戳：2026-08-17T00-27-14-727Z（时间部分用连字符）。 */
function fileNameTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
  return d.toISOString().replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/, "$1$2-$3-$4-$5Z");
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function displayName(agent: string, extId: string, name?: string): string {
  const sid = extId.slice(extId.indexOf(":") + 1) || extId;
  return name?.trim() ? name : `[${agent}] ${sid.slice(0, 24)}`;
}

/** 重写站位文件（header.extId/agent/cwd 与 session_info 行）。文件极小（两行），整文件重写。 */
function rewritePlaceholderFile(p: ExternalPlaceholder): void {
  const lines = [
    line({
      type: "session",
      version: 3,
      id: p.uuid,
      timestamp: p.created,
      cwd: p.cwd,
      agent: p.agent,
      extId: p.extId,
      ...(p.parentSessionFile ? { parentSession: p.parentSessionFile } : {}),
    }),
    line({
      type: "session_info",
      name: displayName(p.agent, p.extId, p.name),
      importedFrom: p.extId,
      external: true,
      createdAt: p.created,
    }),
  ];
  writeFileSync(p.path, lines.join(""), { flag: "w" });
}

/**
 * 写（或更新）一个外部会话的站位文件。幂等：同 extId 已有站位时只补名字。
 * cwd 缺省回落 `~/external-<agent>`（对齐导入流程的 fallbackCwd 惯例）。
 * 返回 null = cwd 缺失且无回落（理论不可达）或写失败。
 */
export function ensurePlaceholder(input: {
  extId: string;
  agent: string;
  cwd?: string;
  name?: string;
  createdIso?: string;
  /** 子代理站位：父会话文件路径（header.parentSession）。已有站位缺该字段时补写。 */
  parentSessionFile?: string;
}): ExternalPlaceholder | null {
  const map = loadRegistry();
  const known = map.get(input.extId);
  if (known) {
    // 别名命中（known.extId ≠ 请求键）：该占位 id 已换绑到真实 extId，原样返回，
    // 不做改名/补写——写入语义只属于真实键的调用。
    if (known.extId !== input.extId) return known;
    const needsName = input.name && input.name !== known.name;
    const needsParent = input.parentSessionFile && input.parentSessionFile !== known.parentSessionFile;
    if (needsName || needsParent) {
      if (needsName) known.name = input.name;
      if (needsParent) known.parentSessionFile = input.parentSessionFile;
      try { rewritePlaceholderFile(known); } catch { /* best-effort */ }
      persistRegistry(map);
    }
    return known;
  }
  const cwd = input.cwd?.trim() || join(homedir(), `external-${input.agent}`);
  const uuid = randomUUID();
  const created = input.createdIso || new Date().toISOString();
  const dir = join(homedir(), ".pi", "agent", "sessions", encodeCwd(cwd));
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const p: ExternalPlaceholder = {
      uuid,
      path: join(dir, `${fileNameTs(created)}_${uuid}.jsonl`),
      extId: input.extId,
      agent: input.agent,
      cwd,
      ...(input.name ? { name: input.name } : {}),
      ...(input.parentSessionFile ? { parentSessionFile: input.parentSessionFile } : {}),
      created,
    };
    rewritePlaceholderFile(p);
    map.set(input.extId, p);
    persistRegistry(map);
    return p;
  } catch {
    return null;
  }
}

/**
 * 站位键迁移：外部后端懒初始化暴露真实原生 id（new- 占位 → 真实 chatId）时，
 * 注册表键与文件 header 随之换绑。旧文件名不改（uuid 身份稳定，改引用会断）。
 * 旧键保留为别名（同一记录）：浏览器/书签里的占位 URL（?session=agent:new-…）
 * 在 handle-store 清空（扩展 reload/重启）后仍能解析回同一会话，而不是被当成
 * 全新会话再实例化出第二只 handle（实测 2026-09-07：同会话双行 + 历史分叉）。
 */
export function rebindPlaceholder(oldExtId: string, newExtId: string): ExternalPlaceholder | null {
  const map = loadRegistry();
  const p = map.get(oldExtId);
  if (!p || !newExtId || newExtId === oldExtId) return map.get(newExtId) ?? null;
  p.extId = newExtId;
  map.set(newExtId, p);
  addAlias(p, oldExtId); // 旧占位键留别名（记录内 aliases[]，加载时展开回 map 键）
  map.set(oldExtId, p);
  try { rewritePlaceholderFile(p); } catch { /* best-effort */ }
  persistRegistry(map);
  return p;
}

function addAlias(p: ExternalPlaceholder, alias: string): void {
  if (alias === p.extId) return;
  p.aliases = p.aliases ?? [];
  if (!p.aliases.includes(alias)) p.aliases.push(alias);
}

/**
 * 记录占位别名：oldExtId（换绑前的 new- 占位复合 id）→ newExtId 的既有站位记录。
 * fresh 会话（new- 键下从未落过站位）的换绑走这里——rebindPlaceholder 只覆盖
 * 「旧键已有站位」的 resume 场景。幂等：目标缺失或已含该别名时不写盘。
 */
export function aliasPlaceholder(oldExtId: string, newExtId: string): ExternalPlaceholder | null {
  if (!oldExtId || !newExtId || oldExtId === newExtId) return null;
  const map = loadRegistry();
  const target = map.get(newExtId);
  if (!target) return null;
  if (map.get(oldExtId) === target) return target;
  addAlias(target, oldExtId);
  map.set(oldExtId, target);
  persistRegistry(map);
  return target;
}

/**
 * new- 占位 sid 判定（各后端扩展的懒初始化占位：zcode/codex `new-<n>-<ts>`、
 * claude/qoder `new-<ts>`、cursor `new-<uuid>`）。真实原生 id 均不带 new- 前缀。
 */
export function isProvisionalExtSid(sid: string): boolean {
  return sid.startsWith("new-");
}

export function getPlaceholder(extId: string): ExternalPlaceholder | undefined {
  return loadRegistry().get(extId);
}

export function hasPlaceholder(extId: string): boolean {
  return loadRegistry().has(extId);
}

/** uuid → 站位记录（注册表 N 很小，线性扫；注册表丢失时走路由侧 header 反查）。 */
export function placeholderByUuid(uuid: string): ExternalPlaceholder | undefined {
  for (const p of loadRegistry().values()) if (p.uuid === uuid) return p;
  return undefined;
}

/**
 * 删除站位（只删锚点：站位文件 + 注册表项含全部别名键）。外部原始数据永不动。
 * 返回 false = 该 uuid 不是站位。
 */
export function removePlaceholderByUuid(uuid: string): boolean {
  const map = loadRegistry();
  const p = placeholderByUuid(uuid);
  if (!p) return false;
  try { unlinkSync(p.path); } catch { /* already gone */ }
  for (const [key, rec] of map) {
    if (rec === p || rec.uuid === uuid) map.delete(key);
  }
  persistRegistry(map);
  return true;
}

/**
 * 列表标注：/api/sessions 合并后对站位行补 agent 标签——磁盘扫描出的 SessionInfo
 * 不携带 header 扩展字段，徽标/外部模型目录路由（前端 loadModels 按 agent 走
 * list_models）靠这一步还原。
 */
export function stampExternalSessions(rows: Array<{ id: string; agent?: string }>): void {
  const map = loadRegistry();
  if (map.size === 0) return;
  for (const row of rows) {
    for (const p of map.values()) {
      if (p.uuid === row.id) {
        row.agent = p.agent;
        break;
      }
    }
  }
}

/** 测试钩子：清空进程内注册表缓存（下一次访问重读磁盘）。 */
export function resetPlaceholderCacheForTest(): void {
  g.__externalPlaceholders = undefined;
}
