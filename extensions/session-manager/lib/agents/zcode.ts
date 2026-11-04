/**
 * session-manager — ZCode adapter（智谱 ZCode 桌面端会话存储）。
 *
 * 存储：~/.zcode/cli/db/db.sqlite（opencode 风格 schema：session/message/part，
 * data 列 JSON —— ZCode CLI 是 opencode fork，part 形状实测同构：
 *   text / reasoning / step-start / step-finish / timeline / tool{callID,tool,state{input,output}}）。
 *
 * message data 键名（2026-10-30 3.16.3 实测）：新版只写 modelId/providerId（小写 d），
 * 旧版双写 modelID/providerID——读取一律双键兼容；provider 值新增 account: 前缀形态。
 *
 * 直读（2026-09-12）：probe/list/listFresh/parse 全部 readOnly 直开源 db（WAL 并发读
 * 安全，实测 2026-09-10）。曾照 opencode copyDb 模式整库复制到 /tmp 做快照，但 db 随
 * 使用持续增长后单次复制以十秒计（同步 copyFile 阻塞事件循环）、且 syncExt 水位锚在
 * 每轮都变的副本文件上恒判变 → 227 会话 × 269MB ≈ 61GB/轮 拷贝风暴 → pi-web 冻结
 * （2026-09-12 guard 重启风暴事故），已彻底移除复制。直读失败（桌面端持写锁/极端
 * 并发）→ 返回空/false，调用方静默跳过、下轮收敛。
 * 本 adapter 是 zcode 会话的**唯一读取实现**（跨扩展服务出口 services.sessions /
 * aiti-zcode-agent 回放均经此处，勿在他处重写）。
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentAdapter, ExtFreshMeta, ExtSessionRef, ExtSourceProbe } from "./types.ts";
import type { IndexedMessage } from "../session-file.ts";
import { foldOpencodeFamilyParts, foldedPartsToMessages } from "./opencode-family.ts";

const ROOT = () => process.env.AITI_ZCODE_HOME
  ? join(process.env.AITI_ZCODE_HOME, "cli")
  : join(homedir(), ".zcode", "cli");
/** 旧 copyDb 快照目录（2026-09-12 起全面直读、无复制）——首次成功直读后清残留。 */
const LEGACY_COPY_DIR = join("/tmp", "sm-zcode-cache");
let legacyCleaned = false;
function cleanupLegacyCopyDir(): void {
  if (legacyCleaned) return;
  legacyCleaned = true;
  try { rmSync(LEGACY_COPY_DIR, { recursive: true, force: true }); } catch { /* absent */ }
}

/** probe 结果缓存（键 = db mtime）：probe 语义是 stat 级探测，直读 count 是一次性轻查询。
 *  列表端点每次 GET 都会 probe（stale 自动补同步），mtime 不变时必须短路。只缓存成功——
 *  失败（写锁瞬间）不缓存，下轮 probe 立即重试。 */
let probeCache: { mtimeMs: number; result: ExtSourceProbe } | null = null;

/** zcode 内置 provider 表（ref 合法性校验用；与 aiti-devtools 生态 zcode 约定一致）。 */
const PROVIDER_IDS: Record<string, true> = { bigmodel: true, zai: true };

/** zcode-artifact:// 引用 → 磁盘 data URL 文件（attachment-N-<key>.txt，内容为 data: URL）。 */
function readArtifactDataUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith("zcode-artifact://")) return null;
  try {
    const rest = url.slice("zcode-artifact://".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    const sessId = rest.slice(0, slash);
    const key = rest.slice(slash + 1);
    const dir = join(ROOT(), "artifacts", sessId);
    if (!existsSync(dir)) return null;
    for (const f of readdirSync(dir)) {
      // 文件名形态：attachment-<序号>-<key>.txt（key 内含 - 与文件名不冲突：取尾部匹配）
      if (f.endsWith(`-${key}.txt`) || f === `${key}.txt`) {
        const content = readFileSync(join(dir, f), "utf8").trim();
        return content.startsWith("data:") ? content : null;
      }
    }
  } catch { /* 读失败 → null（调用方降级占位） */ }
  return null;
}

export function createZcodeAdapter(srcDbOverride?: string): AgentAdapter {
  // A03 P2：生效源库（fixture 测试可覆盖；生产缺省 = ~/.zcode/cli/db/db.sqlite）
  const SRC_DB = () => srcDbOverride ?? join(ROOT(), "db", "db.sqlite");
  /** readOnly 直开源 db（WAL 并发读安全；busy_timeout 兜桌面端写锁瞬间）。失败 → null。 */
  function openSourceDb(): DatabaseSync | null {
    const src = SRC_DB();
    if (!existsSync(src)) return null;
    try {
      const db = new DatabaseSync(src, { readOnly: true });
      try { db.exec("PRAGMA busy_timeout = 2000"); } catch { /* pragma 不支持时忽略 */ }
      return db;
    } catch {
      return null;
    }
  }
  function dbMtimeMs(): number {
    try {
      const base = SRC_DB();
      let ms = statSync(base).mtimeMs;
      // WAL 模式：写入先进 -wal，主文件 mtime 只在 checkpoint 时才动 —— 只看主文件会让
      // probe 水位长期停滞（实测：运行时跑完一轮，索引 modified 延迟 12h+ 才随 checkpoint 同步）。
      // 取 max(db, -wal)：WAL 写入立即可见，静置后 stale 判定必触发。
      try { ms = Math.max(ms, statSync(base + "-wal").mtimeMs); } catch { /* 无 wal：非 WAL 或已 checkpoint */ }
      return ms;
    } catch { return 0; }
  }
  return {
    id: "zcode",
    label: "ZCode",
    roots() {
      const r = ROOT();
      return existsSync(r) ? [r] : [];
    },

    probe() {
      const dbPath = SRC_DB();
      const mtimeMs = dbMtimeMs();
      if (probeCache && probeCache.mtimeMs === mtimeMs) return probeCache.result;
      const db = openSourceDb();
      if (!db) return { ok: false, count: 0, watermarkMs: mtimeMs }; // 失败不缓存，下轮重试
      let count = 0;
      try {
        const row = db.prepare("SELECT count(*) as c FROM session").get() as { c: number } | undefined;
        count = row?.c ?? 0;
      } finally { db.close(); }
      cleanupLegacyCopyDir();
      probeCache = { mtimeMs, result: { ok: true, count, watermarkMs: mtimeMs } };
      return probeCache.result;
    },

    list(): ExtSessionRef[] {
      // 失败抛错而非返回 []：syncExt 的 scoped GC 以 refs 判活，空 refs 会把本源
      // 全部 ext 行误删（直读暂时失败 ≠ 用户删光了会话）。调用方各自 catch。
      const src = SRC_DB();
      const db = openSourceDb();
      if (!db) throw new Error(`zcode db unreadable: ${src}`);
      try {
        const rows = db.prepare("SELECT id, time_updated FROM session ORDER BY time_updated DESC").all() as
          Array<{ id: string; time_updated?: number | null }>;
        return rows.map((row) => ({
          sid: row.id,
          path: `${src}#session:${row.id}`,
          // rev = time_updated：syncExt 按 per-session 版本水位判变（物理 db 文件恒变，stat 无意义）
          ...(typeof row.time_updated === "number" && row.time_updated > 0 ? { rev: row.time_updated } : {}),
        }));
      } catch (e) {
        throw new Error(`zcode db list failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally { db.close(); }
    },

    /** 轻量列表层（listFresh 契约见 types.ts）：直接只读源 db 查 session 表
     *  （零复制、零 message 读，毫秒级）。桌面端常驻写锁下 WAL 并发只读安全
     *  （实测 2026-09-10）；打开/查询失败返回 [] 降级——静置后全量 sync 兑底。 */
    listFresh(): ExtFreshMeta[] {
      const db = openSourceDb();
      if (!db) return [];
      try {
        const rows = db.prepare("SELECT id, title, time_updated FROM session").all() as
          Array<{ id: string; title?: string | null; time_updated?: number | null }>;
        return rows.map((r) => ({
          sid: r.id,
          timeUpdatedMs: typeof r.time_updated === "number" && r.time_updated > 0 ? r.time_updated : undefined,
          title: r.title || undefined,
        }));
      } catch {
        return [];
      } finally { db.close(); }
    },

    parse(ref) {
      const db = openSourceDb();
      if (!db) return null;
      try {
        const sid = ref.sid;
        // parent_id（subagent_child 父子链，2026-09-13 起 meta.parentSid）：旧版 db 可能
        // 无此列——SELECT 抛错时降级为不带 parent 的查询，会话本体解析不受影响。
        let sessRow: { directory?: string; title?: string; time_created?: number; time_updated?: number; parent_id?: string | null } | undefined;
        try {
          sessRow = db.prepare("SELECT directory, title, time_created, time_updated, parent_id FROM session WHERE id = ?").get(sid) as typeof sessRow;
        } catch {
          sessRow = db.prepare("SELECT directory, title, time_created, time_updated FROM session WHERE id = ?").get(sid) as typeof sessRow;
        }
        if (!sessRow) return null;

        // 一次拉全 part（message_id + sequence 排序），内存按 message 分组
        interface PartRec { message_id: string; sequence: number | null; d: Record<string, unknown> }
        const partRows = db.prepare(
          "SELECT message_id, sequence, data FROM part WHERE session_id = ? ORDER BY message_id, sequence",
        ).all(sid) as Array<{ message_id: string; sequence: number | null; data: string }>;
        const partsByMsg = new Map<string, PartRec[]>();
        for (const r of partRows) {
          let d: Record<string, unknown>;
          try { d = JSON.parse(r.data) as Record<string, unknown>; } catch { continue; }
          const list = partsByMsg.get(r.message_id) ?? [];
          list.push({ message_id: r.message_id, sequence: r.sequence, d });
          partsByMsg.set(r.message_id, list);
        }

        const msgRows = db.prepare(
          "SELECT id, data FROM message WHERE session_id = ? ORDER BY sequence, time_created, id",
        ).all(sid) as Array<{ id: string; data: string }>;

        let seq = 0;
        let firstMessage = "";
        let lastMessage = "";
        const messages: IndexedMessage[] = [];
        for (const row of msgRows) {
          let d: Record<string, unknown>;
          try { d = JSON.parse(row.data) as Record<string, unknown>; } catch { continue; }
          const role = d.role === "assistant" ? "assistant" : "user";
          const modelID = typeof d.modelId === "string" ? d.modelId : typeof d.modelID === "string" ? d.modelID : undefined;
          const providerID = typeof d.providerId === "string" ? d.providerId : typeof d.providerID === "string" ? d.providerID : undefined;
          const time = (d.time ?? {}) as { created?: number };
          const created = typeof time.created === "number" ? time.created : 0;

          // 归纳：opencode-family 共享实现（text 合并/工具行独立/reasoning 跳过）；
          // zcode 特有的 file part（zcode-artifact:// 附件）经 onFilePart 钩子吸收
          const folded = foldOpencodeFamilyParts(
            (partsByMsg.get(row.id) ?? []).map((x) => x.d),
            {
              onFilePart: (p) => {
                const mime = typeof p.mime === "string" ? p.mime : "";
                const filename = typeof p.filename === "string" ? p.filename : undefined;
                if (mime.startsWith("image/")) {
                  const SINGLE_IMAGE_LIMIT = 8 * 1024 * 1024;
                  const dataUrl = readArtifactDataUrl(p.url);
                  if (dataUrl && dataUrl.length <= SINGLE_IMAGE_LIMIT) {
                    return { image: { mime, ...(filename ? { filename } : {}), dataUrl } };
                  }
                  return { placeholder: dataUrl
                    ? `[图片 ${filename ?? ""} 过大（${(dataUrl.length / 1024 / 1024).toFixed(1)}MB），未回放]`
                    : `[图片 ${filename ?? ""} 缺失（artifact 未找到）]` };
                }
                return { placeholder: `📎 ${filename ?? mime ?? "附件"}` };
              },
            },
          );

          const { messages: foldedMsgs, nextSeq } = foldedPartsToMessages(folded, {
            role,
            ts: created ? new Date(created).toISOString() : null,
            model: role === "assistant" ? modelID : undefined,
            provider: role === "assistant" && providerID ? providerID : undefined,
            seqStart: seq,
          });
          seq = nextSeq;
          messages.push(...foldedMsgs);
          for (const fm of foldedMsgs) {
            if (!firstMessage && fm.role === "user") firstMessage = fm.text.slice(0, 500);
            lastMessage = fm.text;
          }
        }
        if (!messages.length) return null;

        // 会话模型：最近一条带 modelID 的 assistant 消息 → "provider/model" ref
        //（providerID 形态多样："bigmodel" / "builtin:bigmodel-coding-plan" / 3.16.3+ "account:bigmodel-start-plan"
        //  → 剥 builtin:/account: 前缀与 -coding-plan/-start-plan 后缀，归一到 bigmodel/zai）
        let modelRef: string | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role !== "assistant" || !m.model) continue;
          const rawProvider = (m.provider ?? "").replace(/^(?:builtin|account):/, "").replace(/-(?:coding|start)-plan$/, "");
          if (rawProvider && rawProvider in PROVIDER_IDS) {
            modelRef = `${rawProvider}/${m.model}`;
            break;
          }
        }

        const createdIso = sessRow.time_created ? new Date(sessRow.time_created).toISOString() : new Date().toISOString();
        const updatedIso = sessRow.time_updated ? new Date(sessRow.time_updated).toISOString() : createdIso;
        const parentSid = typeof sessRow.parent_id === "string" && sessRow.parent_id ? sessRow.parent_id : undefined;
        return {
          meta: {
            path: ref.path,
            id: sid,
            cwd: sessRow.directory ?? "",
            name: sessRow.title || undefined,
            created: createdIso,
            modified: updatedIso,
            messageCount: messages.length,
            firstMessage: firstMessage || "(no messages)",
            lastMessage,
            ...(modelRef ? { model: modelRef } : {}),
            ...(parentSid ? { parentSid } : {}),
          },
          messages,
          files: [],
        };
      } finally { db.close(); }
    },

    // ── A03 P2：rows 粒度真归档原语（session/message/part 三表；列动态发现抗 schema 漂移；
    //  短写事务 + busy_timeout 应对桌面端常驻写锁；WAL 模式写安全）──
    capabilities: { remove: true, putBack: true, granularity: "rows" },
    snapshot(ref) {
      const dbPath = SRC_DB();
      if (!existsSync(dbPath)) return null;
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        let envelope: { v: number; kind: string; db: string; tables: Record<string, { cols: string[]; rows: unknown[][] }> };
        try {
          const tables: Record<string, { cols: string[]; rows: unknown[][] }> = {};
          for (const [table, where, param] of [
            ["session", "id = ?", ref.sid] as const,
            ["message", "session_id = ?", ref.sid] as const,
            ["part", "session_id = ?", ref.sid] as const,
          ]) {
            const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
            const objRows = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(param) as Array<Record<string, unknown>>;
            tables[table] = { cols, rows: objRows.map((r) => cols.map((c) => (r[c] ?? null))) };
          }
          envelope = { v: 1, kind: "zcode-rows", db: dbPath, tables };
        } finally { db.close(); }
        return { bytes: Buffer.from(JSON.stringify(envelope)), layout: dbPath };
      } catch { return null; }
    },
    removeSession(ref) {
      const dbPath = SRC_DB();
      if (!existsSync(dbPath)) return; // 幂等
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA busy_timeout = 3000");
        db.exec("BEGIN IMMEDIATE");
        db.prepare("DELETE FROM part WHERE session_id = ?").run(ref.sid);
        db.prepare("DELETE FROM message WHERE session_id = ?").run(ref.sid);
        db.prepare("DELETE FROM session WHERE id = ?").run(ref.sid);
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* noop */ }
        throw e; // 管线撤包、源行保留
      } finally { db.close(); }
    },
    putBack(_sid, snap) {
      const payload = JSON.parse(snap.bytes.toString("utf8")) as {
        kind?: string; tables?: Record<string, { cols: string[]; rows: unknown[][] }>;
      };
      if (payload?.kind !== "zcode-rows" || !payload.tables) throw new Error("unexpected zcode-rows snapshot payload");
      const db = new DatabaseSync(snap.layout);
      try {
        db.exec("PRAGMA busy_timeout = 3000");
        db.exec("BEGIN IMMEDIATE");
        for (const table of ["session", "message", "part"]) { // 外键序：父表先插
          const t = payload.tables[table];
          if (!t || !t.rows.length) continue;
          const ph = t.cols.map(() => "?").join(",");
          const ins = db.prepare(`INSERT INTO ${table}(${t.cols.join(",")}) VALUES(${ph})`);
          for (const row of t.rows) ins.run(...row);
        }
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* noop */ }
        throw e; // 失败：包保留（数据不丢）
      } finally { db.close(); }
    },
  };
}
