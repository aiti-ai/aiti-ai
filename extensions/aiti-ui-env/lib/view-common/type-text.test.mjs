/**
 * type-text 单测（node --test）：VNC「⌨ 输入到远程」的文本 → 键事件映射。
 *
 * 覆盖点：
 *   1. 全部可打印 ASCII 都有映射，且 keysym = 字符码点（US 布局语义）；
 *   2. 大小写/Shift 层标点 shift 标记正确，code 指向正确的物理键；
 *   3. Enter/Tab/Backspace 走 X11 功能键 keysym；CRLF 不产生双回车；
 *   4. 非 ASCII（中文/emoji）跳过并计数，其余字符顺序不变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { textToKeys, charToKey, SHIFT_KEYSYM } from "./type-text.js";

test("可打印 ASCII 全覆盖：keysym = 码点", () => {
  for (let c = 0x20; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    const spec = charToKey(ch);
    assert.ok(spec, `0x${c.toString(16)} (${ch}) 应有映射`);
    assert.equal(spec.keysym, c, `${ch} keysym 应为码点`);
    assert.ok(typeof spec.code === "string" && spec.code.length > 0, `${ch} 应有 DOM code`);
    assert.equal(typeof spec.shift, "boolean", `${ch} shift 应为布尔`);
  }
});

test("Shift 语义：小写/数字不按 Shift，大写/Shift 层标点按 Shift", () => {
  for (const ch of ["a", "z", "0", "9", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"]) {
    assert.equal(charToKey(ch).shift, false, `${ch} 不应按 Shift`);
  }
  for (const ch of ["A", "Z", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "{", "}", "|", ":", '"', "<", ">", "?", "~"]) {
    assert.equal(charToKey(ch).shift, true, `${ch} 应需 Shift`);
  }
});

test("物理键位（DOM code）正确", () => {
  const cases = [
    ["a", "KeyA"], ["Q", "KeyQ"], ["7", "Digit7"],
    ["!", "Digit1"], [")", "Digit0"], ["_", "Minus"], ["+", "Equal"],
    ["{", "BracketLeft"], ["}", "BracketRight"], ["|", "Backslash"],
    [":", "Semicolon"], ['"', "Quote"], ["<", "Comma"], [">", "Period"],
    ["?", "Slash"], ["~", "Backquote"], [" ", "Space"],
  ];
  for (const [ch, code] of cases) assert.equal(charToKey(ch).code, code, `${ch} → ${code}`);
});

test("控制字符：\\n=Enter、\\t=Tab、\\b=Backspace；\\r 丢弃（不双回车）", () => {
  assert.deepEqual(charToKey("\n"), { keysym: 0xff0d, code: "Enter", shift: false });
  assert.deepEqual(charToKey("\t"), { keysym: 0xff09, code: "Tab", shift: false });
  assert.deepEqual(charToKey("\b"), { keysym: 0xff08, code: "Backspace", shift: false });
  const r = textToKeys("a\r\nb\r\n");
  assert.deepEqual(r.keys.map((k) => k.code), ["KeyA", "Enter", "KeyB", "Enter"]);
  assert.equal(r.skipped, 0, "\\r 不算 skipped");
});

test("非 ASCII 跳过并计数，其余保序", () => {
  const r = textToKeys("A中B文€C");
  assert.deepEqual(r.keys.map((k) => k.code), ["KeyA", "KeyB", "KeyC"]);
  assert.equal(r.skipped, 3);
  assert.equal(textToKeys("").skipped, 0);
  assert.deepEqual(textToKeys("").keys, []);
  assert.deepEqual(textToKeys(null).keys, []);
  assert.equal(textToKeys("😀x").skipped, 1, "代理对按一个字符计");
});

test("端到端样例：Windows 命令可完整拆解", () => {
  const cmd = "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0\n";
  const r = textToKeys(cmd);
  assert.equal(r.skipped, 0);
  assert.equal(r.keys.length, cmd.length); // 全部单键（末尾 \n → Enter）
  assert.equal(r.keys[r.keys.length - 1].code, "Enter");
  const shiftKeys = r.keys.filter((k) => k.shift).map((k) => k.keysym);
  // 大写字母（A W C O N O S S H S）+ 4 个 Shift 层 '~'
  assert.deepEqual(shiftKeys, [0x41, 0x57, 0x43, 0x4f, 0x4e, 0x4f, 0x53, 0x53, 0x48, 0x53, 0x7e, 0x7e, 0x7e, 0x7e], "大写/Shift 层字符各需一次 Shift");
  assert.equal(SHIFT_KEYSYM, 0xffe1);
});
