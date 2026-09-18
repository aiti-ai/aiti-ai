import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// tab-detach v0.6.0：右栏内容分派抽 TabBody（components/TabBody.tsx），右栏与拆出窗口
// 共用同一分派（host 差异仅 watchEnabled/onMentionLines/terminal active 三处 prop）。
// 本文件原钉 AppShell 内联 JSX 的不变式，随之迁移：不变式本身不变——
//   ① 经 TabBody 单点分派（不内联 FileViewer、不逐 tab 直挂）；keep-alive 池（方案
//      docs/aiti-editor-right-dock-keepalive-plan.md）后语义：非 terminal tab 最近 N 个
//      常挂载（hidden 隐藏非激活），池外仅当前激活挂载——仍是单点分派，不逐 tab 直挂
//   ② viewerState 快照恢复闭环（key 带 viewerRevision + initialState + onStateChange 回存）
//   ③ 面板关→watch 暂停（panel host 的 watchEnabled 走 ctx.panelOpen）
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const tabBody = await readFile(new URL("./TabBody.tsx", import.meta.url), "utf8");

function fileContentBlock() {
  const start = appShell.indexOf("{/* [aiti-float tab-detach v0.6.0] 内容分派抽 TabBody");
  const end = appShell.indexOf("</div>\n      </div>\n    </div>", start);
  assert.notEqual(start, -1, "TabBody content dispatch block not found in AppShell");
  assert.notEqual(end, -1, "end of file content block not found");
  return appShell.slice(start, end);
}

test("right panel mounts tabs through TabBody single dispatch (keep-alive pool)", () => {
  const block = fileContentBlock();
  // AppShell 侧：非 terminal tab 走 keep-alive 池（最近 N 个常挂载，hidden 隐藏非激活；
  // 池外仅当前激活挂载）——仍只经 TabBody 单点分派（不内联 FileViewer、不逐 tab 直挂）
  assert.match(block, /\.map\(\(tab\) => \(\n\s*<div key=\{tab\.id\} hidden=\{tab\.id !== activeFileTabId\}/);
  assert.equal(block.match(/<FileViewer/g)?.length ?? 0, 0, "AppShell 不应再内联 FileViewer（分派归 TabBody）");
  // TabBody 侧：两条互斥分支（folder kind | file path）——运行时恰好一个 viewer
  assert.equal(tabBody.match(/<FileViewer/g)?.length, 2);
  assert.doesNotMatch(tabBody, /\.map\(/);
});

test("the active viewer restores tab state and saves it with a revision", () => {
  assert.match(tabBody, /key=\{`\$\{tab\.id\}:\$\{tab\.viewerRevision \?\? 0\}`\}/);
  assert.match(tabBody, /initialState=\{tab\.viewerState\}/);
  assert.match(tabBody, /ctx\.onStateChange\(tab\.id, tab\.viewerRevision \?\? 0, viewerState\)/);
});

test("closing the file panel pauses the active viewer watcher", () => {
  // panel host：watchEnabled = ctx.panelOpen（窗口 host 恒 true——可见即活动）
  assert.match(tabBody, /watchEnabled=\{host === "window" \? true : ctx\.panelOpen\}/);
});
