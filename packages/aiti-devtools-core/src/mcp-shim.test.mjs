/**
 * aiti stdio shim 注册逻辑单测（node --test）。
 * 关键手法：**动态 import 前重定向 process.env.HOME 到临时目录**——模块加载时
 * `homedir()` 捕获 HOME，从而让 pi/zcode 等目标的配置文件全部落在测试沙箱。
 * 覆盖：zcode 嵌套 mcp.servers 写入、条目形状、幂等、版本守卫（>= 不动 / < 升级 / force）、
 * http 旧条目迁移（url 字段剔除）、JSONC 兼容、auto 只写已存在文件、显式目标新建缺失文件、
 * 通用 registerMcp 的 zcode keyPath 通路、unregister 只删 aiti。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "aiti-shim-reg-"));
process.env.HOME = SANDBOX; // 必须在 import 模块之前（HOME 在模块加载时捕获）

const { registerAitiShim, unregisterAitiShim, registerMcp } = await import("./mcp-config.ts");

const SHIM = "/opt/fake/aiti-mcp-shim.cjs";
const QUIET = () => {};
const PI_CFG = join(SANDBOX, ".pi/agent/mcp.json"); // pi 目标 = getAgentDir()/mcp.json（2026-09-10 修正）
const ZCODE_CFG = join(SANDBOX, ".zcode/cli/config.json");
const mk = (p, obj) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + "\n"); };
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

function setup() {
  mk(PI_CFG, { mcpServers: { "aiti-testagent": { command: "node", args: ["/x/y.cjs"] } } });
  mk(ZCODE_CFG, { mcp: { servers: { "aiti-devtools-dev": { type: "http", url: "http://127.0.0.1:30142/dev/api/extensions/aiti-devtools/mcp/mcp" } } }, provider: { x: 1 } });
}

test("auto 模式：只写已存在的配置（pi 平面 / zcode 嵌套），缺失目标不新建", () => {
  setup();
  const r = registerAitiShim({ shimPath: SHIM, version: 3, log: QUIET });
  assert.ok(r.ok && r.changed);
  const pi = read(PI_CFG);
  assert.deepEqual(pi.mcpServers.aiti, { type: "stdio", command: "node", args: [SHIM], env: { AITI_SHIM_VERSION: "3" } });
  assert.equal(pi.mcpServers["aiti-testagent"].args[0], "/x/y.cjs"); // 邻居条目原样
  const zc = read(ZCODE_CFG);
  assert.deepEqual(zc.mcp.servers.aiti, { type: "stdio", command: "node", args: [SHIM], env: { AITI_SHIM_VERSION: "3" } });
  assert.equal(zc.mcp.servers["aiti-devtools-dev"].type, "http"); // 邻居 http 条目不动
  assert.deepEqual(zc.provider, { x: 1 }); // 顶层无关字段保留
  // 未创建的目标（claude/cursor/...）没有被新建
  assert.ok(!existsSync(join(SANDBOX, ".claude.json")));
  assert.ok(!existsSync(join(SANDBOX, ".cursor/mcp.json")));
});

test("幂等：同版本二次注册零改写（字节级不变）", () => {
  setup();
  registerAitiShim({ shimPath: SHIM, version: 3, log: QUIET });
  const before = readFileSync(PI_CFG, "utf8"), beforeZ = readFileSync(ZCODE_CFG, "utf8");
  const r = registerAitiShim({ shimPath: SHIM, version: 3, log: QUIET });
  assert.equal(r.changed, false);
  assert.equal(readFileSync(PI_CFG, "utf8"), before);
  assert.equal(readFileSync(ZCODE_CFG, "utf8"), beforeZ);
});

test("版本守卫：已注册版本更新（99 > 3）→ 不动；force → 强制重写", () => {
  setup();
  registerAitiShim({ shimPath: SHIM, version: 3, log: QUIET });
  const zc = read(ZCODE_CFG);
  zc.mcp.servers.aiti.env.AITI_SHIM_VERSION = "99";
  writeFileSync(ZCODE_CFG, JSON.stringify(zc, null, 2));
  let r = registerAitiShim({ shimPath: SHIM, version: 3, log: QUIET });
  assert.equal(r.changed, false);
  assert.equal(read(ZCODE_CFG).mcp.servers.aiti.env.AITI_SHIM_VERSION, "99");
  r = registerAitiShim({ shimPath: SHIM, version: 3, force: true, log: QUIET });
  assert.equal(r.changed, true);
  assert.equal(read(ZCODE_CFG).mcp.servers.aiti.env.AITI_SHIM_VERSION, "3");
});

test("旧版迁移：顶层 _aitiShimVersion 键（严格 schema 宿主拒收）→ 无条件重写剥除并入 env", () => {
  setup();
  const zc = read(ZCODE_CFG);
  zc.mcp.servers.aiti = { type: "stdio", command: "node", args: [SHIM], _aitiShimVersion: 3 };
  writeFileSync(ZCODE_CFG, JSON.stringify(zc, null, 2));
  const r = registerAitiShim({ shimPath: SHIM, version: 3, log: QUIET });
  assert.equal(r.changed, true, "旧键在身即使版本号够新也必须迁移");
  const e = read(ZCODE_CFG).mcp.servers.aiti;
  assert.deepEqual(e, { type: "stdio", command: "node", args: [SHIM], env: { AITI_SHIM_VERSION: "3" } });
});

test("升级：v3 → v5 改写且保留邻居", () => {
  setup();
  registerAitiShim({ shimPath: SHIM, version: 3, log: QUIET });
  const r = registerAitiShim({ shimPath: SHIM + "2", version: 5, log: QUIET });
  assert.equal(r.changed, true);
  const zc = read(ZCODE_CFG);
  assert.deepEqual(zc.mcp.servers.aiti, { type: "stdio", command: "node", args: [SHIM + "2"], env: { AITI_SHIM_VERSION: "5" } });
  assert.ok(zc.mcp.servers["aiti-devtools-dev"]);
});

test("http 旧条目迁移：同名 http 条目（带 url）注册后 url 字段被剔除", () => {
  mk(PI_CFG, { mcpServers: { aiti: { type: "http", url: "http://old:1/mcp" } } });
  registerAitiShim({ shimPath: SHIM, version: 1, log: QUIET });
  const e = read(PI_CFG).mcpServers.aiti;
  assert.equal(e.url, undefined);
  assert.equal(e.type, "stdio");
  assert.equal(e.env.AITI_SHIM_VERSION, "1");
});

test("JSONC 兼容：带注释/尾随逗号的配置可解析可写入", () => {
  const p = join(SANDBOX, "jsonc", "cfg.json");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "{\n  // zed 风格注释\n  \"mcpServers\": {\"x\": {\"command\": \"y\",}},\n}\n");
  const r = registerAitiShim({ shimPath: SHIM, version: 1, configPaths: [p], log: QUIET });
  assert.ok(r.ok && r.changed);
  const e = read(p).mcpServers.aiti;
  assert.equal(e.args[0], SHIM);
});

test("configPaths 显式路径：auto 扫描关闭，只处理指定文件", () => {
  setup();
  const other = join(SANDBOX, "only-me.json");
  writeFileSync(other, "{}");
  const r = registerAitiShim({ shimPath: SHIM, version: 1, configPaths: [other], log: QUIET });
  assert.ok(r.ok && r.changed);
  assert.ok(read(other).mcpServers.aiti);
  assert.equal(read(PI_CFG).mcpServers.aiti, undefined); // 未列入的现存文件不动
});

test("显式 targets 且文件不存在：新建（含嵌套容器）", () => {
  const missing = join(SANDBOX, ".zcode/cli/config.json");
  const r = registerAitiShim({ shimPath: SHIM, version: 1, targets: ["zcode"], projectDir: SANDBOX, log: QUIET });
  assert.ok(r.ok && r.changed);
  assert.deepEqual(read(missing).mcp.servers.aiti, { type: "stdio", command: "node", args: [SHIM], env: { AITI_SHIM_VERSION: "1" } });
});

test("通用 registerMcp 的 zcode 通路：http 条目写进嵌套 mcp.servers", () => {
  setup();
  const r = registerMcp({ url: "http://127.0.0.1:8777/aiti/mcp", targets: ["zcode"], projectDir: SANDBOX, log: QUIET });
  assert.ok(r.ok && r.changed);
  const e = read(ZCODE_CFG).mcp.servers["aiti-devtools"];
  assert.deepEqual(e, { type: "http", url: "http://127.0.0.1:8777/aiti/mcp" });
});

test("unregister：只删 aiti、保留邻居；重复执行无变化", () => {
  setup();
  registerAitiShim({ shimPath: SHIM, version: 1, log: QUIET });
  let r = unregisterAitiShim({ log: QUIET });
  assert.ok(r.ok && r.changed);
  const pi = read(PI_CFG), zc = read(ZCODE_CFG);
  assert.equal(pi.mcpServers.aiti, undefined);
  assert.ok(pi.mcpServers["aiti-testagent"]);
  assert.equal(zc.mcp.servers.aiti, undefined);
  assert.ok(zc.mcp.servers["aiti-devtools-dev"]);
  r = unregisterAitiShim({ log: QUIET });
  assert.equal(r.changed, false);
});

test("未知目标名：干净报错不静默成功（防拼错）", () => {
  setup();
  const before = readFileSync(PI_CFG, "utf8");
  const r = registerAitiShim({ shimPath: SHIM, version: 1, targets: ["zcodes"], log: QUIET });
  assert.equal(r.ok, false, "报告失败而非静默跳过");
  assert.ok(r.summary.includes("未知注册目标"), r.summary);
  assert.equal(readFileSync(PI_CFG, "utf8"), before, "文件零改写");
  const r2 = registerMcp({ url: "http://x/mcp", targets: ["zcodes"], projectDir: SANDBOX, log: QUIET });
  assert.equal(r2.ok, false);
  assert.ok(r2.summary.includes("可用"), "错误提示列出可用目标");
});

test("dry-run：零改写，报告 changed=true", () => {
  setup();
  const r = registerAitiShim({ shimPath: SHIM, version: 1, dryRun: true, log: QUIET });
  assert.ok(r.changed);
  assert.equal(read(PI_CFG).mcpServers.aiti, undefined);
});

test(".bak 备份：真实写前留一份", () => {
  setup();
  registerAitiShim({ shimPath: SHIM, version: 1, log: QUIET });
  const bak = JSON.parse(readFileSync(PI_CFG + ".bak", "utf8"));
  assert.ok(bak.mcpServers["aiti-testagent"]);
  assert.equal(bak.mcpServers.aiti, undefined); // 备份是写前内容
});

// ---- resolveShimPathAuto：安装态路径优先（<webRoot>/node_modules @aiti-ai/aiti-bridge，2026-09-16）----
test("resolveShimPathAuto 安装态优先于仓库检出", async () => {
  const { resolveShimPathAuto } = await import("./mcp-config.ts");
  const installed = join(SANDBOX, ".pi/web/node_modules/@aiti-ai/aiti-bridge/bin/aiti-mcp-shim.cjs");
  mkdirSync(join(installed, ".."), { recursive: true });
  writeFileSync(installed, "const SHIM_VERSION = 9;\n");
  const found = resolveShimPathAuto([SHIM]); // 即便 cwd 候选（仓库位）存在，安装态应胜出
  assert.equal(found.shimPath, installed);
  assert.equal(found.version, 9);
  const explicit = join(SANDBOX, "explicit-shim.cjs");
  writeFileSync(explicit, "const SHIM_VERSION = 1;\n");
  process.env.AITI_SHIM_PATH = explicit;
  try {
    assert.equal(resolveShimPathAuto().shimPath, explicit); // env 显式最优先
  } finally { delete process.env.AITI_SHIM_PATH; }
});

// ---- configPaths 命中已知目标默认文件时必须带出异构定义（opencode local+environment 形状）----
test("configPaths 走 opencode 目标：shimEntry/envKey 不退化为默认 stdio", async () => {
  const { registerAitiShim } = await import("./mcp-config.ts");
  const ocCfg = join(SANDBOX, ".config/opencode/opencode.json");
  mk(ocCfg, { mcp: { aiti: { type: "local", command: ["node", "/old/repo/aiti-mcp-shim.cjs"], enabled: true } }, provider: { x: 1 } });
  const shim = join(SANDBOX, "oc-shim.cjs");
  writeFileSync(shim, "const SHIM_VERSION = 3;\n");
  const r = registerAitiShim({ shimPath: shim, version: 3, configPaths: [ocCfg], log: QUIET });
  assert.equal(r.ok, true);
  const entry = read(ocCfg).mcp.aiti;
  assert.equal(entry.type, "local");                       // 不是默认 stdio
  assert.deepEqual(entry.command, ["node", shim]);         // command 数组
  assert.equal(entry.enabled, true);
  assert.equal(entry.environment.AITI_SHIM_VERSION, "3");  // envKey=environment，不是 env
  assert.equal(entry.env, undefined);
  // 幂等复跑
  const r2 = registerAitiShim({ shimPath: shim, version: 3, configPaths: [ocCfg], log: QUIET });
  assert.equal(r2.results[0].changed, false);
});

// ---- 坏形自愈：shimEntry 目标条目被写入默认形状残留（args/env）时，守卫须放行重写 ----
test("opencode 条目混入默认形状残留（args/env）→ 守卫放行重写并清理", async () => {
  const { registerAitiShim } = await import("./mcp-config.ts");
  const ocCfg = join(SANDBOX, ".config/opencode/opencode.json"); // 必须与目标默认路径一致才能命中 shimEntry
  mk(ocCfg, { mcp: { aiti: { type: "stdio", command: "node", args: ["/old/x.cjs"], env: { AITI_SHIM_VERSION: "3" }, environment: { AITI_SHIM_VERSION: "3" }, enabled: true } } });
  const shim = join(SANDBOX, "oc-shim.cjs");
  const r = registerAitiShim({ shimPath: shim, version: 3, configPaths: [ocCfg], log: QUIET });
  assert.equal(r.ok, true);
  const entry = read(ocCfg).mcp.aiti;
  assert.equal(entry.type, "local");
  assert.deepEqual(entry.command, ["node", shim]);
  assert.equal(entry.args, undefined);   // 残留键被清理
  assert.equal(entry.env, undefined);
  assert.equal(entry.environment.AITI_SHIM_VERSION, "3");
});
