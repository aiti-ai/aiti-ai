import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  GROUP_VISIBLE_LIMIT,
  PINNED_MORE_KEY,
  PINNED_VISIBLE_LIMIT,
  SIDEBAR_ROW_HEIGHTS,
  buildArchiveRows,
  buildSessionTree,
  familiesToArchive,
  familyIds,
  getRowOffsets,
  getVisibleRowIndices,
  isFamilyArchived,
  isFamilyPinned,
  isGroupExpanded,
  keepOutgoingGroupOpen,
  projectNameOf,
} = await jiti.import("./session-tree.ts");
const { listSessionFamilies } = await jiti.import("./session-family.ts");

const DAY = 86_400_000;
const BASE = Date.parse("2026-10-01T00:00:00.000Z");

function iso(ms) {
  return new Date(ms).toISOString();
}

function session(id, { project = "/work/alpha", cwd = project, modified = BASE, ...rest } = {}) {
  return {
    path: `${cwd}/${id}.jsonl`,
    id,
    cwd,
    projectRoot: project,
    projectKey: project,
    created: iso(modified),
    modified: iso(modified),
    messageCount: 1,
    firstMessage: id,
    ...rest,
  };
}

function subagent(id, parentSessionId, options = {}) {
  return session(id, {
    ...options,
    relation: { kind: "subagent", parentSessionId, profile: "explore", description: "Explore", status: "completed" },
  });
}

function uiState({ sessions = {}, projects = {} } = {}) {
  return { version: 1, revision: 0, sessions, projects };
}

function input(overrides = {}) {
  return {
    sessions: [],
    uiState: uiState(),
    runningIds: new Set(),
    unreadIds: new Set(),
    selectedSessionId: null,
    currentProject: null,
    groupExpansion: {},
    expandedMore: new Set(),
    pinnedCollapsed: false,
    ...overrides,
  };
}

function familyOf(sessions, rootId) {
  const family = listSessionFamilies(sessions).find((item) => item.root.id === rootId);
  assert.ok(family, `family ${rootId} not found`);
  return family;
}

function describeRows(rows) {
  return rows.map((row) => {
    switch (row.kind) {
      case "session": return `${row.context}:${row.family.root.id}`;
      case "group": return `group:${row.project.name}${row.expanded ? "" : " (collapsed)"}`;
      case "group-more": return `more:${row.hidden}${row.expanded ? " less" : ""}`;
      case "pinned-more": return `pinned-more:${row.hidden}${row.expanded ? " less" : ""}`;
      case "pinned-header": return `pinned:${row.count}`;
      case "group-empty": return "empty";
      case "spacer": return "-";
      case "footer-archived": return `archived:${row.count}`;
      case "archive-group": return `archive-group:${row.project.name}:${row.count}`;
      default: return row.kind;
    }
  });
}

test("family ids list the root first, then every subagent", () => {
  const sessions = [session("root"), subagent("child", "root"), subagent("grandchild", "child")];
  assert.deepEqual(familyIds(familyOf(sessions, "root")), ["root", "child", "grandchild"]);
});

test("forks stay separate rows while subagents fold into their root", () => {
  const sessions = [
    session("parent", { modified: BASE }),
    session("fork", { modified: BASE + 2, relation: { kind: "fork", originSessionId: "parent" } }),
    subagent("child", "parent", { modified: BASE + 1 }),
  ];
  const model = buildSessionTree(input({ sessions, currentProject: { key: "/work/alpha", root: "/work/alpha" } }));
  assert.deepEqual(describeRows(model.rows), ["group:alpha", "group:fork", "group:parent", "-", "footer-open"]);
  assert.deepEqual(model.rows[2].family.subagents.map((item) => item.id), ["child"]);
});

test("a family is archived until its root session gets a newer message", () => {
  const sessions = [session("root", { modified: BASE }), subagent("child", "root", { modified: BASE + 5 * DAY })];
  const family = familyOf(sessions, "root");
  const archivedLater = uiState({ sessions: { root: { archivedAt: BASE + DAY } } });
  const archivedBefore = uiState({ sessions: { root: { archivedAt: BASE - DAY } } });

  assert.equal(isFamilyArchived(family, archivedLater, new Set()), true, "subagent-only activity does not unarchive");
  assert.equal(isFamilyArchived(family, archivedBefore, new Set()), false, "a newer root message returns the family");
  assert.equal(isFamilyArchived(family, uiState({ sessions: { root: { archivedAt: BASE } } }), new Set()), true, "equal times stay archived");
  assert.equal(isFamilyArchived(family, uiState(), new Set()), false);
});

test("a running member keeps the family live; summary rows trust the flag", () => {
  const sessions = [session("root", { modified: BASE + 3 * DAY, detailsPending: true }), subagent("child", "root")];
  const family = familyOf(sessions, "root");
  const state = uiState({ sessions: { root: { archivedAt: BASE } } });

  assert.equal(isFamilyArchived(family, state, new Set()), true, "detailsPending ignores the stat time");
  assert.equal(isFamilyArchived(family, state, new Set(["child"])), false);
  assert.equal(isFamilyArchived(family, state, new Set(["root"])), false);
});

test("pinned requires a pin and a live family; prototype keys never match", () => {
  const sessions = [session("root"), session("constructor")];
  const family = familyOf(sessions, "root");
  assert.equal(isFamilyPinned(family, uiState({ sessions: { root: { pinnedAt: 1 } } }), new Set()), true);
  assert.equal(isFamilyPinned(family, uiState({ sessions: { root: { pinnedAt: 1, archivedAt: BASE + DAY } } }), new Set()), false);
  assert.equal(isFamilyPinned(family, uiState(), new Set()), false);
  const odd = familyOf(sessions, "constructor");
  assert.equal(isFamilyArchived(odd, uiState(), new Set()), false);
  assert.equal(isFamilyPinned(odd, uiState(), new Set()), false);
});

test("project names use the last path segment on POSIX and Windows", () => {
  assert.equal(projectNameOf("/Users/alex/pi-web"), "pi-web");
  assert.equal(projectNameOf("/Users/alex/pi-web/"), "pi-web");
  assert.equal(projectNameOf("C:\\Users\\Alex\\Project\\"), "Project");
  assert.equal(projectNameOf("C:\\Users\\Alex\\Project"), "Project");
  assert.equal(projectNameOf("C:/mixed\\sep/name"), "name");
  assert.equal(projectNameOf("/"), "/");
  assert.equal(projectNameOf("relative"), "relative");
  assert.equal(projectNameOf(""), "");
});

test("groups list the current project first among unpinned projects, then by activity", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 2 * DAY }),
    session("b1", { project: "/work/beta", modified: BASE + 3 * DAY }),
    subagent("a1-child", "a1", { project: "/work/alpha", modified: BASE + 4 * DAY }),
  ];
  const model = buildSessionTree(input({
    sessions,
    currentProject: { key: "/work/fresh", root: "/work/fresh" },
  }));

  assert.deepEqual(model.projects.map((project) => project.name), ["fresh", "alpha", "beta"]);
  assert.deepEqual(describeRows(model.rows), [
    "group:fresh", "empty", "-",
    "group:alpha (collapsed)", "-",
    "group:beta (collapsed)", "-",
    "footer-open",
  ]);
  assert.equal(model.projects[0].current, true);
  assert.equal(model.archivedCount, 0);
});

test("pinned projects come first in pin order and use the stored root without sessions", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 9 * DAY }),
    session("b1", { project: "/work/beta", modified: BASE }),
  ];
  const state = uiState({
    projects: {
      "/work/gamma": { pinnedAt: 20, root: "/work/gamma" },
      "/work/beta": { pinnedAt: 10, root: "/stale/beta" },
    },
  });
  const model = buildSessionTree(input({ sessions, uiState: state }));

  assert.deepEqual(model.projects.map((project) => [project.name, project.root, project.pinned]), [
    ["beta", "/work/beta", true],
    ["gamma", "/work/gamma", true],
    ["alpha", "/work/alpha", false],
  ]);
  assert.deepEqual(describeRows(model.rows), [
    "group:beta", "group:b1", "-",
    "group:gamma", "empty", "-",
    "group:alpha (collapsed)", "-",
    "footer-open",
  ]);
});

test("a project root comes from its newest family", () => {
  const sessions = [
    session("old", { project: "C:\\Repo", modified: BASE }),
    { ...session("new", { project: "c:/repo", modified: BASE + DAY }), projectKey: "C:\\Repo" },
  ];
  const model = buildSessionTree(input({ sessions }));
  assert.equal(model.projects.length, 1);
  assert.equal(model.projects[0].root, "c:/repo");
  assert.equal(model.projects[0].key, "C:\\Repo");
});

test("expanded groups show six families plus running, unread and selected ones", () => {
  const sessions = Array.from({ length: 10 }, (_, index) => session(`s${index}`, { modified: BASE - index * 1000 }));
  sessions.push(subagent("s8-child", "s8", { modified: BASE - 8 * 1000 - 1 }));
  const current = { key: "/work/alpha", root: "/work/alpha" };
  const model = buildSessionTree(input({
    sessions,
    currentProject: current,
    runningIds: new Set(["s8-child"]),
    unreadIds: new Set(["s7"]),
    selectedSessionId: "s9",
  }));

  assert.equal(GROUP_VISIBLE_LIMIT, 6);
  assert.deepEqual(describeRows(model.rows), [
    "group:alpha", "group:s0", "group:s1", "group:s2", "group:s3", "group:s4", "group:s5",
    "group:s7", "group:s8", "group:s9", "more:1", "-", "footer-open",
  ]);
  const group = model.rows[0];
  assert.equal(group.running, 1);
  assert.equal(group.unread, 1);
  const s8 = model.rows.find((row) => row.key === "session:group:s8");
  assert.deepEqual(s8.status, { running: true, unread: false, selected: false, transient: false });
  assert.equal(model.rows.find((row) => row.key === "session:group:s9").status.selected, true);
});

test("show more lists every family and offers show less", () => {
  const sessions = Array.from({ length: 8 }, (_, index) => session(`s${index}`, { modified: BASE - index }));
  const base = input({ sessions, currentProject: { key: "/work/alpha", root: "/work/alpha" } });

  const collapsed = buildSessionTree(base);
  const more = collapsed.rows.find((row) => row.kind === "group-more");
  assert.deepEqual(more, { kind: "group-more", key: "more:/work/alpha", projectKey: "/work/alpha", hidden: 2, expanded: false });

  const expanded = buildSessionTree({ ...base, expandedMore: new Set(["/work/alpha"]) });
  assert.equal(expanded.rows.filter((row) => row.kind === "session").length, 8);
  assert.deepEqual(expanded.rows.find((row) => row.kind === "group-more"), {
    kind: "group-more", key: "more:/work/alpha", projectKey: "/work/alpha", hidden: 0, expanded: true,
  });

  const small = buildSessionTree({ ...base, sessions: sessions.slice(0, 3), expandedMore: new Set(["/work/alpha"]) });
  assert.equal(small.rows.some((row) => row.kind === "group-more"), false);
});

test("explicit group choices win over the current/pinned default", () => {
  const project = { key: "k", root: "/k", name: "k", pinned: false, current: true };
  assert.equal(isGroupExpanded(project, {}), true);
  assert.equal(isGroupExpanded(project, { k: false }), false);
  assert.equal(isGroupExpanded({ ...project, current: false }, {}), false);
  assert.equal(isGroupExpanded({ ...project, current: false, pinned: true }, {}), true);
  assert.equal(isGroupExpanded({ ...project, current: false }, { k: true }), true);
  assert.equal(isGroupExpanded({ ...project, key: "constructor", current: false }, {}), false);

  const sessions = [session("a1")];
  const model = buildSessionTree(input({ sessions, groupExpansion: { "/work/alpha": true } }));
  assert.deepEqual(describeRows(model.rows), ["group:alpha", "group:a1", "-", "footer-open"]);
});

test("a group open only because it was current stays open when another project becomes current", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 2 }),
    session("b1", { project: "/work/beta", modified: BASE + 1 }),
  ];
  const alpha = { key: "/work/alpha", root: "/work/alpha" };
  const beta = { key: "/work/beta", root: "/work/beta" };
  // beta opened with its chevron, alpha open by the default; then a session of beta is picked.
  const before = buildSessionTree(input({ sessions, currentProject: alpha, groupExpansion: { "/work/beta": true } }));
  assert.deepEqual(describeRows(before.rows), ["group:alpha", "group:a1", "-", "group:beta", "group:b1", "-", "footer-open"]);
  const after = buildSessionTree(input({ sessions, currentProject: beta, groupExpansion: { "/work/beta": true } }));
  const outgoing = after.projects.find((project) => project.key === alpha.key);
  const kept = keepOutgoingGroupOpen({ "/work/beta": true }, outgoing);
  assert.deepEqual(kept, { "/work/beta": true, "/work/alpha": true });
  const settled = buildSessionTree(input({ sessions, currentProject: beta, groupExpansion: kept }));
  assert.deepEqual(describeRows(settled.rows), describeRows(before.rows), "no row moves");

  // Nothing to keep: an explicit choice (open or closed), a pinned project, the
  // project still being current, or a project whose group is gone.
  const explicit = { "/work/alpha": false };
  assert.equal(keepOutgoingGroupOpen(explicit, outgoing), explicit);
  const choices = {};
  assert.equal(keepOutgoingGroupOpen(choices, { ...outgoing, pinned: true }), choices);
  assert.equal(keepOutgoingGroupOpen(choices, { ...outgoing, current: true }), choices);
  assert.equal(keepOutgoingGroupOpen(choices, undefined), choices);
  // A raw cwd key replaced by the real project key (identity hydration) had only an empty group.
  const hydrated = buildSessionTree(input({ sessions, currentProject: alpha }));
  assert.equal(keepOutgoingGroupOpen(choices, hydrated.projects.find((project) => project.key === "/work/alpha/sub")), choices);
});

test("pinned families move to the global section, newest pin first", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE + 3 }),
    session("a2", { project: "/work/alpha", modified: BASE + 2 }),
    session("b1", { project: "/work/beta", modified: BASE + 1 }),
  ];
  const state = uiState({ sessions: { a2: { pinnedAt: 100 }, b1: { pinnedAt: 200 } } });
  const model = buildSessionTree(input({
    sessions,
    uiState: state,
    unreadIds: new Set(["a2"]),
    groupExpansion: { "/work/alpha": true },
  }));

  assert.deepEqual(describeRows(model.rows), [
    "pinned:2", "pinned:b1", "pinned:a2", "-",
    "group:alpha", "group:a1", "-",
    "footer-open",
  ]);
  assert.deepEqual(model.rows[0], { kind: "pinned-header", key: "pinned-header", count: 2, collapsed: false, running: 0, unread: 1 });
  const pinnedRow = model.rows[1];
  assert.equal(pinnedRow.project.name, "beta", "pinned rows carry their own project");
  assert.equal(model.projects.some((project) => project.key === "/work/beta"), false, "a project with only pinned families has no group");
  assert.equal(model.rows.find((row) => row.kind === "group").unread, 0, "group summaries exclude pinned families");

  const collapsed = buildSessionTree(input({ sessions, uiState: state, pinnedCollapsed: true, currentProject: { key: "/work/beta", root: "/work/beta" } }));
  assert.deepEqual(describeRows(collapsed.rows).slice(0, 2), ["pinned:2", "-"]);
  assert.equal(collapsed.rows[0].collapsed, true);
  // beta's activity comes from its pinned family, so the newer alpha leads.
  assert.deepEqual(describeRows(collapsed.rows).slice(2), ["group:alpha (collapsed)", "-", "group:beta", "empty", "-", "footer-open"]);
});

test("the pinned section shows eight families, then more or less", () => {
  const sessions = Array.from({ length: 10 }, (_, index) => session(`p${index}`, { modified: BASE - index }));
  const pins = Object.fromEntries(sessions.map((item, index) => [item.id, { pinnedAt: 1000 - index }]));
  const base = input({ sessions, uiState: uiState({ sessions: pins }) });

  assert.equal(PINNED_VISIBLE_LIMIT, 8);
  const limited = buildSessionTree(base);
  assert.equal(limited.rows.filter((row) => row.kind === "session").length, 8);
  assert.deepEqual(limited.rows.find((row) => row.kind === "pinned-more"), { kind: "pinned-more", key: "pinned-more", hidden: 2, expanded: false });

  const selected = buildSessionTree({ ...base, selectedSessionId: "p9" });
  assert.equal(selected.rows.some((row) => row.key === "session:pinned:p9"), true, "the selected pinned family stays visible");
  assert.equal(selected.rows.find((row) => row.kind === "pinned-more").hidden, 1);

  const all = buildSessionTree({ ...base, expandedMore: new Set([PINNED_MORE_KEY]) });
  assert.equal(all.rows.filter((row) => row.kind === "session").length, 10);
  assert.deepEqual(all.rows.find((row) => row.kind === "pinned-more"), { kind: "pinned-more", key: "pinned-more", hidden: 0, expanded: true });
});

test("archived families leave the tree and are counted across projects", () => {
  const sessions = [
    session("a1", { project: "/work/alpha", modified: BASE }),
    session("a2", { project: "/work/alpha", modified: BASE - 1 }),
    session("b1", { project: "/work/beta", modified: BASE }),
  ];
  const state = uiState({ sessions: { a2: { archivedAt: BASE + DAY }, b1: { archivedAt: BASE + DAY } } });
  const model = buildSessionTree(input({ sessions, uiState: state, groupExpansion: { "/work/alpha": true } }));

  assert.deepEqual(describeRows(model.rows), ["group:alpha", "group:a1", "-", "footer-open", "archived:2"]);
  assert.equal(model.archivedCount, 2);
});

test("with no sessions and no current or pinned project only the footer remains", () => {
  assert.deepEqual(describeRows(buildSessionTree(input()).rows), ["footer-open"]);
  const allArchived = buildSessionTree(input({
    sessions: [session("a1")],
    uiState: uiState({ sessions: { a1: { archivedAt: BASE + DAY } } }),
  }));
  assert.deepEqual(describeRows(allArchived.rows), ["footer-open", "archived:1"]);
});

test("row keys are unique and session rows carry transient status", () => {
  const sessions = [
    session("a1", { project: "/work/alpha" }),
    session("a2", { project: "/work/alpha", transient: true }),
    session("b1", { project: "/work/beta" }),
    session("c1", { project: "/work/gamma" }),
  ];
  const model = buildSessionTree(input({
    sessions,
    uiState: uiState({ sessions: { b1: { pinnedAt: 1 } }, projects: { "/work/gamma": { pinnedAt: 1, root: "/work/gamma" } } }),
    currentProject: { key: "/work/alpha", root: "/work/alpha" },
  }));
  const keys = model.rows.map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("session:pinned:b1"));
  assert.ok(keys.includes("session:group:a1"));
  assert.ok(keys.includes("group:/work/gamma"));
  assert.ok(keys.includes("spacer:/work/alpha"));
  assert.equal(model.rows.find((row) => row.key === "session:group:a2").status.transient, true);
  assert.equal(model.rows.find((row) => row.key === "session:group:a1").archivedAt, null);
});

test("archive rows group by project, newest archive first", () => {
  const sessions = [
    session("a1", { project: "/work/alpha" }),
    session("a2", { project: "/work/alpha" }),
    session("b1", { project: "/work/beta" }),
    session("live", { project: "/work/beta" }),
  ];
  const state = uiState({
    sessions: {
      a1: { archivedAt: BASE + 1 * DAY },
      a2: { archivedAt: BASE + 3 * DAY },
      b1: { archivedAt: BASE + 2 * DAY },
    },
  });
  const rows = buildArchiveRows({
    sessions,
    uiState: state,
    runningIds: new Set(),
    unreadIds: new Set(["a1"]),
    selectedSessionId: "b1",
    currentProject: { key: "/work/beta", root: "/work/beta" },
  });

  assert.deepEqual(describeRows(rows), [
    "archive-group:alpha:2", "archive:a2", "archive:a1",
    "archive-group:beta:1", "archive:b1",
  ]);
  assert.equal(rows[1].archivedAt, BASE + 3 * DAY);
  assert.equal(rows[2].status.unread, true);
  assert.equal(rows[4].status.selected, true);
  assert.equal(rows[3].project.current, true);
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
});

test("bulk archive candidates skip pinned, running, unread, selected, transient and recent families", () => {
  const now = BASE + 30 * DAY;
  const old = BASE;
  const sessions = [
    session("old", { modified: old }),
    session("pinned", { modified: old }),
    session("running", { modified: old }),
    subagent("running-child", "running", { modified: old }),
    session("unread", { modified: old }),
    session("selected", { modified: old }),
    session("transient", { modified: old, transient: true }),
    session("recent", { modified: now - DAY }),
    session("archived", { modified: old }),
    session("other", { project: "/work/beta", modified: old }),
    session("busy-family", { modified: old }),
    subagent("busy-child", "busy-family", { modified: now - DAY }),
  ];
  const ids = familiesToArchive({
    sessions,
    uiState: uiState({ sessions: { pinned: { pinnedAt: 1 }, archived: { archivedAt: now } } }),
    runningIds: new Set(["running-child"]),
    unreadIds: new Set(["unread"]),
    selectedSessionId: "selected",
  }, "/work/alpha", 7 * DAY, now);

  assert.deepEqual(ids, ["old"]);
});

test("row offsets follow each kind's height for the layout", () => {
  const rows = [
    { kind: "group", key: "group:a" },
    { kind: "session", key: "session:group:a" },
    { kind: "spacer", key: "spacer:a" },
    { kind: "footer-open", key: "footer-open" },
  ];
  assert.deepEqual(getRowOffsets(rows, "desktop"), [0, 28, 60, 68, 98]);
  assert.deepEqual(getRowOffsets(rows, "mobile"), [0, 40, 84, 92, 136]);
  assert.deepEqual(getRowOffsets([], "desktop"), [0]);
  assert.equal(SIDEBAR_ROW_HEIGHTS.mobile.session, 44);
});

test("visible indices cover the viewport and overscan, sorted and unique", () => {
  const offsets = Array.from({ length: 2001 }, (_, index) => index * 32);
  const visible = getVisibleRowIndices(offsets, 3200, 320, 64);
  // Rows 98..111 intersect [3136, 3584).
  assert.deepEqual(visible, Array.from({ length: 14 }, (_, index) => 98 + index));

  const withFocus = getVisibleRowIndices(offsets, 3200, 320, 64, [5, 1500, 100, 5, -1, 2000, 1.5]);
  assert.deepEqual(withFocus, [5, ...visible, 1500]);

  assert.deepEqual(getVisibleRowIndices(offsets, 0, 64, 0), [0, 1]);
  assert.deepEqual(getVisibleRowIndices(offsets, 10, 32, 0), [0, 1]);
});

test("visible indices stay valid for short, empty and unmeasured lists", () => {
  const short = [0, 32, 64, 96, 128, 160];
  assert.deepEqual(getVisibleRowIndices(short, 5000, 320, 240), [], "scrolled past a list that shrank");
  assert.deepEqual(getVisibleRowIndices(short, 0, 320, 240), [0, 1, 2, 3, 4]);
  assert.deepEqual(getVisibleRowIndices([0], 0, 320, 240, [0]), []);
  const long = Array.from({ length: 101 }, (_, index) => index * 32);
  assert.equal(getVisibleRowIndices(long, 0, 0, 0).length, 19, "viewport 0 assumes 600px");
  assert.deepEqual(getVisibleRowIndices(long, Number.NaN, 0, 0), getVisibleRowIndices(long, 0, 600, 0));
});
