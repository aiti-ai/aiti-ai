#!/usr/bin/env node
/**
 * 构建 aiti-ai-usage JSX client bundle（Vite lib mode → client/aiti-ai-usage.mjs）
 *
 * 源码：client/src/*.tsx；配置：vite.config.ts。
 * 用法：node tools/build-client.mjs   （或 npm run watch 自动重建）
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const viteJs = resolve(root, "node_modules", "vite", "bin", "vite.js");
const viteBin = existsSync(viteJs) ? viteJs : "vite";

const r = spawnSync(process.execPath, [viteBin, "build", "--config", resolve(root, "vite.config.ts")], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (r.status !== 0) {
  console.error("[aiti-ai-usage] vite build 失败（exit " + r.status + "）。若提示找不到 vite：cd pi-web-ext/aiti-ai-usage && npm install");
  process.exit(r.status ?? 1);
}
console.log("[aiti-ai-usage] JSX client bundle → client/aiti-ai-usage.mjs");
