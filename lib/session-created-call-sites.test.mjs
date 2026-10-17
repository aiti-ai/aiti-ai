/**
 * Behavior-level unit tests for sm:session-created call sites (2026-09-12 creator-side
 * notification consistency; internal design doc todo-session-created-sidebar-notify.md §6).
 *
 * Covers: after fork / fork_branch (regular + the no-assistant defer write branch) / clone run
 * through a real AgentSessionWrapper, notifySessionCreated → publishPageEventToBus broadcasts
 * exactly one frame {type:"sm:session-created", sessionId, cwd, origin} (the data contract of
 * the sidebar pendingDraft row). addPageEventSink is registered in the same jiti realm — notify
 * and the sink share the module instance; in the test environment the globalThis slot is this
 * module's plain assignment (no bus present) → the wide publish does not double-send.
 * Also includes source-level convergence assertions: startRpcSession/subagent/job providers all
 * go through the helper, with no leftover direct publishes.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { addPageEventSink } = await jiti.import("./agent-page-events.ts");

function appendAssistant(manager, text) {
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
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
}

/** Sink collector: asserts exactly one sm:session-created frame with matching fields */
function collectCreatedFrames() {
  const frames = [];
  const off = addPageEventSink((f) => frames.push(f));
  return {
    frames,
    assertOne(origin, sessionId, cwd) {
      const hits = frames.filter((f) => f.type === "sm:session-created");
      assert.equal(hits.length, 1, `expected exactly one sm:session-created frame, got ${hits.length}`);
      assert.deepEqual(
        { sessionId: hits[0].sessionId, cwd: hits[0].cwd, origin: hits[0].origin },
        { sessionId, cwd, origin },
      );
    },
    cleanup: off,
  };
}

function makeWrapper(manager, extra = {}) {
  return new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
    ...extra,
  });
}

async function cleanupTree(root, files) {
  for (const f of files) if (f) await unlink(f).catch(() => {});
  await rmdir(join(root, "sessions")).catch(() => {});
  await rmdir(root).catch(() => {});
}

test("fork_branch broadcasts one sm:session-created frame with origin fork_branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-notify-fb-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  appendAssistant(manager, "source response");
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  const bc = collectCreatedFrames();

  try {
    const wrapper = makeWrapper(manager);
    const result = await wrapper.send({ type: "fork_branch" });
    wrapper.destroy();
    assert.equal(result.cancelled, false);
    const sessions = await SessionManager.list(root, sessionDir);
    forkedFile = sessions.find((s) => s.id === result.newSessionId)?.path;
    assert.ok(forkedFile);
    bc.assertOne("fork_branch", result.newSessionId, root);
  } finally {
    bc.cleanup();
    await cleanupTree(root, [forkedFile, sourceFile]);
  }
});

test("fork broadcasts one sm:session-created frame with origin fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-notify-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const firstEntryId = manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  appendAssistant(manager, "source response");
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  const bc = collectCreatedFrames();

  try {
    const wrapper = makeWrapper(manager);
    const result = await wrapper.send({ type: "fork", entryId: firstEntryId });
    wrapper.destroy();
    assert.equal(result.cancelled, false);
    const sessions = await SessionManager.list(root, sessionDir);
    forkedFile = sessions.find((s) => s.id === result.newSessionId)?.path;
    assert.ok(forkedFile);
    bc.assertOne("fork", result.newSessionId, root);
  } finally {
    bc.cleanup();
    await cleanupTree(root, [forkedFile, sourceFile]);
  }
});

test("clone broadcasts one sm:session-created frame with origin clone", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-notify-clone-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "clone fixture", timestamp: Date.now() });
  appendAssistant(manager, "fixture response");
  const cloneLeafId = manager.getLeafId();
  const sourceFile = manager.getSessionFile();
  let clonedFile;
  const bc = collectCreatedFrames();

  try {
    const wrapper = makeWrapper(manager);
    const result = await wrapper.send({ type: "clone", leafId: cloneLeafId });
    wrapper.destroy();
    assert.equal(result.cancelled, false);
    const sessions = await SessionManager.list(root, sessionDir);
    clonedFile = sessions.find((s) => s.id === result.newSessionId)?.path;
    assert.ok(clonedFile);
    bc.assertOne("clone", result.newSessionId, root);
  } finally {
    bc.cleanup();
    await cleanupTree(root, [clonedFile, sourceFile]);
  }
});

test("fork_branch no-assistant defer path broadcasts once and writes the file first", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-notify-defer-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const earlyUserEntryId = manager.appendMessage({ role: "user", content: "early user message", timestamp: Date.now() });
  appendAssistant(manager, "later response");
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  const bc = collectCreatedFrames();

  try {
    const wrapper = makeWrapper(manager, { extensionRunner: {} });
    // Entry before the first assistant: the branch defaults to defer without writing to disk → broadcast after the manual write fallback
    const result = await wrapper.send({ type: "fork_branch", entryId: earlyUserEntryId });
    wrapper.destroy();
    assert.equal(result.cancelled, false);
    const sessions = await SessionManager.list(root, sessionDir);
    forkedFile = sessions.find((s) => s.id === result.newSessionId)?.path;
    assert.ok(forkedFile, "forked file must be written immediately (defer fallback)");
    bc.assertOne("fork_branch", result.newSessionId, root);
  } finally {
    bc.cleanup();
    await cleanupTree(root, [forkedFile, sourceFile]);
  }
});

test("all creation sites converged on notifySessionCreated; no raw sm:session-created publish remains", async () => {
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const subagent = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const jobProvider = await readFile(new URL("./piweb-job-provider.ts", import.meta.url), "utf8");

  // No leftover direct publishes (unified helper, wide publish converged)
  assert.doesNotMatch(rpc, /publishPageEvent\(\s*"sm:session-created"/);
  assert.doesNotMatch(subagent, /publishPageEvent\(/);
  assert.doesNotMatch(jobProvider, /publishPageEvent\(/);

  // Exactly one helper call per path; origin marks the creation source
  assert.equal((rpc.match(/notifySessionCreated\(/g) ?? []).length, 5);
  assert.match(rpc, /notifySessionCreated\(newSessionId, sessionManager\.getCwd\(\), "fork"\)/);
  assert.match(rpc, /notifySessionCreated\(newSessionId, sessionManager\.getCwd\(\), "fork_branch"\)/);
  assert.match(rpc, /notifySessionCreated\(newSessionId, sessionManager\.getCwd\(\), "clone"\)/);
  assert.equal((rpc.match(/"start"\)/g) ?? []).length, 2);
  assert.match(subagent, /notifySessionCreated\(sessionManager\.getSessionId\(\), sessionManager\.getCwd\(\), "subagent"\)/);
  assert.match(jobProvider, /notifySessionCreated\(sm\.getSessionId\(\), cwd, "job-provider"\)/);

  // All three import the helper (guards against hand-copied implementations)
  for (const src of [rpc, subagent, jobProvider]) {
    assert.match(src, /import \{ notifySessionCreated \} from "\.\/session-created-notify(\.ts)?"|from "@\/lib\/session-created-notify"/);
  }
});
