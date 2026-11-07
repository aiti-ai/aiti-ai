/**
 * aiti-quickstart · server/clone 纯逻辑单测（进度解析 / 历史存取 / 扫描合并 / 端点校验）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-quickstart/server/clone.test.mjs
 *
 * 桩：@aiti-ai/ext-shared/exec-async（whichBin 返回 null 以测「git 缺失」分支——
 * 模块解析经 node_modules symlink，测试前用 require.cache 不可行，改 env +
 * module.register 太重；直接以 test.mock 拦截不可用 → 用 loader hooks 之外的
 * 简法：clone.test 通过 import 后覆写内部引用不可行——故 whichBin 缺失分支
 * 经 env PATH="" 场景由 handleClone 集成验证跳过，本文件聚焦纯函数 + fs 桩）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// node_modules symlink 兜底（test-web-ext.mjs 同款；repo 内直跑 import "@aiti-ai/ext-shared/..." 需要）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const nmTarget = join(repoRoot, "node_modules", "@aiti-ai");
const nmLink = join(nmTarget, "ext-shared");
try {
  mkdirSync(nmTarget, { recursive: true });
  if (!existsSync(nmLink)) {
    const { symlinkSync } = await import("node:fs");
    const { fileURLToPath: f2p } = await import("node:url");
    const sharedSrc = resolve(dirname(fileURLToPath(import.meta.url)), "..", "_shared");
    // _shared 目录无 package.json exports——直接 symlink 到共享根已安装副本
    const installed = join(process.env.HOME ?? "", ".pi", "web-dev", "node_modules", "@aiti-ai", "ext-shared");
    if (existsSync(installed)) symlinkSync(installed, nmLink, "dir");
    else symlinkSync(sharedSrc, nmLink, "dir");
  }
} catch { /* 已存在/不支持 symlink 则依赖既有解析路径 */ }

const mod = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "clone.ts")).href);

/* ── parseCloneProgress ── */

test("parseCloneProgress：Receiving/Resolving 百分比 → phase+percent", () => {
  assert.deepEqual(mod.parseCloneProgress("Receiving objects:  42% (123/293)"), { phase: "receiving", percent: 42 });
  assert.deepEqual(mod.parseCloneProgress("Resolving deltas:  100% (50/50), done."), { phase: "resolving", percent: 100 });
  assert.deepEqual(mod.parseCloneProgress("Counting objects:  12% (3/25)"), { phase: "cloning", percent: 12 });
  assert.deepEqual(mod.parseCloneProgress("Checking out files:  100% (20/20), done."), { phase: "resolving", percent: 100 });
});

test("parseCloneProgress：Cloning into / Checking connectivity / 无关行", () => {
  assert.deepEqual(mod.parseCloneProgress("Cloning into 'x'..."), { phase: "cloning" });
  assert.deepEqual(mod.parseCloneProgress("Checking connectivity: done."), { phase: "resolving" });
  assert.equal(mod.parseCloneProgress("remote: Enumerating objects"), null);
  assert.equal(mod.parseCloneProgress(""), null);
});

/* ── history store（临时 configDir 桩） ── */

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "qs-clone-test-"));
  return {
    ctx: { configDir: join(dir, "cfg"), path: ["workspace"], searchParams: new URLSearchParams(), services: { get: () => undefined } },
    dir,
  };
}

test("readHistory：缺文件/损坏 JSON → 空数组", () => {
  const { ctx, dir } = makeCtx();
  assert.deepEqual(mod.readHistory(ctx), []);
  mkdirSync(join(ctx.configDir, "state", "quickstart"), { recursive: true });
  writeFileSync(join(ctx.configDir, "state", "quickstart", "recent-workspaces.json"), "{oops");
  assert.deepEqual(mod.readHistory(ctx), []);
  rmSync(dir, { recursive: true, force: true });
});

test("appendHistory：置顶去重、scan 不入库、非对象行被读侧过滤", () => {
  const { ctx, dir } = makeCtx();
  const rec = (root, source = "clone") =>
    ({ id: `${source}:${root}`, source, root, name: root.split("/").pop(), time: 1 });
  mod.appendHistory(ctx, rec("/a"));
  mod.appendHistory(ctx, rec("/b", "upload"));
  mod.appendHistory(ctx, rec("/a")); // 同 root → 去重置顶
  let list = mod.readHistory(ctx);
  assert.deepEqual(list.map((r) => r.root), ["/a", "/b"]);
  assert.equal(list[0].source, "clone");
  mod.appendHistory(ctx, { id: "scan:/x", source: "scan", root: "/x", name: "x", time: 2 }); // scan 不写盘
  assert.equal(mod.readHistory(ctx).length, 2);
  // 损坏行过滤：手写混入非法行
  const file = join(ctx.configDir, "state", "quickstart", "recent-workspaces.json");
  writeFileSync(file, JSON.stringify([{ root: "/ok", id: "clone:/ok", source: "clone", name: "ok", time: 1 }, null, { noRoot: true }]));
  assert.equal(mod.readHistory(ctx).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

/* ── scanDefaultWorkspaces + mergedHistory ── */

test("scanDefaultWorkspaces：<home>/workspace 顶层目录 mtime 降序 top8，点前缀/文件排除", () => {
  const home = mkdtempSync(join(tmpdir(), "qs-scan-home-"));
  const ws = join(home, "workspace");
  mkdirSync(join(ws, "up-a"), { recursive: true });
  mkdirSync(join(ws, "up-b"), { recursive: true });
  mkdirSync(join(ws, ".hidden"), { recursive: true });
  writeFileSync(join(ws, "file.txt"), "x");
  // up-a 更新
  const future = new Date(Date.now() + 10_000);
  utimesSync(join(ws, "up-a"), future, future);
  const scanned = mod.scanDefaultWorkspaces(home);
  assert.deepEqual(scanned.map((s) => s.root), [join(ws, "up-a"), join(ws, "up-b")]);
  // 空 home / 不存在目录
  assert.deepEqual(mod.scanDefaultWorkspaces(""), []);
  assert.deepEqual(mod.scanDefaultWorkspaces(join(home, "nope")), []);
  rmSync(home, { recursive: true, force: true });
});

test("mergedHistory：记录优先、扫描去重殿后、截 16", () => {
  const { ctx, dir } = makeCtx();
  const home = mkdtempSync(join(tmpdir(), "qs-merge-home-"));
  const ws = join(home, "workspace");
  mkdirSync(join(ws, "zip-1"), { recursive: true });
  mkdirSync(join(ws, "zip-2"), { recursive: true });
  mod.appendHistory(ctx, { id: "upload:" + join(ws, "zip-1"), source: "upload", root: join(ws, "zip-1"), name: "zip-1", time: 5 });
  const merged = mod.mergedHistory(ctx, home);
  assert.equal(merged[0].source, "upload"); // 记录在前
  assert.equal(merged.filter((r) => r.root === join(ws, "zip-1")).length, 1); // 去重
  assert.ok(merged.some((r) => r.source === "scan" && r.root === join(ws, "zip-2"))); // 扫描补充
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/* ── handleClone 校验分支（无 git 依赖的快速失败路径） ── */

test("handleClone：缺 url / 前导 - 注入 / 非法分支 → 400", async () => {
  const { ctx, dir } = makeCtx();
  const res = async (body) => mod.handleClone(body, ctx);
  const r1 = await res({ url: "" });
  assert.equal(r1.status, 400);
  const r2 = await res({ url: "-evil" });
  assert.equal(r2.status, 400);
  const r3 = await res({ url: "https://x/a.git", branch: "-bad" });
  assert.equal(r3.status, 400);
  const r4 = await res({ url: "https://github.com/a/b.git", dir: "relative/path" });
  assert.equal(r4.status, 400);
  const r5 = await res({ url: "https://github.com/a/b.git", dir: "/" });
  assert.equal(r5.status, 400);
  rmSync(dir, { recursive: true, force: true });
});
