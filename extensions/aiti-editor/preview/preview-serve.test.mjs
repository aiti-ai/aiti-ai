/**
 * preview-serve / preview-shim tests — HTML 预览服务态的纯逻辑（四道守卫 + CSP + shim 注入）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-editor/preview/preview-serve.test.mjs
 * （node 24 原生 TS strip-types，直接 import 邻近 .ts）
 *
 * 夹具一律 tmpdir()/join 构造平台真实路径：POSIX 哨兵路径（/work/…）在 Windows 会被
 * resolve() 成盘符形态，与 probe 集合永不对不上号（docs/windows-compat-lessons.md §4）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  PREVIEW_ALLOWED_EXT,
  previewExtOf,
  previewMimeOf,
  isPreviewDoc,
  resolvePreviewTarget,
  previewRelOrEntry,
  previewCsp,
  injectPreviewShim,
  servePreviewDoc,
  previewBaseFromSegments,
  PREVIEW_DOC_MAX_BYTES,
} = await import("./preview-serve.ts");

const { buildPreviewShim, PREVIEW_MSG } = await import("./preview-shim.ts");

// ── 夹具：平台真实路径（不落盘，只作 probe 的字符串键；resolve/relative/basename 产物同源可对）──
const WORK = join(tmpdir(), "aiti-preview-work");
const SITE = join(WORK, "site");                    // rootDir = 入口文档所在目录
const ENTRY = join(SITE, "index.html");
const SECRET = join(WORK, "secret.css");            // ../secret.css → 站外
const PASSWD = join(tmpdir(), "etc", "passwd.css"); // ../../etc/passwd.css → 站外
const IN = (...segs) => join(SITE, ...segs);        // 站内路径构造
const ok = (r) => r.ok === true;

/** 文件系统桩：files 存在，dirs 是目录，links 把路径映射到「软链真身」（缺省恒等）。 */
function probe({ files = [], dirs = [], links = {} } = {}) {
  const fset = new Set(files), dset = new Set(dirs);
  return {
    isFile: (p) => fset.has(p),
    realpath: (p) => {
      if (links[p]) return links[p];
      if (fset.has(p) || dset.has(p)) return p;
      throw new Error("ENOENT: " + p);
    },
  };
}

// ── 扩展名 / MIME ──

test("previewExtOf：末点之后小写；无扩展名与点文件返回空", () => {
  assert.equal(previewExtOf("/a/b/Report.HTML"), "html");
  assert.equal(previewExtOf("/a/b/app.min.css"), "css");
  assert.equal(previewExtOf("/a/b/Makefile"), "");
  assert.equal(previewExtOf("/a/b/.env"), "");
  assert.equal(previewExtOf("secret.env"), "env");
  // 反斜杠形态（Windows resolve 产物）：目录名带点、文件无扩展名 → 空，不得误判成 "2\makefile"
  assert.equal(previewExtOf("D:\\proj\\v1.2\\Makefile"), "");
  assert.equal(previewExtOf("D:\\proj\\v1.2\\Page.HTML"), "html");
});

test("previewMimeOf：白名单命中类型，未知回落 octet-stream（绝不猜成 html）", () => {
  assert.match(previewMimeOf("html"), /^text\/html/);
  assert.match(previewMimeOf("svg"), /^image\/svg\+xml$/);
  assert.equal(previewMimeOf("php"), "application/octet-stream");
  assert.equal(previewMimeOf(""), "application/octet-stream");
});

test("isPreviewDoc：只有 html/htm 需要 CSP sandbox + shim 注入", () => {
  assert.equal(isPreviewDoc("html"), true);
  assert.equal(isPreviewDoc("htm"), true);
  assert.equal(isPreviewDoc("svg"), false); // svg 可内嵌脚本，但按子资源服务（不注入、不解析）
  assert.equal(isPreviewDoc("css"), false);
});

test("白名单里没有凭据/脚本/配置类扩展（默认拒绝是设计，不是遗漏）", () => {
  for (const e of ["env", "pem", "key", "sh", "py", "php", "exe", "ini", "sqlite", "git"]) {
    assert.equal(PREVIEW_ALLOWED_EXT.has(e), false, "." + e + " 不得可服务");
  }
  for (const e of ["html", "htm", "css", "js", "json", "svg", "png", "woff2", "mp4", "pdf"]) {
    assert.equal(PREVIEW_ALLOWED_EXT.has(e), true, "." + e + " 应可服务");
  }
});

// ── 守卫①：语法级拒绝（先于任何文件系统访问）──

test("resolvePreviewTarget：空 rel / 空段 / 反斜杠 / 带协议 → 400", () => {
  const p = probe({ files: [ENTRY], dirs: [SITE] });
  for (const [rel, why] of [["", "缺"], ["css//app.css", "空段"], ["css\\app.css", "反斜杠"],
    ["http://cdn/x.js", "带协议"], ["https://a/b.css", "带协议"], ["javascript:alert(1).css", "伪协议"]]) {
    const r = resolvePreviewTarget(ENTRY, rel, p);
    assert.equal(r.ok, false, why + " → " + JSON.stringify(rel));
    assert.equal(r.status, 400, why + " 应 400：" + rel);
  }
});

test("resolvePreviewTarget：Windows 盘符形态拒绝", () => {
  const r = resolvePreviewTarget(ENTRY, "c:/windows/win.ini", probe({}));
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test("resolvePreviewTarget：非法百分号编码不炸路由（400 而非 throw）", () => {
  const r = resolvePreviewTarget(ENTRY, "css/%zz%zz.css", probe({}));
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /解码/);
  assert.throws(() => decodeURIComponent("%zz")); // 前提：确实会让裸解码抛
});

test("resolvePreviewTarget：首段根斜杠按预览目录内相对路径处理（不是 400，也不是跳到站点根）", () => {
  const target = IN("css", "app.css");
  const p = probe({ files: [target], dirs: [SITE] });
  const r = resolvePreviewTarget(ENTRY, "/css/app.css", p);
  assert.ok(ok(r), JSON.stringify(r));
  assert.equal(r.target, target);
});

test("previewRelOrEntry：目录根 = 票据入口文档（客户端 previewUrl(base, \"\") 拼出的就是它）", () => {
  const p = probe({ files: [ENTRY], dirs: [SITE] });
  for (const rel of ["", "/", "./", "."]) {
    const r = resolvePreviewTarget(ENTRY, previewRelOrEntry(ENTRY, rel), p);
    assert.ok(ok(r), JSON.stringify(rel) + " → " + JSON.stringify(r));
    assert.ok(r.target.endsWith(ENTRY), "补成入口文件本身");
  }
  // 普通相对路径原样透传
  assert.equal(previewRelOrEntry(ENTRY, "css/app.css"), "css/app.css");
  assert.equal(previewRelOrEntry(ENTRY, "/sub/page2.html"), "sub/page2.html");
});

test("previewRelOrEntry：入口文件名带 % 也能往返（encodeURIComponent 后过同一道解码，不再 400）", () => {
  const entry = IN("100%.html");
  const p = probe({ files: [entry], dirs: [SITE] });
  const r = resolvePreviewTarget(entry, previewRelOrEntry(entry, ""), p);
  assert.ok(ok(r), JSON.stringify(r));
  assert.equal(r.target, entry);
  // 兄弟资源同理：浏览器发 100%25.css，解码后带字面 % 的路径必须可达（曾被判 "URI malformed" → 400）
  const css = IN("100%.css");
  const r2 = resolvePreviewTarget(entry, "100%25.css", probe({ files: [css], dirs: [SITE] }));
  assert.ok(ok(r2), JSON.stringify(r2));
  assert.equal(r2.target, css);
});

test("previewRelOrEntry：不做二次解码（编码形态的 .. 仍由守卫按原样挡住 → 403）", () => {
  const p = probe({ files: [SECRET, ENTRY], dirs: [SITE] });
  const r = resolvePreviewTarget(ENTRY, previewRelOrEntry(ENTRY, "%2e%2e/secret.css"), p);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403, "解码只发生一次：%2e%2e 解成 .. 后照样越界");
});

// ── 守卫②：目录越界 ──

test("resolvePreviewTarget：.. 跳出入口目录 → 403", () => {
  const p = probe({ files: [ENTRY, SECRET, PASSWD], dirs: [SITE] });
  for (const rel of ["../secret.css", "../../etc/passwd.css", "css/../../secret.css", "."]) {
    const r = resolvePreviewTarget(ENTRY, rel, p);
    assert.equal(r.ok, false, rel);
    assert.equal(r.status, 403, rel + " 应越界 403");
  }
});

test("resolvePreviewTarget：编码绕过（%2e%2e%2f）同样被目录包含性挡住", () => {
  const p = probe({ files: [join(WORK, "private.key.css")], dirs: [SITE] });
  const r = resolvePreviewTarget(ENTRY, "%2e%2e%2fprivate.key.css", p);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("resolvePreviewTarget：目录内的规范化（css/../css/app.css）放行", () => {
  const target = IN("css", "app.css");
  const p = probe({ files: [target], dirs: [SITE] });
  assert.ok(ok(resolvePreviewTarget(ENTRY, "css/../css/app.css", p)));
});

// ── 守卫③：扩展名白名单 ──

test("resolvePreviewTarget：越界之外的第二道闸——.env/.pem/.git 读不走", () => {
  const files = [IN(".env"), IN("id.pem"), IN(".git", "config"), IN("Makefile")];
  const p = probe({ files, dirs: [SITE] });
  for (const rel of [".env", "id.pem", ".git/config", "Makefile"]) {
    const r = resolvePreviewTarget(ENTRY, rel, p);
    assert.equal(r.ok, false, rel);
    assert.equal(r.status, 403, rel + " 应白名单 403");
    assert.match(r.error, /预览不接受/);
  }
});

test("resolvePreviewTarget：白名单内但文件不存在 → 404（不泄露目录结构以外的信息）", () => {
  const p = probe({ files: [ENTRY], dirs: [SITE] });
  const r = resolvePreviewTarget(ENTRY, "css/missing.css", p);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

// ── 守卫④：软链逃逸 ──

test("resolvePreviewTarget：软链指向目录外 → 403；指向目录内 → 放行且解析到真身", () => {
  const out = IN("out.css");
  const escape = probe({
    files: [ENTRY, out],
    dirs: [SITE],
    links: { [out]: PASSWD },
  });
  const r1 = resolvePreviewTarget(ENTRY, "out.css", escape);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 403);
  assert.match(r1.error, /软链/);

  const vendor = IN("vendor", "lib.css");
  const libReal = IN("libs", "lib.css");
  const inside = probe({
    files: [ENTRY, vendor],
    dirs: [SITE],
    links: { [vendor]: libReal },
  });
  const r2 = resolvePreviewTarget(ENTRY, "vendor/lib.css", inside);
  assert.ok(ok(r2), JSON.stringify(r2));
  assert.ok(r2.target.endsWith(join("libs", "lib.css")), "返回真实路径：" + r2.target);
});

test("resolvePreviewTarget：真身读不到（realpath 抛）→ 404 不是 500", () => {
  const p = probe({ files: [IN("broken.css")], dirs: [] }); // 目录 realpath 也抛
  const r = resolvePreviewTarget(ENTRY, "broken.css", p);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test("resolvePreviewTarget：兄弟资源正常解析（子目录 + 扩展名 + MIME）", () => {
  const target = IN("assets", "img", "logo.png");
  const p = probe({ files: [target], dirs: [SITE] });
  const r = resolvePreviewTarget(ENTRY, "assets/img/logo.png", p);
  assert.ok(ok(r), JSON.stringify(r));
  assert.equal(r.ext, "png");
  assert.equal(previewMimeOf(r.ext), "image/png");
});

// ── CSP 两态 ──

test("previewCsp：两态都不给 allow-same-origin（opaque origin 是边界本体）", () => {
  const on = previewCsp(true);
  assert.match(on, /^sandbox/);
  assert.match(on, /allow-scripts/);
  assert.equal(on.includes("allow-same-origin"), false);
  assert.equal(on.includes("allow-top-navigation"), false);
  assert.equal(previewCsp(false), "sandbox");
});

// ── shim 注入 ──

test("injectPreviewShim：优先 </body> 前，其次 </html> 前，都没有则追加", () => {
  const opts = { base: "/api/extensions/aiti-editor/preview/tk/", docRel: "" };
  const withBody = "<html><body><p>hi</p></body></html>";
  let out = injectPreviewShim(withBody, opts);
  assert.ok(out.indexOf("<script>") < out.indexOf("</body>"), "注入在 </body> 前");
  assert.ok(out.endsWith("</html>"));

  out = injectPreviewShim("<html><BODY><p>x</p></BODY></HTML>", opts); // 大写标签
  assert.equal((out.match(/<script>/g) || []).length, 1);
  assert.ok(out.indexOf("<script>") < out.toLowerCase().indexOf("</body>"));

  out = injectPreviewShim("<html><p>no body</p></html>", opts);
  assert.ok(out.indexOf("<script>") < out.indexOf("</html>"), "退化到 </html> 前");

  out = injectPreviewShim("<p>fragment</p>", opts);
  assert.ok(out.endsWith("<\/script>"), "片段追加到末尾");
});

test("injectPreviewShim：超过 maxBytes 原样返回（整读注入的代价闸门）", () => {
  const html = "<body>" + "x".repeat(5000) + "</body>";
  const out = injectPreviewShim(html, { base: "/b/", docRel: "", maxBytes: 100 });
  assert.equal(out, html);
  assert.equal(injectPreviewShim(html, { base: "/b/", docRel: "" }).includes("<script>"), true,
    "不传 maxBytes 走默认上限（2MB 文档本例远未触及）");
  assert.equal(PREVIEW_DOC_MAX_BYTES, 2 * 1024 * 1024);
});

test("injectPreviewShim：空/undefined 文档不炸", () => {
  const out = injectPreviewShim("", { base: "/b/", docRel: "" });
  assert.ok(out.includes("<script>"));
  assert.equal(typeof injectPreviewShim(undefined, { base: "/b/", docRel: "" }), "string");
});

// ── 服务态装配（脚本开关 + 注入一次做完）──

test("servePreviewDoc：脚本关=剥作者脚本，自己的 shim 仍在（观测通道不被开关掐掉）", () => {
  const html = '<html><body><p>hi</p><script>alert(1)</script><img onerror="x()" src="a.png"></body></html>';
  const r = servePreviewDoc(html, { base: "/p/tk/", docRel: "", scripts: false });
  assert.equal(r.injected, true);
  assert.equal(r.body.includes("alert(1)"), false);
  assert.equal(r.body.includes("onerror"), false);
  assert.ok(r.body.includes("parent.postMessage"), "shim 注入在剥离之后，不受影响");
  assert.ok(r.stripped >= 2);
});

test("servePreviewDoc：脚本开=作者脚本原样保留（只追加 shim）", () => {
  const html = "<html><body><script>var keep=1</script></body></html>";
  const r = servePreviewDoc(html, { base: "/p/tk/", docRel: "", scripts: true });
  assert.ok(r.body.includes("var keep=1"));
  assert.equal(r.stripped, 0);
  assert.equal((r.body.match(/<script>/g) || []).length, 2, "作者 1 + shim 1");
});

test("servePreviewDoc：超体积原样返回 injected=false（路由据此退化为裸 sandbox）", () => {
  const html = "<body>" + "x".repeat(5000) + "</body>";
  const r = servePreviewDoc(html, { base: "/p/tk/", docRel: "", scripts: false, maxBytes: 100 });
  assert.equal(r.injected, false);
  assert.equal(r.body, html);
  assert.equal(r.stripped, 0);
});

test("servePreviewDoc：undefined 文档不炸（空串照样注入）", () => {
  const r = servePreviewDoc(undefined, { base: "/p/tk/", docRel: "", scripts: false });
  assert.equal(r.injected, true);
  assert.ok(r.body.includes("parent.postMessage"));
});

// ── shim 源码本身（两端共用：服务态注入 + 快速态 srcdoc）──

test("buildPreviewShim：生成码可嵌进模板串与 <script>（无反引号/${、无提前闭合）", () => {
  const src = buildPreviewShim({ base: "/p/tk/", docRel: "sub/a.html" });
  assert.equal(src.includes("`"), false);
  assert.equal(src.includes("${"), false);
  assert.equal(src.toLowerCase().includes("</script>"), false);
  assert.ok(src.includes("parent.postMessage"));
});

test("buildPreviewShim：base/docRel 走 JSON 字面量（引号注入不成代码）", () => {
  const evil = `");alert(1);//`;
  const src = buildPreviewShim({ base: evil, docRel: evil });
  assert.ok(src.includes(JSON.stringify(evil)), "以字符串字面量形态出现");
  assert.equal(src.includes(");alert(1);//\nvar DOC_REL"), false);
});

test("buildPreviewShim：消息 type 与 PREVIEW_MSG 一致（父页监听同一常量）", () => {
  const src = buildPreviewShim({ base: "/p/tk/", docRel: "" });
  for (const t of Object.values(PREVIEW_MSG)) assert.ok(src.includes(t), "缺 " + t);
  assert.equal(PREVIEW_MSG.ready, "aiti-editor-html-ready");
  assert.equal(PREVIEW_MSG.open, "aiti-editor-html-open");
});

// ── shim 行为（真跑生成码：node:vm + DOM 桩；正则比对钉不住协议）──

const ORIGIN = "http://127.0.0.1:3001";
const PREVIEW_BASE = ORIGIN + "/dev/api/extensions/aiti-editor/preview/tk/";

/** 在 vm 里执行生成码，返回消息收集器与事件触发器。 */
function runShim(opts, env = {}) {
  const msgs = [];
  const listeners = { window: {}, document: {} };
  const originals = { error: 0, warn: 0, log: 0 };
  const consoleStub = {
    log: () => { originals.log++; },
    info: () => {},
    error: () => { originals.error++; },
    warn: () => { originals.warn++; },
  };
  const sandbox = {
    URL,
    parent: { postMessage: (m) => msgs.push(m) },
    console: consoleStub,
    location: { href: env.locationHref || (ORIGIN + "/dev/app/page") },
    document: {
      readyState: env.readyState || "complete",
      title: env.title === undefined ? "示例页" : env.title,
      baseURI: env.baseURI === undefined ? PREVIEW_BASE + "index.html" : env.baseURI,
      addEventListener: (t, fn) => { (listeners.document[t] = listeners.document[t] || []).push(fn); },
    },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (t, fn) => { (listeners.window[t] = listeners.window[t] || []).push(fn); };
  vm.createContext(sandbox);
  vm.runInContext(buildPreviewShim(opts), sandbox);
  const fire = (where, type, ev) => {
    const fns = listeners[where][type];
    assert.ok(fns && fns.length, "shim 未注册 " + where + " " + type + " 监听");
    fns.forEach((fn) => fn(ev));
  };
  const anchor = (rawHref, absHref) => ({
    attrs: {},
    getAttribute: (k) => (k === "href" ? rawHref : null),
    href: absHref === undefined ? rawHref : absHref,
    setAttribute(k, v) { this.attrs[k] = v; },
  });
  const click = (a) => {
    let prevented = false;
    fire("document", "click", {
      target: { closest: (sel) => (sel === "a[href]" ? a : null) },
      preventDefault: () => { prevented = true; },
    });
    return prevented;
  };
  const of = (type) => msgs.filter((m) => m.type === type);
  return { msgs, of, fire, anchor, click, consoleStub, originals };
}

/** 除装载 ready 外的全部上报（「什么都不发」类断言用）。 */
const nonReady = (h) => h.msgs.filter((m) => m.type !== PREVIEW_MSG.ready);

test("shim：装载完成上报 ready（带文档标题，供父页面包屑）", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  assert.equal(h.of(PREVIEW_MSG.ready).length, 1);
  assert.equal(h.of(PREVIEW_MSG.ready)[0].title, "示例页");
  assert.equal(h.of(PREVIEW_MSG.ready)[0].docRel, "");
});

test("shim：readyState 未就绪时挂 DOMContentLoaded，不提前上报", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" }, { readyState: "loading" });
  assert.equal(h.of(PREVIEW_MSG.ready).length, 0);
  h.fire("document", "DOMContentLoaded", {});
  assert.equal(h.of(PREVIEW_MSG.ready).length, 1);
});

test("shim：JS 异常回传（消息 + 文件:行:列）", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  h.fire("window", "error", {
    message: "Cannot read properties of undefined", filename: PREVIEW_BASE + "app.js", lineno: 12, colno: 3,
  });
  const r = h.of(PREVIEW_MSG.report)[0];
  assert.equal(r.kind, "error");
  assert.equal(r.level, "error");
  assert.match(r.text, /Cannot read properties/);
  assert.match(r.text, /\(app\.js:12:3\)/);
});

test("shim：子资源加载失败回传（capture 阶段才收得到 img/link 的 error）", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  h.fire("window", "error", { target: { tagName: "IMG", src: PREVIEW_BASE + "img/miss.png" } });
  assert.match(h.of(PREVIEW_MSG.report)[0].text, /^资源加载失败 <img> miss\.png$/);
});

test("shim：unhandledrejection 回传（对象 reason 走 safe 序列化，不出现 [object Object]）", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  h.fire("window", "unhandledrejection", { reason: { code: "boom" } });
  assert.match(h.of(PREVIEW_MSG.report)[0].text, /Promise 未捕获: \{"code":"boom"\}/);
});

test("shim：console.error/warn 转发且原函数照调；console.log 不点徽标", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  h.consoleStub.error("接口 %s 挂了", 500);
  h.consoleStub.warn({ a: 1 });
  h.consoleStub.log("闲聊");
  const reps = h.of(PREVIEW_MSG.report);
  assert.equal(reps.length, 2);
  assert.deepEqual(reps.map((m) => m.level), ["error", "warn"]);
  assert.equal(reps[0].kind, "console");
  assert.match(reps[0].text, /接口 %s 挂了 500/);
  assert.deepEqual(h.originals, { error: 1, warn: 1, log: 1 }, "原 console 未被吃掉");
});

test("shim：预览命名空间内的链接 → 阻止导航并上报 rel（解码 + 去 query/hash）", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "index.html" });
  const a = h.anchor("other.html", PREVIEW_BASE + "pages/other.html");
  assert.equal(h.click(a), true, "站内链接必须 preventDefault");
  const open = h.of(PREVIEW_MSG.open)[0];
  assert.equal(open.rel, "pages/other.html");
  assert.equal(open.docRel, "index.html");

  const q = h.anchor("a.html?x=1#y", PREVIEW_BASE + "a.html?x=1#y");
  h.click(q);
  assert.equal(h.of(PREVIEW_MSG.open)[1].rel, "a.html", "query/hash 不进 rel");

  const sp = h.anchor("my%20file.html", PREVIEW_BASE + "my%20file.html");
  h.click(sp);
  assert.equal(h.of(PREVIEW_MSG.open)[2].rel, "my file.html", "rel 解码后给 dock");
});

test("shim：根相对 BASE 运行时补成绝对（否则前缀比较永不相等 = 改道静默失效）", () => {
  const h = runShim({ base: "/dev/api/extensions/aiti-editor/preview/tk/", docRel: "" });
  const a = h.anchor("b.html", PREVIEW_BASE + "b.html");
  assert.equal(h.click(a), true);
  assert.equal(h.of(PREVIEW_MSG.open)[0].rel, "b.html");
});

test("shim：srcdoc 态（自身 URL about:srcdoc + 绝对 base）仍能改道", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" }, { baseURI: PREVIEW_BASE, locationHref: "about:srcdoc" });
  assert.equal(h.click(h.anchor("c.css", PREVIEW_BASE + "c.css")), true);
});

test("shim：站外链接不改道，交新标签并带 noopener noreferrer", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  const a = h.anchor("https://example.com/x.css");
  assert.equal(h.click(a), false);
  assert.deepEqual(a.attrs, { target: "_blank", rel: "noopener noreferrer" });
  assert.equal(h.of(PREVIEW_MSG.open).length, 0);
});

test("shim：异源同路径不误判为站内（改道判定含 origin）", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  const a = h.anchor("evil", "http://evil.example" + "/dev/api/extensions/aiti-editor/preview/tk/a.html");
  assert.equal(h.click(a), false);
  assert.equal(a.attrs.target, "_blank");
});

test("shim：页内锚点与 mailto 完全放行（ preventDefault 会把 TOC 点死）", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  assert.equal(h.click(h.anchor("#sec-1", PREVIEW_BASE + "index.html#sec-1")), false);
  assert.equal(h.click(h.anchor("mailto:a@b.c", "mailto:a@b.c")), false);
  assert.equal(nonReady(h).length, 0, "锚点/mailto 不产生任何上报（ready 除外）");
});

test("shim：非链接点击与无 href 元素不报错", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  h.fire("document", "click", { target: {}, preventDefault() {} });
  h.fire("document", "click", { target: { closest: () => null }, preventDefault() {} });
  assert.equal(nonReady(h).length, 0);
});

test("shim：表单提交被阻止并提示（预览无同源能力）", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  let prevented = false;
  h.fire("document", "submit", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  const n = h.of(PREVIEW_MSG.report)[0];
  assert.equal(n.kind, "notice");
  assert.match(n.text, /表单提交已阻止/);
});

test("shim：消息上限 60 条（坏页面死循环 console.error 不冲垮父页）", () => {
  const h = runShim({ base: PREVIEW_BASE, docRel: "" });
  for (let i = 0; i < 200; i++) h.consoleStub.error("x" + i);
  assert.equal(h.msgs.length, 60);
});

// ── 路由基址 ──

test("previewBaseFromSegments：截到 ticket 为止并补尾斜杠（<base> 与 rel 截取同一口径）", () => {
  const segs = ["api", "extensions", "aiti-editor", "preview", "tk9", "assets", "a.css"];
  assert.equal(previewBaseFromSegments(segs, 4), "/api/extensions/aiti-editor/preview/tk9/");
  assert.equal(previewBaseFromSegments(["preview", "tk"], 1), "/preview/tk/");
});
