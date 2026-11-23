/**
 * Session hosting inspection / switching core.
 *
 * The chat UI needs one question answered for the current session: which agent
 * drives it, is it alive, is a turn running, and how is the agent process
 * hosted? This module is the single implementation behind
 * `GET/POST /api/sessions/[id]/hosting`.
 *
 * Hosting vocabulary:
 *   in-process         pi-web hosts the agent through the local RPC child (pi only)
 *   subprocess         a backend-owned child process, dies with pi-web
 *   subprocess-detached same, hosted by an agent-starter wrapper (survives restarts)
 *   tui-bridge         the pi TUI owns the file through the attach bridge
 *   null               cold session (no live process)
 *
 * `agentKind` separates pi (in-process is possible) from external backends
 * (claude/qoder/ACP/...), which only expose the two subprocess modes.
 *
 * The module is dependency-injected (`HostingDeps`) so the state matrix and the
 * switch rules are unit-testable without loading the Next.js module graph.
 */

export type HostingMode = "in-process" | "subprocess" | "subprocess-detached";
export type HostingModeState = HostingMode | "external" | "tui-bridge" | null;

export type LocalizedText = string | { en?: string; zh?: string };

export type HostingPreference = {
  mode?: "subprocess" | "subprocess-detached";
  providerType?: string;
  agentKey?: string;
  cwd?: string;
  at?: number;
};

export type LiveRpc = {
  isAlive(): boolean;
  isRunning(): boolean;
};

export type LiveHandle = {
  /** Handle's own id (composite / native). */
  readonly id?: string;
  alive(): boolean;
  isRunning?(): boolean;
  dispose?(): Promise<void>;
  /** Optional in-memory history access for hosting restarts. */
  getMessages?(): Promise<unknown[]> | unknown[];
  restoreHistory?(messages: unknown[]): void;
  /** Optional backend bootstrap readiness seam (external providers). */
  waitUntilReady?(): Promise<void>;
  cwd?: string;
  source?: string;
};

export type WrapperEntry = {
  providerType?: string;
  agentKey?: string;
  cwd?: string;
};

export type WrapperProbe = {
  describe(sessionId: string): WrapperEntry | undefined;
  holds(sessionId: string): Promise<boolean>;
  kill(sessionId: string, signal?: string): Promise<boolean>;
};

export type HostingProvider = {
  type: string;
  label?: string;
  detachable?: boolean;
  /** false = provider cannot safely restart its native session (read-only switch). */
  hostingSwitch?: boolean;
};

export type HostingDeps = {
  resolveSessionPath(id: string): Promise<string | null>;
  readSessionHeader(file: string): unknown;
  findBridgeSessionFileById(id: string): Promise<string | null>;
  getRpcSession(id: string): LiveRpc | undefined;
  getHandle(id: string): LiveHandle | undefined;
  getWrapperStarter(): Promise<WrapperProbe | undefined>;
  getBridgeRunningIds(): string[];
  getDetachedPreference(id: string): HostingPreference | undefined;
  setDetachedPreference(id: string, meta: HostingPreference): void;
  clearDetachedPreference(id: string): void;
  detachSupport(): Promise<{ available: boolean; runner?: string; reason?: string }>;
  findProvidersForAgent(agent: string): HostingProvider[];
  getProvider(type: string): { label?: string } | undefined;
  startRpcSession(id: string, sessionFile: string, cwd?: string, options?: Record<string, unknown>): Promise<unknown>;
  createSessionHandle(options: Record<string, unknown>): Promise<unknown>;
  stopIdleRpcSession(id: string): Promise<"stopped" | "running" | "not-alive" | "missing" | "still-alive">;
  removeHandle(id: string): void;
  /** Register an existing handle under an additional lookup key (native / page id). */
  aliasHandle(id: string, handle: unknown): void;
  /** Every handle currently in the store (key + handle). */
  listHandles(): Array<[string, LiveHandle]>;
  /** Stop any agent-starter wrapper holding this session (even when the cached mode says direct). */
  killWrapperFor(sessionId: string): Promise<"none" | "killed" | "failed">;
  /** Source-index history (session-manager) for a resumed external session. */
  sourceHistory(agent: string, nativeSessionId: string): Promise<unknown[]>;
  /** Seed a provider handle from source-shaped history. */
  seedHistory(handle: unknown, messages: unknown[]): void;
  /** Preserve the captured full history for read routes. */
  rememberHistory(ids: string[], messages: unknown[]): void;
  /** Open an external session through the same path as a cold reopen. */
  openExternalSession?(
    compositeId: string,
    options: Record<string, unknown>,
  ): Promise<unknown>;
  /** Wait for a freshly created handle's backend bootstrap; false = not alive. */
  waitReady(handle: unknown): Promise<boolean>;
  /** Current model of a live handle (carried across a hosting restart). */
  modelOf(handle: unknown): { provider?: string; id?: string } | undefined;
  /** In-memory history of a live handle (captured before stopping it). */
  historyOf(handle: unknown): Promise<unknown[]>;
  /** Replace a new handle's partial history with the captured one. */
  restoreHistory(handle: unknown, messages: unknown[]): void;
  /** Release any durable single-writer claim on the file before an in-process start. */
  releaseOwnership(sessionFile: string, sessionId: string): Promise<boolean>;
  agentDescriptor(agent: string): { label?: LocalizedText; dependencyHint?: LocalizedText; description?: LocalizedText } | undefined;
};

export type HostingModeOption = {
  mode: HostingMode;
  available: boolean;
  reason?: string;
};

export type HostingInfo = {
  ok: true;
  sessionId: string;
  nativeSessionId: string;
  sessionFile?: string;
  cwd?: string;
  agent: string;
  /** pi can also run in-process; external backends only host subprocesses. */
  agentKind: "pi" | "external";
  agentLabel?: LocalizedText;
  agentHint?: LocalizedText;
  agentDescription?: LocalizedText;
  providerType?: string;
  providerLabel?: string;
  alive: boolean;
  running: boolean;
  mode: HostingModeState;
  detached: boolean;
  detachedPreference: boolean;
  nextStartMode: HostingMode;
  runner?: string;
  detachAvailable: boolean;
  detachReason?: string;
  switchSupported: boolean;
  switchDisabledReason: "running" | "external" | "tui-bridge" | "unsupported" | null;
  modes: HostingModeOption[];
};

export type SwitchResult = {
  ok: true;
  mode: HostingMode;
  info: HostingInfo;
};

export class HostingError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HostingError";
    this.status = status;
    this.code = code;
  }
}

type SessionHeaderLike = {
  extId?: unknown;
  agent?: unknown;
  cwd?: unknown;
};

function readHeader(deps: HostingDeps, file: string): SessionHeaderLike | null {
  try {
    const value = deps.readSessionHeader(file);
    return value && typeof value === "object" ? (value as SessionHeaderLike) : null;
  } catch {
    return null;
  }
}

/** Composite-id / placeholder-header identity resolution (no filesystem assumption). */
export function resolveSessionIdentity(id: string, header: SessionHeaderLike | null): {
  agent: string;
  nativeSessionId: string;
  external: boolean;
} {
  const colon = id.indexOf(":");
  if (colon > 0) {
    const prefix = id.slice(0, colon);
    // "pi:<uuid>" is a local pi reference, not an external agent.
    if (prefix === "pi") {
      return { agent: "pi", nativeSessionId: id.slice(colon + 1), external: false };
    }
    return { agent: prefix, nativeSessionId: id.slice(colon + 1), external: true };
  }
  const extId = typeof header?.extId === "string" ? header.extId : "";
  const extColon = extId.indexOf(":");
  if (extColon > 0) {
    return {
      agent: extId.slice(0, extColon),
      nativeSessionId: extId.slice(extColon + 1),
      external: true,
    };
  }
  const headerAgent = typeof header?.agent === "string" && header.agent ? header.agent : "pi";
  return { agent: headerAgent, nativeSessionId: id, external: headerAgent !== "pi" };
}

function pickProvider(
  deps: HostingDeps,
  agent: string,
  preferredType?: string,
  requireDetachable = false,
): HostingProvider | undefined {
  const providers = deps.findProvidersForAgent(agent).filter((p) => !requireDetachable || p.detachable === true);
  if (preferredType) {
    const preferred = providers.find((p) => p.type === preferredType);
    if (preferred) return preferred;
  }
  return providers[0];
}

function providerLabelOf(deps: HostingDeps, type?: string): string | undefined {
  if (!type) return undefined;
  try {
    return deps.getProvider(type)?.label;
  } catch {
    return undefined;
  }
}

async function detachProbe(deps: HostingDeps): Promise<{ available: boolean; runner?: string; reason?: string }> {
  try {
    return await deps.detachSupport();
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Inspect one session. Read-only: never attaches a wrapper, never starts a
 * runtime, never mutates a preference marker.
 */
export async function describeHostingWith(deps: HostingDeps, id: string): Promise<HostingInfo> {
  if (!id || typeof id !== "string") {
    throw new HostingError(400, "invalid_session", "session id is required");
  }

  const sessionFile = await deps.resolveSessionPath(id).catch(() => null);
  const header = sessionFile ? readHeader(deps, sessionFile) : null;
  const identity = resolveSessionIdentity(id, header);
  const nativeId = identity.nativeSessionId;

  const rpc = deps.getRpcSession(nativeId) ?? (nativeId !== id ? deps.getRpcSession(id) : undefined);
  const rpcAlive = !!rpc && rpc.isAlive();
  const rpcRunning = rpcAlive && rpc.isRunning();

  const handle = deps.getHandle(nativeId) ?? (nativeId !== id ? deps.getHandle(id) : undefined);
  const handleAlive = !!handle && handle.alive();
  const handleRunning = handleAlive && typeof handle.isRunning === "function" && handle.isRunning() === true;

  const piLocal = !identity.external && identity.agent === "pi";
  const bridgeFile = piLocal && !id.includes(":") ? await deps.findBridgeSessionFileById(nativeId).catch(() => null) : null;
  const bridgeRunning = piLocal && deps.getBridgeRunningIds().includes(nativeId);

  const wrapper = await deps.getWrapperStarter().catch(() => undefined);
  const wrapperEntry = wrapper ? wrapper.describe(nativeId) : undefined;
  const detachedAlive = !!wrapperEntry && !!wrapper && await wrapper.holds(nativeId).catch(() => false);

  const support = await detachProbe(deps);
  const preference = deps.getDetachedPreference(nativeId);
  const provider = piLocal
    ? pickProvider(deps, "pi", preference?.providerType, true)
    : pickProvider(deps, identity.agent, handle?.source ?? preference?.providerType, false);
  const detachableProvider = piLocal
    ? provider
    : pickProvider(deps, identity.agent, provider?.type ?? preference?.providerType, true);

  let mode: HostingModeState = null;
  if (bridgeFile) mode = "tui-bridge";
  else if (rpcAlive) mode = "in-process";
  else if (detachedAlive) mode = "subprocess-detached";
  else if (handleAlive) mode = "subprocess";

  let providerType: string | undefined;
  if (mode === "in-process") providerType = "local";
  else if (mode === "subprocess-detached") providerType = wrapperEntry?.providerType;
  else if (mode === "subprocess") providerType = handle?.source;
  else if (mode === "tui-bridge") providerType = "aiti-attach-agent/attach";
  else if (mode === null) {
    if (!piLocal) providerType = preference?.providerType ?? provider?.type;
    else if (preference) providerType = preference.providerType;
  }

  const alive = rpcAlive || handleAlive || detachedAlive || !!bridgeFile;
  const running = rpcRunning || handleRunning || bridgeRunning;

  const cwd = (typeof header?.cwd === "string" && header.cwd)
    || (wrapperEntry?.cwd)
    || (handle?.cwd)
    || undefined;

  const descriptor = (() => {
    try {
      return deps.agentDescriptor(identity.agent);
    } catch {
      return undefined;
    }
  })();

  const modes: HostingModeOption[] = [
    {
      mode: "in-process",
      available: piLocal,
      ...(piLocal ? {} : { reason: "only_pi" }),
    },
    {
      mode: "subprocess",
      available: !!provider,
      ...(provider ? {} : { reason: "no_provider" }),
    },
    {
      mode: "subprocess-detached",
      available: !!detachableProvider && support.available,
      ...(detachableProvider ? {} : { reason: "no_provider" }),
      ...(detachableProvider && !support.available ? { reason: "detach_unavailable" } : {}),
    },
  ];

  const switchSupported = mode !== "tui-bridge"
    && (piLocal || (!!detachableProvider && detachableProvider.hostingSwitch !== false));
  let switchDisabledReason: HostingInfo["switchDisabledReason"] = null;
  if (mode === "tui-bridge") switchDisabledReason = "tui-bridge";
  else if (running) switchDisabledReason = "running";
  else if (!piLocal && (!detachableProvider || detachableProvider.hostingSwitch === false)) switchDisabledReason = "external";
  else if (!switchSupported) switchDisabledReason = "unsupported";

  const detachedPreference = !!preference && preference.mode !== "subprocess";
  let nextStartMode: HostingMode;
  if (preference) nextStartMode = preference.mode === "subprocess" ? "subprocess" : "subprocess-detached";
  else if (piLocal) nextStartMode = "in-process";
  else nextStartMode = provider?.detachable ? "subprocess-detached" : "subprocess";

  return {
    ok: true,
    sessionId: id,
    nativeSessionId: nativeId,
    ...(sessionFile ? { sessionFile } : {}),
    ...(cwd ? { cwd } : {}),
    agent: identity.agent,
    agentKind: piLocal ? "pi" : "external",
    agentLabel: descriptor?.label ?? identity.agent,
    ...(descriptor?.dependencyHint ? { agentHint: descriptor.dependencyHint } : {}),
    ...(descriptor?.description ? { agentDescription: descriptor.description } : {}),
    ...(providerType ? { providerType } : {}),
    ...(providerLabelOf(deps, providerType) ? { providerLabel: providerLabelOf(deps, providerType) } : {}),
    alive,
    running,
    mode,
    detached: detachedAlive,
    detachedPreference,
    nextStartMode,
    ...(support.runner ? { runner: support.runner } : {}),
    detachAvailable: support.available,
    ...(support.reason ? { detachReason: support.reason } : {}),
    switchSupported,
    switchDisabledReason,
    modes,
  };
}

async function stopLiveIdle(deps: HostingDeps, info: HostingInfo): Promise<void> {
  const rpc = deps.getRpcSession(info.nativeSessionId) ?? deps.getRpcSession(info.sessionId);
  if (rpc?.isAlive()) {
    if (rpc.isRunning()) {
      throw new HostingError(409, "session_running", "the session is running; stop the current turn before switching hosting");
    }
    const verdict = await deps.stopIdleRpcSession(info.nativeSessionId);
    if (verdict === "running") {
      throw new HostingError(409, "session_running", "the session is running; stop the current turn before switching hosting");
    }
    if (verdict === "still-alive") {
      throw new HostingError(503, "stop_failed", "the current in-process runtime did not stop");
    }
  }

  // Purge every handle/alias for this native id (composite ids differ by caller).
  const native = info.nativeSessionId;
  const targets = new Set([native, info.sessionId]);
  for (const [key, handle] of deps.listHandles()) {
    const matches = targets.has(key)
      || targets.has(handle.id ?? "")
      || (native && (key.endsWith(`:${native}`) || (handle.id ?? "").endsWith(`:${native}`)));
    if (!matches) continue;
    if (handle.alive() && typeof handle.dispose === "function") {
      try {
        await handle.dispose();
      } catch {
        /* removal below is still required */
      }
    }
    deps.removeHandle(key);
  }
  // The direct-mode handle lookup may have missed aliases; remove the canonical ids too.
  deps.removeHandle(native);
  if (info.sessionId !== native) deps.removeHandle(info.sessionId);
}

/**
 * Switch one cold/idle pi session to another hosting mode.
 *
 * Running sessions are rejected: the hosting strategy is fixed at spawn time
 * and switching mid-turn would drop the turn. Idle live processes are stopped
 * first, then the target mode is started immediately (the user explicitly
 * asked for a switch, so a preference-only change would look like a no-op).
 */
export async function switchHostingWith(deps: HostingDeps, id: string, mode: HostingMode): Promise<SwitchResult> {
  if (mode !== "in-process" && mode !== "subprocess" && mode !== "subprocess-detached") {
    throw new HostingError(400, "invalid_mode", "mode must be in-process, subprocess, or subprocess-detached");
  }

  const info = await describeHostingWith(deps, id);
  if (!info.switchSupported) {
    if (info.mode === "tui-bridge") {
      throw new HostingError(409, "tui_bridge", "the session is owned by a TUI bridge");
    }
    throw new HostingError(400, "unsupported_agent", `hosting switching is not supported for agent "${info.agent}"`);
  }
  if (info.running) {
    throw new HostingError(409, "session_running", "the session is running; stop the current turn before switching hosting");
  }
  if (mode === "in-process" && info.agentKind !== "pi") {
    throw new HostingError(400, "mode_not_supported", "in-process hosting applies to pi sessions only");
  }
  if (!info.sessionFile && info.agentKind === "pi") {
    throw new HostingError(404, "session_file_missing", "the session has no file to reopen");
  }

  const oldHandle = info.alive ? (deps.getHandle(info.nativeSessionId) ?? deps.getHandle(info.sessionId)) : undefined;
  const oldModel = oldHandle ? deps.modelOf(oldHandle) : undefined;
  const oldHistory = oldHandle ? await deps.historyOf(oldHandle).catch(() => []) : [];
  if (info.alive) await stopLiveIdle(deps, info);
  // Even when the cached mode says direct, a stale wrapper may still hold the
  // native session. Stop it so the replacement process is the only writer.
  {
    const wrapperState = await deps.killWrapperFor(info.nativeSessionId);
    if (wrapperState === "failed") {
      throw new HostingError(409, "stop_failed", "the previous agent process did not stop");
    }
  }
  // External CLIs briefly lock their native session after the old process
  // exits; starting the replacement immediately makes session/load abort
  // (qoder: "The operation was aborted"). Give the lock one short settle pass.
  if (info.alive && info.agentKind !== "pi") {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  if (mode === "in-process") {
    const sessionFile = info.sessionFile;
    if (!sessionFile) {
      throw new HostingError(404, "session_file_missing", "the session has no file to reopen");
    }
    const released = await deps.releaseOwnership(sessionFile, info.nativeSessionId);
    if (!released) {
      throw new HostingError(409, "provider_claim", "a backend still claims this session file; upgrade the backend before switching to in-process");
    }
    deps.clearDetachedPreference(info.nativeSessionId);
    await deps.startRpcSession(info.nativeSessionId, sessionFile, info.cwd, {});
  } else {
    const preference = deps.getDetachedPreference(info.nativeSessionId);
    const provider = info.agentKind === "pi"
      ? pickProvider(deps, "pi", info.detachedPreference ? preference?.providerType : undefined, true)
      : pickProvider(
          deps,
          info.agent,
          info.providerType ?? preference?.providerType,
          mode === "subprocess-detached",
        );
    if (!provider) {
      throw new HostingError(
        400,
        "no_provider",
        info.agentKind === "pi"
          ? "no installed pi backend can host a subprocess for this session"
          : `no installed backend can host "${info.agent}" as a ${mode === "subprocess-detached" ? "detached " : ""}subprocess`,
      );
    }
    if (mode === "subprocess-detached") {
      const support = await detachProbe(deps);
      if (!support.available) {
        throw new HostingError(409, "detach_unavailable", support.reason || "detached hosting is not available on this host");
      }
    } else if (info.agentKind === "pi") {
      deps.clearDetachedPreference(info.nativeSessionId);
    }
    const handleOptions = {
      providerType: provider.type,
      sessionId: info.nativeSessionId,
      ...(info.sessionFile ? { sessionFile: info.sessionFile } : {}),
      ...(info.cwd ? { cwd: info.cwd } : {}),
      ...(oldModel?.id ? { model: oldModel } : {}),
      detach: mode === "subprocess-detached",
    };
    const externalId = `${info.agent}:${info.nativeSessionId}`;
    let created = info.agentKind !== "pi" && deps.openExternalSession
      ? await deps.openExternalSession(externalId, {
          sessionId: info.nativeSessionId,
          ...(info.cwd ? { cwd: info.cwd } : {}),
          ...(oldModel?.id ? { model: oldModel } : {}),
          detach: mode === "subprocess-detached",
        })
      : await deps.createSessionHandle(handleOptions);
    if (!created) throw new HostingError(503, "backend_not_ready", "the external backend did not open the session");
    if (!await deps.waitReady(created)) {
      // A freshly spawned wrapper can briefly report "process exited (signal)"
      // while its child is still starting; the wrapper stays alive. Retry once
      // through the attach path instead of leaving the session unusable.
      deps.removeHandle(info.nativeSessionId);
      if (info.sessionId !== info.nativeSessionId) deps.removeHandle(info.sessionId);
      created = info.agentKind !== "pi" && deps.openExternalSession
        ? await deps.openExternalSession(externalId, {
            sessionId: info.nativeSessionId,
            ...(info.cwd ? { cwd: info.cwd } : {}),
            ...(oldModel?.id ? { model: oldModel } : {}),
            detach: mode === "subprocess-detached",
          })
        : await deps.createSessionHandle(handleOptions);
      if (!await deps.waitReady(created)) {
        throw new HostingError(503, "backend_not_ready", "the backend process stopped while switching hosting");
      }
    }
    // External providers register the handle under its composite id; the page
    // and the wrapper registry address the native/plain id. Alias both before
    // describe() runs, otherwise a live direct child looks cold.
    deps.aliasHandle(info.nativeSessionId, created);
    if (info.sessionId !== info.nativeSessionId) deps.aliasHandle(info.sessionId, created);
    if (oldHistory.length > 0) {
      const newHistory = await deps.historyOf(created).catch(() => []);
      if (newHistory.length < oldHistory.length) deps.restoreHistory(created, oldHistory);
    }
    // The previous process may itself have held only a partial replay; the source
    // index is authoritative for external agents. Seed when it is larger.
    const source = await deps.sourceHistory(info.agent, info.nativeSessionId).catch(() => []);
    if (source.length > 0) {
      const current = await deps.historyOf(created).catch(() => []);
      if (current.length < source.length) deps.seedHistory(created, source);
    }
    const finalHistory = await deps.historyOf(created).catch(() => []);
    const remember = finalHistory.length >= oldHistory.length ? finalHistory : oldHistory;
    if (remember.length > 0) deps.rememberHistory([info.nativeSessionId, info.sessionId], remember);
    if (mode === "subprocess-detached") {
      deps.setDetachedPreference(info.nativeSessionId, {
        mode: "subprocess-detached",
        providerType: provider.type,
        agentKey: info.agent,
        ...(info.cwd ? { cwd: info.cwd } : {}),
      });
    } else if (info.agentKind !== "pi") {
      deps.setDetachedPreference(info.nativeSessionId, {
        mode: "subprocess",
        providerType: provider.type,
        agentKey: info.agent,
        ...(info.cwd ? { cwd: info.cwd } : {}),
      });
    }
  }

  return { ok: true, mode, info: await describeHostingWith(deps, id) };
}
