#!/usr/bin/env node
/**
 * 同步 pi-fork-rpc 共享层副本 → 消费扩展的 fork-rpc/ 子目录（副本同步机制）。
 *
 * 背景：扩展部署是「平铺文件拷贝」，源码阶段 import 的相对路径必须物理可达，
 * 跨扩展运行时共享沿用 _shared/cursor-cli-store 的副本同步先例。权威源在
 * `_shared/pi-fork-rpc/`（git 管理），两个消费扩展（aiti-pi-agent / aiti-omp-agent）
 * 各持一份 fork-rpc/ 副本（deploy 时随扩展拷入部署目录）。
 *
 * 用法：node scripts/sync-pi-fork-rpc.mjs [--check]
 *   --check  只校验副本与权威源一致（diff 有差异则退出码 1，不写盘）
 */
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "extensions", "_shared", "pi-fork-rpc");
const consumers = [
  join(root, "extensions", "aiti-pi-agent", "fork-rpc"),
  join(root, "extensions", "aiti-omp-agent", "fork-rpc"),
];
const FILES = ["spec.ts", "wire.ts", "cli-resolve.ts"];
const checkOnly = process.argv.includes("--check");

let dirty = false;
for (const dest of consumers) {
  if (!existsSync(dest)) {
    if (checkOnly) {
      console.log(`[sync-pi-fork-rpc] MISSING: ${dest}`);
      dirty = true;
    } else {
      console.log(`[sync-pi-fork-rpc] create ${dest}`);
    }
  }
  for (const f of FILES) {
    const s = join(src, f);
    const d = join(dest, f);
    if (!existsSync(d)) {
      if (checkOnly) {
        console.log(`[sync-pi-fork-rpc] MISSING: ${d}`);
        dirty = true;
      } else {
        cpSync(s, d);
        console.log(`[sync-pi-fork-rpc] create ${d}`);
      }
      continue;
    }
    const same = statSync(s).size === statSync(d).size && (readdirSync(src).length >= 0);
    // 内容级比较（size 不够严谨，但副本同步后由测试兜底；此处以文件 mtime/内容做廉价 diff）
    const { readFileSync } = await import("node:fs");
    if (readFileSync(s, "utf8") !== readFileSync(d, "utf8")) {
      if (checkOnly) {
        console.log(`[sync-pi-fork-rpc] DIFF: ${d}`);
        dirty = true;
      } else {
        cpSync(s, d);
        console.log(`[sync-pi-fork-rpc] synced ${d}`);
      }
    }
  }
}

if (checkOnly) {
  if (dirty) {
    console.error("[sync-pi-fork-rpc] 副本与权威源不一致——先跑 node scripts/sync-pi-fork-rpc.mjs");
    process.exit(1);
  }
  console.log("[sync-pi-fork-rpc] 副本一致 ✓");
}
