/**
 * 上游 built-in subagents 禁用守护（aiti-subagents-fork-upstream-core-plan §0/§1）。
 *
 * 背景：pi-web/SDK 自带 built-in subagents（feature/built-in-subagents-testing 曾启用，
 * main 禁用）。我们用 fork 的 pi-subagents（上游 nicobailon）作为唯一子代理引擎——
 * 两者并存会双 subagent 工具/双引擎冲突。因此 built-in 必须**恒禁用**。
 *
 * 本测试在每次 pi-web 上游 merge 后运行：若上游把实现改成"读 settings 文件"
 * （builtInEnabled 可为 true）或任何放行路径，立刻红灯 → 恢复 `return false`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("built-in subagents 恒禁用（fork pi-subagents 是唯一引擎）", async () => {
  // 用 jiti 加载（pi-web 扩展同机制，可解析无扩展名依赖）；避免 strip-types 对无扩展名 import 的限制
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import("./subagent-settings.ts");
  assert.equal(typeof mod.isBuiltInSubagentsEnabled, "function");
  assert.equal(mod.isBuiltInSubagentsEnabled(), false, "built-in subagents 被启用了——与 fork 引擎冲突，必须恢复禁用");
});

test("实现是代码级硬禁用（return false），不依赖 settings 文件", () => {
  const src = readFileSync(join(ROOT, "lib", "subagent-settings.ts"), "utf8");
  assert.match(
    src,
    /export function isBuiltInSubagentsEnabled\(\): boolean \{\s*\n\s*return false;/,
    "isBuiltInSubagentsEnabled 不再硬编码 return false——上游 merge 可能引入了读文件实现，检查并恢复恒禁用",
  );
});
