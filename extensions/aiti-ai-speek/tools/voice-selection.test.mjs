// Regression tests for voice-selection persistence (speaker.js store).
//
// Bug being covered: /voices refreshes (settings open, initEngine, local ensure) used to prune
// the selected voice against the *edge* list unconditionally, so any local/clone voice id was
// reset to "default" on every settings open.
//
// The store is browser code, so we bundle it with esbuild into one ESM module and stub the few
// globals it touches at import time (localStorage / document / window / fetch / Audio / ...).
import { test } from "node:test";
import assert from "node:assert/strict";

function makeEnv() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const noop = () => {};
  const audio = class {
    constructor(src) { this.src = src; this.playbackRate = 1; }
    play() { return Promise.resolve(); }
    pause() {}
    load() {}
  };
  const EventSource = class {
    constructor(url) { this.url = url; }
    addEventListener() {}
    close() {}
  };
  const BroadcastChannel = class {
    constructor() { this.onmessage = null; }
    postMessage() {}
    close() {}
  };
  return {
    store,
    globals: {
      localStorage,
      window: {
        addEventListener: noop,
        removeEventListener: noop,
        matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
        speechSynthesis: { cancel: noop, speak: noop, getVoices: () => [] },
        isSecureContext: false,
        location: { hostname: "localhost" },
        innerWidth: 1200,
        innerHeight: 800,
      },
      document: {
        addEventListener: noop,
        removeEventListener: noop,
        hidden: false,
        hasFocus: () => true,
        querySelector: () => null,
        querySelectorAll: () => [],
      },
      navigator: { language: "zh-CN" },
      fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      Audio: audio,
      EventSource,
      BroadcastChannel,
      SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    },
  };
}

async function loadStore() {
  const esbuild = await import("esbuild");
  // Bundle so the data: URL module has no relative imports (speaker.js + toSpeechText.js + host-shim).
  const out = esbuild.buildSync({
    entryPoints: [new URL("../client/src/speaker.js", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(url);
}

const env = makeEnv();
for (const [k, v] of Object.entries(env.globals)) {
  try { globalThis[k] = v; } catch { /* read-only global */ }
}
const store = await loadStore();
const state = store.getState();

test("a local voice survives an edge /voices refresh", () => {
  store.setLocalStatus({ available: true, provider: "hojo-40m", baseUrl: "http://127.0.0.1:8768" });
  store.setLocalVoices([
    { id: "hojo_zh_f_01", label: "中文 · 女声 1" },
    { id: "hojo_zh_m_01", label: "中文 · 男声 1" },
  ]);
  store.setSettings({ engine: "local", voice: "hojo_zh_f_01" });
  assert.equal(store.resolvedEngine(), "local");

  // Simulate what /voices (settings open / initEngine) does: edge list refresh.
  store.setEdgeInfo(true, [{ id: "zh-CN-XiaoxiaoNeural", label: "晓晓" }, { id: "zh-CN-YunxiNeural", label: "云希" }]);

  assert.equal(state.settings.voice, "hojo_zh_f_01", "local voice must not be pruned by the edge list");
  assert.equal(JSON.parse(env.store.get("aiti-ai-speek:settings")).voice, "hojo_zh_f_01", "selection is persisted");
});

test("an edge voice survives a local voice refresh", () => {
  store.setSettings({ engine: "edge", voice: "zh-CN-YunxiNeural" });
  assert.equal(store.resolvedEngine(), "edge");
  store.setLocalVoices([{ id: "hojo_zh_m_01", label: "中文 · 男声 1" }]);
  assert.equal(state.settings.voice, "zh-CN-YunxiNeural");
});

test("switching to a provider with different voices clears the stale local id", () => {
  store.setSettings({ engine: "local", voice: "hojo_zh_f_01" });
  store.setLocalStatus({ available: true, provider: "hojo-80m", baseUrl: "http://127.0.0.1:8768" });
  // 80M has no built-in voices: the service returns only clone entries.
  store.setLocalVoices([{ id: "voice-abc12345", label: "我的声音 · 克隆", builtin: false }]);
  assert.equal(state.settings.voice, "");
});

test("a stale edge voice is still pruned while edge is playing", () => {
  store.setSettings({ engine: "edge", voice: "zh-CN-GoneNeural" });
  store.setEdgeInfo(true, [{ id: "zh-CN-XiaoxiaoNeural", label: "晓晓" }]);
  assert.equal(state.settings.voice, "");
});

test("engine=auto keeps the local voice when edge is unavailable", () => {
  env.store.delete("aiti-ai-speek:settings");
  store.setEdgeInfo(false, []);
  state.edgeAvailable = false;
  store.setLocalStatus({ available: true, provider: "hojo-40m" });
  store.setLocalVoices([{ id: "hojo_zh_m_01", label: "中文 · 男声 1" }]);
  store.setSettings({ engine: "auto", voice: "hojo_zh_m_01" });
  store.setEdgeInfo(false, []);
  assert.equal(store.resolvedEngine(), "local");
  assert.equal(state.settings.voice, "hojo_zh_m_01");
});

test("initEngine never overrides an explicit local choice on devices without Web Speech", async () => {
  // Mobile browsers often lack speechSynthesis: the engine must stay "local" (server-side),
  // not be forced to edge/browser on every page load (that looked like settings resetting).
  state.edgeAvailable = true;
  store.setSettings({ engine: "local", voice: "hojo_zh_f_02" });
  await store.initEngine();
  assert.equal(state.browserUnsupported, true, "stub window has no Web Speech");
  assert.equal(state.settings.engine, "local");
  assert.equal(state.settings.voice, "hojo_zh_f_02");
});

test("initEngine still moves auto/browser to a server engine when Web Speech is missing", async () => {
  state.edgeAvailable = true;
  store.setSettings({ engine: "auto", voice: "" });
  await store.initEngine();
  assert.equal(state.settings.engine, "edge");
});
