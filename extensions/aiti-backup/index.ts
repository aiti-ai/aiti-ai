/**
 * aiti-backup · pi-web 数据备份扩展（server 端，M1+M2）
 *
 * 方案：docs/pi-web-ext-data-backup-extension-plan.md（§7 全部拍板完成）
 * 职责：
 *   - 备份源：`<dataRoot>/<extId>/state/` 自动发现 + `~/.pi/agent/sessions`（默认开）+ 自定义
 *   - 目的地安全校验（与源互斥/不受保护根）后 spawn bin/backup-runner.cjs 独立子进程
 *   - runner stdout JSONL 进度 → event-bus topic `aiti-backup:progress|done|error`（禁轮询）
 *   - 运行历史 runs.jsonl（state 层）+ 源级最近状态 source-state.json
 *   - 自身数据分层（吃自己狗粮）：config=backup.config.json / state=runs+source-state / cache=暂不使用
 *
 * M1/M2 无 UI 面板（M5）：全能力经 API（GET status /sources /snapshots /runs，
 * POST config /backup /cancel /source-stats /cleanup-tmp）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename as pathBasename, dirname as pathDirname, join as pathJoin, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 热重载后拿新逻辑（aiti-models-import 同款：清原生 require 缓存） */
function createModuleLoader() {
  const nativeRequire = createRequire(import.meta.url);
  const bust = () => {
    const cache = nativeRequire.cache || {};
    for (const k of Object.keys(cache)) {
      if (k.includes("aiti-backup") && k.endsWith(".cjs")) delete cache[k];
    }
  };
  return () => {
    bust();
    return { core: nativeRequire("./lib/backup-core.cjs") };
  };
}
const loadModules = createModuleLoader();
const { core } = loadModules();

let configDir = "";
let stateDir = "";
let dataRoot = "";
const home = homedir();

type Cfg = any;
let cfg: Cfg = null;

// ---------- 运行态（单飞行队列；重活在 runner 子进程） ----------
let current: { sourceId: string; child: any; startedAt: number; summary: any; errorMessage: string | null } | null = null;
const queue: string[] = [];
const lastProgress = new Map<string, any>();

function publish(topic: string, payload: unknown) {
  try {
    (globalThis as any).__piPageEvents?.publish(topic, payload);
  } catch {}
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function runnerPath() {
  return pathJoin(pathDirname(fileURLToPath(import.meta.url)), "bin", "backup-runner.cjs");
}

async function allSources() {
  return core.effectiveSources(cfg, { home, dataRoot, selfId: "aiti-backup" });
}

async function sourceState() {
  try {
    return JSON.parse(await (await import("node:fs/promises")).readFile(pathJoin(stateDir, "source-state.json"), "utf8"));
  } catch {
    return {};
  }
}

async function saveSourceState(st: any) {
  try {
    await (await import("node:fs/promises")).mkdir(stateDir, { recursive: true });
    await (await import("node:fs/promises")).writeFile(pathJoin(stateDir, "source-state.json"), JSON.stringify(st, null, 2));
  } catch {}
}

function finalizeRun(sourceId: string, exitCode: number | null, sig: string | null) {
  const cur = current;
  current = null;
  if (!cur) return;
  const ok = exitCode === 0 && !!cur.summary;
  const record = {
    at: new Date().toISOString(),
    sourceId,
    ok,
    exitCode,
    signal: sig,
    durationMs: Date.now() - cur.startedAt,
    snapshot: cur.summary?.snapshot || null,
    mode: cur.summary?.mode || null,
    stats: cur.summary?.stats || null,
    pruned: cur.summary?.pruned || null,
    message: cur.errorMessage || (ok ? null : "runner 退出码 " + exitCode + (sig ? "（" + sig + "）" : "")),
  };
  core.appendRun(stateDir, record);
  sourceState().then(async (st) => {
    st[sourceId] = Object.assign({}, st[sourceId], { lastRun: record });
    if (ok) st[sourceId].lastGoodSnapshot = record.snapshot;
    await saveSourceState(st);
  });
  publish(ok ? "aiti-backup:done" : "aiti-backup:error", record);
  console.log("[aiti-backup] run " + sourceId + " " + (ok ? "done" : "failed") + " snapshot=" + (record.snapshot || "-"));
  pump();
}

function pump() {
  if (current || queue.length === 0) return;
  const sourceId = queue.shift()!;
  startRun(sourceId).catch((e) => {
    console.error("[aiti-backup] 启动失败 " + sourceId + "：", e?.message || e);
    current = null;
    core.appendRun(stateDir, { at: new Date().toISOString(), sourceId, ok: false, message: String(e?.message || e) });
    publish("aiti-backup:error", { sourceId, message: String(e?.message || e) });
    pump();
  });
}

async function startRun(sourceId: string) {
  const sources = await allSources();
  const src = sources.find((s: any) => s.id === sourceId);
  if (!src) throw new Error("未知备份源：" + sourceId);
  if (!src.enabled) throw new Error("备份源已停用：" + sourceId);
  if (!existsSync(src.path)) throw new Error("源路径不存在：" + src.path);
  if (!cfg.dest) throw new Error("未配置备份目的地（POST config {dest}）");
  await core.validateDestination(cfg.dest, [src.path], { home, dataRoot }); // 双保险（runner 内还会校验）

  const args = [
    runnerPath(),
    "--source-id",
    sourceId,
    "--src",
    String(src.path),
    "--dest",
    String(pathResolve(cfg.dest)),
    "--keep-count",
    String(cfg.keepCount ?? 7),
  ];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  current = { sourceId, child, startedAt: Date.now(), summary: null, errorMessage: null };

  let buf = "";
  let errTail = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event === "progress") {
        lastProgress.set(sourceId, msg);
        publish("aiti-backup:progress", { sourceId, ...msg });
      } else if (msg.event === "done") {
        current && (current.summary = msg.summary);
      } else if (msg.event === "error") {
        current && (current.errorMessage = msg.message);
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errTail = (errTail + chunk.toString()).slice(-2000);
  });
  child.on("close", (code: number | null, sig: string | null) => {
    if (current && !current.summary && !current.errorMessage && code !== 0) {
      current.errorMessage = "runner 异常退出 " + code + (errTail ? "：" + errTail.slice(-300) : "");
    }
    finalizeRun(sourceId, code, sig);
  });
  publish("aiti-backup:progress", { sourceId, phase: "spawn", done: 0, total: 0, bytes: 0, current: "" });
}

export default {
  id: "aiti-backup",
  name: "数据备份（快照）",
  version: "0.1.0",
  icon: "icon.svg",

  server: {
    startup(ctx: any) {
      configDir = ctx.configDir || "";
      stateDir = ctx.stateDir || (configDir ? pathJoin(configDir, "state") : "");
      // <dataRoot> 推导：configDir = <dataRoot>/<extId>/config
      const extRoot = pathDirname(configDir);
      dataRoot = pathBasename(extRoot) === "aiti-backup" ? pathDirname(extRoot) : "";
      cfg = null; // 热重载后强制重读配置（core 亦随 index.ts 重导入取新）
      console.log(
        "[aiti-backup] 就绪 · stateDir=" + stateDir + " · dataRoot=" + (dataRoot || "（推导失败，仅自定义源）")
      );
    },

    async api(req: any, ctx: any) {
      const p = ctx.path || [];
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      if (!configDir) return json({ ok: false, error: "扩展未初始化" }, 500);
      if (!cfg) cfg = await core.loadConfig(configDir);
      const fsp = await import("node:fs/promises");

      // GET /status —— 轻量：配置 + 队列/当前运行 + 最近 runs（不扫描源体积）
      if (p[0] === "status" && req.method === "GET") {
        const sources = await allSources();
        return json({
          ok: true,
          configured: !!cfg.dest,
          config: { dest: cfg.dest, keepCount: cfg.keepCount, sourceOverrides: cfg.sourceOverrides, custom: cfg.custom },
          sources: sources.map((s: any) => ({ id: s.id, kind: s.kind, label: s.label, path: s.path, enabled: s.enabled, exists: existsSync(s.path) })),
          current: current ? { sourceId: current.sourceId, startedAt: current.startedAt } : null,
          queue: [...queue],
          lastProgress: Object.fromEntries(lastProgress),
          runs: await core.readRuns(stateDir, 10),
        });
      }

      // POST /config {dest?, keepCount?, sourceOverrides?, custom?} —— dest 合法性校验后原子落盘
      if (p[0] === "config" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body) return json({ ok: false, error: "bad json" }, 400);
        const next = { ...cfg };
        if (body.dest !== undefined) next.dest = String(body.dest || "").trim();
        if (body.keepCount !== undefined) next.keepCount = Math.min(64, Math.max(1, Number(body.keepCount) || 7));
        if (body.sourceOverrides !== undefined && typeof body.sourceOverrides === "object") next.sourceOverrides = body.sourceOverrides;
        if (body.custom !== undefined && Array.isArray(body.custom)) next.custom = body.custom;
        if (next.dest) {
          const srcPaths = (await allSources()).filter((s: any) => s.enabled).map((s: any) => s.path);
          try {
            const destReal = await core.validateDestination(next.dest, srcPaths, { home, dataRoot });
            next.dest = destReal;
          } catch (e: any) {
            return json({ ok: false, error: e?.message || String(e) }, 400);
          }
        }
        cfg = next;
        await core.saveConfig(configDir, cfg);
        return json({ ok: true, config: { dest: cfg.dest, keepCount: cfg.keepCount } });
      }

      // GET /sources —— 生效源清单 + 最近运行状态
      if (p[0] === "sources" && req.method === "GET") {
        const sources = await allSources();
        const st = await sourceState();
        return json({
          ok: true,
          sources: sources.map((s: any) => ({ ...s, exists: existsSync(s.path), lastRun: st[s.id]?.lastRun || null })),
        });
      }

      // POST /source-stats {id} —— 按需扫描（元数据 only，不复制）
      if (p[0] === "source-stats" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const sources = await allSources();
        const src = sources.find((s: any) => s.id === body?.id);
        if (!src) return json({ ok: false, error: "未知备份源" }, 404);
        if (!existsSync(src.path)) return json({ ok: false, error: "源路径不存在" }, 400);
        const scan = await core.scanSource(src.path);
        return json({ ok: true, id: src.id, files: scan.files.length, bytes: scan.totalBytes, skipped: scan.skipped.length });
      }

      // POST /backup {sourceId} 或 {all:true} —— 入队（单飞行串行，逐源跑）
      if (p[0] === "backup" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        let ids: string[] = [];
        if (body?.all) {
          ids = (await allSources()).filter((s: any) => s.enabled && existsSync(s.path)).map((s: any) => s.id);
        } else if (body?.sourceId) {
          ids = [String(body.sourceId)];
        }
        if (!ids.length) return json({ ok: false, error: "缺少 sourceId 或 all" }, 400);
        if (!cfg.dest) return json({ ok: false, error: "未配置备份目的地（POST config {dest}）" }, 400);
        const queued: string[] = [];
        const rejected: { id: string; reason: string }[] = [];
        for (const id of ids) {
          if (current?.sourceId === id || queue.includes(id)) rejected.push({ id, reason: "已在运行/队列" });
          else {
            queue.push(id);
            queued.push(id);
          }
        }
        pump();
        return json({ ok: true, queued, rejected, running: current?.sourceId || null });
      }

      // POST /cancel {sourceId?} —— 终止当前（runner 清 .tmp 后退出）；可从队列摘除
      if (p[0] === "cancel" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const removed: string[] = [];
        if (body?.sourceId) {
          const i = queue.indexOf(String(body.sourceId));
          if (i >= 0) {
            queue.splice(i, 1);
            removed.push(String(body.sourceId));
          }
        }
        let killed: string | null = null;
        if (current && (!body?.sourceId || current.sourceId === body.sourceId)) {
          killed = current.sourceId;
          try {
            current.child.kill("SIGTERM");
          } catch {}
        }
        return json({ ok: true, killed, removedFromQueue: removed });
      }

      // GET /snapshots?sourceId=xx
      if (p[0] === "snapshots" && req.method === "GET") {
        let qs = "";
        try {
          qs = new URL(req.url, "http://local").searchParams.get("sourceId") || "";
        } catch {}
        const sourceId = String(qs || p[1] || "");
        if (!sourceId || !cfg.dest) return json({ ok: false, error: "缺少 sourceId 或未配置目的地" }, 400);
        return json({ ok: true, snapshots: await core.listSnapshots(cfg.dest, sourceId) });
      }

      // POST /cleanup-tmp {sourceId} —— 清半成品
      if (p[0] === "cleanup-tmp" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (!cfg.dest) return json({ ok: false, error: "未配置目的地" }, 400);
        const snapRoot = pathJoin(pathResolve(cfg.dest), String(body?.sourceId || ""), "snapshots");
        return json({ ok: true, removed: await core.cleanupTmp(snapRoot) });
      }

      // GET /runs
      if (p[0] === "runs" && req.method === "GET") {
        return json({ ok: true, runs: await core.readRuns(stateDir, 50) });
      }

      return json({ ok: false, error: "not found" }, 404);
    },
  },
};
