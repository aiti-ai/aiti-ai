/**
 * plan 采认记账集成测试（fusion 实施档 §2.3：planRecordBegin/End/Note 三原语）。
 * 覆盖：accepted（before/after 双 commit + 成对 tag 锚点 + 台账单一 op 带 stores[]）、
 * rolledback（无净 diff → 只落台账行）、note 丢弃行、无 store 降级、recordId 缺失降级、
 * 台账 op 编号不受 plan 行影响（readRows/recoverLastOp 只认 op 行）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { TraceEngine } from "../src/engine.ts";
import { ledgerFileFor } from "../src/paths.ts";
import { storeGitDir } from "../src/store.ts";
import { readRows, recoverLastOp } from "../src/ledger.ts";

const GIT_ENV = { ...process.env };
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
}

interface Fixture {
  repo: string;
  dataDir: string;
  write(rel: string, content: string): void;
  cleanup(): void;
}

function mkFixture(t: import("node:test").TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aiti-gt-plan-${t.name.replace(/[^a-z0-9]/gi, "-").slice(0, 30)}-`));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main", repo], root);
  git(["-C", repo, "config", "user.email", "t@t.local"], repo);
  git(["-C", repo, "config", "user.name", "t"], repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(["-C", repo, "add", "-A"], repo);
  git(["-C", repo, "commit", "-q", "-m", "init"], repo);
  const fx: Fixture = {
    repo,
    dataDir: path.join(root, "data"),
    write: (rel, content) => {
      const abs = path.join(repo, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
  };
  t.after(() => fx.cleanup());
  return fx;
}

function newEngine(fx: Fixture, sessionId: string, extra: Record<string, unknown> = {}): TraceEngine {
  return new TraceEngine({ cwd: fx.repo, sessionId, dataDir: fx.dataDir, ...extra });
}

/** 读台账里的 plan 行（kind 行，无 op 编号） */
function planRows(fx: Fixture, sid: string): any[] {
  const file = ledgerFileFor(fx.dataDir, sid);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && typeof r.kind === "string" && r.kind.startsWith("plan-"));
}

function storeTags(fx: Fixture): string[] {
  return git(["tag", "-l"], path.join(fx.repo, ".aiti-trace")).split("\n").filter(Boolean);
}

test("planRecord accepted：before/after 双 commit + 成对 tag + 台账单一 op 带 stores[]", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "planrec1");
  await e.init();
  assert.equal(e.tracked, true, "store tracked");

  const rec = await e.planRecordBegin("采认前现场");
  assert.ok(rec && rec.startsWith("plan-"), `recordId: ${rec}`);

  fx.write("acc.txt", "accepted\n");
  await e.planRecordEnd(rec, { outcome: "accepted", summary: "采认交付物", sandbox: "sb-1", files: ["acc.txt"], deletions: [], conflicts: [], mission: "m-1" });

  const rows = planRows(fx, "planrec1");
  assert.equal(rows.length, 1, `恰好一条 plan 行: ${JSON.stringify(rows)}`);
  const row = rows[0];
  assert.equal(row.kind, "plan-accept");
  assert.equal(row.tool, "plan-accept");
  assert.equal(row.sandbox, "sb-1");
  assert.equal(row.mission, "m-1");
  assert.deepEqual(row.files, ["acc.txt"]);
  assert.ok(Array.isArray(row.stores) && row.stores.length === 1, `stores: ${JSON.stringify(row.stores)}`);
  const st = row.stores[0];
  assert.ok(st.before, "before 引用非空（begin 已打现场）");
  assert.ok(st.after, "after 引用非空");
  assert.deepEqual([st.files.A, st.files.M, st.files.D], [1, 0, 0], `files 计数: ${JSON.stringify(st.files)}`);
  assert.ok(st.paths.includes("acc.txt"), `paths: ${JSON.stringify(st.paths)}`);

  // 成对懒 tag（tag 基 = recordId）
  const tags = storeTags(fx);
  assert.ok(tags.includes(`aiti/planrec1/before-${rec}`), `tags: ${JSON.stringify(tags)}`);
  assert.ok(tags.includes(`aiti/planrec1/after-${rec}`), `tags: ${JSON.stringify(tags)}`);

  // 台账 op 编号不受 plan 行影响（readRows/recoverLastOp 只认 op 行）
  assert.equal(recoverLastOp(ledgerFileFor(fx.dataDir, "planrec1")), 0);
  assert.equal(readRows(ledgerFileFor(fx.dataDir, "planrec1")).length, 0);
});

test("planRecord rolledback：无净 diff → 只落 plan-rollback 台账行（无 stores）", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "planrec2");
  await e.init();
  const rec = await e.planRecordBegin("采认前");
  assert.ok(rec);
  fx.write("g.txt", "will be reverted\n");
  await e.planRecordEnd(rec, { outcome: "rolledback", summary: "门禁失败", sandbox: "sb-2", files: ["g.txt"], deletions: [], conflicts: [] });
  const rows = planRows(fx, "planrec2");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "plan-rollback");
  assert.equal(rows[0].stores, undefined, `无 stores: ${JSON.stringify(rows[0])}`);
});

test("planRecordNote 丢弃 → plan-discard 台账行", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "planrec3");
  await e.init();
  await e.planRecordNote({ summary: "丢弃沙箱", sandbox: "sb-3", projectDir: fx.repo });
  const rows = planRows(fx, "planrec3");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "plan-discard");
  assert.equal(rows[0].sandbox, "sb-3");
});

test("无 store（workspace 禁用）→ begin 返回 null，end 只落台账行", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "planrec4");
  // 无 git 目录 + autoInit 关 → noStore
  const bare = path.join(path.dirname(fx.repo), "bare");
  fs.mkdirSync(bare, { recursive: true });
  const e2 = new TraceEngine({ cwd: bare, sessionId: "planrec4", dataDir: fx.dataDir, autoInit: false, looseDenylist: false });
  await e2.init();
  assert.equal(e2.noStore, true);
  assert.equal(await e2.planRecordBegin("x"), null);
  await e2.planRecordEnd(null, { outcome: "accepted", summary: "降级采认", sandbox: "sb-4", files: [], deletions: [], conflicts: [] });
  const rows = planRows(fx, "planrec4");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "plan-accept");
  assert.equal(rows[0].stores, undefined);
  void e;
});

test("recordId 缺失（begin 阶段已降级）→ accepted 行无 stores，不补 commit", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "planrec5");
  await e.init();
  fx.write("d.txt", "degraded\n");
  await e.planRecordEnd(null, { outcome: "accepted", summary: "s", sandbox: "sb-5", files: ["d.txt"], deletions: [], conflicts: [] });
  const rows = planRows(fx, "planrec5");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "plan-accept");
  assert.equal(rows[0].stores, undefined);
  // store 未被 end 触碰（无 aiti 分支 tag）
  assert.equal(storeTags(fx).filter((x) => x.includes("plan-")).length, 0);
});
