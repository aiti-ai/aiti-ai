/**
 * aiti-ai-usage · SQLite 库（node:sqlite，Node ≥22）。
 *
 * 分层：
 *   明细   msg_usage（会话口径：session×ts×provider×model 幂等）
 *          user_msgs（用户输入消息明细：引用/长度/kind；PK=(msg_id,ts) 全局去重 fork 副本）
 *          key_req   （代理口径：每次上游尝试一行，含 client 归因）
 *          clients / client_sessions（client token → sessionId 映射）
 *          sessions  （会话状态：running/active/idle/ended/forked/archived）
 *   日汇总 daily_model(天×provider×model) / daily_key(天×provider×key×model)
 *          —— 受影响分区重算（DELETE+INSERT SELECT），月视图查询时上卷
 */
import { DatabaseSync } from "node:sqlite";

export interface UsageDb {
  db: DatabaseSync;
  ensure(): void;
  close(): void;
}

export function openUsageDb(dbPath: string): UsageDb {
  const db = new DatabaseSync(dbPath);
  const api: UsageDb = {
    db,
    ensure() {
      db.exec("PRAGMA journal_mode=WAL;");
      // dev 与 prod 实例共享同一数据根（PI_WEB_DATA_DIR）——跨进程并发写必须容忍锁等待
      db.exec("PRAGMA busy_timeout=5000");
      // wal 收敛上限：checkpoint 后截断 wal，防长跑积压（auto-checkpoint 被推迟时 wal 越滚越大）
      db.exec("PRAGMA journal_size_limit=8388608");
      db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      // 用户输入统计 bootstrap：user_msgs 数据模型版本。版本不一致（新库 / 老库升级 /
      // 引用识别逻辑变更后 bump）→ 写全量重扫标记，由 sync 链（runtime/worker）消费：
      // force 忽略文件水位跑一轮，完成后删标记。
      // 为何必需：files 表水位已覆盖全部会话文件，新表/新口径若只靠增量扫描永远只有新会话数据。
      const USER_MSGS_SCHEMA = "1";
      const userMsgsSchema = (db.prepare("SELECT v FROM meta WHERE k = 'user_msgs_schema'").get() as any)?.v;
      const userMsgsStale = String(userMsgsSchema ?? "") !== USER_MSGS_SCHEMA;
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

        CREATE TABLE IF NOT EXISTS msg_usage (
          session_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          day TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input INTEGER DEFAULT 0,
          output INTEGER DEFAULT 0,
          cache_read INTEGER DEFAULT 0,
          cache_write INTEGER DEFAULT 0,
          reasoning INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          cost_total REAL DEFAULT 0,
          PRIMARY KEY (session_id, ts, provider, model)
        );
        CREATE INDEX IF NOT EXISTS idx_msg_day ON msg_usage(day);
        CREATE INDEX IF NOT EXISTS idx_msg_pm ON msg_usage(provider, model);
        CREATE INDEX IF NOT EXISTS idx_msg_session ON msg_usage(session_id);

        CREATE TABLE IF NOT EXISTS key_req (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          day TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT,
          key_name TEXT DEFAULT '',
          status INTEGER NOT NULL,
          client TEXT,
          input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_keyreq_day ON key_req(day);
        CREATE INDEX IF NOT EXISTS idx_keyreq_pk ON key_req(provider, key_name);
        CREATE INDEX IF NOT EXISTS idx_keyreq_client ON key_req(client);
        -- 跨进程双 tail 竞态去重（dev/prod 共库同 watch 一个日志文件）
        CREATE UNIQUE INDEX IF NOT EXISTS idx_keyreq_dedupe ON key_req(
          ts, provider, IFNULL(model,''), IFNULL(key_name,''), status, IFNULL(client,''));

        CREATE TABLE IF NOT EXISTS clients (
          client TEXT PRIMARY KEY,
          pid INTEGER,
          cwd TEXT,
          first_ts INTEGER
        );
        CREATE TABLE IF NOT EXISTS client_sessions (
          client TEXT NOT NULL,
          session_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          cwd TEXT,
          PRIMARY KEY (client, session_id, ts)
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT,
          title TEXT,
          started_at INTEGER,
          last_ts INTEGER,
          msgs INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          cost_total REAL DEFAULT 0,
          archived INTEGER DEFAULT 0,
          state TEXT DEFAULT 'active',
          end_reason TEXT,
          source_file TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_ts);

        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          mtime_ms INTEGER NOT NULL,
          size INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS daily_model (
          day TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'pi', provider TEXT NOT NULL, model TEXT NOT NULL,
          msgs INTEGER DEFAULT 0,
          input INTEGER DEFAULT 0, output INTEGER DEFAULT 0,
          cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0,
          reasoning INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0, cost_total REAL DEFAULT 0,
          PRIMARY KEY (day, agent, provider, model)
        );
        CREATE INDEX IF NOT EXISTS idx_daily_model_provider ON daily_model(provider);

        CREATE TABLE IF NOT EXISTS daily_key (
          day TEXT NOT NULL, provider TEXT NOT NULL, key_name TEXT NOT NULL, model TEXT NOT NULL,
          reqs INTEGER DEFAULT 0, ok INTEGER DEFAULT 0, err429 INTEGER DEFAULT 0,
          input INTEGER DEFAULT 0, output INTEGER DEFAULT 0,
          cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0,
          PRIMARY KEY (day, provider, key_name, model)
        );

        -- 用户输入消息明细（2026-09 输入统计）：session JSONL 中 role=user 的消息。
        -- PK=(msg_id, ts) —— pi 消息 id + 毫秒时间戳，fork 复制消息时两者均保留 → 天然跨文件去重；
        -- 用于统计「用户写了多少条输入」「其中多少带引用」（引用格式识别见 lib/user-quotes.ts）。
        -- kind: human=人写 · agent=机器注入（subagent/扩展自动会话）· external=导入的外部 agent 会话。
        -- 写入幂等由 UPSERT（冲突时只刷新扫描字段）保证。
        CREATE TABLE IF NOT EXISTS user_msgs (
          msg_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          day TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'human',
          chars INTEGER DEFAULT 0,
          lines INTEGER DEFAULT 0,
          image INTEGER DEFAULT 0,
          quote_lines INTEGER DEFAULT 0,
          quote_head INTEGER DEFAULT 0,
          quote_kinds TEXT DEFAULT '',
          PRIMARY KEY (msg_id, ts)
        );
        CREATE INDEX IF NOT EXISTS idx_user_msgs_day ON user_msgs(day);
        CREATE INDEX IF NOT EXISTS idx_user_msgs_session ON user_msgs(session_id);
        CREATE INDEX IF NOT EXISTS idx_user_msgs_kind ON user_msgs(kind);

        -- 外部 agent 用量（第四路摄入：claude/codebuddy/zcode/qodercn 会话 → 用量行）
        -- 与 msg_usage（pi 自身会话）隔离：agent 列归因，PK 含 agent 不与 pi 冲突；
        -- credits = Qoder 系自有积分单位（非金额，独立维度，不并入 cost）
        CREATE TABLE IF NOT EXISTS ext_usage (
          agent TEXT NOT NULL,
          session_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          day TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input INTEGER DEFAULT 0,
          output INTEGER DEFAULT 0,
          cache_read INTEGER DEFAULT 0,
          cache_write INTEGER DEFAULT 0,
          reasoning INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          cost_total REAL DEFAULT 0,
          credits REAL DEFAULT 0,
          PRIMARY KEY (agent, session_id, ts, provider, model)
        );
        CREATE INDEX IF NOT EXISTS idx_ext_day ON ext_usage(day);
        CREATE INDEX IF NOT EXISTS idx_ext_pm ON ext_usage(provider, model);
        CREATE INDEX IF NOT EXISTS idx_ext_agent ON ext_usage(agent);

        -- 外部会话增量水位：jsonl 源 = mtime_ms+size；sqlite 源 = rev（time_updated ms）
        CREATE TABLE IF NOT EXISTS ext_files (
          path TEXT NOT NULL,
          agent TEXT NOT NULL,
          session_id TEXT NOT NULL,
          mtime_ms INTEGER,
          size INTEGER,
          rev INTEGER,
          PRIMARY KEY (path, agent)
        );

        -- 会话口径统一视图：pi 自身（msg_usage，agent='pi'）∪ 外部 agent（ext_usage）。
        -- 所有会话口径报表查询（overview/matrix/trend/models）改读此视图，agent 维度/过滤统一可用。
        CREATE VIEW IF NOT EXISTS usage_caliber AS
        SELECT 'pi' AS agent, session_id, ts, day, provider, model, input, output,
               cache_read, cache_write, reasoning, total_tokens, cost_total, 0 AS credits
        FROM msg_usage
        UNION ALL
        SELECT agent, session_id, ts, day, provider, model, input, output,
               cache_read, cache_write, reasoning, total_tokens, cost_total, credits
        FROM ext_usage;
      `);

      // daily_model 旧 schema 迁移（2026-09-12 外部 agent 摄入）：缺 agent 列 → 重建含 agent 的新表
      //（PK 改 (day,agent,provider,model)），并写 meta 标记 daily_rebuild=1 → 下次 flushDaily 全量重算。
      // 注意：idx_daily_model_agent 必须在 agent 列存在后才能建（旧表无 agent 列时大块里先建会报 no such column），
      //      故 agent 索引只在此处（迁移后 / 已存在时）补建。

      // 已存在 agent 列（新库或已迁移）：直接补建 agent 索引
      const hasAgent = () => (db.prepare("PRAGMA table_info(daily_model)").all() as Array<{ name: string }>)
        .some((c) => c.name === "agent");
      if (hasAgent()) db.exec("CREATE INDEX IF NOT EXISTS idx_daily_model_agent ON daily_model(agent)");
      else {
        db.exec("DROP TABLE daily_model");
        db.exec(`
            CREATE TABLE daily_model (
              day TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'pi', provider TEXT NOT NULL, model TEXT NOT NULL,
              msgs INTEGER DEFAULT 0,
              input INTEGER DEFAULT 0, output INTEGER DEFAULT 0,
              cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0,
              reasoning INTEGER DEFAULT 0,
              total_tokens INTEGER DEFAULT 0, cost_total REAL DEFAULT 0,
              PRIMARY KEY (day, agent, provider, model)
            );
            CREATE INDEX IF NOT EXISTS idx_daily_model_provider ON daily_model(provider);
            CREATE INDEX IF NOT EXISTS idx_daily_model_agent ON daily_model(agent);
          `);
        db.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('daily_rebuild','1')").run();
      }

      // user_msgs 数据模型版本落后 → 安排一次全量重扫（消费方见 lib/ingest.ts userMsgsRebuildPending）
      if (userMsgsStale) {
        db.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('user_msgs_rebuild','1')").run();
        db.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('user_msgs_schema', ?)").run(USER_MSGS_SCHEMA);
      }
    },
    close() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
  return api;
}

/** 本地时区 YYYY-MM-DD。 */
export function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
