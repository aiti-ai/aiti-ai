/**
 * Loader cache & injection unit tests: jitiCacheDir env override, fsCache
 * persistence (first load transpiles → second load hits without rewrite),
 * host SDK virtualModules single-instance injection, cache snapshot diff,
 * PI_WEB_EXT_TIMING observation table.
 * Run: node --experimental-strip-types --test lib/ext/loader-fscache.test.mjs
 *
 * All cases point PI_WEB_JITI_CACHE_DIR at tmp — the real <webRoot()>/.cache/jiti is never polluted.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SIMPLE_ENTRY = `
export default {
  id: "demo",
  name: "Demo",
  version: "1.0.0",
};
`;

const SDK_ENTRY = `
import * as sdk from "@earendil-works/pi-coding-agent";
export default {
  id: "sdkprobe",
  name: "SDK probe",
  version: "1.0.0",
  agentSessionCtor: sdk.AgentSession,
  exportCount: Object.keys(sdk).length,
};
`;

function writeExt(root, id, entry) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), entry);
  return dir;
}

function tmpCache() {
  const dir = mkdtempSync(join(tmpdir(), "pi-jiti-cache-"));
  process.env.PI_WEB_JITI_CACHE_DIR = dir;
  return dir;
}

function cleanup({ root, cache, prevCacheEnv } = {}) {
  if (prevCacheEnv === undefined) delete process.env.PI_WEB_JITI_CACHE_DIR;
  else process.env.PI_WEB_JITI_CACHE_DIR = prevCacheEnv;
  delete process.env.PI_WEB_EXT_TIMING;
  if (root) rmSync(root, { recursive: true, force: true });
  if (cache) rmSync(cache, { recursive: true, force: true });
}

test("jitiCacheDir: <webRoot()>/.cache/jiti default, PI_WEB_JITI_CACHE_DIR override", async () => {
  const { jitiCacheDir } = await import("./data-dir.ts");
  const { webRoot } = await import("./data-dir.ts");
  const prev = process.env.PI_WEB_JITI_CACHE_DIR;
  delete process.env.PI_WEB_JITI_CACHE_DIR;
  try {
    assert.equal(jitiCacheDir(), join(webRoot(), ".cache", "jiti"));
    process.env.PI_WEB_JITI_CACHE_DIR = "/tmp/somewhere-else";
    assert.equal(jitiCacheDir(), "/tmp/somewhere-else");
  } finally {
    if (prev === undefined) delete process.env.PI_WEB_JITI_CACHE_DIR;
    else process.env.PI_WEB_JITI_CACHE_DIR = prev;
  }
});

test("fsCache persistence: first load transpiles into cache dir, second load hits without rewrite", async () => {
  const { loadExtensionFromDir, snapshotJitiCache, countRetranspiled } = await import("./loader.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const prevCacheEnv = process.env.PI_WEB_JITI_CACHE_DIR;
  const cache = tmpCache();
  try {
    const dir = writeExt(root, "demo", SIMPLE_ENTRY);
    assert.equal(readdirSync(cache).length, 0); // empty cache: nothing loaded yet

    await loadExtensionFromDir(dir);
    const afterFirst = readdirSync(cache);
    assert.equal(afterFirst.length, 1); // one TS module = one cache file (.mjs)
    assert.match(afterFirst[0], /\.mjs$/);

    const snap1 = snapshotJitiCache();
    await loadExtensionFromDir(dir); // content unchanged → cache hit, no rewrite
    const snap2 = snapshotJitiCache();
    assert.equal(countRetranspiled(snap1, snap2), 0);

    // source change → same-key overwrite (mtime changes) → exactly 1 file retranspiled, and the new content takes effect
    writeFileSync(join(dir, "index.ts"), SIMPLE_ENTRY.replace('"1.0.0"', '"2.0.0"'));
    const ext = await loadExtensionFromDir(dir);
    const snap3 = snapshotJitiCache();
    assert.equal(countRetranspiled(snap2, snap3), 1);
    assert.equal(ext.version, "2.0.0"); // moduleCache:false + tail checksum invalidation → retranspile
    assert.equal(readdirSync(cache).length, 1); // same-key overwrite, no orphan growth
  } finally {
    cleanup({ root, cache, prevCacheEnv });
  }
});

test("virtualModules: extension's SDK import is the same instance as the host's", async () => {
  const { loadExtensionFromDir } = await import("./loader.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const prevCacheEnv = process.env.PI_WEB_JITI_CACHE_DIR;
  const cache = tmpCache();
  try {
    writeExt(root, "sdkprobe", SDK_ENTRY);
    const ext = await loadExtensionFromDir(join(root, "sdkprobe"));
    assert.ok(ext);
    const hostSdk = await import("@earendil-works/pi-coding-agent");
    // the class the extension gets via the virtualModules direct injection is the same reference as the host's native import
    // — structurally single instance (SDK-internal singletons/global registries do not split)
    assert.equal(ext.agentSessionCtor, hostSdk.AgentSession);
    assert.ok(ext.exportCount > 0);
  } finally {
    cleanup({ root, cache, prevCacheEnv });
  }
});

test("snapshot diff: unrelated cache writes are not attributed; missing dir snapshots empty", async () => {
  const { snapshotJitiCache, countRetranspiled } = await import("./loader.ts");
  const prevCacheEnv = process.env.PI_WEB_JITI_CACHE_DIR;
  const cache = tmpCache();
  try {
    assert.equal(snapshotJitiCache().size, 0); // missing dir → empty snapshot without throwing
    writeFileSync(join(cache, "a.123456.mjs"), "x");
    const snap1 = snapshotJitiCache();
    assert.equal(snap1.size, 1);
    const snap2 = snapshotJitiCache();
    assert.equal(countRetranspiled(snap1, snap2), 0); // no change
    writeFileSync(join(cache, "b.789abc.mjs"), "y");
    const snap3 = snapshotJitiCache();
    assert.equal(countRetranspiled(snap1, snap3), 1); // only new entries count
  } finally {
    cleanup({ cache, prevCacheEnv });
  }
});

test("fsCache graceful degradation: loading still succeeds when the cache dir is not writable (jiti auto-disables caching; plan §6 risk table)", async () => {
  const { loadExtensionFromDir } = await import("./loader.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const roBase = mkdtempSync(join(tmpdir(), "pi-jiti-ro-"));
  const roDir = join(roBase, "ro");
  mkdirSync(roDir, { mode: 0o500 }); // read+execute only: jiti's W_OK probe fails → cache disabled without throwing
  const prevCacheEnv = process.env.PI_WEB_JITI_CACHE_DIR;
  process.env.PI_WEB_JITI_CACHE_DIR = roDir;
  try {
    writeExt(root, "demo", SIMPLE_ENTRY);
    const ext = await loadExtensionFromDir(join(root, "demo"));
    assert.ok(ext); // degrades to cache-less loading, no throw
    assert.equal(ext.id, "demo");
  } finally {
    chmodSync(roDir, 0o700); // restore writability for cleanup
    cleanup({ root, cache: roBase, prevCacheEnv });
  }
});

test("PI_WEB_EXT_TIMING=1: loadAll prints table; first run MISS, second run all hit", async () => {
  const { ExtRegistryImpl } = await import("./registry.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const prevCacheEnv = process.env.PI_WEB_JITI_CACHE_DIR;
  const cache = tmpCache();
  process.env.PI_WEB_EXT_TIMING = "1";
  try {
    writeExt(root, "demo", SIMPLE_ENTRY);
    writeExt(root, "demo2", SIMPLE_ENTRY.replace("demo", "demo2"));
    const reg = new ExtRegistryImpl({ core: { async listSessions() { return []; } }, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
    const captured = mock.method(console, "log", () => {});
    try {
      await reg.loadAll(); // empty cache → some MISS
      await reg.loadAll(); // all hits → no MISS
    } finally {
      captured.mock.restore();
    }
    const lines = captured.mock.calls.map((c) => c.arguments.join(" ")).filter((l) => l.includes("[ext-timing]"));
    const tableStarts = lines.reduce((acc, l) => {
      if (l.includes(" extensions / ")) acc.push([]);
      if (acc.length) acc[acc.length - 1].push(l);
      return acc;
    }, []);
    assert.equal(tableStarts.length, 2); // one table per loadAll round
    assert.equal(tableStarts[0].length, 3); // summary row + 2 extension rows
    assert.match(tableStarts[0][0], /retranspiled [1-9]/); // first round has MISSes
    assert.ok(tableStarts[0].some((l) => l.includes("MISS")));
    assert.match(tableStarts[1][0], /retranspiled 0/); // second round all hits (fsCache persists)
    assert.ok(!tableStarts[1].some((l) => l.includes("MISS")));
  } finally {
    cleanup({ root, cache, prevCacheEnv });
    rmSync(data, { recursive: true, force: true });
  }
});

test("PI_WEB_EXT_TIMING unset: no table output", async () => {
  const { ExtRegistryImpl } = await import("./registry.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const data = mkdtempSync(join(tmpdir(), "pi-data-"));
  const prevCacheEnv = process.env.PI_WEB_JITI_CACHE_DIR;
  const cache = tmpCache();
  assert.equal(process.env.PI_WEB_EXT_TIMING, undefined);
  try {
    writeExt(root, "demo", SIMPLE_ENTRY);
    const reg = new ExtRegistryImpl({ core: { async listSessions() { return []; } }, extensionsRootOverride: root, extraExtensionsRootsOverride: [], devExtensionsRootOverride: null, bundledExtensionsRootOverride: mkdtempSync(join(tmpdir(), "pi-bundled-empty-")), dataRootOverride: data });
    const captured = mock.method(console, "log", () => {});
    try {
      await reg.loadAll();
    } finally {
      captured.mock.restore();
    }
    assert.equal(captured.mock.calls.filter((c) => c.arguments.join(" ").includes("[ext-timing]")).length, 0);
  } finally {
    cleanup({ root, cache, prevCacheEnv });
    rmSync(data, { recursive: true, force: true });
  }
});
