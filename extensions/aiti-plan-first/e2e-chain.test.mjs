/**
 * aiti-plan-first · 全链路集成测试（node --test）
 *
 * 真实链路（方案 §3.1 事件投递链）：两个扩展真实模块同进程对接——
 *   git-trace startup 装 sink → plan-first startup 经 stub 注册表订阅 onOp
 *   → globalThis.__aitiTraceEmit（pi 扩展同款入口）→ traceBus → buffer
 *   → onAgentSettled 冲刷 → evalTurn → __piPageEvents.publish("pf:remind") 帧捕获断言
 *   （33ca97e 起 /events SSE 端点退役，推送走 pi-web 页面事件流，stub 总线捕获载荷）
 * 覆盖：suggest-md / bind 后 stale / 跳号 readOps 补洞（真 readOps 读 git-trace configDir）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import gitTrace from "../aiti-git-trace/index.ts";
import { appendOps } from "../aiti-git-trace/trace-core.ts";
import planFirst, { handleApi } from "./index.ts";

const extDirG = join(dirname(fileURLToPath(import.meta.url)), "..", "aiti-git-trace");

test("全链路：emit → sink → onOp → settle → publish 帧（suggest-md / stale / 跳号补洞）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pf-chain-"));
  const dirG = join(root, "gt-data");
  const dirP = join(root, "pf-data");
  const g = globalThis;
  let realNow; // stale 冷却时钟前移用（try 内赋值，finally 恢复）
  const prevEmit = g.__aitiTraceEmit;
  const prevReg = g.__piWebExt;
  const prevBus = g.__piPageEvents;

  gitTrace.server.startup({ configDir: dirG, dir: extDirG });
  // stub 注册表：plan-first 经 byId 拿到真实 git-trace def（含 services.trace v2）
  g.__piWebExt = { byId: (id) => (id === "aiti-git-trace" ? { id, ext: gitTrace } : undefined) };
  planFirst.server.startup({ configDir: dirP, dir: join(root, "aiti-plan-first") });

  try {
    // remind 帧捕获：/events SSE 端点已退役（33ca97e），推送走页面事件流
    // broadcast → __piPageEvents.publish("pf:remind", event)，stub 总线直接捕获载荷。
    const frames = [];
    g.__piPageEvents = { publish: (type, data) => { if (type === "pf:remind") frames.push(data); } };

    // stale 冷却时钟（1ee34c5 起 10min）：③ 模拟冷却期后的下一轮大改；mock 在 ② 之后装，
    // 保证 ② 用真实时钟设冷却（real+10min）、③ 已前移 11min 过冷却；finally 恢复
    const settle = () => planFirst.server.agent.onAgentSettled({ sessionId: "e2e" });
    const emit = (row) => g.__aitiTraceEmit({ kind: "op", sessionId: "e2e", row });

    // ① md 变更 → suggest-md（冷启动种子：cursor=0，首行 op=1 无需种子）
    emit({ op: 1, stores: [{ root: "/repo", files: { A: 1 }, paths: ["docs/new-plan.md"] }] });
    settle();
    const f1 = frames.shift();
    assert.equal(f1.kind, "suggest-md");
    assert.equal(f1.mdPaths[0].rel, "docs/new-plan.md");

    // ② 绑定（走真实 bind 路由）→ 8 文件大改未跟 → stale
    const bind = await (await fetchImpl(handleApi, { session: "e2e", path: "/repo/docs/new-plan.md", cwd: "/repo" }));
    assert.equal(bind.ok, true);
    for (let i = 2; i <= 9; i++) emit({ op: i, stores: [{ root: "/repo", files: { M: 1 }, paths: [`src/f${i}.ts`] }] });
    settle();
    const f2 = frames.shift();
    assert.equal(f2.kind, "stale");
    assert.equal(f2.files, 8);
    assert.equal(f2.planRel, "docs/new-plan.md");

    // ③ 跳号补洞：buffer 只到 op 12，台账里 10/11 由 readOps 回填（真跨扩展读取）
    //    当前 cursor=9；台账预写 10/11（1 文件/op），事件只发 op 12（1 文件）→ 回填后 4 文件仍低于 8
    //    再补台账 13..16（4 文件）不发事件？——不：跳号检测用 buffer 首行 op !== cursor+1 即回填 sinceOp 全量，
    //    故预写 10..15（6 文件）+ 事件 op 16..17（2 文件）→ 回填 10..17 = 8 op / 8 文件 → stale
    realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    for (let i = 10; i <= 15; i++) appendOps(dirG, "e2e", { op: i, stores: [{ root: "/repo", files: { M: 1 }, paths: [`src/g${i}.ts`] }] });
    emit({ op: 16, stores: [{ root: "/repo", files: { M: 1 }, paths: ["src/h16.ts"] }] });
    emit({ op: 17, stores: [{ root: "/repo", files: { M: 1 }, paths: ["src/h17.ts"] }] });
    settle();
    const f3 = frames.shift();
    assert.equal(f3.kind, "stale", "跳号回填后合并计满阈值");
    assert.equal(f3.files, 8);
    assert.equal(f3.ops, 8);
  } finally {
    Date.now = realNow;
    planFirst.server.shutdown();
    gitTrace.server.shutdown();
    g.__piWebExt = prevReg;
    g.__aitiTraceEmit = prevEmit;
    g.__piPageEvents = prevBus;
    rmSync(root, { recursive: true, force: true });
  }
});

test("check 路由：进入会话检查——事件从未到达的会话（终端桥接）→ suggest-md；重复 check/settle 不重弹；不广播", async () => {
  const root = mkdtempSync(join(tmpdir(), "pf-check-"));
  const dirG = join(root, "gt-data");
  const dirP = join(root, "pf-data");
  const g = globalThis;
  const prevReg = g.__piWebExt;
  const prevBus = g.__piPageEvents;

  gitTrace.server.startup({ configDir: dirG, dir: extDirG });
  g.__piWebExt = { byId: (id) => (id === "aiti-git-trace" ? { id, ext: gitTrace } : undefined) };
  planFirst.server.startup({ configDir: dirP, dir: join(root, "aiti-plan-first") });
  const frames = [];
  g.__piPageEvents = { publish: (type, data) => { if (type === "pf:remind") frames.push(data); } };

  const call = (path, body) =>
    handleApi(
      new Request("http://x/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      { path: [path], searchParams: new URLSearchParams() },
    ).then((r) => r.json());

  try {
    // 模拟终端桥接会话：台账只有磁盘记录，事件从未 emit（外部进程 globalThis 桥到不了 pi-web）
    appendOps(dirG, "bridge-sess", { op: 1, stores: [{ root: "/repo", files: { M: 2 }, paths: ["src/x.ts"] }] });
    appendOps(dirG, "bridge-sess", { op: 2, stores: [{ root: "/repo", files: { A: 1 }, paths: ["docs/bridge-design.md"] }] });

    const r1 = await call("check", { session: "bridge-sess" });
    assert.equal(r1.ok, true);
    assert.equal(r1.popped, true);
    assert.equal(r1.event.kind, "suggest-md");
    assert.equal(r1.event.mdPaths[0].rel, "docs/bridge-design.md");
    assert.equal(frames.length, 0, "check 不广播：弹在触发检查的页面");

    // 游标/suggestedMd 已推进：重复 check 不重弹；后续 settle（同批 op 重放）也不重弹
    const r2 = await call("check", { session: "bridge-sess" });
    assert.equal(r2.popped, false);
    g.__aitiTraceEmit({ kind: "op", sessionId: "bridge-sess", row: { op: 2, stores: [{ root: "/repo", files: { A: 1 }, paths: ["docs/bridge-design.md"] }] } });
    planFirst.server.agent.onAgentSettled({ sessionId: "bridge-sess" });
    assert.equal(frames.length, 0, "settle 不重弹已建议过的 md");

    // 门禁：已绑定 → 不弹绑定向导；但终端桥接场景下绑定的会话进入时评 stale（增量拉取）
    await call("bind", { session: "bridge-sess", path: "/repo/docs/bridge-design.md", cwd: "/repo" });
    appendOps(dirG, "bridge-sess", { op: 3, stores: [{ root: "/repo", files: { A: 1 }, paths: ["docs/another-plan.md"] }] });
    const r3 = await call("check", { session: "bridge-sess" });
    assert.equal(r3.popped, false, "已绑定 + 单文件增量不达 stale 阈值 → 不弹");

    // 绑定态进入评 stale（终端桥接修复）：台账领先 cursor 的增量 ≥3 文件且方案未跟 → popped=true kind=stale
    appendOps(dirG, "bridge-sess", { op: 4, stores: [{ root: "/repo", files: { M: 3 }, paths: ["src/a.ts", "src/b.ts", "src/c.ts"] }] });
    const r5 = await call("check", { session: "bridge-sess" });
    assert.equal(r5.popped, true, "绑定态 + 大改未跟 → enter 评 stale");
    assert.equal(r5.event.kind, "stale");
    assert.equal(frames.length, 0, "check 仍不广播");
    const r6 = await call("check", { session: "bridge-sess" });
    assert.equal(r6.popped, false, "stale 冷却内重复进入不重弹");

    // 跟进方案后进入 → followed 吞 null（不返回 followed 防绑定态空壳弹窗）
    appendOps(dirG, "bridge-sess", { op: 5, stores: [{ root: "/repo", files: { M: 1 }, paths: ["docs/bridge-design.md"] }] });
    const r7 = await call("check", { session: "bridge-sess" });
    assert.equal(r7.popped, false, "跟进方案的会话进入不弹（followed 吞 null）");

    await call("unbind", { session: "bridge-sess" });
    await call("mute", { session: "bridge-sess", muted: true });
    const r4 = await call("check", { session: "bridge-sess" });
    assert.equal(r4.popped, false, "静音会话进入不弹");
  } finally {
    planFirst.server.shutdown();
    gitTrace.server.shutdown();
    g.__piWebExt = prevReg;
    g.__piPageEvents = prevBus;
    rmSync(root, { recursive: true, force: true });
  }
});

/** bind 路由便捷调用（handleApi 直调） */
async function fetchImpl(handleApiFn, body) {
  const res = await handleApiFn(
    new Request("http://x/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { path: ["bind"], searchParams: new URLSearchParams() },
  );
  return res.json();
}

test("status 路由返回 autoClose 缺省时长（suggest 0=常驻 / stale 30s / lead 10s）", async () => {
  const res = await handleApi(
    new Request("http://x/status?session=test"),
    { path: ["status"], searchParams: new URLSearchParams("session=test") },
  );
  const j = await res.json();
  assert.deepEqual(j.autoClose, { suggestMs: 0, staleMs: 30000, leadMs: 10000 });
});

test("终态方案不再跟催：绑定 方案/已实施 md → 大改不弹；改回 评审中 → 照弹（front-matter 实时读）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pf-final-"));
  const dirG = join(root, "gt-data");
  const dirP = join(root, "pf-data");
  const repo = join(root, "repo");
  const planAbs = join(repo, "docs", "done-plan.md");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(planAbs, "---\ntags: [方案/已实施, demo]\n---\n\n# 已完成的方案\n");

  const g = globalThis;
  const prevReg = g.__piWebExt;
  const prevBus = g.__piPageEvents;
  gitTrace.server.startup({ configDir: dirG, dir: extDirG });
  g.__piWebExt = { byId: (id) => (id === "aiti-git-trace" ? { id, ext: gitTrace } : undefined) };
  planFirst.server.startup({ configDir: dirP, dir: join(root, "aiti-plan-first") });
  const frames = [];
  g.__piPageEvents = { publish: (type, data) => { if (type === "pf:remind") frames.push(data); } };
  const settle = () => planFirst.server.agent.onAgentSettled({ sessionId: "final-sess" });
  const emit = (row) => g.__aitiTraceEmit({ kind: "op", sessionId: "final-sess", row });

  try {
    const bind = await fetchImpl(handleApi, { session: "final-sess", path: planAbs, cwd: repo });
    assert.equal(bind.ok, true);

    // 3 op / 3 文件（缺省阈值 3/3）大改未跟：方案已实施 → 不弹
    for (let i = 1; i <= 3; i++) emit({ op: i, stores: [{ root: repo, files: { M: 1 }, paths: [`src/f${i}.ts`] }] });
    settle();
    assert.equal(frames.length, 0, "终态方案豁免 stale 跟催");

    // 状态改回评审中（mtime 变化 → 读缓存失效）→ 同量级大改照弹
    writeFileSync(planAbs, "---\ntags: [方案/评审中, demo]\n---\n\n# 进行中的方案\n");
    for (let i = 4; i <= 6; i++) emit({ op: i, stores: [{ root: repo, files: { M: 1 }, paths: [`src/g${i}.ts`] }] });
    settle();
    const f = frames.shift();
    assert.equal(f?.kind, "stale", "评审中方案照常跟催");
  } finally {
    planFirst.server.shutdown();
    gitTrace.server.shutdown();
    g.__piWebExt = prevReg;
    g.__piPageEvents = prevBus;
    rmSync(root, { recursive: true, force: true });
  }
});
