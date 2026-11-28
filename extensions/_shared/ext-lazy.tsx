/**
 * _shared/ext-lazy.tsx — standard lazy-loading infrastructure for re-splitting eager
 * extensions (plan pi-web-eager-ext-split-plan.md §4.1).
 *
 * Background: the eager-extension batch bundle (host lib/ext/client-bundle.ts v4) externalizes the
 * static relative imports of extensions whose entry static closure contains relative dynamic
 * imports (usesLazyChunks) into file URLs — the extension side only needs a "thin-shell entry +
 * dynamic import of the heavy module" to split safely. The shared entry chunk (host-shim,
 * _shared/*, dock state machine) is collected by vite/rollup into a shared chunk: a single runtime
 * instance, no globalThis-style fallback hacks (the old aiti-git-trace hack is no longer needed).
 *
 * This module provides two standard seams; extension thin shells pick one or combine both:
 *  1. createLazyModule(loader) — imperative seam: at user-interaction points
 *     `ref.load().then(m => m.api())`; on the render side `ref.useModule()` subscribes to readiness
 *     (no polling; load is an idempotent singleton, failure resets so it can retry).
 *  2. lazyExtView(opts) — declarative seam: lazy-view wrapper for **always-mounted slots** such as
 *     dialogs/pages, hard-wiring "import only when active" into the implementation (active=false
 *     renders null and never imports) — these slots always render their item component (returns
 *     null when closed), so the import must never hang off mount (§3.3).
 *
 * Constraints (plan §9):
 *  - load must receive a **module-level stable reference** (function / same ref object) — the
 *    singleton cache keys on reference identity (WeakMap);
 *  - hooks inside lazy chunks go through the shared entry chunk's host-shim (rollup hoists
 *    automatically; the batch bundle already guarantees a single instance);
 *  - waiting is always Promise/subscription; polling is forbidden (global convention).
 */
import { useEffect, useState, createElement as h } from "react";

/* ── singleton import (same loader reference shares one import; failure resets → next load retries) ── */

const importSingletons = new WeakMap<object, { promise: Promise<Record<string, any>> | null }>();

function loadViaSingleton(key: object, load: () => Promise<Record<string, any>>): Promise<Record<string, any>> {
  let entry = importSingletons.get(key);
  if (!entry) {
    entry = { promise: null };
    importSingletons.set(key, entry);
  }
  if (!entry.promise) {
    // Wrapped in Promise.resolve().then so a synchronous throw inside the loader's import()
    // (invalid path etc.) also takes the async rejection path
    entry.promise = Promise.resolve()
      .then(load)
      .catch((e) => {
        entry!.promise = null; // failure reset: next load() re-imports (retry allowed)
        throw e;
      });
  }
  return entry.promise;
}

function defaultOnError(e: unknown): void {
  try { console.error("[ext-lazy] lazy chunk failed to load (retries when the gate next opens)", e); } catch { /* ignore */ }
}

/* ── imperative seam: lazy module ref (idempotent load + readiness subscription + useModule hook) ── */

export interface LazyModuleRef<T extends Record<string, any>> {
  /** Trigger loading (idempotent; resolves the same module instance once ready; calling after a failure retries). */
  load(): Promise<T>;
  /** The loaded module instance; null when not ready (synchronous, render-safe). */
  current(): T | null;
  /** Whether it is ready. */
  ready(): boolean;
  /** Readiness subscription: called back when the module arrives (does not fire immediately when
   *  already ready — callers check current() first). */
  subscribe(cb: () => void): () => void;
  /** React hook: subscribes to readiness, returns the module (null when not ready). Must be called
   *  at the top level of a component. */
  useModule(): T | null;
}

export function createLazyModule<T extends Record<string, any>>(load: () => Promise<T>): LazyModuleRef<T> {
  let mod: T | null = null;
  let promise: Promise<T> | null = null;
  const subs = new Set<() => void>();
  const ref: LazyModuleRef<T> = {
    load() {
      if (mod) return Promise.resolve(mod);
      if (!promise) {
        promise = (Promise.resolve().then(load) as Promise<T>).then(
          (m) => {
            mod = m;
            for (const cb of [...subs]) { try { cb(); } catch { /* noop */ } }
            return m;
          },
          (e) => {
            promise = null; // failure reset: next load() retries
            throw e;
          },
        );
      }
      return promise;
    },
    current: () => mod,
    ready: () => mod != null,
    subscribe(cb) {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
    useModule() {
      const [m, setM] = useState<T | null>(() => mod);
      useEffect(() => {
        let alive = true;
        if (mod) { setM(mod); return; } // subscription later than readiness: catch up once
        const unsub = ref.subscribe(() => { if (alive) setM(mod); });
        return () => { alive = false; unsub(); };
      }, []);
      return m;
    },
  };
  return ref;
}

/* ── declarative seam: lazy-view wrapper for always-mounted slots ── */

export interface LazyExtViewOpts {
  /** Gate (useGate/usePresent/open state/feature). false → renders null and never imports. */
  active: boolean;
  /** Lazy module loader: a module-level stable function, or the ref returned by createLazyModule
   *  (shares the same singleton). */
  load: (() => Promise<Record<string, any>>) | LazyModuleRef<Record<string, any>>;
  /** Which module export to use as the component. */
  pick: string;
  /** Optional loading placeholder (default null; not shown after a failure — the failed state renders null). */
  fallback?: () => unknown;
  /** Load-failure callback (default console.error; failure resets, auto-retries when the gate next opens). */
  onError?: (e: unknown) => void;
  /** Props passed through to the target component (dialogs/pages slot hosts pass props). */
  props?: Record<string, unknown>;
}

/**
 * Call **inside a component's render body** (uses hooks internally, must be called
 * unconditionally); returns an element:
 *   active=false → null (and no import); active=true → triggers load() (idempotent singleton),
 *   once ready h(mod[pick], props); while loading fallback() (default null); on failure onError + null.
 */
export function lazyExtView(opts: LazyExtViewOpts): unknown {
  const { active, pick, fallback, onError, props } = opts;
  // Normalize load → thunk (refs use object identity as the singleton key; bare functions use function identity)
  const thunk = typeof opts.load === "function"
    ? opts.load as () => Promise<Record<string, any>>
    : () => opts.load.load();
  const singletonKey = typeof opts.load === "function" ? thunk : opts.load;

  const [mod, setMod] = useState<Record<string, any> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setFailed(false); // new attempt: clear the failed state (gate false→true means retry)
    loadViaSingleton(singletonKey, thunk).then(
      (m) => { if (alive) setMod(m); },
      (e) => {
        if (!alive) return;
        setFailed(true);
        (onError ?? defaultOnError)(e);
      },
    );
    return () => { alive = false; };
    // The first active=true and every later false→true re-runs this effect (failure retry hangs here);
    // a failure while active stays true does not auto-retry (no polling/loops).
  }, [active]);

  if (!active) return null;
  if (mod) {
    const Comp = mod[pick];
    if (typeof Comp === "function") return h(Comp as any, props ?? {});
    // A missing export is treated as a failure (via the onError channel), rendering null
    (onError ?? defaultOnError)(new Error(`[ext-lazy] module export missing "${pick}"`));
    return null;
  }
  if (failed) return null;
  return fallback ? fallback() : null;
}

/**
 * Component-shaped wrapper for JSX conditional rendering (the component version of lazyExtView):
 *   <LazyMount active={open} load={ref} pick="DirectoryPicker" initialPath={x} .../>
 * active=false renders null and never imports; other semantics match lazyExtView. The rest props
 * pass through to the target component.
 */
export function LazyMount({ active, load, pick, fallback, onError, ...rest }: {
  active: boolean;
  load: (() => Promise<Record<string, any>>) | LazyModuleRef<Record<string, any>>;
  pick: string;
  fallback?: () => unknown;
  onError?: (e: unknown) => void;
} & Record<string, unknown>): unknown {
  return lazyExtView({ active, load, pick, fallback, onError, props: rest });
}
