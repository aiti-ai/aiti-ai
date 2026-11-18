/**
 * pi-session-search — data layer tests (file source + db source + tool wiring).
 *
 * Run: node --experimental-strip-types --test pi-session-search/test/session-search.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const fileSource = await import("../src/lib/file-source.ts");
const dbSource = await import("../src/lib/db-source.ts");

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_B2 = "22229999-9999-4999-8999-999999999999";

function jsonl(id, cwd, turns) {
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-28T00:00:00.000Z", cwd })];
  for (const [i, t] of turns.entries()) {
    lines.push(JSON.stringify({
      type: "message", id: `m-${id.slice(0, 4)}-${i}`, timestamp: `2026-11-28T00:0${i}:00.000Z`,
      message: { role: t.role, content: [{ type: "text", text: t.text }] },
    }));
  }
  if (t2c(id)) lines.push(...t2c(id)); // extra raw entries (compaction etc.)
  return lines.join("\n") + "\n";
}

// A gets a compaction entry appended (raw messages must survive our readers)
function t2c(id) {
  if (!id.startsWith("1111")) return null;
  return [JSON.stringify({ type: "compaction", id: "cmp1", timestamp: "2026-11-28T00:09:00.000Z", summary: "## Goal\n…", firstKeptEntryId: "m-1111-2" })];
}

async function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "pss-"));
  const projA = join(dir, "proj-a");
  const projB = join(dir, "proj-b");
  mkdirSync(projA, { recursive: true });
  mkdirSync(projB, { recursive: true });
  writeFileSync(join(projA, "sA.jsonl"), jsonl(ID_A, "/home/x/proj-a", [
    { role: "user", text: "帮我实现 ddns 的 mock 验证脚本" },
    { role: "assistant", text: "好的，我用 node 写 verify-all.mjs，覆盖四个运营商解析：阿里 DNS、DNSPod、华为云、Cloudflare 各自的 API 基线完全不一样，鉴权方式、分页参数、TTL 生效时间都有差异，所以脚本里分别封装 client，统一输出结构和退出码，方便 CI 直接消费结果并打印每一步耗时。另外脚本支持 --only 参数只跑指定运营商，失败时自动重试一次并记录每次请求的原始响应体到 cache 目录，方便事后排查签名错误和限流问题，整体验证流程保持幂等，可以反复跑而不污染线上配置。" },
    { role: "user", text: "压缩前的重要决定：域名解析走 dnspod API" },
  ]));
  writeFileSync(join(projB, "sB.jsonl"), jsonl(ID_B, "/home/x/proj-b", [
    { role: "user", text: "resize the image to 400px" },
    { role: "assistant", text: "done" },
  ]));
  writeFileSync(join(projB, "sB2.jsonl"), jsonl(ID_B2, "/home/x/proj-b", [
    { role: "user", text: "另一个以 22 开头的会话，谈论 resize 逻辑" },
  ]));
  return dir;
}

// ── file source ──────────────────────────────────────────────────────────────

test("file: listSessionFiles sniffs headers, newest first", async () => {
  const dir = await fixtureDir();
  try {
    const files = await fileSource.listSessionFiles(dir);
    assert.equal(files.length, 3);
    const a = files.find((f) => f.id === ID_A);
    assert.equal(a.cwd, "/home/x/proj-a");
    assert.ok(a.path.endsWith("sA.jsonl"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("file: searchFiles keyword / role / ids-narrowing / early stop", async () => {
  const dir = await fixtureDir();
  try {
    const all = await fileSource.searchFiles(dir, "dnspod");
    assert.equal(all.length, 1); // only A mentions dnspod among pi files
    assert.equal(all[0].sessionId, ID_A);
    assert.equal(all[0].role, "user");
    assert.ok(all[0].text.includes("dnspod"));
    assert.ok(all[0].entryId.startsWith("m-1111"));

    assert.equal((await fileSource.searchFiles(dir, "resize")).length, 2); // B + B2
    const narrowed = await fileSource.searchFiles(dir, "resize", { sessionIds: [ID_A, ID_B] });
    assert.deepEqual(narrowed.map((h) => h.sessionId), [ID_B]); // A has no "resize"
    assert.deepEqual(await fileSource.searchFiles(dir, "resize", { sessionIds: [ID_A] }), []);
    const users = await fileSource.searchFiles(dir, "resize", { role: "user" });
    assert.ok(users.every((h) => h.role === "user"));
    assert.equal((await fileSource.searchFiles(dir, "dnspod", { limit: 1 })).length, 1);
    assert.deepEqual(await fileSource.searchFiles(dir, "  "), []); // blank → no-op
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("file: readSessionFile role / paging / truncation / entry anchor / compaction skipped", async () => {
  const dir = await fixtureDir();
  try {
    const path = join(dir, "proj-a", "sA.jsonl");
    const def = await fileSource.readSessionFile(path, { role: "user" });
    assert.equal(def.total, 2); // compaction entry not counted
    assert.deepEqual(def.messages.map((m) => m.role), ["user", "user"]);
    assert.ok(def.messages[0].text.includes("mock 验证脚本"));

    const all = await fileSource.readSessionFile(path);
    assert.equal(all.total, 3);

    const page = await fileSource.readSessionFile(path, { role: "all", limit: 1, offset: 2 });
    assert.ok(page.messages[0].text.includes("压缩前的重要决定"));

    const tiny = await fileSource.readSessionFile(path, { role: "assistant", maxChars: 200 });
    assert.equal(tiny.messages[0].truncated, true);
    assert.ok(tiny.messages[0].text.endsWith("…[truncated]"));

    const anchor = await fileSource.readSessionFile(path, { entryId: "m-1111-2" });
    assert.equal(anchor.messages.length, 1);
    assert.ok(anchor.messages[0].text.includes("dnspod"));

    assert.equal(await fileSource.readSessionFile(join(dir, "nope.jsonl")), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("file: current-session helpers (live entries via sessionManager stub)", () => {
  const entries = [
    { type: "session", id: "hdr" },
    { type: "message", id: "m0", timestamp: "2026-11-28T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "初始需求：做一个限流器" }] } },
    { type: "compaction", id: "cmp", summary: "…summary…" },
    { type: "message", id: "m1", timestamp: "2026-11-28T00:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "用令牌桶实现限流器：容量一百、每秒补充二十个令牌，允许最多十个突发请求排队等待，超出部分直接拒绝并返回 429，同时把每次拒绝的时间戳和剩余令牌数写进指标，方便观察限流窗口的真实流量分布，再配一个内存版的滑动窗口计数器做兜底校验，保证两种实现的结果一致后才上线。用令牌桶实现限流器：容量一百、每秒补充二十个令牌，允许最多十个突发请求排队等待，超出部分直接拒绝并返回 429，同时把每次拒绝的时间戳和剩余令牌数写进指标，方便观察限流窗口的真实流量分布，再配一个内存版的滑动窗口计数器做兜底校验，保证两种实现的结果一致后才上线。" }] } },
  ];
  const ctx = { sessionManager: { getEntries: () => entries, getSessionId: () => ID_A, getCwd: () => "/p/a" } };
  const res = fileSource.readCurrentEntries(ctx);
  assert.equal(res.total, 2); // compaction summary never surfaces as a message
  assert.deepEqual(res.messages.map((m) => m.entryId), ["m0", "m1"]);
  assert.equal(res.sessionId, ID_A);

  const users = fileSource.readCurrentEntries(ctx, { role: "user" });
  assert.equal(users.total, 1);
  const truncated = fileSource.readCurrentEntries(ctx, { role: "assistant", maxChars: 200 });
  assert.equal(truncated.messages[0].truncated, true);

  const hits = fileSource.searchCurrent(ctx, "令牌桶");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entryId, "m1");
  assert.deepEqual(fileSource.searchCurrent(ctx, "不存在"), []);
});

test("tools: cwdPrefix filters during scan + ambiguous array refs error (file mode)", async () => {
  const dir = await fixtureDir();
  process.env.PI_CODING_AGENT_SESSION_DIR = dir;
  process.env.PI_SESSION_SEARCH_DB = "off";
  try {
    const registered = { tools: [] };
    const pi = { registerTool: (t) => registered.tools.push(t), registerCommand: () => {}, on: () => {} };
    const mod = await import("../src/index.ts");
    mod.default(pi);
    const ctx = { sessionManager: { getEntries: () => [], getSessionId: () => "cur", getCwd: () => "/p", getSessionDir: () => dir } };
    // dnspod only in proj-a; cwd=proj-b → empty (filtered during the scan, before limit)
    const noHit = await registered.tools[0].execute("t1", { q: "dnspod", cwd: "/home/x/proj-b" }, null, null, ctx);
    assert.ok(noHit.content[0].text.includes("no session matched"));
    // ambiguous prefix via array scope → explicit error (contract parity with db source)
    const amb = await registered.tools[0].execute("t2", { q: "resize", scope: ["2222"] }, null, null, ctx);
    assert.equal(amb.isError, true);
    assert.ok(amb.content[0].text.includes("ambiguous"));
    // unique prefix resolves
    const uniq = await registered.tools[0].execute("t3", { q: "dnspod", scope: ["1111"] }, null, null, ctx);
    assert.ok(uniq.content[0].text.includes(ID_A));
  } finally {
    dbSource.closeDb();
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    delete process.env.PI_SESSION_SEARCH_DB;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── db source (session-manager index snapshot, readOnly) ─────────────────────

function makeFixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, path TEXT, cwd TEXT NOT NULL, name TEXT, created TEXT NOT NULL, modified TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, first_message TEXT NOT NULL DEFAULT '', last_message TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, archive_ref TEXT, agent TEXT NOT NULL DEFAULT 'pi', ext_id TEXT, parent_sid TEXT);
    CREATE TABLE messages (session_id TEXT NOT NULL, entry_id TEXT NOT NULL, role TEXT NOT NULL, ts TEXT, model TEXT, provider TEXT, tool_name TEXT, text TEXT NOT NULL, PRIMARY KEY (session_id, entry_id));
    CREATE VIRTUAL TABLE fts USING fts5(session_id UNINDEXED, role UNINDEXED, text, tokenize='trigram');
  `);
  db.prepare("INSERT INTO sessions (id, path, cwd, name, created, modified, agent) VALUES (?,?,?,?,?,?,?)")
    .run(ID_A, join(dbPath, "..", "sA.jsonl"), "/home/x/proj-a", null, "2026-11-28T00:00:00.000Z", "2026-11-28T00:05:00.000Z", "pi");
  const ins = db.prepare("INSERT INTO messages (session_id, entry_id, role, ts, text) VALUES (?,?,?,?,?)");
  const fts = db.prepare("INSERT INTO fts (session_id, role, text) VALUES (?,?,?)");
  ins.run(ID_A, "m-1111-0", "user", "2026-11-28T00:01:00.000Z", "帮我实现 ddns 的 mock 验证脚本");
  fts.run(ID_A, "user", "帮我实现 ddns 的 mock 验证脚本");
  ins.run(ID_A, "m-1111-1", "assistant", "2026-11-28T00:02:00.000Z", "好的，写 verify-all.mjs：四个运营商各自封装 client，统一输出结构与退出码，失败自动重试一次，原始响应体落 cache 目录，整体幂等可反复运行而不污染线上配置，CI 直接消费结果并打印每一步耗时。好的，写 verify-all.mjs：四个运营商各自封装 client，统一输出结构与退出码，失败自动重试一次，原始响应体落 cache 目录，整体幂等可反复运行而不污染线上配置，CI 直接消费结果并打印每一步耗时。");
  fts.run(ID_A, "assistant", "好的，写 verify-all.mjs：四个运营商各自封装 client，统一输出结构与退出码，失败自动重试一次，原始响应体落 cache 目录，整体幂等可反复运行而不污染线上配置，CI 直接消费结果并打印每一步耗时。好的，写 verify-all.mjs：四个运营商各自封装 client，统一输出结构与退出码，失败自动重试一次，原始响应体落 cache 目录，整体幂等可反复运行而不污染线上配置，CI 直接消费结果并打印每一步耗时。");
    ins.run(ID_A, "m-1111-2", "user", "2026-11-28T00:03:00.000Z", "压缩前的重要决定：域名解析走 dnspod API");
  fts.run(ID_A, "user", "压缩前的重要决定：域名解析走 dnspod API");
  db.prepare("INSERT INTO sessions (id, path, cwd, name, created, modified, agent) VALUES (?,?,?,?,?,?,?)")
    .run(`claude:cccc`, "service:claude:cccc", "/home/x/proj-a", "claude fix", "2026-11-27T00:00:00.000Z", "2026-11-27T01:00:00.000Z", "claude");
  ins.run("claude:cccc", "ce0", "user", "2026-11-27T00:30:00.000Z", "fix the dnspod retry loop");
  fts.run("claude:cccc", "user", "fix the dnspod retry loop");
  db.close();
}

test("db: openDb via PI_SESSION_SEARCH_DB + searchSessions all/agents/ids/short-query", () => {
  const dir = mkdtempSync(join(tmpdir(), "pss-db-"));
  const dbPath = join(dir, "index.sqlite");
  makeFixtureDb(dbPath);
  process.env.PI_SESSION_SEARCH_DB = dbPath;
  try {
    const handle = dbSource.openDb();
    assert.ok(handle, "fixture db should open");
    assert.equal(handle.snapshotMtime !== "", true);

    const all = dbSource.searchSessionsDb(handle, "dnspod");
    assert.deepEqual(all.map((h) => h.sessionId).sort(), [ID_A, "claude:cccc"].sort());
    assert.deepEqual(dbSource.searchSessionsDb(handle, "dnspod", { agents: ["pi"] }).map((h) => h.sessionId), [ID_A]);
    assert.deepEqual(dbSource.searchSessionsDb(handle, "dnspod", { agents: ["claude"] }).map((h) => h.sessionId), ["claude:cccc"]);
    assert.deepEqual(dbSource.searchSessionsDb(handle, "dnspod", { sessionIds: [ID_A] }).map((h) => h.sessionId), [ID_A]);
    assert.equal(dbSource.searchSessionsDb(handle, "dnspod", { sessionIds: ["nope"] }).length, 0);
    assert.equal(dbSource.searchSessionsDb(handle, "dnspod", { role: "assistant" }).length, 0); // only users mention dnspod
    const short = dbSource.searchSessionsDb(handle, "dn");
    assert.equal(short.length, 2); // 2-char LIKE fallback hits both sessions

    const refs = dbSource.resolveRefsDb(handle, [ID_A, "1111", "2222", "ffffffff"]);
    assert.deepEqual(refs.ids, [ID_A]); // unique prefix resolves; ambiguous/unknown → unresolved
    assert.deepEqual(refs.unresolved, ["2222", "ffffffff"]);
  } finally {
    dbSource.closeDb();
    delete process.env.PI_SESSION_SEARCH_DB;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db: sessionMessagesDb read paths + ref miss → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "pss-db2-"));
  const dbPath = join(dir, "index.sqlite");
  makeFixtureDb(dbPath);
  process.env.PI_SESSION_SEARCH_DB = dbPath;
  try {
    const handle = dbSource.openDb();
    const def = dbSource.sessionMessagesDb(handle, ID_A, { role: "user" });
    assert.equal(def.total, 2);
    assert.deepEqual(def.messages.map((m) => m.entryId), ["m-1111-0", "m-1111-2"]);
    const all = dbSource.sessionMessagesDb(handle, ID_A);
    assert.equal(all.total, 3);
    const page = dbSource.sessionMessagesDb(handle, ID_A, { role: "all", limit: 1, offset: 2 });
    assert.ok(page.messages[0].text.includes("压缩前"));
    const tiny = dbSource.sessionMessagesDb(handle, ID_A, { role: "assistant", maxChars: 200 });
    assert.equal(tiny.messages[0].truncated, true);
    const anchor = dbSource.sessionMessagesDb(handle, ID_A, { entryId: "m-1111-2" });
    assert.ok(anchor.messages[0].text.includes("dnspod"));
    assert.equal(dbSource.sessionMessagesDb(handle, "ffffffff"), null);
    assert.equal(dbSource.sessionMessagesDb(handle, "2222"), null); // only one session in fixture → prefix "2222" actually resolves... no: ID_A starts 1111
  } finally {
    dbSource.closeDb();
    delete process.env.PI_SESSION_SEARCH_DB;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── tool wiring (fake pi host + fake sessionManager ctx) ─────────────────────

test("tools: register + execute session_search/session_read against file source & current scope", async () => {
  const dir = await fixtureDir();
  process.env.PI_CODING_AGENT_SESSION_DIR = dir;
  process.env.PI_SESSION_SEARCH_DB = "off"; // isolate from the real machine's index dbs
  try {
    const registered = { tools: [], commands: [], handlers: {} };
    const pi = {
      registerTool: (t) => registered.tools.push(t),
      registerCommand: (name, def) => registered.commands.push({ name, def }),
      on: (ev, h) => { registered.handlers[ev] = h; },
    };
    const mod = await import("../src/index.ts");
    mod.default(pi);
    assert.deepEqual(registered.tools.map((t) => t.name), ["session_search", "session_read"]);
    assert.ok(registered.commands[0].name === "session-search");

    const ctx = { sessionManager: { getEntries: () => [
      { type: "message", id: "m0", timestamp: "2026-11-28T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "当前会话里的令牌桶需求" }] } },
    ], getSessionId: () => "cur-sess", getCwd: () => "/p/a", getSessionDir: () => dir } };

    // scope="current" → live entries
    const cur = await registered.tools[0].execute("t1", { q: "令牌桶", scope: "current" }, null, null, ctx);
    assert.ok(cur.content[0].text.includes("current session, live"));
    assert.ok(cur.content[0].text.includes("令牌桶"));

    // default scope="all" → db disabled ("off") → file scan
    const hit = await registered.tools[0].execute("t2", { q: "dnspod" }, null, null, ctx);
    assert.ok(hit.content[0].text.includes("live scan"));
    assert.ok(hit.content[0].text.includes(ID_A));

    // read current
    const rcur = await registered.tools[1].execute("t3", { session: "current" }, null, null, ctx);
    assert.ok(rcur.content[0].text.includes("令牌桶需求"));

    // read by uuid from files
    const rfile = await registered.tools[1].execute("t4", { session: ID_A }, null, null, ctx);
    assert.ok(rfile.content[0].text.includes("mock 验证脚本"));

    // read error path
    const bad = await registered.tools[1].execute("t5", { session: "zzzzzz-not-here" }, null, null, ctx);
    assert.equal(bad.isError, true);
  } finally {
    dbSource.closeDb();
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    delete process.env.PI_SESSION_SEARCH_DB;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- enrich（docs/pi-session-search-enrich-tags-plan.md §4.3/§4.5） ----------

const enrichMod = await import("../src/lib/enrich.ts");

function fixtureDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), "pss-enrich-"));
  mkdirSync(join(dataDir, "session-manager", "config"), { recursive: true });
  mkdirSync(join(dataDir, "aiti-plan-first", "config"), { recursive: true });
  writeFileSync(join(dataDir, "session-manager", "config", "session-tags.json"), JSON.stringify({
    version: 1, favoriteIds: [],
    tags: [
      { id: "t1", name: "项目A", color: "#ef4444", parentId: null, sortOrder: 0, createdAt: "" },
      { id: "t2", name: "todo", color: "#f59e0b", parentId: "t1", sortOrder: 0, createdAt: "" },
      { id: "t3", name: "urgent", color: "#ef4444", parentId: null, sortOrder: 1, createdAt: "" },
    ],
    sessionTags: { [ID_A]: ["t2"], [ID_B]: ["t3"] },
  }));
  const planMd = join(dataDir, "plan.md");
  writeFileSync(planMd, "---\ntags: [方案, aiti-dev, 方案/评审中]\nstatus: 方案/评审中\n---\n\n# 标题\n正文");
  const planMdNoFm = join(dataDir, "plain.md");
  writeFileSync(planMdNoFm, "# 没有 front-matter 的文档\n正文");
  writeFileSync(join(dataDir, "aiti-plan-first", "config", "plans.json"), JSON.stringify({
    version: 1,
    sessions: { [ID_A]: { plan: planMd, planRel: "plan.md" }, [ID_B]: { plan: planMdNoFm }, [ID_B2]: { plan: null } },
  }));
  return dataDir;
}

test("enrich: parseFmTags/statusPhaseOf/readMdFmTags（正常/无 fm/坏文件/截断）", () => {
  assert.deepEqual(enrichMod.parseFmTags("---\ntags: [方案, aiti-dev]\n---\n正文"), ["方案", "aiti-dev"]);
  assert.deepEqual(enrichMod.parseFmTags("---\ntags:\n  - a\n  - b\n---\n"), ["a", "b"]);
  assert.deepEqual(enrichMod.parseFmTags("# 无 fm"), []);
  assert.deepEqual(enrichMod.parseFmTags("---\ntags: [未闭合"), []); // unclosed fm → []
  assert.equal(enrichMod.statusPhaseOf(["方案", "方案/评审中"]), "方案/评审中"); // first plan/* item wins
  assert.equal(enrichMod.statusPhaseOf(["方案"]), null);

  const dir = fixtureDataDir();
  try {
    const good = enrichMod.readMdFmTags(join(dir, "plan.md"));
    assert.deepEqual(good, { fmTags: ["方案", "aiti-dev", "方案/评审中"], statusPhase: "方案/评审中" });
    assert.deepEqual(enrichMod.readMdFmTags(join(dir, "plain.md")), { fmTags: [], statusPhase: null });
    assert.deepEqual(enrichMod.readMdFmTags(join(dir, "missing.md")), { fmTags: [], statusPhase: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("enrich: loadTagPaths/loadPlanRows/enrichLines + 降级", () => {
  const dir = fixtureDataDir();
  try {
    const sids = new Set([ID_A, ID_B, ID_B2]);
    assert.deepEqual(enrichMod.loadTagPaths(dir, sids).get(ID_A), "tags: 项目A/todo");
    assert.deepEqual(enrichMod.loadTagPaths(dir, sids).get(ID_B), "tags: urgent");
    const rows = enrichMod.loadPlanRows(dir, sids);
    assert.deepEqual(rows.get(ID_A), { path: join(dir, "plan.md"), fmTags: ["方案", "aiti-dev", "方案/评审中"], statusPhase: "方案/评审中" });
    assert.deepEqual(rows.get(ID_B), { path: join(dir, "plain.md"), fmTags: [], statusPhase: null });
    assert.equal(rows.has(ID_B2), false); // plan=null → no binding

    const lines = enrichMod.enrichLines([ID_A, ID_B], dir);
    assert.equal(lines.get(ID_A), `tags: 项目A/todo\nplan: ${join(dir, "plan.md")} [方案, aiti-dev]（状态: 方案/评审中）`);
    assert.equal(lines.get(ID_B), `tags: urgent\nplan: ${join(dir, "plain.md")}`);
    assert.deepEqual([...enrichMod.enrichLines([ID_A], null)], []); // no dataDir → empty
    assert.deepEqual([...enrichMod.enrichLines([], dir)], []);
    // broken json → degrade to empty
    writeFileSync(join(dir, "aiti-plan-first", "config", "plans.json"), "{broken");
    assert.deepEqual([...enrichMod.loadPlanRows(dir, sids)], []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("enrich: resolveDataDir（dbPath 反推优先 / env 候选 / 无标记目录回落）", () => {
  const dir = fixtureDataDir();
  mkdirSync(join(dir, "session-manager", "cache"), { recursive: true });
  const dbPath = join(dir, "session-manager", "cache", "index.sqlite");
  writeFileSync(dbPath, "");
  const emptyDir = mkdtempSync(join(tmpdir(), "pss-empty-dd-")); // exists but no marker files
  try {
    assert.equal(enrichMod.resolveDataDir(dbPath, { PI_WEB_DATA_DIR: "" }), dir); // db path derivation wins
    assert.equal(enrichMod.resolveDataDir(undefined, { PI_WEB_DATA_DIR: dir }), dir); // env candidate hit
    assert.notEqual(enrichMod.resolveDataDir(undefined, { PI_WEB_DATA_DIR: emptyDir }), emptyDir); // no markers → falls back, never picks it
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("enrich: killswitchBlocksRegistration（宿主 env + enabled:false/true/缺文件/坏 json/非宿主进程）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pss-ks-"));
  const smCfg = join(dir, "session-manager", "config");
  mkdirSync(smCfg, { recursive: true });
  const ks = join(smCfg, "config.json");
  try {
    // non-pi-web process (no PI_WEB_* env at all) → never blocked, even with the file present
    writeFileSync(ks, JSON.stringify({ agentTools: { enabled: true } }));
    assert.equal(enrichMod.killswitchBlocksRegistration({}), false);
    assert.equal(enrichMod.killswitchBlocksRegistration({ PI_WEB_DATA_DIR: dir }), true);
    // only other PI_WEB_* env (no PI_WEB_DATA_DIR) → host process but nothing to probe → not blocked
    assert.equal(enrichMod.killswitchBlocksRegistration({ PI_WEB_DEV_DIST: "1" }), false);

    writeFileSync(ks, JSON.stringify({ agentTools: { enabled: false } }));
    assert.equal(enrichMod.killswitchBlocksRegistration({ PI_WEB_DATA_DIR: dir }), false);
    writeFileSync(ks, "{}"); // missing agentTools key = not blocked
    assert.equal(enrichMod.killswitchBlocksRegistration({ PI_WEB_DATA_DIR: dir }), false);
    writeFileSync(ks, "{broken"); // broken json = not blocked
    assert.equal(enrichMod.killswitchBlocksRegistration({ PI_WEB_DATA_DIR: dir }), false);
    assert.equal(enrichMod.killswitchBlocksRegistration({ PI_WEB_DATA_DIR: join(tmpdir(), "pss-ks-missing") }), false); // dir missing
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tools: kill-switch 在场 → registerTool 让位（slash 命令保留）", async () => {
  const dir = await fixtureDir();
  const dataDir = mkdtempSync(join(tmpdir(), "pss-ks-reg-"));
  mkdirSync(join(dataDir, "session-manager", "config"), { recursive: true });
  writeFileSync(join(dataDir, "session-manager", "config", "config.json"), JSON.stringify({ agentTools: { enabled: true } }));
  process.env.PI_CODING_AGENT_SESSION_DIR = dir;
  process.env.PI_SESSION_SEARCH_DB = "off";
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const registered = { tools: [], commands: [] };
    const pi = {
      registerTool: (t) => registered.tools.push(t),
      registerCommand: (name, def) => registered.commands.push({ name, def }),
      on: () => {},
    };
    const mod = await import("../src/index.ts");
    mod.default(pi);
    assert.deepEqual(registered.tools, []); // yielded: no tools registered
    assert.deepEqual(registered.commands.map((c) => c.name), ["session-search"]); // human channel kept
  } finally {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    delete process.env.PI_SESSION_SEARCH_DB;
    delete process.env.PI_WEB_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
