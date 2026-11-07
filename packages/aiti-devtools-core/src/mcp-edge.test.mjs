/**
 * 配置边界与异常路径专项（node --test；HOME 沙箱）。
 * 钉死：UTF-8 BOM 配置、容器为数组（[] 不当容器、不静默丢条目）、顶层非对象配置
 * 的干净报错、只读文件写失败的优雅报错、旧条目自定义字段升级保留、mcpServers 为 null。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "aiti-edge-"));
process.env.HOME = SANDBOX; process.env.USERPROFILE = SANDBOX; // 必须在 import 之前（Windows homedir() 读 USERPROFILE）

const { registerAitiShim } = await import("./mcp-config.ts");

const SHIM = "/opt/fake/shim.cjs";
const QUIET = () => {};
const mk = (p, text) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };

test("BOM：带 UTF-8 BOM 的配置文件可解析、可写入", () => {
  const p = join(SANDBOX, "bom/cfg.json");
  mk(p, "\uFEFF" + JSON.stringify({ mcpServers: { keep: { command: "x" } } }, null, 2));
  const r = registerAitiShim({ shimPath: SHIM, version: 1, configPaths: [p], log: QUIET });
  assert.ok(r.ok, "注册成功（BOM 不致解析失败）");
  const cfg = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  assert.equal(cfg.mcpServers.aiti.args[0], SHIM);
  assert.ok(cfg.mcpServers.keep, "邻居保留");
});

test("容器为数组：不当容器使用，不静默丢条目", () => {
  const p = join(SANDBOX, "arrarr/cfg.json");
  mk(p, JSON.stringify({ mcpServers: [] }, null, 2)); // [] 是 object，但不能作为容器
  const r = registerAitiShim({ shimPath: SHIM, version: 1, configPaths: [p], log: QUIET });
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  const entry = cfg.mcpServers && !Array.isArray(cfg.mcpServers) ? cfg.mcpServers.aiti : undefined;
  assert.ok(r.ok, "注册成功");
  assert.deepEqual(entry, { type: "stdio", command: "node", args: [SHIM], env: { AITI_SHIM_VERSION: "1" } }, "条目真实落盘（未被数组静默吞掉）");
});

test("嵌套 keyPath 中段为数组：同样不静默丢", () => {
  const p = join(SANDBOX, ".zcode/cli/config.json");
  mk(p, JSON.stringify({ mcp: { servers: [] } }, null, 2));
  const r = registerAitiShim({ shimPath: SHIM, version: 1, targets: ["zcode"], log: QUIET });
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  assert.ok(r.ok);
  assert.deepEqual(cfg.mcp.servers.aiti, { type: "stdio", command: "node", args: [SHIM], env: { AITI_SHIM_VERSION: "1" } });
});

test("顶层非对象配置（数组/字符串/null）：干净报错不崩溃不写坏", () => {
  const pArr = join(SANDBOX, "toparr/cfg.json");
  mk(pArr, "[1,2,3]");
  let r = registerAitiShim({ shimPath: SHIM, version: 1, configPaths: [pArr], log: QUIET });
  assert.equal(r.ok, false);
  assert.ok(r.results[0].error, "有明确错误信息");
  assert.equal(readFileSync(pArr, "utf8"), "[1,2,3]", "原文件未被写坏");

  const pStr = join(SANDBOX, "topstr/cfg.json");
  mk(pStr, '"just a string"');
  r = registerAitiShim({ shimPath: SHIM, version: 1, configPaths: [pStr], log: QUIET });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(pStr, "utf8"), '"just a string"');
});

test("只读目录：写失败干净报错，原文件完好（rename 语义下文件只读不拦原子替换，目录只读才拦）", () => {
  const p = join(SANDBOX, "readonly/cfg.json");
  mk(p, JSON.stringify({ mcpServers: { keep: { command: "x" } } }, null, 2));
  const dir = join(p, "..");
  chmodSync(dir, 0o555); // 目录只读 → renameSync 必然 EACCES
  try {
    const r = registerAitiShim({ shimPath: SHIM, version: 1, configPaths: [p], log: QUIET });
    assert.equal(r.ok, false, "报告错误而非抛异常");
    assert.ok((r.results[0].error || "").includes("写入失败"), "错误信息：写入失败");
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(cfg.mcpServers.aiti, undefined, "原文件未被破坏");
    assert.ok(cfg.mcpServers.keep);
  } finally {
    chmodSync(dir, 0o755); // 恢复以便沙箱清理
  }
});

test("升级保留旧条目自定义字段；旧顶层版本键迁移并入 env", () => {
  const p = join(SANDBOX, "legacy/cfg.json");
  mk(p, JSON.stringify({ mcpServers: { aiti: { type: "stdio", command: "node", args: ["/old/shim.cjs"], _aitiShimVersion: 1, env: { FOO: "bar" }, description: "自定义描述" } } }, null, 2));
  registerAitiShim({ shimPath: SHIM, version: 2, configPaths: [p], log: QUIET });
  const e = JSON.parse(readFileSync(p, "utf8")).mcpServers.aiti;
  assert.equal(e._aitiShimVersion, undefined, "旧顶层版本键已剥除");
  assert.deepEqual(e.env, { FOO: "bar", AITI_SHIM_VERSION: "2" }, "自定义 env 保留合并 + 版本入 env");
  assert.equal(e.description, "自定义描述", "自定义字段保留");
  assert.equal(e.args[0], SHIM, "args 更新");
});

test("mcpServers 为 null：容器重建", () => {
  const p = join(SANDBOX, "nullc/cfg.json");
  mk(p, JSON.stringify({ mcpServers: null }, null, 2));
  const r = registerAitiShim({ shimPath: SHIM, version: 1, configPaths: [p], log: QUIET });
  assert.ok(r.ok);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).mcpServers.aiti, { type: "stdio", command: "node", args: [SHIM], env: { AITI_SHIM_VERSION: "1" } });
});
