// aiti-float 层叠上下文判定单测（stacking.ts，纯函数零 DOM）。
// 钉住置前连带抬祖先的边界：只抬「真把后代关进层叠上下文」的那一层。
// 回归现场：plan 模式交互提问卡（挂在宿主消息区根 .chat-content = relative + z-index:auto）
// 被点一下 → 旧实现把该布局容器打到 z 3001，透明的整块消息区压过左栏(200)/右栏(250)，
// 两区内容互相穿插。relative + z auto 不困后代，判 false 即不再打标。
// Run: node --experimental-strip-types --test pi-web-ext/aiti-float/client/src/stacking.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { createsStackingContext } from "./stacking.ts";

function cs(over = {}) {
  return {
    position: "static", zIndex: "auto", transform: "none", filter: "none",
    backdropFilter: "none", opacity: "1", willChange: "auto", isolation: "auto",
    mixBlendMode: "normal", contain: "none", ...over,
  };
}

test("布局容器（relative + z-index:auto）不是层叠上下文——宿主消息区根 .chat-content 即此类", () => {
  assert.equal(createsStackingContext(cs({ position: "relative" })), false);
  // 同类误伤面：静态/无 z 的 flex 列、absolute 包裹层同理
  assert.equal(createsStackingContext(cs({ position: "absolute" })), false);
  assert.equal(createsStackingContext(cs()), false);
});

test("定位 + 显式 z-index 才是层叠上下文（真遮罩层惯例，必须连带抬）", () => {
  assert.equal(createsStackingContext(cs({ position: "relative", zIndex: "0" })), true);
  assert.equal(createsStackingContext(cs({ position: "absolute", zIndex: "240" })), true);
  assert.equal(createsStackingContext(cs({ position: "relative", zIndex: "auto" })), false);
  // static 的 z-index 不参与堆叠判定
  assert.equal(createsStackingContext(cs({ zIndex: "50" })), false);
});

test("fixed / sticky 始终自成层叠上下文（即便 z-index:auto）", () => {
  assert.equal(createsStackingContext(cs({ position: "fixed" })), true);
  assert.equal(createsStackingContext(cs({ position: "sticky", zIndex: "auto" })), true);
});

test("transform / filter / 半透明 opacity / isolation / blend / will-change / contain 各自造上下文", () => {
  assert.equal(createsStackingContext(cs({ position: "relative", transform: "translateX(-50%)" })), true);
  assert.equal(createsStackingContext(cs({ position: "relative", filter: "blur(2px)" })), true);
  assert.equal(createsStackingContext(cs({ position: "relative", backdropFilter: "blur(4px)" })), true);
  assert.equal(createsStackingContext(cs({ position: "relative", opacity: "0.98" })), true);
  assert.equal(createsStackingContext(cs({ position: "relative", opacity: "1" })), false);
  assert.equal(createsStackingContext(cs({ position: "relative", isolation: "isolate" })), true);
  assert.equal(createsStackingContext(cs({ position: "relative", mixBlendMode: "multiply" })), true);
  assert.equal(createsStackingContext(cs({ position: "relative", willChange: "transform" })), true);
  assert.equal(createsStackingContext(cs({ position: "relative", contain: "paint" })), true);
  assert.equal(createsStackingContext(cs({ position: "relative", contain: "layout inline-size" })), true);
  // inline-size 单用不成上下文
  assert.equal(createsStackingContext(cs({ position: "relative", contain: "inline-size" })), false);
});

test("字段缺省/空串不误判（打桩与旧浏览器缺属性的兜底）", () => {
  assert.equal(createsStackingContext({ position: "relative", zIndex: "auto" }), false);
  assert.equal(createsStackingContext({ position: "relative", opacity: "" }), false);
  assert.equal(createsStackingContext({ position: "fixed" }), true);
});
