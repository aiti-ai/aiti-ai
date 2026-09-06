import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 消息区扩展契约守卫 —— aiti-msg-nav（滚动导航条）/ aiti-msg-anchor（锚点横幅）
// 纯前端扩展全靠 core 在 DOM 上打的契约工作，零服务端 API。上游代码里这些属性
// 是「无意义的裸属性」，合并时最容易被无声冲掉（2026-08-26 c3db1c1 曾丢
// data-chat-msg-role，msg-nav ▲▼ 前后一用户输入静默失灵，见 aiti-ai
// docs/pi-web-merge-notes.md ⑨）。这里盯住契约接线：合并丢任何一项立即红灯。
const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("message wrapper div carries the data-chat-msg-role contract", () => {
  // ⑨ 根因：aiti-msg-nav 的 ▲上一个/▼下一个用户输入靠 [data-chat-msg-role="user"]
  // 定位目标；属性被合并丢弃后 getUserEls() 过滤为空 → prev/next 静默 return。
  // 必须打在带 attachVisibleRef 的消息包装 div 上、且 role 取自 msg.role 表达式。
  // （试验合并后 ref 改为 attachRef 条件式，包装 div 仍同时携带两契约）
  assert.match(source, /data-chat-msg-role=\{msg\.role\}/);
  assert.match(source, /ref=\{options\.attachRef === false \? undefined : attachVisibleRef\(idx, currentRefIdx\)\}/);
});

test("scroll container carries the data-chat-scroll contract", () => {
  // 契约另一半：⏫ 到最早 / ⏬ 到最新 / 按钮显隐（atTop/atBottom）都靠它找滚动容器。
  assert.match(source, /ref=\{handleScrollBoxRef\} data-chat-scroll/);
});

test("both user and assistant messages remain visible (and thus nav targets)", () => {
  // isVisible 收窄（如上游把 user 消息改走别渲染路径）会让 ▲▼ 无目标可跳；
  // user 必须与 assistant 同等进入包装 div 渲染分支。
  // （试验合并后采用上游 isMessageGroupAnchor 口径 = user + compaction 锚点，覆盖面更宽）
  assert.match(source, /const isVisible = isMessageGroupAnchor\(msg\) \|\| msg\.role === "assistant";/);
  assert.match(
    source,
    /if \(!isVisible \|\| currentRefIdx === undefined\) return view;/,
  );
});

test("chatOverlay slot stays wired for the nav toolbar extension", () => {
  // 内置 ScrollToolbar 抽离为 aiti-msg-nav（4678bc9）后，core 只剩这个插槽挂载点；
  // agentRunning/isMobile 透传驱动「长按到最新保持常亮」与移动端贴边；
  // revealHistory（2026-09-06）供「到最早/上一条」跳转目标在渲染窗口外时全量展开
  // （与 ChatMinimap 的 onRevealHistory 同源，一次性 setVisibleCount(messages.length*2)）。
  assert.match(source, /<ExtSlot\n\s+name="chatOverlay"/);
  assert.match(source, /extra=\{\{ agentRunning, isMobile, revealHistory: revealHistoryForMinimap \}\}/);
});

test("chatOverlay slot keeps passing currentSession for the anchor banner", () => {
  // aiti-msg-anchor 横幅的 title 模式靠 firstMessage 兜底（f1ac17a/94d3435）；
  // 该透传比插槽本身更晚加入、上游更不认识，合并时同样会被当冗余丢掉。
  assert.match(source, /firstMessage: session\.firstMessage/);
});
