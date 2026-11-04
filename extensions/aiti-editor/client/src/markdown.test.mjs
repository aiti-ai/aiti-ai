/**
 * markdown 预览渲染测试 — 围栏渲染器壳（md-plugins M0）+ 门禁 + 标题/智能点击链路。
 *
 * Run: node --test pi-web-ext/aiti-editor/client/src/markdown.test.mjs
 * （node 24 原生 TS strip-types，直接 import 邻近 .ts；字符串级断言，无 DOM/fetch 依赖）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

const {
  markdownPreviewHtml, hasMermaidFence, hasFenceOf, isFenceLang, activeFenceRenderers,
  fenceShellCss, fenceShellScript,
} = await import("./markdown.ts");
const { mermaidFenceCss } = await import("./md-mermaid.ts");
const { makeEl } = await import("./mini-dom.mjs");
const { mdSlug } = await import("./lib.ts");

const FENCE = "graph TD\n  A --> B";
const WITH_MERMAID = "# t\n\n```mermaid\n" + FENCE + "\n```\n";
const NO_MERMAID = "# t\n\n```js\nvar a = 1;\n```\n";
// 注册表构建期描述符的等价物（registry.mdFenceDescriptors 已把 css 按主题求值）
const MERMAID_RS = [{ lang: "mermaid", css: mermaidFenceCss(false) }];

test("预览：实际生成脚本的标题 ID 与 TOC 一致，点击能滚到相应章节", () => {
  const titles = ["Introduction", "Hello, World!", "API v2_0", "第 1 章 Setup", "纯中文章节"];
  const expected = ["introduction", "hello-world", "api-v2_0", "第-1-章-setup", "纯中文章节"];
  assert.deepEqual(titles.map(mdSlug), expected);
  const html = markdownPreviewHtml(titles.map(t => "## " + t).join("\n\n"), false);
  const links = [...html.matchAll(/<a href="#([^"]+)">/g)].map(m => m[1]);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const listeners = {};
  const messages = [];
  const headings = titles.map(textContent => ({
    textContent, id: "", scrolls: 0,
    scrollIntoView() { this.scrolls++; },
  }));
  const content = { innerHTML: "", children: [] };
  // 执行最终 HTML 里的脚本，而不是仅匹配 TS 源码，覆盖模板字符串转义丢失。
  runInNewContext(script, {
    marked: { parse: () => "", lexer: () => [] },
    document: {
      getElementById: id => id === "content" ? content : headings.find(h => h.id === id),
      querySelectorAll: () => headings,
      addEventListener: (type, handler) => { listeners[type] = handler; },
    },
    window: { parent: { postMessage: m => messages.push(m) }, addEventListener() {} },
  });
  assert.deepEqual(links, expected);
  assert.deepEqual(headings.map(h => h.id), expected);
  links.forEach((id, index) => {
    let prevented = false;
    listeners.click({
      target: { closest: () => ({ getAttribute: () => "#" + id }) },
      preventDefault() { prevented = true; }, stopPropagation() {},
    });
    assert.equal(prevented, true);
    assert.equal(headings[index].scrolls, 1);
    assert.equal(messages[index].anchor, id);
  });
});

test("isFenceLang / hasFenceOf：围栏门禁判定", () => {
  assert.equal(isFenceLang("mermaid"), true);
  assert.equal(isFenceLang("flow-chart"), true);
  assert.equal(isFenceLang("math js"), false); // 空格/特殊字符不进 class 与正则
  assert.equal(isFenceLang(""), false);
  assert.equal(isFenceLang(null), false);

  assert.equal(hasFenceOf(WITH_MERMAID, "mermaid"), true);
  assert.equal(hasFenceOf("```mermaid\ngraph TD\n```\n", "mermaid"), true);
  assert.equal(hasFenceOf("  ```mermaid\ngraph TD\n```\n", "mermaid"), true); // 缩进围栏
  assert.equal(hasFenceOf(NO_MERMAID, "mermaid"), false);
  assert.equal(hasFenceOf("```mermaidjs\nx\n```\n", "mermaid"), false); // \b 边界：mermaidjs 不算
  assert.equal(hasFenceOf("行内 ```mermaid 不算围栏", "mermaid"), false);
  assert.equal(hasFenceOf("", "mermaid"), false);
  assert.equal(hasFenceOf("```x\ny\n```\n", "bad lang"), false); // lang 非法 → 恒 false
  assert.equal(hasFenceOf("```math\nx^2\n```\n", "math"), true); // 语言无关
  assert.equal(hasMermaidFence(WITH_MERMAID), true); // 导出链路口仍用它
  assert.equal(hasMermaidFence(NO_MERMAID), false);
});

test("activeFenceRenderers：描述符 ∩ 内容（注册序保持 / 同语言去重 / 非法与未命中丢弃）", () => {
  const both = "# t\n\n```math\nx\n```\n\n```mermaid\ngraph TD\n```\n";
  assert.deepEqual(activeFenceRenderers(both, [
    { lang: "mermaid", css: "M" }, { lang: "math", css: "X" },
  ]), [{ lang: "mermaid", css: "M" }, { lang: "math", css: "X" }]);
  assert.deepEqual(activeFenceRenderers(WITH_MERMAID, [{ lang: "math" }, { lang: "mermaid" }]), [{ lang: "mermaid" }]);
  assert.deepEqual(activeFenceRenderers(WITH_MERMAID, [{ lang: "mermaid" }, { lang: "mermaid", css: "2" }]), [{ lang: "mermaid" }]); // 每语言只注一份
  assert.deepEqual(activeFenceRenderers(WITH_MERMAID, [{ lang: "bad lang" }, null, { lang: "" }]), []);
  assert.deepEqual(activeFenceRenderers(WITH_MERMAID, undefined), []);
});

test("预览：命中围栏才注壳（壳样式 + 渲染器样式 + 分发脚本）；无围栏零注入", () => {
  const on = markdownPreviewHtml(WITH_MERMAID, false, undefined, true, MERMAID_RS);
  assert.ok(on.includes(fenceShellCss(false)), "壳 CSS");
  assert.ok(on.includes(mermaidFenceCss(false)), "渲染器自带 CSS");
  assert.ok(on.includes(fenceShellScript(false, ["mermaid"])), "分发脚本原样内联");
  assert.match(on, /var MD_DARK = false;/);

  // 门禁两路都不命中 → 零注入（延续旧 hasMermaidFence 语义）
  const noRenderer = markdownPreviewHtml(WITH_MERMAID, false, undefined, true, []);
  assert.doesNotMatch(noRenderer, /\.md-fence\b/);
  assert.doesNotMatch(noRenderer, /resolveMdRenderers/);
  const noFence = markdownPreviewHtml(NO_MERMAID, false, undefined, true, MERMAID_RS);
  assert.doesNotMatch(noFence, /\.md-fence\b/);
  assert.doesNotMatch(noFence, /mermaid/);
});

test("预览：壳与语言无关（mermaid 不再特殊；非注册语言不注入）", () => {
  const MATH_RS = [{ lang: "math", css: ".md-math{display:inline}" }];
  const html = markdownPreviewHtml("```math\nx^2\n```\n", true, undefined, true, MATH_RS);
  assert.ok(html.includes(fenceShellCss(true)));
  assert.match(html, /\.md-math\{display:inline\}/);
  assert.match(html, /var langs = \["math"\];/);
  assert.doesNotMatch(html, /mermaid/i);
  // 内容里没有的语言（即便注册了）不进 langs
  assert.doesNotMatch(markdownPreviewHtml(NO_MERMAID, false, undefined, true, [...MATH_RS, ...MERMAID_RS]), /"mermaid"/);
});

test("壳样式：视觉对齐 pi-web 图表块（高度上限 / 焦点可见 / 错误与源码态）", () => {
  const light = fenceShellCss(false);
  assert.match(light, /max-height:min\(600px,60vh\)/); // 同上游 min(600px,60dvh)
  assert.match(light, /\.md-fence-view:focus-visible\{outline:2px solid #0969da/);
  assert.match(light, /\.md-fence\.is-error \.md-fence-view\{display:none\}/);
  assert.match(light, /\.md-fence\.srcmode \.md-fence-src\{display:block\}/);
  assert.match(light, /\.md-fbtn\[hidden\]\{display:none\}/);
  assert.match(fenceShellCss(true), /outline:2px solid #58a6ff/); // 暗色描边跟随主题
});

// ── 分发壳运行时行为：跑真脚本（node:vm + mini-dom 桩），不匹配 TS 源码 ──

/** 一个围栏 <pre><code class="language-x"> 的桩（pre.replaced = 原位替换进来的壳） */
function fencePre(lang, src) {
  const pre = makeEl("pre");
  const code = makeEl("code");
  code.className = "language-" + lang;
  code.textContent = src;
  pre.appendChild(code);
  return code;
}

const flush = () => new Promise((r) => setImmediate(r));

/** 跑 fenceShellScript：返回 click 监听与文档桩，供断言分发/切换行为。 */
async function runFenceShell({ codes, langs = ["mermaid"], dark = false, resolver, parentThrows = false }) {
  const doc = {
    clicks: [],
    createElement: (t) => makeEl(t, doc),
    querySelectorAll: (sel) => (sel === "#content pre > code" ? codes : []),
    addEventListener(t, fn) { if (t === "click") doc.clicks.push(fn); },
  };
  const win = { document: doc, parent: {} };
  if (parentThrows) Object.defineProperty(win, "parent", { get() { throw new Error("cross-origin"); } });
  else if (resolver) win.parent.__aitiEditor = { resolveMdRenderers: resolver };
  runInNewContext(fenceShellScript(dark, langs), { document: doc, window: win });
  await flush();
  return { doc, clicks: doc.clicks };
}

test("壳：命中围栏的 <pre> 原位替换为 .md-fence（顶层 1:1），ctx 齐备，成功落 is-ready", async () => {
  const code = fencePre("mermaid", "graph TD\n  A --> B\n");
  const seen = [];
  const asked = [];
  const renderer = {
    base: "/ext/assets",
    render: async (view, src, ctx) => { seen.push({ view, src, ctx }); view.textContent = "<svg/>"; },
  };
  const { doc, clicks } = await runFenceShell({
    codes: [code], dark: true,
    resolver: (lang) => { asked.push(lang); return [renderer]; },
  });
  assert.deepEqual(asked, ["mermaid"]);
  const w = code.parentElement.replaced;
  assert.ok(w.classList.contains("md-fence")); // 原位替换（元素数不变 → git 行标注仍 1:1）
  assert.match(w.children[0].innerHTML, /<span class="md-fence-lang">mermaid<\/span>/);
  assert.match(w.children[0].innerHTML, /class="md-fbtn md-fence-toggle"/);
  const view = w.querySelector(".md-fence-view");
  assert.equal(view.tagName, "BUTTON"); // 预览本体 = 真 button（键盘可达）
  assert.equal(view.getAttribute("data-md-fence"), "mermaid"); // 渲染器据此定位（CSS/事件委托）
  assert.equal(view.getAttribute("aria-label"), "正在渲染 mermaid…");
  assert.ok(w.querySelector(".md-fence-src"), "源码态节点就位");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].src, "graph TD\n  A --> B"); // 去尾换行再交渲染（同上游）
  assert.equal(seen[0].view, view);
  assert.equal(seen[0].ctx.dark, true); // MD_DARK 透传
  assert.equal(seen[0].ctx.iframeDoc, doc);
  assert.equal(seen[0].ctx.base, "/ext/assets");
  assert.equal(seen[0].ctx.actions, w.querySelector(".md-fence-actions"));
  assert.ok(!view.classList.contains("md-fence-loading"));
  assert.ok(w.classList.contains("is-ready"));
  assert.equal(clicks.length, 1); // 源码切换委托
});

test("壳：render throw / reject → 错误态文案取 message，非 Error 兜底「<lang> 渲染失败」", async () => {
  const cases = [
    { render: () => { throw new Error("boom"); }, want: "boom" },
    { render: () => Promise.reject(new Error("nope")), want: "nope" },
    { render: () => Promise.reject("x"), want: "mermaid 渲染失败" },
  ];
  for (const c of cases) {
    const code = fencePre("mermaid", "graph TD");
    const { doc } = await runFenceShell({ codes: [code], resolver: () => [c] });
    const w = code.parentElement.replaced;
    assert.ok(w.classList.contains("is-error"), c.want);
    assert.ok(!w.classList.contains("is-ready"));
    const err = w.querySelector(".md-fence-error");
    assert.equal(err.hidden, false);
    assert.equal(err.textContent, c.want);
    assert.ok(!w.querySelector(".md-fence-view").classList.contains("md-fence-loading"));
    assert.equal(doc.clicks.length, 1);
  }
});

test("壳：普通代码块保持原样（非注册语言 / 该语言无生效渲染器 / 父页不可达）", async () => {
  const notOurs = fencePre("js", "var a = 1;");
  await runFenceShell({ codes: [notOurs], resolver: () => [{ render() {} }] });
  assert.equal(notOurs.parentElement.replaced, undefined);

  const noRenderer = fencePre("mermaid", "graph TD");
  await runFenceShell({ codes: [noRenderer], resolver: () => [] });
  assert.equal(noRenderer.parentElement.replaced, undefined);

  const noRenderFn = fencePre("mermaid", "graph TD");
  await runFenceShell({ codes: [noRenderFn], resolver: () => [{ id: "x" }] });
  assert.equal(noRenderFn.parentElement.replaced, undefined);

  const crossOrigin = fencePre("mermaid", "graph TD");
  await runFenceShell({ codes: [crossOrigin], parentThrows: true });
  assert.equal(crossOrigin.parentElement.replaced, undefined); // 独立打开该 srcdoc → 整块跳过

  const noParent = fencePre("mermaid", "graph TD");
  await runFenceShell({ codes: [noParent] }); // 无 resolver：父页未挂 __aitiEditor
  assert.equal(noParent.parentElement.replaced, undefined);
});

test("壳：源码 / 预览 切换（委托点击；错误态一样能看源码）", async () => {
  const code = fencePre("mermaid", "graph TD");
  const { doc } = await runFenceShell({ codes: [code], resolver: () => [{ render: () => { throw new Error("bad"); } }] });
  const w = code.parentElement.replaced;
  const btn = w.querySelector(".md-fence-toggle");
  const fire = () => doc.clicks[0]({ target: btn });
  fire();
  assert.ok(w.classList.contains("srcmode"));
  assert.equal(btn.textContent, "预览");
  assert.equal(btn.title, "预览图表");
  assert.ok(btn.classList.contains("is-active"));
  fire();
  assert.ok(!w.classList.contains("srcmode"));
  assert.equal(btn.textContent, "源码");
  assert.equal(btn.title, "查看源码");
  // 壳外点击（无 .md-fence 祖先）不动
  doc.clicks[0]({ target: makeEl("p") });
  doc.clicks[0]({ target: null });
  assert.ok(!w.classList.contains("srcmode"));
});

test("壳脚本：langs 过滤非法语言 id（class/正则注入面）", () => {
  const script = fenceShellScript(false, ["mermaid", "flow-chart", "bad lang", '"><script>', ""]);
  assert.match(script, /var langs = \["mermaid","flow-chart"\];/);
  assert.doesNotMatch(script, /bad lang/);
  assert.doesNotMatch(script, /"><script>/);
});

test("预览：无 mermaid 时其余链路不受影响（marked/css 引用仍在）", () => {
  const html = markdownPreviewHtml(NO_MERMAID, false);
  assert.match(html, /\/assets\/vendor\/marked\.min\.js/);
  assert.match(html, /\/assets\/vendor\/github-markdown\.min\.css/);
  assert.match(html, /marked\.parse\(/);
});

// ── 智能点击（aiti-msg-smart 集成）：iframe 内点击语义块/代码行 → postMessage 上报 ──
const MD = "# 标题\n\n正文一段。\n\n```js\nvar a = 1;\nvar b = 2;\n```\n";

/** 跑生成的脚本，收集 click 监听（按注册顺序全部保留）与 postMessage */
function runScript(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const clicks = [];
  const messages = [];
  const content = {
    innerHTML: "",
    children: [
      mk("H1", "标题", { "data-src-start": "1", "data-src-end": "1", "data-aiti-blk": "0" }),
      mk("P", "正文一段。", { "data-src-start": "3", "data-src-end": "3", "data-aiti-blk": "1" }),
      mk("PRE", "var a = 1;\nvar b = 2;", { "data-src-start": "5", "data-src-end": "8", "data-aiti-blk": "2", "data-code-start": "6" }),
    ],
  };
  function mk(tagName, textContent, attrs) {
    return {
      tagName, textContent, attrs,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      closest: (sel) => (sel.includes("data-aiti-blk") ? { ...attrsClosest } : null),
      contains: () => true,
      getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 10, right: 10, width: 100, height: 10 }),
      childNodes: [],
    };
  }
  const elById = {};
  const doc = {
    getElementById: (id) => (id === "content" ? content : elById[id]),
    querySelectorAll: () => [],
    addEventListener: (type, handler) => { if (type === "click") clicks.push(handler); },
    createTreeWalker: () => ({ nextNode: () => null }),
    caretRangeFromPoint: () => null,
    createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [] }),
  };
  const win = {
    parent: { postMessage: (m) => messages.push(m) },
    addEventListener() {},
    getSelection: () => ({ isCollapsed: true, rangeCount: 0, toString: () => "" }),
  };
  runInNewContext(script, { marked: { parse: () => "", lexer: () => [] }, document: doc, window: win });
  return { clicks, messages };
}
// 点击目标桩：closest 只认 data-aiti-blk（锚点选择器 a[href^="#"] 恒不命中）
let attrsClosest = null;
function hitTarget() {
  return {
    nodeType: 1,
    closest: (sel) => (String(sel).includes("data-aiti-blk") ? attrsClosest : null),
  };
}
function blkStub(attrs, textContent = "") {
  return { ...attrs, textContent, getAttribute: (k) => attrs[k] ?? null };
}

test("预览：点击语义块 → 上报 aiti-editor-preview-click（块级，带源码行区间）", () => {
  attrsClosest = blkStub({ "data-aiti-blk": "1", "data-src-start": "3", "data-src-end": "3", "data-code-start": null }, "正文一段。");
  const { clicks, messages } = runScript(markdownPreviewHtml(MD, false));
  assert.equal(clicks.length, 1); // 锚点拦截与点击上报合并为单个监听
  clicks[0]({ target: hitTarget(), clientX: 5, clientY: 5 });
  const m = messages.find((x) => x.type === "aiti-editor-preview-click");
  // vm 沙箱对象原型不同 → 跨上下文比对走 JSON 往返
  assert.deepEqual(JSON.parse(JSON.stringify(m)), {
    type: "aiti-editor-preview-click", blk: "1", kind: "block",
    text: "正文一段。", row: null, charOffset: null, srcStart: 3, srcEnd: 3,
  });
});

test("预览：点击代码行 → 上报 code-line（源码行 = data-code-start + 行号）", () => {
  attrsClosest = blkStub({ "data-aiti-blk": "2", "data-src-start": "5", "data-src-end": "8", "data-code-start": "6" }, "var a = 1;\nvar b = 2;");
  const { clicks, messages } = runScript(markdownPreviewHtml(MD, false));
  clicks[0]({ target: hitTarget(), clientX: 5, clientY: 5 });
  const m = messages.find((x) => x.type === "aiti-editor-preview-click");
  assert.equal(m.kind, "code-line");
  assert.equal(m.srcStart, 6); // data-code-start(6) + row(0)：围栏行不属代码内容
  assert.equal(m.row, 0);
});

test("预览：划选收尾的 click 不上报（有非折叠选区 → 让行给选区）", () => {
  attrsClosest = blkStub({ "data-aiti-blk": "1", "data-src-start": "3", "data-src-end": "3", "data-code-start": null }, "正文");
  const html = markdownPreviewHtml(MD, false);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const clicks = [];
  const messages = [];
  runInNewContext(script, {
    marked: { parse: () => "", lexer: () => [] },
    document: { getElementById: () => ({ innerHTML: "", children: [] }), querySelectorAll: () => [], addEventListener: (t, h) => { if (t === "click") clicks.push(h); } },
    window: { parent: { postMessage: (m) => messages.push(m) }, addEventListener() {}, getSelection: () => ({ isCollapsed: false, rangeCount: 1, toString: () => "正文" }) },
  });
  clicks[0]({ target: hitTarget(), clientX: 5, clientY: 5 });
  assert.equal(messages.some((x) => x.type === "aiti-editor-preview-click"), false);
});

test("预览：feature 关（smart=false）→ 不发点击消息；主题变量与卡片穿透样式常在", () => {
  const off = markdownPreviewHtml(MD, false, undefined, false);
  assert.match(off, /var SMART = 0;/);
  const on = markdownPreviewHtml(MD, false, undefined, true);
  assert.match(on, /var SMART = 1;/);
  assert.match(on, /data-aiti-blk/); // 语义锚点仍标注（@ 引用行号用）
  // 弹层主题变量（iframe 内无宿主变量，卡片须自带）
  assert.match(on, /--bg:#fff;--border:#d0d7de;--accent:#0969da/);
  assert.match(markdownPreviewHtml(MD, true), /--bg:#0d1117;--border:#30363d/);
  // 卡片容器点击穿透（同 msg-smart 顶层注入规则）
  assert.match(on, /\[data-msg-smart-card\]\{pointer-events:none\}/);
});
