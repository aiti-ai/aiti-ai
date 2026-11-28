/**
 * Markdown preview in-document update runtime — runs the REAL generated script under
 * node:vm + mini-dom (no source matching): initial render, block diff, no-op, chg classes,
 * TOC rebuild, fence pass, scroll anchoring.
 *
 * Plan: docs/aiti-editor-silent-preview-refresh-plan.md §3.2
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-editor/client/src/preview-apply.test.mjs
 */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";

const { markdownPreviewHtml } = await import("./markdown.ts");
const { makeDoc, makeEl } = await import("./mini-dom.mjs");

/** Fake marked: blank-line separated blocks; `# heading` becomes <h2> so the TOC path is exercised. */
const markedStub = {
  parse(raw) {
    return String(raw).split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
      .map((b) => (/^#\s+/.test(b) ? "<h2>" + b.replace(/^#\s+/, "") + "</h2>" : "<p>" + b + "</p>"))
      .join("");
  },
  lexer(raw) {
    const blocks = String(raw).split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    return blocks.map((b, i) => ({
      type: /^#\s+/.test(b) ? "heading" : "paragraph",
      raw: b + (i < blocks.length - 1 ? "\n\n" : "\n"),
    }));
  },
};

function extractScript(html) {
  const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  assert.ok(m, "generated inline script not found");
  return m[1];
}

/** Build the runtime: real generated script + mini-dom document/window. */
function boot(content) {
  const win = {
    innerHeight: 800,
    parent: { postMessage() {} },
    scrollTo(x, y) { win.scrolledTo = y; },
    addEventListener() {},
    getSelection: () => null,
  };
  const doc = makeDoc(win);
  win.document = doc;
  const contentEl = makeEl("div", doc);
  contentEl.id = "content";
  const tocEl = makeEl("div", doc);
  tocEl.id = "tocHost";
  doc.body.appendChild(contentEl);
  doc.body.appendChild(tocEl);
  doc.documentElement.scrollTop = 0;
  doc.documentElement.scrollHeight = 2000;

  const fencePasses = [];
  doc.__aitiFence = { pass: () => fencePasses.push(contentEl.children.length) };

  const script = extractScript(markdownPreviewHtml(content, false, undefined, true, undefined));
  runInNewContext(script, { document: doc, window: win, marked: markedStub, setTimeout: (fn) => { /* noop */ } });
  return { win, doc, content: contentEl, toc: tocEl, fencePasses, api: doc.__aitiMd };
}

const RAW = "# 标题一\n\n第一段\n\n第二段\n\n第三段";

test("initial apply renders all blocks and annotates source lines", () => {
  const { content, api, fencePasses } = boot(RAW);
  assert.equal(content.children.length, 4); // h2 + 3 paragraphs
  assert.equal(api.blockCount(), 4);
  assert.equal(content.children[0].getAttribute("data-src-start"), "1");
  assert.equal(content.children[1].getAttribute("data-aiti-blk"), "1");
  assert.deepEqual(fencePasses, [4], "fence pass runs once for the initial render");
});

test("append-only update keeps existing block nodes (no rebuild, no flash)", () => {
  const { content, api } = boot(RAW);
  const before = content.children.slice();
  const r = api.apply(RAW + "\n\n新增段落", []);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.prefix, 4, "every old block is a common prefix");
  assert.equal(r.added, 1);
  assert.equal(r.removed, 0);
  assert.equal(content.children.length, 5);
  for (let i = 0; i < before.length; i++) {
    assert.equal(content.children[i], before[i], `block ${i} must keep its DOM node`);
  }
  assert.equal(content.children[4].getAttribute("data-src-start"), "9");
});

test("middle edit replaces only the changed block", () => {
  const { content, api } = boot(RAW);
  const [h, p1, p2, p3] = content.children.slice();
  api.apply("# 标题一\n\n第一段\n\n第二段（改过）\n\n第三段", []);
  assert.equal(content.children.length, 4);
  assert.equal(content.children[0], h);
  assert.equal(content.children[1], p1);
  assert.notEqual(content.children[2], p2);
  assert.equal(content.children[3], p3);
});

test("identical content is a no-op (meta-only frames cost nothing)", () => {
  const { content, api } = boot(RAW);
  const before = content.children.slice();
  const r = api.apply(RAW, []);
  assert.equal(r.changed, false);
  assert.equal(content.children.length, 4);
  assert.equal(content.children[0], before[0]);
});

test("git change ranges are applied and cleared without touching block identity", () => {
  const { content, api } = boot(RAW);
  const target = content.children[1];
  api.apply(RAW, [{ start: 3, end: 3 }]);
  assert.ok(target.classList.contains("md-chg"), "line 3 falls inside the first paragraph");
  assert.equal(content.children[0].classList.contains("md-chg"), false, "heading (lines 1-2) untouched");
  api.apply(RAW, []);
  assert.equal(target.classList.contains("md-chg"), false);
  assert.equal(content.children[1], target, "chg-only update must not rebuild blocks");
});

test("TOC is rebuilt when headings change", () => {
  const { toc, api } = boot(RAW);
  api.apply("# 新标题\n\n正文", []);
  assert.match(toc.innerHTML, /新标题/);
  assert.doesNotMatch(toc.innerHTML, /标题一/);
});

test("reading position is restored by source line after a mid-document edit", () => {
  const { doc, content, win, api } = boot(RAW);
  // Simulate: block #2 sits 400px down, the user is scrolled 300px with that block at viewport top.
  content.children[1].offsetTop = 400;
  content.children[1].offsetHeight = 100;
  doc.documentElement.scrollTop = 300;
  win.scrolledTo = null;
  // Edit ABOVE the reading position: the anchored block keeps its node, so the offset check
  // verifies the source-line mapping rather than the stub's missing layout engine.
  api.apply("# 标题一（改）\n\n第一段\n\n第二段\n\n第三段", []);
  assert.equal(win.scrolledTo, 300, "scroll offset of the anchored source line is preserved");
});

test("empty document renders as an empty content root without throwing", () => {
  const { content, api } = boot("");
  assert.equal(content.children.length, 0);
  const r = api.apply("第一段", []);
  assert.equal(r.changed, true);
  assert.equal(content.children.length, 1);
  assert.equal(content.children[0].getAttribute("data-src-start"), "1");
});

test("snapshot exposes scroll state for the manual full-reload path", () => {
  const { content, api, doc } = boot(RAW);
  content.children[0].offsetTop = 0;
  content.children[0].offsetHeight = 120;
  doc.documentElement.scrollTop = 500;
  const snap = api.snapshot();
  assert.equal(snap.scrollTop, 500);
  assert.equal(snap.line, 1);
  assert.equal(snap.offset, 0);
});
