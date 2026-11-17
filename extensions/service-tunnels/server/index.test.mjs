/**
 * 扩展入口契约测试 —— index.ts 的 server hooks / ui 插槽 / i18n 完整性 / client 存在性。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, statSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ext from "../index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("入口元数据：id/name/version/client 齐备", () => {
  assert.equal(ext.id, "service-tunnels");
  assert.equal(typeof ext.name, "string");
  // Single source of truth for the version = package.json (entry no longer hand-writes a
  // version field; the host injects it on load)
  const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  assert.ok(pkgVersion);
  assert.equal(typeof ext.client, "string");
  // client bundle 构建产物存在（部署/加载前提）
  const clientPath = join(root, ext.client);
  assert.ok(existsSync(clientPath), `client bundle 缺失: ${ext.client}`);
  assert.ok(statSync(clientPath).size > 100_000);
});

test("server hooks：startup/shutdown/api/middleware 全部为函数", () => {
  for (const k of ["startup", "shutdown", "api", "middleware"]) {
    assert.equal(typeof ext.server[k], "function", `server.${k} 缺失`);
  }
});

test("ui 插槽：toolbar/dialogs/banners + 条目 id", () => {
  assert.ok(ext.ui.toolbar.some((t) => t.id === "ports"));
  assert.ok(ext.ui.dialogs.some((d) => d.id === "ports"));
  assert.ok(ext.ui.banners.some((b) => b.id === "self-expose-alert"));
});

test("i18n 完整：en/zh-CN 与客户端翻译调用一致（services.* 前缀，数量随功能演进）", () => {
  const en = ext.ui.i18n.en;
  const zh = ext.ui.i18n["zh-CN"];
  assert.ok(en && zh);
  const enKeys = Object.keys(en).filter((k) => k.startsWith("services."));
  const zhKeys = Object.keys(zh).filter((k) => k.startsWith("services."));
  // 语言间 key 完全对齐（对齐比数量重要——数量会随功能演进变化）
  assert.equal(zhKeys.length, enKeys.length);
  const missing = enKeys.filter((k) => !(k in zh));
  assert.deepEqual(missing, []);
  const extra = zhKeys.filter((k) => !(k in en));
  assert.deepEqual(extra, []);
  // 客户端 t() 实际用到的 key 必须全部存在（防漏翻/拼错）
  const srcDir = resolve(import.meta.dirname, "..", "client", "src");
  let src = "";
  for (const f of ["ServicesDialog.tsx", "SelfExposeAlert.tsx"]) {
    try { src += readFileSync(join(srcDir, f), "utf8"); } catch { /* ignore */ }
  }
  const used = new Set();
  for (const m of src.matchAll(/[^a-zA-Z]t\("([^"]+)"/g)) used.add(m[1]);
  const notFound = [...used].filter((k) => k.startsWith("services.") && !(k in en));
  assert.deepEqual(notFound, [], `客户端用到但 i18n 缺失: ${notFound.join(", ")}`);
});

test("middleware 未初始化时安全回退（handled:false，不依赖宿主状态）", async () => {
  delete globalThis.__piServiceTunnels;
  const r = await ext.server.middleware(new Request("http://127.0.0.1:3000/"));
  assert.deepEqual(r, { handled: false });
});

test("startup 创建库单例（globalThis.__piServiceTunnels）", async () => {
  delete globalThis.__piServiceTunnels;
  await ext.server.startup({ id: "service-tunnels", dir: root, configDir: join(root, ".test-data"), core: {} });
  assert.ok(globalThis.__piServiceTunnels, "startup 后单例应存在");
  // 幂等：再次 startup 复用同一实例
  const first = globalThis.__piServiceTunnels;
  await ext.server.startup({ id: "service-tunnels", dir: root, configDir: join(root, ".test-data"), core: {} });
  assert.equal(globalThis.__piServiceTunnels, first);
});

test("shutdown 幂等（不销毁 globalThis 单例——跨 reload 复用）", async () => {
  await ext.server.shutdown();
  assert.ok(globalThis.__piServiceTunnels, "shutdown 后单例保留（与 aiti-devtools 桥同语义）");
});
