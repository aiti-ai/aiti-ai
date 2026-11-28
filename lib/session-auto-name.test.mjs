import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-autoname-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { autoNameProviderOwned, findSessionFileOwner } = await jiti.import("./session-auto-name.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");
const { putHandle, removeHandle } = await jiti.import("./session/handle-store.ts");
const { registerProvider } = await jiti.import("./session/providers.ts");

test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const fileEntries = async (path) =>
  (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

/** A session file with one user turn, cached in the path cache (route-level setup). */
function sessionOnDisk(t) {
  const manager = SessionManager.create(agentDir);
  manager.appendMessage({ role: "user", content: "帮我修登录页的 bug", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "已修复并验证。" }], timestamp: Date.now() });
  const id = manager.getSessionId();
  const path = manager.getSessionFile();
  cacheSessionPath(id, path);
  t.after(() => {
    invalidateSessionPathCache(id);
    removeHandle(id);
  });
  return { id, path };
}

function fakeHandle(id, { entries, model } = {}) {
  const sent = [];
  const handle = {
    id,
    source: "test/spawn",
    capabilities: { getMessages: true, renameSession: true },
    cwd: agentDir,
    prompt: async () => {},
    abort: async () => {},
    subscribe: () => () => {},
    dispose: async () => {},
    alive: () => true,
    isAlive: () => true,
    isRunning: () => false,
    getModel: () => model,
    getMessages: async () => entries,
    setSessionName: async (name) => { sent.push({ type: "set_session_name", name }); },
  };
  return { handle, sent };
}

test("findSessionFileOwner returns the provider that claims the file", async (t) => {
  const previous = globalThis.__sessionProviders;
  globalThis.__sessionProviders = new Map();
  registerProvider({
    type: "owner",
    label: "Owner",
    maxCapabilities: {},
    ownsFile: (file) => file === "/claimed/file",
  });
  t.after(() => { globalThis.__sessionProviders = previous; });

  assert.equal((await findSessionFileOwner("/claimed/file"))?.type, "owner");
  assert.equal(await findSessionFileOwner("/other/file"), undefined);
});

test("autoNameProviderOwned cold file: transcript from disk, appends session_info, last-writer-wins", async (t) => {
  const { id, path } = sessionOnDisk(t);
  let seen;
  const result = await autoNameProviderOwned(id, path, async (system, userText) => {
    seen = { system, userText };
    return { text: '"登录页修复"', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 } };
  });
  assert.equal(result.title, "登录页修复");
  assert.deepEqual(result.usage, { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 });
  assert.match(seen.system, /name/i);
  assert.match(seen.userText, /修登录页的 bug/);

  const infos = (await fileEntries(path)).filter((e) => e.type === "session_info");
  assert.equal(infos.length, 1);
  assert.equal(infos[0].name, "登录页修复");
});

test("autoNameProviderOwned live handle: get_messages for the transcript, set_session_name RPC for the write, file untouched", async (t) => {
  const { id, path } = sessionOnDisk(t);
  const { handle, sent } = fakeHandle(id, {
    entries: [{ type: "message", message: { role: "user", content: "live session prompt", timestamp: 1 } }],
    model: { provider: "test", id: "test-model" },
  });
  putHandle(handle);

  const result = await autoNameProviderOwned(id, path, async (system, userText) => {
    assert.match(userText, /live session prompt/);
    return { text: "Live naming" };
  });
  assert.equal(result.title, "Live naming");
  assert.equal(result.usage, undefined);
  assert.deepEqual(sent, [{ type: "set_session_name", name: "Live naming" }]);

  const infos = (await fileEntries(path)).filter((e) => e.type === "session_info");
  assert.equal(infos.length, 0, "a live backend must be renamed through its RPC, never on disk");
});

test("autoNameProviderOwned without a live handle and without invocable text rejects before invoking", async (t) => {
  const manager = SessionManager.create(agentDir);
  // No messages: only the session header exists.
  const id = manager.getSessionId();
  const path = manager.getSessionFile();
  cacheSessionPath(id, path);
  t.after(() => invalidateSessionPathCache(id));

  let called = false;
  await assert.rejects(
    () => autoNameProviderOwned(id, path, async () => { called = true; return { text: "x" }; }),
    /usable text/,
  );
  assert.equal(called, false);
});
