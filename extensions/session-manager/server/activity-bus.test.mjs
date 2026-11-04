/**
 * activity-bus 单测（2026-09-15 数据帧化：行增量更新口径 / 帧构造 / 节流 trailing）。
 *
 * 覆盖：
 *   - applyMessageToRow 口径（对齐 core session-reader 与本扩展 session-file parser）：
 *     user/assistant 推进计数/时间/预览/角色，toolResult 只计数+角色，空文本不覆盖，
 *     纯 toolCall 伪文本，60 字符截断，非法 message 原样返回；
 *   - publishSessionActivity：缓存命中帧带更新行 / 未命中不带 row（客户端回退增量刷新）；
 *   - 节流 trailing：窗口内事件合并且窗口尾补发（数据帧不丢最后一个事件）；
 *   - 发布口清空静默 / resetActivityBusState 清理。
 *
 * 运行：node --experimental-strip-types --test server/activity-bus.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("./activity-bus.ts");
const {
  applyMessageToRow, noteAssembledRows, publishSessionActivity,
  bindActivityPublisher, resetActivityBusState, __setActivityMinIntervalForTest,
  __peekRowCache,
} = mod;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function baseRow(over = {}) {
  return {
    id: "s1", cwd: "/w", created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z", messageCount: 10, firstMessage: "hi",
    lastMessage: "old", lastRole: "assistant", name: "n", archived: false,
    ...over,
  };
}

test("applyMessageToRow：user 消息推进计数/时间/预览/角色（纯函数不改原行）", () => {
  const row = baseRow();
  const ts = Date.parse("2026-09-15T10:00:00.000Z");
  const next = applyMessageToRow(row, { role: "user", timestamp: ts, content: "你好世界" });
  assert.equal(next.messageCount, 11);
  assert.equal(next.modified, "2026-09-15T10:00:00.000Z");
  assert.equal(next.lastRole, "user");
  assert.equal(next.lastMessage, "你好世界");
  assert.equal(row.messageCount, 10, "原行不被修改");
  assert.equal(row.lastMessage, "old");
});

test("applyMessageToRow：assistant 消息更新 model（原始值，不带 provider 前缀）", () => {
  const next = applyMessageToRow(baseRow(), {
    role: "assistant", timestamp: Date.now(), model: "GLM-5.3",
    content: [{ type: "text", text: "回复" }],
  });
  assert.equal(next.model, "GLM-5.3");
  assert.equal(next.lastMessage, "回复");
  assert.equal(next.lastRole, "assistant");
});

test("applyMessageToRow：toolResult 只计数 + 角色（不推进时间/预览——扫描口径）", () => {
  const row = baseRow();
  const next = applyMessageToRow(row, {
    role: "toolResult", timestamp: Date.parse("2026-09-15T11:00:00.000Z"), content: "tool out",
  });
  assert.equal(next.messageCount, 11);
  assert.equal(next.lastRole, "toolResult");
  assert.equal(next.modified, row.modified, "toolResult 不推进 modified");
  assert.equal(next.lastMessage, "old", "toolResult 不覆盖预览");
});

test("applyMessageToRow：空文本不覆盖 lastMessage；纯 toolCall 回合给伪文本预览", () => {
  const empty = applyMessageToRow(baseRow(), { role: "assistant", timestamp: Date.now(), content: [] });
  assert.equal(empty.lastMessage, "old");
  const tc = applyMessageToRow(baseRow(), {
    role: "assistant", timestamp: Date.now(),
    content: [{ type: "toolCall", name: "read", arguments: { path: "/x" } }],
  });
  assert.ok(tc.lastMessage.startsWith("🛠 read"), "纯工具回合有伪文本预览");
});

test("applyMessageToRow：长文本截断到 60+…（与列表出口 truncate 一致）", () => {
  const next = applyMessageToRow(baseRow(), { role: "user", timestamp: Date.now(), content: "a".repeat(100) });
  assert.equal(next.lastMessage.length, 61);
  assert.ok(next.lastMessage.endsWith("…"));
});

test("applyMessageToRow：message 非法 → 原样返回（不计数）", () => {
  const row = baseRow();
  assert.equal(applyMessageToRow(row, undefined), row);
  assert.equal(applyMessageToRow(row, null), row);
  assert.equal(applyMessageToRow(row, "junk").messageCount, 10);
});

test("applyMessageToRow：messageCount 非数字（无基数）不猜测——不完全倒退成 1", () => {
  const row = baseRow({ messageCount: undefined });
  const next = applyMessageToRow(row, { role: "user", timestamp: Date.now(), content: "x" });
  assert.equal(next.messageCount, undefined, "无基数保持原值（留给列表刷新补齐）");
  assert.equal(next.lastMessage, "x", "其余字段照常更新");
});

test("publishSessionActivity：缓存命中 → 帧带更新行；未命中 → 帧不带 row", () => {
  resetActivityBusState();
  __setActivityMinIntervalForTest(0);
  const frames = [];
  bindActivityPublisher((type, data) => frames.push({ type, ...data }));
  noteAssembledRows([baseRow()], [{ ...baseRow(), id: "arch1", archived: true }]);
  publishSessionActivity("s1", { role: "user", timestamp: Date.now(), content: "hello" });
  publishSessionActivity("ghost", { role: "user", timestamp: Date.now(), content: "x" });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, "sm:session-activity");
  assert.equal(frames[0].sessionId, "s1");
  assert.equal(frames[0].row.messageCount, 11);
  assert.equal(frames[0].row.lastMessage, "hello");
  assert.equal(frames[1].sessionId, "ghost");
  assert.equal(frames[1].row, undefined, "缓存未命中 → 帧不带 row（客户端回退增量刷新）");
});

test("publishSessionActivity：节流窗口内 trailing 补发最新行（不丢最后一个事件）", async () => {
  resetActivityBusState();
  __setActivityMinIntervalForTest(60);
  const frames = [];
  bindActivityPublisher((type, data) => frames.push({ type, ...data }));
  noteAssembledRows([baseRow()]);
  publishSessionActivity("s1", { role: "user", timestamp: Date.now(), content: "a" }); // 立即
  publishSessionActivity("s1", { role: "user", timestamp: Date.now(), content: "b" }); // 窗口内 → trailing
  publishSessionActivity("s1", { role: "user", timestamp: Date.now(), content: "c" }); // 窗口内 → 合并
  assert.equal(frames.length, 1, "窗口内事件不发第二帧");
  await sleep(140);
  assert.equal(frames.length, 2, "窗口尾 trailing 补发一帧");
  assert.equal(frames[1].row.messageCount, 13, "补发行含窗口内全部增量");
  assert.equal(frames[1].row.lastMessage, "c");
});

test("bindActivityPublisher(null) 后静默；resetActivityBusState 清缓存", () => {
  resetActivityBusState();
  __setActivityMinIntervalForTest(0);
  const frames = [];
  bindActivityPublisher((type, data) => frames.push({ type, ...data }));
  noteAssembledRows([baseRow()]);
  publishSessionActivity("s1", { role: "user", timestamp: Date.now(), content: "x" });
  assert.equal(frames.length, 1);
  bindActivityPublisher(null);
  publishSessionActivity("s1", { role: "user", timestamp: Date.now(), content: "y" });
  assert.equal(frames.length, 1, "发布口清空后静默");
  resetActivityBusState();
  assert.equal(__peekRowCache("s1"), undefined);
});
