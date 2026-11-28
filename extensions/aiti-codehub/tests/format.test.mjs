import test from "node:test";
import assert from "node:assert/strict";
import { compactTableRows, flattenRichContent, formatBranchName, formatWorkItemText, htmlToText, isTrivialHtml, jsonmlToText, looksLikeMarkdown, normalizeRichContent, replaceTemplate, sanitizeBranchName, templateVars } from "../server/format.ts";

const item = {
  id: "1",
  key: "CEXP-1",
  number: 1,
  title: "登录失败 500",
  type: "Bug",
  status: "进行中",
  state: "open",
  assignee: "alice",
  creator: "bob",
  priority: "2",
  tags: ["p0", "login"],
  description: "用户登录时报错",
  webUrl: "https://devops.example/1",
  scope: { kind: "project", id: "p1", label: "项目一" },
};

test("sanitizeBranchName: git-safe, 50 chars, no empty", () => {
  assert.equal(sanitizeBranchName("feat/登录: 页面*测试"), "feat_登录_页面_测试");
  assert.equal(sanitizeBranchName("a  b..c@{d}"), "a_b_c_d}");
  assert.equal(sanitizeBranchName(""), "work");
  assert.ok(sanitizeBranchName("x".repeat(80)).length <= 50);
  assert.equal(sanitizeBranchName("---"), "work");
});

test("replaceTemplate + templateVars", () => {
  const vars = templateVars(item, "yunxiao");
  assert.equal(vars.id, "CEXP-1");
  assert.equal(vars.type, "Bug");
  assert.equal(vars.labels, "p0, login");
  assert.equal(replaceTemplate("#{id} {type} {title}", vars), "#CEXP-1 Bug 登录失败 500");
  assert.equal(replaceTemplate("{missing}", vars), "");
});

test("formatWorkItemText collapses blank lines", () => {
  const text = formatWorkItemText(item, "yunxiao", "#{id} {type} {title}\n\n\n{description}");
  assert.equal(text, "#CEXP-1 Bug 登录失败 500\n\n用户登录时报错");
});

test("formatBranchName sanitizes every variable", () => {
  assert.equal(formatBranchName({ ...item, type: "Bug Fix" }, "yunxiao", "{type}_{id}"), "Bug_Fix_CEXP-1");
  assert.equal(formatBranchName(item, "yunxiao", "{id}_{title}"), "CEXP-1_登录失败_500");
});

test("jsonmlToText: paragraphs, lists, links, images", () => {
  const r = jsonmlToText(["root", {}, ["p", {}, "hello"], ["p", { list: { level: 1, listStyle: { text: "-" } } }, "item"], ["a", { href: "https://x" }, "link"], ["img", { src: "https://x/y.png" }]]);
  assert.match(r.text, /hello/);
  assert.match(r.text, /  - item/);
  assert.match(r.text, /link \(https:\/\/x\)/);
  assert.deepEqual(r.images, ["https://x/y.png"]);
});

test("htmlToText extracts images and strips tags", () => {
  const r = htmlToText('<p>a &amp; b</p><ul><li>x</li></ul><img src="https://x/i.png">');
  assert.equal(r.text, "a & b\n  • x");
  assert.deepEqual(r.images, ["https://x/i.png"]);
});

test("flattenRichContent handles markdown / parsed objects / JSON strings", () => {
  assert.deepEqual(flattenRichContent("plain **md**"), { text: "plain **md**", images: [] });
  assert.deepEqual(flattenRichContent({ htmlValue: "<p>hi</p>" }), { text: "hi", images: [] });
  const parsed = flattenRichContent(JSON.stringify({ jsonMLValue: ["root", {}, ["p", {}, "x"]] }));
  assert.equal(parsed.text, "x");
  assert.deepEqual(flattenRichContent(null), { text: "", images: [] });
});

test("looksLikeMarkdown: structural Markdown vs prose", () => {
  assert.equal(looksLikeMarkdown("# Title\n\n- a\n- b"), true);
  assert.equal(looksLikeMarkdown("```js\nconst a = 1;\n```"), true);
  assert.equal(looksLikeMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |"), true);
  assert.equal(looksLikeMarkdown("普通一段话，带一个 - 破折号。"), false);
  assert.equal(looksLikeMarkdown("一行 **加粗** 文本"), false);
  assert.equal(looksLikeMarkdown(""), false);
});

test("normalizeRichContent: explicit MARKDOWN wins", () => {
  const n = normalizeRichContent("## 标题\n- a\n- b", "MARKDOWN");
  assert.equal(n.format, "markdown");
  assert.equal(n.text, "## 标题\n- a\n- b");
  assert.equal(n.html, undefined);
});

test("normalizeRichContent: structural rich HTML stays richtext", () => {
  const n = normalizeRichContent(JSON.stringify({ htmlValue: "<p><strong>粗体</strong></p><ol><li>a</li></ol>" }), "RICHTEXT");
  assert.equal(n.format, "richtext");
  assert.match(n.html, /<strong>/);
});

test("normalizeRichContent: strong Markdown inside rich HTML wins (CEXP-style)", () => {
  const html = "<ol><li>第一条</li></ol><p>## 一、业务需求汇总</p><p>| 测试点 | 预期 |</p><p>| --- | --- |</p><p>**加粗** 与 `代码`</p><p>### 小节</p>";
  const n = normalizeRichContent(JSON.stringify({ htmlValue: html }), "RICHTEXT");
  assert.equal(n.format, "markdown");
  assert.match(n.text, /^## 一、/m);
  assert.match(n.text, /^- 第一条/m);
  assert.equal(n.html, undefined);
});

test("normalizeRichContent: trivial HTML with Markdown text switches to markdown", () => {
  const n = normalizeRichContent(JSON.stringify({ htmlValue: "<p>## 标题</p><p>- a</p><p>- b</p>" }), "RICHTEXT");
  assert.equal(n.format, "markdown");
  assert.match(n.text, /## 标题/);
});

test("normalizeRichContent: plain Markdown-looking string without format", () => {
  const n = normalizeRichContent("# 标题\n- a\n- b");
  assert.equal(n.format, "markdown");
  assert.equal(normalizeRichContent("普通文本").format, "text");
});

test("normalizeRichContent: JSONML converts to HTML and stays richtext", () => {
  const n = normalizeRichContent(JSON.stringify({ jsonMLValue: ["root", {}, ["p", {}, "x"], ["img", { src: "https://x/i.png" }]] }));
  assert.equal(n.format, "richtext");
  assert.match(n.html, /<img/);
  assert.deepEqual(n.images, ["https://x/i.png"]);
});

test("isTrivialHtml: style/formatting is not trivial", () => {
  assert.equal(isTrivialHtml("<p><span>x</span></p>"), true);
  assert.equal(isTrivialHtml('<p><span style="color:red">x</span></p>'), false);
  assert.equal(isTrivialHtml("<ul><li>x</li></ul>"), false);
});

test("compactTableRows keeps GFM header/delimiter/rows adjacent", () => {
  const md = "| a | b |\n\n| --- | --- |\n\n| 1 | 2 |\n\ntext";
  const out = compactTableRows(md);
  assert.match(out, /\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
});
