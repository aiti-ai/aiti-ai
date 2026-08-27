import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护：手机端顶栏按钮曾因两次合并冲突消解错边而坏掉（aiti-ai docs/pi-web-merge-notes.md 第⑦条）：
// ① renderMainFileToggle 的移动端调用 {renderMainFileToggle(true)} 在自定义可排序顶栏重构时丢失，
//    只剩 !isMobile 分支 → 手机右上角文件开关永不渲染，44px 角落预留白白空着；
// ② 移动端 BranchNavigator 的受控 open={activeTopPanel === "branches"} 在合并 c3db1c1 时被消解成
//    JSX 裸属性 open（=恒 true）→ 分支面板永久摊开点不掉，体感「每次点击都是打开、没有关闭」。
// 本文件盯死：两端同一调用点 / 裸布尔 prop 不得回流 / 所有开关型按钮保持 toggle 语义。

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("文件面板开关：桌面与移动必须同一调用点 renderMainFileToggle(isMobile)", () => {
  // 统一调用点存在
  assert.match(source, /\{renderMainFileToggle\(isMobile\)\}/);
  // 不允许只剩桌面分支的旧写法回流
  assert.doesNotMatch(source, /!isMobile && renderMainFileToggle\(false\)/);
});

test("文件面板开关：负右外边距两端统一（不得再有 mobile ? 0 死代码分支）", () => {
  const fn = source.slice(
    source.indexOf("const renderMainFileToggle"),
    source.indexOf("const renderMainFileToggle") + 2000,
  );
  // 容器为右上角预留 44px + safe-area，按钮用等量负 margin 抵消贴角；移动端若单独给 0 即回归
  assert.match(fn, /marginRight:\s*"calc\(-44px - min\(env\(safe-area-inset-right\), 8px\)\)"/);
  assert.doesNotMatch(fn, /mobile \? 0\s*:/);
});

test("移动端 BranchNavigator：open 必须受控于 activeTopPanel，禁止裸布尔属性", () => {
  const m = source.match(
    /\{isMobile && sessionHasBranches && \(\s*<BranchNavigator[\s\S]*?\/?>\s*\)\}/,
  );
  assert.ok(m, "移动端 BranchNavigator 渲染块应存在");
  const block = m[0];
  assert.match(block, /open=\{activeTopPanel === "branches"\}/);
  // 裸 open（无值 = 恒 true）= 面板永展开；裸 hasSession（无会话也渲染）= 门控失效 —— 均不允许回流
  assert.doesNotMatch(block, /^\s*open\s*$/m);
  assert.doesNotMatch(block, /^\s*hasSession\s*$/m);
  // 原生能力 props 不得再丢：compact（图标档）+ hasSession={showChat}（会话门控）
  assert.match(block, /\bcompact\b/);
  assert.match(block, /hasSession=\{showChat\}/);
});

test("toggle 语义：topPanel 与 ⋯更多 都是「再点一次关闭」，不得退化成单向打开", () => {
  // topPanel：同面板再点一次 = 关闭（函数式取反，禁止 setActiveTopPanel(panel) 直赋值）
  assert.match(source, /setActiveTopPanel\(\(cur\) => cur === panel \? null : panel\)/);
  // ⋯更多：setMoreOpen(v => !v) 取反语义
  assert.match(source, /setMoreOpen\(\(?v\)? => !v\)|setMoreOpen\(\(v\) => !v\)/);
});
