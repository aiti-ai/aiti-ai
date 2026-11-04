/**
 * mcp-config.test.mjs —— MCP 配置注册（临时目录模拟各 agent 配置）
 * 用法：node test/mcp-config.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// HOME 隔离：HOME（POSIX）+ USERPROFILE（Windows os.homedir() 实际读取项）都指向临时目录，
// 模块 homeDir() 每次现取——auto 扫描只会看到临时目录下的「不存在」目标，绝不碰真实用户配置
const tmp = mkdtempSync(join(tmpdir(), "aiti-mcp-test-"));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const { registerMcp, unregisterMcp, detectStructureKey, MCP_TARGETS } = await import("../src/mcp-config.ts");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("✗ " + msg); } };

const quiet = () => {};
const URL = "http://localhost:5173/aiti/mcp/mcp";

// ---- 结构识别 ----
{
  ok(detectStructureKey({ mcpServers: {} }).key === "mcpServers", "识别 mcpServers");
  ok(detectStructureKey({ servers: {} }).key === "servers", "识别 servers（vscode）");
  ok(detectStructureKey({ mcp: {} }).key === "mcp", "识别 mcp（zed）");
  ok(detectStructureKey({ other: 1 }).inferred && detectStructureKey({ other: 1 }).key === "mcpServers", "无结构 → 推断 mcpServers");
  ok(detectStructureKey(null).inferred === true, "null 安全（推断 mcpServers）");
}

// ---- pi 风格：保留其他 server，merge 写入 ----
{
  const p = join(tmp, "pi-mcp.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { "chrome-devtools": { command: "npx" } } }, null, 2) + "\n");
  const r = registerMcp({ url: URL, serverName: "aiti-devtools", configPaths: [p], log: quiet });
  ok(r.ok && r.changed, "pi 风格写入 changed");
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  ok(cfg.mcpServers["chrome-devtools"].command === "npx", "原有 server 保留");
  ok(cfg.mcpServers["aiti-devtools"].type === "http" && cfg.mcpServers["aiti-devtools"].url === URL, "aiti-devtools 条目 type/http+url");
  ok(existsSync(p + ".bak"), "备份 .bak 存在");
  // 幂等
  const r2 = registerMcp({ url: URL, serverName: "aiti-devtools", configPaths: [p], log: quiet });
  ok(!r2.changed, "同 url 幂等（不写）");
}

// ---- 自定义 serverName ----
{
  const p = join(tmp, "pi-mcp2.json");
  writeFileSync(p, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
  registerMcp({ url: URL, serverName: "myapp-devtools", configPaths: [p], log: quiet });
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  ok(cfg.mcpServers["myapp-devtools"] && !cfg.mcpServers["aiti-devtools"], "自定义 serverName 条目");
}

// ---- vscode（servers 结构）与 zed（mcp 结构）----
{
  const v = join(tmp, "vscode-mcp.json");
  writeFileSync(v, JSON.stringify({ servers: { "web-reader": { type: "http", url: "x" } } }, null, 2) + "\n");
  registerMcp({ url: URL, configPaths: [v], log: quiet });
  const vc = JSON.parse(readFileSync(v, "utf8"));
  ok(vc.servers["aiti-devtools"].url === URL && vc.servers["web-reader"], "vscode servers 结构写入");

  const z = join(tmp, "zed-settings.json");
  writeFileSync(z, JSON.stringify({ mcp: { "other": { command: "x" } } }, null, 2) + "\n");
  registerMcp({ url: URL, configPaths: [z], log: quiet });
  const zc = JSON.parse(readFileSync(z, "utf8"));
  ok(zc.mcp["aiti-devtools"].url === URL && zc.mcp["other"], "zed mcp 结构写入");
}

// ---- 无结构文件 → 推断 mcpServers ----
{
  const p = join(tmp, "empty.json");
  writeFileSync(p, JSON.stringify({ version: 1 }, null, 2) + "\n");
  registerMcp({ url: URL, configPaths: [p], log: quiet });
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  ok(cfg.mcpServers["aiti-devtools"].url === URL && cfg.version === 1, "无结构推断 mcpServers + 保留原字段");
}

// ---- JSONC（zed settings.json 带注释/尾随逗号）----
{
  const z = join(tmp, "zed-jsonc.json");
  writeFileSync(z, `{
  // Zed 配置（注释）
  "mcp": { "other": { "command": "x" }, },
  "theme": "One Dark",
}`);
  registerMcp({ url: URL, configPaths: [z], log: quiet });
  const cfg = JSON.parse(readFileSync(z, "utf8"));
  ok(cfg.mcp["aiti-devtools"].url === URL && cfg.theme === "One Dark", "JSONC 注释/尾随逗号兼容写入");
}

// ---- dryRun：不写文件 ----
{
  const p = join(tmp, "dry.json");
  writeFileSync(p, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
  const r = registerMcp({ url: URL, configPaths: [p], dryRun: true, log: quiet });
  ok(r.changed === true && !JSON.parse(readFileSync(p, "utf8")).mcpServers["aiti-devtools"], "dryRun 报告 changed 但不写盘");
}

// ---- 显式 targets + projectDir（claude 项目 .mcp.json）----
{
  const proj = join(tmp, "proj");
  mkdirSyncRec(proj);
  writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
  const r = registerMcp({ url: URL, targets: ["claude"], projectDir: proj, log: quiet });
  ok(r.results.some((x) => x.path.endsWith(".mcp.json") && x.changed), "claude 项目 .mcp.json 写入");
  const cfg = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
  ok(cfg.mcpServers["aiti-devtools"].url === URL, "claude 项目条目");
}

// ---- auto 只写存在的 + configPaths 隔离（不给 configPaths 时自动扫，给了只处理指定文件）----
{
  const r = registerMcp({ url: URL, targets: "auto", configPaths: [join(tmp, "pi-mcp.json")], log: quiet });
  ok(r.ok, "auto 模式不报错（跳过不存在的）");
  ok(r.results.every((x) => x.path.includes(tmp)), "configPaths 给定时只处理指定文件（不碰 home 配置）");
  ok(r.results.some((x) => x.path.includes("pi-mcp.json")), "configPaths 文件被处理");
}

// ---- unregister ----
{
  const p = join(tmp, "unreg.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { "aiti-devtools": { type: "http", url: URL }, "keep": { command: "x" } } }, null, 2) + "\n");
  const r = unregisterMcp({ configPaths: [p], log: quiet });
  ok(r.changed, "unregister changed");
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  ok(!cfg.mcpServers["aiti-devtools"] && cfg.mcpServers["keep"], "条目移除、其余保留");
  const r2 = unregisterMcp({ configPaths: [p], log: quiet });
  ok(!r2.changed, "重复 unregister 幂等");
}

// ---- 目标表完整性 ----
{
  const keys = Object.keys(MCP_TARGETS);
  ok(["pi", "claude", "cursor", "windsurf", "vscode", "zed"].every((k) => keys.includes(k)), "目标表含 6 个 agent");
  for (const k of keys) ok(MCP_TARGETS[k].every((f) => typeof f.path === "function"), k + " 文件 path 函数");
}

function mkdirSyncRec(p) {
  // recursive 原生建链即可——旧实现按 "/" 手工切分在 Windows 盘符路径上产出非法段（D:\C:\...）
  mkdirSync(p, { recursive: true });
}

console.log(`\nmcp-config: ${pass} passed, ${fail} failed`);
rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
