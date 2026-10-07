import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { forkSessionBranch, SessionForkError } = await jiti.import("./session-fork.ts");
const { SUBAGENT_META_TYPE } = await jiti.import("./subagents.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

/** A scratch agent dir and session dir: nothing here may reach the real ~/.pi. */
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-session-fork-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  return { cwd: join(root, "project"), sessionDir: join(root, "sessions") };
}

const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });

function lines(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function messageTexts(path) {
  return lines(path).filter((entry) => entry.type === "message").map((entry) => (
    typeof entry.message.content === "string" ? entry.message.content : entry.message.content[0].text
  ));
}

function refusal(code) {
  return (error) => error instanceof SessionForkError && error.code === code;
}

/** u1 → a1, then back to u1 → a2: the file's leaf (its last entry) is a2. */
function branchedSession({ cwd, sessionDir }) {
  const manager = SessionManager.create(cwd, sessionDir);
  const u1 = manager.appendMessage(user("question"));
  const a1 = manager.appendMessage(assistant("first answer"));
  manager.appendLabelChange(u1, "start");
  manager.branch(u1);
  const a2 = manager.appendMessage(assistant("second answer"));
  return { manager, path: manager.getSessionFile(), u1, a1, a2 };
}

test("copies the file's leaf branch beside the source and leaves the source as it was", async (t) => {
  const dirs = await scratch(t);
  const source = branchedSession(dirs);
  const before = readFileSync(source.path, "utf8");

  const fork = forkSessionBranch(source.path);

  assert.notEqual(fork.sessionId, source.manager.getSessionId());
  assert.ok(existsSync(fork.path));
  assert.equal(dirname(fork.path), dirname(source.path));
  assert.ok(fork.path.endsWith(`_${fork.sessionId}.jsonl`));
  const [header, ...entries] = lines(fork.path);
  assert.equal(header.type, "session");
  assert.equal(header.id, fork.sessionId);
  assert.equal(header.cwd, source.manager.getCwd());
  assert.equal(header.parentSession, source.path);
  assert.deepEqual(messageTexts(fork.path), ["question", "second answer"]);
  // The label of a copied entry comes along, as pi copies it.
  assert.ok(entries.some((entry) => entry.type === "label" && entry.targetId === source.u1 && entry.label === "start"));
  assert.equal(readFileSync(source.path, "utf8"), before, "the source is untouched");
});

test("an open wrapper's leaf picks the branch it shows", async (t) => {
  const dirs = await scratch(t);
  const source = branchedSession(dirs);
  const fork = forkSessionBranch(source.path, source.a1);
  assert.deepEqual(messageTexts(fork.path), ["question", "first answer"]);
});

test("a shell-only branch is written even though pi would wait for a message", async (t) => {
  const { cwd, sessionDir } = await scratch(t);
  const path = join(sessionDir, "bash-only.jsonl");
  const timestamp = new Date().toISOString();
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path, [
    { type: "session", version: 3, id: "bash-only", timestamp, cwd },
    { type: "message", id: "b1", parentId: null, timestamp, message: { role: "bashExecution", command: "ls", output: "a\n", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const fork = forkSessionBranch(path);
  const [header, entry] = lines(fork.path);
  assert.equal(header.parentSession, path);
  assert.equal(entry.message.role, "bashExecution");
  assert.equal(entry.message.command, "ls");
});

test("refuses what it cannot copy, with a code the sidebar can name", async (t) => {
  const { cwd, sessionDir } = await scratch(t);
  const missing = join(sessionDir, "missing.jsonl");
  assert.throws(() => forkSessionBranch(missing), refusal("not_found"));
  // A wrapper whose file is not written yet, or whose leaf is not on disk.
  assert.throws(() => forkSessionBranch(missing, "abc"), refusal("unsaved"));
  const source = branchedSession({ cwd, sessionDir });
  assert.throws(() => forkSessionBranch(source.path, "not-an-entry"), refusal("unsaved"));
  // A leaf reset before the first entry, a header alone, setup entries alone.
  assert.throws(() => forkSessionBranch(source.path, null), refusal("empty"));
  const timestamp = new Date().toISOString();
  const headerOnly = join(sessionDir, "header-only.jsonl");
  writeFileSync(headerOnly, `${JSON.stringify({ type: "session", version: 3, id: "header-only", timestamp, cwd })}\n`);
  assert.throws(() => forkSessionBranch(headerOnly), refusal("empty"));
  const setupOnly = join(sessionDir, "setup-only.jsonl");
  writeFileSync(setupOnly, [
    { type: "session", version: 3, id: "setup-only", timestamp, cwd },
    { type: "model_change", id: "m1", parentId: null, timestamp, provider: "p", modelId: "m" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.throws(() => forkSessionBranch(setupOnly), refusal("empty"));

  // A subagent's copy would be folded into its parent's family, out of sight.
  const subagent = SessionManager.create(cwd, sessionDir, { parentSession: source.path });
  subagent.appendCustomEntry(SUBAGENT_META_TYPE, { version: 1, parentSessionId: "parent", parentSessionPath: source.path });
  subagent.appendMessage(user("task"));
  subagent.appendMessage(assistant("done"));
  assert.throws(() => forkSessionBranch(subagent.getSessionFile()), refusal("subagent"));
  // Invalid metadata does not make a subagent.
  const notSubagent = SessionManager.create(cwd, sessionDir);
  notSubagent.appendCustomEntry(SUBAGENT_META_TYPE, { version: 2 });
  notSubagent.appendMessage(user("hello"));
  assert.ok(existsSync(forkSessionBranch(notSubagent.getSessionFile()).path));
});
