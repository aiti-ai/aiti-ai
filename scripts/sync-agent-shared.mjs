#!/usr/bin/env node
/**
 * 同步 agent 家族共享层副本 → 消费扩展目录（副本同步机制，同 sync-pi-fork-rpc.mjs 先例）。
 *
 * 与 pi-fork-rpc 的差异：这批共享文件（spawn env / 治理 / recycle / 队列 / 登录 / 模型目录等）
 * 消费方较多且各自演进过，**动态发现**消费副本——只同步「已存在副本」的扩展目录，
 * 不主动向新扩展添加副本（新扩展应显式拷贝并在 deploy FILES 声明）。
 *
 * 用法：node scripts/sync-agent-shared.mjs [--check]
 *   --check  只校验副本与权威源一致（有差异退出码 1，不写盘）
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sharedDir = join(root, "extensions", "_shared");
const extRoot = join(root, "extensions");

// 权威源文件清单（_shared/ → 各消费扩展副本）
const FILES = [
  "agent-spawn-env.ts",
  "external-cli-governance.ts",
  "session-recycle.ts",
  "ext-model-state.ts",
  "backend-queue.ts",
  "exec-async.ts",
  "controlled-login.mjs",
  "controlled-login-dialog.mjs",
  "cbc-model-catalog.ts",
  "agent-accounts.ts",
  "cursor-cli-store.ts",
];

const checkOnly = process.argv.includes("--check");
let dirty = 0, synced = 0;

for (const file of FILES) {
  const src = join(sharedDir, file);
  if (!existsSync(src)) {
    console.log(`[sync-agent-shared] SKIP（权威源缺失）: _shared/${file}`);
    continue;
  }
  for (const entry of readdirSync(extRoot)) {
    const dir = join(extRoot, entry);
    if (!statSync(dir).isDirectory() || entry === "_shared") continue;
    const dest = join(dir, file);
    if (!existsSync(dest)) continue; // 只管已存在的副本
    if (readFileSync(src).equals(readFileSync(dest))) continue;
    if (checkOnly) {
      console.log(`[sync-agent-shared] DRIFT: ${entry}/${file}`);
      dirty++;
    } else {
      copyFileSync(src, dest);
      synced++;
    }
  }
}

if (checkOnly) {
  if (dirty > 0) {
    console.log(`[sync-agent-shared] ${dirty} 处副本与权威源不一致（运行 node scripts/sync-agent-shared.mjs 同步）`);
    process.exit(1);
  }
  console.log("[sync-agent-shared] 副本一致 ✓");
} else {
  console.log(`[sync-agent-shared] synced ${synced} 个副本`);
}
