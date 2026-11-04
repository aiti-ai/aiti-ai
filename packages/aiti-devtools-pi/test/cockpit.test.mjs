/**
 * cockpit.test.mjs —— cockpit.html（独立桥 AI 操作台）回归测试
 *
 * 背景：cockpit.html（packages/aiti-devtools-pi/src/cockpit.html）是独立桥 serve 的
 * AI 操作台页面，依赖 4 个浏览器资产（bridge-client/host-protocol/cdp-core/aiwin，
 * 均取自 packages/aiti-devtools-core/assets/ 构建产物）。长期未回归——本测试用 jsdom
 * 加载真实页面 + 真实资产，驱动桥数据（fetch stub + fake EventSource 桥下行）与
 * 宿主协议（postMessage），验证：初始化 / 纯函数 / 数据流渲染 / 交互卡 / 发送 /
 * 草稿 / 复制 / 帧树。
 *
 * 用法：node packages/aiti-devtools-pi/test/cockpit.test.mjs
 * 依赖：jsdom（仓库根 devDependencies）
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("✗ " + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), (msg || "") + " 期望=" + JSON.stringify(b) + " 实际=" + JSON.stringify(a));
const truthy = (v, msg) => ok(!!v, msg + "（实际=" + JSON.stringify(v) + "）");
const contains = (s, sub, msg) => ok(String(s).indexOf(sub) >= 0, (msg || "") + " 应包含 " + JSON.stringify(sub) + "，实际=" + String(s).slice(0, 200));
const section = (name) => console.log("\n== " + name + " ==");

const here = dirname(fileURLToPath(import.meta.url));
const piRoot = resolve(here, "..");
const coreAssets = resolve(piRoot, "..", "aiti-devtools-core", "assets");

// ---- 从 cockpit.html 提取内联脚本（最后一个 <script> 块）----
// 注意：模板串含 `<\/script>`（反斜杠转义），不能用正则 </script> 提前截断——
// 用 lastIndexOf 定位（模板里是 `<\/script>` 非字面 `</script>`，不会误命中）。
function extractInlineScript(html) {
  // 起点 = 最后一个真正的内联 <script> 块（以 'use strict'; 开头）——injectCode 模板串里也有字面
  // `<script>`（480 行），lastIndexOf("<script>") 会取错。终点 = 页面最后一个 </script>。
  const start = html.lastIndexOf("<script>\n'use strict';");
  const end = html.lastIndexOf("</script>");
  if (start < 0 || end <= start) throw new Error("cockpit.html 未找到内联脚本块（start=" + start + " end=" + end + "）");
  return html.slice(start + "<script>".length, end);
}

const assets = {};
for (const name of ["bridge-client.js", "host-protocol.js", "cdp-core.js", "aiwin.js"]) {
  assets[name] = readFileSync(resolve(coreAssets, name), "utf8");
}
const cockpitHtml = readFileSync(resolve(piRoot, "src", "cockpit.html"), "utf8");
const inline = extractInlineScript(cockpitHtml);

// ---- fetch stub：按 URL 前缀路由返回模拟桥数据 ----
function makeFetch(routes) {
  const log = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    const path = u.replace(/^https?:\/\/[^/]+/, "");
    log.push({ method: opts.method || "GET", url: path, body: opts.body ? JSON.parse(opts.body) : null });
    const hit = (routes || []).find((r) => (r.method || "GET") === (opts.method || "GET") && path.startsWith(r.prefix));
    if (!hit) return { ok: false, status: 404, json: async () => ({ ok: false, error: "no route " + path }) };
    const data = typeof hit.data === "function" ? hit.data(path, opts) : hit.data;
    return { ok: true, status: 200, json: async () => data };
  };
  return { fn, log };
}

// ---- EventSource fake：记录连接；测试可手动触发 ready / 桥下行消息 ----
function makeEventSource() {
  const conns = [];
  class FakeES {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null; this.onerror = null; this.onmessage = null;
      conns.push(this);
    }
    close() { this.readyState = 2; }
  }
  return { FakeES, conns };
}

// ---- 构造 cockpit 页面场景：jsdom 加载真实资产 + 内联脚本 + stubs（beforeParse 先行）----
// 资产/内联脚本按序以动态 <script> 元素加载（textContent 不走 HTML 解析，规避资产内字面
// `</script>`/`<!--` 的解析错乱；jsdom 动态 script 与静态 script 同享全局词法环境——
// const/function 声明对后续 window.eval 可见）。顺序与页面 <script> 一致。
function loadCockpit(opts = {}) {
  const { fn, log } = makeFetch(opts.routes || []);
  const { FakeES, conns } = makeEventSource();
  // 剔除页面全部静态 script（4 个 src 引用 + 1 个内联块——runScripts:dangerously 会先执行，
  // 资产未注入致 AitiAiWin undefined + 二次注入 $ 冲突；统一改为动态注入）
  const baseHtml = cockpitHtml.replace(/<script[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(baseHtml, {
    url: opts.url || "http://127.0.0.1:8777/cockpit.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = fn;
      win.EventSource = FakeES;
      // clipboard（jsdom 无）
      try { Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true }); } catch (e) {}
      // canvas 2d + toDataURL（makeFavicon 用）
      const fakeCtx = { fillStyle: "", fillRect: () => {}, font: "", textAlign: "", textBaseline: "", fillText: () => {} };
      win.HTMLCanvasElement.prototype.getContext = () => ({ ...fakeCtx, toDataURL: () => "data:image/png;base64,AA==" });
      win.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,AA==";
    },
  });
  const win = dom.window;
  const run = (code) => {
    const s = win.document.createElement("script");
    s.textContent = code;
    win.document.body.appendChild(s);
  };
  run(assets["bridge-client.js"]);
  run(assets["host-protocol.js"]);
  run(assets["cdp-core.js"]);
  run(assets["aiwin.js"]);
  run(inline);
  return { dom, win, fetchLog: log, sseConns: conns };
}

// 等待微任务 + macrotask（aiwin refresh 链 / postMessage 分发 settle）
const settle = (n = 3) => new Promise((r) => setTimeout(r, n * 10));

// 桥下行模拟：fake EventSource 收到 SSE 消息（bridge-client handleMessage 分发）
const bridgePush = (ctx, msg) => {
  const es = ctx.sseConns[0];
  if (!es) throw new Error("无 SSE 连接（BridgeClient.connect 未执行）");
  es.onmessage({ data: JSON.stringify(msg) });
};

// ---- 测试数据 ----
const sessionsData = [
  { instanceId: "00001", frameId: "host", pageId: "00001/host", url: "http://app.test/", title: "App 主页", active: true, viaAI: true },
  { instanceId: "00001", frameId: "f1", pageId: "00001/f1", url: "http://app.test/", title: "表单 iframe", frameParent: "host", active: true },
  { instanceId: "00001", frameId: "f2", pageId: "00001/f2", url: "http://widget.test/", title: "嵌套 iframe", frameParent: "f1", active: true },
  { instanceId: "00002", frameId: "host", pageId: "00002/host", url: "http://other.test/", title: "另一页面", active: true, deviceLabel: "Chrome · 桌面" },
];
const agentsData = [
  { agentId: "pi", sessionId: "sess-aaaa", agentKey: "pi/sess-aaaa", name: "pi · /home/pi/workspace/pi-work", cwd: "/home/pi/workspace/pi-work", online: true, registered: true, lastSeen: Date.now() },
  { agentId: "pi", sessionId: "sess-bbbb", agentKey: "pi/sess-bbbb", name: "pi · /home/pi/workspace/pi-web", cwd: "/home/pi/workspace/pi-web", online: false, registered: true, offlineAt: Date.now() - 30 * 60 * 1000, lastSeen: Date.now() - 30 * 60 * 1000 },
  { agentId: "claude", sessionId: "sess-cccc", agentKey: "claude/sess-cccc", name: "claude", online: false, registered: false, offlineAt: Date.now() - 20 * 60 * 1000, lastSeen: Date.now() - 20 * 60 * 1000 },
];
const messagesData = [
  { id: "m1", kind: "user_message", from: "window", text: "帮我看看这个页面", at: "2026-09-16T10:00:01.000Z", agentKey: "pi/sess-aaaa", status: "delivered", ref: "sent_1" },
  { id: "m2", kind: "agent_message", from: "agent", text: "好的，我先看一下 DOM 结构", at: "2026-09-16T10:00:05.000Z", agentKey: "pi/sess-aaaa", status: "delivered" },
  { id: "m3", kind: "page_log", from: "page", text: "console: [log] hello", at: "2026-09-16T10:00:03.000Z", agentKey: "pi/sess-aaaa", status: "delivered" },
];
const now = Date.now();

export async function run() {
  section("组 1：初始化与静态内容");
  {
    const ctx = loadCockpit({ routes: [{ method: "GET", prefix: "/bridge/sessions", data: [] }] });
    await settle();
    const $ = (id) => ctx.dom.window.document.getElementById(id);
    ok(!!$("status"), "t02 status 元素存在");
    eq(ctx.win.eval("base"), "http://127.0.0.1:8777", "t03 base 推断（独立桥根路径，无 /aiti 前缀）");
    truthy(ctx.win.eval("REMOTE_BRIDGE"), "t04 REMOTE_BRIDGE 常量");
    contains($("injectCode").textContent, "__AITI_BRIDGE_URL", "t05 injectCode 含桥配置");
    contains($("injectCode").textContent, "aiti-launcher.js", "t05b injectCode 含注入脚本");
    contains($("mcpCfg").textContent, "/mcp/mcp", "t06 mcpCfg 含 MCP 端点");
    contains($("bridgeEndpoints").textContent, "REST: http://127.0.0.1:8777/bridge/*", "t07 bridgeEndpoints 端点展示");
    contains($("status").textContent, "无页面", "t08 空桥状态：无页面");
    for (const id of ["agentsList", "frameList", "msgList", "pushText", "pickedBar", "interactions", "guide", "toast", "agentsDd", "frameDd"]) {
      ok(!!$(id), "t09 DOM 元素 " + id);
    }
    ok(ctx.sseConns.length >= 1, "t10 AI 窗已连桥（EventSource 建立）");
    eq(ctx.sseConns[0].url.split("?")[0], "http://127.0.0.1:8777/bridge/sse", "t11 SSE 端点");
    ctx.dom.window.close();
  }

  section("组 2：纯函数");
  {
    const ctx = loadCockpit({ routes: [{ method: "GET", prefix: "/bridge/sessions", data: [] }] });
    await settle();
    const f = (expr) => ctx.win.eval(expr);
    eq(f('esc("<a>&\\"")'), "&lt;a&gt;&amp;\"", "t12 esc HTML 转义（文本节点引号不转义）");
    eq(f('escAttr(\'<div class="x">\')'), "&lt;div class=&quot;x&quot;&gt;", "t13 escAttr 引号转义");
    const row = f('frameRowFromBoot("piweb/host", { id: "host", url: "http://a.test/", title: "T" })');
    eq(row.pageId, "piweb/host", "t14 frameRowFromBoot host 行 pageId");
    const sub = f('frameRowFromBoot("piweb/host", { id: "f1", parentId: "host", url: "http://b.test/" })');
    eq(sub.frameParent, "host", "t15 frameRowFromBoot 子帧 parentId");
    eq(f('frameDomain({ frameUrl: "chrome-extension://abc/page.html" })'), "扩展", "t16 frameDomain chrome-extension → 扩展");
    eq(f('frameDomain({ frameUrl: "about:blank" })'), "srcdoc", "t16b frameDomain about: → srcdoc");
    eq(f('frameDomain({ frameUrl: "data:text/html,x" })'), "data:", "t16c frameDomain data: 字面");
    eq(f('frameDomain({ frameUrl: "http://127.0.0.1:8899/x" })'), "127.0.0.1:8899", "t16d frameDomain 带端口 host");
    ok(f('frameIsExt({ frameUrl: "moz-extension://x/y" })'), "t17 frameIsExt moz-extension");
    ok(!f('frameIsExt({ frameUrl: "http://a.test/" })'), "t17b frameIsExt 普通 URL 非扩展");
    const rows = f("buildFrameTreeRows(" + JSON.stringify(sessionsData) + ")");
    ok(rows.some((r) => r.group && r.instanceId === "00001"), "t18 分组头 00001");
    ok(rows.some((r) => r.group && r.instanceId === "00002"), "t18b 分组头 00002");
    eq(rows.find((r) => r.frameId === "host" && r.instanceId === "00001").depth, 0, "t19 主页 depth=0");
    eq(rows.find((r) => r.frameId === "f1").depth, 1, "t20 子帧 depth=1");
    eq(rows.find((r) => r.frameId === "f2").depth, 2, "t21 嵌套帧 depth=2");
    const dup = f("buildFrameTreeRows(" + JSON.stringify([
      { instanceId: "9", frameId: "host", pageId: "9/host", active: true, viaAI: true },
      { instanceId: "9", frameId: "host", pageId: "9/host", active: true, title: "强信息", url: "http://x/" },
    ]) + ")");
    const dupRows = dup.filter((r) => r.pageId === "9/host");
    eq(dupRows.length, 1, "t22 sessions 同 pageId 去重");
    eq(dupRows[0].title, "强信息", "t22b 去重保留信息更全的行");
    eq(f('timeAgo(' + Date.now() + ')'), "1秒前", "t23 timeAgo 秒（<1s 兕底 1秒前）");
    eq(f('timeAgo(' + (now - 5 * 60 * 1000) + ')'), "5分钟前", "t23b timeAgo 分钟");
    eq(f('timeAgo(' + (now - 3 * 3600 * 1000) + ')'), "3小时前", "t23c timeAgo 小时");
    eq(f('timeAgo(' + (now - 2 * 86400 * 1000) + ')'), "2天前", "t23d timeAgo 天");
    eq(f('timeAgo(0)'), "", "t23e timeAgo 空");
    eq(f('shortCwd("/home/pi/workspace/pi-work")'), "workspace/pi-work", "t24 shortCwd 末两段");
    eq(f('agentCwdOf({ cwd: "/x/y/z" })'), "/x/y/z", "t25 agentCwdOf cwd 字段优先");
    eq(f('agentCwdOf({ name: "pi · /old/path" })'), "/old/path", "t25b agentCwdOf 旧格式 name 解析");
    eq(f('agentCwdOf({ name: "plain" })'), "", "t25c agentCwdOf 非路径名");
    eq(f('agentNameOf({ cwd: "/x", name: "pi · /x" })'), "pi", "t26 agentNameOf 剥 cwd 前缀");
    eq(f('agentNameOf({ name: "claude" })'), "claude", "t26b agentNameOf 纯名");
    eq(f('agentLabel({ cwd: "/a/b", name: "pi · /a/b", sessionId: "sess-long-id" })'), "a/b . pi (sess-lon)", "t27 agentLabel 统一格式");
    eq(f('shortSession("abcdefghijkl")'), "abcdefgh", "t28 shortSession 8 字符");
    eq(f('describeAnswer("confirm", { status: "answered", approved: true })'), "✅ 是", "t29a describeAnswer confirm 是");
    eq(f('describeAnswer("confirm", { status: "answered", approved: false })'), "❌ 否", "t29b describeAnswer confirm 否");
    eq(f('describeAnswer("choose", { status: "answered", value: { index: 2, label: "选项C" } })'), "选项C", "t29c describeAnswer choose");
    eq(f('describeAnswer("choose", { status: "answered", value: { index: -1, custom: true } })'), "✍️ 都不适合", "t29d describeAnswer choose 自定义");
    eq(f('describeAnswer("input", { status: "answered", value: { text: "你好" } })'), "你好", "t29e describeAnswer input");
    eq(f('describeAnswer("presence", { status: "answered", present: false })'), "⏳ 稍后", "t29f describeAnswer presence");
    eq(f('describeAnswer("pick_element", { status: "answered", result: { tag: "button", text: "提交" } })'), "🎯 <button> 提交", "t29g describeAnswer pick_element");
    eq(f('describeAnswer("confirm", { status: "rejected", reason: "user rejected" })'), "✋ 拒绝：user rejected", "t29h describeAnswer rejected");
    eq(f('describeAnswer("confirm", { status: "timeout" })'), "⏱ 超时（用户无响应）", "t29i describeAnswer timeout");
    eq(f('describeAnswer("x", { status: "error", error: "boom" })'), "⚠ boom", "t29j describeAnswer error");
    eq(f('stripCandidateTags("hello [元素1] [回答2] [错误3] world")'), "hello    world", "t30 stripCandidateTags 摘占位符（空位保留）");
    eq(f('withSourceTag("原文")'), "原文", "t31 withSourceTag 恒等（结构化来源已下沉）");
    ctx.dom.window.close();
  }

  section("组 3：数据流渲染（sessions / agents / messages）");
  {
    const ctx = loadCockpit({
      routes: [
        { method: "GET", prefix: "/bridge/sessions", data: sessionsData },
        { method: "GET", prefix: "/bridge/agents", data: { agents: agentsData } },
        { method: "GET", prefix: "/bridge/messages", data: { messages: messagesData } },
      ],
    });
    await settle(8); // 等 aiwin 首次 refresh 链完成
    const $ = (id) => ctx.dom.window.document.getElementById(id);
    const frameRows = [...$("frameList").querySelectorAll(".frow")];
    ok(frameRows.length >= 6, "t32 帧树行数（2 组头 + 4 帧）≥6，实际=" + frameRows.length);
    ok(frameRows.some((r) => r.textContent.includes("App 主页")), "t33 帧树含实例标题");
    ok(frameRows.some((r) => r.textContent.includes("🌐")), "t34 主页图标");
    ok(frameRows.some((r) => r.textContent.includes("📦")), "t35 iframe 图标");
    ok(frameRows.some((r) => r.textContent.includes("widget.test")), "t36 帧域名显示");
    contains($("status").textContent, "主页", "t37 状态默认选中 主页");
    const agentRows = [...$("agentsList").querySelectorAll(".row")];
    ok(agentRows.length >= 4, "t38 agent 下拉行数（群发 + 3 agent）≥4，实际=" + agentRows.length);
    ok(agentRows.some((r) => r.textContent.includes("全部 agent")), "t39 群发行");
    ok(agentRows.some((r) => r.textContent.includes("pi/sess-aaaa")), "t40 agent id 行");
    ok(agentRows.some((r) => r.textContent.includes("pi-work . pi")), "t41 agentLabel 显示（cwd . name）");
    ok(agentRows.some((r) => r.textContent.includes("● 在线")), "t42 在线标记");
    ok(agentRows.some((r) => r.textContent.includes("○ 掉线")), "t43 掉线标记");
    ok(agentRows.some((r) => r.textContent.includes("⚠未注册")), "t44 未注册标记");
    ok([...$("agentsList").querySelectorAll(".sec")].some((s) => s.textContent.includes("📜 历史")), "t45 历史分段");
    // 消息：all 模式首轮 agents 未就绪不拉取（aiwin 时序）——切单 agent 目标触发 agent 模式拉取
    ctx.win.eval("setAgentTarget('pi/sess-aaaa')");
    await settle(6);
    const msgRows = [...$("msgList").querySelectorAll(".msg")];
    ok(msgRows.length === 3, "t46 消息行数=3，实际=" + msgRows.length);
    eq(msgRows.map((r) => r.dataset.at), [...msgRows.map((r) => r.dataset.at)].sort(), "t47 消息按时间插入排序");
    ok(msgRows.some((r) => r.classList.contains("from-me")), "t48 from-me 样式");
    ok(msgRows.some((r) => r.classList.contains("from-agent")), "t49 from-agent 样式");
    ok(msgRows.some((r) => r.classList.contains("sys")), "t50 sys（page_log）样式");
    ok(msgRows.some((r) => r.textContent.includes("帮我看看这个页面")), "t51 消息文本渲染");
    ok(!$("guide").innerHTML.includes("接入 AI 助手"), "t52 有 agent 不显示 Welcome 卡");
    eq(ctx.dom.window.document.title, "workspace/pi-work . pi (sess-aaa) - aiti cockpit", "t53 title 随目标 agent 会话");
    ctx.dom.window.close();
  }

  section("组 4：交互卡（桥下行模拟 confirm/choose/input/presence/notify + 作答回桥）");
  {
    const ctx = loadCockpit({
      routes: [
        { method: "GET", prefix: "/bridge/sessions", data: [] },
        { method: "GET", prefix: "/bridge/agents", data: { agents: agentsData } },
        { method: "GET", prefix: "/bridge/messages", data: { messages: [] } },
        { method: "POST", prefix: "/bridge/result", data: { ok: true } },
        { method: "POST", prefix: "/bridge/interaction", data: { ok: true } },
      ],
    });
    await settle(4);
    const $ = (id) => ctx.dom.window.document.getElementById(id);
    const lastResult = () => ctx.fetchLog.filter((l) => l.url.startsWith("/bridge/result")).at(-1);
    const cards = () => [...$("ixBody").querySelectorAll(".card")];
    const msgTexts = () => [...$("msgList").querySelectorAll(".msg")].map((r) => r.textContent);

    bridgePush(ctx, { type: "interaction", requestId: "r1", interaction: { kind: "confirm", prompt: "确认删除？", agentId: "pi" } });
    await settle();
    eq(cards().length, 1, "t54 confirm 卡片出现");
    contains($("ixBody").textContent, "确认删除？", "t55 卡片 prompt");
    [...cards()[0].querySelectorAll("button")].find((b) => b.textContent.includes("✅")).click();
    await settle();
    const r1 = lastResult();
    truthy(r1, "t56 作答回桥 POST /bridge/result");
    eq(r1.body.requestId, "r1", "t57 回桥带 requestId");
    eq(r1.body.result, { status: "answered", approved: true }, "t58 作答结果 approved=true");
    eq(cards().length, 0, "t59 卡片作答后移除");
    ok(msgTexts().some((t) => t.includes("✅ 是")), "t60 作答记录进消息流");

    bridgePush(ctx, { type: "interaction", requestId: "r2", interaction: { kind: "choose", prompt: "选一个", choices: ["A", "B"], agentId: "pi" } });
    await settle();
    eq(cards().length, 1, "t61 choose 卡片出现");
    [...cards()[0].querySelectorAll("button")].find((b) => b.textContent === "B").click();
    await settle();
    eq(lastResult().body.result.value, { index: 1, label: "B" }, "t62 choose 作答 value");

    bridgePush(ctx, { type: "interaction", requestId: "r3", interaction: { kind: "input", prompt: "输入内容", agentId: "pi" } });
    await settle();
    const card3 = cards()[0];
    card3.querySelector("input").value = "我的输入";
    [...card3.querySelectorAll("button")].find((b) => b.textContent.includes("发送")).click();
    await settle();
    eq(lastResult().body.result.value, { text: "我的输入" }, "t63 input 作答 value");

    bridgePush(ctx, { type: "interaction", requestId: "r4", interaction: { kind: "presence", prompt: "在吗", agentId: "pi" } });
    await settle();
    [...cards()[0].querySelectorAll("button")].find((b) => b.textContent.includes("🙋")).click();
    await settle();
    eq(lastResult().body.result, { status: "answered", present: true }, "t64 presence 作答");

    bridgePush(ctx, { type: "interaction", requestId: "r5", interaction: { kind: "notify", title: "通知标题", body: "通知内容", agentId: "pi" } });
    await settle();
    ok(msgTexts().some((t) => t.includes("通知内容")), "t65 notify 直接进消息流");
    ok(!cards().some((c) => c.textContent.includes("通知标题")), "t66 notify 不占卡片区");

    bridgePush(ctx, { type: "interaction", requestId: "r6", interaction: { kind: "input", prompt: "暂停测试", agentId: "pi" } });
    await settle();
    const pauseBtn = cards()[0].querySelector('button[title*="暂停"]');
    pauseBtn.click();
    await settle();
    eq(ctx.fetchLog.find((l) => l.url.startsWith("/bridge/interaction")).body.action, "pause", "t67 暂停倒计时 postInteraction");
    pauseBtn.click();
    await settle();
    eq(ctx.fetchLog.filter((l) => l.url.startsWith("/bridge/interaction")).at(-1).body.action, "resume", "t68 继续 postInteraction");

    bridgePush(ctx, { type: "interaction", requestId: "r7", interaction: { kind: "input", prompt: "他端作答测试", agentId: "pi" } });
    await settle();
    ok(cards().some((c) => c.textContent.includes("他端作答测试")), "t69 卡片已渲染");
    bridgePush(ctx, { type: "result", requestId: "r7", ok: true, result: { status: "answered", value: { text: "对方答了" } } });
    await settle();
    ok(!cards().some((c) => c.textContent.includes("他端作答测试")), "t70 onResult 移除卡片");
    ok(msgTexts().some((t) => t.includes("对方答了")), "t71 他端作答记录消息流");
    ctx.dom.window.close();
  }

  section("组 5：宿主协议（postMessage 自管理模式：boot → 帧树 + 宿主页身份）");
  {
    const ctx = loadCockpit({ routes: [{ method: "GET", prefix: "/bridge/sessions", data: [] }] });
    await settle(4);
    const $ = (id) => ctx.dom.window.document.getElementById(id);
    ctx.win.postMessage({ __dbg: 1, type: "dbg_ai_boot", payload: { pageId: "00001/host", targetUrl: "http://app.test/", title: "App", frames: [{ id: "host", title: "App", url: "http://app.test/" }, { id: "f1", parentId: "host", title: "IF", url: "http://app.test/f" }] } }, "*");
    await settle(8);
    const frameRows = [...$("frameList").querySelectorAll(".frow")];
    ok(frameRows.some((r) => r.textContent.includes("App")), "t72 boot 帧树本地渲染（host）");
    ok(frameRows.some((r) => r.textContent.includes("IF")), "t73 boot 帧树子帧");
    contains($("status").textContent, "主页: App", "t74 boot 后帧树非空 → 默认选中 主页");
    ctx.dom.window.close();
  }

  section("组 6：草稿与输入（localStorage 防丢 + composer）");
  {
    const ctx = loadCockpit({ routes: [{ method: "GET", prefix: "/bridge/sessions", data: [] }] });
    await settle(4);
    const $ = (id) => ctx.dom.window.document.getElementById(id);
    const ta = $("pushText");
    ta.value = "测试消息 [元素1]";
    ctx.win.eval("resizeComposer(); saveDraftNow()");
    eq(ctx.dom.window.localStorage.getItem("aiti-cockpit-draft"), "测试消息", "t75 草稿保存并摘占位符");
    ta.value = "";
    ctx.win.eval("restoreDraft()");
    eq(ta.value, "测试消息", "t76 restoreDraft 恢复草稿");
    ctx.win.eval("clearDraft()");
    ok(ctx.dom.window.localStorage.getItem("aiti-cockpit-draft") === null, "t77 草稿清除");
    const h = ctx.win.eval("resizeComposer(); document.getElementById('pushText').style.height");
    truthy(h, "t78 composer 设置高度：" + h);
    ctx.dom.window.close();
  }

  section("组 7：发送流程（pushMessage → /bridge/push + 占位符替换）");
  {
    const ctx = loadCockpit({
      routes: [
        { method: "GET", prefix: "/bridge/sessions", data: [] },
        { method: "GET", prefix: "/bridge/agents", data: { agents: agentsData } },
        { method: "GET", prefix: "/bridge/messages", data: { messages: [] } },
        { method: "POST", prefix: "/bridge/push", data: { ok: true, delivered: [{ agentKey: "pi/sess-aaaa", status: "delivered" }] } },
      ],
    });
    await settle(6);
    const $ = (id) => ctx.dom.window.document.getElementById(id);
    const ta = $("pushText");
    const lastPush = () => ctx.fetchLog.filter((l) => l.url.startsWith("/bridge/push")).at(-1);

    // 无 agent 场景：agents 空 → 不发送（另行构造，见下）——先测正常发送
    ta.value = "你好 agent";
    ctx.win.eval("pushMessage()");
    await settle(6);
    const p1 = lastPush();
    truthy(p1, "t79 push 被调");
    eq(p1.body.kind, "user_message", "t80 push body kind");
    eq(p1.body.text, "你好 agent", "t81 push body 文本");
    eq(p1.body.payload.source, "window", "t82 push 来源 source=window");
    eq(p1.body.payload.sourceLabel, "AI 窗", "t83 push 来源 sourceLabel");
    truthy(p1.body.ref, "t84 push 唯一 ref");
    eq(ta.value, "", "t85 发送成功清空输入框");
    ok(ctx.dom.window.localStorage.getItem("aiti-cockpit-draft") === null, "t86 发送成功清草稿");
    contains($("toast").textContent, "已送达", "t87 toast 已送达");

    // 占位符替换：宿主协议注入元素候选 → 输入 [元素1] → push body 被 describe 替换
    ctx.win.postMessage({ __dbg: 1, type: "dbg_ai_element", payload: { tag: "button", text: "提交按钮", xpath: "//button[1]" } }, "*");
    await settle(6);
    ok($("pickedBar").style.display !== "none", "t88 候选区显示");
    ta.value = "点击 [元素1]";
    ctx.win.eval("pushMessage()");
    await settle(6);
    const p2 = lastPush();
    ok(p2.body.text.indexOf("提交按钮") >= 0, "t89 占位符替换为完整描述（实际=" + p2.body.text + "）");
    ctx.dom.window.close();
  }

  section("组 8：无 agent 引导 + 复制兜底");
  {
    const ctx = loadCockpit({ routes: [{ method: "GET", prefix: "/bridge/sessions", data: [] }] });
    await settle(4);
    const $ = (id) => ctx.dom.window.document.getElementById(id);
    // 无 agent → 引导 Welcome 卡
    contains($("guide").innerHTML, "接入 AI 助手", "t90 无 agent 显示 Welcome 卡");
    // 无 agent 发送 → toast 引导不发送
    $("pushText").value = "发给谁";
    ctx.win.eval("pushMessage()");
    await settle(2);
    ok(!ctx.fetchLog.some((l) => l.url.startsWith("/bridge/push")), "t91 无 agent 不发送");
    contains($("toast").textContent, "agent", "t92 无 agent toast 引导");
    // copyText：clipboard stub 成功 → toast
    const el = ctx.dom.window.document.createElement("div");
    el.id = "__copySrc";
    el.textContent = "复制的文本";
    ctx.dom.window.document.body.appendChild(el);
    ctx.win.eval('copyText("__copySrc")');
    await settle(2);
    contains($("toast").textContent, "已复制", "t93 copyText 成功 toast");
    ctx.dom.window.close();
  }

  console.log("\n────────────────────────────");
  console.log("cockpit.test.mjs 结果：" + pass + " 通过 / " + fail + " 失败");
  return fail === 0 ? 0 : 1;
}

// 直跑
if (process.argv[1] && process.argv[1].endsWith("cockpit.test.mjs")) {
  run().then((code) => process.exit(code));
}
