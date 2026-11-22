/**
 * aiti-model-wizard · upsertProviderData apiKeyEnv 分支 + 多 provider undo 快照回整批
 * （aiti-models-import /save-batch 依赖的语义钉子，docs/aiti-models-import-plan.md §6）
 *
 * Run: node --test pi-web-ext/aiti-model-wizard/core-upsert-env.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("./core.cjs");

const tmpRoot = mkdtempSync(join(tmpdir(), "aiti-model-wizard-upsert-test-"));
const configDir = join(tmpRoot, "cfg");
test.after(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

function upsert(data, input) {
  const r = core.upsertProviderData(data, input);
  assert.equal(r.ok, true, "upsert 应成功: " + JSON.stringify(r.error || ""));
  return r;
}

test("apiKeyEnv: 新 provider 落 env 引用;与 apiKey 明文互斥", () => {
  const data = { providers: {} };
  upsert(data, { provider: "p1", baseUrl: "https://x", api: "openai-completions", apiKeyEnv: "OPENAI_API_KEY", models: [] });
  assert.equal(data.providers.p1.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(data.providers.p1.apiKey, undefined);

  // 明文覆盖 env 引用 → env 清除
  upsert(data, { provider: "p1", baseUrl: "https://x", api: "openai-completions", apiKey: "sk-live", models: [] });
  assert.equal(data.providers.p1.apiKey, "sk-live");
  assert.equal(data.providers.p1.apiKeyEnv, undefined);

  // env 再覆盖明文 → 明文清除
  upsert(data, { provider: "p1", baseUrl: "https://x", api: "openai-completions", apiKeyEnv: "OTHER_ENV", models: [] });
  assert.equal(data.providers.p1.apiKeyEnv, "OTHER_ENV");
  assert.equal(data.providers.p1.apiKey, undefined);
});

test("apiKeyEnv: keepKey=true 且已有明文 key 时让位(不覆盖用户现 key);无 key 时照写", () => {
  const data = { providers: { p2: { baseUrl: "https://y", api: "openai-completions", apiKey: "sk-user" } } };
  upsert(data, { provider: "p2", baseUrl: "https://y", api: "openai-completions", apiKeyEnv: "SOME_ENV", keepKey: true, models: [] });
  assert.equal(data.providers.p2.apiKey, "sk-user");
  assert.equal(data.providers.p2.apiKeyEnv, undefined);

  const data3 = { providers: {} };
  upsert(data3, { provider: "p3", baseUrl: "https://z", api: "openai-completions", apiKeyEnv: "E", keepKey: true, models: [] });
  assert.equal(data3.providers.p3.apiKeyEnv, "E");

  // keepKey 缺省(导入新 provider 场景) → env 照写
  const data4 = { providers: {} };
  upsert(data4, { provider: "p4", baseUrl: "https://z", api: "openai-completions", apiKeyEnv: "E2", models: [] });
  assert.equal(data4.providers.p4.apiKeyEnv, "E2");
});

test("空 models 数组不动既有模型(骨架导入安全)", () => {
  const data = { providers: {} };
  upsert(data, { provider: "p", baseUrl: "https://x", api: "openai-completions", models: [{ id: "m1", contextWindow: 128000 }] });
  upsert(data, { provider: "p", baseUrl: "https://x", api: "openai-completions", models: [] });
  assert.deepEqual((data.providers.p.models || []).map((m) => m.id), ["m1"]);
});

test("store 反填源:store 必须是 provider 映射本身(loadModelsStore().data),包装对象会静默失效", () => {
  const data = { providers: {} };
  const store = { pstore: { models: [{ id: "mx", contextWindow: 123456, maxTokens: 4096 }] } };
  upsert(data, { provider: "pstore", baseUrl: "https://s", api: "openai-completions", models: [{ id: "mx" }], store });
  const m = (data.providers.pstore.models || []).find((x) => x.id === "mx");
  assert.equal(m.contextWindow, 123456, "store 内置目录元数据应反填进模型");
  // 反例钉子:传包装对象({file,data})时 storeModelsFor 查不到 → contextWindow 不会被反填(保持缺省)
  const data2 = { providers: {} };
  upsert(data2, { provider: "pstore", baseUrl: "https://s", api: "openai-completions", models: [{ id: "mx" }], store: { file: "x", data: store } });
  const m2 = (data2.providers.pstore.models || []).find((x) => x.id === "mx");
  assert.notEqual(m2.contextWindow, 123456);
});

test("stashUndo/restoreUndoData: 多 provider patch 一次恢复(批前一次快照语义)", () => {
  const before = {
    providers: {
      a: { baseUrl: "https://a-old", api: "openai-completions", models: [{ id: "old-a" }] },
      b: { baseUrl: "https://b-old", api: "openai-completions" },
    },
  };
  const working = JSON.parse(JSON.stringify(before));
  // 模拟 save-batch:两条各自 upsert,undoPatch 合并(条目为 pre-mutation 深拷贝,同 applySaveInto 修复后语义)
  const undoPatch = {
    a: JSON.parse(JSON.stringify(working.providers.a)),
    b: JSON.parse(JSON.stringify(working.providers.b)),
    c: null, // 新增 provider 在批前快照里是 null(applySaveInto 语义) → restore 时删除
  };
  upsert(working, { provider: "a", baseUrl: "https://a-new", api: "openai-completions", models: [{ id: "new-a" }] });
  upsert(working, { provider: "b", baseUrl: "https://b-new", api: "openai-completions", models: [{ id: "new-b" }] });
  upsert(working, { provider: "c", baseUrl: "https://c-new", api: "openai-completions", models: [] });
  assert.equal(working.providers.a.baseUrl, "https://a-new");

  // 批前一次 stash（此刻序列化落盘,冻结 pre-mutation 状态）→ loadUndo 回读 → restore 一步回整批(c 是新增,应被删除)
  core.stashUndo(configDir, undoPatch);
  const undo = core.loadUndo(configDir);
  assert.ok(undo, "loadUndo 应读到快照");
  assert.equal(undo.providers.a.baseUrl, "https://a-old"); // 落盘的是 stash 时的旧值,非内存突变后的引用
  const r = core.restoreUndoData(working, undo);
  assert.equal(r.ok, true);
  assert.equal(working.providers.a.baseUrl, "https://a-old");
  assert.deepEqual((working.providers.a.models || []).map((m) => m.id), ["old-a"]);
  assert.equal(working.providers.b.baseUrl, "https://b-old");
  assert.equal(working.providers.c, undefined);
});
