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
