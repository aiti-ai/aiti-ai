import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { computeMobileComposerMatrix: matrix, base64ToBlob } = await jiti.import("./ChatInput.tsx");

const BASE = {
  isStreaming: false,
  hasInputText: false,
  imageCount: 0,
  canSteerFromQueue: false,
  hasSteerCapability: true,
  hasFollowUpCapability: true,
  hasAbortCapability: true,
};

test("mobile matrix v4: 空闲·空输入 = ＋/图片恒驻；条件组仅「继续」待上浮", () => {
  const m = matrix(BASE);
  assert.deepEqual(
    { plus: m.plus, image: m.image, clear: m.clear, cont: m.cont, send: m.send, stop: m.stop, steer: m.steer, clock: m.clock },
    { plus: true, image: true, clear: false, cont: true, send: false, stop: false, steer: false, clock: false },
  );
});

test("mobile matrix v4: 空闲·有内容 = ＋/图片/×清空/发送；继续退出", () => {
  const m = matrix({ ...BASE, hasInputText: true });
  assert.deepEqual(
    { plus: m.plus, image: m.image, clear: m.clear, cont: m.cont, send: m.send, stop: m.stop, steer: m.steer, clock: m.clock },
    { plus: true, image: true, clear: true, cont: false, send: true, stop: false, steer: false, clock: false },
  );
  // 纯图片也算有内容（与发送可用条件一致）
  const m2 = matrix({ ...BASE, imageCount: 2 });
  assert.equal(m2.send, true);
  assert.equal(m2.clear, true);
  assert.equal(m2.cont, false);
});

test("mobile matrix v4: 运行中·空输入 = 停止浮出；插队/排队不出现（非空才显，canSteerFromQueue 回归队列横幅）", () => {
  const m = matrix({ ...BASE, isStreaming: true, canSteerFromQueue: true });
  assert.deepEqual(
    { plus: m.plus, image: m.image, clear: m.clear, cont: m.cont, send: m.send, stop: m.stop, steer: m.steer, clock: m.clock },
    { plus: true, image: true, clear: false, cont: false, send: false, stop: true, steer: false, clock: false },
  );
  // 外部 agent 无 abort 能力 → 停止缺席（＋/图片仍恒驻）
  const m2 = matrix({ ...BASE, isStreaming: true, hasAbortCapability: false });
  assert.equal(m2.stop, false);
  assert.equal(m2.plus, true);
  assert.equal(m2.image, true);
});

test("mobile matrix v4/五审: 运行中·有内容 = [×随输入框, 停止, 插队, 排队]；发送不渲染（与插队重复——steer 唯一入口=插队）", () => {
  const m = matrix({ ...BASE, isStreaming: true, hasInputText: true });
  assert.deepEqual(
    { plus: m.plus, image: m.image, clear: m.clear, cont: m.cont, send: m.send, stop: m.stop, steer: m.steer, clock: m.clock },
    { plus: true, image: true, clear: true, cont: false, send: false, stop: true, steer: true, clock: true },
  );
});

test("mobile matrix v4/九审: 运行中带图 = 插队/排队可用（带图解禁，链路透传 images），× 仍可用", () => {
  const m = matrix({ ...BASE, isStreaming: true, imageCount: 1 });
  assert.equal(m.steerReady, true);
  assert.equal(m.sendEnabled, true);
  assert.equal(m.clear, true);
  // 存在性=有内容（带图也算）；九审起带图不再禁用
  assert.equal(m.steer, true);
  assert.equal(m.clock, true);
  // steer/followUp 能力缺失 → 插队/排队缺席
  const m2 = matrix({ ...BASE, isStreaming: true, hasInputText: true, hasSteerCapability: false, hasFollowUpCapability: false });
  assert.equal(m2.steer, false);
  assert.equal(m2.clock, false);
  assert.equal(m2.stop, true);
});

test("mobile matrix v4/十审: placeholder 与大屏同逻辑（自写档位矩阵已废弃，渲染层直接三态 i18n）", () => {
  // computeMobilePlaceholder/mobilePlaceholderI18nKey 已从模块导出中移除
  return jiti.import("./ChatInput.tsx").then((mod) => {
    assert.equal("computeMobilePlaceholder" in mod, false);
    assert.equal("mobilePlaceholderI18nKey" in mod, false);
  });
});

test("base64ToBlob: 清空撤销的图片 previewUrl 重建原料", () => {
  const blob = base64ToBlob(Buffer.from("hello").toString("base64"), "image/png");
  assert.equal(blob.type, "image/png");
  assert.equal(blob.size, 5);
});
