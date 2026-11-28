/**
 * 内置 mermaid 围栏渲染器（`md-mermaid.ts`）单测 —— md-plugins M0：mermaid 由「markdown.ts
 * 里的内置硬编码」改为第一个经 registerMdRenderer 注册的消费者，本文件钉住**行为零变化**：
 * 懒加载 vendor / 渲染参数（strict + suppressErrorRendering + 主题跟随）/ parse 先行 /
 * 源码·SVG 下载·查看器缩放 / 加载·成功·错误态文案。
 *
 * Run: node --test pi-web-ext/aiti-editor/client/src/md-mermaid.test.mjs
 * （render 跑在父页、DOM 直写同源预览 iframe → 用 mini-dom 桩造 iframe 文档）
 */
import assert from "node:assert/strict";
import test from "node:test";

const { mermaidRenderer, mermaidFenceCss } = await import("./md-mermaid.ts");
const { makeDoc } = await import("./mini-dom.mjs");

const CODE = "graph TD\n  A --> B";
const SVG = '<svg id="s1" viewBox="0 0 8 8">hi</svg>';
const flush = () => new Promise((r) => setImmediate(r));

/** mermaid 库桩（记录 initialize/parse/render 调用）。 */
function mermaidStub({ parseOk = true, svg = SVG, renderThrows = null } = {}) {
  const calls = { initialize: [], parse: [], render: [] };
  return {
    calls,
    mm: {
      initialize: (o) => { calls.initialize.push(o); },
      parse: async (src, opts) => { calls.parse.push({ src, opts }); return parseOk; },
      render: async (id, src) => { calls.render.push({ id, src }); if (renderThrows) throw renderThrows; return { svg }; },
    },
  };
}

/** iframe 文档/窗口 + 一个已就位（壳替换后）的 mermaid 块。 */
function fixture({ mermaid, dark = false } = {}) {
  const timers = [];
  const blobs = [];
  const urls = { created: 0, revoked: 0 };
  const win = {
    mermaid,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    Blob: function (parts, opts) { blobs.push({ parts, opts }); },
    URL: {
      createObjectURL: () => { urls.created++; return "blob:preview"; },
      revokeObjectURL: () => { urls.revoked++; },
    },
    XMLSerializer: function () {
      this.serializeToString = (n) => '<svg id="' + (n.id || "x") + '"></svg>';
    },
  };
  const doc = makeDoc(win);
  win.document = doc;
  const fence = doc.createElement("div");
  fence.className = "md-fence";
  const actions = doc.createElement("span");
  actions.className = "md-fence-actions";
  const toggle = doc.createElement("button");
  toggle.className = "md-fbtn md-fence-toggle";
  actions.appendChild(toggle);
  fence.appendChild(actions);
  const view = doc.createElement("button");
  view.className = "md-fence-view";
  view.setAttribute("data-md-fence", "mermaid");
  fence.appendChild(view);
  return {
    doc, win, view, actions, toggle, timers, blobs, urls,
    ctx: { dark, iframeDoc: doc, base: "/api/extensions/aiti-editor", actions },
  };
}

/** 走到「vendor 已就位」的渲染（head 里的 script 由桩手动 onload）。 */
async function renderWith(f, stub, code = CODE) {
  const p = mermaidRenderer.render(f.view, code, f.ctx);
  await flush();
  const tag = f.doc.head.children.find((c) => c.tagName === "SCRIPT");
  if (tag) { f.win.mermaid = stub.mm; tag.onload(); }
  await p;
  return tag;
}

test("注册项形状（lang/render 必备；css 按主题求值的函数）", () => {
  assert.equal(mermaidRenderer.id, "aiti-editor.mermaid");
  assert.equal(mermaidRenderer.lang, "mermaid");
  assert.equal(mermaidRenderer.displayName, "Mermaid 图表");
  assert.equal(mermaidRenderer.sourceExt, "aiti-editor");
  assert.equal(typeof mermaidRenderer.render, "function");
  assert.match(mermaidRenderer.base, /\/api\/extensions\/aiti-editor$/);
  assert.equal(typeof mermaidRenderer.css, "function");
});

test("渲染器自带样式：作用域限 mermaid 块（不给别的渲染器串味）+ 查看器件齐备", () => {
  const light = mermaidFenceCss(false);
  assert.match(light, /\.md-fence-view\[data-md-fence="mermaid"\]\{cursor:zoom-in\}/);
  assert.match(light, /\.md-fence-view\[data-md-fence="mermaid"\]:hover\{opacity:\.85\}/); // hover 反馈
  assert.match(light, /\.md-fence-view\[data-md-fence="mermaid"\] svg\{display:block/);
  assert.match(light, /\.md-zoom\{[^}]*background:#fff/);
  assert.match(mermaidFenceCss(true), /\.md-zoom\{[^}]*background:#0d1117/); // 暗色跟随
});

test("懒加载：mermaid.min.js 走自托管资产路由，且一个 iframe 文档只注一次", async () => {
  const { mm } = mermaidStub();
  const f1 = fixture();
  const tag = await renderWith(f1, { mm });
  assert.equal(tag.src, "/api/extensions/aiti-editor/assets/vendor/mermaid.min.js");
  // 同一文档第二块：不再注 script（vendor 已在）
  const view2 = f1.doc.createElement("button");
  view2.className = "md-fence-view";
  await mermaidRenderer.render(view2, CODE, { ...f1.ctx, actions: f1.actions });
  assert.equal(f1.doc.head.children.filter((c) => c.tagName === "SCRIPT").length, 1);
  // 新文档（srcdoc 重建）重新注入
  const f2 = fixture();
  await renderWith(f2, { mm });
  assert.equal(f2.doc.head.children.filter((c) => c.tagName === "SCRIPT").length, 1);
});

test("渲染参数与 pi-web MermaidBlock 一致（strict / suppressErrorRendering / 主题跟随）", async () => {
  const s = mermaidStub();
  await renderWith(fixture({ mermaid: s.mm }), s);
  assert.deepEqual(s.calls.initialize[0], {
    startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "default",
  });
  const d = mermaidStub();
  await renderWith(fixture({ mermaid: d.mm, dark: true }), d);
  assert.equal(d.calls.initialize[0].theme, "dark");
});

test("parse 先行（suppressErrors），通过后才 render；id 唯一", async () => {
  const s = mermaidStub();
  await renderWith(fixture({ mermaid: s.mm }), s);
  assert.deepEqual(s.calls.parse[0], { src: CODE, opts: { suppressErrors: true } });
  assert.equal(s.calls.render.length, 1);
  assert.match(s.calls.render[0].id, /^md-mermaid-\d+-[\w-]+$/);
  assert.equal(s.calls.render[0].src, CODE);

  const bad = mermaidStub({ parseOk: false });
  const f = fixture({ mermaid: bad.mm });
  await assert.rejects(() => mermaidRenderer.render(f.view, "%%", f.ctx), /无效的 Mermaid 图表/);
  assert.equal(bad.calls.render.length, 0); // parse 不过不出图（同上游 suppressErrorRendering）
});

test("成功态：SVG 落进 view，aria 文案由「正在渲染」转「打开查看器」，SVG 按钮解除隐藏并排在源码切换左侧", async () => {
  const s = mermaidStub();
  const f = fixture({ mermaid: s.mm });
  assert.equal(f.view.getAttribute("data-md-fence"), "mermaid");
  await renderWith(f, s);
  assert.equal(f.view.innerHTML, SVG);
  assert.equal(f.view.querySelector("svg").id, "s1");
  assert.equal(f.view.title, "打开 Mermaid 查看器");
  assert.equal(f.view.getAttribute("aria-label"), "打开 Mermaid 查看器");
  const svgBtn = f.actions.querySelector(".md-mermaid-svg");
  assert.equal(svgBtn.hidden, false);
  assert.equal(svgBtn.textContent, "SVG");
  assert.equal(svgBtn.title, "下载文件 (SVG)");
  assert.deepEqual(f.actions.children.map((c) => c.className), ["md-fbtn md-mermaid-svg", "md-fbtn md-fence-toggle"]);
});

test("出图前是加载态（SVG 按钮先藏；错误/无窗口时保持失败态）", async () => {
  const s = mermaidStub();
  const f = fixture();
  const p = mermaidRenderer.render(f.view, CODE, f.ctx).then(
    () => { throw new Error("不应该 resolve"); },
    (e) => e.message,
  );
  await flush();
  const svgBtn = f.actions.querySelector(".md-mermaid-svg");
  assert.equal(svgBtn.hidden, true, "vendor 未就位前不给下载按钮");
  assert.equal(f.view.getAttribute("aria-label"), "正在渲染 Mermaid 图表");
  assert.equal(f.view.title, "打开 Mermaid 查看器");
  const tag = f.doc.head.children.find((c) => c.tagName === "SCRIPT");
  tag.onerror(); // vendor 载失败
  assert.match(await p, /无效的 Mermaid 图表/);
  assert.equal(svgBtn.hidden, true);
});

test("库抛异常 / 无 iframe window → 一律落「无效的 Mermaid 图表」（壳写进错误态）", async () => {
  const s = mermaidStub({ renderThrows: new Error("Syntax error in graph") });
  const f = fixture({ mermaid: s.mm });
  await assert.rejects(() => mermaidRenderer.render(f.view, CODE, f.ctx), /Syntax error in graph/);

  const g = fixture();
  g.doc.defaultView = null;
  await assert.rejects(() => mermaidRenderer.render(g.view, CODE, g.ctx), /无效的 Mermaid 图表/);
});

test("交互委托：点 SVG 按钮下载序列化 SVG（一个文档一次监听）", async () => {
  const s = mermaidStub();
  const f = fixture({ mermaid: s.mm });
  await renderWith(f, s);
  assert.equal(f.doc.handlers.click.length, 1); // addEventListener 幂等（第二块不重复挂）
  const view2 = f.doc.createElement("button");
  view2.className = "md-fence-view";
  view2.setAttribute("data-md-fence", "mermaid");
  await mermaidRenderer.render(view2, CODE, f.ctx); // 同文档第二块：渲染但不新增监听
  assert.equal(f.doc.handlers.click.length, 1);

  const svgBtn = f.actions.querySelector(".md-mermaid-svg");
  f.doc.fire("click", { target: svgBtn });
  assert.equal(f.urls.created, 1);
  assert.deepEqual(f.blobs[0].opts, { type: "image/svg+xml;charset=utf-8" });
  assert.equal(f.blobs[0].parts[0], '<svg id="s1"></svg>');
  const anchor = f.doc.created.find((c) => c.tagName === "A"); // 下载锚：建完即点，不挂树
  assert.equal(anchor.download, "mermaid-diagram.svg");
  assert.equal(anchor.href, "blob:preview");
  assert.equal(anchor.clicked, 1);
  assert.equal(f.timers.length, 1);
  f.timers.forEach((fn) => fn());
  assert.equal(f.urls.revoked, 1);
});

test("交互委托：点预览本体开查看器（缩放 0.5–3 步进 0.25 / 边界禁用 / 适应宽度 / 关闭还原滚动）", async () => {
  const s = mermaidStub();
  const f = fixture({ mermaid: s.mm });
  await renderWith(f, s);
  f.doc.fire("click", { target: f.view });
  const dlg = f.doc.body.children.find((c) => c.tagName === "DIALOG");
  assert.ok(dlg, "查看器对话框");
  assert.ok(dlg.open);
  assert.equal(f.doc.body.style.overflow, "hidden");
  const value = dlg.querySelector(".md-zoom-value");
  const canvas = dlg.querySelector(".md-zoom-canvas");
  const outB = dlg.querySelector('[data-z="out"]');
  const inB = dlg.querySelector('[data-z="in"]');
  const click = (el) => dlg.fire("click", { target: el });
  assert.equal(value.textContent, "100%");
  assert.equal(canvas.style.width, "100%");
  click(inB);
  assert.equal(value.textContent, "125%");
  for (let i = 0; i < 10; i++) click(inB);
  assert.equal(value.textContent, "300%"); // 上限
  assert.equal(inB.disabled, true);
  assert.equal(outB.disabled, false);
  for (let i = 0; i < 12; i++) click(outB);
  assert.equal(value.textContent, "50%"); // 下限
  assert.equal(outB.disabled, true);
  click(dlg.querySelector('[data-z="fit"]'));
  assert.equal(value.textContent, "100%");
  click(dlg.querySelector('[data-z="close"]'));
  assert.equal(dlg.open, false);
  assert.equal(f.doc.body.children.includes(dlg), false); // close 后自移除
  assert.equal(f.doc.body.style.overflow, "");
  // 点空白视口 = 关闭（对话框背景点击语义）
  f.doc.fire("click", { target: f.view });
  const dlg2 = f.doc.body.children.find((c) => c.tagName === "DIALOG");
  dlg2.fire("click", { target: dlg2.querySelector(".md-zoom-viewport") });
  assert.equal(dlg2.open, false);
});

test("交互委托：非 mermaid 块（或壳外点击）不触发下载/查看器", async () => {
  const s = mermaidStub();
  const f = fixture({ mermaid: s.mm });
  await renderWith(f, s);
  const other = f.doc.createElement("div"); // 无 .md-fence 祖先
  assert.doesNotThrow(() => f.doc.fire("click", { target: other }));
  f.doc.fire("click", { target: null });
  const math = f.doc.createElement("div");
  math.className = "md-fence";
  const mathView = f.doc.createElement("button");
  mathView.className = "md-fence-view";
  mathView.setAttribute("data-md-fence", "math");
  math.appendChild(mathView);
  f.doc.fire("click", { target: mathView }); // 该块无 mermaid view → 忽略
  assert.equal(f.doc.body.children.filter((c) => c.tagName === "DIALOG").length, 0);
  assert.equal(f.urls.created, 0);
});
