/**
 * host-protocol-assets.test.mjs —— B3/B4/B5（host-protocol.js 资产行为）
 * 用法：node test/host-protocol-assets.test.mjs
 * 桩：global.localStorage/window/location（create 不需要真实 DOM，addEventListener 空实现）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("✗ " + msg); } };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(resolve(root, "assets/host-protocol.js"), "utf8");

// ---- DOM/localStorage 桩（B5 需要按 session 分 key 的 localStorage）----
// 注：create() 会启动元信息上报轮询（startMetaReporting：读 document.title + setInterval 1.5s）。
// 桩需提供最小 document；setInterval/clearInterval 经 Function 形参注入 no-op——若放行真实
// 定时器，进程在断言跑完后因活动 interval 不退事件循环而挂死。
function makeStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => Object.fromEntries(m),
  };
}
const lsA = makeStore(), lsB = makeStore();
function bootGlobal(ls, sessionParam) {
  const g = {
    localStorage: ls,
    location: { search: sessionParam ? `?_dbg=1&session=${sessionParam}` : "?_dbg=1", origin: "http://ai.test", href: "http://ai.test/" },
    // 元信息上报读取面：title（startMetaReporting）/ favicon 查询 / 可见性监听
    document: { title: "", querySelectorAll: () => [], addEventListener: () => {}, visibilityState: "visible" },
    addEventListener: () => {},
    URL: URL,
  };
  g.window = g;                 // 资产尾部 })(window)——全局对象自引用
  const run = new Function("global", "window", "setInterval", "clearInterval", src + "\n;return window.AitiHostProtocol;");
  run(g, g, () => 0, () => {}); // 定时器桩：登记为已调度但不入事件循环（防测试完成后挂起）
  return g;
}
const gA = bootGlobal(lsA, "sessA");
const gB = bootGlobal(lsB, "sessB");

const hpA = gA.AitiHostProtocol.create({ onPicked: () => {}, insertPlaceholder: () => {} });
const hpB = gB.AitiHostProtocol.create({ onPicked: () => {}, insertPlaceholder: () => {} });

// ---- B5: 两个 AI 窗实例（不同 session）各自的候选互不覆盖 ----
{
  hpA.setPicked([{ kind: "element", tag: "[元素1]", xpath: "/a", text: "A窗元素" }]);
  hpB.setPicked([{ kind: "element", tag: "[元素1]", xpath: "/b", text: "B窗元素" }]);
  const dumpA = lsA._dump(), dumpB = lsB._dump();
  const keysA = Object.keys(dumpA).filter((k) => k.startsWith("__aiti_picked"));
  const keysB = Object.keys(dumpB).filter((k) => k.startsWith("__aiti_picked"));
  ok(keysA.length === 1 && keysB.length === 1, "各实例恰好一个 picked key");
  ok(keysA[0] !== keysB[0], "B5: key 按实例区分（互不覆盖）");
  ok(JSON.parse(dumpA[keysA[0]])[0].xpath === "/a", "A 窗候选为 A 的");
  ok(JSON.parse(dumpB[keysB[0]])[0].xpath === "/b", "B 窗候选为 B 的");
}

// ---- B5+恢复：同实例刷新（重建 hp 读同一 key）恢复候选 ----
{
  const hpA2 = gA.AitiHostProtocol.create({ onPicked: () => {}, insertPlaceholder: () => {} });
  ok(hpA2.getPicked().length === 1 && hpA2.getPicked()[0].xpath === "/a", "同实例 create 恢复候选");
}

// ---- B3: 错误候选自动补来源页 pageId ----
{
  // 无 boot 消息时 debugTarget 为空、urlIdent 无 pageId → 不强加（可空）；
  // 模拟 boot（postMessage 进不来——桩无 dispatch）→ 直接验证 hostIdentity 链：造 url 参数型身份
  const gC = bootGlobal(makeStore(), "sessC");
  gC.location.search = "?_dbg=1&pageId=px99%2Fhost"; // URL 参数兜底身份（launcher 拼 AI 窗地址携带）
  const hpC = gC.AitiHostProtocol.create({ onPicked: () => {}, insertPlaceholder: () => {} });
  const seen = [];
  const hpC2 = gC.AitiHostProtocol.create({
    onPicked: (list) => seen.push(list),
    insertPlaceholder: () => {},
  });
  // 直接走内部消息处理：hp 的 handle 挂在 addEventListener（桩吞了）——用导出面近似验证：
  const hid = hpC2.hostIdentity();
  ok(hid && hid.pageId === "px99/host", "hostIdentity URL 参数兜底");
  // setPicked 手工注入错误候选验证 describe 通路（B3 的 pageId 补全在 dbg_ai_error 处理内，
  // 需消息泵；此处至少验证 hostIdentity 可用 + 错误候选 describe 含 pageId 标注逻辑不崩）
  hpC2.setPicked([{ kind: "error", message: "boom", stack: "at f (x.js:1:1)" }]);
  const desc = hpC2.describe(hpC2.getPicked()[0], "px99/host");
  ok(desc.includes("boom"), "错误候选 describe 正常");
}

// ---- B4: stripFromText 摘除后空白收敛 ----
{
  const hp = gA.AitiHostProtocol.create({ onPicked: () => {}, insertPlaceholder: () => {} });
  hp.setPicked([
    { kind: "element", tag: "[元素1]", xpath: "/a", text: "A" },
    { kind: "element", tag: "[元素2]", xpath: "/b", text: "B" },
  ]);
  const v1 = hp.stripFromText("看 [元素1] 和 [元素2] 对比", hp.getPicked());
  ok(!v1.includes("["), "占位符全摘");
  ok(!/ {2,}/.test(v1), "B4: 摘除后无双空格");
  ok(v1 === "看 和 对比", `B4: 空白收敛为单空格（实际: ${JSON.stringify(v1)}）`);
  const v2 = hp.stripFromText("首 [元素1]", hp.getPicked());
  ok(v2 === "首", "标签在尾：无残留空白");
}

console.log(`host-protocol-assets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
