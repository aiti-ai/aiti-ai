/**
 * agents-registry —— agent 描述符契约 + 动态收集 + 聚合逻辑（纯模块，可测）。
 *
 * 架构（2026-09-13 二版，拍板）：**manager 不写死任何一家 agent**——每家 agent 扩展在
 * startup 里 `ctx.services.provide("<extId>.agent", descriptor)` 自报家门（label / modes /
 * fs 探测表 / 凭据槽位 / 登录动作）；manager 遍历宿主扩展清单（`registry.status()`）
 * 动态发现、聚合并统一展示。未 provide 的扩展 = 不出现在管理面（其登录能力本就不可用）。
 *
 * 聚合原则不变：
 *   - **不实现任何登录协议、不碰凭据内容**——只做 stat 级存在性探测与端点转发；
 *   - 扩展智能状态端点（`/login/status` 返回 `{state: ready|missing|…}`）优先，
 *     否则按 descriptor.auth 候选探测表（file 非空 / dir 存在 / env 非空）；
 *   - 账号档凭据槽位由 `descriptor.accountSlots(ctx)` 提供（各家的路径知识留在各家）。
 *
 * 探测表事实依据（2026-09-10/11 实测本机，现由各家自行声明）：
 *   zcode ~/.zcode/v2/credentials.json · claude ~/.claude/.credentials.json ·
 *   codex ~/.codex/auth.json · cursor ~/.config/cursor/auth.json ·
 *   qoder ~/.qoder{,-cn}/.auth/user · codebuddy 扩展端点优先（CLI auth + 托管凭据）
 */

export type AuthState = "ready" | "missing" | "unknown";

export interface AuthProbeEntry {
  kind: "file" | "dir" | "env";
  /** file/dir: 相对 HOME 的路径段；env: 环境变量名 */
  path: string[];
  label: string;
}

/** 登录形态：url=A url-only / paste=B paste-relay / apikey=API-key 注入 / tui=服务端 PTY 驱动。 */
export type AgentMode = "url" | "paste" | "apikey" | "tui";

/** 账号档凭据槽位（账号档引擎通用形状；key 为逻辑标识，path 为当前机器绝对路径）。 */
export interface AccountSlot {
  key: string;
  label: string;
  path: string;
}

/** descriptor.accountSlots 的入参：manager 组装的当前机器上下文。 */
export interface AccountSlotContext {
  home: string;
  /** PI_WEB_DATA_DIR（或默认 ~/.pi/web/data）——data 根；派生各扩展 configDir 用（<data>/<extId>/config）。 */
  webDataRoot: string;
  env: Record<string, string | undefined>;
  platform: string;
}

/** 登录动作代理映射（manager /ctl/{agent}/{action} 转发用）。 */
export interface AgentActionSpec {
  m: string;
  sub: string[];
  body?: boolean;
}

/**
 * 各 agent 扩展在 startup 里 provide 的描述符（key = `<extId>.agent`）。
 * 扩展侧直接写对象字面量（无需 import 本类型）；manager 侧消费。
 */
export interface AgentDescriptor {
  /** agent 唯一 key（/ctl/{agent} 与账号档分组用，如 "codebuddy"） */
  agent: string;
  label: string;
  modes: AgentMode[];
  /** true = 本扩展 /login/status 返回 {state:"ready"|"missing"} 语义（优先于 fs 探测） */
  extReportsAuthState?: boolean;
  /** true = 支持官方账号额度查询（GET /login/quota；如 codebuddy credits） */
  accountQuota?: boolean;
  dependencyHint?: string;
  /** fs/env 候选探测（任一命中 = ready）；缺省 = 只信扩展端点 */
  auth?: AuthProbeEntry[];
  /** 本家账号档凭据槽位（路径知识在本家；可闭包捕获 configDir） */
  accountSlots?: (ctx: AccountSlotContext) => AccountSlot[];
  /** 非标准登录动作（如 codebuddy 的 tui-start/set-key/clear）；缺省 = 标准 start/cancel/submit */
  actions?: Record<string, AgentActionSpec>;
}

/** 服务 key 后缀约定：`<extId>.agent`。 */
export const AGENT_DESCRIPTOR_SUFFIX = ".agent";

export interface CollectedAgent {
  extId: string;
  def: AgentDescriptor;
}

/**
 * 从宿主扩展清单 + 服务定位器动态收集 agent 描述符（纯函数）。
 * 跳过：未启用/报错的扩展、未 provide 描述符或不合法（agent/label 缺失）的扩展。
 * 返回按 agent 名排序（面板顺序稳定）。
 */
export function collectAgents(opts: {
  status: Record<string, unknown> | null;
  getService: (key: string) => unknown;
}): CollectedAgent[] {
  if (!opts.status || typeof opts.status !== "object") return [];
  const out: CollectedAgent[] = [];
  for (const [extId, raw] of Object.entries(opts.status)) {
    const entry = raw as { enabled?: unknown } | undefined;
    if (entry && entry.enabled === false) continue;
    let d: AgentDescriptor | undefined;
    try {
      d = opts.getService(extId + AGENT_DESCRIPTOR_SUFFIX) as AgentDescriptor | undefined;
    } catch {
      d = undefined;
    }
    if (!d || typeof d.agent !== "string" || !d.agent) continue;
    if (typeof d.label !== "string" || !d.label) continue;
    if (!Array.isArray(d.modes)) d = { ...d, modes: [] };
    out.push({ extId, def: d });
  }
  return out.sort((a, b) => a.def.agent.localeCompare(b.def.agent));
}

export interface ProbeFs {
  existsSync(path: string): boolean;
  statSync(path: string): { size: number };
}

/** fs/env 候选探测：任一命中 = ready；全不命中 = missing（空候选表由调用方归 unknown）。 */
export function probeAuthEntries(entries: AuthProbeEntry[], home: string, env: Record<string, string | undefined>, fs: ProbeFs): AuthState {
  for (const e of entries) {
    if (e.kind === "env") {
      const v = env[e.path[0]];
      if (typeof v === "string" && v.trim()) return "ready";
      continue;
    }
    const p = [home, ...e.path].join("/");
    if (!fs.existsSync(p)) continue;
    if (e.kind === "dir") return "ready"; // 目录存在即命中
    try {
      if (fs.statSync(p).size > 0) return "ready"; // 文件存在且非空
    } catch { /* raced → 下一候选 */ }
  }
  return "missing";
}

/** 单 agent 聚合：扩展智能端点 > fs 探测；无候选表且无智能端点 = unknown（fail-honest）。 */
export function aggregateAgent(def: AgentDescriptor, opts: {
  home: string;
  env: Record<string, string | undefined>;
  fs: ProbeFs;
  /** 扩展 /login/status 响应（拉取失败 = null） */
  extStatus: { authState?: unknown; state?: unknown } | null;
}): { authState: AuthState; flowState: "idle" | "logging-in" | string; source: "ext" | "fs" | "none" } {
  // 流程态：waiting = 登录中
  const flowState = opts.extStatus?.state === "waiting" ? "logging-in" : "idle";
  let authState: AuthState = "unknown";
  let source: "ext" | "fs" | "none" = "none";
  if (def.extReportsAuthState && opts.extStatus) {
    // 扩展智能端点：authState 字段优先，state 字段（codebuddy 语义 ready|missing）归一
    const raw = opts.extStatus.authState ?? opts.extStatus.state;
    if (raw === "ready" || raw === "missing") {
      authState = raw;
      source = "ext";
    }
  } else if (def.auth && def.auth.length > 0) {
    authState = probeAuthEntries(def.auth, opts.home, opts.env, opts.fs);
    source = "fs";
  }
  return { authState, flowState, source };
}

// ============================================================================
// §9.5 步 5：pi 宿主订阅 provider 状态（auth.json 只读；**绝不返回 token 内容**）
// ============================================================================

export interface PiHostProvider {
  provider: string;
  type?: string;
  user?: string;
  expires?: string;
  /** expires 已过期（能解析时） */
  expired?: boolean;
}

/** auth.json 单 provider 行归一（只取展示字段）。 */
export function toPiHostProvider(provider: string, raw: Record<string, unknown>): PiHostProvider {
  const out: PiHostProvider = { provider };
  if (typeof raw.type === "string") out.type = raw.type;
  const user = typeof raw.name === "string" && raw.name ? raw.name : typeof raw.email === "string" ? raw.email : undefined;
  if (user) out.user = user;
  const expires = typeof raw.expires === "string" ? raw.expires : typeof raw.expires === "number" ? new Date(raw.expires).toISOString() : undefined;
  if (expires) {
    out.expires = expires;
    const ms = Date.parse(expires);
    if (Number.isFinite(ms)) out.expired = ms < Date.now();
  }
  return out;
}

/**
 * 读 pi 宿主订阅 provider 清单（auth.json 顶层键 = provider id；只取展示字段，
 * access/refresh token 一律不读出不返回）。文件缺失/坏 JSON → 空数组（面板隐藏该组）。
 */
export function readPiHostAuthProviders(agentDir: string, readFile: (p: string) => string | null): PiHostProvider[] {
  let raw: string | null;
  try {
    raw = readFile(`${agentDir}/auth.json`);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([, v]) => v && typeof v === "object" && !Array.isArray(v))
    .map(([provider, v]) => toPiHostProvider(provider, v as Record<string, unknown>));
}
