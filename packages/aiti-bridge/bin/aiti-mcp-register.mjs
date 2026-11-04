#!/usr/bin/env node
/**
 * aiti-mcp-register — 把 aiti stdio shim 条目注册进各 agent 的 MCP 配置（幂等 + 版本守卫）
 *
 * 条目固定名 `aiti`、URL 不落配置：
 *   { "type": "stdio", "command": "node", "args": ["<aiti-mcp-shim.cjs 绝对路径>"], "env": { "AITI_SHIM_VERSION": "N" } }
 * 运行时由 shim 读 env AITI_BRIDGE_URL 协商端点（dev/prod/独立桥共享同一份配置，只差环境变量）。
 *
 * 版本守卫：条目 env map 里已记录的 AITI_SHIM_VERSION >= shim 当前版本且 shim 路径未变 → 不改写配置（--force 强制）。
 * 版本放 env map（stdio 条目标准字段，值域自由 string map）——顶层私有键（旧 _aitiShimVersion）会被
 * zcode/opencode 等严格 schema 宿主整条拒收（2026-09-16 退役，注册时自动迁移剥除）。
 * 版本号唯一来源 = shim 文件头 SHIM_VERSION 常量（本脚本读文件解析，不重复维护）。
 *
 * 用法：
 *   node aiti-mcp-register.mjs                          # auto：只写已存在的配置文件（不新建）
 *   node aiti-mcp-register.mjs --targets zcode,pi       # 显式目标（不存在会新建文件）
 *   node aiti-mcp-register.mjs --config-paths a.json,b.json
 *   node aiti-mcp-register.mjs --unregister [--targets …]
 *   参数：--dry-run / --force / --name <条目名，默认 aiti> / --shim-path <路径> / --version <N 覆盖>
 *
 * 目标（MCP_TARGETS）：pi（~/.config/mcp/mcp.json）zcode（~/.zcode/cli/config.json · mcp.servers 嵌套）
 *   claude（~/.claude.json + 项目 .mcp.json）cursor windsurf vscode（项目级）zed
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// core 加载：仓库检出用 src（TS 直跑，改动即生效）；装在 node_modules 里用 dist
// （Node 禁止对 node_modules 下 TS 做 type-stripping，src 路线仅仓库态可用）
const { registerAitiShim, unregisterAitiShim } = await (async () => {
  const coreDir = resolve(here, "..", "..", "aiti-devtools-core");
  const srcTs = resolve(coreDir, "src", "index.ts");
  return import(here.includes("node_modules") || !existsSync(srcTs) ? resolve(coreDir, "dist", "index.js") : srcTs);
})();
const LOCAL_SHIM = resolve(here, "aiti-mcp-shim.cjs");

/** 安装态 shim 首选（<webRoot>/node_modules/@aiti-ai/aiti-bridge，extman reconcile 装入；与仓库检出解耦） */
function defaultShimPath() {
  const installed = [
    process.env.AITI_WEB_ROOT && resolve(process.env.AITI_WEB_ROOT, "node_modules/@aiti-ai/aiti-bridge/bin/aiti-mcp-shim.cjs"),
    resolve(homedir(), ".pi/web/node_modules/@aiti-ai/aiti-bridge/bin/aiti-mcp-shim.cjs"),
    resolve(homedir(), ".pi/web-dev/node_modules/@aiti-ai/aiti-bridge/bin/aiti-mcp-shim.cjs"),
  ].filter(Boolean);
  for (const p of installed) {
    try { readFileSync(p); return p; } catch {}
  }
  return LOCAL_SHIM; // 兜底：本脚本所在目录（仓库检出或包内 bin）
}

function parseArgs(argv) {
  const out = { targets: "auto", configPaths: [], dryRun: false, force: false, name: null, shimPath: null, version: null, unregister: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--targets") out.targets = argv[++i].split(",");
    else if (a === "--config-paths") out.configPaths.push(...argv[++i].split(","));
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--shim-path") out.shimPath = resolve(argv[++i]);
    else if (a === "--version") out.version = parseInt(argv[++i], 10);
    else if (a === "--unregister") out.unregister = true;
    else if (a === "--help" || a === "-h") {
      console.log("aiti-mcp-register：注册 aiti stdio shim（固定名 aiti，URL 走 env AITI_BRIDGE_URL）\n  --targets a,b|auto  --config-paths p1,p2  --name <n>  --shim-path <p>  --version <N>\n  --dry-run  --force  --unregister");
      process.exit(0);
    } else { console.error("未知参数：" + a + "（--help 看用法）"); process.exit(1); }
  }
  return out;
}

/** 从 shim 源文件读 SHIM_VERSION（唯一来源；--version 可覆盖） */
function readShimVersion(shimPath) {
  const m = readFileSync(shimPath, "utf8").match(/SHIM_VERSION\s*=\s*(\d+)/);
  if (!m) { console.error("无法从 " + shimPath + " 解析 SHIM_VERSION（缺常量？）"); process.exit(1); }
  return parseInt(m[1], 10);
}

const opts = parseArgs(process.argv.slice(2));
const common = {
  serverName: opts.name || undefined,
  targets: opts.targets,
  configPaths: opts.configPaths.length ? opts.configPaths : undefined,
  dryRun: opts.dryRun,
  log: (l) => console.log(l),
};

if (opts.unregister) {
  const r = unregisterAitiShim(common);
  console.log(r.summary);
  process.exit(r.ok ? 0 : 1);
}

const shimPath = opts.shimPath || defaultShimPath();
const version = opts.version != null && !Number.isNaN(opts.version) ? opts.version : readShimVersion(shimPath);
const r = registerAitiShim({ ...common, shimPath, version, force: opts.force });
console.log(r.summary);
if (!r.changed && !opts.dryRun) console.log("（配置无变化——版本已是最新；升级 shim 后改其 SHIM_VERSION 再跑，或 --force）");
process.exit(r.ok ? 0 : 1);
