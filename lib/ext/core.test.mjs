/**
 * readLiveHandleSession（core.readSession 的外部后端会话回退）单元测试（node --test）
 *
 * 覆盖：handle 库命中 → getMessages 适配 {messages, entryIds}（索引 id 两次调用
 * 稳定，ai-speek idsOnly→messages-content 两段拉取的匹配前提）；role/content 投影
 * 剥离多余字段；handle 缺席 / getMessages 空 / throw → null。
 * 独立轻模块加载（core.ts 顶层 rpc-manager 链含 strip-types 不支持的语法）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { readLiveHandleSession } = await import("./core-live-session.ts");
const { putHandleAt, rebindHandle, getHandle } = await import("../session/handle-store.ts");

function fakeHandle(messages) {
  return {
    id: "zcode:sess_fake",
    alive: () => true,
    subscribe: () => () => {},
    getMessages: async () => messages,
    dispose: async () => {},
  };
}

test("回退适配：handle 库命中 → messages 投影 + 索引 entryIds（两段拉取稳定）", async () => {
  const SID = "test-uuid-ext-1";
  putHandleAt(SID, fakeHandle([
    { role: "user", content: [{ type: "text", text: "问" }], extra: "strip-me" },
    { role: "assistant", content: [{ type: "text", text: "答" }], model: "bigmodel/GLM-5.3", provider: "zcode" },
  ]));
  const sess = await readLiveHandleSession(SID);
  assert.ok(sess, "返回适配形状而非 null");
  assert.equal(sess.messages.length, 2);
  assert.deepEqual(sess.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal("extra" in sess.messages[0], false, "role/content 之外的字段剥离");
  assert.equal("model" in sess.messages[1], false);
  // entryIds：两次调用一致（两段拉取匹配前提）
  const ids1 = sess.entryIds;
  const ids2 = (await readLiveHandleSession(SID)).entryIds;
  assert.deepEqual(ids1, ids2);
  assert.equal(ids1.length, 2);
});

test("回退适配：handle 缺席 / getMessages 空 → null", async () => {
  putHandleAt("test-uuid-ext-2", fakeHandle([]));
  assert.equal(await readLiveHandleSession("test-uuid-ext-2"), null, "空历史 → null");
  assert.equal(await readLiveHandleSession("test-uuid-ext-never-created"), null, "库内无此 id → null");
});

test("回退适配：getMessages throw → null（不冒烟）", async () => {
  const h = fakeHandle(null);
  h.getMessages = async () => { throw new Error("backend gone"); };
  putHandleAt("test-uuid-ext-3", h);
  assert.equal(await readLiveHandleSession("test-uuid-ext-3"), null);
});

// ── B4：rebindHandle——omp 进程生成 id 场景的别名换绑（docs/aiti-omp-agent-id-rebind-design.md）──

function fakeHandle2(messages) {
  return {
    id: "x",
    alive: () => true,
    subscribe: () => () => {},
    getMessages: async () => messages,
    dispose: async () => {},
  };
}

test("B4 rebindHandle：别名挂载 / 幂等 / 查重 / 坏输入", async () => {
  const h = fakeHandle2([{ role: "user", text: "q" }]);
  putHandleAt("placeholder-uuid", h);
  assert.equal(rebindHandle("placeholder-uuid", "real-native-id"), true);
  assert.equal(rebindHandle("placeholder-uuid", "real-native-id"), true, "幂等：已挂同 handle → true");
  putHandleAt("other", fakeHandle2([]));
  assert.equal(rebindHandle("placeholder-uuid", "other"), false, "newId 被其它 handle 占用 → 拒绝");
  assert.equal(rebindHandle("", "x"), false);
  assert.equal(rebindHandle("same", "same"), false);
  assert.equal(rebindHandle("missing-old", "new"), false);
});
