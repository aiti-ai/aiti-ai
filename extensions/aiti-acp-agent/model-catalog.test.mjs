/**
 * aiti-acp-agent — model-catalog 单测：opencode 样本解析 / 缓存 TTL / 合并规则 / 单飞。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-acp-agent/model-catalog.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  ModelCatalogStore, createCatalogRefresher, parseOpenCodeModels, CATALOG_TTL_MS,
} = await import("./model-catalog.ts");

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "acp-catalog-"));
  return { store: new ModelCatalogStore(dir), dir };
}

test("parseOpenCodeModels：provider/model 逐行解析，非条目行忽略", () => {
  // opencode `models` 输出为 provider/model 逐行列表（方案 §2 探测面；无表头）
  const text = `
moonshot/kimi-k2
zhipu/glm-5.3

 2 models
`;
  assert.deepEqual(parseOpenCodeModels(text), [
    { id: "moonshot/kimi-k2", label: "moonshot / kimi-k2" },
    { id: "zhipu/glm-5.3", label: "zhipu / glm-5.3" },
  ]);
  assert.deepEqual(parseOpenCodeModels("no entries"), []);
});

test("store：put/get 持久化 + TTL 过期判定 + cli 版本失效", () => {
  const { store, dir } = tmpStore();
  const t0 = Date.now();
  try {
    store.put("codebuddy", { models: [{ id: "hy3" }], source: "cli", cliVersion: "2.150.0", fetchedAt: t0 });
    assert.equal(store.get("codebuddy")?.models[0].id, "hy3");
    assert.ok(store.isFresh("codebuddy", { now: t0 + 1000 }));
    assert.ok(!store.isFresh("codebuddy", { now: t0 + CATALOG_TTL_MS + 1 }));
    assert.ok(!store.isFresh("codebuddy", { now: t0 + 1000, cliVersion: "2.151.0" }), "版本漂移 = 失效");
    // 重新加载（模拟 reload）：落盘可读
    const store2 = new ModelCatalogStore(dir);
    assert.equal(store2.get("codebuddy")?.cliVersion, "2.150.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store：session 恒覆盖；cli/acp 不覆盖新鲜 session 条目", () => {
  const { store, dir } = tmpStore();
  const t0 = Date.now();
  try {
    store.put("codebuddy", { models: [{ id: "cli-a" }, { id: "cli-b" }], source: "cli", fetchedAt: t0 });
    store.put("codebuddy", { models: [{ id: "sess-a" }], source: "session", fetchedAt: t0 });
    assert.deepEqual(store.get("codebuddy")?.models.map((m) => m.id), ["sess-a"]);
    // 迟到的 acp 探测结果不得回退 session
    store.put("codebuddy", { models: [{ id: "acp-a" }], source: "acp", fetchedAt: t0 });
    assert.deepEqual(store.get("codebuddy")?.models.map((m) => m.id), ["sess-a"]);
    // session 过期后（TTL 外）探测可覆盖：先落一个过期 session 条目（session 恒覆盖写入了它），
    // 新 acp 探测结果随即不再被旧 session 挡住
    store.put("codebuddy", { models: [{ id: "sess-stale" }], source: "session", fetchedAt: t0 - CATALOG_TTL_MS - 1 });
    store.put("codebuddy", { models: [{ id: "acp-b" }], source: "acp", fetchedAt: t0 + CATALOG_TTL_MS + 1 });
    assert.deepEqual(store.get("codebuddy")?.models.map((m) => m.id), ["acp-b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresher：单飞（并发 refresh 同一 agent 只探测一次）+ 新鲜跳过 + cli 优先 acp", async () => {
  const { store, dir } = tmpStore();
  let cliCalls = 0;
  let acpCalls = 0;
  try {
    const refresher = createCatalogRefresher(store, () => [
      {
        name: "codebuddy",
        probeCli: async () => { cliCalls++; await new Promise((r) => setTimeout(r, 20)); return { models: [{ id: "hy3" }], source: "cli", fetchedAt: Date.now() }; },
        probeAcp: async () => { acpCalls++; return { models: [{ id: "acp-x" }], source: "acp", fetchedAt: Date.now() }; },
      },
      {
        name: "gemini",
        probeAcp: async () => { acpCalls++; return { models: [{ id: "g-x" }], source: "acp", fetchedAt: Date.now() }; },
      },
    ]);
    // 并发 5 次 refresh(codebuddy) → 单飞合并为 1 次 CLI 探测
    await Promise.all(Array.from({ length: 5 }, () => refresher.refresh("codebuddy")));
    assert.equal(cliCalls, 1);
    assert.equal(store.get("codebuddy")?.source, "cli", "CLI 源优先，成功即不走 ACP 预启动");
    assert.equal(acpCalls, 0, "codebuddy CLI 命中后不再预启动");
    // refreshAll：新鲜条目跳过（cliCalls 不再涨），gemini 走 ACP
    await refresher.refreshAll();
    assert.equal(cliCalls, 1, "新鲜条目跳过重探测");
    assert.equal(store.get("gemini")?.source, "acp");
    // inFlight 语义
    assert.equal(refresher.inFlight("codebuddy"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresher：CLI 探测失败回落 ACP 预启动", async () => {
  const { store, dir } = tmpStore();
  try {
    const refresher = createCatalogRefresher(store, () => [{
      name: "opencode",
      probeCli: async () => null,
      probeAcp: async () => ({ models: [{ id: "a/b" }], source: "acp", fetchedAt: Date.now() }),
    }]);
    await refresher.refresh("opencode");
    assert.equal(store.get("opencode")?.source, "acp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresher：refreshForce 跳过 TTL 强制探测（与启动/惰性共用单飞）", async () => {
  const { store, dir } = tmpStore();
  let cliCalls = 0;
  try {
    const refresher = createCatalogRefresher(store, () => [{
      name: "codebuddy",
      probeCli: async () => { cliCalls++; return { models: [{ id: `m${cliCalls}` }], source: "cli", fetchedAt: Date.now() }; },
    }]);
    await refresher.refresh("codebuddy");
    await refresher.refresh("codebuddy");
    assert.equal(cliCalls, 1, "TTL 内普通 refresh 跳过");
    const entry = await refresher.refreshForce("codebuddy");
    assert.equal(cliCalls, 2, "force 跳过 TTL 重探测");
    assert.equal(entry?.models[0].id, "m2");
    assert.equal(store.get("codebuddy")?.models[0].id, "m2", "结果落缓存");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store：坏 JSON fail-soft 为空", async () => {
  const { store, dir } = tmpStore();
  try {
    store.put("x", { models: [{ id: "x" }], source: "cli", fetchedAt: Date.now() });
    // 写入坏 JSON 模拟损坏
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "model-catalog.json"), "{broken");
    const store2 = new ModelCatalogStore(dir);
    assert.equal(store2.get("x"), null);
    assert.ok(!store2.isFresh("x"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
