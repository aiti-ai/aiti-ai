/**
 * aiti-mcp-register.mjs CLI 端到端测试（node --test；execFileSync + fake HOME）。
 * 逐旗标钉死：--help、默认 auto、--targets（新建缺失文件）、--dry-run、--force、
 * --version 覆盖、--name 自定义条目名、--unregister、--config-paths、未知参数报错、
 * 坏 shim 文件（缺 SHIM_VERSION）报错退出。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTER = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/aiti-mcp-register.mjs");
const REAL_SHIM = resolve(dirname(REGISTER), "aiti-mcp-shim.cjs");

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "aiti-regcli-"));
  const cfg = join(home, ".pi/agent/mcp.json"); // pi 目标 = getAgentDir()/mcp.json
  mkdirSync(join(cfg, ".."), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ mcpServers: { keep: { command: "x" } } }, null, 2));
  return { home, cfg };
}

function run(args, home, expectCode = 0) {
  let out = "", code = 0;
  try {
    out = execFileSync("node", [REGISTER, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); // USERPROFILE 必须同沙箱——Windows 的 os.homedir() 只读它（2026-11-07 实证：漏了会写真家目录）
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
    code = e.status;
  }
  if (expectCode !== null) assert.equal(code, expectCode, `exit ${code} != ${expectCode}\n${out}`);
  return out;
}

test("--help：退出 0 并打印用法", () => {
  const out = run(["--help"], mkdtempSync(join(tmpdir(), "aiti-regcli-h-")));
  assert.ok(out.includes("--targets"), out);
  assert.ok(out.includes("--unregister"), out);
});

test("默认 auto：写入已存在的 pi 配置，条目形状正确", () => {
  const { home, cfg } = sandbox();
  run([], home);
  const e = JSON.parse(readFileSync(cfg, "utf8")).mcpServers.aiti;
  assert.equal(e.type, "stdio");
  assert.equal(e.command, "node");
  assert.equal(e.args[0], REAL_SHIM);
  const shimVer = parseInt(readFileSync(REAL_SHIM, "utf8").match(/SHIM_VERSION\s*=\s*(\d+)/)[1], 10);
  assert.equal(e.env.AITI_SHIM_VERSION, String(shimVer), "版本来自 shim 文件头（入 env map）");
});

test("幂等：二次运行零改写（字节级）+ 提示语", () => {
  const { home, cfg } = sandbox();
  run([], home);
  const before = readFileSync(cfg, "utf8");
  const out = run([], home);
  assert.equal(readFileSync(cfg, "utf8"), before);
  assert.ok(out.includes("已是最新"), out);
});

test("--targets 显式：缺失文件新建（zcode 嵌套容器）", () => {
  const { home } = sandbox();
  const zc = join(home, ".zcode/cli/config.json");
  run(["--targets", "zcode"], home);
  const e = JSON.parse(readFileSync(zc, "utf8")).mcp.servers.aiti;
  assert.equal(e.type, "stdio");
});

test("--dry-run：报告 changed=true 但零改写", () => {
  const { home, cfg } = sandbox();
  const before = readFileSync(cfg, "utf8");
  const out = run(["--dry-run"], home);
  assert.equal(readFileSync(cfg, "utf8"), before);
  assert.ok(out.includes("[dry-run]"), out);
});

test("--force：版本高于当前时仍重写", () => {
  const { home, cfg } = sandbox();
  run([], home);
  const cfgObj = JSON.parse(readFileSync(cfg, "utf8"));
  cfgObj.mcpServers.aiti.env.AITI_SHIM_VERSION = "999";
  writeFileSync(cfg, JSON.stringify(cfgObj, null, 2));
  run(["--force"], home);
  assert.equal(JSON.parse(readFileSync(cfg, "utf8")).mcpServers.aiti.env.AITI_SHIM_VERSION, "1", "强制回落到 shim 当前版本");
});

test("--version 覆盖 + --name 自定义条目名", () => {
  const { home, cfg } = sandbox();
  run(["--version", "42", "--name", "aiti-dev"], home);
  const e = JSON.parse(readFileSync(cfg, "utf8")).mcpServers["aiti-dev"];
  assert.equal(e.env.AITI_SHIM_VERSION, "42");
  assert.equal(JSON.parse(readFileSync(cfg, "utf8")).mcpServers.aiti, undefined, "默认名未写");
});

test("--unregister：移除条目、退出 0；重复执行零变化", () => {
  const { home, cfg } = sandbox();
  run([], home);
  run(["--unregister"], home);
  assert.equal(JSON.parse(readFileSync(cfg, "utf8")).mcpServers.aiti, undefined);
  assert.ok(JSON.parse(readFileSync(cfg, "utf8")).mcpServers.keep, "邻居保留");
  const out = run(["--unregister"], home);
  assert.ok(out.includes("无该条目") || out.includes("·"), out);
});

test("--config-paths：只处理指定文件", () => {
  const { home } = sandbox();
  const other = join(home, "only.json");
  writeFileSync(other, "{}");
  run(["--config-paths", other], home);
  assert.equal(JSON.parse(readFileSync(other, "utf8")).mcpServers.aiti.args[0], REAL_SHIM);
});

test("未知参数：退出 1 并提示", () => {
  const { home } = sandbox();
  const out = run(["--no-such-flag"], home, 1);
  assert.ok(out.includes("未知参数"), out);
});

test("坏 shim 文件（缺 SHIM_VERSION）：退出 1 并报错", () => {
  const { home } = sandbox();
  const bad = join(home, "bad-shim.cjs");
  writeFileSync(bad, "module.exports = {};");
  const out = run(["--shim-path", bad], home, 1);
  assert.ok(out.includes("SHIM_VERSION"), out);
});
