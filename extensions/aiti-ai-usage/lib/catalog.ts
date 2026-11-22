/**
 * catalog.ts — tool/skill catalog billing data layer (borrow plan §2.7B/C)
 *
 * Catalog billing = fixed injection-cost inventory: MCP servers × tools × schema tokens (bytes/4
 * caliber, same as pi's estimateTokens in lib/subagent-input.ts) + skills (the formatSkillsForPrompt
 * surface) side-by-side with 30-day call counts — cost × usage exposes the waste at a glance.
 *
 * Pure functions (buildCatalog/estimateTokens) are directly testable; collectCatalog assembles on the
 * server (bounded mcp-cache.json read ≤8MB, mcp.json enabled states, same-origin /api/skills surface).
 */
import fs from "node:fs";
import path from "node:path";

/** pi's own estimate caliber (estimateTokens in its compaction module): ~4 chars/token. */
export function estimateTokens(s: string): number {
  return Math.ceil((s || "").length / 4);
}

/** Estimated tokens for a tool's schema + description (§2.7 caliber: inputSchema JSON bytes + description) */
export function toolEstTokens(tool: { name?: string; description?: string; inputSchema?: unknown }): number {
  let chars = 0;
  try { chars += JSON.stringify(tool.inputSchema ?? {}).length; } catch { chars += 2; }
  chars += (tool.description || "").length;
  chars += (tool.name || "").length;
  return estimateTokens(chars === 0 ? "" : "x".repeat(chars));
}

export interface CatalogTool { name: string; estTokens: number; calls30d: number; excluded?: boolean; phantom?: boolean }
export interface CatalogMcpServer {
  name: string;
  enabled: boolean;
  toolCount: number;
  estTokens: number;
  calls30d: number;
  cachedAt: string | null;
  /** mcp.json excludeTools patterns (adapter honors globs at tool-registration time) */
  excludedPatterns: string[];
  tools: CatalogTool[];
}

/** Glob → RegExp (`*` wildcard, everything else literal); used for excludeTools display matching. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
  return new RegExp("^" + escaped + "$", "i");
}

export function toolMatchesPatterns(toolName: string, patterns: string[]): boolean {
  return patterns.some((p) => p && globToRegExp(p).test(toolName));
}
export interface CatalogSkill { name: string; filePath: string; disabled: boolean; calls30d: number }
export interface Catalog {
  mcp: CatalogMcpServer[];
  mcpTotalTools: number;
  mcpTotalTokens: number;
  skills: CatalogSkill[];
  skillCalls30d: number;
  notes: string[];
}

/** Assemble the MCP catalog from mcp-cache.json + mcp.json (bounded reads; missing/corrupt → empty + note). */
export function readMcpCatalog(agentDir: string, notes: string[]): Array<{ name: string; enabled: boolean; toolCount: number; estTokens: number; cachedAt: string | null; excludedPatterns: string[]; tools: CatalogTool[] }> {
  const cachePath = path.join(agentDir, "mcp-cache.json");
  const cfgPath = path.join(agentDir, "mcp.json");
  // enabled/excludeTools come from mcp.json (enabled:false key = off, absent = on; excludeTools =
  // adapter-side filtering by original/prefixed name + glob at registration — excluded tools never
  // reach mcp-cache, so the UI adds phantom list rows from the patterns to keep restore possible)
  const disabledSet = new Set<string>();
  const excludePatterns = new Map<string, string[]>();
  try {
    const st = fs.statSync(cfgPath);
    if (st.size <= 8 * 1024 * 1024) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      for (const [name, srv] of Object.entries<any>(cfg?.mcpServers ?? {})) {
        if (srv?.enabled === false) disabledSet.add(name);
        if (Array.isArray(srv?.excludeTools)) excludePatterns.set(name, srv.excludeTools.map(String));
      }
    } else notes.push("mcp.json 超 8MB，enabled 状态跳过");
  } catch { /* no mcp.json: everything defaults to enabled */ }
  let cache: any = null;
  try {
    const st = fs.statSync(cachePath);
    if (st.size > 8 * 1024 * 1024) {
      notes.push("mcp-cache.json 超 8MB，跳过（有界读纪律）");
      return [];
    }
    cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch { notes.push("mcp-cache.json 不可读（pi 尚未生成缓存？）"); return []; }
  const out: Array<{ name: string; enabled: boolean; toolCount: number; estTokens: number; cachedAt: string | null; excludedPatterns: string[]; tools: CatalogTool[] }> = [];
  for (const [name, srv] of Object.entries<any>(cache?.servers ?? {})) {
    const patterns = excludePatterns.get(name) || [];
    const tools: CatalogTool[] = (Array.isArray(srv?.tools) ? srv.tools : []).map((t: any) => ({
      name: String(t?.name || "?"),
      estTokens: toolEstTokens(t),
      calls30d: 0,
      excluded: toolMatchesPatterns(String(t?.name || "?"), patterns) || undefined,
    }));
    // phantom rows: non-glob exclude patterns whose tool no longer appears in the cache
    // (already filtered out by the adapter) — name-only rows so the UI can restore them.
    const known = new Set(tools.map((t) => t.name.toLowerCase()));
    for (const p of patterns) {
      if (p.includes("*")) continue;
      if (!known.has(p.toLowerCase())) {
        tools.push({ name: p, estTokens: 0, calls30d: 0, excluded: true, phantom: true });
      }
    }
    out.push({
      name,
      enabled: !disabledSet.has(name),
      toolCount: tools.length,
      estTokens: tools.reduce((a, b) => a + b.estTokens, 0),
      cachedAt: srv?.cachedAt ? new Date(Number(srv.cachedAt)).toISOString() : null,
      excludedPatterns: patterns,
      tools,
    });
  }
  out.sort((a, b) => b.estTokens - a.estTokens);
  return out;
}

/** Pure merge: catalog surface × 30-day call counts → Catalog (directly testable).
 *  Attribution caliber: pi records MCP calls at server level (toolName = `mcp__<server>`, dash→underscore);
 *  exact-name matching only covers built-in/extension bare names, so per-tool counts stay 0 for MCP
 *  tools (no cost apportioning in phase 1). */
export function buildCatalog(
  mcpServers: Array<{ name: string; enabled: boolean; toolCount: number; estTokens: number; cachedAt: string | null; excludedPatterns: string[]; tools: CatalogTool[] }>,
  skills: CatalogSkill[],
  toolCounts: Record<string, number>,
  skillCounts: Record<string, number>,
): Catalog {
  const notes: string[] = [];
  const serverCalls = (name: string): number => {
    const variants = [name, name.replace(/-/g, "_")];
    let n = 0;
    for (const [k, c] of Object.entries(toolCounts)) {
      for (const v of variants) {
        if (k === `mcp__${v}` || k.startsWith(`mcp__${v}__`)) { n += c; break; }
      }
    }
    return n;
  };
  for (const s of mcpServers) {
    let bare = 0;
    for (const t of s.tools) {
      t.calls30d = toolCounts[t.name] || 0;
      bare += t.calls30d;
    }
    s.calls30d = bare + serverCalls(s.name); // bare-name tools + the mcp__<server> wrapper caliber
  }
  for (const sk of skills) sk.calls30d = skillCounts[sk.name] || 0;
  return {
    mcp: mcpServers,
    mcpTotalTools: mcpServers.reduce((a, s) => a + s.toolCount, 0),
    mcpTotalTokens: mcpServers.reduce((a, s) => a + s.estTokens, 0),
    skills,
    skillCalls30d: skills.reduce((a, s) => a + s.calls30d, 0),
    notes,
  };
}

/** Server-side assembly (called from api.ts /catalog): read catalog + query 30-day usage + fetch skills surface same-origin. */
export async function collectCatalog(usage: { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } }, opts: { agentDir: string; sameOrigin?: (p: string) => string }): Promise<Catalog> {
  const notes: string[] = [];
  const servers = readMcpCatalog(opts.agentDir, notes);
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const toolCounts: Record<string, number> = {};
  try {
    for (const r of usage.db.prepare("SELECT tool, COUNT(*) c FROM tool_usage WHERE ts >= ? GROUP BY tool").all(since) as Array<{ tool: string; c: number }>) {
      toolCounts[r.tool] = r.c;
    }
  } catch { notes.push("tool_usage 表不可读（旧库未升级？）"); }
  const skillCounts: Record<string, number> = {};
  try {
    for (const r of usage.db.prepare("SELECT skill, COUNT(*) c FROM skill_usage WHERE ts >= ? GROUP BY skill").all(since) as Array<{ skill: string; c: number }>) {
      skillCounts[r.skill] = r.c;
    }
  } catch { notes.push("skill_usage 表不可读（旧库未升级？）"); }
  // effective skills surface: same-origin host /api/skills (loadSkillsWithInstallInfo includes disableModelInvocation)
  const skills: CatalogSkill[] = [];
  if (opts.sameOrigin) {
    try {
      const res = await fetch(opts.sameOrigin("/api/skills"));
      const d = (await res.json()) as any;
      for (const s of Array.isArray(d?.skills) ? d.skills : []) {
        skills.push({
          name: String(s?.name || path.basename(String(s?.filePath || ""), ".md")),
          filePath: String(s?.filePath || ""),
          disabled: s?.disableModelInvocation === true,
          calls30d: 0,
        });
      }
      skills.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      notes.push("skills 面拉取失败：" + (e instanceof Error ? e.message : String(e)));
    }
  } else {
    notes.push("sameOrigin 未配置，skills 面跳过");
  }
  return buildCatalog(servers, skills, toolCounts, skillCounts);
}
