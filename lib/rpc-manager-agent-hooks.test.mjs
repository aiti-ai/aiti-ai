/**
 * 方案 M：AgentSessionWrapper.toAgentSessionInfo / 钩子标记 单测。
 *
 * 该构造是会话创建点与 registry reload 重挂共用的唯一来源（见
 * lib/ext/registry.ts reattachAgentSessions、docs/pi-web-ext-reload-session-resubscribe-plan.md）。
 * 这里用真实 wrapper 类 + 最小 inner 桩验证：字段就位、getModel 实时读取、
 * abortBash 委托、steer 出口、钩子标记语义、subscribeEvent 退订幂等。
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

test("toAgentSessionInfo: 字段就位 + getModel 实时 + abortBash 委托 + 钩子标记", () => {
  const inner = makeInner({ model: { provider: "test-provider", id: "test-model" } });
  const wrapper = new AgentSessionWrapper(inner);
  const info = wrapper.toAgentSessionInfo();

  assert.equal(info.sessionId, "hook-test-session");
  assert.equal(info.cwd, process.cwd());
  assert.equal(typeof info.steer, "function");
  assert.equal(typeof info.subscribeEvent, "function");
  assert.equal(typeof info.abortBash, "function");
  assert.equal(typeof info.getModel, "function");

  // getModel：实时读取（模型切换 / 无模型）
  assert.deepEqual(info.getModel(), { provider: "test-provider", modelId: "test-model" });
  inner.model = { provider: "p2", id: "m2" };
  assert.deepEqual(info.getModel(), { provider: "p2", modelId: "m2" });
  inner.model = undefined;
  assert.equal(info.getModel(), null);

  // abortBash：委托 inner（不 abort 整个 turn）
  let aborted = 0;
  inner.abortBash = () => { aborted += 1; };
  info.abortBash();
  assert.equal(aborted, 1);

  // 钩子标记：reload 重挂的过滤依据（子代理 wrapper 不标记）
  assert.equal(wrapper.hasAgentSessionHooks(), false);
  wrapper.markAgentSessionHooksDispatched();
  assert.equal(wrapper.hasAgentSessionHooks(), true);

  // subscribeEvent：返回退订，重复调用幂等不抛
  const off = info.subscribeEvent(() => {});
  assert.equal(typeof off, "function");
  off();
  off();
});

test("toAgentSessionInfo.steer: 存活时发 steer；非运行补 continue_queue", async () => {
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

test("toAgentSessionInfo: 每次构造均返回新对象（重挂可安全重复派发）", () => {
  const wrapper = new AgentSessionWrapper(makeInner());
  const a = wrapper.toAgentSessionInfo();
  const b = wrapper.toAgentSessionInfo();
  assert.notEqual(a, b);
  assert.equal(a.sessionId, b.sessionId);
});

test("真实 wrapper ⇄ registry.reload 重挂（duck-typing 接口一致性）", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ExtRegistryImpl } = await import("./ext/registry.ts");

  const root = mkdtempSync(join(tmpdir(), "pi-agent-int-"));
  const data = mkdtempSync(join(tmpdir(), "pi-agent-int-data-"));
  const bundled = mkdtempSync(join(tmpdir(), "pi-agent-int-bundled-"));
  const savedSessions = globalThis.__piSessions;
  try {
    // 最小扩展：onAgentSession 打点（reload 后重挂应再次打点；全局日志跨模块实例保留）
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

    // 真实 AgentSessionWrapper：标记为「曾派发过钩子」后放进会话表
    const wrapper = new AgentSessionWrapper(makeInner({ sessionId: "int-session" }));
    wrapper.markAgentSessionHooksDispatched();
    globalThis.__piSessions = new Map([["int-session", wrapper]]);

    await reg.reload();
    assert.deepEqual(globalThis.__hookLog, ["int-session"], "真实 wrapper 被 registry.reload 重挂（方法名/字段契约一致）");
  } finally {
    if (savedSessions === undefined) delete globalThis.__piSessions; else globalThis.__piSessions = savedSessions;
    delete globalThis.__hookLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(bundled, { recursive: true, force: true });
  }
});
