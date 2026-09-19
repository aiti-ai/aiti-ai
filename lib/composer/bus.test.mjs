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
  emitComposerClearToTrash,
  setComposerTrashWriter,
  getComposerTrashWriter,
  runComposerSubmit,
  resetComposerBusForTests,
} = await jiti.import("../../lib/composer/bus.ts");

test("register/dispose: disposer removes exactly its own registration", () => {
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

test("emitChange: one enhancer throwing does not affect others or the main flow", () => {
  resetComposerBusForTests();
  const seen = [];
  registerComposerEnhancement({ id: "boom", onChange: () => { throw new Error("boom"); } });
  registerComposerEnhancement({ id: "ok", onChange: (s) => seen.push(s.value) });
  emitComposerChange({ value: "z", imageCount: 0, hasInput: true });
  assert.deepEqual(seen, ["z"]);
});

test("runSubmit: chained replacement in registration order; void passes the original text through", () => {
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

test("runSubmit: a throwing enhancer passes the original text to the next link", () => {
  resetComposerBusForTests();
  registerComposerEnhancement({ id: "boom", onSubmit: () => { throw new Error("x"); } });
  registerComposerEnhancement({ id: "suffix", onSubmit: (t) => ({ text: t + "+s" }) });
  assert.equal(runComposerSubmit("v", 0), "v+s");
});

test("keyChange dispatch carries prev/next; writer can be set and read back", () => {
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

test("hasComposerEnhancement + subscriber notifications (both register and dispose trigger)", async () => {
  resetComposerBusForTests();
  const { subscribeComposerEnhancers, hasComposerEnhancement, getComposerEnhancersVersion } = await jiti.import("../../lib/composer/bus.ts");
  let events = 0;
  const off = subscribeComposerEnhancers(() => events++);
  assert.equal(hasComposerEnhancement("x"), false);
  const dispose = registerComposerEnhancement({ id: "x" });
  assert.equal(hasComposerEnhancement("x"), true);
  dispose();
  assert.equal(hasComposerEnhancement("x"), false);
  off();
  assert.ok(getComposerEnhancersVersion() >= 2); // one increment each for register + dispose
});

test("clear-to-trash dispatch: only enhancers registered with onClearToTrash are called; returns whether one took over", () => {
  resetComposerBusForTests();
  setComposerTrashWriter(null);
  const snap = { value: "hello", imageCount: 1, hasInput: true };
  // no enhancers → not taken over
  assert.equal(emitComposerClearToTrash(snap), false);
  // an enhancer registered with onClearToTrash → receives the snapshot and takes over (returns true)
  const calls = [];
  registerComposerEnhancement({
    id: "trash-1",
    onClearToTrash: (s) => calls.push(["t1", s.value]),
  });
  registerComposerEnhancement({ id: "other" }); // no onClearToTrash, does not participate
  assert.equal(emitComposerClearToTrash(snap), true);
  assert.deepEqual(calls, [["t1", "hello"]]);
});

test("trash writer can be set and read back (core wiring / extensions read via ctx)", () => {
  resetComposerBusForTests();
  setComposerTrashWriter(null);
  assert.equal(getComposerTrashWriter(), null);
  const w = (s) => void s;
  setComposerTrashWriter(w);
  assert.equal(getComposerTrashWriter(), w);
  setComposerTrashWriter(null);
  assert.equal(getComposerTrashWriter(), null);
});
