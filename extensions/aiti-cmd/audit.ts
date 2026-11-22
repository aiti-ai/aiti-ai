/**
 * aiti-cmd · 执行审计 —— 仿 pi 的 JSONL 全量留存（安全审计）
 *
 * 所有执行逐条 append-only 落盘到 <ctx.cacheDir>/logs/<YYYY-MM-DD>.jsonl（= ~/.pi/web/data/aiti-cmd/cache/logs/），
 * 按天分片、追加写、历史不可改（权限 600）。输出另存 sidecar 纯文本文件
 * （去 ANSI；>1MB 截断 + outputTruncated 标记 + 保留尾部）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

/** 日志保留天数（按天分片文件超期清理） */
const RETENTION_DAYS = parseInt(process.env.AITI_CMD_RETENTION_DAYS || "90", 10) || 90;

export interface AuditRecord {
  ts: number;
  id: string;
  kind: "exec";
  /** 触发来源——开放语义（aiti-cmd-exec-integration-plan.md §3.1）：新入口可传新值，未知值在
   *  POST /run 收口为 "unknown"。基线枚举（只作参照不封闭）：
   *  manual | message | shell | favorite | asr-selfheal | schedule | suggest | ai-helper | codebuddy | service | unknown */
  source: string;
  /** true = POST /run 未带 source 被兜底（不再静默吞成 manual，防新入口漏传，§3.1） */
  sourceDefaulted?: boolean;
  /** 触发来源：pi 会话 id（消息识别执行时关联） */
  piSessionId?: string;
  cwd?: string;
  /** 完整命令（参数已填充） */
  cmd: string;
  /** 参数（运行前填写的占位符值） */
  params?: Record<string, string>;
  /** 环境变量名（值不落盘——脱敏） */
  envNames?: string[];
  /** 命中危险模式 */
  danger?: string[];
  confirm?: boolean;
  /** 沙箱模式 */
  sandbox?: string;
  pid?: number;
  exit?: number | null;
  signal?: string | null;
  durationMs?: number;
  outBytes?: number;
  outputTruncated?: boolean;
  outputFile?: string;
  /** 哈希链（防篡改）：sha256(prevHash + 本记录无 hash 字段的规范序列化) */
  hash?: string;
}

export interface AuditQuery {
  from?: number;
  to?: number;
  source?: string;
  exit?: string;
  cmd?: string;
  limit?: number;
}

export function createAudit(cacheDir: string) {
  const logsDir = path.join(cacheDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });

  const todayFile = () => path.join(logsDir, new Date().toISOString().slice(0, 10) + ".jsonl");

  // ---- 哈希链（防篡改）：lastHash 在进程内随 append 推进；启动时从现有文件尾部重建 ----
  let lastHash = "";
  function rebuildChain() {
    lastHash = "";
    for (const f of listFiles()) {
      try {
        const lines = fs.readFileSync(path.join(logsDir, f), "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as AuditRecord;
            if (rec.hash) lastHash = rec.hash;
          } catch { /* skip bad line */ }
        }
      } catch { /* skip file */ }
    }
  }
  function chainHash(prev: string, rec: AuditRecord): string {
    const { hash: _h, ...canon } = rec; // 规范序列化（去掉 hash 自身，防止自引用）
    return createHash("sha256").update(prev + JSON.stringify(canon)).digest("hex");
  }
  rebuildChain();

  function append(rec: AuditRecord) {
    try {
      rec.hash = chainHash(lastHash, rec);
      lastHash = rec.hash;
      fs.appendFileSync(todayFile(), JSON.stringify(rec) + "\n", { mode: 0o600 });
    } catch (e) {
      console.error("[aiti-cmd] audit append failed:", e);
    }
  }

  /** 校验哈希链：从第一条带 hash 的记录向后重放；篡改/缺失 → 返回损坏点 */
  function verify(): { ok: boolean; count: number; legacy: number; brokenAt?: string; checkedHashes: number } {
    let prev = "";
    let count = 0, legacy = 0, checked = 0;
    let brokenAt: string | undefined;
    for (const f of listFiles()) {
      try {
        const lines = fs.readFileSync(path.join(logsDir, f), "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as AuditRecord;
            count++;
            if (!rec.hash) { legacy++; continue; } // 升级前 legacy 记录不参与校验
            const expected = chainHash(prev, rec);
            if (expected !== rec.hash) { brokenAt = rec.id; break; }
            prev = rec.hash;
            checked++;
          } catch { /* skip bad line */ }
        }
        if (brokenAt) break;
      } catch { /* skip file */ }
    }
    return { ok: !brokenAt, count, legacy, brokenAt, checkedHashes: checked };
  }

  /** 保留策略：删除超过保留天数的日志文件（.jsonl + .out.txt），返回删除数 */
  function cleanupRetention(): number {
    let removed = 0;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
    try {
      const files = fs.readdirSync(logsDir);
      for (const f of files) {
        // 文件日期：jsonl 取文件名前缀（YYYY-MM-DD）；out.txt 取对应 id 记录的日期（简化：按 mtime）
        let dateStr: string | null = null;
        const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (m) dateStr = m[1];
        else {
          try { dateStr = new Date(fs.statSync(path.join(logsDir, f)).mtime).toISOString().slice(0, 10); } catch { continue; }
        }
        const fileTs = Date.parse(dateStr);
        if (!isNaN(fileTs) && fileTs < cutoff) {
          try { fs.unlinkSync(path.join(logsDir, f)); removed++; } catch {}
        }
      }
    } catch {}
    return removed;
  }


  /** 执行输出落盘：去 ANSI 纯文本，>1MB 截断保留尾部（>=MAX 字节则输出尾部 MAX*0.4） */
  function writeOutput(id: string, raw: string): { outBytes: number; outputTruncated: boolean; outputFile: string } {
    const clean = stripAnsi(raw);
    const bytes = Buffer.byteLength(clean, "utf8");
    const MAX = 1024 * 1024;
    const outputTruncated = bytes > MAX;
    const final = outputTruncated ? clean.slice(-Math.floor(MAX * 0.6)) : clean;
    const outputFile = path.join(logsDir, `${id}.out.txt`);
    try {
      fs.writeFileSync(outputFile, final, { mode: 0o600 });
    } catch (e) {
      console.error("[aiti-cmd] audit output write failed:", e);
    }
    return { outBytes: bytes, outputTruncated, outputFile };
  }

  function readOutput(id: string): string | null {
    try {
      const p = path.join(logsDir, `${id}.out.txt`);
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }

  function listFiles(): string[] {
    try {
      return fs.readdirSync(logsDir).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
  }

  function query(q: AuditQuery = {}): AuditRecord[] {
    const out: AuditRecord[] = [];
    const files = listFiles();
    for (const f of files) {
      try {
        const lines = fs.readFileSync(path.join(logsDir, f), "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as AuditRecord;
            if (q.from && rec.ts < q.from) continue;
            if (q.to && rec.ts > q.to) continue;
            if (q.source && rec.source !== q.source) continue;
            if (q.exit !== undefined && rec.exit !== Number(q.exit)) continue;
            if (q.cmd && !rec.cmd.includes(q.cmd)) continue;
            out.push(rec);
          } catch { /* skip bad line */ }
        }
      } catch { /* skip file */ }
    }
    out.sort((a, b) => b.ts - a.ts);
    const limit = Math.min(Math.max(parseInt(String(q.limit || 100), 10) || 100, 1), 1000);
    return out.slice(0, limit);
  }

  /** 按 source 汇总（§3.1 /history?groupBy=source 数据源）：全量扫描聚合数量/最近时间/失败率 */
  function summarizeBySource(): { source: string; count: number; lastTs: number; failCount: number; failRate: number }[] {
    const acc = new Map<string, { count: number; lastTs: number; failCount: number }>();
    for (const f of listFiles()) {
      try {
        const lines = fs.readFileSync(path.join(logsDir, f), "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as AuditRecord;
            const src = rec.source || "unknown";
            let a = acc.get(src);
            if (!a) { a = { count: 0, lastTs: 0, failCount: 0 }; acc.set(src, a); }
            a.count++;
            if (rec.ts > a.lastTs) a.lastTs = rec.ts;
            // 失败语义与查询一致：exit 非 0（含信号杀 128+n）计失败；exit null（排队取消/在途）不计
            if (typeof rec.exit === "number" && rec.exit !== 0) a.failCount++;
          } catch { /* skip bad line */ }
        }
      } catch { /* skip file */ }
    }
    return [...acc.entries()]
      .map(([source, a]) => ({ source, count: a.count, lastTs: a.lastTs, failCount: a.failCount, failRate: a.count ? a.failCount / a.count : 0 }))
      .sort((x, y) => y.count - x.count || y.lastTs - x.lastTs);
  }

  function getById(id: string): AuditRecord | null {    for (const f of listFiles()) {
      try {
        const lines = fs.readFileSync(path.join(logsDir, f), "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as AuditRecord;
            if (rec.id === id) return rec;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
    return null;
  }

  return { append, writeOutput, readOutput, query, summarizeBySource, getById, verify, cleanupRetention, logsDir, retentionDays: RETENTION_DAYS };
}

// ---- ANSI 剥离（轻量，覆盖 SGR/光标/清屏等常见序列） ----
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
function stripAnsi(text: string): string {
  return String(text).replace(ANSI_RE, "");
}
