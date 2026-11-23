/**
 * watch.ts — directory live watch (dsh-better-sidebar borrow plan §2.4; self-contained and directly
 * testable, same spot as git-plan).
 *
 * Isomorphic to ed-watch, directory granularity: the client POSTs /watch per expanded directory for
 * a watchId; frames go out via __piPageEvents.publish("folder-watch") onto the bus (low-freq dual-feed
 * channel, like ed-watch); 300ms debounce; 30min with no events auto-stops (leak guard); a deleted or
 * unreadable dir emits a gone frame and is removed; the client POSTs /watch-stop on collapse/tab close.
 * fs.watch is non-recursive on Linux — which exactly matches the per-directory lazy-load tree model.
 */
import { watch as fsWatch, existsSync, statSync, type FSWatcher } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";

const FOLDER_WATCH_DEBOUNCE_MS = 300;
const FOLDER_WATCH_IDLE_STOP_MS = 30 * 60_000;
const FOLDER_WATCH_MAX = 200;
// Git status refresh result cache: an entry's ignored/tracked answer rarely changes
// between bursts, and spawning two git processes per burst while an agent writes
// files would cost more than the refresh it gates.
const IGNORE_TTL_MS = 60_000;
const IGNORE_GIT_TIMEOUT_MS = 5_000;

interface FolderWatchRecord {
  id: string;
  dir: string;
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  lastFire: number;
  idleTimer: ReturnType<typeof setInterval> | null;
  /** names collected in the current debounce window */
  pending: Set<string>;
  /** true once a pending batch is being filtered (events keep collecting meanwhile) */
  flushing: boolean;
  /** name → ignored-by-git (and not tracked), cached with IGNORE_TTL_MS */
  ignored: Map<string, { v: boolean; at: number }>;
}

// Extension hot reload replaces this module but not the fs.watch handles the
// previous instance opened: their callbacks keep running (and keep publishing
// with the old code), while /watch-stop lands in the new, empty map and cannot
// close them. Keeping the records on globalThis lets the reloaded module re-arm
// those watches with the current handler instead of leaking the old one.
const WATCH_REGISTRY: symbol = Symbol.for("pi-web:aiti-folder:watches");
function folderWatches(): Map<string, FolderWatchRecord> {
  const store = globalThis as Record<symbol, unknown>;
  let map = store[WATCH_REGISTRY] as Map<string, FolderWatchRecord> | undefined;
  if (!map) { map = new Map(); store[WATCH_REGISTRY] = map; }
  return map;
}

function disarm(rec: FolderWatchRecord): void {
  try { rec.watcher?.close(); } catch { /* already gone */ }
  rec.watcher = null;
  if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
  if (rec.idleTimer) { clearInterval(rec.idleTimer); rec.idleTimer = null; }
}

/** Run a read-only git command in `dir`; resolves the exit code and stdout (never throws). */
function runGit(dir: string, args: string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["-C", dir, "-c", "core.fsmonitor=false", ...args],
      { timeout: IGNORE_GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? -1 : 0;
        resolve({ code, stdout: String(stdout ?? "") });
      },
    );
    // Outside a work tree git exits without reading its input; swallow the EPIPE.
    child.stdin?.on("error", () => { /* ignore */ });
    child.stdin?.end(input ?? "");
  });
}

/**
 * Which of `names` are git-ignored *and* not tracked — the same question the file
 * listing answers with `hidden: "ignored"` (tracked names stay visible there, so a
 * force-added file keeps refreshing). null = no answer (not a repo / git missing):
 * the caller then keeps every name rather than silently dropping refreshes.
 */
async function ignoredNames(dir: string, names: readonly string[]): Promise<Set<string> | null> {
  const input = names.join("\0") + "\0";
  const check = await runGit(dir, ["check-ignore", "--no-index", "-z", "--stdin"], input);
  // 0 = some matched, 1 = none matched, anything else = git could not answer.
  if (check.code !== 0 && check.code !== 1) return null;
  const matched = new Set(check.stdout.split("\0").filter(Boolean));
  if (matched.size === 0) return matched;
  const tracked = await runGit(dir, ["ls-files", "-z", "--cached", "--", ...matched]);
  if (tracked.code !== 0) return matched;
  for (const name of tracked.stdout.split("\0")) if (name) matched.delete(name);
  return matched;
}

/** Names of one debounce batch that are worth a refresh frame. */
async function keepChanged(rec: FolderWatchRecord, names: readonly string[]): Promise<boolean> {
  // A null filename means the platform did not say what changed: never suppress it.
  if (names.some((name) => name === "")) return true;
  const now = Date.now();
  const stale: string[] = [];
  const cachedIgnored = new Set<string>();
  for (const name of names) {
    if (name === ".git") { cachedIgnored.add(name); continue; }
    const hit = rec.ignored.get(name);
    if (hit && now - hit.at < IGNORE_TTL_MS) { if (hit.v) cachedIgnored.add(name); }
    else stale.push(name);
  }
  if (stale.length > 0) {
    const answer = await ignoredNames(rec.dir, stale);
    // A long-lived watch in a noisy tree must not grow this map without bound.
    if (rec.ignored.size > 4000) rec.ignored.clear();
    if (answer === null) {
      for (const name of stale) rec.ignored.set(name, { v: false, at: now });
    } else {
      for (const name of stale) {
        const v = answer.has(name);
        rec.ignored.set(name, { v, at: now });
        if (v) cachedIgnored.add(name);
      }
    }
  }
  // Editing the ignore rules must not wait out the cache.
  if (names.some((name) => name === ".gitignore" || name === ".git/info/exclude")) rec.ignored.clear();
  return names.some((name) => !cachedIgnored.has(name));
}

function arm(rec: FolderWatchRecord): void {
  disarm(rec);
  // Records created by an older module version lack the batch/filter fields:
  // normalise before use (a reload must never fail on its predecessor's shape).
  rec.pending ??= new Set<string>();
  rec.ignored ??= new Map<string, { v: boolean; at: number }>();
  rec.flushing = false;
  rec.lastFire = Date.now();
  rec.pending.clear();
  rec.idleTimer = setInterval(() => { if (Date.now() - rec.lastFire > FOLDER_WATCH_IDLE_STOP_MS) stopFolderWatch(rec.id); }, 60_000);
  rec.idleTimer.unref?.();
  const flush = async () => {
    rec.timer = null;
    if (rec.flushing) return; // the running batch reschedules when it finishes
    const names = [...rec.pending];
    rec.pending.clear();
    if (names.length === 0) return;
    rec.flushing = true;
    try {
      if (await keepChanged(rec, names)) {
        rec.lastFire = Date.now();
        publishFolderWatch(rec.id, { dir: rec.dir });
      }
    } catch { /* filtering must never stop the watch */ }
    finally {
      rec.flushing = false;
      if (rec.pending.size > 0) schedule();
    }
  };
  const schedule = () => {
    if (rec.timer) return; // debounce: all names of one burst share one check
    rec.timer = setTimeout(() => { void flush(); }, FOLDER_WATCH_DEBOUNCE_MS);
    rec.timer.unref?.();
  };
  const fire = (eventType?: string, filename?: string | null) => {
    // Windows reports a write to any file inside an immediate child directory as
    // "change <child-dir>". That child's own entry in this listing did not move,
    // so a directory "change" carries nothing to show; refreshing on it makes a
    // repo panel loop: git status rewrites .git/index (optional lock) → frame →
    // tree refresh → /api/git/status → git status → frame ... Add/remove/rename
    // events still refresh, and the child directory's own watch covers its files.
    if (eventType === "change" && filename) {
      let isDirectory = false;
      try { isDirectory = statSync(join(rec.dir, filename)).isDirectory(); } catch { /* entry vanished */ }
      if (isDirectory) return;
    }
    rec.pending.add(filename == null ? "" : String(filename));
    schedule();
  };
  try {
    rec.watcher = fsWatch(rec.dir, { persistent: false, recursive: false }, (eventType, filename) => fire(eventType, filename == null ? null : String(filename)));
    rec.watcher.on("error", () => { publishFolderWatch(rec.id, { dir: rec.dir, gone: true }); stopFolderWatch(rec.id); });
  } catch { stopFolderWatch(rec.id); }
}

// A reloaded module takes over the watches its predecessor left open (same ids):
// re-arm them so the current filtering applies and the old callbacks go quiet.
for (const rec of folderWatches().values()) {
  try { arm(rec); } catch { try { stopFolderWatch(rec.id); } catch { /* ignore */ } }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function publishFolderWatch(id: string, data: Record<string, unknown>): void {
  try { (globalThis as any).__piPageEvents?.publish("folder-watch", { id, ...data }); } catch { /* page-event outlet absent */ }
}

export function stopFolderWatch(id: string): void {
  const rec = folderWatches().get(id);
  if (!rec) return;
  folderWatches().delete(id);
  disarm(rec);
}

export function startFolderWatch(id: string, dir: string): void {
  stopFolderWatch(id);
  const rec: FolderWatchRecord = {
    id, dir, watcher: null, timer: null, lastFire: Date.now(), idleTimer: null,
    pending: new Set(), flushing: false, ignored: new Map(),
  };
  folderWatches().set(id, rec);
  arm(rec);
}

/** Watch endpoints (route = last pathname segment); non-module routes return null for the main api. */
export async function folderWatchApi(req: Request, ctx: any, route: string): Promise<Response | null> {
  // POST /watch { dir } → start a directory watch (same allowedDir security surface) → { ok, id }
  if (route === "watch" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const dir = typeof body?.dir === "string" ? body.dir : "";
    if (!dir || !isAbsolute(dir)) return json({ ok: false, error: "需要绝对路径" }, 400);
    const root = normalize(dir);
    try { if (!(await ctx?.core?.fileAccess?.isAllowed?.(root))) return json({ ok: false, error: "目录不在可读范围" }, 403); } catch { return json({ ok: false, error: "目录不在可读范围" }, 403); }
    if (!existsSync(root)) return json({ ok: false, error: "目录不存在" }, 404);
    const id = "fw-" + randomBytes(8).toString("hex");
    startFolderWatch(id, root);
    // Cap guard (normally the client stops watches on collapse/close): drop the least recently active one
    if (folderWatches().size > FOLDER_WATCH_MAX) {
      let oldest: string | null = null;
      for (const k of folderWatches().keys()) if (oldest === null || folderWatches().get(k)!.lastFire < folderWatches().get(oldest)!.lastFire) oldest = k;
      if (oldest) stopFolderWatch(oldest);
    }
    return json({ ok: true, id });
  }
  // POST /watch-stop { id | ids[] } → remove watch(es)
  if (route === "watch-stop" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const ids: unknown[] = Array.isArray(body?.ids) ? body.ids : [body?.id];
    for (const id of ids) if (typeof id === "string") stopFolderWatch(id);
    return json({ ok: true });
  }
  return null;
}
