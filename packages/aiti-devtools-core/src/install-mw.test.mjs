/**
 * 进程级挂载注册集成测试（node --test）——install.ts patchProcessHttp 的
 * registerMcp 真实通路（Next instrumentation 等载体进程级挂载的自动注册入口）。
 * 手法：import 前重定向 HOME 到沙箱；测试间清除 patch 幂等 symbol 使每次调用真实执行。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "aiti-mw-"));
process.env.HOME = SANDBOX; // 必须在 import 之前

const { patchProcessHttp } = await import("./install.ts");

const PATCH_SYM = Symbol.for("aiti-devtools.process-patched");
const PI_CFG = join(SANDBOX, ".pi/agent/mcp.json"); // pi 目标 = getAgentDir()/mcp.json
const unpatch = () => { delete globalThis[PATCH_SYM]; };

test("patchProcessHttp：端口 + targets → pi 配置自动注册 http 条目（载体自动注册通路）", () => {
  mkdirSync(join(PI_CFG, ".."), { recursive: true });
  writeFileSync(PI_CFG, JSON.stringify({ mcpServers: { keep: { command: "x" } } }, null, 2));
  const logs = [];
  const r = patchProcessHttp({ port: 39999, mcp: { targets: ["pi"] }, log: (l) => logs.push(l) });
  assert.ok(r.bridge, "bridge 句柄存在");
  const e = JSON.parse(readFileSync(PI_CFG, "utf8")).mcpServers["aiti-devtools"];
  assert.deepEqual(e, { type: "http", url: "http://localhost:39999/aiti/mcp" }, "载体端口自动注册");
  assert.ok(JSON.parse(readFileSync(PI_CFG, "utf8")).mcpServers.keep, "邻居保留");
  unpatch();
});

test("patchProcessHttp：mcp.register=false → 零注册", () => {
  const before = readFileSync(PI_CFG, "utf8");
  patchProcessHttp({ port: 39998, mcp: { register: false }, log: () => {} });
  assert.equal(readFileSync(PI_CFG, "utf8"), before);
  unpatch();
});

test("patchProcessHttp：无端口且无 PORT env → 跳过注册不报错", () => {
  const before = readFileSync(PI_CFG, "utf8");
  const saved = process.env.PORT;
  delete process.env.PORT;
  try {
    patchProcessHttp({ mcp: { targets: ["pi"] }, log: () => {} });
  } finally {
    if (saved !== undefined) process.env.PORT = saved;
  }
  assert.equal(readFileSync(PI_CFG, "utf8"), before);
  unpatch();
});
