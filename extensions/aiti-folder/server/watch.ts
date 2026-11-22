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
import { watch as fsWatch, existsSync, type FSWatcher } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { randomBytes } from "node:crypto";

const FOLDER_WATCH_DEBOUNCE_MS = 300;
const FOLDER_WATCH_IDLE_STOP_MS = 30 * 60_000;
const FOLDER_WATCH_MAX = 200;

const folderWatches = new Map<string, { dir: string; watcher: FSWatcher | null; timer: any; lastFire: number; idleTimer: any }>();

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
  const rec = folderWatches.get(id);
  if (!rec) return;
  folderWatches.delete(id);
  try { rec.watcher?.close(); } catch { /* already gone */ }
  if (rec.timer) clearTimeout(rec.timer);
  if (rec.idleTimer) clearInterval(rec.idleTimer);
}

export function startFolderWatch(id: string, dir: string): void {
  stopFolderWatch(id);
  const rec: { dir: string; watcher: FSWatcher | null; timer: any; lastFire: number; idleTimer: any } = { dir, watcher: null, timer: null, lastFire: Date.now(), idleTimer: null };
  rec.idleTimer = setInterval(() => { if (Date.now() - rec.lastFire > FOLDER_WATCH_IDLE_STOP_MS) stopFolderWatch(id); }, 60_000);
  rec.idleTimer.unref?.();
  const fire = () => {
    if (rec.timer) return; // debounce: one frame per burst
    rec.timer = setTimeout(() => { rec.timer = null; rec.lastFire = Date.now(); publishFolderWatch(id, { dir }); }, FOLDER_WATCH_DEBOUNCE_MS);
    rec.timer.unref?.();
  };
  try {
    rec.watcher = fsWatch(dir, { persistent: false, recursive: false }, () => fire());
    rec.watcher.on("error", () => { publishFolderWatch(id, { dir, gone: true }); stopFolderWatch(id); });
  } catch { stopFolderWatch(id); return; }
  folderWatches.set(id, rec);
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
    if (folderWatches.size > FOLDER_WATCH_MAX) {
      let oldest: string | null = null;
      for (const k of folderWatches.keys()) if (oldest === null || folderWatches.get(k)!.lastFire < folderWatches.get(oldest)!.lastFire) oldest = k;
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
