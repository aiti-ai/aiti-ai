#!/usr/bin/env node
/**
 * aiti-trace CLI（M4-2）：编外追踪仓的瘦 身 / 报告 / 会话清单。
 *
 * 用法：
 *   node aiti-trace.mjs sessions <cwd>                 列出 cwd 仓被追踪的全部会话（分支 + op 数 + 末次时间）
 *   node aiti-trace.mjs report  <cwd> [sessionId]      打印某会话（缺省全部）台账摘要
 *   node aiti-trace.mjs gc      <cwd> --days 30 [--dry-run]
 *                                                      删除末次提交早于 N 天的会话分支（追加式历史瘦身；
 *                                                      --dry-run 只列出将删除的分支）
 *
 * 说明：
 *   - 追踪仓 = <repoRoot>/.aiti-trace（§13.2 顶层）；一切调用显式 --git-dir/--work-tree（hermetic 红线）
 *   - 台账（ops/*.jsonl）不删（体积小、可审计）；分支删除后历史 commit 成为孤儿，待 git gc 自然回收
 *   - 安全分支永不删：refs/heads/aiti/safety/*（safety 存档无时间语义，宁多勿删）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const cmd = args[0];
const cwd = path.resolve(args[1] && !args[1].startsWith("--") ? args[1] : process.cwd());
const flag = (name, dft) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dft; };
const dryRun = args.includes("--dry-run");
const days = Number(flag("--days", 30));

const configDir = process.env.PI_WEB_DATA_DIR
  ? path.join(path.resolve(process.env.PI_WEB_DATA_DIR), "aiti-git-trace", "config")
  : path.join(os.homedir(), ".pi", "web", "data", "aiti-git-trace", "config");

function git(gitDir, workTree, gitArgs) {
  return execFileSync("git", [
    "--git-dir", gitDir, "--work-tree", workTree,
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    ...gitArgs,
  ], { cwd: workTree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
       env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
}

function resolveRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    const g = path.join(dir, ".git");
    try { if (fs.statSync(g).isDirectory() && fs.existsSync(path.join(g, "HEAD"))) return dir; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const repoRoot = resolveRepoRoot(cwd);
if (!repoRoot) { console.error("该目录无外层 git 仓：" + cwd); process.exit(1); }
const gitDir = path.join(repoRoot, ".aiti-trace");
if (!fs.existsSync(gitDir)) { console.log("该仓尚无追踪史（.aiti-trace 不存在）"); process.exit(0); }

function branches() {
  const out = git(gitDir, repoRoot, ["for-each-ref", "--format=%(refname)%09%(committerdate:iso-strict)%09%(committerdate:unix)", "refs/heads/aiti/"]);
  return out.trim().split("\n").filter(Boolean).map((l) => {
    const [ref, iso, unix] = l.split("\t");
    return { ref, iso, unix: Number(unix) * 1000, session: path.basename(ref) };
  });
}

function ledgerFor(session) {
  // 分支名是 16 位短 id；台账文件用完整会话 id → state/ops 目录按前缀匹配（数据分层：台账在 state/ops）
  // 数据分层：configDir = <extRoot>/config，台账在 <extRoot>/state/ops
  const dir = path.join(path.dirname(configDir), "state", "ops");
  let f = path.join(dir, session + ".jsonl");
  if (!fs.existsSync(f)) {
    try {
      const hit = fs.readdirSync(dir).find((n) => n.startsWith(session));
      if (hit) f = path.join(dir, hit);
    } catch { /* ops 目录缺失 */ }
  }
  try { return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

if (cmd === "sessions") {
  for (const b of branches()) {
    const rows = ledgerFor(b.session);
    const files = new Set();
    for (const r of rows) for (const st of r.stores || []) for (const p of st.paths || []) files.add(p);
    console.log(`${b.session.slice(0, 16)}  ops=${rows.length}  files=${files.size}  last=${b.iso}`);
  }
} else if (cmd === "report") {
  const sid = args[2] && !args[2].startsWith("--") ? args[2] : null;
  for (const b of branches().filter((x) => !sid || x.session.startsWith(sid))) {
    const rows = ledgerFor(b.session);
    console.log("== " + b.session + "  ops=" + rows.length + "  last=" + b.iso);
    for (const r of rows) {
      const paths = (r.stores || []).flatMap((s) => s.paths || []);
      console.log(`  op#${r.op} ${r.tool} ${String(r.summary).slice(0, 60)}  [${paths.slice(0, 5).join(", ")}${paths.length > 5 ? "…" : ""}]`);
    }
  }
} else if (cmd === "gc") {
  const cutoff = Date.now() - days * 86400_000;
  const victims = branches().filter((b) => b.unix < cutoff && !/\/safety\//.test(b.ref));
  if (!victims.length) { console.log("无可回收分支（" + days + " 天内均有活动）"); process.exit(0); }
  const before = git(gitDir, repoRoot, ["count-objects", "-v"]);
  const sz = (s) => Number((s.match(/size-pack: (\d+)/) || [])[1] || 0);
  for (const v of victims) {
    console.log((dryRun ? "[dry-run] 将删除 " : "删除 ") + v.ref + "  last=" + v.iso);
    if (!dryRun) git(gitDir, repoRoot, ["update-ref", "-d", v.ref]);
  }
  if (!dryRun) {
    try { git(gitDir, repoRoot, ["reflog", "expire", "--expire=now", "--all"]); git(gitDir, repoRoot, ["gc", "--prune=now", "--quiet"]); } catch {}
    const after = git(gitDir, repoRoot, ["count-objects", "-v"]);
    console.log("size-pack KB: " + sz(before) + " → " + sz(after));
  } else {
    console.log("[dry-run] 未执行删除；去掉 --dry-run 生效");
  }
} else {
  console.log("用法：aiti-trace.mjs sessions|report|gc <cwd> [--days N] [--dry-run]");
}
