/**
 * Delegated code-line click path — regression guards.
 *
 * Code lines / diff cells / thinking lines open the popover from a document-level click
 * delegate (no react-dom), so the card is rebuilt by client/src/el-to-dom.js. Two rules:
 *  - line text must not carry the syntax highlighter's gutter numbers (they are inline spans
 *    inside <pre>: userSelect:none, but still in textContent → quotes said "1~/path";
 *    relative paths also stopped resolving because they arrived as "1docs/x.md");
 *  - the delegated renderer must expand function components (see el-to-dom.test.mjs for the
 *    behavioural test of the InvalidCharacterError that blanked the card).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientSrc = await readFile(new URL("../client/src/index.js", import.meta.url), "utf8");

test("code line text: gutter number spans stripped before splitting rows", () => {
  assert.match(clientSrc, /const lines = preText\(lineHost\)\.split\("\\n"\);/);
  assert.match(clientSrc, /lineHost\.querySelector\("\.react-syntax-highlighter-line-number"\)/);
  // The clone loses the number spans; caret offsets keep using the live node (anchorRect).
  assert.match(clientSrc, /clone\.querySelectorAll\("\.react-syntax-highlighter-line-number"\)/);
});

test("delegated card render: el-to-dom module handles function components", () => {
  assert.match(clientSrc, /import \{ elToDom as miniToDom \} from "\.\/el-to-dom\.js";/);
  // A failed card build must not vanish silently (it emptied the popover before).
  assert.match(clientSrc, /console\.error\("\[aiti-msg-smart\] card render failed", e\)/);
});
