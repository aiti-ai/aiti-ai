/**
 * pi-session-search — give the pi agent read-only tools to search its own (and
 * every other agent family's) past sessions, and read original messages from
 * them. Built for the "context got compacted away" moment: the raw entries are
 * always still in the session file / index — these tools surface them again.
 *
 * Tools
 * -----
 *   session_search(q, scope?, agent?, cwd?, role?, limit?)
 *     scope: "current" (this conversation) | "pi" | "all" (default) | one
 *            session id (uuid / prefix / jsonl path) | array of ids
 *   session_read(session, role?="user", limit?, offset?, maxChars?, entry?)
 *
 * Data sources (in priority order)
 * --------------------------------
 *   1. pi-web session-manager index (readOnly SQLite FTS5, ~20 agent families).
 *      Candidates: $PI_SESSION_SEARCH_DB, $PI_WEB_DATA_DIR/..., ~/.pi/web{,-dev}/data/...
 *      Output is labeled with the index snapshot time (lazy snapshot, never written).
 *   2. pi session JSONL files under ~/.pi/agent/sessions (streamed, newest first,
 *      bounded). Always live — no index staleness.
 *   scope="current" bypasses both: reads straight from the live session manager
 *   (ctx.sessionManager.getEntries()), 100% fresh including just-compacted entries.
 *
 * Human channel
 * -------------
 *   /session-search <query> — search without going through the model.
 *
 * Design notes (docs/pi-session-search-tools-plan.md §5): tool contract mirrors
 * the session-manager side (pi-web) 1:1; no LLM calls, no background work, no
 * writes anywhere.
 */

import { openDb, resolveRefsDb, searchSessionsDb, sessionMessagesDb, type DbHandle } from "./lib/db-source.ts";
import {
  listSessionFiles, readCurrentEntries, readSessionFile, searchCurrent, searchFiles, sessionsRoot,
} from "./lib/file-source.ts";
import { enrichLines, killswitchBlocksRegistration, resolveDataDir } from "./lib/enrich.ts";

const SEARCH_DESCRIPTION =
  "Search past conversation history across all agents on this machine (pi, claude, codex, opencode, zcode, kimi, gemini, cursor, ...) by keyword. " +
  "Use it when earlier context was compacted away, when the user refers to previous discussions or past work, or to find out how something was done before. " +
  "Returns one hit per matching session (session id, agent, title, time, snippet). Follow up with session_read to pull full messages. " +
  "CJK queries need >= 3 characters (trigram index); shorter queries fall back to substring match.";

const READ_DESCRIPTION =
  "Read full messages of one past session (any agent family). Default returns the user's original messages — the fastest way to recover the user's exact earlier requests after context compaction. " +
  "Pass entry (from session_search results) to anchor a single message; long texts are truncated at maxChars and can be continued with offset. " +
  "session accepts \"current\" (this conversation), a session id / uuid prefix, or a session jsonl path.";

const SEARCH_PARAMS = {
  type: "object",
  properties: {
    q: { type: "string", description: "Keyword or phrase; multi-word natural language and \"quoted exact phrases\" work. Chinese needs >= 3 chars." },
    scope: {
      type: ["string", "array"],
      description: "Search range: \"current\" (this conversation only — use for recovering compacted-away context) | \"pi\" (pi sessions only) | \"all\" (default, every agent) | one session id (uuid, uuid prefix, or session jsonl path) | array of session ids to narrow a previous search",
      items: { type: "string" },
    },
    agent: { type: "string", description: "Optional agent family filter: pi | claude | codex | opencode | zcode | kimi | gemini | cursor | ..." },
    cwd: { type: "string", description: "Optional project directory prefix filter" },
    role: { type: "string", enum: ["user", "assistant"], description: "Optional message role filter" },
    limit: { type: "number", description: "Max sessions in result (default 8, cap 50)" },
  },
  required: ["q"],
};

const READ_PARAMS = {
  type: "object",
  properties: {
    session: { type: "string", description: '"current" | session id | uuid prefix | session jsonl absolute path' },
    role: { type: "string", enum: ["user", "assistant", "all"], description: 'Message role filter, default "user"' },
    limit: { type: "number", description: "Max messages per call (default 20, cap 200)" },
    offset: { type: "number", description: "Skip first N messages (for paging through long sessions)" },
    maxChars: { type: "number", description: "Per-message character cap before truncation (default 4000)" },
    entry: { type: "string", description: "Anchor a single message by entry id (from session_search hits)" },
  },
  required: ["session"],
}

function fmtHits(hits: Array<Record<string, unknown>>, header: string, enrich?: Map<string, string>): string {
  if (!hits.length) return header;
  const lines = hits.map((h, i) => {
    const sid = String(h.sessionId ?? "");
    const agent = h.agent != null && h.agent !== "" ? String(h.agent) : (h.path === "current" ? "pi" : "?");
    const where = h.path && h.path !== "current" ? `\n   path: ${h.path}` : "";
    const extra = enrich?.get(sid);
    return `${i + 1}. ${sid} [${agent}]${h.title ? ` «${h.title}»` : ""} ${h.modified ?? h.mtime ?? ""}${where}\n   cwd: ${h.cwd}${extra ? `\n   ${extra.replace(/\n/g, "\n   ")}` : ""}\n   ${h.role}@${h.ts ?? "?"}: ${String(h.text).replace(/\s+/g, " ").slice(0, 200)}\n   entry: ${h.entryId}`;
  });
  return `${header}\n${lines.join("\n")}\n(use session_read with the session id above; pass entry to anchor a single message)`;
}

function fmtRead(res: { row?: Record<string, unknown>; sessionId?: string; cwd?: string; messages: Array<Record<string, unknown>>; total: number }, opts: { offset?: number; entry?: string }, extra?: string): string {
  const head = (res.row
    ? `session ${String((res.row as { id: string }).id)} [${String((res.row as { agent?: string }).agent ?? "pi")}]${(res.row as { name?: string }).name ? ` «${(res.row as { name?: string }).name}»` : ""} cwd=${String((res.row as { cwd?: string }).cwd ?? "")} modified=${String((res.row as { modified?: string }).modified ?? "")}`
    : `session ${res.sessionId ?? ""} cwd=${res.cwd ?? ""}`) + (extra ? `\n${extra}` : "");
  const body = res.messages.map((m, i) => {
    const label = opts.entry ? "" : `[${(opts.offset ?? 0) + i + 1}/${res.total}] `;
    const more = m.truncated ? " …continue with offset/maxChars" : "";
    return `${label}${String(m.ts ?? "?")} ${String(m.role)}: ${String(m.text)}${more}`;
  });
  return `${head}\n${body.join("\n\n")}`;
}

/** File-mode ref resolution: exact id / exact path / unique uuid prefix → file paths.
 *  Ambiguous or unknown refs are reported (contract parity with the db source). */
async function resolveFileRefs(refs: string[], root: string, ctxSessionDir?: string):
  Promise<{ paths: string[] } | { error: string }> {
  const files = await listSessionFiles(root, ctxSessionDir);
  const paths: string[] = [];
  const unresolved: string[] = [];
  for (const raw of refs) {
    const ref = String(raw ?? "").trim();
    if (!ref) continue;
    const exact = files.filter((f) => f.id === ref || f.path === ref);
    if (exact.length === 1) { paths.push(exact[0].path); continue; }
    const pref = exact.length ? exact : files.filter((f) => f.id.startsWith(ref));
    if (pref.length === 1) { paths.push(pref[0].path); continue; }
    unresolved.push(ref);
  }
  if (unresolved.length || !paths.length) {
    const known = unresolved.length ? `ambiguous or unknown session refs: ${unresolved.join(", ")}` : "no session matched";
    return { error: paths.length ? `${known}（resolved: ${paths.length}）` : known };
  }
  return { paths };
}

/** Normalize the scope parameter (contract §3). Returns {agents?, ids?} or an error string. */
async function resolveScope(raw: unknown, ctx: any, source: () => DbHandle | null, sessionDir: string):
  Promise<{ ok: true; agents?: string[]; ids?: string[] } | { ok: false; error: string }> {
  const scope = raw === undefined || raw === null || raw === "" ? "all" : raw;
  if (Array.isArray(scope)) {
    const db = source();
    if (!db) {
      const r = await resolveFileRefs(scope.map(String), sessionsRoot(sessionDir), sessionDir);
      return "error" in r ? { ok: false, error: r.error } : { ok: true, ids: r.paths };
    }
    const r = resolveRefsDb(db, scope.map(String));
    if (!r.ids.length) return { ok: false, error: `no session matched: ${r.unresolved.join(", ") || "(empty)"}` };
    if (r.unresolved.length) return { ok: false, error: `ambiguous or unknown session refs: ${r.unresolved.join(", ")}（resolved: ${r.ids.join(", ")}）` };
    return { ok: true, ids: r.ids };
  }
  const s = String(scope);
  if (s === "current") return { ok: true, ids: ["current"] };
  if (s === "pi") return { ok: true, agents: ["pi"] };
  if (s === "all") return { ok: true };
  const db = source();
  if (!db) {
    const r = await resolveFileRefs([s], sessionsRoot(sessionDir), sessionDir);
    return "error" in r ? { ok: false, error: r.error } : { ok: true, ids: r.paths };
  }
  const r = resolveRefsDb(db, [s]);
  if (r.ids.length === 1) return { ok: true, ids: r.ids };
  return { ok: false, error: r.unresolved.length ? `no unique session matched "${s}"（ambiguous prefix or unknown id/path）` : `no session matched "${s}"` };
}

export default function sessionSearchExtension(pi: any) {
  let currentSessionDir = "";

  // A/B co-install kill-switch (docs/pi-session-search-enrich-tags-plan.md §4.3): when the
  // pi-web session-manager agentTools (A side) is present (kill-switch config.json with
  // agentTools.enabled !== false), skip tool registration entirely (aiti-git-trace ×
  // pi-git-trace kill-switch precedent); missing file = standalone TUI, register normally.
  // The /session-search slash command stays (human channel; A side has no same-name command).
  let registerTools = true;
  try {
    if (killswitchBlocksRegistration()) {
      registerTools = false;
      console.warn("[pi-session-search] session-manager agentTools detected on this install — session_search/session_read registration skipped (kill-switch); /session-search stays available.");
    }
  } catch { /* probe failure = register normally (conservative) */ }

  if (registerTools) {
  pi.registerTool({
    name: "session_search",
    label: "session_search",
    description: SEARCH_DESCRIPTION,
    promptSnippet: "Search past sessions (session_search) and read their messages (session_read)",
    promptGuidelines: [
      "Use session_search when earlier conversation context was compacted away and you need details or decisions from the compacted part — search scope \"current\" first.",
      "Use session_search when the user refers to previous sessions or past work (\"上次\", \"之前\", \"we discussed ...\").",
      "Narrow iteratively: search scope \"all\" to locate candidates, then scope [ids] to refine, then session_read to pull the user's original requests.",
    ],
    parameters: SEARCH_PARAMS,
    async execute(_toolCallId: string, params: { q: string; scope?: unknown; agent?: string; cwd?: string; role?: string; limit?: number }, _signal: unknown, _onUpdate: unknown, ctx: any) {
      if (!params?.q) return { content: [{ type: "text", text: 'session_search failed: "q" is required' }], isError: true } as never;
      const sessionDir = typeof ctx?.sessionManager?.getSessionDir === "function" ? String(ctx.sessionManager.getSessionDir()) : currentSessionDir;
      const scoped = await resolveScope(params.scope, ctx, openDb, sessionDir);
      if (!scoped.ok) return { content: [{ type: "text", text: `session_search failed: ${scoped.error}` }], isError: true } as never;
      const cwdPrefix = params.cwd ? String(params.cwd) : undefined;

      // scope="current": search the live session manager (freshest, includes compacted-away entries)
      if (scoped.ids?.length === 1 && scoped.ids[0] === "current") {
        const hits = searchCurrent(ctx, String(params.q), { role: params.role, limit: params.limit });
        const filtered = hits.filter((h) => !cwdPrefix || h.cwd.startsWith(cwdPrefix));
        if (!filtered.length) {
          return { content: [{ type: "text", text: `no message in the current session matched "${params.q}"（live entries, includes everything compacted away）` }] } as never;
        }
        const enrich = enrichLines(filtered.map((h) => String(h.sessionId)), resolveDataDir());
        return { content: [{ type: "text", text: fmtHits(filtered as unknown as Array<Record<string, unknown>>, `session_search (current session, live): ${filtered.length} hit(s)`, enrich) }] } as never;
      }

      const db = openDb();
      if (db) {
        const agents = scoped.agents ?? (params.agent ? [params.agent] : undefined);
        const hits = searchSessionsDb(db, String(params.q), {
          agents,
          sessionIds: scoped.ids,
          role: params.role,
          cwdPrefix,
          limit: params.limit,
        });
        if (!hits.length) {
          return { content: [{ type: "text", text: `no session matched query "${params.q}"（scope=${Array.isArray(params.scope) ? "[ids]" : String(params.scope ?? "all")}, index snapshot ${db.snapshotMtime}）. Try a different keyword, scope "all", or a >= 3-char Chinese phrase.` }] } as never;
        }
        const enrich = enrichLines(hits.map((h) => h.sessionId), resolveDataDir(db.path));
        return { content: [{ type: "text", text: fmtHits(hits as unknown as Array<Record<string, unknown>>, `session_search: ${hits.length} hit(s)（pi-web index snapshot ${db.snapshotMtime}）`, enrich) }] } as never;
      }

      // no index db → scan pi session files (always live)
      const root = sessionsRoot(currentSessionDir || (typeof ctx?.sessionManager?.getSessionDir === "function" ? String(ctx.sessionManager.getSessionDir()) : undefined));
      const hits = await searchFiles(root, String(params.q), {
        sessionIds: scoped.ids,
        role: params.role,
        cwdPrefix,
        limit: params.limit,
        ctxSessionDir: currentSessionDir,
      });
      if (!hits.length) {
        return { content: [{ type: "text", text: `no session matched query "${params.q}"（scanned pi session files under ${root}, live）` }] } as never;
      }
      const enrich = enrichLines(hits.map((h) => String(h.sessionId)), resolveDataDir());
      return { content: [{ type: "text", text: fmtHits(hits as unknown as Array<Record<string, unknown>>, `session_search: ${hits.length} hit(s)（pi session files, live scan）`, enrich) }] } as never;
    },
  });

  pi.registerTool({
    name: "session_read",
    label: "session_read",
    description: READ_DESCRIPTION,
    promptSnippet: "Read a past session's original messages (session_read)",
    parameters: READ_PARAMS,
    async execute(_toolCallId: string, params: { session: string; role?: string; limit?: number; offset?: number; maxChars?: number; entry?: string }, _signal: unknown, _onUpdate: unknown, ctx: any) {
      if (!params?.session) return { content: [{ type: "text", text: 'session_read failed: "session" is required' }], isError: true } as never;
      let ref = String(params.session).trim();
      const readOpts = {
        role: params.role ?? "user", // contract: default to user messages (recover the user's original requests)
        limit: params.limit,
        offset: params.offset,
        maxChars: params.maxChars,
        entryId: params.entry,
      };

      if (ref === "current") {
        const res = readCurrentEntries(ctx, readOpts);
        if (!res.messages.length) {
          return { content: [{ type: "text", text: `session ${res.sessionId || "(current)"} has no matching messages（role=${readOpts.role}, total=${res.total}）` }] } as never;
        }
        const sid = String(res.sessionId);
        return { content: [{ type: "text", text: fmtRead(res, { offset: params.offset, entry: params.entry }, enrichLines([sid], resolveDataDir()).get(sid)) }] } as never;
      }

      const db = openDb();
      if (db) {
        const res = sessionMessagesDb(db, ref, readOpts);
        if (res) {
          if (!res.messages.length) {
            return { content: [{ type: "text", text: `session ${String((res.row as { id: string }).id)} has no matching messages（role=${readOpts.role}, total=${res.total}）` }] } as never;
          }
          const sid = String((res.row as { id: string }).id);
          return { content: [{ type: "text", text: fmtRead(res, { offset: params.offset, entry: params.entry }, enrichLines([sid], resolveDataDir(db.path)).get(sid)) }] } as never;
        }
        // fall through: not in the index (maybe newer than the snapshot / other dir) → try files
      }

      // file source: ref may be a jsonl path or a uuid/prefix within the sessions dir
      let path = ref;
      if (!ref.endsWith(".jsonl")) {
        const sessionDir = typeof ctx?.sessionManager?.getSessionDir === "function" ? String(ctx.sessionManager.getSessionDir()) : currentSessionDir;
        const resolved = await resolveFileRefs([ref], sessionsRoot(sessionDir), sessionDir);
        if ("error" in resolved) {
          return { content: [{ type: "text", text: `session_read failed: ${resolved.error}（use session_search to find exact ids）` }], isError: true } as never;
        }
        path = resolved.paths[0];
      }
      const res = await readSessionFile(path, readOpts);
      if (!res) {
        return { content: [{ type: "text", text: `session_read failed: session file not found "${ref}"` }], isError: true } as never;
      }
      if (!res.messages.length) {
        return { content: [{ type: "text", text: `session "${ref}" has no matching messages（role=${readOpts.role}, total=${res.total}）` }] } as never;
      }
      const fileSid = res.sessionId || ref;
      return { content: [{ type: "text", text: fmtRead({ sessionId: ref, messages: res.messages, total: res.total }, { offset: params.offset, entry: params.entry }, enrichLines([fileSid], resolveDataDir()).get(fileSid)) }] } as never;
    },
  });
  } // registerTools (tools skipped on kill-switch; slash command stays outside)

  // Human channel: /session-search <query> — search without the model in the loop.
  pi.registerCommand("session-search", {
    description: "Search past sessions (current/pi/all + id scopes)",
    handler: async (args: string | undefined, ctx: any) => {
      const q = (args ?? "").trim();
      if (!q) {
        ctx?.ui?.notify?.("Usage: /session-search <query> [scope:current|pi|all]", "info");
        return;
      }
      let query = q;
      let scope: string = "all";
      const m = q.match(/\s+(scope:(current|pi|all))$/i);
      if (m) { query = q.slice(0, m.index).trim(); scope = m[2].toLowerCase(); }
      try {
        if (scope === "current") {
          const hits = searchCurrent(ctx, query, { limit: 10 });
          ctx?.ui?.notify?.(hits.length
            ? `Current session, ${hits.length} hit(s):\n` + hits.map((h, i) => `${i + 1}. [${h.role}] ${h.text.replace(/\s+/g, " ").slice(0, 100)}`).join("\n")
            : `No hit in the current session for "${query}".`, "info");
          return;
        }
        const db = openDb();
        if (db) {
          const hits = searchSessionsDb(db, query, { agents: scope === "pi" ? ["pi"] : undefined, limit: 10 });
          ctx?.ui?.notify?.(hits.length
            ? `${hits.length} session hit(s)（index snapshot ${db.snapshotMtime}）:\n` + hits.map((h, i) => `${i + 1}. [${h.agent ?? "?"}] ${h.sessionId.slice(0, 8)}… ${h.modified} ${String(h.text).replace(/\s+/g, " ").slice(0, 80)}`).join("\n")
            : `No session matched "${query}".`, "info");
          return;
        }
        const root = sessionsRoot(currentSessionDir || (typeof ctx?.sessionManager?.getSessionDir === "function" ? String(ctx.sessionManager.getSessionDir()) : undefined));
        const hits = await searchFiles(root, query, { limit: 10, ctxSessionDir: currentSessionDir });
        ctx?.ui?.notify?.(hits.length
          ? `${hits.length} session hit(s)（file scan, live）:\n` + hits.map((h, i) => `${i + 1}. ${h.sessionId.slice(0, 8)}… ${h.mtime.slice(0, 10)} ${String(h.text).replace(/\s+/g, " ").slice(0, 80)}`).join("\n")
          : `No session matched "${query}".`, "info");
      } catch (e) {
        ctx?.ui?.notify?.(`session-search failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // Track the session dir (custom PI_CODING_AGENT_SESSION_DIR layouts) — session_start ctx has the session manager.
  pi.on?.("session_start", (_event: unknown, ctx: any) => {
    try {
      const dir = ctx?.sessionManager?.getSessionDir?.();
      if (typeof dir === "string" && dir) currentSessionDir = dir;
    } catch { /* keep previous */ }
  });
}
