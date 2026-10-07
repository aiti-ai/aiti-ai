import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { SessionTree, sessionRowTitle } = await jiti.import("./SessionTree.tsx");
const { buildSessionTree, SIDEBAR_ROW_HEIGHTS } = await jiti.import("@/lib/session-tree.ts");
const { messages: zhCN } = (await jiti.import("@/lib/i18n/messages/zh-CN.ts")).zhCNLocale;
const { messages: zhTW } = (await jiti.import("@/lib/i18n/messages/zh-TW.ts")).zhTWLocale;
const source = await readFile(new URL("./SessionTree.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/sidebar.css", import.meta.url), "utf8");

const h = React.createElement;
const MINUTE = 60_000;
const NOW = Date.now();

function decode(html) {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, "\n");
}

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule not found`);
  return match[1];
}

const noop = () => {};
const defaults = {
  rows: [],
  layout: "desktop",
  emptyLabel: null,
  loading: false,
  error: null,
  renamingRootId: null,
  confirmDeleteRootId: null,
  activeMenuRowKey: null,
  onSelectFamily: noop,
  onToggleGroup: noop,
  onToggleMore: noop,
  onTogglePinned: noop,
  onArchiveFamily: noop,
  onRestoreFamily: noop,
  onOpenRowMenu: noop,
  onRowContextMenu: noop,
  onRenameCommit: noop,
  onRenameCancel: noop,
  onDeleteConfirm: noop,
  onDeleteCancel: noop,
  onGroupNew: noop,
  onGroupMenu: noop,
  onOpenOtherProject: noop,
  onOpenArchive: noop,
};

function render(props) {
  return decode(renderToStaticMarkup(h(I18nProvider, null, h(SessionTree, { ...defaults, ...props }))));
}

/** The markup of one rendered row, from its opening tag to the next row. */
function rowMarkup(html, key) {
  const part = html.split(/(?=<div class="session-tree-row )/).find((chunk) => chunk.includes(`data-row-key="${key}"`));
  assert.ok(part, `row ${key} not rendered`);
  return part;
}

function renderedKeys(html) {
  return [...html.matchAll(/data-row-key="([^"]+)"/g)].map((match) => match[1]);
}

function session(id, extra = {}) {
  const modified = new Date(NOW - 5 * MINUTE).toISOString();
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/work/app",
    projectRoot: "/work/app",
    projectKey: "/work/app",
    created: modified,
    modified,
    messageCount: 3,
    firstMessage: `first ${id}`,
    ...extra,
  };
}

const project = { key: "/work/app", root: "/work/app", name: "app", pinned: false, current: true };

function sessionRow(root, { context = "group", status = {}, archivedAt = null, rowProject = project } = {}) {
  return {
    kind: "session",
    key: `session:${context}:${root.id}`,
    family: { root, subagents: [], latestModified: root.modified },
    context,
    project: rowProject,
    status: { running: false, unread: false, selected: false, transient: false, ...status },
    archivedAt,
  };
}

function groupRow(extra = {}, projectExtra = {}) {
  const groupProject = { ...project, ...projectExtra };
  return { kind: "group", key: `group:${groupProject.key}`, project: groupProject, expanded: true, running: 0, unread: 0, ...extra };
}

const footer = [{ kind: "footer-open", key: "footer-open" }];

test("the pinned header toggles the section and shows activity dots only while collapsed", () => {
  const collapsed = rowMarkup(render({
    rows: [{ kind: "pinned-header", key: "pinned-header", count: 3, collapsed: true, running: 1, unread: 2 }],
  }), "pinned-header");
  assert.match(collapsed, /<button type="button" class="session-tree-pinned-toggle" aria-expanded="false">/);
  assert.match(collapsed, /<span class="session-tree-pinned-label">Pinned<\/span><span class="session-tree-pinned-count">· 3<\/span>/);
  assert.match(collapsed, /class="session-tree-pinned-dot is-running" role="img" title="Agent running…" aria-label="Agent running… \(1\)"/);
  assert.match(collapsed, /class="session-tree-pinned-dot is-unread" role="img" title="New session activity" aria-label="New session activity \(2\)"/);
  assert.doesNotMatch(collapsed, /session-tree-chevron is-open/);

  const expanded = rowMarkup(render({
    rows: [{ kind: "pinned-header", key: "pinned-header", count: 3, collapsed: false, running: 1, unread: 2 }],
  }), "pinned-header");
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /session-tree-chevron is-open/);
  assert.doesNotMatch(expanded, /session-tree-pinned-dot/);
});

test("a collapsed group shows its running and unread counts and labelled actions", () => {
  const html = rowMarkup(render({
    rows: [groupRow({ expanded: false, running: 2, unread: 1 }, { pinned: true, current: false })],
  }), "group:/work/app");
  assert.match(html, /^<div class="session-tree-row session-tree-group" style="top:0;height:28px"/);
  assert.match(html, /<button type="button" class="session-tree-group-toggle" aria-expanded="false" title="\/work\/app">/);
  assert.match(html, /<span class="session-tree-group-name">app<\/span>/);
  assert.match(html, /<svg[^>]*class="session-tree-group-pin" role="img" aria-label="Pinned"/);
  assert.match(html, /aria-label="Agent running… \(2\)"/);
  assert.match(html, /aria-label="New session activity \(1\)"/);
  assert.match(html, /aria-label="New session in app" title="New session in app"/);
  assert.match(html, /aria-label="app actions" title="app actions" aria-haspopup="menu" aria-expanded="false"/);

  // The glyph names the state, not the Pin action: in Chinese the section header
  // reads "置顶"/"釘選" like the menu item, the glyph "已置顶"/"已釘選".
  assert.match(source, /className="session-tree-group-pin" label=\{t\("sidebar\.pinnedProject"\)\}/);
  assert.match(source, /<span className="session-tree-pinned-label">\{t\("sidebar\.pinned"\)\}<\/span>/);
  for (const [messages, state, header, action] of [[zhCN, "已置顶", "置顶", "置顶"], [zhTW, "已釘選", "釘選", "釘選"]]) {
    assert.equal(messages["sidebar.pinnedProject"], state);
    assert.equal(messages["sidebar.pinned"], header);
    assert.equal(messages["sidebar.pin"], action);
  }

  const expanded = rowMarkup(render({ rows: [groupRow({ expanded: true, running: 2, unread: 1 })] }), "group:/work/app");
  assert.match(expanded, /session-tree-group is-current/);
  assert.match(expanded, /aria-expanded="true" title="\/work\/app"/);
  assert.doesNotMatch(expanded, /session-tree-summary/);
  assert.doesNotMatch(expanded, /session-tree-group-pin/);
});

test("a group shows which of its buttons opened a menu and disables + while it is busy", () => {
  const more = rowMarkup(render({ rows: [groupRow()], activeMenuRowKey: "group:/work/app" }), "group:/work/app");
  assert.match(more, /session-tree-group is-current is-active/);
  assert.match(more, /class="session-tree-group-action is-active" aria-label="app actions"[^>]*aria-expanded="true"/);

  const picker = rowMarkup(render({ rows: [groupRow()], activeMenuRowKey: "group:/work/app", activeGroupMenu: "new" }), "group:/work/app");
  assert.match(picker, /class="session-tree-group-action is-active" aria-label="New session in app"[^>]*aria-expanded="true"/);
  assert.match(picker, /aria-label="app actions"[^>]*aria-expanded="false"/);

  const pending = rowMarkup(render({ rows: [groupRow()], pendingGroupKey: "/work/app" }), "group:/work/app");
  assert.match(pending, /aria-label="New session in app"[^>]*aria-busy="true" disabled=""/);
  assert.match(pending, /sidebar-spin/);
});

test("an idle session row shows its short time, branch and both actions", () => {
  const root = session("idle", { isWorktree: true, branch: "feat/rows" });
  const html = rowMarkup(render({ rows: [sessionRow(root)] }), "session:group:idle");
  assert.match(html, /^<div class="session-tree-row session-tree-session" style="top:0;height:32px" data-row-key="session:group:idle">/);
  assert.match(html, /<span class="session-tree-slot"><\/span><span class="session-tree-title">first idle<\/span><span class="session-tree-branch">⑂ feat\/rows<\/span><span class="session-tree-meta">5m<\/span>/);
  assert.match(html, /title="first idle\n3 msgs · 5 minutes ago · ⑂ feat\/rows"/);
  assert.match(html, /class="session-tree-action session-tree-quick-action" aria-label="Archive" title="Archive"/);
  assert.match(html, /class="session-tree-action session-tree-more-action" aria-label="More actions" title="More actions" aria-haspopup="menu" aria-expanded="false"/);
  assert.doesNotMatch(html, /aria-current/);
});

test("a branch chip needs a linked worktree", () => {
  const html = render({ rows: [sessionRow(session("main", { branch: "main" }))] });
  assert.doesNotMatch(html, /session-tree-branch/);
  assert.doesNotMatch(html, /⑂/);
});

test("a running row shows the labelled spinner and cannot be archived from the row", () => {
  const html = rowMarkup(render({ rows: [sessionRow(session("run"), { status: { running: true, unread: true } })] }), "session:group:run");
  assert.match(html, /<span class="session-tree-slot is-running" title="Agent running…"><svg[^>]*class="sidebar-spin" role="img" aria-label="Agent running…"/);
  assert.doesNotMatch(html, /session-tree-unread/);
  assert.doesNotMatch(html, /aria-label="Archive"/);
  assert.match(html, /aria-label="More actions"/);
});

test("an unread row shows the labelled unread dot", () => {
  const html = rowMarkup(render({ rows: [sessionRow(session("new"), { status: { unread: true } })] }), "session:group:new");
  assert.match(html, /<span class="session-tree-slot" title="New activity"><span class="session-tree-unread" role="img" aria-label="New session activity"><\/span><\/span>/);
});

test("the selected row is marked and its menu button reports an open menu", () => {
  const row = sessionRow(session("sel"), { status: { selected: true } });
  const html = rowMarkup(render({ rows: [row], activeMenuRowKey: row.key }), row.key);
  assert.match(html, /class="session-tree-row session-tree-session is-selected is-menu-open"/);
  assert.match(html, /<button type="button" class="session-tree-main" title="[^"]*" aria-current="true">/);
  assert.match(html, /class="session-tree-action session-tree-more-action is-active"[^>]*aria-expanded="true"/);
});

test("a transient row offers no actions at all", () => {
  const html = rowMarkup(render({ rows: [sessionRow(session("tmp"), { status: { transient: true } })] }), "session:group:tmp");
  assert.doesNotMatch(html, /session-tree-actions/);
  assert.doesNotMatch(html, /More actions/);
  assert.doesNotMatch(html, /aria-label="Archive"/);
  assert.match(html, /session-tree-title">first tmp</);
});

test("pinned rows name their project and archived rows offer restore with the archive time", () => {
  const pinned = rowMarkup(render({ rows: [sessionRow(session("pin"), { context: "pinned" })] }), "session:pinned:pin");
  assert.match(pinned, /<span class="session-tree-meta"><span class="session-tree-project">app<\/span><\/span>/);
  assert.match(pinned, /aria-label="Archive"/);

  const archived = rowMarkup(render({
    rows: [sessionRow(session("old"), { context: "archive", archivedAt: NOW - 2 * 60 * MINUTE })],
  }), "session:archive:old");
  assert.match(archived, /class="session-tree-row session-tree-session is-archived"/);
  assert.match(archived, /<span class="session-tree-slot is-archived"><svg/);
  assert.match(archived, /<span class="session-tree-meta">2h<\/span>/);
  assert.match(archived, /aria-label="Restore" title="Restore"/);
  assert.doesNotMatch(archived, /aria-label="Archive"/);
});

test("the phone layout uses tall rows, keeps ⋯ and drops the archive quick button", () => {
  const html = render({ layout: "mobile", rows: [groupRow(), sessionRow(session("m"))] });
  assert.match(html, /^<div class="session-tree is-mobile">/);
  assert.match(rowMarkup(html, "group:/work/app"), /style="top:0;height:40px"/);
  const row = rowMarkup(html, "session:group:m");
  assert.match(row, /style="top:40px;height:44px"/);
  assert.match(row, /aria-label="More actions"/);
  assert.doesNotMatch(row, /aria-label="Archive"/);
});

test("a summary row without details shows an ellipsis instead of a message count", () => {
  const html = render({ rows: [sessionRow(session("p", { detailsPending: true, name: "Named" }))] });
  assert.match(html, /title="Named\n… · 5 minutes ago"/);
});

test("rename mode swaps the row for a field seeded with the title", () => {
  const html = rowMarkup(render({ rows: [sessionRow(session("r", { name: "Old name" }))], renamingRootId: "r" }), "session:group:r");
  assert.match(html, /class="session-tree-row session-tree-session is-renaming"/);
  assert.match(html, /<input class="session-tree-rename" aria-label="Rename" value="Old name"\/>/);
  assert.doesNotMatch(html, /session-tree-actions/);
});

test("delete confirmation shows a shortened title and both answers", () => {
  const html = rowMarkup(render({
    rows: [sessionRow(session("d", { name: "A very long session title that keeps going" }))],
    confirmDeleteRootId: "d",
  }), "session:group:d");
  assert.match(html, /class="session-tree-row session-tree-session is-confirming"/);
  assert.match(html, /<span class="session-tree-confirm-text">Delete A very long session ti…\?<\/span>/);
  assert.match(html, /<button type="button" class="session-tree-confirm-delete"><svg[^>]*><path[\s\S]*?<\/svg>Delete<\/button>/);
  assert.match(html, /<button type="button" class="session-tree-confirm-cancel">Cancel<\/button>/);
  assert.doesNotMatch(html, /More actions/);
});

test("show more, empty groups, footer links and archive groups", () => {
  const html = render({
    rows: [
      { kind: "pinned-more", key: "pinned-more", hidden: 0, expanded: true },
      { kind: "group-more", key: "more:/work/app", projectKey: "/work/app", hidden: 3, expanded: false },
      { kind: "group-empty", key: "empty:/work/app", project },
      { kind: "spacer", key: "spacer:/work/app" },
      { kind: "archive-group", key: "archive:/work/app", project, count: 2 },
      { kind: "footer-open", key: "footer-open" },
      { kind: "footer-archived", key: "footer-archived", count: 4 },
    ],
  });
  assert.match(rowMarkup(html, "pinned-more"), /<button type="button" class="session-tree-more-toggle">Show less<\/button>/);
  assert.match(rowMarkup(html, "more:/work/app"), /<button type="button" class="session-tree-more-toggle">Show 3 more<\/button>/);
  assert.match(rowMarkup(html, "empty:/work/app"), /style="top:52px;height:30px" data-row-key="empty:\/work\/app">No sessions yet<\/div>/);
  assert.doesNotMatch(html, /spacer:/);
  assert.match(rowMarkup(html, "archive:/work/app"), /title="\/work\/app"><span class="session-tree-archive-group-name">app<\/span><span class="session-tree-archive-group-count">· 2<\/span>/);
  assert.match(rowMarkup(html, "footer-open"), /<button type="button" class="session-tree-footer-button"><svg[^>]*>[\s\S]*?<\/svg><span class="session-tree-footer-label">Open another project…<\/span><\/button>/);
  assert.match(rowMarkup(html, "footer-archived"), /<span class="session-tree-footer-label">Archived · 4<\/span><svg[^>]*class="session-tree-footer-chevron"/);
});

test("loading replaces the rows; the empty label shows only without session or group rows", () => {
  const loading = render({ loading: true, rows: [groupRow(), ...footer], emptyLabel: "No sessions found" });
  assert.match(loading, /<div class="session-tree-message">Loading...<\/div>/);
  assert.deepEqual(renderedKeys(loading), []);
  assert.doesNotMatch(loading, /No sessions found/);

  const empty = render({ rows: footer, emptyLabel: "No sessions found" });
  assert.match(empty, /<div class="session-tree-message">No sessions found<\/div><div class="session-tree-scroll scrollbar-subtle">/);
  assert.deepEqual(renderedKeys(empty), ["footer-open"]);

  assert.doesNotMatch(render({ rows: [groupRow(), ...footer], emptyLabel: "No sessions found" }), /No sessions found/);
  assert.doesNotMatch(render({ rows: footer, emptyLabel: null }), /session-tree-message/);

  const failed = render({ rows: footer, emptyLabel: "No sessions found", error: "HTTP 500" });
  assert.match(failed, /<div class="session-tree-message is-error">HTTP 500<\/div>/);
  assert.doesNotMatch(failed, /No sessions found/);
});

test("only rows near the viewport are mounted, plus the ones that must stay", () => {
  const rows = Array.from({ length: 200 }, (_, index) => sessionRow(session(`s${index}`)));
  const plain = render({ rows });
  assert.match(plain, /<div class="session-tree-inner" style="height:6400px">/);
  const keys = renderedKeys(plain);
  // An unmeasured viewport counts as 600px, plus 240px of overscan below.
  assert.equal(keys.length, Math.ceil((600 + 240) / 32));
  assert.equal(keys[0], "session:group:s0");

  const kept = renderedKeys(render({
    rows,
    activeMenuRowKey: "session:group:s150",
    renamingRootId: "s120",
    confirmDeleteRootId: "s180",
  }));
  assert.deepEqual(kept.slice(-3), ["session:group:s120", "session:group:s150", "session:group:s180"]);
  assert.match(render({ rows, renamingRootId: "s120" }), /style="top:3840px;height:32px" data-row-key="session:group:s120"/);
});

test("renders the model built from a catalog with unique row keys", () => {
  const sessions = [
    session("a", { modified: new Date(NOW - MINUTE).toISOString() }),
    session("b", { cwd: "/work/other", projectRoot: "/work/other", projectKey: "/work/other" }),
    session("sub", { relation: { kind: "subagent", parentSessionId: "a", profile: "x", description: "", status: "running" } }),
  ];
  const model = buildSessionTree({
    sessions,
    uiState: { version: 1, revision: 0, sessions: { b: { pinnedAt: NOW } }, projects: {} },
    runningIds: new Set(["sub"]),
    unreadIds: new Set(),
    selectedSessionId: "a",
    currentProject: { key: "/work/app", root: "/work/app" },
    groupExpansion: {},
    expandedMore: new Set(),
    pinnedCollapsed: false,
  });
  const html = render({ rows: model.rows });
  const keys = renderedKeys(html);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, ["pinned-header", "session:pinned:b", "group:/work/app", "session:group:a", "footer-open"]);
  const familyRow = rowMarkup(html, "session:group:a");
  assert.match(familyRow, /is-selected/);
  assert.match(familyRow, /aria-label="Agent running…"/);
  assert.match(rowMarkup(html, "session:pinned:b"), /<span class="session-tree-project">other<\/span>/);
});

test("row titles fall back from the name to the first message to the id", () => {
  assert.equal(sessionRowTitle(session("x", { name: "Named" })), "Named");
  assert.equal(sessionRowTitle(session("x", { firstMessage: "y".repeat(80) })), "y".repeat(50));
  assert.equal(sessionRowTitle(session("abcdefghijklmnop", { firstMessage: "" })), "abcdefghijkl");
  const skill = '<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\nbody\n</skill>\n\nthe diff';
  assert.equal(sessionRowTitle(session("x", { firstMessage: skill })), "/skill:review the diff");
});

test("row controls stop clicks from also selecting the row and keys skip IME composition", () => {
  const actionClicks = source.match(/onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);/g) ?? [];
  // archive, restore, ⋯, group +, group ⋯
  assert.equal(actionClicks.length, 5);
  assert.match(source, /function isImeKey\(event: ReactKeyboardEvent\): boolean \{\s*return event\.nativeEvent\.isComposing \|\| event\.keyCode === 229;/);
  assert.match(source, /if \(isImeKey\(event\)\) return;\s*if \(event\.key === "Enter"\)/);
  assert.match(source, /if \(event\.key !== "Escape" \|\| isImeKey\(event\)\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*handlers\.current\.onDeleteCancel\(\);/);
  // Only a normal row reacts to clicks and right-clicks; rename and confirm return earlier.
  assert.equal((source.match(/onContextMenu=/g) ?? []).length, 1);
  assert.ok(source.indexOf("onContextMenu=") > source.indexOf("if (renaming) {"));
  assert.ok(source.indexOf("onContextMenu=") > source.indexOf("if (confirming) {"));
  assert.match(source, /handlers\.current\.onOpenRowMenu\(row, anchorOf\(button\), button\)/);
  assert.match(source, /align: "end"/);
});

test("the scroll container is measured, throttled and keeps its subtle scrollbar", () => {
  assert.match(source, /className="session-tree-scroll scrollbar-subtle"/);
  assert.match(source, /useScrollbarVisibility\(scrollRef\);/);
  assert.match(source, /const OVERSCAN_PX = 240;/);
  assert.match(source, /scrollFrameRef\.current = requestAnimationFrame\(/);
  assert.match(source, /new ResizeObserver\(\(\) => \{\s*setViewportHeight\(element\.clientHeight\);[\s\S]*?setScrollTop\(element\.scrollTop\);/);
  assert.match(source, /getVisibleRowIndices\(offsets, scrollTop, viewportHeight, OVERSCAN_PX, keepMounted\)/);
});

test("row CSS stays flat, themed and quiet", () => {
  assert.doesNotMatch(css, /&/, "no CSS nesting");
  assert.doesNotMatch(css, /@starting-style|prefers-color-scheme/);
  const colors = new Set((css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((color) => color.toLowerCase()));
  for (const color of colors) assert.ok(["#ef4444", "#0891b2", "#f87171", "#fff"].includes(color), `unexpected color ${color}`);
  assert.match(cssRule(".session-tree-session.is-selected"), /border-left-color: var\(--accent\);\s*background: var\(--bg-selected\);/);
  assert.match(cssRule(".session-tree-action"), /display: none;/);
  assert.match(cssRule(".session-tree.is-mobile .session-tree-more-action"), /display: flex;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.session-tree-unread::after \{\s*animation: none;/);
  // Keyboard focus reveals row actions; a mouse-focused (clicked) row does not keep them up.
  assert.match(cssRule(".session-tree-session:has(:focus-visible) .session-tree-action"), /display: flex;/);
  assert.match(cssRule(".session-tree-group:has(:focus-visible) .session-tree-group-actions"), /display: flex;/);
  const outsideFallback = css.replace(/@supports not selector\(:has\(\*\)\) \{[\s\S]*?\n\}\n/, "");
  assert.notEqual(outsideFallback, css, "the :focus-within fallback block exists");
  assert.doesNotMatch(outsideFallback.replace(/\/\*[\s\S]*?\*\//g, ""), /:focus-within/);
  // Heights come from SIDEBAR_ROW_HEIGHTS inline; CSS must not fight them.
  assert.doesNotMatch(cssRule(".session-tree-row"), /height/);
  assert.equal(SIDEBAR_ROW_HEIGHTS.mobile.session, 44);
});
