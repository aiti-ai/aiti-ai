/**
 * aiti-git-ops · 引擎全链路测试（方案 §8：M1 验收面 + 深审回归面）
 *
 * 临时 fixture 仓上直调扩展 server.api（aiti-custom-agent 范式），覆盖：
 * refs/log、checkout 预检（dirty∩affected 409 / HEAD 同点豁免 / 非冲突脏文件放行）、
 * stash-then-switch、注入与路径穿越拒绝、unicode 分支/tag、**异常文件名全形态**
 * （中文/空格/双引号/换行/箭头/目录——Windows 非法字符做平台守卫）、
 * plan 断点、stash 部分暂存/提取（-z 路径）、discard（暂存丢弃/嵌套去重/隔离区）、
 * log 分页（--graph 无 --skip 语义）、stash push 错误透传、审计 jsonl。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const { default: ext } = await import("./index.ts");
const { parseStatusZ } = await import("./git-engine.ts");

const WIN = process.platform === "win32"; // Windows 文件名禁 \n 与 " 与 >——异常名套件降子集
const tmp = mkdtempSync(join(tmpdir(), "git-ops-"));
const repo = join(tmp, "repo");
mkdirSync(repo, { recursive: true });
const configDir = join(tmp, "ext", "config");
mkdirSync(configDir, { recursive: true });

const NL_FILE = WIN ? "nl-file.txt" : "new\nline.txt"; // 换行文件名（win 无此形态）
const Q_FILE = WIN ? "quote-file.txt" : 'quo"te.txt'; // 双引号文件名
const ARROW_FILE = WIN ? "arrow-b.txt" : "a -> b.txt"; // 含 " -> "（v1 行解析会被误切）
const CN_DIR = "中文书";
const CN_FILE = CN_DIR + "/文件.txt";
const SP_FILE = "sp ace.txt";
const WEIRD = [NL_FILE, Q_FILE, ARROW_FILE, CN_FILE, SP_FILE];

const git = (args, opts = {}) => execFileSync("git", args, { cwd: repo, encoding: "utf8", ...opts });
const write = (rel, content) => writeFileSync(join(repo, rel), content);

// fixture：main 一提交（普通 + 异常名全集）
// 注：git init -b 需 git≥2.28（Apple Git 2.24 无）——用 symbolic-ref 设 unborn 分支名全版本兼容
git(["init"]);
git(["symbolic-ref", "HEAD", "refs/heads/main"]);
git(["config", "user.email", "t@t.local"]);
git(["config", "user.name", "t"]);
write("a.txt", "A1\n");
write("b.txt", "B1\n");
write("y.txt", "Y1\n");
mkdirSync(join(repo, CN_DIR), { recursive: true });
write(CN_FILE, "中1\n");
write(ARROW_FILE, "arrow1\n");
write(Q_FILE, "q1\n");
write(SP_FILE, "s1\n");
write(NL_FILE, "n1\n");
git(["add", "-A"]);
git(["commit", "-m", "init"]);

await ext.server.startup({ id: "aiti-git-ops", dir: repo, configDir });

async function call(segs, body) {
  const res = await ext.server.api(new Request("http://local/" + segs.join("/"), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }), { path: segs, method: "POST", searchParams: new URLSearchParams() });
  return { status: res.status, body: res.body ? await res.json() : null };
}

test("parseStatusZ 单元：rename TO/FROM 顺序、NUL 记录、未跟踪目录", () => {
  const entries = parseStatusZ(" M a.txt\0R  new.txt\0old.txt\0?? dir/\0");
  assert.deepEqual(entries, [
    { xy: " M", path: "a.txt" },
    { xy: "R ", path: "new.txt" }, // -z 下 TO 在前，FROM token 被正确消费
    { xy: "??", path: "dir/" },
  ]);
});

test("refs：当前分支/分支列表/脏文件数", async () => {
  const r = await call(["git", "refs"], { cwd: repo });
  assert.equal(r.status, 200);
  assert.equal(r.body.current, "main");
  assert.ok(r.body.branches.includes("main"));
  assert.equal(r.body.dirtyCount, 0);
});

test("branch-create：from=HEAD 建并检出预检豁免（脏文件不阻断）", async () => {
  write("a.txt", "A2\n"); // 脏 a.txt
  const r = await call(["git", "branch-create"], { cwd: repo, name: "dev" });
  assert.equal(r.status, 200);
  assert.equal(git(["symbolic-ref", "--short", "HEAD"]).trim(), "dev");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "A2\n"); // 同 commit 检出不改文件
});

test("checkout 预检：dirty∩affected → 409（异常文件名原样回传）", async () => {
  write(CN_FILE, "中2\n");
  write(NL_FILE, "n2\n");
  git(["add", "-A"]);
  git(["commit", "-m", "dev change weird files"]); // dev 改了 CN_FILE 与 NL_FILE
  write(CN_FILE, "中3\n");
  write(NL_FILE, "n3\n");
  write("b.txt", "B1-dirty\n"); // 非冲突脏文件不进清单
  const r = await call(["git", "checkout"], { cwd: repo, ref: "main" });
  assert.equal(r.status, 409);
  assert.equal(r.body.conflict, true);
  assert.deepEqual([...r.body.files].sort(), [CN_FILE, NL_FILE].sort());
});

test("checkout：非冲突脏文件放行（dirty ≠ 不能切）", async () => {
  git(["checkout", "--", CN_FILE, NL_FILE]); // 恢复为 dev 提交内容
  const r = await call(["git", "checkout"], { cwd: repo, ref: "main" });
  assert.equal(r.status, 200);
  assert.equal(git(["symbolic-ref", "--short", "HEAD"]).trim(), "main");
});

test("checkout：stash-then-switch 冲突路径打通 + stash 往返", async () => {
  write("a.txt", "A-main-dirty\n");
  const r = await call(["git", "checkout"], { cwd: repo, ref: "dev", mode: "stash-then-switch" });
  assert.equal(r.status, 200);
  assert.equal(git(["symbolic-ref", "--short", "HEAD"]).trim(), "dev");
  const list = await call(["git", "stash", "list"], { cwd: repo });
  assert.equal(list.body.items.length, 1);
  // pop 干净应用须回到 stash 基底分支（main）——dev 上 a.txt 内容不同会冲突
  assert.equal((await call(["git", "checkout"], { cwd: repo, ref: "main" })).status, 200);
  const apply = await call(["git", "stash", "apply"], { cwd: repo, index: 0, pop: true });
  assert.equal(apply.status, 200);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "A-main-dirty\n");
});

test("ref/分支名注入与白名单拒绝", async () => {
  assert.equal((await call(["git", "checkout"], { cwd: repo, ref: "--upload-pack=evil" })).status, 400);
  assert.equal((await call(["git", "branch-create"], { cwd: repo, name: "--exec=rm -rf" })).status, 400);
  assert.equal((await call(["git", "branch-create"], { cwd: repo, name: "a b;c" })).status, 400);
  assert.equal((await call(["git", "checkout"], { cwd: repo, ref: "no-such-branch" })).status, 404);
});

test("unicode 分支与 tag（合法 ref 放行）", async () => {
  const r = await call(["git", "branch-create"], { cwd: repo, name: "分支-甲" });
  assert.equal(r.status, 200);
  assert.equal(git(["symbolic-ref", "--short", "HEAD"]).trim(), "分支-甲");
  assert.equal((await call(["git", "checkout"], { cwd: repo, ref: "main" })).status, 200);
  const refs = await call(["git", "refs"], { cwd: repo });
  assert.ok(refs.body.branches.includes("分支-甲"));
  assert.equal((await call(["git", "tag-create"], { cwd: repo, name: "标签-壹", annotate: true, message: "中文注解" })).status, 200);
  const tags = await call(["git", "tags"], { cwd: repo });
  const t = tags.body.tags.find((x) => x.name === "标签-壹");
  assert.ok(t && t.type === "tag");
});

test("路径穿越拒绝", async () => {
  const r = await call(["git", "stage"], { cwd: repo, paths: ["../../etc/passwd"] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /越界|outside/);
});

test("stage/commit 往返 + log", async () => {
  write("a.txt", "A-dev-final\n");
  assert.equal((await call(["git", "stage"], { cwd: repo, paths: ["a.txt"] })).status, 200);
  const c = await call(["git", "commit"], { cwd: repo, message: "final a" });
  assert.equal(c.status, 200);
  assert.match(c.body.sha, /^[0-9a-f]{40}$/);
  const log = await call(["git", "log"], { cwd: repo, cursor: 0 });
  assert.ok(log.body.lines.some((l) => l.includes("final a")));
  assert.equal(log.body.nextCursor, null);
});

test("plan/execute：失败断点（第 2 组非法文件停，第 1 组已提交）", async () => {
  const before = git(["rev-parse", "HEAD"]).trim();
  write("p1.txt", "P1\n");
  write("p2.txt", "P2\n");
  const r = await call(["git", "plan", "execute"], {
    cwd: repo,
    groups: [
      { files: ["p1.txt"], message: "plan g1" },
      { files: ["nonexistent-file.txt"], message: "plan g2" },
    ],
  });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.failedGroup, 1);
  assert.equal(r.body.completed, 1);
  assert.notEqual(git(["rev-parse", "HEAD"]).trim(), before);
  assert.ok(git(["log", "--name-only", "-1"]).includes("p1.txt"));

  const rb = await call(["git", "plan", "rollback"], { cwd: repo, baseHEAD: before });
  assert.equal(rb.status, 200);
  assert.equal(git(["rev-parse", "HEAD"]).trim(), before);
  assert.equal(existsSync(join(repo, "p1.txt")), true); // --mixed 保留工作区
});

test("stash 部分暂存（-z 路径：只存勾选文件，未勾选留工作区）", async () => {
  write("x.txt", "X\n");
  write("y.txt", "Y2\n");
  const r = await call(["git", "stash", "push"], { cwd: repo, message: "partial 中文", includeUntracked: true, paths: ["x.txt"] });
  assert.equal(r.status, 200);
  assert.equal(existsSync(join(repo, "x.txt")), false); // 勾选的未跟踪文件已入 stash
  assert.equal(readFileSync(join(repo, "y.txt"), "utf8"), "Y2\n"); // 未勾选留在工作区
});

test("stash list：unicode 消息与字段齐整", async () => {
  const list = await call(["git", "stash", "list"], { cwd: repo });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.match(list.body.items[0].message, /partial 中文/);
  assert.match(list.body.items[0].sha, /^[0-9a-f]{40}$/);
  assert.ok(list.body.items[0].date.length > 10);
});

test("stash 部分提取（条目保留）", async () => {
  const r = await call(["git", "stash", "apply"], { cwd: repo, index: 0, paths: ["x.txt"] });
  assert.equal(r.status, 200);
  assert.equal(readFileSync(join(repo, "x.txt"), "utf8"), "X\n");
  const list = await call(["git", "stash", "list"], { cwd: repo });
  assert.equal(list.body.items.length, 1); // 提取不 drop
});

test("stash drop 返回 sha（gc 前可找回）", async () => {
  const r = await call(["git", "stash", "drop"], { cwd: repo, index: 0 });
  assert.equal(r.status, 200);
  assert.match(r.body.sha, /^[0-9a-f]{7,40}$/);
});

test("refs.dirtyFiles + stash/files（部分暂存/提取数据面）", async () => {
  write("df1.txt", "D1\n");
  write(CN_FILE, "中-df\n");
  mkdirSync(join(repo, "dfdir"), { recursive: true });
  writeFileSync(join(repo, "dfdir", "u.txt"), "U\n");
  const refs = await call(["git", "refs"], { cwd: repo });
  assert.equal(refs.status, 200);
  const paths = refs.body.dirtyFiles.map((f) => f.path);
  assert.ok(paths.includes("df1.txt"));
  assert.ok(paths.includes(CN_FILE), "中文路径 -z 原样");
  assert.ok(paths.includes("dfdir/")); // 未跟踪目录尾斜杠形态
  // 建 stash 带 untracked → stash/files 应分别给出 tracked/untracked 清单
  assert.equal((await call(["git", "stash", "push"], { cwd: repo, message: "files-probe", includeUntracked: true, paths: ["df1.txt", "dfdir"] })).status, 200);
  const sf = await call(["git", "stash", "files"], { cwd: repo, index: 0 });
  assert.equal(sf.status, 200);
  // df1.txt 与 dfdir 均为未跟踪（-u 路径进第三父）。fixture 有前序测试残留，用包含性断言
  assert.ok(sf.body.untracked.includes("df1.txt"));
  assert.ok(sf.body.untracked.includes("dfdir/u.txt"));
  assert.ok(!sf.body.untracked.includes(CN_FILE));
  assert.equal((await call(["git", "stash", "drop"], { cwd: repo, index: 0 })).status, 200);
  git(["checkout", "--", CN_FILE]);
});

test("stash push 失败透传（pathspec 不匹配不再假 ok）", async () => {
  const r = await call(["git", "stash", "push"], { cwd: repo, paths: ["nonexistent-xyz.txt"] });
  assert.ok(r.status >= 400, "期望错误态，实际 " + r.status);
  assert.equal(r.body.ok, false);
});

test("discard：暂存中的新文件连 index 一起丢", async () => {
  write("u1.txt", "U\n");
  git(["add", "u1.txt"]); // staged new
  const r = await call(["git", "discard"], { cwd: repo, paths: ["u1.txt"] });
  assert.equal(r.status, 200);
  assert.equal(existsSync(join(repo, "u1.txt")), false);
  // fixture 有其他测试遗留的脏文件，只断言 u1 彻底消失（工作区+index）
  assert.equal(git(["status", "--porcelain"]).includes("u1.txt"), false);
});

test("discard：untracked 嵌套去重 + 目录整树隔离（可找回）", async () => {
  mkdirSync(join(repo, "nd", "子目录"), { recursive: true });
  writeFileSync(join(repo, "nd", "f.txt"), "N\n");
  writeFileSync(join(repo, "nd", "子目录", "g.txt"), "G\n");
  const r = await call(["git", "discard"], { cwd: repo, paths: ["nd", "nd/f.txt"] }); // 嵌套选择去重
  assert.equal(r.status, 200);
  assert.equal(r.body.quarantined.length, 1); // 只搬一次（nd 整树）
  assert.equal(existsSync(join(repo, "nd")), false);
  assert.equal(existsSync(join(r.body.quarantined[0], "子目录", "g.txt")), true);
});

test("discard：rename 后新路径 + 异常文件名内容复原", async () => {
  git(["mv", SP_FILE, "sp2 ace.txt"]);
  git(["commit", "-m", "rename sp"]);
  write("sp2 ace.txt", "s2-dirty\n");
  write(ARROW_FILE, "arrow2-dirty\n");
  const r = await call(["git", "discard"], { cwd: repo, paths: ["sp2 ace.txt", ARROW_FILE] });
  assert.equal(r.status, 200);
  assert.equal(readFileSync(join(repo, "sp2 ace.txt"), "utf8"), "s1\n");
  assert.equal(readFileSync(join(repo, ARROW_FILE), "utf8"), "arrow1\n");
});

test("branch-delete：-d 安全删（未合并拒绝 / 合并后可删）", async () => {
  git(["checkout", "main"]);
  assert.equal((await call(["git", "branch-create"], { cwd: repo, name: "tmp" })).status, 200);
  write("tmpfile.txt", "T\n");
  git(["add", "-A"]);
  git(["commit", "-m", "tmp ahead"]);
  const failR = await call(["git", "branch-delete"], { cwd: repo, name: "tmp" });
  assert.equal(failR.status, 500);
  assert.match(failR.body.error, /删除失败/);
  git(["checkout", "main"]);
  git(["merge", "tmp"]);
  assert.equal((await call(["git", "branch-delete"], { cwd: repo, name: "tmp" })).status, 200);
});

test("log 分页：--graph 无 --skip 语义下翻页完整（55 空提交）", async () => {
  for (let i = 1; i <= 55; i++) {
    git(["commit", "--allow-empty", "-m", "c" + String(i).padStart(2, "0")]);
  }
  const total = Number(git(["rev-list", "--count", "HEAD"]).trim());
  const p1 = await call(["git", "log"], { cwd: repo, cursor: 0 });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.lines.length, 50);
  assert.equal(p1.body.nextCursor, 50);
  assert.ok(p1.body.lines.some((l) => l.includes("c55"))); // date-order 最新在前
  const p2 = await call(["git", "log"], { cwd: repo, cursor: 50 });
  assert.equal(p2.body.lines.length, total - 50);
  assert.equal(p2.body.nextCursor, null);
  assert.ok(p2.body.lines.some((l) => l.includes("c01"))); // 最老一页包含最早提交
  const tail = await call(["git", "log"], { cwd: repo, cursor: total + 100 });
  assert.equal(tail.body.lines.length, 0); // 越界空页不炸
});

test("审计 jsonl 已写入（state 分层路径）", async () => {
  const auditPath = join(tmp, "ext", "config", "state", "aiti-git-ops", "git-ops.jsonl");
  assert.equal(existsSync(auditPath), true);
  const lines = readFileSync(auditPath, "utf8").trim().split("\n");
  assert.ok(lines.length >= 5);
  for (const l of lines) {
    const e = JSON.parse(l);
    assert.ok(e.ts && e.cmd);
  }
});

test("非 git 目录 / 非法 cwd 结构化错误", async () => {
  const notRepo = mkdtempSync(join(tmpdir(), "git-ops-norepo-"));
  const r = await call(["git", "refs"], { cwd: notRepo });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /不是 git 仓库/);
  const rel = await call(["git", "refs"], { cwd: "relative/path" });
  assert.equal(rel.status, 400);
});

test("refs.head：plan baseHEAD 数据面", async () => {
  const r = await call(["git", "refs"], { cwd: repo });
  assert.equal(r.status, 200);
  assert.match(r.body.head, /^[0-9a-f]{40}$/);
  assert.equal(r.body.head, git(["rev-parse", "HEAD"]).trim());
});

// ── commit 详情卡（docs/aiti-git-ops-commit-card-plan.md）：commit-show / commit-diff / cherry-pick ──

test("commit-show：普通 commit 元信息 + 文件清单（状态/增删行数，异常文件名原样）", async () => {
  write(CN_FILE, "中1\n中2\n中3\n");
  write("new-shown.txt", "N1\nN2\n");
  git(["add", "-A"]);
  git(["commit", "-m", "show-me: 元信息与清单"]);
  const r = await call(["git", "commit-show"], { cwd: repo, sha: "HEAD" });
  assert.equal(r.status, 200);
  assert.match(r.body.sha, /^[0-9a-f]{40}$/);
  assert.equal(r.body.subject, "show-me: 元信息与清单");
  assert.equal(r.body.author, "t");
  assert.equal(r.body.merge, false);
  assert.equal(r.body.parents.length, 1);
  const cn = r.body.files.find((f) => f.path === CN_FILE);
  assert.equal(cn.status, "M");
  assert.equal(cn.additions, 2); // 中1 → 中1/中2/中3 净 +2
  const nf = r.body.files.find((f) => f.path === "new-shown.txt");
  assert.equal(nf.status, "A");
  assert.deepEqual([nf.additions, nf.deletions], [2, 0]);
  assert.equal(r.body.additions, 4);
  // 短 sha 也可作 ref（图谱行即短 sha）
  const short = await call(["git", "commit-show"], { cwd: repo, sha: r.body.sha.slice(0, 7) });
  assert.equal(short.status, 200);
  assert.equal(short.body.sha, r.body.sha);
});

test("commit-show：rename（-z token 序钉死：old 在前 new 在后）", async () => {
  write("r1.txt", "R\n");
  git(["add", "-A"]);
  git(["commit", "-m", "rename-src"]);
  git(["mv", "r1.txt", "r2 后.txt"]);
  git(["commit", "-m", "rename-dst"]);
  const r = await call(["git", "commit-show"], { cwd: repo, sha: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal(r.body.files.length, 1);
  assert.equal(r.body.files[0].path, "r2 后.txt");
  assert.equal(r.body.files[0].oldPath, "r1.txt");
  assert.equal(r.body.files[0].status, "R");
  assert.deepEqual([r.body.files[0].additions, r.body.files[0].deletions], [0, 0]);
});

test("commit-show：root commit 对空树（全文件 status=A）+ merge 取第一父 diff", async () => {
  const root = git(["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n")[0];
  const rr = await call(["git", "commit-show"], { cwd: repo, sha: root });
  assert.equal(rr.status, 200);
  assert.ok(rr.body.files.some((f) => f.path === "a.txt" && f.status === "A"));
  // merge：side 分支加 side-cp.txt，主干加 main-cp.txt，--no-ff 合并 → 详情只含 main-cp.txt
  git(["checkout", "-b", "show-side"]);
  write("side-cp.txt", "S\n");
  git(["add", "-A"]);
  git(["commit", "-m", "side commit"]);
  git(["checkout", "main"]);
  write("main-cp.txt", "M\n");
  git(["add", "-A"]);
  git(["commit", "-m", "main commit"]);
  git(["merge", "--no-ff", "show-side", "-m", "merge show-side"]);
  const mr = await call(["git", "commit-show"], { cwd: repo, sha: "HEAD" });
  assert.equal(mr.status, 200);
  assert.equal(mr.body.merge, true);
  assert.equal(mr.body.parents.length, 2);
  // 第一父 diff = 相对 main 前一点（已含 main-cp.txt）的净变化 = 被并入的 side-cp.txt（GitHub 同语义）
  assert.deepEqual(mr.body.files.map((f) => f.path), ["side-cp.txt"]);
});

test("commit-diff：单文件 patch + rename 双路径", async () => {
  const sha = git(["rev-parse", "HEAD~1"]).trim(); // main commit
  const r = await call(["git", "commit-diff"], { cwd: repo, sha, paths: ["main-cp.txt"] });
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, false);
  assert.ok(r.body.patch.includes("+M\n"));
  assert.ok(r.body.patch.startsWith("diff --git"));
  // rename commit：传 [新, 旧] 双路径（首父链 merge→main→rename-dst→rename-src，HEAD~2=rename-dst）
  const rsha = git(["rev-parse", "HEAD~2"]).trim(); // rename-dst
  const rr = await call(["git", "commit-diff"], { cwd: repo, sha: rsha, paths: ["r2 后.txt", "r1.txt"] });
  assert.equal(rr.status, 200);
  assert.ok(rr.body.patch.includes("rename from"));
  assert.ok(rr.body.patch.includes("r1.txt"));
  // 路径越界拒绝
  const bad = await call(["git", "commit-diff"], { cwd: repo, sha, paths: ["../../etc/passwd"] });
  assert.equal(bad.status, 400);
});

test("commit-diff：大 diff 行边界截断 + truncated 标志", async () => {
  const big = Array.from({ length: 40_000 }, (_, i) => `line-${String(i).padStart(5, "0")}\n`).join("");
  write("big-diff.txt", big);
  git(["add", "-A"]);
  git(["commit", "-m", "big diff"]);
  const r = await call(["git", "commit-diff"], { cwd: repo, sha: "HEAD", paths: ["big-diff.txt"] });
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, true);
  assert.ok(r.body.patch.includes("（已截断）"));
  assert.ok(r.body.patch.length < 500 * 1024);
});

test("cherry-pick：跨分支摘取成功", async () => {
  git(["checkout", "-b", "cp-src"]);
  write("a.txt", "CP-1\n");
  git(["add", "-A"]);
  git(["commit", "-m", "cp: pick me"]);
  const pickSha = git(["rev-parse", "HEAD"]).trim();
  git(["checkout", "main"]);
  const r = await call(["git", "cherry-pick"], { cwd: repo, sha: pickSha });
  assert.equal(r.status, 200);
  assert.equal(r.body.sha, pickSha);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "CP-1\n");
});

test("cherry-pick：冲突 409 + 中间态文件清单 + abort 复原", async () => {
  // 两分支从同一点各自改 a.txt 首行 → 摘取必冲突
  git(["checkout", "-b", "cp-a", "main"]);
  write("a.txt", "A-side\nshared\n");
  git(["add", "-A"]);
  git(["commit", "-m", "cp-a side"]);
  const aSha = git(["rev-parse", "HEAD"]).trim();
  git(["checkout", "-b", "cp-b", "main"]);
  write("a.txt", "B-side\nshared\n");
  git(["add", "-A"]);
  git(["commit", "-m", "cp-b side"]);
  git(["checkout", "cp-a"]);
  const r = await call(["git", "cherry-pick"], { cwd: repo, sha: aSha === git(["rev-parse", "HEAD"]).trim() ? "HEAD~1" : "cp-b" });
  assert.equal(r.status, 409);
  assert.equal(r.body.conflict, true);
  assert.ok(r.body.files.includes("a.txt"));
  assert.equal(existsSync(join(repo, ".git", "CHERRY_PICK_HEAD")), true); // 中间态在位
  const ab = await call(["git", "cherry-pick"], { cwd: repo, sha: "", abort: true });
  assert.equal(ab.status, 200);
  assert.equal(existsSync(join(repo, ".git", "CHERRY_PICK_HEAD")), false);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "A-side\nshared\n"); // 内容复原
  const st = await call(["git", "refs"], { cwd: repo });
  assert.equal(st.body.dirtyCount, 0); // 工作区干净（走出中间态）
});
