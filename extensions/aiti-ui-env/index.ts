/**
 * aiti-ui-env · UI 环境管理（桌面 / 无头虚拟屏）
 *
 * 后台无头服务器上的 UI 调试环境分配器：一套 4 态模式开关，裁决「新启动的
 * MCP / GUI 应用」落在真实桌面还是 Xvfb 无头虚拟屏（openbox WM + AT-SPI 总线），
 * 并提供 VNC-on-web（noVNC）在浏览器查看虚拟桌面。
 *
 * 核心语义（docs/aiti-ui-env-extension-plan.md）：
 *   prefer-desktop   1 优先桌面   prefer-headless  2 优先无头虚拟环境
 *   always-desktop   3 总是桌面   always-headless  4 总是无头虚拟环境
 * 切换即时生效，作用于下一次 resolve/run（已启动进程不受影响）。
 *
 * 落地三件套：server API（面板/外部）、agent 工具（方案 M 注入，模型直接调用）、
 * scripts/ui-env CLI（MCP 启动器 shell 里 eval）。
 * cua.ai（语义树/计算机操作 agent）不做进本扩展——挂 AT-SPI 总线做独立扩展，
 * 依赖方向单向：cua → 本扩展 status/run API。
 *
 * 只依赖 Node 内建模块；探测/裁决核心在 lib/env.ts（跨 reload 保活用 globalThis 单例）。
 */
import * as env from "./lib/env.js";
import { promises as fsPromises } from "node:fs";
import { join as pathJoin, dirname as pathDirname } from "node:path";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

function parseBody(req: Request): Promise<Record<string, any>> {
  return req.json().catch(() => ({}));
}

/** 解析 "host[:port]" 目标地址；兼容 rdp:// 前缀、[IPv6]:port、纯域名/IP。无法解析时返回 null。 */
function parseRdpTarget(input: string, defaultPort = 3389): { host: string; port: number } | null {
  let s = String(input || "").trim();
  if (!s) return null;
  s = s.replace(/^rdp:\/\//i, "").replace(/\/+$/, "");
  const m6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (m6) return { host: m6[1], port: Number(m6[2] || defaultPort) };
  const i = s.lastIndexOf(":");
  if (i > 0 && /^\d+$/.test(s.slice(i + 1))) {
    const host = s.slice(0, i);
    const port = Number(s.slice(i + 1));
    if (host && port > 0 && port <= 65535) return { host, port };
    return null;
  }
  return { host: s, port: defaultPort };
}

/** VNC 查看外壳页（<token>/view.html）：无 iframe，直接 import 同前缀目录下 noVNC 的
 *  core/rfb.js（ES module）挂载 RFB；工具条支持旋转 0/90/180/270、放大缩小、重置；
 *  触屏双指捏合缩放 + 双指拖动平移（单指透传给 noVNC 操作远程）。
 *  输入映射：对 canvas 实例 patch getBoundingClientRect 返回"虚拟矩形"(0,0,fw,fh)，
 *  我们把物理坐标换算成 framebuffer 坐标后合成事件直接派发给 canvas——
 *  noVNC 的 clientToElement→absX 链路（scale=1、viewport 0,0）即得精确远程坐标，
 *  任意旋转/缩放下鼠标、滚轮、触摸零失真。 */
const VNC_VIEW_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>VNC 查看 · 旋转/缩放</title>
<link rel="stylesheet" href="common/vendor/simple-keyboard.css">
<link rel="stylesheet" href="common/virtual-keyboard.css">
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; background: #0b0e14; color: #e2e8f0;
    font: 13px/1.4 system-ui, sans-serif; display: flex; flex-direction: column; overflow: hidden; }
  #bar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; flex-wrap: wrap;
    background: #111827; border-bottom: 1px solid #1f2937; flex: none; user-select: none; }
  #bar button { background: #1f2937; color: #e2e8f0; border: 1px solid #374151; border-radius: 6px;
    padding: 3px 10px; font-size: 12px; cursor: pointer; }
  #bar button:hover { background: #374151; }
  #status { color:var(--text-dim, #94a3b8); margin-right: 4px; }
  #deg, #pct { min-width: 38px; text-align: center; color: #a5b4fc;
    font-variant-numeric: tabular-nums; opacity: .9; }
  #hint { color:var(--text-muted, #64748b); font-size: 11px; margin-left: auto; }
  #bar button.on { background: #3b5b8f; border-color: #6ea8fe; color: #fff; }
  /* 快捷键条 / 虚拟键盘面板（公共件） */
  #shortcuts { display: flex; flex-wrap: wrap; gap: 4px; padding: 5px 8px;
    background: #0f1522; border-bottom: 1px solid #1f2937; }
  #shortcuts[hidden] { display: none; }
  .scb-chip { background: #1f2937; color: #cbd5e1; border: 1px solid #374151; border-radius: 14px;
    padding: 3px 10px; font-size: 11px; cursor: pointer; touch-action: none;
    -webkit-user-select: none; user-select: none; }
  .scb-chip.scb-on { background: #3b82f6; color: #fff; border-color: #93c5fd; }
  #vkbRoot { padding: 4px 6px 6px; background: #0f1522; border-bottom: 1px solid #1f2937; }
  .syskb-input { position: fixed; left: 0; bottom: 0; width: 100%; height: 24px;
    opacity: 0.01; border: 0; padding: 0; z-index: -1; }
  /* 剪贴板 / 设置浮层（小屏底部抽屉风格） */
  #clip, #settings { position: absolute; left: 0; right: 0; bottom: 0; z-index: 20;
    background: #111827; border-top: 1px solid #374151; padding: 10px;
    display: flex; flex-direction: column; gap: 8px; }
  #clip[hidden], #settings[hidden] { display: none; }
  .cfgrow { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #cbd5e1; }
  .cfgrow select { background: #1f2937; color: #e2e8f0; border: 1px solid #374151;
    border-radius: 4px; padding: 2px 4px; font-size: 12px; }
  #clip textarea { width: 100%; height: 90px; box-sizing: border-box; resize: vertical;
    background: #0b0e14; color: #e2e8f0; border: 1px solid #374151; border-radius: 6px;
    font: 12px/1.5 ui-monospace, monospace; padding: 6px; }
  #clip button { background: #1f2937; color: #e2e8f0; border: 1px solid #374151; border-radius: 6px;
    padding: 3px 10px; font-size: 12px; cursor: pointer; }
  #clip button:hover { background: #374151; }
  #clip button.on { background: #b45309; border-color: var(--warn, #f59e0b); color: #fff; }
  /* 剪贴板面板内联提示（输入框上方）：贴近操作点，比顶部状态栏显眼（发送/获取/输入的结果都落这里） */
  #clipmsg { font-size: 11px; line-height: 1.5; padding: 5px 8px; border-radius: 6px;
    background: #0b1220; border: 1px solid #1f2937; border-left-width: 3px; color:var(--text-dim, #94a3b8);
    max-height: 76px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  #clipmsg[hidden] { display: none; }
  #clipmsg.err { color: #fca5a5; border-color: #7f1d1d; border-left-color: var(--danger, #ef4444); background: color-mix(in srgb, var(--danger, #ef4444) 8%, transparent); }
  #clipmsg.warn { color: var(--warn, #fbbf24); border-color: #78350f; border-left-color: var(--warn, #f59e0b); background: color-mix(in srgb, var(--warn, #f59e0b) 8%, transparent); }
  #clipmsg.ok { color: #86efac; border-color: #14532d; border-left-color: var(--ok, #22c55e); background: color-mix(in srgb, var(--ok, #22c55e) 8%, transparent); }
  #stage { position: relative; flex: 1; overflow: hidden; touch-action: none; background: #000; }
  #box { position: absolute; left: 50%; top: 50%; transform-origin: center; }
  #box canvas { display: block; image-rendering: auto; }
  /* 凭据弹层（对齐 noVNC 官方 credentials 面板：username/password 按事件 types 显隐，密码遮蔽） */
  #cred { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    z-index: 30; background: #111827; border: 1px solid #374151; border-radius: 10px;
    padding: 14px 16px; min-width: 250px; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
  #cred[hidden] { display: none; }
  #cred h3 { margin: 0 0 10px; font-size: 13px; }
  #cred label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #cbd5e1; margin: 8px 0; }
  /* ⚠ 必须显式写：作者样式 #cred label{display:flex} 优先级高于 UA 的 [hidden]{display:none}，
     否则 username 行即使标了 hidden 也照样显示（标准 VNC auth 只该问密码 → 别把用户搞蒙） */
  #cred label[hidden] { display: none; }
  #cred label span { flex: none; width: 44px; }
  #cred input { flex: 1; min-width: 0; background: #0b0e14; color: #e2e8f0; border: 1px solid #374151;
    border-radius: 6px; padding: 5px 8px; font-size: 12px; }
  #cred button { background: #3b82f6; border: 1px solid #60a5fa; color: #fff; border-radius: 6px;
    padding: 5px 14px; font-size: 12px; cursor: pointer; margin-top: 6px; float: right; }
  #cred button:hover { background: #2563eb; }
</style>
</head>
<body>
<div id="bar">
  <span id="status">连接中…</span>
  <button id="rot" title="顺时针旋转 90°">⟳ 旋转</button><span id="deg">0°</span>
  <span style="width:8px"></span>
  <button id="zin" title="放大">＋</button><span id="pct">100%</span><button id="zout" title="缩小">－</button>
  <button id="reset" title="复位旋转与缩放">重置</button>
  <span style="width:8px"></span>
  <button id="clipbtn" title="与远程互传剪贴板">剪贴板</button>
  <button id="cad" title="发送 Ctrl+Alt+Del 到远程">CAD</button>
  <button id="fs" title="全屏">⛶</button>
  <button id="cfgbtn" title="设置：仅观看/共享/画质/压缩/自动重连">⚙</button>
  <span style="width:8px"></span>
  <button id="vkbb" title="虚拟键盘（触屏友好，修饰键可锁定）">虚拟</button>
  <button id="syskbb" title="召喚系统原生软键盘（移动端输入法）">系统</button>
  <button id="scbb" title="快捷键条（Ctrl+Alt+T / Alt+Tab …）">快捷键</button>
  <span id="hint">单指操作远程 · 双指捏合缩放 · 双指拖动平移 · Ctrl+滚轮缩放</span>
</div>
<div id="shortcuts" hidden></div>
<div id="vkbRoot" class="vkb-hidden-root"></div>
<div id="stage"><div id="box"></div></div>
<script src="common/vendor/simple-keyboard.js"></script>
<script src="common/virtual-keyboard.js"></script>
<script src="common/shortcut-bar.js"></script>
<script src="common/remote-keys.js"></script>
<script src="common/system-keyboard.js"></script>
<div id="clip" hidden>
  <div style="display:flex; align-items:center;">
    <strong style="font-size:12px;">剪贴板互通</strong>
    <span style="color:var(--text-muted, #64748b); font-size:11px; margin-left:8px;">远程复制自动进本地剪贴板；下方编辑后可发送到远程</span>
    <button id="clipclose" style="margin-left:auto;" title="关闭">✕</button>
  </div>
  <div id="clipmsg" hidden></div>
  <textarea id="cliptext" spellcheck="false"></textarea>
  <div style="display:flex; gap:6px; flex-wrap:wrap;">
    <button id="clipfetch" title="读取远程当前剪贴板（远程复制只在内容变化时推送，页面后连或同内容重拷用此拉取）">获取远程</button>
    <button id="clipsend" title="写入远程剪贴板：本机目标直写 X/系统剪贴板（Unicode 安全，远程 Ctrl+V 即可）；远程主机/虚拟机等无法直写时自动回退 VNC 协议通道">发送到远程</button>
    <button id="cliptype" title="逐字键入到远程（键盘事件兜底：QEMU 虚拟机、x11vnc 刚连接、无剪贴板通道时可用；仅 ASCII，中文/emoji 跳过；再点一次停止）">输入到远程</button>
  </div>
  <div style="color:var(--text-muted, #64748b); font-size:11px;">发送到远程 = 写目标机剪贴板（支持中文，远程 Ctrl+V）；输入到远程 = 逐字敲键（剪贴板不可用时兜底，仅 ASCII）</div>
</div>
<div id="settings" hidden>
  <div style="display:flex; align-items:center;">
    <strong style="font-size:12px;">设置</strong>
    <button id="cfgclose" style="margin-left:auto;" title="关闭">✕</button>
  </div>
  <label class="cfgrow"><input type="checkbox" id="cfgview"> 仅观看（不发送键鼠）</label>
  <label class="cfgrow"><input type="checkbox" id="cfgshared"> 共享连接（重连后生效）</label>
  <label class="cfgrow"><input type="checkbox" id="cfgauto"> 自动重连（异常断开后最多 5 次）</label>
  <div class="cfgrow">
    <span>画质</span><select id="cfgquality"></select>
    <span>压缩</span><select id="cfgzcomp"></select>
    <span style="color:var(--text-muted, #64748b); font-size:10px;">0=最好/最慢 · 即时生效</span>
  </div>
  <div style="display:flex; gap:6px; justify-content:flex-end;">
    <button id="dcbtn">断开</button><button id="rcbtn">重连</button>
  </div>
</div>
<div id="cred" hidden>
  <h3>服务器要求认证</h3>
  <form id="credform">
    <label id="creduserrow" hidden><span>用户名</span><input id="creduser" autocomplete="username"></label>
    <label><span>密码</span><input id="credpass" type="password" autocomplete="current-password"></label>
    <button type="submit">登录</button>
  </form>
</div>
<script type="module">
import RFB from "./core/rfb.js";
import { textToKeys, SHIFT_KEYSYM } from "./common/type-text.js";

var $ = function (id) { return document.getElementById(id); };
var stage = $("stage"), box = $("box");
var MINZ = 0.25, MAXZ = 5;

// ---- 连接参数：query 的 path=<token 前缀>/ws；缺省从 pathname 推导 ----
var qs = new URLSearchParams(location.search);
var wsPath = qs.get("path") || location.pathname.replace(/view\\.html$/, "ws").replace(/^\\/+/, "");
var wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/" + wsPath.replace(/^\\/+/, "");

// ---- 视图状态 ----
var rfb = null, canvas = null;
var fw = 0, fh = 0;            // framebuffer 尺寸
var deg = 0;                   // 旋转角（0/90/180/270）
var zoom = 1;                  // 相对 fit 的倍率
var pan = { x: 0, y: 0 };      // 平移（视觉 px，相对 stage 中心）

function fitScale() { return Math.min(stage.clientWidth / fw, stage.clientHeight / fh); }
function totalScale() { return fitScale() * zoom; }

function relayout() {
  var cw = stage.clientWidth, ch = stage.clientHeight;
  if (!cw || !ch || !fw || !fh) return;
  box.style.width = fw + "px";
  box.style.height = fh + "px";
  box.style.transform = "translate(calc(-50% + " + pan.x + "px), calc(-50% + " + pan.y + "px)) rotate(" + deg + "deg) scale(" + totalScale() + ")";
  $("pct").textContent = Math.round(totalScale() * 100) + "%";
  $("deg").textContent = deg + "\\u00b0";
}
window.addEventListener("resize", relayout);

// ---- 物理(视口)坐标 → framebuffer 坐标：考虑平移/旋转/缩放 ----
function visToFb(clientX, clientY) {
  var sr = stage.getBoundingClientRect();
  var px = clientX - (sr.left + sr.width / 2) - pan.x;
  var py = clientY - (sr.top + sr.height / 2) - pan.y;
  var th = deg * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
  // y-down 坐标系旋转矩阵的逆 = 转置：[cos sin; -sin cos]
  var s = totalScale();
  var qx = (cos * px + sin * py) / s, qy = (-sin * px + cos * py) / s;
  return {
    x: Math.max(0, Math.min(fw - 1, Math.round(fw / 2 + qx))),
    y: Math.max(0, Math.min(fh - 1, Math.round(fh / 2 + qy)))
  };
}

// fb 点渲染到指定物理位置（缩放锚点跟随的核心）
function keepAnchorAt(fx, fy, clientX, clientY) {
  var sr = stage.getBoundingClientRect();
  var th = deg * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
  var ux = fx - fw / 2, uy = fy - fh / 2, s = totalScale();
  pan.x = (clientX - sr.left - sr.width / 2) - (cos * ux - sin * uy) * s;
  pan.y = (clientY - sr.top - sr.height / 2) - (sin * ux + cos * uy) * s;
}

function clampZoom(z) { return Math.min(MAXZ, Math.max(MINZ, z)); }

// ---- 让 noVNC 拿到我们算好的 fb 坐标：patch canvas 的 getBoundingClientRect 为虚拟矩形，
// 之后合成事件带 (clientX=fb.x, clientY=fb.y)，clientToElement 原样返回，absX(scale=1) 直通 ----
function patchCanvasRect() {
  canvas.getBoundingClientRect = function () {
    return { left: 0, top: 0, x: 0, y: 0, right: fw, bottom: fh, width: fw, height: fh, toJSON: function () { return {}; } };
  };
}

// ---- 合成事件派发（不冒泡 + 打 __r 标记：window 捕获层看到后直接放行，避免递归/双份）----
function markSynth(ev) { ev.__r = true; return ev; }
function mouseInit(ev, f) {
  return { clientX: f.x, clientY: f.y, screenX: f.x, screenY: f.y,
    button: ev.button, buttons: ev.buttons, detail: 0, view: window,
    ctrlKey: ev.ctrlKey, altKey: ev.altKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey,
    relatedTarget: null, bubbles: false, cancelable: true };
}
function forwardMouse(type, ev) {
  var f = visToFb(ev.clientX, ev.clientY);
  canvas.dispatchEvent(markSynth(new MouseEvent(type, mouseInit(ev, f))));
}
function forwardWheel(ev) {
  var f = visToFb(ev.clientX, ev.clientY);
  canvas.dispatchEvent(markSynth(new WheelEvent("wheel", { deltaX: ev.deltaX, deltaY: ev.deltaY,
    deltaZ: ev.deltaZ, deltaMode: ev.deltaMode, clientX: f.x, clientY: f.y,
    view: window, bubbles: false, cancelable: true })));
}
var TOUCH_OK = (typeof Touch === "function") && (typeof TouchEvent === "function");
function makeTouch(t) {
  var f = visToFb(t.clientX, t.clientY);
  return new Touch({ identifier: t.identifier, target: canvas,
    clientX: f.x, clientY: f.y, screenX: f.x, screenY: f.y, pageX: f.x, pageY: f.y });
}
function forwardTouches(type, ev) {
  if (!TOUCH_OK) return;
  var changed = [], all = [], i;
  for (i = 0; i < ev.changedTouches.length; i++) changed.push(makeTouch(ev.changedTouches[i]));
  for (i = 0; i < ev.touches.length; i++) all.push(makeTouch(ev.touches[i]));
  try {
    var tev = new TouchEvent(type, { touches: type === "touchend" ? [] : all,
      targetTouches: [], changedTouches: changed, bubbles: false, cancelable: true });
    canvas.dispatchEvent(markSynth(tev));
  } catch (e) { /* 构造失败则放弃该事件 */ }
}

// ---- 双指手势（捏合缩放 + 平移）；单指原样透传给 noVNC ----
// 注意：所有输入拦截都挂 window 捕获层（先于 noVNC 在 canvas 上的原生监听），
// 且一律先检查 __r 标记——我们合成的重映射事件会再走一遍捕获路径，不能二次处理。
var touches = new Map();       // id -> {x,y} 物理坐标
var gesturing = false;         // 手势进行中（吞掉所有触点直到全部抬起）
var g0 = null;                 // 基线 {dist, mx, my, zoom0, fx, fy}
var singleId = null;           // 透传中的那根手指

function pinchInfo() {
  var arr = [], it = touches.values(), r;
  while ((r = it.next()) && !r.done) arr.push(r.value);
  var dx = arr[0].x - arr[1].x, dy = arr[0].y - arr[1].y;
  return { dist: Math.hypot(dx, dy), mx: (arr[0].x + arr[1].x) / 2, my: (arr[0].y + arr[1].y) / 2 };
}
function beginPinch() {
  var p = pinchInfo();
  var f = visToFb(p.mx, p.my);
  g0 = { dist: Math.max(1, p.dist), mx: p.mx, my: p.my, zoom0: zoom, fx: f.x, fy: f.y };
}
function movePinch() {
  var p = pinchInfo();
  zoom = clampZoom(g0.zoom0 * p.dist / g0.dist);
  keepAnchorAt(g0.fx, g0.fy, p.mx, p.my);   // 锚点始终跟住双指中点（含平移）
  relayout();
}

function inStage(e) { return stage.contains(e.target); }
function ready() { return canvas && fw > 0 && fh > 0; }

window.addEventListener("touchstart", function (e) {
  if (e.__r || !inStage(e)) return;
  var i, t;
  for (i = 0; i < e.changedTouches.length; i++) {
    t = e.changedTouches[i];
    touches.set(t.identifier, { x: t.clientX, y: t.clientY });
  }
  if (touches.size >= 2) {
    e.preventDefault(); e.stopPropagation();
    if (!gesturing) {
      gesturing = true;
      // 取消 noVNC 侧第一指的挂起状态（可能已按下左键/进入 drag）
      if (ready() && TOUCH_OK && singleId !== null && touches.has(singleId)) {
        try {
          var cev = new TouchEvent("touchcancel",
            { touches: [], targetTouches: [], changedTouches: [makeTouch({ identifier: singleId, clientX: 0, clientY: 0 })], bubbles: false, cancelable: true });
          canvas.dispatchEvent(markSynth(cev));
        } catch (err) {}
      }
      singleId = null;
      beginPinch();
    }
    return;
  }
  if (gesturing) return;
  if (ready() && TOUCH_OK) {
    e.preventDefault(); e.stopPropagation();
    singleId = e.changedTouches[0].identifier;
    forwardTouches("touchstart", e);
  }
}, { capture: true, passive: false });

window.addEventListener("touchmove", function (e) {
  if (e.__r || !inStage(e)) return;
  var i, t, rec;
  for (i = 0; i < e.changedTouches.length; i++) {
    t = e.changedTouches[i];
    rec = touches.get(t.identifier);
    if (rec) { rec.x = t.clientX; rec.y = t.clientY; }
  }
  if (gesturing) {
    e.preventDefault(); e.stopPropagation();
    if (touches.size >= 2 && g0) movePinch();
    return;
  }
  if (touches.size >= 2) return;
  if (ready() && TOUCH_OK) {
    e.preventDefault(); e.stopPropagation();
    forwardTouches("touchmove", e);
  }
}, { capture: true, passive: false });

function onTouchEnd(e) {
  if (e.__r || !inStage(e)) return;
  var i;
  for (i = 0; i < e.changedTouches.length; i++) touches.delete(e.changedTouches[i].identifier);
  if (gesturing) {
    e.preventDefault(); e.stopPropagation();
    if (touches.size === 0) { gesturing = false; g0 = null; }   // 全部抬手才恢复单指交互
    return;
  }
  if (ready() && TOUCH_OK) {
    e.preventDefault(); e.stopPropagation();
    if (singleId !== null) { singleId = null; }
    forwardTouches(e.type, e);
  }
}
window.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
window.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: false });

// ---- 鼠标：stage 内拦截重映射；按下后拖出 stage 也持续跟踪 ----
var mouseDown = false;
window.addEventListener("mousedown", function (e) {
  if (e.__r || !inStage(e)) return;
  if (!ready()) return;
  e.preventDefault(); e.stopPropagation();
  mouseDown = true;
  forwardMouse("mousedown", e);
}, true);
window.addEventListener("mousemove", function (e) {
  if (e.__r) return;
  if (!mouseDown && !inStage(e)) return;
  if (!ready()) return;
  e.preventDefault(); e.stopPropagation();
  forwardMouse("mousemove", e);
}, true);
window.addEventListener("mouseup", function (e) {
  if (e.__r) return;
  if (!mouseDown && !inStage(e)) return;
  var wasDown = mouseDown;
  mouseDown = false;
  if (!wasDown && !ready()) return;
  e.preventDefault(); e.stopPropagation();
  forwardMouse("mouseup", e);
}, true);
window.addEventListener("contextmenu", function (e) {
  if (e.__r || !inStage(e)) return;
  e.preventDefault(); e.stopPropagation();
}, true);

// ---- 滚轮：Ctrl/⌘+滚轮（触控板捏合也走这里）= 视图缩放；普通滚轮透传给远程 ----
window.addEventListener("wheel", function (e) {
  if (e.__r || !inStage(e)) return;
  if (!ready()) return;
  e.preventDefault(); e.stopPropagation();
  if (e.ctrlKey || e.metaKey) {
    var factor = Math.pow(1.0018, -e.deltaY);
    var f = visToFb(e.clientX, e.clientY);
    zoom = clampZoom(zoom * factor);
    keepAnchorAt(f.x, f.y, e.clientX, e.clientY);
    relayout();
  } else {
    forwardWheel(e);
  }
}, { capture: true, passive: false });

// Safari 页面级捏合屏蔽（由我们的 touch 手势接管）
["gesturestart", "gesturechange", "gestureend"].forEach(function (n) {
  document.addEventListener(n, function (e) { e.preventDefault(); }, { passive: false });
});

// ---- 工具条 ----
$("rot").onclick = function () { deg = (deg + 90) % 360; pan.x = 0; pan.y = 0; relayout(); };
$("zin").onclick = function () { zoom = clampZoom(zoom * 1.25); relayout(); };
$("zout").onclick = function () { zoom = clampZoom(zoom / 1.25); relayout(); };
$("reset").onclick = function () { deg = 0; zoom = 1; pan.x = 0; pan.y = 0; relayout(); };

// ---- 快捷键 / 虚拟键盘 / 系统键盘（公共件：common/*.js，与 RDP 载体共用）----
var vkb = null, scb = null, syskb = null;
// 虚拟键盘 shift 锁存跟踪 + 上档 keysym 直发。
// 为什么不能「按住 Shift + 小写 keysym」：x11vnc 做 keysym→keycode 翻译时按
// “该 keysym 需要的修饰键”规范化——收到小写 q 会先把按住的 Shift 释放再打字
//（打完又恢复），导致 shift 层永远输出小写字母/数字。所以 shift 锁存期间，
// 打印键必须直发上档 keysym（大写字母 / !@# 等），与远端按住的 Shift 自洽。
var VKB_LATCHED = {};
var SHIFT_SYM = {
  Backquote: 0x60, Minus: 0x5f, Equal: 0x2b,
  BracketLeft: 0x7b, BracketRight: 0x7d, Backslash: 0x7c,
  Semicolon: 0x3a, Quote: 0x22, Comma: 0x3c, Period: 0x3e, Slash: 0x3f,
  Digit1: 0x21, Digit2: 0x40, Digit3: 0x23, Digit4: 0x24, Digit5: 0x25,
  Digit6: 0x5e, Digit7: 0x26, Digit8: 0x2a, Digit9: 0x28, Digit0: 0x29
};
function sendCode(code, down) {
  if (!(rfb && connOk)) return;
  var k;
  if (/^(ShiftLeft|ControlLeft|AltLeft|MetaLeft|CapsLock)$/.test(code)) {
    VKB_LATCHED[code] = down;
    k = RemoteKeys.codeToKeysym(code);
  } else if (VKB_LATCHED.ShiftLeft) {
    // 上档字符直发（down/up 必须用同一 keysym，否则 x11vnc 匹配不到释放）
    var m = /^Key([A-Z])$/.exec(code);
    k = m ? m[1].charCodeAt(0) : (SHIFT_SYM[code] || RemoteKeys.codeToKeysym(code));
  } else {
    k = RemoteKeys.codeToKeysym(code);
  }
  if (!k) return;
  try { rfb.sendKey(k, code, down); } catch (e) {}
}
$("vkbb").onclick = function () {
  if (!vkb && typeof VirtualKeyboard !== "undefined") {
    vkb = VirtualKeyboard.mount({ root: "#vkbRoot", onKey: sendCode, onLatch: sendCode });
  }
  if (!vkb) return;
  vkb.toggle();
  this.classList.toggle("on", vkb.isOpen());
};
$("scbb").onclick = function () {
  var el = $("shortcuts");
  if (!scb && typeof ShortcutBar !== "undefined") {
    scb = ShortcutBar.mount({ root: el,
      onPress: function (c) { sendCode(c, true); },
      onRelease: function (c) { sendCode(c, false); } });
  }
  if (!scb) return;
  el.hidden = !el.hidden;
  this.classList.toggle("on", !el.hidden);
};
function onSysKey(ev) {
  if (!(rfb && connOk)) return;
  try {
    if (ev.type === "char") {
      var k = RemoteKeys.charToKeysym(ev.ch);
      rfb.sendKey(k, "", true); rfb.sendKey(k, "", false);
    } else {
      var code = ev.name === "Enter" ? "Enter" : "Backspace";
      var k2 = RemoteKeys.codeToKeysym(code);
      if (k2) { rfb.sendKey(k2, code, true); rfb.sendKey(k2, code, false); }
    }
  } catch (e) {}
}
$("syskbb").onclick = function () {
  if (!syskb && typeof SystemKeyboard !== "undefined") {
    syskb = SystemKeyboard.mount({ onChange: onSysKey });
  }
  if (!syskb) return;
  syskb.toggle();
  this.classList.toggle("on", syskb.isOpen);
};

// ---- 原生 noVNC 控制栏的常用项：剪贴板 / Ctrl+Alt+Del / 全屏 ----
var connOk = false;
// 「获取远程」：经服务端直读目标屏当前剪贴板（远程复制只在内容变化时 push，
// 页面后连接/同内容重拷都收不到 ServerCutText，需要时点此主动拉取）。
var PAGE_TOKEN = (function () {
  var parts = location.pathname.split("/").filter(Boolean);
  var i = parts.indexOf("vnc");
  return (i >= 0 && parts[i + 1]) || "";
})();
var API_BASE = (function () {
  var parts = location.pathname.split("/").filter(Boolean);
  var i = parts.indexOf("aiti-ui-env");
  return i > 0 ? "/" + parts.slice(0, i).join("/") : ""; // basePath 前缀（如 /dev），根部署为空
})();
var clipFetching = false;
// 剪贴板面板内联提示（输入框上方；level: info|ok|warn|err）——本面板的操作用户就在面板边上，
// 结果不再弹顶部状态栏（顶部只留连接状态），否则发完关掉面板/看顶部都不容易注意到。
function setClipMsg(t, level) {
  var el = $("clipmsg");
  if (!t) { el.hidden = true; el.textContent = ""; el.className = ""; return; }
  el.className = level || "info";
  el.textContent = t;
  el.hidden = false;
  el.scrollTop = 0;
}
function fetchRemoteClip(silent) {
  if (clipFetching) return;
  if (!PAGE_TOKEN) { if (!silent) setClipMsg("无法定位实例 token", "err"); return; }
  clipFetching = true;
  if (!silent) setClipMsg("获取远程剪贴板…", "info");
  fetch(API_BASE + "/api/extensions/aiti-ui-env/vnc-clipboard?token=" + encodeURIComponent(PAGE_TOKEN), { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      clipFetching = false;
      if (d && d.ok && typeof d.text === "string") {
        if (d.text) {
          $("cliptext").value = d.text;
          try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(d.text).catch(function () {}); } catch (e) {}
          setClipMsg("已获取远程剪贴板（" + d.text.length + " 字符）", "ok");
        } else if (!silent) setClipMsg("远程剪贴板为空", "warn");
      } else if (!silent) setClipMsg("获取失败：" + ((d && d.error) || "未知错误"), "err");
    })
    .catch(function () { clipFetching = false; if (!silent) setClipMsg("获取失败（网络错误）", "err"); });
}
$("clipbtn").onclick = function () {
  var clip = $("clip");
  clip.hidden = !clip.hidden;
  if (!clip.hidden) {
    $("cliptext").focus();
    if (!$("cliptext").value) fetchRemoteClip(true); // 打开面板静默拉取一次（textarea 已有编辑内容不覆盖）
  }
};
$("clipclose").onclick = function () { $("clip").hidden = true; };
$("clipfetch").onclick = function () { fetchRemoteClip(false); };
// 「发送到远程」：优先服务端直写（本机 X/系统剪贴板：Unicode 安全、无 x11vnc selwin 8s 窗口、
// QEMU 等无 X 目标明确报错）；失败回退 noVNC 协议通道（远程主机只有这条路；服务器未声明扩展
// 剪贴板时非 ASCII 会变 '?'）。两者都给明确状态（旧版静默无提示 = 失败无从知晓）。
var clipSending = false;
function sendViaVnc(reason) {
  if (rfb && connOk) {
    try { rfb.clipboardPasteFrom($("cliptext").value); } catch (e) {}
    setClipMsg("已通过 VNC 协议发送（" + reason + "）；远程粘不到就改用下面的「⌨ 输入到远程」", "warn");
  } else {
    setClipMsg("发送失败：" + reason, "err");
  }
}
function sendRemoteClip() {
  if (clipSending) return;
  var text = $("cliptext").value;
  if (!text) { setClipMsg("剪贴板为空", "warn"); return; }
  if (!PAGE_TOKEN) { sendViaVnc("无法定位实例 token"); return; }
  clipSending = true;
  setClipMsg("发送中…", "info");
  fetch(API_BASE + "/api/extensions/aiti-ui-env/vnc-clipboard?token=" + encodeURIComponent(PAGE_TOKEN), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text }), cache: "no-store",
  }).then(function (r) { return r.json(); }).then(function (d) {
    clipSending = false;
    if (d && d.ok) { setClipMsg("已发送到远程剪贴板（" + text.length + " 字符）——在远程 Ctrl+V 粘贴", "ok"); return; }
    sendViaVnc((d && d.error) || "服务端不能直写");
  }).catch(function () { clipSending = false; sendViaVnc("网络错误"); });
}
$("clipsend").onclick = sendRemoteClip;

// 「输入到远程」：文本拆成键盘事件逐字发送（VNC 剪贴板不可用时的兜底，任何 VNC 服务端都支持）。
// 映射表在 common/type-text.js（US 布局 ASCII；中文/emoji 无法映射 → 跳过并计数）。再点一次 = 停止。
// 节奏：50ms/键（约 20 键/s；慢虚拟机 TCG 下不丢键），Enter 后多停 150ms 让远端处理。
var typing = null, TYPE_INTERVAL = 50, TYPE_ENTER_EXTRA = 150;
function typeRemoteClip() {
  var btn = $("cliptype");
  if (typing) { typing.stop = true; setClipMsg("停止输入…", "warn"); return; }
  if (!rfb || !connOk) { setClipMsg("未连接，无法输入", "err"); return; }
  if (cfg.viewOnly) { setClipMsg("仅观看模式不能输入（设置里关闭「仅观看」）", "warn"); return; }
  var text = $("cliptext").value;
  if (!text) { setClipMsg("剪贴板为空", "warn"); return; }
  var mapped = textToKeys(text);
  var keys = mapped.keys;
  if (!keys.length) { setClipMsg("没有可键入的 ASCII 字符（中文/emoji 需远程输入法）", "warn"); return; }
  var i = 0;
  typing = { stop: false };
  btn.classList.add("on");
  btn.textContent = "停止输入";
  function end() {
    try { if (rfb && connOk) rfb.sendKey(SHIFT_KEYSYM, "ShiftLeft", false); } catch (e) {} // 防 Shift 卡住
    var done = i, stopped = !!(typing && typing.stop);
    typing = null;
    btn.classList.remove("on");
    btn.textContent = "输入到远程";
    setClipMsg((stopped ? "已停止输入 " : "已键入 ") + done + "/" + keys.length + " 键" +
      (mapped.skipped ? "（跳过 " + mapped.skipped + " 个非 ASCII）" : ""), stopped ? "warn" : "ok");
  }
  function step() {
    if (!typing || typing.stop || i >= keys.length) { end(); return; }
    var k = keys[i++];
    try {
      if (k.shift) rfb.sendKey(SHIFT_KEYSYM, "ShiftLeft", true);
      rfb.sendKey(k.keysym, k.code, true);
      rfb.sendKey(k.keysym, k.code, false);
      if (k.shift) rfb.sendKey(SHIFT_KEYSYM, "ShiftLeft", false);
    } catch (e) {}
    setClipMsg("输入到远程 " + i + "/" + keys.length + (mapped.skipped ? "（跳过 " + mapped.skipped + " 个非 ASCII）" : ""), "info");
    setTimeout(step, k.code === "Enter" ? TYPE_INTERVAL + TYPE_ENTER_EXTRA : TYPE_INTERVAL);
  }
  setClipMsg("输入到远程 0/" + keys.length + "…", "info");
  step();
}
$("cliptype").onclick = typeRemoteClip;
$("cad").onclick = function () {
  if (rfb && connOk) { try { rfb.sendCtrlAltDel(); } catch (e) {} }
};
$("fs").onclick = function () {
  if (document.fullscreenElement) { document.exitFullscreen(); }
  else if (document.documentElement.requestFullscreen) { document.documentElement.requestFullscreen(); }
};

// ---- 设置（localStorage 持久化；仅观看/画质/压缩即时生效，共享模式重连生效）----
var CFG_KEY = "vncview-cfg";
var cfg = { viewOnly: false, shared: true, autoReconnect: true, quality: -1, compression: -1 };
try { var saved = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); for (var k in cfg) if (saved[k] !== undefined) cfg[k] = saved[k]; } catch (e) {}
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }
function applyLiveCfg() {
  if (!rfb || !connOk) return;
  try {
    rfb.viewOnly = !!cfg.viewOnly;
    if (cfg.quality >= 0) rfb.qualityLevel = cfg.quality;
    if (cfg.compression >= 0) rfb.compressionLevel = cfg.compression;
  } catch (e) {}
}
$("cfgbtn").onclick = function () { $("settings").hidden = !$("settings").hidden; };
$("cfgclose").onclick = function () { $("settings").hidden = true; };
$("cfgview").onchange = function () { cfg.viewOnly = this.checked; saveCfg(); applyLiveCfg(); };
$("cfgshared").onchange = function () { cfg.shared = this.checked; saveCfg(); };
$("cfgauto").onchange = function () { cfg.autoReconnect = this.checked; saveCfg(); };
(function initCfgUI() {
  $("cfgview").checked = cfg.viewOnly; $("cfgshared").checked = cfg.shared; $("cfgauto").checked = cfg.autoReconnect;
  var q = $("cfgquality"), c = $("cfgzcomp");
  q.appendChild(new Option("默认", "-1")); c.appendChild(new Option("默认", "-1"));
  for (var i = 0; i <= 9; i++) { q.appendChild(new Option(String(i), String(i))); c.appendChild(new Option(String(i), String(i))); }
  q.value = String(cfg.quality); c.value = String(cfg.compression);
  q.onchange = function () { cfg.quality = parseInt(this.value, 10); saveCfg(); applyLiveCfg(); };
  c.onchange = function () { cfg.compression = parseInt(this.value, 10); saveCfg(); applyLiveCfg(); };
})();

// ---- 连接 / 自动重连（事件触发、有界重试；代际号隔离旧实例事件）----
function setStatus(t) { $("status").textContent = t; }
var MAX_RETRY = 5, retryLeft = MAX_RETRY, wantClose = false, connGen = 0, ro = null, rfbLive = false;
// ---- 凭据（模块级：savedCreds 跨重连存活；submit 只绑一次） ----
// 对齐 noVNC 官方 credentials 面板：按事件 detail.types 显隐 username/password（密码遮蔽）。
// macOS 屏幕共享走 ARD auth 要用户名+密码；标准 VNC auth 只要密码。表单是唯一认证入口。
var savedCreds = null; // 登录用过的密码；自动重连再被要求时直接复用；securityfailure 即弃
function askCreds(types) {
  var needUser = types.indexOf("username") !== -1;
  $("creduserrow").hidden = !needUser;
  $("credpass").value = "";
  setTimeout(function () { $(needUser ? "creduser" : "credpass").focus(); }, 80);
  $("cred").hidden = false;
  setStatus("服务器要求认证");
}
$("credform").addEventListener("submit", function (e) {
  e.preventDefault();
  if (!rfb || !rfbLive) return;
  var needUser = !$("creduserrow").hidden;
  var creds = { username: $("creduser").value, password: $("credpass").value };
  $("credpass").value = "";
  $("cred").hidden = true;
  savedCreds = creds;
  try { rfb.sendCredentials(needUser ? creds : { password: creds.password }); } catch (err) {}
  setStatus("认证中…");
});

function connect() {
  connGen++;
  var gen = connGen;
  try { if (rfb && rfbLive) rfb.disconnect(); } catch (e) {}
  rfbLive = false;
  while (box.firstChild) box.removeChild(box.firstChild);
  connOk = false; canvas = null; fw = 0; fh = 0;
  if (ro) { ro.disconnect(); ro = null; }
  try {
    rfb = new RFB(box, wsUrl, { shared: !!cfg.shared });
  } catch (err) { rfb = null; setStatus("初始化失败：" + err); return; }
  rfb.scaleViewport = false;
  rfb.resizeSession = false;
  rfb.viewOnly = !!cfg.viewOnly;
  rfbLive = true;
  canvas = box.querySelector("canvas");
  patchCanvasRect();
  // framebuffer 尺寸变化（连接建立/远程改分辨率）→ 事件驱动重排
  ro = new ResizeObserver(function () {
    if (gen !== connGen || !canvas) return;
    if (canvas.width && canvas.height && (canvas.width !== fw || canvas.height !== fh)) {
      fw = canvas.width; fh = canvas.height;
      relayout();
    }
  });
  ro.observe(canvas);

  rfb.addEventListener("connect", function () {
    if (gen !== connGen) return;
    connOk = true; retryLeft = MAX_RETRY; applyLiveCfg(); setStatus("已连接"); relayout();
  });
  rfb.addEventListener("disconnect", function (e) {
    if (gen !== connGen) return;
    connOk = false; rfbLive = false;
    var clean = e.detail && e.detail.clean;
    if (wantClose) { wantClose = false; setStatus("已断开"); return; }
    if (cfg.autoReconnect && retryLeft > 0) {
      retryLeft--;
      var delay = 1500 + (MAX_RETRY - retryLeft) * 1000;
      setStatus("连接断开，" + Math.round(delay / 1000) + "s 后重连…（剩余 " + retryLeft + " 次）");
      setTimeout(connect, delay);
    } else {
      setStatus(clean ? "已断开" : "连接断开（异常）");
    }
  });
  // 远端剪贴板变化 → 显示在剪贴板面板 + 尽力写入本地系统剪贴板（免开面板即可本地 Ctrl+V）；
  // 非安全上下文/未获焦点/权限拒绝时 writeText 会 reject，静默降级为「面板可见」。
  rfb.addEventListener("clipboard", function (e) {
    if (gen !== connGen) return;
    var text = (e.detail && e.detail.text) || "";
    $("cliptext").value = text;
    if (text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {});
      } catch (err) {}
    }
  });
  // 凭据：对齐 noVNC 官方 credentials 面板——按事件 detail.types 显隐 username/password（密码遮蔽）；
  // askCreds/savedCreds/表单提交均为模块级（见 connect 之前）
  rfb.addEventListener("credentialsrequired", function (e) {
    if (gen !== connGen) return;
    var types = (e.detail && e.detail.types) || ["password"];
    // 自动重连复用上次凭据（官方 reconnectPassword 同语义）；失败后已由 securityfailure 清除
    if (savedCreds && savedCreds.password) {
      try {
        rfb.sendCredentials(types.indexOf("username") !== -1 ? savedCreds : { password: savedCreds.password });
        setStatus("认证中…");
        return;
      } catch (err) {}
    }
    askCreds(types);
  });
  rfb.addEventListener("securityfailure", function (e) {
    if (gen !== connGen) return;
    savedCreds = null; // 密码错/认证失败：弃用记住的凭据，重连后重新询问
    $("cred").hidden = true;
    setStatus("安全失败：" + ((e.detail && e.detail.reason) || "未知原因"));
  });
}
connect();
$("rcbtn").onclick = function () { retryLeft = MAX_RETRY; setStatus("重连中…"); connect(); };
$("dcbtn").onclick = function () { wantClose = true; if (rfb && rfbLive) { try { rfb.disconnect(); } catch (e) {} } else { setStatus("已断开"); } };
</script>
</body>
</html>`;

// 跨 reload 单例：管理模式状态（VNC 裸起进程记录等）在 globalThis。
// 与 aiti-devtools 的桥单例同模式；区别：key 带 LIB_VERSION——代码更新后 reload
// 即换新实例（桥是 configDir key 保 SSE，我们保 VNC pid 的价值 < 迭代便利，弃旧迎新）。
// env 模块引用直接用 closure 的 env（jiti 可能对 env.ts 有内部 transpile cache，
//   用 g[key]=env 会取到旧缓存 → 函数缺失；直接用 closure env 保证最新版）。
function manager(): typeof env {
  const g = globalThis as Record<string, any>;
  const key = `__aitiUiEnv_${(env as any).LIB_VERSION || "dev"}`;
  if (!g[key]) g[key] = env;
  return env; // 始终返回 closure 的 env（最新版）
}

// legacy（systemd 服务模式固定 5900/6080）探活缓存：middleware 查表失败时用 fetch（无 ss 依赖）；
// Node runtime 模块级状态跨请求保留（Next middleware bundle 单例）。
// 实例令牌轮换定时器（startup 拉起，shutdown 清；unref 不阻塞进程）
let rotateTimer: ReturnType<typeof setInterval> | null = null;
export default {
  id: "aiti-ui-env",
  name: "UI 环境（桌面/无头虚拟屏）",
  version: "0.1.0",
  icon: "icon.svg",
  client: "dist/aiti-ui-env-client.mjs",

  // 功能管理（extman 逐项启停）：behavior.* 由代码自查，tool.* 由 core 自动过滤+execute 包装
  features: [
    { id: "behavior.vnc", label: "VNC-on-web", group: "虚拟屏行为", default: true,
      description: "虚拟屏带 x11vnc + node vnc-bridge/noVNC，可在浏览器查看/操作虚拟桌面" },
    { id: "behavior.atspi", label: "AT-SPI 语义总线", group: "虚拟屏行为", default: true,
      description: "虚拟屏环境注入 GTK/Qt a11y 开关（语义树可见，供 cua.ai 等独立扩展）" },
    { id: "behavior.autostart-headless", label: "虚拟屏未运行时自动拉起", group: "虚拟屏行为", default: false,
      description: "resolve/run 时虚拟屏未启动→自动拉起 Xvfb+openbox（systemd 或裸进程）" },
    { id: "behavior.random-display", label: "DISPLAY 随机避让", group: "虚拟屏行为", default: true,
      description: "启动虚拟屏自动选空闲 DISPLAY 号（auto 随机，避免固定 :99 被占冲突）；关闭则固定用面板配置/默认号" },
    // ── agent 工具 ──
    { id: "tool.ui_env_status", label: "ui_env_status · 环境状态", group: "agent 工具", default: true,
      description: "报告当前模式、桌面/虚拟屏探测、VNC 链接、安装状态" },
    { id: "tool.ui_env_set_mode", label: "ui_env_set_mode · 切换模式", group: "agent 工具", default: true,
      description: "切换显示模式（1优先桌面/2优先无头/3总是桌面/4总是无头），对新启动的 MCP/应用生效" },
    { id: "tool.ui_env_resolve", label: "ui_env_resolve · 生成启动环境", group: "agent 工具", default: true,
      description: "按当前模式裁决目标屏，返回环境变量 JSON + export 行（给应用/MCP 启动器）" },
    { id: "tool.ui_env_run", label: "ui_env_run · 代启动应用/MCP", group: "agent 工具", default: true,
      description: "用裁决后的环境启动命令（后台运行），返回 pid/目标屏/日志文件" },
    { id: "tool.ui_env_headless", label: "ui_env_headless · 虚拟屏启停/查询", group: "agent 工具", default: true,
      description: "启动/停止/查询无头虚拟屏（Xvfb+openbox+dbus+AT-SPI）；start 幂等，stop 仅虚拟屏相关不碰真实桌面" },
    { id: "tool.ui_env_deps", label: "ui_env_deps · 依赖自检/安装", group: "agent 工具", default: true,
      description: "自检/自动安装虚拟屏依赖组件（多发行版自适应）；action=check 只自检，install 需免密 sudo" },
    { id: "tool.ui_env_vnc", label: "ui_env_vnc · VNC 查看/启停", group: "agent 工具", default: true,
      description: "查询/启动/停止 VNC-on-web（浏览器看虚拟桌面的地址）" },
    // ── RDP ──
    { id: "behavior.rdp", label: "RDP-on-web", group: "远程桌面行为", default: true,
      description: "webRDP：通过 rdp-bridge 把 RDP 协议经 WebSocket 透传到浏览器（需 webRDP 静态资源 + 目标 RDP 服务器）" },
    { id: "tool.ui_env_rdp", label: "ui_env_rdp · RDP 查看/启停", group: "agent 工具", default: true,
      description: "探测系统 RDP（xrdp）、启动/停止 RDP-on-web 桥、获取访问 URL" },
    { id: "agentTools.enabled", type: "boolean", label: "AI 工具（UI 环境）", group: "AI", default: false,
      description: "会话内注入 ui_env_* 工具（默认关；需要时经 aiti-helper 帮助点（🤖）临时启用，或扩展管理器开启）" },
  ],

  // AI 自管理清单：AI 能帮我判断用哪种显示模式 / 排查环境
  ai: {
    manage: true,
    intro: "AI 能帮我判断用哪种显示模式（桌面/无头虚拟屏）、分析环境状态",
    skills: "skills",
  },

  ui: {
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    // id 与 client 注册对齐（ui-env-toolbar——原 ui-env 为历史错位，M1 审计发现）
    toolbar: [{ id: "ui-env-toolbar", label: "显示环境", title: "UI 环境管理：桌面/无头虚拟屏 + VNC-on-web", icon: "icons/monitor.svg" }],
    // aiti-float dock v3：停靠槽静态声明（懒扩展物化触发 + 静态入口；id 与 client 注册一致）
    rightFileDock: [{ id: "panel", label: "显示环境" }],
    dialogs: [{ id: "ui-env-dialog", label: "显示环境管理" }],
    i18n: {
      en: {
        "uiEnv.title": "Display environment",
        "uiEnv.open": "Display env",
        "uiEnv.modeTitle": "Mode (applies to newly started MCP / apps)",
        "uiEnv.close": "Close",
      },
      "zh-CN": {
        "uiEnv.title": "UI 环境（桌面/无头虚拟屏）",
        "uiEnv.open": "显示环境",
        "uiEnv.modeTitle": "显示模式（作用于新启动的 MCP / 应用）",
        "uiEnv.close": "关闭",
      },
    },
  },

  server: {
    startup(ctx) {
      const m = manager();
      m.setDataDir((ctx && ctx.configDir) || "");
      // lazy migrate（数据分层双保险）：旧根级可再生物 → cache/（下载物/日志/实例态；同盘 rename 瞬时）
      try {
        const fsm = require("node:fs");
        // 数据分层（三目录对称 2026-09-13）：configDir = <extRoot>/config，旧根级可再生物在 <extRoot>/ 下
        const extRoot = pathDirname(m.getDataDir());
        for (const rel of ["novnc", "grdpwasm", "webRDP", "logs", "ultravnc", "view-common"]) {
          const from = pathJoin(extRoot, rel), to = pathJoin(extRoot, "cache", rel);
          if (!fsm.existsSync(from) || fsm.existsSync(to)) continue;
          fsm.mkdirSync(pathJoin(extRoot, "cache"), { recursive: true });
          fsm.renameSync(from, to);
        }
      } catch { /* 不阻塞启动 */ }
      try { env.setFeatureSource((ctx as any)?.features); } catch {} // DI 方案 P1
      // 存量实例补发令牌（迁移：旧实例无 token）
      try { m.ensureInstanceTokens("vnc"); m.ensureInstanceTokens("rdp"); } catch { /* 迁移失败不致命 */ }
      // 实例令牌定期轮换（真随机防碰撞；旧令牌 prevToken 宽限一个周期，已开页面不立即失效）
      const rotateMs = Number(process.env.UI_ENV_TOKEN_ROTATE_MS || 30 * 60 * 1000);
      if (!rotateTimer) {
        rotateTimer = setInterval(() => {
          try {
            const n = m.rotateInstanceTokens("vnc") + m.rotateInstanceTokens("rdp");
            if (n) console.log(`[aiti-ui-env] 实例令牌轮换 ${n} 个`);
          } catch { /* 轮换失败不影响 */ }
          // 顺带清理死实例（复用既有维护周期，不新增轮询）：断桥/死进程残留不占列表
          m.vncPrune().catch(() => {});
          m.rdpPrune().catch(() => {});
        }, rotateMs);
        if ((rotateTimer as any).unref) (rotateTimer as any).unref();
      }
      // 重启后清理死实例（进程被杀但注册表残留 → middleware 代理到死端口 500）
      m.vncPrune().then((n) => {
        if (n) console.log(`[aiti-ui-env] startup 清理 ${n} 个死 VNC 实例`);
      }).catch(() => {});
      m.rdpPrune().then((n) => {
        if (n) console.log(`[aiti-ui-env] startup 清理 ${n} 个死 RDP 实例`);
      }).catch(() => {});
      console.log(`[aiti-ui-env] 就绪。当前模式：${m.loadMode()}（UI_ENV_MODE 可覆盖）`);
    },
    shutdown() {
      if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
      // globalThis 单例保留（同 bridge 模式）；模块级引用清空不影响已拉起的子进程
    },

    // /api/extensions/aiti-ui-env/<path>
    async api(req, ctx) {
      const m = manager();
      const p = (ctx.path || []).filter(Boolean);
      const action = p[0];

      if (action === "status") {
        const refresh = ctx.searchParams.get("refresh") === "1";
        const probes = await m.probeAll(refresh);
        const vnc = await m.vncStatus();
        const install = await m.installStatus().catch(() => null);
        const mode = m.loadMode();
        // VNC 公开 URL：客户端基于 apiUrl 推导 basePath 生成（无新端口/域名，经 middleware 代理）；
        // 服务端只提供 token + 内部状态。
        return json({
          mode,
          modes: env.MODES,
          target: await m.resolve(undefined, refresh).then((r) => ({ rationale: r.rationale, warnings: r.warnings })),
          desktop: probes.desktop,
          headless: probes.headless,
          vnc: { ...vnc, external: true },
          rdp: await m.rdpStatus(),
          install,
          features: {
            vnc: m.featureEnabled("behavior.vnc"),
            atspi: m.featureEnabled("behavior.atspi"),
            autostart: m.featureEnabled("behavior.autostart-headless"),
          },
          envOverrides: {
            UI_ENV_MODE: process.env.UI_ENV_MODE || null,
            UI_ENV_DISPLAY_NUM: process.env.UI_ENV_DISPLAY_NUM || null,
            UI_ENV_RESOLUTION: process.env.UI_ENV_RESOLUTION || null,
          },
          displayConfig: m.loadDisplayConfig(),
          randomDisplayFeature: m.featureEnabled("behavior.random-display"),
        });
      }

      // DISPLAY 号配置：GET 读；POST {mode, num} 写（默认 auto 随机，可指定固定数字）
      if (action === "display-config") {
        if (req.method === "POST") {
          const body = await parseBody(req);
          const cfg = m.saveDisplayConfig({ mode: String(body.mode || "auto"), num: body.num });
          return json({ ok: true, config: cfg, note: "已保存。下次启动虚拟屏生效（当前运行中的不受影响）" });
        }
        return json({ ok: true, config: m.loadDisplayConfig(), randomDisplayFeature: m.featureEnabled("behavior.random-display") });
      }

      if (action === "set-mode" && req.method === "POST") {
        const body = await parseBody(req);
        const mode = String(body.mode || "");
        if (!env.MODES.some((x) => x.id === mode)) return json({ ok: false, error: "mode 必须是 " + env.MODES.map((x) => x.id).join(" / ") }, 400);
        m.saveMode(mode as env.UeMode);
        return json({ ok: true, mode: m.loadMode(), note: "即时生效，作用于下一次启动（resolve/run/CLI）" });
      }

      // 手动拉起无头虚拟屏：POST /headless {action:start} 启动；GET /headless 查状态。
      // 与 resolve 自动拉起同一条 ensureHeadless 链路（systemd user → system 级 → 裸拉起 Xvfb+openbox+dbus+AT-SPI）。
      if (action === "headless") {
        if (req.method === "POST") {
          const body = await parseBody(req);
          const act = String(body.action || "start");
          if (act === "start") return json(await m.startHeadless());
          if (act === "stop") return json(await m.stopHeadless());
          if (act === "status") {
            const p = await m.probeAll(false);
            return json({ ok: p.headless.available, available: p.headless.available, error: p.headless.error });
          }
          return json({ ok: false, error: "action 只能是 start|stop|status" }, 400);
        }
        const p = await m.probeAll(false);
        return json({ ok: p.headless.available, available: p.headless.available, error: p.headless.error });
      }

      if (action === "resolve") {
        const prefer = (req.method === "POST" ? (await parseBody(req)).prefer : ctx.searchParams.get("prefer")) || undefined;
        const refresh = (req.method === "POST" ? false : ctx.searchParams.get("refresh") === "1");
        if (prefer && !["desktop", "headless"].includes(prefer)) return json({ ok: false, error: "prefer 只能是 desktop|headless" }, 400);
        const r = await m.resolve(prefer as env.UeTarget | undefined, refresh);
        return json(r, r.ok ? 200 : 409);
      }

      if (action === "run" && req.method === "POST") {
        const body = await parseBody(req);
        const cmd = String(body.cmd || "").trim();
        if (!cmd) return json({ ok: false, error: "需要 cmd（要启动的完整命令）" }, 400);
        const r = await m.run(cmd, { prefer: body.prefer, env: body.env || undefined });
        return json(r, r.ok ? 200 : 409);
      }

      if (action === "vnc") {
        if (req.method === "POST") {
          const body = await parseBody(req);
          const act = String(body.action || "status");
          if (act === "list") return json({ ok: true, instances: await m.vncList() });
          if (act === "sys-scan") return json({ ok: true, sysVnc: await m.systemVncScan() });
          if (act === "sys-open") {
            const port = Number(body.port);
            // 外部 VNC：host 可选（缺省本机）；本机用 ss 探活，远程用 TCP 探测
            const host = (body.host ? String(body.host).trim() : "") || "127.0.0.1";
            const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
            if (!Number.isFinite(port) || port <= 0) return json({ ok: false, error: "需要有效的 port" }, 400);
            const reachable = local ? await m.portListening(port) : await m.tcpReachable(host, port);
            if (!reachable) return json({ ok: false, error: `目标 ${host}:${port} 端口无监听（系统 VNC 可能未运行或处于 -loop 等待），无法连接` }, 400);
            try {
              const inst = await m.vncCreate("sys-" + Date.now().toString(36), 0, {
                sysPort: port, sysHost: host, sysLabel: String(body.label || (local ? "sys" : `${host}:${port}`)),
              });
              return json({ ok: true, inst: { id: inst.id, rfbPort: inst.rfbPort, webPort: inst.webPort, sys: inst.sys } });
            } catch (e) { return json({ ok: false, error: "打开失败：" + String((e as Error).message) }, 400); }
          }
          if (act === "sys-stop") {
            const pid = Number(body.pid);
            if (!Number.isFinite(pid) || pid <= 0) return json({ ok: false, error: "需要 pid" }, 400);
            try { process.kill(pid, "SIGTERM"); return json({ ok: true, message: "已向系统 VNC 进程发送停止信号" }); }
            catch (e) { return json({ ok: false, error: "停止失败（可能无权限）：" + String((e as Error).message) }, 400); }
          }
          if (!["start", "stop", "status"].includes(act)) return json({ ok: false, error: "action 只能是 start|stop|status|list|sys-scan|sys-open|sys-stop" }, 400);
          // start = 默认/指定实例（随机端口）；stop {id} 停指定；多实例用重复 start（首实例 id=default，其后自动新实例）
          const r = await m.vncAction(act as "start" | "stop" | "status", {
            id: body.id ? String(body.id) : undefined,
            displayNum: body.displayNum ? Number(body.displayNum) : undefined,
          });
          return json(r);
        }
        return json(await m.vncStatus());
      }

      // 剪贴板直读/直写（view.html「获取远程 / 发送到远程」按钮）：
      // GET  = 读目标当前剪贴板（VNC 剪贴板「变化才 push」，页面后连接/同内容重拷收不到 → 主动拉）；
      // POST = 写目标剪贴板 {text}（本机 X/系统剪贴板直写，Unicode 安全；目标非本机时带诊断错误，
      //        客户端据此回退 VNC 协议通道）。Linux=xclip，Win=Set-Clipboard，mac=pbcopy。
      if (action === "vnc-clipboard") {
        const key = ctx.searchParams.get("token") || ctx.searchParams.get("id") || "";
        if (req.method === "POST") {
          const body = await parseBody(req);
          return json(await m.vncClipboardWrite(key, String(body.text ?? body.value ?? "")));
        }
        return json(await m.vncClipboardRead(key));
      }

      // VNC 会话：发 HttpOnly cookie（30min，HMAC 签名）——URL 无任何凭据，刷新/重复打开可用；
      // 复制到其他机器无 cookie 直接 403（防泄露/防跳板）。middleware + vnc-bridge 双层校验。
      // ⚠ cookie Path 用 /（全站）：Next route handler 的 req.url 已被剥掉 basePath（如 /dev），
      //   固定 Path=/aiti-ui-env/vnc 在带 basePath 的实例下浏览器不发送 cookie（Path 前缀不匹配）→ 403。
      //   安全：HttpOnly（JS 不可读）+ SameSite=Strict（跨站不发）+ 30min，仅 VNC 路径校验，无风险面扩大。
      if (action === "vnc-session" && req.method === "POST") {
        const sess = m.makeVncSession();
        const headers = {
          "content-type": "application/json",
          "cache-control": "no-store",
          "set-cookie": `ui_env_vnc=${sess}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(env.VNC_SESSION_TTL_MS / 1000)}`,
        };
        // 返回目标实例的真随机令牌：URL 路径段 = token，代表该实例/端口（不落目标地址）。
        // ?id=<实例id> 指定实例（缺省=默认/首个）；path 相对站点根（客户端补 basePath）。
        const wantId = ctx.searchParams.get("id") || undefined;
        const inst = wantId ? m.vncInstanceSync(wantId) : (m.vncInstances()[0] || null);
        const token = inst?.token || "";
        // 统一前缀：查看页与 WS 都在 <token>/ 实例前缀下（页内相对资源自动同前缀，路由零歧义）
        const wsPath = "aiti-ui-env/vnc/" + token + "/ws";
        const path = "/aiti-ui-env/vnc/" + token + "/vnc.html?autoconnect=true&resize=scale&path=" + encodeURIComponent(wsPath);
        return new Response(JSON.stringify({ ok: true, path, token, ttlS: Math.round(env.VNC_SESSION_TTL_MS / 1000) }), { status: 200, headers });
      }

      // RDP-on-web：探测系统 RDP（xrdp）/ 起桥 / 停止
      if (action === "rdp") {
        if (req.method === "POST") {
          const body = await parseBody(req);
          const act = String(body.action || "status");
          if (act === "list") return json({ ok: true, instances: await m.rdpList() });
          if (act === "sys-scan") return json({ ok: true, sysRdp: await m.systemRdpScan() });
          if (act === "sys-open") {
            const port = Number(body.port);
            if (!Number.isFinite(port) || port <= 0) return json({ ok: false, error: "需要有效的 port" }, 400);
            if (!(await m.portListening(port))) return json({ ok: false, error: `目标端口 ${port} 无监听，无法连接` }, 400);
            try {
              const inst = await m.rdpCreate("sys-" + Date.now().toString(36), "127.0.0.1", 0, { sysPort: port, sysLabel: String(body.label || "sys") });
              return json({ ok: true, inst: { id: inst.id, port: inst.port, webPort: inst.webPort, sys: inst.sys } });
            } catch (e) { return json({ ok: false, error: "打开失败：" + String((e as Error).message) }, 400); }
          }
          if (act === "sys-stop") {
            const pid = Number(body.pid);
            if (!Number.isFinite(pid) || pid <= 0) return json({ ok: false, error: "需要 pid" }, 400);
            try { process.kill(pid, "SIGTERM"); return json({ ok: true, message: "已向系统 RDP 进程发送停止信号" }); }
            catch (e) { return json({ ok: false, error: "停止失败（可能无权限）：" + String((e as Error).message) }, 400); }
          }
          if (act === "start") {
            let host = String(body.host || "").trim();
            let port = Number(body.port || 0);
            // 允许 host 直接写 "host:port"（如 127.0.0.1:3389），拆开解析
            if (host.includes(":")) {
              const t = parseRdpTarget(host, 3389);
              if (!t) return json({ ok: false, error: "host 无效：应为 host 或 host:port（如 127.0.0.1:3389）" }, 400);
              host = t.host;
              if (!port) port = t.port;
            }
            if (!host) host = "127.0.0.1"; // 只传 port 时默认本机
            if (!Number.isFinite(port) || port <= 0) port = 3389;
            try {
              const r = await m.rdpAction("start", {
                id: body.id ? String(body.id) : undefined, host, port,
                sysPort: body.sysPort ? Number(body.sysPort) : undefined,
                sysLabel: body.sysLabel ? String(body.sysLabel) : undefined,
              });
              return json(r);
            } catch (e) { return json({ ok: false, error: "启动失败：" + String((e as Error).message) }, 500); }
          }
          if (!["start", "stop", "status", "list"].includes(act)) return json({ ok: false, error: "action 只能是 start|stop|status|list|sys-scan|sys-open|sys-stop" }, 400);
          const r = await m.rdpAction(act as "start" | "stop" | "status" | "list", {
            id: body.id ? String(body.id) : undefined,
            host: body.host ? String(body.host) : undefined,
            port: body.port ? Number(body.port) : undefined,
          });
          return json(r);
        }
        return json(await m.rdpStatus());
      }

      // RDP 会话：发 HttpOnly cookie（30min，HMAC 签名）——与 VNC 同模式；
      // 返回实例真随机令牌（URL 路径段 = token，代表该实例/端口，不落目标地址）。
      if (action === "rdp-session" && req.method === "POST") {
        const sess = m.makeRdpSession();
        const headers = {
          "content-type": "application/json",
          "cache-control": "no-store",
          "set-cookie": `ui_env_rdp=${sess}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(env.RDP_SESSION_TTL_MS / 1000)}`,
        };
        const wantId = ctx.searchParams.get("id") || undefined;
        const inst = wantId ? m.rdpInstanceSync(wantId) : (m.rdpInstances()[0] || null);
        const token = inst?.token || "";
        const pagePath = token ? "/aiti-ui-env/rdp/" + token + "/index.html" : "/aiti-ui-env/rdp/index.html";
        return new Response(JSON.stringify({ ok: true, path: pagePath, token, ttlS: Math.round(env.RDP_SESSION_TTL_MS / 1000) }), { status: 200, headers });
      }

      if (action === "install-status") {
        return json(await m.installStatus().catch(() => null));
      }

      // 依赖自检/自动安装（多 OS）：GET /deps = 自检；POST /deps {action:install} = 自动安装
      if (action === "deps") {
        if (req.method === "POST") {
          const body = await parseBody(req);
          if (String(body.action || "") === "install") return json(await m.installDeps());
        }
        return json(await m.checkDeps(true));
      }

      // VNC 密码（自管 winvnc / 系统 VNC server）：GET 查自管密码是否已设；POST {password, id?} 重设
      // （id 缺省 = 自动选：Windows 自管 + 系统版；Linux = 首个可重设的系统 VNC）
      if (action === "vnc-password") {
        if (req.method === "POST") {
          const body = await parseBody(req);
          const r = await m.resetVncPassword(String(body.password || ""), { id: body.id ? String(body.id) : undefined });
          return json(r, r.ok ? 200 : 400);
        }
        const set = !!m.vncPassword();
        return json({ set, hint: set ? undefined : "尚未设置 VNC 密码（Windows 自管 winvnc 需要）" });
      }

      return null; // 404
    },

// legacy（systemd 服务模式固定 5900/6080）探活缓存：middleware 查表失败时用 fetch（无 ss 依赖）；
// Node runtime 模块级状态跨请求保留（Next middleware bundle 单例）。
    // middleware：VNC-on-web + RDP-on-web 代理 —— 全部走当前 Next.js middleware（无新端口/域名/用户），
    // 子 basePath 下直访：静态页/资产 + WebSocket 升级统一 rewrite 到 127.0.0.1:<webPort>。
    // 机制与 service-tunnels 同：返回带 x-middleware-rewrite 头的空 Response，Next 内部
    // 执行 rewrite（WS 升级走编译进 http-proxy 的 proxy.ws()，roadmap M1 已实测）。
    async middleware(req) {
      const rawUrl = new URL(req.url);
      // 支持两种前缀：/aiti-ui-env/vnc/ 和 /aiti-ui-env/rdp/（协议无关，统一处理）
      const vncIdx = rawUrl.pathname.indexOf("/aiti-ui-env/vnc/");
      const rdpIdx = rawUrl.pathname.indexOf("/aiti-ui-env/rdp/");
      const isVnc = vncIdx >= 0 && (rdpIdx < 0 || vncIdx <= rdpIdx);
      const marker = isVnc ? "/aiti-ui-env/vnc/" : "/aiti-ui-env/rdp/";
      const idx = isVnc ? vncIdx : rdpIdx;
      if (idx < 0) return { handled: false };
      const rest = rawUrl.pathname.slice(idx + marker.length);
      const m = manager();

      // ── 页面会话校验（cookie 认证；URL 无凭据；空 token 可关）──
      const cookieSess = () => {
        const c = req.headers.get("cookie") || "";
        const cookieName = isVnc ? "ui_env_vnc" : "ui_env_rdp";
        for (const part of c.split(";")) {
          const i = part.indexOf("=");
          if (i > 0 && part.slice(0, i).trim() === cookieName) return part.slice(i + 1).trim();
        }
        return null;
      };
      // 页面：VNC=<token>/vnc.html（原生 noVNC）与 <token>/view.html（旋转/缩放外壳）；RDP=<token>/index.html
      // —— 一切都在 <token>/ 实例前缀下，会话 cookie 校验
      const barePage = isVnc ? "vnc.html" : "index.html";
      // 公共查看器资产：<token>/common/<path> → configDir/view-common（快捷键条/虚拟键盘/系统键盘等，VNC/RDP 双端共用一份）
      const commonMatch = /^[^/]+\/common\/([a-z0-9._\-/]+)$/.exec(rest);
      if (commonMatch) {
        if (!(isVnc ? m.validVncSession(cookieSess()) : m.validRdpSession(cookieSess()))) {
          return { handled: true, response: new Response("aiti-ui-env: 无会话。请从 pi-web 🖥️ 面板打开", { status: 403 }) };
        }
        // 静态小文件：后缀白名单 + join 前滤掉 ../；本扩展 middleware 实际跑在 Node runtime
        const rel = commonMatch[1];
        const ctype = rel.endsWith(".js") ? "application/javascript; charset=utf-8"
          : rel.endsWith(".css") ? "text/css; charset=utf-8"
          : rel.endsWith(".json") ? "application/json" : null;
        try {
          const fpath = pathJoin(pathDirname(m.getDataDir()), "cache", "view-common", // view-common 静态资产 → cache（<extRoot>/cache）
            ...rel.split("/").filter((s: string) => s && s !== "." && s !== ".."));
          const body = await fsPromises.readFile(fpath);
          return { handled: true, response: new Response(body, { headers: { "content-type": ctype || "application/octet-stream", "cache-control": "no-cache" } }) };
        } catch {
          return { handled: true, response: new Response("aiti-ui-env: 无此公共资产: " + rel, { status: 404 }) };
        }
      }
      if (isVnc && /^[^/]+\/view\.html$/.test(rest)) {
        // 自定义查看外壳：同样要会话 cookie；页面本体由本扩展直接 serve（不经实例 bridge）
        if (!m.validVncSession(cookieSess())) {
          return { handled: true, response: new Response("aiti-ui-env: 无 VNC 会话。请从 pi-web 🖥️ 面板打开（30 分钟会话 cookie）", { status: 403 }) };
        }
        return { handled: true, response: new Response(VNC_VIEW_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }) };
      }
      if (new RegExp(`^[^/]+/${barePage}$`).test(rest)) {
        const sessOk = isVnc ? m.validVncSession(cookieSess()) : m.validRdpSession(cookieSess());
        if (!sessOk) {
          return { handled: true, response: new Response(`aiti-ui-env: 无 ${isVnc ? "VNC" : "RDP"} 会话。请从 pi-web 🖥️ 面板打开（30 分钟会话 cookie）`, { status: 403 }) };
        }
      }
      // WS 认证在 bridge（握手前主动 403）；静态资产直放

      // ── 统一路由：首段 = 实例真随机 token（<token>/ws、<token>/vnc.html、<token>/app/ui.js …），剩余原样转发该实例 bridge ──
      const firstSeg = rest.split("/")[0];
      const inst = isVnc ? m.vncInstanceByToken(firstSeg) : m.rdpInstanceByToken(firstSeg);
      if (!inst) return { handled: true, response: new Response("aiti-ui-env: 无此实例（先 POST /vnc|/rdp {action:start} 或 sys-open）", { status: 404 }) };
      const upPath = rest.split("/").slice(1).join("/") || "/";
      const target = `http://127.0.0.1:${inst.webPort}/${upPath}${rawUrl.search}`;
      return { handled: true, response: new Response(null, { headers: { "x-middleware-rewrite": target } }) };
    },

    // ---- 方案 M：agent 工具（进程内注入，跨会话即时读模式；execute 直调本进程单例） ----
    agent: {
      agentTools() {
        // 门控由 core 统一判定（feature agentTools.enabled + per-session enableExtTools），此处无条件返回
        const m = manager();
        const p = (t: string) => String(t);
        return [
          {
            name: "ui_env_status",
            label: "ui_env_status",
            description: "查看显示环境状态：当前模式、桌面/无头虚拟屏探测结果（DISPLAY/XAUTHORITY/AT-SPI/VNC）、安装状态。需要决定 GUI 应用/浏览器/MCP 落在哪块屏时先调用。",
            parameters: { type: "object", properties: { refresh: { type: "boolean", description: "强制重新探测（默认用 1.5s 缓存）" } } },
            async execute(_id, params) {
              const r = await m.probeAll(!!(params as any).refresh);
              const vnc = await m.vncStatus();
              const mode = m.loadMode();
              return { content: [{ type: "text", text: JSON.stringify({
                mode, modeLabel: env.MODES.find((x) => x.id === mode)?.label,
                desktop: r.desktop, headless: r.headless, vnc: { url: vnc.webUrl, tcp: vnc.tcpRunning, web: vnc.webRunning },
                install: await m.installStatus().catch(() => null),
              }, null, 2) }] };
            },
          },
          {
            name: "ui_env_set_mode",
            label: "ui_env_set_mode",
            description: "切换显示模式（对新启动的 MCP/应用生效，已启动的进程不受影响；切换即时生效无需重启）。模式：prefer-desktop=优先桌面; prefer-headless=优先无头虚拟环境; always-desktop=总是桌面（不可用即报错）; always-headless=总是无头虚拟环境（不可用即报错）。",
            parameters: {
              type: "object", properties: {
                mode: { type: "string", enum: ["prefer-desktop", "prefer-headless", "always-desktop", "always-headless"], description: "目标模式" },
              }, required: ["mode"],
            },
            async execute(_id, params) {
              const mode = p((params as any).mode);
              if (!env.MODES.some((x) => x.id === mode)) return { content: [{ type: "text", text: "无效模式：" + mode }], isError: true };
              m.saveMode(mode as env.UeMode);
              return { content: [{ type: "text", text: `已切换模式：${mode}（${env.MODES.find((x) => x.id === mode)?.label}）。下一次启动（resolve/run/CLI）生效。` }] };
            },
          },
          {
            name: "ui_env_resolve",
            label: "ui_env_resolve",
            description: "按当前模式裁决目标屏，输出可直接使用的环境变量（DISPLAY/XAUTHORITY/DBUS_SESSION_BUS_ADDRESS/XDG_RUNTIME_DIR/a11y 开关）与 shell export 行。启动 GUI 应用或 GUI 类 MCP server 前调用，把 env 传给启动器。",
            parameters: {
              type: "object", properties: {
                prefer: { type: "string", enum: ["desktop", "headless"], description: "本次单次覆盖目标屏（可选；缺省按当前模式裁决）" },
              },
            },
            async execute(_id, params) {
              const prefer = (params as any).prefer;
              const r = await m.resolve(prefer, true);
              const out = {
                ok: r.ok, mode: r.mode, target: r.target, rationale: r.rationale,
                warnings: r.warnings, hint: r.hint, error: r.error,
                env: r.env, exportLines: r.exportLines,
              };
              return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
            },
          },
          {
            name: "ui_env_run",
            label: "ui_env_run",
            description: "用当前模式裁决出的环境后台启动一个命令（GUI 应用/浏览器/带界面的 MCP server）。命令不阻塞，返回 pid、目标屏、日志文件。示例：{cmd: \"chromium --new-window http://localhost:3000\"}。",
            parameters: {
              type: "object", properties: {
                cmd: { type: "string", description: "要运行的完整 shell 命令" },
                prefer: { type: "string", enum: ["desktop", "headless"], description: "本此单次覆盖目标屏（可选）" },
              }, required: ["cmd"],
            },
            async execute(_id, params) {
              const r = await m.run(String((params as any).cmd), { prefer: (params as any).prefer });
              if (!r.ok) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: r.error, hint: r.hint }, null, 2) }] };
              delete (r as any).env; // 避免巨大回显
              return { content: [{ type: "text", text: JSON.stringify({
                ok: true, pid: r.pid, target: r.target, logFile: r.logFile, warnings: r.warnings,
                note: "后台运行（fire-and-forget）：命令自身退出码不追踪；确认成功请检查进程/日志（logFile），或先跑 resolve 拿 env 再前台验证。",
              }, null, 2) }] };
            },
          },
          {
            name: "ui_env_headless",
            label: "ui_env_headless",
            description: "启动/停止/查询无头虚拟屏。Linux: Xvfb+openbox+dbus+AT-SPI；Windows: 虚拟显示驱动 + 自管便携 VNC server（仅回环 + 用户设定密码，免管理员）：首次需 password 参数（向用户询问 1~8 位密码）；macOS: 屏幕共享 VNC server（诚实降级：GUI 仍落控制台桌面，5900 桥接查看；免密 sudo 可自动开）。action=start 拉起（幂等，已在跑则返回就绪）；action=stop 停止（仅停本扩展自管进程，不碰真实桌面/用户服务）；action=status 只查。",
            parameters: {
              type: "object", properties: {
                action: { type: "string", enum: ["start", "stop", "status"], description: "操作（默认 start）" },
                password: { type: "string", description: "VNC 密码（1~8 位，仅 Windows 自管 winvnc 用；首次启动必填：先向用户询问再带此参数重试）" },
              },
            },
            async execute(_id, params) {
              const act = (params as any).action || "start";
              const p = params as any;
              if (act === "status") {
                const pr = await m.probeAll(false);
                return { content: [{ type: "text", text: JSON.stringify({ available: pr.headless.available, error: pr.headless.error || null, passwordSet: !!m.vncPassword() }, null, 2) }] };
              }
              if (act === "stop") {
                const r = await m.stopHeadless();
                return { content: [{ type: "text", text: JSON.stringify({ ok: r.ok, available: r.available, stopped: r.stopped, note: r.note }, null, 2) }] };
              }
              if (p.password) {
                const s = await m.setVncPassword(String(p.password));
                if (!s.ok) return { content: [{ type: "text", text: JSON.stringify({ ok: false, passwordError: s.error }, null, 2) }], isError: true };
              }
              const r = await m.startHeadless();
              return { content: [{ type: "text", text: JSON.stringify({ ok: r.ok, available: r.available, error: r.error || null, needPassword: r.needPassword || false, hint: r.hint || null }, null, 2) }] };
            },
          },
          {
            name: "ui_env_deps",
            label: "ui_env_deps",
            description: "自检/自动安装虚拟屏依赖组件。Linux: core= Xvfb/openbox/x11vnc/at-spi/xauth/xdpyinfo/dbus，ui= tint2/xfce4-terminal/thunar/xdotool/xterm/obamenu，多发行版（apt/dnf/pacman/apk/zypper/brew）自适应。Windows: 自动下载便携 UltraVNC（免安装免管理员）到 configDir/ultravnc（密码由用户提供，写入 ultravnc.ini 由 UltraVNC 自己认证），检测 node/noVNC/bridge/虚拟显示驱动。macOS: 检测 Aqua 会话/屏幕共享/noVNC/bridge，brew 装 cliclick（可选增强）。action=check 只自检（默认）；action=install 自动安装缺失。",
            parameters: {
              type: "object", properties: {
                action: { type: "string", enum: ["check", "install"], description: "check=自检（默认） / install=自动安装缺失组件" },
                password: { type: "string", description: "VNC 密码（1~8 位，仅 Windows）：若传入则一并设置，安装后用该密码连 VNC；不传且未设过 → 返回 needPassword=true，需向用户询问后重试" },
              },
            },
            async execute(_id, params) {
              const act = (params as any).action || "check";
              const p = params as any;
              if (p.password) {
                const s = await m.setVncPassword(String(p.password));
                if (!s.ok) return { content: [{ type: "text", text: JSON.stringify({ ok: false, passwordError: s.error }, null, 2) }], isError: true };
              }
              const r = act === "install" ? await m.installDeps() : await m.checkDeps(true);
              const brief = {
                os: r.os, distro: r.distro, pkgMgr: r.pkgMgr, sudo: r.sudo,
                coreMissing: r.coreMissing.map((i) => i.bin),
                uiMissing: r.uiMissing.map((i) => i.bin),
                allInstalled: r.allInstalled,
                manualHints: r.manualHints,
                installRan: (r as any).installRan, installError: (r as any).error,
                passwordSet: !!m.vncPassword(),
                needPassword: r.os === "windows" && !m.vncPassword(),
              };
              return { content: [{ type: "text", text: JSON.stringify(brief, null, 2) }] };
            },
          },
          {
            name: "ui_env_vnc",
            label: "ui_env_vnc",
            description: "VNC-on-web 管理（多实例，随机端口）。action：start（默认/指定实例，首实例 id=default，重复 start 自动开新实例）、list（实例列表）、stop {id}（停指定实例，缺省停默认）、status、reset-password {password, id?}（重设 VNC 密码：Windows=自管 winvnc ini + 系统版 UltraVNC/TightVNC 注册表，Linux=x11vnc -rfbauth / ~/.vnc/passwd；id 缺省自动选）。端口每次启动随机分配（避免与桌面/其他服务冲突）。macOS 无自管 server：start 自动桥接系统屏幕共享（127.0.0.1:5900，RFB 认证=mac 账号密码，noVNC 凭据层输入）。浏览器经 pi-web 站点 middleware 代理查看（无新端口/域名；URL 零凭据，认证=30min HttpOnly cookie，需先经 🖥️ 面板打开建立）。",
            parameters: {
              type: "object", properties: {
                action: { type: "string", enum: ["start", "stop", "list", "status", "reset-password"], description: "操作（默认 status）；reset-password = 重设 VNC 密码（自管 winvnc / 系统 VNC server）" },
                id: { type: "string", description: "实例 id（stop 用；缺省停默认实例）。reset-password 时 = 系统 VNC 条目 id（先 sys-scan 拿，如 sys-1234）" },
                displayNum: { type: "number", description: "服务哪个虚拟屏号（可选，默认 99）" },
                password: { type: "string", description: "VNC 密码（1~8 位，仅 Windows 自管 winvnc 用；首次 start 必填：先向用户询问再带此参数重试）" },
              },
            },
            async execute(_id, params) {
              const act = (params as any).action || "status";
              const p = params as any;
              // 重设密码（自管 winvnc / 系统 VNC）：可指定 id（sys-scan 的条目 id），缺省自动选
              if (act === "reset-password") {
                if (!p.password) return { content: [{ type: "text", text: "reset-password 需要 password（1~8 位；先向用户询问）" }], isError: true };
                const rr = await m.resetVncPassword(String(p.password), { id: p.id ? String(p.id) : undefined });
                return { content: [{ type: "text", text: JSON.stringify(rr, null, 2) }], isError: !rr.ok };
              }
              if (act === "start" && p.password) {
                const s = await m.setVncPassword(String(p.password));
                if (!s.ok) return { content: [{ type: "text", text: JSON.stringify({ ok: false, passwordError: s.error }, null, 2) }], isError: true };
              }
              let r: any;
              if (act === "list") r = await m.vncList();
              else r = await m.vncAction(act as "start" | "stop" | "status", { id: p.id ? String(p.id) : undefined, displayNum: p.displayNum ? Number(p.displayNum) : undefined });
              const insts = Array.isArray(r) ? r : (r.instances || []);
              const def = insts.find((i: any) => i.id === "default") || insts[0];
              const token = def?.token || "";
              return { content: [{ type: "text", text: JSON.stringify({
                action: act,
                instances: insts.map((i: any) => ({ id: i.id, token: i.token, display: ":" + i.displayNum, rfbPort: i.rfbPort, webPort: i.webPort, tcp: i.tcp, web: i.web, x11vncPid: i.x11vncPid, bridgePid: i.bridgePid })),
                message: r.message,
                needPassword: act === "start" && !m.vncPassword(),
                passwordSet: !!m.vncPassword(),
                viewPath: token ? "/aiti-ui-env/vnc/" + token + "/view.html?autoconnect=true&resize=scale&path=aiti-ui-env%2Fvnc%2F" + token + "%2Fws" : "",
                note: "viewPath 无目标地址：页面/WS/静态资源全在 <token>/ 实例前缀下（首段即实例 token，无旧路径兼容）。view.html = 查看外壳（工具条旋转 0/90/180/270 + 放大缩小 + 触屏双指捏合缩放/平移，直连 noVNC RFB 无 iframe；<token>/vnc.html 原生页直访亦可）。URL 路径段是实例真随机 token（代表该实例/端口，定期轮换；旧 token 宽限期内仍可开）。打开：① 先在本机浏览器开 pi-web 🖥️ 面板点「打开」建立 30min HttpOnly cookie ② 访问 <站点根><viewPath>（带 basePath 的实例别忘了前缀，如 /dev…）。无实例时 viewPath 为空，先 action:start。",
              }, null, 2) }] };
            },
          },
          {
            name: "ui_env_rdp",
            label: "ui_env_rdp",
            description: "RDP-on-web 管理（多实例，随机端口）。action：start {host,port}（直连外部 RDP 服务器；host 可直接写 host:port 如 127.0.0.1:3389，也支持 rdp:// 前缀与域名，port 缺省 3389）、list（实例列表）、stop {id}（停指定实例，缺省停默认）、status。sys-scan（探测系统 RDP/xrdp）、sys-open {port}（桥接系统 RDP）、sys-stop {pid}（停系统 RDP 进程）。浏览器经 pi-web 站点 middleware 代理查看（无新端口/域名；URL 零凭据，认证=30min HttpOnly cookie）。",
            parameters: {
              type: "object", properties: {
                action: { type: "string", enum: ["start", "stop", "list", "status", "sys-scan", "sys-open", "sys-stop"], description: "操作（默认 status）" },
                id: { type: "string", description: "实例 id（stop 用；缺省停默认实例）" },
                host: { type: "string", description: "RDP 目标主机（start 必填）" },
                port: { type: "number", description: "RDP 目标端口（start 默认 3389；sys-open 为系统 RDP 端口）" },
                pid: { type: "number", description: "系统 RDP 进程 pid（sys-stop 用）" },
                label: { type: "string", description: "实例标签（sys-open 用）" },
              },
            },
            async execute(_id, params) {
              const act = (params as any).action || "status";
              const p = params as any;
              let r: any;
              if (act === "list") r = await m.rdpList();
              else if (act === "sys-scan") r = await m.systemRdpScan();
              else if (act === "sys-open") {
                const port = Number(p.port);
                if (!Number.isFinite(port) || port <= 0) return { content: [{ type: "text", text: "需要有效 port" }], isError: true };
                if (!(await m.portListening(port))) return { content: [{ type: "text", text: `目标端口 ${port} 无监听，无法连接` }], isError: true };
                try {
                  const inst = await m.rdpCreate("sys-" + Date.now().toString(36), "127.0.0.1", 0, { sysPort: port, sysLabel: String(p.label || "sys") });
                  r = { inst: { id: inst.id, port: inst.port, webPort: inst.webPort, sys: inst.sys }, instances: await m.rdpList() };
                } catch (e) { return { content: [{ type: "text", text: "打开失败：" + String((e as Error).message) }], isError: true }; }
              } else if (act === "sys-stop") {
                const pid = Number(p.pid);
                if (!Number.isFinite(pid) || pid <= 0) return { content: [{ type: "text", text: "需要 pid" }], isError: true };
                try { process.kill(pid, "SIGTERM"); r = { message: "已向系统 RDP 进程发送停止信号", instances: await m.rdpList() }; }
                catch (e) { return { content: [{ type: "text", text: "停止失败（可能无权限）：" + String((e as Error).message) }], isError: true }; }
              } else {
                const rdp = await m.rdpAction(act as "start" | "stop" | "status" | "list", {
                  id: p.id ? String(p.id) : undefined,
                  host: p.host ? String(p.host) : undefined,
                  port: p.port ? Number(p.port) : undefined,
                });
                r = rdp;
              }
              const insts = Array.isArray(r) ? r : (r.instances || []);
              const def = insts.find((i: any) => i.id === "default") || insts[0];
              const token = def?.token || "";
              // URL 路径段 = 实例真随机令牌（代表该实例/端口，不落目标地址）
              const viewPath = token ? "/aiti-ui-env/rdp/" + token + "/index.html" : "/aiti-ui-env/rdp/index.html";
              return { content: [{ type: "text", text: JSON.stringify({
                action: act,
                instances: insts.map((i: any) => ({ id: i.id, token: i.token, host: i.host, port: i.port, webPort: i.webPort, web: i.web, bridgePid: i.bridgePid, sys: i.sys })),
                sysRdp: r.sysRdp || null,
                message: r.message,
                viewPath,
                note: "viewPath 无目标地址：URL 路径段是实例真随机 token（代表该实例/端口，定期轮换；旧 token 宽限期内仍可开）。打开：① 先在本机浏览器开 pi-web 🖥️ 面板点「打开查看」（30min HttpOnly cookie）② 访问 <站点根><viewPath>。多实例：URL 换成 <base>/aiti-ui-env/rdp/<该实例token>/index.html（token 见 instances 列表，页面自动连对应 RDP 服务器）。",
              }, null, 2) }] };
            },
          },
        ];
      },
    },
  },
};