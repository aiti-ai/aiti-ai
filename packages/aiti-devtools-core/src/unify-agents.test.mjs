/**
 * 统一行为扩展测试（node --test）——"所有 agent 启动自注册 aiti shim"：
 *   ① opencode 目标（异构条目形状：command 数组 + enabled，keyPath=mcp）；
 *   ② autoRegisterAitiShim（env AITI_SHIM_PATH 解析 / 找不到 shim 跳过不抛错 / 幂等）；
 *   ③ resolveShimPathAuto 候选顺序。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "aiti-uni-"));
process.env.HOME = SANDBOX; // 必须在 import 之前
delete process.env.AITI_SHIM_PATH;

const { registerAitiShim, autoRegisterAitiShim, resolveShimPathAuto, registerMcp } = await import("./mcp-config.ts");

const OC_CFG = join(SANDBOX, ".config/opencode/opencode.json");
const PI_CFG = join(SANDBOX, ".pi/agent/mcp.json");
const mk = (p, text) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
const QUIET = () => {};

/** 造一个带合法 SHIM_VERSION 的假 shim 文件 */
function fakeShim(dir, ver = 5) {
  const p = join(dir, `shim-${ver}.cjs`);
  mk(p, `const SHIM_VERSION = ${ver};\nmodule.exports = {};`);
  return p;
}

test("opencode 目标：异构条目形状（type local + command 数组 + enabled，无版本字段）+ 邻居保留", () => {
  mk(OC_CFG, JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { "web-reader": { type: "remote", url: "http://x", enabled: true } } }, null, 2));
  const r = registerAitiShim({ shimPath: "/opt/shim.cjs", version: 3, targets: ["opencode"], log: QUIET });
  assert.ok(r.ok && r.changed);
  const cfg = JSON.parse(readFileSync(OC_CFG, "utf8"));
  assert.deepEqual(cfg.mcp.aiti, { type: "local", command: ["node", "/opt/shim.cjs"], enabled: true, environment: { AITI_SHIM_VERSION: "3" } }, "opencode 形状：type local + command 数组 + enabled + environment 版本（零顶层私有键，schema 严格拒未知键）");
  assert.equal(cfg.mcp["web-reader"].type, "remote", "邻居条目原样");
  assert.equal(cfg.$schema, "https://opencode.ai/config.json", "$schema 保留");
});

test("opencode 目标幂等：版本走 environment map → 同版本零改写", () => {
  const before = readFileSync(OC_CFG, "utf8");
  const r = registerAitiShim({ shimPath: "/opt/shim.cjs", version: 3, targets: ["opencode"], log: QUIET });
  assert.equal(r.changed, false, "二次注册零改写");
  assert.equal(readFileSync(OC_CFG, "utf8"), before, "字节级不变");
  // shim 路径变化 → 条目改写
  const r2 = registerAitiShim({ shimPath: "/opt/shim-v2.cjs", version: 3, targets: ["opencode"], log: QUIET });
  assert.equal(r2.changed, true, "路径变化触发改写");
  assert.deepEqual(JSON.parse(readFileSync(OC_CFG, "utf8")).mcp.aiti.command, ["node", "/opt/shim-v2.cjs"]);
});

test("autoRegisterAitiShim：AITI_SHIM_PATH 指向假 shim → 注册成功且版本来自文件", () => {
  mk(PI_CFG, JSON.stringify({ mcpServers: {} }, null, 2));
  const shim = fakeShim(SANDBOX, 9);
  process.env.AITI_SHIM_PATH = shim;
  try {
    const r = autoRegisterAitiShim({ targets: ["pi"], log: QUIET });
    assert.ok(r && r.ok && r.changed);
    const e = JSON.parse(readFileSync(PI_CFG, "utf8")).mcpServers.aiti;
    assert.equal(e.env.AITI_SHIM_VERSION, "9", "版本解析自 shim 文件头（入 env map）");
    assert.equal(e.args[0], shim);
  } finally { delete process.env.AITI_SHIM_PATH; }
});

test("autoRegisterAitiShim：无 env 且候选不存在 → 返回 null 不抛错、零改写", () => {
  mk(PI_CFG, JSON.stringify({ mcpServers: { keep: { command: "x" } } }, null, 2));
  const before = readFileSync(PI_CFG, "utf8");
  const saved = process.env.HOME;
  const isolated = mkdtempSync(join(tmpdir(), "aiti-uni-noshim-"));
  process.env.HOME = isolated; // 让"常见仓库位置"候选也落空
  try {
    const r = autoRegisterAitiShim({ targets: ["pi"], log: QUIET });
    assert.equal(r, null, "无 shim → null");
    assert.equal(readFileSync(PI_CFG, "utf8"), before, "原配置零改写");
  } finally { process.env.HOME = saved; }
});

test("autoRegisterAitiShim：幂等（二次调用零改写）+ 配置损坏时不抛错", () => {
  mk(PI_CFG, JSON.stringify({ mcpServers: {} }, null, 2));
  const shim = fakeShim(SANDBOX, 9);
  process.env.AITI_SHIM_PATH = shim;
  try {
    const before = readFileSync(PI_CFG, "utf8");
    autoRegisterAitiShim({ targets: ["pi"], log: QUIET });
    const after = readFileSync(PI_CFG, "utf8");
    autoRegisterAitiShim({ targets: ["pi"], log: QUIET });
    assert.equal(readFileSync(PI_CFG, "utf8"), after, "二次零改写");
    // 损坏配置：写坏后调用不得抛异常
    writeFileSync(PI_CFG, "{{{broken");
    const r = autoRegisterAitiShim({ targets: ["pi"], log: QUIET });
    assert.ok(r === null || r.ok === false, "损坏配置返回 null/失败而不抛");
  } finally { delete process.env.AITI_SHIM_PATH; }
});

test("pi 目标路径跟随 PI_CODING_AGENT_DIR（getAgentDir 语义）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiti-pidir-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    // 动态重取 path（MCP_TARGETS.path 是函数，env 变化即生效）
    const { MCP_TARGETS } = await import("./mcp-config.ts");
    const target = join(dir, "mcp.json");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, JSON.stringify({ mcpServers: {} }, null, 2));
    const r = registerAitiShim({ shimPath: "/opt/shim.cjs", version: 2, targets: ["pi"], log: QUIET });
    assert.ok(r.ok && r.changed);
    const e = JSON.parse(readFileSync(target, "utf8")).mcpServers.aiti;
    assert.equal(e.args[0], "/opt/shim.cjs", "注册落在 PI_CODING_AGENT_DIR 下的 mcp.json");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

test("generic registerMcp opencode：http 条目形状为 remote（D23 回归钉死）", async () => {
  const { MCP_TARGETS: T } = await import("./mcp-config.ts");
  const saved = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const r = registerMcp({ url: "http://b:9/aiti/mcp", targets: ["opencode"], log: QUIET });
    assert.ok(r.ok && r.changed);
    const e = JSON.parse(readFileSync(OC_CFG, "utf8")).mcp["aiti-devtools"];
    assert.deepEqual(e, { type: "remote", url: "http://b:9/aiti/mcp", enabled: true }, "opencode http 条目 = remote 形状");
    assert.equal(T.opencode[0].httpEntry("u").type, "remote");
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

test("resolveShimPathAuto：候选顺序 env 优先，全部无效返回 null", () => {
  const a = fakeShim(SANDBOX, 11);
  const b = fakeShim(SANDBOX, 12);
  process.env.AITI_SHIM_PATH = a;
  try {
    const r1 = resolveShimPathAuto([b]);
    assert.equal(r1.version, 11, "env 候选优先");
  } finally { delete process.env.AITI_SHIM_PATH; }
  const r2 = resolveShimPathAuto([b]);
  assert.equal(r2.version, 12, "无 env 时用传入候选");
  assert.equal(resolveShimPathAuto([join(SANDBOX, "nope.cjs")]), null, "全部无效返回 null");
});
