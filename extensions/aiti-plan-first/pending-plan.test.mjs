/**
 * aiti-plan-first · pending 方案存储测试（node --test，注入内存 storage，无浏览器依赖）
 *
 * 覆盖：读写往返、按 cwd 分桶隔离、坏 JSON 容错、清空、take 语义（读后即清）、空 cwd 不落盘。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_PLAN_KEY,
  loadPendingMap, savePendingMap, readPendingPlan, writePendingPlan, takePendingPlan,
} from "./client/src/pending-plan.ts";

/** 内存 storage 桩 */
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    _dump: () => m,
  };
}

test("读写往返：write → read 同 cwd 命中，其余 cwd 为 null", () => {
  const s = memStore();
  writePendingPlan("/a", { path: "/a/docs/p.md", rel: "docs/p.md", at: 1 }, s);
  const hit = readPendingPlan("/a", s);
  assert.equal(hit.path, "/a/docs/p.md");
  assert.equal(hit.rel, "docs/p.md");
  assert.equal(readPendingPlan("/b", s), null);
});

test("按 cwd 分桶：两个 cwd 各自独立，互不覆盖", () => {
  const s = memStore();
  writePendingPlan("/a", { path: "/a/x.md", at: 1 }, s);
  writePendingPlan("/b", { path: "/b/y.md", at: 2 }, s);
  const map = loadPendingMap(s);
  assert.deepEqual(Object.keys(map).sort(), ["/a", "/b"]);
  assert.equal(readPendingPlan("/a", s).path, "/a/x.md");
  assert.equal(readPendingPlan("/b", s).path, "/b/y.md");
});

test("清空：write(null) 删除该 cwd 桶，其余保留", () => {
  const s = memStore();
  writePendingPlan("/a", { path: "/a/x.md", at: 1 }, s);
  writePendingPlan("/b", { path: "/b/y.md", at: 1 }, s);
  writePendingPlan("/a", null, s);
  assert.equal(readPendingPlan("/a", s), null);
  assert.equal(readPendingPlan("/b", s).path, "/b/y.md");
});

test("take：读后即清（二次 take 为 null）", () => {
  const s = memStore();
  writePendingPlan("/a", { path: "/a/x.md", at: 1 }, s);
  assert.equal(takePendingPlan("/a", s).path, "/a/x.md");
  assert.equal(takePendingPlan("/a", s), null);
  assert.deepEqual(loadPendingMap(s), {});
});

test("坏 JSON / 非对象 → 空表容错（不抛）", () => {
  const s = memStore();
  s.setItem(PENDING_PLAN_KEY, "{not json");
  assert.deepEqual(loadPendingMap(s), {});
  s.setItem(PENDING_PLAN_KEY, "[1,2]");
  assert.deepEqual(loadPendingMap(s), {});
  s.setItem(PENDING_PLAN_KEY, "\"str\"");
  assert.deepEqual(loadPendingMap(s), {});
});

test("空 cwd：read/write 均为安全空操作", () => {
  const s = memStore();
  writePendingPlan("", { path: "/x.md", at: 1 }, s);
  assert.equal(readPendingPlan("", s), null);
  assert.deepEqual(loadPendingMap(s), {});
});

test("缺 path 的脏记录：read 视为无 pending", () => {
  const s = memStore();
  savePendingMap({ "/a": { at: 1 } }, s);
  assert.equal(readPendingPlan("/a", s), null);
});

test("无 storage（隐私模式）：读写静默不抛", () => {
  assert.deepEqual(loadPendingMap(null), {});
  savePendingMap({ "/a": { path: "/a/x.md", at: 1 } }, null);
  assert.equal(readPendingPlan("/a", null), null);
  assert.equal(takePendingPlan("/a", null), null);
});
