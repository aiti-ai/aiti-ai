/*!
 * virtual-keyboard.js — 程序员导向网页虚拟键盘（基于 simple-keyboard v3.8.177）
 *
 * 用法（任一载体页）：
 *   <link rel="stylesheet" href="vendor/simple-keyboard.css" />
 *   <link rel="stylesheet" href="virtual-keyboard.css" />
 *   <script src="vendor/simple-keyboard.js"></script>
 *   <script src="virtual-keyboard.js"></script>
 *   VirtualKeyboard.mount({ root: "#vkb", onKey: fn, onLatch: fn });
 *
 * 事件契约（载体适配）：
 *   onKey(code, down)   — 普通键/特殊键按下(true)/抬起(false)，code 为 DOM `code`（KeyA/ArrowUp/Escape…）
 *   onLatch(code, on)   — 修饰键锁定状态变化（ShiftLeft/ControlLeft/AltLeft/MetaLeft/CapsLock）
 *
 * 设计：
 *  - 键值 = code 或哨兵值，由 resolveCode() 统一映射（默认层字母=KeyQ 显示小写；
 *    大写层字母=UQ 哨兵显示大写、上档符号=Tilde/Exclam… 哨兵 → 基础 code）。
 *  - {shift} 按下 → 手动 setOptions 切换 default/shift 布局 + 锁定 ShiftLeft（粘滞）。
 *  - {ctrl}/{alt}/{meta}/{capslock} 为锁键：点按开/再点关（触屏友好）。
 *  - 布局切换后按 `data-skbtn` 属性重打锁定高亮 class。
 */
(function (global, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else if (typeof define === "function" && define.amd) define([], () => mod);
  else global.VirtualKeyboard = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ── 字母大写哨兵（UQ→KeyQ，显示 Q）──────────────────── */
  const LETTERS = "QWERTYUIOPASDFGHJKLZXCVBNM".split("");
  const UPPER_TO_CODE = {}, UPPER_DISPLAY = {};
  for (const ch of LETTERS) {
    UPPER_TO_CODE["U" + ch] = "Key" + ch;
    UPPER_DISPLAY["U" + ch] = ch;
  }

  /* ── 上档符号哨兵 → 基础 code（大写层 shift 已锁，直接出符号）── */
  const SHIFT_SENTINEL = {
    Tilde: "Backquote", Exclam: "Digit1", At: "Digit2", Hash: "Digit3", Dollar: "Digit4",
    Percent: "Digit5", Caret: "Digit6", Ampersand: "Digit7", Asterisk: "Digit8",
    ParenLeft: "Digit9", ParenRight: "Digit0", Underscore: "Minus", Plus: "Equal",
    BraceLeft: "BracketLeft", BraceRight: "BracketRight", Pipe: "Backslash",
    Colon: "Semicolon", DoubleQuote: "Quote", LessThan: "Comma", GreaterThan: "Period", Question: "Slash"
  };

  /* ── 特殊键 → code ─────────────────────────────────── */
  const SPECIAL_CODE = {
    "{esc}": "Escape", "{tab}": "Tab", "{ctrl}": "ControlLeft", "{alt}": "AltLeft",
    "{shift}": "ShiftLeft", "{bksp}": "Backspace", "{delete}": "Delete", "{capslock}": "CapsLock",
    "{meta}": "MetaLeft", "{space}": "Space", "{enter}": "Enter",
    "{arrowup}": "ArrowUp", "{arrowdown}": "ArrowDown", "{arrowleft}": "ArrowLeft", "{arrowright}": "ArrowRight",
    "{home}": "Home", "{end}": "End", "{pageup}": "PageUp", "{pagedown}": "PageDown"
  };

  const DIRECT_CODE_RE = /^(Key[A-Z]|Digit[0-9]|F[0-9]{1,2})$|^(Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

  /* ── 布局（值 = code 或哨兵；{xxx} = 特殊键）──────────── */
  const LOWER_ROWS = [
    "{esc} {tab} {ctrl} {alt} {shift} {bksp} {delete} {capslock}",
    "Backquote Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal",
    "KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight Backslash",
    "KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote {enter}",
    "{shift} KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash {shift}",
    "{meta} {space} {arrowleft} {arrowup} {arrowdown} {arrowright} {home} {end} {pageup} {pagedown}",
    "F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12"
  ];
  const UPPER_ROWS = [
    "{esc} {tab} {ctrl} {alt} {shift} {bksp} {delete} {capslock}",
    "Tilde Exclam At Hash Dollar Percent Caret Ampersand Asterisk ParenLeft ParenRight Underscore Plus",
    "UQ UW UE UR UT UY UU UI UO UP BraceLeft BraceRight Pipe",
    "UA US UD UF UG UH UJ UK UL Colon DoubleQuote {enter}",
    "{shift} UZ UX UC UV UB UN UM LessThan GreaterThan Question {shift}",
    "{meta} {space} {arrowleft} {arrowup} {arrowdown} {arrowright} {home} {end} {pageup} {pagedown}",
    "F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12"
  ];

  /* ── 显示映射（单一全局 map）────────────────────────── */
  const COMMON_DISPLAY = {
    "{esc}": "esc", "{tab}": "tab", "{ctrl}": "Ctrl", "{alt}": "Alt", "{shift}": "⇧",
    "{bksp}": "⌫", "{delete}": "Del", "{capslock}": "caps", "{meta}": "⊞", "{space}": " ",
    "{enter}": "⏎", "{arrowup}": "↑", "{arrowdown}": "↓", "{arrowleft}": "←", "{arrowright}": "→",
    "{home}": "Home", "{end}": "End", "{pageup}": "PgUp", "{pagedown}": "PgDn"
  };
  const DISPLAY = Object.assign({}, COMMON_DISPLAY, UPPER_DISPLAY, {
    Backquote: "`", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5",
    Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9", Digit0: "0", Minus: "-", Equal: "=",
    KeyQ: "q", KeyW: "w", KeyE: "e", KeyR: "r", KeyT: "t", KeyY: "y", KeyU: "u",
    KeyI: "i", KeyO: "o", KeyP: "p", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
    KeyA: "a", KeyS: "s", KeyD: "d", KeyF: "f", KeyG: "g", KeyH: "h", KeyJ: "j",
    KeyK: "k", KeyL: "l", Semicolon: ";", Quote: "'",
    KeyZ: "z", KeyX: "x", KeyC: "c", KeyV: "v", KeyB: "b", KeyN: "n", KeyM: "m",
    Comma: ",", Period: ".", Slash: "/",
    Tilde: "~", Exclam: "!", At: "@", Hash: "#", Dollar: "$", Percent: "%", Caret: "^",
    Ampersand: "&", Asterisk: "*", ParenLeft: "(", ParenRight: ")", Underscore: "_", Plus: "+",
    BraceLeft: "{", BraceRight: "}", Pipe: "|", Colon: ":", DoubleQuote: "\"",
    LessThan: "<", GreaterThan: ">", Question: "?"
  });
  for (let i = 1; i <= 12; i++) DISPLAY["F" + i] = "F" + i; // F1–F12：显示同 code（上/下档一致）

  /* ── 值 → code ────────────────────────────────────── */
  function resolveCode(value) {
    if (SPECIAL_CODE[value]) return SPECIAL_CODE[value];
    if (DIRECT_CODE_RE.test(value)) return value;
    if (SHIFT_SENTINEL[value]) return SHIFT_SENTINEL[value];
    if (UPPER_TO_CODE[value]) return UPPER_TO_CODE[value];
    return null;
  }

  /* ── 挂载 ─────────────────────────────────────────── */
  function mount(opts) {
    const root = typeof opts.root === "string" ? document.querySelector(opts.root) : opts.root;
    if (!root) throw new Error("VirtualKeyboard: root not found: " + opts.root);
    const onKey = opts.onKey || function () {};
    const onLatch = opts.onLatch || function () {};

    const state = { shift: false, mods: {} };
    const LOCK_BTNS = ["{shift}", "{ctrl}", "{alt}", "{meta}", "{capslock}"];

    function setLock(value, on) {
      root.querySelectorAll('.hg-button[data-skbtn="' + value + '"]').forEach((el) => {
        el.classList.toggle("hg-vkb-lock", on);
      });
    }

    // simple-keyboard UMD 导出可能是类本身或 { SimpleKeyboard, default } 命名空间
    const SK = (typeof globalThis.SimpleKeyboard === "function")
      ? globalThis.SimpleKeyboard
      : (globalThis.SimpleKeyboard && globalThis.SimpleKeyboard.SimpleKeyboard);
    if (typeof SK !== "function") throw new Error("VirtualKeyboard: SimpleKeyboard 未加载");
    const sk = new SK(root, {
      theme: "hg-theme-vkb",
      layout: { default: LOWER_ROWS, shift: UPPER_ROWS },
      layoutName: "default",
      display: DISPLAY,
      enableLayoutCandidates: false,
      disableCaretPositioning: true,
      preventMouseDownDefault: true,
      disableButtonHold: true,
      onKeyPress(button) {
        if (button === "{shift}") {
          state.shift = !state.shift;
          onLatch("ShiftLeft", state.shift);
          // 直接操作 DOM 改 layout 布局，不调用 sk.setOptions（它会触发 render
          // 导致 vkb-hidden-root 被意外清除或加回）。手动替换每行按钮的 data-skbtn
          // 和显示文本，实现布局切换。
          var rows = root.querySelectorAll('.hg-row');
          var newLayout = state.shift ? UPPER_ROWS : LOWER_ROWS;
          for (var ri = 0; ri < rows.length && ri < newLayout.length; ri++) {
            var btns = rows[ri].querySelectorAll('.hg-button');
            var keys = newLayout[ri].split(' ');
            for (var ki = 0; ki < btns.length && ki < keys.length; ki++) {
              var val = keys[ki];
              btns[ki].setAttribute('data-skbtn', val);
              var display = DISPLAY[val] || COMMON_DISPLAY[val] || val.replace(/[{}]/g, '');
              btns[ki].innerHTML = '<span>' + display + '</span>';
              // 更新 class
              btns[ki].className = 'hg-button';
              if (state.shift && LOCK_BTNS.indexOf(val) >= 0) {
                btns[ki].classList.add('hg-vkb-lock');
              }
            }
          }
          return;
        }
        if (button === "{ctrl}") { state.mods.ControlLeft = !state.mods.ControlLeft; setLock("{ctrl}", state.mods.ControlLeft); onLatch("ControlLeft", state.mods.ControlLeft); return; }
        if (button === "{alt}") { state.mods.AltLeft = !state.mods.AltLeft; setLock("{alt}", state.mods.AltLeft); onLatch("AltLeft", state.mods.AltLeft); return; }
        if (button === "{meta}") { state.mods.MetaLeft = !state.mods.MetaLeft; setLock("{meta}", state.mods.MetaLeft); onLatch("MetaLeft", state.mods.MetaLeft); return; }
        if (button === "{capslock}") { state.mods.CapsLock = !state.mods.CapsLock; setLock("{capslock}", state.mods.CapsLock); onLatch("CapsLock", state.mods.CapsLock); return; }
        const code = resolveCode(button);
        if (code) onKey(code, true);
      },
      onKeyReleased(button) {
        if (LOCK_BTNS.indexOf(button) >= 0) return; // 锁键，抬起不动作
        const code = resolveCode(button);
        if (code) onKey(code, false);
      }
    });

    return {
      open() { root.classList.remove("vkb-hidden-root"); },
      close() { root.classList.add("vkb-hidden-root"); },
      toggle() { root.classList.toggle("vkb-hidden-root"); },
      isOpen() { return !root.classList.contains("vkb-hidden-root"); },
      reset() { // 全键释放（断开/切换画面时调用）
        if (state.shift) { state.shift = false; onLatch("ShiftLeft", false); }
        Object.keys(state.mods).forEach((c) => { if (state.mods[c]) { state.mods[c] = false; onLatch(c, false); } });
        LOCK_BTNS.forEach((b) => setLock(b, false));
        sk.setOptions({ layoutName: "default" });
      },
      destroy() {
        try { sk.destroy(); } catch (e) {}
      }
    };
  }

  return { mount, resolveCode };
});
