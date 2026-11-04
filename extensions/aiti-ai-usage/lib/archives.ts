/**
 * aiti-ai-usage · 归档会话扫描（session-manager .pwarc 容器）。
 *
 * .pwarc = "PWARC1\n" + 逐文件 brotli 块 + 尾部 manifest + u32 len + u32 magic。
 * 按 (mtime,size) 增量：包变化 → 清旧数据整包重灌（与 token-usage.mjs 同逻辑，
 * 但入库到扩展自己的 SQLite，并保留 sessions.state/archived 标记）。
 */
import fs from "node:fs";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { openSync, readSync, closeSync } from "node:fs";
import type { UsageDb } from "./db.ts";
import { parseSessionJsonl, insertMsgRows, insertUserRows, refreshSessionAggregatesAsync, withTx, yieldToLoop } from "./ingest.ts";

const FOOTER_MAGIC = 0x43524157;

interface Manifest { files: Array<{ sessionId: string; offset: number; brotliSize: number }> }

function readManifest(pkgPath: string): Manifest | null {
  const fd = openSync(pkgPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 8) return null;
    const footer = Buffer.alloc(8);
    readSync(fd, footer, 0, 8, size - 8);
    if (footer.readUInt32LE(4) !== FOOTER_MAGIC) return null;
    const len = footer.readUInt32LE(0);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - 8 - len);
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function extractEntry(pkgPath: string, entry: { offset: number; brotliSize: number }): string {
  const fd = openSync(pkgPath, "r");
  try {
    const buf = Buffer.alloc(entry.brotliSize);
    readSync(fd, buf, 0, entry.brotliSize, entry.offset);
    return brotliDecompressSync(buf).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** 增量扫描归档目录。opts.force=true（user_msgs 重建）时忽略包水位，重灌全部包。
 *  返回处理的包数。异步分批：包间让步 + 分段事务，不冻结事件循环。 */
export async function syncArchives(usage: UsageDb, archiveDir: string, opts: { force?: boolean } = {}): Promise<number> {
  let names: string[];
  try { names = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".pwarc")); } catch { return 0; }
  let changed = 0;
  const metaStmt = usage.db.prepare("SELECT v FROM meta WHERE k = ?");
  for (const name of names) {
    const pkgPath = path.join(archiveDir, name);
    let st: fs.Stats;
    try { st = fs.statSync(pkgPath); } catch { continue; }
    const want = `${Math.round(st.mtimeMs)}:${st.size}`;
    const prevRow = metaStmt.get(`pkg:${pkgPath}`) as any;
    if (!opts.force && prevRow && prevRow.v === want) continue;

    const manifest: Manifest | null = readManifest(pkgPath);
    if (!manifest?.files?.length) continue;
    // 包重写过 → 先清这个包旧会话的数据再整包重灌
    const oldIds = (usage.db.prepare(
      `SELECT DISTINCT id FROM sessions WHERE source_file = ?`).all(pkgPath) as Array<{ id: string }>).map((r) => r.id);
    const ids = [...new Set([...manifest.files.map((f) => f.sessionId), ...oldIds])];
    withTx(usage.db, () => {
      const delM = usage.db.prepare("DELETE FROM msg_usage WHERE session_id = ?");
      const delS = usage.db.prepare("DELETE FROM sessions WHERE id = ?");
      for (const sid of ids) { delM.run(sid); delS.run(sid); }
    });

    const touched = new Set<string>();
    const CHUNK = 50;
    for (let i = 0; i < manifest.files.length; i += CHUNK) {
      const chunk = manifest.files.slice(i, i + CHUNK);
      // 先在事务外解析（含行级让步），再在事务内写入（同步回调不能 await）
      const prepared: Array<{ entry: Manifest["files"][number]; parsed: Awaited<ReturnType<typeof parseSessionJsonl>> }> = [];
      for (const entry of chunk) {
        let text: string;
        try { text = extractEntry(pkgPath, entry); } catch { continue; }
        const parsed = await parseSessionJsonl(text, entry.sessionId);
        parsed.id = entry.sessionId;
        for (const r of parsed.rows) r.session_id = entry.sessionId;
        prepared.push({ entry, parsed });
      }
      // 包内分段事务：中途失败不写 meta 标记 → 下次整包重灌（幂等）
      withTx(usage.db, () => {
        for (const { entry, parsed } of prepared) {
          insertMsgRows(usage, parsed.rows);
          insertUserRows(usage, parsed.userRows);
          touched.add(entry.sessionId);
          usage.db.prepare(`
            INSERT INTO sessions (id, cwd, title, started_at, last_ts, archived, state, source_file)
            VALUES (?, ?, ?, ?, ?, 1, 'archived', ?)
            ON CONFLICT(id) DO UPDATE SET
              cwd=excluded.cwd, title=CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
              archived=1, state='archived', source_file=excluded.source_file`).run(
            entry.sessionId, parsed.cwd, parsed.title, parsed.firstTs || null, parsed.lastTs || null, pkgPath);
        }
      });
      if (i + CHUNK < manifest.files.length) await yieldToLoop();
    }
    await refreshSessionAggregatesAsync(usage, [...touched]);
    withTx(usage.db, () => {
      usage.db.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
        .run(`pkg:${pkgPath}`, want);
    });
    changed++;
    await yieldToLoop(); // 包间让步
  }
  return changed;
}
