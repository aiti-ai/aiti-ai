/**
 * aiti-ai-usage · 代理 key 日志 tail（fs.watch，事件驱动零轮询）。
 *
 * 数据源：pi-models-combo v0.2.1+ 写的
 *   <agentDir>/model-usage/key-requests-<YYYY-MM>.jsonl（当前月）
 *   key-requests-<YYYY-MM>.jsonl.gz                    （历史月，启动时全量导入一次）
 *
 * 行类型：
 *   {ts,type?:"client", client,pid,cwd}                     → clients 表
 *   {ts,type:"session", client,sessionId,cwd}               → client_sessions 表
 *   其余视为请求记录 {ts,provider,model,key,status,client,usage?} → key_req 表
 */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { UsageDb } from "./db.ts";
import { localDay } from "./db.ts";
import { noteDirtyDay, withTx, yieldToLoop } from "./ingest.ts";

export interface ProxyLogCtx {
  usage: UsageDb;
  dir: string;              // <agentDir>/model-usage
  onData?: () => void;      // 每批新数据回调（如 flushDaily）
}

const watcher = fs.watch;

function ingestLine(ctx: ProxyLogCtx, line: string): void {
  if (!line) return;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return; }
  const db = ctx.usage.db;
  const ts = Number(rec.ts) || Date.now();
  const day = localDay(ts);

  if (rec.type === "client") {
    db.prepare(`INSERT INTO clients (client, pid, cwd, first_ts) VALUES (?, ?, ?, ?)
      ON CONFLICT(client) DO NOTHING`).run(rec.client ?? "", rec.pid ?? null, rec.cwd ?? null, ts);
    return;
  }
  if (rec.type === "session") {
    if (!rec.client || !rec.sessionId) return;
    db.prepare(`INSERT OR IGNORE INTO client_sessions (client, session_id, ts, cwd) VALUES (?, ?, ?, ?)`)
      .run(rec.client, rec.sessionId, ts, rec.cwd ?? null);
    // 会话可能不在 sessions 表（如 CLI 会话还没被扫描）→ 建占位行，后续 sync 补内容
    db.prepare(`INSERT INTO sessions (id, cwd, state, started_at, last_ts)
      VALUES (?, ?, 'active', ?, ?) ON CONFLICT(id) DO NOTHING`).run(rec.sessionId, rec.cwd ?? null, ts, ts);
    return;
  }

  // token 字段在记录顶层平铺（pmc v0.2.1 格式），非嵌套 usage
  noteDirtyDay(day);
  db.prepare(`INSERT OR IGNORE INTO key_req (ts, day, provider, model, key_name, status, client,
    input, output, cache_read, cache_write, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ts, day, String(rec.provider ?? "?"), rec.model ?? null, rec.key ?? "",
      Number(rec.status) || 0, rec.client ?? null,
      numOrNull(rec.input), numOrNull(rec.output), numOrNull(rec.cacheRead),
      numOrNull(rec.cacheWrite), numOrNull(rec.reasoning));
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 批量逐行入库：每 batch 行一个事务 + 让出事件循环（启动期 47k 级行数不再冻结主线程）。 */
async function ingestLinesBatched(ctx: ProxyLogCtx, lines: string[], batch = 2000): Promise<void> {
  for (let i = 0; i < lines.length; i += batch) {
    const slice = lines.slice(i, i + batch);
    withTx(ctx.usage.db, () => {
      for (const line of slice) ingestLine(ctx, line);
    });
    if (i + batch < lines.length) await yieldToLoop();
  }
}

async function ingestFile(ctx: ProxyLogCtx, file: string, offsetKey: string | null): Promise<void> {
  const st = fs.statSync(file);
  const db = ctx.usage.db;
  let from = 0;
  if (offsetKey) {
    const prev = db.prepare("SELECT v FROM meta WHERE k = ?").get(offsetKey) as any;
    from = prev ? Number(prev.v) : 0;
    if (from > st.size) from = 0; // 截断/重转 → 重读
  }
  const fd = fs.openSync(file, "r");
  try {
    const len = st.size - from;
    if (len <= 0) return;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    let text = buf.toString("utf8");
    let consumed = st.size;
    if (offsetKey) {
      // 只消费完整行；最后半行留给下次。偏移先单调推进（幂等写，INSERT OR IGNORE 去重），
      // 若随后批写入失败，offset 已前进但数据可能缺——下次不会重读该段。
      // 故：offset 推进放在批写入成功之后，见下方。
      const nl = text.lastIndexOf("\n");
      if (nl < 0) return;
      text = text.slice(0, nl);
      consumed = from + Buffer.byteLength(text) + 1;
      await ingestLinesBatched(ctx, text.split("\n"));
      withTx(db, () => {
        db.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
          .run(offsetKey, String(consumed));
      });
      ctx.onData?.();
      return;
    }
    await ingestLinesBatched(ctx, text.split("\n"));
    ctx.onData?.();
  } finally {
    fs.closeSync(fd);
  }
}

/** 启动导入：历史月（.gz 全量一次）+ 当前月增量 tail 起点。异步分批（不再冻结事件循环）。 */
export async function importProxyHistory(ctx: ProxyLogCtx): Promise<number> {
  let names: string[];
  try { names = fs.readdirSync(ctx.dir); } catch { return 0; }
  let n = 0;
  for (const name of names.sort()) {
    if (/^key-requests-\d{4}-\d{2}\.jsonl\.gz$/.test(name)) {
      const done = ctx.usage.db.prepare("SELECT v FROM meta WHERE k = ?").get(`gz:${name}`) as any;
      if (done) continue;
      const file = path.join(ctx.dir, name);
      try {
        const raw = gunzipFileSync(file);
        await ingestLinesBatched(ctx, raw.split("\n"));
        ctx.usage.db.prepare("INSERT INTO meta (k,v) VALUES ('gz:" + name + "','1') ON CONFLICT(k) DO UPDATE SET v='1'").run();
        n++;
      } catch (err: any) {
        console.error("[aiti-ai-usage] gz 导入失败:", name, err?.message ?? err);
      }
    }
  }
  for (const name of names) {
    if (/^key-requests-\d{4}-\d{2}\.jsonl$/.test(name)) {
      await ingestFile(ctx, path.join(ctx.dir, name), `off:${name}`);
      n++;
    }
  }
  return n;
}

function gunzipFileSync(file: string): string {
  return gunzipSync(fs.readFileSync(file)).toString("utf8");
}

/** 监听目录新写入（事件驱动）。返回停止函数。 */
export function watchProxyLog(ctx: ProxyLogCtx): () => void {
  let w: fs.FSWatcher | null = null;
  try { w = watcher(ctx.dir); } catch { return () => {}; }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onFsEvent = (_evt: string, name: string | Buffer | null) => {
    const n = name == null ? "" : String(name);
    if (!/^key-requests-\d{4}-\d{2}\.jsonl$/.test(n)) return;
    // 短去抖合并同批多次 append（写进程可能一行一 appendFileSync）
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      ingestFile(ctx, path.join(ctx.dir, n), `off:${n}`).catch(() => { /* 文件瞬时消失等 */ });
    }, 200);
  };
  w.on("change", onFsEvent);
  w.on("rename", onFsEvent);
  w.on("error", () => { /* 目录被删等——静默 */ });
  return () => { try { w?.close(); } catch { /* noop */ } };
}
