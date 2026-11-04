/**
 * cursor-cli-store tests — 合成 store.db fixture（clean-room 编码器，参照
 * session-migrate synthetic generator 思路）钉死读取器的 wire 假设，
 * 防 cursor 升级静默破坏。
 *
 * 编码器与读取器相互独立：本文件自带最小 protobuf wire writer，从零构建
 * blobs(sha256 寻址) + meta(hex JSON)，读取器按真实会话同款图解码：
 *
 *   root: f1 = system/context refs（读取器忽略）; f8 = turn refs
 *   turn: f1 = agent-turn（内联）
 *   agent-turn: f1 = user ref; f2 = step refs
 *   user blob: f1 text; f2 uuid; f25/f26 ts(ms)
 *   step: f1 = assistant{f1 text,f2 ts} | f2 = tool call | f3 = thinking{f1 text}
 *
 * Run: node --experimental-strip-types --test lib/agents/cursor-cli-store.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename as pathBasename } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { listCursorCliChats, readCursorCliChat } = await import("../../../_shared/cursor-cli-store.ts");
const { createCursorCliAdapter } = await import("./cursor-cli.ts");

// ── 最小 protobuf wire writer ───────────────────────────────────────────────

function pbVarint(n) {
  const out = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
const pbTag = (no, wt) => pbVarint((no << 3) | wt);
const pbBytes = (no, buf) => Buffer.concat([pbTag(no, 2), pbVarint(buf.length), buf]);
const pbUint = (no, v) => Buffer.concat([pbTag(no, 0), pbVarint(v)]);
const pbStr = (no, s) => pbBytes(no, Buffer.from(s, "utf8"));
const ref = (hexId) => Buffer.from(hexId, "hex"); // 32 字节 blob 引用
const sha = (data) => createHash("sha256").update(data).digest("hex");

// ── blob 构建器（字段布局 = 实测 3.17 帧形） ────────────────────────────────

const jsonBlob = (obj) => Buffer.from(JSON.stringify(obj), "utf8");
const userMsgBlob = (text, uuid, ts) => Buffer.concat([
  pbStr(1, text), pbStr(2, uuid), pbStr(3, ""), pbUint(4, 1),
  pbUint(25, ts), pbUint(26, ts),
]);
const assistantStepBlob = (text, ts) => pbBytes(1, Buffer.concat([pbStr(1, text), pbUint(2, ts)]));
const thinkingStepBlob = (text, ts) => pbBytes(3, Buffer.concat([pbStr(1, text), pbUint(2, 1), pbUint(3, ts), pbUint(4, ts)]));
const toolStepBlob = (desc) => pbBytes(2, pbStr(1, desc));
/** agent-turn: f1 = user ref; f2 = step refs */
const agentTurnBlob = (userId, stepIds) => Buffer.concat([
  pbBytes(1, ref(userId)),
  ...stepIds.map((id) => pbBytes(2, ref(id))),
]);
/** turn: f1 = 内联 agent-turn */
const turnBlob = (agentTurn) => pbBytes(1, agentTurn);
/** root: f1 = system/context refs; f8 = turn refs; 附带 cwd/分支等元数据字段 */
const rootBlob = ({ sysIds, turnIds, cwdUri, cwdPath, branch }) => Buffer.concat([
  ...sysIds.map((id) => pbBytes(1, ref(id))),
  ...turnIds.map((id) => pbBytes(8, ref(id))),
  pbStr(9, `file://${cwdPath}`),
  pbBytes(21, Buffer.concat([pbStr(1, cwdPath), pbStr(2, branch)])),
  pbStr(22, "cli"),
  pbStr(27, "Asia/Shanghai"),
]);

/** 构建一个合成 store.db（blobs sha256 寻址 + meta hex JSON），返回 {dir} */
function buildStoreDb(dir, { sid, name, createdAt, cwd, turns, sysText = "You are Composer." }) {
  mkdirSync(dir, { recursive: true });
  const blobs = new Map(); // id -> Buffer
  const put = (buf) => { const id = sha(buf); blobs.set(id, buf); return id; };

  const sysIds = [put(jsonBlob({ role: "system", content: sysText })), put(jsonBlob({ role: "user", content: "<user_info>…</user_info>" }))];
  let t = createdAt;
  const turnIds = turns.map(({ user, userTs, steps }) => {
    const userId = put(userMsgBlob(user, `${crypto.randomUUID()}`, userTs));
    const stepIds = steps.map((s) => {
      t += 1000;
      if (s.kind === "thinking") return put(thinkingStepBlob(s.text, t));
      if (s.kind === "tool") return put(toolStepBlob(s.text));
      return put(assistantStepBlob(s.text, t));
    });
    return put(turnBlob(agentTurnBlob(userId, stepIds)));
  });
  const rootId = put(rootBlob({ sysIds, turnIds, cwdUri: `file://${cwd}`, cwdPath: cwd, branch: "main" }));

  const db = new DatabaseSync(join(dir, "store.db"));
  db.exec("PRAGMA user_version = 1; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
  const ins = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
  for (const [id, data] of blobs) ins.run(id, data);
  db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(
    Buffer.from(JSON.stringify({ agentId: sid, latestRootBlobId: rootId, name, createdAt, mode: "default", lastUsedModel: "Auto" }), "utf8").toString("hex"),
  );
  db.close();
}

function writeSummary(dir, { sid, createdAt, updatedAt, cwd, title, hasConversation = true }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: createdAt, hasConversation, updatedAtMs: updatedAt, cwd, ...(title ? { title } : {}) }));
}

function writeTranscript(root, slug, sid, lines) {
  const d = join(root, "projects", slug, "agent-transcripts", sid);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const trUser = (q) => ({ role: "user", message: { content: [{ type: "text", text: `<timestamp>Sat, 2026</timestamp>\n<user_query>\n${q}\n</user_query>` }] } });
const trAsst = (t) => ({ role: "assistant", message: { content: [{ type: "text", text: t }] } });

/** 独立 fixture 根（CURSOR_CONFIG_DIR 隔离），返回后须 unset */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "cursor-cli-store-test-"));
  process.env.CURSOR_CONFIG_DIR = root;
  return root;
}
const uuid = () => crypto.randomUUID();
const SID = "1c11c704-4dfd-4717-a3a4-76340dc14c21"; // 固定形似真身的 id

// ── tests ───────────────────────────────────────────────────────────────────

test("decode: 完整 blob 图（多轮/思考/工具/时间戳/元数据）", () => {
  const root = makeRoot();
  try {
    const ws = join(root, "chats", "aa01");
    const createdAt = 1_787_000_000_000;
    buildStoreDb(join(ws, SID), {
      sid: SID, name: "Hello Fixture", createdAt, cwd: "/work/proj",
      turns: [
        { user: "hello world", userTs: createdAt + 10, steps: [
          { kind: "thinking", text: "用户打了个招呼" },
          { kind: "assistant", text: "Hi there" },
        ] },
        { user: "run ls", userTs: createdAt + 100, steps: [
          { kind: "tool", text: "Ran `ls -la`" },
          { kind: "assistant", text: "done" },
        ] },
      ],
    });
    writeSummary(join(ws, SID), { sid: SID, createdAt, updatedAt: createdAt + 999, cwd: "/work/proj", title: "Hello Fixture" });

    const s = readCursorCliChat(SID);
    assert.ok(s, "session decoded");
    assert.equal(s.name, "Hello Fixture");
    assert.equal(s.cwd, "/work/proj");
    assert.equal(s.mode, "default");
    assert.equal(s.messages.length, 4);
    assert.deepEqual(s.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(s.messages[0].text, "hello world");
    assert.equal(s.messages[0].ts, new Date(createdAt + 10).toISOString());
    assert.equal(s.messages[1].text, "💭 用户打了个招呼\nHi there");
    assert.equal(s.messages[2].text, "run ls");
    assert.equal(s.messages[3].text, "🛠 Ran `ls -la`\ndone");
    assert.equal(listCursorCliChats().length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); delete process.env.CURSOR_CONFIG_DIR; }
});

test("fork 去重：同 sid 双 workspaceKey 目录取最近更新", () => {
  const root = makeRoot();
  try {
    const old = join(root, "chats", "ws-old", SID);
    const neu = join(root, "chats", "ws-new", SID);
    buildStoreDb(old, { sid: SID, name: "Old Fork", createdAt: 1_000, cwd: "/old", turns: [{ user: "old msg", userTs: 1_100, steps: [{ kind: "assistant", text: "old reply" }] }] });
    writeSummary(old, { sid: SID, createdAt: 1_000, updatedAt: 1_500, cwd: "/old" });
    buildStoreDb(neu, { sid: SID, name: "New Fork", createdAt: 2_000, cwd: "/new", turns: [{ user: "new msg", userTs: 2_100, steps: [{ kind: "assistant", text: "new reply" }] }] });
    writeSummary(neu, { sid: SID, createdAt: 2_000, updatedAt: 9_000, cwd: "/new" });

    const all = listCursorCliChats();
    assert.equal(all.length, 1, "同 sid 去重为一个");
    const s = readCursorCliChat(SID);
    assert.equal(s.name, "New Fork");
    assert.equal(s.cwd, "/new");
    assert.equal(s.messages[0].text, "new msg");
  } finally { rmSync(root, { recursive: true, force: true }); delete process.env.CURSOR_CONFIG_DIR; }
});

test("jsonl 兑底：无 store.db / store.db 损坏 + user_query 解包", () => {
  const root = makeRoot();
  try {
    // ① 仅转录
    const d1 = join(root, "chats", "ws1", uuid());
    writeSummary(d1, { sid: uuid(), createdAt: 10, updatedAt: 20, cwd: "/t1" });
    writeTranscript(root, "t1", s1of(d1), [trUser("hi there"), trAsst("yo"), { type: "turn_ended", status: "success" }]);
    function s1of(dir) { return pathBasename(dir); } // path.basename：Windows join 产出反斜杠，split("/") 取不到末段
    const sid1 = s1of(d1);
    let s = readCursorCliChat(sid1);
    assert.ok(s, "transcript-only parsed");
    assert.deepEqual(s.messages.map((m) => m.text), ["hi there", "yo"]);
    assert.equal(s.cwd, "/t1");

    // ② store.db 损坏 → 落转录
    const sid2 = uuid();
    const d2 = join(root, "chats", "ws2", sid2);
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d2, "store.db"), Buffer.from("not a sqlite db at all"));
    writeSummary(d2, { sid: sid2, createdAt: 10, updatedAt: 20, cwd: "/t2" });
    writeTranscript(root, "t2", sid2, [trUser("fallback q"), trAsst("fallback a")]);
    s = readCursorCliChat(sid2);
    assert.ok(s, "corrupt db falls back");
    assert.deepEqual(s.messages.map((m) => m.text), ["fallback q", "fallback a"]);
  } finally { rmSync(root, { recursive: true, force: true }); delete process.env.CURSOR_CONFIG_DIR; }
});

test("hasConversation:false 与空目录不入列；adapter probe/list/parse 走通", () => {
  const root = makeRoot();
  try {
    const skip = join(root, "chats", "w0", uuid());
    writeSummary(skip, { sid: "x", createdAt: 1, updatedAt: 2, cwd: "/x", hasConversation: false });
    const ws = join(root, "chats", "w1");
    const sid = SID;
    buildStoreDb(join(ws, sid), { sid, name: "Adapter", createdAt: 5_000, cwd: "/adap", turns: [{ user: "q", userTs: 5_100, steps: [{ kind: "assistant", text: "a" }] }] });
    writeSummary(join(ws, sid), { sid, createdAt: 5_000, updatedAt: 5_200, cwd: "/adap" });

    const a = createCursorCliAdapter();
    assert.deepEqual(a.roots(), [join(root, "chats")]);
    const probe = a.probe();
    assert.equal(probe.ok, true);
    assert.equal(probe.count, 1);
    const refs = a.list();
    assert.equal(refs.length, 1);
    assert.equal(refs[0].sid, sid);
    const parsed = a.parse(refs[0]);
    assert.ok(parsed);
    assert.equal(parsed.meta.name, "Adapter");
    assert.equal(parsed.meta.cwd, "/adap");
    assert.equal(parsed.meta.messageCount, 2);
    assert.equal(parsed.meta.firstMessage, "q");
    assert.equal(parsed.meta.lastMessage, "a");
  } finally { rmSync(root, { recursive: true, force: true }); delete process.env.CURSOR_CONFIG_DIR; }
});
