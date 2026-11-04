/**
 * aiti-cmd 执行链集成方案（docs/aiti-cmd-exec-integration-plan.md）新增逻辑单测：
 *   - M0 audit：sourceDefaulted 透传、summarizeBySource 汇总（数量/最近/失败率）
 *   - M0+M2 index.ts api：/run source 收口（未知→unknown、缺省→manual+sourceDefaulted）、
 *     /shell 后端建会话、/history?groupBy=source
 *   - M1 services 适配层：run 缺省 source=service、显式 source 保留、input/resize/kill 解包纯数据
 *
 * index.ts/audit.ts 是 TS 且相对 import "./x.js"——node 原生无法解析，
 * 用 esbuild（aiti-cmd 自身构建链）bundle 到临时 mjs 再 import（同 recognize.test.mjs）。
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const srcIndex = join(here, "..", "index.ts");

/** esbuild bundle index.ts → 临时 mjs（external:node-pty 保持运行时解析）。 */
let modPromise = null;
function loadExt() {
  if (modPromise) return modPromise;
  modPromise = (async () => {
    const out = join(here, ".tmp-exec-integration.mjs");
    await build({
      entryPoints: [srcIndex],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      outfile: out,
      external: ["node-pty"],
      logLevel: "silent",
    });
    return import(pathToFileURL(out).href);
  })();
  return modPromise;
}

/** 假扩展 ctx：services.provide 捕获实现；configDir/cacheDir 用一次性临时目录。 */
function makeCtx() {
  const provided = {};
  const root = mkdtempSync(join(tmpdir(), "aiti-cmd-test-"));
  return {
    provided,
    ctx: {
      id: "aiti-cmd",
      dir: join(here, ".."),
      configDir: join(root, "config"),
      cacheDir: join(root, "cache"),
      core: {},
      services: {
        provide: (key, impl) => { provided[key] = impl; },
        get: (key) => provided[key],
      },
      features: { get: () => undefined },
    },
    root,
  };
}

/** 调扩展 api 并解析 JSON（query 解析进 ctx.searchParams，同宿主行为）。 */
async function api(ext, method, path, body) {
  const url = new URL("http://t" + path);
  const req = new Request(url.href, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  const res = await ext.default.server.api(req, { path: url.pathname.split("/").filter(Boolean), searchParams: url.searchParams });
  return { status: res.status, body: await res.json() };
}

test("M1: startup 注册 aiti-cmd.runner（方法集对齐 runner）", async () => {
  const { provided, ctx, root } = makeCtx();
  const ext = await loadExt();
  await ext.default.server.startup(ctx);
  const svc = provided["aiti-cmd.runner"];
  assert.ok(svc, "services 未注册");
  assert.deepEqual(
    Object.keys(svc).sort(),
    ["buffered", "diag", "getInfo", "input", "kill", "list", "resize", "run", "sessions"].sort(),
  );
  rmSync(root, { recursive: true, force: true });
});

test("M1: services run 缺省 source=service、显式 source 保留、unwrap 纯数据", async () => {
  const { provided, ctx, root } = makeCtx();
  const ext = await loadExt();
  await ext.default.server.startup(ctx);
  const svc = provided["aiti-cmd.runner"];

  const r1 = svc.run({ command: "echo t1", name: "t-nosrc" });
  assert.equal(r1.ok, true);
  assert.equal(typeof r1.sessionId, "string");
  assert.equal(r1.queued, false, "run 应返回纯数据（含 queued 字段）");
  assert.equal(svc.list().find((s) => s.id === r1.sessionId).source, "service", "缺省 source 应为 service");

  const r2 = svc.run({ command: "sleep 30", source: "asr-selfheal", ttlMs: 60000 });
  assert.equal(svc.list().find((s) => s.id === r2.sessionId).source, "asr-selfheal", "显式 source 应保留");

  const inp = await svc.input(r1.sessionId, "");
  assert.ok(!(inp instanceof Response), "input 应解包为纯数据");
  assert.equal(inp.ok, true);
  const rs = await svc.resize(r1.sessionId, 100, 30);
  assert.ok(!(rs instanceof Response), "resize 应解包为纯数据");
  assert.equal(rs.cols, 100);
  const kl = await svc.kill(r2.sessionId);
  assert.ok(!(kl instanceof Response), "kill 应解包为纯数据");
  assert.equal(kl.ok, true);
  assert.deepEqual(svc.sessions(), svc.list(), "sessions 应与 list 同源");

  // 清场
  await svc.kill(r1.sessionId);
  ext.default.server.shutdown();
  rmSync(root, { recursive: true, force: true });
});

/** 轮询直到 cond 为真（审计在会话异步退出时落盘，需等待）或超时。 */
async function waitFor(cond, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("M0+M2: /run source 收口、/shell 后端建会话、/history groupBy", async () => {
  const { provided, ctx, root } = makeCtx();
  const ext = await loadExt();
  await ext.default.server.startup(ctx);
  const svc = provided["aiti-cmd.runner"];

  // 缺 source → 兜底 manual + 审计 sourceDefaulted
  const a = await api(ext, "POST", "/run", { command: "echo plan-a" });
  assert.equal(a.body.ok, true);
  // 未知 source → 归 unknown
  const b = await api(ext, "POST", "/run", { command: "echo plan-b", source: "no-such-src" });
  assert.equal(b.body.ok, true);
  // /shell → 后端建会话（命令不落前端）
  const sh = await api(ext, "POST", "/shell", { name: "t-shell" });
  assert.equal(sh.body.ok, true);
  assert.ok(sh.body.sessionId, "shell 应返回 sessionId");
  assert.equal(sh.body.name, "t-shell");
  const info = await api(ext, "GET", "/sessions/" + sh.body.sessionId);
  assert.equal(info.body.cmd, "$SHELL", "shell 会话命令应由后端构造");
  // 危险命令仍需确认（协议不变）
  const danger = await api(ext, "POST", "/run", { command: "rm -rf /tmp/x-nonexistent", source: "favorite" });
  assert.equal(danger.status, 403);
  assert.equal(danger.body.needConfirm, true);
  assert.ok(danger.body.confirmToken);

  // groupBy=source 汇总（等会话异步退出 → 审计落盘）
  await waitFor(() => {
    try { return api(ext, "GET", "/history?cmd=plan-b").then((r) => r.body.records.length > 0); } catch { return false; }
  });
  const g = await api(ext, "GET", "/history?groupBy=source");
  assert.equal(g.body.groupBy, "source");
  const bySrc = Object.fromEntries(g.body.groups.map((x) => [x.source, x]));
  assert.ok(bySrc.unknown, "未知 source 应记为 unknown");
  // /shell 会话归因（list 含 source；交互 shell 未退出无审计记录，退出后才入 groupBy）
  const listed = (await api(ext, "GET", "/sessions")).body.sessions.find((s) => s.id === sh.body.sessionId);
  assert.equal(listed.source, "shell", "shell 会话 source 应为 shell");
  assert.equal(listed.cmd, "$SHELL");
  // 缺 source 的记录：source=manual + sourceDefaulted 标记（逐条查）
  const recs = await api(ext, "GET", "/history?cmd=plan-a");
  assert.equal(recs.body.records[0].source, "manual");
  assert.equal(recs.body.records[0].sourceDefaulted, true);
  const recB = await api(ext, "GET", "/history?cmd=plan-b");
  assert.equal(recB.body.records[0].source, "unknown");
  assert.notEqual(recB.body.records[0].sourceDefaulted, true);

  // 清场（先杀会话等全部退出落盘，再 shutdown，最后删目录——防 audit 迟到写 ENOENT 噪音）
  for (const s of svc.list()) if (s.status !== "exit") svc.kill(s.id);
  await waitFor(() => svc.list().every((s) => s.status === "exit"));
  ext.default.server.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("M0: audit.summarizeBySource 数量/失败率/排序", async () => {
  const { provided, ctx, root } = makeCtx();
  const ext = await loadExt();
  await ext.default.server.startup(ctx);
  const svc = provided["aiti-cmd.runner"];
  // 制造：2 条成功 manual + 1 条被信号杀的 shell（kill = exit 128+15 → 失败）
  await api(ext, "POST", "/run", { command: "echo s1" });
  await api(ext, "POST", "/run", { command: "echo s2" });
  const sh = await svc.run({ command: "sleep 30", source: "shell" });
  await svc.kill(sh.sessionId);
  // 审计在会话异步退出时落盘——固定 300ms 在全量套件负载下不够（组缺失 → .count 读 undefined），条件等待
  assert.ok(
    await waitFor(async () => {
      const gg = await api(ext, "GET", "/history?groupBy=source");
      const bs = Object.fromEntries(gg.body.groups.map((x) => [x.source, x]));
      return bs.manual?.count >= 2 && !!bs.shell;
    }),
    "审计落盘超时（manual×2 + shell 未入汇总）",
  );
  const g = await api(ext, "GET", "/history?groupBy=source");
  const bySrc = Object.fromEntries(g.body.groups.map((x) => [x.source, x]));
  assert.equal(bySrc.manual.count, 2);
  assert.equal(bySrc.manual.failRate, 0);
  assert.ok(bySrc.shell.count >= 1, "shell 记录应入汇总");
  assert.ok(bySrc.shell.failCount >= 1, "信号杀（128+n）应计失败");
  assert.ok(bySrc.shell.lastTs > 0);
  // 排序：count 降序
  const counts = g.body.groups.map((x) => x.count);
  assert.deepEqual(counts, [...counts].sort((x, y) => y - x));

  for (const s of svc.list()) if (s.status !== "exit") svc.kill(s.id);
  ext.default.server.shutdown();
  rmSync(root, { recursive: true, force: true });
});

// node-pty/ConPTY 句柄会钉住事件循环（会话常驻为产品语义）——全部用例结束后强制收口
after(() => { setTimeout(() => process.exit(process.exitCode || 0), 300); });
