#!/usr/bin/env node
// dsh-market-index.mjs — generate the aiti ecosystem's DSH plugin-market
// index (format 1) from the npmjs registry.
//
// DSH's market mechanism (dsh-plugin-market + Discover tab + plugin_market
// tool) reads user-configured index URLs; DeepSeek ships no default index, so
// publishing our own JSON is how aiti dsh plugins become browsable/installable
// in the web Discover UI ("插件 → 实验性插件 → 自定义插件市场 → 添加索引源").
//
// Usage: node tools/dsh-market-index.mjs [--out integrations/dsh-market/index.json]
//
// - Package list: PLUGINS below (add future aiti dsh packages there).
// - versions: every published npmjs version, descending SemVer, with the
//   registry's publish time (Unix seconds) — the validator cannot check these
//   against the package, so this generator is the place that keeps them true.
// - engines.dsh: mirrors each package.json's `engines.dsh` declaration
//   (evaluated by dsh with includePrerelease:true, see dsh-app-boot
//   evaluatePluginCompatibility).
// - Validation: parseMarketIndex from @deepseek-ai/dsh-plugin-market-index —
//   pass `--validator <path-to-lib/index.js>` (or make the package resolvable
//   via node_modules); without it only structural self-checks run and a loud
//   warning is printed.
//
// The output file is committed at integrations/dsh-market/index.json — the
// raw.githubusercontent URL of that path is the stable index URL to configure
// in DSH.

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org/";

// aiti dsh plugin inventory — keep in sync when a new dsh package ships.
const PLUGINS = [
  {
    name: "@aiti-ai/dsh-secret-mask",
    title: { en: "Secret Mask (aiti)", zh: "密钥脱敏（aiti）" },
    description: {
      en: "Paste-safe by default: pasted tokens/keys become [REDACTED:*] placeholders before the model sees them, restored inside tool arguments before execution; tool outputs are redacted and an opt-in audit proves no raw value reaches the provider.",
      zh: "随手贴不泄密：贴入的 token/密钥在进入模型前替换为 [REDACTED:*] 占位符，工具参数执行前自动还原；工具输出同步脱敏，可选审计证明无真值上线。",
    },
    icon: "aiti.svg",
    category: "security",
    keywords: ["secrets", "redaction", "privacy", "dlp", "aiti"],
    enginesFallback: ">=0.1.1-rc.0",
  },
  {
    name: "@aiti-ai/aiti-devtools-dsh",
    title: { en: "aiti DevTools for DSH", zh: "aiti DevTools（DSH 版）" },
    description: {
      en: "In-process aiti-devtools bridge for DSH: page-injection debugging (DOM/CSS/console/network), 16 aiti_* agent tools and the AI cockpit mounted on DSH's own web server — browser debugging for the coding agent.",
      zh: "DSH 进程内 aiti-devtools 桥：页面注入调试（DOM/CSS/控制台/网络）、16 个 aiti_* agent 工具与 AI 驾驶舱挂载在 DSH 同端口——给编码 agent 配上浏览器调试。",
    },
    icon: "aiti.svg",
    category: "devtools",
    keywords: ["debugging", "devtools", "browser", "aiti"],
    enginesFallback: ">=0.1.1-rc.0",
  },
];

const CATEGORIES = {
  security: { title: { en: "Security & Privacy", zh: "安全与隐私" } },
  devtools: { title: { en: "Developer Tools", zh: "开发调试" } },
};

const outIdx = process.argv.indexOf("--out");
const OUT = outIdx >= 0 ? resolve(process.argv[outIdx + 1]) : join(REPO, "integrations", "dsh-market", "index.json");
const valIdx = process.argv.indexOf("--validator");
const VALIDATOR = valIdx >= 0 ? resolve(process.argv[valIdx + 1]) : "@deepseek-ai/dsh-plugin-market-index";
const regIdx = process.argv.indexOf("--registry");
const REGISTRY_EFF = regIdx >= 0 ? process.argv[regIdx + 1] : REGISTRY; // override for smoke tests (e.g. staging)

function packument(fullName) {
  const url = REGISTRY_EFF + fullName.replace("/", "%2f");
  const out = execSync(`curl -s --max-time 30 ${JSON.stringify(url)}`, { encoding: "utf8", timeout: 45_000, shell: true });
  const j = JSON.parse(out);
  if (!j || j.error || !j.versions) throw new Error(`packument unavailable for ${fullName}`);
  return j;
}

function semLt(a, b) {
  const pa = a.replace(/-\d*$/, "").split(".").map((x) => parseInt(x, 10));
  const pb = b.replace(/-\d*$/, "").split(".").map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

function sortVersionsDesc(versions) {
  return [...versions].sort((a, b) => (semLt(a, b) ? 1 : semLt(b, a) ? -1 : 0));
}

// npm staged-publishing artifact: a brand-new package's first CI publish is held
// as a `0.0.0-stage` placeholder ("Temporary package placeholder for staged
// publishing"); it is not an installable release and stays in the registry
// forever, so the index must not offer it.
const STAGE_PLACEHOLDER = /^0\.0\.0-stage$/;

function manifestEngines(pkgName) {
  // local source of truth: the synced mirror tree (integrations/<repo>/<pkg>/package.json)
  const found = scanIntegrationManifests(pkgName);
  return found?.engines?.dsh ?? null;
}

function scanIntegrationManifests(pkgName) {
  for (const repo of ["dsh-secret-mask", "dsh-web-ext", "opencode-ext", "openclaw-web-ext", "browser-ext"]) {
    const base = join(REPO, "integrations", repo);
    const direct = join(base, "package.json");
    const candidates = [direct];
    try {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory()) candidates.push(join(base, e.name, "package.json"));
      }
    } catch {}
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        if (j.name === pkgName) return j;
      } catch {}
    }
  }
  return null;
}

const index = {
  format: 1,
  title: { en: "aiti DSH Plugins", zh: "aiti DSH 插件" },
  description: {
    en: "aiti ecosystem plugins for DeepSeek Harness: session-level secret redaction, in-process browser devtools, and more.",
    zh: "aiti 生态的 DeepSeek Harness 插件：会话级密钥脱敏、进程内浏览器调试等。",
  },
  metadata: { categories: CATEGORIES, labels: {}, sortKeys: {} },
  plugins: [],
};

for (const p of PLUGINS) {
  let pk;
  try {
    pk = packument(p.name);
  } catch (e) {
    // not published yet (staged rollout): skip and list it once its first version ships
    console.warn(`[skip] ${p.name}: ${e.message}`);
    continue;
  }
  const versions = sortVersionsDesc(Object.keys(pk.versions)).filter((v) => !pk.versions[v].deprecated && !STAGE_PLACEHOLDER.test(v));
  if (versions.length === 0) {
    console.warn(`[skip] ${p.name}: no non-deprecated versions`);
    continue;
  }
  index.plugins.push({
    name: p.name,
    title: p.title,
    description: p.description,
    author: "aiti",
    homepage: "https://github.com/aiti-ai/aiti-ai#readme",
    repository: { url: "https://github.com/aiti-ai/aiti-ai", directory: repoDirectory(p.name) },
    metadata: { category: p.category, keywords: p.keywords, labels: [], sortKeys: {} },
    versions: versions.map((v) => ({
      version: v,
      publishTimestamp: Math.floor(new Date(pk.time?.[v] ?? Date.now()).getTime() / 1000),
      source: { type: "npm" },
      engines: { dsh: manifestEngines(p.name) ?? p.enginesFallback },
    })),
  });
}

function repoDirectory(pkgName) {
  for (const repo of ["dsh-secret-mask", "dsh-web-ext", "opencode-ext", "openclaw-web-ext", "browser-ext"]) {
    const base = join(REPO, "integrations", repo);
    if (existsSync(join(base, "package.json"))) continue; // repo dir itself is a package → root mapping
    try {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const p = join(base, e.name, "package.json");
        if (!existsSync(p)) continue;
        try {
          const j = JSON.parse(readFileSync(p, "utf8"));
          if (j.name === pkgName) return `integrations/${repo}/${e.name}`;
        } catch {}
      }
    } catch {}
  }
  return "integrations";
}

// ---- validate ----
async function validate() {
  try {
    const target = VALIDATOR.endsWith(".js") ? pathToFileURL(VALIDATOR).href : VALIDATOR;
    const m = await import(target);
    m.parseMarketIndex(JSON.parse(JSON.stringify(index)), "https://raw.githubusercontent.com/aiti-ai/aiti-ai/main/integrations/dsh-market/index.json");
    console.log("[validate] parseMarketIndex: VALID");
    return true;
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      console.warn("[validate] @deepseek-ai/dsh-plugin-market-index not resolvable — structural checks only.");
      console.warn("           run with NODE_PATH pointing at an install of the validator for the full check.");
      return index.format === 1 && index.plugins.every((p) => p.versions.length > 0);
    }
    console.error("[validate] INVALID:", e.path ?? "", e.reason ?? e.message);
    return false;
  }
}

const ok = await validate();
if (!ok) {
  console.error("index generation aborted (validation failed)");
  process.exit(1);
}
if (index.plugins.length === 0) {
  console.error("index generation aborted: no published packages to index (publish first, then regenerate)");
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(index, null, 2) + "\n");
const total = index.plugins.reduce((n, p) => n + p.versions.length, 0);
console.log(`[write] ${OUT} — ${index.plugins.length} plugins, ${total} versions`);
