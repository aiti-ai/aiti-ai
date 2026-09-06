/**
 * 上游 built-in subagents 禁用守护（aiti-subagents-fork-upstream-core-plan §0/§1）。
 *
 * 背景：pi-web/SDK 自带 built-in subagents（feature/built-in-subagents-testing 曾启用）。
 * 我们用 fork 的 pi-subagents（上游 nicobailon）作为唯一子代理引擎——两者并存会双
 * subagent 工具/双引擎冲突。因此 built-in 必须**恒禁用**（实现为代码级 return false）。
 *
 * 本文件两类守护：
 *  1-3（settings 文件 CRUD/损坏兜底/恒 false 语义，来自并行工作）
 *  4（静态断言：实现保持代码级硬禁用，上游 merge 改成读文件即红灯 → 恢复 return false）
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const {
  isBuiltInSubagentsEnabled,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("subagent settings default the built-in extension to disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: false });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
});

test("subagent settings persist both states and preserve unrelated fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true });
  // aiti fork 守护：写入恒存，读取恒 false（fork 的 pi-subagents 是唯一子代理引擎）
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(first, { version: 1, builtInEnabled: true });

  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting: 3 }));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const second = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(second, { version: 1, builtInEnabled: false, futureSetting: 3 });
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, "{");

  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.throws(() => readSubagentSettings(settingsPath));
  assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath));
  assert.equal(await readFile(settingsPath, "utf8"), "{");
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
