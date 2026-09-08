import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护：右侧文件区「加载历史」（aiti-editor session 墓碑恢复）曾因上游合并坏掉
// （aiti-ai docs/pi-web-merge-notes.md 第⑪条）：恢复调用 _restoreSession 原本内联在
// 文件面板开关按钮的 onClick 里，合并上游 handleRightPanelToggle 重构（开关改走统一
// handler）时被无声顶掉 → 展开面板不再恢复上次打开的文件/文件夹，只有再手工打开某个
// 文件/文件夹才触发。
// 本文件盯死：恢复逻辑必须挂在 rightPanelOpen effect 上（任何展开路径都覆盖），
// 且不得回退成只藏在单个 handler 里的内联调用形态。

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("面板展开即触发 session 恢复：rightPanelOpen effect 存在且调用 _restoreSession", () => {
  const m = source.match(
    /useEffect\(\(\) => \{\s*\n\s*if \(!rightPanelOpen\) return;\s*\n\s*const restore = window\.__aitiEditor\?\._restoreSession;[\s\S]*?\n\s*\}, \[rightPanelOpen\]\);/,
  );
  assert.ok(
    m,
    "rightPanelOpen 的 session 恢复 effect 丢失 —— 展开文件区不再加载历史（见 merge-notes ⑪）",
  );
  // 守卫式调用（函数存在才调）+ 异步放行，不得改成裸调用
  assert.match(m[0], /typeof restore === "function"/);
  assert.match(m[0], /setTimeout\(\(\) => restore\(\), 0\)/);
});

test("恢复触发权归 effect 单一所有：不得散落回单个 handler 的内联调用形态", () => {
  // 先摘出 effect 块，剩余源码里只允许 Window 类型声明 `_restoreSession?: () => void;`
  // 这一处；其余任何出现（handler 内联调用等）= 回退成上次丢逻辑的形态。
  const effectMatch = source.match(
    /\/\/ 面板展开即恢复[\s\S]*?\}, \[rightPanelOpen\]\);/,
  );
  assert.ok(effectMatch, "rightPanelOpen session 恢复 effect 应存在");
  const rest = source.replace(effectMatch[0], "");
  const leftovers = [...rest.matchAll(/_restoreSession(?!\?: \(\) => void;)/g)]
    // 注释行提及（// 或 JSDoc * 开头）不算调用点；只拦代码里的出现
    .filter((m) => {
      const lineStart = rest.lastIndexOf("\n", m.index) + 1;
      const line = rest.slice(lineStart, m.index + 200).split("\n")[0].trim();
      return !(line.startsWith("//") || line.startsWith("*") || line.startsWith("/*"));
    });
  assert.equal(
    leftovers.length,
    0,
    `_restoreSession 在 effect 之外出现 ${leftovers.length} 处 —— 恢复触发应收敛于 rightPanelOpen effect，禁止散落回单个 handler（见 merge-notes ⑪）`,
  );
});

test("开关按钮走统一 handler 且 handler 置 rightPanelOpen（经 effect 间接触发恢复）", () => {
  // renderMainFileToggle 不得绕过 handleRightPanelToggle 自行 setRightPanelOpen：
  // 恢复逻辑只挂在 effect 上，按钮一旦绕过统一 handler 就可能丢掉 mobile 收尾；
  // 反过来 handleRightPanelToggle 必须真的置位 rightPanelOpen（否则 effect 永不触发）。
  const fnStart = source.indexOf("const renderMainFileToggle");
  const fn = source.slice(fnStart, fnStart + 2200);
  assert.match(fn, /onClick=\{handleRightPanelToggle\}/);
  const toggleStart = source.indexOf("const handleRightPanelToggle");
  const toggleFn = source.slice(toggleStart, toggleStart + 400);
  assert.match(toggleFn, /setRightPanelOpen\(/);
  // 不允许在 handler 里直接内联恢复调用（那正是合并丢失前的脆弱形态，声明见 Window 注释）
  assert.doesNotMatch(toggleFn, /_restoreSession/);
});

test("恢复配套：面板开+有tabs+无激活 → 激活当前最后一个（消除 select:false 批量打开的空态）", () => {
  // 扩展侧 _restoreSession 全部后台打开（select:false）；纯展开触发时无任何 tab 激活，
  // 面板会落成「点击标签打开」空态。此 effect 状态驱动兜底——恢复流首个文件 commit 时
  // 激活（当时即最后一个），后续文件打开时 activeFileTabId !== null 守卫挡住再激活
  // （= 用户手工打开的文件焦点也不被抢占）。E2E 实证：展开→内容渲染、无空态提示。
  // tab-detach v0.6.0：激活面收窄到 panel 内可见 tabs（detached 的不占右栏激活位）。
  const m = source.match(
    /useEffect\(\(\) => \{\s*\n\s*\/\/ tab-detach：自动激活只在「panel 内可见 tabs」里挑[^\n]*\n\s*const visibleTabs = fileTabs\.filter\(\(t\) => !detachedTabIds\.has\(t\.id\)\);\s*\n\s*if \(!rightPanelOpen \|\| visibleTabs\.length === 0 \|\| activeFileTabId !== null\) return;\s*\n\s*setActiveFileTabId\(visibleTabs\[visibleTabs\.length - 1\]\.id\);\s*\n\s*\}, \[activeFileTabId, fileTabs, detachedTabIds, rightPanelOpen\]\);/,
  );
  assert.ok(m, "恢复激活兜底 effect 丢失 —— 展开面板后历史 tab 打开但无激活，内容区空态");
});

test("Window 类型声明保留 _restoreSession（扩展私有契约仍在）", () => {
  assert.match(source, /_restoreSession\?: \(\) => void;/);
});
