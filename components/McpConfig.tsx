"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { McpCodemodeInfo, McpConfigFieldRef, McpResponse, McpScope, McpServerInfo } from "@/lib/api-types";
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
import {
  ConfigButton,
  ConfigDetail,
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
  ConfigScopeTag,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigTrustNotice,
} from "./SettingsUi";
import {
  MCP_CODEMODE_SELECTION,
  MCP_CODEMODE_STATE_KEYS,
  MCP_EXPOSURE_KEYS,
  MCP_ROW_STATE_BADGE_KEYS,
  MCP_ROW_STATE_LABEL_KEYS,
  isBlockingFileProblem,
  loadMcpOverview,
  mcpCodemodeAutomaticNotice,
  mcpCodemodeReachNotice,
  mcpCodemodeRowState,
  mcpCodemodeTone,
  mcpEffectiveAutoEnableCodemode,
  mcpEmptyDetailKey,
  mcpFileProblems,
  mcpGroupCounts,
  mcpGroupEmptyKey,
  mcpRowContext,
  mcpRowStateTone,
  mcpServerGroups,
  mcpServerKey,
  mcpServerRowState,
  mcpStatusDot,
  mcpTrustNotice,
  mcpUnavailableNotice,
  pickMcpSelection,
  type McpAutoEnableCodemode,
  type McpLoadFailure,
  type McpNoticeText,
  type McpRowContext,
  type McpServerGroup,
} from "./mcp-config-helpers";

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

/**
 * Settings › MCP: the servers of the global `mcp.json` and, with a project,
 * its `.pi/mcp.json`, listed read-only from `GET /api/mcp`, which reads the
 * files and nothing else: no server is started or contacted to show this.
 * Works without a project; the Project group appears only with one.
 */
export function McpConfig({
  cwd,
  onClose,
  embedded = false,
}: {
  cwd: string | null;
  onClose: () => void;
  embedded?: boolean;
}) {
  const [load, setLoad] = useState<McpConfigLoad>({ state: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => getLastSettingsSelection("mcp", cwd));
  // A later load (Refresh, or the panel's project changing) wins over an earlier one still on its way.
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

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

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [refresh]);

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
      onSelect={setSelected}
      onRefresh={() => void refresh()}
      onClose={onClose}
    />
  );
}

/** The panel for a load in any state, without the fetch; exported for tests. */
export function McpConfigView({
  cwd,
  load,
  selected,
  refreshing,
  embedded,
  onSelect,
  onRefresh,
  onClose,
}: {
  cwd: string | null;
  load: McpConfigLoad;
  selected: string | null;
  refreshing: boolean;
  embedded: boolean;
  onSelect: (key: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const data = load.state === "loaded" ? load.data : undefined;
  const groups = data ? mcpServerGroups(data, Boolean(cwd)) : [];
  const context = data ? mcpRowContext(data) : undefined;
  const servers = groups.flatMap((group) => group.servers);
  const selectedServer = servers.find((server) => mcpServerKey(server) === selected);
  const unavailable = data ? mcpUnavailableNotice(data.mcp) : undefined;
  const projectFile = data?.files.find((file) => file.scope === "project");
  const trustNotice = data ? mcpTrustNotice(data.project, projectFile) : undefined;
  const problems = data ? mcpFileProblems(data.files) : [];
  const counts = mcpGroupCounts(servers);
  const globalFile = data?.files.find((file) => file.scope === "global");
  const autoEnable = data ? mcpEffectiveAutoEnableCodemode(data) : undefined;
  const emptyKey = data ? mcpEmptyDetailKey(servers.length, data.files) : undefined;

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("settings.mcp")}
      subtitle={cwd ? shortenPath(cwd) : undefined}
      closeLabel={t("i18n.close")}
      onClose={onClose}
    >
      {unavailable && (
        <ConfigNotice>
          {noticeText(unavailable, t)}
          {data && !data.mcp.available && data.mcp.detail && (
            <> <code className="mcp-config-chip">{revealHiddenCharacters(data.mcp.detail)}</code></>
          )}
        </ConfigNotice>
      )}
      {load.state === "loaded" && load.projectError && (
        <ConfigNotice>{t("mcp.projectNotListed", { reason: failureText(load.projectError, t) })}</ConfigNotice>
      )}
      {trustNotice?.kind === "untrusted" && <ConfigTrustNotice message={noticeText(trustNotice, t)} />}
      {trustNotice?.kind === "inherited" && <ConfigNotice>{noticeText(trustNotice, t)}</ConfigNotice>}

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
                  <McpCodemodeRow codemode={data.codemode} active={selected === MCP_CODEMODE_SELECTION} onSelect={onSelect} />
                </div>
                {groups.map((group) => (
                  <McpServerGroupList
                    key={group.scope}
                    group={group}
                    context={context}
                    selected={selected}
                    onSelect={onSelect}
                  />
                ))}
              </>
            ) : null}
          </ConfigSidebarList>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
            {!data || !context || !autoEnable || !emptyKey ? null : selected === MCP_CODEMODE_SELECTION ? (
              <McpCodemodeDetail codemode={data.codemode} autoEnable={autoEnable} />
            ) : selectedServer ? (
              <McpServerDetail
                key={mcpServerKey(selectedServer)}
                server={selectedServer}
                context={context}
                codemode={data.codemode}
                autoEnable={autoEnable}
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
        <ConfigButton variant="secondary" onClick={onRefresh} disabled={refreshing}>
          {t("i18n.refresh")}
        </ConfigButton>
      </ConfigFooter>
    </ConfigPanelShell>
  );
}

function McpCodemodeRow({
  codemode,
  active,
  onSelect,
}: {
  codemode: McpCodemodeInfo;
  active: boolean;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();
  const state = mcpCodemodeRowState(codemode);
  const stateText = t(MCP_CODEMODE_STATE_KEYS[state]);
  return (
    <ConfigSidebarItem
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

function McpServerGroupList({
  group,
  context,
  selected,
  onSelect,
}: {
  group: McpServerGroup;
  context: McpRowContext;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();
  const { enabled, total } = mcpGroupCounts(group.servers);
  const emptyKey = mcpGroupEmptyKey(group);
  return (
    <div className="config-sidebar-group">
      <ConfigSidebarGroupLabel
        aside={total > 0 ? (
          <span className="config-sidebar-group-count">
            <span aria-hidden="true">{enabled}/{total}</span>
            <span className="sr-only">{t("mcp.serverCount", { enabled, total })}</span>
          </span>
        ) : undefined}
      >
        {scopeLabel(group.scope, t)}
      </ConfigSidebarGroupLabel>
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
}: {
  server: McpServerInfo;
  context: McpRowContext;
  codemode: McpCodemodeInfo;
  autoEnable: McpAutoEnableCodemode;
}) {
  const { t } = useI18n();
  const state = mcpServerRowState(server, context);
  const tone = mcpRowStateTone(state);
  const target = mcpServerTarget(server);
  // A refused entry never connects, so nothing in it runs or is sent.
  const connects = server.invalidError === undefined;
  const http = server.transport === "http" || (server.transport === undefined && server.url !== undefined);
  const stdio = !http && (server.transport === "stdio" || server.command !== undefined);
  const viaCodemode = server.exposure === "codemode" || server.exposure === "codemode-deferred";
  const reachNotice = viaCodemode ? mcpCodemodeReachNotice(codemode, autoEnable) : undefined;

  return (
    <ConfigDetailStack>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ConfigScopeTag scope={server.scope}>{scopeLabel(server.scope, t)}</ConfigScopeTag>
          <ConfigDetailTitle>{revealHiddenCharacters(server.name)}</ConfigDetailTitle>
        </ConfigDetailHeaderInfo>
      </ConfigDetailHeader>

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
 * Code mode, read-only for now: the preference, whether its sandbox can run,
 * and whether a setting turns it off or keeps Automatic from turning it on.
 */
function McpCodemodeDetail({ codemode, autoEnable }: { codemode: McpCodemodeInfo; autoEnable: McpAutoEnableCodemode }) {
  const { t } = useI18n();
  const sandbox = codemode.sandbox;
  const automaticNotice = mcpCodemodeAutomaticNotice(codemode, autoEnable);
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
          {codemode.preference ? (
            <span className="mcp-config-lines">
              <span className="mcp-config-state">{t(MCP_CODEMODE_STATE_KEYS[codemode.preference])}</span>
              <span className="mcp-config-line">
                {t(codemode.preference === "always" ? "mcp.codemode.alwaysDescription" : "mcp.codemode.automaticDescription")}
              </span>
              {automaticNotice && <span className="mcp-config-line is-warning">{noticeText(automaticNotice, t)}</span>}
            </span>
          ) : (
            <span className="mcp-config-line is-warning">
              {t("mcp.codemode.preferenceError")}{" "}
              <code className="mcp-config-chip">{revealHiddenCharacters(codemode.preferenceError ?? "")}</code>
            </span>
          )}
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
        {codemode.builtinDisabled && (
          <ConfigDetailGridRow label={t("mcp.codemode.builtin")} tone="error">
            {codemode.builtinSettingsPath
              ? t("mcp.codemode.builtinDisabled", { path: displayPath(codemode.builtinSettingsPath) })
              : t("mcp.codemode.builtinDisabledUnknown")}
          </ConfigDetailGridRow>
        )}
      </ConfigDetailGrid>
    </ConfigDetailStack>
  );
}
