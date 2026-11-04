/**
 * session-manager M1/M2 lifecycle tests: adapter parse fixtures, syncExt
 * semantics (virtual paths, scoped GC), sources lifecycle, import idempotency.
 * Run: node --experimental-strip-types --test server/lifecycle.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 三目录对称（2026-09-13）：宿主注入的 configDir = <extRoot>/config；测试里的 temp 目录即 extRoot。 */
function cfgOf(root) {
  const c = join(root, "config");
  mkdirSync(c, { recursive: true });
  return c;
}

const { api } = await import("./api.ts");
const { runtime } = await import("./runtime.ts");
const { loadSourceStates } = await import("./ext-sources.ts");
const { writePiSession, encodeCwd } = await import("../lib/agents/to-pi.ts");

function req(url, method = "GET", body) {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

function makeCtx(dir) {
  return {
    configDir: cfgOf(dir),
    searchParams: new URLSearchParams(),
    core: {
      async listSessions() { return []; },
      async getRunningSessionIds() { return []; },
      async getHomeDir() { return join(dir, "home"); },
    },
  };
}

/** A synthetic adapter backed by temp files (jsonl claude-like shape). */
function makeFakeAdapter(rootDir) {
  const refs = [];
  const a = {
    id: "fakeag",
    label: "Fake Agent",
    roots: () => [rootDir],
    probe() {
      let count = 0, wm = 0;
      for (const r of refs) { count++; try { wm = Math.max(wm, statSync(r.path).mtimeMs); } catch {} }
      return { ok: true, count, watermarkMs: wm };
    },
    list() { return refs; },
    parse(ref) {
      let raw; try { raw = readFileSync(ref.path, "utf8"); } catch { return null; }
      const messages = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (!e.message) continue;
        messages.push({ entryId: `${messages.length + 1}`, role: e.message.role, ts: e.timestamp ?? null, text: e.message.content });
      }
      if (!messages.length) return null;
      return { meta: { path: ref.path, id: ref.sid, cwd: "/tmp/fake-proj", created: new Date().toISOString(), modified: new Date().toISOString(), messageCount: messages.length, firstMessage: messages[0].text, lastMessage: messages[messages.length - 1].text }, messages };
    },
  };
  function add(sid, lines) {
    const p = join(rootDir, `${sid}.jsonl`);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    refs.push({ sid, path: p });
  }
  return { a, add };
}

test("syncExt indexes fixture sessions and scoped GC drops vanished artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-lc-"));
  try {
    mkdirSync(join(dir, "root"));
    const idx = runtime(cfgOf(dir)).index;
    const rootDir = join(dir, "root");
    const fake = makeFakeAdapter(rootDir);
    // reuse cursor adapter object shape via direct syncExt with custom parse
    fake.add("s1", [{ message: { role: "user", content: "hello world" } }, { message: { role: "assistant", content: "hi there" } }]);
    const refs1 = [...fake.a.list()];
    const r1 = await idx.syncExt("fakeag", refs1, (r) => fake.a.parse(r));
    assert.equal(r1.indexed, 1);
    assert.equal(idx.extRows(["fakeag"]).length, 1);

    // unchanged file → no re-index
    const r2 = await idx.syncExt("fakeag", [...refs1], (r) => fake.a.parse(r));
    assert.equal(r2.indexed, 0);

    // artifact vanishes → scoped GC removes the row (other agents untouched)
    rmSync(refs1[0].path);
    await idx.syncExt("fakeag", refs1, (r) => fake.a.parse(r));
    assert.equal(idx.extRows(["fakeag"]).length, 0);
  } finally {
    try { runtime(cfgOf(dir)).index.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("to-pi writes pi v3 file with provenance and never overwrites", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-lc2-"));
  try {
    const parsed = {
      meta: { path: "/x/y.jsonl", id: "sid-1", cwd: "/tmp/proj-x", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T01:00:00Z", messageCount: 1, firstMessage: "q", lastMessage: "a" },
      messages: [{ entryId: "1", role: "user", ts: null, text: "q" }],
    };
    const home = join(dir, "home");
    const opts = { homeDir: home, agentId: "kimi", sourceSid: "abc", sourcePath: "/x/y.jsonl" };
    const r1 = writePiSession(parsed, opts);
    assert.ok(r1?.path.includes(encodeCwd("/tmp/proj-x")));
    const r2 = writePiSession(parsed, opts);
    // fresh uuid per call — dedup happens at API layer via extImports map
    assert.ok(r2 && r2.sessionId !== r1.sessionId);
    const line1 = JSON.parse(readFileSync(r1.path, "utf8").split("\n")[0]);
    assert.equal(line1.type, "session");
    assert.equal(line1.version, 3);
    assert.equal(line1.cwd, "/tmp/proj-x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("import is idempotent via extImports map", async () => {
  const { builtinAdapters } = await import("../lib/agents/registry.ts");
  const dir = mkdtempSync(join(tmpdir(), "sm-lc3-"));
  try {
    runtime(cfgOf(dir));
    const ctx = makeCtx(dir);
    // pick a real source with data (claude); skip when absent
    const claude = builtinAdapters().find((a) => a.id === "claude");
    if (!claude || !claude.probe().ok) return;
    const post = (path, body) => api(req("http://x/", "POST", body), { ...ctx, path });
    await post(["sources", "activate"], { agent: "claude" });
    const merged = await (await api(req("http://x/"), { ...ctx, path: ["sessions"] })).json();
    const target = merged.sessions.find((x) => x.agent === "claude");
    assert.ok(target, "expected a claude row");
    const first = await (await post(["import"], { id: target.id })).json();
    assert.ok(first.sessionId);
    const second = await (await post(["import"], { id: target.id })).json();
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.alreadyImported, true);
  } finally {
    try { runtime(cfgOf(dir)).index.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ext hide/unhide: view-level archive survives sync, delete refused (always recoverable)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-lc4-"));
  try {
    mkdirSync(join(dir, "root"));
    const idx = runtime(cfgOf(dir)).index;
    const fake = makeFakeAdapter(join(dir, "root"));
    fake.add("s1", [{ message: { role: "user", content: "q" } }, { message: { role: "assistant", content: "a" } }]);
    const refs = fake.a.list();
    await idx.syncExt("fakeag", refs, (r) => fake.a.parse(r));
    const id = "fakeag:s1";
    assert.equal(idx.extRows(["fakeag"]).length, 1);

    const ctx = makeCtx(dir);
    const post = (path, body) => api(req("http://x/", "POST", body), { ...ctx, path });

    // hide → row leaves live extRows, lands archived with __ext__ ref, path kept (sync GC alive-by-file)
    const r1 = await (await post(["archive", "ext"], { sessionId: id, hidden: true })).json();
    assert.ok(r1.ok);
    assert.equal(idx.extRows(["fakeag"]).length, 0);
    const row = idx.getSession(id);
    assert.equal(row.archived, 1);
    assert.equal(row.archiveRef, "__ext__");
    assert.ok(row.path, "path must survive hide (ext sync GC judges liveness by it)");

    // re-sync: upsert keeps archived state (conflict update touches metadata only), GC keeps the row
    await idx.syncExt("fakeag", refs, (r) => fake.a.parse(r));
    assert.equal(idx.getSession(id).archived, 1);

    // archived viewer endpoint for an ext-archived row reads through the adapter
    //（用真实 builtin zcode adapter + AITI_ZCODE_HOME fixture 库走完整链路）
    const { DatabaseSync } = await import("node:sqlite");
    const zhome = join(dir, "zc-home");
    mkdirSync(join(zhome, "cli", "db"), { recursive: true });
    const zdb = new DatabaseSync(join(zhome, "cli", "db", "db.sqlite"));
    zdb.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)");
    zdb.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, time_created INTEGER, data TEXT)");
    zdb.exec("CREATE TABLE part (message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT)");
    zdb.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("sessfix", "/p", "fixture title", 1700000000000, 1700000100000);
    zdb.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("m1", "sessfix", 0, 1700000000000, JSON.stringify({ role: "user", time: {} }));
    zdb.prepare("INSERT INTO part VALUES (?,?,?,?)").run("m1", "sessfix", 0, JSON.stringify({ type: "text", text: "hello zcode" }));
    zdb.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("m2", "sessfix", 1, 1700000001000, JSON.stringify({ role: "assistant", providerID: "zai", modelID: "glm-4", time: {} }));
    zdb.prepare("INSERT INTO part VALUES (?,?,?,?)").run("m2", "sessfix", 0, JSON.stringify({ type: "text", text: "hi there" }));
    zdb.close();
    const prevZcodeHome = process.env.AITI_ZCODE_HOME;
    process.env.AITI_ZCODE_HOME = zhome;
    try {
      const { builtinAdapters } = await import("../lib/agents/registry.ts");
      const zc = builtinAdapters().find((a) => a.id === "zcode");
      const zrefs = await zc.list();
      await idx.syncExt("zcode", zrefs, (r) => zc.parse(r));
      const zid = "zcode:sessfix";
      await post(["archive", "ext"], { sessionId: zid, hidden: true });
      const viewer = await api(req("http://x/"), { ...ctx, path: ["archive", "session", zid] });
      assert.equal(viewer.status, 200);
      const vd = await viewer.json();
      assert.equal(vd.session.id, zid);
      assert.ok(vd.messages.length >= 2, "messages read through the zcode adapter");
    } finally {
      if (prevZcodeHome === undefined) delete process.env.AITI_ZCODE_HOME;
      else process.env.AITI_ZCODE_HOME = prevZcodeHome;
    }

    // unhide → back to live
    const r2 = await (await post(["archive", "ext"], { sessionId: id, hidden: false })).json();
    assert.ok(r2.ok);
    assert.equal(idx.getSession(id).archived, 0);

    // delete permanently → refused for ext rows (view-level removal is always recoverable)
    await post(["archive", "ext"], { sessionId: id, hidden: true });
    const del = await post(["archive", "delete"], { sessionId: id });
    assert.equal(del.status, 404, "ext-archived row must not be deletable");
    assert.ok(idx.getSession(id), "row survives the delete attempt");
    // source-side change (user keeps chatting in ZCode) → upsert keeps archived state, never resurrects as live
    const refPath = refs[0].path;
    writeFileSync(refPath, JSON.stringify({ message: { role: "user", content: "more" } }) + "\n" + JSON.stringify({ message: { role: "assistant", content: "reply" } }) + "\n");
    await idx.syncExt("fakeag", refs, (r) => fake.a.parse(r));
    assert.ok(idx.getSession(id), "row still indexed");
    assert.equal(idx.getSession(id).archived, 1, "still archived after source change (no resurrection)");
  } finally {
    try { runtime(cfgOf(dir)).index.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heal: syncExt re-indexes a row deleted out-of-band while file watermark survives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-heal1-"));
  try {
    mkdirSync(join(dir, "root"));
    const idx = runtime(cfgOf(dir)).index;
    const fake = makeFakeAdapter(join(dir, "root"));
    fake.add("s1", [{ message: { role: "user", content: "hello world" } }]);
    const refs = fake.a.list();
    await idx.syncExt("fakeag", refs, (r) => fake.a.parse(r));
    assert.equal(idx.extRows(["fakeag"]).length, 1);

    // out-of-band deletion (row gone, file + watermark intact)
    idx.removeSession("fakeag:s1");
    assert.equal(idx.extRows(["fakeag"]).length, 0);

    // next sync must rebuild the row despite the unchanged file
    const r = await idx.syncExt("fakeag", refs, (r) => fake.a.parse(r));
    assert.equal(r.indexed, 1);
    const rows = idx.extRows(["fakeag"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "fakeag:s1");
  } finally {
    try { runtime(cfgOf(dir)).index.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("heal: sync() rebuilds orphan placeholder row and GC keeps rows whose file still exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-heal2-"));
  try {
    const rootDir = join(dir, "sessions");
    mkdirSync(rootDir);
    const phPath = join(rootDir, "ph.jsonl");
    writeFileSync(phPath,
      JSON.stringify({ type: "session", version: 3, id: "uuid-ph", timestamp: "2026-09-08T00:00:00Z", cwd: "/p", agent: "zcode", extId: "zcode:sess_ph" }) + "\n" +
      JSON.stringify({ type: "session_info", name: "t", importedFrom: "zcode:sess_ph", external: true }) + "\n");
    const idx = runtime(cfgOf(dir)).index;
    await idx.sync([{ path: phPath, id: "uuid-ph", cwd: "/p" }]);
    assert.ok(idx.getSession("uuid-ph"), "initially indexed");

    // simulate the production incident: row deleted, files watermark retained
    idx.removeSession("uuid-ph");
    await idx.sync([{ path: phPath, id: "uuid-ph", cwd: "/p" }]); // unchanged pass
    assert.ok(idx.getSession("uuid-ph"), "self-healed on next sync");

    // GC guard: a list that omits the file must NOT delete the row while the file exists
    await idx.sync([]);
    assert.ok(idx.getSession("uuid-ph"), "kept despite missing-from-list (file exists)");

    // real deletion still GCs
    rmSync(phPath);
    await idx.sync([]);
    assert.ok(!idx.getSession("uuid-ph"), "removed once the file is truly gone");
  } finally {
    try { runtime(cfgOf(dir)).index.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
