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
  assert.match(source, /\[activeTabId, revealActiveTab, tabsKey, revealToken\]/);
  assert.doesNotMatch(source, /\[revealActiveTab, tabs\]/);
  // 移动端面板 display:none（0 宽）时跳过测量并留标记
  assert.match(source, /container\.clientWidth <= 0/);
  // 箭头显隐晚于 scrollLeft 写入：有限帧逐帧校正到布局稳定（用户手动滚动不进入）
  assert.match(source, /requestAnimationFrame\(/);
  assert.match(source, /revealActiveTab\(correctFrames - 1\)/);
  // RO 仅在 0 宽跳过后补滚，不拉回用户手动滚开的位置
  assert.match(source, /if \(needsRevealRef\.current\) revealActiveTab\(2\)/);
});

test("file tab ⇱ menu mirrors the dock position menu (停靠方位 icon row)", () => {
  const tab = { id: "file:/a.ts", label: "a.ts", filePath: "/a.ts" };
  // 顺序/图标键与 aiti-ai ext-float-dock「停靠方位」图标排一致（新窗口 → 浮窗 → 左栏 → 右栏）
  const items = filePosMenuItems(tab, (k) => k, {
    onDetachTab() {}, onOpenViewerWindow() {}, onDockFileTab() {},
  });
  assert.deepEqual(items.map((i) => [i.key, i.icon]), [
    ["new-window", "new-window"],
    ["float", "float"],
    ["sidebar-explorer", "panel-left"],
    ["right-panel", "panel-right"],
  ]);
  // 能力回调缺席 / 无 filePath 自动省略（扩展缺席降级语义不变）
  assert.deepEqual(filePosMenuItems(tab, (k) => k, { onDetachTab() {} }).map((i) => i.key), ["float"]);
  assert.deepEqual(
    filePosMenuItems({ id: "x", label: "x", filePath: "" }, (k) => k, { onDockFileTab() {} }).map((i) => i.key),
    [],
  );
  // run 接线：各自回宿主回调（zone 原值透传）
  const calls = [];
  const wired = filePosMenuItems(tab, (k) => k, {
    onDetachTab: (t2) => calls.push(["detach", t2.id]),
    onOpenViewerWindow: (t2) => calls.push(["viewer", t2.id]),
    onDockFileTab: (t2, zone) => calls.push(["dock", zone]),
  });
  wired[0].run(); wired[1].run(); wired[3].run();
  assert.deepEqual(calls, [["viewer", "file:/a.ts"], ["detach", "file:/a.ts"], ["dock", "right-panel"]]);
  // 渲染锚：图标排结构 + 行标题 key（与 dock 菜单同纹；文字项/分隔线已退役）
  assert.match(source, /data-ext-dock-icon-row="1"/);
  assert.match(source, /t\("files\.posDockRow"\)/);
  assert.doesNotMatch(source, /t\("files\.posDetach"\)\}/);
});

test("reveal is gated by host revealToken so background opens never scroll", () => {
  // 令牌模式：宿主递增令牌（用户自主打开/切换）才滚；令牌未变时 activeTabId/tabsKey
  // 变化（历史恢复 select:false 后台静默打开 + 兜底激活）一律不滚——避免后台打开的
  // 页签把页签条拽走（用户手动滚开的位置也不被恢复流拉回）。
  assert.match(source, /revealToken\?: number;/);
  assert.match(source, /const prevRevealTokenRef = useRef\(revealToken\)/);
  assert.match(
    source,
    /if \(revealToken !== undefined\) \{\s*\n\s*if \(revealToken === prevRevealTokenRef\.current\) return;\s*\n\s*prevRevealTokenRef\.current = revealToken;\s*\n\s*\}/,
  );
  // 不传令牌的调用方保持旧行为（跳过门控后仍直接 reveal）
  assert.match(source, /if \(revealToken !== undefined\)[\s\S]{0,200}?\}\s*\n\s*revealActiveTab\(4\);/);
});
