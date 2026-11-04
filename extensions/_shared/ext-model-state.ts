/**
 * ext-model-state — 外部 agent 会话的「临时模型状态文件」共享模块（权威源）。
 *
 * 每个外部 agent 会话 handle 一份 JSON：
 *   ~/.pi/agent/ext-agents/<agentKey>/<sanitized-handle-id>.json
 *
 * 职责（需求：启动或切换时，把 pi 的 models 存到临时配置文件，引导外部 agent）：
 *   1. 记录当前选中模型（selected）→ 各扩展 spawn 参数（--model/-m）从它派生，
 *      会话重开/进程重启后模型选择不丢；
 *   2. 携带合并模型目录（外部自身 + pi 的 models.json 扁平化）→
 *      getAvailableModels 从这里拿 pi 部分，模型选择器外部/pi 同屏分组；
 *   3. 原子写（tmp + rename），坏 JSON/缺目录一律 fail-soft（返回 null/[]）；
 *   4. 每次写入顺手维护该 agent 的「上次使用模型」KV（`<agentKey>/_last-model.json`）——
 *      各 agent 新建会话的默认模型（per-agent last used，对齐 pi 的 defaultModel 语义）
 *      读它即可，不需要每个扩展自己记录/扫描。
 *
 * 本文件按部署单元复制进各扩展目录（aiti-*-agent/ext-model-state.ts），
 * 修改后同步副本（与 cursor-cli-store.ts 同一模式）。
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi 的模型注册表（~/.pi/agent/models.json，{providers:{<key>:{models:[…]}}}）。 */
export function piModelsConfigPath(): string {
  return process.env.PI_MODELS_CONFIG_PATH || join(homedir(), ".pi", "agent", "models.json");
}

/** 读 pi models.json 并扁平化为合并目录条目（读不到/坏 JSON → []，fail-soft）。 */
export async function readPiModels(): Promise<ExtModelEntry[]> {
  try {
    const raw = await readFile(piModelsConfigPath(), "utf8");
    return piModelsFromModelsConfig(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** 合并目录条目：source 区分外部自身目录与 pi 目录。 */
export type ExtModelEntry = {
  id: string;
  provider: string;
  label?: string;
  source?: "ext" | "pi";
};

export type ExtModelState = {
  agentKey: string;
  sessionId: string;
  selected?: { provider: string; id: string };
  models: ExtModelEntry[];
  updatedAt: string;
};

/** 状态文件根目录（可用 EXT_MODEL_STATE_DIR 覆盖，测试用）。 */
export function extModelStateDir(): string {
  return process.env.EXT_MODEL_STATE_DIR || join(homedir(), ".pi", "agent", "ext-agents");
}

/** handle id → 安全文件名（复合 id 形如 claude:<uuid>，冒号/斜杠等一律消毒；无字母数字时回退 session）。 */
export function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "session";
}

export function extModelStatePath(agentKey: string, sessionId: string): string {
  return join(extModelStateDir(), sanitizeId(agentKey), `${sanitizeId(sessionId)}.json`);
}

/** 该 agent「上次使用模型」KV 文件名（agent 目录内保留名，不参与状态 GC/扫描）。 */
export const AGENT_LAST_MODEL_FILE = "_last-model.json";

export function agentLastModelPath(agentKey: string): string {
  return join(extModelStateDir(), sanitizeId(agentKey), AGENT_LAST_MODEL_FILE);
}

/**
 * 进程内 last-used 快照（agentKey → 最近一次已知值 + 文件 mtime）：
 *  - 读：内存快照优先（不重读内容；命中时只做一次 mtime 校验——文件被删/被其它进程
 *    （dev/prod 双实例共享状态目录）改写才回退读 KV 文件），miss 时读文件并回填；
 *  - 写：同值重复写直接跳过（不落盘）；命中时同样用 mtime 校验文件未被别处改写。
 * 状态写入在 setModel/建会话时都会触发，同一模型反复读/写不应放大文件 IO。
 */
const lastModelCache = new Map<string, { provider: string; id: string; mtimeMs: number }>();

/** 测试钩子：清空进程内 last-used 快照（读/跳写行为跨用例隔离）。 */
export function resetAgentLastModelCacheForTests(): void {
  lastModelCache.clear();
}

/** 原子写「该 agent 上次使用的模型」（目录不存在自动建；同值重复写跳过；失败仅告警）。 */
export async function writeAgentLastModel(agentKey: string, selected: { provider: string; id: string }): Promise<void> {
  const file = agentLastModelPath(agentKey);
  const cached = lastModelCache.get(agentKey);
  if (cached && cached.provider === selected.provider && cached.id === selected.id) {
    try {
      const st = await stat(file);
      if (st.mtimeMs === cached.mtimeMs) return; // 未变且文件没被别处改写 → 不写
    } catch { /* 文件被删/不可读 → 重写 */ }
  }
  try {
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;
    await writeFile(tmp, JSON.stringify({ agentKey, selected, updatedAt: new Date().toISOString() }, null, 2));
    await rename(tmp, file);
    const st = await stat(file).catch(() => null);
    lastModelCache.set(agentKey, { provider: selected.provider, id: selected.id, mtimeMs: st?.mtimeMs ?? 0 });
  } catch (e) {
    console.warn(`[ext-model-state] last-model write failed (${file}):`, e instanceof Error ? e.message : e);
  }
}

/**
 * 读「该 agent 上次使用的模型」：内存快照优先（不读文件内容；命中时只做一次 mtime
 * 校验——文件被删/被其它实例（dev/prod 共享目录）改写才回退读盘）；miss 时读专用 KV
 * （`_last-model.json`）并回填内存；存量安装（KV 尚未生成）回退扫描目录内 mtime 最新的
 * 状态文件。缺失/损坏 → null（fail-soft）。调用方负责合法性校验（通道/目录内存在）。
 */
export async function readAgentLastUsedModel(agentKey: string): Promise<{ provider: string; id: string } | null> {
  const file = agentLastModelPath(agentKey);
  const cached = lastModelCache.get(agentKey);
  if (cached) {
    try {
      const st = await stat(file);
      if (st.mtimeMs === cached.mtimeMs) return { provider: cached.provider, id: cached.id };
    } catch { /* 文件被删 → 落到下面读盘/回退扫描 */ }
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { selected?: { provider?: unknown; id?: unknown } };
    const selected = parsed?.selected;
    if (selected && typeof selected.id === "string" && selected.id) {
      const value = {
        provider: typeof selected.provider === "string" && selected.provider ? selected.provider : agentKey,
        id: selected.id,
      };
      const st = await stat(file).catch(() => null);
      lastModelCache.set(agentKey, { ...value, mtimeMs: st?.mtimeMs ?? 0 });
      return value;
    }
  } catch { /* KV 不存在/损坏 → 回退扫描 */ }
  return readLatestSelectedModel(agentKey);
}

/** 原子写状态（目录不存在自动建；失败仅告警——状态文件永不阻断主流程）。 */
let writeSeq = 0;
export async function writeExtModelState(state: ExtModelState): Promise<void> {
  const file = extModelStatePath(state.agentKey, state.sessionId);
  const dir = join(file, "..");
  try {
    await mkdir(dir, { recursive: true });
    // 并发写防撞：同 pid 同毫秒的两次写不能共用同一个 tmp 名
    const tmp = `${file}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
    await rename(tmp, file);
    // 顺手更新该 agent 的「上次使用模型」KV（专用小文件；前端/新建页默认项与 pi 的
    // defaultModel 同语义）。写失败不阻断主流程——KV 缺失时读取端会回退 mtime 扫描。
    if (state.selected?.id) await writeAgentLastModel(state.agentKey, state.selected);
  } catch (e) {
    console.warn(`[ext-model-state] write failed (${file}):`, e instanceof Error ? e.message : e);
    return;
  }
  // 机会式 GC：写成功后顺手清理过期状态（不阻塞、失败静默）
  void pruneExpiredStates(dir, file);
}

/** 状态保留期：30 天未更新的会话状态视为陈旧（会话早已不存在）。 */
export const EXT_MODEL_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 目录级节流：每目录每进程至多扫一次（避免每次写都 stat 风暴）。 */
const prunedDirs = new Set<string>();

/** 删除目录下超过保留期的旧状态文件（keepFile 除外）。清理永不抛错。 */
export async function pruneExpiredStates(dir: string, keepFile?: string): Promise<number> {
  if (prunedDirs.has(dir)) return 0;
  prunedDirs.add(dir);
  let removed = 0;
  try {
    const now = Date.now();
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      if (f === AGENT_LAST_MODEL_FILE) continue; // last-used KV 长期保留（不代表会话存在）
      const p = join(dir, f);
      if (p === keepFile) continue;
      try {
        const st = await stat(p);
        if (now - st.mtimeMs > EXT_MODEL_STATE_RETENTION_MS) {
          await rm(p, { force: true });
          removed++;
        }
      } catch { /* 单文件失败不影响其余 */ }
    }
  } catch { /* 目录不存在等 —— 静默 */ }
  return removed;
}

/** 读状态；缺失/损坏返回 null（fail-soft）。 */
export async function readExtModelState(agentKey: string, sessionId: string): Promise<ExtModelState | null> {
  try {
    const raw = await readFile(extModelStatePath(agentKey, sessionId), "utf8");
    const parsed = JSON.parse(raw) as ExtModelState;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 读「该 agent 上次使用的模型」（per-agent last used，pi 的 defaultModel 同语义）：
 * 取 agentKey 目录下 mtime 最新的状态文件的 selected——状态文件在 createSession 与每次
 * setModel 时写入，所以最新的那份即该 agent 最近一次实际使用的模型。
 * 目录缺失/无文件/坏 JSON → null（fail-soft）。调用方负责合法性校验（通道/目录内存在）。
 */
export async function readLatestSelectedModel(agentKey: string): Promise<{ provider: string; id: string } | null> {
  const dir = join(extModelStateDir(), sanitizeId(agentKey));
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && f !== AGENT_LAST_MODEL_FILE);
    let newest: { file: string; mtimeMs: number } | null = null;
    for (const f of files) {
      try {
        const st = await stat(join(dir, f));
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: f, mtimeMs: st.mtimeMs };
      } catch { /* 单文件失败跳过 */ }
    }
    if (!newest) return null;
    const parsed = JSON.parse(await readFile(join(dir, newest.file), "utf8")) as ExtModelState;
    const selected = parsed?.selected;
    if (!selected || typeof selected.id !== "string" || !selected.id) return null;
    return {
      provider: typeof selected.provider === "string" && selected.provider ? selected.provider : agentKey,
      id: selected.id,
    };
  } catch {
    return null;
  }
}

/** 换绑真实 id（session_backend_ready）：旧文件搬到新 id 名下。 */
export async function renameExtModelState(agentKey: string, fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const from = extModelStatePath(agentKey, fromId);
  const to = extModelStatePath(agentKey, toId);
  try {
    await mkdir(join(to, ".."), { recursive: true });
    await rename(from, to);
  } catch {
    // 旧文件不存在（fresh 会话首次写）或跨设备——忽略，下次 write 覆盖
  }
}

/** 删除状态（dispose 时调用可选；缺省保留供重开恢复）。 */
export async function removeExtModelState(agentKey: string, sessionId: string): Promise<void> {
  try {
    await rm(extModelStatePath(agentKey, sessionId), { force: true });
  } catch { /* ignore */ }
}

/**
 * pi 的 models.json（{providers:{<key>:{apiKey,api,baseUrl,models:[{id,name,api,contextWindow,…}]}}})
 * 扁平化为合并目录条目：provider 统一 "pi"（选择器独立分组），label 尾注协议/窗口。
 */
export function piModelsFromModelsConfig(config: unknown): ExtModelEntry[] {
  const providers = (config as { providers?: Record<string, unknown> } | null)?.providers;
  if (!providers || typeof providers !== "object") return [];
  const out: ExtModelEntry[] = [];
  for (const [provKey, prov] of Object.entries(providers as Record<string, unknown>)) {
    const models = (prov as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;
    for (const m of models as Array<Record<string, unknown>>) {
      if (typeof m?.id !== "string" || !m.id) continue;
      const bits: string[] = [];
      if (typeof m.api === "string" && m.api) bits.push(String(m.api));
      if (typeof m.contextWindow === "number" && m.contextWindow > 0) bits.push(`${Math.round(m.contextWindow / 1024)}k`);
      out.push({
        id: m.id,
        provider: "pi",
        label: bits.length > 0 ? `${String(m.name ?? m.id)} · ${bits.join(" · ")}` : String(m.name ?? m.id),
        source: "pi",
      });
      void provKey; // pi 目录按模型平铺；来源 provider key 不进 UI（避免与 provider 分组语义冲突）
    }
  }
  return out;
}

/**
 * 合并目录：外部自身条目在前（source:"ext"），pi 条目在后（source:"pi"）；
 * 以 provider+id 去重（先到先得——外部自身目录优先）。
 */
export function mergeModelCatalogs(external: ExtModelEntry[], piModels: ExtModelEntry[]): ExtModelEntry[] {
  const seen = new Set<string>();
  const out: ExtModelEntry[] = [];
  for (const m of [...external, ...piModels]) {
    const key = `${m.provider}/${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/** 当前模型排最前的目录整理（选择器默认高亮当前项）。
 *  目录内命中当前模型时整体前移（保留 label 等元数据——合成条目会丢 label 产生裸 ref 行）；
 *  不在目录中（如通道折叠前的旧 ref）才合成最小条目前置。 */
export function withCurrentFirst(models: ExtModelEntry[], current?: { id: string; provider: string; label?: string }): ExtModelEntry[] {
  if (!current?.id) return models;
  const idx = models.findIndex((m) => m.id === current.id && m.provider === current.provider);
  if (idx < 0) return [{ ...current, source: "ext" as const }, ...models];
  return [models[idx], ...models.slice(0, idx), ...models.slice(idx + 1)];
}

/**
 * 静态目录把「上次使用的模型」置顶——只在目录内按 id 命中时前移（保留原条目的
 * provider/label），不合成条目。静态目录供新建页默认项（前端取 list[0]），
 * 若用 withCurrentFirst 会为 provider 不匹配的 pi 模型合成裸条目 → 列表重复。
 * 无命中/已在首位 → 原数组。
 */
export function withLastUsedFirst(models: ExtModelEntry[], lastUsedId?: string | null): ExtModelEntry[] {
  if (!lastUsedId) return models;
  const idx = models.findIndex((m) => m.id === lastUsedId);
  if (idx <= 0) return models;
  return [models[idx], ...models.slice(0, idx), ...models.slice(idx + 1)];
}
