/**
 * External-session placeholder files.
 *
 * External agent sessions (cursor/claude/codex/qoder... driven via
 * sessionProviders, composite id "<agent>:<sid>") previously appeared in the
 * sidebar only as in-memory transient handle rows (getHandleSessionInfos,
 * transient) — gone after a restart, with no trace anywhere in the local
 * session universe.
 *
 * A placeholder file = a real .jsonl dropped into the local session directory
 * (header + session_info, no conversation), giving the external session a
 * durable anchor:
 *   - disk scans list it naturally (the persistedSessions section of
 *     /api/sessions), surviving restarts;
 *   - the header carries agent/extId markers → opening always routes to the
 *     real agent backend (lib/session resolvePlaceholderSession →
 *     openExternalSession); the placeholder file itself is never opened as a
 *     local session (no empty metadata shell);
 *   - deletion removes only the placeholder file + registry entry; external
 *     raw data (cursor store.db etc.) is never touched.
 *
 * Write timing (avoid orphan placeholders):
 *   - resume (⚡ take over history / ?session= restore): written as soon as
 *     the handle is created (extId already known);
 *   - fresh (new session from the welcome page): written only after
 *     session_backend_ready (real chatId rebind) — an empty session that never
 *     sent a first message leaves no placeholder (it stays an in-memory
 *     transient row, matching the local "first reply persists" cadence). The
 *     placeholder key migrates with the rebind (new- provisional key → real
 *     composite id).
 *
 * Registry: ~/.pi/web{,-dev}/data/external-session-placeholders.json (extId → uuid/path).
 * Purely an acceleration index (suppresses transient rows, tags list rows with
 * agent); the file header carries its own markers, so even a lost registry can
 * reverse-look-up by uuid (readSessionHeader → extId) — worst case falls back
 * to the old behavior.
 *
 * File format follows the layout proven by the session-manager import flow
 * (lib/agents/to-pi.ts):
 *   {"type":"session","version":3,"id":<uuid>,"timestamp":...,"cwd":...,"agent":...,"extId":...}
 *   {"type":"session_info","name":"[agent] …","importedFrom":"<agent>:<sid>","external":true,…}
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataRoot } from "../ext/data-dir.ts";
import { trashFileSync } from "../session-trash.ts";

export interface ExternalPlaceholder {
  /** Local placeholder session id (= trailing uuid of the file name = header.id). The sidebar row's outward identity. */
  uuid: string;
  /** Absolute path of the placeholder file. */
  path: string;
  /** External composite id, e.g. "cursor:<chatId>". Key for extId changes (new- rebind). */
  extId: string;
  /** Agent key (cursor/claude/codex/...); used for frontend badges and external model catalog routing. */
  agent: string;
  /** Display name ("[agent] …"). */
  name?: string;
  /** Original project cwd (used for header.cwd; the file is written under the encodeCwd(cwd) directory). */
  cwd: string;
  /** Subagent placeholder: parent session file path (header.parentSession; used for badges/parent-child tree). */
  parentSessionFile?: string;
  /** Pre-rebind new- provisional composite id (alias key): lets unmigrated browser ?session= URLs still resolve back to this session. */
  aliases?: string[];
  created: string;
}

interface RegistryFile {
  version: 1;
  sessions: ExternalPlaceholder[];
}

const g = globalThis as typeof globalThis & {
  __externalPlaceholders?: { mtimeMs: number; map: Map<string, ExternalPlaceholder> };
};

function registryFile(): string {
  return join(dataRoot(), "external-session-placeholders.json");
}

function registryMtime(): number {
  try { return statSync(registryFile()).mtimeMs; } catch { return -1; }
}

/**
 * Lazily re-read the registry by mtime: when the file is written by another
 * process (another web instance / CLI script), this process automatically
 * picks up the new content on its next access — the safe pattern for a
 * long-lived process sharing the registry across dual instances.
 */
function loadRegistry(): Map<string, ExternalPlaceholder> {
  const mtime = registryMtime();
  const cached = g.__externalPlaceholders;
  if (cached && cached.mtimeMs === mtime) return cached.map;
  const map = new Map<string, ExternalPlaceholder>();
  if (mtime >= 0) {
    try {
      const raw = JSON.parse(readFileSync(registryFile(), "utf8")) as RegistryFile;
      for (const s of raw.sessions ?? []) {
        if (s && typeof s === "object" && s.extId && s.uuid) {
          map.set(s.extId, s);
          // Expand alias keys → same record (old ?session= URLs keep resolving
          // after the provisional placeholder id rebinds)
          for (const a of s.aliases ?? []) {
            if (a && a !== s.extId) map.set(a, s);
          }
        }
      }
    } catch {
      /* Corrupt → empty map (header markers are the fallback; see module comment) */
    }
  }
  g.__externalPlaceholders = { mtimeMs: mtime, map };
  return map;
}

function persistRegistry(map: Map<string, ExternalPlaceholder>): void {
  try {
    mkdirSync(dataRoot(), { recursive: true });
    // Map values include duplicate references from alias keys (several keys per
    // record) — dedupe by object identity before persisting
    const payload: RegistryFile = { version: 1, sessions: [...new Set(map.values())] };
    const file = registryFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, file);
  } catch {
    /* best-effort: a registry write failure does not block the placeholder file itself */
  }
}

/** cwd encoding matching the session-manager convention: /home/w/x → --home-wind-x. */
function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";
}

/** Session file-name timestamp: 2026-08-17T00-27-14-727Z (hyphens in the time part). */
function fileNameTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
  return d.toISOString().replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/, "$1$2-$3-$4-$5Z");
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function displayName(agent: string, extId: string, name?: string): string {
  const sid = extId.slice(extId.indexOf(":") + 1) || extId;
  return name?.trim() ? name : `[${agent}] ${sid.slice(0, 24)}`;
}

/** Rewrite the placeholder file (header extId/agent/cwd and the session_info line). The file is tiny (two lines), so rewrite it whole. */
function rewritePlaceholderFile(p: ExternalPlaceholder): void {
  const lines = [
    line({
      type: "session",
      version: 3,
      id: p.uuid,
      timestamp: p.created,
      cwd: p.cwd,
      agent: p.agent,
      extId: p.extId,
      ...(p.parentSessionFile ? { parentSession: p.parentSessionFile } : {}),
    }),
    line({
      type: "session_info",
      name: displayName(p.agent, p.extId, p.name),
      importedFrom: p.extId,
      external: true,
      createdAt: p.created,
    }),
  ];
  writeFileSync(p.path, lines.join(""), { flag: "w" });
}

/**
 * Write (or update) the placeholder file for an external session. Idempotent:
 * when a placeholder already exists for the extId, only the name is patched.
 * cwd falls back to `~/external-<agent>` when absent (matches the import
 * flow's fallbackCwd convention). Returns null = cwd missing with no fallback
 * (theoretically unreachable) or write failure.
 */
export function ensurePlaceholder(input: {
  extId: string;
  agent: string;
  cwd?: string;
  name?: string;
  createdIso?: string;
  /** Subagent placeholder: parent session file path (header.parentSession). Patched in when an existing placeholder lacks it. */
  parentSessionFile?: string;
}): ExternalPlaceholder | null {
  const map = loadRegistry();
  const known = map.get(input.extId);
  if (known) {
    // Alias hit (known.extId ≠ requested key): this provisional id already
    // rebound to the real extId — return as-is, no rename/patch; write
    // semantics belong only to calls on the real key.
    if (known.extId !== input.extId) return known;
    const needsName = input.name && input.name !== known.name;
    const needsParent = input.parentSessionFile && input.parentSessionFile !== known.parentSessionFile;
    if (needsName || needsParent) {
      if (needsName) known.name = input.name;
      if (needsParent) known.parentSessionFile = input.parentSessionFile;
      try { rewritePlaceholderFile(known); } catch { /* best-effort */ }
      persistRegistry(map);
    }
    return known;
  }
  const cwd = input.cwd?.trim() || join(homedir(), `external-${input.agent}`);
  const uuid = randomUUID();
  const created = input.createdIso || new Date().toISOString();
  const dir = join(homedir(), ".pi", "agent", "sessions", encodeCwd(cwd));
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const p: ExternalPlaceholder = {
      uuid,
      path: join(dir, `${fileNameTs(created)}_${uuid}.jsonl`),
      extId: input.extId,
      agent: input.agent,
      cwd,
      ...(input.name ? { name: input.name } : {}),
      ...(input.parentSessionFile ? { parentSessionFile: input.parentSessionFile } : {}),
      created,
    };
    rewritePlaceholderFile(p);
    map.set(input.extId, p);
    persistRegistry(map);
    return p;
  } catch {
    return null;
  }
}

/**
 * Placeholder key migration: when an external backend's lazy init exposes the
 * real native id (new- provisional → real chatId), the registry key and the
 * file header rebind with it. The old file name stays (uuid identity is
 * stable; changing references would break them). The old key is kept as an
 * alias (same record): placeholder URLs in the browser/bookmarks
 * (?session=agent:new-…) keep resolving to the same session after the handle
 * store is cleared (extension reload/restart), instead of being treated as a
 * brand-new session and instantiating a second handle (observed 2026-09-07:
 * duplicate rows for one session + diverged history).
 */
export function rebindPlaceholder(oldExtId: string, newExtId: string): ExternalPlaceholder | null {
  const map = loadRegistry();
  const p = map.get(oldExtId);
  if (!p || !newExtId || newExtId === oldExtId) return map.get(newExtId) ?? null;
  p.extId = newExtId;
  map.set(newExtId, p);
  addAlias(p, oldExtId); // keep the old provisional key as an alias (aliases[] on the record, expanded back into map keys on load)
  map.set(oldExtId, p);
  try { rewritePlaceholderFile(p); } catch { /* best-effort */ }
  persistRegistry(map);
  return p;
}

function addAlias(p: ExternalPlaceholder, alias: string): void {
  if (alias === p.extId) return;
  p.aliases = p.aliases ?? [];
  if (!p.aliases.includes(alias)) p.aliases.push(alias);
}

/**
 * Record a placeholder alias: oldExtId (the pre-rebind new- provisional
 * composite id) → the existing placeholder record under newExtId. This is the
 * path for fresh-session rebinds (no placeholder was ever written under the
 * new- key) — rebindPlaceholder only covers the resume case where the old key
 * already has a placeholder. Idempotent: no write when the target is missing
 * or already carries the alias.
 */
export function aliasPlaceholder(oldExtId: string, newExtId: string): ExternalPlaceholder | null {
  if (!oldExtId || !newExtId || oldExtId === newExtId) return null;
  const map = loadRegistry();
  const target = map.get(newExtId);
  if (!target) return null;
  if (map.get(oldExtId) === target) return target;
  addAlias(target, oldExtId);
  map.set(oldExtId, target);
  persistRegistry(map);
  return target;
}

/**
 * new- provisional sid detection (each backend extension's lazy-init
 * placeholder: zcode/codex `new-<n>-<ts>`, claude/qoder `new-<ts>`,
 * cursor `new-<uuid>`). Real native ids never carry the new- prefix.
 */
export function isProvisionalExtSid(sid: string): boolean {
  return sid.startsWith("new-");
}

export function getPlaceholder(extId: string): ExternalPlaceholder | undefined {
  return loadRegistry().get(extId);
}

export function hasPlaceholder(extId: string): boolean {
  return loadRegistry().has(extId);
}

/** uuid → placeholder record (the registry N is tiny, linear scan; if the registry is lost, the routing side falls back to header reverse lookup). */
export function placeholderByUuid(uuid: string): ExternalPlaceholder | undefined {
  for (const p of loadRegistry().values()) if (p.uuid === uuid) return p;
  return undefined;
}

/**
 * Delete a placeholder (only the anchor: the placeholder file + the registry
 * entry including all alias keys). External raw data is never touched.
 * Returns false = the uuid is not a placeholder.
 */
export function removePlaceholderByUuid(uuid: string): boolean {
  const map = loadRegistry();
  const p = placeholderByUuid(uuid);
  if (!p) return false;
  trashFileSync(p.path); // placeholder file goes to trash (no longer a physical unlink)
  for (const [key, rec] of map) {
    if (rec === p || rec.uuid === uuid) map.delete(key);
  }
  persistRegistry(map);
  return true;
}

/**
 * List annotation: after /api/sessions merges rows, tag placeholder rows with
 * their agent — the disk-scanned SessionInfo carries no header extension
 * fields, so badges and external model catalog routing (the frontend's
 * loadModels goes through list_models per agent) rely on this step to restore
 * them.
 */
export function stampExternalSessions(rows: Array<{ id: string; agent?: string }>): void {
  const map = loadRegistry();
  if (map.size === 0) return;
  for (const row of rows) {
    for (const p of map.values()) {
      if (p.uuid === row.id) {
        row.agent = p.agent;
        break;
      }
    }
  }
}

/** Test hook: clear the in-process registry cache (next access re-reads disk). */
export function resetPlaceholderCacheForTest(): void {
  g.__externalPlaceholders = undefined;
}
