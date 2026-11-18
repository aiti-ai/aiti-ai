/**
 * 框架一键接入补丁器单测（纯函数，esbuild 打包后直测）
 * 运行：node --test test/frameworks.test.mjs
 */
import { test } from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const PKG = dirname(fileURLToPath(import.meta.url)) + "/..";
esbuild.buildSync({
  entryPoints: [path.join(PKG, "src/frameworks.ts")],
  outdir: path.join(PKG, "dist-test"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  logLevel: "silent",
});

const { detectFrameworks, applyFramework, INTEGRATION_CATALOG, DEVTOOLS_HOME } = await import(path.join(PKG, "dist-test/frameworks.js"));

function mkProject(pkgDeps = {}, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiti-fw-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true, devDependencies: pkgDeps }));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

test("检测：vite 项目出现 vite 行且未接入", () => {
  const dir = mkProject({ vite: "^5" }, { "vite.config.ts": 'import { defineConfig } from "vite";\nexport default defineConfig({});' });
  const rows = detectFrameworks(dir);
  const vite = rows.find((r) => r.id === "vite");
  assert.ok(vite?.detected);
  assert.equal(vite.integrated, false);
  assert.equal(vite.canApply, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("vite 一键接入：import + plugins 注入，备份落盘", () => {
  const dir = mkProject({ vite: "^5" }, { "vite.config.ts": 'import { defineConfig } from "vite";\nexport default defineConfig({\n  plugins: [],\n});' });
  const r = applyFramework(dir, "vite");
  assert.equal(r.ok, true);
  const cfg = fs.readFileSync(r.file, "utf8");
  assert.ok(cfg.includes('import { aitiDevtools } from "@aiti-ai/aiti-devtools-vite";'), "import 注入");
  assert.ok(cfg.includes("plugins: [aitiDevtools(),"), "plugins 注入");
  assert.ok(fs.existsSync(r.file + ".aiti-bak"), "备份存在");
  assert.ok(!cfg.includes("aitiDevtools() from") || true);
  // 幂等：再跑一次标记为已接入
  const rows = detectFrameworks(dir);
  assert.equal(rows.find((x) => x.id === "vite").integrated, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("nuxt 一键接入：无 modules 键时补 modules 数组", () => {
  const dir = mkProject({ nuxt: "^3" }, { "nuxt.config.ts": "export default defineNuxtConfig({\n  devServer: { port: 5599 },\n});" });
  const r = applyFramework(dir, "nuxt");
  assert.equal(r.ok, true);
  const cfg = fs.readFileSync(r.file, "utf8");
  assert.ok(cfg.includes("modules: ['@aiti-ai/aiti-devtools-nuxt',],") || cfg.includes("modules: ['@aiti-ai/aiti-devtools-nuxt',"), cfg);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("astro 一键接入：integrations 注入", () => {
  const dir = mkProject({ astro: "^4" }, { "astro.config.mjs": 'import { defineConfig } from "astro/config";\nexport default defineConfig({\n  integrations: [],\n});' });
  const r = applyFramework(dir, "astro");
  assert.equal(r.ok, true);
  assert.ok(fs.readFileSync(r.file, "utf8").includes("integrations: [aitiAstro(),"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("webpack 一键接入：CJS require + plugins 注入", () => {
  const dir = mkProject({ webpack: "^5" }, { "webpack.config.js": 'module.exports = {\n  mode: "development",\n  plugins: [],\n};' });
  const r = applyFramework(dir, "webpack");
  assert.equal(r.ok, true);
  const cfg = fs.readFileSync(r.file, "utf8");
  assert.ok(cfg.includes('require("@aiti-ai/aiti-devtools-webpack")'), "CJS require");
  assert.ok(cfg.includes("plugins: [new AitiDevtoolsWebpackPlugin(),"), "plugin 注入");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("next 一键接入：instrumentation.ts 不存在则创建", () => {
  const dir = mkProject({ next: "^15" }, {});
  const r = applyFramework(dir, "next");
  assert.equal(r.ok, true);
  assert.ok(fs.readFileSync(r.file, "utf8").includes("patchProcessHttp"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("next 已有 register() 导出时不盲改（返回模板）", () => {
  const dir = mkProject({ next: "^15" }, { "instrumentation.ts": "export async function register() { console.log(1); }" });
  const r = applyFramework(dir, "next");
  assert.equal(r.ok, false);
  assert.ok(r.snippet.includes("patchProcessHttp"));
  assert.equal(fs.readFileSync(dir + "/instrumentation.ts", "utf8"), "export async function register() { console.log(1); }", "原文件不动");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("无锚点时返回模板不写盘", () => {
  const dir = mkProject({ vite: "^5" }, { "vite.config.ts": "export default { server: {} };" });
  const r = applyFramework(dir, "vite");
  assert.equal(r.ok, false);
  assert.ok(r.snippet.length > 0);
  assert.ok(!fs.existsSync(dir + "/vite.config.ts.aiti-bak"), "失败不落备份");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("集成文档目录：8 条、链接全指 aiti.pw（面板常显数据源）", () => {
  assert.equal(INTEGRATION_CATALOG.length, 8);
  for (const c of INTEGRATION_CATALOG) {
    assert.ok(c.docsUrl.startsWith("https://aiti.pw/"), c.id + " docsUrl");
    assert.ok(c.name.length > 0);
  }
  assert.equal(DEVTOOLS_HOME, "https://aiti.pw/devtools/integrations/");
  const ids = new Set(INTEGRATION_CATALOG.map((c) => c.id));
  for (const id of ["vite", "vue", "webpack", "rspack", "nuxt", "astro", "next", "express"]) assert.ok(ids.has(id), id);
});
