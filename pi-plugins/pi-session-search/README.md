# pi-session-search

Give the **pi agent** read-only tools to search past sessions and read their original messages — built for the moment context gets compacted away (or the user says "as we discussed last time…").

```bash
pi install npm:pi-session-search        # or: pi -e /path/to/pi-session-search/src/index.ts
```

## Tools

### `session_search(q, scope?, agent?, cwd?, role?, limit?)`

Full-text keyword search across past conversations:

- `scope: "current"` — this conversation only (live, includes everything compacted away)
- `scope: "pi"` — pi's own sessions only
- `scope: "all"` (default) — every agent family the index knows
- `scope: "<id>"` / `scope: ["<id1>", "<id2>"]` — narrow a previous search to specific sessions (uuid, uuid prefix, or jsonl path)

Optional `agent` (pi/claude/codex/opencode/zcode/kimi/gemini/cursor/…), `cwd` prefix, `role`, `limit` filters.

### `session_read(session, role?="user", limit?, offset?, maxChars?, entry?)`

Read one session's original messages. Defaults to the **user's** messages — the fastest way to recover the user's exact earlier requests after compaction. `entry` anchors a single message from a `session_search` hit; long texts truncate at `maxChars` and page via `offset`.

Typical flow: `session_search("压缩 命令", "all")` → `session_search("resize", ["id1","id2"])` → `session_read("id1")` → `session_read("id1", entry)`.

## Data sources

Priority order (per query, read-only everywhere):

1. **pi-web session-manager index** — SQLite FTS5 trigram index covering ~20 agent families (pi, claude, codex, opencode, zcode, kimi, gemini, copilot, cursor, cline, trae, windsurf, zed, antigravity, openclaw, …). Snapshot semantics: output is labeled with the index snapshot time. Candidates: `$PI_SESSION_SEARCH_DB`, `$PI_WEB_DATA_DIR/session-manager/cache/index.sqlite`, `~/.pi/web/data/…`, `~/.pi/web-dev/data/…`. Set `PI_SESSION_SEARCH_DB=off` to disable.
2. **pi session files** — streamed scan of `~/.pi/agent/sessions` (`$PI_CODING_AGENT_SESSION_DIR` override), newest first, bounded. Always live.
3. **`scope: "current"`** — read straight from the live session manager; 100% fresh, includes entries compacted away seconds ago.

Chinese (CJK) queries need ≥ 3 characters (FTS5 trigram); shorter queries fall back to substring matching.

## Human channel

```
/session-search <query> [scope:current|pi|all]
```

## Notes

- Read-only: the extension never writes to session files or any index.
- Zero native dependencies (node:sqlite built-in, Node ≥ 22.5).
- The pi-web counterpart (same tool contract, injected into pi-web sessions via `server.agent.agentTools`) lives in session-manager — see the session-manager extension in this repo.
