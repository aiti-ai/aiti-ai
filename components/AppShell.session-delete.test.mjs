import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function handleSessionDeletedBody() {
  const start = source.indexOf("  const handleSessionDeleted = useCallback");
  const end = source.indexOf("  const handleOpenFile = useCallback", start);
  assert.notEqual(start, -1, "handleSessionDeleted callback not found");
  assert.notEqual(end, -1, "handleOpenFile callback not found after handleSessionDeleted");
  return source.slice(start, end);
}

// Runs the actual callback in a vm sandbox. `capturedSelectedSession` models
// the stale state the closure captured at the delete click; `active` is what
// the render-synced ref holds when the DELETE finally completes.
function runHandleSessionDeleted(capturedSelectedSession, active) {
  const state = {
    setSelectedSession: [],
    setNewSessionCwd: [],
    newSessionDraftId: null,
    sessionKey: 0,
    routerReplaced: null,
    refreshBumped: false,
  };
  const context = vm.createContext({
    crypto: globalThis.crypto,
    window: { location: { pathname: "/", search: "" } },
    router: { replace: (url) => { state.routerReplaced = url; } },
    capturedSelectedSession,
    selectedSession: capturedSelectedSession, // the stale closure value, if the code reads it
    selectedSessionRef: { current: active },
    activeNewSessionDraftKeyRef: { current: null },
    invalidateWorkspaceRestore() {},
    clearTabOpenSession() {},
    setRefreshKey: () => { state.refreshBumped = true; },
    setNewSessionDraftId: (id) => { state.newSessionDraftId = id; },
    setSelectedSession: (value) => { state.setSelectedSession.push(value); },
    setNewSessionCwd: (value) => { state.setNewSessionCwd.push(value); },
    setSessionKey: (fn) => { state.sessionKey = fn(state.sessionKey); },
    setBranchTree() {},
    setBranchActiveLeafId() {},
    setBranchSwitchLocked() {},
    setSystemPrompt() {},
    setSystemTools() {},
    setSystemInfoLoading() {},
    setActiveTopPanel() {},
    useCallback: (callback) => callback,
    // 合并：handleSessionDeleted 融入移动端分流/文件页签恢复
    isMobile: false, revealFileTabOnOpen: () => {}, inAppPathname: (p) => p, apiUrl: (p) => p,
    getDraftApi: () => null, apiRekeyDraft() {}, apiHasDraft: () => false,
    sessionSourceRef: { current: null }, urlRestoredSessionRef: { current: null }, setNewSessionWorkspace() {},
    // 合并：路由写入走 basePath 安全包装 replaceLocationIfChanged —— 记录到同一观测点
    replaceLocationIfChanged: (router, url) => { state.routerReplaced = url; },
  });
  vm.runInContext(stripTypeScriptTypes(`${handleSessionDeletedBody()}
    handleSessionDeleted("gone-session");
  `), context);
  return state;
}

test("the delete callback guards on the render-synced ref, not captured state", () => {
  const body = handleSessionDeletedBody();
  assert.match(body, /const active = selectedSessionRef\.current;/);
  assert.match(body, /if \(active\?\.id === sessionId\)/);
  assert.doesNotMatch(body, /selectedSession\?\.id === sessionId/);
  assert.match(body, /\}, \[invalidateWorkspaceRestore, router\]\);/);
  assert.match(
    source,
    /const selectedSessionRef = useRef\(selectedSession\);\n  selectedSessionRef\.current = selectedSession;/,
  );
});

test("an extension's session end leaves the session and closes only its panel", () => {
  assert.match(source, /onSessionEnded=\{handleSessionEnded\}/);
  const start = source.indexOf("  const handleSessionEnded = useCallback");
  const end = source.indexOf("  // The Agents switcher's Delete", start);
  const state = { deleted: [], closed: [] };
  const context = vm.createContext({
    useCallback: (callback) => callback,
    handleSessionDeleted: (id) => state.deleted.push(id),
    handleCloseFileTab: (id) => state.closed.push(id),
  });
  vm.runInContext(stripTypeScriptTypes(`${source.slice(start, end)}
    handleSessionEnded("side-session");
  `), context);
  assert.deepEqual(state.deleted, ["side-session"]);
  assert.deepEqual(state.closed, ["agent:side-session"]);
});

test("a delete completing after the user navigated away keeps the new chat", () => {
  const deleting = { id: "gone-session", cwd: "/project-a", projectKey: "/project-a" };
  const navigatedTo = { id: "next-session", cwd: "/project-b", projectKey: "/project-b" };
  const state = runHandleSessionDeleted(deleting, navigatedTo);
  assert.equal(state.refreshBumped, true, "sidebar list still refreshes");
  assert.deepEqual(state.setSelectedSession, [], "selection is untouched");
  assert.deepEqual(state.setNewSessionCwd, [], "no empty composer");
  assert.equal(state.newSessionDraftId, null);
  assert.equal(state.sessionKey, 0, "chat does not remount");
  assert.equal(state.routerReplaced, null, "URL does not move");
});

test("a delete completing while the user is still on it falls back to the empty composer", () => {
  const session = { id: "gone-session", cwd: "/project-a", projectKey: "/project-a" };
  const state = runHandleSessionDeleted(session, session);
  assert.equal(state.refreshBumped, true);
  assert.deepEqual(state.setSelectedSession, [null]);
  assert.deepEqual(state.setNewSessionCwd, ["/project-a"]);
  assert.ok(state.newSessionDraftId);
  assert.equal(state.sessionKey, 1, "chat remounts as a fresh composer");
  assert.equal(state.routerReplaced, "/"); // [URL 规范] cwd 不进 URL：落裸应用路径，cwd 走 tab-session
});

test("a side chat's stored draft goes only once its delete succeeded", async () => {
  const start = source.indexOf("  const handleDeleteSideChat = useCallback");
  const end = source.indexOf("\n  }, [", start);
  assert.notEqual(start, -1, "handleDeleteSideChat callback not found");
  for (const refusal of [null, { error: "HTTP 500" }]) {
    const cleared = [];
    const context = vm.createContext({
      useCallback: (callback) => callback,
      deleteSideChat: async () => refusal,
      // [fork] drafts go through the draft-keeper API, not lib/draft-store directly.
      getDraftApi: () => ({ clearAllDrafts: (id) => cleared.push(id) }),
      handleCloseFileTab() {},
      selectedSessionRef: { current: null },
      handleSelectSession() {},
      setRefreshKey() {},
      handleSessionDeleted() {},
    });
    const handleDeleteSideChat = vm.runInContext(stripTypeScriptTypes(`${source.slice(start, end)}\n  }, []);\nhandleDeleteSideChat`), context);
    const error = await handleDeleteSideChat("side-chat", { id: "main" });
    assert.equal(error, refusal?.error ?? null);
    assert.deepEqual(cleared, refusal ? [] : ["side-chat"]);
  }
});
