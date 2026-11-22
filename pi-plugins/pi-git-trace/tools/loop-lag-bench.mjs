/**
 * 事件循环阻塞回归基准（2026-09-12 异步化改造的守护测试）。
 *
 * 背景：本包曾用 execFileSync 跑 git——在 pi-web 进程内被高频工具事件驱动
 * （before/after × 多仓 × 多并发会话）时，把整个进程的事件循环掐死（实测
 * 5 个 op 的窗口期内 setInterval 探针 0 次执行；HTTP 请求排队 2~10s）。
 *
 * 本基准：模拟 5 次工具调用（各含 before/after 双提交），用 10ms 心跳探针测
 * 事件循环延迟。异步实现 maxLag 应为个位数 ms；任何人在 git 路径重新引入
 * 同步调用会让 maxLag 跳到几十~几百 ms → 退出码 1 拦截。
 *
 * 用法：node tools/loop-lag-bench.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const { TraceEngine } = await import(path.join(here, "../src/engine.ts"));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gt-loop-bench-"));
const repo = path.join(root, "repo");
fs.mkdirSync(repo, { recursive: true });
const git = (a, cwd = root) => execFileSync("git", a, { cwd, encoding: "utf8" });
git(["init", "-q", "-b", "main", repo]);
git(["-C", repo, "config", "user.email", "bench@local"]);
git(["-C", repo, "config", "user.name", "bench"]);
fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
git(["-C", repo, "add", "-A"]);
git(["-C", repo, "commit", "-q", "-m", "init"]);

const engine = new TraceEngine({
  cwd: repo,
  sessionId: "loop-bench",
  dataDir: path.join(root, "data"),
});

const lags = [];
let last = Date.now();
const probe = setInterval(() => {
  const now = Date.now();
  lags.push(now - last - 10);
  last = now;
}, 10);

const t0 = Date.now();
await engine.init();
for (let i = 0; i < 5; i++) {
  const id = "call-" + i;
  await engine.onToolCall(id, "bash", { command: "echo hi" });
  fs.writeFileSync(path.join(repo, `f${i}.txt`), `content ${i}\n`);
  await engine.onToolExecutionEnd(id, false);
}
await engine.onTurnEnd();
const wallMs = Date.now() - t0;
clearInterval(probe);

const sorted = [...lags].sort((a, b) => a - b);
const maxLag = sorted[sorted.length - 1] ?? 0;
const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
const LIMIT_MS = 80; // 单机噪声余量；同步实现会轻松超过（数百 ms）

console.log(JSON.stringify({
  maxLagMs: maxLag,
  p95LagMs: p95,
  totalSamples: lags.length,
  wallMs,
  limitMs: LIMIT_MS,
}, null, 1));

fs.rmSync(root, { recursive: true, force: true });
if (maxLag > LIMIT_MS || lags.length === 0) {
  console.error(`❌ 事件循环被阻塞（maxLag=${maxLag}ms / samples=${lags.length}）——git 路径疑似引入同步调用`);
  process.exit(1);
}
console.log("✅ 事件循环流畅（git 调用全部异步）");
