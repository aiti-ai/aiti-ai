/**
 * aiti-agent-manager —— 统一 Agent 管理界面（框架层；docs/aiti-codebuddy-agent-plan.md §9 · §9.5）。
 *
 * 架构（2026-09-13 二版，拍板）：**manager 不写死任何一家 agent**——
 *   - 每家 agent 扩展在 startup 里 `ctx.services.provide("<extId>.agent", descriptor)`
 *     自报家门（label / modes / fs 探测表 / 账号档凭据槽位 / 登录动作）；
 *   - manager 遍历宿主扩展清单（`registry.status()`）动态发现 + 聚合 + 统一渲染；
 *   - 登录操作仍**代理到各扩展既有 /login/* 端点**（本扩展不实现任何登录协议、不碰凭据内容）；
 *   - 账号档（备份/切换/登出/自动保险）由本扩展做文件级实现，凭据槽位来自各 descriptor。
 * 未 provide 描述符的扩展 = 不出现在管理面（其登录能力本就不可用）。
 *
 * 端点（本扩展前缀下）：
 *   GET  /agents                        → 聚合清单（authState/flowState/modes/installed/accounts）
 *   GET  /login-status                  → 同 /agents（plan §9.2 命名兼容别名）
 *   POST /ctl/{agent}/start|cancel|submit  → 转发 descriptor.actions 或标准受控登录端点
 *   GET  /accounts                      → 账号档总览
 *   POST /accounts/{agent}/{save|switch|remove|logout} {alias?}
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  aggregateAgent, collectAgents, readPiHostAuthProviders,
  type AccountSlot, type CollectedAgent,
} from "./agents-registry.ts";
// 账号档共享引擎（副本；权威源 pi-web-ext/_shared/agent-accounts.ts，shared-copy-sync 测试钉一致性）
import {
  autoAlias, clearSlots, hasAnySlotContent, isCurrentCovered,
  listAccounts, readAccountsStore, removeAccount, saveAccount, switchAccount, writeAccountsStore,
  type AccountDisplay, type AccountEntry,
} from "@aiti-ai/ext-shared/agent-accounts";

type RegistryLike = {
  status(): Record<string, unknown>;
  api(req: Request, pathSegments: string[]): Promise<Response | null>;
};

type ServicesLike = {
  get(key: string): unknown;
};

/** startup 捕获的宿主上下文（api 请求期使用）。 */
let startupConfigDir: string | null = null;
let hostSvc: ServicesLike | null = null;

/** 宿主扩展 registry（进程内跨扩展调用的唯一合法通道；session-manager callProvider 同款）。 */
function hostRegistry(): RegistryLike | null {
  const reg = (globalThis as { __piWebExt?: RegistryLike }).__piWebExt;
  return reg && typeof reg.status === "function" && typeof reg.api === "function" ? reg : null;
}

/** 扩展是否已部署（status 表里有 id 且非 error 卸载态）。 */
function extInstalledInHost(extId: string): boolean {
  try {
    const st = hostRegistry()?.status?.();
    const e = st?.[extId] as { error?: unknown } | undefined;
    return Boolean(e) && !e?.error;
  } catch { return false; }
}

/** 动态收集当前已 provide 描述符的 agent（框架不写死任何一家）。 */
function collectedAgents(): CollectedAgent[] {
  let status: Record<string, unknown> | null = null;
  try {
    status = (hostRegistry()?.status?.() as Record<string, unknown>) ?? null;
  } catch { status = null; }
  return collectAgents({ status, getService: (k) => hostSvc?.get?.(k) });
}

function findCollected(agent: string): CollectedAgent | null {
  return collectedAgents().find((c) => c.def.agent === agent) ?? null;
}

/** 进程内调用目标扩展的 /login/* 端点（sub 相对 login）；不可达返回 null。 */
async function callExt(extId: string, method: string, sub: string[], body?: unknown, query?: string): Promise<Record<string, unknown> | null> {
  const reg = hostRegistry();
  if (!reg) return null;
  try {
    const url = `http://local/${extId}/login${sub.length ? "/" + sub.join("/") : ""}${query ? "?" + query : ""}`;
    const req = new Request(url, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    });
    const res = await reg.api(req, [extId, "login", ...sub]);
    if (!res || !res.ok) return null;
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ============================================================================
// 账号档（多 agent 登录备份/切换/自动保险）——单文件存储 <configDir>/agent-accounts.json
// （aiti-configs 备份时按 encrypt pattern 加密）。凭据槽位来自各家 descriptor。
// ============================================================================

/** 账号档单文件路径。 */
function accountsStoreFile(): string {
  return join(startupConfigDir ?? extConfigDirFallback(), "agent-accounts.json");
}

/** 当前机器上下文（传给 descriptor.accountSlots）。 */
function slotContext() {
  const home = homedir();
  return {
    home,
    webDataRoot: process.env.PI_WEB_DATA_DIR || join(home, ".pi", "web", "data"),
    env: process.env as Record<string, string | undefined>,
    platform: process.platform as string,
  };
}

/** 某 agent 的凭据槽位（由各扩展 descriptor 提供；异常/缺省 → 空表）。 */
function slotsFor(c: CollectedAgent): AccountSlot[] {
  if (typeof c.def.accountSlots !== "function") return [];
  try {
    const slots = c.def.accountSlots(slotContext());
    if (!Array.isArray(slots)) return [];
    return slots.filter((s) => s && typeof s.key === "string" && typeof s.path === "string");
  } catch { return []; }
}

/** 账号档列表 + 当前是否有凭据内容（读取失败 → 空，不阻断聚合）。
 * 顺带回填：身份命中且缺账号展示元数据的旧档 → 补写 user/uin/expiresAt（一次性迁移，同步块内原子）。 */
function accountSummaryFor(agent: string, slots: AccountSlot[], identity?: string, account?: AccountDisplay | undefined): { entries: AccountEntry[]; hasContent: boolean } {
  try {
    const file = accountsStoreFile();
    const store = readAccountsStore(file);
    if (identity && account) {
      let dirty = false;
      for (const acct of Object.values(store.accounts[agent] ?? {})) {
        if (acct.identity === identity && !acct.account) { acct.account = account; dirty = true; }
      }
      if (dirty) writeAccountsStore(file, store);
    }
    return {
      entries: listAccounts(store, agent, slots, identity ? { identity } : {}),
      hasContent: hasAnySlotContent(slots),
    };
  } catch {
    return { entries: [], hasContent: false };
  }
}

/** 从扩展 /login/status 提取账号展示元数据（user/uin/expiresAt；字段可缺）。 */
function accountMetaFromStatus(st: Record<string, unknown> | null | undefined): AccountDisplay | undefined {
  if (!st) return undefined;
  const account = st.account as { user?: unknown; uin?: unknown; expiresAt?: unknown } | undefined;
  const user = (typeof st.user === "string" && st.user.trim()) || (typeof account?.user === "string" && account.user.trim()) || "";
  const uin = typeof account?.uin === "string" ? account.uin : "";
  const rawExp = account?.expiresAt ?? st.expiresAt;
  const expiresAt = typeof rawExp === "number" && Number.isFinite(rawExp) ? rawExp : undefined;
  const out: AccountDisplay = {
    ...(user ? { user } : {}),
    ...(uin ? { uin } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** 从扩展 /login/status 响应提取账号身份（user|uin；都没有 → undefined）。 */
function identityFromStatus(st: Record<string, unknown> | null | undefined): string | undefined {
  const m = accountMetaFromStatus(st);
  const joined = [m?.user ?? "", m?.uin ?? ""].filter(Boolean).join("|");
  return joined || undefined;
}

/**
 * 登录前自动保险：当前登录存在且未被任何档覆盖 → 存 `_auto-before-login`。
 * 登录（受控/PTY OAuth）会覆写凭据，此保险保证旧账号永不因“重新登录”而丢。
 */
function autoInsureLogin(agent: string, slots: AccountSlot[], identity?: string, account?: AccountDisplay): boolean {
  try {
    const file = accountsStoreFile();
    const store = readAccountsStore(file);
    if (!hasAnySlotContent(slots) || isCurrentCovered(store, agent, slots, identity)) return false;
    saveAccount(store, agent, autoAlias("login"), slots, {
      auto: true,
      ...(identity ? { identity } : {}),
      ...(account ? { account } : {}),
    });
    writeAccountsStore(file, store);
    return true;
  } catch {
    return false;
  }
}

/** 登出：未存档 → 先存 `_auto-before-logout`，然后清空该 agent 全部槽位文件。 */
function logoutAgent(agent: string, slots: AccountSlot[], identity?: string, account?: AccountDisplay): { removed: string[]; autoSaved: boolean } {
  const file = accountsStoreFile();
  const store = readAccountsStore(file);
  let autoSaved = false;
  if (hasAnySlotContent(slots) && !isCurrentCovered(store, agent, slots, identity)) {
    try {
      saveAccount(store, agent, autoAlias("logout"), slots, {
        auto: true,
        ...(identity ? { identity } : {}),
        ...(account ? { account } : {}),
      });
      writeAccountsStore(file, store);
      autoSaved = true;
    } catch { /* 保险失败不阻断登出 */ }
  }
  return { removed: clearSlots(slots), autoSaved };
}

/** 账号显示名（扩展 /login/status 的 user/account.user；取不到 = undefined）。 */
function statusUserName(st: Record<string, unknown> | null): string | undefined {
  if (!st) return undefined;
  const account = st.account as { user?: unknown } | undefined;
  const user = st.user ?? account?.user;
  return typeof user === "string" && user.trim() ? user.trim() : undefined;
}

// ============================================================================
// 聚合
// ============================================================================

interface FsLike { existsSync: typeof existsSync; statSync: typeof statSync }
const FS: FsLike = { existsSync, statSync };

/** 单 agent 聚合（拉扩展状态 + fs 探测兜底 + 账号档）。 */
async function aggregateOne(c: CollectedAgent): Promise<Record<string, unknown>> {
  const { extId, def } = c;
  const extStatus = await callExt(extId, "GET", ["status"]);
  const extInstalled = extStatus !== null || extInstalledInHost(extId);
  const agg = aggregateAgent(def, {
    home: homedir(),
    env: process.env as Record<string, string | undefined>,
    fs: FS,
    extStatus,
  });
  const slots = slotsFor(c);
  // TUI OAuth 形态（codebuddy）：聚合并发拉 tui-status，面板直接展示 sid/授权 URL
  let tui: Record<string, unknown> | null = null;
  if ((def.modes ?? []).includes("tui") && extInstalled) {
    const t = await callExt(extId, "GET", ["tui", "status"]);
    if (t && t.state !== "idle") tui = { tuiState: t.state, tuiSid: t.sid, ...(t.url ? { tuiUrl: t.url } : {}) };
  }
  const accountSummary = accountSummaryFor(def.agent, slots, identityFromStatus(extStatus), accountMetaFromStatus(extStatus));
  // 官方额度（descriptor.accountQuota；如 codebuddy credits）——扩展侧自带 60s 缓存
  let quota: Record<string, unknown> | null = null;
  if (def.accountQuota === true && extInstalled) quota = await callExt(extId, "GET", ["quota"]);
  return {
    agent: def.agent,
    label: def.label,
    extId,
    modes: def.modes ?? [],
    installed: extInstalled,
    authState: agg.authState,
    flowState: agg.flowState,
    authSource: agg.source,
    dependencyHint: def.dependencyHint ?? "",
    // 账号档：entries = 已保存档（含 current 标记）；hasContent = 本机当前是否有凭据文件
    accounts: accountSummary.entries,
    hasContent: accountSummary.hasContent,
    // 扩展流程态透传（url/error 等，供面板直接渲染 A/B 模式）
    ...(extStatus ? { ext: extStatus } : {}),
    ...(tui ? { tui } : {}),
    ...(quota ? { quota } : {}),
  };
}

/** pi 宿主 agent 目录（getAgentDir 惯例：PI_CODING_AGENT_DIR 优先）。 */
function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

async function agentsEndpoint(): Promise<Response> {
  const collected = collectedAgents();
  const agents = await Promise.all(collected.map(aggregateOne));
  // §9.5 步 5：pi 宿主订阅 provider 并列展示（auth.json 只读，不返回 token）
  const piHost = readPiHostAuthProviders(piAgentDir(), (p) => (existsSync(p) ? readFileSync(p, "utf8") : null));
  return Response.json({ agents, piHost });
}

// ============================================================================
// 登录操作代理（descriptor.actions 优先；缺省标准 start/cancel/submit）
// ============================================================================

async function ctlEndpoint(agent: string, action: string, method: string, body: Record<string, unknown>): Promise<Response> {
  const c = findCollected(agent);
  if (!c) return Response.json({ error: `未知 agent：${agent}（未部署或未提供描述符服务 <extId>.agent）` }, { status: 404 });
  const { extId, def } = c;
  const actions = def.actions ?? {};
  const std = new Set(["start", "cancel", "submit"]);
  const spec = actions[action] ?? (std.has(action) ? { m: "POST", sub: [action], body: action !== "cancel" } : null);
  if (!spec) return Response.json({ error: `${agent} 不支持动作 ${action}` }, { status: 404 });

  // 登录会覆写凭据 → 启动前自动保险（_auto-before-login）
  if (action === "start" || action === "tui-start") {
    const st = await callExt(extId, "GET", ["status"]);
    autoInsureLogin(agent, slotsFor(c), identityFromStatus(st), accountMetaFromStatus(st));
  }
  let payload: unknown;
  if (action === "start") payload = { consoleMode: body?.consoleMode === true };
  else if (action === "submit") payload = { code: String(body?.code ?? "") };
  else if (spec.body) payload = body;

  const res = await callExt(extId, spec.m, spec.sub, spec.m === "GET" ? undefined : payload);
  if (!res) return Response.json({ error: `${extId} 不可达（未部署或未 reload；端点缺失）` }, { status: 502 });
  return Response.json(res);
}

/** dataDir 兑底（宿主 serverContext 恒带 configDir；自拼仅防御性）。 */
function extConfigDirFallback(): string {
  const env = process.env.PI_WEB_DATA_DIR;
  const root = env || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "web", "data");
  return join(root, "aiti-agent-manager", "config");
}

// ============================================================================
// 账号档 API（/accounts）：总览 + save / switch / remove / logout。
// 单文件存储 <configDir>/agent-accounts.json；本层只搬运文件与元数据，不解析 token。
// ============================================================================

/** GET /quota/{agent}[?force=1] → 代理扩展 /login/quota（官方额度；descriptor.accountQuota 声明的才可查）。 */
async function quotaProxy(agent: string, method: string, searchParams: URLSearchParams): Promise<Response> {
  const c = findCollected(agent);
  if (!c) return Response.json({ error: `未知 agent：${agent}（未部署或未提供描述符服务 <extId>.agent）` }, { status: 404 });
  if (c.def.accountQuota !== true) return Response.json({ error: `${agent} 未声明额度查询能力` }, { status: 404 });
  const force = searchParams?.get("force") === "1";
  const res = await callExt(c.extId, "GET", ["quota"], undefined, force ? "force=1" : undefined);
  if (!res) return Response.json({ error: `${c.extId} 不可达（未部署或未 reload）` }, { status: 502 });
  return Response.json(res);
}

/** GET /accounts → 全部 agent 的槽位现状 + 账号档列表。 */
async function accountsOverview(): Promise<Response> {
  const store = readAccountsStore(accountsStoreFile());
  const agents: Record<string, unknown> = {};
  for (const c of collectedAgents()) {
    const slots = slotsFor(c);
    const status = await callExt(c.extId, "GET", ["status"]);
    const identity = identityFromStatus(status);
    agents[c.def.agent] = {
      extId: c.extId,
      slots: slots.map((s) => ({ key: s.key, label: s.label, exists: existsSync(s.path) })),
      accounts: listAccounts(store, c.def.agent, slots, identity ? { identity } : {}),
    };
  }
  return Response.json({ file: accountsStoreFile(), agents });
}

/** POST /accounts/{agent}/{action} {alias?} → save / switch / remove / logout。 */
async function accountsAction(agent: string, action: string, body: Record<string, unknown>): Promise<Response> {
  const c = findCollected(agent);
  if (!c) return Response.json({ error: `未知 agent：${agent}（未部署或未提供描述符服务 <extId>.agent）` }, { status: 404 });
  const file = accountsStoreFile();
  const slots = slotsFor(c);
  const alias = typeof body.alias === "string" ? body.alias : "";
  const status = await callExt(c.extId, "GET", ["status"]);
  const identity = identityFromStatus(status);
  const account = accountMetaFromStatus(status);
  try {
    const store = readAccountsStore(file);
    switch (action) {
      case "save": {
        const note = statusUserName(status);
        const { entry, overwritten } = saveAccount(store, agent, alias, slots, {
          ...(note ? { note } : {}),
          ...(identity ? { identity } : {}),
          ...(account ? { account } : {}),
        });
        writeAccountsStore(file, store);
        return Response.json({ ok: true, entry, overwritten, accounts: listAccounts(store, agent, slots, identity ? { identity } : {}) });
      }
      case "switch": {
        const { entry, autoSaved } = switchAccount(store, agent, alias, slots, {
          ...(identity ? { identity } : {}),
          ...(account ? { account } : {}),
        });
        writeAccountsStore(file, store);
        return Response.json({
          ok: true, entry, autoSaved,
          accounts: listAccounts(store, agent, slots, identity ? { identity } : {}),
          runtimeNote: "只影响之后新建/重建的会话；运行中的会话保持原账号",
        });
      }
      case "remove": {
        const removed = removeAccount(store, agent, alias);
        writeAccountsStore(file, store);
        return Response.json({ ok: removed, accounts: listAccounts(store, agent, slots, identity ? { identity } : {}) });
      }
      case "logout": {
        const r = logoutAgent(agent, slots, identity, account);
        return Response.json({
          ok: true, removed: r.removed, autoSaved: r.autoSaved,
          accounts: listAccounts(readAccountsStore(file), agent, slots, identity ? { identity } : {}),
        });
      }
      default:
        return Response.json({ error: `未知账号档动作：${action}（可选 save/switch/remove/logout）` }, { status: 404 });
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export default {
  id: "aiti-agent-manager",
  name: "Agent 管理界面",
  version: "0.2.0",
  icon: "🤖",
  // 统一管理面板（零构建原生 h() client；client/ 下文件随 deploy 拷入 dist/）
  client: "dist/agent-manager-client.mjs",
  // 静态插入点声明（与 client registerItems 的 id 一一对应；extman 展示/懒加载对账用）
  ui: {
    // [懒加载 v2] 纯登录态面板：开页不拉 client bundle（24KB）；toolbar 静态按钮点击
    // 经 meta.onClick（requestOpen 记 pending）物化后打开。
    clientImmediately: false,
    // 预取提示：OAuth 终端面板交互依赖 aiti-cmd（实际可用性走 ctx.getExtService + ensureMaterialized 懒加载兜底）
    clientDependsOn: ["aiti-cmd"],
    toolbar: [{
      id: "aiti-agent-manager-panel",
      label: "Agent 管理",
      title: "Agent 管理（统一登录态）",
      icon: "icons/bot.svg",
    }],
    dialogs: [{ id: "aiti-agent-manager-panel-dialog", label: "Agent 管理" }],
  },

  server: {
    startup(ctx: { configDir?: string; services?: ServicesLike }) {
      startupConfigDir = ctx.configDir ?? extConfigDirFallback();
      hostSvc = ctx.services ?? null;
      console.log(`[aiti-agent-manager] ready (configDir: ${startupConfigDir}；账号档：agent-accounts.json；agent 发现：<extId>.agent 服务)`);
    },

    async api(req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) {
      const [seg0, seg1, seg2] = Array.isArray(ctx.path) ? ctx.path : [];
      const method = String(ctx.method ?? "GET").toUpperCase();
      if (seg0 === "agents" && method === "GET") return agentsEndpoint();
      if (seg0 === "login-status" && method === "GET") return agentsEndpoint(); // plan §9.2 命名别名
      if (seg0 === "quota" && method === "GET") {
        return quotaProxy(seg1 ?? "", method, ctx.searchParams);
      }
      if (seg0 === "accounts") {
        if (method === "GET" && !seg1) return accountsOverview();
        if (method === "POST") {
          let body: Record<string, unknown> = {};
          try { body = (await req.json()) as Record<string, unknown>; } catch { /* 空体 */ }
          return accountsAction(seg1 ?? "", seg2 ?? "", body);
        }
        return Response.json({ error: `未知账号档端点（${method} /accounts/${seg1 ?? ""}）` }, { status: 404 });
      }
      if (seg0 === "ctl" && method === "POST") {
        let body: Record<string, unknown> = {};
        try { body = await req.json() as Record<string, unknown>; } catch { /* 空体 */ }
        return ctlEndpoint(seg1 ?? "", seg2 ?? "", method, body);
      }
      if (seg0 === "ctl" && method === "GET") {
        return ctlEndpoint(seg1 ?? "", seg2 ?? "", method, {});
      }
      return Response.json({ error: `未知端点 /${(ctx.path ?? []).join("/")}` }, { status: 404 });
    },
  },
};
