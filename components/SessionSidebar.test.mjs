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
const explorerSource = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

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
  assert.deepEqual(sessionRows[0].status, { running: true, awaiting: false, unread: true, selected: true, transient: false });
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

test("on a desktop the files sit below the sessions by default, both in view", () => {
  // The server renders the default placement on a desktop (useFilesPlacement
  // and useIsMobile's server snapshots): the stacked layout.
  const html = render({ selectedCwd: "/work/alpha", onOpenTerminal: noop });
  assert.match(html, /^<div class="session-sidebar is-files-below" style="--sidebar-files-height:320px">/);
  // No tabs: the sessions' title (a span, not a button), then New and the
  // sessions' search. No brand and no view options.
  assert.match(html, /<div class="sidebar-header"><span class="sidebar-title"><svg[^>]*class="sidebar-tab-icon"[^>]*>[\s\S]*?<\/svg><span class="sidebar-tab-label">Sessions<\/span><\/span><span class="sidebar-header-spacer"><\/span><button type="button" class="sidebar-new-button"/);
  assert.doesNotMatch(html, /role="tablist"|role="tab"|role="tabpanel"|View options|Pi Web/);
  assert.match(html, /<span class="sidebar-new-label">New<\/span><\/button><button type="button" title="Search conversations" aria-label="Search conversations" aria-expanded="false" aria-controls="session-search-input" class="sidebar-search-toggle">/);
  // Two regions, both shown: the sessions, the separator, the files.
  const sessions = openingTag(html, "session-sidebar-panel-sessions");
  const files = openingTag(html, "session-sidebar-panel-files");
  assert.equal(sessions, '<div id="session-sidebar-panel-sessions" role="region" aria-label="Sessions" class="sidebar-panel sidebar-sessions-panel">');
  assert.equal(files, '<div id="session-sidebar-panel-files" role="region" aria-label="Files" class="sidebar-panel sidebar-files-panel">');
  const separator = html.slice(html.indexOf('role="separator"') - 200, html.indexOf(files));
  assert.ok(html.indexOf(sessions) < html.indexOf('role="separator"') && html.indexOf('role="separator"') < html.indexOf(files), "sessions, separator, files");
  assert.match(separator, /<div aria-label="Resize file browser" aria-orientation="horizontal" aria-valuemax="2000" aria-valuemin="220" aria-valuenow="320" aria-valuetext="320 px" role="separator" tabindex="0" aria-controls="session-sidebar-panel-files" class="panel-resize-handle sidebar-files-resize-handle" data-resize-handle="sidebar-files" title="Resize file browser: Drag to resize\. Double-click or press Enter to reset\."><\/div>$/);
  // The files section: its header row (folds it; the file search at its
  // end), then its body: the head as the tabs had it and the tree.
  const filesPanel = html.slice(html.indexOf(files) + files.length);
  assert.match(filesPanel, /^<div class="sidebar-files-section"><button type="button" class="sidebar-files-section-toggle" aria-expanded="true" aria-controls="session-sidebar-files-body"><svg[^>]*class="session-tree-group-icon"[^>]*>[\s\S]*?<\/svg><span class="sidebar-files-section-label">Files<\/span><svg[^>]*class="session-tree-chevron is-open"[^>]*>[\s\S]*?<\/svg><\/button><button type="button" title="Search files" aria-label="Search files" aria-expanded="false" aria-controls="file-search-input" class="sidebar-files-section-search">/);
  assert.match(filesPanel, /<div id="session-sidebar-files-body" class="sidebar-files-body"><div class="sidebar-files-head"><div class="project-picker is-stacked" role="group"/);
  assert.match(filesPanel, /aria-label="Open workspace terminal"/);
  assert.match(filesPanel, /<div class="sidebar-files-scroll scrollbar-subtle">/);
  assert.doesNotMatch(filesPanel, /sidebar-files-toolbar|sidebar-files-title/);
  // Pins and archive not loaded yet: the tree waits instead of flashing archived rows.
  assert.match(html, /<div class="session-tree-message">Loading\.\.\.<\/div>/);
  // Without a folder the files' search has nothing to search.
  assert.match(render(), /<button type="button" disabled="" title="Search files" aria-label="Search files" aria-expanded="false" aria-controls="file-search-input" class="sidebar-files-section-search">/);

  // The layout: the desktop's choice; phones always take the tabs.
  assert.match(source, /const filesPlacement = useFilesPlacement\(\);\s*const stacked = !isMobile && filesPlacement === "below";/);
  assert.match(source, /const treeLoading = loading \|\| !uiStateLoaded;/);
});

test("the tabs layout (the setting, phones) is the two tabs as before, in the same element tree", () => {
  // Tabs: only the two tabs are the tablist, each an icon and a label, the
  // inactive panel hidden, both panels named by their tabs.
  assert.match(source, /\{!stacked && \(\s*<div className="sidebar-tabs-list" role="tablist" aria-label=\{t\("sidebar\.tabsLabel"\)\}>/);
  assert.equal((source.match(/role="tab"\n/g) ?? []).length, 2);
  assert.match(source, /id="session-sidebar-tab-sessions"\s*aria-selected=\{sidebarTab === "sessions"\}\s*aria-controls="session-sidebar-panel-sessions"\s*tabIndex=\{sidebarTab === "sessions" \? 0 : -1\}/);
  assert.match(source, /id="session-sidebar-tab-files"\s*aria-selected=\{sidebarTab === "files"\}\s*aria-controls="session-sidebar-panel-files"\s*tabIndex=\{sidebarTab === "files" \? 0 : -1\}/);
  assert.match(source, /<MessageIcon size=\{13\} className="sidebar-tab-icon" \/>\s*<span className="sidebar-tab-label">\{t\("sidebar\.tabSessions"\)\}<\/span>\s*<\/button>/);
  for (const [name, tab] of [["Sessions", "sessions"], ["Files", "files"]]) {
    assert.match(source, new RegExp(`role=\\{stacked \\? "region" : "tabpanel"\\}\\s*aria-label=\\{stacked \\? t\\("sidebar\\.tab${name}"\\) : undefined\\}\\s*aria-labelledby=\\{stacked \\? undefined : "session-sidebar-tab-${tab}"\\}\\s*hidden=\\{!stacked && sidebarTab !== "${tab}"\\}`));
  }
  assert.match(callbackBody("switchTab"), /if \(stacked\) return;\s*setSidebarTab\(tab\);\s*saveSidebarTab\(tab\);/);

  // One element tree for both layouts: the same containers in the same
  // order, the layouts' own rows as conditional siblings, so a switch (the
  // setting, the phone breakpoint) or a fold never remounts the explorer,
  // the tree or the picker.
  const body = source.slice(source.indexOf("  return (\n    <div\n      ref={setSidebarRoot}"));
  const order = [
    '<div ref={headerRef} className="sidebar-header">',
    "{stacked && (\n          <span className=\"sidebar-title\">",
    "{!stacked && (\n          <div className=\"sidebar-tabs-list\"",
    'id="session-sidebar-panel-sessions"',
    "{stacked && !filesCollapsed && (\n        <div\n          {...filesSizer.separatorProps}",
    'id="session-sidebar-panel-files"',
    "{stacked && (\n          <div className=\"sidebar-files-section\">",
    '<div id="session-sidebar-files-body" className="sidebar-files-body" hidden={stacked && filesCollapsed}>',
    '<div className="sidebar-files-head">',
    "<ProjectWorktreePicker",
    '<div ref={explorerScrollRef} className="sidebar-files-scroll scrollbar-subtle">',
    "<SidebarMenu",
    "<SidebarToast",
  ];
  const positions = order.map((part) => body.indexOf(part));
  positions.forEach((position, index) => assert.ok(position >= 0, `${order[index]} rendered`));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal((source.match(/<FileExplorer\n/g) ?? []).length, 1);
  assert.equal((source.match(/<SessionTree\n/g) ?? []).length, 1);
  assert.equal((source.match(/<ProjectWorktreePicker\n/g) ?? []).length, 1);
  // Only the folder decides whether the explorer is mounted.
  assert.match(source, /\{explorerCwd && \(\s*<FileExplorer/);
  assert.doesNotMatch(source, /explorerOpen|stacked \? \(|isMobile \? \(\s*<|file-explorer-state|--sidebar-session-pane-height/);

  // display: none may drop scroll positions: they are noted and put back,
  // in every panel shown, when a tab, the archive, the layout or the fold changes.
  assert.equal((source.match(/onScrollCapture=\{rememberScroll\}/g) ?? []).length, 2);
  assert.match(source, /for \(const panel of \[sessionsPanelRef\.current, filesPanelRef\.current\]\) \{\s*if \(!panel \|\| panel\.hidden\) continue;[\s\S]*?if \(saved !== undefined && element\.scrollTop !== saved\) element\.scrollTop = saved;\s*\}\s*\}\s*\}, \[sidebarTab, archiveView, stacked, filesCollapsed\]\);/);
});

test("the files section's height is the separator's, kept apart from the window's clamp", () => {
  const sizer = source.slice(source.indexOf("const filesSizer = useResizablePanel({"), source.indexOf("});", source.indexOf("const filesSizer = useResizablePanel({")));
  assert.match(sizer, /axis: "vertical",/);
  assert.match(sizer, /cssVariable: "--sidebar-files-height",/);
  assert.match(sizer, /getDefaultWidth: getDefaultFilesHeight,\s*getMaxWidth: getMaxFilesHeight,\s*growthDirection: "up",/);
  assert.match(sizer, /maxWidth: FILES_SECTION_MAX_HEIGHT,\s*minWidth: FILES_SECTION_MIN_HEIGHT,\s*persistClamp: false,\s*storageKey: "pi-web:sidebar-files-height",/);
  // Never the old split's key, which forgetRetiredSidebarKeys drops.
  assert.doesNotMatch(source, /pi-web:sidebar-session-pane-height/);
  // At least the header row, the head (115px) and about three tree rows; at
  // most what leaves the sessions their CSS minimum; 45% by default.
  assert.match(source, /const FILES_SECTION_MIN_HEIGHT = 220;/);
  assert.match(source, /const FILES_SECTION_DEFAULT_SHARE = 0\.45;/);
  assert.match(source, /const getMaxFilesHeight = useCallback\(\(\) => sidebarBodyHeight\(\) - SESSIONS_SECTION_MIN_HEIGHT, \[sidebarBodyHeight\]\);/);
  assert.match(source, /return root\.clientHeight - header\.offsetHeight;/);
  const sessionsMin = Number(source.match(/const SESSIONS_SECTION_MIN_HEIGHT = (\d+);/)[1]);
  // A sidebar too short for both shrinks the files, down to their header row
  // and its line: the sessions' zero basis freezes them at their minimum, so
  // the files take the shortfall and never run past the root.
  assert.match(sidebarStyles, new RegExp(`\\.session-sidebar\\.is-files-below \\.sidebar-sessions-panel \\{\\s*flex-basis: 0;\\s*min-height: ${sessionsMin}px;\\s*\\}`));
  assert.match(sidebarStyles, /\.session-sidebar\.is-files-below \.sidebar-files-panel \{\s*flex: 0 1 auto;\s*height: var\(--sidebar-files-height, 320px\);\s*min-height: 29px;\s*border-top: 1px solid var\(--border\);\s*\}/);
  assert.match(sidebarStyles, /\.session-sidebar\.is-files-below\.is-files-collapsed \.sidebar-files-panel \{\s*flex: none;\s*height: auto;\s*\}/);
  // The variable is on the root (the hook's panel), so the toast reads it too;
  // a sidebar that changes height fits it again while stacked.
  assert.match(source, /sidebarRef\.current = element;\s*filesSizerPanelRef\.current = element;/);
  assert.match(source, /ref=\{setSidebarRoot\}/);
  assert.match(source, /style=\{\{ "--sidebar-files-height": `\$\{filesSizer\.width\}px` \} as CSSProperties\}/);
  assert.match(source, /if \(!stacked \|\| !root \|\| typeof ResizeObserver === "undefined"\) return;\s*const observer = new ResizeObserver\(\(\) => reclampFilesHeight\(\)\);/);
  // The separator: the hook's props, a 12px hit area on the files' top
  // border, in the other resize handles' look.
  assert.match(source, /\{stacked && !filesCollapsed && \(\s*<div\s*\{\.\.\.filesSizer\.separatorProps\}\s*aria-controls="session-sidebar-panel-files"\s*className=\{`panel-resize-handle sidebar-files-resize-handle\$\{filesSizer\.isResizing \? " is-resizing" : ""\}`\}/);
  assert.match(sidebarStyles, /\.panel-resize-handle\.sidebar-files-resize-handle \{\s*width: auto;\s*height: 12px;\s*margin: -6px 0;\s*flex: 0 0 12px;\s*cursor: row-resize;\s*\}/);
  assert.match(sidebarStyles, /\.panel-resize-handle\.sidebar-files-resize-handle::after \{\s*top: 5px;\s*right: 0;\s*bottom: auto;\s*left: 0;\s*width: auto;\s*height: 2px;\s*\}/);
  assert.match(globalStyles, /\.panel-resize-handle \{[^}]*touch-action: none;/);
});

test("the files section folds to its header row, saved per browser, and its search opens it", () => {
  // Restored after hydration with the other preferences, never in a state initializer.
  assert.match(source, /const \[filesCollapsed, setFilesCollapsed\] = useState\(false\);/);
  assert.doesNotMatch(source, /useState[^;\n]*\(\(\) => loadFilesCollapsed\(\)\)/);
  assert.match(source, /if \(loadPinnedCollapsed\(\)\) setPinnedCollapsed\(true\);\s*if \(loadFilesCollapsed\(\)\) setFilesCollapsed\(true\);/);
  assert.match(callbackBody("setFilesSectionCollapsed"), /setFilesCollapsed\(collapsed\);\s*saveFilesCollapsed\(collapsed\);/);
  // The header's toggle folds it; folded, everything under it is hidden,
  // not unmounted, and the separator goes.
  assert.match(source, /aria-expanded=\{!filesCollapsed\}\s*aria-controls="session-sidebar-files-body"\s*title=\{changedFilesTitle\}\s*onClick=\{\(\) => setFilesSectionCollapsed\(!filesCollapsed\)\}/);
  assert.match(source, /<span className="sidebar-files-section-label">\{t\("sidebar\.tabFiles"\)\}<\/span>\s*\{explorerCwd && changesCount > 0 && <span className="sidebar-files-section-count" aria-hidden="true">· \{changesCount\}<\/span>\}\s*<ChevronIcon size=\{10\} className=\{`session-tree-chevron\$\{filesCollapsed \? "" : " is-open"\}`\} \/>/);
  assert.match(source, /hidden=\{stacked && filesCollapsed\}/);
  assert.match(source, /className=\{`session-sidebar\$\{stacked \? " is-files-below" : ""\}\$\{stacked && filesCollapsed \? " is-files-collapsed" : ""\}\$\{toast \? " has-toast" : ""\}`\}/);
  // Its search: the files' alone (the toolbar row's is the sessions');
  // folded, the section opens first, the field open and focused.
  assert.match(source, /disabled=\{!explorerCwd\}\s*onClick=\{\(\) => \{[\s\S]*?if \(filesCollapsed\) \{\s*setFileSearchOpen\(true\);\s*revealFiles\("file-search"\);\s*return;\s*\}\s*setFileSearchOpen\(\(open\) => !open\);\s*\}\}\s*title=\{t\("sidebar\.searchFiles"\)\}\s*aria-label=\{t\("sidebar\.searchFiles"\)\}\s*aria-expanded=\{fileSearchOpen\}\s*aria-controls="file-search-input"/);
  // The section header in the project groups' look.
  assert.match(sidebarStyles, /\.sidebar-files-section \{\s*display: flex;\s*flex: none;\s*align-items: center;\s*gap: 4px;\s*height: 28px;/);
  // Its folder in the groups' icon column: their left inset, widened by a classic scrollbar.
  assert.match(sidebarStyles, /\.sidebar-files-section \{[^}]*padding: 0 10px 0 max\(6px, var\(--session-tree-scrollbar, 0px\)\);/);
  assert.match(sidebarStyles, /\.sidebar-files-section-toggle \{[^}]*padding: 0 0 0 5px;[^}]*color: color-mix\(in srgb, var\(--text\) 85%, var\(--bg-panel\)\);\s*font: inherit;\s*font-size: 13px;\s*font-weight: 600;/);
  assert.match(sidebarStyles, /\.sidebar-files-section-count \{\s*flex: none;\s*color: var\(--text-dim\);/);
  assert.match(sidebarStyles, /\.sidebar-files-section-label \{\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*\}/);
});

test("everything that goes to the files goes through revealFiles, in either layout", () => {
  const reveal = callbackBody("revealFiles");
  assert.match(reveal, /filesFocusRef\.current = focusTarget;\s*setFilesFocusRequest\(\(count\) => count \+ 1\);\s*if \(stacked\) setFilesSectionCollapsed\(false\);\s*else switchTab\("files"\);/);
  // No other way to the files tab but its own tab button.
  assert.equal((source.match(/switchTab\("files"\)/g) ?? []).length, 2);
  assert.match(source, /onClick=\{\(\) => switchTab\("files"\)\}/);
  assert.doesNotMatch(appShellSource, /switchTab|sidebar-tab/);
  assert.match(callbackBody("openProjectInFiles"), /if \(!project\.current\) setSelectedCwd\(project\.root\);\s*revealFiles\("project-button"\);/);
  assert.match(callbackBody("handleOpenOtherProject"), /revealFiles\("project-list"\);/);
  // The focus follows once the files show; below the sessions they may show
  // already, so a request counter runs it too.
  assert.match(source, /const filesShown = stacked \? !filesCollapsed : sidebarTab === "files";/);
  const effect = between("const filesShown = ", "const sessionMenuItems");
  assert.match(effect, /if \(!target \|\| !filesShown\) return;\s*filesFocusRef\.current = null;\s*if \(target === "project-list"\) filesPickerRef\.current\?\.openMenu\("project"\);\s*else if \(target === "file-search"\) document\.getElementById\("file-search-input"\)\?\.focus\(\{ preventScroll: true \}\);\s*else filesPickerRef\.current\?\.button\("project"\)\?\.focus\(\{ preventScroll: true \}\);\s*\}, \[filesShown, filesFocusRequest\]\);/);
});

test("a layout switch moves focus off a control it removed or hid, and leaves focus outside the sidebar", () => {
  // The root notes the sidebar control focus is on, and forgets it once focus
  // leaves the sidebar; the window losing focus keeps it (the setting from
  // another window arrives just then).
  assert.match(source, /onFocus=\{\(event\) => \{ sidebarFocusRef\.current = event\.target; \}\}\s*onBlur=\{\(event\) => \{ if \(event\.relatedTarget === null && !document\.hasFocus\(\)\) return; if \(!event\.currentTarget\.contains\(event\.relatedTarget\)\) sidebarFocusRef\.current = null; \}\}/);
  // Only on a switch, not on mount; the tab, or the search below the sessions.
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*if \(previousStackedRef\.current === stacked\) return;\s*previousStackedRef\.current = stacked;\s*const last = sidebarFocusRef\.current;\s*if \(last && \(!last\.isConnected \|\| last\.getClientRects\(\)\.length === 0\)\) focusIfHidden\(selectedTabButton\(\)\);\s*\}, \[stacked, selectedTabButton\]\);/);
});

test("with no tabs, focus that lost its control lands on the toolbar row's search, and the toast stays over the sessions", () => {
  // The selected tab, or, with the files below (no tab mounted), the search
  // button: always there and enabled, so focus never falls to the page.
  assert.match(source, /const selectedTabButton = useCallback\(\s*\(\) => \(sessionsPanelRef\.current\?\.hidden \? filesTabRef : sessionsTabRef\)\.current \?\? searchButtonRef\.current,\s*\[\],\s*\);/);
  assert.match(source, /<button\s*ref=\{searchButtonRef\}\s*type="button"\s*onClick=/);
  const search = source.slice(source.indexOf("ref={searchButtonRef}"), source.indexOf("<SearchIcon size={16} />"));
  assert.doesNotMatch(search, /disabled/);
  // Below the sessions the toolbar row's search is theirs; the tabs keep
  // today's: the files tab's searches its files.
  assert.match(source, /const sessionsShown = stacked \|\| sidebarTab === "sessions";\s*const searchesFiles = !stacked && sidebarTab === "files" && explorerCwd !== null;/);
  // The toast: one live region at the root; below the files it sits over
  // the sessions, never over the file tree.
  assert.equal((source.match(/<SidebarToast /g) ?? []).length, 1);
  assert.match(sidebarStyles, /\.session-sidebar\.is-files-below \.sidebar-toast-region \{\s*bottom: calc\(var\(--sidebar-files-height, 320px\) \+ 8px\);\s*\}/);
  assert.match(sidebarStyles, /\.session-sidebar\.is-files-below\.is-files-collapsed \.sidebar-toast-region \{\s*bottom: 37px;\s*\}/);
});

test("the files' head holds the picker and its six buttons, always the same ones in the same places", () => {
  const html = render({ selectedCwd: "/work/alpha", onOpenTerminal: noop });
  const panel = html.slice(html.indexOf('id="session-sidebar-panel-files"'));
  const head = panel.slice(panel.indexOf('<div class="sidebar-files-head">'), panel.indexOf('<div class="sidebar-files-scroll'));
  // The picker's group names only the project and worktree; the buttons are
  // the head's, a group of their own after it.
  const pickerEnd = head.indexOf('<div class="sidebar-files-actions"');
  assert.ok(pickerEnd > 0);
  assert.equal((head.slice(0, pickerEnd).match(/class="sidebar-tool-button/g) ?? []).length, 0);
  assert.match(head.slice(pickerEnd), /^<div class="sidebar-files-actions" role="group" aria-label="File actions">/);
  // The folder's actions, then the tree's two views: what it lists and its
  // changes (its search is a header's: the toolbar row's on the files tab,
  // the section's below the sessions). The changes view is there without
  // changes too, disabled, so nothing moves as an agent edits files and
  // commits; its count is the tab's, or the section header's.
  const labels = [...head.slice(pickerEnd).matchAll(/<button type="button"( disabled="")? title="([^"]+)" aria-label="\2"( aria-pressed="(true|false)")? class="([^"]+)"/g)]
    .map((match) => `${match[2]}${match[1] ? " (disabled)" : ""}${match[4] ? ` pressed=${match[4]}` : ""}`);
  assert.deepEqual(labels, [
    "Open workspace terminal",
    "Open in file manager",
    "Upload files to project root",
    "Refresh file list",
    "Show ignored files pressed=false",
    "0 changed files (disabled) pressed=false",
  ]);
  assert.match(head, /<button type="button" title="Show ignored files" aria-label="Show ignored files" aria-pressed="false" class="sidebar-tool-button sidebar-files-views-start">/);
  // The ignored-files switch is the browser's, restored after hydration like
  // the tab, and it is what the explorer lists.
  assert.match(source, /if \(loadShowIgnoredFiles\(\)\) setShowIgnoredFiles\(true\);/);
  assert.match(source, /const next = !showIgnoredFiles;\s*setShowIgnoredFiles\(next\);\s*saveShowIgnoredFiles\(next\);/);
  assert.match(source, /title=\{t\("sidebar\.showIgnoredFiles"\)\}\s*pressed=\{showIgnoredFiles\}/);
  assert.match(source, /showHidden=\{showIgnoredFiles\}/);
  assert.doesNotMatch(head, /Search files/);
  assert.match(source, /disabled=\{changesCount === 0\}\s*title=\{t\("sidebar\.changedFiles", \{ count: changesCount \}\)\}\s*pressed=\{changesCount > 0 && !changesCollapsed\}/);
  assert.doesNotMatch(source, /changesCount > 0 && \(\s*<ToolbarIconButton/);
  // Without a terminal (no onOpenTerminal) the other five stay.
  const noTerminal = render({ selectedCwd: "/work/alpha" });
  assert.doesNotMatch(noTerminal, /Open workspace terminal/);
  assert.match(noTerminal, /aria-label="Open in file manager"/);
  // In the tabs, the toolbar row's search button is the tab's: the files
  // tab's searches its files; elsewhere, and on a files tab without a
  // folder, the sessions. Below the sessions it is always theirs.
  assert.match(source, /const searchesFiles = !stacked && sidebarTab === "files" && explorerCwd !== null;/);
  assert.match(source, /if \(searchesFiles\) \{\s*setFileSearchOpen\(\(open\) => !open\);\s*return;\s*\}\s*if \(!sessionsShown\) \{\s*switchTab\("sessions"\);\s*setSessionSearchOpen\(true\);\s*return;\s*\}\s*setSessionSearchOpen\(\(open\) => !open\);/);
  assert.match(source, /title=\{searchesFiles \? t\("sidebar\.searchFiles"\) : t\("sidebar\.toggleSessionSearch"\)\}\s*aria-label=\{searchesFiles \? t\("sidebar\.searchFiles"\) : t\("sidebar\.toggleSessionSearch"\)\}\s*aria-expanded=\{searchesFiles \? fileSearchOpen : sessionSearchOpen\}\s*aria-controls=\{searchesFiles \? "file-search-input" : "session-search-input"\}/);
  assert.match(source, /className=\{`sidebar-search-toggle\$\{\(searchesFiles \? fileSearchOpen : sessionSearchOpen\) \? " is-active" : ""\}`\}/);
  assert.match(explorerSource, /ref=\{searchInputRef\}\s*id="file-search-input"/);
  // The sessions' search, as the server renders it (below the sessions).
  assert.match(html, /title="Search conversations" aria-label="Search conversations" aria-expanded="false" aria-controls="session-search-input" class="sidebar-search-toggle"/);
  assert.doesNotMatch(source, /kind: "files"|filesMenuItems|TabRowToggle/);
  // No box of its own: the head sits flat under the toolbar row's line and
  // a line of its own parts it from the tree. None between the boxes and the
  // keys: square, borderless and dim, the folder's four from the left, the
  // tree's two views at the right end, the row's edges on the boxes'. At the
  // sidebar's 180px minimum (160px inside the head's padding) all six fit:
  // six 21px keys and five 6px gaps.
  assert.match(sidebarStyles, /\.sidebar-files-head \{\s*display: flex;\s*flex: none;\s*flex-direction: column;\s*padding: 10px 10px 4px;\s*border-bottom: 1px solid var\(--border\);\s*\}/);
  assert.match(source, /<div className="sidebar-files-head">/);
  assert.doesNotMatch(source, /explorerScrolled|is-scrolled/);
  assert.doesNotMatch(sidebarStyles, /sidebar-files-card|sidebar-files-actions::before|sidebar-tabs\.is-files|sidebar-icon-button|is-scrolled/);
  assert.match(sidebarStyles, /\.sidebar-files-actions \{\s*display: flex;\s*align-items: center;\s*gap: 6px;\s*margin-top: 4px;\s*\}/);
  assert.match(sidebarStyles, /\.sidebar-files-views-start \{\s*margin-left: auto;\s*\}/);
  assert.doesNotMatch(sidebarStyles, /\.sidebar-tool-button:last-child/);
  assert.match(sidebarStyles, /\.sidebar-tool-button \{\s*display: flex;\s*flex: 0 1 32px;\s*align-items: center;\s*justify-content: center;\s*min-width: 21px;\s*height: 32px;\s*padding: 0;\s*border: 0;\s*border-radius: 7px;\s*background: transparent;\s*color: var\(--text-dim\);/);
  assert.match(sidebarStyles, /\.sidebar-tool-button:not\(:disabled\):hover \{\s*background: var\(--bg-selected\);\s*color: var\(--text\);/);
  assert.match(sidebarStyles, /@media \(pointer: coarse\) \{[\s\S]*?\.sidebar-tool-button \{\s*flex-basis: 36px;\s*height: 36px;\s*\}/);
  // Little room above and below the keys: 4px to the boxes, 4px to the line,
  // and the tree's first row as far under it as their icons are above it.
  assert.match(sidebarStyles, /\.sidebar-files-scroll \{[^}]*padding-top: 6px;/);
  assert.doesNotMatch(globalStyles.slice(globalStyles.indexOf(".project-picker.is-stacked {")), /^\.project-picker\.is-stacked \{[^}]*(border|background|margin)/);
  assert.doesNotMatch(sidebarStyles, /sidebar-files-toolbar|sidebar-files-title|is-pressed/);
});

test("the toolbar row is the chat bar's cells, and gives up labels only where they do not fit", () => {
  // 36px with its line, as the chat's top bar beside it (AppShell, border-box
  // from the global reset), so the two read as one bar; the chosen tab and
  // the open search take its accent line.
  assert.match(sidebarStyles, /\.sidebar-header \{\s*display: flex;\s*flex: none;\s*align-items: stretch;\s*height: 36px;\s*box-sizing: border-box;\s*border-bottom: 1px solid var\(--border\);\s*\}/);
  assert.match(appShellSource, /borderBottom: "1px solid var\(--border\)", height: "calc\(36px \+ env\(safe-area-inset-top\)\)", paddingTop: "env\(safe-area-inset-top\)"/);
  assert.match(globalStyles, /^\* \{\s*box-sizing: border-box;/m);
  assert.match(sidebarStyles, /\.sidebar-tab,\s*\.sidebar-new-button,\s*\.sidebar-search-toggle \{[^}]*padding: 0 12px;\s*border: 0;\s*border-top: 2px solid transparent;\s*border-radius: 0;/);
  assert.match(sidebarStyles, /\.sidebar-tab,\s*\.sidebar-new-button \{\s*border-right: 1px solid var\(--border\);\s*\}/);
  assert.match(sidebarStyles, /\.sidebar-tab\.is-selected,\s*\.sidebar-search-toggle\.is-active \{\s*border-top-color: var\(--accent\);\s*background: var\(--bg-selected\);\s*color: var\(--text\);\s*\}/);
  assert.match(sidebarStyles, /\.sidebar-search-toggle \{\s*width: 36px;\s*padding: 0;\s*\}/);
  // Measured, since the labels' widths change with the language: New keeps
  // its +, then the tabs their icons. A hidden label is still the name.
  const fit = between("function useHeaderFit(", "\nfunction buttonAnchor(");
  assert.match(fit, /useLayoutEffect\(\(\) => \{/);
  assert.match(fit, /for \(const level of \["0", "1", "2"\]\) \{\s*header\.dataset\.fit = level;\s*if \(header\.scrollWidth <= header\.clientWidth\) return;\s*\}/);
  assert.match(fit, /const observer = new ResizeObserver\(fit\);\s*observer\.observe\(header\);\s*return \(\) => observer\.disconnect\(\);\s*\}, \[ref, labels\]\);/);
  // Fed the labels shown: the sessions' title, or the tabs (and the layout,
  // which changes the row's cells).
  assert.match(source, /useHeaderFit\(headerRef, \(stacked\s*\? \["below", t\("sidebar\.tabSessions"\), t\("sidebar\.new"\)\]\s*: \["tabs", t\("sidebar\.tabSessions"\), t\("sidebar\.tabFiles"\), t\("sidebar\.new"\), explorerCwd && changesCount > 0 \? changesCount : "", sidebarTab\]\s*\)\.join\("\\n"\)\);/);
  assert.match(source, /<div ref=\{headerRef\} className="sidebar-header">/);
  assert.match(sidebarStyles, /\.sidebar-header\[data-fit="1"\] \.sidebar-new-button,\s*\.sidebar-header\[data-fit="2"\] \.sidebar-new-button \{\s*width: 36px;\s*padding: 0;\s*\}/);
  assert.match(sidebarStyles, /\.sidebar-header\[data-fit="1"\] \.sidebar-new-label,\s*\.sidebar-header\[data-fit="2"\] \.sidebar-new-label,\s*\.sidebar-header\[data-fit="2"\] \.sidebar-tab-label \{\s*position: absolute;\s*width: 1px;\s*height: 1px;\s*overflow: hidden;\s*clip: rect\(0 0 0 0\);/);
  // The sessions' title is a tab's label and icon (the same classes, so the
  // same fit rules), in a chosen tab's type with no accent line or box.
  assert.match(sidebarStyles, /\.sidebar-header\[data-fit="2"\] \.sidebar-tab,\s*\.sidebar-header\[data-fit="2"\] \.sidebar-title \{\s*padding: 0 11px;\s*\}/);
  assert.match(sidebarStyles, /\.sidebar-title \{\s*display: flex;\s*flex: none;\s*align-items: center;\s*gap: 6px;\s*padding: 0 12px;\s*border-top: 2px solid transparent;\s*color: var\(--text\);\s*font-size: 12px;\s*font-weight: 500;\s*white-space: nowrap;\s*\}/);
  assert.doesNotMatch(sidebarStyles.slice(sidebarStyles.indexOf(".sidebar-title {")), /^\.sidebar-title \{[^}]*(border-top-color|background|border-right)/);
  // The brand is the new-session page's alone.
  assert.doesNotMatch(source, /PiWebTitle|useScramble|SCRAMBLE_CHARS/);
});

test("the layout, the tab and the fold chosen last are shown again after hydration, not in the first render", () => {
  const serverHtml = render();
  const saved = {
    "pi-web:sidebar-files-placement": "tab",
    "pi-web:sidebar-tab": "files",
    "pi-web:sidebar-files-collapsed": "true",
    "pi-web:sidebar-groups-v2": JSON.stringify({ "/work/alpha": false }),
    "pi-web:sidebar-pins-collapsed": "true",
    "pi-web:sidebar-files-show-ignored": "true",
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
  // The hydrating render must match the server's HTML: the files open below
  // the sessions, whatever the browser saved.
  assert.equal(clientHtml, serverHtml);
  assert.match(clientHtml, /^<div class="session-sidebar is-files-below" style="--sidebar-files-height:320px">/);
  assert.doesNotMatch(openingTag(clientHtml, "session-sidebar-panel-files"), /hidden/);
  assert.equal(openingTag(clientHtml, "session-sidebar-files-body"), '<div id="session-sidebar-files-body" class="sidebar-files-body">');
  assert.doesNotMatch(clientHtml, /role="tablist"/);

  // The layout follows the stored choice through useSyncExternalStore (its
  // server snapshot is the default); the saved tab, the fold, group choices,
  // pinned section and ignored-files switch come back in a mount effect.
  assert.match(source, /const \[sidebarTab, setSidebarTab\] = useState<SidebarTab>\("sessions"\);/);
  assert.match(source, /const \[groupExpansion, setGroupExpansion\] = useState<Readonly<Record<string, boolean>>>\(\{\}\);/);
  // What the page keeps open is never read from storage.
  assert.match(source, /const \[keptOpenGroups, setKeptOpenGroups\] = useState<ReadonlySet<string>>\(\(\) => new Set\(\)\);/);
  assert.match(source, /const \[pinnedCollapsed, setPinnedCollapsed\] = useState\(false\);/);
  assert.match(source, /const \[showIgnoredFiles, setShowIgnoredFiles\] = useState\(false\);/);
  assert.doesNotMatch(source, /useState[^;\n]*\(\(\) => load(?:SidebarTab|GroupExpansion|PinnedCollapsed|ShowIgnoredFiles)\(\)\)/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*const tab = loadSidebarTab\(\);\s*if \(tab !== "sessions"\) setSidebarTab\(tab\);\s*const groups = loadGroupExpansion\(\);\s*if \(Object\.keys\(groups\)\.length > 0\) setGroupExpansion\(groups\);\s*if \(loadPinnedCollapsed\(\)\) setPinnedCollapsed\(true\);\s*if \(loadFilesCollapsed\(\)\) setFilesCollapsed\(true\);\s*if \(loadShowIgnoredFiles\(\)\) setShowIgnoredFiles\(true\);\s*forgetRetiredSidebarKeys\(\);\s*\}, \[\]\);/,
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
  assert.match(source, /if \(!sessionsShown\) \{\s*switchTab\("sessions"\);\s*setSessionSearchOpen\(true\);\s*return;\s*\}/);
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
  assert.match(treeSource, /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{running\}\)`\}/);
  assert.match(treeSource, /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{unread\}\)`\}/);
  // The files tab's project menu shows the group headers' own badge.
  assert.match(treeSource, /export function ActivitySummary\(/);
  assert.match(source, /projectActivity=\{projectActivity\}/);
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
  assert.match(callbackBody("handleSelectSessionFromList"), /if \(s\.cwd\) setSelectedCwd\(s\.cwd\);\s*onSelectSession\(s, false, entryId, blockIndex, options\);/);
  assert.match(source, /onSelectSession=\{handleSelectSessionFromList\}/);
  // Only the list selection and the initial URL restore select a session.
  assert.equal((source.match(/\bonSelectSession\(/g) ?? []).length, 2);
});

test("expanding, collapsing or paging a group never changes the cwd", () => {
  for (const name of ["handleToggleGroup", "handleShowMore", "handleShowLess", "handleTogglePinned", "setAllGroupsExpanded", "handleGroupMenu", "moveProject"]) {
    assert.doesNotMatch(callbackBody(name), /setSelectedCwd|onCwdChange/, `${name} must not switch projects`);
  }
  // "Show more" adds SHOW_MORE_STEP families a click; "show less" folds back.
  assert.match(callbackBody("handleShowMore"), /setMoreShown\(\(prev\) => showMoreFamilies\(prev, key\)\);/);
  assert.match(callbackBody("handleShowLess"), /setMoreShown\(\(prev\) => showLessFamilies\(prev, key\)\);/);
  // A toggle reads what is shown (kept open for the page included) and saves
  // an explicit choice, which replaces the page's for that group.
  assert.match(callbackBody("handleToggleGroup"), /const expanded = !isGroupExpanded\(project, shownGroupExpansion\);\s*if \(all\) \{\s*setAllGroupsExpanded\(\(\) => expanded\);\s*return;\s*\}\s*const next = \{ \.\.\.groupExpansion \};[\s\S]*?delete next\[projectKey\];\s*next\[projectKey\] = expanded;\s*saveGroupChoices\(next, \[projectKey\]\);/);
  // Alt+click on a header: every group follows it.
  assert.match(treeSource, /onClick=\{\(event\) => handlers\.current\.onToggleGroup\(project\.key, event\.altKey\)\}/);
  assert.match(callbackBody("setAllGroupsExpanded"), /const next = \{ \.\.\.groupExpansion \};\s*for \(const project of model\.projects\) \{\s*delete next\[project\.key\];\s*next\[project\.key\] = expanded\(project\);\s*\}\s*saveGroupChoices\(next, null\);/);
  // "Open in Files" of another project is the one deliberate switch from a group.
  assert.match(callbackBody("openProjectInFiles"), /if \(!project\.current\) setSelectedCwd\(project\.root\);[\s\S]*?revealFiles\("project-button"\);/);
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
  // "Use default directory" validates today's folder like a picked one, for the bar.
  assert.match(handle, /openDefaultDirectoryForNewSession: \(onPicked\) => \{\s*folderPickRef\.current = onPicked;\s*folderReturnFocusRef\.current = null;\s*void handleDefaultCwdRef\.current\("new-session"\);/);
  assert.match(source, /const handleDefaultCwdRef = useRef\(handleDefaultCwd\);\s*handleDefaultCwdRef\.current = handleDefaultCwd;/);
  // The files tab's picker uses the same two: both are stable.
  assert.match(handle, /refreshWorktrees,\s*createWorktree,\s*\}\), \[createWorktree, refreshWorktrees\]\);\s*$/);
  assert.match(source, /const refreshWorktrees = useCallback\(\(\) => setWtRefreshKey\(\(k\) => k \+ 1\), \[\]\);/);
  // A created worktree is listed at once and refetched, whether or not anyone moves there.
  const create = callbackBody("createWorktree");
  assert.match(create, /body: JSON\.stringify\(\{ cwd: project\.root, branch \}\)/);
  assert.match(create, /if \(!res\.ok \|\| data\.error \|\| !data\.path\) return \{ error: data\.error \?\? `HTTP \$\{res\.status\}` \};/);
  const listed = create.indexOf("prev.projectKey === project.key && !prev.worktrees.some((worktree) => worktree.path === path)");
  const refetch = create.indexOf("setWtRefreshKey((k) => k + 1);\n      return { path };");
  assert.ok(listed >= 0 && listed < refetch, "listed, then refetched, then handed back");
  assert.match(create, /return \{ error: e instanceof Error \? e\.message : String\(e\) \};\s*\}\s*\}, \[\]\);/);
  assert.match(source, /controlRef\?: Ref<SessionSidebarControl>;/);
});

test("the composer's folder pick leaves the sidebar's cwd to the shell, and Cancel gives focus back", () => {
  const commit = callbackBody("commitCustomPath");
  assert.match(commit, /useCallback\(async \(candidate\?: string, \{ remember = true, purpose = customPathOpen \} = \{\}\) => \{/);
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
  assert.match(snapshot, /projects: projectChoiceList,/);
  // With the names the user gave projects, the bar's project too.
  assert.match(source, /const projectChoiceList = useMemo\(\s*\(\) => mergeProjectChoices\(model\.projects, recentProjects, projectNames\),\s*\[model\.projects, recentProjects, projectNames\],\s*\);/);
  assert.match(snapshot, /project: withProjectAlias\(selectedProject, projectNames\),/);
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

test("the footer opens the project list in the files; the archive view replaces the tree", () => {
  const footer = source.slice(source.indexOf("const handleOpenOtherProject"), source.indexOf("const sessionMenuItems"));
  assert.match(footer, /revealFiles\("project-list"\);\s*\};/);
  // Once the files show, the picker's project menu opens below its button.
  assert.match(footer, /if \(target === "project-list"\) filesPickerRef\.current\?\.openMenu\("project"\);/);
  assert.match(source, /onOpenOtherProject: handleOpenOtherProject,/);
  assert.match(source, /onOpenArchive: openArchiveView,/);
  // The sessions tab, in the tabs layout (switchTab does nothing below the files).
  assert.match(callbackBody("openArchiveView"), /setArchiveView\(true\);[\s\S]*?setSessionSearchOpen\(false\);\s*switchTab\("sessions"\);/);
  assert.match(source, /<div className="sidebar-sessions-view" hidden=\{archiveView\}>\s*<SessionTree\s+\{\.\.\.treeProps\}\s+rows=\{model\.rows\}\s+emptyLabel=\{t\("sidebar\.noSessions"\)\}\s+reveal=\{treeReveal\}\s+onRevealHandled=\{handleRevealHandled\}\s+\/>/);
  assert.match(source, /<SessionTree \{\.\.\.treeProps\} rows=\{archiveRows\} emptyLabel=\{t\("sidebar\.noArchived"\)\} \/>/);
  assert.match(source, /const sessionMenuItems = \(row: SessionRow\): SidebarMenuItem\[\] => sessionMenuEntries\(row\.context, row\.status\)/);
  assert.match(callbackBody("handleTogglePinned"), /setPinnedCollapsed\(next\);\s*savePinnedCollapsed\(next\);/);
});

test("the files tab shows the composer bar's picker as two rows, with removal and activity", () => {
  const html = render({ selectedCwd: "/work/alpha" });
  const filesPanel = html.slice(html.indexOf('id="session-sidebar-panel-files"'));
  // Before the sidebar has a cwd: the project row asks for one.
  assert.match(filesPanel, /<div class="project-picker is-stacked" role="group" aria-label="Project and worktree"><button type="button" class="project-picker-button is-project is-empty" title="" aria-haspopup="menu" aria-expanded="false">/);
  assert.match(filesPanel, /<span class="project-picker-label">Select project…<\/span>/);
  const pickerStart = source.indexOf("<ProjectWorktreePicker\n");
  const picker = source.slice(pickerStart, source.indexOf("/>", pickerStart));
  assert.match(picker, /layout="stacked"/);
  // The bar's context, or every project while there is no cwd yet.
  assert.match(picker, /context=\{newSessionContext \?\? \{ project: null, worktrees: null, currentWorktreePath: null, projects: projectChoiceList \}\}/);
  assert.match(picker, /worktreeHint=\{inactiveWorktreeSelector\}/);
  assert.match(picker, /onPick=\{handleFilesPick\}/);
  assert.match(picker, /onUseDefaultDirectory=\{\(\) => \{ void handleDefaultCwd\(\); \}\}/);
  assert.match(picker, /onOpenFolder=\{handleCustomPathClick\}/);
  assert.match(picker, /onCreateWorktree=\{createWorktree\}/);
  assert.match(picker, /onRemoveWorktree=\{handleRemoveWorktree\}/);
  // A pick moves the cwd, as the old dropdowns did, with the picked identity
  // first: a pinned project without sessions has no other source of its key.
  assert.match(callbackBody("handleFilesPick"), /useCallback\(\(\{ cwd, projectKey, projectRoot \}: NewSessionTarget\) => \{\s*if \(projectKey && projectRoot\) setValidatedProject\(\{ cwd, root: projectRoot, key: projectKey \}\);\s*setSelectedCwd\(cwd\);\s*\}, \[\]\);/);
  // A dirty checkout is the picker's question to ask; a removed current one falls back to the root.
  const remove = callbackBody("handleRemoveWorktree");
  assert.match(remove, /body: JSON\.stringify\(\{ cwd: project\.root, path, force \}\)/);
  assert.match(remove, /if \(data\.dirty && !force\) return "dirty";\s*return \{ error: data\.error \?\? `HTTP \$\{res\.status\}` \};/);
  assert.match(remove, /if \(currentWorktreePath === path\) setSelectedCwd\(project\.root\);\s*setWtRefreshKey\(\(k\) => k \+ 1\);\s*return "removed";/);
  // Nothing is left of the inline-styled dropdowns.
  assert.doesNotMatch(source, /AnimatedDropdown|DROPDOWN_STYLE|PathLabel|dropdownOpen|projectFilter|wtFilter|wtNewBranch|wtDropdownOpen|wtConfirmRemove|wtBusy|wtError|showProjectActivity|sidebar-project|sidebar-worktree/);
  assert.doesNotMatch(sidebarStyles, /\.sidebar-project|\.sidebar-worktree-(?:button|icon|label|note|chevron)/);
});

test("the group that stops being current keeps its rows open for the page, never saved", () => {
  const effect = source.slice(source.indexOf("const previousCurrentProjectKeyRef"), source.indexOf("// An explicit choice for the groups"));
  assert.match(effect, /useLayoutEffect\(\(\) => \{/, "settled before the browser paints the collapsed group");
  assert.match(effect, /if \(previous === null \|\| previous === currentProjectKey\) return;\s*const outgoing = projectByKey\.get\(previous\);\s*setKeptOpenGroups\(\(kept\) => keepOutgoingGroupOpen\(kept, groupExpansion, outgoing\)\);/);
  assert.doesNotMatch(effect, /setGroupExpansion|saveGroupExpansion|saveGroupChoices/);

  // The tree and every toggle read the saved choices over the page's.
  assert.match(source, /const shownGroupExpansion = useMemo\(\s*\(\) => effectiveGroupExpansion\(groupExpansion, keptOpenGroups\),\s*\[groupExpansion, keptOpenGroups\],\s*\);/);
  assert.match(source, /currentProject,\s*groupExpansion: shownGroupExpansion,\s*moreShown,/);
  // Every read of the expansion is the shown one; the saved choices are read
  // only to build the next ones (and by the keep-open, which skips them).
  assert.doesNotMatch(source, /isGroupExpanded\([^)]*, groupExpansion\)/);
  assert.equal((source.match(/\bgroupExpansion\[/g) ?? []).length, 0);
  assert.equal((source.match(/\{ \.\.\.groupExpansion \}/g) ?? []).length, 3, "the toggle, every group at once, the fork's reveal");

  // Only explicit choices are saved, and each one replaces what the page kept
  // open for its groups (all of them for a choice made for every group).
  assert.match(callbackBody("saveGroupChoices"), /useCallback\(\(next: Readonly<Record<string, boolean>>, keys: readonly string\[\] \| null\) => \{\s*setGroupExpansion\(next\);\s*saveGroupExpansion\(next\);\s*setKeptOpenGroups\(\(kept\) => forgetKeptOpenGroups\(kept, keys\)\);\s*\}, \[\]\);/);
  assert.equal((source.match(/saveGroupExpansion\(/g) ?? []).length, 1, "saved in one place");
  assert.equal((source.match(/setGroupExpansion\(/g) ?? []).length, 2, "the load after hydration and saveGroupChoices");
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
  // The awaiting ids ride the same two sources, through the same helper.
  assert.equal((source.match(/setAwaitingInputSessionIds\(\(previous\) => sameIdsOr\(previous, data\.awaitingInputSessionIds \?\? \[\]\)\);/g) ?? []).length, 2);
  assert.doesNotMatch(source, /setRunningSessionIds\(new Set/);
});

test("focus that went away with the archive view, a toast or a delete confirmation lands on what replaced it", () => {
  // Opening the archive: Back; going back: the footer link, else the selected tab.
  const archive = source.slice(source.indexOf("const archiveBackRef"), source.indexOf("const handleTabKeyDown"));
  assert.match(archive, /if \(previousArchiveViewRef\.current === archiveView\) return;/, "nothing moves on mount");
  assert.match(archive, /if \(archiveView\) \{\s*focusIfHidden\(archiveBackRef\.current\);/);
  assert.match(archive, /querySelector<HTMLElement>\('\[data-row-key="footer-archived"\] button'\);\s*const target = footer && footer\.getClientRects\(\)\.length > 0 \? footer : selectedTabButton\(\);\s*focusIfHidden\(target\);/);
  // A fork opened from the archive may take focus from where closing it put it.
  assert.match(archive, /if \(target && document\.activeElement === target\) archiveCloseFocusRef\.current = target;/);
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

test("Fork copies the row's session on the server and opens the copy where its row is", () => {
  assert.match(source, /case "fork": void forkFamily\(row\); break;/);
  const fork = callbackBody("forkFamily");
  // One per session at a time (another session's Fork goes ahead), never for
  // a transient session, never through an AgentSession.
  assert.match(source, /const forkingIdsRef = useRef\(new Set<string>\(\)\);/);
  assert.match(fork, /if \(source\.transient \|\| forkingIdsRef\.current\.has\(source\.id\)\) return;\s*forkingIdsRef\.current\.add\(source\.id\);/);
  assert.match(fork, /fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(source\.id\)\}\/fork`, \{\s*method: "POST",\s*headers: \{ "Content-Type": "application\/json" \},\s*body: "\{\}",/);
  assert.doesNotMatch(fork, /sendAgentCommand|handleSessionForked|\/api\/agent/);
  assert.match(fork, /finally \{\s*forkingIdsRef\.current\.delete\(source\.id\);\s*\}/);
  // A refusal says why; a source deleted elsewhere leaves the tree. No forced rescan.
  assert.match(fork, /const \{ key, params \} = forkFailureMessage\(data\.code, data\.error \?\? `HTTP \$\{res\.status\}`\);\s*showToast\(t\(key, params\)\);/);
  assert.match(fork, /if \(data\.code === "not_found"\) void loadSessions\(\);/);
  assert.doesNotMatch(fork, /loadSessions\(false, true\)/);
  // The answer always runs the newest openForked, never a click-time closure.
  const selectedAtClick = fork.indexOf("const selectedAtClick = selectedSessionIdRef.current;");
  const request = fork.indexOf("await fetch(");
  assert.ok(selectedAtClick >= 0 && selectedAtClick < request, "the selection is noted before the request");
  assert.match(fork, /openForkedRef\.current\(forked, row\.key\);\s*showToast\(message, \[\], tail\);/);
  assert.doesNotMatch(fork, /[^.]openForked\(|handleSelectSessionFromList/);
  // The toast names the copy; its ellipsis cuts the name before the suffix,
  // which stays in the toast's tail (lib/session-fork-name.ts). An unnamed
  // copy is cut as other toasts are.
  assert.match(fork, /const title = sessionRowTitle\(forked\);\s*const \{ head: message, tail \} = splitBeforeForkSuffix\(t\("sidebar\.forkedToast", \{ title \}\), title\)\s*\?\? \{ head: t\("sidebar\.forkedToast", \{ title: shortTitle\(title, TOAST_TITLE_MAX\) \}\), tail: undefined \};/);
  assert.match(source, /import \{ splitBeforeForkSuffix \} from "@\/lib\/session-fork-name";/);
  assert.match(callbackBody("showToast"), /setToast\(\{ id: toastIdRef\.current, message, \.\.\.\(tail \? \{ tail \} : \{\}\), actions \}\);/);
  // The user moved on meanwhile: they stay; the copy waits unread and the toast offers it.
  const movedOn = fork.slice(fork.indexOf("if (selectedSessionIdRef.current !== selectedAtClick) {"), fork.indexOf("openForkedRef.current(forked, row.key);"));
  assert.match(movedOn, /setAllSessions\(\(current\) => \(current\.some\(\(session\) => session\.id === forked\.id\) \? current : \[forked, \.\.\.current\]\)\);/);
  assert.match(movedOn, /setUnreadSessionIds\(\(prev\) => new Set\(prev\)\.add\(forked\.id\)\);/);
  assert.match(movedOn, /void loadSessions\(\);/);
  assert.match(movedOn, /showToast\(message, \[\{ id: "open", label: t\("sidebar\.open"\), onClick: \(\) => openForkedRef\.current\(forked, null\) \}\], tail\);\s*return;/);
  assert.match(source, /const openForkedRef = useRef\(openForked\);\s*openForkedRef\.current = openForked;/);

  const open = callbackBody("openForked");
  // The archive closes; its saved scroll of the main tree must not undo the reveal.
  const dropScroll = open.indexOf("panelScrollTopsRef.current.delete(main);");
  const close = open.indexOf("setArchiveView(false);");
  assert.ok(dropScroll >= 0 && dropScroll < close, "the main tree's saved position goes before the archive closes");
  assert.match(open, /querySelector\("\.sidebar-sessions-view \.session-tree-scroll"\)/);
  // A group the user collapsed opens, as the newest choice.
  assert.match(open, /if \(Object\.hasOwn\(shownGroupExpansion, groupKey\) && shownGroupExpansion\[groupKey\] === false\) \{\s*const next = \{ \.\.\.groupExpansion \};[\s\S]*?delete next\[groupKey\];\s*next\[groupKey\] = true;\s*saveGroupChoices\(next, \[groupKey\]\);/);
  // Opened like a row click: the cwd moves to its worktree, AppShell adopts
  // the project. The Fork's own answer leaves a phone's drawer open (the copy
  // looks like its source; its row and the toast are in the drawer); the
  // toast's Open closes it, as a row click does.
  assert.match(open, /handleSelectSessionFromList\(forked, undefined, undefined, \{ keepSidebarOpen: fromRowKey !== null \}\);\s*\/\/[^\n]*\n\s*void loadSessions\(\);/);
  assert.match(source, /export interface SelectSessionOptions \{[\s\S]*?keepSidebarOpen\?: boolean;\s*\}/);
  // Every request has a new id (a counter, not the last request's, which is
  // gone once handled) and its time, so the tree can drop it when stale.
  assert.match(open, /treeRevealIdRef\.current \+= 1;\s*setTreeReveal\(\{\s*id: treeRevealIdRef\.current,\s*at: Date\.now\(\),\s*rowKey: `session:group:\$\{forked\.id\}`,\s*takeFocusFrom: \(active\) => \(fromRow !== null && active\.closest\(fromRow\) !== null\) \|\| active === archiveCloseFocusRef\.current,/);
  // The tree hands a request back once it has scrolled to it or dropped it:
  // kept, a tree mounted again after a search would run it a second time.
  assert.match(source, /const handleRevealHandled = useCallback\(\(id: number\) => \{\s*setTreeReveal\(\(current\) => \(current\?\.id === id \? null : current\)\);\s*\}, \[\]\);/);
  assert.equal((source.match(/setTreeReveal\(/g) ?? []).length, 3, "only a fork's open, a project move and the tree's answer set it");
  // Only the main tree reveals; the archive view is closed by then.
  assert.equal((source.match(/reveal=\{treeReveal\}/g) ?? []).length, 1);
  assert.equal((source.match(/onRevealHandled=\{handleRevealHandled\}/g) ?? []).length, 1);
  assert.doesNotMatch(source.slice(source.indexOf("const treeProps = {"), source.indexOf("} as const;")), /reveal/);
  assert.match(source, /fork: "sidebar\.fork",/);
  assert.match(source, /case "fork": return <ForkIcon \/>;/);
});

test("new projects are saved to the project order once, quietly, after real state and details have loaded", () => {
  const effect = source.slice(source.indexOf("const recordedOrderKeysRef"), source.indexOf("// Every project in the groups' order"));
  // Not from a failed GET's empty state (archived projects would look live), not from summary rows.
  assert.match(effect, /if \(loading \|\| !uiStateSynced \|\| !sessionDetailsLoaded\) return;/);
  assert.match(source, /synced: uiStateSynced,/);
  assert.match(callbackBody("loadSessions"), /setAllSessions\(data\.sessions\);\s*if \(!summary\) setSessionDetailsLoaded\(true\);/);
  // A full list takes nothing more: no request at all.
  assert.match(effect, /if \(storedOrderLength >= MAX_PROJECT_ORDER_KEYS\) return;/);
  // At most one request's worth, bottom first (lib/session-tree.test.mjs plays
  // it out), and only the keys sent are marked: each key once per page.
  assert.match(effect, /const keys = nextProjectKeysToRecord\(projectKeysToRecord, recorded, MAX_SESSION_UI_IDS_PER_REQUEST\);\s*if \(keys\.length === 0\) return;\s*for \(const key of keys\) recorded\.add\(key\);/);
  // The raw apply: a background save that fails shows no toast.
  assert.match(effect, /void applyUiStateRequest\(\{ action: "add-projects", keys \}\);/);
  assert.doesNotMatch(effect, /applyUiState\(/);
  assert.match(effect, /\}, \[applyUiStateRequest, loading, projectKeysToRecord, sessionDetailsLoaded, storedOrderLength, uiStateSynced\]\);/);
});

test("a project moves next to another of its band, its band's unsaved projects first, and is then revealed", () => {
  const move = callbackBody("moveProject");
  assert.match(move, /if \(!project \|\| !anchor \|\| project === anchor \|\| project\.pinned !== anchor\.pinned\) return;/);
  assert.match(move, /const add = model\.unorderedKeysByBand\[project\.pinned \? "pinned" : "other"\]\.slice\(-MAX_SESSION_UI_IDS_PER_REQUEST\);\s*void applyUiState\(\{ action: "move-project", projectKey, anchorKey, position, add \}\);/);
  // The tree's one reveal mechanism: a new id from the counter; the row stays
  // mounted until handled, so the menu can give focus back to its ⋯.
  assert.match(move, /treeRevealIdRef\.current \+= 1;\s*setTreeReveal\(\{ id: treeRevealIdRef\.current, at: Date\.now\(\), rowKey: `group:\$\{projectKey\}` \}\);/);
  assert.match(source, /onMoveGroup: moveProject,/);

  // Move up / Move down sit in the group menu, disabled at the band's edges,
  // for the project as the tree has it now.
  const items = between("const groupMenuItems = ", "let menuTitle");
  assert.match(items, /const up = adjacentProjectMove\(model\.projects, project\.key, "up"\);\s*const down = adjacentProjectMove\(model\.projects, project\.key, "down"\);/);
  assert.match(items, /id: "move-up",\s*label: t\("sidebar\.moveProjectUp"\),\s*icon: <ChevronIcon className="sidebar-icon-up" \/>,\s*disabled: up === null,\s*onSelect: \(\) => \{ if \(up\) moveProject\(project\.key, up\.anchorKey, up\.position\); \},/);
  assert.match(items, /id: "move-down",\s*label: t\("sidebar\.moveProjectDown"\),\s*icon: <ChevronIcon className="sidebar-icon-down" \/>,\s*disabled: down === null,\s*onSelect: \(\) => \{ if \(down\) moveProject\(project\.key, down\.anchorKey, down\.position\); \},/);
  assert.ok(items.indexOf('id: "pin-project"') < items.indexOf('id: "move-up"'));
  // The sidebar's view menu went with the brand's row: collapsing and
  // expanding every group is a group's menu (and Alt+click on a header),
  // each disabled when the groups are already that way.
  assert.match(items, /id: "collapse-others",\s*label: t\("sidebar\.collapseOtherGroups"\),\s*icon: <ChevronIcon \/>,\s*disabled: model\.projects\.every\(\(other\) => isGroupExpanded\(other, shownGroupExpansion\) === \(other\.key === project\.key\)\),\s*onSelect: \(\) => setAllGroupsExpanded\(\(other\) => other\.key === project\.key\),/);
  assert.match(items, /id: "expand-all",\s*label: t\("sidebar\.expandAllGroups"\),\s*icon: <ChevronIcon className="sidebar-icon-down" \/>,\s*disabled: model\.projects\.every\(\(other\) => isGroupExpanded\(other, shownGroupExpansion\)\),\s*onSelect: \(\) => setAllGroupsExpanded\(\(\) => true\),/);
  assert.ok(items.indexOf('id: "open-in-files"') < items.indexOf('id: "collapse-others"'));
  assert.ok(items.indexOf('id: "expand-all"') < items.indexOf('id: "view-archived"'));
  assert.doesNotMatch(source, /viewMenuItems|kind: "view"|sidebar\.viewOptions/);
  assert.match(source, /const project = projectByKey\.get\(menu\.project\.key\) \?\? menu\.project;\s*menuTitle = project\.name;\s*menuLabel = t\("sidebar\.projectActions", \{ name: project\.name \}\);\s*menuItems = groupMenuItems\(project, menu\.olderCount\);/);
});

test("a project's Rename… and Reset name change its display name only, from its group menu", () => {
  const items = between("const groupMenuItems = ", "let menuTitle");
  // Rename… always, Reset name while the project has a name of its own, right after Pin.
  assert.match(items, /const nameItems = projectNameMenuEntries\(project\)\.map\(/);
  assert.match(items, /label: t\("sidebar\.renameProject"\),\s*icon: <PencilIcon \/>,\s*onSelect: \(\) => startProjectRename\(project\),/);
  assert.match(items, /label: t\("sidebar\.resetProjectName"\),\s*icon: <RestoreIcon \/>,\s*onSelect: \(\) => \{ void applyUiState\(\{ action: "rename-project", projectKey: project\.key, name: null \}\); \},/);
  assert.ok(items.indexOf('id: "pin-project"') < items.indexOf("...nameItems,") && items.indexOf("...nameItems,") < items.indexOf('id: "move-up"'));
  // Saving goes through the UI state alone (a refused save rolls back with a
  // toast): no cwd, selection, order, pin or expansion change.
  const commit = callbackBody("commitProjectRename");
  assert.match(commit, /endProjectRename\(project\.key\);\s*const request = projectRenameRequest\(project, value\);\s*if \(request\) void applyUiState\(request\);/);
  const start = callbackBody("startProjectRename");
  const end = callbackBody("endProjectRename");
  for (const body of [commit, start, end]) {
    assert.doesNotMatch(body, /setSelectedCwd|onSelectSession|setGroupExpansion|saveGroupChoices|moveProject|pin-project|setMenu/);
  }
  // The field goes, and the header's toggle takes the focus if it fell to the page.
  assert.match(end, /setRenamingProjectKey\(\(current\) => \(current === projectKey \? null : current\)\);\s*focusAfterCommit\(\(\) => groupHeaderButton\(projectKey\)\);/);
  assert.match(source, /renamingProjectKey,\n/);
  assert.match(source, /onRenameProjectCommit: commitProjectRename,\s*onRenameProjectCancel: \(\) => \{ if \(renamingProjectKey\) endProjectRename\(renamingProjectKey\); \},/);
});
