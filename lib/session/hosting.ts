/**
 * Session hosting API wiring (default dependencies for hosting-core.ts).
 *
 * Keep this file thin: all rules live in hosting-core.ts and are unit tested
 * there. This module only connects the host's real modules and serializes
 * switch requests per session (two clicks must never spawn two agents).
 */
import { resolveSessionPath, readSessionHeader, findBridgeSessionFileById } from "../session-reader.ts";
import { getRpcSession, startRpcSession, stopIdleRpcSession } from "../rpc-manager.ts";
import { getHandle, listAllHandles, putHandleAt, removeHandle } from "./handle-store.ts";
import { createSessionHandle, detachSupport, findAliveHandleById, openExternalSession } from "./index.ts";
import { getBridgeRunningIds } from "./bridge-running.ts";
import { findProvidersForAgent, getProvider, listProviders } from "./providers.ts";
import {
  clearDetachedPreference,
  getDetachedPreference,
  getWrapperStarter,
  setDetachedPreference,
} from "../agent-starter/index.ts";
import { getRegistry } from "../ext/registry.ts";
import { hostingSwitchFlight, trackHostingSwitch } from "./hosting-lock.ts";
import { rememberSessionHistory } from "./history-cache.ts";
import {
  describeHostingWith,
  switchHostingWith,
  HostingError,
  type HostingDeps,
  type HostingInfo,
  type HostingMode,
  type LocalizedText,
  type SwitchResult,
} from "./hosting-core.ts";

export {
  describeHostingWith,
  switchHostingWith,
  HostingError,
};
export type {
  HostingDeps,
  HostingInfo,
  HostingMode,
  HostingModeOption,
  HostingModeState,
  LocalizedText,
  SwitchResult,
} from "./hosting-core.ts";

type AgentDescriptorLike = {
  agent?: unknown;
  label?: LocalizedText;
  dependencyHint?: LocalizedText;
  description?: LocalizedText;
};

/** Discover the `<extId>.agent` descriptor a backend provided (same source as the agent manager). */
function agentDescriptorOf(agent: string): AgentDescriptorLike | undefined {
  let status: Record<string, unknown>;
  try {
    status = getRegistry().status() as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const [extId, entry] of Object.entries(status)) {
    if ((entry as { enabled?: boolean } | undefined)?.enabled === false) continue;
    try {
      const descriptor = getRegistry().services.get<AgentDescriptorLike>(`${extId}.agent`);
      if (descriptor && descriptor.agent === agent) return descriptor;
    } catch {
      /* service gone during a reload */
    }
  }
  return undefined;
}

const defaultDeps: HostingDeps = {
  resolveSessionPath,
  readSessionHeader,
  findBridgeSessionFileById,
  getRpcSession,
  getHandle: findAliveHandleById,
  getWrapperStarter,
  getBridgeRunningIds,
  getDetachedPreference,
  setDetachedPreference,
  clearDetachedPreference,
  detachSupport,
  findProvidersForAgent,
  getProvider,
  startRpcSession: async (id, sessionFile, cwd, options) =>
    startRpcSession(id, sessionFile, cwd, (options ?? {}) as Parameters<typeof startRpcSession>[3]),
  createSessionHandle: async (options) =>
    createSessionHandle(options as Parameters<typeof createSessionHandle>[0]),
  stopIdleRpcSession,
  removeHandle,
  aliasHandle: (id, handle) => {
    if (id && handle) putHandleAt(id, handle as Parameters<typeof putHandleAt>[1]);
  },
  listHandles: () => [...listAllHandles()],
  killWrapperFor: async (sessionId) => {
    const wrapper = await getWrapperStarter().catch(() => undefined);
    if (!wrapper) return "none";
    const entry = wrapper.list().find((item) => item.sessionId === sessionId || item.sessionId.endsWith(`:${sessionId}`));
    if (!entry) return "none";
    // wrapper.kill now stops and waits for the systemd transient unit as part
    // of its normal teardown; no hosting-layer workaround needed here.
    return await wrapper.kill(entry.sessionId).catch(() => false) ? "killed" : "failed";
  },
  sourceHistory: async (agent, nativeSessionId) => {
    try {
      const service = getRegistry().services.get<{ parseSession?(id: string): Promise<{ messages?: unknown[] } | null> }>("session-manager.sessions");
      if (!service || typeof service.parseSession !== "function") return [];
      const parsed = await service.parseSession(`${agent}:${nativeSessionId}`);
      return Array.isArray(parsed?.messages) ? parsed.messages : [];
    } catch {
      return [];
    }
  },
  seedHistory: (handle, messages) => {
    const candidate = handle as { seedHistory?: (next: unknown[]) => void } | null;
    try {
      if (candidate && typeof candidate.seedHistory === "function") candidate.seedHistory(messages);
    } catch {
      /* source seeding is best-effort */
    }
  },
  rememberHistory: (ids, messages) => rememberSessionHistory(ids, messages),
  openExternalSession: (compositeId, options) =>
    (openExternalSession as unknown as (id: string, opts: Record<string, unknown>) => Promise<unknown>)(compositeId, options),
  waitReady: async (handle) => {
    const candidate = handle as { waitUntilReady?: () => Promise<void>; alive?: () => boolean } | null;
    try {
      if (candidate && typeof candidate.waitUntilReady === "function") await candidate.waitUntilReady();
    } catch {
      return false;
    }
    return !candidate || typeof candidate.alive !== "function" || candidate.alive();
  },
  modelOf: (handle) => {
    const candidate = handle as { getModel?: () => { provider?: string; id?: string } | undefined } | null;
    try {
      return candidate && typeof candidate.getModel === "function" ? candidate.getModel() : undefined;
    } catch {
      return undefined;
    }
  },
  historyOf: async (handle) => {
    const candidate = handle as { getMessages?: () => Promise<unknown[]> | unknown[] } | null;
    try {
      if (!candidate || typeof candidate.getMessages !== "function") return [];
      const messages = await candidate.getMessages();
      return Array.isArray(messages) ? messages : [];
    } catch {
      return [];
    }
  },
  restoreHistory: (handle, messages) => {
    const candidate = handle as { restoreHistory?: (next: unknown[]) => void } | null;
    try {
      if (candidate && typeof candidate.restoreHistory === "function") candidate.restoreHistory(messages);
    } catch {
      /* history restore is best-effort */
    }
  },
  releaseOwnership: releaseProviderOwnership,
  agentDescriptor: agentDescriptorOf,
};

/**
 * Explicit in-process switch: every provider that claims the file must release
 * its durable ownership first. A provider without a release hook means the
 * switch cannot be done safely (the local runtime would be blocked by the
 * ownsFile gate, and routing the next request to the backend would create a
 * second writer).
 */
async function releaseProviderOwnership(sessionFile: string, sessionId: string): Promise<boolean> {
  for (const provider of listProviders()) {
    if (!provider.ownsFile) continue;
    let claimed = false;
    try {
      claimed = await provider.ownsFile(sessionFile);
    } catch {
      continue;
    }
    if (!claimed) continue;
    if (typeof provider.releaseOwnership !== "function") return false;
    const released = await provider.releaseOwnership(sessionId);
    if (!released) return false;
  }
  return true;
}

export function describeSessionHosting(id: string): Promise<HostingInfo> {
  return describeHostingWith(defaultDeps, id);
}

export function switchSessionHosting(id: string, mode: HostingMode): Promise<SwitchResult> {
  if (hostingSwitchFlight(id)) {
    throw new HostingError(409, "switch_in_flight", "another hosting switch is already running for this session");
  }
  const flight = switchHostingWith(defaultDeps, id, mode);
  trackHostingSwitch(id, flight);
  return flight;
}
