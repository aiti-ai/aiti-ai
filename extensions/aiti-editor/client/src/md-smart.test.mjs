/**
 * markdown 预览 → aiti-msg-smart 弹层适配（`md-smart.ts`）单测。
 *
 * Run: node --test pi-web-ext/aiti-editor/client/src/md-smart.test.mjs
 * 纯函数层（dirOf / srcRef / previewClickInfo）+ 生成脚本层（点击上报，见 markdown.test.mjs）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { dirOf, srcRef, previewClickInfo } = await import("./md-smart.ts");

const FILE = "/home/pi/workspace/aiti-ai/docs/x.md";

/** 极简 iframe 文档/窗口桩（只需 createElement/body/querySelector） */
function fakeDoc(el) {
  const body = { appendChild() {} };
  return {
    body,
    createElement: () => ({ style: {}, innerHTML: "", appendChild() {}, remove() {} }),
    querySelector: (sel) => (sel.includes('data-aiti-blk="' + el.blk + '"') ? el : null),
  };
}

test("dirOf：相对路径基准取文件所在目录（非会话 cwd）", () => {
  assert.equal(dirOf(FILE), "/home/pi/workspace/aiti-ai/docs");
  assert.equal(dirOf("/a.md"), "");
  assert.equal(dirOf("D:\\w\\p\\a.md"), "D:\\w\\p");
});

test("srcRef：源码行区间 → @ 定位串", () => {
  assert.equal(srcRef(FILE, 12, 14), "@/home/pi/workspace/aiti-ai/docs/x.md#L12-L14");
  assert.equal(srcRef(FILE, 7, 7), "@/home/pi/workspace/aiti-ai/docs/x.md#L7");
  assert.equal(srcRef(FILE, 0), "@/home/pi/workspace/aiti-ai/docs/x.md"); // 无有效行号 → 纯引用
  assert.equal(srcRef(FILE, 3, 2), "@/home/pi/workspace/aiti-ai/docs/x.md#L3"); // end < start 忽略
});

test("previewClickInfo：块级点击 → info 字段齐备（float/doc/win/caps/引用前缀）", () => {
  const el = { blk: "3", textContent: "一段正文" };
  const doc = fakeDoc(el);
  const win = {};
  const info = previewClickInfo(
    { type: "aiti-editor-preview-click", blk: "3", kind: "block", text: "一段正文", row: null, charOffset: null, srcStart: 12, srcEnd: 14 },
    { doc, win, filePath: FILE },
  );
  assert.equal(info.element, el);
  assert.equal(info.doc, doc);
  assert.equal(info.win, win);
  assert.equal(info.float, true); // 块级也走 fixed（iframe 内 setInline 是 body 追加层）
  assert.equal(info.rowIndex, null);
  assert.equal(info.text, "一段正文");
  assert.equal(info.cwd, "/home/pi/workspace/aiti-ai/docs");
  assert.equal(info.paragraphId, "mdprev:" + FILE + ":3:-");
  // 引用带源码定位（msg-smart 的 formatQuote 结果接在后面）
  assert.equal(info.decorateQuote("> 一段正文\n"), srcRef(FILE, 12, 14) + "\n> 一段正文\n");
  // 预览语境裁剪：question/providers/跨仓分辨关闭
  assert.deepEqual(info.caps, { question: false, providers: false, fileExternalRoots: false });
});

test("previewClickInfo：代码行点击 → rowIndex + __aitiClickedOffset（行高亮/行矩形）", () => {
  const el = { blk: "5" };
  const doc = fakeDoc(el);
  const info = previewClickInfo(
    { type: "aiti-editor-preview-click", blk: "5", kind: "code-line", text: "const a = 1;", row: 2, charOffset: 17, srcStart: 20, srcEnd: 20 },
    { doc, win: {}, filePath: FILE },
  );
  assert.equal(info.rowIndex, 2);
  assert.equal(el.__aitiClickedOffset, 17); // anchorRect 据此取该逻辑行真实视觉矩形
  assert.equal(info.paragraphId, "mdprev:" + FILE + ":5:2");
  assert.equal(info.decorateQuote("> const a = 1;\n"), srcRef(FILE, 20, 20) + "\n> const a = 1;\n");
});

test("previewClickInfo：锚点元素找不到（标注失配/文档已重建）→ null，调用方忽略", () => {
  const doc = { body: {}, createElement: () => ({}), querySelector: () => null };
  assert.equal(
    previewClickInfo({ type: "aiti-editor-preview-click", blk: "9", kind: "block", text: "x", row: null, charOffset: null, srcStart: 1, srcEnd: 1 },
      { doc, win: {}, filePath: FILE }),
    null,
  );
});

test("previewClickInfo：setInline 建层 / close 移除层（弹层生命周期自洽）", () => {
  const el = { blk: "1" };
  let appended = null;
  let removed = false;
  const layer = { innerHTML: "", appendChild(n) { appended = n; }, remove() { removed = true; } };
  const doc = { body: { appendChild() {} }, createElement: () => layer, querySelector: () => el };
  const info = previewClickInfo(
    { type: "aiti-editor-preview-click", blk: "1", kind: "block", text: "t", row: null, charOffset: null, srcStart: 1, srcEnd: 1 },
    { doc, win: {}, filePath: FILE },
  );
  info.setInline({ type: "span" }); // 服务缺席（无 toDom）→ 不抛异常、不挂空节点
  assert.equal(appended, null);
  info.close();
  assert.equal(removed, true);
});
