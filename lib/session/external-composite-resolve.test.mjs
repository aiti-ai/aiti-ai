/**
 * resolveExternalCompositeSession 单测——复合外部 id（zcode:sess_x 等）冷恢复。
 * 运行：node --experimental-strip-types --test lib/session/external-composite-resolve.test.mjs
 * （或仓库根 npm test）。HOME/PI_WEB_DATA_DIR 指向临时目录做全隔离（站位文件写入隔离）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "extcomp-home-"));
process.env.HOME = home;
process.env.PI_WEB_DATA_DIR = join(home, "data");

const { registerExtensionProvider, unregisterExtensionProviders } = await import("./providers.ts");
const { resolveExternalCompositeSession, listHandleIds } = await import("./index.ts");

function fakeHandle(id, alive = true) {
  const subscribers = new Set();
  return {
    id,
    alive: () => alive,
    isRunning: () => false,
    subscribe: (l) => {
      subscribers.add(l);
      return () => subscribers.delete(l);
    },
    prompt: async () => {},
    abort: async () => {},
    dispose: async () => {},
    getModel: () => undefined,
    capabilities: {},
    source: "fake",
  };
}

test("非复合 id / pi: 前缀 / 占位 sid → undefined（不触后端）", async () => {
  assert.equal(await resolveExternalCompositeSession("0189f70c-9643-7335-a090-e70a9070b852"), undefined);
  assert.equal(await resolveExternalCompositeSession("pi:0189f70c-9643-7335-a090-e70a9070b852"), undefined);
  assert.equal(await resolveExternalCompositeSession("zcode:new-abc"), undefined);
});

test("无 provider 可驱动 → undefined（快速返回，不挂起）", async () => {
  assert.equal(await resolveExternalCompositeSession("nosuchagent:sess_abc"), undefined);
});

test("provider 可驱动：冷恢复入库，二次调用复用 handle", async () => {
  let created = 0;
  registerExtensionProvider("ext-test", {
    type: "zcode",
    label: "fake zcode",
    maxCapabilities: {},
    agentKey: "zcode",
    createSession: async (opts) => {
      created += 1;
      return fakeHandle(`zcode:${opts.sessionId}`);
    },
  });
  try {
    const s1 = await resolveExternalCompositeSession("zcode:sess_abc");
    assert.ok(s1?.isAlive(), "first resolve should return a live adapter");
    assert.equal(created, 1);
    assert.ok(listHandleIds().includes("zcode:sess_abc"), "handle registered under composite id");

    const s2 = await resolveExternalCompositeSession("zcode:sess_abc");
    assert.ok(s2?.isAlive());
    assert.equal(created, 1, "second resolve must reuse the stored handle");
  } finally {
    unregisterExtensionProviders("ext-test");
  }
});

test("后端打不开（handle 非 alive）→ undefined", async () => {
  registerExtensionProvider("ext-dead", {
    type: "zcode",
    label: "dead zcode",
    maxCapabilities: {},
    agentKey: "zcode",
    createSession: async () => fakeHandle("zcode:sess_dead", false),
  });
  try {
    // openExternalSession 既有语义：createSession 结果先入库再由调用方判活
    // （与站位路径一致，消费方全部 isAlive 守卫）——这里只断言 helper 不放行死 handle。
    assert.equal(await resolveExternalCompositeSession("zcode:sess_dead"), undefined);
  } finally {
    unregisterExtensionProviders("ext-dead");
  }
});
