/**
 * preview.ts / html.ts tests — 预览门禁 + HTML 快速态纯函数。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-editor/client/src/html.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { previewKindOf, defaultViewModeOf, previewModeItems } = await import("./preview.ts");
const {
  stripUserScripts,
  buildHtmlPreviewSrcdoc,
  previewUrl,
  absBase,
  resolvePreviewRel,
  viewportStyle,
  viewportWidthOf,
  VIEWPORT_PRESETS,
} = await import("./html.ts");

// ── 门禁：哪些文件有预览面 ──

test("previewKindOf：md 系与 html/htm 出类型；其余 null", () => {
  assert.equal(previewKindOf("/a/b/README.md"), "markdown");
  assert.equal(previewKindOf("/a/b/notes.MARKDOWN"), "markdown");
  assert.equal(previewKindOf("/a/b/index.HTML"), "html");
  assert.equal(previewKindOf("/a/b/page.HTM"), "html");
  assert.equal(previewKindOf("C:\\work\\site\\index.html"), "html");
  assert.equal(previewKindOf("/a/b/x.txt"), null);
  assert.equal(previewKindOf("/a/b/Makefile"), null);
  assert.equal(previewKindOf("/a/b/.md"), null);
  assert.equal(previewKindOf(""), null);
});

test("previewKindOf：扩展名表跟随 LANG_EXT（.mkd 全仓不当 markdown，就不能给它空白预览面）", () => {
  assert.equal(previewKindOf("/a/b/note.mkd"), null);
  assert.equal(previewKindOf("/a/b/note.mdx"), null);
});

test("previewKindOf：provider 声明 language=markdown 时按 markdown（非常规扩展名也有预览面）", () => {
  assert.equal(previewKindOf("/a/b/README.txt", "markdown"), "markdown");
  assert.equal(previewKindOf("/a/b/App.vue", "html"), null, "html 不看语言：.vue 不是独立可渲染文档");
  assert.equal(defaultViewModeOf("/a/b/README.txt", "markdown"), "preview");
});

test("previewKindOf：.vue/.svg 不给预览面（language 是 html 但不是独立可渲染文档）", () => {
  assert.equal(previewKindOf("/a/App.vue"), null);
  assert.equal(previewKindOf("/a/icon.svg"), null);
});

test("defaultViewModeOf：有预览面的默认预览，其余默认编辑", () => {
  assert.equal(defaultViewModeOf("/a/b.md"), "preview");
  assert.equal(defaultViewModeOf("/a/b.html"), "preview");
  assert.equal(defaultViewModeOf("/a/b.ts"), "edit");
});

test("previewModeItems：三模式条目（value 稳定），无预览面返回空", () => {
  assert.deepEqual(previewModeItems(null), []);
  const md = previewModeItems("markdown").map((m) => m.value);
  const html = previewModeItems("html").map((m) => m.value);
  assert.deepEqual(md, ["edit", "split", "preview"]);
  assert.deepEqual(html, md, "两类共用同一套切换器");
  assert.match(previewModeItems("html")[2].title, /渲染页面/);
});

// ── 剥脚本（便利层：真实边界是 opaque origin）──

test("stripUserScripts：成对 script（大小写 + 跨行 + 属性）整段剥除", () => {
  const src = '<div>a</div>\n<SCRIPT type="text/javascript">\n  alert(1);\n</SCRIPT>\n<p>b</p><script src="x.js"></script>';
  const r = stripUserScripts(src);
  assert.equal(r.removed, 2);
  assert.equal(r.html.includes("alert"), false);
  assert.equal(r.html.includes("x.js"), false);
  assert.ok(r.html.includes("<div>a</div>"), "正文不受影响");
});

test("stripUserScripts：自闭合 script 也剥", () => {
  const r = stripUserScripts("<script/>text");
  assert.equal(r.removed, 1);
  assert.equal(r.html, "text");
});

test("stripUserScripts：on* 属性（双引号/单引号/裸值/大写/含空格）", () => {
  const r = stripUserScripts(
    `<a href="/x" onclick="evil()">1</a><img src="a.png" ONERROR='evil()'>` +
    `<button onclick = evil() >2</button>`,
  );
  assert.equal(r.removed, 3);
  assert.equal(r.html.includes("evil"), false);
  assert.match(r.html, /href="\/x"/, "正常属性保留");
  assert.match(r.html, /src="a\.png"/);
});

test("stripUserScripts：javascript: 伪协议改 #，引号不被吃掉", () => {
  const r = stripUserScripts(`<a href="javascript:alert(1)">a</a><a href='javascript:x()'>b</a><a href=javascript:alert(2)>c</a>`);
  assert.equal(r.removed, 3);
  assert.match(r.html, /href="#"/);
  assert.match(r.html, /href='#'/);
  assert.match(r.html, /href=#/);
  assert.equal(r.html.includes("alert"), false);
  assert.equal(r.html.includes("<a"), true, "标签结构完整（引号未失配）");
});

test("stripUserScripts：无脚本内容与 null/undefined 输入零改动", () => {
  assert.deepEqual(stripUserScripts("<p>纯文本</p>"), { html: "<p>纯文本</p>", removed: 0 });
  assert.equal(stripUserScripts(undefined).removed, 0);
  assert.equal(stripUserScripts(null).html, "");
});

// ── 快速态 srcdoc ──

const SHIM = "/*shim*/";

test("buildHtmlPreviewSrcdoc：scripts=false 剥脚本并回报处数；true 原样", () => {
  const src = "<html><head></head><body><p>hi</p><script>alert(1)</script></body></html>";
  const off = buildHtmlPreviewSrcdoc({ content: src, base: "", scripts: false, dark: false, shim: "" });
  assert.equal(off.stripped, 1);
  assert.equal(off.doc.includes("alert"), false);
  const on = buildHtmlPreviewSrcdoc({ content: src, base: "", scripts: true, dark: false, shim: "" });
  assert.equal(on.stripped, 0);
  assert.ok(on.doc.includes("alert(1)"));
});

test("buildHtmlPreviewSrcdoc：base 注入 <head> 内；作者已有 <base> 不重复", () => {
  const { doc } = buildHtmlPreviewSrcdoc({
    content: "<html><head><title>T</title></head><body></body></html>",
    base: "http://h:1/dev/api/extensions/aiti-editor/preview/tk/", scripts: true, dark: false, shim: "",
  });
  assert.ok(doc.indexOf("<base") > doc.indexOf("<head>"), "base 在 head 内");
  assert.ok(doc.indexOf("<base") < doc.indexOf("</head>"));
  const again = buildHtmlPreviewSrcdoc({
    content: '<html><head><base href="http://cdn/x/"></head><body></body></html>',
    base: "http://h/preview/tk/", scripts: true, dark: false, shim: "",
  });
  assert.equal((again.doc.match(/<base/g) || []).length, 1, "尊重作者自带 base");
  assert.ok(again.doc.includes("http://cdn/x/"));
});

test("buildHtmlPreviewSrcdoc：无 head/无 html 的片段也能补出 base", () => {
  const { doc } = buildHtmlPreviewSrcdoc({ content: "<p>x</p>", base: "http://h/p/tk/", scripts: true, dark: false, shim: "" });
  assert.ok(doc.startsWith("<head>"), doc.slice(0, 40));
  assert.ok(doc.includes('<base href="http://h/p/tk/">'));
  assert.ok(doc.includes("<p>x</p>"));
});

test("buildHtmlPreviewSrcdoc：base 里的引号被转义（srcdoc 属性拼接不越界）", () => {
  const { doc } = buildHtmlPreviewSrcdoc({ content: "<p></p>", base: 'http://h/p/tk/"><img src=x onerror=alert(1)>', scripts: true, dark: false, shim: "" });
  assert.equal(doc.includes('href="http://h/p/tk/%22'), true, doc);
  assert.equal(/<base[^>]*"><img/.test(doc), false, "不得提前闭合 base");
});

test("buildHtmlPreviewSrcdoc：shim 恒在末尾（剥了用户脚本仍要上报）", () => {
  const { doc } = buildHtmlPreviewSrcdoc({ content: "<body><script>bad()</script></body>", base: "", scripts: false, dark: false, shim: SHIM });
  assert.ok(doc.endsWith("<script>" + SHIM + "</script>"));
  assert.equal(doc.indexOf("bad()"), -1);
});

test("buildHtmlPreviewSrcdoc：只声明 color-scheme，不替页面画背景", () => {
  const dark = buildHtmlPreviewSrcdoc({ content: "<html><head></head></html>", base: "", scripts: true, dark: true, shim: "" });
  assert.ok(dark.doc.includes("color-scheme:dark"));
  assert.equal(dark.doc.includes("background:#0d1117"), false);
  const light = buildHtmlPreviewSrcdoc({ content: "<html><head></head></html>", base: "", scripts: true, dark: false, shim: "" });
  assert.ok(light.doc.includes("color-scheme:light"));
});

// ── 真预览态 URL ──

test("previewUrl：脚本关 → ?noscript=1；开 → 不带（服务端据此选 CSP 强度）", () => {
  const base = "http://h:3001/dev/api/extensions/aiti-editor/preview/tk/";
  assert.equal(previewUrl(base, "", { scripts: false }), base + "?noscript=1");
  assert.equal(previewUrl(base, "", { scripts: true }), base);
  assert.equal(previewUrl(base, "sub/page.html", { scripts: false }), base + "sub/page.html?noscript=1");
});

test("previewUrl：刷新计数 v 与 rel 的分段编码", () => {
  const base = "http://h/preview/tk/";
  assert.equal(previewUrl(base, "", { scripts: true, v: 3 }), base + "?v=3");
  assert.equal(previewUrl(base, "a b/c&d.html", { scripts: false, v: 7 }), base + "a%20b/c%26d.html?noscript=1&v=7");
  assert.equal(previewUrl(base, "x.html", { scripts: true, v: 0 }), base + "x.html?v=0", "v=0 也要带上（首刷）");
});

// ── 基址绝对化（srcdoc 的 <base> 与 shim 改道判定都要 origin）──

test("absBase：根相对补成 origin 限定；空与非法回空", () => {
  assert.equal(absBase("/dev/api/extensions/aiti-editor/preview/tk/", "https://pi.example.com:8443/some/page"),
    "https://pi.example.com:8443/dev/api/extensions/aiti-editor/preview/tk/");
  assert.equal(absBase("http://h/p/tk/", "http://other/x"), "http://h/p/tk/", "已绝对则原样（尾斜杠保留）");
  assert.equal(absBase("", "http://h/x"), "");
  assert.equal(absBase(undefined, "http://h/x"), "");
  assert.equal(absBase("http://h/p/tk/", "not a url"), "http://h/p/tk/", "已经是绝对地址时不依赖基准");
});

// ── 相对链接改道：shim 报的 rel → dock 可打开的路径 ──

test("resolvePreviewRel：目录内相对路径 → 绝对；子目录与 ./ 归一", () => {
  assert.equal(resolvePreviewRel("/work/site/index.html", "about.html"), "/work/site/about.html");
  assert.equal(resolvePreviewRel("/work/site/index.html", "./css/app.css"), "/work/site/css/app.css");
  assert.equal(resolvePreviewRel("/work/site/index.html", "sub/../b.html"), "/work/site/b.html");
  assert.equal(resolvePreviewRel("/work/site/index.html", "a%20b.html"), "/work/site/a%20b.html", "解码由 shim 做过，这里不重复");
});

test("resolvePreviewRel：越界/绝对/带协议 → 空（调用方忽略，不重复越权）", () => {
  assert.equal(resolvePreviewRel("/work/site/index.html", "../secret.txt"), "");
  assert.equal(resolvePreviewRel("/work/site/index.html", "a/../../b.txt"), "");
  assert.equal(resolvePreviewRel("/work/site/index.html", "/etc/passwd"), "");
  assert.equal(resolvePreviewRel("/work/site/index.html", "http://cdn/x.js"), "");
  assert.equal(resolvePreviewRel("/work/site/index.html", ""), "");
});

test("resolvePreviewRel：查询串与 hash 剥掉；分隔符随 filePath（Windows 形态）", () => {
  assert.equal(resolvePreviewRel("/work/site/index.html", "page.html?x=1#top"), "/work/site/page.html");
  assert.equal(resolvePreviewRel("C:\\work\\site\\index.html", "sub/a.html"), "C:\\work\\site\\sub\\a.html");
});

// ── 视口预设 ──

test("viewportWidthOf：预设 id → 宽度；未知 id 回退自适应", () => {
  assert.equal(viewportWidthOf("auto"), null);
  assert.equal(viewportWidthOf("768"), 768);
  assert.equal(viewportWidthOf("bogus"), null);
  assert.ok(VIEWPORT_PRESETS.length >= 3);
});

test("viewportStyle：自适应铺满；固定宽度 → 定宽居中画布 + 可滚外框", () => {
  const auto = viewportStyle(null, false);
  assert.equal(auto.frame.width, "100%");
  assert.equal(auto.wrap.padding, undefined);
  const fixed = viewportStyle(768, false);
  assert.equal(fixed.frame.width, "768px");
  assert.equal(fixed.frame.height, "100%");
  assert.equal(fixed.frame.margin, "0 auto");
  assert.equal(fixed.frame.background, "#fff", "定宽画布要看得见边界");
  assert.equal(fixed.wrap.overflow, "auto");
  assert.equal(fixed.wrap.position, "absolute");
  assert.notEqual(fixed.wrap.background, undefined, "留白底色随主题");
  assert.equal(viewportStyle(390, true).wrap.background, "#0d1117");
});
