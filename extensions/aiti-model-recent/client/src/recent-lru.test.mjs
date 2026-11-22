/**
 * recent.ts LRU/pick 单测（自 pi-web fork components/ModelSelector.test.mjs 随逻辑外迁；
 * 每个 case 独立 localStorage stub）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  RECENT_MODELS_LIMIT,
  readRecentModels,
  rememberRecentModel,
  pickRecentOptions,
  RECENT_MODELS_KEY,
} from "./recent.ts";

/** 每个 case 独立的 localStorage stub（Node 无 window.localStorage） */
function installStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  globalThis.window = {
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
  };
  return map;
}

const opt = (provider, modelId, name = modelId) => ({ provider, modelId, name });

test("rememberRecentModel records and reorders LRU (dedupe + move-to-front)", () => {
  installStorage();
  rememberRecentModel("a", "m1");
  rememberRecentModel("b", "m2");
  rememberRecentModel("a", "m1"); // repeat → move to front, no duplicate
  assert.deepEqual(
    readRecentModels().map((e) => `${e.provider}/${e.modelId}`),
    ["a/m1", "b/m2"],
  );
});

test("rememberRecentModel caps at RECENT_MODELS_LIMIT, evicting oldest", () => {
  installStorage();
  for (let i = 0; i < RECENT_MODELS_LIMIT + 2; i++) rememberRecentModel("p", `m${i}`);
  const stored = readRecentModels();
  assert.equal(stored.length, RECENT_MODELS_LIMIT);
  assert.equal(stored[0].modelId, `m${RECENT_MODELS_LIMIT + 1}`); // newest kept
  assert.equal(stored.at(-1).modelId, `m2`); // m0/m1 evicted
});

test("rememberRecentModel survives model ids containing '/'", () => {
  installStorage();
  rememberRecentModel("modelscope", "ZhipuAI/GLM-5.2");
  rememberRecentModel("modelscope", "Qwen/Qwen3.8-Flash-Next");
  assert.deepEqual(
    readRecentModels().map((e) => `${e.provider}/${e.modelId}`),
    ["modelscope/Qwen/Qwen3.8-Flash-Next", "modelscope/ZhipuAI/GLM-5.2"],
  );
});

test("readRecentModels returns [] on corrupted JSON / non-array / invalid entries", () => {
  installStorage({ [RECENT_MODELS_KEY]: "{broken json" });
  assert.deepEqual(readRecentModels(), []);

  installStorage({ [RECENT_MODELS_KEY]: JSON.stringify({ not: "an array" }) });
  assert.deepEqual(readRecentModels(), []);

  installStorage({
    [RECENT_MODELS_KEY]: JSON.stringify([
      { provider: "ok", modelId: "m1", at: 1 },
      null,
      "string",
      { provider: 42, modelId: "m2" }, // non-string provider → dropped
      { provider: "ok2" }, // missing modelId → dropped
    ]),
  });
  assert.deepEqual(readRecentModels(), [{ provider: "ok", modelId: "m1", at: 1 }]);
});

test("readRecentModels tolerates missing key and unavailable storage", () => {
  installStorage();
  assert.deepEqual(readRecentModels(), []);

  const savedWindow = globalThis.window;
  try {
    delete globalThis.window; // privacy mode etc. → silent degrade
    assert.deepEqual(readRecentModels(), []);
    assert.doesNotThrow(() => rememberRecentModel("a", "m1"));
  } finally {
    globalThis.window = savedWindow; // 不污染后续用例（顺序耦合瑕疵修复）
  }
});

const CATALOG = [
  opt("zai", "glm-flash", "GLM-5.3-Flash"),
  opt("deepseek", "v4-flash", "DeepSeek V4 Flash"),
  opt("modelscope", "ZhipuAI/GLM-5.2", "GLM-5.2"),
];

test("pickRecentOptions maps stored entries to options in recency order", () => {
  const recent = [
    { provider: "deepseek", modelId: "v4-flash", at: 300 },
    { provider: "zai", modelId: "glm-flash", at: 200 },
  ];
  assert.deepEqual(
    pickRecentOptions(recent, CATALOG, { open: true, filter: "" }),
    [CATALOG[1], CATALOG[0]],
  );
});

test("pickRecentOptions drops unavailable models and dedupes repeats", () => {
  const recent = [
    { provider: "gone", modelId: "deleted", at: 900 }, // no longer available
    { provider: "zai", modelId: "glm-flash", at: 800 },
    { provider: "zai", modelId: "glm-flash", at: 100 }, // repeat entry
  ];
  assert.deepEqual(
    pickRecentOptions(recent, CATALOG, { open: true, filter: "" }),
    [CATALOG[0]],
  );
});

test("pickRecentOptions caps at RECENT_MODELS_LIMIT", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ provider: "zai", modelId: `m${i}`, at: i }));
  const catalog = many.map((e) => opt(e.provider, e.modelId));
  assert.equal(pickRecentOptions(many, catalog, { open: true, filter: "" }).length, RECENT_MODELS_LIMIT);
});

test("pickRecentOptions hidden while panel closed or filtering", () => {
  const recent = [{ provider: "zai", modelId: "glm-flash", at: 1 }];
  assert.deepEqual(pickRecentOptions(recent, CATALOG, { open: false, filter: "" }), []);
  assert.deepEqual(pickRecentOptions(recent, CATALOG, { open: true, filter: "glm" }), []);
  assert.deepEqual(pickRecentOptions(recent, CATALOG, { open: true, filter: "  " }).length, 1); // whitespace-only filter = no filter
});

