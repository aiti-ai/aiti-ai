#!/usr/bin/env node
/**
 * 构建 aiti-ui-env JSX client bundle（Vite lib mode → client/aiti-ui-env-client.mjs）
 *
 * 源码：client/src/*.tsx；配置：vite.config.ts。
 * 用法：node tools/build-client.mjs   （或 npm run watch 自动重建）
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Windows 兼容：优先本机 vite.js（node 直接跑），否则 .bin 里的平台垫片（Linux sh / Windows cmd）
const viteJs = resolve(root, "node_modules", "vite", "bin", "vite.js");
const localBin = resolve(root, "node_modules", ".bin", "vite" + (process.platform === "win32" ? ".cmd" : ""));
let cmd, args;
if (existsSync(viteJs)) { cmd = process.execPath; args = [viteJs]; }
else if (existsSync(localBin)) { cmd = localBin; args = []; }
else { cmd = "vite"; args = []; }

const r = spawnSync(cmd, [...args, "build", "--config", resolve(root, "vite.config.ts")], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32" && cmd !== process.execPath, // .cmd 垫片需 shell
});
if (r.status !== 0) {
  console.error("[aiti-ui-env] vite build 失败（exit " + r.status + "）。若提示找不到 vite：cd pi-web-ext/aiti-ui-env && npm install");
  process.exit(r.status ?? 1);
}
console.log("[aiti-ui-env] JSX client bundle → client/aiti-ui-env-client.mjs");
