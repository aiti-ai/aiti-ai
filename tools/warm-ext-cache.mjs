#!/usr/bin/env node
/**
 * 扩展 jiti 转译缓存预热（transform-only：只转译写盘、不执行扩展代码）。
 *
 * 背景：pi-web 扩展加载器（pi-web lib/ext/loader.ts）的 jiti fsCache 固定在
 * <webRoot()>/.cache/jiti（持久，重启不丢）。新机器安装 / 手动清缓存后，首次
 * 启动要对全部 TS 模块做 babel 全量转译（52 扩展 ~7.5s）。本脚本遍历扩展树的
 * 全部 TS 文件提前转译写盘（产物与真实加载的 cache 键/内容一致），把首启压回
 * 暖态 ~2s。每机一生只有一次价值，需要的人跑一次即可：
 *
 *   node tools/warm-ext-cache.mjs            # 生产根 ~/.pi/web
 *   node tools/warm-ext-cache.mjs --dev      # dev 根 ~/.pi/web-dev
 *   node tools/warm-ext-cache.mjs --web-root ~/.pi/web
 *
 * 不执行任何扩展代码（不 import entry）——jiti.transform 只走 getCache 转译路径，
 * 无顶层副作用（实测 aiti-qoder-agent 连 wasm client 都不会拉起）。
 * 注意：jiti 对语法错误不抛错（产物内嵌 __JITI_ERROR__ 标记，求值时才抛，与
 * 真实加载同参同行为）——本脚本「0 失败」≠ 语法健康，只代表转译写盘完成。
 * Windows（155）注意：缓存键含 hash(原样 filename)——若本脚本的 / 形态与宿主
 * loader 的实际形态分叉，预热退化为无害空转（键不同=miss，绝不误命中）；
 * POSIX（48/23）实测键与真实加载一致。
 *
 * 可整目录 rm -rf 缓存后重跑自愈（缓存契约，见方案文档 §1/§2.2）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// ---------- 参数 ----------
const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
if (args.includes("--help") || args.includes("-h")) {
  console.log("用法: warm-ext-cache.mjs [--dev] [--web-root <dir>] [--roots <dir,...>] [--pkg-dir <pi-web 仓>]");
  process.exit(0);
}

// ---------- webRoot / cacheDir（与 pi-web lib/ext/data-dir.ts 同语义）----------
function webRoot() {
  if (argOf("--web-root")) return resolve(argOf("--web-root"));
  return process.env.PI_WEB_DEV_DIST === "1" || args.includes("--dev")
    ? join(homedir(), ".pi", "web-dev")
    : join(homedir(), ".pi", "web");
}
const root = webRoot();
const cacheDir = process.env.PI_WEB_JITI_CACHE_DIR || join(root, ".cache", "jiti");

// ---------- 扩展根（真实加载会碰的根集合）----------
const roots = argOf("--roots")
  ? argOf("--roots").split(",").map((s) => resolve(s.trim())).filter(Boolean)
  : [join(root, "extensions"), ...(process.env.PI_WEB_EXTRA_EXTENSIONS_DIRS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean).map((s) => resolve(s))];

// ---------- jiti（从 pi-web 仓 node_modules 解析，与宿主同版本）----------
const pkgDir = argOf("--pkg-dir")
  ? resolve(argOf("--pkg-dir"))
  : resolve(dirname(fileURLToPath(import.meta.url)), ".."); // repo root (this package ships its own node_modules)
const requireFromPkg = createRequire(join(pkgDir, "package.json"));
const jitiPath = requireFromPkg.resolve("jiti");
const { createJiti } = await import(jitiPath);

const EXT_TS = /\.(ts|tsx|mts|cts)$/;
function collectFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      collectFiles(p, out);
    } else if (EXT_TS.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

// ---------- 预热：每扩展一个 jiti 实例（与 loader.ts 同参），transform-only ----------
const t0 = Date.now();
let files = 0;
let ok = 0;
const failures = [];
for (const extRoot of roots) {
  if (!existsSync(extRoot)) continue;
  for (const name of readdirSync(extRoot).filter((n) => !n.startsWith("."))) {
    const extDir = join(extRoot, name);
    if (!statSync(extDir).isDirectory()) continue;
    const tsFiles = collectFiles(extDir);
    if (tsFiles.length === 0) continue;
    const entry = join(extDir, "index.ts");
    // id 与 loader.ts 一致用入口文件（裸说明符从扩展目录解析）；transform 不解析
    // 依赖，alias 不影响产物。fsCache 与 loader 同目录 → 产物键/内容一致。
    const jiti = createJiti((existsSync(entry) ? entry : tsFiles[0]).replace(/\\/g, "/"), {
      interopDefault: true,
      moduleCache: false,
      fsCache: cacheDir,
    });
    for (const file of tsFiles) {
      files++;
      try {
        jiti.transform({ source: readFileSync(file, "utf8"), filename: file.replace(/\\/g, "/") });
        ok++;
      } catch (e) {
        failures.push({ file, msg: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}

console.log(`[warm-ext-cache] webRoot=${root}`);
console.log(`[warm-ext-cache] cache=${cacheDir}（预写 ${ok}/${files} 个 TS 文件，${Date.now() - t0}ms）`);
if (failures.length) {
  console.error(`[warm-ext-cache] ${failures.length} 个文件转译失败：`);
  for (const f of failures) console.error(`  - ${f.file}: ${f.msg.slice(0, 200)}`);
  process.exit(1);
}
console.log(`[warm-ext-cache] 完成。下次 pi-web 启动/reload 直接命中缓存（首启免全量重转译）。`);
