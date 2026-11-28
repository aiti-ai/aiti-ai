import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

/**
 * The image-generation module talks to `getModelRuntimeWithExtensions()`. These
 * tests replace that module with a fake runtime so the ledger, validation and
 * result flattening are covered without building a real SDK runtime.
 */
async function loadWithRuntime(fakeRuntime) {
  const mod = await jiti.import("./image-generation.ts");
  // jiti shares one module instance; patch the resolver the module captured.
  mod.__setTestRuntime?.(fakeRuntime);
  return mod;
}

function makeRuntime(overrides = {}) {
  const registered = new Map();
  const models = [
    { provider: "builtin-img", id: "img-one", name: "Img One", api: "test-images", output: ["image"] },
    { provider: "builtin-img", id: "img-two", api: "test-images", output: ["image", "text"] },
  ];
  return {
    registered,
    getModelsOfType: (type) => (type === "image" ? models : []),
    getAvailableOfType: async (type) => (type === "image" ? models.slice(0, 1) : []),
    registerProvider: (name, config) => { registered.set(name, config); },
    unregisterProvider: (name) => { registered.delete(name); },
    generateImages: async () => ({
      api: "test-images",
      provider: "builtin-img",
      model: "img-one",
      output: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
      stopReason: "stop",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      timestamp: Date.now(),
    }),
    ...overrides,
  };
}

test("image-generation: validation rejects non-image models", async () => {
  const mod = await jiti.import("./image-generation.ts");
  mod.resetImageProviders();
  const bad = await mod.registerImageProvider("demo-ext", "bad", { models: [{ id: "x", type: "chat", api: "openai-completions" }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /type must be "image"/);
  const noApi = await mod.registerImageProvider("demo-ext", "bad2", { models: [{ id: "x", type: "image" }] });
  assert.equal(noApi.ok, false);
  assert.match(noApi.error, /api is required/);
});

test("image-generation: register ledgers per extension and replays", async () => {
  const mod = await jiti.import("./image-generation.ts");
  mod.resetImageProviders();
  const config = {
    baseUrl: "https://example.test/v1",
    apiKey: "test-key-placeholder",
    models: [{ type: "image", id: "cogview-test", api: "zhipu-images", output: ["image"] }],
    images: { "zhipu-images": { generateImages: async () => ({}) } },
  };
  const runtime = makeRuntime();
  mod.__setTestRuntime?.(runtime);
  const reg = await mod.registerImageProvider("video-studio", "vs-zhipu", config);
  assert.equal(reg.ok, true, reg.error);
  assert.deepEqual(mod.imageProviderRegistrations(), [{ extId: "video-studio", name: "vs-zhipu" }]);
  assert.equal(runtime.registered.size, 1);

  // Replay into a fresh runtime (the TTL / reload path).
  const replayed = [];
  const n = mod.replayImageProviders({ registerProvider: (name, cfg) => replayed.push([name, cfg]) });
  assert.equal(n, 1);
  assert.equal(replayed[0][0], "vs-zhipu");

  const removed = await mod.unregisterImageProviders("video-studio");
  assert.deepEqual(removed, ["vs-zhipu"]);
  assert.deepEqual(mod.imageProviderRegistrations(), []);
  assert.equal(runtime.registered.size, 0);
});

test("image-generation: listImageModels merges availability", async () => {
  const mod = await jiti.import("./image-generation.ts");
  mod.resetImageProviders();
  mod.__setTestRuntime?.(makeRuntime());
  const rows = await mod.listImageModels();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].available, true);
  assert.equal(rows[1].available, false);
  assert.deepEqual(rows[1].output, ["image", "text"]);
});

test("image-generation: generateImages loops n and merges usage", async () => {
  const mod = await jiti.import("./image-generation.ts");
  mod.resetImageProviders();
  let calls = 0;
  const runtime = makeRuntime({
    generateImages: async () => {
      calls++;
      return {
        api: "test-images", provider: "builtin-img", model: "img-one",
        output: [{ type: "image", mimeType: "image/png", data: `A${calls}` }, { type: "text", text: "note" }],
        stopReason: "stop",
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
        timestamp: Date.now(),
      };
    },
  });
  mod.__setTestRuntime?.(runtime);
  const r = await mod.generateImages({ prompt: "a cat", n: 3 });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls, 3);
  assert.equal(r.images.length, 3);
  assert.deepEqual(r.images.map((i) => i.data), ["A1", "A2", "A3"]);
  assert.deepEqual(r.texts, ["note", "note", "note"]);
  assert.deepEqual(r.usage, { input: 6, output: 9, cacheRead: 0, cacheWrite: 0 });
});

test("image-generation: failures flatten to ok=false without throwing", async () => {
  const mod = await jiti.import("./image-generation.ts");
  mod.resetImageProviders();
  mod.__setTestRuntime?.(makeRuntime({
    generateImages: async () => ({
      api: "test-images", provider: "builtin-img", model: "img-one",
      output: [], stopReason: "error", errorMessage: "upstream 429", timestamp: Date.now(),
    }),
  }));
  const r = await mod.generateImages({ prompt: "x" });
  assert.equal(r.ok, false);
  assert.match(r.error, /429/);
  assert.deepEqual(r.images, []);
});

test("image-generation: unknown explicit model reports the reference", async () => {
  const mod = await jiti.import("./image-generation.ts");
  mod.resetImageProviders();
  mod.__setTestRuntime?.(makeRuntime());
  const r = await mod.generateImages({ provider: "nope", modelId: "missing", prompt: "x" });
  assert.equal(r.ok, false);
  assert.match(r.error, /image model not found: nope\/missing/);
});

test("image-generation: prompt or images is required", async () => {
  const mod = await jiti.import("./image-generation.ts");
  mod.resetImageProviders();
  mod.__setTestRuntime?.(makeRuntime());
  const r = await mod.generateImages({});
  assert.equal(r.ok, false);
  assert.match(r.error, /prompt or images required/);
});
