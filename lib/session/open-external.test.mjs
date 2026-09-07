import { test } from "node:test";
import assert from "node:assert/strict";

// openExternalSession 依赖 globalThis 全局（handle store / provider registry）——
// 测试先清场，结束再清理，避免污染其它测试文件。
const g = globalThis;
function reset() {
  g.__sessionHandles = undefined;
  g.__sessionProviders = undefined;
  g.__extSessionProviders = undefined;
}

function liveHandle(id) {
  return {
    id,
    source: "test-ext/zcode",
    capabilities: {},
    cwd: "",
    alive: () => true,
    isRunning: () => false,
    subscribe: () => () => {},
    dispose: async () => {},
  };
}

async function load() {
  reset();
  const providers = await import("./providers.ts");
  const store = await import("./handle-store.ts");
  const index = await import("./index.ts");
  return { providers, store, index };
}

test("openExternalSession：同复合 id 已有活 handle 时复用，不重建（防双 handle 互杀）", async () => {
  const { providers, store, index } = await load();
  try {
    let created = 0;
    providers.registerExtensionProvider("test-ext", {
      type: "zcode",
      label: "zcode",
      agentKey: "zcode",
      maxCapabilities: {},
      createSession: async () => { created++; return liveHandle(`zcode:sess_${created}`); },
    });

    const existing = liveHandle("zcode:sess_x");
    store.putHandle(existing);

    const got = await index.openExternalSession("zcode:sess_x");
    assert.equal(got, existing, "必须返回存活的既有 handle");
    assert.equal(created, 0, "不得经 provider 重建（重建会 dispose 前一只，杀掉在途轮次）");
  } finally {
    reset();
  }
});

test("openExternalSession：占位 uuid 别名门口打开时复用并补复合 id 键", async () => {
  const { providers, store, index } = await load();
  try {
    let created = 0;
    providers.registerExtensionProvider("test-ext", {
      type: "zcode",
      label: "zcode",
      agentKey: "zcode",
      maxCapabilities: {},
      createSession: async () => { created++; return liveHandle(`zcode:sess_${created}`); },
    });

    const existing = liveHandle("zcode:sess_x");
    store.putHandleAt("placeholder-uuid", existing); // 只在占位 uuid 键下可达

    const got = await index.openExternalSession("zcode:sess_x");
    assert.equal(got, existing);
    assert.equal(created, 0);
    assert.equal(store.getHandle("zcode:sess_x"), existing, "复合 id 键补注册");
  } finally {
    reset();
  }
});

test("openExternalSession：无活 handle 时照常经 provider 创建", async () => {
  const { providers, store, index } = await load();
  try {
    let created = 0;
    providers.registerExtensionProvider("test-ext", {
      type: "zcode",
      label: "zcode",
      agentKey: "zcode",
      maxCapabilities: {},
      createSession: async () => { created++; return liveHandle("zcode:sess_new"); },
    });

    const got = await index.openExternalSession("zcode:sess_new");
    assert.equal(created, 1);
    assert.equal(got?.id, "zcode:sess_new");
    assert.equal(store.getHandle("zcode:sess_new"), got);
  } finally {
    reset();
  }
});
