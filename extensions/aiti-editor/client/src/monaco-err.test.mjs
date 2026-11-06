/**
 * lib.ts describeMonacoError 测试 —— Monaco AMD 加载错误可读化。
 *
 * 背景：vscode AMD loader 对脚本加载失败把 Event 字符串化进 Error.message
 *（"[object Event]"），UI 直显会误导用户。2026-09-25 排障实测钉死三种形态。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-editor/client/src/monaco-err.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { describeMonacoError } = await import("./lib.ts");

test("loader 包装的 Error（message 含 [object Event]）→ 可读文案 + 自助指引", () => {
  const e = new Error("[object Event]");
  const out = describeMonacoError(e);
  assert.ok(!out.includes("[object Event]"), "不得原样输出 [object Event]");
  assert.ok(out.includes("脚本加载失败"), "out=" + out);
  assert.ok(out.includes("重试") || out.includes("刷新"), "应带自助指引 out=" + out);
});

test("Event 本体 → 可读文案；带 target.src 时提取 URL", () => {
  const ev = new Event("error");
  const out = describeMonacoError(ev);
  assert.ok(out.includes("脚本加载失败"), "out=" + out);

  const ev2 = new Event("error");
  // Event.target 只读且不在构造器里赋——用 defineProperty 模拟 script 元素
  Object.defineProperty(ev2, "target", { value: { src: "https://x/api/extensions/aiti-editor/assets/monaco/vs/editor/editor.main.js" } });
  const out2 = describeMonacoError(ev2);
  assert.ok(out2.includes("editor.main.js"), "应含失败文件名 out2=" + out2);
});

test("普通 Error → message 原样透传", () => {
  assert.equal(describeMonacoError(new Error("loader.js: no require")), "loader.js: no require");
  assert.equal(describeMonacoError(new Error("editor.main loaded but no monaco")), "editor.main loaded but no monaco");
});

test("字符串 / 空值兜底", () => {
  assert.equal(describeMonacoError("boom"), "boom");
  assert.ok(describeMonacoError(null).length > 0);
  assert.ok(describeMonacoError(undefined).length > 0);
});
