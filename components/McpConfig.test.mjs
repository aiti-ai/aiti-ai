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
const { McpConfig, McpConfigView } = await jiti.import("./McpConfig.tsx");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const source = await readFile(new URL("./McpConfig.tsx", import.meta.url), "utf8");
const helperSource = await readFile(new URL("./mcp-config-helpers.ts", import.meta.url), "utf8");
const displaySource = await readFile(new URL("../lib/mcp-server-display.ts", import.meta.url), "utf8");
const apiTypesSource = await readFile(new URL("../lib/api-types.ts", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");

const h = React.createElement;
const messages = enLocale.messages;

function render(element) {
  return renderToStaticMarkup(h(I18nProvider, null, element));
}

function decode(html) {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** The text of the markup, tags dropped, entities decoded. */
function text(html) {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function server(overrides = {}) {
  return {
    name: "github",
    scope: "global",
    sourcePath: "/Users/me/.pi/agent/mcp.json",
    configKey: "key",
    enabled: true,
    validated: true,
    envNames: [],
    headerNames: [],
    usesOAuth: false,
    commandFields: [],
    variableReferences: [],
    masked: false,
    ...overrides,
  };
}

const globalFile = { scope: "global", path: "/Users/me/.pi/agent/mcp.json", exists: true, problems: [] };
const projectFile = { scope: "project", path: "/Users/me/repo/.pi/mcp.json", exists: true, problems: [] };
const trusted = { requiresTrust: true, trusted: true, decision: true, decisionPath: "/Users/me/repo", inherited: false };
const untrusted = { requiresTrust: true, trusted: false, decision: null, inherited: false };

function overview(overrides = {}) {
  return {
    mcp: { available: true },
    codemode: { sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic" },
    files: [globalFile],
    servers: [],
    ...overrides,
  };
}

const stdioServer = server({
  name: "lint",
  transport: "stdio",
  exposure: "direct",
  command: "npx",
  args: ["-y", "@acme/lint-mcp", "--api-key=••••"],
  cwd: "tools",
  envNames: ["NODE_ENV", "LINT_TOKEN"],
  commandFields: [{ kind: "env", name: "LINT_TOKEN" }],
  masked: true,
});

const httpServer = server({
  name: "github",
  transport: "http",
  exposure: "codemode",
  url: "https://api.example.com/mcp",
  headerNames: ["Authorization"],
  variableReferences: [{ kind: "header", name: "Authorization", variables: ["GITHUB_TOKEN"] }],
});

function view(props = {}) {
  return render(h(McpConfigView, {
    cwd: null,
    load: { state: "loaded", data: overview({ servers: [httpServer, stdioServer] }) },
    selected: null,
    refreshing: false,
    embedded: true,
    onSelect() {},
    onRefresh() {},
    onClose() {},
    ...props,
  }));
}

/** The opening tag of the sidebar row whose accessible name starts with `name`. */
function row(html, name) {
  return decode(html).match(new RegExp(`<button[^>]*aria-label="${name}[^"]*"[^>]*>`))?.[0];
}

test("without a project only the global file is listed, under the Code mode row", () => {
  const html = view();
  const shown = text(html);
  assert.ok(!shown.includes(messages["skills.scope.project"]), "no Project group without a project");
  assert.match(decode(html), /class="config-sidebar-group-label-text">global</);
  // Code mode comes first, so the 190px phone sidebar always shows it.
  const sidebar = decode(html).slice(decode(html).indexOf('class="config-sidebar-list"'));
  assert.ok(sidebar.indexOf("Code mode: Automatic") < sidebar.indexOf("github: On"));
  assert.match(row(html, "Code mode"), /aria-label="Code mode: Automatic"/);
  assert.match(row(html, "github"), /aria-label="github: On"/);
  assert.match(shown, /2 of 2 servers turned on/);
});

test("with a project, its group comes first and every row names its state", () => {
  const data = overview({
    files: [globalFile, projectFile],
    servers: [
      server({ name: "shared", transport: "http", url: "https://a.example/mcp", shadowedByProject: true }),
      server({ name: "off", transport: "http", url: "https://b.example/mcp", enabled: false }),
      server({ name: "shared", scope: "project", sourcePath: projectFile.path, transport: "stdio", command: "node", replacesGlobal: true }),
      server({ name: "legacy", scope: "project", sourcePath: projectFile.path, invalidError: "sse is not supported", url: "https://old/sse" }),
    ],
    project: { cwd: "/Users/me/repo", trust: untrusted },
  });
  const html = view({ cwd: "/Users/me/repo", load: { state: "loaded", data } });
  const markup = decode(html);
  assert.ok(markup.indexOf(">project<") < markup.indexOf(">global<"));
  // n/m counts read as a sentence to a screen reader.
  assert.match(markup, /<span aria-hidden="true">2\/2<\/span><span class="sr-only">2 of 2 servers turned on<\/span>/);
  assert.match(markup, /<span aria-hidden="true">1\/2<\/span><span class="sr-only">1 of 2 servers turned on<\/span>/);
  // The project is not trusted, so its entry does not connect and the global one is not replaced.
  assert.match(row(html, "shared: Project"), /aria-label="shared: Project not trusted"/);
  assert.match(row(html, "shared: On"), /aria-label="shared: On"/);
  assert.match(row(html, "off"), /aria-label="off: Turned off in the file"/);
  assert.match(row(html, "legacy"), /aria-label="legacy: Refused by Pi"/);
  // The state is visible text on the row too, never only the dot's color.
  for (const badge of ["untrusted", "off", "refused"]) {
    assert.match(markup, new RegExp(`class="mcp-sidebar-badge is-[a-z]+">${badge}<`), badge);
  }
  // The untrusted project gets the trust notice, with no button yet.
  assert.match(markup, /<div role="status" class="config-notice">This project is not trusted, so the servers in its \.pi\/mcp\.json do not connect\.<\/div>/);

  const trustedHtml = view({
    cwd: "/Users/me/repo",
    load: { state: "loaded", data: { ...data, project: { cwd: "/Users/me/repo", trust: trusted } } },
  });
  assert.match(row(trustedHtml, "shared: Replaced"), /aria-label="shared: Replaced by the project's server"/);
  assert.ok(!decode(trustedHtml).includes("This project is not trusted"));
});

test("inherited trust names the folder it comes from", () => {
  const data = overview({
    files: [globalFile, projectFile],
    servers: [server({ name: "p", scope: "project", sourcePath: projectFile.path, transport: "stdio", command: "node" })],
    project: { cwd: "/Users/me/repo/app", trust: { ...trusted, decisionPath: "/Users/me/repo", inherited: true } },
  });
  const shown = text(view({ cwd: "/Users/me/repo/app", load: { state: "loaded", data } }));
  assert.match(shown, /Trusted through ~\/repo: the servers in this project's \.pi\/mcp\.json connect, as in every folder under it\./);
  const denied = text(view({
    cwd: "/Users/me/repo/app",
    load: { state: "loaded", data: { ...data, project: { cwd: "/Users/me/repo/app", trust: { ...untrusted, decision: false, decisionPath: "/Users/me/repo", inherited: true } } } },
  }));
  assert.match(denied, /This project is not trusted \(~\/repo is marked untrusted\)/);
});

test("a stdio server's detail shows its masked command line, folder, env names and !command fields", () => {
  const html = view({ selected: "global\0lint" });
  const shown = text(html);
  const markup = decode(html);
  assert.match(markup, /<div class="config-detail-title">lint<\/div>/);
  assert.match(shown, /Transport stdio/);
  assert.match(shown, /Command npx -y @acme\/lint-mcp --api-key=••••/);
  assert.match(shown, /Working directory tools/);
  assert.match(markup, /<code class="mcp-config-chip">NODE_ENV<\/code><code class="mcp-config-chip">LINT_TOKEN<\/code>/);
  assert.match(shown, /Values are not shown here\./);
  assert.match(shown, /Shell commands Runs a shell command on every connection: env LINT_TOKEN/);
  assert.match(shown, /Tools Declared to the model directly/);
  assert.match(shown, /File ~\/\.pi\/agent\/mcp\.json/);
  assert.match(shown, /Parts that look like secrets are hidden\./);
  assert.match(shown, /scope "extension"/);
  // Headers and sign-in belong to HTTP servers.
  assert.doesNotMatch(shown, /Headers|Sign-in/);

  const sessionFolder = text(view({ selected: "global\0lint", load: { state: "loaded", data: overview({ servers: [{ ...stdioServer, cwd: undefined }] }) } }));
  assert.match(sessionFolder, /Working directory The session's folder/);
});

test("an HTTP server's detail shows its URL, header names, the variables it sends and how it signs in", () => {
  const shown = text(view({ selected: "global\0github" }));
  assert.match(shown, /URL https:\/\/api\.example\.com\/mcp/);
  assert.match(shown, /Headers Authorization Values are not shown here\./);
  assert.match(shown, /Host variables Sends environment variables of the computer running Pi Web to this server on every connection: GITHUB_TOKEN in header Authorization/);
  assert.match(shown, /Sign-in Uses its Authorization header instead of OAuth\./);
  assert.match(shown, /Tools Called from Code mode scripts, not declared to the model/);
  assert.doesNotMatch(shown, /Working directory|Environment/);

  const oauth = (signedIn) => text(view({
    selected: "global\0notion",
    load: { state: "loaded", data: overview({ servers: [server({ name: "notion", transport: "http", url: "https://n/mcp", usesOAuth: true, signedIn })] }) },
  }));
  assert.match(oauth(true), /Sign-in Signed in: OAuth tokens are stored in mcp-auth\.json\./);
  assert.match(oauth(false), /Sign-in No OAuth tokens stored\./);
  assert.match(oauth(undefined), /Sign-in Unknown: mcp-auth\.json cannot be read\./);

  // Code mode cannot run here, so its tools go through tool search.
  const sandboxDown = text(view({
    selected: "global\0github",
    load: { state: "loaded", data: overview({ servers: [httpServer], codemode: { sandbox: { state: "unavailable", error: "no wasm" }, builtinDisabled: false, preference: "automatic" } }) },
  }));
  assert.match(sandboxDown, /reached through tool search instead/);

  // -builtin:codemode registers no codemode tool, so only tool search can reach them.
  const builtinOff = text(view({
    selected: "global\0github",
    load: { state: "loaded", data: overview({ servers: [httpServer], codemode: { sandbox: { state: "available" }, builtinDisabled: true, preference: "always" } }) },
  }));
  assert.match(builtinOff, /Tools Called from Code mode scripts, not declared to the model -builtin:codemode turns Code mode off, so these tools can be called only while tool search is active\./);

  // Automatic with autoEnableCodemode false never turns Code mode on for them.
  const autoOff = (preference) => text(view({
    selected: "global\0github",
    load: { state: "loaded", data: overview({
      files: [{ ...globalFile, autoEnableCodemode: false }],
      servers: [httpServer],
      codemode: { sandbox: { state: "available" }, builtinDisabled: false, preference },
    }) },
  }));
  assert.match(autoOff("automatic"), /autoEnableCodemode is false in ~\/\.pi\/agent\/mcp\.json, so sessions do not turn Code mode on for these tools: they can be called only while Code mode is Always on or tool search is active\./);
  assert.doesNotMatch(autoOff("always"), /autoEnableCodemode/);
  // Tools the model is offered directly need no Code mode.
  const direct = text(view({
    selected: "global\0lint",
    load: { state: "loaded", data: overview({ files: [{ ...globalFile, autoEnableCodemode: false }], servers: [stdioServer] }) },
  }));
  assert.doesNotMatch(direct, /autoEnableCodemode/);
});

test("a refused entry shows why, and nothing it would run or send", () => {
  const refused = server({
    name: "bad",
    invalidError: "\"sse\" transport is not supported",
    url: "https://old/sse",
    commandFields: [{ kind: "header", name: "X" }],
    variableReferences: [{ kind: "header", name: "X", variables: ["SECRET"] }],
  });
  const shown = text(view({ selected: "global\0bad", load: { state: "loaded", data: overview({ servers: [refused] }) } }));
  assert.match(shown, /Status Refused by Pi Pi refuses this entry, so it never connects: "sse" transport is not supported/);
  assert.doesNotMatch(shown, /Shell commands|Host variables|Sign-in/);

  const password = text(view({
    selected: "global\0pw",
    load: { state: "loaded", data: overview({ servers: [server({ name: "pw", transport: "http", url: "https://x/mcp", webPasswordField: { kind: "header", name: "Authorization" } })] }) },
  }));
  assert.match(password, /Status Refused: references PI_WEB_PASSWORD References PI_WEB_PASSWORD\. Pi Web refuses to connect it/);
});

test("repository text is shown with its hidden characters escaped", () => {
  const sneaky = server({ name: "safe\u202Ejs.revres", scope: "project", sourcePath: projectFile.path, transport: "stdio", command: "node", args: ["a\nb"], envNames: ["A\u200BB"] });
  const html = view({
    cwd: "/Users/me/repo",
    selected: "project\0safe\u202Ejs.revres",
    load: { state: "loaded", data: overview({ files: [globalFile, projectFile], servers: [sneaky], project: { cwd: "/Users/me/repo", trust: trusted } }) },
  });
  assert.ok(!/[\n\u202E\u200B]/.test(html), "no raw newline, override or zero-width space reaches the markup");
  assert.match(decode(html), /"a\\u\{000A\}b"/);
  assert.match(decode(html), /safe\\u\{202E\}js\.revres/);
  assert.match(text(html), /Holds invisible or control characters/);
});

test("MCP being off, a refused project folder, and file problems are said above and below the list", () => {
  const off = text(view({ load: { state: "loaded", data: overview({ mcp: { available: false, reason: "operator-disabled", error: "x" } }) } }));
  assert.match(off, /MCP is off: PI_WEB_DISABLE_MCP is set where Pi Web runs\./);
  const internals = text(view({ load: { state: "loaded", data: overview({ mcp: { available: false, reason: "internals-unavailable", error: "x", detail: "cannot find module" } }) } }));
  assert.match(internals, /cannot load the SDK's MCP modules\. .* cannot find module/);
  const builtin = text(view({ load: { state: "loaded", data: overview({ mcp: { available: false, reason: "builtin-disabled", error: "x", settingsPath: "/Users/me/.pi/agent/settings.json" } }) } }));
  assert.match(builtin, /the extensions setting in ~\/\.pi\/agent\/settings\.json turns off builtin:mcp/);

  const projectError = view({
    cwd: "/Users/me/gone",
    load: { state: "loaded", data: overview(), projectError: { error: "cwd must be a directory", reason: "cwd-not-directory" } },
  });
  assert.match(text(projectError), /This project's servers are not listed: The project folder no longer exists or is not a folder\./);
  assert.match(decode(projectError), /class="mcp-sidebar-group-empty">Not listed</);

  const broken = view({
    load: {
      state: "loaded",
      data: overview({ files: [{ ...globalFile, problems: [{ reason: "unparsable", error: "Unexpected token } in JSON at position 9 (line 1 column 10)" }] }] }),
    },
  });
  const shown = text(broken);
  assert.match(decode(broken), /class="config-footer-status-summary is-error">1 file problem</);
  assert.match(shown, /~\/\.pi\/agent\/mcp\.json The file is not valid JSON, so none of its servers load\. Unexpected token \} in JSON at position 9/);
  assert.match(decode(broken), /class="mcp-sidebar-group-empty">Not listed: see the file problem below</);
  // The detail pane agrees: the servers are hidden by the problem, not missing.
  assert.match(shown, /No servers could be listed: see the file problems below\./);
  assert.doesNotMatch(shown, /No MCP servers yet/);
});

test("a dangling project link needs no trust, so only the footer speaks of it", () => {
  const dangling = { ...projectFile, problems: [{ reason: "link-dangling", error: "a symbolic link to nothing" }] };
  const html = view({
    cwd: "/Users/me/repo",
    load: { state: "loaded", data: overview({
      files: [globalFile, dangling],
      project: { cwd: "/Users/me/repo", trust: { requiresTrust: false, trusted: true, decision: null, inherited: false } },
    }) },
  });
  const shown = text(html);
  assert.doesNotMatch(shown, /not trusted/);
  assert.match(shown, /1 file problem/);
});

test("loading, a failed load and an empty listing each say so", () => {
  assert.match(text(view({ load: { state: "loading" } })), /Loading\.\.\./);
  const denied = decode(view({ load: { state: "failed", error: { error: "Access denied", reason: "cwd-denied" } } }));
  assert.match(denied, /<div role="alert" class="config-sidebar-message is-error">Could not read the MCP settings\. Pi Web may not read this folder\.<\/div>/);
  // Nothing to translate for an internal failure: its diagnostic is the reason.
  assert.match(text(view({ load: { state: "failed", error: { error: "EACCES: permission denied", reason: "internal" } } })), /Could not read the MCP settings\. EACCES: permission denied/);
  // A load that never answered ends with a way out, never "Loading..." for good.
  assert.match(
    text(view({ load: { state: "failed", error: { error: "GET /api/mcp did not answer within 15000 ms", timedOut: true } } })),
    /Could not read the MCP settings\. Pi Web did not answer in time\. Press Refresh to try again\./,
  );
  const empty = text(view({ load: { state: "loaded", data: overview() } }));
  assert.match(empty, /No MCP servers yet\. Servers in ~\/\.pi\/agent\/mcp\.json and in a project's \.pi\/mcp\.json appear here\./);
  assert.match(empty, /global No servers/);
  assert.doesNotMatch(empty, /0 of 0/);
  assert.match(text(view({ selected: "global\0gone" })), /Select a server or Code mode\./);
  assert.match(decode(view({ refreshing: true })), /<button type="button" disabled="" class="config-button config-button-secondary config-button-default">Refresh<\/button>/);
});

/** The Code mode switch's buttons, by label, with whether each is pressed and disabled. */
function codemodeOptions(html) {
  const group = decode(html).match(/<div role="group" aria-label="Code mode"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(group, "the Code mode switch is rendered");
  return [...group.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(([, attributes, label]) => ({
    label,
    pressed: /aria-pressed="true"/.test(attributes),
    disabled: /disabled=""/.test(attributes),
    describedBy: attributes.match(/aria-describedby="([^"]+)"/)?.[1],
  }));
}

function codemodeView(info, props = {}) {
  return view({ selected: "codemode", load: { state: "loaded", data: overview({ codemode: info, ...props.data }) }, ...props.view });
}

test("the Code mode pane offers Automatic and Always on, and says when a choice applies", () => {
  const automatic = codemodeView({ sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic" });
  assert.deepEqual(codemodeOptions(automatic), [
    { label: "Automatic", pressed: true, disabled: false, describedBy: undefined },
    { label: "Always on", pressed: false, disabled: false, describedBy: undefined },
  ]);
  assert.match(text(automatic),
    /Mode Automatic Always on A session turns Code mode on when a server whose tools use code mode connects\. Applies to sessions started after you change it\. Open sessions keep their tools\. Sandbox Works: its self-test passed\./);
  assert.doesNotMatch(automatic, /role="alert"/);

  // A self-test nobody has run yet leaves Always on available and has its own wording.
  const always = codemodeView({ sandbox: { state: "not-checked" }, builtinDisabled: false, preference: "always" });
  assert.deepEqual(codemodeOptions(always).map(({ label, pressed, disabled }) => [label, pressed, disabled]), [
    ["Automatic", false, false],
    ["Always on", true, false],
  ]);
  assert.match(text(always),
    /Sessions start with Code mode on .* Sandbox Not checked yet: the self-test runs when the first session starts after Pi Web does\./);

  // While a save is on its way both options wait, and the pane says it is saving.
  const saving = codemodeView({ sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic" }, {
    view: { codemodeSave: { saving: true, error: null } },
  });
  assert.deepEqual(codemodeOptions(saving).map(({ disabled }) => disabled), [true, true]);
  assert.match(decode(saving), /<span role="status" class="mcp-config-line is-dim">Saving…<\/span>/);
});

test("Always on is disabled with a visible reason while no session could offer Code mode", () => {
  const reasonOf = (html) => {
    const [, always] = codemodeOptions(html);
    assert.equal(always.disabled, true);
    assert.ok(always.describedBy, "the disabled option points at its reason");
    const reason = decode(html).match(new RegExp(`<span id="${always.describedBy}" class="config-scope-switch-reason">([^<]*)</span>`))?.[1];
    assert.ok(reason, "the reason is visible text, not a tooltip");
    // Automatic can still be chosen.
    assert.equal(codemodeOptions(html)[0].disabled, false);
    return reason;
  };
  assert.equal(
    reasonOf(codemodeView({ sandbox: { state: "unavailable", error: "worker exited" }, builtinDisabled: false, preference: "automatic" })),
    "Always on is unavailable: Code mode's sandbox cannot run on this Pi Web server.",
  );
  const globalPath = "/Users/me/.pi/agent/settings.json";
  assert.equal(
    reasonOf(codemodeView({ sandbox: { state: "available" }, builtinDisabled: true, builtinSettingsPath: globalPath, globalBuiltinSettingsPath: globalPath, preference: "always" })),
    "Always on is unavailable: -builtin:codemode in ~/.pi/agent/settings.json turns Code mode off.",
  );
  // A project that turns Code mode back on for its sessions does not make the global switch work elsewhere.
  assert.equal(
    reasonOf(codemodeView({ sandbox: { state: "available" }, builtinDisabled: false, globalBuiltinSettingsPath: globalPath, preference: "automatic" })),
    "Always on is unavailable: -builtin:codemode in ~/.pi/agent/settings.json turns Code mode off.",
  );

  const down = text(codemodeView({ sandbox: { state: "unavailable", error: "worker exited" }, builtinDisabled: true, builtinSettingsPath: globalPath, globalBuiltinSettingsPath: globalPath, preferenceError: "Unexpected token" }));
  // An unreadable settings file offers no choice to save into it.
  assert.match(down, /Cannot read the global settings file: Unexpected token/);
  assert.doesNotMatch(down, /Applies to sessions started/);
  assert.match(down, /Cannot run on this Pi Web server, so no session offers Code mode: worker exited/);
  assert.match(down, /Turned off by -builtin:codemode in ~\/\.pi\/agent\/settings\.json\./);
  const html = view({ load: { state: "loaded", data: overview({ codemode: { sandbox: { state: "unavailable", error: "x" }, builtinDisabled: false, preference: "automatic" } }) } });
  assert.match(row(html, "Code mode"), /aria-label="Code mode: Unavailable"/);
  assert.match(decode(html), /class="mcp-sidebar-badge is-error">Unavailable</);
});

test("a trusted project that turns Code mode off for itself leaves Always on, a global choice, available", () => {
  const html = codemodeView({
    sandbox: { state: "available" },
    builtinDisabled: true,
    builtinSettingsPath: "/work/app/.pi/settings.json",
    preference: "automatic",
  });
  assert.deepEqual(codemodeOptions(html).map(({ label, disabled, describedBy }) => [label, disabled, describedBy]), [
    ["Automatic", false, undefined],
    ["Always on", false, undefined],
  ]);
  assert.doesNotMatch(decode(html), /config-scope-switch-reason/);
  // The project's own line says what it does to its sessions, and that the switch still reaches the others.
  assert.match(text(html),
    /Extension Turned off for this project's sessions by -builtin:codemode in \/work\/app\/\.pi\/settings\.json\. Always on still applies to sessions in other folders\./);
});

test("a failed save is shown with its reason on every platform", () => {
  const info = { sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic" };
  const failed = (error) => {
    const html = codemodeView(info, { view: { codemodeSave: { saving: false, error } } });
    return decode(html).match(/<span role="alert" class="mcp-config-line is-error">([\s\S]*?)<\/span>(?=<span|<\/div>)/)?.[1];
  };
  assert.equal(text(failed({ error: "Untrusted API request", reason: "request-denied" })),
    "Could not save the choice: Pi Web refused the request because it did not come from this page.");
  // An internal failure (the settings file no longer parses, its lock is held) shows its diagnostic.
  assert.equal(text(failed({ error: "Unexpected token n in JSON", reason: "internal" })), "Could not save the choice: Unexpected token n in JSON");
  assert.equal(text(failed({ error: "Failed to fetch" })), "Could not save the choice: Failed to fetch");
  assert.equal(text(failed({ error: "PUT /api/tools/settings did not answer within 15000 ms", timedOut: true })),
    "Could not save the choice: Pi Web did not answer in time, so the choice may not have been saved.");
  // Unlike the PowerShell switch in General, nothing here waits for the platform.
  assert.doesNotMatch(source, /isWindows/);
  // The error line has its own color.
  assert.match(cssSource, /\.mcp-config-line\.is-error \{[\s\S]*?color: #ef4444;/);
});

test("a trusted project whose defaultTools decides Code mode is named in the pane", () => {
  const settingsPath = "/Users/me/repo/.pi/settings.json";
  const pane = (globalPreference, projectPreference, autoEnableCodemode = true) => text(view({
    cwd: "/Users/me/repo",
    selected: "codemode",
    load: { state: "loaded", data: overview({
      files: [{ ...globalFile, autoEnableCodemode }, projectFile],
      project: { cwd: "/Users/me/repo", trust: trusted },
      codemode: {
        sandbox: { state: "available" },
        builtinDisabled: false,
        preference: globalPreference,
        projectOverride: { settingsPath, preference: projectPreference },
      },
    }) },
  }));
  assert.match(pane("always", "automatic"),
    /This project decides for itself: defaultTools in ~\/repo\/\.pi\/settings\.json starts its sessions without Code mode, as Automatic does, whichever you choose here\./);
  assert.match(pane("automatic", "always"),
    /This project decides for itself: defaultTools in ~\/repo\/\.pi\/settings\.json starts its sessions with Code mode on, whichever you choose here\./);
  // The switch still shows and saves the global choice.
  assert.match(pane("automatic", "always"), /Mode Automatic Always on A session turns Code mode on when a server/);
  // With autoEnableCodemode false, Automatic is what these sessions get, so the warning follows the project.
  assert.match(pane("always", "automatic", false), /autoEnableCodemode is false in ~\/\.pi\/agent\/mcp\.json, so Automatic never turns Code mode on/);
  assert.doesNotMatch(pane("automatic", "always", false), /autoEnableCodemode/);
});

test("the autoEnableCodemode warning names the file whose value sessions read", () => {
  // autoEnableCodemode false (the trusted project's value wins) keeps Automatic from ever turning it on.
  const autoOff = (preference) => text(view({
    cwd: "/Users/me/repo",
    selected: "codemode",
    load: { state: "loaded", data: overview({
      files: [{ ...globalFile, autoEnableCodemode: true }, { ...projectFile, autoEnableCodemode: false }],
      project: { cwd: "/Users/me/repo", trust: trusted },
      codemode: { sandbox: { state: "available" }, builtinDisabled: false, preference },
    }) },
  }));
  assert.match(autoOff("automatic"), /Mode Automatic Always on A session turns Code mode on .* autoEnableCodemode is false in ~\/repo\/\.pi\/mcp\.json, so Automatic never turns Code mode on/);
  assert.doesNotMatch(autoOff("always"), /autoEnableCodemode/);
});

test("the container starts loading and remembers the selection per project", () => {
  // Before the first answer the panel shows that it is loading.
  assert.match(text(render(h(McpConfig, { cwd: null, onClose() {}, embedded: true }))), /Loading\.\.\./);
  assert.match(source, /useState<string \| null>\(\(\) => getLastSettingsSelection\("mcp", cwd\)\)/);
  assert.match(source, /if \(selected\) setLastSettingsSelection\("mcp", selected, cwd\);/);
  assert.match(source, /setSelected\(\(current\) => pickMcpSelection\(mcpServerGroups\(result\.data, Boolean\(cwd\)\), current\)\);/);
  // A late answer from an earlier load never replaces a newer one.
  assert.match(source, /if \(request !== requestRef\.current\) return;/);
  // The servers are read-only: the one write is the Code mode choice, through the tools settings route.
  assert.doesNotMatch(source, /method:/);
  assert.deepEqual([...helperSource.matchAll(/method: "([A-Z]+)"/g)].map((match) => match[1]), ["PUT"]);
  assert.match(helperSource, /fetchImpl\("\/api\/tools\/settings", \{\n\s*method: "PUT",/);
  assert.doesNotMatch(source, /style=\{/);
});

test("the container saves the Code mode choice, then reads back what is stored", () => {
  // Only a change is saved; the pressed option does nothing.
  assert.match(source, /onChange=\{\(value\) => \{\n\s*if \(value !== preference\) onChange\(value\);/);
  assert.match(source, /const result = await saveMcpCodemodePreference\(preference, undefined, controller\.signal\);/);
  // A save answered after the panel closed changes nothing.
  assert.match(source, /if \(saveControllerRef\.current !== controller\) return;/);
  // The stored preference is shown at once, and the overview is read again whatever the outcome:
  // a timed-out save may still land, and a refused one may mean the file changed.
  const save = source.slice(source.indexOf("const saveCodemode = useCallback"), source.indexOf("}, [refresh]);", source.indexOf("const saveCodemode")));
  assert.match(save, /withMcpCodemodePreference\(current\.data, result\.preference\)/);
  assert.match(save, /\n    void refresh\(\);\n {2}$/);
  // Nothing reloads an open session: pi applies defaultTools when it creates one.
  assert.doesNotMatch(source, /sendAgentCommand|type: "reload"/);
});

test("every string the panel shows is translated", () => {
  const literal = (text) => [...text.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  const quoted = (text) => [...text.matchAll(/"((?:mcp|i18n|skills|settings)\.[\w.-]+)"/g)].map((match) => match[1]);
  const problemReasons = [...apiTypesSource.slice(
    apiTypesSource.indexOf("export type McpConfigFileProblemReason"),
    apiTypesSource.indexOf("export interface McpConfigFileProblem "),
  ).matchAll(/\| "([a-z-]+)"/g)].map((match) => match[1]);
  const reasonCodes = [...apiTypesSource.slice(
    apiTypesSource.indexOf("export type McpRefusalReason"),
    apiTypesSource.indexOf("export interface McpErrorResponse"),
  ).matchAll(/\| "([a-z-]+)"/g)].map((match) => match[1]).filter((code) => code !== "internal");
  const keys = [
    ...literal(source),
    ...quoted(source),
    ...quoted(helperSource),
    ...quoted(displaySource),
    ...problemReasons.map((reason) => `mcp.fileProblem.${reason}`),
    ...reasonCodes.map((code) => `mcp.reason.${code}`),
    "mcp.transport.stdio",
    "mcp.transport.http",
  ];
  assert.ok(literal(source).length >= 40);
  for (const key of keys) assert.equal(typeof messages[key], "string", `${key} is missing from en.ts`);
  // No English sentence is written into the markup itself.
  assert.doesNotMatch(source, />\s*[A-Z][a-z]+(?: [a-z]+){2,}[.:]?\s*</);
});
