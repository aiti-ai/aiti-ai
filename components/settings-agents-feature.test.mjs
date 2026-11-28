/**
 * Guard tests for the settingsAgentsFeature slot (T3 redo: revert 5e52a04 back to the upstream original + slot takeover):
 * - Original "built-in subagents" toggle section kept as fallback (when the extension is not registered)
 * - Once the subagents extension registers, it is replaced by the engine banner + "open subagent fleet" entry
 * - Engine gate isBuiltInSubagentsEnabled staying constantly false must not regress (same guard as lib/subagent-settings.test.mjs)
 * Run: node --experimental-strip-types --test components/settings-agents-feature.test.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentsSource = await readFile(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../lib/ext/types.ts", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("../lib/subagent-settings.ts", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../app/api/subagents/settings/route.ts", import.meta.url), "utf8");

test("AgentsConfig consumes the settingsAgentsFeature slot (takeover trampoline pattern)", () => {
  assert.match(agentsSource, /useExtSlotItems\("settingsAgentsFeature"\)\.find\(hasExtRender\)/);
  assert.match(agentsSource, /<ExtItemBoundary extId=\{agentsFeatureTakeover\.extId\} slot="settingsAgentsFeature" itemId=\{agentsFeatureTakeover\.id\}>/);
  // Takeover props contract passed through (cwd/sessionId)
  assert.match(agentsSource, /cwd=\{cwd\}/);
  assert.match(agentsSource, /sessionId=\{sessionId \?\? null\}/);
});

test("Original toggle section kept as fallback (rendered when the extension is not registered)", () => {
  // Upstream original structure: agents-feature-setting section + builtInTitle copy + ConfigSwitch
  assert.match(agentsSource, /className="agents-feature-setting"/);
  assert.match(agentsSource, /t\("agents\.builtInTitle"\)/);
  assert.match(agentsSource, /<ConfigSwitch/);
  assert.match(agentsSource, /toggleBuiltInSubagents/);
});

test("settingsAgentsFeature contract exists in the slot type table", () => {
  assert.match(typesSource, /\| "settingsAgentsFeature"/);
  assert.match(typesSource, /interface SettingsAgentsFeatureSlotProps \{/);
  assert.match(typesSource, /settingsAgentsFeature: \{ props: SettingsAgentsFeatureSlotProps \};/);
});

test("Original read/write chain fully restored (no missing pieces after revert 5e52a04)", () => {
  // Original code untouched: read (GET echo) + write (PUT persistence) go through settings.json
  assert.match(settingsSource, /export function readSubagentSettings\(/);
  assert.match(settingsSource, /export function writeBuiltInSubagentsEnabled\(/);
  assert.match(routeSource, /writeBuiltInSubagentsEnabled/);
  assert.match(routeSource, /readSubagentSettings/);
});

test("Engine gate stays constantly false (the fork's only engine is pi-subagents)", () => {
  assert.match(
    settingsSource,
    /export function isBuiltInSubagentsEnabled\(\): boolean \{\s*\n\s*return false;/,
    "isBuiltInSubagentsEnabled was changed — the fork's only subagent engine is pi-subagents, restore the constant false",
  );
});
