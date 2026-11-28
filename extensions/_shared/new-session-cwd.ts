/**
 * Shared: @-to-new-session CWD resolution (never casually change the current CWD; normalized to workspace granularity)
 * Plans: docs/pi-web-at-new-session-cwd-plan.md (v1) + docs/pi-web-at-new-session-cwd-v2-plan.md (v2)
 *
 * Principle (v2, 2026-09-17): locating the target outranks switching directories, and the CWD must land at
 * workspace granularity —
 * ① target already inside the current CWD → keep current; ② target inside the current CWD's watched directories
 *    (git-trace watchPaths, repoRoot ?? path) → switch to that watched directory (deepest hit); ③ target inside an
 *    existing workspace (sidebar dropdown candidates, /api/sessions-derived projectRoot ?? cwd) → use the longest
 *    covering entry; ④ otherwise use its own directory, stripping common directory names upward
 *    (docs/doc/tmp/temp/design/designs); if the stripped result hits a workspace, use that workspace.
 *    Without a current CWD, ②③④ still run (fixes v1: with no cwd it landed directly on the file's parent directory →
 *    deep-subdirectory bug).
 *
 * Pure functions (no DOM/fs dependencies): server side (jiti) and client side (vite bundle, via `../../../_shared/…`
 * relative import) import the same source on both ends — same reference style as `_shared/ext-float-dock.ts`.
 *
 * Capability funnel: the session-manager client registers the `session-manager.mention` service (buildAtText + openNewSession);
 * consumers call the service first (`openNewSessionWithExtSvc`), falling back to this file's same-source implementation
 * when the service is absent (identical behavior).
 */

/** Common directory names (strip candidates: a target directory with one of these names is not taken as CWD; look upward; hard-coded per v2 user decision, not yet configurable) */
export const DEFAULT_EXCLUDE_DIR_NAMES = ["docs", "doc", "tmp", "temp", "design", "designs"];

/** Path normalization: Windows backslashes → slashes, trailing slashes removed. */
export function normDir(p: string): string {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/** containment: a and b are equal or path prefixes of each other (same as doc-center's wsCovers; tolerant of Windows backslashes and trailing slashes). */
export function pathCovers(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = normDir(a);
  const nb = normDir(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

/** Strict one-way covering: c is a prefix of target (or equal) — used for "switch to the covering directory" candidates, avoiding mistakenly selecting a subdirectory of the target. */
function coversDir(c: string, target: string): boolean {
  if (!c || !target) return false;
  return target === c || target.startsWith(c + "/");
}

/** Strips common directory names upward (docs/tmp/design…, case-insensitive), returning the first non-common directory; returns the original when nothing can be stripped. */
export function stripCommonDirs(dir: string, excludeNames?: string[]): string {
  const ex = new Set((excludeNames ?? DEFAULT_EXCLUDE_DIR_NAMES).map((s) => String(s).toLowerCase()));
  let d = normDir(dir);
  for (;;) {
    const name = d.split("/").pop() || "";
    if (!name || !ex.has(name.toLowerCase())) break;
    const idx = d.lastIndexOf("/");
    if (idx <= 0) break; // root level (/docs or D:) — stop ascending
    d = d.slice(0, idx);
  }
  return d;
}

/** The longest (deepest) entry among candidates (absolute paths) strictly covering target; null when none. */
export function longestCovering(target: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  for (const raw of candidates) {
    const c = normDir(String(raw || ""));
    if (!c) continue;
    if (coversDir(c, target)) {
      if (!best || c.length > best.length) best = c;
    }
  }
  return best;
}

export interface ResolveNewSessionCwdResult {
  /** The working directory to use after resolution (absolute path). */
  cwd: string;
  /** Whether a switch happened relative to the current CWD (always false when there is no current CWD). */
  switched: boolean;
}

/**
 * Resolves the working directory an "@-to-new-session" should use (v2).
 * @param targetDir target directory (absolute path; for files pass its containing directory, for directories pass itself — extracted by the caller)
 * @param targetPath the target file/directory's full path (optional; pass the file path for file scenarios, making covering checks more precise; falls back to targetDir when absent)
 * @param currentCwd the current session's cwd (empty/absent → skip ①; ②③④ still run)
 * @param watchPaths the current cwd's watched paths (git-trace watchPaths; entries are strings or {path, repoRoot};
 *        on a hit, repoRoot ?? path wins — repo root first per v2 user decision)
 * @param knownWorkspaces existing workspace candidates (sidebar dropdown = /api/sessions-derived projectRoot ?? cwd, deduplicated; may be empty)
 * @param excludeNames common directory name list (defaults to DEFAULT_EXCLUDE_DIR_NAMES)
 */
export function resolveNewSessionCwd(opts: {
  targetDir: string;
  targetPath?: string | null;
  currentCwd?: string | null;
  watchPaths?: (string | { path?: string | null; repoRoot?: string | null })[];
  knownWorkspaces?: (string | null | undefined)[];
  excludeNames?: string[];
}): ResolveNewSessionCwdResult {
  const target = normDir(opts.targetPath || opts.targetDir || "");
  const dir = normDir(opts.targetDir || opts.targetPath || "");
  const cur = normDir(opts.currentCwd || "");
  if (!target && !dir) return { cwd: cur, switched: false };

  // ① target inside the current CWD (two-way containment, same as doc-center's wsCovers) → keep
  if (cur && (pathCovers(cur, target) || (dir && dir !== target && pathCovers(cur, dir)))) {
    return { cwd: cur, switched: false };
  }

  // ② target inside the current CWD's watched directories (watchPaths, repoRoot ?? path) → switch to that watched directory (deepest)
  const watchCands: string[] = [];
  for (const w of Array.isArray(opts.watchPaths) ? opts.watchPaths : []) {
    if (typeof w === "string") { if (w) watchCands.push(w); continue; }
    const o = (w ?? {}) as { path?: string | null; repoRoot?: string | null };
    watchCands.push(normDir(o.repoRoot || o.path || ""));
  }
  const wh = longestCovering(target, watchCands) ?? (dir && dir !== target ? longestCovering(dir, watchCands) : null);
  if (wh) return { cwd: wh, switched: !!cur && wh !== cur };

  // ③ target inside an existing workspace (sidebar dropdown candidates) → use the longest covering entry
  const wsCands = (Array.isArray(opts.knownWorkspaces) ? opts.knownWorkspaces : []).filter(Boolean) as string[];
  const ws = longestCovering(target, wsCands) ?? (dir && dir !== target ? longestCovering(dir, wsCands) : null);
  if (ws) return { cwd: ws, switched: !!cur && ws !== cur };

  // ④ its own directory: strip common directory names upward; if the stripped result hits a workspace, use that workspace
  const stripped = stripCommonDirs(dir || target, opts.excludeNames);
  const ws2 = longestCovering(stripped, wsCands);
  const out = ws2 || stripped || dir || target || "";
  return { cwd: out, switched: !!cur && out !== cur };
}

/**
 * @-mention text: same format as the host's `pi-web/lib/file-fuzzy.ts` `buildAtMentionText` (quotes around spaces, trailing slash for directories).
 * Pass the path as it should finally display (the caller decides relative/absolute); this function only handles the `@` and quoting.
 */
export function buildAtText(path: string, isDir?: boolean): string {
  const p = isDir ? path.replace(/\\/g, "/").replace(/\/+$/, "") + "/" : path;
  return p.includes(" ") ? `@"${p}" ` : `@${p} `;
}

// ── Known workspace list (derived from the host's /api/sessions, aligned with the sidebar workspace dropdown) ──────────
// Module-level TTL cache (60s): a Memory cache of one-shot fetches, no timers (polling-forbidden red-line self-check);
// failures silently degrade to [] (local resolution as fallback) and enter a cooldown to avoid refetch loops during brief network faults.
const KNOWN_WS_TTL_MS = 60_000;
const wsCache: { t: number; list: string[] } = { t: 0, list: [] };

export function _resetWsCacheForTest(): void { wsCache.t = 0; wsCache.list = []; }

async function fetchKnownWorkspaces(apiUrl: (path: string) => string, fetchFn: typeof fetch): Promise<string[]> {
  const now = Date.now();
  if (now - wsCache.t < KNOWN_WS_TTL_MS) return wsCache.list;
  try {
    const r = await fetchFn(apiUrl("/api/sessions"), { headers: { accept: "application/json" } });
    const d = await r.json().catch(() => null) as { sessions?: Array<{ projectRoot?: string; cwd?: string }> } | null;
    const set = new Set<string>();
    for (const s of d?.sessions ?? []) {
      const root = normDir((s as any)?.projectRoot ?? (s as any)?.cwd ?? "");
      if (root) set.add(root);
    }
    wsCache.list = [...set];
  } catch {
    wsCache.list = [];
  }
  wsCache.t = now;
  return wsCache.list;
}

/**
 * Client convenience: fast path (target inside the current CWD → keep with zero requests) → when further resolution
 * is needed, fetch known workspaces (/api/sessions-derived, TTL-cached) + POST the git-trace endpoint (watched paths +
 * cross-check against the known list) → on failure fall back to local resolution (knownWorkspaces in hand, watchPaths absent).
 * Returns the final cwd string; the caller dispatches pi-web:new-session from it.
 * @param apiUrl the extension's own apiUrl (host-shim) — used to build the git-trace endpoint and the host's /api/sessions
 * @param fetchFn for test injection (defaults to browser fetch)
 */
export async function resolveNewSessionCwdClient(opts: {
  targetDir: string;
  targetPath?: string | null;
  currentCwd?: string | null;
  apiUrl: (path: string) => string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const target = normDir(opts.targetPath || opts.targetDir || "");
  const cur = normDir(opts.currentCwd || "");
  // fast path: the current CWD covers the target → keep (zero requests; v2's only short-circuit point — without a cwd, ②③④ normalization still applies)
  if (cur && target && pathCovers(cur, target)) return cur;
  // empty target (path-less scenarios like message references) → always keep current
  if (!opts.targetDir && !opts.targetPath) return cur;
  const fetchFn = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const knownWs = await fetchKnownWorkspaces(opts.apiUrl, fetchFn);
  try {
    const r = await fetchFn(opts.apiUrl("/api/extensions/aiti-git-trace/new-session-cwd"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetDir: opts.targetDir, targetPath: opts.targetPath || "", cwd: opts.currentCwd || "",
        knownWorkspaces: knownWs,
      }),
    });
    const d = await r.json().catch(() => ({} as any));
    if (d?.ok && typeof d.cwd === "string" && d.cwd) return d.cwd;
  } catch { /* endpoint absent/failed → local resolution as fallback (fail-silent) */ }
  return resolveNewSessionCwd({
    targetDir: opts.targetDir, targetPath: opts.targetPath, currentCwd: opts.currentCwd, knownWorkspaces: knownWs,
  }).cwd;
}

/**
 * Full @-to-new-session action (client only): writes the pending composer prefill → CWD resolution (v2, cross-checked
 * by the git-trace endpoint) → dispatches pi-web:new-session. Pairs with the host ChatInput consumer (15s validity).
 * @param windowRef test injection (node has no window; defaults to global window)
 */
export async function openNewSession(opts: {
  text: string;
  targetDir: string;
  targetPath?: string | null;
  currentCwd?: string | null;
  apiUrl: (path: string) => string;
  fetchFn?: typeof fetch;
  dispatch?: (evt: Event) => void; // test injection (defaults to window.dispatchEvent)
  windowRef?: { __piWebPendingComposer?: unknown } | null;
}): Promise<void> {
  const win = opts.windowRef !== undefined ? opts.windowRef : (typeof window !== "undefined" ? window : null);
  if (win) win.__piWebPendingComposer = { text: opts.text, at: Date.now() };
  const finalCwd = await resolveNewSessionCwdClient({
    targetDir: opts.targetDir, targetPath: opts.targetPath, currentCwd: opts.currentCwd, apiUrl: opts.apiUrl, fetchFn: opts.fetchFn,
  });
  const dispatch = opts.dispatch ?? ((evt: Event) => (typeof window !== "undefined" ? window : null)?.dispatchEvent?.(evt));
  dispatch(new CustomEvent("pi-web:new-session", { detail: { cwd: finalCwd } }));
}

/**
 * Unified consumer entry: prefers session-manager's `session-manager.mention` client service (capability funnel);
 * when the service is absent (session-manager disabled/not ready) → falls back to this file's same-source implementation (identical behavior).
 * @param extSvc the consumer host-shim's extSvc (wrapping `getExtService`; falls back directly when not provided)
 */
export async function openNewSessionWithExtSvc(opts: {
  text: string;
  targetDir: string;
  targetPath?: string | null;
  currentCwd?: string | null;
  apiUrl: (path: string) => string;
  extSvc?: <T>(key: string) => T | undefined;
  fetchFn?: typeof fetch;
  dispatch?: (evt: Event) => void;
  windowRef?: { __piWebPendingComposer?: unknown } | null;
}): Promise<void> {
  const svc = opts.extSvc?.("session-manager.mention") as
    | { openNewSession: (t: string, o: { targetDir: string; targetPath?: string | null; currentCwd?: string | null }) => Promise<void> }
    | undefined;
  if (svc?.openNewSession) {
    await svc.openNewSession(opts.text, { targetDir: opts.targetDir, targetPath: opts.targetPath, currentCwd: opts.currentCwd });
    return;
  }
  await openNewSession({
    text: opts.text, targetDir: opts.targetDir, targetPath: opts.targetPath, currentCwd: opts.currentCwd, apiUrl: opts.apiUrl,
    fetchFn: opts.fetchFn, dispatch: opts.dispatch, windowRef: opts.windowRef,
  });
}
