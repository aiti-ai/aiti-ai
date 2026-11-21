// Wiring tests for the cross-extension backend service `aiti-ai-speek.tts`.
// index.ts is bundled standalone and started with a stub host context, so the service is
// exercised in-process (no pi-web, no network, no child processes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const esbuild = await import("esbuild");
const out = esbuild.buildSync({
  entryPoints: [new URL("../index.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["node:*"],
  logLevel: "silent",
});
const ext = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

const root = mkdtempSync(join(tmpdir(), "speek-svc-"));
const configDir = join(root, "config");
const cacheDir = join(root, "cache");
const stateDir = join(root, "state");
mkdirSync(configDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });

// Network-free: the status probe must not touch the real 127.0.0.1:8768 on this machine.
const prevFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("offline (test)"); };

const provided = {};
await ext.default.server.startup({
  configDir,
  cacheDir,
  stateDir,
  features: { get: () => undefined },
  services: { provide: (name, impl) => { provided[name] = impl; } },
});

const svc = provided["aiti-ai-speek.tts"];

test("backend service is provided under the documented key with its full surface", () => {
  assert.ok(svc, "aiti-ai-speek.tts must be provided at startup");
  for (const m of ["ensure", "status", "stop", "restart", "synthesize", "voices", "readCached", "baseUrl"]) {
    assert.equal(typeof svc[m], "function", `missing method ${m}`);
  }
  assert.equal(svc.version, 1);
  assert.deepEqual(svc.panel, { extId: "aiti-ai-speek", dialog: "settings", localFeature: "tts.local" });
});

test("synthesize rejects an empty batch without probing/starting anything", async () => {
  const r = await svc.synthesize({ texts: ["   "] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad-input");
  assert.deepEqual(r.items, []);
});

test("status degrades to stopped when the service is unreachable", async () => {
  const st = await svc.status();
  assert.equal(st.running, false);
  assert.equal(st.status, "stopped");
  assert.equal(st.provider, "hojo-40m"); // feature default
  assert.match(st.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("readCached serves a cached file and rejects junk keys", async () => {
  const key = "b".repeat(64);
  const file = join(configDir, "cache", "tts-cache", key + ".wav");
  mkdirSync(join(configDir, "cache", "tts-cache"), { recursive: true });
  writeFileSync(file, Buffer.from("RIFFdata"));
  const hit = await svc.readCached(key);
  assert.ok(hit);
  assert.equal(hit.ext, ".wav");
  assert.equal(hit.contentType, "audio/wav");
  assert.equal(hit.buffer.toString(), "RIFFdata");
  assert.equal(await svc.readCached("../etc/passwd"), null);
  assert.equal(await svc.readCached("c".repeat(64)), null);
});

test("cleanup restores the global fetch", () => {
  globalThis.fetch = prevFetch;
  rmSync(root, { recursive: true, force: true });
});

// ── voice management handler (multipart) ───────────────────────────────────────────────────
function sineWav(seconds = 3, rate = 24000) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii"); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function callApi(method, path, { body, form } = {}) {
  const url = `http://internal/api/extensions/aiti-ai-speek/${path}`;
  const init = { method };
  if (form) init.body = form;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  const res = await ext.default.server.api(new Request(url, init), {
    method, path: path.split("/"), searchParams: new URL(url).searchParams,
    configDir, cacheDir, stateDir, core: {}, services: { get: () => undefined },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function voiceForm(name, provider) {
  const fd = new FormData();
  fd.append("name", name);
  fd.append("refText", "这是一段用于克隆的参考文本。");
  fd.append("language", "Chinese");
  fd.append("provider", provider);
  fd.append("audio", new File([sineWav()], "ref.wav", { type: "audio/wav" }));
  return fd;
}

test("voice create: rejects non-clone providers, then stores, then refuses duplicates", async () => {
  const bad = await callApi("POST", "tts/voices", { form: voiceForm("demo", "hojo-40m") });
  assert.equal(bad.status, 400);
  assert.match(String(bad.json.error), /does not support voice cloning/);

  const ok = await callApi("POST", "tts/voices", { form: voiceForm("Demo Voice", "hojo-80m") });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.voice.id, "demo-voice");

  const dup = await callApi("POST", "tts/voices", { form: voiceForm("Demo Voice", "hojo-80m") });
  assert.equal(dup.status, 409);
  assert.match(String(dup.json.error), /already exists/);
});

test("voice delete: refuses unknown ids and bad keys", async () => {
  const del = await callApi("DELETE", "tts/voices/demo-voice");
  assert.equal(del.status, 200);
  const again = await callApi("DELETE", "tts/voices/demo-voice");
  assert.equal(again.status, 404);
  const bad = await callApi("DELETE", "tts/voices/..%2Fescape");
  assert.ok([400, 404].includes(bad.status), `unexpected status ${bad.status}`);
});
