import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, waitForRpcSession, notifyRunningChange } = await jiti.import("./rpc-manager.ts");

test("get_tools preserves the SDK tool definition fields", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const getToolsSource = source.slice(
    source.indexOf('case "get_tools"'),
    source.indexOf('case "get_commands"'),
  );

  assert.match(getToolsSource, /\.getAllTools\(\)/);
  assert.match(getToolsSource, /\.\.\.t,/);
  assert.match(getToolsSource, /active: active\.has\(t\.name\)/);
});

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("built-in subagents persist their selected resource policy", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const subagentSource = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(subagentSource, /SessionManager\.create\(parent\.cwd, undefined, \{ parentSession: parent\.sessionFile \}\)/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_META_TYPE/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_RESULT_TYPE/);
  assert.match(subagentSource, /dependencies\.registerSession\(inner, \{/);
  assert.match(subagentSource, /noExtensions: !profile\.loadExtensions/);
  assert.match(subagentSource, /noSkills: !profile\.loadSkills/);
  assert.match(subagentSource, /excludeTools: \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\]/);
  assert.match(subagentSource, /withSubagentExtensionTools\(profile\.tools, extensionToolNames\)/);
  assert.match(subagentSource, /resourceSnapshot:/);
  assert.match(startupSource, /readSubagentSessionResources\(/);
  assert.match(startupSource, /resourceLoaderOptions: subagentResources/);
  assert.match(startupSource, /appendSystemPrompt: subagentResources\.appendSystemPrompt/);
  assert.match(startupSource, /noExtensions: !subagentResources\.loadExtensions/);
  assert.match(startupSource, /noSkills: !subagentResources\.loadSkills/);
  assert.match(startupSource, /excludeTools: \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\]/);
  assert.match(startupSource, /let toolsOption: string\[\] \| undefined = subagentResources\?\.tools/);
  assert.match(source, /createSubagentController\(/);
  assert.match(source, /suppressCompletionNotifications: true/);
  assert.match(source, /suppressCompletionNotifications: Boolean\(subagentResources\)/);
  assert.match(startupSource, /createSubagentExtension\([\s\S]*?SUBAGENT_CONTROLLER\.extensionRuntime,[\s\S]*?\(\) => listSubagentProfiles\(sessionCwd\),[\s\S]*?isBuiltInSubagentsEnabled/);
  // After the refactor, upstream behavior is restored: conflicting-extension disabling runs before the fork-subagent extension's priority wrapping
  assert.match(startupSource, /preferPiWebSubagentExtension\(disableConflictingExtensions\(base, getExtRegistry\(\)\)\)/);
});

test("running snapshots expose sessions with suppressed completion notifications", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const runningRouteSource = await readFile(new URL("../app/api/agent/running/route.ts", import.meta.url), "utf8");
  const sessionsRouteSource = await readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8");
  const snapshotSource = source.slice(
    source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds"),
    source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds")),
  );

  assert.match(snapshotSource, /session\.isRunning\(\) && session\.hasSuppressedCompletionNotifications\(\)/);
  assert.match(runningRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
  assert.match(sessionsRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
});

test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSessionFromServices(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: \[\.\.\.scope\.scopedModels\]/);
  assert.match(startupSource, /model: startupModel/);
  assert.match(startupSource, /thinkingLevel: initial\.thinkingLevel/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = branch\.some\(\(entry\) => entry\.type === "message"\)/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.match(startupSource, /getLatestModelChange\(branch as unknown as SessionEntry\[\]\)/);
  assert.match(startupSource, /model: startupModel/);
  assert.doesNotMatch(startupSource, /const initial = sessionFile/);
  assert.doesNotMatch(startupSource, /sessionManager\.buildSessionContext\(\)/);
});

test("RPC session startup opens an existing session file only once and trusts its cwd", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const routeSource = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventRouteSource = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const autoNameRouteSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(startupSource, /projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  for (const route of [routeSource, eventRouteSource, autoNameRouteSource]) {
    assert.doesNotMatch(route, /SessionManager\.open\(/);
  }
});

test("RPC wrapper avoids per-chunk idle maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  beginExtensionBinding"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const idleSource = source.slice(
    source.indexOf("  private resetIdleTimer"),
    source.indexOf("  private persistBashOnlySession"),
  );
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "clone"'),
  );
  const cloneSource = source.slice(
    source.indexOf('case "clone"'),
    source.indexOf('case "navigate_tree"'),
  );
  assert.match(idleSource, /this\.shutdown\("idle"\)/);
  // fork/clone no longer use replacement-style teardown: an in-flight run must not be interrupted (both only
  // read the source file + write a new branch, the source session keeps running, and idle wrappers are left
  // to the existing idle GC).
  assert.doesNotMatch(forkSource, /shutdownAfterSessionReplacement\("fork"\)/);
  assert.doesNotMatch(cloneSource, /shutdownAfterSessionReplacement\("clone"\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("clone copies the requested leaf into a child session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const cloneSource = source.slice(
    source.indexOf('case "clone"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(cloneSource, /typeof command\.leafId === "string"/);
  assert.match(cloneSource, /branchHasAssistant/);
  assert.match(cloneSource, /createBranchedSession\(leafId\)/);
  assert.match(cloneSource, /cacheSessionPath\(newSessionId, clonedPath\)/);
  assert.match(cloneSource, /invalidateSessionListCache\(\)/);
  assert.match(cloneSource, /return \{ cancelled: false, newSessionId \}/);
});

test("fork_branch copies the selected assistant entry without replacing the source session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-quoted-branch-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "selected response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const selectedEntryId = manager.getLeafId();
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  let disposed = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const result = await wrapper.send({ type: "fork_branch", entryId: selectedEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;
    assert.equal(SessionManager.open(forkedFile, sessionDir).getLeafId(), selectedEntryId);
    assert.equal(manager.getLeafId(), selectedEntryId);
    assert.equal(disposed, false);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

/** Background fork (composer "new session" button): no entryId = current leaf; allowed while running;
 *  the copy carries the full context (including a mid-run model_change → the new session uses the user-changed model); the source session is unaffected. */
test("fork_branch without entryId defaults to the current leaf and carries the latest model change while running", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-bg-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendModelChange("test", "model-a");
  manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "source response" }],
    api: "test",
    provider: "test",
    model: "model-a",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  // User changes the model mid-run: model_change is appended at the current leaf (switching while running is likewise flushed immediately)
  const modelChangeId = manager.appendModelChange("test", "model-b");
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  let disposed = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    // While running: the old implementation's isSessionRunningForReplacement() would reject here — background fork must pass.
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const result = await wrapper.send({ type: "fork_branch" });
    assert.equal(result.cancelled, false);
    assert.ok(result.newSessionId);
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo, "forked session file must exist immediately (background start reads it by id)");
    forkedFile = forkedInfo.path;

    const forkedManager = SessionManager.open(forkedFile, sessionDir);
    // The current leaf (including the model change) is copied wholesale — the new session's cold start can restore model-b via getLatestModelChange(branch).
    assert.equal(forkedManager.getLeafId(), modelChangeId);
    const branch = forkedManager.getBranch();
    const lastModelChange = [...branch].reverse().find((entry) => entry.type === "model_change");
    assert.equal(lastModelChange.modelId, "model-b");

    // Source session unaffected (not replaced/closed, leaf untouched)
    assert.equal(manager.getLeafId(), modelChangeId);
    assert.equal(disposed, false);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

/** Manual flush fallback: when an explicit entryId lands before the first assistant message, the copied path has no assistant,
 *  and createBranchedSession defers writing the file (the source file already exists thanks to the later assistant) — background fork
 *  needs the file to exist immediately (the caller cold-starts by id right away), so it must be written manually with the sessionId matching the file header. */
test("fork_branch writes the forked file immediately even when the copied path has no assistant message", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-bg-fork-noassistant-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const earlyUserEntryId = manager.appendMessage({ role: "user", content: "early user message", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "later response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  });

  try {
    // Entry before the first assistant: the copied path has no assistant → the branch file is not flushed by default
    const result = await wrapper.send({ type: "fork_branch", entryId: earlyUserEntryId });
    assert.equal(result.cancelled, false);
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo, "forked file must be written immediately");
    forkedFile = forkedInfo.path;
    // The file-header id matches the return value (a cold start parsing sessionId from the file cannot go wrong)
    assert.equal(SessionManager.open(forkedFile, sessionDir).getSessionId(), result.newSessionId);
    assert.equal(SessionManager.open(forkedFile, sessionDir).getLeafId(), earlyUserEntryId);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

/** Source session never flushed (no assistant): fork_branch returns cancelled instead of throwing — the frontend reports that there is no full conversation. */
test("fork_branch cancels on a source session that never flushed a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-bg-fork-unflushed-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "only a user message", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  });

  try {
    const result = await wrapper.send({ type: "fork_branch" });
    assert.equal(result.cancelled, true);
  } finally {
    wrapper.destroy();
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("fork before the first message persists a reopenable message-free child session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-root-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const settingsEntryId = manager.appendModelChange("test", "test-model");
  const firstEntryId = manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "source response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const result = await wrapper.send({ type: "fork", entryId: firstEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;

    const forked = SessionManager.open(forkedFile, sessionDir);
    assert.equal(forked.getHeader().parentSession, sourceFile);
    assert.equal(forked.getLeafId(), settingsEntryId);
    assert.deepEqual(forked.getEntries(), [manager.getEntry(settingsEntryId)]);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

/** Fork while running (the "new session" button on a message): the source session must not be shut down/interrupted — the in-flight run continues.
 *  Counter-example: the old implementation ran shutdownAfterSessionReplacement("fork") → destroy → dispose after the fork completed,
 *  so the running agent stopped as if someone had pressed Stop when the user clicked "new session". */
test("fork during an active run does not shut down the source session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-fork-active-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "first reply" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const secondUserEntryId = manager.appendMessage({ role: "user", content: "second prompt", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  let disposed = false;
  let shutdownEmits = 0;
  let finishPrompt;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    prompt: (_message, options) => new Promise((resolve) => {
      finishPrompt = resolve;
      options.preflightResult?.(true);
    }),
    extensionRunner: {
      emit: async (event) => {
        if (event?.type === "session_shutdown") shutdownEmits += 1;
      },
    },
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    await wrapper.send({ type: "prompt", message: "keep this run active" });
    assert.ok(finishPrompt, "fixture run must stay active");

    const result = await wrapper.send({ type: "fork", entryId: secondUserEntryId });
    assert.equal(result.cancelled, false);
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo, "forked session file must exist");
    forkedFile = forkedInfo.path;

    // Source session not shut down/interrupted: wrapper still alive, run still pending, no session_shutdown broadcast.
    assert.equal(disposed, false, "fork must not dispose the source wrapper while a run is active");
    assert.equal(shutdownEmits, 0, "fork must not emit session_shutdown for the source session");
  } finally {
    finishPrompt?.();
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("concurrent replacements are rejected and clone keeps the source session alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "clone fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const cloneLeafId = manager.getLeafId();
  manager.appendSessionInfo("source-only metadata");

  const sourceFile = manager.getSessionFile();
  let clonedFile;
  let releaseModelRefresh;
  let signalModelRefresh;
  const modelRefreshStarted = new Promise((resolve) => { signalModelRefresh = resolve; });
  const modelRefreshHeld = new Promise((resolve) => { releaseModelRefresh = resolve; });
  let disposed = false;
  let shutdownEmits = 0;
  let autoRetryEnabled = false;
  let finishPrompt;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    prompt: (_message, options) => new Promise((resolve) => {
      finishPrompt = resolve;
      options.preflightResult?.(true);
    }),
    modelRuntime: {
      getModel: () => undefined,
      refresh: async () => {
        signalModelRefresh();
        await modelRefreshHeld;
      },
    },
    setAutoRetryEnabled: (enabled) => { autoRetryEnabled = enabled; },
    extensionRunner: {
      emit: async (event) => {
        if (event?.type === "session_shutdown") shutdownEmits += 1;
      },
    },
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    // Replacement mutual exclusion kept: clone is rejected while another mutating command is in progress.
    const modelChange = wrapper.send({ type: "set_model", provider: "test", modelId: "missing" });
    await modelRefreshStarted;
    await assert.rejects(
      wrapper.send({ type: "clone" }),
      /Cannot clone while another session command is running/,
    );
    releaseModelRefresh();
    await assert.rejects(modelChange, /Model not found/);

    // Clone while running: the branch is copied successfully and the source session is not shut down/interrupted (the in-flight run continues).
    await wrapper.send({ type: "prompt", message: "keep this run active" });
    assert.ok(finishPrompt, "fixture run must stay active");
    const result = await wrapper.send({ type: "clone", leafId: cloneLeafId });
    assert.equal(result.cancelled, false);

    const sessions = await SessionManager.list(root, sessionDir);
    const clonedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(clonedInfo);
    clonedFile = clonedInfo.path;

    const cloned = SessionManager.open(clonedFile, sessionDir);
    assert.equal(cloned.getHeader().parentSession, sourceFile);
    assert.equal(cloned.getLeafId(), cloneLeafId);
    assert.deepEqual(cloned.buildSessionContext().messages, manager.buildSessionContext().messages);

    // Source session still alive: not disposed, no session_shutdown broadcast, replacement lock released (subsequent commands can run).
    assert.equal(disposed, false, "clone must not dispose the source wrapper while a run is active");
    assert.equal(shutdownEmits, 0, "clone must not emit session_shutdown for the source session");
    await wrapper.send({ type: "set_auto_retry", enabled: true });
    assert.equal(autoRetryEnabled, true);
  } finally {
    finishPrompt?.();
    wrapper.destroy();
    if (clonedFile) await unlink(clonedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("cancelled session replacement releases its lock", async () => {
  const manager = SessionManager.inMemory(tmpdir());
  let autoRetryEnabled = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    setAutoRetryEnabled: (enabled) => { autoRetryEnabled = enabled; },
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "fork", entryId: "missing" }), { cancelled: true });
    await wrapper.send({ type: "set_auto_retry", enabled: true });
    assert.equal(autoRetryEnabled, true);
  } finally {
    wrapper.destroy();
  }
});

test("navigate_tree rewrites the current model/thinking onto the new branch (edit-from-here sync)", async () => {
  // Incident shape: the model-switch model_change hangs off the leaf at switch time; a later navigate
  // (edit-from-here) branching back to an earlier node leaves the new chain's ancestors without that
  // mc → the display falls back to the old model while the engine actually runs the new one.
  // After backfilling, the new chain should carry a model_change consistent with the in-memory state
  // (+ thinking_level_change).
  const root = await mkdtemp(join(tmpdir(), "pi-web-nav-sync-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const u1 = manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "branch point reply" }],
    provider: "prov-a",
    model: "model-a",
    timestamp: Date.now(),
  });
  // Simulate "switching models": the mc hangs off the leaf at that time (after a1)
  manager.appendModelChange("prov-b", "model-b");

  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    model: { id: "model-b", provider: "prov-b" },
    agent: { state: { thinkingLevel: "off" } },
    // Mock pi's navigate: only branch (enough to drive the logic under test)
    navigateTree: async (targetId) => {
      manager.branch(targetId);
      return { cancelled: false };
    },
    extensionRunner: { emit: async () => {} },
    dispose() {},
  });

  try {
    const result = await wrapper.send({ type: "navigate_tree", targetId: u1 });
    assert.deepEqual(result, { cancelled: false });
    const entries = manager.getEntries();
    // The new chain (under u1) should have a backfilled model_change(prov-b/model-b) and thinking_level_change(off)
    const patchedMc = entries.find((e) => e.type === "model_change" && e.parentId === u1);
    assert.ok(patchedMc, "expected a rewritten model_change under the branch target");
    assert.equal(patchedMc.provider, "prov-b");
    assert.equal(patchedMc.modelId, "model-b");
    const patchedTl = entries.find((e) => e.type === "thinking_level_change" && e.parentId === patchedMc.id);
    assert.ok(patchedTl, "expected a rewritten thinking_level_change chained after the model_change");
    assert.equal(patchedTl.thinkingLevel, "off");
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("clone cancels an assistant-free branch without creating a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-empty-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "no assistant yet", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "clone" }), { cancelled: true });
    assert.equal((await SessionManager.list(root, sessionDir)).length, 0);
  } finally {
    wrapper.destroy();
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("new-session route applies model scope during construction instead of follow-up commands", async () => {
  const source = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  assert.match(source, /initialModel: \{ provider, modelId \}/);
  assert.match(source, /thinkingLevel: explicitThinkingLevel/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_model"/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_thinking_level"/);
  assert.match(source, /model: state\.model/);
  assert.match(source, /thinkingLevel: state\.thinkingLevel/);
});

test("prompt routes mark only preflight failures as rejected", async () => {
  const existingRoute = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const newRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  for (const source of [existingRoute, newRoute]) {
    assert.match(source, /let promptAccepted = false/);
    assert.match(source, /await .*\.send\(/);
    assert.match(source, /promptAccepted = .*\.type === "prompt"/);
    assert.match(source, /commandType === "prompt" && !promptAccepted/);
  }
});

test("the wrapper reapplies an exact prompt after SDK preflight", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const promptSource = source.slice(
    source.indexOf('case "prompt"'),
    source.indexOf('case "abort"'),
  );

  assert.match(promptSource, /preflightResult: \(success\) => \{[\s\S]*?this\.applyExactSystemPrompt\(\);[\s\S]*?acceptPreflight\(\)/);
  assert.doesNotMatch(promptSource, /requestedToolNames/);
});

test("RPC session startup persists explicit preferences without replaying setters", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /persistExplicitStartupPreferences\(/);
  assert.match(startupSource, /modelDefaultChanged\) invalidateModelsCache\(\)/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.inner\.reload\(\)/);
  assert.match(reloadSource, /this\.applyExactSystemPrompt\(\);\s*invalidateModelsCache\(\)/);
});

test("normal sessions restore persisted tool selections before loading resources", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const registrationSource = source.slice(
    source.indexOf("function registerRpcWrapper"),
    source.indexOf("const SUBAGENT_CONTROLLER"),
  );

  assert.match(startupSource, /readSessionToolSelection\(sessionManager\.getEntries\(\)/);
  assert.match(startupSource, /const selectedToolNames = subagentResources\?\.tools \?\? persistedToolNames \?\? requestedToolNames/);
  assert.match(startupSource, /appendSessionToolSelection\(sessionManager, requestedToolNames\)/);
  assert.ok(startupSource.indexOf("const chatOnly") < startupSource.indexOf("createAgentSessionServices("));
  assert.match(startupSource, /chatOnly\s*\? CHAT_ONLY_RESOURCE_LOADER_OPTIONS/);
  assert.match(startupSource, /const trustReloadOptions = subagentResources[\s\S]*?subagentLoadsResources[\s\S]*?projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(registrationSource, /if \(!wrapper\.isChatOnly\(\)\) wrapper\.beginExtensionBinding\(\)/);
});

test("crossing the Chat-only boundary persists and rebuilds the wrapper", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const switchSource = source.slice(
    source.indexOf("export async function setRpcSessionTools"),
    source.indexOf("export function getRunningRpcSessionIds"),
  );

  assert.match(switchSource, /!hasCurrentResourcePolicy\s*\|\| existing\.isChatOnly\(\) !== \(toolNames\.length === 0\)/);
  assert.match(switchSource, /appendSessionToolSelection\(existing\.inner\.sessionManager, toolNames\)/);
  assert.match(switchSource, /await existing\.shutdown\(\)/);
  assert.match(switchSource, /__recreate__\$\{randomUUID\(\)\}/);
  assert.match(switchSource, /sessionId: started\.realSessionId/);
});

test("queue views carry parallel hasImages flags (get_state + import_queue)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-queue-attach-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const sessionFile = manager.getSessionFile();
  const steerCalls = [];
  const followCalls = [];
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    // import_queue re-enqueues via inner.steer/followUp (fake: record + no-op)
    steer: async (text, images) => { steerCalls.push({ text, images }); },
    followUp: async (text, images) => { followCalls.push({ text, images }); },
    getSteeringMessages: () => steerCalls.map((c) => c.text),
    getFollowUpMessages: () => followCalls.map((c) => c.text),
    getContextUsage: () => null,
    pendingMessageCount: 0,
    autoCompactionEnabled: true,
    autoRetryEnabled: false,
    model: undefined,
    dispose() {},
  });

  try {
    const importResult = await wrapper.send({
      type: "import_queue",
      entries: [
        { kind: "followUp", text: "plain entry" },
        { kind: "followUp", text: "with image", images: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
        { kind: "steer", text: "steer with image", images: [{ type: "image", data: "aGk=", mimeType: "image/jpeg" }] },
      ],
    });
    assert.equal(importResult.imported, 3);
    assert.deepEqual(importResult.followUpHasImages, [false, true]);
    assert.deepEqual(importResult.steeringHasImages, [true]);

    const state = await wrapper.send({ type: "get_state" });
    assert.deepEqual(state.queuedMessages.steering, ["steer with image"]);
    assert.deepEqual(state.queuedMessages.followUp, ["plain entry", "with image"]);
    assert.deepEqual(state.queuedMessages.steeringHasImages, [true]);
    assert.deepEqual(state.queuedMessages.followUpHasImages, [false, true]);
  } finally {
    wrapper.destroy();
    const sidecar = `${sessionFile}.queue.json`;
    await Promise.allSettled([unlink(sidecar), unlink(sessionFile)]);
    await rm(sessionDir, { recursive: true, force: true });
    await rmdir(root).catch(() => {});
  }
});

test("waitForRpcSession event-driven wrapper waiting (does not start one, unsubscribable, immediately ready when already present)", async () => {
  const previousRegistry = globalThis.__piSessions;
  const registry = new Map();
  globalThis.__piSessions = registry;
  try {
    // 1) No wrapper yet: keep waiting, do not resolve early.
    let ready = null;
    const stop = waitForRpcSession("wait-for-rpc-test", (wrapper) => { ready = wrapper; });
    assert.equal(ready, null);

    // 2) After unsubscribing, even a registration must not wake it.
    stop();
    const wrapperA = { isAlive: () => true, isRunning: () => false };
    registry.set("wait-for-rpc-test", wrapperA);
    notifyRunningChange();
    assert.equal(ready, null, "must not wake up again after unsubscribing");

    // 3) When a wrapper already exists, resolve immediately (the lazy-SSE open-and-alive path).
    let readyNow = null;
    waitForRpcSession("wait-for-rpc-test", (wrapper) => { readyNow = wrapper; });
    assert.equal(readyNow, wrapperA);

    // 4) Registration broadcast wakes it (the starting→registered transition is covered by the notifyRunningChange snapshot).
    registry.delete("wait-for-rpc-test");
    let readyLate = null;
    waitForRpcSession("wait-for-rpc-test", (wrapper) => { readyLate = wrapper; });
    const wrapperB = { isAlive: () => true, isRunning: () => false };
    registry.set("wait-for-rpc-test", wrapperB);
    notifyRunningChange();
    assert.equal(readyLate, wrapperB);
  } finally {
    globalThis.__piSessions = previousRegistry;
  }
});
