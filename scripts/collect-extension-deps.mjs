#!/usr/bin/env node
// collect-extension-deps.mjs —— 生成扩展共享构建根（extensions/.build-root/）的 package.json：
// deps+devDeps 全并集；@aiti-ai/* 官方源就绪前，本地 vendor tgz 用 overrides 注入
//（file: 协议依赖的「自身依赖」仍走 registry——overrides 把名字整体钉到 file，
// 传递依赖也一并满足，npm install 一次成型）。
//
// 用法：
//   node scripts/collect-extension-deps.mjs --out <path/package.json> \
//     --file "@aiti-ai/ext-shared=<tgz>" --file "@aiti-ai/aiti-bridge=<tgz>" ... \
//     --omit service-tunnels
//
// --file 可重复；overrides 只对 --file 列出的包生效（npmjs 有版面的包照常走 registry）。
// --omit：从并集剔除（npm 不装）——依赖名与可安装形态对不上的包（如 service-tunnels：
// 依赖写无 scope 名而仓内源 name 是 @aiti-ai/aiti-service-tunnels），由调用方以 symlink 兜住。

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."), "extensions");

const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? resolve(process.argv[i + 1]) : null;
})();
const OMIT = (() => {
  const i = process.argv.indexOf("--omit");
  return i >= 0 ? process.argv[i + 1].split(",").map((s) => s.trim()) : [];
})();
const FILE_MAP = {};
{
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") {
      const [name, path] = String(argv[i + 1] || "").split("=");
      if (name && path) FILE_MAP[name] = resolve(path);
      i++;
    }
  }
}

const union = {};
for (const d of readdirSync(ROOT)) {
  const pj = join(ROOT, d, "package.json");
  if (!existsSync(pj)) continue;
  let p;
  try { p = JSON.parse(readFileSync(pj, "utf8")); } catch { continue; }
  for (const section of [p.dependencies, p.devDependencies]) {
    for (const [name, spec] of Object.entries(section || {})) {
      // 共享根单版本语义（同 extman reconcile）：同名保留先见者
      if (!union[name]) union[name] = spec;
    }
  }
}
for (const name of OMIT) delete union[name];

const pkg = {
  name: "aiti-extensions-build-root",
  private: true,
  dependencies: union,
};
if (Object.keys(FILE_MAP).length) {
  // 直接依赖：值直接写 file:（npm 接受 file: 直接依赖，name 按包内 package.json 对号）；
  // 传递依赖（不在直接 deps，如 bridge→core）：用 overrides 钉住——override 与直接依赖
  // 值不同会报 EOVERRIDE，因此二者必须区分。file: 依赖自身的传递解析由后者兜住。
  pkg.overrides = {};
  for (const [name, path] of Object.entries(FILE_MAP)) {
    if (pkg.dependencies[name]) pkg.dependencies[name] = `file:${path}`;
    else pkg.overrides[name] = `file:${path}`;
  }
  if (!Object.keys(pkg.overrides).length) delete pkg.overrides;
}

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(pkg, null, 2) + "\n");
  console.error(`[collect] build-root package.json → ${OUT}（deps ${Object.keys(union).length}，overrides ${Object.keys(pkg.overrides || {}).length}）`);
} else {
  console.log(JSON.stringify(pkg, null, 2));
}
