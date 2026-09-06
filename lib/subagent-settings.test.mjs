/**
 * 上游 built-in subagents 禁用守护（aiti-subagents-fork-upstream-core-plan §0/§1）。
 *
 * 背景：pi-web/SDK 自带 built-in subagents（feature/built-in-subagents-testing 曾启用）。
 * 我们用 fork 的 pi-subagents（上游 nicobailon）作为唯一子代理引擎——两者并存会双
 * subagent 工具/双引擎冲突。因此 built-in 必须**恒禁用**（实现为代码级 return false）。
 *
 * 本文件两类守护：
 *  1（恒 false 语义，来自并行工作）
 *  2（静态断言：实现保持代码级硬禁用，上游 merge 改成读文件即红灯 → 恢复 return false）
 *  3（readSubagentEngineStatus：pi settings.json packages 装载状态读侧，Agents 页引擎区块用）
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const {
  isBuiltInSubagentsEnabled,
  readSubagentEngineStatus,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("built-in subagents are hard-disabled regardless of any settings file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");
  await mkdir(join(root, "agents"), { recursive: true });
  // 即使历史 settings.json 里 builtInEnabled=true，实现也必须恒 false（语义已死：fork 引擎唯一）
  await writeFile(settingsPath, JSON.stringify({ version: 1, builtInEnabled: true }));

  assert.equal(isBuiltInSubagentsEnabled(), false);
});

test("guard: built-in subagents 硬禁用实现不被上游 merge 改回读文件（aiti fork 守护）", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "subagent-settings.ts"),
    "utf8",
  );
  assert.match(
    src,
    /export function isBuiltInSubagentsEnabled\([^)]*\): boolean \{\s*\n\s*return false;/,
    "isBuiltInSubagentsEnabled 不再硬编码 return false——上游 merge 可能引入了读文件实现，" +
      "fork 的 pi-subagents 是唯一子代理引擎，必须恢复恒禁用",
  );
});

test("readSubagentEngineStatus: installed via settings.json packages + version from npm dir", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "settings.json"), JSON.stringify({
    packages: ["npm:pi-mcp-adapter", "npm:@aiti-ai/pi-subagents@0.59.0-aiti.1"],
  }));
  const pkgDir = join(root, "npm", "node_modules", "@aiti-ai", "pi-subagents");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@aiti-ai/pi-subagents", version: "0.59.0-aiti.1" }));

  const status = readSubagentEngineStatus(root, join(root, "settings.json"));
  assert.deepEqual(status, {
    installed: true,
    packageName: "@aiti-ai/pi-subagents",
    spec: "npm:@aiti-ai/pi-subagents@0.59.0-aiti.1",
    version: "0.59.0-aiti.1",
  });
});

test("readSubagentEngineStatus: not installed / missing settings / broken version dir all fail soft", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // settings.json 缺失 → 未装载（不抛）
  assert.deepEqual(readSubagentEngineStatus(root, join(root, "settings.json")), {
    installed: false,
    packageName: "@aiti-ai/pi-subagents",
    spec: null,
    version: null,
  });

  // spec 在但实装目录缺 package.json → installed=true、version=null（展示 spec 兑底）
  await writeFile(join(root, "settings.json"), JSON.stringify({ packages: ["npm:@aiti-ai/pi-subagents"] }));
  const status = readSubagentEngineStatus(root, join(root, "settings.json"));
  assert.equal(status.installed, true);
  assert.equal(status.version, null);
  assert.equal(status.spec, "npm:@aiti-ai/pi-subagents");
});
