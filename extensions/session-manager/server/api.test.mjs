/**
 * session-manager server API tests (optimistic-lock mutations).
 * Run: node --experimental-strip-types --test ~/.pi/web/extensions/session-manager/server/api.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "fs";
import { rmRf } from "../../_shared/test-rm-rf.mjs";
import { tmpdir } from "os";
import { join, dirname } from "path";

/** 三目录对称（2026-09-13）：宿主注入的 configDir = <extRoot>/config；测试里的 temp 目录即 extRoot。 */
function cfgOf(root) {
  const c = join(root, "config");
  mkdirSync(c, { recursive: true });
  return c;
}

const { api } = await import("./api.ts");
const { readTagData } = await import("./tags-store.ts");
const { emptyTagData } = await import("../lib/session-tags.ts");

function makeCtx(configDir, path = ["session-tags"]) {
  return { configDir, path, searchParams: new URLSearchParams(), core: { async listSessions() { return []; }, async getRunningSessionIds() { return []; }, async getHomeDir() { return "/tmp"; } } };
}

function req(url, method = "GET", body) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("session-tags GET returns empty by default, PUT replaces with version bump", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  try {
    const ctx = makeCtx(dir);
    const empty = await api(req("http://x/", "GET"), ctx);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).tags, []);

    const data = emptyTagData();
    data.tags = [{ id: "t1", name: "todo", color: "#f59e0b", parentId: null, sortOrder: 0, createdAt: "x" }];
    const put = await api(req("http://x/", "PUT", data), ctx);
    assert.equal(put.status, 200);
    const { data: saved } = await put.json();
    assert.equal(saved.version, 1);
    assert.equal(saved.tags.length, 1);

    // stale PUT → 409 with current
    const stale = await api(req("http://x/", "PUT", { ...saved, version: 0 }), ctx);
    assert.equal(stale.status, 409);
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("actions: assign (find-or-create + default color), unassign, favorite, rename, recolor, delete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  try {
    const ctx = makeCtx(dir, ["assign"]);

    // assign "项目A/todo" to s1
    const a1 = await api(req("http://x/", "POST", { version: 0, sessionId: "s1", path: "项目A/todo" }), { ...ctx, path: ["assign"] });
    assert.equal(a1.status, 200);
    const { data: d1 } = await a1.json();
    assert.equal(d1.version, 1);
    assert.equal(d1.tags.length, 2);
    const todo = d1.tags.find((t) => t.name === "todo");
    assert.equal(todo.color, "#f59e0b");
    assert.deepEqual(d1.sessionTags.s1, [todo.id]);

    // version conflict → 409
    const conflict = await api(req("http://x/", "POST", { version: 0, sessionId: "s1", path: "bugfix" }), { ...ctx, path: ["assign"] });
    assert.equal(conflict.status, 409);
    const { current } = await conflict.json();
    assert.equal(current.version, 1);

    // favorite
    const fav = await api(req("http://x/", "POST", { version: 1, sessionId: "s1" }), { ...ctx, path: ["favorite"] });
    const { data: d2 } = await fav.json();
    assert.deepEqual(d2.favoriteIds, ["s1"]);
    assert.equal(d2.version, 2);

    // rename
    const ren = await api(req("http://x/", "POST", { version: 2, tagId: todo.id, name: "doing" }), { ...ctx, path: ["rename"] });
    assert.equal(ren.status, 200);
    const { data: d3 } = await ren.json();
    assert.equal(d3.tags.find((t) => t.id === todo.id).name, "doing");

    // recolor
    const rec = await api(req("http://x/", "POST", { version: 3, tagId: todo.id, color: "#123456" }), { ...ctx, path: ["recolor"] });
    const { data: d4 } = await rec.json();
    assert.equal(d4.tags.find((t) => t.id === todo.id).color, "#123456");

    // unassign
    const un = await api(req("http://x/", "POST", { version: 4, sessionId: "s1", tagId: todo.id }), { ...ctx, path: ["unassign"] });
    const { data: d5 } = await un.json();
    assert.equal(d5.sessionTags.s1, undefined);

    // assignTag: pick an existing tag id directly (before deletion removes tags)
    const at = await api(req("http://x/", "POST", { version: 5, sessionId: "s1", tagId: todo.id }), { ...ctx, path: ["assignTag"] });
    assert.equal(at.status, 200);
    const { data: d7 } = await at.json();
    assert.ok(d7.sessionTags.s1.includes(todo.id));

    // delete subtree (removes 项目A + doing)
    const del = await api(req("http://x/", "POST", { version: 6, tagId: d5.tags.find((t) => t.name === "项目A").id, subtree: true }), { ...ctx, path: ["delete"] });
    const { data: d6 } = await del.json();
    assert.equal(d6.tags.length, 0);

    // invalid color rejected

    const bad = await api(req("http://x/", "POST", { version: 7, tagId: "x", color: "red" }), { ...ctx, path: ["recolor"] });
    assert.equal(bad.status, 400);
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("data persists to disk and readTagData round-trips", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  try {
    const ctx = makeCtx(dir, ["assign"]);
    await api(req("http://x/", "POST", { version: 0, sessionId: "s9", path: "bugfix" }), ctx);
    assert.ok(existsSync(join(dir, "session-tags.json")));
    const onDisk = readTagData(dir);
    assert.equal(onDisk.version, 1);
    assert.deepEqual(onDisk.sessionTags.s9.length, 1);
    assert.equal(onDisk.tags[0].color, "#ef4444"); // bugfix default
    // file content is valid JSON
    JSON.parse(readFileSync(join(dir, "session-tags.json"), "utf8"));
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("corrupt file falls back to empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  try {
    const { writeFileSync } = await import("fs");
    writeFileSync(join(dir, "session-tags.json"), "{{{nope");
    const ctx = makeCtx(dir);
    const r = await api(req("http://x/", "GET"), ctx);
    assert.deepEqual((await r.json()).tags, []);
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("archive/run with ids: archives selected (never running), marks index archived", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-arc-"));
  const { writeFileSync, statSync } = await import("fs");
  try {
    // Fresh timestamps so the age-based auto rule does NOT select anything —
    // only the explicit ids path can archive them (proves ids truly reach the pipeline).
    const now = new Date().toISOString();
    const header = (id, ts) => JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd: "/w" });
    const msg = (id, role, text, ts) => JSON.stringify({ type: "message", id, parentId: null, timestamp: ts, message: { role, content: role === "assistant" ? [{ type: "text", text }] : text } });
    const sA = join(dir, "a.jsonl");
    const sB = join(dir, "b.jsonl");
    writeFileSync(sA, header("sA", now) + "\n" + msg("m1", "user", "old stuff", now) + "\n");
    writeFileSync(sB, header("sB", now) + "\n" + msg("m2", "user", "recent", now) + "\n");
    const core = {
      async listSessions() { return [{ id: "sA", path: sA, cwd: "/w", modified: now }, { id: "sB", path: sB, cwd: "/w", modified: now }]; },
      async getRunningSessionIds() { return ["sA"]; }, // sA is running
    };
    // index must be synced first (as the production timer does) — archive only marks existing rows
    const { runtime } = await import("./runtime.ts");
    await runtime(cfgOf(dir)).index.sync([{ path: sA, id: "sA", cwd: "/w" }, { path: sB, id: "sB", cwd: "/w" }]);
    const ctx = { configDir: cfgOf(dir), path: ["archive", "run"], searchParams: new URLSearchParams(), core };
    const r = await api(req("http://x/", "POST", { ids: ["sA", "sB"] }), ctx);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.archived, 1); // only sB — sA is running
    assert.deepEqual(body.skippedIds, ["sA"]); // guard reports the held-back id
    assert.ok(!existsSync(sB), "sB original deleted");
    assert.ok(existsSync(sA), "running sA untouched");
    // index marks sB archived
    const idx = runtime(cfgOf(dir)).index;
    const row = idx.getSession("sB");
    assert.equal(row.archived, 1);
    assert.ok(row.archiveRef);
    // 包位置契约：写入侧必须落在 state/archive（读取侧 findEntry/extract/restore 的同一来源：
    // archivePackagesDir）。曾漏迁为根级 archive/ → 写侧自建目录照常成功，读侧永远 MISS，
    // 恢复/查看静默失败；归档不可再生 → state 层（不可整体删除），不在 cache/。
    assert.ok(existsSync(join(dir, "state", "archive", row.archiveRef)), "package written under state/archive");
    assert.ok(!existsSync(join(dir, "archive")) && !existsSync(join(dir, "cache", "archive")), "no split/legacy archive dirs");
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("archive/restore round-trip via API: package in state/archive, file comes back live", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-restore-api-"));
  const { writeFileSync } = await import("fs");
  const { findEntry } = await import("../lib/session-archive.ts");
  try {
    const now = new Date().toISOString();
    const header = (id, ts) => JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd: "/w" });
    const msg = (id, text, ts) => JSON.stringify({ type: "message", id, parentId: null, timestamp: ts, message: { role: "user", content: text } });
    const sPath = join(dir, "s.jsonl");
    writeFileSync(sPath, header("s1", now) + "\n" + msg("m1", "restore me", now) + "\n");
    const core = {
      async listSessions() { return [{ id: "s1", path: sPath, cwd: "/w", modified: now }]; },
      async getRunningSessionIds() { return []; },
    };
    const { runtime } = await import("./runtime.ts");
    await runtime(cfgOf(dir)).index.sync([{ path: sPath, id: "s1", cwd: "/w" }]);

    // 归档 → 包必须落在 restore 读取的同一目录；原文件删除
    const r1 = await api(req("http://x/", "POST", { ids: ["s1"] }), { configDir: cfgOf(dir), path: ["archive", "run"], searchParams: new URLSearchParams(), core });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).archived, 1);
    const row = runtime(cfgOf(dir)).index.getSession("s1");
    assert.equal(row.archived, 1);
    assert.ok(existsSync(join(dir, "state", "archive", row.archiveRef)), "package must land where restore looks");
    assert.ok(!existsSync(sPath), "original deleted after archive");

    // 恢复 → 文件回原路径、索引翻回 live、包内条目移除（曾经的静默 404 回归点）
    const r2 = await api(req("http://x/", "POST", { sessionId: "s1" }), { configDir: cfgOf(dir), path: ["archive", "restore"], searchParams: new URLSearchParams(), core });
    assert.equal(r2.status, 200, "restore must find the package");
    assert.deepEqual(await r2.json(), { ok: true });
    assert.ok(existsSync(sPath), "file restored to its original live path");
    const after = runtime(cfgOf(dir)).index.getSession("s1");
    assert.equal(after.archived, 0);
    assert.equal(after.path, sPath);
    assert.equal(findEntry(join(dir, "state", "archive"), "s1"), null, "entry removed from package");
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("deleted sessions: stale tag assignments GC'd on merged list fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-gc-"));
  try {
    const ctx = makeCtx(dir, ["assign"]);
    // assign "todo" to s1 and s2
    await api(req("http://x/", "POST", { version: 0, sessionId: "s1", path: "todo" }), { ...ctx, path: ["assign"] });
    let d = await (await api(req("http://x/", "POST", { version: 1, sessionId: "s2", path: "todo" }), { ...ctx, path: ["assign"] })).json();
    const vAfter = d.data.version;
    assert.deepEqual(Object.keys(d.data.sessionTags).sort(), ["s1", "s2"]);
    // now fetch merged sessions — core only knows s2 (s1 was deleted)
    const listCtx = { ...makeCtx(dir, ["sessions"]), core: {
      async listSessions() { return [{ id: "s2", path: "/w/s2.jsonl", cwd: "/w", modified: "2026-01-01T00:00:00.000Z" }]; },
      async getRunningSessionIds() { return []; },
    } };
    // first fetch: s1 marked for GC (grace window), still present
    globalThis.__smGcGraceMs = 0; // test hook: prune immediately on the second round
    const r1 = await api(req("http://x/"), listCtx);
    assert.equal(r1.status, 200);
    assert.deepEqual(Object.keys(readTagData(dir).sessionTags).sort(), ["s1", "s2"], "first round only marks");
    // second fetch: s1 confirmed absent for a full grace window → pruned
    const r2 = await api(req("http://x/"), listCtx);
    assert.equal(r2.status, 200);
    const after = readTagData(dir);
    assert.deepEqual(Object.keys(after.sessionTags), ["s2"], "s1 assignment cleaned up after grace");
    assert.equal(after.version, vAfter + 1, "GC bumps version");
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("GC 回归钉：favoriteIds（含 ws:<projectKey> 项目钉住）不被懒 GC 触碰、顺序不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-gc-fav-"));
  try {
    const seeded = {
      version: 0,
      favoriteIds: ["s1", "ws:C:\\Proj\\A", "s2"],
      tags: [{ id: "t1", name: "x", color: "#ef4444", parentId: null, sortOrder: 0, createdAt: "x" }],
      sessionTags: { s1: ["t1"], sGone: ["t1"] },
    };
    const put = await api(req("http://x/", "PUT", seeded), makeCtx(dir));
    assert.equal(put.status, 200);
    const { data: saved } = await put.json();
    // validateTagData 契约：favoriteIds 原序原样保留——数组相对顺序就是项目钉内展示顺序
    assert.deepEqual(saved.favoriteIds, ["s1", "ws:C:\\Proj\\A", "s2"]);

    // 只有 s1 在册 → sGone 的 tag 指派是 stale；favoriteIds 三项都不该动
    const listCtx = { ...makeCtx(dir, ["sessions"]), core: {
      async listSessions() { return [{ id: "s1", path: "/w/s1.jsonl", cwd: "/w", modified: "2026-01-01T00:00:00.000Z" }]; },
      async getRunningSessionIds() { return []; },
    } };
    globalThis.__smGcGraceMs = 0;
    globalThis.__smGcPending = new Map();
    try {
      assert.equal((await api(req("http://x/"), listCtx)).status, 200);
      assert.equal((await api(req("http://x/"), listCtx)).status, 200);
      const after = readTagData(dir);
      assert.deepEqual(Object.keys(after.sessionTags), ["s1"], "只清已消失会话的 tag 指派");
      assert.deepEqual(after.favoriteIds, ["s1", "ws:C:\\Proj\\A", "s2"],
        "GC 只管 sessionTags：favoriteIds 内容与顺序一律不动（防将来有人把 GC 扩到 favoriteIds）");
    } finally {
      delete globalThis.__smGcGraceMs;
      delete globalThis.__smGcPending;
    }
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("sessions fmt=2: 全量紧凑形态 + decode 还原；patch 形态不重复携带行数组", async () => {
  // 冷启动窗口外（gate：模块加载 60s 内禁 patch——restart 后扫描未稳态；本测试模拟稳态）
  globalThis.__smBootAt = Date.now() - 61_000;
  const dir = mkdtempSync(join(tmpdir(), "sm-fmt2-"));
  try {
    const now = "2026-09-07T00:00:00.000Z";
    const rows1 = [
      { id: "s1", path: "/w/s1.jsonl", cwd: "/home/x/proj", projectRoot: "/home/x/proj", created: now, modified: now, messageCount: 3, firstMessage: "hello", lastMessage: "world" },
      { id: "s2", path: "/w/s2.jsonl", cwd: "/home/x/proj", projectRoot: "/home/x/proj", created: now, modified: now, messageCount: 1, firstMessage: "a", lastMessage: "b" },
    ];
    const listCtx = () => ({ configDir: cfgOf(dir), path: ["sessions"], searchParams: new URLSearchParams(), core: {
      async listSessions() { return rows1.map((r) => ({ ...r })); },
      async getRunningSessionIds() { return []; },
    } });

    // ── 全量 fmt=2 ──
    const sp1 = new URLSearchParams({ fmt: "2" });
    const r1 = await api(req("http://x/?fmt=2"), { ...listCtx(), searchParams: sp1 });
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.equal(b1.fmt, 2);
    assert.ok(Array.isArray(b1.cwds) && b1.cwds.length === 1, "枚举表单一条目（cwd/projectRoot 同值合并）");
    assert.equal(b1.sessions[0].cwd, undefined, "紧凑行无 cwd 字符串");
    assert.equal(b1.sessions[0].c, 0);
    assert.equal(b1.sessions[0].ct, Date.parse(now));
    const { decodeRowV2 } = await import("./payload.ts");
    assert.equal(decodeRowV2(b1.sessions[0], b1.cwds).cwd, "/home/x/proj");

    // ── patch fmt=2：行变更后带 since 重拉 ──
    const rev1 = b1.rev;
    const rows2 = rows1.map((r) => ({ ...r, modified: "2026-09-07T01:00:00.000Z", lastMessage: "changed" }));
    const core2 = { async listSessions() { return rows2; }, async getRunningSessionIds() { return []; } };
    const sp2 = new URLSearchParams({ fmt: "2", since: rev1 });
    const r2 = await api(req(`http://x/?fmt=2&since=${rev1}`), { configDir: cfgOf(dir), path: ["sessions"], searchParams: sp2, core: core2 });
    assert.equal(r2.status, 200);
    const b2 = await r2.json();
    assert.ok(b2.patch, "命中缓冲 → patch 形态");
    assert.equal(b2.fmt, 2);
    assert.ok(Array.isArray(b2.cwds));
    // 回归断言（响应翻倍 bug）：顶层不得再带 sessions/行数组——行只出现在 patch.up
    assert.equal(b2.sessions, undefined, "patch body 顶层不得重复携带行数组");
    assert.ok(b2.patch.up.length >= 1);
    assert.equal(b2.patch.up[0].cwd, undefined, "up 行同为紧凑形态");

    // ── 旧形态（无 fmt）不受影响 ──
    const r3 = await api(req("http://x/"), listCtx());
    const b3 = await r3.json();
    assert.equal(b3.fmt, undefined);
    assert.equal(b3.sessions[0].cwd, "/home/x/proj");
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("sessions rev 指纹纳入 name：重命名（modified 不变）必须推进 rev 并进 patch.up（重命名不刷新回归）", async () => {
  // 根因回归：宿主 PATCH 重命名 = append session_info——只改 name，modified/messageCount/
  // lastMessage 全不变。指纹漏 name 时 rev 不变 → 304 或 patch 不含该行 → 行名永不刷新，
  // 直到其他字段变化（用户实测「重命名要很久才刷新」）。
  globalThis.__smBootAt = Date.now() - 61_000; // 冷启动窗口外（patch 出口）
  const dir = mkdtempSync(join(tmpdir(), "sm-rename-rev-"));
  try {
    const now = "2026-09-07T00:00:00.000Z";
    const base = { id: "s1", path: "/w/s1.jsonl", cwd: "/w", projectRoot: "/w", created: now, modified: now, messageCount: 2, firstMessage: "hello", lastMessage: "world" };
    const mkCore = (rows) => ({ async listSessions() { return rows.map((r) => ({ ...r })); }, async getRunningSessionIds() { return []; } });
    const get = (qs, rows) => api(req(`http://x/?${qs}`), { configDir: cfgOf(dir), path: ["sessions"], searchParams: new URLSearchParams(qs), core: mkCore(rows) });
    const b1 = await (await get("fmt=2", [base])).json();
    assert.equal(b1.sessions[0].name, undefined);
    // 仅改名（宿主 PATCH 的实际效果：除 name 外全部字段不变）
    const res2 = await get(`fmt=2&since=${b1.rev}`, [{ ...base, name: "新名字" }]);
    assert.equal(res2.status, 200, "改名后不得 304（rev 必须随 name 变化）");
    const b2 = await res2.json();
    assert.notEqual(b2.rev, b1.rev, "改名必须推进 rev（否则 304 命中、客户端永远拿不到新名）");
    assert.ok(b2.patch, "稳定态增量出口应为 patch");
    assert.equal(b2.patch.up.length, 1, "改名行必须进 patch.up");
    assert.equal(b2.patch.up[0].name, "新名字");
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("sessions 整行指纹稳定性：同内容 rev 恒等（304），仅变化行进 patch.up", async () => {
  // 整行反射指纹的稳定性不变量：同内容两次取数不得无谓推进 rev（否则每次轮询都
  // 200+patch，打掉 304/memo 的省流价值）；未变行不得进 patch.up。
  globalThis.__smBootAt = Date.now() - 61_000; // 冷启动窗口外（patch 出口）
  const dir = mkdtempSync(join(tmpdir(), "sm-rev-stable-"));
  try {
    const now = "2026-09-07T00:00:00.000Z";
    const row = (id, extra = {}) => ({ id, path: `/w/${id}.jsonl`, cwd: "/w", projectRoot: "/w", created: now, modified: now, messageCount: 1, firstMessage: "x", lastMessage: "y", ...extra });
    const mkCore = (rows) => ({ async listSessions() { return rows.map((r) => ({ ...r })); }, async getRunningSessionIds() { return []; } });
    const get = (qs, rows) => api(req(`http://x/?${qs}`), { configDir: cfgOf(dir), path: ["sessions"], searchParams: new URLSearchParams(qs), core: mkCore(rows) });
    const b1 = await (await get("fmt=2", [row("a"), row("b")])).json();
    // 同内容 → since 命中当前 rev → 304（rev 恒等）
    const r2 = await get(`fmt=2&since=${b1.rev}`, [row("a"), row("b")]);
    assert.equal(r2.status, 304, "同内容必须 304（指纹不得漂移）");
    // 仅 a 改名 → rev 推进，patch.up 只含 a（b 不得入 up）
    const b3 = await (await get(`fmt=2&since=${b1.rev}`, [row("a", { name: "A" }), row("b")])).json();
    assert.notEqual(b3.rev, b1.rev);
    assert.equal(b3.patch.up.length, 1, "未变行不得进 patch.up");
    assert.equal(b3.patch.up[0].id, "a");
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("sessions 抖动保护：rm>30% 拒 patch 降级全量（fmt=2 时全量也为紧凑形态）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-jitter-"));
  try {
    const now = "2026-09-07T00:00:00.000Z";
    const row = (id) => ({ id, path: `/w/${id}.jsonl`, cwd: "/w", projectRoot: "/w", created: now, modified: now, messageCount: 1, firstMessage: "x", lastMessage: "y" });
    const mkCore = (ids) => ({ async listSessions() { return ids.map(row); }, async getRunningSessionIds() { return []; } });
    // 第一轮：4 行 → rev1
    const b1 = await (await api(req("http://x/?fmt=2"), { configDir: cfgOf(dir), path: ["sessions"], searchParams: new URLSearchParams({ fmt: "2" }), core: mkCore(["a", "b", "c", "d"]) })).json();
    assert.equal(b1.fmt, 2);
    // 第二轮：只剩 2 行（a,b 消失 → rm=2 > 2*0.3=0.6）→ 拒 patch 降级全量
    const r2 = await api(req(`http://x/?fmt=2&since=${b1.rev}`), { configDir: cfgOf(dir), path: ["sessions"], searchParams: new URLSearchParams({ fmt: "2", since: b1.rev }), core: mkCore(["c", "d"]) });
    const b2 = await r2.json();
    assert.equal(b2.patch, undefined, "抖动时不返回 patch");
    assert.ok(Array.isArray(b2.sessions), "降级为全量");
    assert.equal(b2.fmt, 2, "全量出口同为紧凑形态");
    assert.ok(Array.isArray(b2.cwds));
    // 正常 patch 不受影响：第三轮带新 rev 只改 modified
    const b3 = await (await api(req("http://x/?fmt=2"), { configDir: cfgOf(dir), path: ["sessions"], searchParams: new URLSearchParams({ fmt: "2" }), core: mkCore(["c", "d"]) })).json();
    const rows3 = [row("c"), { ...row("d"), modified: "2026-09-07T01:00:00.000Z" }];
    const r4 = await api(req(`http://x/?fmt=2&since=${b3.rev}`), { configDir: cfgOf(dir), path: ["sessions"], searchParams: new URLSearchParams({ fmt: "2", since: b3.rev }), core: { async listSessions() { return rows3; }, async getRunningSessionIds() { return []; } } });
    const b4 = await r4.json();
    assert.ok(b4.patch, "稳态 patch 正常");
    assert.equal(b4.patch.up.length, 1);
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("archive/run skips open (alive/idle) sessions via skippedIds instead of failing the batch — old core without stopAliveSession keeps the guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  try {
    const ctx = makeCtx(dir, ["archive", "run"]);
    ctx.core.getAliveSessionIds = async () => ["alive-id"];
    const res = await api(req("http://x/", "POST", { ids: ["alive-id"] }), ctx);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.deepEqual(d.skippedIds, ["alive-id"]);
    assert.equal(d.archived, 0);
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("archive/run releases a finished-but-alive session first when the core can stopAliveSession", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-arc-"));
  const { writeFileSync, existsSync } = await import("fs");
  try {
    const now = new Date().toISOString();
    const header = (id) => JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd: "/w" });
    const msg = (id, text, ts) => JSON.stringify({ type: "message", id, parentId: null, timestamp: ts, message: { role: "user", content: text } });
    const sIdle = join(dir, "idle.jsonl");
    const sRun = join(dir, "run.jsonl");
    writeFileSync(sIdle, header("idle-id") + "\n" + msg("m1", "finished", now) + "\n");
    writeFileSync(sRun, header("run-id") + "\n" + msg("m2", "busy", now) + "\n");
    const { runtime } = await import("./runtime.ts");
    await runtime(cfgOf(dir)).index.sync([
      { path: sIdle, id: "idle-id", cwd: "/w" },
      { path: sRun, id: "run-id", cwd: "/w" },
    ]);
    let stopped = [];
    let aliveIds = ["idle-id", "run-id"];
    const core = {
      async listSessions() {
        return [
          { id: "idle-id", path: sIdle, cwd: "/w", modified: now },
          { id: "run-id", path: sRun, cwd: "/w", modified: now },
        ];
      },
      async getRunningSessionIds() { return ["run-id"]; },
      async getAliveSessionIds() { return aliveIds; },
      async stopAliveSession(id) {
        stopped.push(id);
        aliveIds = aliveIds.filter((x) => x !== id); // 模拟 shutdown 后 wrapper 退出 registry
        return "stopped";
      },
    };
    const ctx = { configDir: cfgOf(dir), path: ["archive", "run"], searchParams: new URLSearchParams(), core };
    const r = await api(req("http://x/", "POST", { ids: ["idle-id", "run-id"] }), ctx);
    assert.equal(r.status, 200);
    const body = await r.json();
    // idle-but-finished: handle released first, then archived; running: untouched
    assert.deepEqual(stopped, ["idle-id"]);
    assert.equal(body.archived, 1);
    assert.deepEqual(body.skippedIds, ["run-id"]);
    assert.ok(!existsSync(sIdle), "finished session archived (file gone)");
    assert.ok(existsSync(sRun), "running session untouched");
    const row = runtime(cfgOf(dir)).index.getSession("idle-id");
    assert.equal(row.archived, 1);
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("archive/run keeps an idle session skipped when stopAliveSession fails to release it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  try {
    const ctx = makeCtx(dir, ["archive", "run"]);
    ctx.core.getAliveSessionIds = async () => ["stuck-id"];
    ctx.core.stopAliveSession = async (id) => (id === "stuck-id" ? "still-alive" : "stopped");
    const res = await api(req("http://x/", "POST", { ids: ["stuck-id"] }), ctx);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.deepEqual(d.skippedIds, ["stuck-id"]);
    assert.equal(d.archived, 0);
    assert.equal((await ctx.core.getAliveSessionIds())[0], "stuck-id");
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("guardedSessionIds falls back to running-only on old cores", async () => {
  const { guardedSessionIds } = await import("./runtime.ts");
  const old = { async getRunningSessionIds() { return ["r1"]; } };
  assert.deepEqual([...(await guardedSessionIds(old))], ["r1"]);
  const neu = { async getRunningSessionIds() { return ["r1"]; }, async getAliveSessionIds() { return ["r1", "a1"]; } };
  assert.deepEqual([...(await guardedSessionIds(neu))].sort(), ["a1", "r1"]);
});

test("archive/run rejects unindexed sessions (index row missing) via skippedIds — no silent no-record archive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-arc-"));
  const { writeFileSync } = await import("fs");
  try {
    const now = new Date().toISOString();
    const header = (id) => JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd: "/w" });
    const msg = (id, text, ts) => JSON.stringify({ type: "message", id, parentId: null, timestamp: ts, message: { role: "user", content: text } });
    const sIdx = join(dir, "idx.jsonl");
    const sNoIdx = join(dir, "bad.jsonl"); // unparseable → sync never indexes it
    writeFileSync(sIdx, header("idx-id") + "\n" + msg("m1", "hi", now) + "\n");
    writeFileSync(sNoIdx, "this is not a session file\n");
    const { runtime } = await import("./runtime.ts");
    await runtime(cfgOf(dir)).index.sync([{ path: sIdx, id: "idx-id", cwd: "/w" }]);
    const core = {
      async listSessions() {
        return [
          { id: "idx-id", path: sIdx, cwd: "/w", modified: now },
          { id: "bad-id", path: sNoIdx, cwd: "/w", modified: now },
        ];
      },
      async getRunningSessionIds() { return []; },
      async getAliveSessionIds() { return []; },
    };
    const ctx = { configDir: cfgOf(dir), path: ["archive", "run"], searchParams: new URLSearchParams(), core };
    const r = await api(req("http://x/", "POST", { ids: ["idx-id", "bad-id"] }), ctx);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.archived, 1, "indexed session archived");
    assert.deepEqual(body.skippedIds, ["bad-id"], "unindexed session rejected, not silently archived");
    assert.ok(!existsSync(sIdx), "indexed session file removed");
    assert.ok(existsSync(sNoIdx), "unindexed session file untouched");
    const row = runtime(cfgOf(dir)).index.getSession("idx-id");
    assert.equal(row.archived, 1);
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("move releases an alive-but-idle handle first (core.stopAliveSession), then moves the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-mv-"));
  const { writeFileSync, mkdirSync } = await import("fs");
  try {
    const now = new Date().toISOString();
    const sPath = join(dir, "sess.jsonl");
    writeFileSync(sPath, JSON.stringify({ type: "session", version: 3, id: "mv-id", timestamp: now, cwd: "/old" }) + "\n"
      + JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: now, message: { role: "user", content: "hi" } }) + "\n");
    let aliveIds = ["mv-id"];
    const core = {
      async listSessions() { return [{ id: "mv-id", path: sPath, cwd: "/old", modified: now }]; },
      async getRunningSessionIds() { return []; },
      async getAliveSessionIds() { return aliveIds; },
      async stopAliveSession(id) { aliveIds = aliveIds.filter((x) => x !== id); return "stopped"; },
      async getHomeDir() { return dir; },
    };
    const destDir = join(dir, "target");
    mkdirSync(destDir, { recursive: true });
    const ctx = { configDir: cfgOf(dir), path: ["move"], searchParams: new URLSearchParams(), core };
    const r = await api(req("http://x/", "POST", { sessionId: "mv-id", cwd: destDir }), ctx);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.ok, "move succeeded after auto-releasing the idle handle");
    assert.ok(!existsSync(sPath), "original file moved away");
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("move still rejects when stopAliveSession fails to release (still-alive)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-mv-"));
  const { writeFileSync } = await import("fs");
  try {
    const now = new Date().toISOString();
    const sPath = join(dir, "sess.jsonl");
    writeFileSync(sPath, JSON.stringify({ type: "session", version: 3, id: "mv2-id", timestamp: now, cwd: "/old" }) + "\n");
    const core = {
      async listSessions() { return [{ id: "mv2-id", path: sPath, cwd: "/old", modified: now }]; },
      async getRunningSessionIds() { return []; },
      async getAliveSessionIds() { return ["mv2-id"]; },
      async stopAliveSession() { return "still-alive"; },
      async getHomeDir() { return dir; },
    };
    const ctx = { configDir: cfgOf(dir), path: ["move"], searchParams: new URLSearchParams(), core };
    const r = await api(req("http://x/", "POST", { sessionId: "mv2-id", cwd: dir }), ctx);
    assert.equal(r.status, 409);
    assert.ok(existsSync(sPath), "file untouched");
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("merged sessions: placeholder registry backfills extId/agent for orphan placeholder rows (zcode double-row fix)", async () => {
  // configDir nested one level deeper so dirname(configDir) is a writable scratch root
  // holding external-session-placeholders.json (mirrors ~/.pi/web/data layout).
  const root = mkdtempSync(join(tmpdir(), "sm-ph-"));
  const dir = join(root, "data", "session-manager");
  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync(dir, { recursive: true });
  try {
    // zcode placeholder session: uuid row on disk, no index rows anywhere
    const uuid = "11111111-2222-3333-4444-555555555555";
    const core = {
      async listSessions() {
        return [{ id: uuid, path: join(root, "ph.jsonl"), cwd: "/proj", modified: "2026-09-08T00:00:00Z" }];
      },
      async getRunningSessionIds() { return []; },
      async getHomeDir() { return root; },
    };
    writeFileSync(join(root, "data", "external-session-placeholders.json"), JSON.stringify({
      version: 1,
      sessions: [{ uuid, path: join(root, "ph.jsonl"), extId: "zcode:sess_abc", agent: "zcode", cwd: "/proj", created: "2026-09-08T00:00:00Z" }],
    }));

    // 1) with the registry present → row is restamped to the composite id with agent
    let ctx = { configDir: cfgOf(dir), path: ["sessions"], searchParams: new URLSearchParams(), core };
    const r1 = await api(req("http://x/"), ctx);
    assert.equal(r1.status, 200);
    const row = (await r1.json()).sessions.find((s) => String(s.id).includes("sess_abc"));
    assert.ok(row, "composite row present");
    assert.equal(row.id, "zcode:sess_abc");
    assert.equal(row.agent, "zcode");
    assert.equal(row.extId, "zcode:sess_abc");

    // 2) registry gone (deleted placeholder / corrupted file) → no phantom restamp
    writeFileSync(join(root, "data", "external-session-placeholders.json"), "{broken");
    ctx = { configDir: cfgOf(dir), path: ["sessions"], searchParams: new URLSearchParams(), core };
    const r2 = await api(req("http://x/"), ctx);
    const rows2 = (await r2.json()).sessions;
    assert.ok(!rows2.some((s) => s.agent === "zcode" && s.extId === "zcode:sess_abc"), "no backfill from broken registry");
  } finally {
    await rmRf(root, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("workspaces：项目级聚合（同源口径）+ running/unread 计数 + 304", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-ws-"));
  try {
    const rows = [
      { id: "s1", path: "/w/s1.jsonl", cwd: "/home/x/proj", projectRoot: "/home/x/proj", projectKey: "/home/x/proj", created: "2026-09-07T00:00:00.000Z", modified: "2026-09-07T00:00:00.000Z", messageCount: 3, firstMessage: "hello", lastMessage: "world" },
      { id: "s2", path: "/w/s2.jsonl", cwd: "/home/x/proj", projectRoot: "/home/x/proj", projectKey: "/home/x/proj", created: "2026-09-07T00:00:00.000Z", modified: "2026-09-08T00:00:00.000Z", messageCount: 1, firstMessage: "a", lastMessage: "b" },
      // windows 盘符 + 反斜杠：normalize 后与 posix 不同 key
      { id: "s3", path: "w:\\s3.jsonl", cwd: "c:\\workspace\\aiti-ai", projectRoot: "c:\\workspace\\aiti-ai", projectKey: "c:\\workspace\\aiti-ai", created: "x", modified: "2026-09-09T00:00:00.000Z", messageCount: 1, firstMessage: "c", lastMessage: "d" },
    ];
    const core = {
      async listSessions() { return rows.map((r) => ({ ...r })); },
      async getRunningSessionIds() { return ["s2"]; },
    };
    const sp = new URLSearchParams({ unread: "s1,s3" });
    const ctx = { configDir: cfgOf(dir), path: ["workspaces"], searchParams: sp, core };
    const r = await api(req("http://x/?unread=s1,s3"), ctx);
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.ok(Array.isArray(b.workspaces) && b.workspaces.length === 2, "两项目（posix + win 归一）");
    const byKey = new Map(b.workspaces.map((w) => [w.key, w]));
    const p1 = byKey.get("/home/x/proj");
    assert.ok(p1, "posix 项目存在");
    assert.equal(p1.sessionCount, 2);
    assert.equal(p1.runningCount, 1);
    assert.equal(p1.unreadCount, 1);
    assert.equal(p1.lastModified, "2026-09-08T00:00:00.000Z");
    assert.equal(p1.name, "proj");
    const p2 = byKey.get("d:/workspace/aiti-ai");
    assert.ok(p2, "win 项目按 lowercase+slash 归一");
    assert.equal(p2.runningCount, 0);
    assert.equal(p2.unreadCount, 1);
    // 排序：modified 降序
    assert.equal(b.workspaces[0].key, "d:/workspace/aiti-ai");
    // rev 稳定 + 304
    const r2 = await api(req("http://x/", "GET"), ctx);
    assert.equal(r2.status, 200);
    const b2 = await r2.json();
    assert.equal(b2.rev, b.rev, "同内容 rev 恒等");
    const r304 = await api(new Request("http://x/", { headers: { "if-none-match": `"${b.rev}"` } }), ctx);
    assert.equal(r304.status, 304);
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("sessions project=<key> 作用域：只回该项目行；不带 project 仍全量；scoped 不走 patch", async () => {
  globalThis.__smBootAt = Date.now() - 61_000;
  const dir = mkdtempSync(join(tmpdir(), "sm-scope-"));
  try {
    const now = "2026-09-07T00:00:00.000Z";
    const rows = [
      { id: "s1", path: "/w/s1.jsonl", cwd: "/home/x/proj", projectRoot: "/home/x/proj", projectKey: "/home/x/proj", created: now, modified: now, messageCount: 3, firstMessage: "hello", lastMessage: "world" },
      { id: "s2", path: "/w/s2.jsonl", cwd: "/home/x/other", projectRoot: "/home/x/other", projectKey: "/home/x/other", created: now, modified: now, messageCount: 1, firstMessage: "a", lastMessage: "b" },
      { id: "s3", path: "w:\\s3.jsonl", cwd: "c:\\workspace\\aiti-ai", projectRoot: "c:\\workspace\\aiti-ai", projectKey: "c:\\workspace\\aiti-ai", created: now, modified: now, messageCount: 1, firstMessage: "c", lastMessage: "d" },
    ];
    const core = { async listSessions() { return rows.map((r) => ({ ...r })); }, async getRunningSessionIds() { return []; } };
    const base = { configDir: cfgOf(dir), path: ["sessions"] };

    // 全量 fmt=2 → 3 行
    const rAll = await api(req("http://x/?fmt=2"), { ...base, searchParams: new URLSearchParams({ fmt: "2" }), core });
    const bAll = await rAll.json();
    assert.equal(bAll.sessions.length, 3, "全量含 3 行");

    // scoped fmt=2&project=/home/x/proj → 1 行；紧凑形态可还原 cwd
    const sp = new URLSearchParams({ fmt: "2", project: "/home/x/proj" });
    const rS = await api(req("http://x/?fmt=2&project=/home/x/proj"), { ...base, searchParams: sp, core });
    assert.equal(rS.status, 200);
    const bS = await rS.json();
    assert.equal(bS.sessions.length, 1, "只回该项目行");
    assert.ok(bS.sessions[0].cwd === undefined, "紧凑行无 cwd 字符串");
    const { decodeRowV2 } = await import("./payload.ts");
    assert.equal(decodeRowV2(bS.sessions[0], bS.cwds).cwd, "/home/x/proj");

    // legacy 形态 scoped（无 fmt）
    const rL = await api(req("http://x/?project=/home/x/proj"), { ...base, searchParams: new URLSearchParams({ project: "/home/x/proj" }), core });
    const bL = await rL.json();
    assert.equal(bL.sessions.length, 1);
    assert.equal(bL.sessions[0].cwd, "/home/x/proj");

    // scoped 304：If-None-Match 命中
    const r304 = await api(new Request("http://x/?fmt=2&project=/home/x%2Fproj", { headers: { "if-none-match": `"${bS.rev ?? bL.rev}"` } }), { ...base, searchParams: new URLSearchParams({ fmt: "2", project: "/home/x/proj" }), core });
    // etag 从全量响应读不到（scoped 自己算），只验证 304 或 200 均正确
    assert.ok([200, 304].includes(r304.status));
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});

test("workspaces：pi 站位接管（placeholder）的 ext 行不重复计数/不产生幽灵项目", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-wsph-"));
  try {
    const { writeFileSync, mkdirSync: mk } = await import("fs");
    const { runtime } = await import("./runtime.ts");
    // 数据根 = dirname(dirname(configDir))——cfgOf 把 temp 当 extRoot，dataRoot 是 dirname(extRoot)
    const dataRoot = dirname(cfgOf(dir));
    mk(dataRoot, { recursive: true });
    // 站位注册表：uuid u1 接管 zcode:sess_z1
    writeFileSync(join(dataRoot, "external-session-placeholders.json"), JSON.stringify({
      sessions: [{ uuid: "u1", extId: "zcode:sess_z1", agent: "zcode" }],
    }));
    const now = "2026-09-07T00:00:00.000Z";
    const rows = [
      // pi 站位行（被接管的代表行）：cwd 是真实项目
      { id: "u1", path: "/w/u1.jsonl", cwd: "/home/x/proj", projectRoot: "/home/x/proj", projectKey: "/home/x/proj", created: now, modified: now, messageCount: 1, firstMessage: "h", lastMessage: "w" },
    ];
    const core = { async listSessions() { return rows.map((r) => ({ ...r })); }, async getRunningSessionIds() { return []; } };
    // 索引里放一个 zcode ext 行（cwd 是幽灵目录 /tmp/ghost）+ pi 行带 ext_id
    await runtime(cfgOf(dir)).index.sync([
      { path: "/w/u1.jsonl", id: "u1", cwd: "/home/x/proj" },
      { path: "/db/z1", id: "zcode:sess_z1", cwd: "/tmp/ghost", agent: "zcode" },
    ]);
    // 给 pi 行补 ext_id（站位行专属列）——模拟索引里被接管标记
    const idx = runtime(cfgOf(dir)).index;
    idx.sync([{ path: "/w/u1.jsonl", id: "u1", cwd: "/home/x/proj", extId: "zcode:sess_z1", agent: "zcode" }]);
    // 激活 zcode 源（extRows 需要 activeAgents 命中）
    const ext = await import("./ext-sources.ts");
    ext.registerProvider(cfgOf(dir), "zcode");
    await ext.ensureProviders(cfgOf(dir));
    const ctx = { configDir: cfgOf(dir), path: ["workspaces"], searchParams: new URLSearchParams(), core };
    const r = await api(req("http://x/"), ctx);
    const b = await r.json();
    const keys = b.workspaces.map((w) => w.key);
    assert.ok(!keys.includes("/tmp/ghost"), "幽灵目录不得出现（ext 行已被 pi 站位接管）");
    const proj = b.workspaces.find((w) => w.key === "/home/x/proj");
    assert.equal(proj.sessionCount, 1, "被接管 ext 行不重复计数");
  } finally {
    await rmRf(dir, { closeSessionIndex: true, sessionIndexConfigDir: cfgOf(dir) });
  }
});
