/**
 * Session abstraction — public surface.
 *
 * Layer map:
 *   types.ts        — SessionHandle, SessionCapabilities, errors (Layer 2)
 *   providers.ts    — provider registry incl. extension slot (Layer 1)
 *   handle-store.ts — live store for provider-created handles
 *   local.ts        — host-native adapter over rpc-manager (the ONLY built-in)
 *
 * Architecture rule (user directive): pi-web core ships NO concrete agent
 * backends beyond the host-native local world. Every real backend — attach
 * (socket to a running agent), spawn (`pi --mode rpc` child), claude-code
 * resume, cc-connect hub, ... — is a pi-web extension registering through
 * ctx.sessionProviders at startup. First-party backends live in
 * pi-web-ext/ (e.g. session-attach, agent-echo); third parties follow the
 * same slot.
 *
 * Usage:
 *   import { createSessionHandle, listProviderInfos, openExternalSession } from "@/lib/session";
 */

// Layer 2 — contracts
export type {
  SessionHandle,
  SessionCapabilities,
  HandleEvent,
  HandleEventListener,
  HandleModel,
  HandleImage,
  HandleBashResult,
  HandleCommandInfo,
  PromptOptions,
} from "./types.ts";
export {
  FULL_CAPABILITIES,
  capabilities,
  guard,
  UnsupportedCapabilityError,
  SessionDeadError,
  BridgeOccupiedError,
} from "./types.ts";

// Layer 1 — registry (incl. extension slot lifecycle)
export type { SessionProvider, CreateSessionOptions } from "./providers.ts";
export {
  registerProvider,
  registerExtensionProvider,
  unregisterExtensionProviders,
  cleanupAllExtensionProviders,
  getProvider,
  findProvidersForAgent,
  listProviders,
  shutdownAllProviders,
  DEFAULT_PROVIDER_TYPE,
} from "./providers.ts";

// Live handle store (provider-created sessions)
export { putHandle, putHandleAt, getHandle, removeHandle, listHandleIds, listAllHandles, getHandleSessionInfos, getRunningHandleIds } from "./handle-store.ts";

// Relay (agent-to-agent)
export { relayToSession, type RelayResult } from "./relay.ts";

// TUI bridge registry (session file → socket 占用识别)

// Host-native adapter (wraps AgentSessionWrapper from rpc-manager)
export { createLocalHandle } from "./local.ts";

// Wrapper-compatible adapter (lets existing /api/agent/* routes drive handles)
export { HandleSessionAdapter, handleModelToClient, type WrappedSessionLike } from "./handle-adapter.ts";

import { getProvider, findProvidersForAgent, listProviders, DEFAULT_PROVIDER_TYPE } from "./providers.ts";
import type { CreateSessionOptions } from "./providers.ts";
import { BridgeOccupiedError } from "./types.ts";
import type { SessionCapabilities, SessionHandle } from "./types.ts";
import { getHandle as lookupHandle, putHandle, putHandleAt, listAllHandles } from "./handle-store.ts";
import { HandleSessionAdapter, type WrappedSessionLike } from "./handle-adapter.ts";
import { findBridgeSessionFileById, invalidateSessionListCache, readSessionHeader, resolveSessionPath } from "../session-reader.ts"; // 相对路径+显式扩展名：jiti 不解析 @/ 别名，ESM 要求扩展名
import { ensurePlaceholder, rebindPlaceholder, getPlaceholder } from "./placeholder.ts";

function listProviderNames(): string[] {
  return listProviders().map((p) => p.type);
}

/** Provider info for UI pickers / discovery endpoints. */
export type ProviderInfo = {
  type: string;
  label: string;
  /** External agent key this backend can drive (all-sessions join key), if any. */
  agentKey?: string;
  maxCapabilities: SessionCapabilities;
};

export function listProviderInfos(): ProviderInfo[] {
  return listProviders().map((p) => ({
    type: p.type,
    label: p.label,
    ...(p.agentKey ? { agentKey: p.agentKey } : {}),
    maxCapabilities: p.maxCapabilities,
  }));
}

/**
 * Split an all-sessions composite id ("claude:<uuid>") into its parts.
 * Plain ids are host-native pi sessions (agent "pi"). Same convention as
 * session-manager's lib/agents/types.ts splitExtId — keep both in sync.
 */
export function splitHandleId(id: string): { agent: string; sid: string } {
  const i = id.indexOf(":");
  if (i <= 0) return { agent: "pi", sid: id };
  return { agent: id.slice(0, i), sid: id.slice(i + 1) };
}

/**
 * Open a LIVE session for an all-sessions historical row (attach-from-history).
 *
 * Given a composite id like "claude:<sid>", resolves providers whose agentKey
 * matches the agent and creates a driving handle for the native session.
 * Browse old external sessions in All Sessions → open one → keep working in it
 * through pi-web. Returns undefined when no provider can drive that agent
 * (UI falls back to read-only viewer / import-to-pi flow).
 */
export async function openExternalSession(
  compositeId: string,
  options: Omit<CreateSessionOptions, "sessionFile"> & { sessionId?: string } = {},
): Promise<SessionHandle | undefined> {
  const { agent, sid } = splitHandleId(compositeId);
  const candidates = findProvidersForAgent(agent);
  if (candidates.length === 0) return undefined;
  let lastError: unknown;
  for (const provider of candidates) {
    try {
      const handle = await provider.createSession({
        ...options,
        sessionId: options.sessionId ?? sid,
      });
      putHandle(handle);
      // 接管/恢复路径同样落站位（resume 语义，extId 已知）：⚡接管历史行、
      // ?session= 恢复、复合 id GET 都汇合在这里。
      if (provider.agentKey) wireExternalPlaceholder(handle, true, options.cwd);
      return handle;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error(`No provider could open ${compositeId}`);
}

/** attach provider 的注册键（aiti-attach-agent 启动时注册；未装扩展时 undefined）。 */
function findAttachProviderType(): string | undefined {
  return listProviders().find((p) => p.type === "aiti-attach-agent/attach")?.type;
}

/**
 * 桥认领成功后，关闭同会话的意外本地 wrapper（单写者恢复）。
 *
 * 背景（2026-08-30 实测复现）：TUI 桥登记晚于 web 首开时（pi -c 起动数秒内点开
 * 会话、或浏览器 SSE 断线重连落在 TUI 重启空档），SSE/prompt 路由会在注册表
 * miss 窗口内 startRpcSession 抢先起一个本地 runtime。桥随后登记完成 →
 * split-brain：POST 走桥（attach 优先）、GET/SSE 仍偏向本地双胞胎——用户表现为
 * 「第一次连不上，切走再切回来才通」。attach 成功即关掉双胞胎，下一轮询自愈。
 */
async function shutdownStrayLocalRuntime(sessionId: string, sessionFile: string): Promise<void> {
  try {
    const { getRpcSession } = await import("../rpc-manager");
    for (const key of new Set([sessionId, sessionFile])) {
      const twin = getRpcSession(key);
      if (twin?.isAlive()) {
        console.warn(`[session] bridge claimed "${sessionFile}" — shutting down stray local runtime (race-window twin)`);
        await twin.shutdown().catch(() => {});
      }
    }
  } catch { /* rpc-manager 不可用（极端裁剪环境）——跳过善后 */ }
}

/**
 * 会话文件被运行中的 TUI 桥占用时，懒创建 attach handle 并入库（键 = 文件路径）。
 * 占用判定经 provider.ownsFile 协商——注册表格式归扩展所有，核心不感知。
 *
 * 语义（单写者红线）：
 *   - 无认领        → undefined（调用方走本地路径）
 *   - 认领且附着成功 → adapter
 *   - 认领但附着失败 → BridgeOccupiedError（拒绝本地打开，绝不静默分叉）
 */
export async function attachIfBridged(
  sessionFile: string,
): Promise<WrappedSessionLike | undefined> {
  // 已附着的 handle 直接复用——否则每请求新建连接会 dispose 掉
  // 正在被 SSE 监听的旧 handle（putHandle 的覆盖语义）
  const existingHandle = lookupHandle(sessionFile);
  if (existingHandle?.alive()) return new HandleSessionAdapter(existingHandle);

  const candidates = listProviders().filter((p) => p.ownsFile);
  for (const provider of candidates) {
    let claimed = false;
    try {
      claimed = await provider.ownsFile!(sessionFile);
    } catch (e) {
      console.error(`[session] ${provider.type}.ownsFile failed:`, e instanceof Error ? e.message : e);
      continue;
    }
    if (!claimed) continue;
    try {
      // attach handle 的 id 必须是对外会话 uuid（而非文件路径）——/api/agent/[id]
      // 的 resolveAnySession(id) 按 id 查 handle-store，id 错位则 GET/SSE 全 404、
      // 前端聊天窗拉不到 live 状态。双 key 注册：uuid（权威）+ 文件路径（兼容
      // 既有 lookupHandle(sessionFile) 复用语义）。
      const sessionUuid = (sessionFile.match(/_([0-9a-f-]{36})\.jsonl$/) ?? [null, sessionFile])[1];
      const handle = await provider.createSession({
        sessionFile,
        sessionId: sessionUuid,
      });
      putHandle(handle);
      if (sessionUuid !== sessionFile) putHandleAt(sessionFile, handle);
      // 单写者善后：桥认领成功 → 竞态窗口起的本地双胞胎必须退场（后台执行不阻塞返回）
      void shutdownStrayLocalRuntime(sessionUuid, sessionFile);
      return new HandleSessionAdapter(handle);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 幽灵认领防御：ownsFile 声称占用，但 createSession 自解析不到桥 socket——
      // 认领与注册表事实已脱节（陈旧模块图/陈旧状态），按无占用处理（本地打开安全：
      // 真实占用场景下 readBridgeRegistry 的 pid+socket 双重存活检查会先行剔除死条目）。
      if (/no bridge socket/i.test(msg)) {
        console.warn(`[session] ${provider.type} claimed "${sessionFile}" but resolves no bridge socket — treating claim as stale`);
        continue;
      }
      throw new BridgeOccupiedError(sessionFile, msg);
    }
  }
  return undefined;
}

/**
 * 会话文件被运行中的 TUI 桥占用时，懒创建 attach handle 并入库（键 = 文件路径）。
 * 单写者规则：TUI 持有 session 时 pi-web 绝不本地打开该文件。
 * 返回 adapter 或 undefined（无桥/socket 不可达时由调用方走本地路径）。
 */

/**
 * Resolve a live session by id across BOTH registries: local sessions
 * (rpc-manager) win first, then provider handles wrapped in the
 * wrapper-compatible adapter. Returns undefined when neither has it.
 *
 * /api/agent/[id] and /events use this so the existing chat flow drives any
 * backend without frontend changes.
 */
export function resolveAnySession(id: string): WrappedSessionLike | undefined {
  // Local registry is consulted by callers first (they import getRpcSession);
  // this helper is the handle-side fallback.
  const handle = lookupHandle(id);
  if (!handle) return undefined;
  return new HandleSessionAdapter(handle);
}

/**
 * 按 id 解析 attach（socket 优先）：handle-store miss 时读 bridge registry 反查
 * registry key（= sessionFile，不依赖文件落盘）再 attach。空会话/未索引会话的
 * /api/agent/[id]（GET/SSE）据此拿到 live 附着，文件仅历史回放。
 */
export async function resolveAttachBySessionId(id: string): Promise<WrappedSessionLike | undefined> {
  const bridgeFile = await findBridgeSessionFileById(id);
  if (!bridgeFile) return undefined;
  try {
    const bridged = await attachIfBridged(bridgeFile);
    return bridged?.isAlive() ? bridged : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a session handle through the registry and store it for later lookup.
 * Falls back to the default provider when `providerType` is omitted.
 * Non-default handles are stored in the global handle store; default ("local")
 * sessions stay in rpc-manager's registry.
 */
export async function createSessionHandle(
  options: CreateSessionOptions & { providerType?: string },
): Promise<SessionHandle> {
  const type = options.providerType ?? DEFAULT_PROVIDER_TYPE;
  const provider = getProvider(type);
  if (!provider) {
    throw new Error(
      `Unknown session provider "${type}". Known providers: ${listProviderNames().join(", ")}` +
        (listProviders().length === 0 ? " (none registered — backend extensions not loaded?)" : ""),
    );
  }
  const handle = await provider.createSession(options);
  if (type !== DEFAULT_PROVIDER_TYPE) {
    putHandle(handle);
    // 后端可能在首条消息后才得知真实原生 id（如 claude CLI 懒初始化）——
    // 监听 session_backend_ready 把 handle 额外注册到真实复合 id 下；
    // 原键保留，已发出的引用继续有效。
    handle.subscribe((event) => {
      if (event.type === "session_backend_ready" && typeof event.id === "string" && event.id !== handleKeyOf(handle)) {
        putHandleAt(event.id, handle);
      }
    });
    // 外部 agent 后端（agentKey = 能驱动的外部 agent）：落 pi 站位文件（持久锚点）。
    // attach/spawn 管的是本地 pi 会话，文件已存在，不落。
    if (provider.agentKey) wireExternalPlaceholder(handle, !!options.sessionId, options.cwd);
  }
  return handle;
}

/**
 * 外部 handle 的站位文件接线（lib/session/placeholder.ts）。
 *   - resume（extId 已知且非 new- 占位）：创建即写；
 *   - fresh（new- 占位键）：等 session_backend_ready 真实 id 换绑才写——
 *     未发过首条消息的空会话不留孤儿站位；
 *   - 换绑时站位键随迁移（rebindPlaceholder），与 putHandleAt 双注册同步。
 */
function wireExternalPlaceholder(handle: SessionHandle, resume: boolean, cwd?: string): void {
  const colon = handle.id.indexOf(":");
  if (colon <= 0) return; // 非复合 id 不落站位
  const agent = handle.id.slice(0, colon);
  const provisional = handle.id.includes(":new-");
  const writeNow = () => {
    // cwd 优先级：显式传入 > handle.cwd（provider createSession 时已解析会话原工作区，
    // cursor/claude resume 都会回填）> 模块内回落目录
    const p = ensurePlaceholder({ extId: handle.id, agent, ...(cwd || handle.cwd ? { cwd: cwd || handle.cwd } : {}) });
    if (p) invalidateSessionListCache(); // 让下一轮 /api/sessions 立即看到站位行
  };
  if (resume && !provisional) writeNow();
  handle.subscribe((event) => {
    if (event.type !== "session_backend_ready" || typeof event.id !== "string") return;
    const prevEvent = event as unknown as { oldId?: unknown };
    const prevId = typeof prevEvent.oldId === "string" ? prevEvent.oldId : undefined;
    if (prevId && getPlaceholder(prevId)) rebindPlaceholder(prevId, event.id);
    else if (!getPlaceholder(event.id)) writeNow();
    invalidateSessionListCache();
  });
}

/**
 * 站位会话解析：uuid → 站位文件 header.extId → 真实 agent 后端。
 * 非站位 uuid 返回 undefined（调用方走本地路径，只多一次 header 读）。
 * 打开的 handle 双注册到站位 uuid 下——后续 POST /events 的同步查表直接命中。
 */
export async function resolvePlaceholderSession(id: string): Promise<WrappedSessionLike | undefined> {
  const fp = await resolveSessionPath(id).catch(() => null);
  if (!fp) return undefined;
  const header = readSessionHeader(fp) as unknown as { extId?: string } | null;
  if (!header?.extId || !header.extId.includes(":")) return undefined;
  const existing = resolveAnySession(id);
  if (existing?.isAlive()) return existing;
  const sid = header.extId.slice(header.extId.indexOf(":") + 1);
  const handle = await openExternalSession(header.extId, { ...(sid ? { sessionId: sid } : {}) }).catch(() => undefined);
  if (!handle?.alive()) return undefined;
  putHandleAt(id, handle);
  return resolveAnySession(id);
}

/** The registry key a handle was first stored under (identity compare). */
function handleKeyOf(handle: SessionHandle): string {
  for (const [key, h] of [...listAllHandles()]) {
    if (h === handle) return key;
  }
  return handle.id;
}
