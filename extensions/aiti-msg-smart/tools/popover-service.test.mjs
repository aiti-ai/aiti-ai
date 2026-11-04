/**
 * 跨扩展出口回归测试（aiti-editor markdown 预览集成本弹层引擎）：
 *  - 弹层引擎以客户端服务 `aiti-msg-smart.popover` 开放（open/close）
 *  - 渲染上下文 rcx 缺省顶层文档（聊天路径零变化），仅 info.doc/win 可搬到别的同源文档
 *  - info.float / info.decorateQuote / info.caps 三个扩展点接入到位
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientSrc = await readFile(new URL("../client/src/index.js", import.meta.url), "utf8");

test("popover 服务：注册 aiti-msg-smart.popover（open/close，走同一个 ph）", () => {
  assert.match(clientSrc, /ctx\.registerExtService\?\.\("aiti-msg-smart\.popover"/);
  assert.match(clientSrc, /open: \(info\) => \{ if \(info\) ph\(info\); \}/);
  // close 必须清 state.opening + 浮层监听（清不干净 → 下次点击 toggle 误判）
  assert.match(clientSrc, /close: \(\) => \{[\s\S]*?state\.opening = null;[\s\S]*?clearFloat\(\);/);
});

test("渲染上下文：rcx 缺省顶层文档/窗口（聊天路径不受影响）", () => {
  // 初值 + setRcx 缺省都回落顶层
  assert.match(clientSrc, /let rcx = \{ doc: typeof document !== "undefined" \? document : null/);
  assert.match(clientSrc, /function setRcx\(info\) \{[\s\S]*?\(info && info\.doc\) \|\| \(typeof document/);
  // ph 入口按 info 重设（每次开弹层都重新解析，framed 与聊天互不串味）
  assert.match(clientSrc, /const ph = \(info\) => \{\s*\n\s*setRcx\(info\);/);
  // 顶层委托（划选/inline code）显式复位，防 rcx 残留指向 iframe
  assert.match(clientSrc, /function openSelectionCard\(text, range, msgEl\) \{\s*\n\s*setRcx\(null\);/);
  assert.match(clientSrc, /setRcx\(null\); \/\/ 行内 code 弹层恒在顶层文档/);
});

test("扩展点：float（非行级也浮层）/ decorateQuote（引用加前缀）/ caps（能力裁剪）", () => {
  // renderCard 浮层判据：行级元素或 info.float
  assert.match(clientSrc, /const isFloat = isLineEl\(info\.element\) \|\| !!info\.float;/);
  // decorateQuote 缺省恒等，接入 onPick / onNewSession
  assert.match(clientSrc, /const deco = \(s\) => \(typeof info\.decorateQuote === "function" \? info\.decorateQuote\(s\) : s\);/);
  assert.match(clientSrc, /ctx\.appendText\(deco\(quote\)\);/);
  assert.match(clientSrc, /text: deco\(quote\),/);
  // caps 优先、缺失回落 feature 开关
  assert.match(clientSrc, /return c && typeof c\[key\] === "boolean" \? c\[key\] : featureEnabled\("recognizer\." \+ key\);/);
  for (const cap of ["question", "file", "url", "providers"]) {
    assert.match(clientSrc, new RegExp(`capsOf\\("${cap}"\\)`), `caps 未接入: ${cap}`);
  }
});

test("framed 钳位：仅 info.doc 指向另一文档时启用（聊天定位行为不变）", () => {
  assert.match(clientSrc, /const framed = !!\((?:info|[^)]*)info\.doc && info\.doc !== document\)/);
});
