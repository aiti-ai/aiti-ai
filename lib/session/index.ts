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
export { HandleSessionAdapter, type WrappedSessionLike } from "./handle-adapter.ts";

import { getProvider, findProvidersForAgent, listProviders, DEFAULT_PROVIDER_TYPE } from "./providers.ts";
import type { CreateSessionOptions } from "./providers.ts";
import { BridgeOccupiedError } from "./types.ts";
import type { SessionCapabilities, SessionHandle } from "./types.ts";
import { getHandle as lookupHandle, putHandle, putHandleAt, listAllHandles } from "./handle-store.ts";
import { HandleSessionAdapter, type WrappedSessionLike } from "./handle-adapter.ts";
import { findBridgeSessionFileById } from "@/lib/session-reader";

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
  }
  return handle;
}

/** The registry key a handle was first stored under (identity compare). */
function handleKeyOf(handle: SessionHandle): string {
  for (const [key, h] of [...listAllHandles()]) {
    if (h === handle) return key;
  }
  return handle.id;
}
