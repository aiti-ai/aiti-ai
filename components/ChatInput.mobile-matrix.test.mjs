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

test("mobile matrix v4: idle with empty input = plus/image always present; only \"continue\" among the conditional group floats up", () => {
  const m = matrix(BASE);
  assert.deepEqual(
    { plus: m.plus, image: m.image, clear: m.clear, cont: m.cont, send: m.send, stop: m.stop, steer: m.steer, clock: m.clock, fork: m.fork },
    { plus: true, image: true, clear: false, cont: true, send: false, stop: false, steer: false, clock: false, fork: false },
  );
});

test("mobile matrix v4: idle with content = plus/image/clear/send; continue exits", () => {
  const m = matrix({ ...BASE, hasInputText: true });
  assert.deepEqual(
    { plus: m.plus, image: m.image, clear: m.clear, cont: m.cont, send: m.send, stop: m.stop, steer: m.steer, clock: m.clock, fork: m.fork },
    { plus: true, image: true, clear: true, cont: false, send: true, stop: false, steer: false, clock: false, fork: true },
  );
  // Images alone count as content (consistent with the send-enabled condition)
  const m2 = matrix({ ...BASE, imageCount: 2 });
  assert.equal(m2.send, true);
  assert.equal(m2.clear, true);
  assert.equal(m2.cont, false);
  assert.equal(m2.fork, true);
});

test("mobile matrix v4 / 11th review: streaming with empty input = stop floats up; steer appears when a queue exists (first queued dispatch is a steer, S9a regression)", () => {
  const m = matrix({ ...BASE, isStreaming: true, canSteerFromQueue: true });
  assert.deepEqual(
    { plus: m.plus, image: m.image, clear: m.clear, cont: m.cont, send: m.send, stop: m.stop, steer: m.steer, clock: m.clock, fork: m.fork },
    { plus: true, image: true, clear: false, cont: false, send: false, stop: true, steer: true, clock: false, fork: false },
  );
  // No queue → steer absent; external agent without abort capability → stop absent (plus/image still always present)
  const m1 = matrix({ ...BASE, isStreaming: true });
  assert.equal(m1.steer, false);
  const m2 = matrix({ ...BASE, isStreaming: true, hasAbortCapability: false });
  assert.equal(m2.stop, false);
  assert.equal(m2.plus, true);
  assert.equal(m2.image, true);
});

test("mobile matrix v4 / 5th review: streaming with content = [clear inline, stop, steer, queue]; send not rendered (redundant with steer — steer's only entry is the steer button)", () => {
  const m = matrix({ ...BASE, isStreaming: true, hasInputText: true });
  assert.deepEqual(
    { plus: m.plus, image: m.image, clear: m.clear, cont: m.cont, send: m.send, stop: m.stop, steer: m.steer, clock: m.clock, fork: m.fork },
    { plus: true, image: true, clear: true, cont: false, send: false, stop: true, steer: true, clock: true, fork: true },
  );
});

test("mobile matrix v4 / 9th review: streaming with images = steer/queue available (image lockout lifted, images passed down the chain); clear still available", () => {
  const m = matrix({ ...BASE, isStreaming: true, imageCount: 1 });
  assert.equal(m.steerReady, true);
  assert.equal(m.sendEnabled, true);
  assert.equal(m.clear, true);
  // Presence = has content (images count); since the 9th review, images no longer disable it; fork likewise shows based on content
  assert.equal(m.steer, true);
  assert.equal(m.clock, true);
  assert.equal(m.fork, true);
  // Missing steer/followUp capability → steer/queue absent
  const m2 = matrix({ ...BASE, isStreaming: true, hasInputText: true, hasSteerCapability: false, hasFollowUpCapability: false });
  assert.equal(m2.steer, false);
  assert.equal(m2.clock, false);
  assert.equal(m2.stop, true);
});

test("mobile matrix v4 / 10th review: placeholder shares the desktop logic (the bespoke tier matrix is retired; the render layer uses the three-state i18n directly)", () => {
  // computeMobilePlaceholder/mobilePlaceholderI18nKey have been removed from the module exports
  return jiti.import("./ChatInput.tsx").then((mod) => {
    assert.equal("computeMobilePlaceholder" in mod, false);
    assert.equal("mobilePlaceholderI18nKey" in mod, false);
  });
});

test("base64ToBlob: rebuilds the raw material for previewUrl of cleared/undone images", () => {
  const blob = base64ToBlob(Buffer.from("hello").toString("base64"), "image/png");
  assert.equal(blob.type, "image/png");
  assert.equal(blob.size, 5);
});
