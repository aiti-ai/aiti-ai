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

// 测试隔离：jiti fsCache 指向一次性目录——loader 的持久缓存默认落在真实
// <webRoot()>/.cache/jiti，tmp 扩展的缓存键每次运行都会积累孤儿文件。
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
    assert.ok(existsSync(join(data, "demo", "stopped.txt")));
    assert.ok(readFileSync(join(data, "demo", "started.txt"), "utf8"));
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
  // 真实扩展的版本号以 package.json 为准（同名裁决的版本源）；entry version 是兑底。
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
    writeMiniExt(roots.bundled, "demo", "2.0.0"); // 低优先级根但版本更高 → 版本优先，bundled 胜
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
    writeMiniExt(roots.extraB, "demo", "2.0.0"); // 同版本 → 列出顺序（根优先级）裁决
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
    // user 版无 package.json（老式扩展）：探测 entry version 1.0.0 参与裁决
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
    // 双方版本都无法解析（非数字段）→ 未知 → 根优先级
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
    writeExt(roots.bundled, "demo", EXT_ENTRY); // startup writes into dataDir
    writeMiniExt(roots.user, "demo", "9.0.0");
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();
    await reg.startAll();
    await reg.reload();
    assert.equal(reg.all().length, 1);
    assert.equal(reg.byId("demo").source, "user");
    // bundled 版 startup 被遮蔽没跑，但数据目录仍自动创建在 data 根
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
  assert.equal(compareExtVersions("1.2", "1.2.0"), 0); // 缺段补 0
  assert.equal(compareExtVersions("v2.0", "1.9.9"), 1); // v 前缀剥离
  assert.equal(compareExtVersions("1.0.0-beta", "1.0.0"), -1); // 预发布 < 正式
  assert.equal(compareExtVersions("1.0.0-beta", "1.0.0-alpha"), 1);
  assert.equal(compareExtVersions("beta-1", "1.0.0"), 0); // 不可解析 → 0（回退根优先级）
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
    writeMiniExt(roots.bundled, "b", "1.0.0");  // bundled 版 b（被 extra 遮蔽）
    writeMiniExt(roots.bundled, "d", "1.0.0");
    writeMiniExt(roots.extraA, "d", "2.0.0");   // extra 版 d（遮蔽 bundled）
    const reg = new ExtRegistryImpl({
      core: FAKE_CORE,
      extensionsRootOverride: roots.user,
      extraExtensionsRootsOverride: [roots.extraA],
      devExtensionsRootOverride: roots.bundled,  // 把 dev 层指到 bundled 目录，验证 dev 在 extra 与 bundled 之间
      bundledExtensionsRootOverride: roots.extraA,
      dataRootOverride: roots.data,
    });
    await reg.loadAll();
    const byId = Object.fromEntries(reg.all().map((e) => [e.id, e]));
    // user 存在 → user
    assert.equal(byId.a.source, "user");
    // extra 存在 → extra（dev 同名不抢）
    assert.equal(byId.b.source, "extra");
    // 只有 dev → dev
    assert.equal(byId.c.source, "dev");
    assert.equal(byId.c.dir.startsWith(roots.bundled), true);
    // extra 与 bundled 同名且无 user → extra
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
    // 仓库根已无 dev-exts（源码移入 aiti-ai）→ 自动检测应跳过
    assert.equal(devExtensionsRoot(), null);
    // dev 层 override 仍可用（未来仓库内 dev 扩展的通道）
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
    // 外部 dev 扩展目录（如 aiti-ai/dev-exts）经 extra 中间层注入：source = extra
    writeMiniExt(roots.bundled, "aiti-inject");
    const regExtra = new ExtRegistryImpl({
      core: FAKE_CORE,
      extensionsRootOverride: roots.user,
      extraExtensionsRootsOverride: [roots.bundled], // PI_WEB_EXTRA_EXTENSIONS_DIRS=<aiti-ai>/dev-exts
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

// ── 依赖与能力模型（aiti-ext-deps-capabilities-plan.md P0-P2）────────────────

/** 带声明扩展字段的迷你扩展（依赖与能力模型测试用）。 */
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
    // id 命中：hard/soft 两条边都解析到扩展 svc
    assert.equal(byName["svc:h"].kind, "ext");
    assert.equal(byName["svc:h"].status, "ok");
    assert.equal(byName["svc:h"].hard, true);
    assert.equal(byName["svc:s"].kind, "ext");
    assert.equal(byName["svc:s"].hard, false);
    assert.equal(byName["nope:s"].kind, "cap"); // 无目录无能力 → 能力分支
    assert.equal(byName["nope:s"].status, "missing");
    assert.equal(byName["nope:s"].hard, false);
    assert.equal(byName["ghost:h"].kind, "cap");
    assert.equal(byName["ghost:h"].status, "missing");
    // 目标被禁用：winners 仍有候选（存在性）→ inactive
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
    // 生效提供者：semver 最新者（prov-a 2.0.0 > prov-b 1.0.0）；多实现取其一
    assert.equal(byName["cap.thing:h"].kind, "cap");
    assert.equal(byName["cap.thing:h"].target, "prov-a");
    assert.equal(byName["cap.thing:h"].status, "ok");
    assert.deepEqual([...byName["cap.thing:h"].providers].sort(), ["prov-a", "prov-b"]);
    // missing 能力（只在 depends 里出现）也在能力视图有条目
    assert.equal(byName["cap.absent:h"].status, "missing");
    const caps = reg.statusPayload().capabilities;
    assert.equal(caps["cap.thing"].effective, "prov-a");
    assert.equal(caps["cap.thing"].providers.length, 2);
    // 消费方：硬 + 可选都记；missing 能力收编进视图
    assert.deepEqual(caps["cap.thing"].consumers, [{ extId: "consumer", hard: true }, { extId: "consumer", hard: false }]);
    assert.equal(caps["cap.absent"].effective, null);
    assert.deepEqual(caps["cap.absent"].providers, []);
    // 同 id 字典序兑底：同版本提供者
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
    // takeover 声明者优先（独占语义），版本更新但未声明 takeover 的不看
    assert.equal(reg.statusPayload().capabilities["cap.x"].effective, "prov-take");
    const takeResolved = reg.status().prov_take ?? reg.status()["prov-take"];
    assert.deepEqual(takeResolved.takeoverResolved, [{ name: "cap.x", effective: true }]);
    // 用户 pin 能力提供者 > takeover
    reg.setPin("capability:cap.x", "prov-new");
    await reg.loadAll();
    const caps = reg.statusPayload().capabilities["cap.x"];
    assert.equal(caps.effective, "prov-new");
    assert.equal(caps.pinnedTo, "prov-new");
    const st = reg.status().consumer ?? {};
    // pin 后 status 的 depsResolved 带 viaPin
    writeCapExt(roots.user, "consumer", "1.0.0", `dependsOn: ["cap.x"]`);
    await reg.loadAll();
    const dep = reg.status().consumer.depsResolved[0];
    assert.equal(dep.target, "prov-new");
    assert.equal(dep.viaPin, true);
    // pin 指向非提供者（失效）→ 忽略回自动（takeover 胜出）
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
    // 默认：版本高者胜（bundled 2.0.0），与根层次无关
    assert.equal(reg.byId("demo").source, "bundled");
    const group = reg.statusPayload().multiSource.demo;
    assert.equal(group.candidates.length, 2);
    assert.deepEqual(group.candidates.filter((c) => c.winner).map((c) => c.source), ["bundled"]);
    assert.equal(group.candidates.find((c) => c.source === "user").version, "1.0.0");
    // 用户 pin 来源（dir）> 版本
    reg.setPin("source:demo", userDir);
    await reg.loadAll();
    assert.equal(reg.byId("demo").source, "user");
    assert.equal(reg.statusPayload().pins.pins["source:demo"], userDir);
    // pin 指向已不存在的目录 → 忽略回自动
    reg.setPin("source:demo", "/nonexistent/dir");
    await reg.loadAll();
    assert.equal(reg.byId("demo").source, "bundled");
    // dev 优先：默认关（既有契约 dev 不抢）；显式打开后 dev 根候选胜出版本裁决
    writeCapExt(roots.extraA, "dv", "1.0.0");
    writeCapExt(roots.bundled, "dv", "9.0.0");
    writeCapExt(roots.extraB, "dv", "0.1.0"); // dev 层低版本
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
    assert.equal(regDev.byId("dv").source, "bundled"); // dev 优先关：版本高者胜（9.0.0）
    regDev.setDevPriority(true);
    await regDev.loadAll();
    assert.equal(regDev.byId("dv").source, "dev"); // dev 优先开：dev 根直接胜出
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

test("manifest + status: four declaration fields pass through (extman 展示数据源)", async () => {
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

// ---- agent 工具整组门（agentTools.enabled）----
function writeGateExt(root, id, toolNames, features) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const tools = toolNames.map((n) => `{ name: "${n}", label: "${n}", description: "${n}", parameters: { type: "object", properties: {} }, async execute() { return { content: [] }; } }`).join(",\n        ");
  const feats = features.map((f) => `{ id: ${JSON.stringify(f.id)}${f.type ? `, type: ${JSON.stringify(f.type)}` : ""}${f.default !== undefined ? `, default: ${JSON.stringify(f.default)}` : ""} }`).join(",\n      ");
  writeFileSync(join(dir, "index.ts"), `export default {\n  id: "${id}", name: "${id}", version: "1.0.0",\n  features: [\n      ${feats}\n    ],\n  server: { agent: { agentTools() { return [\n        ${tools}\n      ]; } } },\n};\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: id, version: "1.0.0" }));
  return dir;
}

test("agentTools 整组门：关→全不注入；开→全放行(忽略 per-tool)；无门→per-tool；forced→全放行", async () => {
  const roots = makeRoots();
  try {
    // 带整组门扩展：gt_a per-tool 默认开、gt_b 默认关
    writeGateExt(roots.user, "gate-ext", ["gt_a", "gt_b"], [
      { id: "agentTools.enabled", type: "boolean", default: false },
      { id: "tool.gt_a", default: true },
      { id: "tool.gt_b", default: false },
    ]);
    // 无整组门扩展：纯 per-tool 语义
    writeGateExt(roots.user, "nongate-ext", ["nt_c", "nt_d"], [
      { id: "tool.nt_c", default: true },
      { id: "tool.nt_d", default: false },
    ]);
    const reg = await loadRegistryFor(roots);
    await reg.loadAll();

    const names = (tools) => tools.map((t) => t.name).sort();
    const info = { sessionId: "s1", cwd: "/x" };

    // 1) 默认（整组门关、无显式设置）：gate-ext 全不注入——
    //    回归：修复前 default:true 的 gt_a 会经 per-tool 分支泄漏。
    let tools = reg.collectAgentToolsWith(info);
    assert.deepEqual(names(tools), ["nt_c"]);
    assert.ok(!tools.some((t) => t.name === "gt_a"));
    assert.ok(!tools.some((t) => t.name === "gt_b"));

    // 2) 门开 → 全放行，忽略 per-tool（gt_b default:false 也放行）
    reg.setFeatureFlag("gate-ext", "agentTools.enabled", true);
    tools = reg.collectAgentToolsWith(info);
    assert.deepEqual(names(tools), ["gt_a", "gt_b", "nt_c"]);

    // 3) 门关回 → 即时全不注入（featureEnabled 实时读）
    reg.setFeatureFlag("gate-ext", "agentTools.enabled", false);
    tools = reg.collectAgentToolsWith(info);
    assert.deepEqual(names(tools), ["nt_c"]);

    // 4) forced（enableExtTools 点名）→ 无视门关全放行
    tools = reg.collectAgentToolsWith(info, ["gate-ext"]);
    assert.deepEqual(names(tools), ["gt_a", "gt_b", "nt_c"]);
  } finally {
    for (const r of Object.values(roots)) rmSync(r, { recursive: true, force: true });
  }
});
