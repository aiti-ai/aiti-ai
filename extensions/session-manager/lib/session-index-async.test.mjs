/**
 * session-manager — index facade（worker 门面）测试：降级链 + worker 往返 + vacuum 触发。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/session-manager/lib/session-index-async.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const { createIndexFacade, requestIndexVacuum } = await import("./session-index-async.ts");

function parsed(id) {
  return {
    meta: {
      path: `virtual://${id}`, id, cwd: "/tmp/proj", name: `s-${id}`,
      created: "2026-09-12T00:00:00.000Z", modified: "2026-09-12T00:01:00.000Z",
      messageCount: 1, firstMessage: "f", lastMessage: "l",
    },
    messages: [{ entryId: "e0", role: "user", ts: null, text: `hello ${id}` }],
    files: [],
  };
}

test("facade：workerPath 缺失 → sync/syncExt 自动回落本地实现（行为同旧版）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-facade-"));
  let facade;
  try {
    // pi sync 只索引真实存在的文件——造一个最小 jsonl
    writeFileSync(join(dir, "x.jsonl"),
      JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-12T00:00:00Z", cwd: dir }) + "\n" +
      JSON.stringify({ type: "message", id: "m1", timestamp: "2026-09-12T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "hello local" }] } }) + "\n");
    facade = createIndexFacade(join(dir, "index.sqlite"), { workerPath: join(dir, "no-such-worker.mjs") });
    const r1 = await facade.sync([{ path: join(dir, "x.jsonl"), id: "s1", cwd: dir }]);
    assert.equal(r1.indexed, 1);
    assert.equal(r1.removed, 0);
    // syncExt 走本地（parse 回调被调用）
    let called = 0;
    const r2 = await facade.syncExt("zcode", [{ sid: "a", path: "/tmp/db#session:a", rev: 1 }], (ref) => {
      called++;
      return parsed(ref.sid);
    });
    assert.equal(r2.indexed, 1);
    assert.equal(called, 1, "回落本地时 parse 在主线程执行");
    // requestVacuum：worker 不在场 → false（绝不本地跑 VACUUM）
    assert.equal(facade.requestVacuum(), false);
    assert.equal(requestIndexVacuum(join(dir, "index.sqlite")), false, "worker 不在场 → false");
  } finally {
    facade?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("facade：真 worker 往返（构建产物在时）——sync/syncExt 在 worker 内完成", async () => {
  // 用 repo 内真实构建产物；没有（未构建）就跳过
  const workerPath = fileURLToPath(new URL("../dist/index-worker.mjs", import.meta.url));
  const { existsSync } = await import("node:fs");
  if (!existsSync(workerPath)) return test.skip("dist/index-worker.mjs 未构建，跳过真 worker 用例");

  const dir = mkdtempSync(join(tmpdir(), "sm-facade-real-"));
  let facade;
  try {
    // 真 worker 需要 parse 在 worker 内可用 → 内置适配器表有 zcode（fixture 由 env 指向空目录 → list 抛错路径不走）
    // 这里用 pi sync（无需适配器）验证往返 + 真实落库
    facade = createIndexFacade(join(dir, "index.sqlite"), { workerPath });
    const f = join(dir, "s1.jsonl");
    writeFileSync(f, JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-12T00:00:00Z", cwd: dir }) + "\n" +
      JSON.stringify({ type: "message", id: "m1", timestamp: "2026-09-12T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "worker roundtrip 你好" }] } }) + "\n");
    const r = await Promise.race([
      facade.sync([{ path: f, id: "s1", cwd: dir }]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("worker 往返超时（15s）")), 15_000)),
    ]);
    assert.equal(r.indexed, 1, "worker 内 sync 成功");
    // 落库可见（主线程读连接读 worker 写入——WAL 多连接）
    const row = facade.getSession("s1");
    assert.ok(row, "主线程读到 worker 写入的行");
    const hits = facade.search("roundtrip", 5);
    assert.equal(hits.length, 1, "FTS 查询命中 worker 写入内容");
  } finally {
    // 断言失败也要 terminate worker——否则 worker 句柄让测试进程永不退出
    facade?.close();
    // worker?.terminate() 是异步的（close 里 fire-and-forget）：Windows 上 worker 的
    // SQLite 句柄还钉着临时目录时 rmSync 即 EPERM（lessons §4 收口配方：留 ~150ms 等句柄释放）
    await new Promise((r) => setTimeout(r, 200));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncExt/extRows：源内父子链 parent_sid 落库并带出（zcode subagent_child）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-parent-sid-"));
  try {
    const { openSessionIndex } = await import("./session-index.ts");
    const idx = openSessionIndex(join(dir, "index.sqlite"));
    const mkParsed = (id, parentSid) => ({
      meta: {
        path: `db#session:${id}`, id, cwd: "/tmp/proj", name: `s-${id}`,
        created: "2026-09-13T00:00:00.000Z", modified: "2026-09-13T00:01:00.000Z",
        messageCount: 1, firstMessage: "f", lastMessage: "l", ...(parentSid ? { parentSid } : {}),
      },
      messages: [{ entryId: "e0", role: "user", ts: null, text: `hello ${id}` }],
      files: [],
    });
    const r = await idx.syncExt("zcode",
      [{ sid: "p", path: "db#session:p", rev: 1 }, { sid: "c", path: "db#session:c", rev: 1 }],
      (ref) => mkParsed(ref.sid, ref.sid === "c" ? "p" : undefined));
    assert.equal(r.indexed, 2);
    const rows = idx.extRows(["zcode"]);
    assert.equal(rows.length, 2);
    const child = rows.find((x) => x.id === "zcode:c");
    assert.equal(child.parentSid, "p", "syncExt 落库 parent_sid，extRows 带出");
    const parent = rows.find((x) => x.id === "zcode:p");
    assert.equal(parent.parentSid ?? null, null, "无父链 → NULL");
    idx.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensure()：旧 copyDb 副本水位行一次性清理（zcode/opencode 直读改造配套）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-legacy-wm-"));
  try {
    const dbPath = join(dir, "index.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE files (path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL, indexed_at TEXT NOT NULL)");
    db.prepare("INSERT INTO files VALUES (?,?,?,?)").run("/tmp/sm-zcode-cache/zcode-copy.db#session:old1", 1, 268607488, "x");
    db.prepare("INSERT INTO files VALUES (?,?,?,?)").run("/tmp/sm-opencode-cache/opencode-copy.db#session:old2", 1, 999, "x");
    db.prepare("INSERT INTO files VALUES (?,?,?,?)").run("/home/pi/.pi/agent/sessions/real.jsonl", 1, 5, "x");
    db.close();

    const { openSessionIndex } = await import("./session-index.ts");
    const idx = openSessionIndex(dbPath); // ensure() 打开即清理
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const rows = check.prepare("SELECT path FROM files").all().map((r) => r.path);
    check.close();
    idx.close();
    assert.ok(!rows.some((p) => p.startsWith("/tmp/sm-zcode-cache")), "zcode 副本水位行已清");
    assert.ok(!rows.some((p) => p.startsWith("/tmp/sm-opencode-cache")), "opencode 副本水位行已清");
    assert.ok(rows.includes("/home/pi/.pi/agent/sessions/real.jsonl"), "真实文件水位行保留");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
