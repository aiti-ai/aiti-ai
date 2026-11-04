#!/usr/bin/env node
/**
 * 验证 speaker.js 批窗口推进 / in-window 跳转 / 进度显示语义（headless, 无浏览器）
 * 运行：node tools/verify-speaker-loop.mjs
 *
 * 覆盖的问题（2026-09 审核）：
 *  1) 批末推进 nextIdx=from+1 → 每批重读 19/20 条（消息总循环）→ 应为 lastConsumed+1
 *  2) curIndex 停留在批次起点 → 高亮/prev/skip/进度全错 → 应逐句同步到真实消息
 *  3) 进度记录/恢复 = per-message 句序（跨批不串）
 */
import { createRequire } from "node:module";

// ── 最小浏览器环境 mock ──
let lastUtterance = null;
const allUtterances = [];

globalThis.window = {
  innerHeight: 800,
  pageYOffset: 0,
  addEventListener() {},
  removeEventListener() {},
  scrollTo() {},
  speechSynthesis: null,
};
globalThis.document = {
  hidden: false,
  hasFocus: () => true,
  addEventListener() {},
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, textContent: "" }),
  head: { appendChild() {} },
};
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
// node ≥21 的 navigator 是只读 getter，只补缺失成员
if (!globalThis.navigator || !globalThis.navigator.wakeLock) {
  try { Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true }); } catch { /* ignore */ }
}
globalThis.BroadcastChannel = class { postMessage() {} };
globalThis.EventSource = class { constructor(u) { this.url = u; } addEventListener() {} close() {} };
globalThis.Audio = class { pause() {} play() { return Promise.resolve(); } };
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
globalThis.window.speechSynthesis = {
  speak(u) { lastUtterance = u; allUtterances.push(u); },
  cancel() { lastUtterance = null; },
  pause() {},
  resume() {},
};

const api = await import("../client/src/speaker.js");
const { getState, setApiUrl, playAtSourceId, prev, skip, stop, setCurrentSession, readMessageFrom, consumeReadOnFollow, setFollow, toggleFollow, startFollowFromPageTop, setBarVisible, setSettings } = api;

// ── 造数据：35 条消息，每条 2 句（"第N条…前半句。后半句。"）──
const SESSION = "sess-1";
const MESSAGES = [];
for (let i = 1; i <= 35; i++) MESSAGES.push({ id: "id-" + i, key: false });
const mkText = (n) => `第${n}条消息的前半句。第${n}条消息的后半句。`;

// 服务端 mock
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/messages-content")) {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const ids = body ? body.ids : [];
    return { ok: true, json: async () => ({ ok: true, items: ids.map((id) => ({ id, text: mkText(parseInt(id.split("-")[1], 10)) })) }) };
  }
  if (u.includes("/messages?")) {
    return { ok: true, json: async () => ({ ok: true, messages: MESSAGES }) };
  }
  return { ok: true, json: async () => ({}) };
};

setApiUrl((p) => p);
setCurrentSession(SESSION);

function expect(cond, msg) {
  if (!cond) { console.error("✗ FAIL:", msg); process.exitCode = 1; }
  else console.log("✓", msg);
}

// ── 场景 1：批末推进不重读（核心循环修复） ──
await playAtSourceId(SESSION, "id-1");
await new Promise((r) => setTimeout(r, 30));
{
  const st = getState();
  expect(st.curSegs.length === 40, `窗口载入 20 条 ×2 句 = 40 句（实际 ${st.curSegs.length}）`);
  expect(st.curIndex === 0, `curIndex 起始 = 0（实际 ${st.curIndex}）`);
}
// 逐句播完第 1 批（40 句）
for (let k = 0; k < 40; k++) {
  const u = lastUtterance;
  if (!u) { console.error("✗ FAIL: 播完前中断于句", k, JSON.stringify(getState().curSeg)); process.exit(1); }
  u.onend();
  await new Promise((r) => setTimeout(r, 6));
}
{
  const st = getState();
  // 第 1 批播完：应从最后一条已读消息（id-20）的下一条（id-21）开始新批
  expect(st.curSegIds[0] === "id-21", `新批第一条 = id-21（实际 ${st.curSegIds[0]}）`);
  expect(st.curSegs.length === 30, `新批 = 剩 15 条 ×2 = 30 句（实际 ${st.curSegs.length}）`);
  expect(st.curSegs[st.curSeg]._id === "id-21", `当前播放句属于 id-21（实际 ${st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id}）`);
  expect(st.curIndex === 20, `curIndex = 20（实际 ${st.curIndex}）`);
  expect(st.curSeg === 0, `curSeg 归零（实际 ${st.curSeg}）`);
}

// ── 场景 2：skip 在批次内 → 直接切句（不重读不重载） ──
skip();
await new Promise((r) => setTimeout(r, 25));
{
  const st = getState();
  expect(st.curSegs[st.curSeg]._id === "id-22", `skip 后当前消息 = id-22（实际 ${st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id}）`);
  expect(st.curSegs.length === 28, `skip 重载窗口 [21..35) = 28 句（实际 ${st.curSegs.length}）`);
  expect(st.curIndex === 21, `skip 后 curIndex = 21（实际 ${st.curIndex}）`);
}

// ── 场景 3：prev 在批次内 → 切回上一条（id-21 从头） ──
prev();
await new Promise((r) => setTimeout(r, 25));
{
  const st = getState();
  expect(st.curSegs[st.curSeg]._id === "id-21", `prev 后当前消息 = id-21（实际 ${st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id}）`);
  expect(st.curSeg === 0, `prev 后回到该消息第 1 句（实际 ${st.curSeg}）`);
}

// ── 场景 4：句内进度记录/恢复（per-message 语义） ──
{
  lastUtterance.onend(); // id-21 第 1 句播完 → curSeg=1（第 2 句）
  await new Promise((r) => setTimeout(r, 15));
  stop();
  const prog = JSON.parse(localStorage.getItem("aiti-ai-speek:progress") || "{}");
  expect(prog["id-21"] === 1, `stop 后 progress[id-21] = 1（实际 ${prog["id-21"]}）`);
  // 续读：从 id-21 恢复 → 应从第 2 句开始
  await playAtSourceId(SESSION, "id-21");
  await new Promise((r) => setTimeout(r, 25));
  const st = getState();
  const cur = st.curSegs[st.curSeg];
  expect(cur && cur._id === "id-21" && st.curSeg === 1, `恢复续读 id-21 第 2 句（实际 ${cur && cur._id}@${st.curSeg}）`);
  stop();
}

// ── 场景 5：点读弹条 + 工具栏不再双启动 + 陈旧回调令牌守卫 ──
{
  setFollow(false);
  stop();
  await readMessageFrom("任意文本", "id-25", SESSION);
  await new Promise((r) => setTimeout(r, 30));
  let st = getState();
  expect(st.followOn === true, `点读后 followOn=true（实际 ${st.followOn}）`);
  expect(st.barVisible === true, `点读后 barVisible=true（弹条）（实际 ${st.barVisible}）`);
  expect(st.playing === true, `点读后 playing=true（实际 ${st.playing}）`);
  expect(st.curIndex === 24, `点读定位 id-25（curIndex 24，实际 ${st.curIndex}）`);
  expect(consumeReadOnFollow() === true, `点读抑制标志就绪（PlaybackBar 开启即自动读应跳过；实际 ${consumeReadOnFollow()}）`);

  // 用户再点顶部跟读（正是“出现两个声音”的路径）：followOn 已 on 且播放中 → 应关闭而非重启
  toggleFollow();
  await new Promise((r) => setTimeout(r, 20));
  st = getState();
  expect(st.followOn === false && st.playing === false, `工具栏再点=关闭且不再重启（实际 followOn=${st.followOn} playing=${st.playing}）`);

  // 令牌守卫：重启（cancel+重新播放）后，被取消 utterance 的陈旧 onend 不得推进新播放
  await playAtSourceId(SESSION, "id-30");
  await new Promise((r) => setTimeout(r, 25));
  const staleUtterance = lastUtterance; // id-30 第 1 句（旧令牌）
  await playAtSourceId(SESSION, "id-31"); // 模拟任何“cancel+重启”
  await new Promise((r) => setTimeout(r, 25));
  st = getState();
  const idBefore = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  const segBefore = st.curSeg;
  staleUtterance.onend();
  await new Promise((r) => setTimeout(r, 10));
  st = getState();
  const idAfter = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(idAfter === idBefore && st.curSeg === segBefore, `陈旧 onend 未推进新播放（${idBefore}@${segBefore} → ${idAfter}@${st.curSeg}）`);
  stop();
}

// ── 场景 6：双启动竞态 → 只允许一次启动出声 ──
{
  allUtterances.length = 0; // 只统计本场景（早期场景已读过 id-10/id-25 等）
  // 6a: 点读只应有一次启动；副实例（非 primary）的自动读 effect 被门控，不再二次启动
  stop();
  setFollow(false);
  await readMessageFrom("任意文本", "id-25", SESSION);
  await new Promise((r) => setTimeout(r, 40));
  let st = getState();
  expect(st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id === "id-25", `点读单次启动定位 id-25（实际 ${st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id}）`);
  // 主实例 consume 掉抑制 → 副实例（primary 门控）不会再发起 startFollowFromPageTop
  expect(consumeReadOnFollow() === true, `抑制就绪待主实例消费（返回 ${consumeReadOnFollow()}）`);
  expect(allUtterances.filter((u) => u.text.includes("第35条")).length === 0, `无第二次启动（id-35 未被播：${allUtterances.filter((u) => u.text.includes("第35条")).length}）`);
  expect(allUtterances.filter((u) => u.text.includes("第25条")).length === 1, `id-25 仅首句播一次（无重播：${allUtterances.filter((u) => u.text.includes("第25条")).length}）`);
  stop();

  // 6b: 快速双击 playAtSourceId（同一消息）→ 后启动接管，被超越加载作废
  allUtterances.length = 0;
  setFollow(false);
  playAtSourceId(SESSION, "id-10");
  playAtSourceId(SESSION, "id-10");
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  const segNow2 = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(segNow2 === "id-10", `双击后单次播放（当前 ${segNow2}，应为 id-10）`);
  expect(allUtterances.filter((u) => u.text.includes("第10条")).length === 1, `第10条首句仅播一次（无重播：${allUtterances.filter((u) => u.text.includes("第10条")).length}）`);
  stop();
}

// ── 场景 7：前一条语义（直接跳前条，不碰当前段进度）──
{
  allUtterances.length = 0;
  setFollow(false);
  // 7a: 从 id-24 开始读（窗口 [23..35)），播到 id-24 第 2 句 → prev 应直接到 id-23 开头（重载窗口）
  await playAtSourceId(SESSION, "id-24");
  await new Promise((r) => setTimeout(r, 30));
  lastUtterance.onend(); // id-24 句1 完 → 句2
  await new Promise((r) => setTimeout(r, 15));
  let st = getState();
  let cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-24" && st.curSeg === 1, `当前段 = id-24 第 2 句（实际 ${cur}@${st.curSeg}）`);
  prev();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-23" && st.curSeg === 0 && st.curSegFrom === 22, `prev 后直接到 id-23 开头（实际 ${cur}@${st.curSeg} from=${st.curSegFrom}）`);

  // 7b: 再 prev → id-22 开头；再 prev → id-21 开头（逐条回退，不自持当前段进度）
  prev();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-22" && st.curSeg === 0, `再 prev → id-22 开头（实际 ${cur}@${st.curSeg}）`);
  prev();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-21" && st.curSeg === 0, `再 prev → id-21 开头（实际 ${cur}@${st.curSeg}）`);

  // 7c: 播到 id-21 第 2 句再 prev → id-20 开头（跨窗口边界，同样直接跳）
  lastUtterance.onend();
  await new Promise((r) => setTimeout(r, 15));
  st = getState();
  cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-21" && st.curSeg === 1, `当前段 = id-21 第 2 句（实际 ${cur}@${st.curSeg}）`);
  prev();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-20" && st.curSeg === 0 && st.curSegFrom === 19, `第 2 句 prev → id-20 开头（实际 ${cur}@${st.curSeg} from=${st.curSegFrom}）`);
  stop();
}

// ── 场景 8：停止态 / 播完末尾的 prev-skip 基准（lastReadPos）──
{
  allUtterances.length = 0;
  setFollow(false);
  // 8a: 播到 id-23 中途停止 → stop 记 lastReadPos=id-23；prev → id-22 开头；skip → id-24 开头
  await playAtSourceId(SESSION, "id-22");
  await new Promise((r) => setTimeout(r, 30));
  lastUtterance.onend(); // id-22 句1 完 → 句2
  await new Promise((r) => setTimeout(r, 15));
  lastUtterance.onend(); // id-22 句2 完 → id-23 句1
  await new Promise((r) => setTimeout(r, 15));
  stop(); // 当前段 = id-23@0
  let st = getState();
  let cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(st.playing === false, `停止态（playing=${st.playing}）`);
  prev();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-22" && st.curSeg === 0, `停止态 prev → 当前条上一（id-22 开头，实际 ${cur}@${st.curSeg}）`);
  stop();
  skip();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-23" && st.curSeg === 0, `停止态 skip → 当前条下一（id-23 开头，实际 ${cur}@${st.curSeg}）`);

  // 8b: 播到会话末尾（id-35 读完 → END 态）→ prev 应回 id-34，而非跳到 id-35 重放
  stop();
  await playAtSourceId(SESSION, "id-34");
  await new Promise((r) => setTimeout(r, 30));
  // 播完窗口剩余（id-34..id-35 = 4 句，当前 id-34@0）
  for (let k = 0; k < 4; k++) { lastUtterance.onend(); await new Promise((r) => setTimeout(r, 12)); }
  st = getState();
  expect(st.playing === false && st.curSegs.length === 0, `会话末尾 END 态（playing=${st.playing}）`);
  prev();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-34" && st.curSeg === 0, `末尾 END 态 prev → id-34 开头（实际 ${cur}@${st.curSeg}）`);
  stop();
}

// ── 场景 9：首次开跟读自动开播 + 未播放态 skip/prev 都生效──
{
  allUtterances.length = 0;
  stop();
  setFollow(false);
  await new Promise((r) => setTimeout(r, 20));
  let st = getState();
  expect(st.followOn === false && st.playing === false, `初始：跟读关+未播（实际 followOn=${st.followOn} playing=${st.playing}）`);
  toggleFollow(); // = 首次点顶部跟读
  await new Promise((r) => setTimeout(r, 1400));
  st = getState();
  // harness 中可见消息为空 → startFollowFromPageTop 兑底读最后一条（id-35）
  expect(st.playing === true && (st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id === "id-35"), `首次开跟读自动开播（playing=${st.playing}，当前 ${st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id}）`);
  expect(st.barVisible === true, `播放条自动显示（barVisible=${st.barVisible}）`);
  // 关闭条 → 顶部中间态语义：toggleFollow 只开条不关跟读
  stop();
  setBarVisible(false);
  await new Promise((r) => setTimeout(r, 20));
  toggleFollow();
  await new Promise((r) => setTimeout(r, 20));
  st = getState();
  expect(st.followOn === true && st.barVisible === true, `条藏时点顶部=开条不关跟读（followOn=${st.followOn} barVisible=${st.barVisible}）`);

  // 未播放态（停止后）skip/prev 都以 lastReadPos 为基准立刻开播；先用 id-30 留下非末尾基准
  await playAtSourceId(SESSION, "id-30");
  await new Promise((r) => setTimeout(r, 40));
  stop();
  await new Promise((r) => setTimeout(r, 20));
  st = getState();
  expect(st.playing === false, `已停止（playing=${st.playing}）`);
  skip();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  expect(st.playing === true && (st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id === "id-31"), `未播放态 skip → 下一（id-31，实际 playing=${st.playing} ${st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id}）`);
  stop();
  await new Promise((r) => setTimeout(r, 20));
  prev();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  expect(st.playing === true && (st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id === "id-30"), `未播放态 prev → 上一（id-30，实际 playing=${st.playing} ${st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id}）`);
  stop();
}

// ── 场景 10：minChars 忽略短回复（readableSegs）──
{
  allUtterances.length = 0;
  setFollow(false);
  stop();
  setSettings({ minChars: 100 }); // 全部消息文本 < 100 字 → 全部不应朗读
  await playAtSourceId(SESSION, "id-1");
  await new Promise((r) => setTimeout(r, 50));
  let st = getState();
  expect(st.playing === false && st.curSegs.length === 0, `短消息全部被跳过（playing=${st.playing} segs=${st.curSegs.length}）`);
  setSettings({ minChars: 8 });
  stop();
}

// ── 场景 11：prev 语义全面扫描（任何时刻 prev 都不许回到当前消息）──
{
  allUtterances.length = 0;
  setFollow(false);
  stop();
  await playAtSourceId(SESSION, "id-24");
  await new Promise((r) => setTimeout(r, 30));
  // 11a: 段内第2句按 prev → id-23
  lastUtterance.onend();
  await new Promise((r) => setTimeout(r, 15));
  let st = getState();
  const curBefore = st.curSegs[st.curSeg]._id;
  prev();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  let cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-23" && cur !== curBefore, `段内第2句 prev → 上一条（${curBefore}→${cur}）`);

  // 11b: 跨段瞬间（先 advance 到下一段，再立即 prev）→ 回到上一段（合法回退），绝不回「当前」之后
  // 从 id-23@0 出发：onend → id-23 第2句 → onend → id-24 第1句（跨段）
  lastUtterance.onend(); await new Promise((r) => setTimeout(r, 12));
  lastUtterance.onend(); await new Promise((r) => setTimeout(r, 12));
  st = getState();
  expect(st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id === "id-24", `跨段至 id-24 第1句（实际 ${st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id}@${st.curSeg}）`);
  prev();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-23" && st.curSeg === 0, `跨段后 prev → 上一段开头（实际 ${cur}@${st.curSeg}）`);

  // 11c: 批末在途按 prev（模拟：播到窗口末尾触发 loadRangeIntoCur 瞬间）
  await playAtSourceId(SESSION, "id-34"); // 窗口 [33..35)
  await new Promise((r) => setTimeout(r, 30));
  // 快速连推进到批末（id-34 → id-35 → 批末 END/下一窗口）
  for (let k = 0; k < 4; k++) { lastUtterance.onend(); await new Promise((r) => setTimeout(r, 10)); }
  // 现在可能在 END/在途——立即 prev（若正播 id-35 → 应到 id-34；若已在 END → 不应跳到最后一自身）
  prev();
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  cur = st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id;
  expect(cur === "id-34" || cur === "id-33", `批末/END-istate prev → 上一条（实际 ${cur}）`);
  stop();
}

// ── 场景 12：读完标记 e（9e）——resume（lastReadPos=末条）读到 e 不再重播 ──
{
  setFollow(false);
  stop();
  await playAtSourceId(SESSION, "id-35"); // 窗口末一条（2 句）
  await new Promise((r) => setTimeout(r, 30));
  lastUtterance.onend(); await new Promise((r) => setTimeout(r, 18));
  lastUtterance.onend(); await new Promise((r) => setTimeout(r, 30)); // id-35 读完 → END + e 标记
  let st = getState();
  const prog = JSON.parse(localStorage.getItem("aiti-ai-speek:progress") || "{}");
  expect(prog["id-35"] === "e", `读完 id-35 标记 e（实际 ${prog["id-35"]}）`);
  // 模拟 resume：lastReadPos=id-35 → 再播 id-35 → e 跳过 → 不重播、保持 END
  await playAtSourceId(SESSION, "id-35");
  await new Promise((r) => setTimeout(r, 40));
  st = getState();
  expect(st.playing === false, `e 后 resume 不重播 id-35（playing=${st.playing}）`);
  stop();
}

console.log(process.exitCode ? "\n有失败用例 ❌" : "\n全部通过 ✅");
process.exit(process.exitCode || 0);
