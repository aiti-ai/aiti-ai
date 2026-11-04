/*!
 * shortcut-bar.js — 远程桌面快捷键条（载体无关公共件；aiti-ui-env canonical 源）
 *
 * 用法：
 *   <script src=".../shortcut-bar.js"></script>
 *   ShortcutBar.mount({ root: "#shortcuts", onPress(code), onRelease(code), combos? });
 *
 * 语义：按住 chip = 依次按下组合内所有键；抬起/移出 = 逆序释放
 * （支持「按住 Alt+Tab 再点 Tab」式操作由上层扩展；本组件保持最简）。
 * combos 可覆盖默认组合：[{ label, codes: ["ControlLeft", ...] }]，code 为 DOM code。
 */
(function (global, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else if (typeof define === "function" && define.amd) define([], () => mod);
  else global.ShortcutBar = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_COMBOS = [
    { label: "Ctrl+Alt+Del", codes: ["ControlLeft", "AltLeft", "Delete"] },
    { label: "Ctrl+Alt+T", codes: ["ControlLeft", "AltLeft", "KeyT"] },
    { label: "Alt+Tab", codes: ["AltLeft", "Tab"] },
    { label: "⊞ Win", codes: ["MetaLeft"] },
    { label: "Ctrl+C", codes: ["ControlLeft", "KeyC"] },
    { label: "Ctrl+V", codes: ["ControlLeft", "KeyV"] },
    { label: "Ctrl+Z", codes: ["ControlLeft", "KeyZ"] },
    { label: "Ctrl+S", codes: ["ControlLeft", "KeyS"] },
    { label: "F1", codes: ["F1"] },
    { label: "F2", codes: ["F2"] },
    { label: "F3", codes: ["F3"] },
    { label: "F4", codes: ["F4"] },
    { label: "F5", codes: ["F5"] },
    { label: "F6", codes: ["F6"] },
    { label: "F7", codes: ["F7"] },
    { label: "F8", codes: ["F8"] },
    { label: "F9", codes: ["F9"] },
    { label: "F10", codes: ["F10"] },
    { label: "F11", codes: ["F11"] },
    { label: "F12", codes: ["F12"] },
    { label: "⇧+F10", codes: ["ShiftLeft", "F10"] }, // Windows/Linux 右键菜单（上下文菜单）
    { label: "Esc", codes: ["Escape"] },
    { label: "PrtSc", codes: ["PrintScreen"] }
  ];

  function mount(opts) {
    const root = typeof opts.root === "string" ? document.querySelector(opts.root) : opts.root;
    if (!root) throw new Error("ShortcutBar: root not found");
    const onPress = opts.onPress || function () {};
    const onRelease = opts.onRelease || function () {};
    const combos = opts.combos || DEFAULT_COMBOS;

    root.classList.add("scb-root");
    let held = null; // { btn, codes }

    function release() {
      if (!held) return;
      for (let i = held.codes.length - 1; i >= 0; i--) onRelease(held.codes[i]);
      held.btn.classList.remove("scb-on");
      held = null;
    }

    combos.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "scb-chip";
      b.textContent = c.label;
      const down = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (held && held.btn !== b) release();
        if (held) return; // 已按住同一 chip，忽略重复按下
        held = { btn: b, codes: c.codes };
        b.classList.add("scb-on");
        for (const code of c.codes) onPress(code);
      };
      const up = () => {
        if (held && held.btn === b) release();
      };
      b.addEventListener("pointerdown", down);
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
      b.addEventListener("pointerleave", up);
      root.appendChild(b);
    });

    return {
      release,
      isOpen() { return true; }
    };
  }

  return { mount, DEFAULT_COMBOS };
});
