/**
 * pi-session-search — enrich source: read-only augmentation of search/read hits
 * with session-manager tags and aiti-plan-first plan bindings.
 * (docs/pi-session-search-enrich-tags-plan.md §4.3, 1:1 output contract with the
 * pi-web session-manager agentTools side.)
 *
 * Data (all read-only, never written):
 *   <dataDir>/session-manager/config/session-tags.json  — tag tree + per-session leaf ids
 *   <dataDir>/aiti-plan-first/config/plans.json         — sessionId → plan md absolute path
 *   <plan md> front-matter (first 4KB)                  — fm tags incl. plan/* status tag
 *
 * dataDir candidates mirror db-source (same dev/prod split); when an index db is
 * open, the dir it lives in takes precedence so enrich stays in sync with the index.
 * Everything degrades silently: missing/corrupt file → no line, never an error.
 *
 * Same-plugin duplication note: parseFmTags/statusPhaseOf are small copies of
 * aiti-plan-first plan-core.ts (this plugin is a standalone pi package and cannot
 * import pi-web extension modules — same self-containment rule as db-source).
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Ordered dataDir candidates (same split as db-source; env override first). */
export function dataDirCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.PI_WEB_DATA_DIR && env.PI_WEB_DATA_DIR.trim()) out.push(env.PI_WEB_DATA_DIR.trim());
  out.push(join(homedir(), ".pi", "web", "data"));
  out.push(join(homedir(), ".pi", "web-dev", "data"));
  return out;
}

/** Resolve the dataDir to enrich from. An open index db's dir wins (index and
 *  enrich must describe the same install); otherwise the first candidate that has
 *  any of the enrich files. null = nothing on disk → callers skip enriching. */
export function resolveDataDir(dbPath?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const marks = [
    join("session-manager", "config", "session-tags.json"),
    join("aiti-plan-first", "config", "plans.json"),
    join("session-manager", "config", "config.json"),
  ];
  const hasMark = (dir: string) => marks.some((m) => existsSync(join(dir, m)));
  if (dbPath) {
    // <dataDir>/session-manager/cache/index.sqlite → dataDir is three levels up
    const dir = dirname(dirname(dirname(dbPath)));
    if (hasMark(dir)) return dir;
  }
  for (const dir of dataDirCandidates(env)) if (hasMark(dir)) return dir;
  return null;
}

// ---------- plan md front-matter (small copy of aiti-plan-first plan-core.ts parseFmTags) ----------

export function parseFmTags(text: string): string[] {
  const lines = String(text || "").split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return [];
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") { end = i; break; }
  }
  if (end < 0) return [];
  const tags: string[] = [];
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(lines[i]);
    if (!m || m[1].toLowerCase() !== "tags") continue;
    const val = m[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      for (const part of val.slice(1, -1).split(",")) {
        const v = part.trim().replace(/^["']|["']$/g, "");
        if (v) tags.push(v);
      }
    } else if (val === "") {
      for (let j = i + 1; j < end; j++) {
        const bm = /^\s+-\s+(.*)$/.exec(lines[j]);
        if (!bm) break;
        const v = bm[1].trim().replace(/^["']|["']$/g, "");
        if (v) tags.push(v);
      }
    } else if (val) tags.push(val);
  }
  return tags;
}

/** Status tag = first `plan/*`-style (Chinese 方案/*) item (same semantics as aiti-plan-first statusPhaseOf). */  // cjk-ok
export function statusPhaseOf(fmTags: string[]): string | null {
  return fmTags.find((t) => t.startsWith("方案/")) ?? null;
}

const fmCache = new Map<string, { mtimeMs: number; fmTags: string[]; statusPhase: string | null }>();

/** Read the first 4KB of a plan md and parse its front-matter tags (mtime-cached;
 *  truncated/unopened/broken → empty, never throws). fm must live at the file head. */
export function readMdFmTags(abs: string): { fmTags: string[]; statusPhase: string | null } {
  try {
    const st = statSync(abs);
    const cached = fmCache.get(abs);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached;
    const fd = openSync(abs, "r");
    let head = "";
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, 4096, 0);
      head = buf.toString("utf8", 0, n);
    } finally { closeSync(fd); }
    const fmTags = parseFmTags(head);
    const entry = { mtimeMs: st.mtimeMs, fmTags, statusPhase: statusPhaseOf(fmTags) };
    fmCache.set(abs, entry);
    return { fmTags: entry.fmTags, statusPhase: entry.statusPhase };
  } catch { return { fmTags: [], statusPhase: null }; }
}

// ---------- loaders ----------

interface TagNode { id: string; name: string; parentId: string | null }
interface TagData { version: number; tags: TagNode[]; sessionTags: Record<string, string[]> }

/** sessionId → "tags: a/b, c" display lines (missing/corrupt file → empty map). */
export function loadTagPaths(dataDir: string, sids: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (!sids.size) return out;
  let data: TagData;
  try { data = JSON.parse(readFileSync(join(dataDir, "session-manager", "config", "session-tags.json"), "utf8")) as TagData; } catch { return out; }
  if (!data || !Array.isArray(data.tags) || !data.sessionTags) return out;
  const byId = new Map<string, TagNode>(data.tags.filter((t) => t && typeof t.id === "string").map((t) => [t.id, t]));
  // leaf id → tree path "项目A/todo" (walk parents; same shape as session-manager tagPath)  // cjk-ok
  const pathOf = (id: string): string => {
    const segs: string[] = [];
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      segs.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return segs.join("/");
  };
  for (const sid of sids) {
    const ids = data.sessionTags[sid];
    if (!Array.isArray(ids) || !ids.length) continue;
    const paths = ids.map(pathOf).filter(Boolean);
    if (paths.length) out.set(sid, `tags: ${paths.join(", ")}`);
  }
  return out;
}

export interface PlanRow { path: string; fmTags: string[]; statusPhase: string | null }

/** sessionId → bound plan md + its fm tags (missing/corrupt file → empty map). */
export function loadPlanRows(dataDir: string, sids: Set<string>): Map<string, PlanRow> {
  const out = new Map<string, PlanRow>();
  if (!sids.size) return out;
  let sessions: Record<string, { plan?: unknown }>;
  try {
    const j = JSON.parse(readFileSync(join(dataDir, "aiti-plan-first", "config", "plans.json"), "utf8")) as { sessions?: Record<string, { plan?: unknown }> };
    sessions = j?.sessions ?? {};
  } catch { return out; }
  for (const sid of sids) {
    const st = sessions[sid];
    const plan = st && typeof st.plan === "string" ? st.plan : "";
    if (!plan) continue;
    const { fmTags, statusPhase } = readMdFmTags(plan);
    out.set(sid, { path: plan, fmTags, statusPhase });
  }
  return out;
}

/** Combined lines per session: Map<sid, "tags: …\nplan: …">. Both sources best-effort. */
export function enrichLines(sids: string[], dataDir: string | null): Map<string, string> {
  const out = new Map<string, string>();
  const uniq = new Set(sids.filter(Boolean));
  if (!dataDir || !uniq.size) return out;
  const tags = loadTagPaths(dataDir, uniq);
  const plans = loadPlanRows(dataDir, uniq);
  for (const sid of uniq) {
    const parts: string[] = [];
    const t = tags.get(sid);
    if (t) parts.push(t);
    const p = plans.get(sid);
    if (p) {
      // status tag (方案/*) stays out of the [..] list — it goes into the （状态: …） suffix (contract §3)  // cjk-ok
      const fmTags = (p.fmTags ?? []).filter((t) => !t.startsWith("方案/"));
      const fm = fmTags.length ? ` [${fmTags.join(", ")}]` : "";
      const st = p.statusPhase ? `（状态: ${p.statusPhase}）` : "";
      parts.push(`plan: ${p.path}${fm}${st}`);
    }
    if (parts.length) out.set(sid, parts.join("\n"));
  }
  return out;
}

// ---------- A/B co-install kill-switch (git-trace precedent) ----------

/** true = this process is the pi-web host (sessions run in-process next to the
 *  session-manager extension, so A-side agentTools may be injected). Standalone TUI
 *  or bridge-agent processes have no pi-web env → A-side can never be present →
 *  never blocked (B registers normally). The pi-web systemd units set PI_WEB_DATA_DIR
 *  explicitly (dev/prod); other PI_WEB_* envs serve as fallback signals. */
export function inPiWebHostProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.PI_WEB_DATA_DIR || env.PI_WEB_BASE_PATH || env.PI_WEB_DEV_DIST || env.PI_WEB_BUILD_BASEPATH);
}

/** true = A-side session_search is present: this is a pi-web host process AND
 *  <PI_WEB_DATA_DIR>/session-manager/config/config.json has agentTools.enabled !== false.
 *  Missing file/key, broken json, or non-pi-web process = register normally
 *  (same default-on semantics as the git-trace kill-switch precedent). */
export function killswitchBlocksRegistration(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!inPiWebHostProcess(env)) return false;
  const dataDir = env.PI_WEB_DATA_DIR && env.PI_WEB_DATA_DIR.trim() ? env.PI_WEB_DATA_DIR.trim() : "";
  if (!dataDir) return false;
  try {
    const p = join(dataDir, "session-manager", "config", "config.json");
    if (!existsSync(p)) return false;
    const cfg = JSON.parse(readFileSync(p, "utf8")) as { agentTools?: { enabled?: boolean } };
    return !!(cfg?.agentTools && cfg.agentTools.enabled !== false);
  } catch { return false; }
}
