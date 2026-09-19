import assert from "node:assert/strict";
import test from "node:test";

import { openFileTab, openFolderTab, saveFileViewerState } from "./file-tab-state.ts";

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

// ── findDormantFileFacePath (guards the file-editor extension's lazy-materialization window) ──
import { findDormantFileFacePath } from "./file-tab-state.ts";

// Minimal localStorage stub (the node:test environment has no window)
function withFakeLocalStorage(entries, run) {
  const store = new Map(Object.entries(entries));
  const fake = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
  const g = globalThis;
  const had = "localStorage" in g;
  const prev = had ? g.localStorage : undefined;
  Object.defineProperty(g, "localStorage", { value: fake, configurable: true });
  try { run(); } finally {
    if (had) Object.defineProperty(g, "localStorage", { value: prev, configurable: true });
    else delete g.localStorage;
  }
}

test("findDormantFileFacePath returns the stored instance path on exact match", () => {
  withFakeLocalStorage({ "pi:sidebar-dock:files": JSON.stringify(["/repo/docs/plan.md"]) }, () => {
    assert.equal(findDormantFileFacePath("/repo/docs/plan.md"), "/repo/docs/plan.md");
  });
});

test("findDormantFileFacePath matches ignoring trailing slashes and backslash form", () => {
  withFakeLocalStorage({ "pi:sidebar-dock:files": JSON.stringify(["C:/repo/docs/plan.md"]) }, () => {
    assert.equal(findDormantFileFacePath("C:\\repo\\docs\\plan.md\\"), "C:/repo/docs/plan.md");
  });
});

test("findDormantFileFacePath returns null when the list is empty or malformed", () => {
  withFakeLocalStorage({ "pi:sidebar-dock:files": "not-json" }, () => {
    assert.equal(findDormantFileFacePath("/repo/docs/plan.md"), null);
  });
  withFakeLocalStorage({}, () => {
    assert.equal(findDormantFileFacePath("/repo/docs/plan.md"), null);
  });
  withFakeLocalStorage({ "pi:sidebar-dock:files": JSON.stringify(["/repo/other.md"]) }, () => {
    assert.equal(findDormantFileFacePath("/repo/docs/plan.md"), null);
  });
});
