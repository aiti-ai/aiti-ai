#!/usr/bin/env node
/**
 * 构建 aiti-plan-review JSX client bundle（Vite lib mode → client/aiti-plan-review-client.mjs）
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
  // 密闭生产构建：无条件 NODE_ENV=production。外层 shell 带 NODE_ENV=development 时
  // （agent shell 继承 dev 实例环境很常见），esbuild 自动 JSX 会走 dev 运行时——
  // jsxDEV + 本机绝对路径定位对象打进产物，且与 48 端生产 bundle 漂移
  env: { ...process.env, NODE_ENV: "production" },
});
if (r.status !== 0) {
  console.error("[aiti-plan-review] vite build 失败（exit " + r.status + "）。若提示找不到 vite：cd pi-web-ext/aiti-plan-review && npm install");
  process.exit(r.status ?? 1);
}
console.log("[aiti-plan-review] JSX client bundle → client/aiti-plan-review-client.mjs");
