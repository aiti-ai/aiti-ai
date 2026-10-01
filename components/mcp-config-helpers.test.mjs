import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  MCP_CODEMODE_PROJECT_OVERRIDE_KEYS,
  MCP_CODEMODE_SAVE_TIMEOUT_MS,
  MCP_CODEMODE_SELECTION,
  MCP_CODEMODE_STATE_KEYS,
  MCP_EXPOSURE_KEYS,
  MCP_OVERVIEW_TIMEOUT_MS,
  MCP_ROW_STATE_BADGE_KEYS,
  MCP_ROW_STATE_LABEL_KEYS,
  MCP_SERVER_ROW_STATES,
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
  mcpEffectiveCodemodePreference,
  mcpEmptyDetailKey,
  mcpFileProblems,
  mcpGroupCounts,
  mcpGroupEmptyKey,
  mcpOverviewUrl,
  mcpProjectServersLoad,
  mcpProjectTrustable,
  mcpRowContext,
  mcpRowStateTone,
  mcpServerGroups,
  mcpServerKey,
  mcpServerRowState,
  mcpStatusDot,
  mcpTrustNotice,
  mcpUnavailableNotice,
  pickMcpSelection,
  saveMcpCodemodePreference,
  withMcpCodemodePreference,
} = await jiti.import("./mcp-config-helpers.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");

const messages = enLocale.messages;

function server(overrides = {}) {
  return {
    name: "github",
    scope: "global",
    sourcePath: "/home/u/.pi/agent/mcp.json",
    configKey: "key",
    enabled: true,
    validated: true,
    transport: "http",
    url: "https://example.com/mcp",
    envNames: [],
    headerNames: [],
    usesOAuth: true,
    commandFields: [],
    variableReferences: [],
    masked: false,
    ...overrides,
  };
}

function file(scope, overrides = {}) {
  return {
    scope,
    path: scope === "global" ? "/home/u/.pi/agent/mcp.json" : "/repo/.pi/mcp.json",
    exists: true,
    problems: [],
    ...overrides,
  };
}

const on = { mcpAvailable: true, projectServersLoad: true };

test("a row's state follows the file, the most important reason first", () => {
  assert.equal(mcpServerRowState(server(), on), "on");
  // pi refuses the entry: nothing else about it matters.
  assert.equal(mcpServerRowState(server({ invalidError: "bad", enabled: false, webPasswordField: { kind: "header", name: "X" } }), on), "invalid");
  // Pi Web refuses it even while turned off, since turning it on would be refused too.
  assert.equal(mcpServerRowState(server({ enabled: false, webPasswordField: { kind: "header", name: "X" } }), on), "web-password");
  assert.equal(mcpServerRowState(server({ enabled: false }), { mcpAvailable: false, projectServersLoad: false }), "disabled");
  // A project entry connects only where the project's file is read.
  const project = server({ scope: "project", sourcePath: "/repo/.pi/mcp.json" });
  assert.equal(mcpServerRowState(project, { mcpAvailable: true, projectServersLoad: false }), "not-trusted");
  assert.equal(mcpServerRowState(project, { mcpAvailable: false, projectServersLoad: false }), "not-trusted");
  assert.equal(mcpServerRowState(project, on), "on");
  // A global entry the project's entry replaces is replaced only while the project is read.
  const shadowed = server({ shadowedByProject: true });
  assert.equal(mcpServerRowState(shadowed, on), "replaced");
  assert.equal(mcpServerRowState(shadowed, { mcpAvailable: true, projectServersLoad: false }), "on");
  assert.equal(mcpServerRowState(server(), { mcpAvailable: false, projectServersLoad: true }), "mcp-off");
  assert.deepEqual([...MCP_SERVER_ROW_STATES].sort(), Object.keys(MCP_ROW_STATE_LABEL_KEYS).sort());
});

test("project servers load only under a trust decision, as the MCP host reads it", () => {
  const cwd = "/repo";
  assert.equal(mcpProjectServersLoad(undefined), false);
  assert.equal(mcpProjectServersLoad({ cwd, trustError: "locked" }), false);
  assert.equal(mcpProjectServersLoad({ cwd, trust: { requiresTrust: true, trusted: true, decision: true, decisionPath: cwd, inherited: false } }), true);
  assert.equal(mcpProjectServersLoad({ cwd, trust: { requiresTrust: true, trusted: true, decision: true, decisionPath: "/", inherited: true } }), true);
  assert.equal(mcpProjectServersLoad({ cwd, trust: { requiresTrust: true, trusted: false, decision: false, decisionPath: cwd, inherited: false } }), false);
  assert.equal(mcpProjectServersLoad({ cwd, trust: { requiresTrust: true, trusted: false, decision: null, inherited: false } }), false);
  // `trusted` is true for a fresh folder, but a file that appeared there is not read without a decision.
  assert.equal(mcpProjectServersLoad({ cwd, trust: { requiresTrust: false, trusted: true, decision: null, inherited: false } }), false);
  assert.deepEqual(
    mcpRowContext({ mcp: { available: false, reason: "operator-disabled", error: "x" }, project: undefined }),
    { mcpAvailable: false, projectServersLoad: false },
  );
});

test("each state has a color, a full label and, when it is not plain on, visible short text", () => {
  assert.equal(mcpRowStateTone("on"), "on");
  assert.equal(mcpRowStateTone("invalid"), "error");
  assert.equal(mcpRowStateTone("web-password"), "error");
  assert.equal(mcpRowStateTone("not-trusted"), "warning");
  for (const state of ["disabled", "replaced", "mcp-off"]) assert.equal(mcpRowStateTone(state), "off", state);
  assert.deepEqual(mcpStatusDot("on"), { active: true });
  assert.deepEqual(mcpStatusDot("off"), { active: false });
  assert.deepEqual(mcpStatusDot("error"), { color: "#ef4444" });
  assert.deepEqual(mcpStatusDot("warning"), { color: "#f59e0b" });
  // Color is never the only sign: every state but on (and MCP off, which the banner says once) has a badge.
  for (const state of MCP_SERVER_ROW_STATES) {
    assert.equal(typeof messages[MCP_ROW_STATE_LABEL_KEYS[state]], "string", state);
    if (state === "on" || state === "mcp-off") assert.equal(MCP_ROW_STATE_BADGE_KEYS[state], undefined, state);
    else assert.equal(typeof messages[MCP_ROW_STATE_BADGE_KEYS[state]], "string", state);
  }
  for (const key of [...Object.values(MCP_EXPOSURE_KEYS), ...Object.values(MCP_CODEMODE_STATE_KEYS)]) {
    assert.equal(typeof messages[key], "string", key);
  }
  assert.deepEqual(Object.keys(MCP_EXPOSURE_KEYS).sort(), ["codemode", "codemode-deferred", "deferred", "direct", "hidden"]);
});

test("the Project group appears only with a project, first, and says why it lists nothing", () => {
  const data = {
    files: [file("global"), file("project")],
    servers: [server({ name: "a" }), server({ name: "b", enabled: false }), server({ name: "c", scope: "project" })],
  };
  const withProject = mcpServerGroups(data, true);
  assert.deepEqual(withProject.map((group) => group.scope), ["project", "global"]);
  assert.deepEqual(withProject[0].servers.map((entry) => entry.name), ["c"]);
  assert.deepEqual(withProject[1].servers.map((entry) => entry.name), ["a", "b"]);
  assert.deepEqual(mcpGroupCounts(withProject[1].servers), { enabled: 1, total: 2 });
  assert.equal(mcpGroupEmptyKey(withProject[1]), undefined);

  const globalOnly = mcpServerGroups({ files: [file("global")], servers: [server()] }, false);
  assert.deepEqual(globalOnly.map((group) => group.scope), ["global"]);

  // A project the route refused has no file: the group stays and says it is not listed.
  const refused = mcpServerGroups({ files: [file("global")], servers: [] }, true);
  assert.equal(refused[0].file, undefined);
  assert.equal(mcpGroupEmptyKey(refused[0]), "mcp.group.notListed");
  assert.equal(mcpGroupEmptyKey(refused[1]), "mcp.group.empty");
  assert.equal(mcpGroupEmptyKey({ scope: "global", file: file("global", { exists: false }), servers: [] }), "mcp.group.empty");
  const unparsable = { reason: "unparsable", error: "Unexpected token" };
  assert.equal(mcpGroupEmptyKey({ scope: "global", file: file("global", { problems: [unparsable] }), servers: [] }), "mcp.group.fileProblem");
  // autoEnableCodemode of the wrong type still loads every server.
  const flag = { reason: "auto-enable-codemode-invalid", error: "x" };
  assert.equal(isBlockingFileProblem(flag), false);
  assert.equal(isBlockingFileProblem(unparsable), true);
  assert.equal(mcpGroupEmptyKey({ scope: "global", file: file("global", { problems: [flag] }), servers: [] }), "mcp.group.empty");
  for (const key of ["mcp.group.notListed", "mcp.group.empty", "mcp.group.fileProblem"]) assert.equal(typeof messages[key], "string");
});

test("the selection survives a reload while its row exists, and otherwise moves to the first server", () => {
  const groups = mcpServerGroups({
    files: [file("global"), file("project")],
    servers: [server({ name: "g" }), server({ name: "p", scope: "project" })],
  }, true);
  assert.equal(mcpServerKey({ scope: "global", name: "g" }), "global\0g");
  assert.equal(pickMcpSelection(groups, "global\0g"), "global\0g");
  assert.equal(pickMcpSelection(groups, MCP_CODEMODE_SELECTION), MCP_CODEMODE_SELECTION);
  assert.equal(pickMcpSelection(groups, "global\0gone"), "project\0p");
  assert.equal(pickMcpSelection(groups, null), "project\0p");
  assert.equal(pickMcpSelection(mcpServerGroups({ files: [file("global")], servers: [] }, false), "global\0gone"), null);
  // A server's key always holds a NUL, so no server can be taken for Code mode.
  assert.ok(!MCP_CODEMODE_SELECTION.includes("\0"));
});

test("MCP being off is said with the route's reason", () => {
  assert.equal(mcpUnavailableNotice({ available: true }), undefined);
  assert.deepEqual(mcpUnavailableNotice({ available: false, reason: "operator-disabled", error: "x" }), { key: "mcp.unavailable.operator-disabled" });
  assert.deepEqual(
    mcpUnavailableNotice({ available: false, reason: "internals-unavailable", error: "x", detail: "moved" }),
    { key: "mcp.unavailable.internals-unavailable" },
  );
  assert.deepEqual(
    mcpUnavailableNotice({ available: false, reason: "builtin-disabled", error: "x", settingsPath: "/repo/.pi/settings.json" }),
    { key: "mcp.unavailable.builtin-disabled", params: { path: "/repo/.pi/settings.json" } },
  );
  assert.deepEqual(mcpUnavailableNotice({ available: false, reason: "builtin-disabled", error: "x" }), { key: "mcp.unavailable.builtin-disabled-unknown" });
});

test("trust is reported only for a project with a .pi/mcp.json, and inherited trust names its folder", () => {
  const cwd = "/repo/app";
  const exists = file("project");
  const status = (overrides) => ({ requiresTrust: true, trusted: false, decision: null, inherited: false, ...overrides });
  assert.equal(mcpTrustNotice(undefined, exists), undefined);
  assert.equal(mcpTrustNotice({ cwd, trust: status() }, undefined), undefined);
  assert.equal(mcpTrustNotice({ cwd, trust: status() }, file("project", { exists: false })), undefined);
  assert.deepEqual(mcpTrustNotice({ cwd, trust: status() }, exists), { kind: "untrusted", key: "mcp.trust.untrusted" });
  // A file the folder holds that needs trust, but cannot be listed, is still worth a word.
  assert.deepEqual(
    mcpTrustNotice({ cwd, trust: status() }, file("project", { problems: [{ reason: "link-outside", error: "x" }] })),
    { kind: "untrusted", key: "mcp.trust.untrusted" },
  );
  // A dangling link, as the route reports it: listed as a file with a problem, while the
  // SDK's existsSync follows the link and finds nothing to trust. Trusting would answer
  // trust-not-required, so no notice; the footer explains the file.
  const dangling = file("project", { problems: [{ reason: "link-dangling", error: "a symbolic link to nothing" }] });
  const fresh = { requiresTrust: false, trusted: true, decision: null, inherited: false };
  assert.equal(mcpTrustNotice({ cwd, trust: fresh }, dangling), undefined);
  assert.equal(mcpTrustNotice({ cwd, trust: { ...fresh, decision: true, decisionPath: "/repo", inherited: true } }, dangling), undefined);
  // A decision that marks the folder untrusted still holds once the link leads somewhere.
  assert.deepEqual(
    mcpTrustNotice({ cwd, trust: { ...fresh, decision: false, decisionPath: cwd } }, dangling),
    { kind: "untrusted", key: "mcp.trust.untrusted" },
  );
  assert.deepEqual(
    mcpTrustNotice({ cwd, trust: status({ decision: false, decisionPath: "/repo", inherited: true }) }, exists),
    { kind: "untrusted", key: "mcp.trust.untrustedThrough", params: { path: "/repo" } },
  );
  assert.deepEqual(mcpTrustNotice({ cwd, trust: status({ decision: false, decisionPath: cwd }) }, exists), { kind: "untrusted", key: "mcp.trust.untrusted" });
  assert.equal(mcpTrustNotice({ cwd, trust: status({ trusted: true, decision: true, decisionPath: cwd }) }, exists), undefined);
  assert.deepEqual(
    mcpTrustNotice({ cwd, trust: status({ trusted: true, decision: true, decisionPath: "/repo", inherited: true }) }, exists),
    { kind: "inherited", key: "mcp.trust.trustedThrough", params: { path: "/repo" } },
  );
  assert.deepEqual(mcpTrustNotice({ cwd, trustError: "locked" }, exists), { kind: "untrusted", key: "mcp.trust.unreadable" });
  for (const key of ["mcp.trust.untrusted", "mcp.trust.untrustedThrough", "mcp.trust.trustedThrough", "mcp.trust.unreadable"]) {
    assert.equal(typeof messages[key], "string", key);
  }
  assert.match(messages["mcp.trust.trustedThrough"], /\{path\}/);
  assert.match(messages["mcp.trust.untrustedThrough"], /\{path\}/);
});

test("Trust is offered only for a folder that requires trust and is not trusted", () => {
  const cwd = "/repo/app";
  const status = (overrides) => ({ requiresTrust: true, trusted: false, decision: null, inherited: false, ...overrides });
  assert.equal(mcpProjectTrustable({ cwd, trust: status() }), true);
  // An ancestor's explicit false: trusting records this folder's own decision, which wins.
  assert.equal(mcpProjectTrustable({ cwd, trust: status({ decision: false, decisionPath: "/repo", inherited: true }) }), true);
  assert.equal(mcpProjectTrustable({ cwd, trust: status({ decision: false, decisionPath: cwd }) }), true);
  assert.equal(mcpProjectTrustable({ cwd, trust: status({ trusted: true, decision: true, decisionPath: cwd }) }), false);
  assert.equal(mcpProjectTrustable({ cwd, trust: status({ trusted: true, decision: true, decisionPath: "/repo", inherited: true }) }), false);
  // Requires no trust (a dangling .pi/mcp.json link), even under an explicit false: POST answers trust-not-required.
  assert.equal(mcpProjectTrustable({ cwd, trust: { requiresTrust: false, trusted: true, decision: false, decisionPath: cwd, inherited: false } }), false);
  // trust.json unreadable: whether the folder needs trust is unknown, and trusting would fail the same way.
  assert.equal(mcpProjectTrustable({ cwd, trustError: "locked" }), false);
  assert.equal(mcpProjectTrustable(undefined), false);
});

test("file problems are listed for the footer, the global file's first", () => {
  const problems = mcpFileProblems([
    file("project", { problems: [{ reason: "link-outside", error: "x" }] }),
    file("global", { problems: [{ reason: "unparsable", error: "y" }, { reason: "auto-enable-codemode-invalid", error: "z" }] }),
  ]);
  assert.deepEqual(problems.map(({ file: info, problem }) => `${info.scope}:${problem.reason}`), [
    "global:unparsable",
    "global:auto-enable-codemode-invalid",
    "project:link-outside",
  ]);
});

test("autoEnableCodemode is merged as the SDK merges it: the project's where read, else the global one's, else true", () => {
  const cwd = "/repo";
  const trustedProject = { cwd, trust: { requiresTrust: true, trusted: true, decision: true, decisionPath: cwd, inherited: false } };
  const untrustedProject = { cwd, trust: { requiresTrust: true, trusted: false, decision: null, inherited: false } };
  assert.deepEqual(mcpEffectiveAutoEnableCodemode({ files: [file("global")] }), { value: true });
  assert.deepEqual(
    mcpEffectiveAutoEnableCodemode({ files: [file("global", { autoEnableCodemode: false })] }),
    { value: false, path: "/home/u/.pi/agent/mcp.json" },
  );
  const both = [file("global", { autoEnableCodemode: false }), file("project", { autoEnableCodemode: true })];
  assert.deepEqual(mcpEffectiveAutoEnableCodemode({ files: both, project: trustedProject }), { value: true, path: "/repo/.pi/mcp.json" });
  // An unread project file sets nothing.
  assert.deepEqual(mcpEffectiveAutoEnableCodemode({ files: both, project: untrustedProject }), { value: false, path: "/home/u/.pi/agent/mcp.json" });
  assert.deepEqual(
    mcpEffectiveAutoEnableCodemode({ files: [file("global"), file("project", { autoEnableCodemode: false })], project: trustedProject }),
    { value: false, path: "/repo/.pi/mcp.json" },
  );
});

test("tools only Code mode scripts call are flagged where no session would reach them", () => {
  const info = (overrides) => ({ sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic", ...overrides });
  const auto = { value: true };
  const off = { value: false, path: "/home/u/.pi/agent/mcp.json" };
  assert.equal(mcpCodemodeReachNotice(info(), auto), undefined);
  assert.equal(mcpCodemodeReachNotice(info({ sandbox: { state: "not-checked" } }), auto), undefined);
  // The host offers them through tool search instead.
  assert.deepEqual(mcpCodemodeReachNotice(info({ sandbox: { state: "unavailable", error: "x" }, builtinDisabled: true }), off), { key: "mcp.exposure.sandboxUnavailable" });
  // No codemode tool exists, and the host keeps their exposure.
  assert.deepEqual(mcpCodemodeReachNotice(info({ builtinDisabled: true, preference: "always" }), auto), { key: "mcp.exposure.builtinDisabled" });
  // Automatic never turns Code mode on with autoEnableCodemode false; Always on does not need it.
  assert.deepEqual(mcpCodemodeReachNotice(info(), off), { key: "mcp.exposure.autoEnableOff", params: { path: off.path } });
  assert.deepEqual(mcpCodemodeReachNotice(info({ preference: undefined, preferenceError: "bad" }), off), { key: "mcp.exposure.autoEnableOff", params: { path: off.path } });
  assert.equal(mcpCodemodeReachNotice(info({ preference: "always" }), off), undefined);

  assert.deepEqual(mcpCodemodeAutomaticNotice(info(), off), { key: "mcp.codemode.autoEnableOff", params: { path: off.path } });
  assert.equal(mcpCodemodeAutomaticNotice(info(), auto), undefined);
  assert.equal(mcpCodemodeAutomaticNotice(info({ preference: "always" }), off), undefined);
  for (const key of ["mcp.exposure.sandboxUnavailable", "mcp.exposure.builtinDisabled", "mcp.exposure.autoEnableOff", "mcp.codemode.autoEnableOff"]) {
    assert.equal(typeof messages[key], "string", key);
  }
  assert.match(messages["mcp.exposure.autoEnableOff"], /\{path\}/);
  assert.match(messages["mcp.codemode.autoEnableOff"], /\{path\}/);
});

test("a project whose own defaultTools decides Code mode is what its sessions get, and says so", () => {
  const info = (overrides) => ({ sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic", ...overrides });
  const settingsPath = "/repo/.pi/settings.json";
  const off = { value: false, path: "/repo/.pi/mcp.json" };
  assert.equal(mcpEffectiveCodemodePreference(info()), "automatic");
  assert.equal(mcpEffectiveCodemodePreference(info({ preference: undefined, preferenceError: "bad" })), undefined);
  assert.equal(mcpCodemodeProjectOverrideNotice(info()), undefined);

  // The project starts its sessions with Code mode on: Automatic's autoEnableCodemode warning no longer applies.
  const projectOn = info({ projectOverride: { settingsPath, preference: "always" } });
  assert.equal(mcpEffectiveCodemodePreference(projectOn), "always");
  assert.equal(mcpCodemodeReachNotice(projectOn, off), undefined);
  assert.equal(mcpCodemodeAutomaticNotice(projectOn, off), undefined);
  assert.deepEqual(mcpCodemodeProjectOverrideNotice(projectOn), {
    key: "mcp.codemode.projectOverride.always",
    params: { path: settingsPath },
  });

  // It starts them without Code mode (-codemode, or a plain list without it) although Always on is chosen.
  const projectOff = info({ preference: "always", projectOverride: { settingsPath, preference: "automatic" } });
  assert.equal(mcpEffectiveCodemodePreference(projectOff), "automatic");
  assert.deepEqual(mcpCodemodeReachNotice(projectOff, off), { key: "mcp.exposure.autoEnableOff", params: { path: off.path } });
  assert.deepEqual(mcpCodemodeAutomaticNotice(projectOff, off), { key: "mcp.codemode.autoEnableOff", params: { path: off.path } });
  assert.deepEqual(mcpCodemodeProjectOverrideNotice(projectOff), {
    key: "mcp.codemode.projectOverride.automatic",
    params: { path: settingsPath },
  });
  // Said even when it agrees with the global choice: changing that choice still changes nothing there.
  assert.ok(mcpCodemodeProjectOverrideNotice(info({ preference: "always", projectOverride: { settingsPath, preference: "always" } })));

  for (const key of Object.values(MCP_CODEMODE_PROJECT_OVERRIDE_KEYS)) assert.match(messages[key], /\{path\}/, key);
});

test("Always on is unavailable while no session could offer Code mode, and says why", () => {
  const info = (overrides) => ({ sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic", ...overrides });
  const globalPath = "/home/u/.pi/agent/settings.json";
  assert.equal(mcpCodemodeAlwaysUnavailableNotice(info()), undefined);
  // Nobody has run the self-test yet: Always on stays available, and the Sandbox line says it is unchecked.
  assert.equal(mcpCodemodeAlwaysUnavailableNotice(info({ sandbox: { state: "not-checked" } })), undefined);
  // The sandbox first: nothing in Settings fixes it.
  assert.deepEqual(
    mcpCodemodeAlwaysUnavailableNotice(info({
      sandbox: { state: "unavailable", error: "x" },
      builtinDisabled: true,
      builtinSettingsPath: globalPath,
      globalBuiltinSettingsPath: globalPath,
    })),
    { key: "mcp.codemode.alwaysUnavailable.sandbox" },
  );
  assert.deepEqual(
    mcpCodemodeAlwaysUnavailableNotice(info({ builtinDisabled: true, builtinSettingsPath: globalPath, globalBuiltinSettingsPath: globalPath })),
    { key: "mcp.codemode.alwaysUnavailable.builtin", params: { path: globalPath } },
  );
  for (const key of ["sandbox", "builtin"]) {
    assert.equal(typeof messages[`mcp.codemode.alwaysUnavailable.${key}`], "string", key);
  }
  assert.match(messages["mcp.codemode.alwaysUnavailable.builtin"], /\{path\}/);
});

test("Always on is weighed against the global extensions alone, never the project Settings was opened from", () => {
  const info = (overrides) => ({ sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic", ...overrides });
  const globalPath = "/home/u/.pi/agent/settings.json";
  const projectPath = "/work/app/.pi/settings.json";
  // Only the trusted project turns Code mode off: its sessions lose it, Always on still works everywhere else.
  const projectOnly = info({ builtinDisabled: true, builtinSettingsPath: projectPath });
  assert.equal(mcpCodemodeAlwaysUnavailableNotice(projectOnly), undefined);
  assert.deepEqual(mcpCodemodeBuiltinNotice(projectOnly), { key: "mcp.codemode.builtinDisabledProject", params: { path: projectPath } });
  // This project's sessions still cannot offer it, so the row and the Tools line say so.
  assert.equal(mcpCodemodeRowState(projectOnly), "unavailable");
  assert.deepEqual(mcpCodemodeReachNotice(projectOnly, { value: true }), { key: "mcp.exposure.builtinDisabled" });
  // The global settings turn it off and the project turns it back on: Always on is still unavailable,
  // as it is from every other folder, and this project's sessions have nothing to report.
  const reEnabled = info({ globalBuiltinSettingsPath: globalPath });
  assert.deepEqual(mcpCodemodeAlwaysUnavailableNotice(reEnabled), { key: "mcp.codemode.alwaysUnavailable.builtin", params: { path: globalPath } });
  assert.equal(mcpCodemodeBuiltinNotice(reEnabled), undefined);
  // Both off: the line names the file that decides for these sessions.
  assert.deepEqual(
    mcpCodemodeBuiltinNotice(info({ builtinDisabled: true, builtinSettingsPath: projectPath, globalBuiltinSettingsPath: globalPath })),
    { key: "mcp.codemode.builtinDisabled", params: { path: projectPath } },
  );
  assert.deepEqual(
    mcpCodemodeBuiltinNotice(info({ builtinDisabled: true, builtinSettingsPath: globalPath, globalBuiltinSettingsPath: globalPath })),
    { key: "mcp.codemode.builtinDisabled", params: { path: globalPath } },
  );
  assert.deepEqual(mcpCodemodeBuiltinNotice(info({ builtinDisabled: true })), { key: "mcp.codemode.builtinDisabledUnknown" });
  assert.equal(mcpCodemodeBuiltinNotice(info()), undefined);
  for (const key of ["mcp.codemode.builtinDisabled", "mcp.codemode.builtinDisabledProject"]) {
    assert.match(messages[key], /\{path\}/, key);
  }
  assert.equal(typeof messages["mcp.codemode.builtinDisabledUnknown"], "string");
});

test("with nothing selected, the detail pane tells an empty listing from one a file problem hides", () => {
  assert.equal(mcpEmptyDetailKey(2, [file("global")]), "mcp.selectItem");
  assert.equal(mcpEmptyDetailKey(0, [file("global"), file("project", { exists: false })]), "mcp.empty");
  assert.equal(mcpEmptyDetailKey(0, [file("global", { problems: [{ reason: "auto-enable-codemode-invalid", error: "x" }] })]), "mcp.empty");
  assert.equal(mcpEmptyDetailKey(0, [file("global"), file("project", { problems: [{ reason: "too-large", error: "x" }] })]), "mcp.emptyFileProblem");
  // Servers listed from the other file still make it a choice.
  assert.equal(mcpEmptyDetailKey(1, [file("global", { problems: [{ reason: "unparsable", error: "x" }] })]), "mcp.selectItem");
  for (const key of ["mcp.selectItem", "mcp.empty", "mcp.emptyFileProblem"]) assert.equal(typeof messages[key], "string", key);
});

test("the Code mode row says whether a session can offer it, and the preference otherwise", () => {
  const info = (overrides) => ({ sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic", ...overrides });
  assert.equal(mcpCodemodeRowState(info()), "automatic");
  assert.equal(mcpCodemodeRowState(info({ preference: "always", sandbox: { state: "not-checked" } })), "always");
  assert.equal(mcpCodemodeRowState(info({ sandbox: { state: "unavailable", error: "no wasm" } })), "unavailable");
  assert.equal(mcpCodemodeRowState(info({ builtinDisabled: true })), "unavailable");
  assert.equal(mcpCodemodeRowState(info({ preference: undefined, preferenceError: "bad json" })), "unknown");
  assert.equal(mcpCodemodeTone("unavailable"), "error");
  assert.equal(mcpCodemodeTone("unknown"), "off");
  assert.equal(mcpCodemodeTone("always"), "on");
});

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return next.body;
      },
    };
  };
  return { calls, fetchImpl };
}

const overview = {
  mcp: { available: true },
  codemode: { sandbox: { state: "not-checked" }, builtinDisabled: false, preference: "automatic" },
  files: [file("global")],
  servers: [],
};

test("the overview is loaded for the panel's project, or for the global file alone", async () => {
  assert.equal(mcpOverviewUrl(null), "/api/mcp");
  assert.equal(mcpOverviewUrl("/a b/c&d"), "/api/mcp?cwd=%2Fa%20b%2Fc%26d");

  const global = fakeFetch([{ status: 200, body: overview }]);
  assert.deepEqual(await loadMcpOverview(null, global.fetchImpl), { ok: true, data: overview });
  assert.equal(global.calls.length, 1);
  assert.equal(global.calls[0].input, "/api/mcp");
  // Always read fresh: the files change outside the page.
  assert.equal(global.calls[0].init.cache, "no-store");
  assert.equal(global.calls[0].init.method, undefined);

  const project = fakeFetch([{ status: 200, body: { ...overview, project: { cwd: "/repo" } } }]);
  const loaded = await loadMcpOverview("/repo", project.fetchImpl);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.projectError, undefined);
  assert.deepEqual(project.calls.map((call) => call.input), ["/api/mcp?cwd=%2Frepo"]);
});

test("a project folder the route refuses still leaves the global servers listed", async () => {
  for (const [status, reason] of [[403, "cwd-denied"], [400, "cwd-not-directory"], [400, "cwd-invalid"]]) {
    const { calls, fetchImpl } = fakeFetch([
      { status, body: { error: "Access denied", reason } },
      { status: 200, body: overview },
    ]);
    const result = await loadMcpOverview("/gone", fetchImpl);
    assert.deepEqual(result, { ok: true, data: overview, projectError: { error: "Access denied", reason } }, reason);
    assert.deepEqual(calls.map((call) => call.input), ["/api/mcp?cwd=%2Fgone", "/api/mcp"]);
  }
  // Without a project there is nothing to fall back from.
  const noProject = fakeFetch([{ status: 403, body: { error: "Access denied", reason: "cwd-denied" } }]);
  assert.deepEqual(await loadMcpOverview(null, noProject.fetchImpl), { ok: false, error: { error: "Access denied", reason: "cwd-denied" } });
  // When the global listing fails too, that failure is what the panel shows.
  const both = fakeFetch([
    { status: 403, body: { error: "Access denied", reason: "cwd-denied" } },
    { status: 500, body: { error: "boom", reason: "internal" } },
  ]);
  assert.deepEqual(await loadMcpOverview("/gone", both.fetchImpl), { ok: false, error: { error: "boom", reason: "internal" } });
});

test("other failures keep their reason, or their diagnostic when there is none", async () => {
  const internal = fakeFetch([{ status: 500, body: { error: "EACCES", reason: "internal" } }]);
  assert.deepEqual(await loadMcpOverview("/repo", internal.fetchImpl), { ok: false, error: { error: "EACCES", reason: "internal" } });
  assert.equal(internal.calls.length, 1);
  const network = fakeFetch([new TypeError("Failed to fetch")]);
  assert.deepEqual(await loadMcpOverview(null, network.fetchImpl), { ok: false, error: { error: "Failed to fetch" } });
  const html = fakeFetch([{ status: 502 }]);
  assert.deepEqual(await loadMcpOverview(null, html.fetchImpl), { ok: false, error: { error: "HTTP 502" } });
  // A 200 that is not an overview is not shown as one.
  const odd = fakeFetch([{ status: 200, body: { servers: [] } }]);
  assert.deepEqual(await loadMcpOverview(null, odd.fetchImpl), { ok: false, error: { error: "HTTP 200" } });
});

test("the caller's signal reaches the request, and a load that never answers ends at the deadline", async () => {
  assert.equal(MCP_OVERVIEW_TIMEOUT_MS, 15_000);
  // Aborting the caller's signal aborts the request on its way.
  const caller = new AbortController();
  const seen = [];
  const pending = loadMcpOverview(null, (input, init) => {
    seen.push(init.signal);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  }, caller.signal);
  caller.abort();
  const aborted = await pending;
  assert.equal(seen[0].aborted, true);
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.timedOut, undefined);
  // An already aborted signal is honored too.
  const early = new AbortController();
  early.abort();
  const earlySeen = [];
  await loadMcpOverview(null, async (input, init) => {
    earlySeen.push(init.signal.aborted);
    throw new DOMException("aborted", "AbortError");
  }, early.signal);
  assert.deepEqual(earlySeen, [true]);

  // A request that ignores its signal still ends: the deadline settles the load, and aborts the request.
  const hung = [];
  const started = Date.now();
  const timedOut = await loadMcpOverview("/repo", (input, init) => {
    hung.push(init.signal);
    return new Promise(() => {});
  }, undefined, 30);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.timedOut, true);
  assert.equal(hung[0].aborted, true);
  assert.equal(typeof messages["mcp.loadTimedOut"], "string");

  // The deadline covers the global listing loaded after a refused project folder too.
  let calls = 0;
  const second = await loadMcpOverview("/gone", async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 403, json: async () => ({ error: "Access denied", reason: "cwd-denied" }) };
    return new Promise(() => {});
  }, undefined, 30);
  assert.equal(calls, 2);
  assert.equal(second.ok, false);
  assert.equal(second.error.timedOut, true);
});

test("the Code mode choice is saved through the tools settings route and answers with what it stored", async () => {
  assert.equal(MCP_CODEMODE_SAVE_TIMEOUT_MS, 15_000);
  const saved = fakeFetch([{ status: 200, body: { isWindows: false, powerShellEnabled: false, codemode: "always" } }]);
  assert.deepEqual(await saveMcpCodemodePreference("always", saved.fetchImpl), { ok: true, preference: "always" });
  assert.equal(saved.calls.length, 1);
  assert.equal(saved.calls[0].input, "/api/tools/settings");
  assert.equal(saved.calls[0].init.method, "PUT");
  assert.deepEqual(saved.calls[0].init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(saved.calls[0].init.body), { codemode: "always" });

  // What the route read back after writing is what the switch shows.
  const stored = fakeFetch([{ status: 200, body: { isWindows: true, powerShellEnabled: true, codemode: "automatic" } }]);
  assert.deepEqual(await saveMcpCodemodePreference("always", stored.fetchImpl), { ok: true, preference: "automatic" });

  // Refusals keep their reason; failures without one keep their diagnostic.
  const refused = fakeFetch([{ status: 403, body: { error: "Untrusted API request", reason: "request-denied" } }]);
  assert.deepEqual(await saveMcpCodemodePreference("always", refused.fetchImpl), {
    ok: false,
    error: { error: "Untrusted API request", reason: "request-denied" },
  });
  const unparsable = fakeFetch([{ status: 500, body: { error: "Unexpected token n in JSON", reason: "internal" } }]);
  assert.deepEqual(await saveMcpCodemodePreference("automatic", unparsable.fetchImpl), {
    ok: false,
    error: { error: "Unexpected token n in JSON", reason: "internal" },
  });
  const network = fakeFetch([new TypeError("Failed to fetch")]);
  assert.deepEqual(await saveMcpCodemodePreference("always", network.fetchImpl), { ok: false, error: { error: "Failed to fetch" } });
  const html = fakeFetch([{ status: 502 }]);
  assert.deepEqual(await saveMcpCodemodePreference("always", html.fetchImpl), { ok: false, error: { error: "HTTP 502" } });
  // A 200 without a preference is not taken for a save.
  const odd = fakeFetch([{ status: 200, body: { codemode: "never" } }]);
  assert.deepEqual(await saveMcpCodemodePreference("always", odd.fetchImpl), { ok: false, error: { error: "HTTP 200" } });
});

test("a save that never answers ends at the deadline, and the caller's signal reaches it", async () => {
  const hung = [];
  const started = Date.now();
  const timedOut = await saveMcpCodemodePreference("always", (input, init) => {
    hung.push(init.signal);
    return new Promise(() => {});
  }, undefined, 30);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.timedOut, true);
  assert.equal(hung[0].aborted, true);

  const caller = new AbortController();
  const seen = [];
  const pending = saveMcpCodemodePreference("automatic", (input, init) => {
    seen.push(init.signal);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  }, caller.signal);
  caller.abort();
  const aborted = await pending;
  assert.equal(seen[0].aborted, true);
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.timedOut, undefined);
  for (const key of ["mcp.codemode.saveFailed", "mcp.codemode.saveTimedOut"]) assert.equal(typeof messages[key], "string", key);
});

test("a saved choice replaces the preference and its read error in the loaded overview", () => {
  const data = { ...overview, codemode: { sandbox: { state: "available" }, builtinDisabled: false, preferenceError: "Unexpected token" } };
  const next = withMcpCodemodePreference(data, "always");
  assert.deepEqual(next.codemode, { sandbox: { state: "available" }, builtinDisabled: false, preference: "always" });
  assert.equal(next.servers, data.servers);
  assert.equal(data.codemode.preferenceError, "Unexpected token", "the loaded overview is not changed in place");
});
