// 改写 staging 内的依赖引用为容器内 file: 路径（@aiti-ai/* 官方源就绪前的过渡）：
// 1) vendor tgz 重 pack：其自身 deps 里的 NAMES 引用改 file:/opt/vendor/<flat>.tgz（传递链闭环）
// 2) staged {extensions,pi-plugins,packages}/*/package.json 的 deps/devDeps 里 NAMES → file:
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const STAGE = process.argv[2];
const NAMES = [
  "@aiti-ai/ext-shared", "@aiti-ai/aiti-bridge", "@aiti-ai/aiti-devtools-core",
  "justget", "service-tunnels", "@aiti-ti/ddns",
];
const VENDOR_SRC = join(STAGE, "vendor", "npm");
const VENDOR_OUT = join(STAGE, "vendor", "rewritten");

const flatName = (pkgName, ver) =>
  `${pkgName.replace(/^@/, "").replace("/", "-")}-${ver}.tgz`;

// 1) vendor tgz 重写传递 deps
mkdirSync(VENDOR_OUT, { recursive: true });
const map = {}; // pkgName → 容器内 file: 值
for (const t of readdirSync(VENDOR_SRC).filter((f) => f.endsWith(".tgz"))) {
  const work = join(VENDOR_OUT, "w-" + t.replace(/\.tgz$/, ""));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execSync(`tar xzf ${JSON.stringify(join(VENDOR_SRC, t))} -C ${JSON.stringify(work)}`, { shell: true });
  const pj = join(work, "package", "package.json");
  const p = JSON.parse(readFileSync(pj, "utf8"));
  for (const sec of [p.dependencies, p.devDependencies]) {
    for (const n of NAMES) if (sec && sec[n]) sec[n] = `file:/opt/vendor/placeholder-${n}`;
  }
  writeFileSync(pj, JSON.stringify(p, null, 2) + "\n");
  const out = join(VENDOR_OUT, t);
  execSync(`cd ${JSON.stringify(work)} && npm pack --ignore-scripts --pack-destination ${JSON.stringify(VENDOR_OUT)} > /dev/null 2>&1 || npm pack --pack-destination ${JSON.stringify(VENDOR_OUT)} > /dev/null`, { shell: true });
  // npm pack 输出名由 name+version 决定——建立名字映射（deps 引用统一 file:/opt/vendor/<实际文件名>）
  const p2 = JSON.parse(readFileSync(pj, "utf8"));
  map[p2.name] = `file:/opt/vendor/${flatName(p2.name, p2.version)}`;
}
// 第二遍：用真实文件名修正第一遍的占位引用 + 校验 tgz 落盘
for (const t of readdirSync(VENDOR_OUT).filter((f) => f.endsWith(".tgz"))) {
  const work = join(VENDOR_OUT, "w-" + t.replace(/\.tgz$/, ""));
  const pj = join(work, "package", "package.json");
  const p = JSON.parse(readFileSync(pj, "utf8"));
  let ch = false;
  for (const sec of [p.dependencies, p.devDependencies]) {
    if (!sec) continue;
    for (const n of NAMES) if (sec[n] && map[n]) { sec[n] = map[n]; ch = true; }
  }
  if (ch) {
    writeFileSync(pj, JSON.stringify(p, null, 2) + "\n");
    execSync(`cd ${JSON.stringify(work)} && npm pack --ignore-scripts --pack-destination ${JSON.stringify(VENDOR_OUT)} > /dev/null 2>&1 || npm pack --pack-destination ${JSON.stringify(VENDOR_OUT)} > /dev/null`, { shell: true });
  }
}
console.log("[vendor-rewrite] tgz 传递链重写完成:", Object.keys(map).join(", "));

// 2) staged package.json 批量改写（deps/devDeps 里 NAMES → 容器内 file:）
let n = 0;
const rewrite = (dir) => {
  for (const d of readdirSync(dir)) {
    const pj = join(dir, d, "package.json");
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, "utf8"));
    let ch = false;
    for (const sec of [p.dependencies, p.devDependencies]) {
      if (!sec) continue;
      for (const nm of NAMES) if (sec[nm] && map[nm]) { sec[nm] = map[nm]; ch = true; }
    }
    if (ch) { writeFileSync(pj, JSON.stringify(p, null, 2) + "\n"); n++; }
  }
};
for (const sub of (process.argv[3] || "extensions pi-plugins packages").split(" ")) {
  const dir = join(STAGE, sub);
  if (existsSync(dir)) rewrite(dir);
}
console.log(`[vendor-rewrite] staged package.json 改写 ${n} 个`);
