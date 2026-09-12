import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const { TabBar, computeTabRevealScrollLeft } = await jiti.import("./TabBar.tsx");

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

test("fully visible tabs do not move the strip", () => {
  assert.equal(computeTabRevealScrollLeft(metrics({ itemLeft: 120, itemRight: 220 })), null);
  // 与容器边缘严格对齐也算可见（不引入 ±1px 抖动）
  assert.equal(computeTabRevealScrollLeft(metrics({ itemLeft: 100, itemRight: 460 })), null);
});

test("tab beyond the right edge scrolls right by the exact overflow", () => {
  // item 380..520 超出容器右缘 460 共 60px
  assert.equal(
    computeTabRevealScrollLeft(metrics({ scrollLeft: 120, itemLeft: 380, itemRight: 520 })),
    180,
  );
});

test("tab beyond the left edge scrolls left by the exact underflow", () => {
  // item 60..160 越过容器左缘 100 共 40px
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
  // item 40..500 跨越整个容器（100..460），左缘优先 → scrollLeft 80 - 60 = 20
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
  // 依赖稳定 tabsKey 而非 tabs 数组引用——AppShell 的 panelTabs 每次渲染都是新数组，
  // 直接依赖 tabs 会让任何父级重渲染都把用户手动滚开的激活 tab 拽回来
  assert.match(source, /const tabsKey = tabs\.map/);
  assert.match(source, /\[activeTabId, revealActiveTab, tabsKey\]/);
  assert.doesNotMatch(source, /\[revealActiveTab, tabs\]/);
  // 移动端面板 display:none（0 宽）时跳过测量并留标记
  assert.match(source, /container\.clientWidth <= 0/);
  // 箭头显隐晚于 scrollLeft 写入：有限帧逐帧校正到布局稳定（用户手动滚动不进入）
  assert.match(source, /requestAnimationFrame\(/);
  assert.match(source, /revealActiveTab\(correctFrames - 1\)/);
  // RO 仅在 0 宽跳过后补滚，不拉回用户手动滚开的位置
  assert.match(source, /if \(needsRevealRef\.current\) revealActiveTab\(2\)/);
});
