import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { computeMobileComposerMatrix: matrix, computeMobilePlaceholder: placeholder, mobilePlaceholderI18nKey, base64ToBlob } = await jiti.import("./ChatInput.tsx");

const BASE = {
  isStreaming: false,
  hasInputText: false,
  imageCount: 0,
  canSteerFromQueue: false,
  hasSteerCapability: true,
  hasFollowUpCapability: true,
  hasAbortCapability: true,
};

test("mobile matrix §三: 空闲·空输入 = [prompt, ＋] + 🎤 插槽，无 stop/steer/clock/发送", () => {
  const m = matrix(BASE);
  assert.deepEqual(
    { prompt: m.prompt, plus: m.plus, stop: m.stop, steer: m.steer, clock: m.clock, send: m.send, clear: m.clear, affixSlot: m.affixSlot },
    { prompt: true, plus: true, stop: false, steer: false, clock: false, send: false, clear: false, affixSlot: true },
  );
});

test("mobile matrix §三: 空闲·有内容 = ×清空 + 发送；prompt/＋/🎤 消失（v3 瘦身：左组空）", () => {
  const m = matrix({ ...BASE, hasInputText: true });
  assert.deepEqual(
    { prompt: m.prompt, plus: m.plus, stop: m.stop, steer: m.steer, clock: m.clock, send: m.send, clear: m.clear, affixSlot: m.affixSlot },
    { prompt: false, plus: false, stop: false, steer: false, clock: false, send: true, clear: true, affixSlot: false },
  );
  // 纯图片也算有内容（与发送可用条件一致）
  const m2 = matrix({ ...BASE, imageCount: 2 });
  assert.equal(m2.send, true);
  assert.equal(m2.clear, true);
  assert.equal(m2.affixSlot, false);
});

test("mobile matrix §三: 运行中·空输入 = [stop, steer, ⏰, ＋] + 🎤；＋ 能力缺失可整组缺席", () => {
  const m = matrix({ ...BASE, isStreaming: true });
  assert.deepEqual(
    { prompt: m.prompt, plus: m.plus, stop: m.stop, steer: m.steer, clock: m.clock, send: m.send, clear: m.clear, affixSlot: m.affixSlot },
    { prompt: false, plus: true, stop: true, steer: true, clock: true, send: false, clear: false, affixSlot: true },
  );
  // 外部 agent 无 steer/followUp/abort 能力 → 按钮缺席（不影响 ＋/affix）
  const m2 = matrix({ ...BASE, isStreaming: true, hasSteerCapability: false, hasFollowUpCapability: false, hasAbortCapability: false });
  assert.equal(m2.stop, false);
  assert.equal(m2.steer, false);
  assert.equal(m2.clock, false);
  assert.equal(m2.plus, true);
});

test("mobile matrix §三: 运行中·有内容 = [steer, ⏰] + × + 发送；stop 消失（打字不误停）", () => {
  const m = matrix({ ...BASE, isStreaming: true, hasInputText: true });
  assert.deepEqual(
    { prompt: m.prompt, plus: m.plus, stop: m.stop, steer: m.steer, clock: m.clock, send: m.send, clear: m.clear, affixSlot: m.affixSlot },
    { prompt: false, plus: false, stop: false, steer: true, clock: true, send: true, clear: true, affixSlot: false },
  );
});

test("mobile matrix §三/S8: 运行中带图 steer/⏰/发送禁用（steerReady=false），× 仍可用", () => {
  const m = matrix({ ...BASE, isStreaming: true, imageCount: 1 });
  assert.equal(m.steerReady, false);
  assert.equal(m.sendEnabled, false);
  assert.equal(m.clear, true);
  // steer 图标仍在（disabled 态），canSteerFromQueue 也可救活空输入 steer
  assert.equal(m.steer, true);
});

test("mobile matrix S9: 空输入 + followUp 队列非空 → steer 存在（disabled 由组件按 canSteerFromQueue 计算）", () => {
  const m = matrix({ ...BASE, isStreaming: true, canSteerFromQueue: true });
  assert.equal(m.steer, true);
  assert.equal(m.steerReady, false);
  assert.equal(m.sendEnabled, false);
});

test("mobile placeholder §七: 优先级 P1 > P2 > P3 > P4 > agent > P5b/P5 > P6", () => {
  const b = { isStreaming: true, hasSteerCapability: true, hasInputText: false, imageCount: 0, followStreaming: true, bashMode: false, bashExcluded: false, queueCount: 0 };
  assert.equal(placeholder(b).key, "runFollow");                    // P4
  assert.equal(placeholder({ ...b, followStreaming: false }).key, "runPaused"); // P3
  assert.equal(placeholder({ ...b, hasInputText: true }).key, "steer");          // P2
  assert.equal(placeholder({ ...b, hasInputText: true, imageCount: 1 }).key, "runImages"); // P1
  assert.equal(placeholder({ ...b, isStreaming: false }).key, "message");        // P6
  assert.equal(placeholder({ ...b, isStreaming: false, bashMode: true }).key, "shellModel");   // P5
  assert.equal(placeholder({ ...b, isStreaming: false, bashMode: true, bashExcluded: true }).key, "shellLocal"); // P5b
  assert.equal(placeholder({ ...b, isStreaming: true, hasSteerCapability: false }).key, "agent");
});

test("mobile placeholder §七: queueCount>0 追加队列后缀", () => {
  const r = placeholder({ isStreaming: false, hasSteerCapability: true, hasInputText: false, imageCount: 0, followStreaming: true, bashMode: false, bashExcluded: false, queueCount: 3 });
  assert.equal(r.queueCount, 3);
  assert.equal(placeholder({ isStreaming: false, hasSteerCapability: true, hasInputText: false, imageCount: 0, followStreaming: true, bashMode: false, bashExcluded: false, queueCount: 0 }).queueCount, null);
});

test("mobile placeholder: i18n key 映射齐全", () => {
  for (const key of ["runImages", "steer", "runPaused", "runFollow", "agent", "shellLocal", "shellModel", "message"]) {
    assert.match(mobilePlaceholderI18nKey(key), /^chat\./);
  }
});

test("base64ToBlob: 清空撤销的图片 previewUrl 重建原料", () => {
  const blob = base64ToBlob(Buffer.from("hello").toString("base64"), "image/png");
  assert.equal(blob.type, "image/png");
  assert.equal(blob.size, 5);
});
