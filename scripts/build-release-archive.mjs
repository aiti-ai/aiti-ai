#!/usr/bin/env node
// build-release-archive.mjs —— GitHub Releases 预构建产物打包（npm 渠道之外的第二分发渠道）。
//
// 产物 = npm 包内容（bin/extensions(.next dist)/public/patches/…，npm pack 权威过滤）
//        + node_modules 生产依赖闭包（npm ci --omit=dev；postinstall 的 patch-package
//        直接生效于闭包；原生模块按构建平台绑定）→ 单文件压缩包，解压即用、零 npm。
//
// 两种模式：
//   --from-tgz <path>  复用已打好的 npm tgz（CI：prepare job 的平台无关构建产物）
//   （无参）            本地自包含：git archive HEAD → 隔离 staging 完整构建 → pack → 闭包
//                      （同 build-bundled-package.mjs 的隔离语义，工作树状态无关）
//
// 用法：
//   node scripts/build-release-archive.mjs                     # 当前平台，完整构建
//   node scripts/build-release-archive.mjs --out /tmp/x.tar.gz
//   node scripts/build-release-archive.mjs --os linux --arch x64 --from-tgz x.tgz

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, arch as nodeArch, platform as nodePlatform } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);

const OUT = opt("--out");
const FROM_TGZ = opt("--from-tgz"); // CI 复用 prepare job 的 npm tgz
const LOCK = opt("--lock"); // package-lock.json（npm pack 硬排除 lock，闭包 npm ci 需单独传入）
const OS = opt("--os") || nodePlatform;
const ARCH = opt("--arch") || nodeArch;
const REGISTRY = process.env.AITI_PACK_REGISTRY || "";
const NODE_OPTIONS = process.env.NODE_OPTIONS || "--max-old-space-size=8192";

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const VERSION = pkg.version;

const run = (cmd, cwd, label) => {
  console.log(`\n[release] ${label || cmd}`);
  // shell:true（默认 shell）而非 bash -c——CI 的 windows runner 无 bash，命令保持跨平台形态
  const r = spawnSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true, env: { ...process.env, NODE_OPTIONS } });
  if (r.status !== 0) {
    console.error((r.stderr || "").slice(-1500));
    throw new Error(`${label || cmd} 失败 (exit ${r.status})`);
  }
  return r.stdout;
};

const t0 = Date.now();
const stage = join(tmpdir(), `aiti-release-${Date.now()}`);
mkdirSync(stage, { recursive: true });
console.log(`[release] v${VERSION} ${OS}-${ARCH}  staging: ${stage}`);

// ---- 1) 拿到平台无关的 npm tgz（含 .next + 扩展 dist）----
let tgzPath;
let lockPath = LOCK && existsSync(LOCK) ? LOCK : null;
if (FROM_TGZ && existsSync(FROM_TGZ)) {
  tgzPath = FROM_TGZ;
  if (!lockPath) throw new Error("--from-tgz 模式必须配 --lock（npm pack 硬排除 lock）");
  console.log(`[release] 复用 npm tgz: ${tgzPath}`);
} else {
  // 隔离完整构建（build-bundled-package.mjs 同语义）：HEAD 快照 → 构建 → pack
  run(`git archive HEAD | tar -x -C ${JSON.stringify(stage)}`, REPO, "git archive HEAD → staging");
  if (!lockPath) lockPath = join(stage, "package-lock.json");
  run("npm install --no-audit --no-fund --loglevel=error" + (REGISTRY ? ` --registry ${REGISTRY}` : ""), stage, "npm install（主包依赖）");
  run("npm run build", stage, "next build（.next）");
  const extRoot = join(stage, "extensions");
  const exts = readdirSync(extRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  let built = 0;
  const failed = [];
  for (const ext of exts) {
    const pjPath = join(extRoot, ext, "package.json");
    if (!existsSync(pjPath)) continue;
    let p;
    try { p = JSON.parse(readFileSync(pjPath, "utf8")); } catch { continue; }
    const bc = p.scripts?.["build:client"];
    if (!bc || bc.trim() === "true") continue;
    try {
      run("npm install --no-audit --no-fund --loglevel=error" + (REGISTRY ? ` --registry ${REGISTRY}` : ""), join(extRoot, ext), `install ${ext}`);
      run("npm run build:client", join(extRoot, ext), `build ${ext}`);
      built++;
    } catch (e) {
      failed.push(ext);
      console.error(`[release] ✗ ${ext}: ${e.message.slice(0, 120)}`);
    }
  }
  if (failed.length) throw new Error(`扩展构建失败: ${failed.join(", ")}`);
  console.log(`[release] 扩展 dist: built ${built}`);
  run("npm pack --pack-destination " + JSON.stringify(stage), stage, "npm pack（主包）");
  tgzPath = join(stage, `aiti-ai-pi-web-${VERSION}.tgz`);
}
if (!existsSync(tgzPath)) throw new Error(`npm tgz 缺失: ${tgzPath}`);

// ---- 2) 解包 → app/（npm pack 顶层目录固定 package/）+ 注入 lock 供闭包 npm ci ----
run(`tar xzf ${JSON.stringify(tgzPath)} -C ${JSON.stringify(stage)}`, stage, "解包 npm tgz");
const appDir = join(stage, "aiti-web");
cpSync(join(stage, "package"), appDir, { recursive: true });
rmSync(join(stage, "package"), { recursive: true, force: true });
if (!existsSync(lockPath)) throw new Error(`package-lock.json 缺失: ${lockPath}`);
cpSync(lockPath, join(appDir, "package-lock.json"));

// ---- 3) 生产依赖闭包（postinstall 的 patch-package 在闭包内生效；原生模块按当前平台绑定）----
run(
  "npm ci --omit=dev --no-audit --no-fund --loglevel=error" + (REGISTRY ? ` --registry ${REGISTRY}` : ""),
  appDir,
  `npm ci --omit=dev（${OS}-${ARCH} 闭包）`,
);

// ---- 4) 自检：关键构件齐全（扩展 dist / .next / patches / 无 node_modules 嵌套残留）----
const listing = execSync(`find . -path ./node_modules -prune -o -type f -print`, { cwd: appDir, encoding: "utf8", shell: true });
const count = (re) => (listing.match(new RegExp(re, "gm")) || []).length;
const checks = {
  "扩展 dist 文件": count("^\\./extensions/[^/]+/dist/[^/]+$"),
  ".next 条目": count("^\\./\\.next/"),
  "patches/": count("^\\./patches/"),
  "bin/pi-web.js": count("^\\./bin/pi-web\\.js$"),
};
console.log("\n[release] 自检:");
let bad = false;
for (const [k, v] of Object.entries(checks)) {
  if (v === 0) { bad = true; console.log(`  ✗ ${k}: 0`); }
  else console.log(`  ✓ ${k}: ${v}`);
}
if (bad) throw new Error("产物自检失败——构件缺失");

writeFileSync(join(appDir, "RELEASE.txt"), [
  `version=${VERSION}`,
  `platform=${OS}-${ARCH}`,
  `builtAt=${new Date().toISOString()}`,
  `node=${process.version}`,
].join("\n") + "\n");

// ---- 5) archive：顶层目录固定 aiti-web/。linux/darwin tgz；windows zip（Expand-Archive 只认 zip）----
const ext = OS === "win32" ? "zip" : "tar.gz";
const outName = `aiti-web-v${VERSION}-${OS}-${ARCH}.${ext}`;
const outPath = OUT || join(REPO, outName);
if (ext === "zip") {
  run(`powershell -NoProfile -Command "Compress-Archive -Path '${appDir.replace(/'/g, "''")}' -DestinationPath '${resolve(outPath).replace(/'/g, "''")}' -Force"`, stage, `zip → ${outName}`);
} else {
  run(`tar czf ${JSON.stringify(resolve(outPath))} aiti-web/`, stage, `tar → ${outName}`);
}

let sizeBytes;
try { sizeBytes = Number(execSync(`stat -c%s ${JSON.stringify(resolve(outPath))}`, { shell: true }).toString().trim()); }
catch { sizeBytes = Number(execSync(`wc -c < ${JSON.stringify(resolve(outPath))}`, { shell: true }).toString().trim()); }
console.log(`\n[release] 完成: ${outPath}（${(sizeBytes / 1048576).toFixed(1)} MB，总耗时 ${((Date.now() - t0) / 60000).toFixed(1)} min）`);

if (resolve(dirname(outPath)) !== resolve(stage)) rmSync(stage, { recursive: true, force: true });
