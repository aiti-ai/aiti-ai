/**
 * sm:session-created 调用点行为级单测（2026-09-12 创建方通知一致性，aiti-ai
 * docs/todo-session-created-sidebar-notify.md §6）。
 *
 * 覆盖：fork / fork_branch（常规 + no-assistant defer 写盘分支）/ clone 经真实
 * AgentSessionWrapper 执行后，notifySessionCreated → publishPageEventToBus 恰好
 * 广播一帧 {type:"sm:session-created", sessionId, cwd, origin}（侧栏 pendingDraft
 * 草稿行的数据契约）。同一 jiti realm 注册 addPageEventSink——notify 与 sink 共享
 * 模块实例；测试环境 globalThis 槽为本模块 plain 赋值（总线不在场）→ 宽发布不双发。
 * 另含源码级收敛断言：startRpcSession/subagent/job provider 全走 helper，无残留直调。
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

/** sink 收集器：断言期间恰好一帧 sm:session-created 且字段匹配 */
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
    // 首条 assistant 之前的 entry：分支默认 defer 不落盘 → 手动写盘兜底后广播
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

  // 无残留直调（统一 helper，宽发布收口）
  assert.doesNotMatch(rpc, /publishPageEvent\(\s*"sm:session-created"/);
  assert.doesNotMatch(subagent, /publishPageEvent\(/);
  assert.doesNotMatch(jobProvider, /publishPageEvent\(/);

  // 各路径恰好一次 helper 调用，origin 标记创建来源
  assert.equal((rpc.match(/notifySessionCreated\(/g) ?? []).length, 5);
  assert.match(rpc, /notifySessionCreated\(newSessionId, sessionManager\.getCwd\(\), "fork"\)/);
  assert.match(rpc, /notifySessionCreated\(newSessionId, sessionManager\.getCwd\(\), "fork_branch"\)/);
  assert.match(rpc, /notifySessionCreated\(newSessionId, sessionManager\.getCwd\(\), "clone"\)/);
  assert.equal((rpc.match(/"start"\)/g) ?? []).length, 2);
  assert.match(subagent, /notifySessionCreated\(sessionManager\.getSessionId\(\), sessionManager\.getCwd\(\), "subagent"\)/);
  assert.match(jobProvider, /notifySessionCreated\(sm\.getSessionId\(\), cwd, "job-provider"\)/);

  // 三处均 import helper（防手写复制实现）
  for (const src of [rpc, subagent, jobProvider]) {
    assert.match(src, /import \{ notifySessionCreated \} from "\.\/session-created-notify"|from "@\/lib\/session-created-notify"/);
  }
});
