/**
 * doc-worker.ts —— 文档中心索引进程内 Worker（真后台，方案 §10.2 迭代）
 *
 * 为什么：node:sqlite 是同步 API，主线程里批量扫描/写库会饿死事件循环（整个 pi-web 失去响应）。
 * 本 Worker 独立线程 + 独立 SQLite 连接（WAL 多连接并发），主线程只做查询与消息转发。
 *
 * 协议（Main → Worker）：
 *   {cmd:"scan", full}                       全量/增量扫描
 *   {cmd:"reindex", root, rel}               单文件重索引（onOp / fs.watch 驱动）
 *   {cmd:"session-ops", sid, rows}           回填：main 经 services.trace.readOps 拉到的台账行
 *   {cmd:"abort"}                            中止当前扫描
 * 协议（Worker → Main）：
 *   {type:"ready"|"scan-start"|...|"scan-done"|...} 进度与状态（main 转 SSE）
 *
 * 红线继承：worker 不读兄弟扩展 configDir（session-ops 的 rows 由 main 拉好传入）。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import {
  initSchema, walkFiles, parseMarkdown, upsertDoc, compareMap,
  markMissingDeleted, markOneDeleted, purgeExpired, rebuildAllLinks, computeRank,
  contentHash, derivePathTags, TAG_LOGIC_VERSION, INDEX_LOGIC_VERSION,
} from "../doc-core.ts";

interface Cfg { dbPath: string; roots: string[]; excludes: string[]; maxFileKB: number }
const { dbPath, cfg } = workerData as { dbPath: string; cfg: Cfg };

mkdirSync(dbPath.replace(/\/[^/]+$/, ""), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA synchronous=NORMAL;");
db.exec("PRAGMA busy_timeout=5000");
initSchema(db);

const excludes = new Set<string>(cfg.excludes);
const scan = { running: false, done: 0, total: 0, current: "", changed: 0, lastAt: 0, lastError: "" };
let scanSeq = 0;
let graphTimer: any = null;

const post = (msg: any) => { try { parentPort!.postMessage(msg); } catch { /* ignore */ } };
const log = (msg: string) => post({ type: "log", msg });

// ── 跨实例扫描锁（dev/prod 共享数据根；同进程内另有 running 标志） ──

function scanLockAcquire(): boolean {
  const row = db.prepare("SELECT value FROM meta WHERE key='scan_lock'").get() as any;
  if (row) {
    const parts = String(row.value).split(":");
    const pid = Number(parts[0]);
    if (pid !== process.pid && Date.now() - Number(parts[1]) < 120_000) {
      try { process.kill(pid, 0); return false; } catch { /* 持锁进程已死：接管 */ }
    }
  }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('scan_lock', ?)").run(process.pid + ":" + Date.now());
  return true;
}
function scanLockRelease(): void {
  try { db.prepare("DELETE FROM meta WHERE key='scan_lock' AND value LIKE ?").run(process.pid + ":%"); } catch { /* ignore */ }
}

// ── 单文件重索引 ──

function reindexOne(root: string, rel: string): void {
  const abs = root + "/" + rel;
  if (!existsSync(abs)) {
    if (markOneDeleted(db, root, rel)) scheduleGraph();
    return;
  }
  try {
    const st = statSync(abs);
    let text = readFileSync(abs, "utf8");
    let headOnly = false;
    if (st.size > cfg.maxFileKB * 1024) { text = text.slice(0, 4096); headOnly = true; }
    const parsed = parseMarkdown(text);
    if (headOnly) { parsed.body = ""; parsed.wordCount = 0; parsed.inlineTags = []; parsed.links = []; parsed.headings = []; }
    upsertDoc(db, { root, rel, mtimeMs: Math.round(st.mtimeMs), size: st.size, hash: contentHash(text), parsed, pathTags: derivePathTags(rel) });
    drainPending(); // 新档命中 pending → 补会话关联（命中与否都发一次 doc-updated）
    post({ type: "doc-updated", root, rel });
    scheduleGraph();
  } catch (e: any) {
    scan.lastError = rel + ": " + String(e?.message ?? e);
  }
}

function scheduleGraph(): void {
  clearTimeout(graphTimer);
  graphTimer = setTimeout(() => {
    try {
      const r = rebuildAllLinks(db, cfg.roots);
      computeRank(db);
      post({ type: "graph-updated", edges: r.edges });
    } catch { /* 下次触发再试 */ }
  }, 3000);
}

// ── 扫描 ──

async function scanAll(fullOpt: boolean): Promise<void> {
  let full = fullOpt;
  if (scan.running) { post({ type: "scan-skipped", reason: "in progress" }); return; }
  if (!scanLockAcquire()) { post({ type: "scan-skipped", reason: "another instance scanning" }); return; }
  scan.running = true; scan.done = 0; scan.total = 0; scan.changed = 0; scan.current = ""; scan.lastError = "";
  const seq = ++scanSeq;
  const t0 = Date.now();
  try {
    // 派生规则版本：不一致 → 全量（版本号开始即写，防重启打断→重复全量循环）
    const lv = db.prepare("SELECT value FROM meta WHERE key='tag_logic_version'").get() as any;
    if (lv?.value !== TAG_LOGIC_VERSION) {
      full = true;
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('tag_logic_version', ?)").run(TAG_LOGIC_VERSION);
    }
    // 短词索引版本（doc_bigrams）：老库缺表/空表 → 全量重建回填 2-gram
    const iv = db.prepare("SELECT value FROM meta WHERE key='index_logic_version'").get() as any;
    if (iv?.value !== INDEX_LOGIC_VERSION) {
      full = true;
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('index_logic_version', ?)").run(INDEX_LOGIC_VERSION);
    }
    const files: any[] = [];
    for (const root of cfg.roots) {
      for (const f of walkFiles(root, excludes)) files.push({ ...f, root });
    }
    scan.total = files.length;
    post({ type: "scan-start", total: scan.total, full });
    const map = compareMap(db);
    const seen = new Set<string>();
    for (const f of files) {
      if (seq !== scanSeq) { post({ type: "scan-aborted" }); return; }
      const key = f.root + "\u0000" + f.rel;
      seen.add(key);
      const prev = map.get(key);
      if (!full && prev && !prev.deleted && prev.mtimeMs === f.mtimeMs && prev.size === f.size) { scan.done++; continue; }
      scan.current = f.rel;
      try {
        let text = readFileSync(f.abs, "utf8");
        if (f.size > cfg.maxFileKB * 1024) {
          text = text.slice(0, 4096);
          const parsed = parseMarkdown(text);
          parsed.body = ""; parsed.wordCount = 0; parsed.inlineTags = []; parsed.links = []; parsed.headings = [];
          upsertDoc(db, { root: f.root, rel: f.rel, mtimeMs: f.mtimeMs, size: f.size, hash: contentHash(text), parsed, pathTags: derivePathTags(f.rel) });
        } else {
          upsertDoc(db, {
            root: f.root, rel: f.rel, mtimeMs: f.mtimeMs, size: f.size,
            hash: contentHash(text), parsed: parseMarkdown(text), pathTags: derivePathTags(f.rel),
          });
        }
        scan.changed++;
      } catch (e: any) {
        scan.lastError = f.rel + ": " + String(e?.message ?? e);
      }
      scan.done++;
      if (scan.done % 25 === 0) post({ type: "scan-progress", done: scan.done, total: scan.total, current: scan.current });
    }
    const deleted = markMissingDeleted(db, seen);
    purgeExpired(db, Date.now() - 30 * 86400_000);
    const drained = drainPending(); // 全量收集后建档的 pending 关联在此冲销
    const links = rebuildAllLinks(db, cfg.roots);
    computeRank(db);
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* ignore */ }
    scan.lastAt = Date.now();
    if (full) {
      // 全量后 30s 回收空间（软删行 + 旧 fts；VACUUM 需要独占锁，错峰执行）
      setTimeout(() => {
        try { db.exec("VACUUM;"); post({ type: "log", msg: "VACUUM 完成" }); } catch { /* 忙时跳过 */ }
      }, 30_000);
    }
    post({ type: "scan-done", total: scan.total, changed: scan.changed, deleted, drained, edges: links.edges, dangling: links.dangling, ms: scan.lastAt - t0 });
  } catch (e: any) {
    scan.lastError = String(e?.message ?? e);
    post({ type: "log", msg: "scanAll: " + scan.lastError });
  } finally {
    scan.running = false;
    scanLockRelease();
  }
}

// ── 回填（rows 由 main 经 services.trace 拉取后传入；红线：不直读兄弟 configDir） ──
//
// 语义：每个会话的全量 rows 重算 → 「替换」而非累加（重复回填/重放幂等，op_count 不翻倍）。
// 未命中索引的 (root,path) 进 pending_session_docs 暂存，待 reindex/scan 建档后冲销（drainPending）
// ——修复「回填早于文档索引，关联永久丢失」（如会话写新文档 → 回填先跑 → 文档后被收集）。

const SESSION_UPSERT = `INSERT INTO doc_sessions(doc_id, session_id, first_op, last_op, op_count) VALUES(?,?,?,?,?)
  ON CONFLICT(doc_id, session_id) DO UPDATE SET
    first_op=MIN(COALESCE(first_op, excluded.first_op), excluded.first_op),
    last_op=MAX(COALESCE(last_op, 0), excluded.last_op),
    op_count=excluded.op_count`;

function applySessionOps(sid: string, rows: any[]): number {
  let touched = 0;
  const byDoc = new Map<number, { first: number; last: number; count: number }>();
  const pendings = new Map<string, { first: number; last: number; count: number }>();
  for (const r of rows ?? []) {
    for (const st of r?.stores ?? []) {
      const storeRoot = typeof st?.root === "string" ? st.root.replace(/\/+$/, "") : "";
      if (!storeRoot) continue;
      for (const p of st?.paths ?? []) {
        // ops 的 root 是 git 仓根；docs 表键是扫描根+相对路径 → 平移映射
        let mapped: { sr: string; rel: string } | null = null;
        for (const scanRoot of cfg.roots) {
          const sr = scanRoot.replace(/\/+$/, "");
          let rel: string;
          if (storeRoot === sr) rel = String(p);
          else if (storeRoot.startsWith(sr + "/")) rel = storeRoot.slice(sr.length + 1) + "/" + p;
          else continue;
          mapped = { sr, rel };
          break;
        }
        if (!mapped) continue;
        const d = db.prepare("SELECT id FROM docs WHERE root=? AND relpath=?").get(mapped.sr, mapped.rel) as any;
        const t0 = Number(r.t0) || 0, t1 = Number(r.t1) || 0;
        if (d) {
          const cur = byDoc.get(d.id) ?? { first: t0, last: t1, count: 0 };
          cur.first = Math.min(cur.first || t0, t0);
          cur.last = Math.max(cur.last, t1);
          cur.count++;
          byDoc.set(d.id, cur);
        } else {
          const k = mapped.sr + "\0" + mapped.rel;
          const cur = pendings.get(k) ?? { sr: mapped.sr, rel: mapped.rel, first: t0, last: t1, count: 0 };
          cur.first = Math.min(cur.first || t0, t0);
          cur.last = Math.max(cur.last, t1);
          cur.count++;
          pendings.set(k, cur);
        }
      }
    }
  }
  if (!byDoc.size && !pendings.size) return 0;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM doc_sessions WHERE session_id=?").run(sid); // 全量重算 → 替换语义
    for (const [docId, v] of byDoc) {
      db.prepare(SESSION_UPSERT).run(docId, sid, v.first, v.last, v.count);
    }
    for (const v of pendings.values()) {
      db.prepare(`INSERT INTO pending_session_docs(root, path, sid, first_op, last_op, op_count) VALUES(?,?,?,?,?,?)
        ON CONFLICT(root, path, sid) DO UPDATE SET
          first_op=MIN(COALESCE(first_op, excluded.first_op), excluded.first_op),
          last_op=MAX(COALESCE(last_op, 0), excluded.last_op),
          op_count=excluded.op_count`).run(v.sr, v.rel, sid, v.first, v.last, v.count);
    }
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* ignore */ } throw e; }
  touched = byDoc.size;
  if (pendings.size) drainPending(); // 本轮建档可能已覆盖部分 pending
  scheduleGraph();
  return touched;
}

/** pending 冲销：已建档（deleted=0）的 pending 路径 → 写 doc_sessions 并清除（reindexOne/scanAll/回填后共用）。 */
function drainPending(): number {
  const rows = db.prepare(`SELECT p.rowid rid, d.id doc_id, p.sid, p.first_op, p.last_op, p.op_count
    FROM pending_session_docs p JOIN docs d ON d.root=p.root AND d.relpath=p.path AND d.deleted=0`).all() as any[];
  if (!rows.length) return 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      db.prepare(SESSION_UPSERT).run(r.doc_id, r.sid, r.first_op, r.last_op, r.op_count);
      db.prepare("DELETE FROM pending_session_docs WHERE rowid=?").run(r.rid);
    }
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* ignore */ } throw e; }
  return rows.length;
}

// ── 消息循环 ──

parentPort!.on("message", (m: any) => {
  try {
    if (m?.cmd === "scan") void scanAll(!!m.full);
    else if (m?.cmd === "reindex" && typeof m.root === "string" && typeof m.rel === "string") reindexOne(m.root, m.rel);
    else if (m?.cmd === "session-ops" && typeof m.sid === "string") {
      const n = applySessionOps(m.sid, Array.isArray(m.rows) ? m.rows : []);
      if (n) post({ type: "session-ops-done", sid: m.sid, docs: n });
    } else if (m?.cmd === "abort") scanSeq++;
  } catch (e: any) {
    log("message handler: " + String(e?.message ?? e));
  }
});

post({ type: "ready" });
