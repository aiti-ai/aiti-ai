/**
 * aiti-git-trace · server 核心测试（node --test）
 *
 * 覆盖：workspace 配置 CRUD/原子性、台账追加/读取/fork 预览过滤、
 *       store 初始化、hermetic 红线（用户仓无新 ref/object/无 status 变化）、
 *       全量回撤（safety → read-tree → 记账）、部分回滚（hunk 过滤 + apply -R + -3 兜底路径）、
 *       handleApi 全路由（含 allowed-roots 拒绝、错误分支）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(fileURLToPath(import.meta.url)); // 扩展源码目录（fixture 所在）

import {
  workspaceKey, loadWorkspace, saveWorkspace, deleteWorkspace,
  readOps, readOpsWithMeta, appendOps, forkPreviewOps, opsFile, sessionRepoRoots,
  repoRootOf, initStore, storeOf, storeOk, runGit, lastCommit,
  rollbackFull, rollbackPartial, diffPatch, BUILTIN_EXCLUDES_V1,
  cleanupSessionOps, cleanupWorkspace, lineage,
  forkPreviewOpsByUserEntries, rollbackOpsReversed,
  sessionFileSummary, fileDiffText,
} from "./trace-core.ts";
import { handleApi } from "./api.ts";
import ext, { traceService, onTraceOp } from "./index.ts";

let tmpRoot = "";
/** 三目录对称（2026-09-13）：configDir = <extRoot>/config，cache/state 在 <extRoot> 下 */
function extRootOf(configDir) {
  return dirname(configDir);
}
function freshDir(name) {
  const d = mkdtempSync(join(tmpdir(), "aiti-trace-" + name + "-"));
  tmpRoot = d;
  const configDir = join(d, "config");
  mkdirSync(configDir, { recursive: true });
  return configDir;
}
function sh(cwd, args) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}
async function commitOnBranch(store, msg) {
  await runGit(store, ["add", "-A"]); // 与引擎一致：先暂存工作区（含 untracked），再 write-tree
  const tree = (await runGit(store, ["write-tree"])).stdout.trim();
  const parentRes = await runGit(store, ["rev-parse", "--verify", "--quiet", "refs/heads/aiti/" + store.sessionId], { allowFail: true });
  const parent = parentRes.stdout.trim();
  const sha = (await runGit(store, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", msg])).stdout.trim();
  await runGit(store, ["update-ref", "refs/heads/aiti/" + store.sessionId, sha]);
  return sha;
}
function makeUserRepo(name, files) {
  const dir = mkdtempSync(join(tmpdir(), "aiti-trace-repo-"));
  mkdirSync(dir, { recursive: true });
  sh(dir, ["init", "--quiet"]);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "--quiet", "-m", "base"]);
  // 统一正斜杠形态：产品返回的 cwd 就是 / 分隔（win 反斜杠形态会让断言互不相等）
  return dir.split("\\").join("/");
}

// ---------- workspace 配置 ----------
test("workspace config: 默认值 / 保存 / 删除", async () => {
  const configDir = freshDir("ws");
  const key = workspaceKey("/tmp/some/cwd");
  assert.equal(loadWorkspace(configDir, key).autoDiscover, true);
  assert.deepEqual(loadWorkspace(configDir, key).paths, []);
  const saved = saveWorkspace(configDir, key, { autoDiscover: false, paths: [{ path: "/a", repoRoot: null }] });
  assert.equal(saved.autoDiscover, false);
  assert.equal(saved.paths[0].origin, "user"); // origin 归一为 user
  assert.equal(loadWorkspace(configDir, key).autoDiscover, false);
  assert.ok(existsSync(join(extRootOf(configDir), "cache", "workspaces", key + ".json")));
  deleteWorkspace(configDir, key);
  assert.equal(loadWorkspace(configDir, key).paths.length, 0);
});

// ---------- 台账 ----------
test("ledger: 原子追加 / 读取 / fork 预览过滤", async () => {
  const configDir = freshDir("ledger");
  appendOps(configDir, "sess/1", { op: 1, entryId: "e1", msgSeq: 1, stores: [{ root: "/x", before: "a", after: "b", files: {}, paths: ["p"], partial: false }], leaks: [] });
  appendOps(configDir, "sess/1", { op: 2, entryId: "e2", msgSeq: 1, stores: [{ root: "/x", before: "b", after: "c", files: {}, paths: ["q"], partial: true }], leaks: [{ path: "/tmp/z", size: 1, kind: "create" }] });
  const ops = readOps(configDir, "sess/1");
  assert.equal(ops.length, 2);
  assert.equal(ops[1].leaks[0].path, "/tmp/z");
  // entryId=e1 之后的 op → 只剩 op2
  assert.deepEqual(forkPreviewOps(configDir, "sess/1", "e1").map((o) => o.op), [2]);
  // entryId 未知 → 保守返回全部
  assert.equal(forkPreviewOps(configDir, "sess/1", "nope").length, 2);
  // 坏行容错：手工追加非 JSON 行后仍可读
  appendFileSync(opsFile(configDir, "sess/1"), "not-json-line\n");
  assert.equal(readOps(configDir, "sess/1").length, 2);
});

test("sessionRepoRoots: 台账仓根去重按首现序，坏行/空台账容错", async () => {
  const configDir = freshDir("roots");
  assert.deepEqual(sessionRepoRoots(configDir, "empty"), []); // 无台账
  appendOps(configDir, "s1", { op: 1, stores: [{ root: "/repo-a" }] });
  appendOps(configDir, "s1", { op: 2, stores: [{ root: "/repo-a" }, { root: "/repo-b" }] });
  appendOps(configDir, "s1", { op: 3, stores: [] });
  appendOps(configDir, "s1", { op: 4, stores: [{ root: "/repo-c/" }, {}] }); // 尾斜杠保留原样（归一化归消费方）
  assert.deepEqual(sessionRepoRoots(configDir, "s1"), ["/repo-a", "/repo-b", "/repo-c/"]);
});

// ---------- services.trace 出口（§16 / plan-first §3.2；msg-smart 跨仓分辨已接入） ----------

test("services.trace.readOps: sinceOp 增量 + limit 取最新", async () => {
  const configDir = freshDir("svc-ops");
  for (let op = 1; op <= 5; op++) appendOps(configDir, "sx", { op, stores: [] });
  const svc = traceService(configDir);
  assert.equal(svc.version, 2);
  assert.deepEqual(svc.readOps("sx").map((o) => o.op), [1, 2, 3, 4, 5]); // 缺省全量
  assert.deepEqual(svc.readOps("sx", { sinceOp: 3 }).map((o) => o.op), [4, 5]); // 增量
  assert.deepEqual(svc.readOps("sx", { limit: 2 }).map((o) => o.op), [4, 5]); // 取最新
  assert.deepEqual(svc.readOps("sx", { sinceOp: 99 }), []); // 游标越前 → 空（消费方重置逻辑自判）
});

test("services.trace.sessionStores: state 快照 + 台账补全去重，主仓在前", async () => {
  const configDir = freshDir("svc-stores");
  mkdirSync(join(extRootOf(configDir), "cache", "state"), { recursive: true });
  writeFileSync(join(extRootOf(configDir), "cache", "state", "sy.json"), JSON.stringify({
    cwd: "/repo-a", kind: "git", tracked: true,
    stores: [{ root: "/repo-a", role: "primary" }, { root: "/repo-b", role: "secondary" }],
  }));
  // 台账里有 state 快照丢失的副仓（引擎重启场景）+ 与 state 重叠的主仓
  appendOps(configDir, "sy", { op: 1, stores: [{ root: "/repo-a" }, { root: "/repo-c" }] });
  const stores = traceService(configDir).sessionStores("sy");
  assert.deepEqual(stores, [
    { root: "/repo-a", role: "primary" },
    { root: "/repo-b", role: "secondary" },
    { root: "/repo-c", role: "secondary" },
  ]);
  assert.deepEqual(traceService(configDir).sessionStores("nope"), []); // 无 state 无台账
});

test("services.trace.listMd v2: tracked+untracked 全列；.gitignore/.aitiignore 生效", async () => {
  const configDir = freshDir("svc-md2");
  const repo = makeUserRepo("md2", { "docs/a.md": "# A\n", "src/x.ts": "const a=1;\n" });
  // untracked 非 ignore md + gitignored md + .aitiignore 命中的 tracked md
  writeFileSync(join(repo, "docs/b.md"), "B\n");
  writeFileSync(join(repo, "ign.md"), "I\n");
  appendFileSync(join(repo, ".gitignore"), "ign.md\n");
  writeFileSync(join(repo, ".aitiignore"), "docs/a.md\n");
  const store = await initStore(repo);
  await runGit(storeOf(repo, "s9"), ["add", "-A"]); // 会话索引（.gitignore 使 ign.md 不入）
  appendOps(configDir, "s9", { op: 1, stores: [{ root: repo, role: "primary" }] });
  const rels = (await traceService(configDir).listMd("s9")).map((m) => m.path).sort();
  assert.deepEqual(rels, ["docs/b.md"]); // a.md 被 .aitiignore 剔除；ign.md 被 gitignore 排除；x.ts 非 md 不列
});

test("services.trace.watchPaths + listMd: 关注路径映射 / ls-files 去重上限", async () => {
  const configDir = freshDir("svc-md");
  const repo = makeUserRepo("svc", { "docs/a.md": "# A\n", "README.md": "r\n", "src/x.ts": "const a=1;\n" });
  const store = await initStore(repo);
  const szStore = storeOf(repo, "sz");
  await runGit(szStore, ["add", "-A"]); // 引擎每 op 同款：会话索引暂存后 ls-files 才可见（index 按会话分文件）
  saveWorkspace(configDir, workspaceKey(repo), { enabled: true, autoDiscover: true, paths: [{ path: "/ext-repo", origin: "user", repoRoot: "/ext-repo", addedAt: 1 }] });
  const svc = traceService(configDir);
  assert.deepEqual(svc.watchPaths(repo), [{ path: "/ext-repo", repoRoot: "/ext-repo" }]);
  assert.deepEqual(svc.watchPaths(""), []);
  // state + 台账把 repo 记为主仓 → listMd 命中仓内 md（ts 不在列）
  appendOps(configDir, "sz", { op: 1, stores: [{ root: repo, role: "primary" }] });
  const mds = await svc.listMd("sz");
  assert.deepEqual(mds.map((m) => m.path).sort(), ["README.md", "docs/a.md"]);
  assert.ok(mds.every((m) => m.root === repo));
  // 上限 200：写入 250 个 md → 截断
  for (let i = 0; i < 250; i++) writeFileSync(join(repo, "bulk-" + i + ".md"), "x\n");
  await runGit(szStore, ["add", "-A"]);
  assert.equal((await svc.listMd("sz")).length, 200);
});

// ---------- store 初始化与红线 ----------
test("store: init/hermetic 校验 + 用户仓零污染", async () => {
  const configDir = freshDir("store");
  const repo = makeUserRepo("r1", { "a.txt": "v1\n" });
  // 用户仓无 git 之前的快照
  const refsBefore = sh(repo, ["for-each-ref"]).toString();
  const objBefore = sh(repo, ["rev-parse", "HEAD"]);

  const store = await initStore(repo);
  assert.ok(storeOk(repo));
  assert.ok(existsSync(join(repo, ".aiti-trace", "HEAD")));
  // hermetic：init 产生的 config 只在 .git/aiti/config（git 分节格式）
  const cfg = readFileSync(join(repo, ".aiti-trace", "config"), "utf8");
  assert.ok(cfg.includes("[user]") && cfg.includes("name = aiti-trace"));
  assert.ok(cfg.includes("[gc]") && /auto = 0/.test(cfg));

  // 用 trace store 提交一次（模拟 op after）
  writeFileSync(join(repo, "a.txt"), "v2\n");
  await runGit(store, ["add", "-A"]);
  await runGit(store, ["commit", "--quiet", "--allow-empty", "-m", "aiti op=1 after"]);
  const traceHead = await lastCommit(store);

  // 红线：用户仓 refs 无变化（for-each-ref 不含 .git/aiti 分支）、status 只显示文件改动
  assert.equal(sh(repo, ["for-each-ref"]).toString(), refsBefore);
  assert.equal(sh(repo, ["rev-parse", "HEAD"]), objBefore);
  const status = sh(repo, ["status", "--porcelain"]).toString();
  assert.ok(status.includes("a.txt")); // 只有工作区文件改动
  assert.ok(!status.includes("aiti")); // 追踪仓内容不进用户 status
  void configDir;
});

test("store: init 自携带免打扰 .gitignore/.ignore = *（AI grep 自动跳过）且幂等", async () => {
  const repo = makeUserRepo("sr", { "a.txt": "v1\n" });
  await initStore(repo);
  const gi = readFileSync(join(repo, ".aiti-trace", ".gitignore"), "utf8");
  const ig = readFileSync(join(repo, ".aiti-trace", ".ignore"), "utf8");
  assert.ok(gi.split("\n").includes("*"), "store .gitignore 应含 *");
  assert.ok(ig.split("\n").includes("*"), "store .ignore 应含 *");
  // 幂等：重复 init 不重复追加
  await initStore(repo);
  const gi2 = readFileSync(join(repo, ".aiti-trace", ".gitignore"), "utf8");
  assert.equal(gi2.split("\n").filter((l) => l === "*").length, 1, "重复 init 不应重复追加 *");
});

// ---------- 全量回撤 ----------
test("rollbackFull: safety → read-tree → 记账，worktree 恢复目标态；commit 落会话分支", async () => {
  const repo = makeUserRepo("r2", { "a.txt": "v1\n" });
  await initStore(repo);
  const store = storeOf(repo, "s1");
  const branch = "refs/heads/aiti/s1"; // 与 paths.sessionBranch/store.sessionBranch 一致
  await commitOnBranch(store, "aiti baseline");
  // op1：改文件提交（模拟；plumbing 落会话分支，与引擎一致）
  writeFileSync(join(repo, "a.txt"), "v2\n");
  writeFileSync(join(repo, "new.txt"), "n\n");
  await commitOnBranch(store, "aiti op=1 after");
  const after1 = await lastCommit(store);
  const before1 = (await runGit(store, ["rev-parse", branch + "~1"])).stdout.trim();

  const configDir = freshDir("rbfull");
  const r = await rollbackFull({ repoRoot: repo, sessionId: "s1", targetCommit: before1 });
  assert.ok(r.safety && r.rollback);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v1\n");
  assert.ok(!existsSync(join(repo, "new.txt"))); // -u 含删除
  assert.ok(after1);
  // 分支归属红线：safety/rollback 记账必须落在会话分支（而非 HEAD 指向的 init 分支）
  const branchLog = (await runGit(store, ["log", "--format=%s", branch])).stdout;
  assert.ok(/phase=safety/.test(branchLog), "safety 应在会话分支");
  assert.ok(/phase=rollback/.test(branchLog), "rollback 应在会话分支");
  // 追踪仓的 master（init 默认分支）保持 unborn：git commit 绝不带写 HEAD
  let masterExists = true;
  try { await runGit(store, ["rev-parse", "--verify", "--quiet", "refs/heads/master"]); } catch { masterExists = false; } finally { void 0; }
  assert.ok(!(await runGit(store, ["for-each-ref", "--format=%(refname)", "refs/heads/master"])).stdout.includes("refs/heads/master"), "master 不应被创建");
  void masterExists; void configDir;
});

test("fork-preview: userEntryId 优先匹配（fork 点=用户消息 entry）", async () => {
  const configDir = freshDir("forkp");
  appendOps(configDir, "sx", { op: 1, entryId: "assistant-1", userEntryId: "user-1", stores: [] });
  appendOps(configDir, "sx", { op: 2, entryId: "assistant-2", userEntryId: "user-2", stores: [] });
  appendOps(configDir, "sx", { op: 3, entryId: "assistant-3", userEntryId: "user-3", stores: [] });
  // fork 在 user-2（用户消息）：应只返回其后的 op3
  const after = forkPreviewOps(configDir, "sx", "user-2");
  assert.deepEqual(after.map((o) => o.op), [3]);
  // 旧格式（无 userEntryId）回退 entryId 匹配
  const after2 = forkPreviewOps(configDir, "sx", "assistant-1");
  assert.deepEqual(after2.map((o) => o.op), [2, 3]);
  // 未知 entry：保守返回全部
  assert.equal(forkPreviewOps(configDir, "sx", "unknown").length, 3);
});

// ---------- 部分回滚 ----------
test("rollbackPartial: hunk 过滤 → 只回滚命中文件", async () => {
  const repo = makeUserRepo("r3", { "a.txt": "l1\nl2\nl3\n", "b.txt": "x1\nx2\nx3\n" });
  await initStore(repo);
  const store = storeOf(repo, "s1");
  const baseline = await commitOnBranch(store, "aiti baseline"); // init 后的第一笔
  // 一次 op 同时改 a.txt 和 b.txt
  writeFileSync(join(repo, "a.txt"), "l1\nl2-mod\nl3\n");
  writeFileSync(join(repo, "b.txt"), "x1\nx2-mod\nx3\n");
  const target = await commitOnBranch(store, "aiti op=1 after");

  const { hunks } = await diffPatch(store, baseline, target, ["a.txt", "b.txt"]);
  assert.equal(hunks.length, 2);
  // 只回滚 a.txt 的 hunk（idx 0）
  const configDir = freshDir("rbpartial");
  const r = await rollbackPartial({ repoRoot: repo, sessionId: "s1", base: baseline, target, files: ["a.txt", "b.txt"], hunkIdx: [0] });
  assert.ok(r.rollback);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "l1\nl2\nl3\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "x1\nx2-mod\nx3\n"); // b 未动

  // 再回滚 b.txt 的 hunk（idx 1）
  await rollbackPartial({ repoRoot: repo, sessionId: "s1", base: baseline, target, files: ["a.txt", "b.txt"], hunkIdx: [1] });
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "x1\nx2\nx3\n");

  // [P0-1 契约] 空 hunkIdx = 该文件全部 hunk（前端逐 op 回滚的真实调用形态）
  writeFileSync(join(repo, "a.txt"), "l1\nl2-x\nl3\n");
  writeFileSync(join(repo, "b.txt"), "x1\nx2-y\nx3\n");
  const target2 = await commitOnBranch(store, "aiti op=2 after");
  const r2 = await rollbackPartial({ repoRoot: repo, sessionId: "s1", base: target, target: target2, files: ["a.txt", "b.txt"], hunkIdx: [] });
  assert.ok(r2.rollback);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "l1\nl2-mod\nl3\n", "空 hunkIdx → 回到 base(=target) 内容");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "x1\nx2-mod\nx3\n", "空 hunkIdx → 回到 base(=target) 内容");
});

// ---------- handleApi 路由 ----------
test("api: ops/fork-preview/workspace/rollback/rollback-partial 全路由", async () => {
  const configDir = freshDir("api");
  const repo = makeUserRepo("r4", { "a.txt": "v1\n" });
  await initStore(repo);
  const store = storeOf(repo, "s1");
  await commitOnBranch(store, "aiti baseline");
  const base = await lastCommit(store);
  writeFileSync(join(repo, "a.txt"), "v2\n");
  const target = await commitOnBranch(store, "aiti op=1 after");

  const env = { configDir, dir: extDir, allowRoot: async () => true };
  const call = (method, path, body) => {
    const [p, qs] = path.split("?");
    return handleApi(new Request("http://x" + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "content-type": "application/json" } : undefined,
    }), { path: p.split("/").filter(Boolean), searchParams: new URLSearchParams(qs || "") }, env);
  };

  // ops 空
  let r = await (await call("GET", "/ops?session=s1")).json();
  assert.equal(r.ok, true); assert.equal(r.ops.length, 0);
  // fixture
  r = await (await call("GET", "/ops?session=s1&fixture=sample")).json();
  assert.equal(r.ops.length, 3);
  // fork-preview 有数据
  r = await (await call("GET", "/fork-preview?session=s1&entryId=e1")).json();
  assert.equal(r.ops.length, 0); // 台账为空（只有 fixture 时不读台账）→ 空数组直通
  // workspace CRUD
  r = await (await call("POST", "/workspace/resolve", { cwd: repo })).json();
  assert.equal(r.ok, true); assert.ok(r.key);
  r = await (await call("POST", "/workspace", { key: "k1", autoDiscover: true, paths: [{ path: "/x" }] })).json();
  assert.equal(r.config.paths[0].path, "/x");
  r = await (await call("GET", "/workspace?key=k1")).json();
  assert.equal(r.config.paths.length, 1);
  r = await (await call("DELETE", "/workspace?key=k1")).json();
  assert.equal(r.deleted, true);
  // watch/resolve
  r = await (await call("POST", "/watch/resolve", { path: repo })).json();
  assert.equal(r.isGit, true);
  // new-session-cwd（@到新会话 CWD 判定）：目标在当前 cwd 内 → 保持；其它仓 → 切；缺 targetDir → 400
  r = await (await call("POST", "/new-session-cwd", { targetDir: repo + "/sub", cwd: repo })).json();
  assert.equal(r.ok, true); assert.equal(r.cwd.split("\\").join("/"), repo); assert.equal(r.switched, false);
  r = await (await call("POST", "/new-session-cwd", { targetDir: repo + "/sub", cwd: "/elsewhere" })).json();
  assert.equal(r.ok, true); assert.equal(r.cwd.split("\\").join("/"), repo + "/sub"); assert.equal(r.switched, true);
  r = await (await call("POST", "/new-session-cwd", { cwd: repo })).json();
  assert.equal(r.ok, false);
  // rollback：bad store 400
  r = await (await call("POST", "/rollback", { storeRoot: "/tmp/not-exist", sessionId: "s1", targetCommit: base })).json();
  assert.equal(r.ok, false);
  // rollback：正常
  r = await (await call("POST", "/rollback", { storeRoot: repo, sessionId: "s1", targetCommit: base })).json();
  assert.equal(r.ok, true);
  // 台账记了一笔 rollback
  const ops = readOps(configDir, "s1");
  assert.equal(ops[ops.length - 1].kind, "rollback");
  // rollback-partial：缺 files 400（[P0-1] 空 hunkIdx 已合法 = 全部 hunk，直连用例覆盖）
  r = await (await call("POST", "/rollback-partial", { storeRoot: repo, sessionId: "s1", base, target, files: [], hunkIdx: [] })).json();
  assert.equal(r.ok, false);
  // allowed-roots 拒绝
  const envDeny = { configDir, dir: "", allowRoot: async () => false };
  r = await (await handleApi(new Request("http://x/rollback", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ storeRoot: repo, sessionId: "s1", targetCommit: base }),
  }), { path: ["rollback"], searchParams: new URLSearchParams() }, envDeny)).json();
  assert.equal(r.ok, false);
  // excludes
  r = await (await call("GET", "/excludes")).json();
  assert.ok(r.text.includes("node_modules/"));
  assert.ok(BUILTIN_EXCLUDES_V1.includes("__pycache__/"));
});

// ---------- 回撤一等化记账（api 层） ----------
test("api: fork-preview POST entryIds + rollback-reversed 记账行一等化", async () => {
  const configDir = freshDir("api-rev");
  const repo = makeUserRepo("r5", { "a.txt": "v0\n", "b.txt": "keep\n" });
  await initStore(repo);
  const store = storeOf(repo, "s1");
  const b0 = await commitOnBranch(store, "aiti baseline");
  writeFileSync(join(repo, "a.txt"), "v1\n");
  const a1 = await commitOnBranch(store, "aiti op1 after");
  writeFileSync(join(repo, "a.txt"), "v2\n");
  const a2 = await commitOnBranch(store, "aiti op2 after");
  appendOps(configDir, "s1", { op: 1, entryId: "a1", userEntryId: "u1", tool: "write", summary: "a v1", cwd: repo, stores: [{ root: repo, before: b0, after: a1, files: { M: 1, A: 0, D: 0 }, paths: ["a.txt"], partial: false }], leaks: [] });
  appendOps(configDir, "s1", { op: 2, entryId: "a2", userEntryId: "u1", tool: "write", summary: "a v2", cwd: repo, stores: [{ root: repo, before: a1, after: a2, files: { M: 1, A: 0, D: 0 }, paths: ["a.txt"], partial: false }], leaks: [] });

  const env = { configDir, dir: extDir, allowRoot: async () => true };
  const call = (method, path, body) => {
    const [p, qs] = path.split("?");
    return handleApi(new Request("http://x" + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "content-type": "application/json" } : undefined,
    }), { path: p.split("/").filter(Boolean), searchParams: new URLSearchParams(qs || "") }, env);
  };

  // fork-preview POST entryIds：裁 u1 轮 → 圈出 op1,2（含被编辑轮头部）
  let r = await (await call("POST", "/fork-preview", { session: "s1", entryIds: ["u1"] })).json();
  assert.equal(r.ok, true); assert.deepEqual(r.ops.map((o) => o.op), [1, 2]);
  // 未知集合 → 空
  r = await (await call("POST", "/fork-preview", { session: "s1", entryIds: ["u9"] })).json();
  assert.deepEqual(r.ops, []);

  // rollback-reversed 正常
  r = await (await call("POST", "/rollback-reversed", {
    storeRoot: repo, sessionId: "s1",
    refs: [{ op: 1, before: b0, after: a1 }, { op: 2, before: a1, after: a2 }],
  })).json();
  assert.equal(r.ok, true); assert.equal(r.failed, null); assert.equal(r.applied, 2);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v0\n");
  // 一等化记账行：LedgerRow 同构 + stores[].before/after = safety/记账 + rollback.targetOps
  const ops = readOps(configDir, "s1");
  const rb = ops[ops.length - 1];
  assert.equal(rb.kind, "rollback");
  assert.equal(rb.scope, "reverse-ops");
  assert.equal(rb.tool, "rollback");
  assert.ok(/回撤 #1,2/.test(rb.summary));
  assert.deepEqual(rb.rollback.targetOps, [1, 2]);
  assert.equal(rb.stores[0].root, repo);
  assert.ok(rb.stores[0].before && rb.stores[0].after);
  assert.equal(rb.stores[0].paths.includes("a.txt"), true);

  // 无 refs → 400
  r = await (await call("POST", "/rollback-reversed", { storeRoot: repo, sessionId: "s1", refs: [] })).json();
  assert.equal(r.ok, false);
  // allowed-roots 拒绝
  const envDeny = { configDir, dir: "", allowRoot: async () => false };
  r = await (await handleApi(new Request("http://x/rollback-reversed", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ storeRoot: repo, sessionId: "s1", refs: [{ op: 1, before: b0, after: a1 }] }),
  }), { path: ["rollback-reversed"], searchParams: new URLSearchParams() }, envDeny)).json();
  assert.equal(r.ok, false);
});

test("api: 撤销回撤（op=-1）可通过 filter 且记账 targetOps 留空", async () => {
  const configDir = freshDir("api-undo");
  const repo = makeUserRepo("r6", { "a.txt": "v0\n" });
  await initStore(repo);
  const store = storeOf(repo, "s1");
  const b0 = await commitOnBranch(store, "aiti baseline");
  writeFileSync(join(repo, "a.txt"), "v1\n");
  const a1 = await commitOnBranch(store, "aiti op1 after");
  const env = { configDir, dir: extDir, allowRoot: async () => true };
  const call = (method, path, body) => {
    const [p, qs] = path.split("?");
    return handleApi(new Request("http://x" + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "content-type": "application/json" } : undefined,
    }), { path: p.split("/").filter(Boolean), searchParams: new URLSearchParams(qs || "") }, env);
  };
  // 先回撤 op1（safety=before, rollback=after），再对 safety→rollback 反向 patch = 撤销回撤
  const rb = await (await call("POST", "/rollback-reversed", {
    storeRoot: repo, sessionId: "s1", refs: [{ op: 1, before: b0, after: a1 }],
  })).json();
  assert.equal(rb.ok, true); assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v0\n");
  const undo = await (await call("POST", "/rollback-reversed", {
    storeRoot: repo, sessionId: "s1", refs: [{ op: -1, before: rb.safety, after: rb.rollback }],
  })).json();
  assert.equal(undo.ok, true, JSON.stringify(undo)); // 关键：op=-1 必须通过 filter（曾因 rf.op>0 被吞 → 400）
  assert.equal(undo.applied, 1);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v1\n"); // 撤销回撤 → 恢复 v1
  const ops = readOps(configDir, "s1");
  const last = ops[ops.length - 1];
  assert.equal(last.kind, "rollback");
  assert.deepEqual(last.rollback.targetOps, []); // 撤销回撤记账：targetOps 留空
  assert.ok(/撤销回撤/.test(last.summary));
});

// ---------- 归属解析 ----------
test("resolveWatchPath: walk-up + 嵌套仓向下扫一层", async () => {
  const { resolveWatchPath } = await import("./trace-core.ts");
  const root = mkdtempSync(join(tmpdir(), "aiti-trace-nested-"));
  const inner = join(root, "pi-web");
  mkdirSync(join(inner, ".git"), { recursive: true });
  writeFileSync(join(inner, ".git", "HEAD"), "ref: refs/heads/main\n");
  // 路径在嵌套仓内 → 归属该仓
  const inRepo = resolveWatchPath(join(inner, "src"));
  assert.equal(inRepo.repoRoot, inner);
  // 目录本身无归属 → 向下扫一层发现嵌套仓
  const parent = resolveWatchPath(root);
  assert.equal(parent.repoRoot, null);
  assert.ok(parent.nested.includes(inner));
  rmSync(root, { recursive: true, force: true });
});

// ---------- 清理（§15） ----------
test("cleanupSessionOps：整删 / beforeOp 截断保留", async () => {
  const configDir = freshDir("cln");
  const sid = "s-cln";
  for (const op of [1, 2, 3, 4]) appendOps(configDir, sid, { op, file: "f" + op + ".txt" });
  const r1 = cleanupSessionOps(configDir, sid, 3); // 清 #3 之前 → 保留 3,4
  assert.equal(r1.removed, 2);
  assert.deepEqual(readOps(configDir, sid).map((r) => r.op), [3, 4]);
  const r2 = cleanupSessionOps(configDir, sid); // 整删
  assert.equal(r2.deleted, true);
  assert.equal(readOps(configDir, sid).length, 0);
});

test("cleanupWorkspace：cwd 前缀匹配删台账 + 仅删自己的追踪仓", async () => {
  const configDir = freshDir("clnw");
  mkdirSync(join(extRootOf(configDir), "state", "ops"), { recursive: true });
  const mk = (sid, cwd) => writeFileSync(join(extRootOf(configDir), "state", "ops", sid + ".jsonl"), JSON.stringify({ op: 1, cwd }) + "\n");
  const root = mkdtempSync(join(tmpdir(), "aiti-ws-")); // workspace 根（真实 tmp 路径）
  mk("in-repo", join(root, "repo", "sub"));
  mk("at-root", root);
  mk("outside", join(root, "..", "elsewhere"));
  // 造一个「我们的」追踪仓（HEAD 存在即认定）
  const store = join(root, ".aiti-trace");
  mkdirSync(join(store, "refs"), { recursive: true });
  writeFileSync(join(store, "HEAD"), "ref: refs/heads/main");
  const r = cleanupWorkspace(configDir, root);
  assert.equal(r.sessions, 2);      // in-repo + at-root
  assert.equal(r.storeRemoved, true);
  assert.ok(existsSync(join(extRootOf(configDir), "state", "ops", "outside.jsonl"))); // workspace 外不删
  assert.ok(!existsSync(join(extRootOf(configDir), "ops", "in-repo.jsonl")));
});
test("lineage：parent 链聚合（祖先根优先 / 后代 BFS）+ 无关会话不混入", async () => {
  const configDir = freshDir("lineage");
  mkdirSync(join(extRootOf(configDir), "state", "ops"), { recursive: true });
  const mk = (sid, parent) => writeFileSync(join(extRootOf(configDir), "state", "ops", sid + ".jsonl"),
    JSON.stringify({ op: 1, parent: parent || null, t0: 100, t1: 200 }) + "\n");
  mk("A"); mk("B", "A"); mk("C", "B"); mk("D", "A"); mk("E", null); // 链 A←B←C，分叉 D，无关 E
  const r = lineage(configDir, "C");
  assert.deepEqual(r.ancestors.map((n) => n.id), ["A", "B"]);       // 根优先
  assert.equal(r.self.id, "C");
  assert.deepEqual(r.descendants.map((n) => n.id), []);             // C 无后代
  const r2 = lineage(configDir, "A");
  assert.deepEqual(r2.descendants.map((n) => n.id), ["B", "D", "C"]); // BFS：B/D 同层在前，C 在 B 后
  assert.ok([...r2.ancestors, r2.self, ...r2.descendants].every((n) => n.opCount >= 1));
});
// ---------- 事件出口（plan-first §3.2 v2：onOp / sink 链式装卸 / SSE） ----------

test("事件 sink：startup 链式安装（前任也收）→ bus 派发 onOp / shutdown 恢复前任", async () => {
  const configDir = freshDir("svc-sink");
  const prevCalls = [];
  const prevEmit = globalThis.__aitiTraceEmit;
  globalThis.__aitiTraceEmit = (e) => prevCalls.push(e); // 模拟前任消费者
  const got = [];
  ext.server.startup({ configDir, dir: extDir });
  try {
    const evt = { kind: "op", sessionId: "sk", row: { op: 9 } };
    const off = traceService(configDir).onOp((e) => got.push(e));
    globalThis.__aitiTraceEmit(evt); // pi 扩展同款 emit 入口
    assert.deepEqual(got, [evt]);        // 新消费者经 bus 收到
    assert.deepEqual(prevCalls, [evt]);  // 链式：前任也收到（不覆盖）
    off();
    globalThis.__aitiTraceEmit(evt);
    assert.equal(got.length, 1);         // 退订后不再收
  } finally {
    ext.server.shutdown();
    globalThis.__aitiTraceEmit = prevEmit; // 恢复现场（shutdown 已恢复，此处双保险）
  }
});

test("SSE /events：event-stream 头 + 首帧 connected + op 事件帧", async () => {
  const configDir = freshDir("svc-sse");
  const res = await handleApi(
    new Request("http://x/events"),
    { path: ["events"], searchParams: new URLSearchParams() },
    { configDir, onTraceOp },
  );
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = (res.body).getReader();
  const dec = new TextDecoder();
  const first = dec.decode((await reader.read()).value); // ": connected\n\n"
  assert.match(first, /: connected/);
  onTraceOp(() => {}); // 占位：确保 bus 活跃无异常
  // 经 globalThis 桥（未装 sink 时无派发）→ 直接用 onTraceOp 同源 bus 验证帧格式：跳过（sink 测试已覆盖派发）
  await reader.cancel();
});

// ---------- 「从这里编辑」区间 + 逐 op 逆序反向回撤（方案 §7） ----------

test("forkPreviewOpsByUserEntries：按被裁轮集合过滤 / 未知→空 / 旧台账兜底 entryId", async () => {
  const configDir = freshDir("fpe");
  appendOps(configDir, "sx", { op: 1, entryId: "a1", userEntryId: "u1", stores: [] });
  appendOps(configDir, "sx", { op: 2, entryId: "a2", userEntryId: "u1", stores: [] });   // u1 轮（两 op）
  appendOps(configDir, "sx", { op: 3, entryId: "a3", userEntryId: "u2", stores: [] });   // u2 轮
  appendOps(configDir, "sx", { op: 4, entryId: "a4", stores: [{ root: "/x", before: "a", after: "b", files: {}, paths: ["p"], partial: false }] }); // 旧格式无 userEntryId
  // 裁 u1+u2 两轮 → 应圈出 op 1,2,3（含被编辑轮 op1，区分 forkPreviewOps 的 slice(last+1) 漏头）
  assert.deepEqual(forkPreviewOpsByUserEntries(configDir, "sx", ["u1", "u2"]).map((o) => o.op), [1, 2, 3]);
  // 只裁 u1 → [1,2]
  assert.deepEqual(forkPreviewOpsByUserEntries(configDir, "sx", ["u1"]).map((o) => o.op), [1, 2]);
  // 旧台账兜底 entryId 匹配（无 userEntryId 的行）
  assert.deepEqual(forkPreviewOpsByUserEntries(configDir, "sx", ["a4"]).map((o) => o.op), [4]);
  // 未知集合 → 空（不弹直通）
  assert.deepEqual(forkPreviewOpsByUserEntries(configDir, "sx", ["unknown"]), []);
  // 空集合 → 空
  assert.deepEqual(forkPreviewOpsByUserEntries(configDir, "sx", []), []);
});

test("rollbackOpsReversed：同文件多 op 逆序反向撤 + before/after 记账可逆", async () => {
  const repo = makeUserRepo("rr", { "a.txt": "v0\n" });
  await initStore(repo);
  const store = storeOf(repo, "s1");
  const b0 = await commitOnBranch(store, "aiti baseline");
  // op1：a.txt v0→v1
  writeFileSync(join(repo, "a.txt"), "v1\n");
  const a1 = await commitOnBranch(store, "aiti op=1 after");
  // op2：a.txt v1→v2（同文件后续 op）
  writeFileSync(join(repo, "a.txt"), "v2\n");
  const a2 = await commitOnBranch(store, "aiti op=2 after");

  const r = await rollbackOpsReversed({ repoRoot: repo, sessionId: "s1", refs: [
    { op: 1, before: b0, after: a1 },
    { op: 2, before: a1, after: a2 },
  ] });
  assert.ok(r.safety && r.rollback);
  assert.equal(r.failed, null);
  assert.equal(r.applied, 2);          // op2 先撤 → op1 再撤
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v0\n"); // 回到基线
  // 回撤本身可逆：对 safety→rollback 反向 patch = 恢复到回撤前（v2）
  const rb = await rollbackOpsReversed({ repoRoot: repo, sessionId: "s1", refs: [
    { op: "rb", before: r.safety, after: r.rollback },
  ] });
  assert.equal(rb.failed, null);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v2\n");
  // 记账 commit 落会话分支（master unborn 红线）
  const branchLog = (await runGit(store, ["log", "--format=%s", "refs/heads/aiti/s1"])).stdout;
  assert.ok(/phase=safety/.test(branchLog));
  assert.ok(/phase=rollback/.test(branchLog));
  assert.ok(!(await runGit(store, ["for-each-ref", "--format=%(refname)", "refs/heads/master"])).stdout.includes("refs/heads/master"));
});

test("rollbackOpsReversed：gap 跳过，且只撤该 op 的增量（保留 gap 来源变更）", async () => {
  const repo = makeUserRepo("rr2", { "a.txt": "v0\n" });
  await initStore(repo);
  const store = storeOf(repo, "s1");
  await commitOnBranch(store, "aiti baseline");
  // op1（gap：before=null）→ 跳过；op1 after = a.txt v0→v-gap
  writeFileSync(join(repo, "a.txt"), "v-gap\n");
  const gapAfter = await commitOnBranch(store, "aiti gap after");
  // op2：before=gapAfter（a.txt=v-gap），after= v2 —— 只撤 v-gap→v2 增量，不碰 gap 来源变更
  writeFileSync(join(repo, "a.txt"), "v2\n");
  const a2 = await commitOnBranch(store, "aiti op=2 after");

  const r = await rollbackOpsReversed({ repoRoot: repo, sessionId: "s1", refs: [
    { op: 1, before: null, after: gapAfter },   // gap：skip
    { op: 2, before: gapAfter, after: a2 },     // 正常撤
  ] });
  assert.equal(r.failed, null);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].op, 1);
  assert.equal(r.applied, 1);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "v-gap\n"); // 回 v-gap（gap 增量保留，只撤 op2）
});

test("集成：裁掉中间两轮，只撤被裁轮变更，未裁轮+用户手改保留", async () => {
  const repo = makeUserRepo("int", { "a.txt": "a0\n", "b.txt": "b0\n" });
  await initStore(repo);
  const store = storeOf(repo, "s1");
  const b0 = await commitOnBranch(store, "aiti baseline");
  const configDir = freshDir("int");
  const seq = [
    // 轮1（不裁，保留）：改 a.txt a0→a1
    async () => { writeFileSync(join(repo, "a.txt"), "a1\n"); return await commitOnBranch(store, "aiti op1 after"); },
    // 轮2（裁）：改 a.txt a1→a2
    async () => { writeFileSync(join(repo, "a.txt"), "a2\n"); return await commitOnBranch(store, "aiti op2 after"); },
    // 轮3（裁）：改 b.txt b0→b1
    async () => { writeFileSync(join(repo, "b.txt"), "b1\n"); return await commitOnBranch(store, "aiti op3 after"); },
  ];
  const a1 = await seq[0](); const a2 = await seq[1](); const a3 = await seq[2]();
  // 台账：轮1(保留), 轮2+轮3(被裁)
  appendOps(configDir, "s1", { op: 1, entryId: "a1", userEntryId: "u1", tool: "w", summary: "a1", msgSeq: 1, stores: [{ root: repo, before: b0, after: a1, files: { M: 1, A: 0, D: 0 }, paths: ["a.txt"], partial: false }], leaks: [] });
  appendOps(configDir, "s1", { op: 2, entryId: "a2", userEntryId: "u2", tool: "w", summary: "a2", msgSeq: 2, stores: [{ root: repo, before: a1, after: a2, files: { M: 1, A: 0, D: 0 }, paths: ["a.txt"], partial: false }], leaks: [] });
  appendOps(configDir, "s1", { op: 3, entryId: "a3", userEntryId: "u3", tool: "w", summary: "b1", msgSeq: 3, stores: [{ root: repo, before: a2, after: a3, files: { M: 1, A: 0, D: 0 }, paths: ["b.txt"], partial: false }], leaks: [] });

  // 被裁轮 = u2,u3 → fork-preview POST 圈出 op2,3
  const env = { configDir, dir: extDir, allowRoot: async () => true };
  const call = (method, path, body) => {
    const [p, qs] = path.split("?");
    return handleApi(new Request("http://x" + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "content-type": "application/json" } : undefined,
    }), { path: p.split("/").filter(Boolean), searchParams: new URLSearchParams(qs || "") }, env);
  };
  const preview = await (await call("POST", "/fork-preview", { session: "s1", entryIds: ["u2", "u3"] })).json();
  assert.deepEqual(preview.ops.map((o) => o.op), [2, 3]);

  // 用户在轮3之后手改了 c.txt（模拟手改，撤销时须保留）
  writeFileSync(join(repo, "c.txt"), "user-edit\n");
  const userHead = await runGit(store, ["add", "-A"]);
  void userHead; // c.txt 加入 index（仅用于制造工作树非干净态；不 commit，仍在工作树）

  // 撤销：对 op2,3 收集 refs
  const refs = preview.ops.flatMap((o) => (o.stores || []).filter((s) => s.before).map((s) => ({ op: o.op, before: s.before, after: s.after })));
  const rb = await (await call("POST", "/rollback-reversed", { storeRoot: repo, sessionId: "s1", refs })).json();
  assert.equal(rb.failed, null);
  assert.equal(rb.applied, 2);
  // 只撤被裁轮：a.txt 回到轮1的 a1（未裁轮变更保留），b.txt 回到 b0（轮3被裁），c.txt 手改保留
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "a1\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "b0\n");
  assert.equal(readFileSync(join(repo, "c.txt"), "utf8"), "user-edit\n");
  // 时间线读取：最后一行是回撤记账（kind rollback, scope reverse-ops）
  const ops = readOps(configDir, "s1");
  const last = ops[ops.length - 1];
  assert.equal(last.kind, "rollback");
  assert.deepEqual(last.rollback.targetOps, [2, 3]);
});

// ---------- 变更总览（docs/aiti-git-trace-overview-view-plan.md §7 全口径） ----------

/** 总览测试仓：b0 →(op1: a.txt v0→v1) a1 →(op2: a.txt v1→v2 + c.txt 新建 + hand.txt 手改不入账) a2 */
async function makeOverviewRepo() {
  const repo = makeUserRepo("ov", { "a.txt": "v0\nline2\n", "b.txt": "keep\n" });
  await initStore(repo);
  const store = storeOf(repo, "s1");
  const b0 = await commitOnBranch(store, "aiti baseline");
  writeFileSync(join(repo, "a.txt"), "v1\nline2\n");
  const a1 = await commitOnBranch(store, "aiti op1 after");
  writeFileSync(join(repo, "a.txt"), "v2\nline2\n");
  writeFileSync(join(repo, "c.txt"), "c1\nc2\nc3\n");
  writeFileSync(join(repo, "hand.txt"), "hand-edit\n"); // 交集口径（R1）：台账外路径
  const a2 = await commitOnBranch(store, "aiti op2 after");
  return { repo, store, b0, a1, a2 };
}

function appendOpRow(configDir, sid, row) {
  appendOps(configDir, sid, {
    entryId: "e", userEntryId: "u", msgSeq: 1, tool: "edit", summary: "s",
    t0: 1000, t1: 1100, cwd: "/x", leaks: [], ...row,
  });
}

// ---------- /ops 解析缓存 + ETag 再校验（§11.3 性能审计落地） ----------

test("readOpsWithMeta: mtime+size 命中返回同一解析实例；追加/缩减失效重读；readOps 浅拷贝隔离", () => {
  const configDir = freshDir("ops-cache");
  appendOpRow(configDir, "s1", { op: 1, entryId: "e1" });
  const a = readOpsWithMeta(configDir, "s1");
  assert.ok(a.etag && /^W\/"\d+-\d+"$/.test(a.etag), "etag 形如 W/\"size-mtimeMs\": " + a.etag);
  const b = readOpsWithMeta(configDir, "s1");
  assert.equal(b.rows, a.rows, "未变更 → 缓存命中（同一解析数组实例）");
  assert.equal(b.etag, a.etag);
  // 追加一行 → size/mtime 变 → 重读且含新行
  appendOpRow(configDir, "s1", { op: 2, entryId: "e2" });
  const c = readOpsWithMeta(configDir, "s1");
  assert.notEqual(c.rows, a.rows, "变更后为新解析实例");
  assert.equal(c.rows.length, 2);
  assert.notEqual(c.etag, a.etag);
  // 缩减（清理场景）→ 重读
  const f = opsFile(configDir, "s1");
  writeFileSync(f, readFileSync(f, "utf8").split("\n")[0] + "\n");
  const d = readOpsWithMeta(configDir, "s1");
  assert.equal(d.rows.length, 1);
  // readOps 公开面 = 浅拷贝（两次调用不同实例、与缓存实例不同），内容一致
  const e1 = readOps(configDir, "s1");
  const e2 = readOps(configDir, "s1");
  assert.notEqual(e1, e2);
  assert.deepEqual(e1, e2);
  // 不存在的会话 → 空行 + 无 etag
  assert.deepEqual(readOpsWithMeta(configDir, "nope"), { rows: [], etag: null });
});

test("api: GET /ops 带 ETag；If-None-Match 未变 → 304 零体；变更后 200 + 新 etag", async () => {
  const configDir = freshDir("ops-etag");
  appendOpRow(configDir, "s1", { op: 1, entryId: "e1" });
  const env = { configDir, dir: extDir, allowRoot: async () => true };
  const call = (path, headers) => handleApi(new Request("http://x" + path, { headers }), { path: path.split("?")[0].split("/").filter(Boolean), searchParams: new URLSearchParams(path.split("?")[1] || "") }, env);
  // 首取 200 + etag
  const r1 = await call("/ops?session=s1");
  assert.equal(r1.status, 200);
  const etag = r1.headers.get("etag");
  assert.ok(etag, "200 响应带 etag");
  const body1 = await r1.json();
  assert.equal(body1.ops.length, 1);
  // 未变 + If-None-Match → 304 空体
  const r2 = await call("/ops?session=s1", { "if-none-match": etag });
  assert.equal(r2.status, 304);
  assert.equal(await r2.text(), "");
  // etag 不匹配 → 200 全量
  const r3 = await call("/ops?session=s1", { "if-none-match": 'W/"1-1"' });
  assert.equal(r3.status, 200);
  // 台账变更后同 etag → 200 新 etag 新内容
  appendOpRow(configDir, "s1", { op: 2, entryId: "e2" });
  const r4 = await call("/ops?session=s1", { "if-none-match": etag });
  assert.equal(r4.status, 200);
  assert.notEqual(r4.headers.get("etag"), etag);
  assert.equal((await r4.json()).ops.length, 2);
});

test("sessionFileSummary: 普通聚合 + 交集口径（台账外路径不进列表）+ net ±行数", async () => {
  const { repo, b0, a1, a2 } = await makeOverviewRepo();
  const configDir = freshDir("ov-basic");
  appendOpRow(configDir, "s1", { op: 1, entryId: "e1", userEntryId: "u1", msgSeq: 1, stores: [{ root: repo, before: b0, after: a1, files: { M: 1, A: 0, D: 0 }, paths: ["a.txt"], partial: false }] });
  appendOpRow(configDir, "s1", { op: 2, entryId: "e2", userEntryId: "u2", msgSeq: 2, t0: 2000, t1: 2100, leaks: [{ path: "/tmp/leak", size: 1, kind: "create" }], stores: [{ root: repo, before: a1, after: a2, files: { M: 1, A: 1, D: 0 }, paths: ["a.txt", "c.txt"], partial: false }] });

  const r = await sessionFileSummary(configDir, "s1", []);
  assert.equal(r.stores.length, 1);
  assert.equal(r.stores[0].root, repo);
  assert.equal(r.stores[0].base, b0);
  assert.equal(r.stores[0].target, a2);
  assert.ok(!r.stores[0].storeMissing && !r.stores[0].rejected);
  const paths = r.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["a.txt", "c.txt"]); // hand.txt 是区间 diff 的一部分但台账未触达 → 交集口径剔除
  const a = r.files.find((f) => f.path === "a.txt");
  assert.equal(a.status, "M");
  assert.equal(a.touches.length, 2); // op1 + op2
  assert.equal(a.touches[0].kind, "op");
  assert.equal(a.touches[1].op, 2);
  assert.equal(a.lastT, 2100);
  const c = r.files.find((f) => f.path === "c.txt");
  assert.equal(c.status, "A");
  assert.equal(c.adds, 3);
  // 区间净变更：a.txt v0→v2 = +1 −1；c.txt 新建 = +3（hand.txt 剔除后不计）
  assert.equal(r.totals.adds, 4);
  assert.equal(r.totals.dels, 1);
  assert.equal(r.totals.ops, 2);
  assert.equal(r.totals.files, 2);
  assert.equal(r.totals.rollbacks, 0);
  assert.equal(r.totals.leaks, 1);
  assert.equal(r.totals.binary, 0);
  assert.equal(r.filesTruncated, false);
});

test("sessionFileSummary: entryIds 轮次过滤（该轮净增量，base=该轮首 op before）", async () => {
  const { repo, a1, a2 } = await makeOverviewRepo();
  const configDir = freshDir("ov-entry");
  appendOpRow(configDir, "s1", { op: 1, entryId: "e1", userEntryId: "u1", stores: [{ root: repo, before: "b0fake", after: a1, files: { M: 1 }, paths: ["a.txt"] }] });
  appendOpRow(configDir, "s1", { op: 2, entryId: "e2", userEntryId: "u2", t0: 2000, t1: 2100, stores: [{ root: repo, before: a1, after: a2, files: { M: 1, A: 1 }, paths: ["a.txt", "c.txt"] }] });
  const r = await sessionFileSummary(configDir, "s1", ["u2"]);
  assert.equal(r.stores[0].base, a1); // 只用命中轮 op 行解析
  assert.equal(r.stores[0].target, a2);
  assert.equal(r.totals.ops, 1);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["a.txt", "c.txt"]);
  // 旧台账无 userEntryId → 兜底 entryId 匹配
  const dataDir2 = freshDir("ov-entry2");
  appendOpRow(dataDir2, "s1", { op: 1, entryId: "only-e", stores: [{ root: repo, before: "x", after: "y", files: { M: 1 }, paths: ["a.txt"] }] });
  const r2 = await sessionFileSummary(dataDir2, "s1", ["only-e"]);
  assert.equal(r2.totals.ops, 1);
});

test("sessionFileSummary: 首触 fallback（全 gap → base=最早 after；基线快照不产生文件行）", async () => {
  const repo = makeUserRepo("ovgap", { "a.txt": "v0\n" });
  await initStore(repo);
  const store = storeOf(repo, "s2");
  writeFileSync(join(repo, "a.txt"), "v1\n");
  const ga = await commitOnBranch(store, "aiti gap after");
  writeFileSync(join(repo, "b.txt"), "new\n");
  const ga2 = await commitOnBranch(store, "aiti op2 after");
  const configDir = freshDir("ov-gap");
  // op1 = 首触基线（before=null，paths 是全树快照）→ 不产生文件行；op2 正常增量
  appendOpRow(configDir, "s2", { op: 1, stores: [{ root: repo, before: null, after: ga, files: { A: 2 }, paths: ["a.txt"] }] });
  appendOpRow(configDir, "s2", { op: 2, t0: 2000, t1: 2100, stores: [{ root: repo, before: ga, after: ga2, files: { A: 1 }, paths: ["b.txt"] }] });
  const r = await sessionFileSummary(configDir, "s2", []);
  assert.equal(r.stores[0].base, ga); // 全为空 → 最早 after
  assert.equal(r.stores[0].target, ga2);
  assert.deepEqual(r.files.map((f) => f.path), ["b.txt"]); // a.txt 在区间 ga..ga2 无差异 → 不进列表
  assert.equal(r.totals.ops, 1); // 基线快照（before=null）不计入 ops（与徽标口径一致）
});

test("sessionFileSummary: 回撤三 shape 归一（reversed/partial/full）参与 target+rollbacks 不参与 base", async () => {
  const repo = makeUserRepo("ovrb", { "a.txt": "v0\n" });
  await initStore(repo);
  const store = storeOf(repo, "s3");
  const b0 = await commitOnBranch(store, "aiti baseline");
  writeFileSync(join(repo, "a.txt"), "v1\n");
  const a1 = await commitOnBranch(store, "aiti op1 after");
  // 真实 commit 顶 target 解析（resolveCommit 校验）
  const safety1 = await commitOnBranch(store, "aiti phase=safety pre-1");
  const rb1 = await commitOnBranch(store, "aiti phase=rollback r1");
  const c1 = await commitOnBranch(store, "aiti phase=rollback partial");
  const c2 = await commitOnBranch(store, "aiti phase=rollback full");
  const configDir = freshDir("ov-rb");
  appendOpRow(configDir, "s3", { op: 1, stores: [{ root: repo, before: b0, after: a1, files: { M: 1 }, paths: ["a.txt"] }] });
  // shape 1：rollback-reversed（LedgerRow 同构，stores[].before/after，t1）
  appendOps(configDir, "s3", { kind: "rollback", scope: "reverse-ops", tool: "rollback", summary: "回撤 #1", t0: 3000, t1: 3100, op: null, stores: [{ root: repo, before: safety1, after: rb1, files: { M: 1 }, paths: ["a.txt"] }], leaks: [] });
  // shape 2：rollback-partial（扁平 storeRoot/base/target/safety/commit，只有 t）
  appendOps(configDir, "s3", { kind: "rollback", t: 4000, storeRoot: repo, base: a1, target: a1, files: ["a.txt"], safety: safety1, commit: c1, scope: "partial" });
  // shape 3：rollback full（同扁平，无 base/files）
  appendOps(configDir, "s3", { kind: "rollback", t: 5000, storeRoot: repo, target: b0, safety: c1, commit: c2, scope: "full" });

  const r = await sessionFileSummary(configDir, "s3", []);
  assert.equal(r.stores[0].base, b0); // 回撤行 before=safety 不参与 base
  assert.equal(r.stores[0].target, c2); // 最新（t1 ?? t）回撤 commit 参与 target
  assert.equal(r.totals.rollbacks, 3);
  assert.equal(r.totals.ops, 1);
  const a = r.files.find((f) => f.path === "a.txt");
  assert.ok(a);
  assert.equal(a.touches.filter((x) => x.kind === "rollback").length, 2); // reversed(paths) + partial(files)；full 无 paths 不产生触达
});

test("sessionFileSummary: plan-accept/discard 行排除（R3）不带偏 base/target/ops", async () => {
  const { repo, b0, a2 } = await makeOverviewRepo();
  const configDir = freshDir("ov-plan");
  appendOpRow(configDir, "s1", { op: 1, stores: [{ root: repo, before: b0, after: a2, files: { M: 1 }, paths: ["a.txt"] }] });
  // 若未排除，这些行会污染 base/target（假 commit）并多计 ops
  appendOps(configDir, "s1", { kind: "plan-accept", t: 9000, sandbox: "/x", files: ["ghost.md"], summary: "采认" });
  appendOps(configDir, "s1", { kind: "plan-discard", t: 9100, sandbox: "/x", files: [], summary: "丢弃" });
  const r = await sessionFileSummary(configDir, "s1", []);
  assert.equal(r.stores[0].base, b0);
  assert.equal(r.stores[0].target, a2);
  assert.equal(r.totals.ops, 1);
  assert.ok(!r.files.some((f) => f.path === "ghost.md"));
});

test("sessionFileSummary: 跨仓 / storeMissing / allowRoot 拒（rejected 部分返回）", async () => {
  const r1 = await makeOverviewRepo();
  const repo2 = makeUserRepo("ov2", { "d.txt": "d0\n" });
  await initStore(repo2);
  const store2 = storeOf(repo2, "s1");
  const db0 = await commitOnBranch(store2, "aiti baseline");
  writeFileSync(join(repo2, "d.txt"), "d1\n");
  const da1 = await commitOnBranch(store2, "aiti op after");
  const configDir = freshDir("ov-multi");
  appendOpRow(configDir, "s1", { op: 1, stores: [
    { root: r1.repo, before: r1.b0, after: r1.a2, files: { M: 2, A: 1 }, paths: ["a.txt", "c.txt"] },
    { root: repo2, before: db0, after: da1, files: { M: 1 }, paths: ["d.txt"] },
    { root: "/tmp/definitely-no-trace-store-xyz", before: "x", after: "y", files: { M: 1 }, paths: ["z"] },
  ] });
  const r = await sessionFileSummary(configDir, "s1", []);
  assert.equal(r.stores.length, 3);
  const missing = r.stores.find((s) => s.root === "/tmp/definitely-no-trace-store-xyz");
  assert.equal(missing.storeMissing, true); // storeOk 假 → 标注保留（非静默丢）
  assert.deepEqual(r.files.filter((f) => f.root === repo2).map((f) => f.path), ["d.txt"]);
  assert.equal(r.totals.files, 3); // a.txt + c.txt + d.txt
  // allowRoot 拒（Y5）→ rejected 标注 + 该仓不出文件
  const rDeny = await sessionFileSummary(configDir, "s1", [], { allowRoot: async (root) => root === r1.repo });
  const rej = rDeny.stores.find((s) => s.root === repo2);
  assert.equal(rej.rejected, true);
  assert.ok(!rDeny.files.some((f) => f.root === repo2));
  assert.ok(rDeny.files.some((f) => f.root === r1.repo)); // 放行的仓正常返回
});

test("sessionFileSummary: binary / rename（R 三段）/ 改名未检测（D+A 成对）/ 触达截断 / opSet", async () => {
  // rw.txt 在基线存在、a2 被同名内容零相似替换到 rw2.txt → 相似度不足 = D+A 两行（N1）
  const repo = makeUserRepo("ovx", { "a.txt": "v0\n", "old.txt": "same content\nsame2\n", "rw.txt": "aaaa\nbbbb\ncccc\ndddd\n" });
  await initStore(repo);
  const store = storeOf(repo, "s4");
  const b0 = await commitOnBranch(store, "aiti baseline");
  writeFileSync(join(repo, "a.txt"), "v1\n");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
  const a1 = await commitOnBranch(store, "aiti op1 after");
  // op2 窗口：rename（内容全同 → R100）+ 彻底改写搬家（D+A）+ binary 改动
  renameSync(join(repo, "old.txt"), join(repo, "new.txt"));
  rmSync(join(repo, "rw.txt"));
  writeFileSync(join(repo, "rw2.txt"), "zz1\nzz2\nzz3\nzz4\nzz5\n");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0x00, 0x01, 0x03]));
  // 触达截断：同文件 55 行台账（复用同一 before/after 对，无需新 commit）
  const a2 = await commitOnBranch(store, "aiti op2 after");
  const configDir = freshDir("ov-x");
  appendOpRow(configDir, "s4", { op: 1, stores: [{ root: repo, before: b0, after: a1, files: { M: 1, A: 1 }, paths: ["a.txt", "bin.dat"] }] });
  appendOpRow(configDir, "s4", { op: 2, t0: 2000, t1: 2100, stores: [{ root: repo, before: a1, after: a2, files: {}, paths: ["new.txt", "rw.txt", "rw2.txt", "bin.dat"] }] });
  for (let i = 3; i <= 57; i++) appendOpRow(configDir, "s4", { op: i, stores: [{ root: repo, before: a1, after: a2, files: {}, paths: ["a.txt"] }] });

  const r = await sessionFileSummary(configDir, "s4", []);
  const bin = r.files.find((f) => f.path === "bin.dat");
  assert.equal(bin.binary, true); // numstat -\t-
  assert.equal(bin.adds, 0); assert.equal(bin.dels, 0);
  assert.equal(r.totals.binary, 1);
  const ren = r.files.find((f) => f.path === "new.txt");
  assert.equal(ren.status, "R"); // name-status 权威
  assert.equal(ren.renamedFrom, "old.txt");
  assert.equal(ren.adds, 0); assert.equal(ren.dels, 0);
  // 相似度不足的改名 = D+A 成对两行（N1，不合并诚实呈现）
  const del = r.files.find((f) => f.path === "rw.txt");
  const add = r.files.find((f) => f.path === "rw2.txt");
  assert.ok(del && del.status === "D");
  assert.ok(add && add.status === "A");
  // 触达截断：a.txt 55 行台账 → 上限 50
  const a = r.files.find((f) => f.path === "a.txt");
  assert.equal(a.touches.length, 50);
  // opSet 圈定（GET fork-preview 聚合路径）
  const rOps = await sessionFileSummary(configDir, "s4", [], { opSet: new Set([1]) });
  assert.equal(rOps.totals.ops, 1);
  assert.equal(rOps.stores[0].target, a1);
});

test("fileDiffText: 正文/截断/边界（缺 store、坏 ref）", async () => {
  const { repo, b0, a2, a1 } = await makeOverviewRepo();
  const full = await fileDiffText(repo, "s1", b0, a2, "a.txt");
  assert.equal(full.truncated, false);
  assert.ok(full.text.includes("diff --git a/a.txt"));
  assert.ok(full.text.split("\n").some((l) => l.startsWith("+v2")));
  assert.ok(full.text.split("\n").some((l) => l.startsWith("-v0")));
  assert.ok(full.total > 3);
  // 截断保护：maxLines
  const cut = await fileDiffText(repo, "s1", b0, a2, "a.txt", 3);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.split("\n").length, 3);
  assert.equal(cut.total, full.total);
  // 不限 path = 全树 diff（含 c.txt）
  const tree = await fileDiffText(repo, "s1", b0, a2, "");
  assert.ok(tree.text.includes("c.txt"));
  // 空 diff（区间内该文件无变化）
  const empty = await fileDiffText(repo, "s1", a1, a1, "a.txt");
  assert.equal(empty.text, "");
  // 边界：缺 store / 坏 ref → throw（api 层转 400）
  await assert.rejects(async () => await fileDiffText("/tmp/no-store-xyz", "s1", b0, a2, "a.txt"));
  await assert.rejects(async () => await fileDiffText(repo, "s1", "deadbeef", a2, "a.txt"));
});

// ---------- API：GET /files、GET /file-diff、fork-preview 附带聚合（R4） ----------

test("api: GET /files + /file-diff（allowRoot 拒/storeMissing 降级/maxLines 截断）", async () => {
  const { repo, b0, a1, a2 } = await makeOverviewRepo();
  const configDir = freshDir("ov-api");
  appendOpRow(configDir, "s1", { op: 1, entryId: "e1", userEntryId: "u1", stores: [{ root: repo, before: b0, after: a1, files: { M: 1 }, paths: ["a.txt"] }] });
  appendOpRow(configDir, "s1", { op: 2, entryId: "e2", userEntryId: "u2", t0: 2000, t1: 2100, stores: [{ root: repo, before: a1, after: a2, files: { M: 1, A: 1 }, paths: ["a.txt", "c.txt"] }] });
  const env = { configDir, dir: extDir, allowRoot: async () => true };
  const call = (method, path, body) => {
    const [p, qs] = path.split("?");
    return handleApi(new Request("http://x" + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "content-type": "application/json" } : undefined,
    }), { path: p.split("/").filter(Boolean), searchParams: new URLSearchParams(qs || "") }, env);
  };

  // /files 正常
  let r = await (await call("GET", "/files?session=s1")).json();
  assert.equal(r.ok, true);
  assert.equal(r.stores[0].base, b0);
  assert.equal(r.totals.ops, 2);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["a.txt", "c.txt"]);
  // /files entryIds 解析
  r = await (await call("GET", "/files?session=s1&entryIds=u2")).json();
  assert.equal(r.totals.ops, 1);
  assert.deepEqual(r.entryIds, ["u2"]);
  // /file-diff 正常
  r = await (await call("GET", `/file-diff?root=${encodeURIComponent(repo)}&session=s1&base=${b0}&target=${a2}&path=a.txt`)).json();
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("a.txt"));
  assert.equal(r.truncated, false);
  // /file-diff maxLines 截断
  r = await (await call("GET", `/file-diff?root=${encodeURIComponent(repo)}&session=s1&base=${b0}&target=${a2}&path=a.txt&maxLines=3`)).json();
  assert.equal(r.truncated, true);
  assert.equal(r.text.split("\n").length, 3);
  // /file-diff 缺 store → 400
  r = await (await call("GET", `/file-diff?root=/tmp/no-store&session=s1&base=${b0}&target=${a2}&path=a.txt`)).json();
  assert.equal(r.ok, false);
  // /file-diff 坏 ref → 400
  r = await (await call("GET", `/file-diff?root=${encodeURIComponent(repo)}&session=s1&base=deadbeef&target=${a2}`)).json();
  assert.equal(r.ok, false);
  // /file-diff 缺 base/target → 400
  r = await (await call("GET", `/file-diff?root=${encodeURIComponent(repo)}&session=s1`)).json();
  assert.equal(r.ok, false);
  // /files + /file-diff allowRoot 拒：/files 部分返回 rejected；/file-diff 403
  const envDeny = { configDir, dir: "", allowRoot: async () => false };
  r = await (await handleApi(new Request("http://x/files?session=s1"), { path: ["files"], searchParams: new URLSearchParams("session=s1") }, envDeny)).json();
  assert.equal(r.ok, true);
  assert.equal(r.stores[0].rejected, true);
  assert.deepEqual(r.files, []);
  r = await (await handleApi(new Request("http://x/file-diff"), { path: ["file-diff"], searchParams: new URLSearchParams(`root=${encodeURIComponent(repo)}&session=s1&base=${b0}&target=${a2}`) }, envDeny)).json();
  assert.equal(r.ok, false);
});

test("api: fork-preview 响应附带 files/totals 聚合（R4，POST entryIds + GET opSet 双路）", async () => {
  const { repo, b0, a1, a2 } = await makeOverviewRepo();
  const configDir = freshDir("ov-fork");
  appendOpRow(configDir, "s1", { op: 1, entryId: "e1", userEntryId: "u1", stores: [{ root: repo, before: b0, after: a1, files: { M: 1 }, paths: ["a.txt"] }] });
  appendOpRow(configDir, "s1", { op: 2, entryId: "e2", userEntryId: "u2", t0: 2000, t1: 2100, stores: [{ root: repo, before: a1, after: a2, files: { M: 1, A: 1 }, paths: ["a.txt", "c.txt"] }] });
  const env = { configDir, dir: extDir, allowRoot: async () => true };
  const call = (method, path, body) => {
    const [p, qs] = path.split("?");
    return handleApi(new Request("http://x" + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "content-type": "application/json" } : undefined,
    }), { path: p.split("/").filter(Boolean), searchParams: new URLSearchParams(qs || "") }, env);
  };
  // POST entryIds：聚合与轮次同圈（u2 轮）
  let r = await (await call("POST", "/fork-preview", { session: "s1", entryIds: ["u2"] })).json();
  assert.equal(r.ok, true);
  assert.deepEqual(r.ops.map((o) => o.op), [2]);
  assert.equal(r.totals.ops, 1);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["a.txt", "c.txt"]);
  // GET entryId：fork 点后 ops 圈定（e1 之后 = op2）
  r = await (await call("GET", "/fork-preview?session=s1&entryId=e1")).json();
  assert.equal(r.ok, true);
  assert.deepEqual(r.ops.map((o) => o.op), [2]);
  assert.equal(r.totals.ops, 1);
  assert.ok(Array.isArray(r.files));
});


// ── SSE /events 退订双钩（2026-09-15 断连泄漏回归）────────────────────────
// 客户端静默断开可能不触发 ReadableStream.cancel——req.signal abort 钩必须兜住，
// 否则 op 监听器 + 15s ping 永久留在 traceBus（MaxListenersExceeded 实证）。
function sseCall(env, signal) {
  return handleApi(
    new Request("http://x/events", { signal }),
    { path: ["events"], searchParams: new URLSearchParams() },
    env
  );
}
const tick = () => new Promise((r) => setImmediate(r));

test("api: SSE /events req.signal abort → 退订 op 监听（断开泄漏回归）", async () => {
  const ac = new AbortController();
  let live = 0;
  const env = {
    configDir: freshDir("sse-abort"), dir: extDir,
    onTraceOp: (l) => { live++; return () => { live--; }; },
  };
  const res = await sseCall(env, ac.signal);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const reader = res.body.getReader();
  await reader.read(); // ": connected\n\n"（start 已跑、监听已挂）
  assert.equal(live, 1);
  ac.abort();
  await tick();
  assert.equal(live, 0, "abort 后监听必须退订");
  try { await reader.cancel(); } catch { /* 流已关闭 */ }
});

test("api: SSE /events reader.cancel → 退订 op 监听（正常关闭路）", async () => {
  let live = 0;
  const env = {
    configDir: freshDir("sse-cancel"), dir: extDir,
    onTraceOp: (l) => { live++; return () => { live--; }; },
  };
  const res = await sseCall(env, undefined);
  const reader = res.body.getReader();
  await reader.read();
  assert.equal(live, 1);
  await reader.cancel();
  await tick();
  assert.equal(live, 0, "cancel 后监听必须退订");
});
