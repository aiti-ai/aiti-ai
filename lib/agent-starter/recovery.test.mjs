import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_AGENT_STARTER_DIR = mkdtempSync(join(tmpdir(), "pi-starter-recovery-"));
process.env.PI_AGENT_STARTER_RUNNER = "plain";

const { LinuxMacWrapperStarter } = await import("./wrapper.ts");
const { registerExtensionProvider, unregisterExtensionProviders } = await import("../session/providers.ts");
const { attachIfBridged, openExternalSession, createSessionHandle } = await import("../session/index.ts");
const { getHandle } = await import("../session/handle-store.ts");

const FAKE_AGENT = join(import.meta.dirname, "fixtures", "fake-agent.mjs");
const starter = new LinuxMacWrapperStarter({ runner: "plain", runnerEnv: {}, nodePath: process.execPath });

function fakeHandle(id, attached) {
  const listeners = new Set();
  return {
    id,
    source: "fake/spawn",
    capabilities: {},
    cwd: "/tmp",
    attached,
    prompt: async () => {},
    abort: async () => {},
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: async () => {},
    alive: () => true,
    isRunning: () => false,
    getModel: () => undefined,
  };
}

/** Register a detachable provider that records the adopted child. */
function registerProvider({ agentKey = "pi", detachable = true, adopt = true } = {}) {
  const calls = [];
  const key = registerExtensionProvider("fake", {
    type: "spawn",
    label: "fake spawn",
    agentKey,
    detachable,
    maxCapabilities: {},
    async createSession(options) {
      calls.push(options);
      if (options.attached && !adopt) throw new Error("cannot adopt");
      return fakeHandle(options.sessionId ?? "fake", options.attached);
    },
  });
  return { key, calls, cleanup: () => unregisterExtensionProviders("fake") };
}

async function spawnWrapperSession(sessionId) {
  const child = await starter.spawn(process.execPath, [FAKE_AGENT], {
    env: process.env,
    sessionId,
    agentKey: "pi",
    owner: "fake/spawn",
    cwd: "/tmp",
  });
  await new Promise((resolve) => {
    child.stdout.once("data", resolve);
  });
  child.release();
  const dir = mkdtempSync(join(tmpdir(), "pi-starter-file-"));
  const sessionFile = join(dir, `2099-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n");
  return sessionFile;
}

test("attachIfBridged adopts a wrapper-hosted agent through the owning provider", async () => {
  const provider = registerProvider();
  const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  const sessionFile = await spawnWrapperSession(sessionId);
  try {
    const bridged = await attachIfBridged(sessionFile);
    assert.ok(bridged, "a live wrapper session must yield an attach adapter");
    assert.equal(provider.calls.length, 1);
    const adopted = provider.calls[0];
    assert.equal(adopted.sessionId, sessionId);
    assert.equal(adopted.attached.sessionId, sessionId);
    assert.equal(adopted.attached.agentKey, "pi");
    assert.equal(adopted.attached.child.detachable, true, "facade child must be the wrapper one");
    assert.equal(typeof adopted.attached.child.pid, "number");
    // Handle store: the handle is reachable by uuid and by file path.
    assert.ok(getHandle(sessionId), "handle registered by session id");
    assert.ok(getHandle(sessionFile), "handle registered by session file");
  } finally {
    provider.cleanup();
    await starter.kill(sessionId);
  }
});

test("a second open reuses the attached handle (single writer, one attach)", async () => {
  const provider = registerProvider();
  const sessionId = "bbbbbbbb-1111-2222-3333-444444444444";
  const sessionFile = await spawnWrapperSession(sessionId);
  try {
    const first = await attachIfBridged(sessionFile);
    const second = await attachIfBridged(sessionFile);
    assert.ok(first && second);
    assert.equal(provider.calls.length, 1, "the live handle is reused, not reattached");
  } finally {
    provider.cleanup();
    await starter.kill(sessionId);
  }
});

test("no provider for the agent → BridgeOccupiedError (never open locally)", async () => {
  const sessionId = "cccccccc-1111-2222-3333-444444444444";
  const sessionFile = await spawnWrapperSession(sessionId);
  try {
    await assert.rejects(() => attachIfBridged(sessionFile), /no installed backend can drive/);
  } finally {
    await starter.kill(sessionId);
  }
});

test("a provider that cannot adopt leaves the session blocked instead of forking", async () => {
  const provider = registerProvider({ adopt: false });
  const sessionId = "dddddddd-1111-2222-3333-444444444444";
  const sessionFile = await spawnWrapperSession(sessionId);
  try {
    await assert.rejects(() => attachIfBridged(sessionFile), /no backend could adopt/);
    // The agent is still alive and hosted (we disconnected, we did not kill).
    assert.equal(await starter.holds(sessionId), true);
  } finally {
    provider.cleanup();
    await starter.kill(sessionId);
  }
});

test("a provider that did not opt in to detaching is never asked to adopt", async () => {
  const provider = registerProvider({ detachable: false });
  const sessionId = "eeeeeeee-1111-2222-3333-444444444444";
  const sessionFile = await spawnWrapperSession(sessionId);
  try {
    await assert.rejects(() => attachIfBridged(sessionFile), /no installed backend can drive/);
    assert.equal(provider.calls.length, 0);
  } finally {
    provider.cleanup();
    await starter.kill(sessionId);
  }
});

test("createSessionHandle and openExternalSession route an existing detached session to attach", async () => {
  const provider = registerProvider();
  const sessionId = "ffffffff-1111-2222-3333-444444444444";
  await spawnWrapperSession(sessionId);
  try {
    const viaHandle = await createSessionHandle({ providerType: "fake/spawn", sessionId });
    assert.equal(viaHandle.attached?.sessionId, sessionId);
    const viaComposite = await openExternalSession(`pi:${sessionId}`, { sessionId });
    assert.equal(viaComposite.id, sessionId);
    assert.ok(provider.calls.length >= 1);
    assert.equal(provider.calls[0].attached.sessionId, sessionId);
  } finally {
    provider.cleanup();
    await starter.kill(sessionId);
  }
});
