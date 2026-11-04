/**
 * speaker 账本测试（双SSE去重·方案A，本测试针对 docs/todo-aiti-ai-speek-dual-sse-redundancy.md §4-A）。
 *
 * 直接 import speaker.js（模块顶层无 window 依赖——window 只在函数体内引用），
 * 验证 settled 轮账本的时序语义：
 *   1. 同会话 15s 内第二路 claim → false（合并）
 *   2. resetSettledTurn（新一轮 assistant 块完成）→ claim 重新放行（跨轮压制回归修复）
 *   3. 不同会话互不影响
 *
 * Run: node --experimental-strip-types --test speaker-ledger.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

// node 环境最小 DOM stub（speaker.js 顶层注册 visibilitychange 监听）
globalThis.window = globalThis.window || {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
};
globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } };

const speaker = await import("../client/src/speaker.js");
const { claimSettledTurn, resetSettledTurn, cacheMessageText, getState } = speaker;

test("claimSettledTurn: 同会话连续 claim，15s 内第二路被合并", () => {
  resetSettledTurn();
  assert.equal(claimSettledTurn("s-x"), true, "首轮放行");
  assert.equal(claimSettledTurn("s-x"), false, "同会话第二路合并");
  assert.equal(claimSettledTurn("s-y"), true, "不同会话互不影响");
});

test("resetSettledTurn（assistant 块完成）→ 同会话 claim 重新放行（P0-3 跨轮压制回归修复）", () => {
  resetSettledTurn();
  assert.equal(claimSettledTurn("s-turn1"), true, "turn1 放行");
  assert.equal(claimSettledTurn("s-turn1"), false, "turn1 第二路合并");
  resetSettledTurn(); // 新一轮活动：assistant 块完成（handleUpdating 入口调用）
  assert.equal(claimSettledTurn("s-turn1"), true, "重置后同会话重新放行（turn2）");
});

test("单槽设计：换会话 claim 重新放行（订阅一次只跟一个会话）", () => {
  resetSettledTurn();
  assert.equal(claimSettledTurn("sess-a"), true);
  assert.equal(claimSettledTurn("sess-a"), false, "同会话窗口内合并");
  assert.equal(claimSettledTurn("sess-b"), true, "换会话（订阅切换）→ 放行");
  assert.equal(claimSettledTurn("sess-b"), false, "同会话再 claim 仍合并");
});

test("cacheMessageText：full 模式直写 textCache；essentials 跳过；无 id 忽略", () => {
  const st = getState();
  const prevMode = st.settings.mode;
  try {
    st.settings.mode = "full";
    cacheMessageText("sess-cache", { id: "m1", content: [{ type: "text", text: "hello" }] });
    assert.equal(st.textCache["sess-cache"]?.m1, "hello", "full 模式直写");
    cacheMessageText("sess-cache", { id: "m2", content: "raw string" });
    assert.equal(st.textCache["sess-cache"]?.m2, "raw string", "string content 直写");
    st.settings.mode = "essentials";
    cacheMessageText("sess-cache", { id: "m3", content: [{ type: "text", text: "要点" }] });
    assert.equal("m3" in (st.textCache["sess-cache"] || {}), false, "essentials 不直写（服务端过滤）");
    cacheMessageText("sess-cache", { id: "m4", content: [{ type: "image", url: "x" }] });
    assert.equal("m4" in (st.textCache["sess-cache"] || {}), false, "无文本 → 忽略");
  } finally {
    st.settings.mode = prevMode;
  }
});

// ============================================================================
// 外部后端会话跟读：wire 帧观察账本合成朗读列表（todo-aispeek-external-session-follow）
// ============================================================================

test("wireMsgIds 账本：cacheMessageText 保序去重记账", async () => {
  const st = getState();
  const prevMode = st.settings.mode;
  try {
    st.settings.mode = "full";
    cacheMessageText("sess-wire", { id: "w1", content: [{ type: "text", text: "第一" }] });
    cacheMessageText("sess-wire", { id: "w2", content: [{ type: "text", text: "第二" }] });
    cacheMessageText("sess-wire", { id: "w1", content: [{ type: "text", text: "第一" }] }); // 重复帧（重连重放）
    assert.deepEqual(st.wireMsgIds["sess-wire"], ["w1", "w2"], "保序且去重");
  } finally {
    st.settings.mode = prevMode;
  }
});

test("ensureSessionLoaded：服务端空列表 + wire 账本 → 合成朗读列表（外部会话跟读闭环）", async () => {
  const st = getState();
  const prevMode = st.settings.mode;
  const realFetch = globalThis.fetch;
  try {
    st.settings.mode = "full";
    cacheMessageText("sess-ext", { id: "wire-1", content: [{ type: "text", text: "外部回复一" }] });
    cacheMessageText("sess-ext", { id: "wire-2", content: [{ type: "text", text: "外部回复二" }] });
    // 服务端 /messages 空列表（外部会话形态）；messages-content 对 missing 也返回空
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("idsOnly=1")) {
        return { ok: true, json: async () => ({ ok: true, messages: [] }) };
      }
      return { ok: true, json: async () => ({ ok: true, items: [] }) };
    };
    const list = await speaker.ensureSessionLoaded("sess-ext", true);
    assert.equal(list.length, 2, "wire 账本合成 2 段");
    assert.deepEqual(list.map((x) => x.id), ["wire-1", "wire-2"]);
    assert.equal(st.msgList["sess-ext"].length, 2);
    assert.equal(st.allMessagesLoaded["sess-ext"], true);
    // 后续非 force 调用走早退分支，同样拿到合成列表
    const list2 = await speaker.ensureSessionLoaded("sess-ext");
    assert.deepEqual(list2.map((x) => x.id), ["wire-1", "wire-2"]);
  } finally {
    globalThis.fetch = realFetch;
    st.settings.mode = prevMode;
  }
});

test("ensureSessionLoaded：无 wire 账本且服务端空 → 行为不变（空列表）", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, messages: [] }) });
    const list = await speaker.ensureSessionLoaded("sess-no-wire", true);
    assert.deepEqual(list, [], "无观察账本 → 空列表（原行为）");
    assert.equal(getState().msgList["sess-no-wire"].length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
