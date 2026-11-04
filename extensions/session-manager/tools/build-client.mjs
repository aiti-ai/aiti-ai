#!/usr/bin/env node
/**
 * 构建 session-manager JSX client bundle（Vite lib mode → client/session-manager.mjs）
 *
 * 源码：client/src/*.tsx；配置：vite.config.ts。
 * 用法：node tools/build-client.mjs   （或 npm run watch 自动重建）
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Windows 上 .bin/vite（无扩展名 sh 脚本）不可直接执行（spawnSync 会 status=null 静默失败）；
// 跨平台统一用 node 直跑 vite 的 JS 入口（npm scripts 内部也是这么做的）。
const viteJs = resolve(root, "node_modules", "vite", "bin", "vite.js");
const viteBin = existsSync(viteJs) ? viteJs : "vite";

const r = spawnSync(process.execPath, [viteBin, "build", "--config", resolve(root, "vite.config.ts")], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env: { ...process.env, NODE_ENV: "production" },
});
if (r.status !== 0) {
  console.error("[session-manager] vite build 失败（exit " + r.status + "）。若提示找不到 vite：cd pi-web-ext/session-manager && npm install");
  process.exit(r.status ?? 1);
}
console.log("[session-manager] JSX client bundle → client/session-manager.mjs");
