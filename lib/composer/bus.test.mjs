import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  registerComposerEnhancement,
  setComposerWriter,
  getComposerWriter,
  emitComposerChange,
  emitComposerKeyChange,
  runComposerSubmit,
  resetComposerBusForTests,
} = await jiti.import("../../lib/composer/bus.ts");

test("register/dispose：disposer 精确移除本次注册", () => {
  resetComposerBusForTests();
  const seen = [];
  const off1 = registerComposerEnhancement({ id: "a", onChange: (s) => seen.push(`a:${s.value}`) });
  const off2 = registerComposerEnhancement({ id: "b", onChange: (s) => seen.push(`b:${s.value}`) });
  emitComposerChange({ value: "x", imageCount: 0, hasInput: true });
  assert.deepEqual(seen, ["a:x", "b:x"]);
  off1();
  seen.length = 0;
  emitComposerChange({ value: "y", imageCount: 0, hasInput: true });
  assert.deepEqual(seen, ["b:y"]);
  off2();
});

test("emitChange：单个 enhancer 抛错不影响其他与主流程", () => {
  resetComposerBusForTests();
  const seen = [];
  registerComposerEnhancement({ id: "boom", onChange: () => { throw new Error("boom"); } });
  registerComposerEnhancement({ id: "ok", onChange: (s) => seen.push(s.value) });
  emitComposerChange({ value: "z", imageCount: 0, hasInput: true });
  assert.deepEqual(seen, ["z"]);
});

test("runSubmit：按注册序链式替换，void 放行原文", () => {
  resetComposerBusForTests();
  registerComposerEnhancement({
    id: "upper",
    onSubmit: (t, ic) => ({ text: `${t}!ic=${ic}` }),
  });
  registerComposerEnhancement({ id: "noop", onSubmit: () => undefined });
  registerComposerEnhancement({ id: "wrap", onSubmit: (t) => ({ text: `<${t}>` }) });
  const out = runComposerSubmit("hi", 2);
  assert.equal(out, "<hi!ic=2>");
});

test("runSubmit：enhancer 抛错 → 原文放行到下一环", () => {
  resetComposerBusForTests();
  registerComposerEnhancement({ id: "boom", onSubmit: () => { throw new Error("x"); } });
  registerComposerEnhancement({ id: "suffix", onSubmit: (t) => ({ text: t + "+s" }) });
  assert.equal(runComposerSubmit("v", 0), "v+s");
});

test("keyChange 分发携带 prev/next；writer 可设置与取回", () => {
  resetComposerBusForTests();
  const calls = [];
  registerComposerEnhancement({ id: "k", onKeyChange: (p, n) => calls.push([p, n]) });
  emitComposerKeyChange("old", "new");
  emitComposerKeyChange(undefined, "first");
  assert.deepEqual(calls, [["old", "new"], [undefined, "first"]]);
  const w = { snapshot: () => ({ value: "", imageCount: 0, hasInput: false }), setValue: () => {} };
  setComposerWriter(w);
  assert.equal(getComposerWriter(), w);
  setComposerWriter(null);
  assert.equal(getComposerWriter(), null);
});
