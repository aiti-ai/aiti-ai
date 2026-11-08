#!/usr/bin/env node
/**
 * build.mjs —— aiti-devtools 浏览器扩展构建
 *
 * 从 src/ + core/assets（aiti-launcher.js 产物）生成 dist/{chrome,edge,firefox}
 *  - main.js（MAIN world）构建时内联 aiti-launcher.js 源码（file 顶层执行，不受页面 CSP）
 *  - manifest 按目标差异生成（Firefox 加 browser_specific_settings.gecko + gecko_android）
 *
 * 用法：node scripts/build.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // browser-ext/scripts
const root = resolve(here, "..");
const coreAssets = resolve(root, "..", "packages", "aiti-devtools-core", "assets");
const src = resolve(root, "src");
const dist = resolve(root, "dist");

const TARGETS = ["chrome", "edge", "firefox"];

const launcher = readFileSync(join(coreAssets, "aiti-launcher.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!launcher || launcher.length < 10000) {
  console.error("✗ core/assets/aiti-launcher.js 缺失或过小——先跑 packages/aiti-devtools-inject/tools/build.mjs + core/tools/build-assets.mjs");
  process.exit(1);
}

function buildTarget(target) {
  const out = join(dist, target);
  rmSync(out, { recursive: true, force: true });
  for (const d of ["content", "background", "popup", "options"]) mkdirSync(join(out, d), { recursive: true });

  // main.js：内联 launcher 源码（replace 回调避免 $ 替换语义）
  const mainTpl = readFileSync(join(src, "content", "main.js"), "utf8");
  if (mainTpl.indexOf("/*__LAUNCHER_CODE__*/") < 0) {
    console.error("✗ src/content/main.js 缺少占位符 /*__LAUNCHER_CODE__*/");
    process.exit(1);
  }
  const mainOut = mainTpl.replace("/*__LAUNCHER_CODE__*/", () => launcher);
  writeFileSync(join(out, "content", "main.js"), mainOut);

  const copy = (rel) => copyFileSync(join(src, rel), join(out, rel));
  // brand icons (same logo.svg as aiti-docs + rendered PNG family) — manifest icons / action.default_icon / popup & options header
  mkdirSync(join(out, "icons"), { recursive: true });
  for (const icon of ["logo.svg", "icon16.png", "icon32.png", "icon48.png", "icon128.png"])
    copyFileSync(join(root, "icons", icon), join(out, "icons", icon));
  copy("content/bridge.js");
  copy("background/sw.js");
  for (const f of ["popup.html", "popup.css", "popup.js"]) copy(join("popup", f));
  for (const f of ["options.html", "options.css", "options.js"]) copy(join("options", f));

  const manifest = {
    manifest_version: 3,
    name: "aiti devtools",
    version: pkg.version,
    description: pkg.description,
    author: "aiti-ai",
    homepage_url: "https://aiti.pw",
    permissions: ["storage", "activeTab", "scripting"],
    host_permissions: ["<all_urls>"],
    background: { service_worker: "background/sw.js" },
    content_scripts: [
      { matches: ["<all_urls>"], js: ["content/bridge.js"], run_at: "document_start", world: "ISOLATED" },
      { matches: ["<all_urls>"], js: ["content/main.js"], run_at: "document_idle", world: "MAIN" },
    ],
    action: {
      default_popup: "popup/popup.html",
      default_title: "aiti devtools",
      default_icon: { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
    },
    icons: { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
    options_ui: { page: "options/options.html", open_in_tab: true },
  };
  if (target === "chrome" || target === "edge") {
    // world:"MAIN" content scripts need Chromium 111+; older versions fail silently — declare explicitly
    // (firefox uses gecko strict_min_version 128 instead of minimum_chrome_version)
    manifest.minimum_chrome_version = "111";
  }
  if (target === "firefox") {
    // Firefox MV3 has no service_worker (Chromium-only) — event page model (background.scripts array)
    manifest.background = { scripts: ["background/sw.js"] };
    manifest.browser_specific_settings = {
      gecko: { id: "aiti-devtools@aiti.ai", strict_min_version: "128.0" },
      gecko_android: { strict_min_version: "128.0" },
    };
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("✓ dist/" + target + "（main.js 内联 launcher " + (launcher.length / 1024).toFixed(0) + "K）");
}

for (const t of TARGETS) buildTarget(t);
console.log("→ 完成：" + TARGETS.map((t) => "dist/" + t).join("  "));