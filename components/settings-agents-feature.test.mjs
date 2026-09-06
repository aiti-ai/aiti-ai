/**
 * settingsAgentsFeature 插槽守护测试（T3 重做：revert 5e52a04 恢复上游原版 + 插槽 takeover）：
 * - 原版「内置子代理」开关区兜底（扩展未注册时）
 * - 扩展（aiti-subagents）注册后替换为引擎横幅 + 「打开子代理舰队」入口
 * - 引擎门控 isBuiltInSubagentsEnabled 恒 false 不回归（lib/subagent-settings.test.mjs 同款守护）
 * Run: node --experimental-strip-types --test components/settings-agents-feature.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentsSource = await readFile(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../lib/ext/types.ts", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("../lib/subagent-settings.ts", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../app/api/subagents/settings/route.ts", import.meta.url), "utf8");

test("AgentsConfig 消费 settingsAgentsFeature 插槽（takeover 跳板范式）", () => {
  assert.match(agentsSource, /useExtSlotItems\("settingsAgentsFeature"\)\.find\(hasExtRender\)/);
  assert.match(agentsSource, /<ExtItemBoundary extId=\{agentsFeatureTakeover\.extId\} slot="settingsAgentsFeature" itemId=\{agentsFeatureTakeover\.id\}>/);
  // 接管 props 契约透传（cwd/sessionId）
  assert.match(agentsSource, /cwd=\{cwd\}/);
  assert.match(agentsSource, /sessionId=\{sessionId \?\? null\}/);
});

test("原版开关区块保留为兜底（扩展未注册时渲染）", () => {
  // 上游原版结构：agents-feature-setting 区 + builtInTitle 文案 + ConfigSwitch
  assert.match(agentsSource, /className="agents-feature-setting"/);
  assert.match(agentsSource, /t\("agents\.builtInTitle"\)/);
  assert.match(agentsSource, /<ConfigSwitch/);
  assert.match(agentsSource, /toggleBuiltInSubagents/);
});

test("settingsAgentsFeature 契约存在于插槽类型表", () => {
  assert.match(typesSource, /\| "settingsAgentsFeature"/);
  assert.match(typesSource, /interface SettingsAgentsFeatureSlotProps \{/);
  assert.match(typesSource, /settingsAgentsFeature: \{ props: SettingsAgentsFeatureSlotProps \};/);
});

test("原版读写链完整恢复（revert 5e52a04 后不缺件）", () => {
  // 原版代码不动：读（GET 回显）+ 写（PUT 持久化）走 settings.json
  assert.match(settingsSource, /export function readSubagentSettings\(/);
  assert.match(settingsSource, /export function writeBuiltInSubagentsEnabled\(/);
  assert.match(routeSource, /writeBuiltInSubagentsEnabled/);
  assert.match(routeSource, /readSubagentSettings/);
});

test("引擎门控恒 false 不回归（fork 唯一引擎 = pi-subagents）", () => {
  assert.match(
    settingsSource,
    /export function isBuiltInSubagentsEnabled\(\): boolean \{\s*\n\s*return false;/,
    "isBuiltInSubagentsEnabled 被改动——fork 的 pi-subagents 是唯一子代理引擎，必须恢复恒禁用",
  );
});
