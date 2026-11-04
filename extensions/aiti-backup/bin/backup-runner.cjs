#!/usr/bin/env node
/**
 * aiti-backup · 备份 runner（独立子进程，方案 §2.6）
 *
 * 重活隔离：扫描/硬链接/复制全在本进程，宿主只解析 stdout JSONL 进度。
 * 用法：
 *   node bin/backup-runner.cjs --source-id <id> --src <path> --dest <root> [--keep-count N] [--no-link]
 * stdout（JSONL，一行一个事件）：
 *   {"event":"start","sourceId":..,"snapshot":"..","total":N,"totalBytes":N,"mode":"incremental|full"}
 *   {"event":"progress","phase":"copy","done":n,"total":N,"bytes":B,"current":"rel"}
 *   {"event":"done","summary":{...}}     → 退出码 0
 *   {"event":"error","message":".."}     → 退出码 1（已运行=2，取消=130）
 *
 * 运行锁：<dest>/<sourceId>/.lock（wx 创建，pid 存活检查防并发同源备份；陈旧锁自动接管）。
 * 中断安全：SIGINT/SIGTERM → 删 .tmp-* 半成品 → 释放锁 → 非零退出；源永不触碰。
 */
"use strict";

const process = require("node:process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const core = require("../lib/backup-core.cjs");

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {}
}

function argOf(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

async function alive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/** 运行锁：wx 独占创建；已存在且 pid 存活 → 拒绝；陈旧（进程已死）→ 接管 */
async function acquireLock(lockPath) {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fsp.open(lockPath, "wx");
      await fh.write(payload, 0, "utf8");
      await fh.close();
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let prev = {};
      try {
        prev = JSON.parse(await fsp.readFile(lockPath, "utf8"));
      } catch {}
      if (await alive(prev.pid)) {
        const err = new Error("同源备份已在运行（pid=" + prev.pid + "，" + (prev.startedAt || "?") + "）");
        err.code = "LOCKED";
        throw err;
      }
      await fsp.unlink(lockPath).catch(() => {}); // 陈旧锁接管
    }
  }
  throw new Error("运行锁获取失败（" + lockPath + "）");
}

async function main() {
  const sourceId = argOf("--source-id");
  const srcPath = argOf("--src");
  const destRoot = path.resolve(argOf("--dest"));
  const keepCount = Number(argOf("--keep-count", "7")) || 0;
  const disableLink = process.argv.includes("--no-link");
  if (!sourceId || !srcPath || !destRoot) {
    emit({ event: "error", message: "缺少 --source-id / --src / --dest" });
    process.exitCode = 1;
    return;
  }

  // 目的地安全校验（宿主已校验过，此处双保险）
  await core.validateDestination(destRoot, [srcPath], { home: require("node:os").homedir() });

  const sourceDir = path.join(destRoot, sourceId);
  const snapRoot = path.join(sourceDir, "snapshots");
  await fsp.mkdir(snapRoot, { recursive: true });
  const lockPath = path.join(sourceDir, ".lock");
  await acquireLock(lockPath);

  const signal = { aborted: false };
  let finalized = false;
  const releaseLock = () =>
    fsp.unlink(lockPath).catch(() => {});
  const cleanupAndExit = async (code, message) => {
    if (finalized) return;
    finalized = true;
    await core.cleanupTmp(snapRoot).catch(() => {});
    await releaseLock();
    if (message) emit({ event: "error", message });
    process.exitCode = code;
  };
  process.on("SIGINT", () => {
    signal.aborted = true;
    cleanupAndExit(130, "aborted (SIGINT)");
  });
  process.on("SIGTERM", () => {
    signal.aborted = true;
    cleanupAndExit(130, "aborted (SIGTERM)");
  });

  try {
    // 半成品清理（上次中断残留）+ 增量基底
    const stale = await core.cleanupTmp(snapRoot);
    if (stale.length) emit({ event: "progress", phase: "cleanup-tmp", done: stale.length, total: stale.length, bytes: 0, current: stale.join(",") });
    const prev = await core.findLatestValidSnapshot(snapRoot);
    const scan = await core.scanSource(srcPath);
    emit({
      event: "start",
      sourceId,
      total: scan.files.length,
      totalBytes: scan.totalBytes,
      mode: prev ? "incremental" : "full",
    });
    const result = await core.backupSnapshot({
      srcPath,
      destRoot,
      sourceId,
      keepCount,
      prevManifest: prev ? prev.manifest : null,
      prevSnapshotName: prev ? prev.name : null,
      disableLink,
      signal,
      onProgress: (p) => emit(Object.assign({ event: "progress" }, p)),
    });
    await releaseLock();
    finalized = true;
    emit({
      event: "done",
      summary: {
        sourceId,
        snapshot: result.snapshotName,
        dir: result.dir,
        mode: result.manifest.mode,
        stats: result.manifest.stats,
        pruned: result.pruned,
      },
    });
    process.exitCode = 0;
  } catch (e) {
    if (e && e.code === "ABORTED") {
      await cleanupAndExit(130, "aborted");
    } else if (e && e.code === "LOCKED") {
      await cleanupAndExit(2, e.message);
    } else {
      await cleanupAndExit(1, (e && (e.code + " " + e.message)) || String(e));
    }
  }
}

main().catch((e) => {
  emit({ event: "error", message: String((e && e.stack) || e) });
  process.exitCode = 1;
});
