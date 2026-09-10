/**
 * Loader cache & injection unit tests: jitiCacheDir env override, fsCache
 * persistence (first load transpiles → second load hits without rewrite),
 * host SDK virtualModules single-instance injection, cache snapshot diff,
 * PI_WEB_EXT_TIMING observation table.
 * Run: node --experimental-strip-types --test lib/ext/loader-fscache.test.mjs
 *
 * 全部用例把 PI_WEB_JITI_CACHE_DIR 指向 tmp——不污染真实 <webRoot()>/.cache/jiti。
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
    assert.equal(readdirSync(cache).length, 0); // 空 cache：还没加载过

    await loadExtensionFromDir(dir);
    const afterFirst = readdirSync(cache);
    assert.equal(afterFirst.length, 1); // 一个 TS 模块 = 一个缓存文件（.mjs）
    assert.match(afterFirst[0], /\.mjs$/);

    const snap1 = snapshotJitiCache();
    await loadExtensionFromDir(dir); // 内容不变 → 命中，不重写
    const snap2 = snapshotJitiCache();
    assert.equal(countRetranspiled(snap1, snap2), 0);

    // 源码变化 → 同名键覆盖写（mtime 变）→ 恰好 1 个文件重转译，且新内容生效
    writeFileSync(join(dir, "index.ts"), SIMPLE_ENTRY.replace('"1.0.0"', '"2.0.0"'));
    const ext = await loadExtensionFromDir(dir);
    const snap3 = snapshotJitiCache();
    assert.equal(countRetranspiled(snap2, snap3), 1);
    assert.equal(ext.version, "2.0.0"); // moduleCache:false + 尾部校验失效 → 重转译
    assert.equal(readdirSync(cache).length, 1); // 键同名覆盖，无孤儿膨胀
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
    // 扩展内部经 virtualModules 直注拿到的 class 与宿主原生 import 同一引用
    // ——结构性单实例（SDK 内部单例/全局注册表不分裂）
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
    assert.equal(snapshotJitiCache().size, 0); // 目录不存在 → 空快照不抛错
    writeFileSync(join(cache, "a.123456.mjs"), "x");
    const snap1 = snapshotJitiCache();
    assert.equal(snap1.size, 1);
    const snap2 = snapshotJitiCache();
    assert.equal(countRetranspiled(snap1, snap2), 0); // 无变化
    writeFileSync(join(cache, "b.789abc.mjs"), "y");
    const snap3 = snapshotJitiCache();
    assert.equal(countRetranspiled(snap1, snap3), 1); // 只算新增
  } finally {
    cleanup({ cache, prevCacheEnv });
  }
});

test("fsCache 优雅降级：缓存目录不可写时加载仍成功（jiti 自动禁用缓存，方案 §6 风险表）", async () => {
  const { loadExtensionFromDir } = await import("./loader.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-ext-"));
  const roBase = mkdtempSync(join(tmpdir(), "pi-jiti-ro-"));
  const roDir = join(roBase, "ro");
  mkdirSync(roDir, { mode: 0o500 }); // 只读+执行：jiti W_OK 探测失败 → 禁缓存不抛错
  const prevCacheEnv = process.env.PI_WEB_JITI_CACHE_DIR;
  process.env.PI_WEB_JITI_CACHE_DIR = roDir;
  try {
    writeExt(root, "demo", SIMPLE_ENTRY);
    const ext = await loadExtensionFromDir(join(root, "demo"));
    assert.ok(ext); // 降级为无缓存加载，不抛错
    assert.equal(ext.id, "demo");
  } finally {
    chmodSync(roDir, 0o700); // 恢复可写以便清理
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
      await reg.loadAll(); // 空 cache → 有 MISS
      await reg.loadAll(); // 全命中 → 无 MISS
    } finally {
      captured.mock.restore();
    }
    const lines = captured.mock.calls.map((c) => c.arguments.join(" ")).filter((l) => l.includes("[ext-timing]"));
    const tableStarts = lines.reduce((acc, l) => {
      if (l.includes("个扩展 / ")) acc.push([]);
      if (acc.length) acc[acc.length - 1].push(l);
      return acc;
    }, []);
    assert.equal(tableStarts.length, 2); // 两轮 loadAll 各一张表
    assert.equal(tableStarts[0].length, 3); // 汇总行 + 2 扩展行
    assert.match(tableStarts[0][0], /重转译 [1-9]/); // 第一轮有 MISS
    assert.ok(tableStarts[0].some((l) => l.includes("MISS")));
    assert.match(tableStarts[1][0], /重转译 0/); // 第二轮全命中（fsCache 持久生效）
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
