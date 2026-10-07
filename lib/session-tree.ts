/**
 * Flat row model of the sidebar's session tree.
 *
 * Every project is a collapsible group of session families; pinned families
 * move to one global section above the groups, archived families leave the
 * tree for the archive view. The component renders `rows` with a virtualizer
 * over per-kind heights (`getRowOffsets` + `getVisibleRowIndices`), so every
 * decision about what is shown lives here, pure and testable.
 *
 * Pin and archive flags are keyed by the family ROOT session id. An archived
 * family returns on its own when the root session gets a newer message
 * (`root.modified`, not `latestModified`: subagent activity alone does not
 * bring it back) or while any member is running.
 */

import { listSessionFamilies, type SessionFamily } from "./session-family";
import type { SessionUiFamilyState, SessionUiState } from "./session-ui-state-shared";
import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

export type SidebarLayout = "desktop" | "mobile";
export type SidebarRowKind =
  | "pinned-header" | "session" | "pinned-more" | "group" | "group-more" | "group-empty"
  | "spacer" | "footer-open" | "footer-archived" | "archive-group";

export const SIDEBAR_ROW_HEIGHTS: Record<SidebarLayout, Record<SidebarRowKind, number>> = {
  desktop: { "pinned-header": 26, session: 32, "pinned-more": 26, group: 28, "group-more": 26, "group-empty": 30, spacer: 8, "footer-open": 30, "footer-archived": 30, "archive-group": 26 },
  mobile: { "pinned-header": 30, session: 44, "pinned-more": 36, group: 40, "group-more": 36, "group-empty": 40, spacer: 8, "footer-open": 44, "footer-archived": 44, "archive-group": 30 },
};
export const GROUP_VISIBLE_LIMIT = 6;
export const PINNED_VISIBLE_LIMIT = 8;
/** How many more families each "show more" click reveals. */
export const SHOW_MORE_STEP = 20;
/** `moreShown` entry for the pinned section's "show more". */
export const PINNED_MORE_KEY = "pinned";

export interface SidebarProject { key: string; root: string; name: string; pinned: boolean; current: boolean }
export interface SidebarFamilyStatus { running: boolean; unread: boolean; selected: boolean; transient: boolean }

export type SidebarRow =
  | { kind: "pinned-header"; key: "pinned-header"; count: number; collapsed: boolean; running: number; unread: number }
  | { kind: "session"; key: string; family: SessionFamily; context: "pinned" | "group" | "archive"; project: SidebarProject; status: SidebarFamilyStatus; archivedAt: number | null }
  | { kind: "pinned-more"; key: "pinned-more"; hidden: number; canShowLess: boolean }
  | { kind: "group"; key: string; project: SidebarProject; expanded: boolean; running: number; unread: number }
  | { kind: "group-more"; key: string; projectKey: string; hidden: number; canShowLess: boolean }
  | { kind: "group-empty"; key: string; project: SidebarProject }
  | { kind: "spacer"; key: string }
  | { kind: "footer-open"; key: "footer-open" }
  | { kind: "footer-archived"; key: "footer-archived"; count: number }
  | { kind: "archive-group"; key: string; project: SidebarProject; count: number };

export interface SessionTreeInput {
  /** The full catalog (allSessions), subagents included. */
  sessions: readonly SessionInfo[];
  uiState: SessionUiState;
  runningIds: ReadonlySet<string>;
  unreadIds: ReadonlySet<string>;
  selectedSessionId: string | null;
  /** projectFor(selectedCwd); shown as a group even without sessions. */
  currentProject: { key: string; root: string } | null;
  /** Explicit user choices only (from prefs); see isGroupExpanded. */
  groupExpansion: Readonly<Record<string, boolean>>;
  /** Families revealed beyond the base limit by "show more", per projectKey or PINNED_MORE_KEY. */
  moreShown: Readonly<Record<string, number>>;
  pinnedCollapsed: boolean;
}

export interface SessionTreeModel {
  rows: SidebarRow[];
  /** Projects in group order. */
  projects: SidebarProject[];
  /** Archived families across all projects. */
  archivedCount: number;
}

type FamilyFlagsInput = Pick<SessionTreeInput, "uiState" | "runningIds" | "unreadIds" | "selectedSessionId">;

function familyEntry(state: SessionUiState, rootId: string): SessionUiFamilyState | undefined {
  // Session ids such as "constructor" must not resolve to Object.prototype members.
  return Object.hasOwn(state.sessions, rootId) ? state.sessions[rootId] : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Time value for ordering: newest first, unparsable dates last. */
function timeOf(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? -Infinity : time;
}

/** Descending comparison that is safe for ±Infinity (a - b would give NaN). */
function compareDesc(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

export function familyIds(family: SessionFamily): string[] {
  return [family.root.id, ...family.subagents.map((session) => session.id)];
}

function anyMemberIn(family: SessionFamily, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  return ids.has(family.root.id) || family.subagents.some((session) => ids.has(session.id));
}

function isMember(family: SessionFamily, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return family.root.id === sessionId || family.subagents.some((session) => session.id === sessionId);
}

/**
 * archivedAt set AND no family member running AND (root.detailsPending OR
 * archivedAt >= Date.parse(root.modified)). A summary row (detailsPending)
 * carries only stat metadata, so its time is not trusted to un-archive; an
 * unparsable root.modified likewise keeps the family archived.
 */
export function isFamilyArchived(family: SessionFamily, state: SessionUiState, runningIds: ReadonlySet<string>): boolean {
  const archivedAt = finiteNumber(familyEntry(state, family.root.id)?.archivedAt);
  if (archivedAt === null) return false;
  if (anyMemberIn(family, runningIds)) return false;
  if (family.root.detailsPending) return true;
  const modified = Date.parse(family.root.modified);
  return Number.isNaN(modified) || archivedAt >= modified;
}

/** pinnedAt set AND not isFamilyArchived. */
export function isFamilyPinned(family: SessionFamily, state: SessionUiState, runningIds: ReadonlySet<string>): boolean {
  return finiteNumber(familyEntry(state, family.root.id)?.pinnedAt) !== null
    && !isFamilyArchived(family, state, runningIds);
}

/** Last path segment of a project root, for "/" and "\\" paths alike. */
export function projectNameOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  // "/" (or "\\", "//") is a filesystem root: show it as is.
  if (!trimmed) return root.charAt(0);
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(separator + 1);
}

/** Explicit choice wins; by default the current and pinned projects are open. */
export function isGroupExpanded(project: SidebarProject, groupExpansion: Readonly<Record<string, boolean>>): boolean {
  if (Object.hasOwn(groupExpansion, project.key)) {
    const choice = groupExpansion[project.key];
    if (typeof choice === "boolean") return choice;
  }
  return project.current || project.pinned;
}

/**
 * Group choices once `outgoing`, the project that was current, no longer is
 * (`outgoing` as the new model has it). A group open only by the "current"
 * default would fold up at once: picking a session in another group would
 * move every row below it, the clicked one included, from under the pointer.
 * It stays open as an explicit choice instead. Returns `groupExpansion`
 * itself when nothing changes: an explicit choice, a pinned project (open by
 * default anyway), a project still current, or one without a group any more.
 */
export function keepOutgoingGroupOpen(
  groupExpansion: Readonly<Record<string, boolean>>,
  outgoing: SidebarProject | undefined,
): Readonly<Record<string, boolean>> {
  if (!outgoing || outgoing.current || outgoing.pinned || Object.hasOwn(groupExpansion, outgoing.key)) return groupExpansion;
  return { ...groupExpansion, [outgoing.key]: true };
}

function familyStatus(family: SessionFamily, input: FamilyFlagsInput): SidebarFamilyStatus {
  return {
    running: anyMemberIn(family, input.runningIds),
    unread: anyMemberIn(family, input.unreadIds),
    selected: isMember(family, input.selectedSessionId),
    transient: family.root.transient === true,
  };
}

function familyProjectKey(family: SessionFamily): string {
  return workspaceKeyOf(family.root);
}

function familyProjectRoot(family: SessionFamily): string {
  return family.root.projectRoot ?? family.root.cwd;
}

/**
 * SidebarProject for every key that is referenced. The root path comes from
 * the newest family of that key (families arrive newest first), then from the
 * current project, then from the pinned-project entry.
 */
function createProjectResolver(
  uiState: SessionUiState,
  currentProject: { key: string; root: string } | null,
) {
  const roots = new Map<string, string>();
  const projects = new Map<string, SidebarProject>();

  return {
    noteFamily(family: SessionFamily) {
      const key = familyProjectKey(family);
      if (!roots.has(key)) roots.set(key, familyProjectRoot(family));
    },
    get(key: string): SidebarProject {
      const cached = projects.get(key);
      if (cached) return cached;
      const pinnedEntry = Object.hasOwn(uiState.projects, key) ? uiState.projects[key] : undefined;
      const current = currentProject !== null && currentProject.key === key;
      const root = roots.get(key)
        ?? (current ? currentProject.root : undefined)
        ?? pinnedEntry?.root
        ?? key;
      const project: SidebarProject = {
        key,
        root,
        name: projectNameOf(root),
        pinned: pinnedEntry !== undefined,
        current,
      };
      projects.set(key, project);
      return project;
    },
  };
}

function sessionRow(
  family: SessionFamily,
  context: "pinned" | "group" | "archive",
  project: SidebarProject,
  input: FamilyFlagsInput,
  archivedAt: number | null,
): SidebarRow {
  return {
    kind: "session",
    key: `session:${context}:${family.root.id}`,
    family,
    context,
    project,
    status: familyStatus(family, input),
    archivedAt,
  };
}

/**
 * The first `limit` families, any later one that is running, unread or
 * selected, and the next `extra` of the others (sorted order kept). Families
 * that show anyway do not use up `extra`, so each "show more" click reveals
 * exactly SHOW_MORE_STEP more rows (or what is left), and a long project
 * never mounts all of its rows at once. `revealed` counts what `extra` showed.
 */
function visibleFamilies(
  families: readonly SessionFamily[],
  limit: number,
  extra: number,
  input: FamilyFlagsInput,
): { visible: SessionFamily[]; revealed: number } {
  let revealed = 0;
  const visible = families.filter((family, index) => {
    if (index < limit) return true;
    const status = familyStatus(family, input);
    if (status.running || status.unread || status.selected) return true;
    if (revealed < extra) {
      revealed++;
      return true;
    }
    return false;
  });
  return { visible, revealed };
}

/** Families "show more" has revealed for `key` (0 when none or malformed). */
export function shownMoreFor(moreShown: Readonly<Record<string, number>>, key: string): number {
  if (!Object.hasOwn(moreShown, key)) return 0;
  const value = moreShown[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** One "show more" click: SHOW_MORE_STEP more families for `key`. */
export function showMoreFamilies(moreShown: Readonly<Record<string, number>>, key: string): Record<string, number> {
  return { ...moreShown, [key]: shownMoreFor(moreShown, key) + SHOW_MORE_STEP };
}

/** "Show less": back to the base limit for `key`. */
export function showLessFamilies(moreShown: Readonly<Record<string, number>>, key: string): Record<string, number> {
  if (!Object.hasOwn(moreShown, key)) return moreShown as Record<string, number>;
  const next = { ...moreShown };
  delete next[key];
  return next;
}

/**
 * The "show more" row: how many families are still hidden, and whether
 * "show less" would fold anything back (only rows "show more" revealed; the
 * running, unread or selected ones stay). Null when neither applies.
 */
function moreRowState(total: number, visible: number, revealed: number): { hidden: number; canShowLess: boolean } | null {
  const hidden = total - visible;
  const canShowLess = revealed > 0;
  return hidden > 0 || canShowLess ? { hidden, canShowLess } : null;
}

export function buildSessionTree(input: SessionTreeInput): SessionTreeModel {
  const { uiState, runningIds, currentProject } = input;
  const families = listSessionFamilies(input.sessions);
  const resolver = createProjectResolver(uiState, currentProject);

  let archivedCount = 0;
  const pinnedFamilies: SessionFamily[] = [];
  // Insertion order follows family activity (newest first).
  const projectFamilies = new Map<string, SessionFamily[]>();
  const projectActivity = new Map<string, number>();

  for (const family of families) {
    if (isFamilyArchived(family, uiState, runningIds)) {
      archivedCount++;
      continue;
    }
    resolver.noteFamily(family);
    const key = familyProjectKey(family);
    const activity = timeOf(family.latestModified);
    projectActivity.set(key, Math.max(projectActivity.get(key) ?? -Infinity, activity));
    if (isFamilyPinned(family, uiState, runningIds)) {
      pinnedFamilies.push(family);
      continue;
    }
    const list = projectFamilies.get(key);
    if (list) list.push(family);
    else projectFamilies.set(key, [family]);
  }

  const rows: SidebarRow[] = [];

  // Pinned section: newest pin first; ties keep family activity order.
  if (pinnedFamilies.length > 0) {
    const pinnedAt = (family: SessionFamily) => finiteNumber(familyEntry(uiState, family.root.id)?.pinnedAt) ?? 0;
    const sorted = pinnedFamilies
      .map((family, index) => ({ family, index }))
      .sort((a, b) => compareDesc(pinnedAt(a.family), pinnedAt(b.family)) || a.index - b.index)
      .map(({ family }) => family);
    let running = 0;
    let unread = 0;
    for (const family of sorted) {
      if (anyMemberIn(family, runningIds)) running++;
      if (anyMemberIn(family, input.unreadIds)) unread++;
    }
    rows.push({ kind: "pinned-header", key: "pinned-header", count: sorted.length, collapsed: input.pinnedCollapsed, running, unread });
    if (!input.pinnedCollapsed) {
      const { visible, revealed } = visibleFamilies(sorted, PINNED_VISIBLE_LIMIT, shownMoreFor(input.moreShown, PINNED_MORE_KEY), input);
      for (const family of visible) {
        rows.push(sessionRow(family, "pinned", resolver.get(familyProjectKey(family)), input, null));
      }
      const more = moreRowState(sorted.length, visible.length, revealed);
      if (more) rows.push({ kind: "pinned-more", key: "pinned-more", ...more });
    }
    // Group spacers are "spacer:<projectKey>", so this key cannot collide.
    rows.push({ kind: "spacer", key: "pinned-spacer" });
  }

  // Projects: live non-pinned families, the current project, pinned projects.
  const projectKeys: string[] = [...projectFamilies.keys()];
  const seen = new Set(projectKeys);
  const addKey = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    projectKeys.push(key);
  };
  if (currentProject) addKey(currentProject.key);
  for (const key of Object.keys(uiState.projects)) addKey(key);

  const projects = projectKeys.map((key) => resolver.get(key));
  const activityOf = (project: SidebarProject) => projectActivity.get(project.key)
    ?? (project.current ? Infinity : -Infinity);
  const projectPinnedAt = (project: SidebarProject) => finiteNumber(uiState.projects[project.key]?.pinnedAt) ?? 0;
  const pinnedProjects = projects
    .map((project, index) => ({ project, index }))
    .filter(({ project }) => project.pinned)
    .sort((a, b) => compareDesc(projectPinnedAt(b.project), projectPinnedAt(a.project)) || a.index - b.index)
    .map(({ project }) => project);
  const otherProjects = projects
    .map((project, index) => ({ project, index }))
    .filter(({ project }) => !project.pinned)
    .sort((a, b) => compareDesc(activityOf(a.project), activityOf(b.project)) || a.index - b.index)
    .map(({ project }) => project);
  const orderedProjects = [...pinnedProjects, ...otherProjects];

  for (const project of orderedProjects) {
    const groupFamilies = projectFamilies.get(project.key) ?? [];
    const expanded = isGroupExpanded(project, input.groupExpansion);
    let running = 0;
    let unread = 0;
    for (const family of groupFamilies) {
      if (anyMemberIn(family, runningIds)) running++;
      if (anyMemberIn(family, input.unreadIds)) unread++;
    }
    rows.push({ kind: "group", key: `group:${project.key}`, project, expanded, running, unread });

    if (expanded) {
      if (groupFamilies.length === 0) {
        rows.push({ kind: "group-empty", key: `empty:${project.key}`, project });
      } else {
        const { visible, revealed } = visibleFamilies(groupFamilies, GROUP_VISIBLE_LIMIT, shownMoreFor(input.moreShown, project.key), input);
        for (const family of visible) rows.push(sessionRow(family, "group", project, input, null));
        const more = moreRowState(groupFamilies.length, visible.length, revealed);
        if (more) rows.push({ kind: "group-more", key: `more:${project.key}`, projectKey: project.key, ...more });
      }
    }
    rows.push({ kind: "spacer", key: `spacer:${project.key}` });
  }

  rows.push({ kind: "footer-open", key: "footer-open" });
  if (archivedCount > 0) rows.push({ kind: "footer-archived", key: "footer-archived", count: archivedCount });

  return { rows, projects: orderedProjects, archivedCount };
}

/**
 * The archive view: archived families of every project, grouped by project.
 * Groups by their newest archivedAt (desc), families by archivedAt (desc).
 */
export function buildArchiveRows(
  input: Pick<SessionTreeInput, "sessions" | "uiState" | "runningIds" | "unreadIds" | "selectedSessionId" | "currentProject">,
): SidebarRow[] {
  const { uiState, runningIds } = input;
  const flags: FamilyFlagsInput = input;
  const resolver = createProjectResolver(uiState, input.currentProject);
  const groups = new Map<string, { newest: number; families: { family: SessionFamily; archivedAt: number }[] }>();

  for (const family of listSessionFamilies(input.sessions)) {
    if (!isFamilyArchived(family, uiState, runningIds)) continue;
    resolver.noteFamily(family);
    const archivedAt = finiteNumber(familyEntry(uiState, family.root.id)?.archivedAt) ?? 0;
    const key = familyProjectKey(family);
    const group = groups.get(key);
    if (group) {
      group.families.push({ family, archivedAt });
      group.newest = Math.max(group.newest, archivedAt);
    } else {
      groups.set(key, { newest: archivedAt, families: [{ family, archivedAt }] });
    }
  }

  const rows: SidebarRow[] = [];
  const ordered = [...groups.entries()]
    .map(([key, group], index) => ({ key, group, index }))
    .sort((a, b) => compareDesc(a.group.newest, b.group.newest) || a.index - b.index);
  for (const { key, group } of ordered) {
    const project = resolver.get(key);
    rows.push({ kind: "archive-group", key: `archive:${key}`, project, count: group.families.length });
    const families = group.families
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => compareDesc(a.archivedAt, b.archivedAt) || a.index - b.index);
    for (const { family, archivedAt } of families) {
      rows.push(sessionRow(family, "archive", project, flags, archivedAt));
    }
  }
  return rows;
}

/**
 * Root ids of live, non-pinned, non-running, non-unread, non-selected
 * families of `projectKey` whose latestModified is older than
 * now - olderThanMs. Transient families have no file and are never archived.
 */
export function familiesToArchive(
  input: Pick<SessionTreeInput, "sessions" | "uiState" | "runningIds" | "unreadIds" | "selectedSessionId">,
  projectKey: string,
  olderThanMs: number,
  now: number,
): string[] {
  const cutoff = now - olderThanMs;
  const ids: string[] = [];
  for (const family of listSessionFamilies(input.sessions)) {
    if (familyProjectKey(family) !== projectKey) continue;
    if (isFamilyArchived(family, input.uiState, input.runningIds)) continue;
    if (isFamilyPinned(family, input.uiState, input.runningIds)) continue;
    const status = familyStatus(family, input);
    if (status.running || status.unread || status.selected || status.transient) continue;
    const modified = Date.parse(family.latestModified);
    if (Number.isNaN(modified) || modified >= cutoff) continue;
    ids.push(family.root.id);
  }
  return ids;
}

/** Prefix sums of row heights: length rows.length + 1, offsets[0] = 0. */
export function getRowOffsets(rows: readonly SidebarRow[], layout: SidebarLayout): number[] {
  const heights = SIDEBAR_ROW_HEIGHTS[layout];
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rows.length; index++) {
    offsets[index + 1] = offsets[index] + heights[rows[index].kind];
  }
  return offsets;
}

const UNMEASURED_VIEWPORT_HEIGHT = 600;

/**
 * Indices to render: rows intersecting [scrollTop - overscanPx,
 * scrollTop + viewportHeight + overscanPx] (an unmeasured viewport of 0 counts
 * as 600px), plus every valid index in `keepMounted`. Sorted and unique.
 */
export function getVisibleRowIndices(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number,
  keepMounted: readonly number[] = [],
): number[] {
  const count = Math.max(0, offsets.length - 1);
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : UNMEASURED_VIEWPORT_HEIGHT;
  const overscan = Number.isFinite(overscanPx) && overscanPx > 0 ? overscanPx : 0;
  const windowStart = top - overscan;
  const windowEnd = top + height + overscan;

  // First row whose bottom edge is below windowStart.
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid + 1] > windowStart) high = mid;
    else low = mid + 1;
  }
  const first = low;

  // First row whose top edge is at or past windowEnd; the range ends before it.
  low = first;
  high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] >= windowEnd) high = mid;
    else low = mid + 1;
  }
  const end = low;

  const indices: number[] = [];
  for (let index = first; index < end; index++) indices.push(index);
  if (keepMounted.length === 0) return indices;

  const extra = keepMounted.filter((index) => Number.isInteger(index) && index >= 0 && index < count && (index < first || index >= end));
  if (extra.length === 0) return indices;
  return [...new Set([...indices, ...extra])].sort((a, b) => a - b);
}
