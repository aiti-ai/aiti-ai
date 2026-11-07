/**
 * aiti-app-center · app-registry —— 应用枚举与分类解析（纯逻辑层，零 JSX）。
 *
 * 数据源（全部现有注册表，新插件自动进列表）：
 *   - toolbar/sidebarFooter 插槽条目（meta.onClick 可调，含懒扩展静态条目的物化转发）→ action/manage 卡
 *   - rightFileDock 插槽条目 + dialogs 白名单 → panel 卡（present 状态机打开）
 *   - manifest features（boolean 型）→ toggle 卡（extman ops API 切换 + 广播回灌）
 *
 * 分类（方案 §3，tag 式）：条目级（meta.category / 静态条目根 category）→ feature 级
 * （features[].category，toggle 卡）→ 扩展级（manifest 顶层 category）→ 覆盖表 → 默认 other。
 * 内部分类 id 出多语标签；其他值 = 自定义分类，原样展示。
 *
 * 定制（localStorage，客户端约定）：pi:app-center:pinned:v1（钉住序）/
 * pi:app-center:hidden:v1（隐藏）。形态自适应由数据推导：总数 ≤ FLAT_MODE_THRESHOLD 平铺；
 * 否则两段式，pinned 空 = 首次态（「更多」默认展开）。
 *
 * 视图分置（重构方案 docs/aiti-app-center-refactor-plan.md）：应用视图 = 可执行入口
 * （action/panel/manage），开关视图 = toggle 按扩展分组。钉住/隐藏只作用于应用视图，
 * 两个数组不再含 `toggle:*`；v1 残留由 pruneToggleIds() 一次性清洗。
 */

export type AppKind = "action" | "panel" | "toggle" | "manage";

export interface AppDescriptor {
  /** "action:<extId>:<itemId>" / "panel:…" / "toggle:<extId>:<featureId>" */
  id: string;
  kind: AppKind;
  /** 解析后的分类 id（内部分类 id 或自定义分类原文）。 */
  category: string;
  label: string;
  extId: string;
  extName?: string;
  /** 声明式图标（ExtUiItemIcon 三形态：{svg} / emoji 字符串 / "icons/*.svg" 相对路径）。 */
  icon?: string | { svg: string };
  keywords: string[];
  run: () => void;
  /** toggle 卡当前态（boolean feature）。 */
  on?: boolean;
  /** toggle 卡的 feature 描述（开关视图行式副标题）。 */
  featureDescription?: string;
  /** 来源扩展版本（信息页）。 */
  extVersion?: string;
  /** 来源扩展描述（信息页；宿主 manifest 透传 = 入口声明优先、package.json 兜底）。 */
  extDescription?: string;
  /** 来源扩展级图标（开关视图分组头）。 */
  extIcon?: string | { svg: string };
}

/** 内部分类（§3.1；顺序即展示序。i18n 标签 = `cat.<id>`，本扩展 ui.i18n 提供 zh-CN/en）。 */
export const INTERNAL_CATEGORIES = ["session", "code", "ai", "auto", "debug", "ui", "system", "other"] as const;
export type InternalCategoryId = (typeof INTERNAL_CATEGORIES)[number];
export const DEFAULT_CATEGORY: InternalCategoryId = "other";

/** 形态自适应阈值（§1.5，v3）：应用总数 ≤ 阈值 → 平铺全部；否则两段式。 */
export const FLAT_MODE_THRESHOLD = 12;

/** localStorage 键（客户端约定，与 dock 折叠/排序同级）。 */
export const PINNED_KEY = "pi:app-center:pinned:v1";
export const HIDDEN_KEY = "pi:app-center:hidden:v1";
/** 同 tab 定制变更广播（跨组件同步；跨 tab 走 storage 事件）。 */
export const APP_STORE_EVENT = "pi:app-center:store";

/* ── 覆盖表（APP_OVERRIDES，方案 §3.1）：存量扩展的初始归类 + 关键词补充。
 *    扩展 index.ts 顶层 category（经 manifest 透传）优先于本表；本表是
 *    「尚未声明 category 的存量扩展」的兜底归类——逐扩展铺量后表项可退役。 ── */
export const APP_OVERRIDES: Record<string, { category?: string; keywords?: string[] }> = {
  // session 会话与项目
  "session-manager": { category: "session", keywords: ["sessions", "会话"] },
  "aiti-folder": { category: "session", keywords: ["folder", "文件夹", "文件"] },
  "aiti-draft-keeper": { category: "session", keywords: ["draft", "草稿"] },
  "aiti-recovery": { category: "session", keywords: ["recovery", "恢复"] },
  "aiti-session-cards": { category: "session", keywords: ["request", "请求卡"] },
  "aiti-quickstart": { category: "session", keywords: ["quickstart", "上手", "指南", "guide", "welcome"] },
  // code 代码与 Git
  "aiti-editor": { category: "code", keywords: ["editor", "编辑"] },
  "aiti-git-ops": { category: "code", keywords: ["git", "分支"] },
  "aiti-git-review": { category: "code", keywords: ["review", "审核", "diff"] },
  "aiti-git-trace": { category: "code", keywords: ["trace", "改动"] },
  "aiti-ctx-meter": { category: "code", keywords: ["context", "上下文"] },
  // ai 模型与 AI
  "aiti-model-check": { category: "ai", keywords: ["model", "模型", "429"] },
  "aiti-model-wizard": { category: "ai", keywords: ["model", "聚合", "多 key"] },
  "aiti-provider-usage": { category: "ai", keywords: ["quota", "余额", "额度"] },
  "aiti-ai-usage": { category: "ai", keywords: ["usage", "用量"] },
  "aiti-ai-input": { category: "ai", keywords: ["usage", "用量"] },
  "aiti-prompts": { category: "ai", keywords: ["prompt", "提示词"] },
  "aiti-plan-first": { category: "ai", keywords: ["plan", "方案"] },
  "aiti-plan-review": { category: "ai", keywords: ["plan", "评审"] },
  "aiti-models-import": { category: "ai", keywords: ["models", "导入"] },
  // auto 自动化与 Agent
  "aiti-ai-schedule": { category: "auto", keywords: ["schedule", "定时", "任务"] },
  "aiti-subagents": { category: "auto", keywords: ["subagent", "子代理", "舰队"] },
  "aiti-agent-manager": { category: "auto", keywords: ["agent", "登录"] },
  "aiti-custom-agent": { category: "auto", keywords: ["agent", "自定义"] },
  "aiti-cmd": { category: "auto", keywords: ["terminal", "终端", "命令"] },
  "aiti-queue-keeper": { category: "auto", keywords: ["queue", "队列"] },
  "aiti-ai-speek": { category: "auto", keywords: ["tts", "朗读"] },
  "aiti-attach-agent": { category: "auto", keywords: ["bridge", "桥"] },
  // debug 调试与观测
  "aiti-devtools": { category: "debug", keywords: ["devtools", "调试", "注入"] },
  "aiti-debug-inject": { category: "debug", keywords: ["inject", "注入"] },
  "aiti-ui-env": { category: "debug", keywords: ["ui", "虚拟屏", "vnc"] },
  "aiti-testagent-native": { category: "debug", keywords: ["testagent-native", "tan", "native"] },
  "aiti-testagent": { category: "debug", keywords: ["java", "testagent"] },
  "aiti-cpu-meter": { category: "debug", keywords: ["cpu", "监控"] },
  "aiti-bridge-probe": { category: "debug", keywords: ["bridge", "探针"] },
  // ui 界面与阅读
  "aiti-float": { category: "ui", keywords: ["float", "浮窗"] },
  "aiti-msg-smart": { category: "ui", keywords: ["message", "消息"] },
  "aiti-msg-nav": { category: "ui", keywords: ["message", "导航"] },
  "aiti-msg-anchor": { category: "ui", keywords: ["message", "锚点"] },
  "aiti-word-docx-preview": { category: "ui", keywords: ["docx", "word"] },
  "aiti-word-superdoc": { category: "ui", keywords: ["docx", "word"] },
  "aiti-sheet-univer": { category: "ui", keywords: ["sheet", "表格"] },
  "aiti-onlyoffice": { category: "ui", keywords: ["office", "文档"] },
  "aiti-doc-center": { category: "ui", keywords: ["docs", "文档"] },
  "aiti-mail": { category: "ui", keywords: ["mail", "邮件"] },
  // system 系统与管理
  "aiti-extman": { category: "system", keywords: ["extensions", "扩展", "插件"] },
  "aiti-configs": { category: "system", keywords: ["backup", "配置", "备份"] },
  "aiti-backup": { category: "system", keywords: ["backup", "备份"] },
  "service-tunnels": { category: "system", keywords: ["ports", "端口", "隧道"] },
  "aiti-event-bus": { category: "system", keywords: ["event", "事件", "sse"] },
  "aiti-append-system": { category: "system", keywords: ["append", "系统提示词"] },
  "aiti-model-recent": { category: "system", keywords: ["recent", "最近"] },
  "aiti-crash-fatal": { category: "system", keywords: ["crash", "崩溃"] },
  "aiti-app-center": { category: "system", keywords: ["apps", "应用"] },
};

/** 分类解析链：条目级 → （toggle 卡的 feature 级在组装处先并成 itemLevel）→ 扩展级 → 覆盖表 → 默认。 */
export function resolveCategory(itemLevel: string | undefined, extLevel: string | undefined, extId: string): string {
  const v = (itemLevel && String(itemLevel).trim()) || (extLevel && String(extLevel).trim()) || APP_OVERRIDES[extId]?.category || DEFAULT_CATEGORY;
  return String(v).trim() || DEFAULT_CATEGORY;
}

export function isInternalCategory(id: string): boolean {
  return (INTERNAL_CATEGORIES as readonly string[]).includes(id);
}

/** 分类展示名：内部分类走 i18n（`cat.<id>`），自定义分类原样。 */
export function categoryLabel(id: string, t: (key: string) => string): string {
  return isInternalCategory(id) ? t(`cat.${id}`) : id;
}

/** 分类排序键：内部分类按声明序（other 垫底语义由序保证），自定义按名称排其后。 */
export function categorySortKey(id: string): string {
  const idx = (INTERNAL_CATEGORIES as readonly string[]).indexOf(id);
  return idx >= 0 ? String(idx).padStart(2, "0") : `99${id}`;
}

/** 形态自适应（v3）：flat = 平铺全部；two-segment = 常用 + 更多。 */
export function viewMode(totalApps: number): "flat" | "two-segment" {
  return totalApps <= FLAT_MODE_THRESHOLD ? "flat" : "two-segment";
}

/** 首次态（v3）：两段式且无钉住记录 → 「更多」默认展开（分类浏览即首屏）。 */
export function moreExpandedDefault(pinnedCount: number): boolean {
  return pinnedCount === 0;
}

/** 搜索匹配：query 按空白分词，逐词命中 label/extName/extId/keywords 任一即算命中（大小写不敏感子串）。 */
export function matchApp(app: { label: string; extId: string; extName?: string; keywords?: string[] }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [app.label, app.extId, app.extName ?? "", ...(app.keywords ?? [])].join("\n").toLowerCase();
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

/* ── 钉住/隐藏存储（localStorage 单一事实源 + 变更事件/跨 tab 订阅；折叠键同范式）── */

function readIdList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch { return []; }
}
function writeIdList(key: string, ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(ids));
  } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(APP_STORE_EVENT, { detail: { key } })); } catch { /* ignore */ }
}

export function readPinned(): string[] { return readIdList(PINNED_KEY); }
export function writePinned(ids: string[]): void { writeIdList(PINNED_KEY, [...new Set(ids)]); }
export function readHidden(): string[] { return readIdList(HIDDEN_KEY); }
export function writeHidden(ids: string[]): void { writeIdList(HIDDEN_KEY, [...new Set(ids)]); }

/** 钉/拔（幂等）；钉住追加到尾部（常用序 = 钉住序）。 */
export function togglePinned(appId: string): void {
  const cur = readPinned();
  writePinned(cur.includes(appId) ? cur.filter((x) => x !== appId) : [...cur, appId]);
}
export function toggleHidden(appId: string): void {
  const cur = readHidden();
  writeHidden(cur.includes(appId) ? cur.filter((x) => x !== appId) : [...cur, appId]);
}
/** 编辑模式上/下移（仅钉住区内有效序）。 */
export function movePinned(appId: string, delta: number): void {
  const cur = readPinned();
  const i = cur.indexOf(appId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= cur.length) return;
  [cur[i], cur[j]] = [cur[j], cur[i]];
  writePinned(cur);
}

export const TOGGLE_PREFIX = "toggle:";
export function isToggleId(id: string): boolean { return id.startsWith(TOGGLE_PREFIX); }

/**
 * 一次性本地迁移（方案 P0-2）：v1 允许钉/隐藏 toggle 卡，视图分置后应用视图不再含
 * toggle 卡——残留记录会致首屏形态错乱（可见钉住数为 0 但数组非空）+ 钉住能力静默丢失。
 * 幂等：无残留时零写入。返回清除条数。
 */
export function pruneToggleIds(): number {
  const pinned = readPinned();
  const hidden = readHidden();
  const keepPinned = pinned.filter((x) => !isToggleId(x));
  const keepHidden = hidden.filter((x) => !isToggleId(x));
  const removed = pinned.length - keepPinned.length + (hidden.length - keepHidden.length);
  if (removed === 0) return 0;
  writePinned(keepPinned);
  writeHidden(keepHidden);
  return removed;
}

/** 隐藏（追加写语义，幂等）：信息页入口用——恢复区的 toggleHidden 翻转语义在此会造成「再隐藏已隐藏项」。 */
export function hideApp(appId: string): void {
  const cur = readHidden();
  if (!cur.includes(appId)) writeHidden([...cur, appId]);
}

/* ── 卡片组装（依赖注入形态，便于单测）── */

/** 组装输入：消费方（app-center.tsx hooks）从插槽/manifest 取数后传入；runs 是闭包。 */
export function buildApps(input: {
  exts: Array<{ id: string; name?: string; version?: string; description?: string; icon?: string | null; category?: string; features?: Array<{ id: string; type?: string; label?: string; description?: string; category?: string; enabled: boolean }> | null }>;
  slotItems: Array<{ slot: "toolbar" | "sidebarFooter" | "rightFileDock" | "dialogs"; id: string; extId?: string; meta?: { label?: string; title?: string; icon?: unknown; onClick?: (e?: unknown) => void }; category?: string }>;
  featureState: Record<string, boolean>;
  /** 面板打开原语（present 状态机语义糖；UI 层注入，rightFileDock 卡专用）。 */
  openPanel: (key: string) => void;
}): AppDescriptor[] {
  const out: AppDescriptor[] = [];
  const seen = new Set<string>();
  const extById = new Map(input.exts.map((e) => [e.id, e]));
  for (const it of input.slotItems) {
    const colon = it.id.indexOf(":");
    const extId = it.extId ?? (colon > 0 ? it.id.slice(0, colon) : "");
    if (!extId) continue;
    const ext = extById.get(extId);
    const isPanel = it.slot === "rightFileDock";
    // 动作卡只收声明式条目（meta.onClick 可调——静态条目自带物化转发；带 render 的自绘
    // 条目无法异位重放）；面板卡走 openPanel（present），不依赖 onClick。
    if (!isPanel && typeof it.meta?.onClick !== "function") continue;
    if (it.slot === "dialogs") continue; // v1：dialogs 不进（非 float 自绘弹窗 present 无响应 = 死卡；float 面板主场景已被 rightFileDock 覆盖）
    // feature 门控关闭的条目不进卡（宿主工具条等消费方都会隐藏它——抽屉里留着 = 永远
    // 点不出东西的死卡，如 ACP 的 behavior.showAcpManager 默认关）
    const feat = (it as { feature?: string }).feature;
    if (feat && input.featureState[`${extId}:${feat}`] === false) continue;
    // 静态条目（懒加载清单声明）不进面板卡：其 id 是声明标记（如 aiti-editor 的 "file"，
    // 真实 dock key 是按实例的 "file:<path>"），对它 present 永远打不中 = 死卡；动态注册
    // 的同名条目出现后静态条目本就退休，能留下来的静态面板条目都是打不中的。
    if (isPanel && (it as { static?: boolean }).static) continue;
    const kind: AppKind = isPanel ? "panel" : (it.slot === "sidebarFooter" ? "manage" : "action");
    // 面板卡 key 与卡 id 必须用宿主全序 id（`<extId>:<注册 id>`——dock present 状态机按这个 key
    // 寻址；注册侧的裸 id（如 session-manager 的 "panel"）不带前缀时 present 打到不存在的 key = 死卡）
    const fullId = it.id.startsWith(`${extId}:`) ? it.id : `${extId}:${it.id}`;
    const id = `${kind}:${fullId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = String(it.meta?.label ?? it.meta?.title ?? (colon > 0 ? it.id.slice(colon + 1) : it.id));
    out.push({
      id,
      kind,
      category: resolveCategory((it as { category?: string }).category ?? (it.meta as { category?: string } | undefined)?.category, ext?.category, extId),
      label,
      extId,
      extName: ext?.name,
      extVersion: ext?.version,
      extDescription: ext?.description,
      extIcon: ext?.icon ?? undefined,
      icon: it.meta?.icon as AppDescriptor["icon"],
      keywords: [...(APP_OVERRIDES[extId]?.keywords ?? [])],
      run: isPanel
        ? () => input.openPanel(fullId)
        : () => { try { it.meta!.onClick!(undefined); } catch { /* ignore */ } },
    });
  }
  // toggle 卡：boolean features（string/textlist 是配置项不进开关；extman 面板承接）
  for (const ext of input.exts) {
    for (const f of ext.features ?? []) {
      if (f.type && f.type !== "boolean") continue;
      const id = `toggle:${ext.id}:${f.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        kind: "toggle",
        category: resolveCategory(f.category, ext.category, ext.id),
        label: String(f.label ?? f.id),
        featureDescription: f.description,
        extId: ext.id,
        extName: ext.name,
        extVersion: ext.version,
        extDescription: ext.description,
        extIcon: ext.icon ?? undefined,
        keywords: [...(APP_OVERRIDES[ext.id]?.keywords ?? []), f.id],
        on: input.featureState[`${ext.id}:${f.id}`] ?? f.enabled !== false,
        run: () => { /* toggle run 在 UI 层接线（异步 + 事件回灌） */ },
      });
    }
  }
  // 同扩展同名去重（跨 kind）：toolbar/sidebarFooter 动作卡与 rightFileDock 面板卡描述同一
  // 功能时（如 调度/显示环境/文档/邮件/扩展/服务端口 双卡），保留面板卡（present 状态机语义
  // 最全：浮动/停靠/关闭 + 位置持久化），面板缺席时保留原动作卡。首个出现位次保留。
  const rank = (k: AppKind) => (k === "panel" ? 0 : k === "toggle" ? 1 : 2);
  const best = new Map<string, AppDescriptor>();
  const order: string[] = [];
  for (const a of out) {
    const key = `${a.kind === "toggle" ? "t" : "e"}\n${a.extId}\n${a.label}`;
    const prev = best.get(key);
    if (!prev) { best.set(key, a); order.push(key); continue; }
    if (rank(a.kind) < rank(prev.kind)) best.set(key, a);
  }
  return order.map((k) => best.get(k)!);
}

/** extman ops set-feature（boolean）；成功后按 extman 同款 detail 广播 → 宿主 feature store 原地 patch（插槽条目即时显隐）。 */
export async function setBooleanFeature(apiUrlFn: (p: string) => string, extId: string, featureId: string, enabled: boolean): Promise<boolean> {
  try {
    const res = await fetch(apiUrlFn("/api/extensions/aiti-extman/ops"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-feature", id: extId, featureId, enabled }),
    });
    if (!res.ok) return false;
    try { window.dispatchEvent(new CustomEvent("pi-web:ext-features-changed", { detail: { extId, featureId, enabled } })); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

/* ── 视图分置（重构方案 §1/§2）：应用视图 = 可执行入口，开关视图 = toggle 按扩展分组 ── */

export function splitByKind(apps: AppDescriptor[]): { entries: AppDescriptor[]; toggles: AppDescriptor[] } {
  const entries: AppDescriptor[] = [];
  const toggles: AppDescriptor[] = [];
  for (const a of apps) (a.kind === "toggle" ? toggles : entries).push(a);
  return { entries, toggles };
}

export interface ToggleGroup {
  extId: string;
  extName?: string;
  extIcon?: string | { svg: string };
  apps: AppDescriptor[];
}

/** 开关按来源扩展分组（组头 = 扩展图标 + 名 + 计数）；组序按扩展名，组内保持 manifest 声明序。 */
export function extensionToggleGroups(apps: AppDescriptor[]): ToggleGroup[] {
  const byExt = new Map<string, ToggleGroup>();
  for (const a of apps) {
    if (a.kind !== "toggle") continue;
    let g = byExt.get(a.extId);
    if (!g) { g = { extId: a.extId, extName: a.extName, extIcon: a.extIcon, apps: [] }; byExt.set(a.extId, g); }
    g.apps.push(a);
  }
  return [...byExt.values()].sort((x, y) => (x.extName ?? x.extId).localeCompare(y.extName ?? y.extId));
}

/** manifest 条目的依赖相关字段（宿主 ManifestExtension 子集）。 */
export interface ManifestDepEntry { id: string; name?: string; dependsOn?: string[]; provides?: string[] }

/**
 * 硬依赖者（信息页「一键禁用」置灰用）。口径 = manifest 声明近似（extman 前端用 status
 * 的 depsResolved 精确解析，差异接受）：`dependsOn` 元素命中 extId 本身、`<extId>.<cap>` /
 * `<extId>:<cap>` 能力前缀、或 extId 声明的 provides 能力名。manifest 只含启用的扩展。
 */
export function hardDependents(exts: ManifestDepEntry[], extId: string): string[] {
  const provides = new Set(exts.find((e) => e.id === extId)?.provides ?? []);
  const names = new Set<string>();
  for (const e of exts) {
    if (e.id === extId) continue;
    const hit = (e.dependsOn ?? []).some(
      (d) => d === extId || d.startsWith(`${extId}.`) || d.startsWith(`${extId}:`) || provides.has(d),
    );
    if (hit) names.add(e.name ?? e.id);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** extman ops disable（一键禁用扩展）。成功判定含 body.error —— ops 在 HTTP 200 里回业务错误。 */
export async function disableExtension(apiUrlFn: (p: string) => string, extId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(apiUrlFn("/api/extensions/aiti-extman/ops"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "disable", id: extId }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (!res.ok || body?.error) return { ok: false, error: String(body?.error ?? `HTTP ${res.status}`) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
