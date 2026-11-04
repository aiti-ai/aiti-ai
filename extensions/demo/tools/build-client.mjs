#!/usr/bin/env node
/**
 * demo · 构建 JSX client bundle（Vite lib mode → client/demo-jsx.mjs）
 *
 * 包装 `vite build`，确保 vite 从本扩展 node_modules 解析（扩展不依赖宿主安装）。
 * 源码：client/src/*.tsx；配置：vite.config.ts。
 *
 * 用法：node tools/build-client.mjs
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Windows 上 .bin/vite（无扩展名 sh 脚本）spawn 会 status=null 静默失败；
// 跨平台统一 node 直跑 vite.js 入口（.bin 垫片的真实目标，npm scripts 内部同做法）。
const viteJs = resolve(root, "node_modules", "vite", "bin", "vite.js");
const viteBin = (await import("node:fs")).existsSync(viteJs) ? viteJs : "vite";

const r = spawnSync(process.execPath, [viteBin, "build", "--config", resolve(root, "vite.config.ts")], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (r.status !== 0) {
  console.error("[demo] vite build 失败（exit " + r.status + "）。若提示找不到 vite：cd pi-web-ext/demo && npm install");
  process.exit(r.status ?? 1);
}
console.log("[demo] JSX client bundle → client/demo-jsx.mjs");
