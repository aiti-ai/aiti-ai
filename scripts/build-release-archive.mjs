#!/usr/bin/env node
// build-release-archive.mjs —— GitHub Releases 预构建产物打包（npm 渠道之外的第二分发渠道）。
//
// 产物 = 单一 universal 压缩包（aiti-web-v<ver>-universal.tar.gz + -universal.zip），
// 一个包通吃全部支持平台（linux/darwin x64+arm64、win32 x64+arm64），解压即用、零 npm。
//
// 内容 = npm 包内容（bin/extensions(.next dist)/public/patches/…，npm pack 权威过滤）
//        + node_modules 生产依赖闭包（npm install --omit=dev；postinstall 的 patch-package
//        直接生效于闭包）+ universal 后处理（见 postProcessUniversal —— 抹平平台差异、删死重）。
//
// 平台无关化原理（2026-11-14，v0.15.15-aiti.7 起替代 4 平台矩阵）：
//   - npm 渠道本就平台无关（optionalDependencies 在用户机安装时选平台二进制）；
//     release 包把闭包安装提前到构建机，平台才被固化。后处理把三件平台绑定物抹平：
//     @next/swc-<p> 删除（生产 serve 不用，实测断网全绿）、@img/sharp-<p> 换全平台
//     wasm32 兜底、@esbuild/<p> 补齐全平台（shim 运行时自选）。
//   - node-pty / pi-tui / quickjs-wasi 本就全平台 prebuild 自带，无需处理。
//
// 两种模式：
//   --from-tgz <path>  复用已打好的 npm tgz（CI：prepare job 的平台无关构建产物）
//   （无参）            本地自包含：git archive HEAD → 隔离 staging 完整构建 → pack → 闭包
//                      （同 build-bundled-package.mjs 的隔离语义，工作树状态无关）
//
// 用法：
//   node scripts/build-release-archive.mjs                     # 完整构建，输出双格式资产 + .sha256
//   node scripts/build-release-archive.mjs --out-dir /tmp/x    # 资产输出目录（默认仓库根）
//   node scripts/build-release-archive.mjs --postprocess-only <appDir>  # 只对现有闭包跑后处理（调试）

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, arch as nodeArch, platform as nodePlatform } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const POSTPROCESS_ONLY = args.includes("--postprocess-only") ? args[args.indexOf("--postprocess-only") + 1] : null;

const OUT_DIR = opt("--out-dir");
const FROM_TGZ = opt("--from-tgz"); // CI 复用 prepare job 的 npm tgz
const LOCK = opt("--lock"); // package-lock.json（npm pack 硬排除 lock，闭包 npm ci 需单独传入）
const OS = opt("--os") || nodePlatform; // 仅影响闭包安装平台；后处理抹平，资产与平台无关
const ARCH = opt("--arch") || nodeArch;
const REGISTRY = process.env.AITI_PACK_REGISTRY || "";
const NODE_OPTIONS = process.env.NODE_OPTIONS || "--max-old-space-size=8192";
// 风险开关：未来若生产启用需要 swc 的特性（reactCompiler / on-demand recompile 等），
// 置 AITI_RELEASE_KEEP_SWC=1 保留平台 swc 二进制——此时包重新平台绑定，workflow matrix 需一并恢复。
const KEEP_SWC = process.env.AITI_RELEASE_KEEP_SWC === "1";

// 全部路径统一绝对化——脚本后半段以临时 staging 为 cwd 跑命令，相对路径会被吞
const abs = (p) => (p ? resolve(p) : p);

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const VERSION = pkg.version;

const run = (cmd, cwd, label) => {
  console.log(`\n[release] ${label || cmd}`);
  // shell:true（默认 shell）而非 bash -c——CI 的 windows runner 无 bash，命令保持跨平台形态。
  // env 卫生：剔除 pi-web 实例运行时注入的 basePath/dist 变量——在 pi-web 进程树里跑本脚本
  // （aiti-cmd 面板/终端）会继承 PI_WEB_DEV_DIST=1 / PI_WEB_BASE_PATH=/dev 等，令 next build
  // 变成 dev 形态产物（distDir=.next-dev、路由带 /dev 前缀）；CI 干净环境不受影响，剔除后两端一致。
  const env = { ...process.env, NODE_OPTIONS };
  for (const k of ["PI_WEB_DEV_DIST", "PI_WEB_BASE_PATH", "PI_WEB_BUILD_BASEPATH", "PI_WEB_DIST_DIR"]) delete env[k];
  const r = spawnSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true, env });
  if (r.status !== 0) {
    console.error((r.stderr || "").slice(-1500));
    throw new Error(`${label || cmd} 失败 (exit ${r.status})`);
  }
  return r.stdout;
};

const dirSize = (p) => {
  try {
    const out = execSync(`du -sk ${JSON.stringify(p)}`, { encoding: "utf8", shell: true }).trim();
    return Number(out.split("\t")[0]) * 1024;
  } catch {
    return 0; // du 缺失（如 win32 本地跑）时退化为 0，只影响日志展示
  }
};
const fmt = (n) => `${(n / 1048576).toFixed(1)} MB`;

// npm pack 指定包并解到 node_modules/<name> 下——不用 npm install（会按 lock 重整整棵树，
// 把后处理删掉的平台二进制装回来），pack+untar 与 install 产物逐字节等效（这些包无 install 脚本）。
function packIntoNodeModules(appDir, spec, destRel) {
  const dest = join(appDir, "node_modules", destRel);
  if (existsSync(dest)) return false;
  const tmp = join(appDir, ".pack-tmp");
  // 清理前置：幂等重跑时残留的旧 tgz 会让下面的 readdir find 拿错包
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  run(`npm pack ${spec} --pack-destination ${JSON.stringify(tmp)} --loglevel=error` + (REGISTRY ? ` --registry ${REGISTRY}` : ""), appDir, `npm pack ${spec}`);
  const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`npm pack ${spec}: tgz not found`);
  mkdirSync(dest, { recursive: true });
  // 系统 tar（windows 上 System32 bsdtar）：Git Bash 的 GNU tar 会把 C:\ 路径当 host:path
  const TAR = nodePlatform === "win32" ? `${process.env.SystemRoot || "C:\\Windows"}\\System32\\tar.exe` : "tar";
  run(`${TAR} xzf ${JSON.stringify(join(tmp, tgz))} -C ${JSON.stringify(dest)} --strip-components=1`, appDir, `unpack ${tgz} → node_modules/${destRel}`);
  rmSync(tmp, { recursive: true, force: true });
  return true;
}

// universal 后处理：单包通吃所有平台 + 生产包死重清理。幂等（各项存在才处理）。
function postProcessUniversal(appDir) {
  const nm = join(appDir, "node_modules");
  if (!existsSync(nm)) throw new Error(`postProcessUniversal: node_modules missing under ${appDir}`);
  const sizeBefore = dirSize(appDir);
  const rmTree = (rel) => {
    const p = join(nm, rel);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  };

  // 1) @next/swc-<p>（每平台 87-191M，最大单项）：next start 生产服务不加载
  //    （.next 全预编译、middleware matcher 为空）。缺失时 Next 仅尝试在线下载、
  //    失败静默降级（实测：断网启动 116ms、页面/静态资源 200）。
  if (!KEEP_SWC) {
    const nextDir = join(nm, "@next");
    const swcVariants = existsSync(nextDir) ? readdirSync(nextDir).filter((e) => e.startsWith("swc-")) : [];
    for (const v of swcVariants) rmTree(join("@next", v));
    console.log(`[release] swc 平台二进制: removed ${swcVariants.length ? swcVariants.join(", ") : "(none present)"}`);
  } else {
    console.log("[release] swc 平台二进制: AITI_RELEASE_KEEP_SWC=1 → 保留（包将重新平台绑定）");
  }

  // 2) @img/sharp-<p> 平台二进制 → 保留全平台通用的 @img/sharp-wasm32 兜底
  //    （app 仅两处 next/image：登录 logo + 聊天头像；wasm 优化慢但功能完整）。
  //    linux 闭包 npm 平台过滤不装 wasm32 变体，这里按 sharp 主包版本补齐。
  const sharpKeep = new Set(["sharp-wasm32", "colour"]);
  const imgDir = join(nm, "@img");
  if (existsSync(imgDir)) {
    const removed = [];
    for (const e of readdirSync(imgDir)) {
      if (!sharpKeep.has(e) && (e.startsWith("sharp-") || e.startsWith("libvips-"))) {
        rmTree(join("@img", e));
        removed.push(e);
      }
    }
    console.log(`[release] sharp 平台二进制: removed ${removed.length ? removed.join(", ") : "(none)"}`);
  }
  const sharpPkg = JSON.parse(readFileSync(join(nm, "sharp", "package.json"), "utf8"));
  if (!existsSync(join(nm, "@img", "sharp-wasm32"))) {
    packIntoNodeModules(appDir, `@img/sharp-wasm32@${sharpPkg.version}`, join("@img", "sharp-wasm32"));
    console.log(`[release] sharp wasm32 兜底: installed @img/sharp-wasm32@${sharpPkg.version}`);
  }
  if (!existsSync(join(nm, "@emnapi", "runtime"))) {
    packIntoNodeModules(appDir, "@emnapi/runtime@1", join("@emnapi", "runtime"));
    console.log("[release] sharp wasm32 依赖: installed @emnapi/runtime@1");
  }

  // 3) @esbuild/<p> 补齐全平台（运行时真依赖：lib/ext/client-bundle.ts；
  //    esbuild JS shim 运行时按 process.platform/arch 自动选对应包，多平台共存无冲突）
  if (existsSync(join(nm, "esbuild"))) {
    const esbuildVersion = JSON.parse(readFileSync(join(nm, "esbuild", "package.json"), "utf8")).version;
    const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];
    const added = [];
    for (const p of platforms) {
      if (packIntoNodeModules(appDir, `@esbuild/${p}@${esbuildVersion}`, join("@esbuild", p))) added.push(p);
    }
    console.log(`[release] esbuild 全平台 @${esbuildVersion}: added ${added.length ? added.join(", ") : "(all present)"}`);
  }

  // 4) 生产死重（平台无关的纯浪费）：
  //    *.map（~128M source maps）、*.d.ts（~18M 类型声明）、@types/* + undici-types
  //    （纯类型包，运行时从不 require）、next/dist/docs（官方文档）、next 的 *.dev.js
  //    （dev-only runtime 变体）、openai/src（TS 源码，main=index.js 不经此路径）。
  const rmFile = (p) => rmSync(p, { force: true });
  const walk = (dir, cb) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".bin") continue; // npm 启动 shim，symlink 保留
        walk(p, cb);
      } else if (e.isFile() && !e.isSymbolicLink()) cb(p);
    }
  };
  let maps = 0;
  let dtypes = 0;
  let devJs = 0;
  walk(nm, (p) => {
    if (p.endsWith(".map")) (rmFile(p), maps++);
    else if (p.endsWith(".d.ts") || p.endsWith(".d.mts") || p.endsWith(".d.cts")) (rmFile(p), dtypes++);
    else if (p.startsWith(join(nm, "next")) && p.endsWith(".dev.js")) (rmFile(p), devJs++);
  });
  walk(join(appDir, ".next"), (p) => {
    if (p.endsWith(".map")) (rmFile(p), maps++);
  });
  rmTree("@types");
  rmTree("undici-types");
  rmTree(join("next", "dist", "docs"));
  rmTree(join("openai", "src"));
  console.log(`[release] 死重清理: ${maps} .map, ${dtypes} .d.ts, ${devJs} next dev bundles, @types/undici-types/docs/openai-src`);

  const sizeAfter = dirSize(appDir);
  console.log(`[release] app 目录: ${fmt(sizeBefore)} → ${fmt(sizeAfter)}（-${fmt(sizeBefore - sizeAfter)}）`);
}

const t0 = Date.now();

// ---- 全流程模式 ----
let appDir;
let stage = null;
if (!POSTPROCESS_ONLY) {
  stage = join(tmpdir(), `aiti-release-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  console.log(`[release] v${VERSION} universal（闭包构建机: ${OS}-${ARCH}）  staging: ${stage}`);

  // ---- 1) 拿到平台无关的 npm tgz（含 .next + 扩展 dist）----
  let tgzPath;
  let lockPath = LOCK ? abs(LOCK) : null;
  if (FROM_TGZ && existsSync(abs(FROM_TGZ))) {
    tgzPath = abs(FROM_TGZ);
    if (!lockPath) throw new Error("--from-tgz 模式必须配 --lock（npm pack 硬排除 lock）");
    console.log(`[release] 复用 npm tgz: ${tgzPath}`);
  } else {
    // 隔离完整构建（build-bundled-package.mjs 同语义）：HEAD 快照 → 构建 → pack
    run(`git archive HEAD | tar -x -C ${JSON.stringify(stage)}`, REPO, "git archive HEAD → staging");
    if (!lockPath) lockPath = join(stage, "package-lock.json");
    // --include=dev：build 需要 devDeps（typescript —— next 用它把 tsconfig paths 变成
    // webpack alias，缺了全局 @/ import 全部 Module not found）。NODE_ENV=production 的
    // 环境里 npm 默认 omit dev，显式声明免疫；npm pack 的 files 白名单不收 devDeps，无泄漏。
    run("npm install --include=dev --no-audit --no-fund --loglevel=error" + (REGISTRY ? ` --registry ${REGISTRY}` : ""), stage, "npm install（主包依赖）");
    run("npm run build", stage, "next build（.next）");
    const extRoot = join(stage, "extensions");
    const exts = readdirSync(extRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    let built = 0;
    const failed = [];
    for (const ext of exts) {
      const pjPath = join(extRoot, ext, "package.json");
      if (!existsSync(pjPath)) continue;
      let p;
      try {
        p = JSON.parse(readFileSync(pjPath, "utf8"));
      } catch {
        continue;
      }
      const bc = p.scripts?.["build:client"];
      if (!bc || bc.trim() === "true") continue;
      try {
        // --include=dev：同主包 install —— vite 在扩展 devDeps 里，NODE_ENV=production 的
        // 运行环境（如 pi-web 进程树）下 npm 默认 omit dev，不显式声明扩展 client 构建必挂
        run("npm install --include=dev --no-audit --no-fund --loglevel=error" + (REGISTRY ? ` --registry ${REGISTRY}` : ""), join(extRoot, ext), `install ${ext}`);
        run("npm run build:client", join(extRoot, ext), `build ${ext}`);
        built++;
      } catch (e) {
        failed.push(ext);
        console.error(`[release] ✗ ${ext}: ${e.message.slice(0, 120)}`);
      }
    }
    if (failed.length) throw new Error(`扩展构建失败: ${failed.join(", ")}`);
    console.log(`[release] 扩展 dist: built ${built}`);
    run(`node ${JSON.stringify(join(REPO, "scripts", "materialize-shared.mjs"))}`, stage, "materialize _shared sibling copies");
    run("npm pack --pack-destination " + JSON.stringify(stage), stage, "npm pack（主包）");
    tgzPath = join(stage, `aiti-ai-pi-web-${VERSION}.tgz`);
  }
  if (!existsSync(tgzPath)) throw new Error(`npm tgz 缺失: ${tgzPath}`);

  // ---- 2) 解包 → app/（npm pack 顶层目录固定 package/）+ 注入 lock 供闭包 npm ci ----
  // windows 显式用 System32 bsdtar：PATH 里 Git Bash 的 GNU tar 把 "D:\..." 当远程主机（host:path 语义）
  const TAR = OS === "win32" ? `${process.env.SystemRoot || "C:\\Windows"}\\System32\\tar.exe` : "tar";
  run(`${TAR} xzf ${JSON.stringify(tgzPath)} -C ${JSON.stringify(stage)}`, stage, "解包 npm tgz");
  appDir = join(stage, "aiti-web");
  cpSync(join(stage, "package"), appDir, { recursive: true });
  rmSync(join(stage, "package"), { recursive: true, force: true });
  if (!existsSync(lockPath)) throw new Error(`package-lock.json 缺失: ${lockPath}`);
  cpSync(lockPath, join(appDir, "package-lock.json"));

  // ---- 3) 生产依赖闭包（postinstall 的 patch-package 在闭包内生效）----
  // npm install 而非 ci：lock 的 resolved 已脱敏指向官方源，@aiti-ai/* 上官方源前
  // 在 ci 严格模式下必 404；install 会在 registry 不可达时按 configured registry 重解析
  run(
    "npm install --omit=dev --no-audit --no-fund --loglevel=error" + (REGISTRY ? ` --registry ${REGISTRY}` : ""),
    appDir,
    `npm install --omit=dev（${OS}-${ARCH} 闭包）`,
  );
} else {
  appDir = abs(POSTPROCESS_ONLY); // --postprocess-only：对现有闭包目录只跑后处理（调试用）
  console.log(`[release] postprocess-only: ${appDir}`);
}

// ---- 4) universal 后处理：抹平平台差异 + 删死重 ----
postProcessUniversal(appDir);

// ---- 5) 自检：关键构件齐全（扩展 dist / .next / patches / 无 node_modules 嵌套残留）----
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
  if (v === 0) {
    bad = true;
    console.log(`  ✗ ${k}: 0`);
  } else console.log(`  ✓ ${k}: ${v}`);
}
if (bad) throw new Error("产物自检失败——构件缺失");

writeFileSync(join(appDir, "RELEASE.txt"), [
  `version=${VERSION}`,
  `platform=universal`,
  `builtAt=${new Date().toISOString()}`,
  `node=${process.version}`,
].join("\n") + "\n");

// ---- 6) archive：单包双格式。顶层目录固定 aiti-web/。tgz 给 linux/darwin（tar 习惯），
// zip 给 windows（Expand-Archive 只认 zip）；内容逐字节相同。zip 用 zip 命令生成
// （POSIX 分隔符——Compress-Archive 的 '\\' 分隔符在非 Windows 解压工具下会解析残缺；
// 目录参数不带尾斜杠，否则 Info-ZIP 把它当裸目录条目报 "Nothing to do"）。
const outBase = `aiti-web-v${VERSION}-universal`;
const outDir = OUT_DIR ? abs(OUT_DIR) : REPO;
const appBase = appDir.split("/").pop().split("\\").pop(); // tar/zip 的打包根（全流程恒为 aiti-web）
mkdirSync(outDir, { recursive: true });

run(`tar czf ${JSON.stringify(join(outDir, `${outBase}.tar.gz`))} ${JSON.stringify(appBase)}`, dirname(appDir), `tar.gz → ${outBase}.tar.gz`);

let zipPath = join(outDir, `${outBase}.zip`);
if (nodePlatform === "win32") {
  // 开发者本地（windows）fallback：System32 bsdtar -a 按扩展名出 zip（POSIX 分隔符）
  run(`${process.env.SystemRoot || "C:\\Windows"}\\System32\\tar.exe -a -cf ${JSON.stringify(zipPath)} ${JSON.stringify(appBase)}`, dirname(appDir), `zip(bsdtar) → ${outBase}.zip`);
} else {
  run(`zip -qr ${JSON.stringify(zipPath)} ${JSON.stringify(appBase)}`, dirname(appDir), `zip → ${outBase}.zip`);
}

// ---- 7) sha256（随资产上传，release job 合并为 checksums.txt；更新器下载时校验）----
for (const asset of [join(outDir, `${outBase}.tar.gz`), zipPath]) {
  if (!existsSync(asset)) continue;
  const sha = spawnSync(`sha256sum ${JSON.stringify(asset)}`, { encoding: "utf8", shell: true });
  if (sha.status !== 0) throw new Error(`sha256sum failed for ${asset}`);
  writeFileSync(`${asset}.sha256`, sha.stdout);
  console.log(`[release] ${(sha.stdout.match(/^[0-9a-f]+/) || ["sha?"])[0].slice(0, 16)}…  ${asset.split("/").pop().split("\\").pop()}`);
}

const sizes = [join(outDir, `${outBase}.tar.gz`), zipPath].filter(existsSync).map((p) => `${p.split("/").pop().split("\\").pop()} ${fmt(dirSize(p))}`);
console.log(`\n[release] 完成: ${sizes.join(" · ")}（总耗时 ${((Date.now() - t0) / 60000).toFixed(1)} min）`);

// staging（staging/appDir 内含 800MB+ 闭包）在产物落 outDir 后已无价值，总是清理
if (!POSTPROCESS_ONLY) rmSync(stage, { recursive: true, force: true });
