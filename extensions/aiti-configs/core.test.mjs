/**
 * aiti-configs · core.cjs M2 重构函数测试（数据分层方案 §11 收口）。
 *
 * 覆盖：configs-self 一次性迁移、expandPath 占位符、snapshot 同步量闸门（force 豁免）、
 * repoSizes 体积体检、pruneRepoOrphans 孤儿清理、ensureRepo 搬仓引导（MIGRATION-NOTE）。
 *
 * 运行：node aiti-configs/core.test.mjs
 * 全部落在临时目录（AITI_CONFIGS_SELF_DIR env 隔离；测试进程内再不碰真实 ~/.pi/configs-self）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const TMP = mkdtempSync(join(tmpdir(), "aiti-configs-test-"));
process.env.AITI_CONFIGS_SELF_DIR = join(TMP, "self");
const core = await import("./core.cjs");

const git = (repo, args) => {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
};

function mkRepo(name, files) {
  const repo = join(TMP, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["checkout", "-q", "-b", "main"]);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  return repo;
}

test("expandPath：<configDir>/<cacheDir> 占位符 + 旧 <dataDir> 兼容 + {HOME}", async () => {
  const ctx = { configDir: "/tmp/cfg", cacheDir: "/tmp/cfg/cache" };
  assert.equal(core.expandPath("<configDir>/a.json", ctx), "/tmp/cfg/a.json");
  assert.equal(core.expandPath("<cacheDir>/x", ctx), "/tmp/cfg/cache/x");
  // 旧 <dataDir> 占位符兼容读 configDir
  assert.equal(core.expandPath("<dataDir>/a.json", ctx), "/tmp/cfg/a.json");
  // 无 ctx 时不炸（占位符替换为空串，仅剩字面路径）
  assert.equal(core.expandPath("<cacheDir>x", null), "x");
});

test("loadConfig：旧位置一次性迁移到 configs-self + 标记文件", async () => {
  const legacyDir = join(TMP, "legacy-data");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "ai-configs.json"), JSON.stringify({ repo: "/tmp/old-repo" }));
  const cfg = core.loadConfig(legacyDir);
  assert.ok(existsSync(cfg._file), "新位置文件应存在");
  assert.equal(JSON.parse(readFileSync(cfg._file)).repo, "/tmp/old-repo");
  assert.ok(existsSync(join(legacyDir, "ai-configs.json.migrated-to-configs-self")), "迁移标记应存在");
  // 再次加载直接读新位置（幂等）
  const cfg2 = core.loadConfig(legacyDir);
  assert.equal(cfg2._file, cfg._file);
});

test("syncToRepo 返回 bytes + 分层 excludes 生效", async () => {
  const src = join(TMP, "sync-src");
  mkdirSync(join(src, "cache"), { recursive: true });
  mkdirSync(join(src, "cfgdir"), { recursive: true });
  writeFileSync(join(src, "keep.json"), JSON.stringify({ a: 1 }));
  writeFileSync(join(src, "cache", "junk.jsonl"), "{}\n");
  const repo = mkRepo("sync-repo", {});
  const cfg = { ...core.loadConfig(), repo, includes: [{ path: src + "/**", dest: "s/" }] };
  const r = await core.syncToRepo(cfg, {});
  assert.equal(r.synced.length, 1, "只有 keep.json 入仓");
  assert.ok(r.bytes > 0 && r.bytes < 100);
  assert.ok(!existsSync(join(repo, "s", "cache")), "cache/ 目录不进备份");
});

test("snapshot 前置闸门：超量拒绝、force 豁免", async () => {
  const src = join(TMP, "gate-src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 1)); // 2MB
  const repo = mkRepo("gate-repo", {});
  const cfg = { ...core.loadConfig(), repo, includes: [{ path: src + "/**", dest: "g/" }], snapshotGateMB: 1, encrypt: { enabled: false } };
  const blocked = await core.snapshot(cfg, {}, {});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.gateBlocked, true);
  assert.ok(blocked.bytes > 1024 * 1024);
  const forced = await core.snapshot(cfg, {}, { force: true });
  assert.equal(forced.ok, true);
});

test("repoSizes：.git 与工作区体积统计 + 早停", async () => {
  const repo = mkRepo("size-repo", { "a.txt": "x".repeat(2048) });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const sizes = await core.repoSizes({ repo }, {});
  assert.ok(sizes.workspaceBytes >= 2048);
  assert.ok(sizes.gitBytes >= 0);
});

test("pruneRepoOrphans：删除命中 excludes 的跟踪副本，保护 protected", async () => {
  const repo = mkRepo("prune-repo", {
    "web/data/aiti-x/cache/junk.jsonl": "{}",
    "web/data/aiti-y/ops/op.jsonl": "{}",
    "web/data/aiti-x/auth.json": "{}",
    "web/data/aiti-x/keep.json": "{}",
  });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed"]);
  const cfg = {
    repo,
    excludes: ["**/cache/**", "**/ops/**"],
    hardExcludes: ["**/.git/**"],
    protected: ["**/auth.json"],
  };
  const r = await core.pruneRepoOrphans(cfg, {});
  assert.equal(r.pruned, 2, "cache/ops 两副本被清");
  assert.ok(!existsSync(join(repo, "web/data/aiti-x/cache/junk.jsonl")));
  assert.ok(existsSync(join(repo, "web/data/aiti-x/auth.json")), "protected 不清");
  assert.ok(existsSync(join(repo, "web/data/aiti-x/keep.json")), "普通配置不清");
});

test("ensureRepo 搬仓引导：检测归档旧仓 → 落 MIGRATION-NOTE", async () => {
  const home = join(TMP, "fake-home");
  mkdirSync(join(home, ".pi"), { recursive: true });
  mkdirSync(join(home, ".pi", "configs-archive-20990101"), { recursive: true });
  const repo = join(home, "new-configs");
  const origHome = process.env.HOME;
  const origUserHome = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home; // ensureRepo 以 os.homedir() 扫归档（Windows 读 USERPROFILE）
  try {
    const cfg = { repo, branch: "main", identity: { name: "t", email: "t@t" } };
    await core.ensureRepo(cfg, {});
    assert.ok(existsSync(join(repo, "MIGRATION-NOTE.md")), "迁移提示应生成");
    assert.ok(readFileSync(join(repo, "MIGRATION-NOTE.md"), "utf8").includes("configs-archive-20990101"));
  } finally {
    process.env.HOME = origHome; process.env.USERPROFILE = origUserHome;
  }
});

test("snapshot 正常路径：小变更直接提交", async () => {
  const src = join(TMP, "snap-src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "s.json"), JSON.stringify({ v: 2 }));
  const repo = mkRepo("snap-repo", {});
  const cfg = { ...core.loadConfig(), repo, includes: [{ path: src + "/**", dest: "snap/" }] };
  const r = await core.snapshot(cfg, {}, { message: "test snapshot" });
  assert.equal(r.ok, true);
  assert.ok(r.hash);
});

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* windows 句柄延迟 */ }
});
