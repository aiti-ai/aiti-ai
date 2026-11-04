/**
 * fresh.test.mjs — statFreshList 共享实现（列表层时间戳通道）语义钉死。
 * 跑法：node lib/agents/fresh.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statFreshList } from "./fresh.ts";

test("statFreshList: stat 会话文件 mtime；# 虚拟路径与缺失文件跳过", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-fresh-"));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  writeFileSync(a, "{}");
  writeFileSync(b, "{}");
  // 固定 mtime 便于断言（过去某整点）
  const t = new Date("2026-09-10T01:00:00.000Z");
  utimesSync(a, t, t);

  const refs = [
    { sid: "sess_a", path: a },
    { sid: "sess_b", path: b },
    { sid: "sess_db", path: "/tmp/sm-zcode-cache/zcode-copy.db#session:sess_db" }, // db copy 虚拟路径
    { sid: "sess_gone", path: join(dir, "missing.jsonl") }, // 已消失
  ];
  const out = statFreshList(refs);
  assert.deepEqual(out.map((r) => r.sid).sort(), ["sess_a", "sess_b"]);
  const rowA = out.find((r) => r.sid === "sess_a");
  assert.equal(rowA.timeUpdatedMs, t.getTime());
});

test("statFreshList: 空 refs / 全部无效 → 空数组（不 throw）", () => {
  assert.deepEqual(statFreshList([]), []);
  assert.deepEqual(statFreshList([{ sid: "x", path: "/nonexistent/xx#y:z" }]), []);
});
