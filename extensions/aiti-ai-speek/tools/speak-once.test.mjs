// Tests for the one-shot announcement API (cross-extension `aiti-ai-speek.speak`).
// The store is browser code, so it is bundled with esbuild and run against stubbed globals.
import { test } from "node:test";
import assert from "node:assert/strict";

function makeEnv() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const spoken = [];
  const audioSrcs = [];
  class FakeAudio {
    constructor(src) { this.src = src; audioSrcs.push(src); this.playbackRate = 1; }
    play() { setTimeout(() => { try { this.onended && this.onended(); } catch { /* noop */ } }, 0); return Promise.resolve(); }
    pause() {}
    load() {}
  }
  const speech = {
    cancel() {},
    getVoices() { return []; },
    speak(u) { spoken.push(u.text); setTimeout(() => { try { u.onend && u.onend(); } catch { /* noop */ } }, 0); },
  };
  const noop = () => {};
  return {
    store,
    spoken,
    audioSrcs,
    globals: {
      localStorage,
      window: {
        addEventListener: noop,
        removeEventListener: noop,
        matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
        speechSynthesis: speech,
        isSecureContext: false,
        location: { hostname: "localhost" },
        innerWidth: 1200,
        innerHeight: 800,
        SpeechSynthesisUtterance: undefined,
      },
      document: { addEventListener: noop, removeEventListener: noop, hidden: false, hasFocus: () => true, querySelector: () => null, querySelectorAll: () => [] },
      navigator: { language: "zh-CN" },
      Audio: FakeAudio,
      EventSource: class { constructor(url) { this.url = url; } addEventListener() {} close() {} },
      BroadcastChannel: class { constructor() { this.onmessage = null; } postMessage() {} close() {} },
      SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    },
  };
}

async function loadStore() {
  const esbuild = await import("esbuild");
  const out = esbuild.buildSync({
    entryPoints: [new URL("../client/src/speaker.js", import.meta.url).pathname],
    bundle: true, write: false, format: "esm", platform: "node", target: "node20", logLevel: "silent",
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

const env = makeEnv();
for (const [k, v] of Object.entries(env.globals)) {
  try { globalThis[k] = v; } catch { /* read-only global */ }
}
const store = await loadStore();
const state = store.getState();

/** Route stub fetches: batch/ensure/voices are the only endpoints announcements touch. */
function stubFetch(routes) {
  const prev = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init && init.body ? String(init.body) : "" });
    for (const [pattern, handler] of routes) {
      if (u.includes(pattern)) {
        const body = await handler({ url: u, init });
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

test("empty text is rejected without touching any engine", async () => {
  const r = await store.speakOnce("   ");
  assert.equal(r.ok, false);
  assert.equal(r.code, "empty");
});

test("browser engine speaks through speechSynthesis", async () => {
  state.browserUnsupported = false;
  state.edgeAvailable = false;
  state.localStatus = "stopped";
  store.setSettings({ engine: "browser", voice: "" });
  const before = env.spoken.length;
  const r = await store.speakOnce("你好，任务完成了。", { engine: "browser" });
  assert.equal(r.ok, true);
  assert.equal(r.engine, "browser");
  assert.ok(env.spoken.length > before, "speechSynthesis.speak was called");
});

test("local engine serves from the TTS cache and plays it", async () => {
  store.setLocalStatus({ available: true, provider: "hojo-40m", baseUrl: "http://127.0.0.1:8768" });
  store.setSettings({ engine: "local", voice: "hojo_zh_f_02" });
  const stub = stubFetch([["/tts-batch", () => ({ ok: true, engine: "local", items: [{ text: "x", key: "a".repeat(64), cached: true, ext: ".wav" }] })]]);
  try {
    const before = env.audioSrcs.length;
    const r = await store.speakOnce("本地播放测试。");
    assert.equal(r.ok, true);
    assert.equal(r.engine, "local");
    const batch = stub.calls.find((c) => c.url.includes("/tts-batch"));
    assert.ok(batch, "batch endpoint hit");
    assert.match(batch.body, /"engine":"local"/);
    assert.match(batch.body, /hojo_zh_f_02/);
    assert.ok(env.audioSrcs.length > before, "an <audio> source was created");
    assert.match(env.audioSrcs[env.audioSrcs.length - 1], /tts-cache\/a{64}/);
  } finally { stub.restore(); }
});

test("a failed local start opens the settings panel and reports the failure", async () => {
  store.setLocalStatus({ available: false, status: "stopped", provider: "hojo-40m" });
  state.localStatus = "stopped";
  store.setSettings({ engine: "local", voice: "" });
  let opened = 0;
  store.setSettingsOpener(() => { opened++; });
  const stub = stubFetch([
    ["/tts/ensure", () => ({ ok: true, running: false, starting: false, error: "venv creation failed" })],
  ]);
  try {
    const r = await store.speakOnce("启动失败应该弹面板。", { engine: "local" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "service-start-failed");
    assert.match(r.error, /venv creation failed/);
    assert.equal(opened, 1, "settings panel opened exactly once");
    assert.equal(state.localStatus, "error");
    assert.ok(state.failToast && state.failToast.text, "a toast was raised");
  } finally { stub.restore(); }
});

test("ensureSpeak reports a missing edge backend without starting anything", async () => {
  state.edgeAvailable = false;
  const r = await store.ensureSpeak({ engine: "edge" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "edge-unavailable");
});

test("speakStatus exposes the engine snapshot for consumers", () => {
  state.edgeAvailable = true;
  store.setSettings({ engine: "auto" });
  const st = store.speakStatus();
  assert.equal(st.engine, "edge");
  assert.equal(typeof st.local.status, "string");
  assert.equal(st.edgeAvailable, true);
});
