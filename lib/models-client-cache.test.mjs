import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  readCachedModels,
  writeCachedModels,
  clearCachedModels,
  readMostRecentCachedCwd,
  MODELS_CLIENT_CACHE_MAX_AGE_MS,
  MODELS_CLIENT_CACHE_MAX_ENTRIES,
  MODELS_CLIENT_CACHE_MAX_BYTES,
} = await jiti.import("./models-client-cache.ts");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

const sample = (name = "Test") => ({
  models: { "custom:test": name },
  modelList: [{ id: "test", name, provider: "custom" }],
  defaultModel: { provider: "custom", modelId: "test" },
});

test("round-trips a payload for the same cwd", () => {
  const storage = createStorage();
  writeCachedModels("/work/a", sample(), storage);
  const hit = readCachedModels("/work/a", storage);
  assert.equal(hit.models["custom:test"], "Test");
  assert.equal(hit.modelList[0].name, "Test");
});

test("keeps cwd slots independent (including the empty-cwd slot)", () => {
  const storage = createStorage();
  writeCachedModels("/work/a", sample("A"), storage);
  writeCachedModels("/work/b", sample("B"), storage);
  writeCachedModels("", sample("Default"), storage);
  assert.equal(readCachedModels("/work/a", storage).modelList[0].name, "A");
  assert.equal(readCachedModels("/work/b", storage).modelList[0].name, "B");
  assert.equal(readCachedModels("", storage).modelList[0].name, "Default");
  assert.equal(readCachedModels("/work/c", storage), null);
});

test("returns null and removes the slot when older than max age", () => {
  const storage = createStorage({
    "pi-web:models-cache:/work/old": JSON.stringify({
      savedAt: Date.now() - MODELS_CLIENT_CACHE_MAX_AGE_MS - 1,
      data: sample(),
    }),
  });
  assert.equal(readCachedModels("/work/old", storage), null);
  assert.equal(storage.getItem("pi-web:models-cache:/work/old"), null);
  // expired slots in the index are cleared too
  assert.equal(storage.getItem("pi-web:models-cache:__index__"), JSON.stringify({}));
});

test("ignores corrupt JSON and wrong shapes", () => {
  const storage = createStorage({
    "pi-web:models-cache:/work/x": "{not json",
    "pi-web:models-cache:/work/y": JSON.stringify({ savedAt: Date.now(), data: { models: {} } }),
    "pi-web:models-cache:/work/z": JSON.stringify({ savedAt: Date.now(), data: { models: null, modelList: [] } }),
  });
  assert.equal(readCachedModels("/work/x", storage), null);
  assert.equal(readCachedModels("/work/y", storage), null);
  assert.equal(readCachedModels("/work/z", storage), null);
});

test("evicts the least recently written slot beyond the entry cap", () => {
  const storage = createStorage();
  // fill to the cap in order (savedAt monotonically non-decreasing; stable sort → earliest written evicted first)
  for (let i = 0; i < MODELS_CLIENT_CACHE_MAX_ENTRIES; i++) {
    writeCachedModels(`/work/${i}`, sample(String(i)), storage);
  }
  assert.ok(readCachedModels("/work/0", storage));
  // one more write triggers prune: the oldest /work/0 is evicted, the new slot survives
  writeCachedModels("/work/fresh", sample("fresh"), storage);
  assert.equal(readCachedModels("/work/fresh", storage)?.modelList[0].name, "fresh");
  assert.equal(readCachedModels("/work/0", storage), null);
  const index = JSON.parse(storage.getItem("pi-web:models-cache:__index__"));
  assert.ok(Object.keys(index).length <= MODELS_CLIENT_CACHE_MAX_ENTRIES);
});

test("skips writes beyond the byte cap", () => {
  const storage = createStorage();
  const huge = { models: {}, modelList: [], blob: "x".repeat(MODELS_CLIENT_CACHE_MAX_BYTES) };
  writeCachedModels("/work/huge", huge, storage);
  assert.equal(readCachedModels("/work/huge", storage), null);
});

test("readMostRecentCachedCwd returns the latest written cwd", () => {
  const storage = createStorage();
  assert.equal(readMostRecentCachedCwd(storage), null);
  writeCachedModels("/work/older", sample(), storage);
  writeCachedModels("/work/newer", sample(), storage);
  // set timestamps explicitly to avoid nondeterministic ordering of same-millisecond writes
  const index = JSON.parse(storage.getItem("pi-web:models-cache:__index__"));
  index["/work/older"] = 1;
  index["/work/newer"] = 2;
  storage.setItem("pi-web:models-cache:__index__", JSON.stringify(index));
  assert.equal(readMostRecentCachedCwd(storage), "/work/newer");
  writeCachedModels("", sample(), storage); // Date.now() is guaranteed larger than the fake values above
  assert.equal(readMostRecentCachedCwd(storage), "");
});

test("clearCachedModels removes every slot and the index", () => {
  const storage = createStorage();
  writeCachedModels("/work/a", sample(), storage);
  writeCachedModels("/work/b", sample(), storage);
  clearCachedModels(storage);
  assert.equal(readCachedModels("/work/a", storage), null);
  assert.equal(readCachedModels("/work/b", storage), null);
  assert.equal(storage.getItem("pi-web:models-cache:__index__"), null);
});

test("silently degrades without storage", () => {
  assert.equal(readCachedModels("/work/a", null), null);
  writeCachedModels("/work/a", sample(), null);
  clearCachedModels(null);
});

test("survives a storage whose setItem throws (quota/private mode)", () => {
  const storage = {
    values: new Map(),
    getItem(key) {
      return this.values.get(key) ?? null;
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem(key) {
      this.values.delete(key);
    },
  };
  writeCachedModels("/work/a", sample(), storage);
  assert.equal(readCachedModels("/work/a", storage), null);
});
