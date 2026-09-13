import assert from "node:assert/strict";
import test from "node:test";

import { openFileTab, openFolderTab, saveFileViewerState, openImageTab, imageTabId } from "./file-tab-state.ts";

const tabA = {
  id: "file:/repo/a.ts",
  label: "a.ts",
  filePath: "/repo/a.ts",
  viewerRevision: 0,
  viewerState: {
    displayMode: "source",
    wrapLines: true,
    scrollTop: 240,
    scrollLeft: 16,
  },
};

const tabB = {
  id: "file:/repo/b.ts",
  label: "b.ts",
  filePath: "/repo/b.ts",
  viewerRevision: 0,
};

const openA = {
  fileName: "a.ts",
  filePath: "/repo/a.ts",
  tabId: "file:/repo/a.ts",
};

test("saving viewer state updates only the matching revision", () => {
  const tabs = [tabA, tabB];
  const nextState = { ...tabA.viewerState, scrollTop: 480 };
  const saved = saveFileViewerState(tabs, tabA.id, 0, nextState);

  assert.notStrictEqual(saved, tabs);
  assert.deepEqual(saved[0].viewerState, nextState);
  assert.strictEqual(saved[1], tabB);

  const stale = saveFileViewerState(saved, tabA.id, 9, tabA.viewerState);
  assert.strictEqual(stale, saved);
});

test("opening an existing tab normally preserves its state and revision", () => {
  const tabs = [tabA, tabB];
  assert.strictEqual(openFileTab(tabs, openA), tabs);
});

test("changing the source session remounts the viewer without losing its state", () => {
  const [next] = openFileTab([tabA], { ...openA, sourceSessionId: "session-2" });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.strictEqual(next.viewerState, tabA.viewerState);
});

test("opening from the same source session preserves the viewer revision", () => {
  const tab = { ...tabA, sourceSessionId: "session-1" };
  const tabs = [tab];
  assert.strictEqual(
    openFileTab(tabs, { ...openA, sourceSessionId: "session-1" }),
    tabs,
  );
});

test("changing source while forcing diff increments the revision once", () => {
  const [next] = openFileTab([tabA], {
    ...openA,
    sourceSessionId: "session-2",
    modeHint: "diff",
  });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.equal(next.viewerState.displayMode, "diff");
});

test("every explicit diff activation resets the mode and increments the revision", () => {
  const first = openFileTab([tabA, tabB], { ...openA, modeHint: "diff" });
  assert.equal(first[0].viewerRevision, 1);
  assert.deepEqual(first[0].viewerState, {
    displayMode: "diff",
    wrapLines: true,
    scrollTop: 0,
    scrollLeft: 0,
  });

  const returnedToSource = saveFileViewerState(first, tabA.id, 1, tabA.viewerState);
  const second = openFileTab(returnedToSource, { ...openA, modeHint: "diff" });
  assert.equal(second[0].viewerRevision, 2);
  assert.equal(second[0].viewerState.displayMode, "diff");
});

test("a remounted viewer ignores the previous revision's late cleanup", () => {
  const reopened = openFileTab([tabA], { ...openA, modeHint: "diff" });
  const stale = saveFileViewerState(reopened, tabA.id, 0, tabA.viewerState);
  assert.strictEqual(stale, reopened);
  assert.equal(stale[0].viewerState.displayMode, "diff");
});

const openFolderA = {
  folderName: "src",
  folderPath: "/repo/src",
  tabId: "folder:/repo/src",
};

test("opening a folder tab adds a folder-kind tab", () => {
  const tabs = openFolderTab([tabA], openFolderA);
  assert.equal(tabs.length, 2);
  assert.equal(tabs[1].id, "folder:/repo/src");
  assert.equal(tabs[1].kind, "folder");
  assert.equal(tabs[1].label, "src");
  assert.equal(tabs[1].filePath, "/repo/src");
});

test("reopening an already-open folder is a no-op (caller reselects)", () => {
  const first = openFolderTab([tabA], openFolderA);
  const second = openFolderTab(first, openFolderA);
  assert.strictEqual(second, first);
});

// ── 图片预览 tab（消息图片多开预览，src 无磁盘路径） ──

test("image tab ids are stable per src and carry an image: prefix", () => {
  assert.match(imageTabId("data:image/png;base64,AAA"), /^image:/);
  assert.strictEqual(
    imageTabId("data:image/png;base64,AAA"),
    imageTabId("data:image/png;base64,AAA"),
  );
  assert.notEqual(
    imageTabId("data:image/png;base64,AAA"),
    imageTabId("data:image/png;base64,BBB"),
  );
});

test("opening an image tab appends a kind:image tab holding the src", () => {
  const src = "data:image/png;base64,AAA";
  const tabs = openImageTab([tabB], { src, label: "图片", tabId: imageTabId(src) });
  assert.equal(tabs.length, 2);
  assert.equal(tabs[1].kind, "image");
  assert.equal(tabs[1].imageSrc, src);
  assert.equal(tabs[1].label, "图片");
  assert.equal(tabs[1].filePath, "");
});

test("reopening the same image is idempotent (caller reselects)", () => {
  const src = "data:image/png;base64,AAA";
  const input = { src, label: "图片", tabId: imageTabId(src) };
  const tabs = openImageTab([], input);
  assert.strictEqual(openImageTab(tabs, input), tabs);
});

test("same tabId with a different src updates the tab in place (hash collision / refreshed URL)", () => {
  const tabs = openImageTab([], { src: "a", label: "图片", tabId: "image:collision" });
  const next = openImageTab(tabs, { src: "b", label: "图片2", tabId: "image:collision" });
  assert.notStrictEqual(next, tabs);
  assert.equal(next.length, 1);
  assert.equal(next[0].imageSrc, "b");
  assert.equal(next[0].label, "图片2");
});
