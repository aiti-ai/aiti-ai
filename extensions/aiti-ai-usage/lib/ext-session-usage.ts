/**
 * ext-session-usage — shared pure-function parsing layer: external agent sessions → token usage rows.
 *
 * Authoritative source: pi-web-ext/_shared/ext-session-usage.ts (after changes, sync to the per-extension
 * copies — following the cursor-cli-store.ts precedent: _shared is the sole authority; aiti-ai-usage /
 * session-manager keep copies or reference it directly).
 *
 * Covered sources (P0; wire shapes all pinned by local measurement 2026-09, see
 * docs/aiti-ai-usage-ext-agent-token-ingest-plan.md §2.2):
 *   - claude   Claude Code      ~/.claude/projects/<cwd>/<sid>.jsonl
 *                               message.usage.{input_tokens, output_tokens,
 *                                 cache_creation_input_tokens, cache_read_input_tokens} + message.model
 *   - qodercn  QoderCN          ~/.qoder-cn/projects/<cwd>/<sid>.jsonl (CC-isomorphic fork, key-identical at 1.1.44)
 *                               message.model + message.usage.credits (Qoder's own credit unit, not money);
 *                               tokens always 0 (Qoder does not persist billing tokens)
 *   - codebuddy CodeBuddy Code  ~/.codebuddy/projects/<cwd>/<sid>.jsonl
 *                               providerData.rawUsage.{prompt_tokens, completion_tokens, total_tokens,
 *                                 cache_read_input_tokens, cache_creation_input_tokens,
 *                                 completion_tokens_details.reasoning_tokens} + providerData.model
 *   - zcode    ZCode            ~/.zcode/cli/db/db.sqlite (readOnly direct read; never copy the whole db — lesson of the 2026-09-12 copy storm)
 *                               message.data JSON: tokens{total,input,output,reasoning,cache{read,write}}
 *                                 + modelID + providerID + cost
 *
 * P1 model-only three sources (tokens/cost always 0 — the source persists no billing data; session-level
 * model/provider attribution; reports mark "no token data" on totalTokens=0):
 *   - codex    Codex CLI        turn_context/message.model of ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   - opencode OpenCode         modelID/providerID of ~/.local/share/opencode/storage/message/<sid>/msg_*.json
 *   - cursor   Cursor CLI       ~/.cursor/ai-tracking/ai-code-tracking.db ai_code_hashes.model (newest row)
 *
 * Noise filtering (keeps zero-data sources from polluting reports):
 *   - Qoder 0.1.24 international edition: usage always 0 with no model/credits → no row produced (officially writes no token/model);
 *   - ZCode timeline_event-class messages: tokens always 0 and cost 0 → no row produced.
 *
 * Format regression test: pi-web-ext/_shared/ext-session-usage.test.mjs (fixtures pin the wire assumptions).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------- Types

/** Unified usage row (agent-dimension attribution; credits is the Qoder family's independent credit unit, not money). */
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

/** Session reference: path is a physical file or the virtual "db#session:<id>" path; rev = source-side version (time_updated ms). */
export interface ExtSessionRef {
  agent: string;
  sid: string;
  path: string;
  rev?: number;
}

export interface ExtUsageSource {
  id: string;
  label: string;
  /** any root existing → source installed. */
  probe(): boolean;
  /** enumerates sessions (may throw while the zcode db is briefly unreadable; the caller catches and silently skips the round). */
  list(): ExtSessionRef[];
  /** parses one session → usage rows (empty array = nothing ingestible). */
  parse(ref: ExtSessionRef): ExtUsageRow[];
}

// ---------------------------------------------------------------- Utilities

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

/** provider normalization (sources without an explicit providerID are inferred from agent identity + model-name prefix). */
export function inferProvider(agent: string, model: string): string {
  const m = (model || "").toLowerCase();
  if (m.startsWith("glm")) return "zhipu";
  if (m.startsWith("qmodel")) return "qoder";
  if (m.startsWith("claude")) return "anthropic";
  if (m.includes("/")) return m.split("/")[0]!.trim() || agent; // codex's nvidia/xxx
  return agent;
}

// ---------------------------------------------------------------- claude-like family (claude / qodercn)

function numUsage(u: Record<string, unknown>): { input: number; output: number; cacheRead: number; cacheWrite: number; credits: number } {
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    credits: num(u.credits),
  };
}

/** CC / QoderCN / Qoder isomorphic jsonl → usage rows.
 *  Noise filter: rows whose usage exists but is all-zero with no model and no credits (Qoder 0.1.24 empty billing) produce nothing. */
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
    if (model === "<synthetic>") continue; // aiti e2e test placeholder model, not real usage
    if (!input && !output && !cacheRead && !cacheWrite && !credits && !model) continue; // empty-billing noise
    const ts = Date.parse(String(e.timestamp ?? ""));
    if (!Number.isFinite(ts) || ts <= 0) continue;
    rows.push({
      agent, sid, ts,
      provider: inferProvider(agent, model),
      model: model || "?",
      input, output, cacheRead, cacheWrite,
      reasoning: 0,
      totalTokens: input + output, // CC's total excludes cache; cache shown as its own column
      costTotal: 0,
      credits,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- CodeBuddy Code (Tencent cbc)

/** cbc jsonl → usage rows (tokens live in providerData.rawUsage, OpenAI-compatible field names). */
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
    // cbc timestamp is a numeric epoch in milliseconds
    const ts = num(e.timestamp);
    if (!ts) continue;
    rows.push({
      agent: "codebuddy", sid,
      ts,
      provider: inferProvider("codebuddy", model),
      model: model || "?",
      input, output, cacheRead, cacheWrite, reasoning,
      totalTokens: num(ru.total_tokens) || (input + output),
      costTotal: 0, // cbc's rawUsage.credit is account-balance semantics, not this turn's unit price × tokens
      credits: 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- ZCode (Zhipu, SQLite direct read)

function openZcodeDb(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 2000"); } catch { /* ignored when pragma unsupported */ }
    return db;
  } catch {
    return null;
  }
}

/** zcode message.data JSON → usage rows (whole-db copy forbidden; readOnly direct read).
 *  ⚠ token semantics (pinned by local measurement 2026-09): `input`/`cache.read` are **session-level cumulative values**
 *  (monotonically increasing per row, including historical context), `output` is per-turn, `reasoning` per-turn.
 *  Ingestion must diff input/cacheRead in in-session order (current − previous = this turn's increment);
 *  output/reasoning are taken as-is; total = input increment + output (cache stays in its own column, kept out of total to avoid double counting). */
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
      // diff: input/cacheRead are session-cumulative (on window reset current < previous → take current)
      const input = rawInput >= prevInput ? rawInput - prevInput : rawInput;
      const cacheReadInc = cacheRead >= prevCacheRead ? cacheRead - prevCacheRead : cacheRead;
      if (rawInput > 0) prevInput = rawInput;
      if (cacheRead > 0) prevCacheRead = cacheRead;
      if (!input && !output && !reasoning && !cacheReadInc && !cacheWrite && !cost) continue; // timeline_event noise
      // from 3.16.3 the new build writes only modelId/providerId (older builds wrote both modelID/providerID keys) — both keys supported;
      // provider normalization aligns with the session-manager zcode adapter (builtin:/account: prefixes, -coding-plan/-start-plan suffixes)
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
          // the official total is cumulative too: diffed the same way (when no previous total exists, take the total itself)
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

// ---------------------------------------------------------------- Source factory

/** Enumerates ~/.claude or ~/.qoder-cn projects (claude-like structure). */
function listClaudeLikeProjects(projectsRoot: string, agent: string): ExtSessionRef[] {
  return listProjectJsonls(projectsRoot).map(({ sid, path }) => ({ agent, sid, path }));
}

/** Enumerates ~/.codebuddy/projects. */
function listCodebuddyProjects(projectsRoot: string): ExtSessionRef[] {
  return listProjectJsonls(projectsRoot).map(({ sid, path }) => ({ agent: "codebuddy", sid, path }));
}

// ---------------------------------------------------------------- P1 model-only family (codex / opencode / cursor)

/** model-only row skeleton: tokens/cost all 0 (the source persists no billing data) — for session-level model/provider attribution;
 *  the report layer marks "no token data" on totalTokens=0 and keeps it out of token totals. */
function modelOnlyRow(agent: string, sid: string, ts: number, model: string, provider?: string): ExtUsageRow {
  return {
    agent, sid, ts,
    provider: provider || inferProvider(agent, model),
    model,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    totalTokens: 0, costTotal: 0, credits: 0,
  };
}

/** Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — the model field of turn_context/message rows (the first is the launch model). */
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
      } catch { /* skip bad line */ }
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

/** OpenCode: storage/session/<proj>/ses_*.json (metadata) + storage/message/<proj>/msg_*.json (modelID/providerID). */
export function parseOpencodeModelOnly(root: string, sessionJsonPath: string, sid: string): ExtUsageRow[] {
  try {
    const sess = JSON.parse(readFileSync(sessionJsonPath, "utf8")) as {
      projectID?: unknown; time?: { updated?: unknown; created?: unknown };
    };
    void sess;
    const msgDir = join(root, "storage", "message", sid); // measured: message directories are per session (storage/message/<sid>/msg_*.json)
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

/** Cursor CLI: ~/.cursor/ai-tracking/ai-code-tracking.db (readOnly direct read) — ai_code_hashes.model, newest row per session. */
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
  /** Test isolation hook: overrides each source's default root (aligned with the AITI_ZCODE_HOME precedent). */
  claudeHome?: string;          // default ~/.claude
  qodercnHome?: string;         // default ~/.qoder-cn
  codebuddyHome?: string;       // default ~/.codebuddy
  zcodeHome?: string;           // default ~/.zcode
  codexHome?: string;           // default ~/.codex (A11 P1 model-only)
  opencodeHome?: string;        // default ~/.local/share/opencode
  cursorHome?: string;          // default ~/.cursor
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
    // ── P1 model-only three sources (tokens always 0: the source persists no billing data; session-level model/provider attribution) ──
    {
      id: "codex",
      label: "Codex CLI (model-only)",
      probe: () => existsSync(codexRoot()),
      list: () => listCodexSessions(codexRoot()),
      parse: (ref) => parseCodexModelOnly(ref.path, ref.sid),
    },
    {
      id: "opencode",
      label: "OpenCode (model-only)",
      probe: () => existsSync(opencodeRoot()),
      list: () => listOpencodeSessions(opencodeRoot()),
      parse: (ref) => parseOpencodeModelOnly(opencodeRoot(), ref.path, ref.sid),
    },
    {
      id: "cursor",
      label: "Cursor CLI (model-only)",
      probe: () => existsSync(cursorDbPath()),
      list: () => listCursorSessions(cursorDbPath()),
      parse: (ref) => {
        const [dbPath] = ref.path.split("#");
        return parseCursorModelOnly(dbPath || cursorDbPath(), ref.sid);
      },
    },
  ];
}