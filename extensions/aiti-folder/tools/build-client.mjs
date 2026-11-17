#!/usr/bin/env node
/**
 * 构建 aiti-folder JSX client bundle（Vite lib mode → client/aiti-folder-client.mjs）
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
  console.error("[aiti-folder] vite build 失败（exit " + r.status + "）。若提示找不到 vite：cd pi-web-ext/aiti-folder && npm install");
  process.exit(r.status ?? 1);
}
console.log("[aiti-folder] JSX client bundle → client/aiti-folder-client.mjs");

// ── 构建后冒烟：裸未定义标识符检测（esbuild 对未定义全局静默放行，运行时才崩——
//    MiEyeOff/createGitOpsApi/MiPlus 三次同族事故的构建期拦截）。原理：minify 会重命名
//    一切合法绑定，产物中出现完整原名 = 未被绑定的裸引用（排除字符串字面量/属性访问/成员访问）。──
{
  const fsSmoke = await import("node:fs");
  const smokeBad = [];
  const re = /(^|[\.\s,;:()\[\]{}!=<>+\-*/&|?%])(Mi[A-Z][a-zA-Z]+|createGitOpsApi)(?![\w$])/g;
  for (const f of fsSmoke.readdirSync(resolve(root, "dist"))) {
    if (!f.endsWith(".js") && !f.endsWith(".mjs")) continue;
    let c = fsSmoke.readFileSync(resolve(root, "dist", f), "utf8");
    // 剥注释（块/行）再扫——注释里的「与 XX 同形」字样会误报；只影响扫描文本，不写回
    c = c.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    let m;
    while ((m = re.exec(c)) !== null) {
      smokeBad.push(f + ": " + m[2] + " @ " + m.index);
    }
  }
  if (smokeBad.length) {
    console.error("[aiti-folder] 冒烟失败：产物含未绑定标识符（缺 import？）：\n  " + smokeBad.join("\n  "));
    process.exit(1);
  }
  console.log("[aiti-folder] 冒烟 ✓ 无裸未定义标识符");
}
