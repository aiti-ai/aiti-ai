/**
 * aiti-codebuddy-agent —— 会话后端扩展：腾讯 CodeBuddy Code CLI（cbc）驱动。
 *
 * 打通 All Sessions 跨 agent 链路：面板里的 cbc 历史行（"codebuddy:<sid>"）经
 * openExternalSession → 本扩展 spawn cbc 续聊；全新会话首轮后从 system/init 帧
 * 捕获真实 session_id 换绑（懒持久化，CC 同款）。
 *
 * 协议（2.150.0 实测，docs/aiti-codebuddy-agent-plan.md §1/§4.2/§4.2b）：
 *   stream（默认，长连接，参照 aiti-claude-code-agent）：
 *     `cbc -p --input-format stream-json --output-format stream-json
 *           --include-partial-messages --verbose [--model M] [--permission-mode X] [--resume sid]`
 *     stdin  ← {"type":"user","message":{…}}                       用户消息（空闲时写入）
 *     stdin  ← {"type":"control_request",…}                        interrupt / set_model / set_permission_mode
 *     stdout → system/init / stream_event / assistant / result / control_response（CC 同形）
 *   exec（兼容档，feature codebuddy.connectionMode=exec）：每轮单发 + --resume：
 *     `cbc -p <prompt> --output-format stream-json --include-partial-messages
 *           [--model M] [--permission-mode X] [--resume sid]`
 *   stdout → {"type":"system","subtype":"init","session_id","model","tools",…}   （可能双发，幂等处理）
 *   stdout → {"type":"stream_event","event":{content_block_delta/text_delta}}     流式增量
 *   stdout → {"type":"assistant","message":{content:[…],"model"}}                 完整消息
 *   stdout → {"type":"result","subtype",…,"is_error","usage","modelUsage"}        轮终结
 *   ⚠ 错误轮 exit code 也是 0 —— 成败只认 result 帧（exec 模式）。
 *
 * 进程模型（2026-09-12 起默认长连接）：stream = 单进程多轮（cwd 进程内固定、免每轮
 * MCP/LSP 冷启动、运行中可切模型/权限）；exec = 原每轮单发（进程隔离）。运行中输入
 * 一律入本地 followUp 队列（backend-queue 共享层，面板可见可撤回）。
 * handle 实现（两模式共享层）在 codebuddy-handles.ts。
 *
 * 认证（plan §4.3 路径 A · P0）：CODEBUDDY_API_KEY / CODEBUDDY_AUTH_TOKEN / CODEBUDDY_BASE_URL
 * env 直读（iam.md 官方通道）；值存扩展 configDir 凭据文件（0600），feature 可覆盖。
 * 浏览器 OAuth（服务端 PTY 驱动）留 P1（plan §9.3）。
 */

import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnEnvFeature, spawnCommandFeature, spawnArgsPrefixFeature, captureSpawnEnvFeatures } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import {
  readExtModelState, readAgentLastUsedModel, withLastUsedFirst,
} from "@aiti-ai/ext-shared/ext-model-state";
import {
  CBC_PERMISSION_MODES, DEFAULT_MODEL,
  buildLoginCommand, codebuddyDataRoots, credPath, extractCbcLoginUrl, loadCachedCbcModels, loginFingerprint,
  readCliAuth, readCred, refreshCbcModelCatalog, resolveCli, setCachedCbcModels, stripAnsi, writeCred,
  CBC_CLI_AUTH_REL, isolateCliLogin, fetchCbcQuota, readCliAuthCredentials,
  type CbcCredentials, type ResolvedCli, type IsolatedLogin,
} from "./codebuddy-core.ts";
// handle 实现（stream 长连接 + exec 单发双模式；能力表/目录/SID_RE 同源）
import {
  CBC_CAPABILITIES, SID_RE, codebuddyCatalog, createCodebuddyHandle, setCodebuddyQueueStateDir,
  type CodebuddyHandleBase, type CodebuddyRuntime,
} from "./codebuddy-handles.ts";

// ============================================================================
// 结构化契约（out-of-tree）
// ============================================================================

interface SessionCapabilitiesLike extends Record<string, boolean> {}

// ============================================================================
// feature 读取（extman 功能管理）——ctx.features 优先，__piWebExt 直调兜底
// ============================================================================

let hostFeatures: any = null;
let hostSvc: any = null;
type FeatureRegistry = { featureValue?: (extId: string, fid: string) => boolean | string };
function featureRegistry(): FeatureRegistry | undefined {
  return (globalThis as Record<string, unknown>).__piWebExt as FeatureRegistry | undefined;
}
function featureString(fid: string): string {
  const v = hostFeatures?.get?.("aiti-codebuddy-agent", fid);
  if (typeof v === "string") return v;
  const reg = featureRegistry();
  const v2 = reg?.featureValue ? reg.featureValue("aiti-codebuddy-agent", fid) : "";
  return typeof v2 === "string" ? v2 : "";
}

function featureCliPath(): string | undefined {
  const v = featureString("codebuddy.cliPath").trim();
  return v || undefined;
}
function featurePkgSpec(): string {
  return featureString("codebuddy.packageSpec").trim(); // 空值走 core 默认 spec
}
function featureModel(): string | undefined {
  const v = featureString("codebuddy.model").trim();
  return v || undefined;
}
function featurePermissionMode(): string {
  const v = featureString("codebuddy.permissionMode").trim();
  return (CBC_PERMISSION_MODES as readonly string[]).includes(v) ? v : "bypassPermissions";
}
/** 连接模式：stream（默认，长连接）| exec（兼容档，每轮单发 + --resume）。 */
function featureConnectionMode(): "stream" | "exec" {
  return featureString("codebuddy.connectionMode").trim() === "exec" ? "exec" : "stream";
}
/** feature 凭据 override（优先于 configDir 凭据文件）。 */
function featureCred(): CbcCredentials {
  const out: CbcCredentials = {};
  const apiKey = featureString("codebuddy.apiKey").trim();
  const authToken = featureString("codebuddy.authToken").trim();
  const baseUrl = featureString("codebuddy.baseUrl").trim();
  if (apiKey) out.apiKey = apiKey;
  if (authToken) out.authToken = authToken;
  if (baseUrl) out.baseUrl = baseUrl;
  return out;
}

/** 每轮生效凭据：feature override > configDir 凭据文件。 */
function effectiveCred(configDir: string): CbcCredentials | null {
  const fromFeature = featureCred();
  if (Object.keys(fromFeature).length) return fromFeature;
  return readCred(configDir);
}

// ============================================================================
// Extension entry
// ============================================================================

let startupDataDir: string | null = null;
/** startup 时捕获的 state 目录（登录前凭据隔离备份用）。 */
let startupStateDir: string | null = null;
/** 备注：startup 时捕获的扩展数据目录（api 凭据端点用；未 startup 时兑底自拼）。 */

/** configDir 兑底（宿主 serverContext 恒带 configDir；自拼仅防御性——老宿主/测试无 ctx 时）。
 *  数据分层三目录对称（2026-09-13）后 configDir = 数据根/<id>/config（配置区）。 */
function extDataDir(): string {
  const env = process.env.PI_WEB_DATA_DIR;
  const root = env || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "web", "data");
  return join(root, "aiti-codebuddy-agent", "config");
}

/**
 * 凭据/登录态判定（登录徽标数据源），三来源任一命中 = ready：
 *   feature override（codebuddy.apiKey 等）> configDir 凭据文件 > **CLI 自身登录态**
 *   （浏览器 OAuth 落盘在 <数据根>/CodeBuddyExtension/Data/Public/auth/*.info；只读展示字段）。
 * 只有前两者是「本扩展托管凭据」→ canClear=true（登出按钮可点）；CLI 登录态不在本扩展
 * 管理范围（清凭据无效），登出需用户在 cbc 内 /logout。
 */
function credState(configDir: string): {
  state: "ready" | "missing";
  mode: "apikey" | "cli" | "none";
  sources: { feature: boolean; file: boolean; cli: boolean };
  hasBaseUrl: boolean;
  credentialFile: string;
  account?: { user: string; uin?: string; expired: boolean; expiresAt?: number };
  canClear: boolean;
} {
  const fromFeature = featureCred();
  const fromFile = readCred(configDir);
  const managed = Boolean(Object.keys(fromFeature).length) || Boolean(fromFile);
  const cli = readCliAuth();
  const ready = managed || Boolean(cli);
  const mode = managed ? "apikey" : cli ? "cli" : "none";
  return {
    state: ready ? "ready" : "missing",
    mode,
    sources: { feature: Boolean(Object.keys(fromFeature).length), file: Boolean(fromFile), cli: Boolean(cli) },
    hasBaseUrl: Boolean(fromFeature.baseUrl || fromFile?.baseUrl),
    credentialFile: credPath(configDir),
    ...(cli?.user || cli?.uin ? {
      account: {
        user: cli.user ?? cli.uin ?? "",
        ...(cli.uin ? { uin: cli.uin } : {}),
        expired: cli.expired,
        ...(cli.refreshExpiresAt ?? cli.expiresAt ? { expiresAt: cli.refreshExpiresAt ?? cli.expiresAt } : {}),
      },
    } : {}),
    canClear: managed,
  };
}

// ============================================================================
// 登录 PTY 驱动（plan §9.3 · §9.5 步 4）：服务端 spawn 交互 cbc TUI，进程所有权在后台。
// 契约：aiti-cmd M1 的 services.runner（run/input/kill/getInfo/buffered）——sid 共享给
// aiti-cmd 前端 xterm 渲染（event-bus cmd-<id>），站点选择等人工介入由用户在共享终端
// 直接键入或经 /login/tui/input 转发；授权 URL 从输出流抓取；完成以 ~/.codebuddy 落盘
// 指纹变化判定。不实现 OAuth 协议、不碰凭据内容（受控登录标准哲学）。
// ============================================================================

interface LoginTuiState {
  sid: string;
  startedAt: number;
  /** 登录前指纹（null = ~/.codebuddy 不存在）；变化 = 登录落盘完成 */
  baseline: string | null;
  /** 已捕获的授权 URL（sticky：ring 截断后仍可报） */
  url: string | null;
  done: boolean;
  failed: string | null;
  timeout: boolean;
  /** 登录前旧凭据备份目录（isolateCliLogin；无旧凭据时为空） */
  backupDir?: string;
}

let loginTui: LoginTuiState | null = null;
const LOGIN_TUI_TIMEOUT_MS = 330_000; // 受控登录标准兜底档（CLI 侧多为 300s 硬超时）

/** runner 服务定位（aiti-cmd M1；缺省 = 未部署/未 reload → 人话报错）。 */
function runnerSvc(): Record<string, (...a: unknown[]) => unknown> | null {
  const svc = hostSvc?.get?.("aiti-cmd.runner");
  return svc && typeof svc === "object" ? (svc as Record<string, (...a: unknown[]) => unknown>) : null;
}

function loginTuiText(runner: Record<string, (...a: unknown[]) => unknown>): string {
  try {
    const buf = runner.buffered(loginTui!.sid) as { chunks?: Array<{ data?: string }> } | null;
    return stripAnsi((buf?.chunks ?? []).map((c) => String(c.data ?? "")).join(""));
  } catch { return ""; }
}

function loginTuiView(runner: Record<string, (...a: unknown[]) => unknown> | null, state: string): Record<string, unknown> {
  if (!loginTui) return { state: "idle", mode: "tui" };
  const out: Record<string, unknown> = {
    state, mode: "tui", sid: loginTui.sid, startedAt: loginTui.startedAt,
    ...(loginTui.url ? { url: loginTui.url } : {}),
    ...(loginTui.failed ? { error: loginTui.failed } : {}),
    ...(loginTui.backupDir ? { backupDir: loginTui.backupDir } : {}),
  };
  if (runner && (state === "waiting" || state === "failed" || state === "timeout")) {
    const text = loginTuiText(runner);
    if (text) out.tail = text.slice(-500);
  }
  return out;
}

function startLoginTui(body: Record<string, unknown>): Promise<Response> {
  const runner = runnerSvc();
  if (!runner?.run || !runner.input || !runner.buffered) {
    return Promise.resolve(Response.json(
      { error: "aiti-cmd 未提供 runner 服务（aiti-cmd 扩展未部署/未 reload；M1 见 docs/aiti-cmd-exec-integration-plan.md §3.2）" },
      { status: 501 },
    ));
  }
  // 幂等：已有存活登录会话且未收口 → 原样返回
  if (loginTui && !loginTui.done && !loginTui.failed && !loginTui.timeout) {
    const info = runner.getInfo(loginTui.sid) as { status?: string } | null;
    if (info?.status === "running") return Promise.resolve(Response.json(loginTuiView(runner, "waiting")));
  }
  let cli: ResolvedCli;
  try {
    cli = resolveCli({ featurePath: featureCliPath(), pkgSpec: featurePkgSpec() });
  } catch (e) {
    return Promise.resolve(Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }));
  }
  // 用户要求（2026-09-13）：cbc login 会拿现存 token 去注销/覆盖旧账号——
  // 启动登录进程前，先把当前登录凭据备份并移走（CLI auth *.info + 托管凭据）。
  let isolate: IsolatedLogin = { backupDir: "", moved: [] };
  try {
    const cfg = startupDataDir ?? extDataDir();
    const stateDir = startupStateDir ?? join(cfg, "..", "state");
    isolate = isolateCliLogin({ configDir: cfg, stateDir });
  } catch { /* 隔离失败不阻断登录，但保留旧凭据风险 */ }
  const baseline = loginFingerprint();
  const r = runner.run({ command: buildLoginCommand(cli), cwd: homedir(), name: "cbc-login" }) as { ok?: boolean; sessionId?: string } | { status: number; error?: string };
  const sid = (r as { sessionId?: string }).sessionId;
  if (!(r as { ok?: boolean }).ok || !sid) {
    return Promise.resolve(Response.json({ error: `登录会话创建失败：${JSON.stringify(r).slice(0, 200)}` }, { status: 500 }));
  }
  loginTui = { sid, startedAt: Date.now(), baseline, url: null, done: false, failed: null, timeout: false, ...(isolate.backupDir ? { backupDir: isolate.backupDir } : {}) };
  // 程序化 /login：TUI 就绪需要数秒；单次链式延时（非轮询）。site 可选自动选站（序号）。
  const site = typeof body?.site === "string" || typeof body?.site === "number" ? String(body.site).trim() : "";
  setTimeout(() => {
    try { runner.input(sid, "/login\r"); } catch { /* 会话已亡 */ }
    if (site) {
      setTimeout(() => { try { runner.input(sid, `${site}\r`); } catch { /* 已亡 */ } }, 2000);
    }
  }, 2500);
  return Promise.resolve(Response.json(loginTuiView(runner, "waiting")));
}

async function loginTuiStatus(): Promise<Response> {
  if (!loginTui) return Response.json({ state: "idle", mode: "tui" });
  const runner = runnerSvc();
  if (!runner) {
    loginTui.failed = "aiti-cmd runner 不可用（被 reload？），登录会话失联，请重新发起";
    return Response.json(loginTuiView(null, "failed"));
  }
  // 抓 URL（sticky）
  const text = loginTuiText(runner);
  if (!loginTui.url) {
    const u = extractCbcLoginUrl(text);
    if (u) loginTui.url = u;
  }
  // 完成判定：落盘指纹变化
  const fp = loginFingerprint();
  const success = fp !== null && fp !== loginTui.baseline;
  const info = runner.getInfo(loginTui.sid) as { status?: string } | null;
  if (success) {
    loginTui.done = true;
    return Response.json(loginTuiView(runner, "success"));
  }
  if (info?.status !== "running") {
    loginTui.failed = loginTui.failed ?? "登录进程已退出（未见授权完成），请重新发起；终端输出见 aiti-cmd 会话";
    return Response.json(loginTuiView(runner, "failed"));
  }
  if (Date.now() - loginTui.startedAt > LOGIN_TUI_TIMEOUT_MS) {
    loginTui.timeout = true;
    try { runner.kill(loginTui.sid); } catch { /* 已亡 */ }
    return Response.json(loginTuiView(runner, "timeout"));
  }
  return Response.json(loginTuiView(runner, "waiting"));
}

/** 凭据/登录状态 API（plan §4.3 路径 A · P0 + §9.3 PTY OAuth）。
 *  API-key 档：GET /login/status · POST /login/key {apiKey?,authToken?,baseUrl?}（空串=清除该字段）· POST /login/clear。
 *  浏览器 OAuth 档（服务端 PTY 驱动）：POST /login/tui {site?} · GET /login/tui/status · POST /login/tui/input {text} · POST /login/tui/cancel。 */
/** 账号额度缓存（默认 60s；force=1 绕过；失败 10s 内不重试，防面板轮询打爆接口）。 */
let quotaCache: { at: number; ttl: number; value: Record<string, unknown> } | null = null;
const QUOTA_TTL_MS = 60_000;
const QUOTA_ERROR_TTL_MS = 10_000;

/** GET /login/quota[?force=1] → 官方 billing 额度（credits）；token 仅服务端内部使用。 */
async function quotaView(force: boolean): Promise<Response> {
  if (!force && quotaCache && Date.now() - quotaCache.at < quotaCache.ttl) return Response.json(quotaCache.value);
  const creds = readCliAuthCredentials();
  if (!creds) {
    const v = { available: false, reason: "no-cli-auth", note: "当前无 CLI OAuth 登录（API Key/第三方网关档不适用官方额度）" };
    quotaCache = { at: Date.now(), ttl: QUOTA_TTL_MS, value: v };
    return Response.json(v);
  }
  try {
    const q = await fetchCbcQuota({
      token: creds.accessToken,
      ...(creds.uin ? { uin: creds.uin } : {}),
      ...(creds.domain ? { domain: creds.domain } : {}),
    });
    const v = { available: true, ...q };
    quotaCache = { at: Date.now(), ttl: QUOTA_TTL_MS, value: v };
    return Response.json(v);
  } catch (e) {
    const v = { available: false, reason: "fetch-failed", error: e instanceof Error ? e.message : String(e), fetchedAt: Date.now() };
    quotaCache = { at: Date.now(), ttl: QUOTA_ERROR_TTL_MS, value: v };
    return Response.json(v);
  }
}

async function loginApi(req: Request, ctx: { path: string[]; method: string; searchParams?: URLSearchParams }, configDir: string): Promise<Response | null> {
  const segs = Array.isArray(ctx.path) ? ctx.path : [];
  if (segs[0] !== "login") return null;
  const sub = segs[1] ?? "";
  const sub2 = segs[2] ?? "";
  const method = String(ctx.method ?? "GET").toUpperCase();

  if (sub === "tui") {
    if (sub2 === "start" && method === "POST") {
      let body: Record<string, unknown> = {};
      try { body = await req.json() as Record<string, unknown>; } catch { /* 空体 */ }
      return startLoginTui(body);
    }
    if (sub2 === "status" && method === "GET") return loginTuiStatus();
    if (sub2 === "input" && method === "POST") {
      let body: { text?: unknown } = {};
      try { body = await req.json() as { text?: unknown }; } catch { /* 空体 */ }
      const text = typeof body.text === "string" ? body.text : "";
      if (!text) return Response.json({ error: "text required" }, { status: 400 });
      const runner = runnerSvc();
      if (!loginTui || !runner?.input) return Response.json({ error: "无进行中的登录会话" }, { status: 409 });
      await runner.input(loginTui.sid, text.endsWith("\r") || text.endsWith("\n") ? text : text + "\r");
      return Response.json({ ok: true });
    }
    if (sub2 === "cancel" && method === "POST") {
      const runner = runnerSvc();
      if (loginTui && runner?.kill) {
        try { runner.kill(loginTui.sid); } catch { /* 已亡 */ }
      }
      loginTui = null;
      return Response.json({ state: "cancelled", mode: "tui" });
    }
    return Response.json({ error: `未知登录端点 /login/tui/${sub2}（${method}）` }, { status: 404 });
  }

  if (sub === "quota" && method === "GET") return quotaView(ctx.searchParams?.get("force") === "1");
  if (sub === "status" && method === "GET") return Response.json(credState(configDir));
  if (sub === "key" && method === "POST") {
    let body: Record<string, unknown> = {};
    try { body = await req.json() as Record<string, unknown>; } catch { /* 空体 */ }
    const patch: CbcCredentials = {};
    for (const key of ["apiKey", "authToken", "baseUrl"] as const) {
      const v = body[key];
      if (typeof v === "string") patch[key] = v.trim();
    }
    if (!Object.keys(patch).length) return Response.json({ error: "body 需含 apiKey/authToken/baseUrl 任一字段" }, { status: 400 });
    writeCred(configDir, patch);
    return Response.json(credState(configDir));
  }
  if (sub === "clear" && method === "POST") {
    writeCred(configDir, { apiKey: "", authToken: "", baseUrl: "" });
    return Response.json(credState(configDir));
  }
  return Response.json({ error: `未知登录端点 /login/${sub}（${method}）` }, { status: 404 });
}

// ============================================================================
// 会话 recycle API（zcode 同款）：存量 handle 升级到当前扩展代码，无需重启 pi-web。
//   GET  /session/recycle               → 存量 codebuddy 会话清单
//   POST /session/recycle {id, force?}  → dispose 旧 handle → loopback 重建（当前代码）
// ============================================================================

type RecycleHandleLike = { id: string; isRunning(): boolean; alive(): boolean; dispose(): unknown; cwd?: string };

function recycleSelfBase(req: Request): string {
  try {
    const u = new URL(req.url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
      return u.origin;
    }
  } catch { /* fallthrough */ }
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return `http://127.0.0.1:${Number.isFinite(port) ? port : 3000}`;
}

async function recycleApi(req: Request, ctx: { path: string[]; method: string }): Promise<Response | null> {
  if (ctx.path[0] !== "session" || ctx.path[1] !== "recycle") return null;
  const store = (globalThis as { __sessionHandles?: Map<string, RecycleHandleLike> }).__sessionHandles;
  if (ctx.method === "GET") {
    const sessions = [...(store?.values() ?? [])]
      .filter((h) => h.id.startsWith("codebuddy:"))
      .map((h) => ({ id: h.id, running: h.isRunning(), alive: h.alive() }));
    return Response.json({ sessions });
  }
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  let body: { id?: unknown; force?: unknown } = {};
  try { body = await req.json() as typeof body; } catch { /* 空体按缺省 */ }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id.startsWith("codebuddy:")) return Response.json({ error: "id 必须是 codebuddy: 复合 id" }, { status: 400 });
  const old = store?.get(id);
  if (!old) return Response.json({ error: `无存活的 handle：${id}` }, { status: 404 });
  if (old.isRunning() && !body.force) {
    return Response.json(
      { error: "会话正在运行中——等本轮收口后重试；确认要打断请带 force:true", running: true },
      { status: 409 },
    );
  }
  const realSid = id.startsWith("codebuddy:") && SID_RE.test(id.slice("codebuddy:".length)) ? id.slice("codebuddy:".length) : "";
  const cwd = typeof (old as { cwd?: string }).cwd === "string" ? (old as { cwd?: string }).cwd : "";
  try { await old.dispose(); } catch { /* 已死容错 */ }
  if (!realSid) {
    return Response.json({ recycled: true, recreated: false, id, note: "占位会话已释放（未发过消息的空会话），前端下次访问按需重建" });
  }
  const base = recycleSelfBase(req);
  try {
    const res = await fetch(`${base}/api/session-backends`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerType: "aiti-codebuddy-agent/codebuddy", sessionId: realSid, ...(cwd ? { cwd } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return Response.json({
        recycled: true, recreated: false, id,
        error: `重建请求 HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
        note: "旧 handle 已释放——前端刷新该会话即走复活路径用当前代码重建",
      });
    }
    return Response.json({ recycled: true, recreated: true, id, session: data });
  } catch (e) {
    return Response.json({
      recycled: true, recreated: false, id,
      error: `重建请求失败: ${e instanceof Error ? e.message : String(e)}`,
      note: "旧 handle 已释放——前端刷新该会话即走复活路径用当前代码重建",
    });
  }
}

export default {
  id: "aiti-codebuddy-agent",
  name: "CodeBuddy Code (腾讯)",
  version: "0.1.0",
  icon: "🔵",

  features: [
    spawnEnvFeature("CodeBuddy Code"),
    spawnCommandFeature("CodeBuddy Code"),
    spawnArgsPrefixFeature("CodeBuddy Code"),
    {
      id: "codebuddy.cliPath",
      type: "string" as const,
      label: "CLI 路径",
      group: "CodeBuddy Code",
      description: "指定 cbc 可执行文件（npm i -g @tencent-ai/codebuddy-code 或 brew install codebuddy-code 后的绝对路径）。留空自动探测 PATH 上的 cbc/codebuddy → npx 兜底（首用有下载延迟）。",
      placeholder: "/home/me/.nvm/versions/node/v22/bin/cbc",
    },
    {
      id: "codebuddy.packageSpec",
      type: "string" as const,
      label: "npx 包 spec",
      group: "CodeBuddy Code",
      description: "npx 兜底通道拉的包（默认 @tencent-ai/codebuddy-code 最新缓存；可钉版本如 @tencent-ai/codebuddy-code@2.148.0）。仅 cliPath 未配置时生效。",
      value: "",
      placeholder: "@tencent-ai/codebuddy-code",
    },
    {
      id: "codebuddy.model",
      type: "string" as const,
      label: "默认模型",
      group: "CodeBuddy Code",
      description: "新会话默认模型 id（--model）：default-model/fast-model/balanced-model/primary-model/deep-model/glm-5.3/glm-5.2/kimi-k3/kimi-k2.6/minimax-m3/gemini-3.5-flash/gpt-5.x…。留空用账号默认档。",
      value: "",
      placeholder: "default-model",
    },
    {
      id: "codebuddy.permissionMode",
      type: "string" as const,
      label: "权限模式",
      group: "CodeBuddy Code",
      description: "--permission-mode：default/acceptEdits/bypassPermissions/plan/dontAsk/auto。默认 bypassPermissions（headless 无审批面，未放行=任务失败）。stream 模式支持运行中 control_request 切换，exec 模式下轮 spawn 生效。",
      value: "bypassPermissions",
      placeholder: "bypassPermissions",
    },
    {
      id: "codebuddy.connectionMode",
      type: "string" as const,
      label: "连接模式",
      group: "CodeBuddy Code",
      description: "stream（默认，长连接：单进程多轮、cwd 进程内固定、免每轮冷启动、运行中可切模型/权限）| exec（兼容档：每轮单发 + --resume，进程隔离）。改后对已有会话需 /session/recycle 或重新打开生效。",
      value: "stream",
      placeholder: "stream | exec",
    },
    {
      id: "codebuddy.apiKey",
      type: "string" as const,
      label: "API Key（凭据）",
      group: "CodeBuddy Code",
      description: "CODEBUDDY_API_KEY：腾讯 CodeBuddy 平台个人 API key（覆盖凭据文件）。第三方 OpenAI 兼容网关请同时配 baseUrl。改后即刻生效（下轮 spawn 注入）。",
      value: "",
      placeholder: "留空使用凭据文件（🔑 /login/key）",
    },
    {
      id: "codebuddy.authToken",
      type: "string" as const,
      label: "Auth Token（凭据）",
      group: "CodeBuddy Code",
      description: "CODEBUDDY_AUTH_TOKEN：已有 OAuth token（CLI 侧优先级高于 API key）。一般留空。",
      value: "",
      placeholder: "",
    },
    {
      id: "codebuddy.baseUrl",
      type: "string" as const,
      label: "Base URL（第三方模型网关）",
      group: "CodeBuddy Code",
      description: "CODEBUDDY_BASE_URL：指向 OpenAI 兼容端点（绕过腾讯积分生态，iam.md 官方支持）。留空走腾讯官方。",
      value: "",
      placeholder: "https://your-gateway.example.com/v1",
    },
    {
      id: "codebuddy.bridgeUrl",
      type: "string" as const,
      label: "AITI 桥 URL（MCP 工具注入）",
      group: "CodeBuddy Code",
      description: "AITI_BRIDGE_URL：cbc 会话内启用 aiti_* 工具直连浏览器桥（需先 aiti-mcp-register --targets codebuddy 注册 shim）。留空则透传服务进程 env（有则生效），两者皆无=不含桥工具。",
      value: "",
      placeholder: "http://127.0.0.1:8777",
    },
  ],

  server: {
    startup(ctx: {
      configDir?: string;
      features?: { get(extIdOrFid?: string, fid?: string): boolean | string | undefined };
      services?: { get(key: string): unknown; provide<T>(key: string, impl: T): () => void };
      sessionProviders: {
        register(provider: {
          type: string;
          label: string;
          agentKey?: string;
          priority?: number;
          maxCapabilities: SessionCapabilitiesLike;
          listModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          refreshModels?: () => Promise<Array<{ id: string; provider: string; label?: string }>>;
          createSession(options: {
            sessionId?: string;
            cwd?: string;
            model?: { provider: string; id: string };
          }): Promise<CodebuddyHandleBase>;
        }): string;
      };
    }) {
      hostFeatures = (ctx as any)?.features ?? null;
      captureSpawnEnvFeatures((ctx as any)?.features ?? null); // D1：spawn.env feature 捕获（否则 spawnEnvList 恒空）
      hostSvc = (ctx as any)?.services ?? null;
      // 数据分层 breaking（2026-09-11）：ctx.dataDir 已移除（访问即抛）——凭据/配置一律 configDir。
      const configDir = (ctx as { configDir?: string }).configDir ?? extDataDir();
      // 队列崩溃恢复 sidecar 根（<stateDir>/queues/<sessionId>.json；docs/aiti-remote-queue-and-sidecar-plan.md §3）
      setCodebuddyQueueStateDir((ctx as { stateDir?: string }).stateDir ?? join(configDir, "state"));
      try { mkdirSync(join((ctx as { stateDir?: string }).stateDir ?? join(configDir, "state"), "queues"), { recursive: true }); } catch { /* exists */ }
      startupDataDir = configDir;
      startupStateDir = (ctx as { stateDir?: string }).stateDir ?? join(configDir, "..", "state");
      try { mkdirSync(configDir, { recursive: true }); } catch { /* exists */ }

      // 动态模型目录（D13）：cache 层持久化优先 → 启动后台真实探测（不阻塞 startup）
      const cacheDir = (ctx as { cacheDir?: string }).cacheDir || join(dirname(configDir), "cache");
      const cached = loadCachedCbcModels(cacheDir);
      if (cached) setCachedCbcModels(cached);
      void (async () => {
        try {
          const cli = resolveCli({ featurePath: featureCliPath(), pkgSpec: featurePkgSpec() });
          const models = await refreshCbcModelCatalog(cacheDir, cli);
          if (models) console.log(`[aiti-codebuddy-agent] 模型目录已刷新（${models.length} 档，cbc --help）`);
        } catch (e) {
          console.warn("[aiti-codebuddy-agent] 模型目录探测失败（沿用兜底清单）:", e instanceof Error ? e.message : e);
        }
      })();

      // handle 运行环境（feature/env → 注入 handle，handle 不直读 feature）
      const runtime: CodebuddyRuntime = {
        resolveCli: () => resolveCli({ featurePath: featureCliPath(), pkgSpec: featurePkgSpec() }),
        effectiveCred: () => effectiveCred(configDir),
        bridgeUrl: () => featureString("codebuddy.bridgeUrl"),
        defaultModel: () => featureModel(),
        permissionMode: () => featurePermissionMode(),
      };

      // createSession 主体（provider 与 P2 launch 服务共用：复活/种子模型/状态文件全链路一致）
      const createCbcSession = async (
        options: { sessionId?: string; cwd?: string; model?: { provider: string; id: string } },
        launchOverride?: LaunchOverride,
      ) => {
        const rawSid = options.sessionId ?? "";
        const isRealSid = SID_RE.test(rawSid);

        // ★ 复活路径先读 cbc 会话存储（session-manager 唯一读取实现）：cwd 必须以
        //   会话原 cwd 为准（resume/load 的项目一致性依赖此值）；URL ?session= 恢复路径的
        //   options.cwd 常为空 → 不能落 process.cwd()。
        let restoredParsed: { meta?: { cwd?: string; model?: string }; messages?: unknown[] } | null = null;
        const parseSessionSvc = (): Promise<{ meta?: { cwd?: string; model?: string }; messages?: unknown[] } | null> => {
          const reg = (globalThis as any).__piWebExt;
          const svc = hostSvc?.get?.("session-manager.sessions") ?? reg?.byId?.("session-manager")?.ext?.services?.sessions;
          return typeof svc?.parseSession === "function" ? svc.parseSession(`codebuddy:${rawSid}`) : Promise.resolve(null);
        };
        if (isRealSid) {
          try {
            restoredParsed = await parseSessionSvc();
          } catch { /* 回放失败不阻断接管（fail-silent） */ }
        }
        const restoredCwd = typeof restoredParsed?.meta?.cwd === "string" && restoredParsed.meta.cwd.trim() ? restoredParsed.meta.cwd : "";

        // 种子模型：显式指定 > 会话回放 > 状态文件恢复（用户上次在 pi-web 切过）> feature 默认 > 账号默认
        let seedModel: { id: string; provider: string } | undefined;
        if (typeof options.model?.id === "string" && options.model.id) {
          seedModel = { id: options.model.id, provider: "codebuddy" };
        } else if (typeof restoredParsed?.meta?.model === "string" && restoredParsed.meta.model) {
          seedModel = { id: restoredParsed.meta.model, provider: "codebuddy" };
        }
        if (!seedModel && options.sessionId) {
          const restored = await readExtModelState("codebuddy", `codebuddy:${options.sessionId}`);
          if (restored?.selected?.id) seedModel = { id: restored.selected.id, provider: "codebuddy" };
        }
        // 新会话（无显式/回放/同会话状态）→ 该 agent 上次使用的模型（per-agent last used）
        // ⚠ 仅新会话：resume 会话模型以会话存储为准，不用 agent 级默认覆盖
        if (!seedModel && !options.sessionId) {
          const lastUsed = await readAgentLastUsedModel("codebuddy");
          if (lastUsed?.id) seedModel = { id: lastUsed.id, provider: "codebuddy" };
        }
        if (!seedModel) seedModel = { id: featureModel() || DEFAULT_MODEL, provider: "codebuddy" };

        // stream（默认长连接）/ exec（兼容档）由 feature 决定；cwd 取会话原 cwd 优先
        const handle = await createCodebuddyHandle(featureConnectionMode(), {
          sessionId: isRealSid ? rawSid : undefined,
          cwd: restoredCwd || options.cwd || process.cwd(),
          model: seedModel,
          runtime,
        });
        if (isRealSid && restoredParsed?.messages?.length) handle.seedHistory(restoredParsed.messages as never[]);
        handle.launchOverride = launchOverride;
        return handle;
      };
      const lastKey = ctx.sessionProviders.register({
        type: "codebuddy",
        label: "CodeBuddy Code (腾讯)",
        agentKey: "codebuddy",
        priority: 10, // 原生 CLI 驱动优先于通用 ACP 驱动（aiti-acp-agent 的 codebuddy 后端 priority 0）
        maxCapabilities: CBC_CAPABILITIES,
        // 静态目录（新建页选后端时供选择器；无会话即可取）——上次使用的模型置顶
        listModels: async () => withLastUsedFirst(await codebuddyCatalog(), (await readAgentLastUsedModel("codebuddy"))?.id),
        // 手动刷新（新建页「刷新模型列表」）：重新解析 cbc --help 并更新缓存
        refreshModels: async () => {
          const cli = resolveCli({ featurePath: featureCliPath(), pkgSpec: featurePkgSpec() });
          await refreshCbcModelCatalog(cacheDir, cli);
          return codebuddyCatalog();
        },
        createSession: (options) => createCbcSession(options),
      });
      // agent 描述符：agent 管理面（aiti-agent-manager）动态发现用——manager 不写死各家，
      // 各家自报 label/modes/探测表/账号档凭据槽位/登录动作（本家路径知识留在本家）。
      ctx.services?.provide?.("aiti-codebuddy-agent.agent", {
        agent: "codebuddy",
        label: "CodeBuddy Code (腾讯)",
        modes: ["apikey", "tui"],
        extReportsAuthState: true,
        accountQuota: true, // 支持官方额度（credits）查询：agent-manager 聚合 /login/quota
        dependencyHint: "npx -y @tencent-ai/codebuddy-code（或 npm i -g）",
        auth: [
          { kind: "file", path: [".codebuddy", "settings.json"], label: "~/.codebuddy/settings.json" },
          { kind: "dir", path: [".codebuddy", "local_storage"], label: "~/.codebuddy/local_storage/" },
        ],
        accountSlots: (c: { home: string; env: Record<string, string | undefined>; platform: string }) => {
          const out: Array<{ key: string; label: string; path: string }> = [];
          // CLI 浏览器 OAuth 落盘：XDG_DATA_HOME（Linux）/ LOCALAPPDATA|APPDATA（Windows）目录内 *.info 全扫
          for (const root of codebuddyDataRoots(c.env as NodeJS.ProcessEnv)) {
            const dir = join(root, ...CBC_CLI_AUTH_REL);
            try {
              for (const f of (readdirSync(dir) as string[]).filter((x) => x.endsWith(".info")).sort()) {
                out.push({ key: `cli-auth/${f}`, label: `CLI OAuth · ${f}`, path: join(dir, f) });
              }
            } catch { /* 目录不存在 */ }
          }
          out.push({ key: "managed-credentials", label: "托管凭据（API Key）", path: credPath(configDir) });
          return out;
        },
        actions: {
          "tui-start": { m: "POST", sub: ["tui", "start"], body: true },
          "tui-status": { m: "GET", sub: ["tui", "status"] },
          "tui-input": { m: "POST", sub: ["tui", "input"], body: true },
          "tui-cancel": { m: "POST", sub: ["tui", "cancel"] },
          "set-key": { m: "POST", sub: ["key"], body: true },
          "clear": { m: "POST", sub: ["clear"] },
        },
      });
      // P2 协议委托：launch 服务（provider 同链路：复活/种子模型/状态文件）
      ctx.services?.provide?.("aiti-codebuddy-agent.launch", {
        agentKey: "codebuddy",
        capabilities: CBC_CAPABILITIES,
        listModels: async () => withLastUsedFirst(await codebuddyCatalog(), (await readAgentLastUsedModel("codebuddy"))?.id),
        createSessionFromLaunch: (launch: LaunchOverride, options: { sessionId?: string; cwd?: string; model?: { provider: string; id: string } }) =>
          createCbcSession(options, launch),
      });
      console.log(`[aiti-codebuddy-agent] registered: ${lastKey} (configDir: ${configDir})`);
    },

    /** 凭据 API（/login/*）+ 会话 recycle（/session/recycle）。 */
    async api(req: Request, ctx: { path: string[]; method: string; searchParams: URLSearchParams }) {
      const recycled = await recycleApi(req, ctx);
      if (recycled) return recycled;
      return loginApi(req, ctx, startupDataDir ?? extDataDir());
    },
  },
};
