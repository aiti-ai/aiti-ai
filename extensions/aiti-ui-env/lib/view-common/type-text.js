/**
 * aiti-ui-env · 公共查看器件：文本 → RFB 键盘事件序列（VNC「⌨ 输入到远程」用）
 *
 * 为什么需要：VNC 剪贴板不是所有目标都可用——
 *   - QEMU 虚拟机的 VNC 剪贴板需要 guest 代理（spice-vdagent 等）才能落到客户机，无代理时
 *     ClientCutText 收到的数据在 QEMU 里悬空（noVNC 发送成功但客户机永远收不到）；
 *   - x11vnc 客户端连接后约 8s 内 selwin 未创建，此窗口内收到的 ClientCutText 被静默丢弃；
 *   - 旧扩展剪贴板协议只传 Latin-1，非 ASCII 会变 '?'。
 * 兜底办法 = 把文本拆成键盘事件逐个发（等价于人在远程逐字敲），任何 VNC 服务端都支持。
 *
 * 映射约定（US 布局，与 noVNC 官方 Keyboard 一致）：每个字符给出
 *   - keysym：该字符的 X11 keysym（旧协议 KeyEvent 用；x11vnc/libvncserver 按 keysym 反查键位+Shift）
 *   - code  ：DOM code 名（QEMU 扩展键事件用它查 XtScancode 表得 AT 扫描码）
 *   - shift ：该字符是否需要 Shift（QEMU 扩展键事件只认扫描码 + 修饰键状态，必须自带 Shift 按下/抬起）
 * 非 ASCII（中文/emoji…）无法映射为单键 → 跳过并计数（远程需输入法），由调用方提示用户。
 */

/** XK_Shift_L：修饰键 keysym（DOM code = "ShiftLeft"） */
export const SHIFT_KEYSYM = 0xffe1;

const LETTERS = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = String.fromCharCode(65 + i);
    const code = "Key" + upper;
    m[lower] = { keysym: lower.codePointAt(0), code, shift: false };
    m[upper] = { keysym: upper.codePointAt(0), code, shift: true };
  }
  return m;
})();

const DIGITS = (() => {
  const m = {};
  for (let d = 0; d <= 9; d++) m[String(d)] = { keysym: 0x30 + d, code: "Digit" + d, shift: false };
  return m;
})();

/** [字符, DOM code]；未列出的 Shift 层字符在 SHIFTED 里 */
const PLAIN_PUNCT = [
  [" ", "Space"], ["`", "Backquote"], ["-", "Minus"], ["=", "Equal"],
  ["[", "BracketLeft"], ["]", "BracketRight"], ["\\", "Backslash"], [";", "Semicolon"],
  ["'", "Quote"], [",", "Comma"], [".", "Period"], ["/", "Slash"],
];
const SHIFTED_PUNCT = [
  ["!", "Digit1"], ["@", "Digit2"], ["#", "Digit3"], ["$", "Digit4"], ["%", "Digit5"],
  ["^", "Digit6"], ["&", "Digit7"], ["*", "Digit8"], ["(", "Digit9"], [")", "Digit0"],
  ["_", "Minus"], ["+", "Equal"], ["{", "BracketLeft"], ["}", "BracketRight"], ["|", "Backslash"],
  [":", "Semicolon"], ['"', "Quote"], ["<", "Comma"], [">", "Period"], ["?", "Slash"], ["~", "Backquote"],
];

/** 控制字符：keysym 用 X11 功能键 keysym */
const CONTROL = {
  "\n": { keysym: 0xff0d, code: "Enter", shift: false },
  "\t": { keysym: 0xff09, code: "Tab", shift: false },
  "\b": { keysym: 0xff08, code: "Backspace", shift: false },
};

const TABLE = (() => {
  const m = Object.assign({}, LETTERS, DIGITS, CONTROL);
  for (const [ch, code] of PLAIN_PUNCT) m[ch] = { keysym: ch.codePointAt(0), code, shift: false };
  for (const [ch, code] of SHIFTED_PUNCT) m[ch] = { keysym: ch.codePointAt(0), code, shift: true };
  return m;
})();

/** 单个字符 → 键位规格；不可映射（非 ASCII/未知控制符）返回 null */
export function charToKey(ch) {
  if (typeof ch !== "string" || ch.length === 0) return null;
  return TABLE[ch] || null;
}

/**
 * 文本 → 键事件序列。
 * @param {string} text
 * @returns {{keys: {keysym:number, code:string, shift:boolean}[], skipped: number}}
 *   skipped = 不可映射字符数（非 ASCII、\r 等）；\r\n 的 \r 不计入 skipped（换行交给 \n）。
 */
export function textToKeys(text) {
  const keys = [];
  let skipped = 0;
  for (const ch of String(text == null ? "" : text)) {
    if (ch === "\r") continue; // CRLF：\r 丢弃，\n 发 Enter（避免双回车）
    const spec = charToKey(ch);
    if (spec) keys.push(spec);
    else skipped++;
  }
  return { keys, skipped };
}

export default { textToKeys, charToKey, SHIFT_KEYSYM };
