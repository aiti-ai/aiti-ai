/*!
 * system-keyboard.js — 系统（设备原生）软键盘代理（载体无关公共件）
 *
 * 用途：远程桌面画布（canvas/tabindex=-1）在移动端往往唤不起 IME；本组件用
 * 一个隐藏 <input> 召回系统键盘，把输入的字符/退格/回车经回调转发给载体。
 *
 *   const kb = SystemKeyboard.mount({ onChange(ev) });  // ev = {type:"char",ch} | {type:"special",name}
 *   kb.open()/close()/toggle(); kb.isOpen;
 *
 * 注意：
 *  - input 不能 display:none（部分浏览器不弹 IME），由载体 CSS 设为近透明固定条
 *  - 中文 IME 组合输入期间 input 会多次触发，逐段转发（远端按 Unicode keysym 收）
 */
(function (global, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else if (typeof define === "function" && define.amd) define([], () => mod);
  else global.SystemKeyboard = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function mount(opts) {
    const onChange = opts.onChange || function () {};

    const input = document.createElement("input");
    input.type = "text";
    input.className = "syskb-input";
    input.name = "syskb";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.spellcheck = false;
    document.body.appendChild(input);

    function flush() {
      const v = input.value;
      if (!v) return;
      input.value = "";
      for (const ch of v) onChange({ type: "char", ch: ch });
    }
    input.addEventListener("input", flush);
    input.addEventListener("keydown", (e) => {
      // 物理键盘的特殊键不会体现在 value 里
      if (e.key === "Backspace") { e.preventDefault(); onChange({ type: "special", name: "Backspace" }); }
      else if (e.key === "Enter") { flush(); onChange({ type: "special", name: "Enter" }); }
    });

    return {
      el: input,
      open() { input.focus(); },
      close() { input.blur(); },
      toggle() { if (document.activeElement === input) input.blur(); else input.focus(); },
      get isOpen() { return document.activeElement === input; }
    };
  }

  return { mount };
});
