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

// Test isolation: point the jiti fsCache at a throwaway dir — the loader's persistent cache
// defaults to the real <webRoot()>/.cache/jiti, where tmp extensions' cache keys would
// accumulate orphan files on every run.
process.env.PI_WEB_JITI_CACHE_DIR ??= mkdtempSync(join(tmpdir(), "pi-jiti-cache-test-"));

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
  // The manifest embeds a content hash (?v=<sha256:12>) of the client file;
  // provide one so clientUrl carries a real hash (81b0de0).
  const clientDir = join(dir, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "demo.mjs"), "export default {}\n");
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
      fs.writeFileSync(path.join(ctx.configDir, "started.txt"), "ok");
    },
    async shutdown(ctx) {
      fs.writeFileSync(path.join(ctx.configDir, "stopped.txt"), "ok");
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
    // Hidden dirs (.git, .DS_Store-style) are not extensions.
    mkdirSync(join(root, ".git"));
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
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
    await reg.loadAll();
    assert.equal(reg.all().length, 1);
    assert.ok(reg.byId("demo"));
    await reg.startAll();
    assert.ok(existsSync(join(data, "demo", "config", "started.txt")));
    await reg.shutdown();
    assert.ok(existsSync(join(data, "demo", "config", "stopped.txt")));
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
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
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
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
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
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
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
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
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
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
    await reg.loadAll();
    const manifest = reg.manifest();
    assert.equal(manifest.length, 1);
    assert.match(manifest[0].clientUrl, /^\/api\/extensions\/demo\/assets\/client\/demo\.mjs\?v=[0-9a-f]{12}$/);
    assert.deepEqual(manifest[0].ui?.toolbar, [{ id: "t1" }]);
    assert.deepEqual(manifest[0].ui?.i18n, { en: { k: "v" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("manifest passes through extension-level and feature-level category (app-center)", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  try {
    writeExt(root, "demo", `export default {
  id: "demo", name: "Demo", version: "1.0.0", client: "client/demo.mjs",
  category: "system",
  features: [
    { id: "behavior.on", label: "On", category: "code" },
    { id: "behavior.plain", label: "Plain" },
  ],
};
`);
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
    await reg.loadAll();
    const m = reg.manifest()[0];
    assert.equal(m.category, "system");
    assert.equal(m.features.find((f) => f.id === "behavior.on").category, "code");
    // un-annotated features carry no category field (client resolution falls to extension-level/default)
    assert.equal("category" in m.features.find((f) => f.id === "behavior.plain"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("lazy-static diagnostics: no static slot entry flags, ui.clientLazyVia:\"service\" exempts", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const entry = (extra) => `export default {
  id: "demo", name: "Demo", version: "1.0.0", client: "client/demo.mjs",
  ui: { clientImmediately: false${extra} },
};
`;
  try {
    writeExt(root, "demo", entry(""));
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
    await reg.loadAll();
    assert.match(reg.loadFailures().find((f) => f.id === "demo")?.error ?? "", /lazy flag ineffective/);

    // service-delivered exemption: consumer deterministically ensureMaterialized (e.g. the app-center extension delivered via session-manager)
    writeExt(root, "demo", entry(", clientLazyVia: \"service\""));
    const reg2 = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
    await reg2.loadAll();
    assert.equal(reg2.loadFailures().find((f) => f.id === "demo"), undefined);
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
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
    await reg.loadAll();
    await reg.startAll();
    await reg.reload();
    assert.equal(reg.all().length, 1);
    assert.ok(existsSync(join(data, "demo", "config", "stopped.txt")));
    assert.ok(readFileSync(join(data, "demo", "config", "started.txt"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

// ---------- multi-root (user → extra → bundled) ----------

function writeMiniExt(root, id, version = "1.0.0") {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), `export default { id: "${id}", name: "${id}", version: "${version}" };\n`);
  // real extensions take their version from package.json (the version source for same-id arbitration); entry version is the fallback.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: id, version }));
  return dir;
}

function makeRoots() {
  const roots = {};
  roots.user = mkdtempSync(join(tmpdir(), "pi-user-"));
  roots.extraA = mkdtempSync(join(tmpdir(), "pi-extraA-"));
  roots.extraB = mkdtempSync(join(tmpdir(), "pi-extraB-"));
  roots.bundled = mkdtempSync(join(tmpdir(), "pi-bundled-"));
  roots.data = mkdtempSync(join(tmpdir(), "pi-data-"));
  return roots;
}

async function loadRegistryFor(roots) {
  const { ExtRegistryImpl } = await loadSubject();
  return new ExtRegistryImpl({
    core: FAKE_CORE,
    extensionsRootOverride: roots.user,
    extraExtensionsRootsOverride: [roots.extraA, roots.extraB],
    devExtensionsRootOverride: null,
    bundledExtensionsRootOverride: roots.bundled,
    dataRootOverride: roots.data,
  });
}

test("multi-root: bundled-only extension loads with source=bundled", async () => {
  const roots = makeRoots();
  try {
    writeMiniExt(roots.bundled, "demo");
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    assert.equal(reg.all().length, 1);
    const ext = reg.byId("demo");
    assert.equal(ext.source, "bundled");
    assert.ok(ext.dir.startsWith(roots.bundled));
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: user shadows bundled (same id; version and priority both favor user)", async () => {
  const roots = makeRoots();
  try {
    writeMiniExt(roots.user, "demo", "9.9.9");
    writeMiniExt(roots.bundled, "demo", "1.0.0");
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    assert.equal(reg.all().length, 1);
    const ext = reg.byId("demo");
    assert.equal(ext.source, "user");
    assert.equal(ext.version, "9.9.9");
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: extra loads when user empty, bundled shadows extra", async () => {
  const roots = makeRoots();
  try {
    writeMiniExt(roots.extraA, "demo", "2.0.0");
    writeMiniExt(roots.bundled, "demo", "1.0.0");
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    assert.equal(reg.all().length, 1);
    const ext = reg.byId("demo");
    assert.equal(ext.source, "extra");
    assert.equal(ext.version, "2.0.0");
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: user > extra > bundled priority", async () => {
  const roots = makeRoots();
  try {
    writeMiniExt(roots.user, "demo", "3.0.0");
    writeMiniExt(roots.extraA, "demo", "2.0.0");
    writeMiniExt(roots.bundled, "demo", "1.0.0");
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    assert.equal(reg.all().length, 1);
    const ext = reg.byId("demo");
    assert.equal(ext.source, "user");
    assert.equal(ext.version, "3.0.0");
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: higher version wins regardless of root priority (bundled beats user)", async () => {
  const roots = makeRoots();
  try {
    writeMiniExt(roots.user, "demo", "1.0.0");
    writeMiniExt(roots.bundled, "demo", "2.0.0"); // lower-priority root but higher version → version wins, bundled takes it
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    assert.equal(reg.all().length, 1);
    const ext = reg.byId("demo");
    assert.equal(ext.source, "bundled");
    assert.equal(ext.version, "2.0.0");
    assert.ok(ext.dir.startsWith(roots.bundled));
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: equal versions fall back to root priority (user > extraA > extraB)", async () => {
  const roots = makeRoots();
  try {
    writeMiniExt(roots.extraA, "demo", "2.0.0");
    writeMiniExt(roots.extraB, "demo", "2.0.0"); // equal versions → listed order (root priority) decides
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    const ext = reg.byId("demo");
    assert.equal(ext.source, "extra");
    assert.equal(ext.version, "2.0.0");
    assert.ok(ext.dir.startsWith(roots.extraA));
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: missing package.json version falls back to entry version (probe)", async () => {
  const roots = makeRoots();
  try {
    // user copy has no package.json (old-style extension): probed entry version 1.0.0 joins the arbitration
    writeExt(roots.user, "demo", EXT_ENTRY); // entry version 1.0.0
    writeMiniExt(roots.bundled, "demo", "0.9.0"); // package.json 0.9.0
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    const ext = reg.byId("demo");
    assert.equal(ext.source, "user"); // 1.0.0 > 0.9.0
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: unresolvable versions on both sides fall back to root priority", async () => {
  const roots = makeRoots();
  try {
    // neither side's version resolves (non-numeric segment) → unknown → root priority
    writeMiniExt(roots.bundled, "demo", "1.0.0");
    const dir = join(roots.user, "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "beta-1" }));
    writeFileSync(join(dir, "index.ts"), `export default { id: "demo", name: "demo", version: "beta-1" };\n`);
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    assert.equal(reg.byId("demo").source, "user");
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: broken high-priority entry fails fast, no fallback", async () => {
  const roots = makeRoots();
  try {
    mkdirSync(join(roots.user, "demo"), { recursive: true });
    writeFileSync(join(roots.user, "demo", "index.ts"), `throw new Error("broken entry");\n`);
    writeMiniExt(roots.bundled, "demo");
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    assert.equal(reg.all().length, 0);
    assert.equal(reg.status().demo.loaded, false);
    assert.match(reg.status().demo.error, /broken entry/);
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: bundled data dir + reload keeps shadowing", async () => {
  const roots = makeRoots();
  try {
    writeExt(roots.bundled, "demo", EXT_ENTRY); // startup writes into configDir
    writeMiniExt(roots.user, "demo", "9.0.0");
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    await reg.startAll();
    await reg.reload();
    assert.equal(reg.all().length, 1);
    assert.equal(reg.byId("demo").source, "user");
    // the bundled copy's startup was shadowed and never ran, but the data dir is still auto-created under the data root
    assert.ok(existsSync(join(roots.data, "demo")));
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: status + manifest expose roots and source", async () => {
  const roots = makeRoots();
  try {
    writeMiniExt(roots.bundled, "demo");
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    assert.equal(reg.extensionsRoot(), roots.user);
    assert.deepEqual(reg.extraExtensionsRoots(), [roots.extraA, roots.extraB]);
    assert.equal(reg.bundledExtensionsRoot(), roots.bundled);
    assert.equal(reg.status().demo.source, "bundled");
    assert.equal(reg.manifest()[0].source, "bundled");
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("loader version helpers: parse + compare (same-id shadowing source)", async () => {
  const { compareExtVersions } = await import("./loader.ts");
  assert.equal(compareExtVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareExtVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareExtVersions("1.2", "1.2.0"), 0); // missing segment padded with 0
  assert.equal(compareExtVersions("v2.0", "1.9.9"), 1); // v prefix stripped
  assert.equal(compareExtVersions("1.0.0-beta", "1.0.0"), -1); // prerelease < release
  assert.equal(compareExtVersions("1.0.0-beta", "1.0.0-alpha"), 1);
  assert.equal(compareExtVersions("beta-1", "1.0.0"), 0); // unresolvable → 0 (falls back to root priority)
  assert.equal(compareExtVersions(undefined, "1.0.0"), 0);
});

test("data-dir: extraExtensionsRoots parses comma list, trims, ignores blanks, dedupes", async () => {
  const { extraExtensionsRoots } = await import("./data-dir.ts");
  const a = mkdtempSync(join(tmpdir(), "pi-env-a-"));
  const b = mkdtempSync(join(tmpdir(), "pi-env-b-"));
  const prev = process.env.PI_WEB_EXTRA_EXTENSIONS_DIRS;
  try {
    process.env.PI_WEB_EXTRA_EXTENSIONS_DIRS = `${a}, ${b},, ${a}, ,`;
    assert.deepEqual(extraExtensionsRoots(), [a, b]);
    process.env.PI_WEB_EXTRA_EXTENSIONS_DIRS = "";
    assert.deepEqual(extraExtensionsRoots(), []);
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_EXTRA_EXTENSIONS_DIRS;
    else process.env.PI_WEB_EXTRA_EXTENSIONS_DIRS = prev;
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("multi-root: dev layer loads with source=dev, between extra and bundled", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const roots = makeRoots();
  try {
    writeMiniExt(roots.user, "a", "3.0.0");     // user
    writeMiniExt(roots.extraA, "b", "2.0.0");   // extra
    writeMiniExt(roots.bundled, "c", "1.0.0");  // bundled
    writeMiniExt(roots.bundled, "b", "1.0.0");  // bundled copy of b (shadowed by extra)
    writeMiniExt(roots.bundled, "d", "1.0.0");
    writeMiniExt(roots.extraA, "d", "2.0.0");   // extra copy of d (shadows bundled)
    const reg = new ExtRegistryImpl({
      core: FAKE_CORE,
      extensionsRootOverride: roots.user,
      extraExtensionsRootsOverride: [roots.extraA],
      devExtensionsRootOverride: roots.bundled,  // point the dev layer at the bundled dir to verify dev sits between extra and bundled
      bundledExtensionsRootOverride: roots.extraA,
      dataRootOverride: roots.data,
    });
    await reg.loadAll();
    const byId = Object.fromEntries(reg.all().map((e) => [e.id, e]));
    // user exists → user
    assert.equal(byId.a.source, "user");
    // extra exists → extra (same-named dev does not steal it)
    assert.equal(byId.b.source, "extra");
    // only dev → dev
    assert.equal(byId.c.source, "dev");
    assert.equal(byId.c.dir.startsWith(roots.bundled), true);
    // extra and bundled share the name with no user → extra
    assert.equal(byId.d.source, "extra");
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-root: dev layer auto-detects <pkgDir>/dev-exts; extra layer loads external dev dir", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const { devExtensionsRoot } = await import("./data-dir.ts");
  const roots = makeRoots();
  try {
    // the repo root no longer has a dev-exts dir (source moved out of this repo) → auto-detection should skip
    assert.equal(devExtensionsRoot(), null);
    // dev-layer override still usable (the channel for future in-repo dev extensions)
    writeMiniExt(roots.bundled, "dev-only");
    const regDev = new ExtRegistryImpl({
      core: FAKE_CORE,
      extensionsRootOverride: roots.user,
      extraExtensionsRootsOverride: [],
      devExtensionsRootOverride: roots.bundled,
      bundledExtensionsRootOverride: roots.extraA,
      dataRootOverride: roots.data,
    });
    await regDev.loadAll();
    assert.equal(regDev.byId("dev-only").source, "dev");
    // external dev extension dir (e.g. an out-of-repo dev-exts dir) injected via the extra middle layer: source = extra
    writeMiniExt(roots.bundled, "aiti-inject");
    const regExtra = new ExtRegistryImpl({
      core: FAKE_CORE,
      extensionsRootOverride: roots.user,
      extraExtensionsRootsOverride: [roots.bundled], // PI_WEB_EXTRA_EXTENSIONS_DIRS=<out-of-repo>/dev-exts
      devExtensionsRootOverride: null,
      bundledExtensionsRootOverride: roots.extraA,
      dataRootOverride: roots.data,
    });
    await regExtra.loadAll();
    const ext = regExtra.byId("aiti-inject");
    assert.ok(ext);
    assert.equal(ext.source, "extra");
    assert.ok(ext.dir.startsWith(roots.bundled));
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

// ── dependency & capability model (aiti-ext-deps-capabilities-plan.md P0-P2) ────────────────

/** Mini extension carrying the declarative fields (used by the dependency & capability model tests). */
function writeCapExt(root, id, version, extra = "") {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), `export default { id: "${id}", name: "${id}", version: "${version}"${extra ? ", " + extra : ""} };\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: id, version }));
  return dir;
}

test("deps: dependsOn resolves ext id / optional edge / missing; disabled target → inactive", async () => {
  const roots = makeRoots();
  try {
    writeCapExt(roots.user, "consumer", "1.0.0", `dependsOn: ["svc", "ghost"], optionalDependsOn: ["svc", "nope"]`);
    writeCapExt(roots.user, "svc", "1.0.0");
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    const st = reg.status().consumer;
    assert.deepEqual(st.dependsOn, ["svc", "ghost"]);
    assert.deepEqual(st.optionalDependsOn, ["svc", "nope"]);
    const byName = Object.fromEntries(st.depsResolved.map((d) => [d.name + ":" + (d.hard ? "h" : "s"), d]));
    // id hit: both hard/soft edges resolve to the ext svc
    assert.equal(byName["svc:h"].kind, "ext");
    assert.equal(byName["svc:h"].status, "ok");
    assert.equal(byName["svc:h"].hard, true);
    assert.equal(byName["svc:s"].kind, "ext");
    assert.equal(byName["svc:s"].hard, false);
    assert.equal(byName["nope:s"].kind, "cap"); // no dir and no capability → capability branch
    assert.equal(byName["nope:s"].status, "missing");
    assert.equal(byName["nope:s"].hard, false);
    assert.equal(byName["ghost:h"].kind, "cap");
    assert.equal(byName["ghost:h"].status, "missing");
    // target disabled: winners still has the candidate (existence) → inactive
    reg.setEnabled("svc", false);
    await reg.loadAll();
    const after = Object.fromEntries(reg.status().consumer.depsResolved.map((d) => [d.name + ":" + (d.hard ? "h" : "s"), d]));
    assert.equal(after["svc:h"].status, "inactive");
    assert.equal(after["svc:h"].kind, "ext");
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("caps: provides multi-provider resolution (version > id); missing capability surfaced in view", async () => {
  const roots = makeRoots();
  try {
    writeCapExt(roots.user, "prov-a", "2.0.0", `provides: ["cap.thing"]`);
    writeCapExt(roots.user, "prov-b", "1.0.0", `provides: ["cap.thing"]`);
    writeCapExt(roots.user, "consumer", "1.0.0", `dependsOn: ["cap.thing", "cap.absent"], optionalDependsOn: ["cap.thing"]`);
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    const st = reg.status().consumer;
    const byName = Object.fromEntries(st.depsResolved.map((d) => [d.name + ":" + (d.hard ? "h" : "s"), d]));
    // effective provider: newest semver (prov-a 2.0.0 > prov-b 1.0.0); one of multiple implementations is picked
    assert.equal(byName["cap.thing:h"].kind, "cap");
    assert.equal(byName["cap.thing:h"].target, "prov-a");
    assert.equal(byName["cap.thing:h"].status, "ok");
    assert.deepEqual([...byName["cap.thing:h"].providers].sort(), ["prov-a", "prov-b"]);
    // missing capability (appears only in depends) also has an entry in the capability view
    assert.equal(byName["cap.absent:h"].status, "missing");
    const caps = reg.statusPayload().capabilities;
    assert.equal(caps["cap.thing"].effective, "prov-a");
    assert.equal(caps["cap.thing"].providers.length, 2);
    // consumers: hard + optional both recorded; the missing capability is folded into the view
    assert.deepEqual(caps["cap.thing"].consumers, [{ extId: "consumer", hard: true }, { extId: "consumer", hard: false }]);
    assert.equal(caps["cap.absent"].effective, null);
    assert.deepEqual(caps["cap.absent"].providers, []);
    // same-id lexicographic tiebreak: providers of equal version
    writeCapExt(roots.user, "prov-c", "2.0.0", `provides: ["cap.tie"]`);
    writeCapExt(roots.user, "prov-a2", "2.0.0", `provides: ["cap.tie"]`);
    await reg.loadAll();
    assert.equal(reg.statusPayload().capabilities["cap.tie"].effective, "prov-a2");
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("caps: takeover provider wins over newer provides; capability pin overrides both; stale pin falls back", async () => {
  const roots = makeRoots();
  try {
    writeCapExt(roots.user, "prov-new", "9.0.0", `provides: ["cap.x"]`);
    writeCapExt(roots.user, "prov-take", "1.0.0", `takeover: ["cap.x"]`);
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    // takeover declarer wins (exclusive semantics); a newer version without a takeover declaration is not considered
    assert.equal(reg.statusPayload().capabilities["cap.x"].effective, "prov-take");
    const takeResolved = reg.status().prov_take ?? reg.status()["prov-take"];
    assert.deepEqual(takeResolved.takeoverResolved, [{ name: "cap.x", effective: true }]);
    // user-pinned capability provider > takeover
    reg.setPin("capability:cap.x", "prov-new");
    await reg.loadAll();
    const caps = reg.statusPayload().capabilities["cap.x"];
    assert.equal(caps.effective, "prov-new");
    assert.equal(caps.pinnedTo, "prov-new");
    const st = reg.status().consumer ?? {};
    // after pinning, status's depsResolved carries viaPin
    writeCapExt(roots.user, "consumer", "1.0.0", `dependsOn: ["cap.x"]`);
    await reg.loadAll();
    const dep = reg.status().consumer.depsResolved[0];
    assert.equal(dep.target, "prov-new");
    assert.equal(dep.viaPin, true);
    // pin pointing at a non-provider (stale) → ignored, back to auto (takeover wins)
    reg.setPin("capability:cap.x", "prov-gone");
    await reg.loadAll();
    assert.equal(reg.statusPayload().capabilities["cap.x"].effective, "prov-take");
    assert.equal(reg.statusPayload().capabilities["cap.x"].pinnedTo, undefined);
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("multi-source: version wins by default; source pin overrides; stale pin falls back; devPriority opt-in", async () => {
  const roots = makeRoots();
  try {
    const userDir = writeCapExt(roots.user, "demo", "1.0.0");
    writeCapExt(roots.bundled, "demo", "2.0.0");
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    // default: higher version wins (bundled 2.0.0), regardless of root hierarchy
    assert.equal(reg.byId("demo").source, "bundled");
    const group = reg.statusPayload().multiSource.demo;
    assert.equal(group.candidates.length, 2);
    assert.deepEqual(group.candidates.filter((c) => c.winner).map((c) => c.source), ["bundled"]);
    assert.equal(group.candidates.find((c) => c.source === "user").version, "1.0.0");
    // user pins the source (dir) > version
    reg.setPin("source:demo", userDir);
    await reg.loadAll();
    assert.equal(reg.byId("demo").source, "user");
    assert.equal(reg.statusPayload().pins.pins["source:demo"], userDir);
    // pin pointing at a no-longer-existing dir → ignored, back to auto
    reg.setPin("source:demo", "/nonexistent/dir");
    await reg.loadAll();
    assert.equal(reg.byId("demo").source, "bundled");
    // dev priority: off by default (existing contract: dev does not steal); once explicitly enabled the dev-root candidate wins over the version arbitration
    writeCapExt(roots.extraA, "dv", "1.0.0");
    writeCapExt(roots.bundled, "dv", "9.0.0");
    writeCapExt(roots.extraB, "dv", "0.1.0"); // dev layer has the lower version
    const { ExtRegistryImpl } = await loadSubject();
    const regDev = new ExtRegistryImpl({
      core: FAKE_CORE,
      extensionsRootOverride: roots.user,
      extraExtensionsRootsOverride: [roots.extraA],
      devExtensionsRootOverride: roots.extraB,
      bundledExtensionsRootOverride: roots.bundled,
      dataRootOverride: roots.data,
    });
    await regDev.loadAll();
    assert.equal(regDev.byId("dv").source, "bundled"); // dev priority off: higher version wins (9.0.0)
    regDev.setDevPriority(true);
    await regDev.loadAll();
    assert.equal(regDev.byId("dv").source, "dev"); // dev priority on: dev root wins outright
    assert.equal(regDev.statusPayload().pins.devPriority, true);
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("pins: persisted to <dataRoot>/ext-pins.json; clearExtPins cleans source + capability entries", async () => {
  const roots = makeRoots();
  try {
    writeCapExt(roots.user, "solo", "1.0.0", `provides: ["cap.s"]`);
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    reg.setPin("capability:cap.s", "solo");
    reg.setPin("source:solo", roots.user);
    const file = join(roots.data, "ext-pins.json");
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(persisted.pins["capability:cap.s"], "solo");
    assert.equal(persisted.pins["source:solo"], roots.user);
    reg.clearExtPins("solo");
    const cleaned = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(cleaned.pins["capability:cap.s"], undefined);
    assert.equal(cleaned.pins["source:solo"], undefined);
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("manifest + status: four declaration fields pass through (extman display data source)", async () => {
  const roots = makeRoots();
  try {
    writeCapExt(roots.user, "demo", "1.0.0", `dependsOn: ["cap.a"], optionalDependsOn: ["b"], provides: ["cap.p"], takeover: ["cap.t"]`);
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    const m = reg.manifest()[0];
    assert.deepEqual(m.dependsOn, ["cap.a"]);
    assert.deepEqual(m.optionalDependsOn, ["b"]);
    assert.deepEqual(m.provides, ["cap.p"]);
    assert.deepEqual(m.takeover, ["cap.t"]);
    const st = reg.status().demo;
    assert.deepEqual(st.capsProvides, ["cap.p"]);
    assert.deepEqual(st.capsTakeover, ["cap.t"]);
    assert.equal(st.depsResolved.length, 2);
    assert.equal(st.depsResolved[1].name, "b");
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

// ---- agent tools group gate (agentTools.enabled) ----
function writeGateExt(root, id, toolNames, features) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const tools = toolNames.map((n) => `{ name: "${n}", label: "${n}", description: "${n}", parameters: { type: "object", properties: {} }, async execute() { return { content: [] }; } }`).join(",\n        ");
  const feats = features.map((f) => `{ id: ${JSON.stringify(f.id)}${f.type ? `, type: ${JSON.stringify(f.type)}` : ""}${f.default !== undefined ? `, default: ${JSON.stringify(f.default)}` : ""} }`).join(",\n      ");
  writeFileSync(join(dir, "index.ts"), `export default {\n  id: "${id}", name: "${id}", version: "1.0.0",\n  features: [\n      ${feats}\n    ],\n  server: { agent: { agentTools() { return [\n        ${tools}\n      ]; } } },\n};\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: id, version: "1.0.0" }));
  return dir;
}

test("agentTools group gate: off → none injected; on → all pass (per-tool ignored); no gate → per-tool; forced → all pass", async () => {
  const roots = makeRoots();
  try {
    // extension with the group gate: gt_a per-tool default on, gt_b default off
    writeGateExt(roots.user, "gate-ext", ["gt_a", "gt_b"], [
      { id: "agentTools.enabled", type: "boolean", default: false },
      { id: "tool.gt_a", default: true },
      { id: "tool.gt_b", default: false },
    ]);
    // extension without the group gate: pure per-tool semantics
    writeGateExt(roots.user, "nongate-ext", ["nt_c", "nt_d"], [
      { id: "tool.nt_c", default: true },
      { id: "tool.nt_d", default: false },
    ]);
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();

    const names = (tools) => tools.map((t) => t.name).sort();
    const info = { sessionId: "s1", cwd: "/x" };

    // 1) default (group gate off, no explicit setting): gate-ext injects nothing —
    //    regression: before the fix, gt_a with default:true leaked through the per-tool branch.
    let tools = reg.collectAgentToolsWith(info);
    assert.deepEqual(names(tools), ["nt_c"]);
    assert.ok(!tools.some((t) => t.name === "gt_a"));
    assert.ok(!tools.some((t) => t.name === "gt_b"));

    // 2) gate on → all pass, per-tool ignored (gt_b with default:false also passes)
    reg.setFeatureFlag("gate-ext", "agentTools.enabled", true);
    tools = reg.collectAgentToolsWith(info);
    assert.deepEqual(names(tools), ["gt_a", "gt_b", "nt_c"]);

    // 3) gate back off → immediately none injected (featureEnabled is read live)
    reg.setFeatureFlag("gate-ext", "agentTools.enabled", false);
    tools = reg.collectAgentToolsWith(info);
    assert.deepEqual(names(tools), ["nt_c"]);

    // 4) forced (named by enableExtTools) → all pass despite the gate being off
    tools = reg.collectAgentToolsWith(info, ["gate-ext"]);
    assert.deepEqual(names(tools), ["gt_a", "gt_b", "nt_c"]);
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

test("data layering: ctx.configDir/stateDir/cacheDir in place + ctx.dataDir throws on access (breaking contract pinned)", async () => {
  const roots = makeRoots();
  try {
    const THROW_ENTRY = `
const fs = require("node:fs");
const path = require("node:path");
export default {
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  client: "client/demo.mjs",
  server: {
    async startup(ctx) {
      const cfgDir = ctx.configDir;
      const stateDir = ctx.stateDir;
      const cacheDir = ctx.cacheDir;
      const extRoot = path.dirname(cfgDir);
      if (path.basename(cfgDir) !== "config") throw new Error("configDir should be <extRoot>/config");
      if (stateDir !== path.join(extRoot, "state")) throw new Error("stateDir layout mismatch");
      if (cacheDir !== path.join(extRoot, "cache")) throw new Error("cacheDir layout mismatch");
      fs.writeFileSync(path.join(cfgDir, "cfg.txt"), "ok");
      fs.writeFileSync(path.join(stateDir, "s.txt"), "ok");
      fs.writeFileSync(path.join(cacheDir, "c.txt"), "ok");
      let threw = null;
      try { void ctx.dataDir; } catch (e) { threw = e; }
      if (!threw || !String(threw.message).includes("ctx.dataDir")) throw new Error("dataDir did not throw per contract: " + (threw && threw.message));
      fs.writeFileSync(path.join(cfgDir, "gate.txt"), threw.message);
    },
  },
};
`;
    writeExt(roots.user, "demo", THROW_ENTRY);
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    await reg.startAll();
    assert.ok(existsSync(join(roots.data, "demo", "config", "cfg.txt")), "configDir writable (three-dir symmetry: config/)");
    assert.ok(existsSync(join(roots.data, "demo", "state", "s.txt")), "stateDir writable and equals configDir/state");
    assert.ok(existsSync(join(roots.data, "demo", "cache", "c.txt")), "cacheDir writable and equals configDir/cache");
    assert.ok(existsSync(join(roots.data, "demo", "config", "gate.txt")), "dataDir getter throw message landed on disk");
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});

// ---- unified SSE port plan §3-A: startupPriority (higher starts first; shutdown is the symmetric reverse) ----

function writePriorityExt(root, id, priority, orderLog) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), `
const fs = require("node:fs");
export default {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(id)},
  version: "1.0.0",
  client: "client/demo.mjs",
  ${priority === 0 ? "" : `startupPriority: ${priority},`}
  server: {
    async startup() { fs.appendFileSync(${JSON.stringify(orderLog)}, "start:" + ${JSON.stringify(id)} + "\\n"); },
    async shutdown() { fs.appendFileSync(${JSON.stringify(orderLog)}, "stop:" + ${JSON.stringify(id)} + "\\n"); },
  },
};
`);
  const clientDir = join(dir, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "demo.mjs"), "export default {}\n");
}

test("startupPriority: startAll starts in descending order, shutdown is the symmetric reverse, bootGraph passes priority through", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const orderLog = join(mkdtempSync(join(tmpdir(), "pi-order-")), "order.log");
  try {
    // scan order (alphabetical) = a, bus, z; expected start order = bus(100) → z(50) → a(0), shutdown reversed
    writePriorityExt(root, "a", 0, orderLog);
    writePriorityExt(root, "bus", 100, orderLog);
    writePriorityExt(root, "z", 50, orderLog);
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
    await reg.loadAll();
    await reg.startAll();
    assert.equal(reg.all().length, 3);
    const started = readFileSync(orderLog, "utf8").trim().split("\n");
    assert.deepEqual(started, ["start:bus", "start:z", "start:a"], "startAll starts stably in descending priority order");
    await reg.shutdown();
    const stopped = readFileSync(orderLog, "utf8").trim().split("\n").slice(3);
    assert.deepEqual(stopped, ["stop:a", "stop:z", "stop:bus"], "shutdown is the symmetric reverse (lowest priority stops first)");
    const busEntry = reg.bootGraph().entries.find((e) => e.id === "bus");
    assert.equal(busEntry?.priority, 100, "bootGraph entry passes startupPriority through (frontend materialize priority)");
    const aEntry = reg.bootGraph().entries.find((e) => e.id === "a");
    assert.equal(aEntry?.priority, undefined, "priority 0 omitted (default semantics, clean graph row)");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(orderLog, { recursive: true, force: true });
  }
});

// ---- unified SSE port plan v2: startupById single-start first (boots the bus at the earliest point of the host startup sequence) ----

test("startupById: single-start first, startAll idempotent without duplication, ledger cleared after shutdown", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const orderLog = join(mkdtempSync(join(tmpdir(), "pi-order-")), "order.log");
  try {
    writePriorityExt(root, "bus", 100, orderLog);
    writePriorityExt(root, "zz", 0, orderLog);
    const reg = new ExtRegistryImpl({ core: FAKE_CORE, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
    await reg.loadAll();
    // single-start: the bus is ready before any batch startup (returns true)
    assert.equal(await reg.startupById("bus"), true);
    // absent extension silently skipped (returns false, no throw)
    assert.equal(await reg.startupById("no-such-ext"), false);
    // startAll: bus already started → not repeated; only zz is filled in
    await reg.startAll();
    const lines = readFileSync(orderLog, "utf8").trim().split("\n");
    assert.equal(lines.filter((l) => l === "start:bus").length, 1, "bus starts exactly once (idempotent ledger)");
    assert.ok(lines.includes("start:zz"), "remaining extensions are still started");
    // shutdown cycle closes out: ledger cleared (re-recorded next cycle)
    await reg.shutdown();
    assert.equal(await reg.startupById("no-such-ext"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(orderLog, { recursive: true, force: true });
  }
});

// ---- plan M: re-dispatch to live sessions after reload (subscription epochs) ----
// Plan: docs/pi-web-ext-reload-session-resubscribe-plan.md
// dispatchAgentSession opens a new epoch on every call (reclaiming the previous epoch's
// subscriptions first); after startAll, reload re-dispatches to live wrappers via
// reattachAgentSessions so extensions re-attach event subscriptions across hot reloads.

function writeAgentExt(root, id, selfUnsub = false) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), `
export default {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(id)},
  version: "1.0.0",
  client: "client/demo.mjs",
  server: {
    agent: {
      onAgentSession(info) {
        const g = globalThis;
        (g.__agentHookLog = g.__agentHookLog || []).push(info.sessionId);
        (g.__agentInfo = g.__agentInfo || {})[info.sessionId] = info;
        if (typeof info.subscribeEvent === "function") {
          const off = info.subscribeEvent(() => { (g.__agentEventLog = g.__agentEventLog || []).push(info.sessionId); });
          (g.__agentOffLog = g.__agentOffLog || []).push(off);
          ${selfUnsub ? `const selfOffs = (g.__agentSelfOff = g.__agentSelfOff || {});
          if (selfOffs[info.sessionId]) { try { selfOffs[info.sessionId](); } catch { /* ignore */ } }
          selfOffs[info.sessionId] = off;` : ""}
        }
      },
    },
  },
};
`);
  const clientDir = join(dir, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "demo.mjs"), "export default {}\n");
}

function makeAgentRegistry(ExtRegistryImpl, root, data) {
  return new ExtRegistryImpl({
    core: FAKE_CORE,
    extensionsRootOverride: root,
    extraExtensionsRootsOverride: [],
    devExtensionsRootOverride: null,
    bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")),
    dataRootOverride: data,
  });
}

function makeFakeAgentWrapper(sessionId, { alive = true, marked = true } = {}) {
  const state = { listeners: new Set(), subscribed: 0, released: 0 };
  const wrapper = {
    isAlive: () => alive,
    hasAgentSessionHooks: () => marked,
    toAgentSessionInfo: () => ({
      sessionId,
      cwd: "/tmp/" + sessionId,
      steer: async () => {},
      subscribeEvent: (l) => {
        state.subscribed += 1;
        state.listeners.add(l);
        return () => { state.released += 1; state.listeners.delete(l); };
      },
    }),
  };
  return { wrapper, state };
}

function cleanAgentGlobals(savedSessions) {
  const g = globalThis;
  if (savedSessions === undefined) delete g.__piSessions; else g.__piSessions = savedSessions;
  delete g.__agentHookLog;
  delete g.__agentEventLog;
  delete g.__agentOffLog;
  delete g.__agentSelfOff;
  delete g.__agentInfo;
}

test("agent hooks: reload re-dispatches dispatchAgentSession to live sessions and reclaims old subscriptions (subscription epochs)", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const g = globalThis;
  const savedSessions = g.__piSessions;
  try {
    writeAgentExt(root, "agent-demo");
    const reg = makeAgentRegistry(ExtRegistryImpl, root, data);
    await reg.loadAll();
    await reg.startAll();

    const { wrapper, state } = makeFakeAgentWrapper("s1", { alive: true, marked: true });
    g.__piSessions = new Map([["s1", wrapper]]);

    // first dispatch (simulating onAgentSession at session creation)
    reg.dispatchAgentSession(wrapper.toAgentSessionInfo());
    assert.deepEqual(g.__agentHookLog, ["s1"], "onAgentSession dispatched once");
    assert.equal(state.listeners.size, 1, "first dispatch establishes one subscription");
    assert.equal(g.__agentOffLog.length, 1, "epoch 1 records one unsubscribe");

    // reload → reattachAgentSessions re-dispatches
    await reg.reload();
    assert.deepEqual(g.__agentHookLog, ["s1", "s1"], "after reload, onAgentSession is re-dispatched to the live session");
    assert.equal(state.listeners.size, 1, "old epoch's subscription reclaimed → only the new epoch's one (no double delivery)");
    assert.equal(state.released, 1, "old subscription's unsubscribe was invoked");
    assert.equal(g.__agentOffLog.length, 2, "each of the two epochs recorded one unsubscribe");

    // the new subscription works
    for (const l of [...state.listeners]) l({ type: "message_end" });
    assert.deepEqual(g.__agentEventLog, ["s1"], "the new epoch's subscription receives the event");
  } finally {
    cleanAgentGlobals(savedSessions);
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("agent hooks: reload re-attach only targets live wrappers that were dispatched before (unmarked/destroyed are not dispatched)", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const g = globalThis;
  const savedSessions = g.__piSessions;
  try {
    writeAgentExt(root, "agent-demo");
    const reg = makeAgentRegistry(ExtRegistryImpl, root, data);
    await reg.loadAll();
    await reg.startAll();

    const marked = makeFakeAgentWrapper("s-marked", { alive: true, marked: true });
    const unmarked = makeFakeAgentWrapper("s-unmarked", { alive: true, marked: false });
    const dead = makeFakeAgentWrapper("s-dead", { alive: false, marked: true });
    g.__piSessions = new Map([
      ["s-marked", marked.wrapper],
      ["s-unmarked", unmarked.wrapper],
      ["s-dead", dead.wrapper],
    ]);

    await reg.reload();
    assert.deepEqual(g.__agentHookLog, ["s-marked"], "only live, previously-dispatched wrappers are re-attached");
    assert.equal(unmarked.state.listeners.size, 0, "never dispatched (subagents etc.) → not re-attached");
    assert.equal(dead.state.listeners.size, 0, "destroyed → not re-attached");
  } finally {
    cleanAgentGlobals(savedSessions);
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("agent hooks: dispatchAgentSessionEnd settles the ledger and reclaims subscriptions (re-dispatch with the same id is unaffected)", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const g = globalThis;
  const savedSessions = g.__piSessions;
  try {
    writeAgentExt(root, "agent-demo");
    const reg = makeAgentRegistry(ExtRegistryImpl, root, data);
    await reg.loadAll();
    await reg.startAll();

    const { wrapper, state } = makeFakeAgentWrapper("s1");
    reg.dispatchAgentSession(wrapper.toAgentSessionInfo());
    assert.equal(state.listeners.size, 1);

    reg.dispatchAgentSessionEnd("s1", "idle");
    assert.equal(state.listeners.size, 0, "end settles the ledger and reclaims the epoch's subscriptions");
    assert.equal(state.released, 1);

    reg.dispatchAgentSession(wrapper.toAgentSessionInfo());
    assert.equal(state.listeners.size, 1, "re-dispatch with the same id opens a new epoch normally");
    reg.dispatchAgentSessionEnd("s1", "idle");
    assert.equal(state.listeners.size, 0);
  } finally {
    cleanAgentGlobals(savedSessions);
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("agent hooks: extension self-unsubscribe (helper pattern) coexists idempotently with host epoch reclamation", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const g = globalThis;
  const savedSessions = g.__piSessions;
  try {
    writeAgentExt(root, "agent-demo", true); // selfUnsub: simulates the AI-helper extension's "unsubscribe old before subscribing new" pattern
    const reg = makeAgentRegistry(ExtRegistryImpl, root, data);
    await reg.loadAll();
    await reg.startAll();

    const { wrapper, state } = makeFakeAgentWrapper("s1");
    g.__piSessions = new Map([["s1", wrapper]]);

    reg.dispatchAgentSession(wrapper.toAgentSessionInfo());
    assert.equal(state.listeners.size, 1);
    assert.equal(state.released, 0, "first dispatch has no old subscription to release");

    await reg.reload();
    assert.deepEqual(g.__agentHookLog, ["s1", "s1"], "re-attached after reload");
    assert.equal(state.listeners.size, 1, "after host reclaim + extension self-unsubscribe, exactly one new subscription");
    assert.ok(state.released >= 2, "double unsubscribe is idempotent (host reclaim once + extension self-unsubscribe once), no throw");
  } finally {
    cleanAgentGlobals(savedSessions);
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("agent hooks: late cross-epoch subscriptions are unsubscribed immediately (not mixed into the new epoch; same after session end)", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const g = globalThis;
  const savedSessions = g.__piSessions;
  try {
    writeAgentExt(root, "agent-demo");
    const reg = makeAgentRegistry(ExtRegistryImpl, root, data);
    await reg.loadAll();
    await reg.startAll();

    const { wrapper, state } = makeFakeAgentWrapper("s1");
    g.__piSessions = new Map([["s1", wrapper]]);

    // epoch 1 → record that epoch's info; then open epoch 2 (reclaiming epoch 1's subscription)
    reg.dispatchAgentSession(wrapper.toAgentSessionInfo());
    const infoEpoch1 = g.__agentInfo["s1"];
    reg.dispatchAgentSession(wrapper.toAgentSessionInfo());
    assert.equal(state.listeners.size, 1, "epoch 2's subscription is in place");

    // epoch 1's extension closure subscribes late, asynchronously → unsubscribed immediately, not mixed into epoch 2
    const before = state.released;
    infoEpoch1.subscribeEvent(() => {});
    assert.equal(state.released, before + 1, "the late cross-epoch subscription is unsubscribed immediately");
    assert.equal(state.listeners.size, 1, "still only epoch 2's one subscription");

    // late again after the session ended → likewise unsubscribed immediately
    const infoEpoch2 = g.__agentInfo["s1"];
    reg.dispatchAgentSessionEnd("s1", "idle");
    const beforeEnd = state.released;
    infoEpoch2.subscribeEvent(() => {});
    assert.equal(state.released, beforeEnd + 1, "the late subscription after session end is unsubscribed immediately");
    assert.equal(state.listeners.size, 0);
  } finally {
    cleanAgentGlobals(savedSessions);
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("agent hooks: non-standard __piSessions objects (mock/{} / null) do not disturb re-attach and do not throw", async () => {
  const { ExtRegistryImpl } = await loadSubject();
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const g = globalThis;
  const savedSessions = g.__piSessions;
  try {
    writeAgentExt(root, "agent-demo");
    const reg = makeAgentRegistry(ExtRegistryImpl, root, data);
    await reg.loadAll();
    await reg.startAll();

    const good = makeFakeAgentWrapper("s-good");
    g.__piSessions = new Map([
      ["s-good", good.wrapper],
      ["s-plain", {}],
      ["s-null", null],
      ["s-running-only", { isRunning: () => true }],
    ]);

    await reg.reload();
    assert.deepEqual(g.__agentHookLog, ["s-good"], "only standard, marked wrappers are re-attached");
    assert.equal(good.state.listeners.size, 1);
  } finally {
    cleanAgentGlobals(savedSessions);
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});
