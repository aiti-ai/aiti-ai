/**
 * 注册全目标矩阵测试（node --test）——钉死 MCP_TARGETS 六类异构配置格式：
 *   pi(mcpServers) / zcode(mcp.servers 嵌套 keyPath) / claude(~/.claude.json + 项目 .mcp.json) /
 *   cursor / windsurf / vscode(.vscode/mcp.json · servers 容器) / zed(settings.json · mcp 容器 · JSONC 注释)
 * 覆盖：registerAitiShim auto 全落位、generic registerMcp（http）异构容器、
 *   generic unregisterMcp（含 zcode keyPath）、dry-run、空配置结构推断、邻居保留。
 * 手法：import 前重定向 HOME 到沙箱目录（模块加载时捕获）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "aiti-targets-"));
process.env.HOME = SANDBOX; // 必须在 import 之前

const { registerAitiShim, unregisterAitiShim, registerMcp, unregisterMcp, detectStructureKey } = await import("./mcp-config.ts");

const mk = (p, text) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
const rd = (p) => JSON.parse(readFileSync(p, "utf8"));
const QUIET = () => {};
const SHIM = "/opt/fake/shim.cjs";

// 六类目标的沙箱路径
const P = {
  pi: join(SANDBOX, ".pi/agent/mcp.json"),
  zcode: join(SANDBOX, ".zcode/cli/config.json"),
  codebuddy: join(SANDBOX, ".codebuddy/.mcp.json"),
  claudeUser: join(SANDBOX, ".claude.json"),
  claudeProject: join(SANDBOX, "proj/.mcp.json"),
  cursor: join(SANDBOX, ".cursor/mcp.json"),
  windsurf: join(SANDBOX, ".codeium/windsurf/mcp_config.json"),
  vscode: join(SANDBOX, "proj/.vscode/mcp.json"),
  zedUser: join(SANDBOX, ".config/zed/settings.json"),
  zedProject: join(SANDBOX, "proj/.zed/settings.json"),
};

/** 预置全部目标文件（各自的原生格式 + 邻居条目），返回邻居快照用于保真断言 */
function seedAll() {
  mk(P.pi, JSON.stringify({ mcpServers: { keep_pi: { command: "x" } } }, null, 2));
  mk(P.zcode, JSON.stringify({ provider: { k: 1 }, mcp: { servers: { keep_zc: { type: "http", url: "http://z" } } } }, null, 2));
  mk(P.claudeUser, JSON.stringify({ mcpServers: { keep_cl: { command: "y" } }, projects: {} }, null, 2));
  mk(P.claudeProject, JSON.stringify({ mcpServers: {} }, null, 2));
  mk(P.cursor, JSON.stringify({ mcpServers: {} }, null, 2));
  mk(P.windsurf, JSON.stringify({ mcpServers: {} }, null, 2));
  mk(P.vscode, JSON.stringify({ servers: { keep_vs: { type: "http", url: "http://v" } } }, null, 2));
  mk(P.zedUser, '{\n  // zed settings 带注释\n  "theme": "One Dark",\n  "mcp": { "keep_zed": { "command": "z" } },\n}\n');
  mk(P.zedProject, '{ "mcp": {} }\n');
}

test("detectStructureKey：三种容器识别 + 空配置推断 mcpServers", () => {
  assert.deepEqual(detectStructureKey({ mcpServers: {} }), { key: "mcpServers", inferred: false });
  assert.deepEqual(detectStructureKey({ servers: {} }), { key: "servers", inferred: false });
  assert.deepEqual(detectStructureKey({ mcp: {} }), { key: "mcp", inferred: false });
  assert.deepEqual(detectStructureKey({}), { key: "mcpServers", inferred: true });
  assert.deepEqual(detectStructureKey({ other: 1 }), { key: "mcpServers", inferred: true });
});

test("shim 注册 auto：六类格式九个文件全部落位，容器/邻居/注释语义保真", () => {
  seedAll();
  const r = registerAitiShim({ shimPath: SHIM, version: 7, projectDir: join(SANDBOX, "proj"), log: QUIET });
  assert.ok(r.ok && r.changed);
  assert.equal(r.results.filter((x) => x.changed).length, 9, "九个目标文件全部写入");
  const entry = { type: "stdio", command: "node", args: [SHIM], env: { AITI_SHIM_VERSION: "7" } };
  assert.deepEqual(rd(P.pi).mcpServers.aiti, entry);
  assert.deepEqual(rd(P.zcode).mcp.servers.aiti, entry, "zcode 嵌套");
  assert.deepEqual(rd(P.claudeUser).mcpServers.aiti, entry);
  assert.deepEqual(rd(P.claudeProject).mcpServers.aiti, entry, "claude 项目级");
  assert.deepEqual(rd(P.cursor).mcpServers.aiti, entry);
  assert.deepEqual(rd(P.windsurf).mcpServers.aiti, entry);
  assert.deepEqual(rd(P.vscode).servers.aiti, entry, "vscode servers 容器");
  assert.deepEqual(rd(P.zedUser).mcp.aiti, entry, "zed mcp 容器（JSONC 源）");
  assert.deepEqual(rd(P.zedProject).mcp.aiti, entry);
  // 邻居与无关字段保真
  assert.ok(rd(P.pi).mcpServers.keep_pi);
  assert.ok(rd(P.zcode).mcp.servers.keep_zc && rd(P.zcode).provider.k === 1);
  assert.ok(rd(P.claudeUser).mcpServers.keep_cl && rd(P.claudeUser).projects);
  assert.ok(rd(P.vscode).servers.keep_vs);
  assert.ok(rd(P.zedUser).theme === "One Dark", "JSONC 注释源文件的其他字段保留");
});

test("generic registerMcp：http 条目写进 vscode(servers)/zed(mcp) 异构容器", () => {
  seedAll();
  const r = registerMcp({ url: "http://b:1/aiti/mcp", targets: ["vscode", "zed"], projectDir: join(SANDBOX, "proj"), log: QUIET });
  assert.ok(r.ok && r.changed);
  assert.deepEqual(rd(P.vscode).servers["aiti-devtools"], { type: "http", url: "http://b:1/aiti/mcp" });
  assert.deepEqual(rd(P.zedUser).mcp["aiti-devtools"], { type: "http", url: "http://b:1/aiti/mcp" });
  assert.deepEqual(rd(P.zedProject).mcp["aiti-devtools"], { type: "http", url: "http://b:1/aiti/mcp" }, "项目级 zed 也命中");
  assert.equal(rd(P.pi).mcpServers["aiti-devtools"], undefined, "未列入的目标不动");
});

test("generic registerMcp：空配置文件（结构推断）写入并新建 mcpServers 容器", () => {
  const p = join(SANDBOX, "empty-agent/cfg.json");
  mk(p, "{}");
  const r = registerMcp({ url: "http://b:2/mcp", configPaths: [p], log: QUIET });
  assert.ok(r.ok && r.changed);
  assert.deepEqual(rd(p), { mcpServers: { "aiti-devtools": { type: "http", url: "http://b:2/mcp" } } });
});

test("generic registerMcp dry-run：报告 changed 但零改写", () => {
  seedAll();
  const before = readFileSync(P.vscode, "utf8");
  const r = registerMcp({ url: "http://b:3/mcp", targets: ["vscode"], projectDir: join(SANDBOX, "proj"), dryRun: true, log: QUIET });
  assert.ok(r.changed, "dry-run 报告将会改变");
  assert.equal(readFileSync(P.vscode, "utf8"), before, "文件零改写");
});

test("codebuddy 目标：显式注册落 ~/.codebuddy/.mcp.json（mcpServers 容器）+ 邻居保留；auto 对不存在文件跳过", () => {
  mk(P.codebuddy, JSON.stringify({ mcpServers: { keep_cb: { command: "cb" } }, disabledMcpServers: [] }, null, 2));
  const r = registerAitiShim({ shimPath: SHIM, version: 9, targets: ["codebuddy"], log: QUIET });
  assert.ok(r.ok && r.changed);
  const entry = { type: "stdio", command: "node", args: [SHIM], env: { AITI_SHIM_VERSION: "9" } };
  assert.deepEqual(rd(P.codebuddy).mcpServers.aiti, entry, "codebuddy mcpServers 容器");
  assert.ok(rd(P.codebuddy).mcpServers.keep_cb, "邻居保留");
  assert.deepEqual(rd(P.codebuddy).disabledMcpServers, [], "无关字段保留");
  // unregister 清理 + 邻居保留
  const u = unregisterAitiShim({ targets: ["codebuddy"], log: QUIET });
  assert.ok(u.ok && u.changed);
  assert.equal(rd(P.codebuddy).mcpServers.aiti, undefined);
  assert.ok(rd(P.codebuddy).mcpServers.keep_cb);
});

test("generic unregisterMcp：跨异构目标清理（含 zcode keyPath），邻居保留", () => {
  seedAll();
  registerMcp({ url: "http://b:4/aiti/mcp", targets: ["pi", "zcode", "vscode", "zed"], projectDir: join(SANDBOX, "proj"), log: QUIET });
  const r = unregisterMcp({ targets: ["pi", "zcode", "vscode", "zed"], projectDir: join(SANDBOX, "proj"), log: QUIET });
  assert.ok(r.ok && r.changed);
  assert.equal(rd(P.pi).mcpServers["aiti-devtools"], undefined);
  assert.equal(rd(P.zcode).mcp.servers["aiti-devtools"], undefined, "zcode 嵌套条目被移除");
  assert.equal(rd(P.vscode).servers["aiti-devtools"], undefined);
  assert.equal(rd(P.zedUser).mcp["aiti-devtools"], undefined);
  assert.ok(rd(P.vscode).servers.keep_vs, "邻居保留");
});

test("shim unregister auto：九文件 aiti 全清、邻居全留", () => {
  seedAll();
  registerAitiShim({ shimPath: SHIM, version: 1, projectDir: join(SANDBOX, "proj"), log: QUIET });
  const r = unregisterAitiShim({ projectDir: join(SANDBOX, "proj"), log: QUIET });
  assert.ok(r.ok && r.changed);
  for (const p of [P.pi, P.zcode, P.claudeUser, P.claudeProject, P.cursor, P.windsurf, P.vscode, P.zedUser, P.zedProject]) {
    const cfg = rd(p);
    const container = cfg.mcpServers || cfg.servers || cfg.mcp || (cfg.mcp && cfg.mcp.servers);
    const entry = cfg.mcpServers?.aiti ?? cfg.servers?.aiti ?? cfg.mcp?.aiti ?? cfg.mcp?.servers?.aiti;
    assert.equal(entry, undefined, p + " 的 aiti 已移除");
    assert.ok(container, p + " 容器仍在");
  }
  assert.ok(rd(P.pi).mcpServers.keep_pi && rd(P.vscode).servers.keep_vs, "邻居条目全留");
});
