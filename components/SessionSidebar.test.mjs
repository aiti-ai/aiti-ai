import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { SessionSidebar, sameIdsOr } = await jiti.import("./SessionSidebar.tsx");
const { buildSessionTree, getRowOffsets, getVisibleRowIndices } = await jiti.import("@/lib/session-tree.ts");

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const treeSource = await readFile(new URL("./SessionTree.tsx", import.meta.url), "utf8");
const searchSource = await readFile(new URL("./SessionSearch.tsx", import.meta.url), "utf8");
const globalStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const sidebarStyles = await readFile(new URL("../app/sidebar.css", import.meta.url), "utf8");

const h = React.createElement;
const noop = () => {};
const BASE = Date.parse("2026-10-01T00:00:00.000Z");

function between(startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(start, -1, `${startAnchor} not found`);
  assert.notEqual(end, -1, `${endAnchor} not found after ${startAnchor}`);
  return source.slice(start, end);
}

/** A sidebar callback's body: from its declaration to the next `const` of the component. */
function callbackBody(name) {
  return between(`const ${name} = `, "\n  const ");
}

function session(id, { project = "/work/alpha", modified = BASE, ...rest } = {}) {
  const time = new Date(modified).toISOString();
  return {
    path: `${project}/${id}.jsonl`,
    id,
    cwd: project,
    projectRoot: project,
    projectKey: project,
    created: time,
    modified: time,
    messageCount: 1,
    firstMessage: id,
    ...rest,
  };
}

function treeInput(overrides = {}) {
  return {
    sessions: [],
    uiState: { version: 1, revision: 0, sessions: {}, projects: {} },
    runningIds: new Set(),
    unreadIds: new Set(),
    selectedSessionId: null,
    currentProject: null,
    groupExpansion: {},
    moreShown: {},
    pinnedCollapsed: false,
    ...overrides,
  };
}

function render(props = {}) {
  return renderToStaticMarkup(h(I18nProvider, null, h(SessionSidebar, {
    selectedSessionId: null,
    onSelectSession: noop,
    ...props,
  })));
}

/** The opening tag of the element with this id. */
function openingTag(html, id) {
  const match = html.match(new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]*>`));
  assert.ok(match, `#${id} not rendered`);
  return match[0];
}

test("scrolling keeps the focused session and the viewport mounted without expanding the whole tree", () => {
  const sessions = Array.from({ length: 2000 }, (_, index) => session(`s${index}`, { modified: BASE - index * 60_000 }));
  const { rows } = buildSessionTree(treeInput({ sessions, currentProject: { key: "/work/alpha", root: "/work/alpha" }, moreShown: { "/work/alpha": 5000 } }));
  const offsets = getRowOffsets(rows, "desktop");
  const lastSessionIndex = rows.findLastIndex((row) => row.kind === "session");
  for (const [scrollTop, focusedIndex] of [[0, lastSessionIndex], [30000, 1]]) {
    const indices = getVisibleRowIndices(offsets, scrollTop, 335, 240, [focusedIndex]);
    for (let index = 0; index < rows.length; index++) {
      const intersects = offsets[index + 1] > scrollTop && offsets[index] < scrollTop + 335;
      if (intersects) assert.ok(indices.includes(index), `row ${index} in the viewport is mounted`);
    }
    assert.ok(indices.includes(focusedIndex), "an inline rename survives scrolling");
    assert.ok(indices.length < 60, "only a window of the tree is mounted");
    assert.equal(new Set(indices).size, indices.length);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  }
});

test("session windows stay valid after a project shrinks and before the viewport is measured", () => {
  const { rows } = buildSessionTree(treeInput({ sessions: [session("only")] }));
  const offsets = getRowOffsets(rows, "mobile");
  assert.deepEqual(getVisibleRowIndices(offsets, 80000, 335, 240, [1999]), []);
  assert.deepEqual(getVisibleRowIndices(offsets, 0, 0, 0), rows.map((_, index) => index));
  assert.deepEqual(getVisibleRowIndices([0], 0, 335, 240, [3]), []);
});

test("subagents fold into their main session row, which carries their running, unread and selected state", () => {
  const child = session("child", { relation: { kind: "subagent", parentSessionId: "main", profile: "explore", description: "", status: "running" } });
  const { rows } = buildSessionTree(treeInput({
    sessions: [session("main"), child],
    runningIds: new Set(["child"]),
    unreadIds: new Set(["child"]),
    selectedSessionId: "child",
    currentProject: { key: "/work/alpha", root: "/work/alpha" },
  }));
  const sessionRows = rows.filter((row) => row.kind === "session");
  assert.deepEqual(sessionRows.map((row) => row.family.root.id), ["main"]);
  assert.deepEqual(sessionRows[0].status, { running: true, unread: true, selected: true, transient: false });
  // The sidebar builds that model from the whole catalog, subagents included.
  assert.match(source, /const model = useMemo\(\(\) => buildSessionTree\(\{\s*sessions: allSessions,/);
  assert.doesNotMatch(source, /function SessionItem|function SessionTreeItem|getSessionListIndices/);
});

test("only Shift skips the session deletion confirmation", () => {
  assert.match(
    callbackBody("requestDelete"),
    /if \(shiftKey\) \{\s*void performDelete\(family\);\s*\} else \{[\s\S]*?setConfirmDeleteRootId\(family\.root\.id\);/,
  );
  // The menu item hands Shift (click, Shift+Enter, Shift+D) to that decision.
  assert.match(source, /case "delete": requestDelete\(family, shiftKey\); break;/);
  assert.match(source, /onSelect: \(\{ shiftKey \}\) => runSessionAction\(entry\.id, row, shiftKey\)/);
  assert.match(source, /onDeleteConfirm: \(family: SessionFamily\) => \{ void performDelete\(family\); \}/);
});

test("sessions and files are two tabs of one sidebar, both kept mounted", () => {
  const html = render({ selectedCwd: "/work/alpha", onOpenTerminal: noop });
  // Only the two tabs are in the tablist; the view options button sits beside it.
  const tablist = html.match(/<div class="sidebar-tabs"><div class="sidebar-tabs-list" role="tablist" aria-label="Sidebar view">([\s\S]*?)<\/div><span class="sidebar-tabs-spacer"><\/span>/);
  assert.ok(tablist, "tablist rendered inside the tab row");
  assert.equal((tablist[1].match(/<button /g) ?? []).length, 2);
  assert.equal((tablist[1].match(/role="tab"/g) ?? []).length, 2);
  assert.doesNotMatch(tablist[1], /View options/);
  assert.match(html, /<span class="sidebar-tabs-spacer"><\/span><button type="button" class="sidebar-icon-button" title="View options" aria-label="View options" aria-haspopup="menu"/);
  const sessionsTab = openingTag(html, "session-sidebar-tab-sessions");
  const filesTab = openingTag(html, "session-sidebar-tab-files");
  assert.match(sessionsTab, /role="tab"/);
  assert.match(sessionsTab, /aria-selected="true"/);
  assert.match(sessionsTab, /aria-controls="session-sidebar-panel-sessions"/);
  assert.match(sessionsTab, /tabindex="0"/);
  assert.match(filesTab, /aria-selected="false"/);
  assert.match(filesTab, /tabindex="-1"/);
  assert.doesNotMatch(openingTag(html, "session-sidebar-panel-sessions"), /hidden/);
  assert.match(openingTag(html, "session-sidebar-panel-files"), /role="tabpanel"[^>]*hidden=""/);
  // The hidden files tab still holds the explorer for the cwd, with its toolbar.
  const filesPanel = html.slice(html.indexOf('id="session-sidebar-panel-files"'));
  assert.match(filesPanel, /aria-label="Open workspace terminal"/);
  assert.match(filesPanel, /<div class="sidebar-files-scroll scrollbar-subtle">/);
  assert.match(filesPanel, /<span class="sidebar-files-title">Explorer<\/span>/);
  // Pins and archive not loaded yet: the tree waits instead of flashing archived rows.
  assert.match(html, /<div class="session-tree-message">Loading\.\.\.<\/div>/);

  assert.match(source, /hidden=\{sidebarTab !== "sessions"\}/);
  assert.match(source, /hidden=\{sidebarTab !== "files"\}/);
  assert.match(callbackBody("switchTab"), /setSidebarTab\(tab\);\s*saveSidebarTab\(tab\);/);
  assert.match(source, /const treeLoading = loading \|\| !uiStateLoaded;/);
  // display: none may drop scroll positions: they are noted and put back.
  assert.equal((source.match(/onScrollCapture=\{rememberScroll\}/g) ?? []).length, 2);
  assert.match(source, /if \(saved !== undefined && element\.scrollTop !== saved\) element\.scrollTop = saved;\s*\}\s*\}, \[sidebarTab, archiveView\]\);/);
  // No vertical sessions/explorer split any more.
  assert.doesNotMatch(source, /useResizablePanel|axis: "vertical"|--sidebar-session-pane-height|explorerOpen|file-explorer-state|data-resize-handle/);
  assert.doesNotMatch(globalStyles, /sidebar-section-resize-handle/);
});

test("the tab chosen last is shown again after hydration, not in the first render", () => {
  const serverHtml = render();
  const saved = {
    "pi-web:sidebar-tab": "files",
    "pi-web:sidebar-groups": JSON.stringify({ "/work/alpha": false }),
    "pi-web:sidebar-pins-collapsed": "true",
  };
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: { getItem: (key) => saved[key] ?? null, setItem() {}, removeItem() {} },
  };
  let clientHtml;
  try {
    clientHtml = render();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
  // The hydrating render must match the server's HTML: the Sessions tab, its
  // panel and its view options, whatever the browser saved.
  assert.equal(clientHtml, serverHtml);
  assert.match(openingTag(clientHtml, "session-sidebar-tab-sessions"), /aria-selected="true"/);
  assert.match(openingTag(clientHtml, "session-sidebar-panel-files"), /hidden=""/);
  assert.match(clientHtml, /aria-label="View options"/);

  // The saved tab, group choices and pinned section come back in a mount effect.
  assert.match(source, /const \[sidebarTab, setSidebarTab\] = useState<SidebarTab>\("sessions"\);/);
  assert.match(source, /const \[groupExpansion, setGroupExpansion\] = useState<Readonly<Record<string, boolean>>>\(\{\}\);/);
  assert.match(source, /const \[pinnedCollapsed, setPinnedCollapsed\] = useState\(false\);/);
  assert.doesNotMatch(source, /useState[^;\n]*\(\(\) => load(?:SidebarTab|GroupExpansion|PinnedCollapsed)\(\)\)/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*const tab = loadSidebarTab\(\);\s*if \(tab !== "sessions"\) setSidebarTab\(tab\);\s*const groups = loadGroupExpansion\(\);\s*if \(Object\.keys\(groups\)\.length > 0\) setGroupExpansion\(groups\);\s*if \(loadPinnedCollapsed\(\)\) setPinnedCollapsed\(true\);\s*forgetRetiredSidebarKeys\(\);\s*\}, \[\]\);/,
  );
});

test("the files tab keeps FileExplorer mounted under an always-present scroll container", () => {
  assert.match(source, /<div ref=\{explorerScrollRef\} className="sidebar-files-scroll scrollbar-subtle">\s*\{explorerCwd && \(\s*<FileExplorer/);
  assert.match(source, /useScrollbarVisibility\(explorerScrollRef\);/);
  assert.match(source, /const explorerCwd = selectedCwd \?\? selectedCwdProp \?\? null;/);
  assert.match(source, /onOpenTerminal\(explorerCwd\)/);
  assert.match(sidebarStyles, /\.sidebar-files-scroll \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/);
});

test("arrow keys move between the tabs and the search toggle opens the sessions tab", () => {
  const keys = source.slice(source.indexOf("const handleTabKeyDown"), source.indexOf("// A session family's pin"));
  assert.match(keys, /event\.key !== "ArrowLeft" && event\.key !== "ArrowRight" && event\.key !== "Home" && event\.key !== "End"/);
  assert.match(keys, /switchTab\(next\);\s*\(next === "sessions" \? sessionsTabRef : filesTabRef\)\.current\?\.focus\(\);/);
  assert.match(source, /if \(sidebarTab !== "sessions"\) \{\s*switchTab\("sessions"\);\s*setSessionSearchOpen\(true\);\s*return;\s*\}/);
});

test("does not register row-level session deletion shortcuts", () => {
  for (const text of [source, treeSource]) {
    assert.doesNotMatch(text, /"Delete"|"Backspace"/);
  }
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("the running poll carries the pin and archive revision to the UI state", () => {
  assert.match(source, /sessionUiStateRevision\?: number \| null;/);
  assert.match(
    source,
    /setRunningSessionIds\(\(previous\) => sameIdsOr\(previous, data\.runningSessionIds \?\? \[\]\)\);[\s\S]*?noteUiRevision\(data\.sessionUiStateRevision\);[\s\S]*?\}, \[loadSessions, noteUiRevision\]\);/,
  );
  assert.match(source, /noteRevision: noteUiRevision,\s*\} = useSessionUiState\(\);/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("exposes the loaded session catalog to the shell", () => {
  assert.match(source, /onSessionsChange\?: \(sessions: SessionInfo\[\]\) => void/);
  assert.match(source, /onSessionsChange\?\.\(allSessions\)/);
});

test("subagent completion stays silent and never becomes unread", () => {
  assert.match(source, /completionNotificationSuppressedSessionIds\?: string\[\]/);
  assert.match(
    source,
    /completedWithNotifications = completedInBackground\.filter\([\s\S]*?!previousSuppressedCompletionSessionIdsRef\.current\.has\(id\)[\s\S]*?!knownSubagentIds\.has\(id\)/,
  );
  assert.match(source, /completedWithNotifications\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(source, /if \(completedWithNotifications\.length > 0\) \{\s*onBackgroundTaskDone\?\.\(\)/);
  assert.match(
    source,
    /filter\(\(session\) => session\.relation\?\.kind !== "subagent"\)[\s\S]*?unreadEligibleIds\.has\(id\)/,
  );
});

test("includes project activity counts in accessible labels", () => {
  for (const text of [source, treeSource]) {
    assert.match(text, /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{(?:activity\.)?running\}\)`\}/);
    assert.match(text, /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{(?:activity\.)?unread\}\)`\}/);
  }
});

test("project activity ignores archived families", () => {
  assert.match(
    source,
    /getProjectActivity\(\s*archiveIndex\.ids\.size === 0 \? allSessions : allSessions\.filter\(\(session\) => !archiveIndex\.ids\.has\(session\.id\)\),/,
  );
  assert.match(source, /if \(!isFamilyArchived\(family, uiState, runningSessionIds\)\) continue;\s*for \(const id of familyIds\(family\)\) ids\.add\(id\);/);
  assert.match(source, /archivedSessionIds=\{archiveIndex\.ids\}/);
});

test("search results of archived families are tagged, not hidden", () => {
  assert.match(searchSource, /archivedSessionIds\?: ReadonlySet<string>;/);
  assert.match(
    searchSource,
    /\{session\.name \|\| session\.firstMessage\}<\/span>\s*\{archivedSessionIds\?\.has\(session\.id\) && \(\s*<span className="[^"]*text-\[10px\][^"]*">\{t\("sidebar\.archived"\)\}<\/span>/,
  );
  // The whole family counts: a subagent hit of an archived session is tagged too.
  assert.match(source, /for \(const id of familyIds\(family\)\) ids\.add\(id\);/);
});

test("formats session timestamps with the active locale", () => {
  assert.match(treeSource, /import \{ formatRelativeTime, formatShortRelativeTime \} from "@\/lib\/i18n\/format"/);
  assert.match(treeSource, /const \{ locale, t \} = useI18n\(\)/);
  assert.match(treeSource, /formatShortRelativeTime\(family\.latestModified, locale, nowDate\)/);
  assert.match(treeSource, /formatRelativeTime\(root\.modified, locale, nowDate\)/);
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  const body = callbackBody("commitRename");
  assert.match(body, /const title = sessionRowTitle\(session\);/);
  assert.match(
    body,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;[\s\S]*?method: "PATCH"[\s\S]*?void loadSessions\(\);/,
  );
});

test("right-click lets the downstream hook claim the row before the built-in menu opens", () => {
  const body = callbackBody("handleContextMenu");
  assert.match(body, /if \(session\.id === renamingRootId \|\| session\.id === confirmDeleteRootId\) return;/);
  assert.match(
    body,
    /if \(dispatchSessionRowContextMenu\(\{[\s\S]*?refresh: \(\) => \{ void loadSessions\(\); \},\s*\}\)\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*return;\s*\}/,
  );
  const dispatched = body.indexOf("dispatchSessionRowContextMenu(");
  const transient = body.indexOf("if (session.transient) return;");
  const builtIn = body.indexOf("openRowMenu(");
  assert.ok(dispatched < transient && transient < builtIn, "dispatch, then keep the native menu for a transient row, then the built-in menu");
  assert.ok(body.lastIndexOf("event.preventDefault();") > transient, "the native menu is suppressed only for the built-in one");
  assert.match(source, /onRowContextMenu: handleContextMenu,/);
  // Renaming and delete-confirm rows offer no context menu at all.
  assert.equal((treeSource.match(/onContextMenu=/g) ?? []).length, 1);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(callbackBody("openRowMenu"), /if \(row\.status\.transient\) return;/);
  assert.match(callbackBody("startRename"), /if \(family\.root\.transient\) return;/);
  assert.match(callbackBody("performDelete"), /if \(session\.transient\) return;/);
  assert.match(callbackBody("archiveFamilies"), /families\.filter\(\(family\) => !family\.root\.transient\)/);
  assert.match(treeSource, /\{!status\.transient && \(\s*<span className="session-tree-actions">/);
});

test("row clicks go through the list selection, which moves the cwd to the session's worktree", () => {
  assert.match(source, /const handleSelectFamily = useCallback\(\(family: SessionFamily\) => \{\s*handleSelectSessionFromList\(family\.root\);\s*\}, \[handleSelectSessionFromList\]\);/);
  assert.match(source, /onSelectFamily: handleSelectFamily,/);
  assert.match(callbackBody("handleSelectSessionFromList"), /if \(s\.cwd\) setSelectedCwd\(s\.cwd\);\s*onSelectSession\(s, false, entryId, blockIndex\);/);
  assert.match(source, /onSelectSession=\{handleSelectSessionFromList\}/);
  // Only the list selection and the initial URL restore select a session.
  assert.equal((source.match(/\bonSelectSession\(/g) ?? []).length, 2);
});

test("expanding, collapsing or paging a group never changes the cwd", () => {
  for (const name of ["handleToggleGroup", "handleShowMore", "handleShowLess", "handleTogglePinned", "setAllGroupsExpanded", "handleGroupMenu"]) {
    assert.doesNotMatch(callbackBody(name), /setSelectedCwd|onCwdChange/, `${name} must not switch projects`);
  }
  // "Show more" adds SHOW_MORE_STEP families a click; "show less" folds back.
  assert.match(callbackBody("handleShowMore"), /setMoreShown\(\(prev\) => showMoreFamilies\(prev, key\)\);/);
  assert.match(callbackBody("handleShowLess"), /setMoreShown\(\(prev\) => showLessFamilies\(prev, key\)\);/);
  assert.match(callbackBody("handleToggleGroup"), /delete next\[projectKey\];\s*next\[projectKey\] = !isGroupExpanded\(project, groupExpansion\);\s*setGroupExpansion\(next\);\s*saveGroupExpansion\(next\);/);
  // "Open in Files" of another project is the one deliberate switch from a group.
  assert.match(callbackBody("openProjectInFiles"), /if \(!project\.current\) setSelectedCwd\(project\.root\);[\s\S]*?switchTab\("files"\);/);
});

test("a new session moves the cwd and hands the shell the target's project", () => {
  const body = callbackBody("startNewSessionIn");
  const identity = body.indexOf("setValidatedProject({ cwd, root: projectRoot, key: projectKey })");
  const cwd = body.indexOf("setSelectedCwd(cwd);");
  const handOff = body.indexOf("onNewSession?.(createTempSessionId(), cwd, projectKey, carryComposer ? { carryComposer: true } : undefined);");
  assert.ok(identity >= 0 && identity < cwd && cwd < handOff, "identity, then cwd, then the new session");
  // The header "+" keeps the sidebar's cwd and lets the shell keep its project.
  assert.match(callbackBody("handleNewSession"), /if \(!selectedCwd\) return;\s*startNewSessionIn\(\{ cwd: selectedCwd \}\);/);
  assert.match(source, /onNewSession\?: \(sessionId: string, cwd: string, projectKey\?: string \| null, options\?: NewSessionOptions\) => void;/);
});

test("a group's + starts a session at once, in the sidebar's worktree for the current project", () => {
  const body = callbackBody("handleGroupNew");
  assert.match(body, /const handleGroupNew = useCallback\(\(project: SidebarProject\) => \{\s*setMenu\(null\);\s*startNewSessionIn\(\{\s*cwd: project\.current && selectedCwd \? selectedCwd : project\.root,\s*projectKey: project\.key,\s*projectRoot: project\.root,\s*\}\);/);
  assert.match(body, /\}, \[selectedCwd, startNewSessionIn\]\);/);
  assert.doesNotMatch(body, /fetch\(|\/api\/worktrees|kind: "worktrees"/);
  assert.match(source, /onGroupNew: handleGroupNew,/);
  // Nothing of the old worktree picker is left in the sidebar.
  assert.doesNotMatch(source, /pendingGroupKey|cancelGroupNew|groupNewRequestRef|needsWorktreePicker|WorktreeCreateForm|worktreeMenuItems|createWorktreeForSession|kind: "worktrees"|sidebar\.pickWorktree|activeGroupMenu|menuRef/);
});

test("the composer's bar moves through a handle made once, with the newest closures", () => {
  const handle = source.slice(source.indexOf("useImperativeHandle(controlRef"), source.indexOf("// Header \"+\""));
  assert.match(source, /const startNewSessionInRef = useRef\(startNewSessionIn\);\s*startNewSessionInRef\.current = startNewSessionIn;/);
  assert.match(handle, /startNewSessionIn: \(target\) => startNewSessionInRef\.current\(target\),/);
  assert.match(handle, /openFolderForNewSession: \(onPicked, returnFocusTo\) => \{\s*folderPickRef\.current = onPicked;\s*folderReturnFocusRef\.current = returnFocusTo;\s*setCustomPathError\(null\);\s*setCustomPathOpen\("new-session"\);/);
  assert.match(handle, /refreshWorktrees: \(\) => setWtRefreshKey\(\(k\) => k \+ 1\),/);
  assert.match(handle, /\}\), \[\]\);\s*$/);
  // A created worktree is listed at once and refetched, whether or not a session starts in it.
  assert.match(handle, /body: JSON\.stringify\(\{ cwd: project\.root, branch \}\)/);
  assert.match(handle, /if \(!res\.ok \|\| data\.error \|\| !data\.path\) return \{ error: data\.error \?\? `HTTP \$\{res\.status\}` \};/);
  const listed = handle.indexOf("prev.projectKey === project.key && !prev.worktrees.some((worktree) => worktree.path === path)");
  const refetch = handle.indexOf("setWtRefreshKey((k) => k + 1);\n        return { path };");
  assert.ok(listed >= 0 && listed < refetch, "listed, then refetched, then handed back");
  assert.match(source, /controlRef\?: Ref<SessionSidebarControl>;/);
});

test("the composer's folder pick leaves the sidebar's cwd to the shell, and Cancel gives focus back", () => {
  const commit = callbackBody("commitCustomPath");
  assert.match(commit, /const purpose = customPathOpen;/);
  const branch = commit.slice(commit.indexOf('if (purpose === "new-session") {'), commit.indexOf("setValidatedProject("));
  assert.match(branch, /const pick = folderPickRef\.current;[\s\S]*?folderPickRef\.current = null;[\s\S]*?pick\?\.\(\{ cwd: data\.cwd, projectKey: data\.projectKey, projectRoot: data\.projectRoot \}\);/);
  assert.match(branch, /focusAfterCommit\(\(\) => \(opener\?\.isConnected \? opener : null\)\);\s*return;/);
  assert.doesNotMatch(branch, /setSelectedCwd|setValidatedProject|startNewSessionIn/);
  assert.match(commit, /\}, \[customPathOpen, customPathValue, customPathValidating, focusAfterCommit\]\);/);
  assert.match(callbackBody("handleCustomPathClick"), /setCustomPathOpen\("files"\);/);
  const cancel = source.slice(source.indexOf("<DirectoryPicker"), source.indexOf("onSelect={(path) => void commitCustomPath(path)}"));
  assert.match(cancel, /const opener = customPathOpen === "new-session" \? folderReturnFocusRef\.current : null;\s*folderPickRef\.current = null;\s*folderReturnFocusRef\.current = null;/);
  assert.match(cancel, /if \(opener\) focusAfterCommit\(\(\) => \(opener\.isConnected \? opener : null\)\);/);
  // focusAfterCommit is declared before the callbacks that list it as a dependency.
  assert.ok(source.indexOf("const focusAfterCommit = useCallback") < source.indexOf("const commitCustomPath = useCallback"));
});

test("the bar hears of the sidebar's cwd only when something it shows changed", () => {
  const snapshot = source.slice(source.indexOf("const newSessionContext = useMemo"), source.indexOf("// Picking a session in another group makes its project current."));
  // Worktrees only where the files tab offers its switcher: the top of a git checkout.
  assert.match(snapshot, /const listed = showWorktreeSwitcher && worktreeState !== null;/);
  assert.match(snapshot, /worktrees: listed \? worktreeState\.worktrees\.map\(\(\{ path, branch, isMain \}\) => \(\{ path, branch, isMain \}\)\) : null,/);
  assert.match(snapshot, /currentWorktreePath: listed \? currentWorktreePath : null,/);
  assert.match(snapshot, /projects: mergeProjectChoices\(model\.projects, recentProjects\),/);
  assert.match(snapshot, /const newSessionContextSignature = newSessionContextKey\(newSessionContext\);/);
  assert.match(snapshot, /useEffect\(\(\) => \{\s*onNewSessionContextChange\?\.\(newSessionContextRef\.current\);\s*\}, \[newSessionContextSignature, onNewSessionContextChange\]\);/);
});

test("archive keeps an undo snapshot and clears unread markers", () => {
  const body = callbackBody("archiveFamilies");
  const snapshot = body.indexOf("const snapshot = snapshotUiState(archivable.map((family) => family.root.id));");
  const apply = body.indexOf('void applyUiState({ action: "set", ids, archived: true })');
  assert.ok(snapshot >= 0 && snapshot < apply, "the snapshot is taken before the change");
  assert.match(body, /for \(const id of memberIds\) next\.delete\(id\);/);
  // More families than one request may carry go in parts, and so does their Undo.
  assert.match(body, /for \(const part of chunkForSessionUiRequests\(archivable\)\) \{\s*const ids = part\.map\(\(family\) => family\.root\.id\);\s*void applyUiState\(\{ action: "set", ids, archived: true \}\)/);
  assert.match(body, /label: t\("sidebar\.undo"\),[\s\S]*?for \(const entries of chunkForSessionUiRequests\(snapshot\)\) \{\s*void applyUiState\(\{ action: "restore", entries \}\);\s*\}\s*restoreUnread\(unreadBefore\);/);
  assert.doesNotMatch(body, /const ids = archivable\.map|entries: snapshot \}/, "never one request for every family");
  // A refused part rolls back, and its unread markers come back with it.
  assert.match(body, /\.then\(\(ok\) => \{\s*\/\/[^\n]*\n\s*if \(ok \|\| unreadBefore\.length === 0\) return;\s*const partIds = new Set\(part\.flatMap\(\(family\) => familyIds\(family\)\)\);\s*restoreUnread\(unreadBefore\.filter\(\(id\) => partIds\.has\(id\)\)\);/);
  // The session open by then has been read: its marker stays off.
  assert.match(callbackBody("restoreUnread"), /if \(id !== selectedSessionIdRef\.current\) next\.add\(id\);/);
  assert.match(body, /\{ id: "view", label: t\("sidebar\.viewArchive"\), onClick: openArchiveView \}/);
  assert.match(callbackBody("archiveFamily"), /if \(familyIds\(family\)\.some\(\(id\) => runningSessionIds\.has\(id\)\)\) return;/);
  assert.match(callbackBody("restoreFamily"), /void applyUiState\(\{ action: "set", ids, archived: false \}\);[\s\S]*?t\("sidebar\.restoredToast"/);
  // A refused save is reported once per failure.
  assert.match(callbackBody("applyUiState"), /if \(!ok\) setUiWriteFailures\(\(count\) => count \+ 1\);/);
  assert.match(source, /showToast\(t\("sidebar\.uiStateFailed", \{ error: uiStateError \?\? "" \}\)\);/);
});

test("lifecycle refreshes bypass the cache while cross-window polling reuses it", () => {
  assert.match(source, /function sessionListUrl\(summary: boolean, force: boolean\)/);
  assert.match(source, /if \(summary\) return "\/api\/sessions\?summary=1"/);
  assert.match(source, /if \(force\) return "\/api\/sessions\?force=1"/);
  assert.match(source, /cache: "no-store"/);
  // First paint uses the cheap summary listing, then hydrates after a delay.
  assert.match(source, /loadSessions\(true, false, true\)/);
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*?void loadSessions\(false, true\)/);
  assert.match(source, /data\.sessionListVersion !== sessionListVersionRef\.current[\s\S]*?await loadSessions\(\)/);
  assert.doesNotMatch(source, /sessionRefreshDone|sessionRefreshTimerRef|title=\{t\("sidebar\.refresh"\)\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("a cwd prop that went away and came back still moves the sidebar", () => {
  const sync = source.slice(source.indexOf("const lastSyncedCwdPropRef"), source.indexOf("// Load worktrees for the current effective cwd"));
  assert.match(sync, /if \(!selectedCwdProp\) \{\s*lastSyncedCwdPropRef\.current = null;\s*return;\s*\}/);
  assert.match(sync, /if \(selectedCwdProp !== lastSyncedCwdPropRef\.current\) \{\s*lastSyncedCwdPropRef\.current = selectedCwdProp;\s*setSelectedCwd\(selectedCwdProp\);/);
});

test("the footer opens the project list in the files tab; the archive view replaces the tree", () => {
  const footer = source.slice(source.indexOf("const handleOpenOtherProject"), source.indexOf("const sessionMenuItems"));
  assert.match(footer, /switchTab\("files"\);\s*setDropdownOpen\(true\);/);
  assert.match(source, /onOpenOtherProject: handleOpenOtherProject,/);
  assert.match(source, /onOpenArchive: openArchiveView,/);
  assert.match(callbackBody("openArchiveView"), /setArchiveView\(true\);[\s\S]*?setSessionSearchOpen\(false\);\s*switchTab\("sessions"\);/);
  assert.match(source, /<div className="sidebar-sessions-view" hidden=\{archiveView\}>\s*<SessionTree \{\.\.\.treeProps\} rows=\{model\.rows\} emptyLabel=\{t\("sidebar\.noSessions"\)\} \/>/);
  assert.match(source, /<SessionTree \{\.\.\.treeProps\} rows=\{archiveRows\} emptyLabel=\{t\("sidebar\.noArchived"\)\} \/>/);
  assert.match(source, /const sessionMenuItems = \(row: SessionRow\): SidebarMenuItem\[\] => sessionMenuEntries\(row\.context, row\.status\)/);
  assert.match(callbackBody("handleTogglePinned"), /setPinnedCollapsed\(next\);\s*savePinnedCollapsed\(next\);/);
});

test("the group that stops being current keeps its rows open", () => {
  const effect = source.slice(source.indexOf("const previousCurrentProjectKeyRef"), source.indexOf("const showToast"));
  assert.match(effect, /useLayoutEffect\(\(\) => \{/, "settled before the browser paints the collapsed group");
  assert.match(effect, /if \(previous === null \|\| previous === currentProjectKey\) return;\s*const next = keepOutgoingGroupOpen\(groupExpansion, projectByKey\.get\(previous\)\);\s*if \(next === groupExpansion\) return;\s*setGroupExpansion\(next\);\s*saveGroupExpansion\(next\);/);
});

test("the running poll keeps the same Set while the running ids stay the same", () => {
  const previous = new Set(["a", "b"]);
  assert.equal(sameIdsOr(previous, ["b", "a"]), previous);
  assert.equal(sameIdsOr(previous, ["a", "b", "b"]), previous);
  assert.deepEqual([...sameIdsOr(previous, ["a"])], ["a"]);
  assert.deepEqual([...sameIdsOr(previous, ["a", "c"])], ["a", "c"]);
  const empty = new Set();
  assert.equal(sameIdsOr(empty, []), empty);
  // Both places that take a polled list go through it.
  assert.equal((source.match(/setRunningSessionIds\(\(previous\) => sameIdsOr\(previous, data\.runningSessionIds \?\? \[\]\)\);/g) ?? []).length, 2);
  assert.doesNotMatch(source, /setRunningSessionIds\(new Set/);
});

test("focus that went away with the archive view, a toast or a delete confirmation lands on what replaced it", () => {
  // Opening the archive: Back; going back: the footer link, else the selected tab.
  const archive = source.slice(source.indexOf("const archiveBackRef"), source.indexOf("const handleTabKeyDown"));
  assert.match(archive, /if \(previousArchiveViewRef\.current === archiveView\) return;/, "nothing moves on mount");
  assert.match(archive, /if \(archiveView\) \{\s*focusIfHidden\(archiveBackRef\.current\);/);
  assert.match(archive, /querySelector<HTMLElement>\('\[data-row-key="footer-archived"\] button'\);\s*focusIfHidden\(footer && footer\.getClientRects\(\)\.length > 0 \? footer : selectedTabButton\(\)\);/);
  assert.match(source, /<button\s+ref=\{archiveBackRef\}\s+type="button"\s+className="sidebar-archive-back"/);
  // Focus still on something just hidden counts as lost; elsewhere it stays.
  assert.match(source, /function focusIfHidden\(target: HTMLElement \| null\): void \{[\s\S]*?active\.getClientRects\(\)\.length === 0\) \{\s*target\.focus\(\{ preventScroll: true \}\);\s*return;\s*\}\s*focusIfLost\(document, target\);/);
  // Toast Undo and a delete confirmation's Cancel: the family's row, after the commit that brings it back.
  assert.match(callbackBody("focusAfterCommit"), /focusAfterCommitRef\.current = target;\s*setFocusRequest\(\(count\) => count \+ 1\);/);
  assert.match(source, /if \(target\) focusIfLost\(document, target\(\)\);\s*\}, \[focusRequest\]\);/);
  assert.match(callbackBody("archiveFamilies"), /focusAfterCommit\(\(\) => familyRowButton\(archivable\[0\]\.root\.id\)\);/);
  assert.match(callbackBody("restoreFamily"), /focusAfterCommit\(\(\) => familyRowButton\(family\.root\.id\)\);/);
  assert.match(source, /onDeleteCancel: \(\) => \{\s*const rootId = confirmDeleteRootId;\s*setConfirmDeleteRootId\(null\);[\s\S]*?if \(rootId\) focusAfterCommit\(\(\) => familyRowButton\(rootId\)\);/);
  const rowButton = callbackBody("familyRowButton");
  assert.match(rowButton, /for \(const context of \["pinned", "group", "archive"\]\)/);
  assert.match(rowButton, /\.session-tree-main`\);\s*if \(button && button\.getClientRects\(\)\.length > 0\) return button;\s*\}\s*return selectedTabButton\(\);/);
  // The toast's View opens the archive, whose Back then takes focus.
  assert.match(callbackBody("archiveFamilies"), /\{ id: "view", label: t\("sidebar\.viewArchive"\), onClick: openArchiveView \}/);
});
