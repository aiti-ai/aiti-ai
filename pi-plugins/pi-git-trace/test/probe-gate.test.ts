/**
 * P0 优化测试（docs/aiti-git-trace-op-cost-optimization-plan.md §6）：
 *  - classifyBashMutability 样本集（零容忍方向：写误判为读 = 缺陷；只读误判为写 = 可接受）
 *  - 探测门态矩阵（无变化跳过 / touch-only refresh 消化 / 改回原内容不提交 /
 *    分支不存在 fallback / untracked 走枚举 / 删除检出）
 *  - tag 懒打配对（有变化 op 成对、无变化 op 零 tag）+ before 非空约束（除首触）
 *  - 台账空行省略 + op 跳号续接 + bash 只读 op 号不消费
 *  - P0-3 命中仓收敛 / watchPaths 常驻 / turn_end flush 收敛
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { TraceEngine } from "../src/engine.ts";
import { classifyBashMutability } from "../lib/recognize.ts";
import { storeGitDir } from "../src/store.ts";
import { ledgerFileFor, sessionBranch } from "../src/paths.ts";
import { readRows, recoverLastOp } from "../src/ledger.ts";

const GIT_ENV = { ...process.env };
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
}

interface Fixture {
  root: string;
  repo: string;
  dataDir: string;
  write(rel: string, content: string): string;
  rm(rel: string): void;
  cleanup(): void;
}

function mkFixture(t: import("node:test").TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aiti-gate-${t.name.replace(/[^a-z0-9]/gi, "-")}-`));
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
    rm: (rel) => fs.rmSync(path.join(repo, rel), { force: true }),
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
  };
  t.after(() => fx.cleanup());
  return fx;
}

function newEngine(fx: Fixture, sessionId: string, extra: Record<string, unknown> = {}): TraceEngine {
  return new TraceEngine({ cwd: fx.repo, sessionId, dataDir: fx.dataDir, ...extra });
}

async function runSimpleOp(e: TraceEngine, toolCallId: string, tool: string, input: unknown, mutate?: () => void) {
  await e.onToolCall(toolCallId, tool, input);
  mutate?.();
  await e.onToolExecutionEnd(toolCallId, false);
}

function branchLog(repo: string, branch: string): string[] {
  try {
    return git(["--git-dir", storeGitDir(repo), "log", "--reverse", "--format=%B%x00", branch], repo)
      .split("\0").map((m) => m.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** 分支提交（sha + 消息首行），时间正序 */
function branchCommits(repo: string, branch: string): Array<{ sha: string; head: string }> {
  try {
    return git(["--git-dir", storeGitDir(repo), "log", "--reverse", "--format=%H%x1f%B%x00", branch], repo)
      .split("\0").map((m) => m.trim()).filter(Boolean)
      .map((m) => { const [sha, body] = m.split("\x1f"); return { sha, head: (body ?? "").split("\n")[0] }; });
  } catch {
    return [];
  }
}

function commitCount(repo: string, branch: string): number {
  return branchLog(repo, branch).length;
}

function tagRefs(repo: string): string[] {
  return git(["--git-dir", storeGitDir(repo), "for-each-ref", "--format=%(refname)", "refs/tags/"], repo)
    .split("\n").map((l) => l.trim()).filter(Boolean).sort();
}

/* ---------------- classifyBashMutability 样本集 ---------------- */

test("P0-1 分类器：只读白名单样本全命中 readonly", () => {
  const readonly: string[] = [
    "ls", "ls -la /tmp", "cat foo.txt", "head -n 5 x", "tail -20 log",
    "wc -l a.txt", "grep -rn pattern .", "rg foo src/", "pwd", "date", "whoami",
    "echo hello", "printf '%s\\n' hi", "env", "printenv PATH", "ps aux", "df -h", "du -sh .",
    "stat foo.txt", "file x", "readlink -f x", "id", "uptime", "tree",
    "jq . a.json", "which node", "type ls",
    "git status", "git log --oneline -5", "git diff", "git show HEAD",
    "git rev-parse HEAD", "git describe --tags", "git ls-files", "git blame f",
    "git shortlog -sn", "git cat-file -p HEAD", "git grep pattern",
    "git branch", "git branch -a", "git branch --list 'x*'", "git branch --show-current",
    "git remote", "git remote -v",
    "git -C /other status", "git -c x=y log", "git --git-dir=/x log",
    "cd /tmp && ls", "cd /x && git status && pwd",
    "ls | grep foo | wc -l", "cat a b | sort | uniq -c",
    "echo $((1+2))", "echo $(date)", "echo `date`",
    "FOO=bar ls", "FOO=1",
    "2>/dev/null ls", "ls 2>/dev/null", "ls 2>&1", "echo x > /dev/null",
    "find . -name '*.ts'", "find . -maxdepth 2 -type f",
    "sort a.txt", "diff a b", "cmp a b", "sha256sum x", "md5sum -c x.sum",
    "sleep 1", "test -f x && echo yes", "true",
    "cat <<'EOF'\nhello\nEOF",
    "",
    "   ",
  ];
  for (const cmd of readonly) {
    assert.equal(classifyBashMutability(cmd), "readonly", `应判定只读：${cmd}`);
  }
});

test("P0-1 分类器：写特征/危险模式零容忍（全部 maybe-write）", () => {
  const write: string[] = [
    // 重定向（含 fd / 追加 / clobber）
    "echo x > f.txt", "echo x >> f.txt", "echo x >| f.txt", "cmd 2> err.log", "cmd &> all.log",
    // 写命令
    "echo x | tee f.txt", "tee f.txt", "sed -i 's/a/b/' f", "sed -i.bak s/a/b/ f",
    "rm x", "cp a b", "mv a b", "touch f", "mkdir d", "ln -s a b", "rmdir d",
    "chmod +x f", "dd of=f", "truncate -s 0 f",
    // git 写子命令
    "git add .", "git commit -m x", "git checkout -b x", "git checkout main",
    "git apply p.diff", "git restore f", "git push", "git pull", "git fetch",
    "git merge x", "git rebase main", "git stash", "git stash pop", "git tag v1",
    "git branch newbranch", "git branch -D x", "git remote add o url", "git remote prune origin",
    "git config x.y z", "git diff --output=f", "git log --output=f",
    // 包管理/构建/解释器（白名单外一律保守）
    "npm install", "npm run build", "pnpm i", "yarn add x", "pip install x",
    "make", "make -C x", "cmake .", "bash -c 'ls'", "sh -c ls", "node -e '1'",
    "python -c '1'", "python3 x.py", "perl -e ''", "awk '{print}' f",
    "xargs ls", "tar -xf a.tgz", "tar -czf b.tgz x", "curl http://x", "wget http://x",
    "docker ps", "kubectl get pods", "ssh host", "sudo ls /etc", "sudo -u root ls",
    // 危险旗标
    "find . -name x -delete", "find . -exec rm {} \\;", "find . -fprint out",
    "sort -o out in", "date -s 2020-01-01",
    // 组合/替换/间接执行
    "ls > /dev/null && rm x", "cd /tmp && rm x", "env FOO=1 make", "env -C /x make",
    "sudo tee /etc/x", "nohup make", "time make", "nice make",
    "echo $(rm -rf x)", "echo `rm -rf x`", "$(cmd)", "$CMD", "${CMD}",
    "source x.sh", ". x.sh", "eval ls", "unset FOO", "export FOO=1", "alias ll='ls'",
    "cat <(ls) > f", "echo a >(tee f)", "echo $((1+1)) && touch f",
    "x$((1+2))y > f",
  ];
  for (const cmd of write) {
    assert.equal(classifyBashMutability(cmd), "maybe-write", `必须保守判写：${cmd}`);
  }
});

/* ---------------- 探测门态矩阵（P0-2） ---------------- */

test("P0-2 探测门：无变化写命令零 commit/零 tag/不落台账；op 跳号 + tag 懒打配对", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-gate");
  await e.init();
  await e.onTurnStart();
  // op1：有变化 → before（新会话空 index 探测报脏 → 懒提交全量快照）+ after + 成对 tag
  await runSimpleOp(e, "g1", "bash", { command: "echo hi > a.txt" }, () => fx.write("a.txt", "hi\n"));
  // op2：touch-only（mutating 但 refresh 消化）→ 零 commit/零 tag/零台账行
  await runSimpleOp(e, "g2", "bash", { command: "touch a.txt" });
  // op3：有变化 → before 探测干净（零写）+ after + before-3/after-3 成对 tag
  await runSimpleOp(e, "g3", "bash", { command: "echo more > a.txt" }, () => fx.write("a.txt", "more\n"));

  const branch = sessionBranch("s-gate");
  assert.equal(commitCount(fx.repo, branch), 3, "快照+after1+after3（无变化 op 零提交）");
  const short = branch.split("/").pop();
  const tips = branchCommits(fx.repo, branch).map((c) => c.head);
  assert.match(tips[0], /^aiti op=1 .* phase=before$/);
  assert.match(tips[1], /^aiti op=1 .* phase=after$/);
  assert.match(tips[2], /^aiti op=3 .* phase=after$/);
  // tag 配对：op1 的 before 引用 = 懒提交快照（新会话空 index 探测报脏）→ 成对；op3 成对；op2 零 tag
  assert.deepEqual(tagRefs(fx.repo), [
    `refs/tags/aiti/${short}/after-1`,
    `refs/tags/aiti/${short}/after-3`,
    `refs/tags/aiti/${short}/before-1`,
    `refs/tags/aiti/${short}/before-3`,
  ]);
  // before-N → before 边界引用（懒提交 sha / 旧 tip），after-N → 新 commit
  const shaOf = (phase: string, op: number) =>
    git(["--git-dir", storeGitDir(fx.repo), "rev-parse", "--verify", `refs/tags/aiti/${short}/${phase}-${op}^{commit}`], fx.repo).trim();
  const after1 = shaOf("after", 1);
  const before3 = shaOf("before", 3);
  const after3 = shaOf("after", 3);
  assert.equal(before3, after1, "before-N 按旧 tip（commit sha）打");
  const parent3 = git(["--git-dir", storeGitDir(fx.repo), "rev-parse", `${after3}^`], fx.repo).trim();
  assert.equal(parent3, after1, "after 提交 parent = before 引用（同会话串行）");
  // 台账：op2 不落行（跳号），op1/op3 落；before 恒非 null（除真首触/空仓）
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-gate"));
  assert.deepEqual(rows.map((r) => r.op), [1, 3]);
  assert.equal(rows[0].stores[0].partial, false, "before=懒提交快照 sha（非 null）");
  assert.equal(rows[0].stores[0].before, shaOf("before", 1));
  assert.ok(rows[1].stores[0].before && rows[1].stores[0].before !== rows[1].stores[0].after);
  assert.equal(recoverLastOp(ledgerFileFor(fx.dataDir, "s-gate")), 3);
  assert.equal(e.stats.ops, 3);
  assert.equal(e.stats.opsNoChange, 1);
  assert.equal(e.stats.opsAccounted, 2);
});

test("P0-2 探测门：改回原内容不提交（内容精确，非 mtime 假阳性）；untracked 走枚举归账", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-revert");
  await e.init();
  await e.onTurnStart();
  await runSimpleOp(e, "v1", "edit", { path: "base.txt" }, () => fx.write("base.txt", "v2\n"));
  const branch = sessionBranch("s-revert");
  const base = commitCount(fx.repo, branch); // 快照 + after
  // op2：写回与提交内容一致（净零变化）→ 探测门两段都放行不出 commit
  await runSimpleOp(e, "v2", "bash", { command: "echo v2 > base.txt" }, () => fx.write("base.txt", "v2\n"));
  assert.equal(commitCount(fx.repo, branch), base, "净零变化零提交");
  // op3：仅新增 untracked（mutating 命令本身零内容变化）→ 枚举发现 → 归账本 op
  await runSimpleOp(e, "v3", "bash", { command: "touch base.txt" }, () => fx.write("new.txt", "n\n"));
  assert.equal(commitCount(fx.repo, branch), base + 1, "untracked 触发 after 提交");
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-revert"));
  assert.deepEqual(rows.map((r) => r.op), [1, 3]);
  assert.deepEqual(rows[1].stores[0].paths, ["new.txt"]);
  assert.equal(rows[1].stores[0].files.A, 1);
});

test("P0-2 探测门：删除文件检出；有手改 op 的 before 懒提交保持「手改独立快照」语义", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-del");
  await e.init();
  await e.onTurnStart();
  await runSimpleOp(e, "d0", "bash", { command: "echo x > del.txt" }, () => fx.write("del.txt", "x\n"));
  const branch = sessionBranch("s-del");
  // 手改（op 外直接改文件）→ 下一 op before 懒提交捕获为独立快照
  fx.write("base.txt", "hand-edit\n");
  await runSimpleOp(e, "d1", "bash", { command: "echo x > other.txt" }, () => fx.write("other.txt", "x\n"));
  const log = branchLog(fx.repo, branch);
  const beforeCommit = branchCommits(fx.repo, branch).find((c) => /^aiti op=2 /.test(c.head) && c.head.includes("phase=before"));
  assert.ok(beforeCommit, "手改触发 before 懒提交");
  const show = git(["--git-dir", storeGitDir(fx.repo), "show", "--name-only", "--format=", beforeCommit.sha], fx.repo);
  assert.ok(show.includes("base.txt"), "手改进 before 快照（不混入 after diff）");
  // 删除检出（op 执行期内删除 → after 提交 D 计数）
  await runSimpleOp(e, "d2", "bash", { command: "rm del.txt" }, () => fx.rm("del.txt"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-del"));
  const row3 = rows.find((r) => r.op === 3);
  assert.ok(row3, "删除 op 落账");
  assert.ok(row3.stores[0].paths.includes("del.txt"));
  assert.equal(row3.stores[0].files.D, 1);
});

test("P0-2 首触：有内容仓 before 恒非 null；空仓首 op partial（前端 before-null 契约）", async (t) => {
  const fx = mkFixture(t);
  // 有内容仓：首 op before = 全量快照提交（非 null）
  const e1 = newEngine(fx, "s-full");
  await e1.init();
  await e1.onTurnStart();
  await runSimpleOp(e1, "f1", "write", { path: "x.txt" }, () => fx.write("x.txt", "x\n"));
  const rows1 = readRows(ledgerFileFor(fx.dataDir, "s-full"));
  assert.ok(rows1[0].stores[0].before, "有内容仓首触 before=快照 sha");
  assert.equal(rows1[0].stores[0].partial, false);
  // 空仓：首 op before 无可提交内容 → root commit → before=null → partial
  const empty = path.join(fx.root, "empty-repo");
  fs.mkdirSync(empty);
  git(["init", "-q", "-b", "main", empty], fx.root);
  git(["-C", empty, "config", "user.email", "t@t.local"], empty);
  git(["-C", empty, "config", "user.name", "t"], empty);
  const e2 = new TraceEngine({ cwd: empty, sessionId: "s-empty", dataDir: fx.dataDir });
  await e2.init();
  await e2.onTurnStart();
  await runSimpleOp(e2, "e1", "write", { path: "f.txt" }, () => fs.writeFileSync(path.join(empty, "f.txt"), "f\n"));
  const rows2 = readRows(ledgerFileFor(fx.dataDir, "s-empty"));
  assert.equal(rows2[0].stores[0].before, null, "空仓首触 before=null（前端：最早可恢复点为 after）");
  assert.equal(rows2[0].stores[0].partial, true);
});

/* ---------------- P0-1 bash 只读短路 ---------------- */

test("P0-1 bash 只读短路：纯读 op 零 commit/零台账/op 号不消费；写 op 照常", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-rop");
  await e.init();
  await e.onTurnStart();
  await runSimpleOp(e, "r1", "bash", { command: "ls -la && cat base.txt && git log --oneline | head -3" });
  assert.equal(commitCount(fx.repo, sessionBranch("s-rop")), 0, "只读 op 零 git 写");
  assert.equal(readRows(ledgerFileFor(fx.dataDir, "s-rop")).length, 0);
  assert.equal(e.stats.opsSkippedReadonly, 1);
  assert.equal(e.stats.ops, 0);
  // 只读 op 不消费 op 号 → 写 op 编号从 1 起（台账连续，消费方无需跳号）
  await runSimpleOp(e, "w1", "bash", { command: "echo x > w.txt" }, () => fx.write("w.txt", "x\n"));
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-rop"));
  assert.deepEqual(rows.map((r) => r.op), [1]);
  // cd 探索 + 纯读：整 op 归零（副作用取舍：不再触发副仓注册）
  const other = path.join(fx.root, "other");
  fs.mkdirSync(other);
  git(["init", "-q", "-b", "main", other], fx.root);
  await runSimpleOp(e, "r2", "bash", { command: `cd ${other} && ls && git status` });
  assert.equal((e as any).stores.size, 1, "只读 op 不注册副仓");
});

test("P0-1 开关：workspace readOnlyBashFastPath=false 关回严格全记", async (t) => {
  const fx = mkFixture(t);
  const prev = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = fx.dataDir;
  t.after(() => { if (prev === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = prev; });
  fs.mkdirSync(path.join(fx.dataDir, "aiti-git-trace", "cache", "workspaces"), { recursive: true });
  const { workspaceConfigFile } = await import("../src/paths.ts");
  fs.writeFileSync(workspaceConfigFile(fx.repo, process.env), JSON.stringify({ enabled: true, autoDiscover: true, paths: [], readOnlyBashFastPath: false }));
  const e = newEngine(fx, "s-roff");
  await e.init();
  await e.onTurnStart();
  // 关闭短路：`ls` 也按会改记账（before 快照 + after 空放行 = 探测开销，但无 commit/tag/行）
  await runSimpleOp(e, "r1", "bash", { command: "ls" });
  assert.equal(e.stats.opsSkippedReadonly, 0, "短路已关");
  assert.equal(e.stats.ops, 1, "op 进入记账");
  assert.equal(readRows(ledgerFileFor(fx.dataDir, "s-roff")).length, 0, "无变化仍不落行");
  assert.equal(commitCount(fx.repo, sessionBranch("s-roff")), 1, "新会话空 index 快照（严格全记语义）");
});

/* ---------------- P0-3 仓数收敛 ---------------- */

test("P0-3b：cd 逃逸仓按 op 参与——命中 op 记账，未命中 op 零提交", async (t) => {
  const fx = mkFixture(t);
  const other = path.join(fx.root, "other");
  fs.mkdirSync(other);
  git(["init", "-q", "-b", "main", other], fx.root);
  git(["-C", other, "config", "user.email", "t@t.local"], other);
  git(["-C", other, "config", "user.name", "t"], other);
  const e = newEngine(fx, "s-hit");
  await e.init();
  await e.onTurnStart();
  // op1：cd 进 other 并写入 → 副仓按需注册 + 参与配对
  await runSimpleOp(e, "h1", "bash", { command: `cd ${other} && echo x > f.txt` }, () => fs.writeFileSync(path.join(other, "f.txt"), "x\n"));
  const otherBranch = sessionBranch("s-hit");
  const otherCommits = commitCount(other, otherBranch);
  assert.ok(otherCommits >= 1, "命中 op 副仓落快照/after");
  const rows1 = readRows(ledgerFileFor(fx.dataDir, "s-hit"));
  assert.ok(rows1[0].stores.some((s) => s.root === fs.realpathSync(other)), "命中 op 台账含副仓条目");
  // op2：仅动主仓 → 副仓零提交（不再永久挂载）
  await runSimpleOp(e, "h2", "bash", { command: "echo y > b2.txt" }, () => fx.write("b2.txt", "y\n"));
  assert.equal(commitCount(other, otherBranch), otherCommits, "未命中 op 副仓零开销");
  const rows2 = readRows(ledgerFileFor(fx.dataDir, "s-hit"));
  assert.equal(rows2[rows2.length - 1].stores.length, 1, "未命中 op 台账仅主仓条目");
});

test("P0-3c/P0-3d：watchPaths 仓常驻参与且每 turn flush；逃逸副仓未参与 turn 不 flush", async (t) => {
  const fx = mkFixture(t);
  const watch = path.join(fx.root, "watched");
  const esc = path.join(fx.root, "escaped");
  for (const dir of [watch, esc]) {
    fs.mkdirSync(dir);
    git(["init", "-q", "-b", "main", dir], fx.root);
    git(["-C", dir, "config", "user.email", "t@t.local"], dir);
    git(["-C", dir, "config", "user.name", "t"], dir);
  }
  const prev = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = fx.dataDir;
  t.after(() => { if (prev === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = prev; });
  fs.mkdirSync(path.join(fx.dataDir, "aiti-git-trace", "cache", "workspaces"), { recursive: true });
  const { workspaceConfigFile } = await import("../src/paths.ts");
  fs.writeFileSync(workspaceConfigFile(fx.repo, process.env), JSON.stringify({
    enabled: true, autoDiscover: true, trackNestedRepos: false,
    paths: [{ path: watch, origin: "user", repoRoot: watch, addedAt: 0 }],
  }));
  const e = newEngine(fx, "s-res");
  await e.init();
  assert.equal((e as any).stores.size, 2, "watchPaths 仓 init 即注册（常驻）");
  await e.onTurnStart();
  // op1：cd 进逃逸仓并写入（按需注册参与）；主仓/逃逸仓外无动作
  await runSimpleOp(e, "c1", "bash", { command: `cd ${esc} && echo x > f.txt` }, () => fs.writeFileSync(path.join(esc, "f.txt"), "x\n"));
  assert.equal((e as any).stores.size, 3, "逃逸仓按需注册");
  // watch 副仓手改（op 外）→ turn 1 flush 覆盖常驻仓
  fs.writeFileSync(path.join(watch, "w.txt"), "w\n");
  await e.onTurnEnd();
  assert.ok(commitCount(watch, sessionBranch("s-res")) >= 1, "常驻副仓 turn_end flush 提交");
  assert.ok(commitCount(esc, sessionBranch("s-res")) >= 1, "本 turn 活跃逃逸仓 flush/提交");
  // turn 2：无任何 op → 逃逸仓残留变化不 flush（收敛）；watch 残留变化仍 flush（显式关注）
  await e.onTurnStart();
  fs.writeFileSync(path.join(esc, "g.txt"), "g\n");
  fs.writeFileSync(path.join(watch, "w2.txt"), "w2\n");
  const escBefore = commitCount(esc, sessionBranch("s-res"));
  const watchBefore = commitCount(watch, sessionBranch("s-res"));
  await e.onTurnEnd();
  assert.equal(commitCount(esc, sessionBranch("s-res")), escBefore, "逃逸仓未参与 turn → 不 flush");
  assert.ok(commitCount(watch, sessionBranch("s-res")) > watchBefore, "watch 常驻 → 每 turn flush");
});

test("P0-2/P0-3b：外溢行保留（stores 空但 leaks 非空 → 不省略）", async (t) => {
  const fx = mkFixture(t);
  const e = newEngine(fx, "s-leak");
  await e.init();
  await e.onTurnStart();
  await runSimpleOp(e, "l1", "bash", { command: "echo x > /tmp/aiti-gate-leak-out.txt" }, () => {
    fs.writeFileSync("/tmp/aiti-gate-leak-out.txt", "x\n");
  });
  try { fs.rmSync("/tmp/aiti-gate-leak-out.txt", { force: true }); } catch { /* 清理 */ }
  const rows = readRows(ledgerFileFor(fx.dataDir, "s-leak"));
  assert.equal(rows.length, 1, "leaks 行必须落账（外溢唯一记录）");
  assert.equal(rows[0].stores.length, 0);
  assert.equal(rows[0].leaks.length, 1);
});
