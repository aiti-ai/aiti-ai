/**
 * aiti-msg-nav · 构建 JSX client bundle（Vite lib mode → client/aiti-msg-nav-client.mjs）
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
  console.error("[aiti-msg-nav] vite build 失败（exit " + r.status + "）。若提示找不到 vite：cd pi-web-ext/aiti-msg-nav && npm install");
  process.exit(r.status ?? 1);
}
console.log("[aiti-msg-nav] JSX client bundle → client/aiti-msg-nav-client.mjs");