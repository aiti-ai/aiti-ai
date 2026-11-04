/**
 * ext-session-usage —— 外部 agent 会话 → token 用量行 的共享纯函数解析层。
 *
 * 权威源：pi-web-ext/_shared/ext-session-usage.ts（改动后同步到各扩展副本——按
 * cursor-cli-store.ts 先例：_shared 为唯一权威，aiti-ai-usage / session-manager
 * 各留副本或直接引用）。
 *
 * 覆盖源（P0，wire 形状均本机 2026-09 实测钉死，见 docs/aiti-ai-usage-ext-agent-token-ingest-plan.md §2.2）：
 *   - claude   Claude Code      ~/.claude/projects/<cwd>/<sid>.jsonl
 *                               message.usage.{input_tokens, output_tokens,
 *                                 cache_creation_input_tokens, cache_read_input_tokens} + message.model
 *   - qodercn  QoderCN          ~/.qoder-cn/projects/<cwd>/<sid>.jsonl（CC 同构 fork，1.1.44 逐键一致）
 *                               message.model + message.usage.credits（Qoder 自有积分单位、非金额）；
 *                               token 恒 0（Qoder 不落盘计费 token）
 *   - codebuddy CodeBuddy Code  ~/.codebuddy/projects/<cwd>/<sid>.jsonl
 *                               providerData.rawUsage.{prompt_tokens, completion_tokens, total_tokens,
 *                                 cache_read_input_tokens, cache_creation_input_tokens,
 *                                 completion_tokens_details.reasoning_tokens} + providerData.model
 *   - zcode    ZCode            ~/.zcode/cli/db/db.sqlite（readOnly 直读，禁整库复制——2026-09-12 拷贝风暴教训）
 *                               message.data JSON: tokens{total,input,output,reasoning,cache{read,write}}
 *                                 + modelID + providerID + cost
 *
 * P1 model-only 三源（token/成本恒 0——源不落盘计费数据；会话级 model/provider 归因，报表按
 * totalTokens=0 标注「token 无数据」）：
 *   - codex    Codex CLI        ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 的 turn_context/message.model
 *   - opencode OpenCode         ~/.local/share/opencode/storage/message/<sid>/msg_*.json 的 modelID/providerID
 *   - cursor   Cursor CLI       ~/.cursor/ai-tracking/ai-code-tracking.db ai_code_hashes.model（最新一条）
 *
 * 噪音过滤（防零数据源污染报表）：
 *   - Qoder 0.1.24 国际版 usage 恒 0 且无 model/credits → 不产出行（官方不写 token/model）；
 *   - ZCode timeline_event 类消息 tokens 恒 0 且 cost 0 → 不产出行。
 *
 * 格式回归测试：pi-web-ext/_shared/ext-session-usage.test.mjs（fixture 钉死 wire 假设）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------- 类型

/** 统一用量行（agent 维度归因；credits 为 Qoder 系独立积分，非金额）。 */
export interface ExtUsageRow {
  agent: string;
  sid: string;
  ts: number;                  // epoch ms
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  costTotal: number;
  credits: number;
}

/** 会话引用：path 为物理文件或 "db#session:<id>" 虚拟路径；rev = 源侧版本（time_updated ms）。 */
export interface ExtSessionRef {
  agent: string;
  sid: string;
  path: string;
  rev?: number;
}

export interface ExtUsageSource {
  id: string;
  label: string;
  /** roots 任一存在 → 源已安装。 */
  probe(): boolean;
  /** 枚举会话（zcode db 短暂不可读时允许抛错，调用方 catch 静默跳过本轮）。 */
  list(): ExtSessionRef[];
  /** 解析一个会话 → 用量行（空数组 = 无可摄入数据）。 */
  parse(ref: ExtSessionRef): ExtUsageRow[];
}

// ---------------------------------------------------------------- 工具

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const SID_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function listProjectJsonls(root: string): Array<{ sid: string; path: string }> {
  const out: Array<{ sid: string; path: string }> = [];
  if (!existsSync(root)) return out;
  for (const dir of readdirSync(root)) {
    const d = join(root, dir);
    try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(d)) {
      const m = SID_UUID_RE.exec(f);
      if (m) out.push({ sid: m[1], path: join(d, f) });
    }
  }
  return out;
}

/** provider 归一（无显式 providerID 的源按 agent 身份 + 模型名前缀推断）。 */
export function inferProvider(agent: string, model: string): string {
  const m = (model || "").toLowerCase();
  if (m.startsWith("glm")) return "zhipu";
  if (m.startsWith("qmodel")) return "qoder";
  if (m.startsWith("claude")) return "anthropic";
  if (m.includes("/")) return m.split("/")[0]!.trim() || agent; // codex 的 nvidia/xxx
  return agent;
}

// ---------------------------------------------------------------- claude-like 家族（claude / qodercn）

function numUsage(u: Record<string, unknown>): { input: number; output: number; cacheRead: number; cacheWrite: number; credits: number } {
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    credits: num(u.credits),
  };
}

/** CC / QoderCN / Qoder 同构 jsonl → 用量行。
 *  噪音过滤：usage 存在但全部字段 0 且无 model 且无 credits 的行（Qoder 0.1.24 空计费）不产出。 */
export function parseClaudeLikeSession(agent: string, filePath: string, sid: string): ExtUsageRow[] {
  let raw: string;
  try { raw = readFileSync(filePath, "utf8"); } catch { return []; }
  const rows: ExtUsageRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "assistant") continue;
    const m = e.message ?? {};
    const u = m.usage;
    if (!u || typeof u !== "object") continue;
    const { input, output, cacheRead, cacheWrite, credits } = numUsage(u);
    const model = typeof m.model === "string" ? m.model : "";
    if (model === "<synthetic>") continue; // aiti e2e 测试占位模型，非真实使用
    if (!input && !output && !cacheRead && !cacheWrite && !credits && !model) continue; // 空计费噪音
    const ts = Date.parse(String(e.timestamp ?? ""));
    if (!Number.isFinite(ts) || ts <= 0) continue;
    rows.push({
      agent, sid, ts,
      provider: inferProvider(agent, model),
      model: model || "?",
      input, output, cacheRead, cacheWrite,
      reasoning: 0,
      totalTokens: input + output, // CC 的 total 不含 cache；cache 单独列展示
      costTotal: 0,
      credits,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- CodeBuddy Code（腾讯 cbc）

/** cbc jsonl → 用量行（token 在 providerData.rawUsage，OpenAI 兼容字段名）。 */
export function parseCodebuddySession(filePath: string, sid: string): ExtUsageRow[] {
  let raw: string;
  try { raw = readFileSync(filePath, "utf8"); } catch { return []; }
  const rows: ExtUsageRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== "message" || e.role !== "assistant") continue;
    const pd = e.providerData ?? {};
    const ru = pd.rawUsage;
    if (!ru || typeof ru !== "object") continue;
    const input = num(ru.prompt_tokens);
    const output = num(ru.completion_tokens);
    const cacheRead = num(ru.cache_read_input_tokens) || num(ru.prompt_cache_hit_tokens);
    const cacheWrite = num(ru.cache_creation_input_tokens) || num(ru.prompt_cache_write_tokens);
    const reasoning = num(ru.completion_tokens_details?.reasoning_tokens);
    const model = typeof pd.model === "string" && pd.model ? pd.model
      : typeof pd.requestModelId === "string" ? pd.requestModelId : "";
    // cbc timestamp 是数字 epoch 毫秒
    const ts = num(e.timestamp);
    if (!ts) continue;
    rows.push({
      agent: "codebuddy", sid,
      ts,
      provider: inferProvider("codebuddy", model),
      model: model || "?",
      input, output, cacheRead, cacheWrite, reasoning,
      totalTokens: num(ru.total_tokens) || (input + output),
      costTotal: 0, // cbc 的 rawUsage.credit 是账号余额语义，非本轮单价 × token
      credits: 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- ZCode（智谱，SQLite 直读）

function openZcodeDb(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 2000"); } catch { /* pragma 不支持时忽略 */ }
    return db;
  } catch {
    return null;
  }
}

/** zcode message.data JSON → 用量行（禁整库复制，readOnly 直读）。
 *  ⚠ tokens 语义（2026-09 本机实测钉死）：`input`/`cache.read` 是**会话级累积值**
 *  （逐条单调递增，含历史 context），`output` 是单轮值，`reasoning` 单轮。
 *  摄入必须按会话内顺序对 input/cacheRead 做差分（当前 − 上一条 = 本轮增量），
 *  output/reasoning 直取；total = input增 + output（cache 单独列，不并入 total 防双计）。 */
export function parseZcodeSession(dbPath: string, sid: string): ExtUsageRow[] {
  const db = openZcodeDb(dbPath);
  if (!db) return [];
  try {
    const rows: ExtUsageRow[] = [];
    const msgRows = db.prepare(
      "SELECT data FROM message WHERE session_id = ? ORDER BY sequence, time_created, id",
    ).all(sid) as Array<{ data: string | null }>;
    let prevInput = 0, prevCacheRead = 0, prevTotal: number | null = null;
    for (const r of msgRows) {
      if (!r.data) continue;
      let d: Record<string, any>;
      try { d = JSON.parse(r.data); } catch { continue; }
      if (d.role !== "assistant") continue;
      const t = d.tokens;
      if (!t || typeof t !== "object") continue;
      const output = num(t.output), reasoning = num(t.reasoning);
      const cacheRead = num(t.cache?.read), cacheWrite = num(t.cache?.write);
      const cost = num(d.cost);
      const rawInput = num(t.input);
      // 差分：input/cacheRead 为会话累积（窗口重置时当前 < 上一条 → 取当前）
      const input = rawInput >= prevInput ? rawInput - prevInput : rawInput;
      const cacheReadInc = cacheRead >= prevCacheRead ? cacheRead - prevCacheRead : cacheRead;
      if (rawInput > 0) prevInput = rawInput;
      if (cacheRead > 0) prevCacheRead = cacheRead;
      if (!input && !output && !reasoning && !cacheReadInc && !cacheWrite && !cost) continue; // timeline_event 噪音
      // 3.16.3 起新版只写 modelId/providerId（旧版双写 modelID/providerID 两种键）——双键兼容；
      // provider 归一与 session-manager zcode adapter 对齐（builtin:/account: 前缀、-coding-plan/-start-plan 后缀）
      const model = typeof d.modelId === "string" ? d.modelId : typeof d.modelID === "string" ? d.modelID : "";
      const rawProvider = typeof d.providerId === "string" ? d.providerId : typeof d.providerID === "string" ? d.providerID : "";
      const provider = rawProvider.replace(/^(?:builtin|account):/, "").replace(/-(?:coding|start)-plan$/, "") || "zcode";
      const created = num(d.time?.created);
      if (!created) continue;
      rows.push({
        agent: "zcode", sid,
        ts: created,
        provider,
        model: model || "?",
        input, output, cacheRead: cacheReadInc, cacheWrite, reasoning,
        totalTokens: num(t.total) > 0
          // 官方 total 也是累积：差分 same 方式（无上一条 total 时取 total 本身）
          ? (prevTotal !== null && num(t.total) >= prevTotal ? num(t.total) - prevTotal : num(t.total))
          : (input + output + reasoning + cacheReadInc + cacheWrite),
        costTotal: cost,
        credits: 0,
      });
      if (num(t.total) > 0) prevTotal = num(t.total);
    }
    return rows;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- 源工厂

/** 枚举 ~/.claude 或 ~/.qoder-cn 的 projects（claude-like 结构）。 */
function listClaudeLikeProjects(projectsRoot: string, agent: string): ExtSessionRef[] {
  return listProjectJsonls(projectsRoot).map(({ sid, path }) => ({ agent, sid, path }));
}

/** 枚举 ~/.codebuddy/projects。 */
function listCodebuddyProjects(projectsRoot: string): ExtSessionRef[] {
  return listProjectJsonls(projectsRoot).map(({ sid, path }) => ({ agent: "codebuddy", sid, path }));
}

// ---------------------------------------------------------------- P1 model-only 家族（codex / opencode / cursor）

/** model-only 行骨架：token/成本全 0（源不落盘计费数据）——会话级 model/provider 归因用；
 *  报表层按 totalTokens=0 标注「token 无数据」，不进 token 汇总口径。 */
function modelOnlyRow(agent: string, sid: string, ts: number, model: string, provider?: string): ExtUsageRow {
  return {
    agent, sid, ts,
    provider: provider || inferProvider(agent, model),
    model,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    totalTokens: 0, costTotal: 0, credits: 0,
  };
}

/** Codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl —— turn_context/message 行的 model 字段（首个即启动模型）。 */
export function parseCodexModelOnly(filePath: string, sid: string): ExtUsageRow[] {
  let model = "";
  let ts = 0;
  try {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      if (!line.includes('"model"')) continue;
      try {
        const d = JSON.parse(line) as { payload?: { model?: unknown }; model?: unknown; timestamp?: unknown };
        const m = d.payload?.model ?? d.model;
        if (typeof m === "string" && m) {
          model = m;
          if (typeof d.timestamp === "string") ts = Date.parse(d.timestamp) || ts;
          break;
        }
      } catch { /* 跳坏行 */ }
    }
    if (!ts) ts = statSync(filePath).mtimeMs;
  } catch { return []; }
  if (!model) return [];
  return [modelOnlyRow("codex", sid, ts, model)];
}

function listCodexSessions(root: string): ExtSessionRef[] {
  const out: ExtSessionRef[] = [];
  if (!existsSync(root)) return out;
  const uuidRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try { if (statSync(p).isDirectory()) { walk(p, depth + 1); continue; } } catch { continue; }
      const m = uuidRe.exec(name);
      if (!m) continue;
      try { out.push({ agent: "codex", sid: m[1], path: p, rev: statSync(p).mtimeMs }); } catch { continue; }
    }
  };
  walk(root, 0);
  return out;
}

/** OpenCode：storage/session/<proj>/ses_*.json（元数据）+ storage/message/<proj>/msg_*.json（modelID/providerID）。 */
export function parseOpencodeModelOnly(root: string, sessionJsonPath: string, sid: string): ExtUsageRow[] {
  try {
    const sess = JSON.parse(readFileSync(sessionJsonPath, "utf8")) as {
      projectID?: unknown; time?: { updated?: unknown; created?: unknown };
    };
    void sess;
    const msgDir = join(root, "storage", "message", sid); // 实测：message 按会话分目录（storage/message/<sid>/msg_*.json）
    if (!existsSync(msgDir)) return [];
    let best: { ts: number; modelID: string; providerID: string } | null = null;
    for (const name of readdirSync(msgDir)) {
      if (!name.endsWith(".json")) continue;
      const p = join(msgDir, name);
      let m: any;
      try { m = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
      if (m?.sessionID !== sid || m?.role !== "assistant" || typeof m?.modelID !== "string" || !m.modelID) continue;
      const ts = Number(m?.time?.created) || 0;
      if (!best || ts >= best.ts) best = { ts, modelID: m.modelID, providerID: typeof m.providerID === "string" ? m.providerID : "" };
    }
    if (!best) return [];
    const ts = best.ts || Number(sess.time?.updated) || Number(sess.time?.created) || 0;
    return [modelOnlyRow("opencode", sid, ts, best.modelID, best.providerID || undefined)];
  } catch { return []; }
}

function listOpencodeSessions(root: string): ExtSessionRef[] {
  const sessDir = join(root, "storage", "session");
  const out: ExtSessionRef[] = [];
  if (!existsSync(sessDir)) return out;
  for (const proj of readdirSync(sessDir)) {
    const dir = join(sessDir, proj);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("ses_") || !name.endsWith(".json")) continue;
      const p = join(dir, name);
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as { id?: unknown; time?: { updated?: unknown } };
        if (typeof j.id !== "string") continue;
        out.push({ agent: "opencode", sid: j.id, path: p, ...(typeof j.time?.updated === "number" ? { rev: j.time.updated } : {}) });
      } catch { continue; }
    }
  }
  return out;
}

/** Cursor CLI：~/.cursor/ai-tracking/ai-code-tracking.db（readOnly 直读）——ai_code_hashes.model 按会话最新一条。 */
function openCursorDb(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 2000"); } catch { /* ignore */ }
    return db;
  } catch { return null; }
}
export function parseCursorModelOnly(dbPath: string, sid: string): ExtUsageRow[] {
  const db = openCursorDb(dbPath);
  if (!db) return [];
  try {
    const r = db.prepare(
      "SELECT model, timestamp FROM ai_code_hashes WHERE conversationId=? AND model IS NOT NULL ORDER BY timestamp DESC LIMIT 1").get(sid) as any;
    if (!r?.model) return [];
    const ts = Number(r.timestamp) || 0;
    return [modelOnlyRow("cursor", sid, ts > 1e12 ? ts : ts * 1000, String(r.model))];
  } finally { db.close(); }
}
function listCursorSessions(dbPath: string): ExtSessionRef[] {
  const db = openCursorDb(dbPath);
  if (!db) return [];
  try {
    const rows = db.prepare(
      "SELECT conversationId, MAX(timestamp) ts FROM ai_code_hashes WHERE conversationId IS NOT NULL GROUP BY conversationId").all() as any[];
    return rows.map((r) => {
      const ts = Number(r.ts) || 0;
      return { agent: "cursor", sid: String(r.conversationId), path: `${dbPath}#conversation:${r.conversationId}`, ...(ts > 0 ? { rev: ts > 1e12 ? ts : ts * 1000 } : {}) };
    });
  } finally { db.close(); }
}

export interface ExtUsageSourceEnv {
  /** 测试隔离口：覆盖各源默认根目录（对齐 AITI_ZCODE_HOME 先例）。 */
  claudeHome?: string;          // 默认 ~/.claude
  qodercnHome?: string;         // 默认 ~/.qoder-cn
  codebuddyHome?: string;       // 默认 ~/.codebuddy
  zcodeHome?: string;           // 默认 ~/.zcode
  codexHome?: string;           // 默认 ~/.codex（A11 P1 model-only）
  opencodeHome?: string;        // 默认 ~/.local/share/opencode
  cursorHome?: string;          // 默认 ~/.cursor
}

export function builtinExtUsageSources(env: ExtUsageSourceEnv = {}): ExtUsageSource[] {
  const home = homedir();
  const claudeRoot = () => env.claudeHome || join(home, ".claude", "projects");
  const qodercnRoot = () => env.qodercnHome || join(home, ".qoder-cn", "projects");
  const codebuddyRoot = () => env.codebuddyHome || join(home, ".codebuddy", "projects");
  const zcodeDbPath = () => env.zcodeHome ? join(env.zcodeHome, "cli", "db", "db.sqlite") : join(home, ".zcode", "cli", "db", "db.sqlite");
  const codexRoot = () => (env.codexHome || join(home, ".codex")) + "/sessions";
  const opencodeRoot = () => env.opencodeHome || join(home, ".local", "share", "opencode");
  const cursorDbPath = () => env.cursorHome ? join(env.cursorHome, "ai-tracking", "ai-code-tracking.db") : join(home, ".cursor", "ai-tracking", "ai-code-tracking.db");

  return [
    {
      id: "claude",
      label: "Claude Code",
      probe: () => existsSync(claudeRoot()),
      list: () => listClaudeLikeProjects(claudeRoot(), "claude"),
      parse: (ref) => parseClaudeLikeSession("claude", ref.path, ref.sid),
    },
    {
      id: "qodercn",
      label: "QoderCN",
      probe: () => existsSync(qodercnRoot()),
      list: () => listClaudeLikeProjects(qodercnRoot(), "qodercn"),
      parse: (ref) => parseClaudeLikeSession("qodercn", ref.path, ref.sid),
    },
    {
      id: "codebuddy",
      label: "CodeBuddy Code",
      probe: () => existsSync(codebuddyRoot()),
      list: () => listCodebuddyProjects(codebuddyRoot()),
      parse: (ref) => parseCodebuddySession(ref.path, ref.sid),
    },
    {
      id: "zcode",
      label: "ZCode",
      probe: () => existsSync(zcodeDbPath()),
      list: () => {
        const db = openZcodeDb(zcodeDbPath());
        if (!db) throw new Error(`zcode db unreadable: ${zcodeDbPath()}`);
        try {
          const rows = db.prepare("SELECT id, time_updated FROM session ORDER BY time_updated DESC").all() as
            Array<{ id: string; time_updated?: number | null }>;
          return rows.map((r) => ({
            agent: "zcode",
            sid: r.id,
            path: `${zcodeDbPath()}#session:${r.id}`,
            ...(typeof r.time_updated === "number" && r.time_updated > 0 ? { rev: r.time_updated } : {}),
          }));
        } finally {
          db.close();
        }
      },
      parse: (ref) => {
        const [dbPath] = ref.path.split("#");
        return parseZcodeSession(dbPath || zcodeDbPath(), ref.sid);
      },
    },
    // ── P1 model-only 三源（token 恒 0：源不落盘计费数据；会话级 model/provider 归因）──
    {
      id: "codex",
      label: "Codex CLI（model-only）",
      probe: () => existsSync(codexRoot()),
      list: () => listCodexSessions(codexRoot()),
      parse: (ref) => parseCodexModelOnly(ref.path, ref.sid),
    },
    {
      id: "opencode",
      label: "OpenCode（model-only）",
      probe: () => existsSync(opencodeRoot()),
      list: () => listOpencodeSessions(opencodeRoot()),
      parse: (ref) => parseOpencodeModelOnly(opencodeRoot(), ref.path, ref.sid),
    },
    {
      id: "cursor",
      label: "Cursor CLI（model-only）",
      probe: () => existsSync(cursorDbPath()),
      list: () => listCursorSessions(cursorDbPath()),
      parse: (ref) => {
        const [dbPath] = ref.path.split("#");
        return parseCursorModelOnly(dbPath || cursorDbPath(), ref.sid);
      },
    },
  ];
}