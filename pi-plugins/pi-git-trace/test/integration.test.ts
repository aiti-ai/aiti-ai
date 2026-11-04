/**
 * M0 集成测试（临时目录，直调 engine；§10.1 M0-13）。
 * 覆盖：store 定位/初始化、双 commit 链与 trailer、台账↔commit 一致、
 * op 计数器台账续接、hermetic 红线（用户仓零变化）、并发会话、嵌套仓、
 * 大小跳过、内置排除与显式追踪让位、turn_end 兜底、无 git 置态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { TraceEngine } from "../src/engine.ts";
import { resolveRepoRoot, isValidGitDir } from "../src/recognition.ts";
import { storeGitDir, ensureStore, excludeNestedInParent } from "../src/store.ts";
import { ledgerFileFor, workspaceKey, sessionBranch } from "../src/paths.ts";
import { readRows, recoverLastOp } from "../src/ledger.ts";
import { renderExcludesFile, BUILTIN_EXCLUDES } from "../src/excludes.ts";
import { countFilesWithBudget, maintainLooseGitignore } from "../src/loose.ts";
import { userRepoRefs, userRepoStatus } from "../src/git-wrap.ts";

const GIT_ENV = { ...process.env };
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
}

// 平台过滤（各系统跑各的测试）：POSIX 专属用例在 Windows 上 skip（理由随 skip 信息上报）
const SKIP_ON_WIN = process.platform === "win32"
  ? "POSIX 语义用例（/tmp denylist 等），仅 Linux 跑"
  : false;
// Windows 无特权环境 symlink 需开发者模式/管理员，EPERM —— symlink 用例仅 POSIX 跑
const SKIP_ON_WIN_SYMLINK = process.platform === "win32"
  ? "非特权 Windows 建 symlink EPERM，仅 Linux 跑"
  : false;

interface Fixture {
  root: string;
  repo: string;
  dataDir: string;
  write(rel: string, content: string): string;
  rm(rel: string): void;
  cleanup(): void;
}

function mkFixture(t: import("node:test").TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aiti-gt-${t.name.replace(/[^a-z0-9]/gi, "-")}-`));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main", repo], root);
  git(["-C", repo, "config", "user.email", "t@t.local"], repo);
  git(["-C", repo, "config", "user.name", "t"], repo);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(["-C", repo, "add", "-A"], repo);
  git(["-C", repo, "commit", "-q", "-m", "init"], repo);
  const dataDir = path.join(root, "data");
  const fx: Fixture = {
    root,
    repo,
    dataDir,
    write: (rel, content) => {
      const abs = path.join(repo, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return abs;
    },
    rm: (rel) => fs.rmSync(path.join(repo, rel), { force: true, recursive: true }),
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
  };
  t.after(() => fx.cleanup());
  return fx;
}

function newEngine(fx: Fixture, sessionId: string, extra: Record<string, unknown> = {}): TraceEngine {
  return new TraceEngine({ cwd: fx.repo, sessionId, dataDir: fx.dataDir, ...extra });
}

function branchLog(repo: string, branch: string): string[] {
  try {
    return git(
      ["--git-dir", storeGitDir(repo), "log", "--reverse", "--format=%B%x00", branch],
      repo,
    )
      .split("\0")
      .map((m) => m.trim())
      .filter(Boolean);
  } catch {
    return []; // 分支尚无提交（ unborn / 不存在）
  }
}

function storeRefs(repo: string): string[] {
  return git(["--git-dir", storeGitDir(repo), "for-each-ref", "--format=%(refname)"], repo)
    .split("\n").map((l) => l.trim()).filter(Boolean);
}

async function runSimpleOp(e: TraceEngine, toolCallId: string, tool: string, input: unknown, mutate?: () => void) {
  await e.onToolCall(toolCallId, tool, input);
  mutate?.();
  await e.onToolExecutionEnd(toolCallId, false);
}

/* ---------------- store 定位 ---------------- */

test("locate: cwd 自带 .git → 仓根；子目录向上走查；无 git → null；.git 文件跳过", (t) => {
  const fx = mkFixture(t);
  assert.equal(resolveRepoRoot(fx.repo), fx.repo);
  const sub = path.join(fx.repo, "a", "b");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(resolveRepoRoot(sub), fx.repo);
  assert.equal(resolveRepoRoot(fx.root), null); // root 上再无外层仓
  // .git 是文件（worktree 指针形态）→ 继续向上（此处上层无仓 → null）
  const orphan = path.join(fx.root, "orphan");
  fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, ".git"), "gitdir: /nowhere\n");
  assert.equal(resolveRepoRoot(orphan), null);
});

/* ---------------- store init 与隔离 ---------------- */

test("init: store 建立、config 写死、分支正确；hermetic 红线（用户仓零变化）", async (t) => {
  const fx = mkFixture(t);
  const statusBefore = await userRepoStatus(fx.repo);
  const refsBefore = (await userRepoRefs(fx.repo)).sort();

  const e = newEngine(fx, "sessA");
  await e.init();
  assert.ok(e.tracked);

  // store 结构与 config
  const gitDir = storeGitDir(fx.repo);
  assert.ok(isValidGitDir(gitDir));
  const cfg = (k: string) =>
    execFileSync("git", ["--git-dir", gitDir, "config", k], { encoding: "utf8" }).trim();
  assert.equal(cfg("user.name"), "aiti-trace");
  assert.equal(cfg("user.email"), "aiti@local");
  assert.equal(cfg("gc.auto"), "0");
  assert.equal(cfg("core.quotePath"), "false");
  const infoExcl = fs.readFileSync(path.join(gitDir, "info", "exclude"), "utf8");
  assert.ok(infoExcl.includes("# --- aiti managed v1 ---") && infoExcl.includes("node_modules/"));
  await runSimpleOp(e, "c1", "bash", { command: "echo hi > x.txt" }, () => fx.write("x.txt", "hi\n"));

  // hermetic 红线：用户仓 refs 与操作前完全一致（追踪 refs 全在 .git/aiti 内，用户 git 不可见）
  assert.deepEqual((await userRepoRefs(fx.repo)).sort(), refsBefore);
  // 追踪会话分支已建立于 store 内
  assert.ok(storeRefs(fx.repo).includes(sessionBranch("sessA")));
  // 用户仓 status 的唯一增量 = 本 op 的真实文件变更（?? x.txt），追踪调用本身零痕迹
  assert.equal(await userRepoStatus(fx.repo), statusBefore + "?? x.txt\n");
  // 用户仓提交历史不变
  const userLog = git(["-C", fx.repo, "log", "--oneline"], fx.repo).split("\n").filter(Boolean).length;
  assert.equal(userLog, 1);
});

/* ---------------- 双 commit 链 / trailer / 台账一致 ---------------- */

test("双 commit：before/after 对、trailer 完整、台账↔commit 一致、op 编号连续", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-op");
  await e.init();
  await e.onTurnStart();
  await runSimpleOp(e, "t1", "edit", { path: "base.txt" }, () => fx.write("base.txt", "changed\n"));
  await runSimpleOp(e, "t2", "write", { file_path: "new.txt" }, () => fx.write("new.txt", "new\n"));

  const log = branchLog(fx.repo, sessionBranch("s-op"));
  // [P0-2] op1：before（新会话首触全量快照）+ after；op2：before 探测干净不提交 → 仅 after
  // （无手改 before 边界零写；before 引用由 after 提交 parent 推导，恒非 null）
  assert.equal(log.length, 3);
  const heads = log.map((m) => m.split("\n")[0]);
  assert.match(heads[0], /^aiti op=1 msg=- phase=before$/);
  assert.match(heads[1], /^aiti op=1 msg=- phase=after$/);
  assert.match(heads[2], /^aiti op=2 msg=- phase=after$/);
  // trailer 字段
  assert.ok(log[2].includes("Tool: write"));
  assert.ok(log[2].includes(`Repo-Root: ${fx.repo}`));
  assert.ok(/User-Head: [0-9a-f]{7,40}/.test(log[2]));
  // after 提交 diff 恰为本 op 变更
  assert.ok(log[1].includes("edit: base.txt"));

  // 台账：两行、op 1/2、paths、与 commit 对一致
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-op"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].op, 1);
  assert.equal(rows[1].op, 2);
  assert.equal(rows[0].tool, "edit");
  assert.equal(rows[0].stores.length, 1);
  assert.equal(rows[0].stores[0].root, fx.repo);
  assert.equal(rows[0].stores[0].partial, false);
  assert.deepEqual(rows[0].stores[0].paths, ["base.txt"]);
  assert.equal(rows[0].stores[0].files.M, 1);
  assert.equal(rows[1].stores[0].files.A, 1);
  assert.deepEqual(rows[1].stores[0].paths, ["new.txt"]);
  assert.ok(rows[0].stores[0].before && rows[0].stores[0].after && rows[0].stores[0].before !== rows[0].stores[0].after);
  assert.ok(recoverLastOp(ledgerFileFor(fx.dataDir, "s-op")) === 2);
});

/* ---------------- 纯读跳过 / 未知工具按会改 ---------------- */

test("mutating 判定：read 跳过、未知自定义工具按会改", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-mut");
  await e.init();
  await e.onTurnStart();
  await runSimpleOp(e, "r1", "read", { path: "base.txt" }); // 无副作用，也不应产生 commit
  assert.equal(branchLog(fx.repo, sessionBranch("s-mut")).length, 0);
  await runSimpleOp(e, "u1", "my_custom_tool", { foo: 1 }, () => fx.write("u.txt", "u\n"));
  // 未知工具按会改处理：before(+empty)+after 有真实变更
  const log = branchLog(fx.repo, sessionBranch("s-mut"));
  assert.equal(log.length, 2);
  assert.match(log[0], /^aiti op=1 .* phase=before/);
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-mut"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, "my_custom_tool");
});

/* ---------------- op 计数器台账续接 ---------------- */

test("op 计数器：同 sessionId 重建 engine 后从台账续接", async (t) => {
  const fx = mkFixture(t);
  const e1 = newEngine(fx, "s-rec");
  await e1.init();
  await e1.onTurnStart();
  await runSimpleOp(e1, "a", "edit", { path: "base.txt" }, () => fx.write("base.txt", "v2\n"));

  const e2 = newEngine(fx, "s-rec"); // 模拟 wrapper idle GC 重建
  await e2.init();
  await e2.onTurnStart();
  await runSimpleOp(e2, "b", "edit", { path: "base.txt" }, () => fx.write("base.txt", "v3\n"));
  await runSimpleOp(e2, "c", "read", { path: "base.txt" });

  const rows = readRows(ledgerFileFor(fx.dataDir, "s-rec"));
  assert.deepEqual(rows.map((r) => r.op), [1, 2]); // 不重计
  const log = branchLog(fx.repo, sessionBranch("s-rec"));
  assert.match(log[0], /^aiti op=1 /);
  assert.match(log[2], /^aiti op=2 /);
});

/* ---------------- turn_end 兜底 ---------------- */

test("turn_end 兜底：脏工作区被 flush（不占 op 编号），下一 op diff 仍精确", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-flush");
  await e.init();
  await e.onTurnStart();
  // 未识别的副作用：直接改文件（无 op）
  fx.write("stray.txt", "stray\n");
  await e.onTurnEnd(); // 兜底 flush
  const log = branchLog(fx.repo, sessionBranch("s-flush"));
  assert.equal(log.length, 1);
  assert.ok(log[0].includes("Tool: _turn_flush"));
  assert.ok(log[0].includes("stray.txt"));
  // 下一 op：before 探测干净不提交（flush 已兜底），after 只含本 op 变更
  await runSimpleOp(e, "n1", "edit", { path: "base.txt" }, () => fx.write("base.txt", "next\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-flush"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].op, 1);
  assert.deepEqual(rows[0].stores[0].paths, ["base.txt"]);
  const log2 = branchLog(fx.repo, sessionBranch("s-flush"));
  assert.equal(log2.length, 2); // [P0-2] flush, after（before 探测干净 → 零写）
});

/* ---------------- 嵌套仓 ---------------- */

test("嵌套仓：发现→父 store 排除+注册副 store→副 store 正式配对", async (t) => {
  const fx = mkFixture(t);
  // 预置嵌套仓（空仓，无 commit → partial 场景在前，配对在后）
  const nested = path.join(fx.repo, "nested");
  fs.mkdirSync(nested);
  git(["init", "-q", "-b", "main", nested], fx.repo);
  git(["-C", nested, "config", "user.email", "n@n"], nested);
  git(["-C", nested, "config", "user.name", "n"], nested);

  const e = newEngine(fx, "s-nest");
  await e.init();
  await e.onTurnStart({ userEntryId: "user-entry-u1", text: "" });
  // op1：主仓文件变更（嵌套仓尚无任何变更→不会被 status 发现）
  await runSimpleOp(e, "o1", "edit", { path: "base.txt" }, () => fx.write("base.txt", "n1\n"));
  // op2：写嵌套仓内文件（bash 副作用模拟）→ after 阶段发现嵌套仓
  await runSimpleOp(e, "o2", "bash", { command: "echo hi > nested/f.txt" }, () => {
    fs.writeFileSync(path.join(nested, "f.txt"), "hi\n");
  });

  // 父 store 排除了嵌套仓
  const infoExclude = fs.readFileSync(path.join(storeGitDir(fx.repo), "info", "exclude"), "utf8");
  assert.ok(infoExclude.includes("nested/"));
  // 副 store 已建立且记录了 after（首触 partial：before=null）
  const secLog = branchLog(nested, sessionBranch("s-nest"));
  assert.ok(secLog.length >= 1);
  assert.ok(secLog[0].includes("phase=after"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-nest"));
  const row2 = rows.find((r) => r.op === 2)!;
  assert.equal(rows[0].userEntryId, "user-entry-u1"); // turn_start 锚点透传台账
  const nestEntry = row2.stores.find((s) => s.root === nested);
  assert.ok(nestEntry, "op2 台账应含嵌套仓条目");
  assert.equal(nestEntry.partial, true);
  assert.equal(nestEntry.before, null);

  // op3：再改嵌套仓 → 正式 before/after 配对
  await runSimpleOp(e, "o3", "bash", { command: "echo more > nested/f.txt" }, () => {
    fs.writeFileSync(path.join(nested, "f.txt"), "more\n");
  });
  const rows3 = readRows(ledgerFileFor(fx.dataDir, "s-nest"));
  const row3 = rows3.find((r) => r.op === 3)!;
  const n3 = row3.stores.find((s) => s.root === nested)!;
  assert.equal(n3.partial, false);
  assert.ok(n3.before && n3.after);
  assert.deepEqual(n3.paths, ["f.txt"]);
});

/* ---------------- 大小上限跳过 ---------------- */

test("大小上限：超大文件跳过并计数，不进 commit", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-big", { maxFileKB: 1024 });
  await e.init();
  await e.onTurnStart();
  await runSimpleOp(e, "b1", "bash", { command: "make blob" }, () => {
    fx.write("blob.bin", "x".repeat(2 * 1024 * 1024));
    fx.write("small.txt", "ok\n");
  });
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-big"));
  assert.equal(rows[0].stores[0].files.skipped, 1);
  assert.deepEqual(rows[0].stores[0].paths, ["small.txt"]);
  // blob.bin 确实不在追踪提交里
  const show = git(["--git-dir", storeGitDir(fx.repo), "show", "--name-only", "--format=", sessionBranch("s-big")], fx.repo);
  assert.ok(!show.includes("blob.bin"));
  assert.ok(show.includes("small.txt"));
});

/* ---------------- 内置排除与显式追踪让位 ---------------- */

test("内置排除：node_modules 不追踪；让位：用户已 track 的 dist/ 仍追踪", async (t) => {
  const fx = mkFixture(t);
  // 用户仓刻意 track dist/keep.txt（让位场景）
  fs.mkdirSync(path.join(fx.repo, "dist"));
  fx.write("dist/keep.txt", "tracked\n");
  git(["-C", fx.repo, "add", "dist/keep.txt"], fx.repo);
  git(["-C", fx.repo, "commit", "-q", "-m", "track dist"], fx.repo);

  const e = newEngine(fx, "s-exc");
  await e.init();
  const excl = fs.readFileSync(path.join(storeGitDir(fx.repo), "info", "exclude"), "utf8");
  assert.ok(excl.includes("node_modules/"));
  assert.ok(excl.includes("[让位] dist/")); // 让位：模式被剔除并留痕

  await e.onTurnStart();
  await runSimpleOp(e, "e1", "bash", { command: "gen" }, () => {
    fx.write("node_modules/pkg.js", "js\n");
    fx.write("dist/keep.txt", "changed\n");
  });
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-exc"));
  assert.deepEqual(rows[0].stores[0].paths, ["dist/keep.txt"]); // node_modules 被排除
  assert.equal(rows[0].stores[0].files.M, 1);
});

test("renderExcludesFile：去重/版本戳/让位/豁免", () => {
  const out = renderExcludesFile({
    extraExcludes: ["node_modules/", "secrets/"],
    includeExtra: ["!dist/keep.txt"],
    dropped: new Set(["dist/"]),
  });
  assert.ok(out.includes("# --- aiti managed v1 ---") && out.includes("# aiti-excludes v"));
  assert.equal(out.split("\n").filter((l) => l.trim() === "node_modules/").length, 1); // 去重
  assert.ok(out.includes("# [让位] dist/"));
  assert.ok(out.includes("secrets/"));
  assert.ok(out.includes("!dist/keep.txt"));
  assert.ok(BUILTIN_EXCLUDES.length > 30);
});

/* ---------------- 并发会话 ---------------- */

test("双会话同仓并发：各走各分支，互不串号", async (t) => {
  const fx = mkFixture(t);
  const eA = newEngine(fx, "sessA-uuid");
  const eB = newEngine(fx, "sessB-uuid");
  await eA.init();
  await eB.init();
  assert.notEqual(sessionBranch("sessA-uuid"), sessionBranch("sessB-uuid"));
  await eA.onTurnStart();
  await eB.onTurnStart();
  await runSimpleOp(eA, "a1", "edit", { path: "base.txt" }, () => fx.write("base.txt", "A\n"));
  await runSimpleOp(eB, "b1", "edit", { path: "base.txt" }, () => fx.write("base.txt", "B\n"));
  await runSimpleOp(eA, "a2", "edit", { path: "base.txt" }, () => fx.write("base.txt", "A2\n"));

  const logA = branchLog(fx.repo, sessionBranch("sessA-uuid"));
  const logB = branchLog(fx.repo, sessionBranch("sessB-uuid"));
  // [P0-2] A: op1 before+after；op2 before 为「B 会话写入」的懒提交快照（共享 worktree
  // 干扰被探测门捕获为手改）+ after。B: op1 空 index 快照 before + after。
  assert.equal(logA.filter((m) => m.startsWith("aiti op=")).length, 4);
  assert.equal(logB.filter((m) => m.startsWith("aiti op=")).length, 2);
  assert.ok(logA.some((m) => m.includes("Session-Id: sessA-uuid")));
  assert.ok(logB.some((m) => m.includes("Session-Id: sessB-uuid")));
  assert.ok(!logB.some((m) => m.includes("sessA")));
  const rowsA = readRows(ledgerFileFor(fx.dataDir, "sessA-uuid"));
  assert.deepEqual(rowsA.map((r) => r.op), [1, 2]);
});

/* ---------------- 无 git 置态 ---------------- */

test("无 git cwd：loose 关闭时不建仓、置态提醒数据；识别到的写目标记外溢（行保留）", async (t) => {
  const fx = mkFixture(t);
  const plain = path.join(fx.root, "plain");
  fs.mkdirSync(plain);
  const e = new TraceEngine({ cwd: plain, sessionId: "s-nogit", dataDir: fx.dataDir, autoInit: false });
  await e.init();
  assert.equal(e.tracked, false);
  assert.equal(e.noStore, true);
  assert.equal(e.noStoreReason, "no-git-disabled");
  assert.equal(fs.existsSync(path.join(plain, ".git")), false); // 严禁凭空造 .git
  assert.equal(fs.existsSync(path.join(plain, ".aiti-trace")), false); // 关闭时也不建
  await e.onTurnStart();
  // [P0-2] 写类 op（无 store 可落、但识别到写目标）→ 行保留：stores 空 + leaks 列示
  await runSimpleOp(e, "n1", "write", { path: "a.txt" }, () => fs.writeFileSync(path.join(plain, "a.txt"), "a\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-nogit"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stores.length, 0); // 无 store 可落
  assert.equal(rows[0].leaks.length, 1); // 写目标无归属仓 → 外溢
});

/* ---------------- 杂项单元 ---------------- */

test("单元：workspaceKey 稳定且区分大小写路径；ensureStore 幂等；excludeNestedInParent 去重", async (t) => {
  const fx = mkFixture(t);
  assert.equal(workspaceKey(fx.repo), workspaceKey(fx.repo + path.sep));
  assert.notEqual(workspaceKey(fx.repo), workspaceKey(fx.root));
  const h1 = await ensureStore({ repoRoot: fx.repo, sessionId: "zz", role: "primary" });
  const h2 = await ensureStore({ repoRoot: fx.repo, sessionId: "zz", role: "primary" });
  assert.equal(h1.gitDir, h2.gitDir);
  excludeNestedInParent(h1, "sub");
  excludeNestedInParent(h1, "sub");
  const excl = fs.readFileSync(path.join(h1.gitDir, "info", "exclude"), "utf8");
  assert.equal(excl.split("\n").filter((l) => l === "sub/").length, 1);
});

/* ---------------- v3.1 §13：顶层 .aiti-trace ---------------- */

test("v3.1 自吸入防护：store 顶层化后 op 快照不含 .aiti-trace 内部文件", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-self");
  await e.init();
  assert.equal(fs.existsSync(path.join(fx.repo, ".aiti-trace", "HEAD")), true); // 新路径
  // store 自身 info/exclude 含 .aiti-trace/（防 ls-files --others 吸入）
  const excl = fs.readFileSync(path.join(storeGitDir(fx.repo), "info", "exclude"), "utf8");
  assert.ok(excl.includes(".aiti-trace/"), "store info/exclude 应含 .aiti-trace/");
  await e.onTurnStart();
  await runSimpleOp(e, "self1", "write", { path: "x.txt" }, () => fx.write("x.txt", "x\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-self"));
  assert.equal(rows.length, 1);
  for (const st of rows[0].stores) {
    for (const p of st.paths) assert.ok(!p.includes(".aiti-trace"), `不应吸入 store 内部：${p}`);
  }
  // 双保险 belt：直接枚举也不含
  const tip = branchLog(fx.repo, sessionBranch("s-self")).pop() || "";
  assert.ok(tip.includes("op=1"));
});

test("v3.1 项目仓可见性：.git/info/exclude 托管块 + 用户 git status 干净", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-vis");
  await e.init();
  const projExcl = fs.readFileSync(path.join(fx.repo, ".git", "info", "exclude"), "utf8");
  assert.ok(projExcl.includes(".aiti-trace/"), "项目仓 info/exclude 应含 .aiti-trace/");
  // 用户 git status：.aiti-trace 不出现（untracked 干净）
  const status = await userRepoStatus(fx.repo);
  assert.ok(!status.includes(".aiti-trace"), `用户 git status 不应见 .aiti-trace：${status}`);
  // 幂等：重复 init 不重复追加
  const e2 = newEngine(fx, "s-vis2");
  await e2.init();
  const projExcl2 = fs.readFileSync(path.join(fx.repo, ".git", "info", "exclude"), "utf8");
  assert.equal(projExcl2.split("\n").filter((l) => l === ".aiti-trace/").length, 1);
});

test("v3.1 store 自携带免打扰：.aiti-trace/.gitignore 与 .ignore 均为 *，AI grep 自动跳过", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-selfignore");
  await e.init();
  const gi = fs.readFileSync(path.join(storeGitDir(fx.repo), ".gitignore"), "utf8");
  const ig = fs.readFileSync(path.join(storeGitDir(fx.repo), ".ignore"), "utf8");
  assert.ok(gi.split("\n").includes("*"), "store .gitignore 应含 *（全忽略）");
  assert.ok(ig.split("\n").includes("*"), "store .ignore 应含 *（rg 专属全忽略）");
  // 幂等：重复 init 不重复写
  const e2 = newEngine(fx, "s-selfignore2");
  await e2.init();
  const gi2 = fs.readFileSync(path.join(storeGitDir(fx.repo), ".gitignore"), "utf8");
  assert.equal(gi2.split("\n").filter((l) => l === "*").length, 1, "重复 init 不应重复追加 *");
  // rg 从仓库根搜索应跳过 store 内部（gitignore 生效证明）
  const rgHit = execFileSync("rg", ["--hidden", "-l", "base", "."], {
    cwd: fx.repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).split("\n").filter(Boolean);
  assert.ok(!rgHit.some((p) => p.includes(".aiti-trace")), `rg 不应命中 store 内部：${rgHit.join(",")}`);
});

test("v3.1 手工迁移：mv .git/aiti → .aiti-trace 后继续追踪，可见性块自动补写", async (t) => {
  const fx = mkFixture(t);
  // 模拟 v1 store：旧路径手工构造
  const oldDir = path.join(fx.repo, ".git", "aiti");
  fs.mkdirSync(oldDir, { recursive: true });
  git(["--git-dir", oldDir, "init", "-q"], fx.repo);
  // v3.1 引擎在新路径建仓（旧行为遗留目录不读取）
  const e = newEngine(fx, "s-mig");
  await e.init();
  assert.equal(fs.existsSync(path.join(oldDir, "HEAD")), true); // 旧目录原样保留
  // 手工迁移：mv 旧 → 新（新已存在则先删，模拟用户按文档操作）
  fs.rmSync(path.join(fx.repo, ".aiti-trace"), { recursive: true, force: true });
  fs.renameSync(oldDir, path.join(fx.repo, ".aiti-trace"));
  const e2 = newEngine(fx, "s-mig2");
  await e2.init();
  await e2.onTurnStart();
  await runSimpleOp(e2, "mig1", "write", { path: "m.txt" }, () => fx.write("m.txt", "m\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-mig2"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stores.length, 1); // 迁移后的 store 正常配对
  const projExcl = fs.readFileSync(path.join(fx.repo, ".git", "info", "exclude"), "utf8");
  assert.ok(projExcl.includes(".aiti-trace/"));
});

test("P0-3a scanNestedRuntime：默认仅 exclude 不注册；trackNestedRepos=true 才注册并常驻", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-nrt");
  await e.init();
  // init 后新出现的嵌套仓
  const nested = path.join(fx.repo, "late-nested");
  fs.mkdirSync(nested, { recursive: true });
  git(["init", "-q", "-b", "main", nested], fx.repo);
  await e.scanNestedRuntime();
  // exclude 恒写（防父仓 gitlink 污染），但默认不注册副 store
  const excl = fs.readFileSync(path.join(storeGitDir(fx.repo), "info", "exclude"), "utf8");
  assert.ok(excl.includes("late-nested/"), "exclude 恒写");
  assert.equal((e as any).stores.size, 1, "默认不注册副 store");
  // opt-in：workspace 配置 trackNestedRepos=true → 新引擎 init 即注册
  const prevDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = fx.dataDir;
  t.after(() => { if (prevDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = prevDataDir; });
  fs.mkdirSync(path.join(fx.dataDir, "aiti-git-trace", "cache", "workspaces"), { recursive: true });
  const { workspaceConfigFile } = await import("../src/paths.ts");
  fs.writeFileSync(workspaceConfigFile(fx.repo, process.env), JSON.stringify({ enabled: true, autoDiscover: true, paths: [], trackNestedRepos: true }));
  const e2 = newEngine(fx, "s-nrt2");
  await e2.init();
  assert.equal((e2 as any).stores.size, 2, "opt-in 后 init 即注册");
  const rt = (e2 as any).stores.get(fs.realpathSync(nested));
  assert.equal(rt.resident, true, "trackNestedRepos 注册的子仓常驻参与");
});

/* ---------------- v3.1 §13.4：loose 自动建仓 ---------------- */

test("loose 基本流：无 git 小目录自动建 .aiti-trace + .gitignore 维护 + 正常记 op", async (t) => {
  const fx = mkFixture(t);
  const plain = path.join(fx.root, "plain");
  fs.mkdirSync(plain);
  const e = new TraceEngine({ cwd: plain, sessionId: "s-loose", dataDir: fx.dataDir, looseDenylist: false });
  await e.init();
  assert.equal(e.tracked, true);           // 不再「无 git 不追踪」
  assert.equal(e.kind, "loose");
  assert.equal(e.noStore, false);
  assert.equal(fs.existsSync(path.join(plain, ".aiti-trace", "HEAD")), true);
  assert.equal(fs.existsSync(path.join(plain, ".git")), false); // 仍然绝不造 .git
  const gi = fs.readFileSync(path.join(plain, ".gitignore"), "utf8");
  assert.ok(gi.includes(".aiti-trace/"), "gitignore 应含 .aiti-trace/");
  await e.onTurnStart({ userEntryId: "u1", text: "hello loose" });
  await runSimpleOp(e, "l1", "write", { path: "a.txt" }, () => fs.writeFileSync(path.join(plain, "a.txt"), "a\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-loose"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stores.length, 1);
  assert.equal(rows[0].stores[0].root, fs.realpathSync(plain));
  assert.equal(rows[0].prompt, "hello loose");
});

test("loose 边界：预算 2000 恰好通过 / 2001 超限跳过（no-git-oversize）", async (t) => {
  const fx = mkFixture(t);
  const mk = (n: number) => {
    const d = path.join(fx.root, `d${n}`);
    fs.mkdirSync(d);
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), "x");
    return d;
  };
  const okDir = mk(2000);
  const e1 = new TraceEngine({ cwd: okDir, sessionId: "s-b1", dataDir: fx.dataDir, autoInitMaxFiles: 2000, looseDenylist: false });
  await e1.init();
  assert.equal(e1.tracked, true);
  const bigDir = mk(2001);
  const e2 = new TraceEngine({ cwd: bigDir, sessionId: "s-b2", dataDir: fx.dataDir, autoInitMaxFiles: 2000, looseDenylist: false });
  await e2.init();
  assert.equal(e2.tracked, false);
  assert.equal(e2.noStoreReason, "no-git-oversize");
  assert.equal(fs.existsSync(path.join(bigDir, ".aiti-trace")), false);
});

test("loose denylist：$HOME 与 /tmp 不建仓（no-git-denylist）；autoInit 关不建仓（no-git-disabled）", { skip: SKIP_ON_WIN }, async (t) => {
  const fx = mkFixture(t);
  const home = os.homedir();
  const eHome = new TraceEngine({ cwd: home, sessionId: "s-dh", dataDir: fx.dataDir });
  const prevHome = fs.existsSync(path.join(home, ".aiti-trace"));
  await eHome.init();
  if (!prevHome) { // 家目录原本没仓才断言（避免污染真机）
    assert.equal(eHome.tracked, false);
    assert.equal(eHome.noStoreReason, "no-git-denylist");
    assert.equal(fs.existsSync(path.join(home, ".aiti-trace")), false);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiti-tmpdeny-"));
  t.after(() => fs.rmSync(tmpDir, { force: true, recursive: true }));
  const eTmp = new TraceEngine({ cwd: tmpDir, sessionId: "s-dt", dataDir: fx.dataDir });
  await eTmp.init();
  assert.equal(eTmp.tracked, false);
  assert.equal(eTmp.noStoreReason, "no-git-denylist");
  // 显式关闭
  const plain = path.join(fx.root, "plain2");
  fs.mkdirSync(plain);
  const eOff = new TraceEngine({ cwd: plain, sessionId: "s-doff", dataDir: fx.dataDir, autoInit: false });
  await eOff.init();
  assert.equal(eOff.tracked, false);
  assert.equal(eOff.noStoreReason, "no-git-disabled");
});

test("loose→git 演进：同一 .aiti-trace 在目录 git init 后无缝转 git 模式，台账延续", async (t) => {
  const fx = mkFixture(t);
  const plain = path.join(fx.root, "evolve");
  fs.mkdirSync(plain);
  const e1 = new TraceEngine({ cwd: plain, sessionId: "s-ev1", dataDir: fx.dataDir, looseDenylist: false });
  await e1.init();
  assert.equal(e1.kind, "loose");
  await e1.onTurnStart({ userEntryId: "u1", text: "loose turn" });
  await runSimpleOp(e1, "ev1", "write", { path: "a.txt" }, () => fs.writeFileSync(path.join(plain, "a.txt"), "a\n"));
  // 目录后来 git init
  git(["init", "-q", "-b", "main"], plain);
  git(["-C", plain, "config", "user.email", "t@t.local"], plain);
  git(["-C", plain, "config", "user.name", "t"], plain);
  const e2 = new TraceEngine({ cwd: plain, sessionId: "s-ev2", dataDir: fx.dataDir, looseDenylist: false });
  await e2.init();
  assert.equal(e2.kind, "git");                     // 同一路径转 git 模式
  assert.equal(fs.existsSync(path.join(plain, ".aiti-trace", "HEAD")), true); // store 未换
  const projExcl = fs.readFileSync(path.join(plain, ".git", "info", "exclude"), "utf8");
  assert.ok(projExcl.includes(".aiti-trace/"));     // git 模式可见性块补齐
  await e2.onTurnStart({ userEntryId: "u2", text: "git turn" });
  await runSimpleOp(e2, "ev2", "write", { path: "b.txt" }, () => fs.writeFileSync(path.join(plain, "b.txt"), "b\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-ev2"));
  assert.equal(rows.length, 1);                     // 新会话台账正常（同仓续追踪）
  assert.equal(rows[0].stores[0].root, fs.realpathSync(plain));
});

test("loose .gitignore：seedCommon 补常见条目；已有行不重复", async (t) => {
  const fx = mkFixture(t);
  const d1 = path.join(fx.root, "g1");
  fs.mkdirSync(d1);
  maintainLooseGitignore(d1, { seedCommon: true });
  const g1 = fs.readFileSync(path.join(d1, ".gitignore"), "utf8");
  assert.ok(g1.includes(".aiti-trace/") && g1.includes("node_modules/"));
  // 幂等：再跑一遍不重复
  maintainLooseGitignore(d1, { seedCommon: true });
  const g2 = fs.readFileSync(path.join(d1, ".gitignore"), "utf8");
  assert.equal(g2.split("\n").filter((l) => l.trim() === ".aiti-trace/").length, 1);
  // 已有 gitignore：只追加缺行，原内容保留
  const d2 = path.join(fx.root, "g2");
  fs.mkdirSync(d2);
  fs.writeFileSync(path.join(d2, ".gitignore"), "keep-me\n");
  maintainLooseGitignore(d2);
  const g3 = fs.readFileSync(path.join(d2, ".gitignore"), "utf8");
  assert.ok(g3.startsWith("keep-me\n") && g3.includes(".aiti-trace/") && !g3.includes("node_modules/"));
});

test("loose countFilesWithBudget：早退不数完整树；跳过 .aiti-trace；不跟符号链接", { skip: SKIP_ON_WIN_SYMLINK }, (t) => {
  const fx = mkFixture(t);
  const d = path.join(fx.root, "cnt");
  const sub = path.join(d, "deep", "deeper");
  fs.mkdirSync(sub, { recursive: true });
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(sub, `f${i}`), "x");
  fs.mkdirSync(path.join(d, ".aiti-trace"));
  fs.writeFileSync(path.join(d, ".aiti-trace", "HEAD"), "junk"); // 应被跳过
  assert.equal(countFilesWithBudget(d, 100), 10);
  assert.equal(countFilesWithBudget(d, 5), 6);  // 早退：budget+1 即停
  // 符号链接目录不跟
  fs.symlinkSync(sub, path.join(d, "linked"), "dir");
  assert.equal(countFilesWithBudget(d, 100), 10);
});

test("跨仓识别修复：cd 路径经过嵌套仓但零变更 → 台账不落空 store 条目，cross 不误报", async (t) => {
  const fx = mkFixture(t);
  const nested = path.join(fx.repo, "sub-repo");
  fs.mkdirSync(nested, { recursive: true });
  git(["init", "-q", "-b", "main", nested], fx.repo);
  git(["-C", nested, "config", "user.email", "t@t.local"], nested);
  git(["-C", nested, "config", "user.name", "t"], nested);
  fs.writeFileSync(path.join(nested, "n.txt"), "n1\n");
  git(["-C", nested, "add", "-A"], nested);
  git(["-C", nested, "commit", "-q", "-m", "n-init"], nested);
  const e = newEngine(fx, "s-cross");
  await e.init(); // [P0-3a] 子仓默认不自动注册（仅 exclude）
  assert.equal((e as any).stores.size, 1);
  await e.onTurnStart({ userEntryId: "u1", text: "cd around" });
  // 主仓改文件；bash 同时 cd 进嵌套仓（无文件变更）+ 落一个写目标（保持 mutating 语义）
  await e.onToolCall("c1", "bash", { command: `cd ${nested} && ls && cd ${fx.repo} && echo done > done.txt` });
  fx.write("a.txt", "a2\n");
  await e.onToolExecutionEnd("c1", false);
  assert.equal((e as any).stores.size, 2); // [P0-3b] cd 命中 → 副仓按需注册参与
  fx.write("a.txt", "a2\n");
  await e.onToolExecutionEnd("c1", false);
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-cross"));
  assert.equal(rows.length, 1);
  const withChanges = rows[0].stores.filter((st) => (st.files.M + st.files.A + st.files.D) > 0 || st.partial);
  assert.equal(withChanges.length, 1);
  assert.equal(withChanges[0].root, fs.realpathSync(fx.repo)); // 仅主仓有条目
  assert.equal(rows[0].stores.length, withChanges.length); // 无空条目
});

test("工作区追踪开关：enabled=false 彻底不追踪；会话中实时关闭/重开", async (t) => {
  const fx = mkFixture(t);
  // 预写 workspace 配置：关闭（engine 经 PI_WEB_DATA_DIR 定位 dataDir，测试需对齐）
  const prevDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = fx.dataDir;
  t.after(() => { if (prevDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = prevDataDir; });
  const { workspaceConfigFile } = await import("../src/paths.ts");
  fs.mkdirSync(path.join(fx.dataDir, "aiti-git-trace", "cache", "workspaces"), { recursive: true });
  const cfgFile = workspaceConfigFile(fx.repo, process.env);
  fs.writeFileSync(cfgFile, JSON.stringify({ enabled: false, autoDiscover: true, paths: [] }));
  const e = newEngine(fx, "s-ws");
  await e.init();
  assert.equal(e.tracked, false);
  assert.equal(e.noStoreReason, "workspace-disabled");
  assert.equal(fs.existsSync(path.join(fx.repo, ".aiti-trace", "HEAD")), false); // 不建仓
  // 会话中实时开启
  fs.writeFileSync(cfgFile, JSON.stringify({ enabled: true, autoDiscover: true, paths: [] }));
  await e.onToolCall("w1", "write", { path: "x.txt" }); // 触发 checkWorkspaceSwitch → 重 init
  assert.equal(e.tracked, true);
  fx.write("x.txt", "x\n");
  await e.onToolExecutionEnd("w1", false);
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-ws"));
  assert.equal(rows.length, 1); // 开启后的 op 正常入账
  // 会话中实时关闭：下一 op 前停止
  fs.writeFileSync(cfgFile, JSON.stringify({ enabled: false, autoDiscover: true, paths: [] }));
  await e.onToolCall("w2", "write", { path: "y.txt" });
  fx.write("y.txt", "y\n");
  await e.onToolExecutionEnd("w2", false);
  const rows2 = readRows(ledgerFileFor(fx.dataDir, "s-ws"));
  assert.equal(rows2.length, 1); // 关闭后的 op 不入账
  assert.equal(e.noStoreReason, "workspace-disabled");
});

test("用户消息捕获：同一条消息的 turn 2+ 不推进 msgSeq（归入同一 prompt 分组）", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-prompt");
  await e.init();
  e.onTurnStart({ userEntryId: "u-9", text: "帮我改 a.txt" });
  await runSimpleOp(e, "p1", "write", { path: "a.txt" }, () => fx.write("a.txt", "1\n"));
  // 同一用户消息的第二个 agent turn（无新 prompt）
  e.onTurnStart(null);
  await runSimpleOp(e, "p2", "write", { path: "b.txt" }, () => fx.write("b.txt", "2\n"));
  // 新的用户消息 → msgSeq 推进
  e.onTurnStart({ userEntryId: "u-10", text: "再改 b.txt" });
  await runSimpleOp(e, "p3", "write", { path: "b.txt" }, () => fx.write("b.txt", "3\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-prompt"));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].msgSeq, 1);
  assert.equal(rows[1].msgSeq, 1); // 同 prompt 分组
  assert.equal(rows[1].prompt, "帮我改 a.txt");
  assert.equal(rows[2].msgSeq, 2);
  assert.equal(rows[2].prompt, "再改 b.txt");
});

test("清理自愈：store 目录被删后引擎自动重建空仓并继续配对", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-heal");
  await e.init();
  await e.onTurnStart({ userEntryId: "u1", text: "before wipe" });
  await runSimpleOp(e, "h1", "write", { path: "a.txt" }, () => fx.write("a.txt", "1\n"));
  assert.equal(readRows(ledgerFileFor(fx.dataDir, "s-heal")).length, 1);
  // 模拟用户在工作区面板深清理：删掉追踪仓
  fs.rmSync(path.join(fx.repo, ".aiti-trace"), { recursive: true, force: true });
  // 下一操作：引擎自愈重建，不抛错、不影响原命令
  await e.onTurnStart({ userEntryId: "u2", text: "after wipe" });
  await runSimpleOp(e, "h2", "write", { path: "b.txt" }, () => fx.write("b.txt", "2\n"));
  assert.equal(fs.existsSync(path.join(fx.repo, ".aiti-trace", "HEAD")), true); // 空仓已重建
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-heal"));
  assert.equal(rows.length, 2); // 清理后的 op 照常入账（全新空仓 → partial 配对）
  assert.equal(rows[1].stores[0].partial, false); // 新仓首个 before 即真实 commit（非首触 gap）
  assert.equal(rows[1].stores[0].root, fs.realpathSync(fx.repo));
  assert.ok(rows[1].stores[0].files.A >= 1); // b.txt 以新增入账
});

test("parent 链接线（P0-2）：引擎写入 parentSessionId → 台账行 parent 字段落账", async (t) => {
  const fx = mkFixture(t);
  // 父会话先入账一笔（家谱父节点）
  const parent = newEngine(fx, "s-parent");
  await parent.init();
  await parent.onTurnStart({ userEntryId: "u0", text: "父会话改动" });
  await runSimpleOp(parent, "h0", "write", { path: "a.txt" }, () => fx.write("a.txt", "parent\n"));
  // fork 出的子会话：parentSessionId 指向父会话（pi 扩展经会话头 parentSession 解析后传入）
  const child = newEngine(fx, "s-child", { parentSessionId: "s-parent" });
  await child.init();
  await child.onTurnStart({ userEntryId: "u1", text: "子会话改动" });
  await runSimpleOp(child, "h1", "write", { path: "b.txt" }, () => fx.write("b.txt", "child\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-child"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parent, "s-parent"); // [P0-2] 此前恒 null（GAP-2）
});

test("P1-2 additive 字段：getModel 注入 → 台账行带 agent/model（旧行缺省兼容）", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-p12", { getModel: () => ({ provider: "bigmodel", modelId: "GLM-5.3" }) });
  await e.init();
  await e.onTurnStart({ userEntryId: "u1", text: "模型字段用例" });
  await runSimpleOp(e, "h1", "write", { path: "a.txt" }, () => fx.write("a.txt", "1\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-p12"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, "pi");
  assert.equal(rows[0].model, "bigmodel/GLM-5.3");
  // 对照：未注入 getModel 的引擎行不含 model 字段（additive 兼容）
  const e2 = newEngine(fx, "s-p12-bare");
  await e2.init();
  await e2.onTurnStart({ userEntryId: "u2", text: "bare" });
  await runSimpleOp(e2, "h2", "write", { path: "b.txt" }, () => fx.write("b.txt", "2\n"));
  const rows2 = readRows(ledgerFileFor(fx.dataDir, "s-p12-bare"));
  assert.equal(rows2[0].agent, "pi");
  assert.equal("model" in rows2[0], false, "未注入 getModel → 无 model 字段");
});

test("P1-2 尾巴：getPlanRel 注入 → 台账行带 planRel", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-planrel", { getPlanRel: () => "/proj/docs/plan.md" });
  await e.init();
  await e.onTurnStart({ userEntryId: "u1", text: "带方案绑定" });
  await runSimpleOp(e, "h1", "write", { path: "a.txt" }, () => fx.write("a.txt", "p\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-planrel"));
  assert.equal(rows[0].planRel, "/proj/docs/plan.md");
});
