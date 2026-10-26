import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./TabBar.tsx", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { TabBar, computeTabRevealScrollLeft, filePosMenuItems } = await jiti.import("./TabBar.tsx");

function metrics(overrides) {
  return {
    containerLeft: 100,
    containerRight: 460,
    scrollLeft: 0,
    itemLeft: 100,
    itemRight: 180,
    ...overrides,
  };
}

function renderTabBar(count) {
  const tabs = Array.from({ length: count }, (_, index) => ({ id: `t${index}`, label: `file-${index}.ts`, filePath: `/p/file-${index}.ts` }));
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(TabBar, { tabs, activeTabId: "t0", onSelectTab() {}, onCloseTab() {} })));
}

/** The inline style of every element with that role, as property maps. */
function styles(html, role) {
  // 合并适配：fork 的 tab div 带 data-tab-id 前缀属性，role 不再紧跟 <div。
  return [...html.matchAll(new RegExp(`<div[^>]*role="${role}"[^>]* style="([^"]*)"`, "g"))].map(([, style]) =>
    Object.fromEntries(style.split(";").filter(Boolean).map((declaration) => {
      const colon = declaration.indexOf(":");
      return [declaration.slice(0, colon), declaration.slice(colon + 1)];
    })));
}

test("fully visible tabs do not move the strip", () => {
  assert.equal(computeTabRevealScrollLeft(metrics({ itemLeft: 120, itemRight: 220 })), null);
  // exact alignment with the container edges also counts as visible (no ±1px jitter introduced)
  assert.equal(computeTabRevealScrollLeft(metrics({ itemLeft: 100, itemRight: 460 })), null);
});

test("tab beyond the right edge scrolls right by the exact overflow", () => {
  // item 380..520 overflows the container right edge (460) by 60px
  assert.equal(
    computeTabRevealScrollLeft(metrics({ scrollLeft: 120, itemLeft: 380, itemRight: 520 })),
    180,
  );
});

test("tab beyond the left edge scrolls left by the exact underflow", () => {
  // item 60..160 crosses the container left edge (100) by 40px
  assert.equal(
    computeTabRevealScrollLeft(metrics({ scrollLeft: 300, itemLeft: 60, itemRight: 160 })),
    260,
  );
});

test("left underflow never yields a negative scrollLeft", () => {
  assert.equal(
    computeTabRevealScrollLeft(metrics({ scrollLeft: 4, itemLeft: 92, itemRight: 172 })),
    0,
  );
});

test("oversized tab (both edges overflow) aligns to its left edge", () => {
  // item 40..500 spans the whole container (100..460); left edge wins → scrollLeft 80 - 60 = 20
  assert.equal(
    computeTabRevealScrollLeft(metrics({ scrollLeft: 80, itemLeft: 40, itemRight: 500 })),
    20,
  );
});

test("every tab renders data-tab-id used by the reveal lookup", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(TabBar, {
        tabs: [
          { id: "file:/a.ts", label: "a.ts", filePath: "/a.ts" },
          { id: "file:/b.ts", label: "b.ts", filePath: "/b.ts" },
        ],
        activeTabId: "file:/b.ts",
        onSelectTab() {},
        onCloseTab() {},
      }),
    ),
  );
  assert.match(html, /data-tab-id="file:\/a\.ts"/);
  assert.match(html, /data-tab-id="file:\/b\.ts"/);
});

test("active tab is revealed on activation and on container resize", () => {
  assert.match(source, /const revealActiveTab = useCallback\(/);
  // depend on the stable tabsKey, not the tabs array reference — AppShell's
  // panelTabs is a new array on every render; depending on tabs directly
  // would let any parent re-render yank the active tab back from where the
  // user manually scrolled it
  assert.match(source, /const tabsKey = tabs\.map/);
  assert.match(source, /\[activeTabId, revealActiveTab, tabsKey, revealToken\]/);
  assert.doesNotMatch(source, /\[revealActiveTab, tabs\]/);
  // when the mobile panel is display:none (0 width), skip measuring and leave a flag
  assert.match(source, /container\.clientWidth <= 0/);
  // arrow visibility is written after the scrollLeft write: a bounded number of frames correct until layout is stable (user manual scrolling does not enter)
  assert.match(source, /requestAnimationFrame\(/);
  assert.match(source, /revealActiveTab\(correctFrames - 1\)/);
  // the RO only completes the scroll after a 0-width skip; it does not pull back positions the user manually scrolled away from
  assert.match(source, /if \(needsRevealRef\.current\) revealActiveTab\(2\)/);
});

test("file tab ⇱ menu mirrors the dock position menu (docking-position icon row)", async () => {
  const tab = { id: "file:/a.ts", label: "a.ts", filePath: "/a.ts" };
  // order/icon keys match the shared dock's "docking position" icon row (new window → float → left panel → right panel)
  const items = filePosMenuItems(tab, (k) => k, {
    onDetachTab() {}, onOpenViewerWindow() {}, onDockFileTab() {},
  });
  assert.deepEqual(items.map((i) => [i.key, i.icon]), [
    ["new-window", "new-window"],
    ["float", "float"],
    ["sidebar-explorer", "panel-left"],
    ["right-panel", "panel-right"],
  ]);
  // missing capability callbacks / no filePath are automatically omitted (degraded semantics when the extension is absent, unchanged)
  assert.deepEqual(filePosMenuItems(tab, (k) => k, { onDetachTab() {} }).map((i) => i.key), ["float"]);
  assert.deepEqual(
    filePosMenuItems({ id: "x", label: "x", filePath: "" }, (k) => k, { onDockFileTab() {} }).map((i) => i.key),
    [],
  );
  // run wiring: each returns to its host callback (zone value passed through as-is)
  const calls = [];
  const wired = filePosMenuItems(tab, (k) => k, {
    onDetachTab: (t2) => calls.push(["detach", t2.id]),
    onOpenViewerWindow: (t2) => calls.push(["viewer", t2.id]),
    onDockFileTab: (t2, zone) => calls.push(["dock", zone]),
  });
  wired[0].run(); wired[1].run(); wired[3].run();
  assert.deepEqual(calls, [["viewer", "file:/a.ts"], ["detach", "file:/a.ts"], ["dock", "right-panel"]]);
  // render anchors: icon-row structure + row title key (same pattern as the dock menu; text items/separator are retired)
  assert.match(source, /data-ext-dock-icon-row="1"/);
  assert.match(source, /t\("files\.posDockRow"\)/);
  assert.doesNotMatch(source, /t\("files\.posDetach"\)\}/);
  // positioning fix: both fixed menus mount to body via portal — in right
  // panel overlay mode the container has a transform, so an in-place render
  // would use the container as the containing block and offset the whole menu
  assert.match(source, /import \{ createPortal \} from "react-dom"/);
  assert.equal((source.match(/createPortal\(/g) || []).length, 2);
  // tooltip identical to the dock menu (the dock menu's new-window label = the zh-CN i18n string asserted below)
  const zhCN = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
  assert.match(zhCN, /"files\.posNewWindow": "新窗口打开"/);
});

test("reveal is gated by host revealToken so background opens never scroll", () => {
  // token mode: scroll only when the host increments the token (user-initiated
  // open/switch); when the token is unchanged, activeTabId/tabsKey changes
  // (history restore silently opening in the background with select:false +
  // fallback activation) never scroll — background-opened tabs must not yank
  // the tab bar away (positions the user manually scrolled to are not pulled
  // back by the restore flow either).
  assert.match(source, /revealToken\?: number;/);
  assert.match(source, /const prevRevealTokenRef = useRef\(revealToken\)/);
  assert.match(
    source,
    /if \(revealToken !== undefined\) \{\s*\n\s*if \(revealToken === prevRevealTokenRef\.current\) return;\s*\n\s*prevRevealTokenRef\.current = revealToken;\s*\n\s*\}/,
  );
  // callers that pass no token keep the old behavior (after skipping the gate, still reveal directly)
  assert.match(source, /if \(revealToken !== undefined\)[\s\S]{0,200}?\}\s*\n\s*revealActiveTab\(4\);/);
});

test("overflowing tabs keep the whole 36px bar: the strip has no scrollbar", () => {
  // The app's 10px (6px on touch) scrollbar took its height out of the 36px
  // bar: 36px tabs were clipped (#1225), stretched ones squeezed to 26px.
  const html = renderTabBar(12);
  assert.match(html, /<div role="tablist" class="tabbar-scroll"/);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.tabbar-scroll \{\s*scrollbar-width: none;\s*\}/);
  assert.match(css, /\.tabbar-scroll::-webkit-scrollbar \{\s*display: none;\s*\}/);
  const [list] = styles(html, "tablist");
  assert.equal(list.height, "36px");
  assert.equal(list["overflow-x"], "auto");
  assert.equal(list["overflow-y"], "hidden");
  assert.equal(list["align-items"], "stretch");
  const tabs = styles(html, "tab");
  assert.equal(tabs.length, 12);
  for (const tab of tabs) {
    assert.equal(tab.height, undefined);
    assert.equal(tab["align-items"], "center");
  }
});

