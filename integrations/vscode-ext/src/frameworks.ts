/**
 * 框架载体插件接入：检测项目框架 → 文档指引 → 一键应用（config 补丁，带 .aiti-bak 备份）
 *
 * 矩阵（与 examples/ 各 demo 的一行接入对齐）：
 *   Vite / SvelteKit / Vue   → @aiti-ai/aiti-devtools-vite     plugins: [aitiDevtools()]
 *   webpack / Rspack         → @aiti-ai/aiti-devtools-webpack  plugins: [new AitiDevtoolsWebpackPlugin()]
 *   Nuxt                     → @aiti-ai/aiti-devtools-nuxt     modules: ['@aiti-ai/aiti-devtools-nuxt']
 *   Astro                    → @aiti-ai/aiti-devtools-vite     integrations: [aitiAstro()]
 *   Next                     → @aiti-ai/aiti-devtools-core     instrumentation.ts register() + patchProcessHttp()
 *   Express                  → core connectBridge 中间件（手动，文档指引）
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { readdirSync } from "fs";
import { join } from "path";

export interface FrameworkRow {
  id: string;
  name: string;
  detected: boolean;
  configFile?: string;
  integrated: boolean;
  docsUrl: string;
  installPkg?: string;
  canApply: boolean;
}

const DOCS = "https://aiti.pw/devtools/integrations";

const QUICK_START = "https://aiti.pw/devtools/quick-start.html";

/** 全部集成文档目录（面板常显——没检测到框架也要能直达文档） */
export const INTEGRATION_CATALOG: Array<{ id: string; name: string; docsUrl: string; pkg?: string }> = [
  { id: "vite", name: "Vite (incl. Vue/SvelteKit)", docsUrl: `${DOCS}/vite.html`, pkg: "@aiti-ai/aiti-devtools-vite" },
  { id: "vue", name: "Vue", docsUrl: `${DOCS}/vue.html`, pkg: "@aiti-ai/aiti-devtools-vite" },
  { id: "webpack", name: "webpack", docsUrl: `${DOCS}/webpack-rspack.html`, pkg: "@aiti-ai/aiti-devtools-webpack" },
  { id: "rspack", name: "Rspack", docsUrl: `${DOCS}/webpack-rspack.html`, pkg: "@aiti-ai/aiti-devtools-webpack" },
  { id: "nuxt", name: "Nuxt", docsUrl: `${DOCS}/nuxt.html`, pkg: "@aiti-ai/aiti-devtools-nuxt" },
  { id: "astro", name: "Astro", docsUrl: `${DOCS}/astro.html`, pkg: "@aiti-ai/aiti-devtools-vite" },
  { id: "next", name: "Next.js", docsUrl: QUICK_START, pkg: "@aiti-ai/aiti-devtools-core" },
  { id: "express", name: "Express (manual)", docsUrl: `${DOCS}/manual.html`, pkg: "@aiti-ai/aiti-devtools-core" },
];
export const DEVTOOLS_HOME = "https://aiti.pw/devtools/integrations/";

function findConfig(wsRoot: string, patterns: RegExp[]): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(wsRoot);
  } catch {
    return undefined;
  }
  for (const pattern of patterns) {
    const hit = entries.find((e) => pattern.test(e));
    if (hit) {
      const full = join(wsRoot, hit);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

function readDeps(wsRoot: string): Set<string> {
  const out = new Set<string>();
  try {
    const pkg = JSON.parse(readFileSync(join(wsRoot, "package.json"), "utf8"));
    for (const key of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys(pkg[key] ?? {})) out.add(name);
    }
  } catch {
    /* 无 package.json */
  }
  return out;
}

function fileHas(path: string, re: RegExp): boolean {
  try {
    return re.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/** 补丁工具：在最后一个 import/require 行后插入 */
function insertImport(content: string, line: string): string {
  const lines = content.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(import\s|const\s+.*=\s*require\()/.test(lines[i])) last = i;
  }
  if (last >= 0) lines.splice(last + 1, 0, line);
  else lines.unshift(line);
  return lines.join("\n");
}

function patchAfterFirst(content: string, anchor: RegExp, insert: string): string | null {
  const m = content.match(anchor);
  if (!m) return null;
  const idx = m.index! + m[0].length;
  return content.slice(0, idx) + insert + content.slice(idx);
}

type PatchResult = { ok: true; file: string } | { ok: false; file?: string; snippet: string; reason: string };

function writePatched(file: string, next: string): PatchResult {
  copyFileSync(file, `${file}.aiti-bak`); // 改前备份（.aiti-bak），改坏可一键还原
  writeFileSync(file, next, "utf8");
  return { ok: true, file };
}

const VITE_IMPORT = 'import { aitiDevtools } from "@aiti-ai/aiti-devtools-vite";';
const ASTRO_IMPORT = 'import { aitiAstro } from "@aiti-ai/aiti-devtools-vite/astro";';
const WEBPACK_IMPORT_ESM = 'import { AitiDevtoolsWebpackPlugin } from "@aiti-ai/aiti-devtools-webpack";';
const WEBPACK_IMPORT_CJS = 'const { AitiDevtoolsWebpackPlugin } = require("@aiti-ai/aiti-devtools-webpack");';

function patchViteLike(file: string, importLine: string, entry: string): PatchResult {
  let c = readFileSync(file, "utf8");
  if (!c.includes(importLine.split(" from ")[0])) c = insertImport(c, importLine);
  if (/plugins\s*:/.test(c)) {
    const next = patchAfterFirst(c, /plugins\s*:\s*\[/, entry);
    if (!next) return { ok: false, file, snippet: entry, reason: "failed to insert after the plugins array anchor" };
    return writePatched(file, next);
  }
  // 无 plugins 键：在 defineConfig({ 后补
  const next = patchAfterFirst(c, /defineConfig\s*\(\s*\{/, `  plugins: [${entry}],\n`);
  if (!next) return { ok: false, file, snippet: `plugins: [${entry}]`, reason: "plugins/defineConfig anchor not found" };
  return writePatched(file, next);
}

function patchWebpack(file: string): PatchResult {
  let c = readFileSync(file, "utf8");
  const esm = /export\s+default|export\s+const/.test(c);
  if (!c.includes("AitiDevtoolsWebpackPlugin")) {
    c = insertImport(c, esm ? WEBPACK_IMPORT_ESM : WEBPACK_IMPORT_CJS);
  }
  if (/plugins\s*:/.test(c)) {
    const next = patchAfterFirst(c, /plugins\s*:\s*\[/, "new AitiDevtoolsWebpackPlugin(),");
    if (!next) return { ok: false, file, snippet: "new AitiDevtoolsWebpackPlugin()", reason: "plugins anchor insertion failed" };
    return writePatched(file, next);
  }
  return {
    ok: false,
    file,
    snippet: `plugins: [new AitiDevtoolsWebpackPlugin()]`,
    reason: "plugins array not found — add it manually at the top level of the config object",
  };
}

function patchNuxt(file: string): PatchResult {
  let c = readFileSync(file, "utf8");
  const mod = "'@aiti-ai/aiti-devtools-nuxt',";
  if (c.includes("@aiti-ai/aiti-devtools-nuxt")) return { ok: true, file };
  if (/modules\s*:/.test(c)) {
    const next = patchAfterFirst(c, /modules\s*:\s*\[/, mod);
    if (!next) return { ok: false, file, snippet: mod, reason: "modules anchor insertion failed" };
    return writePatched(file, next);
  }
  const next = patchAfterFirst(c, /defineNuxtConfig\s*\(\s*\{/, `  modules: [${mod}],\n`);
  if (!next) return { ok: false, file, snippet: `modules: ['@aiti-ai/aiti-devtools-nuxt']`, reason: "defineNuxtConfig anchor not found" };
  return writePatched(file, next);
}

function patchAstro(file: string): PatchResult {
  let c = readFileSync(file, "utf8");
  if (!c.includes("aitiAstro")) c = insertImport(c, ASTRO_IMPORT);
  if (/integrations\s*:/.test(c)) {
    const next = patchAfterFirst(c, /integrations\s*:\s*\[/, "aitiAstro(),");
    if (!next) return { ok: false, file, snippet: "aitiAstro()", reason: "integrations anchor insertion failed" };
    return writePatched(file, next);
  }
  const next = patchAfterFirst(c, /defineConfig\s*\(\s*\{/, "  integrations: [aitiAstro()],\n");
  if (!next) return { ok: false, file, snippet: "integrations: [aitiAstro()]", reason: "integrations/defineConfig anchor not found" };
  return writePatched(file, next);
}

const NEXT_INSTRUMENTATION = `// aiti-devtools Next 单端口集成（一行，与其他载体一致）：桥/资产/注入/MCP 注册全在 core
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV !== 'development') return;
  const { createRequire } = await import('node:module');
  const core = createRequire(process.cwd() + '/')('@aiti-ai/aiti-devtools-core');
  core.patchProcessHttp();   // 桥路由 + HTML 注入 + MCP 自动注册（PORT env 拼地址）
}
`;

function patchNext(wsRoot: string): PatchResult {
  const patterns = [/^instrumentation\.(ts|js|mts|mjs)$/, /^src\/instrumentation\.(ts|js|mts|mjs)$/, /^instrumentation-[^.]*\.(ts|js)$/];
  const existing = findConfig(wsRoot, patterns);
  if (existing) {
    if (fileHas(existing, /aiti-devtools-core|patchProcessHttp/)) return { ok: true, file: existing };
    // 已有 register 导出 → 不敢盲改，给模板让用户合并
    if (fileHas(existing, /export\s+(async\s+)?function\s+register|exports\.register/)) {
      return { ok: false, file: existing, snippet: NEXT_INSTRUMENTATION, reason: "existing register() export found — merge manually (template via clipboard prompt)" };
    }
    const next = readFileSync(existing, "utf8") + "\n" + NEXT_INSTRUMENTATION;
    return writePatched(existing, next);
  }
  const file = join(wsRoot, "instrumentation.ts");
  writeFileSyncDirect(file, NEXT_INSTRUMENTATION);
  return { ok: true, file };
}

function writeFileSyncDirect(file: string, body: string): void {
  writeFileSync(file, body, "utf8"); // 新文件无需备份
}

/** 项目框架矩阵（检测 + 接入状态 + 一键应用能力） */
export function detectFrameworks(wsRoot: string): FrameworkRow[] {
  const deps = readDeps(wsRoot);
  const has = (n: string) => deps.has(n);
  const viteCfg = findConfig(wsRoot, [/^vite\.config\.(ts|mts|js|mjs)$/]);
  const wpCfg = findConfig(wsRoot, [/^webpack\.config\.(js|ts|mjs|cjs)$/, /^webpack\.config\.dev\.(js|ts)$/]);
  const rspCfg = findConfig(wsRoot, [/^rspack\.config\.(js|ts|mjs|cjs)$/]);
  const nuxCfg = findConfig(wsRoot, [/^nuxt\.config\.(ts|js|mjs)$/]);
  const astCfg = findConfig(wsRoot, [/^astro\.config\.(mjs|ts|js)$/]);

  return [
    {
      id: "vite", name: "Vite / Vue / SvelteKit (Vite family)",
      detected: has("vite") || has("@sveltejs/kit") || !!viteCfg,
      configFile: viteCfg, integrated: !!viteCfg && fileHas(viteCfg, /aiti-devtools-vite/),
      docsUrl: `${DOCS}/vite.html`, installPkg: "@aiti-ai/aiti-devtools-vite", canApply: !!viteCfg,
    },
    {
      id: "webpack", name: "webpack",
      detected: has("webpack") || !!wpCfg,
      configFile: wpCfg, integrated: !!wpCfg && fileHas(wpCfg, /aiti-devtools-webpack|AitiDevtoolsWebpackPlugin/),
      docsUrl: `${DOCS}/webpack-rspack.html`, installPkg: "@aiti-ai/aiti-devtools-webpack", canApply: !!wpCfg,
    },
    {
      id: "rspack", name: "Rspack",
      detected: has("@rspack/core") || has("@rspack/cli") || !!rspCfg,
      configFile: rspCfg, integrated: !!rspCfg && fileHas(rspCfg, /aiti-devtools-webpack|AitiDevtoolsWebpackPlugin/),
      docsUrl: `${DOCS}/webpack-rspack.html`, installPkg: "@aiti-ai/aiti-devtools-webpack", canApply: !!rspCfg,
    },
    {
      id: "nuxt", name: "Nuxt",
      detected: has("nuxt") || !!nuxCfg,
      configFile: nuxCfg, integrated: !!nuxCfg && fileHas(nuxCfg, /aiti-devtools-nuxt/),
      docsUrl: `${DOCS}/nuxt.html`, installPkg: "@aiti-ai/aiti-devtools-nuxt", canApply: !!nuxCfg,
    },
    {
      id: "astro", name: "Astro",
      detected: has("astro") || !!astCfg,
      configFile: astCfg, integrated: !!astCfg && fileHas(astCfg, /aitiAstro|aiti-devtools-vite\/astro/),
      docsUrl: `${DOCS}/astro.html`, installPkg: "@aiti-ai/aiti-devtools-vite", canApply: !!astCfg,
    },
    {
      id: "next", name: "Next.js",
      detected: has("next"),
      integrated: fileHas(join(wsRoot, "instrumentation.ts"), /aiti-devtools-core/) ||
        fileHas(join(wsRoot, "instrumentation.js"), /aiti-devtools-core/),
      docsUrl: QUICK_START, installPkg: "@aiti-ai/aiti-devtools-core", canApply: true,
    },
    {
      id: "express", name: "Express（手动接入）",
      detected: has("express"),
      integrated: false,
      docsUrl: `${DOCS}/manual.html`, canApply: false,
    },
  ].filter((r) => r.detected || r.integrated);
}

/** 一键应用 */
export function applyFramework(wsRoot: string, id: string): PatchResult & { docsUrl?: string } {
  const rows = detectFrameworks(wsRoot);
  const row = rows.find((r) => r.id === id);
  switch (id) {
    case "vite":
    case "sveltekit":
      return row?.configFile ? patchViteLike(row.configFile, VITE_IMPORT, "aitiDevtools(),") : { ok: false, snippet: VITE_IMPORT, reason: "vite.config.* not found" };
    case "webpack":
      return row?.configFile ? patchWebpack(row.configFile) : { ok: false, snippet: WEBPACK_IMPORT_ESM, reason: "webpack.config.* not found" };
    case "rspack":
      return row?.configFile ? patchWebpack(row.configFile) : { ok: false, snippet: WEBPACK_IMPORT_ESM, reason: "rspack.config.* not found" };
    case "nuxt":
      return row?.configFile ? patchNuxt(row.configFile) : { ok: false, snippet: "modules: ['@aiti-ai/aiti-devtools-nuxt']", reason: "nuxt.config.* not found" };
    case "astro":
      return row?.configFile ? patchAstro(row.configFile) : { ok: false, snippet: ASTRO_IMPORT, reason: "astro.config.* not found" };
    case "next":
      return patchNext(wsRoot);
    default:
      return { ok: false, snippet: "", reason: "no one-click apply for this framework (see docs for manual integration)", docsUrl: row?.docsUrl };
  }
}
