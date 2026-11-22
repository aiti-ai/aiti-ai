#!/usr/bin/env node
/** 部署 aiti-pi-agent 到 ~/.pi/web{,-dev}/extensions/（默认双写；--prod 仅 prod、--dev 仅 dev；文件集须与部署树一致）。
 *  v0.2.0（拆分版）：pi 专一——pi-handle.ts + 共享层 fork-rpc/ 副本；旧 pi-rpc-spawn.ts / host-tools-bridge.ts 已移除。 */
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { notifyReconcile } from "../../_shared/reconcile-deps.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prod = process.argv.includes("--prod");
const devOnly = process.argv.includes("--dev");
const home = process.env.HOME || process.env.USERPROFILE;
const bases = [
  ...(prod ? [] : [join(home, ".pi", process.env.PI_WEB_DEV_DIR ? `web-${process.env.PI_WEB_DEV_DIR}` : "web-dev", "extensions")]),
  ...(devOnly ? [] : [join(home, ".pi", "web", "extensions")]),
];
const FILES = ["index.ts", "pi-handle.ts", "external-governance.ts", "package.json"];
const FORK_DIR = "fork-rpc";
const LEGACY = ["pi-rpc-spawn.ts", "host-tools-bridge.ts"];
for (const base of bases) {
  const dest = join(base, "aiti-pi-agent");
  mkdirSync(dest, { recursive: true });
  for (const f of FILES) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(dest, f));
  }
  // fork-rpc/ 共享层副本（input: spec.ts / wire.ts / cli-resolve.ts —— 同步脚本维护）
  const forkSrc = join(root, FORK_DIR);
  const forkDest = join(dest, FORK_DIR);
  mkdirSync(forkDest, { recursive: true });
  for (const f of readdirSync(forkSrc)) {
    if (statSync(join(forkSrc, f)).isFile() && f.endsWith(".ts")) cpSync(join(forkSrc, f), join(forkDest, f));
  }
  // 清理旧拆分残留（旧引擎文件）
  for (const f of LEGACY) rmSync(join(dest, f), { force: true });
  console.log(`[deploy] aiti-pi-agent → ${dest}`);
}

// ── 共享依赖 reconcile 通知（依赖进 <webRoot>/node_modules；允许失败，永不 throw）──
await notifyReconcile();

// ── 双实例热重载——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}