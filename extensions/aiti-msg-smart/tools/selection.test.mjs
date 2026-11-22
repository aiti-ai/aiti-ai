/**
 * T1（todo-upstream-v0.9-integration）划选识别回归测试：
 *  - 引用格式：formatQuote 的 `> ` 逐行对多行/代码块/表格文本成立（选中片段 → 引用不烂）
 *  - client 静态契约：划选守卫互斥、新会话引用通道、三按钮、feature 声明
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatQuote } from "../client/src/recognize.js";

const clientSrc = await readFile(new URL("../client/src/index.js", import.meta.url), "utf8");
const serverSrc = await readFile(new URL("../index.ts", import.meta.url), "utf8");

test("formatQuote: 选中片段含代码块/表格行时逐行 `> ` 引用不烂", () => {
  const code = "function a() {\n  return 1;\n}";
  assert.equal(
    formatQuote(code),
    "> function a() {\n>   return 1;\n> }\n",
  );
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  assert.equal(
    formatQuote(table),
    "> | a | b |\n> |---|---|\n> | 1 | 2 |\n",
  );
});

test("selection path: 划选守卫与点击路径互斥（有选区 → 点击让行）", () => {
  // 守卫函数存在（winOverride：顶层委托显式传 window，不被上一次 framed 弹层的 rcx 污染）
  assert.match(clientSrc, /function selectionNonCollapsed\(winOverride\)/);
  // 段落点击 handler 入口守卫（划选 info 由 isSelection 放行，见 selection path 用例）
  assert.match(clientSrc, /const ph = \(info\) => \{[\s\S]*?if \(selectionNonCollapsed\(\) && !info\.isSelection\) return;/);
  // pre/diff click 委托入口守卫（顶层链路显式传 window）
  assert.match(clientSrc, /document\.addEventListener\("click", \(e\) => \{\s*\n\s*if \(selectionNonCollapsed\(window\)\) return;/);
});

test("selection card: 复制/引用/新会话 三按钮统一（点击/行/划选同款），新会话走收口通道", () => {
  // 三按钮统一：buildCardNode 顶部恒显（onNewSession 存在即渲染，不再限 isSelection）
  assert.match(clientSrc, /view\.onNewSession && h\("button", \{\s*\n\s*key: "quote-new-session"/);
  // 新会话投递已收口 _shared/openNewSession（docs/pi-web-at-new-session-cwd-plan.md §4.5）：
  // 本扩展不再手写 pendingComposer / pi-web:new-session 事件，改调共享实现（15s 时效由 core 消费侧保证）
  assert.match(clientSrc, /openNewSession\(\{/);
  assert.doesNotMatch(clientSrc, /window\.__piWebPendingComposer/);
  assert.doesNotMatch(clientSrc, /new CustomEvent\("pi-web:new-session"/);
  // 引用回复仍走当前会话（appendText），格式沿用 `> ` 逐行（不引入上游 intro/question 模板）
  // deco = info.decorateQuote（外部容器给引用加前缀，如 aiti-editor 的 @file#Lx-Ly），缺省恒等
  assert.match(clientSrc, /const onPick = \(quote\) => \{[\s\S]*?ctx\.appendText\(deco\(quote\)\);/);
  assert.doesNotMatch(clientSrc, /quoteIntro|quoteQuestion/);
});

test("selection path: 划选走段落点击全流程（统一识别与弹层管理）", () => {
  // openSelectionCard 构造 ph 兼容 info（isSelection 标记 + 自管 fixed layer）→ paragraphHandler
  assert.match(clientSrc, /isSelection: true,[\s\S]*?setInline: \(node\) => \{/);
  assert.match(clientSrc, /paragraphHandler\(info\);/);
  // ph 入口守卫：划选 info 放行（isSelection），其余点击路径选区非折叠时让行
  assert.match(clientSrc, /if \(selectionNonCollapsed\(\) && !info\.isSelection\) return;/);
  // 划选 info 不触发互斥 closeSelectionCard（防误杀刚建的 layer）
  assert.match(clientSrc, /if \(!info\.isSelection\) closeSelectionCard\(\);/);
});

test("selection card: 同时只开一个 + pointerup 监听 + 弹层互斥", () => {
  // Close the three existing popover kinds before opening; ext param lets external containers
  // (iframes) reuse the same engine for selection
  assert.match(clientSrc, /function openSelectionCard\(text, range, msgEl, ext\) \{[\s\S]*?closeSelectionCard\(\);/);
  // 段落/行内 code 路径反向互斥
  assert.match(clientSrc, /\/\/ 与划选弹层互斥：开段落弹层前先关选中弹层[\s\S]*?closeSelectionCard\(\);/);
  assert.match(clientSrc, /\/\/ 与划选弹层互斥：开 code 弹层前先关选中弹层\s*\n\s*closeSelectionCard\(\);/);
  // 消息区 pointerup capture + 消息块范围校验
  assert.match(clientSrc, /document\.addEventListener\("pointerup", \(e\) => \{/);
  // The guard must read the top window explicitly (rcx may still point at a framed popover's
  // iframe — reading that selection would pass the guard, then the top window's empty selection
  // crashes getRangeAt(0) with IndexSizeError, killing the listener → selection never pops again)
  assert.match(clientSrc, /if \(!selectionNonCollapsed\(window\)\) return;/);
  assert.match(clientSrc, /if \(!sel \|\| sel\.rangeCount === 0\) return;/);
  // Same-gesture closing click race: the card opens on mouseup and the browser fires one more
  // click (target = the cross-block common ancestor like ul/ol — not in the leaf-block whitelist)
  // → outsideHandler must ignore clicks right after opening, or the card closes instantly
  assert.match(clientSrc, /const openedAt = Date\.now\(\);[\s\S]*?if \(Date\.now\(\) - openedAt < 200\) return;/);
  // container = chat msg block OR FileViewer markdown preview
  assert.match(clientSrc, /closest\("\[data-chat-msg-role\], \.markdown-file-preview"\)/);
});

test("selection card: 点弹层自身不重开（pointerup 排除卡片内 target，按钮 click 可达）", () => {
  // 卡片 mousedown preventDefault 保住选区 → selectionNonCollapsed 仍 true；若 pointerup
  // 不排除卡片内 target，点按钮会重走 openSelectionCard → 旧 layer remove 重建 →
  // click 目标 detach → 复制/引用/新会话点了无效（回归防护）
  assert.match(
    clientSrc,
    /document\.addEventListener\("pointerup", \(e\) => \{[\s\S]*?closest\("\[data-msg-smart-card\]"\)\) return;/,
  );
});

test("feature: recognizer.selection 默认开启（extman 可关）", () => {
  assert.match(serverSrc, /id: "recognizer\.selection", label: "划选识别（引用片段）".*default: true/);
});

test("selection via popover service: 外部容器（aiti-editor 预览 iframe）划选走同一引擎", () => {
  // popover service open routing: isSelection + range/rect → openSelectionCard (engine owns the
  // layer; card pinned under the selection)
  assert.match(clientSrc, /if \(info\.isSelection && \(info\.range \|\| info\.rect\)\) \{ openSelectionCard\(info\.text, info\.range \|\| null, info\.element, info\); return; \}/);
  // ext param: doc/win point at the container document (card renders inside the iframe); default = top document, unchanged
  assert.match(clientSrc, /function openSelectionCard\(text, range, msgEl, ext\) \{/);
  assert.match(clientSrc, /setRcx\(ext \? \{ doc: ext\.doc, win: ext\.win \} : null\)/);
  // scroll/resize follow attaches to the container window (positionSelectionCard previously had
  // no listener — any scroll un-anchored the card)
  assert.match(clientSrc, /selectionState\.win = rcx\.win \|\| window;/);
  assert.match(clientSrc, /selectionState\.win\.addEventListener\("scroll", follow, true\)/);
  // close removes listeners via the container window (rcx may already be re-pointed by a later framed popover)
  assert.match(clientSrc, /function selWin\(\) \{ return selectionState\.win \|\| window; \}/);
});

test("selection-container: 容器注册服务（msg-smart 直挂在选区文档挂 pointerup，标准做法）", () => {
  assert.match(clientSrc, /aiti-msg-smart\.selection-container/);
  // handler mirrors the top-level pointerup: card-target exclusion + non-collapsed check + live meta + openSelectionCard
  assert.match(clientSrc, /const selContainers = new Map\(\);/);
  assert.match(clientSrc, /info\.doc\.addEventListener\("pointerup", handler, true\);/);
  assert.match(clientSrc, /openSelectionCard\(text, range, rootEl, \{ doc: info\.doc, win: info\.win, \.\.\.meta \}\);/);
  // unregister: detach the listener; also close the card when it belongs to this container
  assert.match(clientSrc, /if \(selectionState\.win === rec\.win\) closeSelectionCard\(\);/);
  // refuse registration when the feature is off
  assert.match(clientSrc, /if \(!featureEnabled\("recognizer\.selection"\)\) return;/);
});
