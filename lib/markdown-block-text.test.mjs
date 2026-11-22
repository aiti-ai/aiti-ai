import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { blockPlainText } = await jiti.import("./markdown-block-text.ts");

const t = (v) => ({ nodeType: 3, nodeValue: v, childNodes: [] });
const el = (tagName, ...kids) => ({ nodeType: 1, tagName, childNodes: kids });

test("inline elements stay on one line", () => {
  const p = el("P", t("Run "), el("CODE", t("npm test")), t(" now"));
  assert.equal(blockPlainText(p), "Run npm test now");
});

test("a list item keeps its nested items, one per line", () => {
  const li = el(
    "LI",
    t("Cross-platform check"),
    el("UL", el("LI", t("Windows WebView2")), el("LI", t("macOS WKWebView"))),
  );
  assert.equal(blockPlainText(li), "Cross-platform check\nWindows WebView2\nmacOS WKWebView");
});

test("blocks keep one line each and <br> ends a line", () => {
  const li = el("LI", t("Title"), el("P", t("First."), el("BR"), t("Second.")), el("P", t("Third.")));
  assert.equal(blockPlainText(li), "Title\nFirst.\nSecond.\nThird.");
});

test("code indentation and inner blank lines survive", () => {
  const li = el("LI", t("Run:"), el("PRE", el("CODE", t("if (a) {\n    b();\n\n    c();\n}"))));
  assert.equal(blockPlainText(li), "Run:\nif (a) {\n    b();\n\n    c();\n}");
});

test("trailing whitespace is trimmed, leading blank lines dropped", () => {
  const p = el("P", t("   "), t("value   "), t("   "));
  assert.equal(blockPlainText(p), "   value"); // leading indent kept on purpose (code lines)
});
