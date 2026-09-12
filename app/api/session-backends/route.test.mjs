import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { GET } = await jiti.import("./route.ts");

/** 直接播种 provider 注册表（getProvider 读 globalThis.__sessionProviders——与路由同源）。 */
function seedProvider(provider) {
  const map = globalThis.__sessionProviders ?? new Map();
  globalThis.__sessionProviders = map;
  map.set(provider.type, provider);
  return () => map.delete(provider.type);
}

const req = (query) => new Request(`http://127.0.0.1/api/session-backends${query}`, {
  // 主机门禁（isApiRequestHostAllowed）读 Host 头：IP 字面量恒受信
  headers: { host: "127.0.0.1" },
});

test("session-backends ?refresh=1：有 refreshModels → 强制刷新 + refreshable:true", async () => {
  let listCalls = 0;
  let refreshCalls = 0;
  const cleanup = seedProvider({
    type: "test/refresh",
    label: "R",
    listModels: async () => { listCalls++; return [{ id: "a", provider: "test/refresh" }]; },
    refreshModels: async () => { refreshCalls++; return [{ id: "b", provider: "test/refresh", label: "B" }]; },
  });
  try {
    const res = await GET(req("?provider=test%2Frefresh&refresh=1"));
    const d = await res.json();
    assert.equal(res.status, 200);
    assert.equal(d.refreshable, true);
    assert.equal(refreshCalls, 1, "refresh=1 → 走 refreshModels（强制探测）");
    assert.equal(listCalls, 0);
    assert.deepEqual(d.models, [{ id: "b", provider: "test/refresh", label: "B" }]);
    // 不带 refresh → 静态 listModels，refreshable 仍然标注（前端据此显隐按钮）
    const res2 = await GET(req("?provider=test%2Frefresh"));
    const d2 = await res2.json();
    assert.equal(listCalls, 1);
    assert.equal(d2.refreshable, true);
    assert.deepEqual(d2.models, [{ id: "a", provider: "test/refresh" }]);
  } finally {
    cleanup();
  }
});

test("session-backends refreshable 契约：仅 listModels → refreshable:false，refresh=1 仍回落 listModels", async () => {
  let listCalls = 0;
  const cleanup = seedProvider({
    type: "test/static",
    label: "S",
    listModels: async () => { listCalls++; return [{ id: "s", provider: "test/static" }]; },
  });
  try {
    const res = await GET(req("?provider=test%2Fstatic&refresh=1"));
    const d = await res.json();
    assert.equal(d.refreshable, false);
    assert.equal(listCalls, 1, "无 refreshModels → refresh=1 回落 listModels");
    assert.deepEqual(d.models, [{ id: "s", provider: "test/static" }]);
  } finally {
    cleanup();
  }
});

test("session-backends：无任何目录方法 → models:null + refreshable:false", async () => {
  const cleanup = seedProvider({ type: "test/none", label: "N" });
  try {
    const res = await GET(req("?provider=test%2Fnone"));
    const d = await res.json();
    assert.equal(d.models, null);
    assert.equal(d.refreshable, false);
  } finally {
    cleanup();
  }
});
