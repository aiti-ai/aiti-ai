/**
 * Plan M: unit tests for AgentSessionWrapper.toAgentSessionInfo / hook flagging.
 *
 * This constructor is the single source shared by the session creation point and the
 * re-attach-after-registry-reload path (see lib/ext/registry.ts reattachAgentSessions,
 * docs/pi-web-ext-reload-session-resubscribe-plan.md).
 * These tests use the real wrapper class + a minimal inner stub to verify: fields in
 * place, live getModel, abortBash delegation, the steer exit path, hook flag semantics,
 * and subscribeEvent unsubscribe idempotence.
 * Run: node --experimental-strip-types --test lib/rpc-manager-agent-hooks.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function makeInner(overrides = {}) {
  return {
    sessionId: "hook-test-session",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    modelRuntime: {
      getModel: () => undefined,
      refresh: async () => {},
    },
    sessionManager: { getCwd: () => process.cwd() },
    settingsManager: { setProjectTrusted: () => {}, getDefaultTools: () => undefined },
    agent: { state: {} },
    extensionRunner: {
      getRegisteredCommands: () => [],
      setUIContext: () => {},
      emit: async () => {},
    },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe: () => () => {},
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getActiveToolNames: () => ["read"],
    getAllTools: () => [],
    setActiveToolsByName: () => {},
    pendingMessageCount: 0,
    dispose: () => {},
    reload: async () => {},
    abortBash: () => {},
    ...overrides,
  };
}

test("toAgentSessionInfo: fields in place + live getModel + abortBash delegation + hook flag", () => {
  const inner = makeInner({ model: { provider: "test-provider", id: "test-model" } });
  const wrapper = new AgentSessionWrapper(inner);
  const info = wrapper.toAgentSessionInfo();

  assert.equal(info.sessionId, "hook-test-session");
  assert.equal(info.cwd, process.cwd());
  assert.equal(typeof info.steer, "function");
  assert.equal(typeof info.subscribeEvent, "function");
  assert.equal(typeof info.abortBash, "function");
  assert.equal(typeof info.getModel, "function");

  // getModel: reads live (model switched / no model)
  assert.deepEqual(info.getModel(), { provider: "test-provider", modelId: "test-model" });
  inner.model = { provider: "p2", id: "m2" };
  assert.deepEqual(info.getModel(), { provider: "p2", modelId: "m2" });
  inner.model = undefined;
  assert.equal(info.getModel(), null);

  // abortBash: delegates to inner (does not abort the whole turn)
  let aborted = 0;
  inner.abortBash = () => { aborted += 1; };
  info.abortBash();
  assert.equal(aborted, 1);

  // Hook flag: filter criterion for re-attach after reload (subagent wrappers are not flagged)
  assert.equal(wrapper.hasAgentSessionHooks(), false);
  wrapper.markAgentSessionHooksDispatched();
  assert.equal(wrapper.hasAgentSessionHooks(), true);

  // subscribeEvent: returns an unsubscribe; repeated calls are idempotent and do not throw
  const off = info.subscribeEvent(() => {});
  assert.equal(typeof off, "function");
  off();
  off();
});

test("toAgentSessionInfo.steer: forwards steer while alive; enqueues continue_queue when not running", async () => {
  const wrapper = new AgentSessionWrapper(makeInner());
  const sent = [];
  wrapper.send = async (command) => { sent.push(command); };
  const info = wrapper.toAgentSessionInfo();

  await info.steer("focus on tests");
  assert.deepEqual(sent, [
    { type: "steer", message: "focus on tests" },
    { type: "continue_queue" },
  ]);
});

test("toAgentSessionInfo returns a fresh object on every call (re-attach can safely re-dispatch)", () => {
  const wrapper = new AgentSessionWrapper(makeInner());
  const a = wrapper.toAgentSessionInfo();
  const b = wrapper.toAgentSessionInfo();
  assert.notEqual(a, b);
  assert.equal(a.sessionId, b.sessionId);
});

test("real wrapper re-attaches through registry.reload (duck-typing interface consistency)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ExtRegistryImpl } = await import("./ext/registry.ts");

  const root = mkdtempSync(join(tmpdir(), "pi-agent-int-"));
  const data = mkdtempSync(join(tmpdir(), "pi-agent-int-data-"));
  const bundled = mkdtempSync(join(tmpdir(), "pi-agent-int-bundled-"));
  const savedSessions = globalThis.__piSessions;
  try {
    // Minimal extension: onAgentSession trace point (re-attach after reload should trace
    // again; the global log survives across module instances)
    const dir = join(root, "agent-demo");
    mkdirSync(join(dir, "client"), { recursive: true });
    writeFileSync(join(dir, "client", "demo.mjs"), "export default {}\n");
    writeFileSync(join(dir, "index.ts"), `
export default {
  id: "agent-demo",
  name: "agent-demo",
  version: "1.0.0",
  client: "client/demo.mjs",
  server: {
    agent: {
      onAgentSession(info) { (globalThis.__hookLog = globalThis.__hookLog || []).push(info.sessionId); },
    },
  },
};
`);
    const reg = new ExtRegistryImpl({
      core: {
        async listSessions() { return []; },
        async getRunningSessionIds() { return []; },
        async getHomeDir() { return "/tmp"; },
      },
      extensionsRootOverride: root,
      extraExtensionsRootsOverride: [],
      devExtensionsRootOverride: null,
      bundledExtensionsRootOverride: bundled,
      dataRootOverride: data,
    });
    await reg.loadAll();
    await reg.startAll();

    // Real AgentSessionWrapper: marked "hooks dispatched" before being put into the session table
    const wrapper = new AgentSessionWrapper(makeInner({ sessionId: "int-session" }));
    wrapper.markAgentSessionHooksDispatched();
    globalThis.__piSessions = new Map([["int-session", wrapper]]);

    await reg.reload();
    assert.deepEqual(globalThis.__hookLog, ["int-session"], "real wrapper re-attached by registry.reload (method-name/field contract intact)");
  } finally {
    if (savedSessions === undefined) delete globalThis.__piSessions; else globalThis.__piSessions = savedSessions;
    delete globalThis.__hookLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(bundled, { recursive: true, force: true });
  }
});
