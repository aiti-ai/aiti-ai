/**
 * folder-watch — directory live-watch client (dsh-better-sidebar borrow plan §2.4)
 *
 * One watch per expanded directory (DSH perf discipline: never watch the whole tree): a TreeNode
 * expanded → watchDir(dir) → POST /watch for a watchId → server fs.watch frames come back over the
 * event-bus topic "folder-watch" → this module fans frames out to per-dir listeners ({ type, id, dir, gone? }).
 * The off() returned on collapse/unmount decrements the refcount; at zero it POSTs /watch-stop.
 * event-bus topics absent → degrade silently to a static tree (same pattern as ed-watch).
 */
import { apiUrl, extSvc } from "./host-shim";

export type FolderWatchFrame = { type?: string; id?: string; dir?: string; gone?: boolean };
type FrameHandler = (f: FolderWatchFrame) => void;

const handlers = new Map<string, Set<FrameHandler>>(); // dir → handlers
const watchIds = new Map<string, string>();            // dir → watchId
const refs = new Map<string, number>();                // dir → refcount
let unsub: (() => void) | null = null;
let busFailed = false;

/** Subscribe to event-bus topics once (broker singleton; multi-instance panels share this module state) */
function ensureBus(): void {
  if (unsub || busFailed) return;
  try {
    const svc = extSvc?.("aiti-event-bus.subscribe-topics") as
      | ((h: FrameHandler, types: string[]) => { ready?: Promise<void>; off: () => void })
      | undefined;
    if (typeof svc !== "function") { busFailed = true; return; }
    const sub = svc((f: FolderWatchFrame) => {
      if (!f || f.type !== "folder-watch" || typeof f.dir !== "string") return;
      const set = handlers.get(f.dir);
      if (!set) return;
      for (const h of [...set]) { try { h(f); } catch { /* one bad listener must not break others */ } }
    }, ["folder-watch"]);
    if (sub && typeof sub.off === "function") unsub = () => sub.off();
    else busFailed = true;
  } catch { busFailed = true; }
}

async function requestWatch(dir: string): Promise<void> {
  try {
    const r = await fetch(apiUrl("/api/extensions/aiti-folder/watch"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir }),
    });
    const d = await r.json();
    if (d?.ok && typeof d.id === "string") watchIds.set(dir, d.id);
  } catch { /* server absent → static tree degradation */ }
}

async function releaseWatch(dir: string): Promise<void> {
  const id = watchIds.get(dir);
  watchIds.delete(dir);
  if (!id) return;
  try {
    await fetch(apiUrl("/api/extensions/aiti-folder/watch-stop"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }),
    });
  } catch { /* ignore */ }
}

/**
 * Watch one directory while the returned disposer is alive (refcounted per dir).
 * Caller supplies the per-dir callback (frames already filtered to this dir by the bus).
 */
export function watchDir(dir: string, onFrame: FrameHandler): () => void {
  ensureBus();
  let set = handlers.get(dir);
  if (!set) { set = new Set(); handlers.set(dir, set); }
  set.add(onFrame);
  const n = (refs.get(dir) || 0) + 1;
  refs.set(dir, n);
  if (n === 1) void requestWatch(dir);
  return () => {
    const s = handlers.get(dir);
    if (s) { s.delete(onFrame); if (s.size === 0) handlers.delete(dir); }
    const left = (refs.get(dir) || 1) - 1;
    if (left <= 0) { refs.delete(dir); void releaseWatch(dir); }
    else refs.set(dir, left);
  };
}
