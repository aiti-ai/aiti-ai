import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelSource = await readFile(new URL("./ToolDefinitionsPanel.tsx", import.meta.url), "utf8");
const systemSource = await readFile(new URL("./SystemPromptPanel.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("keeps System and Tools in separate adjacent toolbar actions", () => {
  // 2026-11-15 (d3d11cc7): the mobile horizontal More-controls tier retired — its
  // `handleSystemInfoToggle(…, mobile)` call sites went with it. The top bar now pins
  // the fork's own buttons: system is a plain panel toggle, tools routes through the
  // lazy system-info loader.
  assert.match(appShellSource, /toggleTopPanel\("system"\)[\s\S]*?handleSystemInfoToggle\("tools"\)/);
  assert.match(appShellSource, /activeTopPanel === "system"[\s\S]*?<SystemPromptPanel/);
  assert.match(appShellSource, /activeTopPanel === "tools"[\s\S]*?<ToolDefinitionsPanel/);
  assert.doesNotMatch(systemSource, /ToolEntry|tools/);
  assert.doesNotMatch(systemSource, /system-prompt-heading/);
  assert.doesNotMatch(panelSource, /tool-definitions-heading/);
});

test("header bar carries a title and a top-right close button (session-info parity)", () => {
  assert.match(panelSource, /className="tool-definitions-header"/);
  assert.match(panelSource, /className="tool-definitions-title"/);
  assert.match(panelSource, /\{translate\("tools\.title"\)\}/);
  assert.match(panelSource, /onClick=\{onClose\}/);
  assert.match(panelSource, /translate\("i18n\.close"\)/);
  assert.match(appShellSource, /<ToolDefinitionsPanel[\s\S]*?onClose=\{\(\) => setActiveTopPanel\(null\)\}/);
});

test("renders declared tool definitions in a selectable master-detail layout", () => {
  assert.match(panelSource, /tools\?\.filter\(\(tool\) => tool\.active && !tool\.declarationHidden\)/);
  assert.match(panelSource, /setSelectedToolName\(tool\.name\)/);
  assert.match(panelSource, /declaredTools\?\.some\(\(tool\) => tool\.name === current\)/);
  assert.match(panelSource, /className="tool-definitions-sidebar"/);
  assert.match(panelSource, /className="tool-definition-detail"/);
  assert.match(panelSource, /grid-template-columns: clamp\(112px, 26%, 220px\) minmax\(0, 1fr\)/);
});

test("shows schema fields and metadata in the detail form", () => {
  assert.match(panelSource, /parameters\.properties/);
  assert.match(panelSource, /parameters\.required/);
  assert.match(panelSource, /field\.allowedValues/);
  assert.match(panelSource, /field\.defaultValue/);
  assert.match(panelSource, /selectedTool\.promptGuidelines/);
});

test("preserves the two-column layout on narrow screens", () => {
  assert.match(
    panelSource,
    /@media \(max-width: 640px\)[\s\S]*?\.tool-definitions-panel \{[\s\S]*?grid-template-columns: 112px minmax\(0, 1fr\)/,
  );
  assert.doesNotMatch(panelSource, /@media \(max-width: 640px\)[\s\S]*?\.tool-definitions-panel \{[\s\S]*?display: block/);
});
