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
  MCP_READ_ONLY_KEYS,
  MCP_ROW_STATE_BADGE_KEYS,
  MCP_ROW_STATE_LABEL_KEYS,
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
  mcpRowStateTone,
  mcpServerGroups,
  mcpServerKey,
  mcpServerRowState,
  mcpStatusDot,
  mcpTrustNotice,
  mcpUnavailableNotice,
  mcpWriteBlock,
  mcpWritesOff,
  pickMcpSelection,
  postMcpAction,
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
 * sessions apply it at their next message. The Code mode choice is written
 * through `PUT /api/tools/settings`. An untrusted project's notice offers
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
  // A later load (Refresh, or the panel's project changing) wins over an earlier one still on its way.
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);
  const actionControllerRef = useRef<AbortController | null>(null);
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

  useEffect(() => () => {
    saveControllerRef.current?.abort();
    saveControllerRef.current = null;
    actionControllerRef.current?.abort();
    actionControllerRef.current = null;
  }, []);

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
  onSelect,
  onRefresh,
  onCodemodeChange,
  onServerSwitch = () => {},
  onGroupSwitch = () => {},
  onRemove = () => {},
  onUndo = () => {},
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
  onSelect: (key: string) => void;
  onRefresh: () => void;
  onCodemodeChange: (preference: McpCodemodePreference) => void;
  onServerSwitch?: (server: McpServerInfo, enabled: boolean) => void;
  onGroupSwitch?: (scope: McpScope, servers: McpServerInfo[], enabled: boolean) => void;
  onRemove?: (server: McpServerInfo) => void;
  onUndo?: () => void;
  onTrustProject?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const unavailableNoticeId = useId();
  const trustNoticeId = useId();
  const data = load.state === "loaded" ? load.data : undefined;
  const groups = data ? mcpServerGroups(data, Boolean(cwd)) : [];
  const context = data ? mcpRowContext(data) : undefined;
  const servers = groups.flatMap((group) => group.servers);
  const selectedServer = servers.find((server) => mcpServerKey(server) === selected);
  const unavailable = data ? mcpUnavailableNotice(data.mcp) : undefined;
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
                onSwitch={onServerSwitch}
                onRemove={onRemove}
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
            aria-label={t("mcp.rowLabel", { name, state: t(MCP_ROW_STATE_LABEL_KEYS[state]) })}
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
  // Said by the PI_WEB_PASSWORD line, which every state shows.
  if (state === "web-password") return null;
  const key = {
    disabled: "mcp.server.disabled",
    "not-trusted": "mcp.stateDetail.not-trusted",
    replaced: "mcp.server.shadowedByProject",
    "mcp-off": "mcp.stateDetail.mcp-off",
    on: "mcp.stateDetail.on",
  }[state];
  return <span className="mcp-config-line">{t(key)}</span>;
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
  onSwitch,
  onRemove,
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
  onSwitch: (server: McpServerInfo, enabled: boolean) => void;
  onRemove: (server: McpServerInfo) => void;
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
            <span className={`mcp-config-state is-${tone}`}>{t(MCP_ROW_STATE_LABEL_KEYS[state])}</span>
            <McpStateDetail server={server} state={state} />
            {server.webPasswordField && (
              <span className="mcp-config-line is-warning">
                {t("mcp.server.webPassword")} <McpFieldChips fields={[server.webPasswordField]} />
              </span>
            )}
          </span>
        </ConfigDetailGridRow>
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
