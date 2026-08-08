/**
 * Extension framework unit tests: loader + registry lifecycle, API dispatch,
 * middleware chain, asset path guard, manifest, reload.
 * Run: node --experimental-strip-types --test lib/ext/registry.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

async function loadSubject() {
  const { ExtRegistryImpl } = await import("./registry.ts");
  const { scanExtensionDirs, loadExtensionFromDir } = await import("./loader.ts");
  return { ExtRegistryImpl, scanExtensionDirs, loadExtensionFromDir };
}

const FAKE_CORE = {
  async listSessions() { return [{ id: "s1" }]; },
  async getRunningSessionIds() { return ["s1"]; },
  async getHomeDir() { return "/home/test"; },
};

function writeExt(root, id, entry) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), entry);
  return dir;
}

const EXT_ENTRY = `
const fs = require("node:fs");
const path = require("node:path");
export default {
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  client: "client/demo.mjs",
  server: {
    async startup(ctx) {
      fs.writeFileSync(path.join(ctx.dataDir, "started.txt"), "ok");
    },
    async shutdown(ctx) {
      fs.writeFileSync(path.join(ctx.dataDir, "stopped.txt"), "ok");
    },
    async api(req, ctx) {
      const [action] = ctx.path;
      if (action === "ping") return new Response(JSON.stringify({ pong: true, m: ctx.method, q: ctx.searchParams.get("q") }), { headers: { "content-type": "application/json" } });
      if (action === "boom") throw new Error("kaboom");
      if (action === "core") return new Response(JSON.stringify(await ctx.core.listSessions()), { headers: { "content-type": "application/json" } });
      return null;
    },
    async middleware(req) {
      if (new URL(req.url).pathname.startsWith("/demo-own")) {
        return { handled: true, response: new Response("owned") };
      }
      return { handled: false };
    },
  },
  ui: { toolbar: [{ id: "t1" }], i18n: { en: { "k": "v" } } },
};
`;

test("loader scans and loads extension directories", async () => {
  const { scanExtensionDirs, loadExtensionFromDir } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  try {
    writeExt(root, "demo", EXT_ENTRY);
    assert.deepEqual(scanExtensionDirs(root).length, 1);
    const ext = await loadExtensionFromDir(scanExtensionDirs(root)[0]);
    assert.ok(ext);
    assert.equal(ext.id, "demo");
    assert.equal(ext.client, "client/demo.mjs");
    assert.ok(ext.server?.api);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry lifecycle: loadAll + startup + shutdown with data dir", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  try {
    writeExt(root, "demo", EXT_ENTRY);
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, dataRootOverride: data });
    await reg.loadAll();
    assert.equal(reg.all().length, 1);
    assert.ok(reg.byId("demo"));
    await reg.startAll();
    assert.ok(existsSync(join(data, "demo", "started.txt")));
    await reg.shutdown();
    assert.ok(existsSync(join(data, "demo", "stopped.txt")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("registry: entry id mismatch is recorded as an error", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  try {
    writeExt(root, "mismatch", EXT_ENTRY); // dir name "mismatch" vs id "demo"
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, dataRootOverride: data });
    await reg.loadAll();
    assert.equal(reg.all().length, 0);
    assert.equal(reg.status().mismatch.loaded, false);
    assert.match(reg.status().mismatch.error, /does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("api dispatch: routing, core access, 404, error isolation", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  try {
    writeExt(root, "demo", EXT_ENTRY);
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, dataRootOverride: data });
    await reg.loadAll();

    const ok = await reg.api(new Request("http://x/api/extensions/demo/ping?q=hi", { method: "POST" }), ["demo", "ping"]);
    assert.equal(ok?.status, 200);
    assert.deepEqual(await ok.json(), { pong: true, m: "POST", q: "hi" });

    const coreRes = await reg.api(new Request("http://x/api/extensions/demo/core"), ["demo", "core"]);
    assert.deepEqual(await coreRes?.json(), [{ id: "s1" }]);

    // Unknown extension → null (route answers 404)
    assert.equal(await reg.api(new Request("http://x/"), ["nope", "ping"]), null);

    // Unknown action → null
    assert.equal(await reg.api(new Request("http://x/"), ["demo", "zzz"]), null);

    // Throwing handler → 500 with extension id, not a crash
    const boom = await reg.api(new Request("http://x/"), ["demo", "boom"]);
    assert.equal(boom?.status, 500);
    assert.match((await boom.json()).error, /\[demo\] kaboom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("middleware chain: handled + fallthrough", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  try {
    writeExt(root, "demo", EXT_ENTRY);
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, dataRootOverride: data });
    await reg.loadAll();
    const handled = await reg.middleware(new Request("http://x/demo-own/x"));
    assert.equal(handled.handled, true);
    if (handled.handled) assert.equal(handled.response.status, 200);
    const unhandled = await reg.middleware(new Request("http://x/api/whatever"));
    assert.deepEqual(unhandled, { handled: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("assetPath: allows files inside the extension dir, blocks traversal", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  try {
    writeExt(root, "demo", EXT_ENTRY);
    mkdirSync(join(root, "demo", "client"), { recursive: true });
    writeFileSync(join(root, "demo", "client", "demo.mjs"), "export default function register(ctx){}");
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, dataRootOverride: data });
    await reg.loadAll();
    const ok = reg.assetPath("demo", "client/demo.mjs");
    assert.ok(ok);
    assert.ok(existsSync(ok));
    assert.equal(reg.assetPath("demo", "../secret"), null);
    assert.equal(reg.assetPath("demo", "/etc/passwd"), null);
    assert.equal(reg.assetPath("demo", "client/../../x"), null);
    assert.equal(reg.assetPath("nope", "client/demo.mjs"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("manifest shape", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  try {
    writeExt(root, "demo", EXT_ENTRY);
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, dataRootOverride: data });
    await reg.loadAll();
    const manifest = reg.manifest();
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].clientUrl, "/api/extensions/demo/assets/client/demo.mjs");
    assert.deepEqual(manifest[0].ui?.toolbar, [{ id: "t1" }]);
    assert.deepEqual(manifest[0].ui?.i18n, { en: { k: "v" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("reload: shutdown → reload → startup again", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  try {
    writeExt(root, "demo", EXT_ENTRY);
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, dataRootOverride: data });
    await reg.loadAll();
    await reg.startAll();
    await reg.reload();
    assert.equal(reg.all().length, 1);
    assert.ok(existsSync(join(data, "demo", "stopped.txt")));
    assert.ok(readFileSync(join(data, "demo", "started.txt"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});
