/**
 * git-view-model.ts tests — render/navigation state matrix.
 *
 * Run: node --experimental-strip-types --test extensions/aiti-editor/client/src/git-view-model.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  AUTO_INLINE_BREAKPOINT, OUTLINE_BOTTOM_BREAKPOINT,
  deriveGitViewState, resolveRenderMode, pickJumpTarget, outlinePlacement,
} = await import("./git-view-model.ts");

const base = {
  isRepo: true, binary: false, ready: true,
  changed: true, dirty: false, status: "M",
  baseline: "ready", hasBaseline: true,
  view: "latest", outlineOpen: false, width: 1400,
};

test("clean file: no badge, no view switch, no outline", () => {
  const s = deriveGitViewState({ ...base, changed: false, dirty: false });
  assert.equal(s.hasDelta, false);
  assert.equal(s.controlsVisible, false);
  assert.equal(s.diffActive, false);
  assert.equal(s.outlineVisible, false);
});

test("dirty editor with a clean worktree still exposes the change view", () => {
  const s = deriveGitViewState({ ...base, changed: false, dirty: true, status: undefined });
  assert.equal(s.hasDelta, true);
  assert.equal(s.controlsVisible, true);
});

test("new file (A): badge only — view switch and outline are hidden", () => {
  const s = deriveGitViewState({ ...base, status: "A", outlineOpen: true });
  assert.equal(s.hasDelta, true);
  assert.equal(s.isNewFile, true);
  assert.equal(s.controlsVisible, false);
  assert.equal(s.outlineToggleVisible, false);
  assert.equal(s.outlineVisible, false);
  assert.equal(s.diffActive, false);
});

test("baseline pending: selector allowed, outline waits for the baseline", () => {
  const s = deriveGitViewState({ ...base, baseline: "pending", hasBaseline: null, outlineOpen: true, view: "side" });
  assert.equal(s.controlsVisible, true);
  assert.equal(s.diffActive, true);
  assert.equal(s.outlineToggleVisible, false);
  assert.equal(s.outlineVisible, false);
});

test("baseline error on M: explicit error state, no diff/outline", () => {
  const s = deriveGitViewState({ ...base, baseline: "error", hasBaseline: false, outlineOpen: true, view: "side" });
  assert.equal(s.baselineMissing, true);
  assert.equal(s.controlsVisible, true);   // badge still explains the state
  assert.equal(s.selectVisible, false);    // but the mode switch is disabled
  assert.equal(s.diffActive, false);
  assert.equal(s.outlineVisible, false);
});

test("non-repo, binary and not-ready never expose the change view", () => {
  for (const patch of [{ isRepo: false }, { binary: true }, { ready: false }]) {
    const s = deriveGitViewState({ ...base, ...patch });
    assert.equal(s.hasDelta, false, JSON.stringify(patch));
    assert.equal(s.controlsVisible, false);
  }
});

test("side-by-side auto-inlines below the VSCode 900px breakpoint", () => {
  assert.equal(AUTO_INLINE_BREAKPOINT, 900);
  assert.equal(resolveRenderMode("side", 1400), "side");
  assert.equal(resolveRenderMode("side", 900), "side");
  assert.equal(resolveRenderMode("side", 899), "inline");
  const narrow = deriveGitViewState({ ...base, view: "side", width: 398 });
  assert.equal(narrow.renderMode, "inline");
  assert.equal(narrow.autoInlined, true);
  assert.equal(narrow.diffActive, true); // still a diff view, just unified
});

test("explicit inline is never upgraded, latest never degrades", () => {
  assert.equal(resolveRenderMode("inline", 2400), "inline");
  assert.equal(resolveRenderMode("latest", 320), "latest");
  assert.equal(deriveGitViewState({ ...base, view: "inline", width: 2400 }).autoInlined, false);
});

test("outline visibility is orthogonal to the render mode", () => {
  for (const view of ["latest", "side", "inline"]) {
    const s = deriveGitViewState({ ...base, view, outlineOpen: true, width: 1400 });
    assert.equal(s.outlineVisible, true, view);
    assert.equal(s.outlineToggleVisible, true, view);
  }
});

test("pickJumpTarget dispatches to the editor in latest mode and the diff otherwise", () => {
  assert.deepEqual(pickJumpTarget("latest", 12), { kind: "editor", line: 12 });
  assert.deepEqual(pickJumpTarget("side", 12), { kind: "diff", line: 12 });
  assert.deepEqual(pickJumpTarget("inline", 12), { kind: "diff", line: 12 });
  assert.deepEqual(pickJumpTarget("latest", 0), { kind: "editor", line: 1 });
  assert.deepEqual(pickJumpTarget("latest", undefined), { kind: "editor", line: 1 });
});

test("outline docks at the bottom on narrow viewports", () => {
  assert.equal(OUTLINE_BOTTOM_BREAKPOINT, 640);
  assert.equal(outlinePlacement(1400), "right");
  assert.equal(outlinePlacement(640), "right");
  assert.equal(outlinePlacement(639), "bottom");
  assert.equal(outlinePlacement(398), "bottom");
});
