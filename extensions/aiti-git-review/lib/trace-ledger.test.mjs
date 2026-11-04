import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLedger, pickStoreEntry, groupRevisions } from "./trace-ledger.mjs";

const LINE1 = JSON.stringify({
  op: 12, entryId: "e_1", msgSeq: 8, tool: "bash", summary: "rm -rf dist && npm run build",
  t0: 1000, t1: 2000, cwd: "/x", userHead: "uh", parent: null,
  stores: [
    { root: "/x", before: "aaa", after: "bbb", files: { M: 3, A: 1, D: 0, skipped: 2 }, paths: ["a.ts"], partial: false },
    { root: "/y", before: null, after: "9aa", files: { A: 1 }, partial: true },
  ],
  leaks: [],
});
const LINE2 = JSON.stringify({
  op: 13, entryId: "e_2", msgSeq: 8, tool: "edit", summary: "edit src/b.ts",
  t1: 3000,
  stores: [{ root: "/x", before: "bbb", after: "ccc", files: { M: 1 }, partial: false }],
});
const LINE3 = JSON.stringify({
  op: 14, entryId: "e_3", msgSeq: 9, tool: "write", summary: "write /y/new.md",
  stores: [{ root: "/y", before: "9aa", after: "ddd", files: { A: 1 } }],
});

test("parseLedger：逐行解析，坏行/缺 stores 跳过", () => {
  const text = [LINE1, "not-json", "{}", LINE2, ""].join("\n");
  const ops = parseLedger(text);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].op, 12);
  assert.equal(ops[1].op, 13);
});

test("pickStoreEntry：root 精确匹配优先，缺省第一条，空 stores → null", () => {
  const ops = parseLedger(LINE1);
  assert.equal(pickStoreEntry(ops[0], "/y").after, "9aa");
  assert.equal(pickStoreEntry(ops[0], "/x").after, "bbb");
  assert.equal(pickStoreEntry(ops[0]).root, "/x"); // 主 store 恒在首
  assert.equal(pickStoreEntry({ op: 1, stores: [] }), null);
});

test("groupRevisions：消息→操作两级分组、升序、文件计数（不含 skipped）、partial 透传", () => {
  const ops = parseLedger([LINE1, LINE2, LINE3].join("\n"));
  const msgs = groupRevisions(ops, "/x");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].msgSeq, 8);
  assert.equal(msgs[0].ops.length, 2);
  assert.equal(msgs[0].label, "#8 rm -rf dist && npm run build（2 ops）");
  const op12 = msgs[0].ops[0];
  assert.equal(op12.after, "bbb");
  assert.equal(op12.filesCount, 4); // M3+A1+D0，skipped 不计
  assert.equal(op12.partial, false);
  assert.equal(msgs[1].msgSeq, 9);
  assert.equal(msgs[1].ops[0].root, "/y");
});

test("groupRevisions：指定 root 无条目的 op 落回第一条 store", () => {
  const ops = parseLedger(LINE3);
  const msgs = groupRevisions(ops, "/not-exist");
  assert.equal(msgs[0].ops[0].root, "/y");
});
