import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const mobileHookSource = await readFile(new URL("../hooks/useIsMobile.ts", import.meta.url), "utf8");

// 本地 fork 的 AppShell 顶栏为自绘实现（renderTopbarItem / ⋯ 收纳 / 扩展按钮位），
// 上游 mobile-toolbar 结构（renderChatToolbarActions / data-mobile-toolbar / covered 焦点管理）
// 在本地实现中不存在——纯上游结构断言在本地实现下跳过（保留上游测试原文，不改写断言内容）。
// 跳过 ≠ 漏覆盖：上游意图 → fork 等价钉子映射（文件尾部 [fork] 块无条件运行）：
//   #1/#2 两档动作呈现 → [fork] 内联 + 溢出层量宽收纳
//   #3 covered 防误触   → [fork] renderMainFileToggle covered 五件套
//   #4 动作后层保持打开 → [fork] keepMobileToolbarOpen / setMobileToolbarMoreOpen(true)
//   #5 主题/语言入口    → [fork] 双入口并存（顶栏 + 上游 #772 设置面板）
//   #6 统计降级         → AppShell.stat-fallback.test.mjs（4 条钉子）
//   #7 信任警告/文件开关 → AppShell.topbar-dedup.test.mjs + AppShell.mobile-topbar-toggle.test.mjs
const upstreamStructSkip = source.includes("renderChatToolbarActions(")
  ? false
  : (source.includes("renderTopbarItem(")
    ? "本地 AppShell 为自绘顶栏实现（renderTopbarItem），上游 mobile-toolbar 源码结构不适用（意图由文件尾部 [fork] 块及 stat-fallback/topbar-dedup/mobile-topbar-toggle 等价钉住）"
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
  assert.match(source, /\{hasSubagentSessions && \(\s*<button[\s\S]*?toggleTopPanel\("agents", mobile\)/);
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

test("keeps theme and language in settings instead of the chat toolbar", { skip: "上游断言与 fork 拍板相反（fork 顶栏保留主题/语言入口，不拆仅留设置面板）；fork 侧意图由文件尾部 [fork] 双入口测试正向钉住" }, () => {
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
// [fork] 意图钉子（无条件运行）——上方上游结构断言在本 fork 自绘顶栏下整体跳过，
// 但其守护的 UX 意图必须在 fork 实现上有等价钉子，防止「跳过」随每次合并累计成
// 无监督黑洞。约定：上游测试原文保留 skip 不改写；同文件尾部必须有对应 [fork] 钉子，
// 或在本文件头部映射表注明已由哪个 fork 测试文件覆盖。
// ═══════════════════════════════════════════════════════════════════════════════

const settingsPanelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("[fork] 顶栏动作两档呈现：行内 renderTopbarItem(item,true) + 溢出层 (item,false) 量宽收纳（对应上游 #1/#2）", () => {
  assert.match(source, /renderTopbarItem\(item, true\)/);
  assert.match(source, /const overflowMenuNodes = overflowItems\.map\(\(item\)/);
  assert.match(source, /renderTopbarItem\(item, false\)/);
  // 收纳判定靠实测宽度（forMeasure 探针渲染）而非固定断点——跨 narrow/medium 两档统一机制
  assert.match(source, /const renderTopbarItem = \(id: string, inRow: boolean, forMeasure = false, forPreview = false\)/);
});

test("[fork] 窄屏 ⋯ 层打开时文件开关防误触：covered 五件套（对应上游 #3）", () => {
  assert.match(source, /const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;/);
  assert.match(source, /disabled=\{covered\}/);
  assert.match(source, /tabIndex=\{covered \? -1 : undefined\}/);
  assert.match(source, /aria-hidden=\{covered \? true : undefined\}/);
  assert.match(source, /visibility: covered \? "hidden" : "visible"/);
  assert.match(source, /pointerEvents: covered \? "none" : "auto"/);
});

test("[fork] 展开动作使用后 ⋯ 层保持打开：keepMobileToolbarOpen 重开 + 动作 handler 重开不关闭（对应上游 #4）", () => {
  assert.match(source, /if \(isMobile && isNarrowMobile && keepMobileToolbarOpen\) setMobileToolbarMoreOpen\(true\);/);
  assert.match(source, /toggleTopPanel\("branches", true\)/);
  assert.match(source, /handleSystemInfoToggle\("system", mobile\)/);
  assert.match(source, /handleSystemInfoToggle\("tools", mobile\)/);
  // history / autoName 动作：执行后重开 ⋯ 层（而非关闭）——与上游「层不因使用动作而关」同语义
  assert.match(source, /handleViewFullHistory\(\);[\s\S]{0,120}if \(mobile && isNarrowMobile\) setMobileToolbarMoreOpen\(true\);/);
  assert.match(source, /void handleAutoName\(\);[\s\S]{0,120}if \(mobile && isNarrowMobile\) setMobileToolbarMoreOpen\(true\);/);
});

test("[fork] 主题/语言双入口并存：顶栏保留（fork 拍板）+ 设置面板生效（上游 #772）", () => {
  // 顶栏（fork 自绘渲染器 + 对应下拉面板项）
  assert.match(source, /const renderThemeButton = \(mobile: boolean\) => \(/);
  assert.match(source, /const renderLanguageButton = \(mobile: boolean\) => \(/);
  assert.match(source, /setThemePreference\(option\.id\)/);
  assert.match(source, /setLocale\(plugin\.id as typeof locale\)/);
  // 设置面板（上游 #772 引入，合并自动生效）——两边入口写同一状态，不得删任一侧
  assert.match(settingsPanelSource, /setThemePreference\(option\.id\)/);
  assert.match(settingsPanelSource, /setLocale\(plugin\.id as typeof locale\)/);
});
