import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const mobileHookSource = await readFile(new URL("../hooks/useIsMobile.ts", import.meta.url), "utf8");

// This fork's AppShell top bar is a custom-drawn implementation
// (renderTopbarItem / ⋯ overflow collapse / extension button slots); the
// upstream mobile-toolbar structure (renderChatToolbarActions /
// data-mobile-toolbar / covered focus management) does not exist in the local
// implementation — pure upstream structure assertions are skipped under the
// local implementation (upstream test text is kept as-is, assertions not
// rewritten).
// Skip does not mean lost coverage: upstream intent → fork-equivalent pin
// mapping (the [fork] block at the end of this file runs unconditionally):
//   #1/#2 two-tier action presentation → [fork] inline + width-measured overflow collapse
//   #3 covered mis-touch protection    → [fork] renderMainFileToggle covered five-piece set
//   #4 layer stays open after use      → [fork] keepMobileToolbarOpen / setMobileToolbarMoreOpen(true)
//   #5 theme/language entries          → [fork] dual entry coexistence (top bar + upstream #772 settings panel)
//   #6 stats degradation               → AppShell.stat-fallback.test.mjs (4 pins)
//   #7 trust warnings/file toggle      → AppShell.topbar-dedup.test.mjs + AppShell.mobile-topbar-toggle.test.mjs
const upstreamStructSkip = source.includes("renderChatToolbarActions(")
  ? false
  : (source.includes("renderTopbarItem(")
    ? "local AppShell implements its own top bar (renderTopbarItem); upstream mobile-toolbar source structure does not apply (intent pinned by the [fork] block at the end of this file and the equivalents in stat-fallback/topbar-dedup/mobile-topbar-toggle)"
    : false);



test("keeps action icons inline in medium mobile sidebars", { skip: upstreamStructSkip }, () => {
  assert.match(mobileHookSource, /NARROW_MOBILE_QUERY = "\(max-width: 480px\)"/);
  assert.match(source, /const isNarrowMobile = useIsNarrowMobile\(\);/);
  assert.match(source, /\{!isNarrowMobile && renderChatToolbarActions\(true\)\}/);
  assert.match(source, /\{isNarrowMobile && \([\s\S]*?data-mobile-toolbar-more="true"/);
});

test("uses a compact narrow-mobile toolbar with a floating action layer", { skip: upstreamStructSkip }, () => {
  assert.match(source, /data-mobile-toolbar="true"[\s\S]*?flex: 1,[\s\S]*?minWidth: 0/);
  assert.match(
    source,
    /data-mobile-toolbar-actions="true"[\s\S]*?position: "absolute"[\s\S]*?right: 0,[\s\S]*?left: TOP_BAR_ICON_BUTTON_SIZE/,
  );

  for (const action of ["history", "name", "agents", "branches", "system", "tools"]) {
    assert.match(source, new RegExp(`data-mobile-toolbar-action=(?:\\{mobile \\? )?"${action}"`));
  }
});

test("only renders the Agents switcher when the active session family has subagents", () => {
  assert.match(source, /const hasSubagentSessions = Boolean\(activeSessionFamily\?\.subagents\.length\)/);
  // 合并适配：fork 在门控上追加 agentsBadge（有 subagent 才算 badge，无则不渲染按钮）。
  assert.match(source, /\{hasSubagentSessions && agentsBadge && \(\s*<button[\s\S]*?toggleTopPanel\("agents", mobile\)/);
  assert.match(source, /activeTopPanel === "agents" && activeSessionFamily && selectedSession/);
});

test("keeps the Agents panel open while switching sessions and positions it at the left", () => {
  assert.match(source, /const AGENT_PANEL_WIDTH = 420/);
  assert.match(
    source,
    /if \(activeTopPanel === "agents"\)[\s\S]*?left: topBarRect\.left[\s\S]*?width: Math\.min\(AGENT_PANEL_WIDTH, topBarRect\.width\)/,
  );
  assert.match(source, /<AgentSessionPanel[\s\S]*?onSelectSession=\{handleSelectSession\}/);
});

test("only renders branch toolbar controls for sessions with branches", () => {
  assert.match(source, /const sessionHasBranches = hasSessionBranches\(branchTree\)/);
  assert.match(source, /\{sessionHasBranches && \(mobile \? \(/);
  assert.match(source, /\{isMobile && sessionHasBranches && \(/);
  assert.match(source, /panel === "branches" \? null : panel/);
});

test("keeps covered statistics and file controls out of interaction and focus", { skip: upstreamStructSkip }, () => {
  assert.match(source, /const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;/);
  assert.match(source, /disabled=\{!showChat \|\| covered\}[\s\S]*?tabIndex=\{covered \? -1 : undefined\}/);
  assert.match(source, /data-mobile-toolbar-file=\{mobile \? "true" : undefined\}[\s\S]*?visibility: covered \? "hidden" : "visible"/);
  assert.match(source, /aria-hidden=\{covered \? true : undefined\}/);
});

test("closes the mobile action layer on outside click, Escape, layout changes, and session changes", () => {
  assert.match(source, /event\.composedPath\(\)\.includes\(toolbar\)/);
  assert.match(source, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(source, /event\.key !== "Escape"[\s\S]*?setMobileToolbarMoreOpen\(false\)/);
  assert.match(source, /\}, \[isMobile, isNarrowMobile, selectedSession\?\.id, newSessionDraftId\]\);/);
});

test("keeps the mobile action layer open after using an expanded action", { skip: upstreamStructSkip }, () => {
  const toggleTopPanel = source.match(/const toggleTopPanel = useCallback\([\s\S]*?\n  \}, \[isMobile, isNarrowMobile\]\);/)?.[0];
  const historyHandler = source.match(/onClick=\{\(\) => \{[\s\S]*?handleViewFullHistory\(\);[\s\S]*?\n          \}\}/)?.[0];
  const autoNameHandler = source.match(/onClick=\{\(\) => \{[\s\S]*?void handleAutoName\(\);[\s\S]*?\n              \}\}/)?.[0];

  for (const handler of [toggleTopPanel, historyHandler, autoNameHandler]) {
    assert.ok(handler);
    assert.doesNotMatch(handler, /setMobileToolbarMoreOpen\(false\)/);
    assert.match(handler, /setMobileToolbarMoreOpen\(true\)/);
  }

  assert.match(source, /toggleTopPanel\("branches", true\)/);
  assert.match(source, /handleSystemInfoToggle\("system", mobile\)/);
  assert.match(source, /handleSystemInfoToggle\("tools", mobile\)/);
  assert.match(source, /onClick=\{\(\) => toggleTopPanel\("session"\)\}/);
});

test("keeps theme and language in settings instead of the chat toolbar", { skip: "upstream assertion contradicts the fork decision (fork top bar keeps theme/language entries instead of settings-panel-only); fork intent positively pinned by the [fork] dual-entry test at the end of this file" }, () => {
  assert.doesNotMatch(source, /renderThemeButton/);
  assert.doesNotMatch(source, /renderLanguageButton/);
  assert.doesNotMatch(source, /toggleTopPanel\("language"/);
  assert.doesNotMatch(source, /data-mobile-toolbar-action=\{mobile \? "theme"/);
  assert.doesNotMatch(source, /data-mobile-toolbar-action=\{mobile \? "language"/);
  assert.match(source, /import \{ useTheme \} from "@\/hooks\/useTheme"/);
  assert.match(source, /useTheme\(\);/);
});

test("prioritizes context and cost when the mobile statistics area narrows", { skip: upstreamStructSkip }, () => {
  assert.match(source, /\.mobile-session-stats \{[\s\S]*?container-type: inline-size/);
  assert.match(source, /@container \(max-width: 158px\)[\s\S]*?\.mobile-session-stat-io/);
  assert.match(source, /@container \(max-width: 88px\)[\s\S]*?\.mobile-session-stat-cost/);
  assert.match(source, /mobileContextText = percent !== null \? `\$\{percent\.toFixed\(0\)\}%` : null/);
});

test("places trust warnings below the mobile toolbar and the file toggle in toolbar flow", { skip: upstreamStructSkip }, () => {
  assert.match(source, /\{isMobile && renderProjectTrustWarning\(true\)\}/);
  assert.match(source, /data-mobile-trust-banner=\{mobileBanner \? "true" : undefined\}/);
  assert.doesNotMatch(source, /File panel toggle — always visible at top-right/);
  assert.doesNotMatch(source, /position: "fixed", top: "env\(safe-area-inset-top\)"/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// [fork] intent pins (run unconditionally) — the upstream structure assertions
// above are skipped wholesale under this fork's custom-drawn top bar, but the
// UX intents they guard must have equivalent pins on the fork implementation,
// so skips do not accumulate into an unsupervised black hole with each merge.
// Convention: upstream test text keeps its skip and is not rewritten; the same
// file must have matching [fork] pins at the end, or the mapping table at the
// top of this file must note which fork test file already covers it.
// ═══════════════════════════════════════════════════════════════════════════════

const settingsPanelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("[fork] top-bar actions in two tiers: inline renderTopbarItem(item,true) + width-measured overflow layer (item,false) collapse (maps to upstream #1/#2)", () => {
  assert.match(source, /renderTopbarItem\(item, true\)/);
  assert.match(source, /const overflowMenuNodes = overflowItems\.map\(\(item\)/);
  assert.match(source, /renderTopbarItem\(item, false\)/);
  // collapse decision uses measured width (forMeasure probe render) rather than a fixed breakpoint — one mechanism across both narrow/medium tiers
  assert.match(source, /const renderTopbarItem = \(id: string, inRow: boolean, forMeasure = false, forPreview = false\)/);
});

test("[fork] file toggle mis-touch protection while the narrow-screen ⋯ layer is open: the covered five-piece set (maps to upstream #3)", () => {
  assert.match(source, /const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;/);
  assert.match(source, /disabled=\{covered\}/);
  assert.match(source, /tabIndex=\{covered \? -1 : undefined\}/);
  assert.match(source, /aria-hidden=\{covered \? true : undefined\}/);
  assert.match(source, /visibility: covered \? "hidden" : "visible"/);
  assert.match(source, /pointerEvents: covered \? "none" : "auto"/);
});

test("[fork] the ⋯ layer stays open after using an expanded action: keepMobileToolbarOpen reopens + action handlers reopen instead of closing (maps to upstream #4)", () => {
  assert.match(source, /if \(isMobile && isNarrowMobile && keepMobileToolbarOpen\) setMobileToolbarMoreOpen\(true\);/);
  assert.match(source, /toggleTopPanel\("branches", true\)/);
  assert.match(source, /handleSystemInfoToggle\("system", mobile\)/);
  assert.match(source, /handleSystemInfoToggle\("tools", mobile\)/);
  // history / autoName actions: reopen the ⋯ layer after running (rather than closing) — same semantics as upstream "the layer does not close because an action was used"
  assert.match(source, /handleViewFullHistory\(\);[\s\S]{0,120}if \(mobile && isNarrowMobile\) setMobileToolbarMoreOpen\(true\);/);
  assert.match(source, /void handleAutoName\(\);[\s\S]{0,120}if \(mobile && isNarrowMobile\) setMobileToolbarMoreOpen\(true\);/);
});

test("[fork] theme/language dual entries coexist: kept in the top bar (fork decision) + settings panel takes effect (upstream #772)", () => {
  // top bar (fork's custom renderer + the corresponding dropdown panel items)
  assert.match(source, /const renderThemeButton = \(mobile: boolean\) => \(/);
  assert.match(source, /const renderLanguageButton = \(mobile: boolean\) => \(/);
  assert.match(source, /setThemePreference\(option\.id\)/);
  assert.match(source, /setLocale\(plugin\.id as typeof locale\)/);
  // settings panel (introduced by upstream #772, takes effect automatically on merge) — both entries write the same state; neither side may be removed
  assert.match(settingsPanelSource, /setThemePreference\(option\.id\)/);
  assert.match(settingsPanelSource, /setLocale\(plugin\.id as typeof locale\)/);
});

test("closes top-bar dropdowns when the file panel expands to full width", () => {
  assert.match(
    source,
    /const handleRightPanelExpandToggle = useCallback\(\(\) => \{\s*setActiveTopPanel\(null\);\s*setRightPanelExpanded\(\(expanded\) => !expanded\);/,
  );
  assert.match(source, /onClick=\{handleRightPanelExpandToggle\}/);
  assert.match(source, /if \(rightPanelFullWidth\) setActiveTopPanel\(null\);/);
});

test("a sidebar pick closes the phone's drawer unless it asks to stay open (the sidebar's Fork)", () => {
  assert.match(source, /const handleSelectSession = useCallback\(\(session: SessionInfo, isRestore = false, entryId\?: string, blockIndex\?: number, options\?: SelectSessionOptions\) => \{/);
  assert.match(source, /if \(isMobile && !isRestore && !options\?\.keepSidebarOpen\) setSidebarOpen\(false\);/);
});
