"use client";

import { useCallback, useEffect, useId, useRef, useState, type Ref } from "react";
import type {
  McpActionResponse,
  McpCodemodeInfo,
  McpCodemodePreference,
  McpConfigFieldRef,
  McpResponse,
  McpScope,
  McpServerInfo,
  McpServerStatus,
  McpSessionStatus,
  ProjectTrustStatus,
} from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { shortenPath } from "@/lib/display-path";
import {
  mcpFieldLabel,
  mcpFileProblemDetail,
  mcpServerHasHiddenCharacters,
  mcpServerTarget,
  mcpVariableChips,
  mcpVariableReferencesKey,
  revealHiddenCharacters,
} from "@/lib/mcp-server-display";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "@/lib/settings-navigation";
import { focusAfterChange, focusIfLost } from "@/lib/stacked-dialog";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailGrid,
  ConfigDetailGridRow,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigFooter,
  ConfigFooterStatus,
  ConfigNotice,
  ConfigPanelShell,
  ConfigScopeSwitch,
  ConfigScopeTag,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarGroupStatus,
  ConfigSidebarGroupSwitch,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
  ConfigTrustNotice,
} from "./SettingsUi";
import {
  MCP_CODEMODE_SELECTION,
  MCP_CODEMODE_STATE_KEYS,
  MCP_EXPOSURE_KEYS,
  MCP_EXPOSURE_SHORT_KEYS,
  MCP_READ_ONLY_KEYS,
  MCP_ROW_STATE_BADGE_KEYS,
  MCP_TEST_BLOCK_KEYS,
  MCP_TEST_REFUSAL_KEYS,
  MCP_TEST_SERIAL_KEY,
  isBlockingFileProblem,
  loadMcpOverview,
  mcpCodemodeAlwaysUnavailableNotice,
  mcpCodemodeAutomaticNotice,
  mcpCodemodeBuiltinNotice,
  mcpCodemodeProjectOverrideNotice,
  mcpCodemodeReachNotice,
  mcpCodemodeRowState,
  mcpCodemodeTone,
  mcpEffectiveAutoEnableCodemode,
  mcpEmptyDetailKey,
  mcpFileProblems,
  mcpGroupCounts,
  mcpGroupEmptyKey,
  mcpGroupSwitchChecked,
  mcpGroupSwitchTargets,
  mcpProjectTrustable,
  mcpRowContext,
  mcpRowStateDetailKey,
  mcpRowStateLabelKey,
  mcpRowStateTone,
  mcpServerGroups,
  mcpSeconds,
  mcpServerKey,
  mcpServerRowState,
  mcpSessionStateView,
  mcpSessionSummaryKey,
  mcpStatusDot,
  mcpStatusTimeText,
  mcpTestAnswerOutdates,
  mcpTestBlock,
  mcpTestExplainKey,
  mcpTestRunAfter,
  mcpTestRunFor,
  mcpTestStateView,
  mcpTestSummaryKey,
  mcpTrustNotice,
  mcpUnavailableNotice,
  mcpWithTestResults,
  mcpWriteBlock,
  mcpWritesOff,
  pickMcpSelection,
  postMcpAction,
  postMcpTest,
  saveMcpCodemodePreference,
  withMcpCodemodePreference,
  type McpActionFailure,
  type McpActionRequest,
  type McpActionResult,
  type McpAutoEnableCodemode,
  type McpLoadFailure,
  type McpNoticeText,
  type McpRowContext,
  type McpServerGroup,
  type McpTestBlock,
  type McpTestRun,
  type McpWriteBlock,
} from "./mcp-config-helpers";
import { projectTrustReloadKey } from "./settings-ui-helpers";

type Translate = ReturnType<typeof useI18n>["t"];

/** What the panel has loaded; a project the route refused leaves the global listing and `projectError`. */
export type McpConfigLoad =
  | { state: "loading" }
  | { state: "failed"; error: McpLoadFailure }
  | { state: "loaded"; data: McpResponse; projectError?: McpLoadFailure };

function scopeLabel(scope: McpScope, t: Translate): string {
  return scope === "project" ? t("skills.scope.project") : t("skills.scope.global");
}

/** A path as the panel shows it: the home folder as `~`, hidden characters escaped. */
function displayPath(path: string): string {
  return revealHiddenCharacters(shortenPath(path));
}

/** A notice's text, with any `path` parameter shown as `displayPath()` shows it. */
function noticeText({ key, params }: McpNoticeText, t: Translate): string {
  if (!params) return t(key);
  return t(key, params.path === undefined ? params : { ...params, path: displayPath(params.path) });
}

/** A refusal's translated reason, or for an internal or network failure its diagnostic. */
function failureText(failure: McpLoadFailure, t: Translate): string {
  if (failure.timedOut) return t("mcp.loadTimedOut");
  return failure.reason && failure.reason !== "internal" ? t(`mcp.reason.${failure.reason}`) : failure.error;
}

/** The same for a change, whose timeout means it may have landed. */
function actionFailureText(failure: McpActionFailure, t: Translate): string {
  if (failure.timedOut) return t("mcp.actionTimedOut");
  return failureText(failure, t);
}

/** What saving the Code mode choice is doing: nothing, waiting for the route, or why it failed. */
export interface McpCodemodeSaveState {
  saving: boolean;
  error: McpLoadFailure | null;
}

/** What the last group switch left undone, under that group's heading. */
export interface McpGroupStatus {
  scope: McpScope;
  /** Servers that reference PI_WEB_PASSWORD, which the switch left off. */
  keptOff: number;
  /** The servers the route refused, of `total` asked for. */
  failures: { name: string; failure: McpActionFailure }[];
  total: number;
  /** The request as a whole failed. */
  error?: McpActionFailure;
}

/**
 * A removal that can still be undone, while its notice shows: the token the
 * route answered with, never the entry, which stays on the server.
 */
export interface McpUndoNotice {
  token: string;
  scope: McpScope;
  name: string;
  path: string;
  /** How long the route holds it, from when the notice appeared. */
  expiresInMs: number;
  undoing: boolean;
  error?: McpActionFailure;
}

/**
 * Where focus goes once a change is answered and nothing waits any more: the
 * button it was started from (disabled meanwhile, which dropped focus to the
 * page). A new object per change, so the same button twice still counts.
 */
export interface McpFocusBack {
  control: HTMLButtonElement | null;
}

/** The button a change is started from, when it has focus: a keyboard press, or a click in most browsers. */
function pressedButton(): HTMLButtonElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLButtonElement ? active : null;
}

/**
 * Settings › MCP: the servers of the global `mcp.json` and, with a project,
 * its `.pi/mcp.json`, from `GET /api/mcp`, which reads the files and nothing
 * else: no server is started or contacted to show this. Works without a
 * project; the Project group appears only with one. A server can be switched
 * on or off, a whole group at once, and removed with 60 seconds to undo,
 * through `POST /api/mcp`, whose answer is the overview after the change; open
 * sessions apply it at their next message. Test connects one server once
 * through `POST /api/mcp/test`, beside any change, and its result becomes the
 * row's state. The Code mode choice is written through
 * `PUT /api/tools/settings`. An untrusted project's notice offers
 * Trust, which opens the page's trust dialog (AppShell owns trust), and the
 * panel reloads once the page's status for the folder changes.
 */
export function McpConfig({
  cwd,
  onClose,
  embedded = false,
  trust,
  onTrustProject,
}: {
  cwd: string | null;
  onClose: () => void;
  embedded?: boolean;
  /** The page's trust status for `cwd`; a change reloads the panel. */
  trust?: ProjectTrustStatus | null;
  /** Opens the page's trust dialog for `cwd`; without it the trust notice has no button. */
  onTrustProject?: () => void;
}) {
  const [load, setLoad] = useState<McpConfigLoad>({ state: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => getLastSettingsSelection("mcp", cwd));
  const [codemodeSave, setCodemodeSave] = useState<McpCodemodeSaveState>({ saving: false, error: null });
  // Which change is on its way (`switch:<key>`, `remove:<key>`, `group:<scope>`, `undo`); one at a time.
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<McpActionErrorState | null>(null);
  const [groupStatus, setGroupStatus] = useState<McpGroupStatus | null>(null);
  const [undo, setUndo] = useState<McpUndoNotice | null>(null);
  const [focusBack, setFocusBack] = useState<McpFocusBack | null>(null);
  // Tests by server key. A test writes no file, so it runs beside changes and other tests.
  const [tests, setTests] = useState<Record<string, McpTestRun>>({});
  // A later load (Refresh, or the panel's project changing) wins over an earlier one still on its way.
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);
  const actionControllerRef = useRef<AbortController | null>(null);
  // The test request on its way for each server, by key; an entry is only an identity.
  const testRequestsRef = useRef(new Map<string, object>());
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    const result = await loadMcpOverview(cwd, undefined, controller.signal);
    if (request !== requestRef.current) return;
    setRefreshing(false);
    if (!result.ok) {
      setLoad({ state: "failed", error: result.error });
      return;
    }
    setLoad({ state: "loaded", data: result.data, ...(result.projectError ? { projectError: result.projectError } : {}) });
    setSelected((current) => pickMcpSelection(mcpServerGroups(result.data, Boolean(cwd)), current));
  }, [cwd]);

  // A new trust decision for the folder (the trust dialog trusted it, or read
  // one made elsewhere) loads the panel again, in place, so the project's
  // servers and notices follow while the selection stays.
  const trustKey = projectTrustReloadKey(trust);
  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [refresh, trustKey]);

  // The switch is disabled while a save or a server change runs, so only one write is ever on its way.
  const saveCodemode = useCallback(async (preference: McpCodemodePreference) => {
    const controller = new AbortController();
    saveControllerRef.current = controller;
    setCodemodeSave({ saving: true, error: null });
    const result = await saveMcpCodemodePreference(preference, undefined, controller.signal);
    // Closed meanwhile: nothing is left to update.
    if (saveControllerRef.current !== controller) return;
    saveControllerRef.current = null;
    setCodemodeSave({ saving: false, error: result.ok ? null : result.error });
    if (result.ok) {
      setLoad((current) => current.state === "loaded"
        ? { ...current, data: withMcpCodemodePreference(current.data, result.preference) }
        : current);
    }
    // Read back what is stored: a save that timed out may still land, and one
    // refused because the file no longer parses should show that file's error.
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const testRequests = testRequestsRef.current;
    return () => {
      saveControllerRef.current?.abort();
      saveControllerRef.current = null;
      actionControllerRef.current?.abort();
      actionControllerRef.current = null;
      // Tests are let go, never aborted: the route stops a test nobody waits
      // for and records nothing, while one left running records its result
      // for the next time Settings opens.
      testRequests.clear();
    };
  }, []);

  // One test per server at a time; the route joins presses from other tabs too.
  // Its answer is kept per server and shown over the listing's status while it
  // is the newer one (`mcpWithTestResults()`), so a load already on its way
  // cannot hide it. An answer that shows the listing is out of date (a
  // refusal, or a test of content the listing does not show) loads it again.
  const testServer = useCallback(async (server: McpServerInfo) => {
    const key = mcpServerKey(server);
    if (testRequestsRef.current.has(key)) return;
    const request = {};
    testRequestsRef.current.set(key, request);
    setTests((runs) => ({ ...runs, [key]: { ...runs[key], running: true, error: undefined, queueTimedOut: undefined, configKey: undefined } }));
    const current = loadRef.current;
    // As for a change: the project only when the listing covers it. A global stdio server runs there, else in the home folder.
    const testCwd = current.state === "loaded" && current.data.project ? cwd : null;
    const result = await postMcpTest({ scope: server.scope, name: server.name }, testCwd);
    // Closed meanwhile: nothing is left to update.
    if (testRequestsRef.current.get(key) !== request) return;
    testRequestsRef.current.delete(key);
    setTests((runs) => ({ ...runs, [key]: mcpTestRunAfter(runs[key], result, server.configKey) }));
    const listing = loadRef.current;
    const listed = listing.state === "loaded" ? listing.data.servers.find((item) => mcpServerKey(item) === key) : undefined;
    if (mcpTestAnswerOutdates(result, listed)) void refresh();
  }, [cwd, refresh]);

  // A change answers with the overview read after it, which replaces the
  // listing; a load still on its way may predate the change, so it is dropped.
  const applyOverview = useCallback((data: McpResponse, select?: string) => {
    requestRef.current += 1;
    controllerRef.current?.abort();
    setRefreshing(false);
    setLoad((current) => ({
      state: "loaded",
      data,
      ...(current.state === "loaded" && current.projectError ? { projectError: current.projectError } : {}),
    }));
    setSelected((current) => pickMcpSelection(mcpServerGroups(data, Boolean(cwd)), select ?? current));
  }, [cwd]);

  // Every control waits while a change runs, so only one is ever on its way.
  // A refused change reloads the listing: the file may no longer say what the
  // panel showed (a server removed meanwhile, a file that no longer parses),
  // and a change that timed out may still have landed.
  const runAction = useCallback(async (
    request: McpActionRequest,
    busyKey: string,
    select?: (data: McpActionResponse) => string | undefined,
  ): Promise<McpActionResult | undefined> => {
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setBusy(busyKey);
    const current = loadRef.current;
    // The project only when the listing covers it: a folder the route refused would refuse the change too.
    const writeCwd = current.state === "loaded" && current.data.project ? cwd : null;
    const result = await postMcpAction(request, writeCwd, undefined, controller.signal);
    // Closed meanwhile: nothing is left to update.
    if (actionControllerRef.current !== controller) return undefined;
    actionControllerRef.current = null;
    setBusy(null);
    if (result.ok) applyOverview(result.data, select?.(result.data));
    else void refresh();
    return result;
  }, [applyOverview, cwd, refresh]);

  const switchServer = useCallback(async (server: McpServerInfo, enabled: boolean) => {
    const key = mcpServerKey(server);
    const pressed = pressedButton();
    setActionError(null);
    setGroupStatus(null);
    const result = await runAction({ action: enabled ? "enable" : "disable", scope: server.scope, name: server.name }, `switch:${key}`);
    if (!result) return;
    if (!result.ok) setActionError({ key, failure: result.error });
    setFocusBack({ control: pressed });
  }, [runAction]);

  // A removal that worked moves focus to Undo, and an undo that worked to the
  // row it put back (both in the view); only a failed one gives focus back to
  // the button pressed.
  const removeServer = useCallback(async (server: McpServerInfo) => {
    const key = mcpServerKey(server);
    const pressed = pressedButton();
    setActionError(null);
    setGroupStatus(null);
    const result = await runAction({ action: "remove", scope: server.scope, name: server.name }, `remove:${key}`);
    if (!result) return;
    if (!result.ok) {
      setActionError({ key, failure: result.error });
      setFocusBack({ control: pressed });
      return;
    }
    const removed = result.data.undo;
    if (removed) setUndo({ ...removed, undoing: false });
  }, [runAction]);

  const undoRemoval = useCallback(async () => {
    const notice = undo;
    if (!notice) return;
    const pressed = pressedButton();
    setActionError(null);
    setGroupStatus(null);
    setUndo({ ...notice, undoing: true, error: undefined });
    const result = await runAction(
      { action: "undo", token: notice.token },
      "undo",
      (data) => (data.restored ? mcpServerKey(data.restored) : undefined),
    );
    if (!result) return;
    setUndo((current) => {
      if (current?.token !== notice.token) return current;
      return result.ok ? null : { ...current, undoing: false, error: result.error };
    });
    if (!result.ok) setFocusBack({ control: pressed });
  }, [runAction, undo]);

  // The notice goes when the route lets the removal go.
  const undoToken = undo?.token;
  const undoExpiresInMs = undo?.expiresInMs;
  useEffect(() => {
    if (undoToken === undefined || undoExpiresInMs === undefined) return;
    const timer = setTimeout(() => setUndo((current) => (current?.token === undoToken ? null : current)), undoExpiresInMs);
    return () => clearTimeout(timer);
  }, [undoToken, undoExpiresInMs]);

  // One request for the whole group, answered per server: the ones the route
  // refuses keep their state and are named under the heading, and so are the
  // ones referencing PI_WEB_PASSWORD, which switching on leaves off.
  const switchGroup = useCallback(async (scope: McpScope, servers: McpServerInfo[], enabled: boolean) => {
    const { targets, keptOff } = mcpGroupSwitchTargets(servers, enabled);
    const pressed = pressedButton();
    setActionError(null);
    setGroupStatus(keptOff > 0 ? { scope, keptOff, failures: [], total: 0 } : null);
    if (targets.length === 0) return;
    const result = await runAction(
      { action: "set-enabled", enabled, servers: targets.map(({ scope: serverScope, name }) => ({ scope: serverScope, name })) },
      `group:${scope}`,
    );
    if (!result) return;
    setFocusBack({ control: pressed });
    if (!result.ok) {
      setGroupStatus({ scope, keptOff, failures: [], total: targets.length, error: result.error });
      return;
    }
    const results = result.data.results ?? [];
    const failures = results
      .filter((item) => item.reason !== undefined)
      .map((item) => ({ name: item.name, failure: { error: item.error ?? "", reason: item.reason } }));
    setGroupStatus(failures.length > 0 || keptOff > 0 ? { scope, keptOff, failures, total: results.length } : null);
  }, [runAction]);

  useEffect(() => {
    if (selected) setLastSettingsSelection("mcp", selected, cwd);
  }, [cwd, selected]);

  return (
    <McpConfigView
      cwd={cwd}
      load={load}
      selected={selected}
      refreshing={refreshing}
      embedded={embedded}
      codemodeSave={codemodeSave}
      busy={busy}
      actionError={actionError}
      groupStatus={groupStatus}
      undo={undo}
      focusBack={focusBack}
      tests={tests}
      onTest={(server) => void testServer(server)}
      onSelect={(key) => {
        setSelected(key);
        setActionError(null);
      }}
      onRefresh={() => void refresh()}
      onCodemodeChange={(preference) => void saveCodemode(preference)}
      onServerSwitch={(server, enabled) => void switchServer(server, enabled)}
      onGroupSwitch={(scope, servers, enabled) => void switchGroup(scope, servers, enabled)}
      onRemove={(server) => void removeServer(server)}
      onUndo={() => void undoRemoval()}
      onTrustProject={onTrustProject}
      onClose={onClose}
    />
  );
}

/** A change to one server that failed, shown in that server's detail pane. */
export interface McpActionErrorState {
  key: string;
  failure: McpActionFailure;
}

/** The panel for a load in any state, without the fetch; exported for tests. */
export function McpConfigView({
  cwd,
  load,
  selected,
  refreshing,
  embedded,
  codemodeSave = { saving: false, error: null },
  busy = null,
  actionError = null,
  groupStatus = null,
  undo = null,
  focusBack = null,
  tests = {},
  onSelect,
  onRefresh,
  onCodemodeChange,
  onServerSwitch = () => {},
  onGroupSwitch = () => {},
  onRemove = () => {},
  onUndo = () => {},
  onTest = () => {},
  onTrustProject,
  onClose,
}: {
  cwd: string | null;
  load: McpConfigLoad;
  selected: string | null;
  refreshing: boolean;
  embedded: boolean;
  codemodeSave?: McpCodemodeSaveState;
  /** The change on its way, if any: `switch:<key>`, `remove:<key>`, `group:<scope>` or `undo`. */
  busy?: string | null;
  actionError?: McpActionErrorState | null;
  groupStatus?: McpGroupStatus | null;
  undo?: McpUndoNotice | null;
  /** The control the last answered change was started from, to give focus back to. */
  focusBack?: McpFocusBack | null;
  /** The panel's tests by server key: running, their last answer, or why one failed. */
  tests?: Readonly<Record<string, McpTestRun>>;
  onSelect: (key: string) => void;
  onRefresh: () => void;
  onCodemodeChange: (preference: McpCodemodePreference) => void;
  onServerSwitch?: (server: McpServerInfo, enabled: boolean) => void;
  onGroupSwitch?: (scope: McpScope, servers: McpServerInfo[], enabled: boolean) => void;
  onRemove?: (server: McpServerInfo) => void;
  onUndo?: () => void;
  onTest?: (server: McpServerInfo) => void;
  onTrustProject?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const unavailableNoticeId = useId();
  const trustNoticeId = useId();
  // The panel's own test results count as each server's status while they are the newest.
  const data = load.state === "loaded" ? mcpWithTestResults(load.data, tests) : undefined;
  const groups = data ? mcpServerGroups(data, Boolean(cwd)) : [];
  const context = data ? mcpRowContext(data) : undefined;
  const servers = groups.flatMap((group) => group.servers);
  const selectedServer = servers.find((server) => mcpServerKey(server) === selected);
  const unavailable = data ? mcpUnavailableNotice(data.mcp) : undefined;
  // MCP off says more: no session connects anything then.
  const hostInactive = unavailable ? undefined : data?.hostInactive;
  const projectFile = data?.files.find((file) => file.scope === "project");
  const trustNotice = data ? mcpTrustNotice(data.project, projectFile) : undefined;
  // Trust only where the dialog would offer it: the folder requires trust and is not trusted.
  const onTrust = onTrustProject && mcpProjectTrustable(data?.project) ? onTrustProject : undefined;
  const offersTrust = trustNotice?.kind === "untrusted" && onTrust !== undefined;
  // The trust dialog hands focus back to Trust… when it closes, and after a
  // successful trust the reload removes that button with its notice: focus
  // would fall to the page behind Settings. It goes to the selected row
  // instead, which the reload keeps; focus anywhere else stays where it is.
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  const offeredTrustRef = useRef(offersTrust);
  useEffect(() => {
    const offeredTrust = offeredTrustRef.current;
    offeredTrustRef.current = offersTrust;
    if (offeredTrust && !offersTrust) focusIfLost(document, selectedRowRef.current);
  }, [offersTrust]);
  // A removal unmounts the pane its Remove button sat in, and a finished or
  // expired undo the notice its Undo button sat in, so focus would fall to the
  // page behind Settings: it moves to Undo once offered, and to the selected
  // row once the notice goes. Focus anywhere else stays where it is.
  const undoButtonRef = useRef<HTMLButtonElement>(null);
  const undoToken = undo?.token;
  const shownUndoRef = useRef(undoToken);
  useEffect(() => {
    const shown = shownUndoRef.current;
    shownUndoRef.current = undoToken;
    if (undoToken !== undefined && undoToken !== shown) focusIfLost(document, undoButtonRef.current);
    else if (shown !== undefined && undoToken === undefined) focusIfLost(document, selectedRowRef.current);
  }, [undoToken]);
  const problems = data ? mcpFileProblems(data.files) : [];
  const counts = mcpGroupCounts(servers);
  const globalFile = data?.files.find((file) => file.scope === "global");
  const autoEnable = data ? mcpEffectiveAutoEnableCodemode(data) : undefined;
  const emptyKey = data ? mcpEmptyDetailKey(servers.length, data.files) : undefined;
  // Every control waits while a change, a Code mode save or a load is on its way, so the listing a click
  // acts on is the one shown, and one write's answer never replaces what another just saved.
  const controlsBusy = busy !== null || refreshing || codemodeSave.saving;
  // Waiting disables the control a change was started from, and a disabled
  // element loses focus to the page behind Settings. Once nothing waits (a
  // refused change waits for its reload too), focus goes back to it, or to the
  // selected row when it went away or stays disabled; only when it fell to the
  // page. Declared after the Undo effects: a removal that worked gives Undo
  // focus, and a later fallback must not take it.
  const handledFocusBackRef = useRef<McpFocusBack | null>(null);
  useEffect(() => {
    if (!focusBack || controlsBusy || handledFocusBackRef.current === focusBack) return;
    handledFocusBackRef.current = focusBack;
    focusAfterChange(document, focusBack.control, selectedRowRef.current);
  }, [focusBack, controlsBusy]);
  const writeBlock = (scope: McpScope): McpWriteBlock | undefined => (data ? mcpWriteBlock(scope, data) : undefined);
  const writesOff = data ? mcpWritesOff(data.mcp) : false;
  const projectServers = groups.find((group) => group.scope === "project")?.servers ?? [];
  const projectBlock = writeBlock("project");
  // The notices above the list say why a switch cannot be used; a disabled one points at them.
  const blockNoticeId = (block: McpWriteBlock | undefined) => {
    if (block === "mcp-off") return unavailable ? unavailableNoticeId : undefined;
    return block && trustNotice?.kind === "untrusted" ? trustNoticeId : undefined;
  };
  const trustMessage = trustNotice?.kind === "untrusted"
    ? [
        noticeText(trustNotice, t),
        projectBlock && projectBlock !== "mcp-off" && projectServers.length > 0 ? t(MCP_READ_ONLY_KEYS[projectBlock]) : null,
      ].filter(Boolean).join(" ")
    : "";

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("settings.mcp")}
      subtitle={cwd ? shortenPath(cwd) : undefined}
      closeLabel={t("i18n.close")}
      onClose={onClose}
    >
      {unavailable && (
        <ConfigNotice id={unavailableNoticeId}>
          {noticeText(unavailable, t)}
          {writesOff && <> {t(MCP_READ_ONLY_KEYS["mcp-off"])}</>}
          {data && !data.mcp.available && data.mcp.detail && (
            <> <code className="mcp-config-chip">{revealHiddenCharacters(data.mcp.detail)}</code></>
          )}
        </ConfigNotice>
      )}
      {hostInactive && (
        <ConfigNotice>{t("mcp.hostInactive", { path: displayPath(hostInactive.cwd), owner: displayPath(hostInactive.owner) })}</ConfigNotice>
      )}
      {load.state === "loaded" && load.projectError && (
        <ConfigNotice>{t("mcp.projectNotListed", { reason: failureText(load.projectError, t) })}</ConfigNotice>
      )}
      {trustNotice?.kind === "untrusted" && (
        <ConfigTrustNotice id={trustNoticeId} message={trustMessage} trustLabel={t("mcp.trust.trustButton")} onTrust={onTrust} />
      )}
      {trustNotice?.kind === "inherited" && <ConfigNotice>{noticeText(trustNotice, t)}</ConfigNotice>}
      {undo && (
        <ConfigNotice
          action={undo.error?.reason === "undo-unavailable" ? undefined : (
            <ConfigButton ref={undoButtonRef} size="small" onClick={onUndo} disabled={undo.undoing || controlsBusy}>
              {undo.undoing ? t("mcp.undoing") : t("mcp.undo")}
            </ConfigButton>
          )}
        >
          {t("mcp.removed", { name: revealHiddenCharacters(undo.name), path: displayPath(undo.path) })}
          {undo.error && <> {t("mcp.undoFailed")} {actionFailureText(undo.error, t)}</>}
        </ConfigNotice>
      )}

      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
            {load.state === "loading" ? (
              <div className="config-sidebar-message">{t("i18n.loading")}</div>
            ) : load.state === "failed" ? (
              <div role="alert" className="config-sidebar-message is-error">
                {t("mcp.loadFailed")} {failureText(load.error, t)}
              </div>
            ) : data && context ? (
              <>
                {/* First, so the 190px phone sidebar always shows it, however many servers follow. */}
                <div className="config-sidebar-group">
                  <McpCodemodeRow
                    codemode={data.codemode}
                    active={selected === MCP_CODEMODE_SELECTION}
                    rowRef={selectedRowRef}
                    onSelect={onSelect}
                  />
                </div>
                {groups.map((group) => {
                  const block = writeBlock(group.scope);
                  return (
                    <McpServerGroupList
                      key={group.scope}
                      group={group}
                      context={context}
                      selected={selected}
                      selectedRowRef={selectedRowRef}
                      block={block}
                      blockNoticeId={blockNoticeId(block)}
                      busy={busy}
                      controlsBusy={controlsBusy}
                      status={groupStatus?.scope === group.scope ? groupStatus : null}
                      onSelect={onSelect}
                      onGroupSwitch={onGroupSwitch}
                    />
                  );
                })}
              </>
            ) : null}
          </ConfigSidebarList>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {!data || !context || !autoEnable || !emptyKey ? null : selected === MCP_CODEMODE_SELECTION ? (
              <McpCodemodeDetail
                codemode={data.codemode}
                autoEnable={autoEnable}
                save={codemodeSave}
                serverBusy={busy !== null}
                onChange={onCodemodeChange}
              />
            ) : selectedServer ? (
              <McpServerDetail
                key={mcpServerKey(selectedServer)}
                server={selectedServer}
                context={context}
                codemode={data.codemode}
                autoEnable={autoEnable}
                block={writeBlock(selectedServer.scope)}
                savedWhileOff={!data.mcp.available && !writesOff}
                busy={busy}
                controlsBusy={controlsBusy}
                actionError={actionError?.key === mcpServerKey(selectedServer) ? actionError.failure : null}
                test={mcpTestRunFor(tests[mcpServerKey(selectedServer)], selectedServer)}
                testBlock={mcpTestBlock(selectedServer, data)}
                onSwitch={onServerSwitch}
                onRemove={onRemove}
                onTest={onTest}
              />
            ) : (
              <ConfigEmptyState>
                {emptyKey === "mcp.empty"
                  ? t(emptyKey, { globalPath: displayPath(globalFile?.path ?? "~/.pi/agent/mcp.json") })
                  : t(emptyKey)}
              </ConfigEmptyState>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      <ConfigFooter
        status={problems.length > 0 ? (
          <ConfigFooterStatus
            tone={problems.some(({ problem }) => isBlockingFileProblem(problem)) ? "error" : "warning"}
            summary={problems.length === 1 ? t("mcp.footer.fileProblem") : t("mcp.footer.fileProblems", { count: problems.length })}
            details={problems.map(({ file, problem }) => {
              const detail = mcpFileProblemDetail(problem, file.realPath);
              return (
                <>
                  <code className="mcp-config-chip">{displayPath(file.path)}</code>{" "}
                  {t(`mcp.fileProblem.${problem.reason}`)}
                  {detail && <> <code className="mcp-config-chip">{detail}</code></>}
                </>
              );
            })}
          />
        ) : (
          <ConfigFooterStatus summary={counts.total > 0 ? t("mcp.serverCount", { enabled: counts.enabled, total: counts.total }) : ""} />
        )}
      >
        {!embedded && <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>}
        <ConfigButton variant="secondary" onClick={onRefresh} disabled={controlsBusy}>
          {t("i18n.refresh")}
        </ConfigButton>
      </ConfigFooter>
    </ConfigPanelShell>
  );
}

function McpCodemodeRow({
  codemode,
  active,
  rowRef,
  onSelect,
}: {
  codemode: McpCodemodeInfo;
  active: boolean;
  /** Set to this row's button while it is the selected one. */
  rowRef: Ref<HTMLButtonElement>;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();
  const state = mcpCodemodeRowState(codemode);
  const stateText = t(MCP_CODEMODE_STATE_KEYS[state]);
  return (
    <ConfigSidebarItem
      ref={active ? rowRef : undefined}
      active={active}
      aria-label={t("mcp.codemode.rowLabel", { state: stateText })}
      onClick={() => onSelect(MCP_CODEMODE_SELECTION)}
    >
      <ConfigStatusDot {...mcpStatusDot(mcpCodemodeTone(state))} />
      <ConfigSidebarText className="is-grow">{t("mcp.codemode.title")}</ConfigSidebarText>
      <span className={`mcp-sidebar-badge is-${mcpCodemodeTone(state)}`}>{stateText}</span>
    </ConfigSidebarItem>
  );
}

/** What a group switch left undone, as the lines under the group's heading. */
function groupStatusText(status: McpGroupStatus, t: Translate): { note?: string; error?: string } {
  const note = status.keptOff > 0 ? t("mcp.groupKeptOff", { count: status.keptOff }) : undefined;
  const error = status.error
    ? `${t("mcp.actionFailed")} ${actionFailureText(status.error, t)}`
    : status.failures.length > 0
      ? [
          t("mcp.bulkFailed", { count: status.failures.length, total: status.total }),
          ...status.failures.map(({ name, failure }) => `${revealHiddenCharacters(name)}: ${actionFailureText(failure, t)}`),
        ].join("\n")
      : undefined;
  return { ...(note ? { note } : {}), ...(error ? { error } : {}) };
}

function McpServerGroupList({
  group,
  context,
  selected,
  selectedRowRef,
  block,
  blockNoticeId,
  busy,
  controlsBusy,
  status,
  onSelect,
  onGroupSwitch,
}: {
  group: McpServerGroup;
  context: McpRowContext;
  selected: string | null;
  /** Set to the selected row's button, when it is in this group. */
  selectedRowRef: Ref<HTMLButtonElement>;
  /** Why the group's servers cannot be changed here. */
  block: McpWriteBlock | undefined;
  /** The notice above the list that says so. */
  blockNoticeId: string | undefined;
  busy: string | null;
  controlsBusy: boolean;
  status: McpGroupStatus | null;
  onSelect: (key: string) => void;
  onGroupSwitch: (scope: McpScope, servers: McpServerInfo[], enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const { enabled, total } = mcpGroupCounts(group.servers);
  // On only while every server it can turn on is: a partial group reads as off beside its count, and one
  // click completes it; an entry it never turns on (PI_WEB_PASSWORD, not an object) cannot hold it off.
  const checked = mcpGroupSwitchChecked(group.servers);
  const emptyKey = mcpGroupEmptyKey(group);
  const statusText = status ? groupStatusText(status, t) : undefined;
  return (
    <div className="config-sidebar-group">
      <ConfigSidebarGroupLabel
        aside={total > 0 ? (
          <ConfigSidebarGroupSwitch
            enabled={enabled}
            total={total}
            checked={checked}
            disabled={controlsBusy || block !== undefined}
            loading={busy === `group:${group.scope}`}
            describedBy={block ? blockNoticeId : undefined}
            label={t(checked ? "mcp.groupSwitchOn" : "mcp.groupSwitchOff", { group: scopeLabel(group.scope, t) })}
            onChange={(next) => onGroupSwitch(group.scope, group.servers, next)}
          />
        ) : undefined}
      >
        {scopeLabel(group.scope, t)}
      </ConfigSidebarGroupLabel>
      {statusText && <ConfigSidebarGroupStatus note={statusText.note} error={statusText.error} />}
      {emptyKey && <div className="mcp-sidebar-group-empty">{t(emptyKey)}</div>}
      {group.servers.map((server) => {
        const key = mcpServerKey(server);
        const state = mcpServerRowState(server, context);
        const tone = mcpRowStateTone(state);
        const badgeKey = MCP_ROW_STATE_BADGE_KEYS[state];
        const name = revealHiddenCharacters(server.name);
        return (
          <ConfigSidebarItem
            key={key}
            ref={selected === key ? selectedRowRef : undefined}
            active={selected === key}
            // The dot is aria-hidden, so the state is part of the row's name.
            aria-label={t("mcp.rowLabel", { name, state: t(mcpRowStateLabelKey(state, server.status)) })}
            onClick={() => onSelect(key)}
          >
            <ConfigStatusDot {...mcpStatusDot(tone)} />
            <ConfigSidebarText className={`is-grow${tone === "on" ? "" : " is-muted"}`}>{name}</ConfigSidebarText>
            {badgeKey && <span className={`mcp-sidebar-badge is-${tone}`}>{t(badgeKey)}</span>}
          </ConfigSidebarItem>
        );
      })}
    </div>
  );
}

function McpFieldChips({ fields }: { fields: readonly McpConfigFieldRef[] }) {
  const { t } = useI18n();
  return (
    <span className="mcp-config-chips">
      {fields.map((field) => {
        const label = mcpFieldLabel(field);
        return (
          <code key={`${field.kind}\0${field.name ?? ""}`} className="mcp-config-chip">
            {t(label.key, label.params)}
          </code>
        );
      })}
    </span>
  );
}

/** Env or header names: the values stay in the file and never reach the browser. */
function McpNameList({ names }: { names: readonly string[] }) {
  const { t } = useI18n();
  if (names.length === 0) return <>{t("mcp.detail.none")}</>;
  return (
    <span className="mcp-config-lines">
      <span className="mcp-config-chips">
        {names.map((name) => <code key={name} className="mcp-config-chip">{revealHiddenCharacters(name)}</code>)}
      </span>
      <span className="mcp-config-line is-dim">{t("mcp.detail.valuesHidden")}</span>
    </span>
  );
}

/** The sentence under a server's state: why it does or does not connect. */
function McpStateDetail({ server, state }: { server: McpServerInfo; state: ReturnType<typeof mcpServerRowState> }) {
  const { t } = useI18n();
  if (state === "invalid") {
    return (
      <span className="mcp-config-line is-warning">
        {t("mcp.server.invalid")} <code className="mcp-config-chip">{revealHiddenCharacters(server.invalidError ?? "")}</code>
      </span>
    );
  }
  // None for web-password: the PI_WEB_PASSWORD line, which every state shows, says it.
  const key = mcpRowStateDetailKey(state, server.status);
  return key ? <span className="mcp-config-line">{t(key)}</span> : null;
}

function McpServerDetail({
  server,
  context,
  codemode,
  autoEnable,
  block,
  savedWhileOff,
  busy,
  controlsBusy,
  actionError,
  test,
  testBlock,
  onSwitch,
  onRemove,
  onTest,
}: {
  server: McpServerInfo;
  context: McpRowContext;
  codemode: McpCodemodeInfo;
  autoEnable: McpAutoEnableCodemode;
  /** Why this server cannot be changed here. */
  block: McpWriteBlock | undefined;
  /** MCP is off by `-builtin:mcp`: changes are written, but no session connects these servers. */
  savedWhileOff: boolean;
  busy: string | null;
  controlsBusy: boolean;
  /** The last change to this server that failed. */
  actionError: McpActionFailure | null;
  /** This server's test, if the panel started one. */
  test: McpTestRun | undefined;
  /** Why it cannot be tested. */
  testBlock: McpTestBlock | undefined;
  onSwitch: (server: McpServerInfo, enabled: boolean) => void;
  onRemove: (server: McpServerInfo) => void;
  onTest: (server: McpServerInfo) => void;
}) {
  const { t } = useI18n();
  const noteId = useId();
  const state = mcpServerRowState(server, context);
  const tone = mcpRowStateTone(state);
  const target = mcpServerTarget(server);
  // A refused entry never connects, so nothing in it runs or is sent.
  const connects = server.invalidError === undefined;
  const http = server.transport === "http" || (server.transport === undefined && server.url !== undefined);
  const stdio = !http && (server.transport === "stdio" || server.command !== undefined);
  const viaCodemode = server.exposure === "codemode" || server.exposure === "codemode-deferred";
  const reachNotice = viaCodemode ? mcpCodemodeReachNotice(codemode, autoEnable) : undefined;
  const key = mcpServerKey(server);
  const name = revealHiddenCharacters(server.name);
  // The route never turns on an entry that references PI_WEB_PASSWORD; turning one off still works.
  const passwordKeepsOff = !server.enabled && server.webPasswordField !== undefined;
  // An entry that is not an object has no `enabled` to write; Remove still works.
  const switchless = server.notAnObject === true;
  // The note under the controls: why they cannot be used, else when a change applies, which under
  // -builtin:mcp is never: the file is written, but no session connects its servers.
  const note = block
    ? t(`mcp.reason.${block}`)
    : switchless
      ? t("mcp.reason.entry-not-object")
      : passwordKeepsOff
        ? t("mcp.reason.web-password")
        : t(savedWhileOff ? "mcp.write.savedWhileOff" : "mcp.write.appliesNextMessage");

  return (
    <ConfigDetailStack>
      <div className="config-detail-heading">
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <ConfigScopeTag scope={server.scope}>{scopeLabel(server.scope, t)}</ConfigScopeTag>
            <ConfigDetailTitle>{name}</ConfigDetailTitle>
          </ConfigDetailHeaderInfo>
          <ConfigDetailActions>
            <ConfigButton
              variant="danger"
              size="small"
              disabled={controlsBusy || block !== undefined}
              aria-describedby={block ? noteId : undefined}
              onClick={() => onRemove(server)}
            >
              {busy === `remove:${key}` ? t("i18n.removing") : t("i18n.remove")}
            </ConfigButton>
            <ConfigSwitch
              checked={server.enabled}
              disabled={controlsBusy || block !== undefined || switchless || passwordKeepsOff}
              loading={busy === `switch:${key}`}
              describedBy={noteId}
              label={t(server.enabled ? "mcp.server.switchOff" : "mcp.server.switchOn", { name })}
              onChange={(enabled) => onSwitch(server, enabled)}
            />
          </ConfigDetailActions>
        </ConfigDetailHeader>
        <div id={noteId} className="config-detail-heading-note">{note}</div>
      </div>
      {actionError && (
        <p role="alert" className="mcp-config-line is-error">
          {t("mcp.actionFailed")} {actionFailureText(actionError, t)}
        </p>
      )}

      <ConfigDetailGrid>
        <ConfigDetailGridRow label={t("i18n.status")} tone="plain">
          <span className="mcp-config-lines">
            <span className={`mcp-config-state is-${tone}`}>{t(mcpRowStateLabelKey(state, server.status))}</span>
            <McpStateDetail server={server} state={state} />
            {server.webPasswordField && (
              <span className="mcp-config-line is-warning">
                {t("mcp.server.webPassword")} <McpFieldChips fields={[server.webPasswordField]} />
              </span>
            )}
          </span>
        </ConfigDetailGridRow>
        <McpConnectionRows server={server} test={test} testBlock={testBlock} onTest={onTest} />
        {server.transport && (
          <ConfigDetailGridRow label={t("mcp.detail.transport")}>
            {t(`mcp.transport.${server.transport}`)}
          </ConfigDetailGridRow>
        )}
        {target !== undefined && (
          <ConfigDetailGridRow label={http ? t("mcp.detail.url") : t("mcp.detail.command")} tone="plain" mono>
            {target}
          </ConfigDetailGridRow>
        )}
        {stdio && (
          <ConfigDetailGridRow label={t("mcp.detail.cwd")} mono={server.cwd !== undefined}>
            {server.cwd !== undefined ? revealHiddenCharacters(server.cwd) : t("mcp.detail.cwdSession")}
          </ConfigDetailGridRow>
        )}
        {stdio && (
          <ConfigDetailGridRow label={t("mcp.detail.env")}>
            <McpNameList names={server.envNames} />
          </ConfigDetailGridRow>
        )}
        {http && (
          <ConfigDetailGridRow label={t("mcp.detail.headers")}>
            <McpNameList names={server.headerNames} />
          </ConfigDetailGridRow>
        )}
        {connects && server.commandFields.length > 0 && (
          <ConfigDetailGridRow label={t("mcp.detail.shellCommands")} tone="plain">
            <span className="mcp-config-lines">
              <span className="mcp-config-line is-warning">{t("mcp.server.commandFields")}</span>
              <McpFieldChips fields={server.commandFields} />
            </span>
          </ConfigDetailGridRow>
        )}
        {connects && server.variableReferences.length > 0 && (
          <ConfigDetailGridRow label={t("mcp.detail.variables")} tone="plain">
            <span className="mcp-config-lines">
              <span className="mcp-config-line is-warning">{t(mcpVariableReferencesKey(server))}</span>
              <span className="mcp-config-chips">
                {mcpVariableChips(server.variableReferences).map(({ variable, field }) => {
                  const label = mcpFieldLabel(field);
                  return (
                    <code key={`${variable}\0${field.kind}\0${field.name ?? ""}`} className="mcp-config-chip">
                      {t("mcp.server.variableIn", { variable, field: t(label.key, label.params) })}
                    </code>
                  );
                })}
              </span>
            </span>
          </ConfigDetailGridRow>
        )}
        {http && connects && (
          <ConfigDetailGridRow label={t("mcp.detail.signIn")}>
            {!server.usesOAuth
              ? t("mcp.signIn.header")
              : server.signedIn === true
                ? t("mcp.signIn.signedIn")
                : server.signedIn === false
                  ? t("mcp.signIn.notSignedIn")
                  : t("mcp.signIn.unknown")}
          </ConfigDetailGridRow>
        )}
        {server.exposure && (
          <ConfigDetailGridRow label={t("mcp.detail.exposure")} tone="plain">
            <span className="mcp-config-lines">
              <span className="mcp-config-line">{t(MCP_EXPOSURE_KEYS[server.exposure])}</span>
              {reachNotice && <span className="mcp-config-line is-warning">{noticeText(reachNotice, t)}</span>}
            </span>
          </ConfigDetailGridRow>
        )}
        <ConfigDetailGridRow label={t("mcp.detail.file")} tone="dim" mono>
          {displayPath(server.sourcePath)}
        </ConfigDetailGridRow>
      </ConfigDetailGrid>

      <div className="mcp-config-lines">
        {mcpServerHasHiddenCharacters(server) && (
          <p className="mcp-config-line is-warning">{t("mcp.server.hiddenCharacters")}</p>
        )}
        {!server.validated && <p className="mcp-config-line is-warning">{t("mcp.server.unchecked")}</p>}
        {server.replacesGlobal && <p className="mcp-config-line is-warning">{t("mcp.server.replacesGlobal")}</p>}
        {server.shadowedByProject && state !== "replaced" && (
          <p className="mcp-config-line">{t("mcp.server.shadowedByProject")}</p>
        )}
        {server.masked && <p className="mcp-config-line is-dim">{t("mcp.server.masked")}</p>}
      </div>

      <p className="mcp-config-note">{t("mcp.disclosure")}</p>
    </ConfigDetailStack>
  );
}

/** A server's stderr as lines, each with its hidden characters escaped; the line breaks stay. */
function revealLines(text: string): string {
  return text.split(/\r?\n/).map(revealHiddenCharacters).join("\n");
}

/** Why a test request did not answer with a result, in a test's words where the reason has them. */
function testFailureText(failure: McpActionFailure, t: Translate): string {
  if (failure.timedOut) return t("mcp.test.requestTimedOut");
  const key = failure.reason ? MCP_TEST_REFUSAL_KEYS[failure.reason] : undefined;
  return key ? t(key) : failureText(failure, t);
}

/** A status's error and the stderr tail it kept, as the server's text with its hidden characters escaped. */
function McpStatusOutput({ error, stderr }: { error?: string; stderr?: string }) {
  const { t } = useI18n();
  return (
    <>
      {error && (
        <span className="mcp-config-line is-error">
          {t("mcp.test.error")} <code className="mcp-config-chip">{revealHiddenCharacters(error)}</code>
        </span>
      )}
      {stderr && (
        <>
          <span className="mcp-config-line is-dim">{t("mcp.test.stderr")}</span>
          <pre className="mcp-test-output">{revealLines(stderr)}</pre>
        </>
      )}
    </>
  );
}

/** The last known status: a test's or an open session's. */
function McpStatusLines({ status }: { status: McpServerStatus }) {
  return status.origin === "session" ? <McpSessionStatusLines status={status} /> : <McpTestStatusLines status={status} />;
}

/** What the last test found: its state with when and how long, the error and stderr, and what the server said about itself. */
function McpTestStatusLines({ status }: { status: McpServerStatus & { origin: "test" } }) {
  const { t, locale } = useI18n();
  const view = mcpTestStateView(status);
  const time = mcpStatusTimeText(status.testedAt, locale);
  const info = status.serverInfo;
  return (
    <>
      <span className="mcp-config-line">
        <span className={`mcp-config-state is-${view.tone}`}>{t(view.key)}</span>{" "}
        {t(mcpTestSummaryKey(status), { count: status.toolCount, seconds: mcpSeconds(status.durationMs), time })}
      </span>
      <McpStatusOutput error={status.error} stderr={status.stderr} />
      {info && (
        <span className="mcp-config-line is-dim">
          {t("mcp.test.serverInfo", { name: revealHiddenCharacters(info.title ?? info.name), version: revealHiddenCharacters(info.version) })}
        </span>
      )}
      {status.resources !== undefined && (
        <span className="mcp-config-line is-dim">
          {t("mcp.test.resources", { resources: status.resources, templates: status.resourceTemplates ?? 0 })}
        </span>
      )}
      {status.cwd !== undefined && <span className="mcp-config-line is-dim">{t("mcp.test.ranIn", { path: displayPath(status.cwd) })}</span>}
      {status.queuedMs !== undefined && status.queuedMs >= 500 && (
        <span className="mcp-config-line is-dim">{t("mcp.test.queued", { seconds: mcpSeconds(status.queuedMs) })}</span>
      )}
    </>
  );
}

/**
 * What an open session last saw: its state, the folder of the session that
 * reported it (a global stdio server runs in each session's own), when, and
 * why where it says: the error and stderr, or the extension that holds the
 * name. A connection the session has closed since says when it closed.
 */
function McpSessionStatusLines({ status }: { status: McpSessionStatus }) {
  const { t, locale } = useI18n();
  const view = mcpSessionStateView(status);
  const time = mcpStatusTimeText(status.updatedAt, locale);
  const closedTime = status.closedAt === undefined ? undefined : mcpStatusTimeText(status.closedAt, locale);
  return (
    <>
      <span className="mcp-config-line">
        <span className={`mcp-config-state is-${view.tone}`}>{t(view.key)}</span>{" "}
        {t(mcpSessionSummaryKey(status), { path: displayPath(status.cwd), time, ...(closedTime === undefined ? {} : { closedTime }) })}
      </span>
      {status.conflict !== undefined && (
        <span className="mcp-config-line is-error">
          {t("mcp.session.conflictOwner")} <code className="mcp-config-chip">{displayPath(status.conflict)}</code>
        </span>
      )}
      <McpStatusOutput error={status.error} stderr={status.stderr} />
    </>
  );
}

/** The tools a connected test listed, read-only: name, whether the server marks it read-only, an exposure of its own, and its description's first line. */
function McpTestToolList({ status, serverExposure }: { status: McpServerStatus & { origin: "test" }; serverExposure: McpServerInfo["exposure"] }) {
  const { t } = useI18n();
  const notShown = status.toolCount - status.tools.length;
  return (
    <span className="mcp-config-lines">
      <ul className="mcp-test-tools">
        {status.tools.map((tool, index) => (
          <li key={`${index}\0${tool.name}`} className="mcp-test-tool">
            <span className="mcp-config-chips">
              <code className="mcp-config-chip">{revealHiddenCharacters(tool.name)}</code>
              {tool.readOnly && <span className="mcp-test-tool-tag">{t("mcp.test.readOnly")}</span>}
              {tool.exposure !== (serverExposure ?? "codemode") && (
                <span className="mcp-test-tool-tag">{t(MCP_EXPOSURE_SHORT_KEYS[tool.exposure])}</span>
              )}
            </span>
            {tool.description && <span className="mcp-config-line is-dim">{revealHiddenCharacters(tool.description)}</span>}
          </li>
        ))}
      </ul>
      {notShown > 0 && <span className="mcp-config-line is-dim">{t("mcp.test.moreTools", { count: notShown })}</span>}
    </span>
  );
}

/**
 * The Connection row: the server's last known status (from a Test or an
 * open session) and what it found, the Test button, and why it cannot be
 * used, which the button points at; then, when a test connected, the tools it
 * listed.
 */
function McpConnectionRows({
  server,
  test,
  testBlock,
  onTest,
}: {
  server: McpServerInfo;
  test: McpTestRun | undefined;
  testBlock: McpTestBlock | undefined;
  onTest: (server: McpServerInfo) => void;
}) {
  const { t } = useI18n();
  const blockId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const running = test?.running === true;
  // The button is disabled while its test runs, which drops focus to the page
  // behind Settings; it gets it back once the answer is in, only from there.
  const wasRunningRef = useRef(running);
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = running;
    if (wasRunning && !running) focusIfLost(document, buttonRef.current);
  }, [running]);
  const status = server.status;
  return (
    <>
      <ConfigDetailGridRow label={t("mcp.detail.connection")} tone="plain">
        <span className="mcp-config-lines">
          {status ? <McpStatusLines status={status} /> : <span className="mcp-config-line">{t("mcp.test.never")}</span>}
          {test?.queueTimedOut && <span role="alert" className="mcp-config-line is-error">{t("mcp.test.queueTimedOut")}</span>}
          {test?.error && (
            <span role="alert" className="mcp-config-line is-error">
              {t("mcp.test.requestFailed")} {testFailureText(test.error, t)}
            </span>
          )}
          {testBlock && <span id={blockId} className="mcp-config-line is-dim">{t(MCP_TEST_BLOCK_KEYS[testBlock])}</span>}
          <span className="mcp-config-line">
            <ConfigButton
              ref={buttonRef}
              size="small"
              disabled={running || testBlock !== undefined}
              aria-busy={running || undefined}
              aria-describedby={testBlock ? blockId : undefined}
              onClick={() => onTest(server)}
            >
              {running ? t("mcp.test.testing") : t("mcp.test.button")}
            </ConfigButton>
          </span>
          {!testBlock && <span className="mcp-config-line is-dim">{t(mcpTestExplainKey(server))}</span>}
          {/* Its own line, so no locale has to join two sentences with a space. */}
          {!testBlock && server.commandFields.length > 0 && <span className="mcp-config-line is-dim">{t(MCP_TEST_SERIAL_KEY)}</span>}
        </span>
      </ConfigDetailGridRow>
      {status?.origin === "test" && status.state === "connected" && status.toolCount > 0 && (
        <ConfigDetailGridRow label={t("mcp.detail.listedTools")} tone="plain">
          <McpTestToolList status={status} serverExposure={server.exposure} />
        </ConfigDetailGridRow>
      )}
    </>
  );
}

/**
 * Code mode: the one choice, Automatic or Always on, saved to the global
 * `defaultTools` and read by sessions started afterwards (pi applies
 * `defaultTools` when it creates a session, so nothing reloads); a trusted
 * project whose own `defaultTools` decides it there; whether its sandbox can
 * run; and whether a setting turns it off. Always on is disabled, with the
 * reason as text under the switch, while no session could offer Code mode.
 */
function McpCodemodeDetail({
  codemode,
  autoEnable,
  save,
  serverBusy,
  onChange,
}: {
  codemode: McpCodemodeInfo;
  autoEnable: McpAutoEnableCodemode;
  save: McpCodemodeSaveState;
  /** A server change is on its way; its answer carries the Code mode choice as read before this save. */
  serverBusy: boolean;
  onChange: (preference: McpCodemodePreference) => void;
}) {
  const { t } = useI18n();
  const sandbox = codemode.sandbox;
  const preference = codemode.preference;
  const waiting = save.saving || serverBusy;
  const automaticNotice = mcpCodemodeAutomaticNotice(codemode, autoEnable);
  const alwaysUnavailable = mcpCodemodeAlwaysUnavailableNotice(codemode);
  const builtinNotice = mcpCodemodeBuiltinNotice(codemode);
  const projectOverride = mcpCodemodeProjectOverrideNotice(codemode);
  return (
    <ConfigDetailStack>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ConfigDetailTitle>{t("mcp.codemode.title")}</ConfigDetailTitle>
        </ConfigDetailHeaderInfo>
      </ConfigDetailHeader>
      <p className="mcp-config-line">{t("mcp.codemode.intro")}</p>

      <ConfigDetailGrid>
        <ConfigDetailGridRow label={t("mcp.codemode.mode")} tone="plain">
          <div className="mcp-config-lines">
            {preference ? (
              <>
                <ConfigScopeSwitch
                  value={preference}
                  label={t("mcp.codemode.title")}
                  options={[
                    { value: "automatic", label: t(MCP_CODEMODE_STATE_KEYS.automatic), disabled: waiting },
                    {
                      value: "always",
                      label: t(MCP_CODEMODE_STATE_KEYS.always),
                      disabled: waiting || alwaysUnavailable !== undefined,
                    },
                  ]}
                  disabledReason={alwaysUnavailable ? noticeText(alwaysUnavailable, t) : null}
                  onChange={(value) => {
                    if (value !== preference) onChange(value);
                  }}
                >
                  {save.saving && <span role="status" className="mcp-config-line is-dim">{t("i18n.saving")}</span>}
                </ConfigScopeSwitch>
                <span className="mcp-config-line">
                  {t(preference === "always" ? "mcp.codemode.alwaysDescription" : "mcp.codemode.automaticDescription")}
                </span>
                <span className="mcp-config-line is-dim">{t("mcp.codemode.appliesLater")}</span>
              </>
            ) : (
              <span className="mcp-config-line is-warning">
                {t("mcp.codemode.preferenceError")}{" "}
                <code className="mcp-config-chip">{revealHiddenCharacters(codemode.preferenceError ?? "")}</code>
              </span>
            )}
            {/* Shown on every platform: unlike the PowerShell switch, Code mode is not Windows-only. */}
            {save.error && (
              <span role="alert" className="mcp-config-line is-error">
                {t("mcp.codemode.saveFailed")}{" "}
                {save.error.timedOut
                  ? t("mcp.codemode.saveTimedOut")
                  : save.error.reason && save.error.reason !== "internal"
                    ? t(`mcp.reason.${save.error.reason}`)
                    : <code className="mcp-config-chip">{revealHiddenCharacters(save.error.error)}</code>}
              </span>
            )}
            {projectOverride && <span className="mcp-config-line is-warning">{noticeText(projectOverride, t)}</span>}
            {automaticNotice && <span className="mcp-config-line is-warning">{noticeText(automaticNotice, t)}</span>}
          </div>
        </ConfigDetailGridRow>
        <ConfigDetailGridRow label={t("mcp.codemode.sandbox")} tone="plain">
          {sandbox.state === "unavailable" ? (
            <span className="mcp-config-line is-warning">
              {t("mcp.codemode.sandbox.unavailable")}{" "}
              <code className="mcp-config-chip">{revealHiddenCharacters(sandbox.error)}</code>
            </span>
          ) : (
            <span className="mcp-config-line">
              {t(sandbox.state === "available" ? "mcp.codemode.sandbox.available" : "mcp.codemode.sandbox.not-checked")}
            </span>
          )}
        </ConfigDetailGridRow>
        {builtinNotice && (
          <ConfigDetailGridRow label={t("mcp.codemode.builtin")} tone="error">
            {noticeText(builtinNotice, t)}
          </ConfigDetailGridRow>
        )}
      </ConfigDetailGrid>
    </ConfigDetailStack>
  );
}
