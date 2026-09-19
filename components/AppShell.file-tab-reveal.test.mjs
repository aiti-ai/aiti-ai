import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护：右侧文件区页签条「跟随新开 tab 自动滚入视野」（TabBar revealToken，
// 前身见 8fd815f）只服务「用户自主打开/切换」。历史恢复（aiti-editor session 墓碑
// 批量 select:false 后台静默打开）与其兜底激活不得递增令牌——那些页签是后台静默
// 打开的，不切焦点，也不应把页签条拽走（用户手动滚开的位置不被恢复流拉回）。
// 恢复语义背景见 aiti-ai docs/pi-web-merge-notes.md ⑪。

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

/** 截取某个顶层声明到下一个顶层 const 声明之间的源码片段（顶层声明 = 两空格缩进）。 */
function blockOf(decl) {
  const start = source.indexOf(decl);
  assert.ok(start >= 0, `未找到 ${decl}`);
  const after = source.indexOf("\n  const ", start + decl.length);
  return source.slice(start, after === -1 ? source.length : after);
}

test("TabBar 由宿主令牌驱动（revealToken={fileTabRevealToken}）", () => {
  assert.match(source, /const \[fileTabRevealToken, setFileTabRevealToken\] = useState\(0\);/);
  assert.match(source, /const revealFileTabOnOpen = useCallback\(\(\) => setFileTabRevealToken\(\(n\) => n \+ 1\), \[\]\);/);
  assert.match(source, /revealToken=\{fileTabRevealToken\}/);
});

test("用户自主打开路径递增令牌：文件/文件夹（select:true）、点击页签、终端、dock、收回", () => {
  // 2026-09-19 拆分：openHostFileTab 承载宿主 tab 落位（handleOpenFile 只做 face 守卫分流）
  assert.match(
    blockOf("const openHostFileTab = useCallback"),
    /if \(select\) \{\s*\n\s*setActiveFileTabId\(tabId\);\s*\n\s*revealFileTabOnOpen\(\)/,
  );
  assert.match(
    blockOf("const handleOpenFolder = useCallback"),
    /if \(select\) \{\s*\n\s*setActiveFileTabId\(tabId\);\s*\n\s*revealFileTabOnOpen\(\)/,
  );
  assert.match(blockOf("const guardedSelectFileTab = useCallback"), /revealFileTabOnOpen\(\)/);
  assert.match(blockOf("const handleOpenTerminal = useCallback"), /revealFileTabOnOpen\(\)/);
  assert.match(blockOf("const dockBackTab = useCallback"), /revealFileTabOnOpen\(\)/);
  // dock 打开 / 已停靠面板重复打开置前（两类事件各一处）
  assert.equal((source.match(/revealFileTabOnOpen\(\); \/\/ 用户从工具条\/扩展打开 dock 面板/g) || []).length, 1);
  assert.equal((source.match(/revealFileTabOnOpen\(\); \/\/ 已停靠面板重复打开置前/g) || []).length, 1);
});

test("懒物化窗口期守卫：休眠 face 改道 openFileFace（不落宿主 tab）", () => {
  const b = blockOf("const handleOpenFile = useCallback");
  // 命中休眠 face → 物化 aiti-editor 后走 openFileFace（auto 透传 select:false）；
  // 用户点击（select:true）的置前/令牌语义由 dock activate 事件联动承担（AppShell onActivate）。
  assert.match(b, /findDormantFileFacePath\(filePath\)/);
  assert.match(b, /ensureExtMaterialized\("aiti-editor"\)/);
  assert.match(b, /api\.openFileFace\(facePath, \{ auto: options\?\.select === false \}\)/);
  assert.match(b, /openHostFileTab\(facePath, fileName, options\)/);
});

test("后台恢复与回落路径不递增令牌：恢复兜底激活 / 布局恢复 / 关闭 / 拆窗", () => {
  // 恢复兜底激活（纯展开面板恢复历史文件时唯一的自动激活点）
  const restoreIdx = source.indexOf("setActiveFileTabId(visibleTabs[visibleTabs.length - 1].id);");
  assert.ok(restoreIdx > 0, "恢复兜底激活 effect 应存在");
  assert.doesNotMatch(source.slice(restoreIdx - 420, restoreIdx + 80), /revealFileTabOnOpen/);
  // terminal 页签布局恢复（sessionStorage）
  const termIdx = source.indexOf("setActiveFileTabId(saved.activeId);");
  assert.ok(termIdx > 0, "terminal 布局恢复应存在");
  assert.doesNotMatch(source.slice(termIdx - 320, termIdx + 80), /revealFileTabOnOpen/);
  // 关闭 / 拆出后的激活回落
  for (const decl of [
    "const handleCloseFileTabs = useCallback",
    "const performCloseFileTab = useCallback",
    "const handleTerminalClosed = ",
    "const detachTab = useCallback",
  ]) {
    assert.doesNotMatch(blockOf(decl), /revealFileTabOnOpen/, `${decl} 不应递增页签滚动令牌`);
  }
});
