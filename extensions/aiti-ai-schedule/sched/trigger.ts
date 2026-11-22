/**
 * trigger.ts — event-trigger manager (dsh-better-sidebar borrow plan §2.3)
 *
 * Event-triggered plans: fs.watch on user-declared paths only (event-driven, zero polling),
 * process-exit via aiti-cmd's on-exit service, webhook via a route in index.ts.
 * Fires route into Engine.fireTrigger (budget/cooldown/maxRuns semantics live there).
 * sync(plans) is called after every plan mutation and at startup; stop() on shutdown.
 */
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { isAbsolute as pathIsAbsolute } from "node:path";
import type { Plan, PlanTrigger } from "./store.ts";

export interface TriggerHooks {
  /** engine.fireTrigger — budget/cooldown/busy gating and run execution */
  fireTrigger(planId: string, source: string): { ok: boolean; reason?: string };
  isPathAllowed?(p: string): boolean;
}

interface FsWatchRec {
  path: string;
  watcher: FSWatcher;
  plans: Set<string>;
  timer: any;
  debounceMs: number;
}

export class TriggerManager {
  private hooks: TriggerHooks;
  /** path → shared watch record (same path in multiple plans = one fs.watch serving all) */
  private fsWatches = new Map<string, FsWatchRec>();
  /** planId → its watched paths (for diffing on sync) */
  private planPaths = new Map<string, Set<string>>();
  /** aiti-cmd exit subscription unsubscribe (re-resolved each sync; survives nothing) */
  private exitUnsub: (() => void) | null = null;
  /** latest process-exit plan set (subscription callback reads this live, never a stale snapshot) */
  private wantExits = new Map<string, { plan: Plan; trig: PlanTrigger }>();
  private stopped = false;

  constructor(hooks: TriggerHooks) {
    this.hooks = hooks;
  }

  /** Rebuild watchers from the current plan list. Idempotent: diff against live state. */
  sync(plans: Plan[]) {
    if (this.stopped) return;
    const want = new Map<string, { plan: Plan; trig: PlanTrigger }>();
    for (const p of plans) {
      const trig = p.trigger;
      if (!p.enabled || !trig || typeof trig !== "object") continue;
      if (trig.type === "fs-watch") want.set(p.id, { plan: p, trig });
    }
    // fs-watch: diff paths
    const nextPlanPaths = new Map<string, Set<string>>();
    for (const [planId, { plan, trig }] of want) {
      const paths = (trig.type === "fs-watch" ? trig.paths : []).filter(
        (s) => typeof s === "string" && s && pathIsAbsolute(s) && (!this.hooks.isPathAllowed || this.hooks.isPathAllowed(s)),
      );
      nextPlanPaths.set(planId, new Set(paths));
      const minDebounce = trig.type === "fs-watch" ? clampInt(trig.debounceMs, 50, 10_000, 300) : 300;
      for (const path of paths) {
        const rec = this.fsWatches.get(path);
        if (!rec) this.openWatch(path, [planId], minDebounce);
        else {
          rec.plans.add(planId);
          rec.debounceMs = Math.min(rec.debounceMs, minDebounce);
        }
      }
    }
    // close watches whose plan set shrank to nothing
    for (const [path, rec] of [...this.fsWatches]) {
      for (const planId of [...rec.plans]) {
        if (!nextPlanPaths.get(planId)?.has(path)) rec.plans.delete(planId);
      }
      if (rec.plans.size === 0) this.closeWatch(path);
    }
    this.planPaths = nextPlanPaths;
    this.syncProcessExit(want);
  }

  /** process-exit: (re)subscribe to aiti-cmd exits (service may appear/reload at any time). */
  private syncProcessExit(want: Map<string, { plan: Plan; trig: PlanTrigger }>) {
    this.wantExits = new Map([...want].filter(([, x]) => x.trig.type === "process-exit"));
    if (this.wantExits.size === 0) {
      if (this.exitUnsub) { this.exitUnsub(); this.exitUnsub = null; }
      return;
    }
    if (this.exitUnsub) return; // already subscribed; callback reads this.wantExits live
    try {
      const svc = (globalThis as Record<string, any>).__aitiScheduleCmdExitSvc;
      if (svc && typeof svc.subscribe === "function") {
        this.exitUnsub = svc.subscribe((info: { cmd?: string; sessionId: string }) => {
          for (const [planId, { trig }] of this.wantExits) {
            const cmdNeedle = typeof (trig as { cmd?: string }).cmd === "string" ? (trig as { cmd?: string }).cmd!.trim().toLowerCase() : "";
            if (cmdNeedle && !(info.cmd || "").toLowerCase().includes(cmdNeedle)) continue;
            this.hooks.fireTrigger(planId, "process-exit" + (info.cmd ? ":" + info.cmd.slice(0, 80) : ""));
          }
        }) || null;
      }
    } catch { /* aiti-cmd absent: trigger stays dormant */ }
  }

  /** Wire the aiti-cmd.on-exit service (called from index.ts startup when ctx.services exists). */
  attachCmdExitService(svc: unknown) {
    (globalThis as Record<string, any>).__aitiScheduleCmdExitSvc = svc;
    // re-resolve immediately: a service arriving late should not wait for the next plan mutation
    if (this.exitUnsub) { this.exitUnsub(); this.exitUnsub = null; }
    this.syncProcessExit(this.wantExits);
  }

  /** Webhook hit (route in index.ts): token already verified by caller. */
  fireWebhook(planId: string): { ok: boolean; reason?: string } {
    return this.hooks.fireTrigger(planId, "webhook");
  }

  private openWatch(path: string, planIds: string[], debounceMs: number) {
    try {
      const rec: FsWatchRec = { path, watcher: null as unknown as FSWatcher, plans: new Set(planIds), timer: null, debounceMs };
      rec.watcher = fsWatch(path, { persistent: false, recursive: false }, () => this.onFsEvent(path));
      rec.watcher.on("error", () => this.closeWatch(path)); // deleted/unreadable target → drop quietly
      this.fsWatches.set(path, rec);
    } catch (e) {
      console.warn("[aiti-ai-schedule] fs-watch 启动失败 " + path + ": " + (e instanceof Error ? e.message : e));
    }
  }

  private onFsEvent(path: string) {
    const rec = this.fsWatches.get(path);
    if (!rec) return;
    if (rec.timer) return; // debounce: one fire per burst
    rec.timer = setTimeout(() => {
      rec.timer = null;
      for (const planId of rec.plans) this.hooks.fireTrigger(planId, "fs-watch:" + path);
    }, rec.debounceMs);
    rec.timer.unref?.();
  }

  private closeWatch(path: string) {
    const rec = this.fsWatches.get(path);
    if (!rec) return;
    this.fsWatches.delete(path);
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    try { rec.watcher.close(); } catch { /* already gone */ }
  }

  stop() {
    this.stopped = true;
    for (const path of [...this.fsWatches.keys()]) this.closeWatch(path);
    if (this.exitUnsub) { this.exitUnsub(); this.exitUnsub = null; }
  }
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
