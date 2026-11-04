/**
 * aiti-backup · 备份核心单测（fixture 目录 + node:test）
 *
 * 覆盖：首次全量、增量硬链接（inode 相等）、修改/新增/删除计数、
 *       强制复制降级、目的地安全校验、保留轮转护栏、.tmp 半成品清理、
 *       源严格只读、symlink 不跟随、复制件 mtime 保留。
 * 跑法：node --test pi-web-ext/aiti-backup/lib/（或仓根 test-web-ext.mjs 全量收集）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";

const require = createRequire(import.meta.url);
const core = require("./backup-core.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeSource() {
  const src = await mkdtemp(join(tmpdir(), "aiti-backup-src-"));
  await mkdir(join(src, "sub"), { recursive: true });
  await writeFile(join(src, "a.txt"), "hello a\n");
  await writeFile(join(src, "sub", "b.bin"), Buffer.alloc(4096, 7));
  return src;
}

/** 递归取 {rel: 内容hash}（源只读断言用） */
async function snapshotTree(root) {
  const out = {};
  async function walk(dir, rel) {
    const entries = await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const r = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) await walk(abs, r);
      else if (ent.isFile()) out[r] = (await readFile(abs)).toString("hex");
      else out[r] = "<special>";
    }
  }
  await walk(root, "");
  return out;
}

test("snapshotName 符合目录安全格式（可轮转的字典序时间戳）", () => {
  const name = core.snapshotName(new Date("2026-09-19T08:30:00.123Z"));
  assert.match(name, core.SNAPSHOT_NAME_RE);
  assert.equal(name, "2026-09-19T08-30-00-123Z");
});

test("首次备份：全量复制 + manifest 完成标记 + 原子改名", async () => {
  const src = await makeSource();
  const dest = await mkdtemp(join(tmpdir(), "aiti-backup-dest-"));
  const r = await core.backupSnapshot({ srcPath: src, destRoot: dest, sourceId: "s1", keepCount: 0 });
  assert.match(r.snapshotName, core.SNAPSHOT_NAME_RE);
  assert.equal(r.manifest.mode, "full");
  assert.equal(r.manifest.stats.total, 2);
  assert.equal(r.manifest.stats.copied, 2);
  assert.equal(r.manifest.stats.linked, 0);
  // 内容可读、路径保持
  assert.equal(await readFile(join(r.dir, "a.txt"), "utf8"), "hello a\n");
  assert.equal((await readFile(join(r.dir, "sub", "b.bin"))).length, 4096);
  // 无 .tmp 残留
  const snaps = await core.listSnapshots(dest, "s1");
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].incomplete, false);
  await rm(src, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test("增量备份：未变文件硬链接（同 inode）、变更/新增复制、删除不传播", async () => {
  const src = await makeSource();
  const dest = await mkdtemp(join(tmpdir(), "aiti-backup-dest-"));
  const snapRoot = join(dest, "s1", "snapshots");
  const r1 = await core.backupSnapshot({ srcPath: src, destRoot: dest, sourceId: "s1", keepCount: 0 });
  await sleep(5);
  // r1→r2：变更 a.txt、新增 c.txt、删除 sub/b.bin
  await writeFile(join(src, "a.txt"), "changed\n");
  await writeFile(join(src, "c.txt"), "new file\n");
  await rm(join(src, "sub", "b.bin"));
  const p1 = await core.findLatestValidSnapshot(snapRoot);
  const r2 = await core.backupSnapshot({
    srcPath: src,
    destRoot: dest,
    sourceId: "s1",
    keepCount: 0,
    prevManifest: p1.manifest,
    prevSnapshotName: p1.name,
  });
  assert.equal(r2.manifest.mode, "incremental");
  assert.equal(r2.manifest.linkedTo, r1.snapshotName);
  assert.equal(r2.manifest.stats.removed, 1); // b.bin 从源消失
  const f2 = new Map(r2.manifest.files.map((f) => [f.path, f]));
  assert.equal(f2.get("sub/b.bin"), undefined); // 删除不传播：新快照里就是没有
  assert.equal(f2.get("a.txt").how, "copied");
  assert.equal(f2.get("c.txt").how, "copied");

  // r2→r3：全部未变（a.txt/c.txt 未动，新增 d.txt 后又跑 r4 前先验证本轮全 linked）
  await sleep(5);
  const p2 = await core.findLatestValidSnapshot(snapRoot);
  const r3 = await core.backupSnapshot({
    srcPath: src,
    destRoot: dest,
    sourceId: "s1",
    keepCount: 0,
    prevManifest: p2.manifest,
    prevSnapshotName: p2.name,
  });
  assert.equal(r3.manifest.mode, "incremental");
  assert.equal(r3.manifest.stats.removed, 0);
  const f3 = new Map(r3.manifest.files.map((f) => [f.path, f]));
  assert.equal(f3.get("a.txt").how, "linked"); // 未变 → 硬链接
  assert.equal(f3.get("c.txt").how, "linked");
  // inode 相等验证：r2 与 r3 的 a.txt 共享 inode；源与快照绝不同 inode
  const inoSrc = (await stat(join(src, "a.txt"))).ino;
  const inoR2 = (await stat(join(snapRoot, p2.name, "a.txt"))).ino;
  const inoR3 = (await stat(join(r3.dir, "a.txt"))).ino;
  assert.equal(inoR2, inoR3);
  assert.notEqual(inoSrc, inoR3); // 源从不被链进快照（严格只读的另一面）
  await rm(src, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test("disableLink 强制复制：mode=full、全部 copied、跨快照不共享 inode", async () => {
  const src = await makeSource();
  const dest = await mkdtemp(join(tmpdir(), "aiti-backup-dest-"));
  await core.backupSnapshot({ srcPath: src, destRoot: dest, sourceId: "s1", keepCount: 0 });
  await sleep(5);
  const snapRoot = join(dest, "s1", "snapshots");
  const prev = await core.findLatestValidSnapshot(snapRoot);
  const r2 = await core.backupSnapshot({
    srcPath: src,
    destRoot: dest,
    sourceId: "s1",
    keepCount: 0,
    prevManifest: prev.manifest,
    prevSnapshotName: prev.name,
    disableLink: true,
  });
  assert.equal(r2.manifest.mode, "full");
  assert.equal(r2.manifest.stats.linked, 0);
  assert.equal(r2.manifest.stats.copied, 2);
  const ino1 = (await stat(join(snapRoot, prev.name, "a.txt"))).ino;
  const ino2 = (await stat(join(r2.dir, "a.txt"))).ino;
  assert.notEqual(ino1, ino2);
  await rm(src, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test("目的地安全校验：相等/嵌套/包含/根 全拒，兄弟目录放行", async () => {
  const wrapper = await mkdtemp(join(tmpdir(), "aiti-backup-wrap-"));
  const src = join(wrapper, "inner-src");
  await mkdir(src, { recursive: true });
  const sibling = await mkdtemp(join(tmpdir(), "aiti-backup-sib-"));
  // 放行：与源无包含关系的兄弟目录
  const ok = await core.validateDestination(sibling, [src], { home: join(tmpdir(), "no-such-home") });
  assert.ok(ok);
  // 拒：目的地 === 源
  await assert.rejects(() => core.validateDestination(src, [src], {}), /相同/);
  // 拒：目的地在源内部（目录真实存在，避免 realpath 上溯到源本身）
  const inside = join(src, "inside");
  await mkdir(inside, { recursive: true });
  await assert.rejects(() => core.validateDestination(inside, [src], {}), /位于备份源内部/);
  // 拒：目的地包含源（源在目的地内部）
  await assert.rejects(() => core.validateDestination(wrapper, [src], {}), /包含备份源/);
  // 拒：文件系统根
  await assert.rejects(() => core.validateDestination(parsePath(tmpdir()).root || "/", [], {}));
  await rm(wrapper, { recursive: true, force: true });
  await rm(sibling, { recursive: true, force: true });
});

test("保留轮转：keepCount=2 删最旧；非时间戳命名目录永不触碰", async () => {
  const src = await makeSource();
  const dest = await mkdtemp(join(tmpdir(), "aiti-backup-dest-"));
  const snapRoot = join(dest, "s1", "snapshots");
  await mkdir(join(snapRoot, "not-a-snapshot"), { recursive: true }); // 护栏目标
  const names = [];
  for (let i = 0; i < 3; i++) {
    const r = await core.backupSnapshot({ srcPath: src, destRoot: dest, sourceId: "s1", keepCount: 2 });
    names.push(r.snapshotName);
    await sleep(4);
  }
  const left = (await core.listSnapshotDirs(snapRoot)).sort();
  assert.equal(left.length, 2); // 只剩最近 2 份（listSnapshotDirs 只列正式快照）
  assert.ok(!left.includes(names[0])); // 最旧被删
  assert.ok(left.includes(names[2]));
  // 护栏：非时间戳命名目录永不触碰（listSnapshotDirs 看不到它，用 readdir 验证仍在）
  const allEntries = await readdir(snapRoot);
  assert.ok(allEntries.includes("not-a-snapshot"));
  await rm(src, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test("中断安全：.tmp 半成品被 cleanupTmp 清掉，正式快照不受影响", async () => {
  const src = await makeSource();
  const dest = await mkdtemp(join(tmpdir(), "aiti-backup-dest-"));
  const good = await core.backupSnapshot({ srcPath: src, destRoot: dest, sourceId: "s1", keepCount: 0 });
  const snapRoot = join(dest, "s1", "snapshots");
  await mkdir(join(snapRoot, core.TMP_PREFIX + "stale-run"), { recursive: true });
  await writeFile(join(snapRoot, core.TMP_PREFIX + "stale-run", "partial.bin"), "half");
  const removed = await core.cleanupTmp(snapRoot);
  assert.deepEqual(removed, [core.TMP_PREFIX + "stale-run"]);
  const snaps = await core.listSnapshots(dest, "s1");
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].name, good.snapshotName);
  await rm(src, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test("源严格只读：备份前后源树逐字节一致；symlink 跳过且不跟随", async () => {
  const src = await makeSource();
  await writeFile(join(src, "outer.txt"), "outside\n");
  // symlink 指向源外目录（若被跟随会把外部内容拉进快照）
  const outside = await mkdtemp(join(tmpdir(), "aiti-backup-outside-"));
  await writeFile(join(outside, "secret.txt"), "should-not-leak\n");
  await symlink(outside, join(src, "danger-link"), "dir");
  const before = await snapshotTree(src);
  const dest = await mkdtemp(join(tmpdir(), "aiti-backup-dest-"));
  const r = await core.backupSnapshot({ srcPath: src, destRoot: dest, sourceId: "s1", keepCount: 0 });
  const after = await snapshotTree(src);
  assert.deepEqual(before, after); // 源零改动
  const skipped = new Map(r.manifest.skipped.map((s) => [s.path, s.reason]));
  assert.equal(skipped.get("danger-link"), "symlink");
  const leaked = await readFile(join(r.dir, "danger-link", "secret.txt")).then(
    () => true,
    () => false
  );
  assert.equal(leaked, false); // 未跟随
  await rm(src, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("复制件保留源 mtime（恢复语义）；manifest 记录源 mtime 供增量比对", async () => {
  const src = await makeSource();
  const old = new Date("2026-01-02T03:04:05.678Z");
  await utimes(join(src, "a.txt"), old, old);
  const dest = await mkdtemp(join(tmpdir(), "aiti-backup-dest-"));
  const r = await core.backupSnapshot({ srcPath: src, destRoot: dest, sourceId: "s1", keepCount: 0 });
  const st = await stat(join(r.dir, "a.txt"));
  assert.equal(Math.round(st.mtimeMs), Math.round(old.getTime()));
  const mf = r.manifest.files.find((f) => f.path === "a.txt");
  assert.equal(mf.mtimeMs, Math.round(old.getTime()));
  await rm(src, { recursive: true, force: true });
  await rm(dest, { recursive: true, force: true });
});

test("config：默认值（keepCount=7 / pi-sessions 默认开）、overrides 与持久化往返", async () => {
  const cfgDir = await mkdtemp(join(tmpdir(), "aiti-backup-cfg-"));
  const cfg = await core.loadConfig(cfgDir);
  assert.equal(cfg.keepCount, 7);
  assert.equal(cfg.dest, "");
  const home = await mkdtemp(join(tmpdir(), "aiti-backup-home-"));
  await mkdir(join(home, ".pi", "agent", "sessions"), { recursive: true });
  cfg.dest = join(cfgDir, "backups");
  cfg.sourceOverrides["pi-sessions"] = { enabled: false };
  await core.saveConfig(cfgDir, cfg);
  const cfg2 = await core.loadConfig(cfgDir);
  assert.equal(cfg2.dest, cfg.dest);
  assert.deepEqual(cfg2.sourceOverrides["pi-sessions"], { enabled: false });
  const sources = await core.effectiveSources(cfg2, { home, dataRoot: null });
  const pi = sources.find((s) => s.id === "pi-sessions");
  assert.ok(pi);
  assert.equal(pi.enabled, false); // 显式关
  await rm(cfgDir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("state 源自动发现：<dataRoot>/*/state/ 即源，跳过自身与无 state 目录", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "aiti-backup-data-"));
  await mkdir(join(dataRoot, "session-manager", "state", "archive"), { recursive: true });
  await mkdir(join(dataRoot, "aiti-backup", "state"), { recursive: true });
  await mkdir(join(dataRoot, "no-state-ext"), { recursive: true });
  const found = await core.discoverStateSources(dataRoot, { selfId: "aiti-backup" });
  assert.deepEqual(
    found.map((s) => s.id),
    ["session-manager"]
  );
  await rm(dataRoot, { recursive: true, force: true });
});
