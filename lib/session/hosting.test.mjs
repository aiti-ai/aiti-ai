import assert from "node:assert/strict";
import test from "node:test";
import {
  describeHostingWith,
  switchHostingWith,
  HostingError,
} from "./hosting-core.ts";

function fakeDeps(patch = {}) {
  const state = {
    file: "/tmp/2026-01-01T00-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl",
    header: null,
    pref: null,
    rpc: null,
    handle: null,
    wrapperEntry: null,
    holds: false,
    bridgeFile: null,
    bridgeRunning: [],
    detach: { available: true, runner: "systemd-run", reason: "systemd-run: ok" },
    providers: [{ type: "aiti-pi-agent/spawn", label: "Pi Spawn", detachable: true }],
    providersByAgent: null,
    releaseOwnershipOk: true,
    oldHistory: [],
    sourceHistory: [],
    descriptor: { agent: "pi", label: "Pi", dependencyHint: "pi CLI" },
    calls: [],
    ...patch,
  };

  const deps = {
    async resolveSessionPath() { return state.file; },
    readSessionHeader() { return state.header; },
    async findBridgeSessionFileById() { return state.bridgeFile; },
    getRpcSession() {
      const rpc = state.rpc;
      return rpc ? { isAlive: () => rpc.alive, isRunning: () => rpc.running } : undefined;
    },
    getHandle() {
      const handle = state.handle;
      if (!handle?.alive) return undefined;
      return {
        alive: () => handle.alive,
        isRunning: () => handle.running,
        source: handle.source,
        dispose: async () => { handle.disposed = true; },
      };
    },
    async getWrapperStarter() {
      return {
        describe: () => state.wrapperEntry ?? undefined,
        holds: async () => state.holds,
        kill: async () => {
          state.calls.push(["killWrapper"]);
          state.wrapperEntry = null;
          state.holds = false;
          return true;
        },
      };
    },
    getBridgeRunningIds() { return state.bridgeRunning; },
    getDetachedPreference() { return state.pref ?? undefined; },
    setDetachedPreference(id, meta) {
      state.pref = { ...meta, at: 1 };
      state.calls.push(["setPref", id, meta]);
    },
    clearDetachedPreference() { state.pref = null; state.calls.push(["clearPref"]); },
    async detachSupport() { return state.detach; },
    findProvidersForAgent(agent) {
      if (state.providersByAgent && state.providersByAgent[agent]) return state.providersByAgent[agent];
      return agent === "pi" ? state.providers : [];
    },
    getProvider() { return { label: "Pi Spawn (subprocess backend)" }; },
    async startRpcSession(id, file) {
      state.calls.push(["startRpc", id, file]);
      state.rpc = { alive: true, running: false };
      return {};
    },
    async createSessionHandle(options) {
      state.calls.push(["createHandle", options]);
      state.handle = { alive: true, running: false, source: String(options.providerType ?? "") };
      if (options.detach === true) {
        state.wrapperEntry = { providerType: options.providerType };
        state.holds = true;
      } else {
        state.wrapperEntry = null;
        state.holds = false;
      }
      return state.handle;
    },
    async stopIdleRpcSession(id) {
      state.calls.push(["stopRpc", id]);
      state.rpc = null;
      return "stopped";
    },
    removeHandle(id) {
      state.calls.push(["removeHandle", id]);
      if (state.handle) state.handle.alive = false;
    },
    async releaseOwnership(file, id) {
      state.calls.push(["releaseOwnership", file, id]);
      return state.releaseOwnershipOk !== false;
    },
    aliasHandle(id, handle) {
      state.calls.push(["aliasHandle", id]);
      if (handle && typeof handle === "object") state.handle = handle;
    },
    async waitReady(handle) {
      const alive = !handle || typeof handle.alive !== "function" || handle.alive();
      if (!alive) throw new Error("not ready");
      return true;
    },
    modelOf(handle) {
      if (state.oldModel) return state.oldModel;
      return handle && typeof handle.getModel === "function" ? handle.getModel() : undefined;
    },
    async historyOf(handle) {
      return state.oldHistory ?? (handle && typeof handle.getMessages === "function" ? await handle.getMessages() : []);
    },
    listHandles() {
      return state.handle ? [["handle", state.handle]] : [];
    },
    async killWrapperFor() {
      if (!state.wrapperEntry) return "none";
      state.calls.push(["killWrapper"]);
      state.wrapperEntry = null;
      state.holds = false;
      return "killed";
    },
    async sourceHistory() {
      return state.sourceHistory ?? [];
    },
    seedHistory(handle, messages) {
      state.calls.push(["seedHistory", messages.length]);
      if (handle && typeof handle.seedHistory === "function") handle.seedHistory(messages);
    },
    rememberHistory(ids, messages) {
      state.calls.push(["rememberHistory", ids.length, messages.length]);
    },
    restoreHistory(handle, messages) {
      state.calls.push(["restoreHistory", messages.length]);
      if (handle && typeof handle.restoreHistory === "function") handle.restoreHistory(messages);
    },
    agentDescriptor() { return state.descriptor ?? undefined; },
  };
  return { deps, state };
}

const ID = "11111111-1111-4111-8111-111111111111";

test("cold pi session: no live host, no marker", async () => {
  const { deps } = fakeDeps();
  const info = await describeHostingWith(deps, ID);
  assert.equal(info.mode, null);
  assert.equal(info.alive, false);
  assert.equal(info.running, false);
  assert.equal(info.detached, false);
  assert.equal(info.nextStartMode, "in-process");
  assert.equal(info.switchSupported, true);
  assert.equal(info.switchDisabledReason, null);
  assert.equal(info.agent, "pi");
  assert.equal(info.modes.find((m) => m.mode === "subprocess-detached")?.available, true);
});

test("cold pi session with a survive-restart marker", async () => {
  const { deps } = fakeDeps({ pref: { providerType: "aiti-pi-agent/spawn", agentKey: "pi" } });
  const info = await describeHostingWith(deps, ID);
  assert.equal(info.mode, null);
  assert.equal(info.detachedPreference, true);
  assert.equal(info.nextStartMode, "subprocess-detached");
});

test("in-process idle session", async () => {
  const { deps } = fakeDeps({ rpc: { alive: true, running: false } });
  const info = await describeHostingWith(deps, ID);
  assert.equal(info.mode, "in-process");
  assert.equal(info.providerType, "local");
  assert.equal(info.alive, true);
  assert.equal(info.running, false);
  assert.equal(info.switchDisabledReason, null);
});

test("in-process running session cannot switch", async () => {
  const { deps } = fakeDeps({ rpc: { alive: true, running: true } });
  const info = await describeHostingWith(deps, ID);
  assert.equal(info.running, true);
  assert.equal(info.switchDisabledReason, "running");
});

test("detached wrapper session", async () => {
  const { deps } = fakeDeps({
    handle: { alive: true, running: false, source: "aiti-pi-agent/spawn" },
    wrapperEntry: { providerType: "aiti-pi-agent/spawn", cwd: "/work" },
    holds: true,
  });
  const info = await describeHostingWith(deps, ID);
  assert.equal(info.mode, "subprocess-detached");
  assert.equal(info.detached, true);
  assert.equal(info.providerType, "aiti-pi-agent/spawn");
  assert.equal(info.cwd, "/work");
});

test("plain subprocess session (no wrapper entry)", async () => {
  const { deps } = fakeDeps({ handle: { alive: true, running: false, source: "aiti-pi-agent/spawn" } });
  const info = await describeHostingWith(deps, ID);
  assert.equal(info.mode, "subprocess");
  assert.equal(info.detached, false);
});

test("external composite session is read-only", async () => {
  const { deps } = fakeDeps({
    header: null,
    descriptor: { agent: "claude", label: "Claude Code" },
  });
  const info = await describeHostingWith(deps, "claude:abc");
  assert.equal(info.agent, "claude");
  assert.equal(info.agentKind, "external");
  assert.equal(info.nativeSessionId, "abc");
  assert.equal(info.mode, null);
  assert.equal(info.switchSupported, false);
  assert.equal(info.switchDisabledReason, "external");
});

test("external detachable agent exposes subprocess modes (no in-process)", async () => {
  const { deps } = fakeDeps({
    providers: [],
    providersByAgent: { acp: [{ type: "aiti-acp-agent/acp", label: "ACP", detachable: true }] },
    handle: { alive: true, running: false, source: "aiti-acp-agent/acp" },
    descriptor: { agent: "acp", label: "ACP" },
  });
  const info = await describeHostingWith(deps, "acp:abc");
  assert.equal(info.agentKind, "external");
  assert.equal(info.mode, "subprocess");
  assert.equal(info.switchSupported, true);
  assert.equal(info.nextStartMode, "subprocess-detached");
  const inProcess = info.modes.find((m) => m.mode === "in-process");
  assert.equal(inProcess?.available, false);
  assert.equal(inProcess?.reason, "only_pi");
  assert.equal(info.modes.find((m) => m.mode === "subprocess")?.available, true);
  assert.equal(info.modes.find((m) => m.mode === "subprocess-detached")?.available, true);
});

test("external detached agent reports the wrapper mode", async () => {
  const { deps } = fakeDeps({
    providers: [],
    providersByAgent: { acp: [{ type: "aiti-acp-agent/acp", label: "ACP", detachable: true }] },
    handle: { alive: true, running: false, source: "aiti-acp-agent/acp" },
    wrapperEntry: { providerType: "aiti-acp-agent/acp" },
    holds: true,
    descriptor: { agent: "acp", label: "ACP" },
  });
  const info = await describeHostingWith(deps, "acp:abc");
  assert.equal(info.mode, "subprocess-detached");
  assert.equal(info.detached, true);
  assert.equal(info.providerType, "aiti-acp-agent/acp");
});

test("provider can opt out of hosting restarts", async () => {
  const { deps } = fakeDeps({
    providers: [],
    providersByAgent: { qodercn: [{ type: "aiti-qoder-agent/qoder-cn", label: "Qoder CN", detachable: true, hostingSwitch: false }] },
    handle: { alive: true, running: false, source: "aiti-qoder-agent/qoder-cn" },
    descriptor: { agent: "qodercn", label: "QoderCN" },
  });
  const info = await describeHostingWith(deps, "qodercn:abc");
  assert.equal(info.switchSupported, false);
  assert.equal(info.switchDisabledReason, "external");
});

test("external non-detachable backend is read-only", async () => {
  const { deps } = fakeDeps({
    providers: [],
    providersByAgent: { omp: [{ type: "aiti-omp-agent/omp", label: "OMP", detachable: false }] },
    handle: { alive: true, running: false, source: "aiti-omp-agent/omp" },
    descriptor: { agent: "omp", label: "OMP" },
  });
  const info = await describeHostingWith(deps, "omp:abc");
  assert.equal(info.mode, "subprocess");
  assert.equal(info.switchSupported, false);
  assert.equal(info.switchDisabledReason, "external");
});

test("TUI bridge session is read-only", async () => {
  const { deps } = fakeDeps({ bridgeFile: "/tmp/session.jsonl", bridgeRunning: [ID] });
  const info = await describeHostingWith(deps, ID);
  assert.equal(info.mode, "tui-bridge");
  assert.equal(info.running, true);
  assert.equal(info.switchSupported, false);
  assert.equal(info.switchDisabledReason, "tui-bridge");
});

test("switch cold session to in-process clears the marker and starts the local runtime", async () => {
  const { deps, state } = fakeDeps({ pref: { providerType: "aiti-pi-agent/spawn", at: 1 } });
  const result = await switchHostingWith(deps, ID, "in-process");
  assert.equal(result.mode, "in-process");
  assert.equal(result.info.mode, "in-process");
  const releaseAt = state.calls.findIndex((c) => c[0] === "releaseOwnership");
  const clearAt = state.calls.findIndex((c) => c[0] === "clearPref");
  const startAt = state.calls.findIndex((c) => c[0] === "startRpc");
  assert.ok(releaseAt >= 0 && clearAt > releaseAt && startAt > clearAt);
  assert.equal(state.calls[startAt][1], ID);
});

test("switch cold session to detached starts a wrapper and writes the marker", async () => {
  const { deps, state } = fakeDeps();
  const result = await switchHostingWith(deps, ID, "subprocess-detached");
  assert.equal(result.mode, "subprocess-detached");
  assert.equal(result.info.mode, "subprocess-detached");
  const create = state.calls.find((c) => c[0] === "createHandle");
  assert.equal(create[1].detach, true);
  const pref = state.calls.find((c) => c[0] === "setPref");
  assert.equal(pref[2].providerType, "aiti-pi-agent/spawn");
});

test("switch cold session to subprocess starts a direct child and clears the marker", async () => {
  const { deps, state } = fakeDeps({ pref: { providerType: "aiti-pi-agent/spawn", at: 1 } });
  const result = await switchHostingWith(deps, ID, "subprocess");
  assert.equal(result.mode, "subprocess");
  assert.ok(state.calls.some((c) => c[0] === "clearPref"));
  const create = state.calls.find((c) => c[0] === "createHandle");
  assert.equal(create[1].detach, false);
  assert.equal(state.pref, null);
});

test("switch running session is rejected before any stop/start", async () => {
  const { deps, state } = fakeDeps({ rpc: { alive: true, running: true } });
  await assert.rejects(
    () => switchHostingWith(deps, ID, "subprocess"),
    (err) => err instanceof HostingError && err.status === 409 && err.code === "session_running",
  );
  assert.equal(state.calls.length, 0);
});

test("switch idle in-process session stops the old runtime first", async () => {
  const { deps, state } = fakeDeps({ rpc: { alive: true, running: false } });
  const result = await switchHostingWith(deps, ID, "subprocess-detached");
  assert.equal(result.info.mode, "subprocess-detached");
  assert.ok(state.calls.some((c) => c[0] === "stopRpc"));
  const stopAt = state.calls.findIndex((c) => c[0] === "stopRpc");
  const createAt = state.calls.findIndex((c) => c[0] === "createHandle");
  assert.ok(stopAt >= 0 && createAt > stopAt);
});

test("switch idle detached session kills the wrapper and disposes the handle", async () => {
  const { deps, state } = fakeDeps({
    handle: { alive: true, running: false, source: "aiti-pi-agent/spawn" },
    wrapperEntry: { providerType: "aiti-pi-agent/spawn" },
    holds: true,
  });
  const result = await switchHostingWith(deps, ID, "in-process");
  assert.equal(result.info.mode, "in-process");
  assert.ok(state.calls.some((c) => c[0] === "killWrapper"));
  assert.ok(state.calls.some((c) => c[0] === "removeHandle"));
});

test("switch to in-process fails when a backend still claims the file", async () => {
  const { deps, state } = fakeDeps({ releaseOwnershipOk: false });
  await assert.rejects(
    () => switchHostingWith(deps, ID, "in-process"),
    (err) => err instanceof HostingError && err.status === 409 && err.code === "provider_claim",
  );
  assert.ok(!state.calls.some((c) => c[0] === "startRpc"));
});

test("switch external session without a backend is refused", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(
    () => switchHostingWith(deps, "claude:abc", "subprocess"),
    (err) => err instanceof HostingError && err.status === 400 && err.code === "unsupported_agent",
  );
});

test("external agent cannot switch to in-process", async () => {
  const { deps } = fakeDeps({
    providers: [],
    providersByAgent: { acp: [{ type: "aiti-acp-agent/acp", label: "ACP", detachable: true }] },
    descriptor: { agent: "acp", label: "ACP" },
  });
  await assert.rejects(
    () => switchHostingWith(deps, "acp:abc", "in-process"),
    (err) => err instanceof HostingError && err.status === 400 && err.code === "mode_not_supported",
  );
});

test("switch external agent to a direct subprocess persists the direct preference", async () => {
  const { deps, state } = fakeDeps({
    providers: [],
    providersByAgent: { acp: [{ type: "aiti-acp-agent/acp", label: "ACP", detachable: true }] },
    handle: { alive: true, running: false, source: "aiti-acp-agent/acp" },
    descriptor: { agent: "acp", label: "ACP" },
  });
  const result = await switchHostingWith(deps, "acp:abc", "subprocess");
  assert.equal(result.mode, "subprocess");
  assert.equal(result.info.mode, "subprocess");
  const create = state.calls.find((c) => c[0] === "createHandle");
  assert.equal(create[1].detach, false);
  assert.equal(state.pref?.mode, "subprocess");
  assert.equal(result.info.nextStartMode, "subprocess");
});

test("file-less external agent can still switch hosting", async () => {
  const { deps, state } = fakeDeps({
    file: null,
    providers: [],
    providersByAgent: { omp: [{ type: "aiti-omp-agent/omp", label: "OMP", detachable: true }] },
    descriptor: { agent: "omp", label: "OMP" },
  });
  const result = await switchHostingWith(deps, "omp:abc", "subprocess-detached");
  assert.equal(result.mode, "subprocess-detached");
  const create = state.calls.find((c) => c[0] === "createHandle");
  assert.equal("sessionFile" in create[1], false);
});

test("switch external agent to detached writes the wrapper preference", async () => {
  const { deps, state } = fakeDeps({
    providers: [],
    providersByAgent: { acp: [{ type: "aiti-acp-agent/acp", label: "ACP", detachable: true }] },
    descriptor: { agent: "acp", label: "ACP" },
  });
  const result = await switchHostingWith(deps, "acp:abc", "subprocess-detached");
  assert.equal(result.mode, "subprocess-detached");
  assert.equal(result.info.mode, "subprocess-detached");
  const create = state.calls.find((c) => c[0] === "createHandle");
  assert.equal(create[1].detach, true);
  assert.equal(state.pref?.mode, "subprocess-detached");
  assert.equal(state.pref?.agentKey, "acp");
});

test("switch without a session file is a 404", async () => {
  const { deps } = fakeDeps({ file: null });
  await assert.rejects(
    () => switchHostingWith(deps, ID, "in-process"),
    (err) => err instanceof HostingError && err.status === 404 && err.code === "session_file_missing",
  );
});

test("switch without a pi subprocess provider reports no_provider", async () => {
  const { deps } = fakeDeps({ providers: [] });
  await assert.rejects(
    () => switchHostingWith(deps, ID, "subprocess"),
    (err) => err instanceof HostingError && err.status === 400 && err.code === "no_provider",
  );
});

test("switch to detached reports detach_unavailable", async () => {
  const { deps } = fakeDeps({ detach: { available: false, reason: "no runner" } });
  await assert.rejects(
    () => switchHostingWith(deps, ID, "subprocess-detached"),
    (err) => err instanceof HostingError && err.status === 409 && err.code === "detach_unavailable",
  );
});

test("detached option is marked unavailable when the host has no runner", async () => {
  const { deps } = fakeDeps({ detach: { available: false, reason: "no runner" } });
  const info = await describeHostingWith(deps, ID);
  const option = info.modes.find((m) => m.mode === "subprocess-detached");
  assert.equal(option?.available, false);
  assert.equal(option?.reason, "detach_unavailable");
  assert.equal(info.detachAvailable, false);
  assert.equal(info.detachReason, "no runner");
});
