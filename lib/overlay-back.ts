"use client";

/**
 * Unified back-stack handler (overlay back stack) that closes overlays on small-screen
 * "system back".
 *
 * Scenario: when a drawer/floating window/dialog is open on a phone (left panel, right panel,
 * settings, extension floats...), the first system back (Android back button / iOS edge swipe)
 * should only close the topmost overlay and reveal the main page — not immediately leave the
 * site / exit the PWA; a second press actually goes back.
 *
 * Mechanism: when an overlay opens, push a same-URL history entry (carrying this module's token
 * in state); on popstate, close the layer matching the overlay entry being left. **History has a
 * single writer** — the host exclusively owns this module; extensions participate via the
 * acquire() of `ctx.getExtService("pi-web.overlayBack")` and must not listen to popstate
 * themselves (two stacks would stomp on each other's entries).
 *
 * Design points:
 *  - Enabling is the caller's decision (the host hook uses `isMobile`; extension consumers judge
 *    the small-screen breakpoint themselves); this module only handles the history back stack.
 *  - When the user closes via ✕ (release()), if the current history entry still belongs to this
 *    layer → `history.back()` clears the entry, avoiding a pile of empty entries after repeated
 *    open/close (otherwise many back presses would be needed to leave the site). The self-back
 *    uses a selfBacks counter to swallow the corresponding popstate, and never mis-closes a live
 *    layer inside a race window.
 *  - When system back lands on a vacant entry ("UI-closed but entry still present"), it
 *    automatically backs up one more step — the user perceives a single back returning to the
 *    non-overlay page.
 *  - Forward navigation (rare) landing on a stale entry → replaceState wipes the marker to
 *    normalize; nothing is closed. Confident forward navigation (pos crossing higher) never
 *    closes a layer.
 *  - History entry identity tracking doesn't rely only on the state KEY: an external replaceState
 *    (Next router sync) can wipe the KEY; then popCount (incremented per popstate) + lastToken
 *    determine "is the current entry still the one we pushed", keeping release self-cleanup and
 *    acquire vacant-slot reuse valid on such entries.
 *  - pushState carries state only, no URL (`pushState(state, "")`): path and query stay unchanged
 *    (the fragment would be cleared; the host app has no hash, so no impact); state is spread so
 *    Next App Router's `__NA`/internal tree survives (Next's reload detection depends on it).
 */

const KEY = "__piWebOverlayBack";
const POS_KEY = "__piWebOverlayBackPos";

export interface OverlayBackHandle {
  /** Release this layer (called when the overlay closes; idempotent). */
  release(): void;
}

interface Layer {
  token: number;
  close: () => void;
}

let installed = false;
let seq = 0;
let pos = 0;
const layers: Layer[] = [];
let lastToken: number | null = null;
let lastPos = 0;
/** History traversal count (incremented per popstate): combined with lastTokenPopCount to determine "the current entry is unchanged". */
let popCount = 0;
/** popCount when lastToken was set: only if no traversal happened since can we confirm the current entry is still the one for that token. */
let lastTokenPopCount = 0;
/** release() self-back counter: its popstate only syncs state and closes no layer. */
let selfBacks = 0;
let selfBackTimer: ReturnType<typeof setTimeout> | null = null;

function readEntry(state: unknown): { token: number | null; pos: number } {
  const o = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
  return {
    token: typeof o[KEY] === "number" ? (o[KEY] as number) : null,
    pos: typeof o[POS_KEY] === "number" ? (o[POS_KEY] as number) : 0,
  };
}

function currentEntry(): { token: number | null; pos: number } {
  return readEntry(window.history.state);
}

function isActiveToken(token: number | null): boolean {
  return token !== null && layers.some((l) => l.token === token);
}

/** Landed on a vacant entry left behind after UI close → back up one more step (still a single back from the user's perspective). */
function skipVacantEntry(token: number | null): void {
  if (token !== null && !isActiveToken(token)) {
    try {
      window.history.back();
    } catch {
      /* sandboxed environment disables history: ignore */
    }
  }
}

function onPopState(event: PopStateEvent): void {
  const from = lastToken;
  const fromPos = lastPos;
  popCount += 1;
  const to = readEntry(event.state);
  lastToken = to.token;
  lastPos = to.pos;
  lastTokenPopCount = popCount;
  if (selfBacks > 0) {
    selfBacks -= 1;
    if (selfBackTimer) {
      clearTimeout(selfBackTimer);
      selfBackTimer = null;
    }
    // Self-cleanup back: closes no layer — even in a race window where a just-opened new layer's entry got swallowed, a live layer is never mis-closed
    return;
  }
  const forward = to.pos > fromPos;
  // "Confident forward": crossing from a pos>0 entry to a higher pos — no closing, only
  // normalizing stale entries.
  // fromPos=0 means we just landed on an entry whose marker was wiped; direction is untrusted —
  // treat as back (better to close than to miss).
  const confidentForward = forward && fromPos > 0;
  if (confidentForward) {
    if (to.token !== null && !isActiveToken(to.token)) {
      try {
        window.history.replaceState({ ...(event.state ?? {}), [KEY]: null, [POS_KEY]: to.pos }, "");
      } catch {
        /* ignore */
      }
      lastToken = null;
    }
    return;
  }
  let closed = false;
  const idx = from === null ? -1 : layers.findIndex((l) => l.token === from);
  if (idx >= 0) {
    const [layer] = layers.splice(idx, 1);
    closed = true;
    try {
      layer.close();
    } catch {
      /* close-callback exceptions don't break the back chain */
    }
  } else if (from === null && layers.length > 0) {
    // Missing-marker fallback: an external replaceState (e.g. Next router sync) can wipe the KEY
    // on the current entry; backing out of that entry later yields from = null while the layer is
    // still alive — close the topmost layer LIFO, avoiding "back does nothing while an overlay is
    // open". Real scenario (2026-09-14 e2e): right-panel overlay (marker wiped externally) →
    // top position menu → after back closes the menu, the next back must still close the right panel.
    const layer = layers.pop();
    if (layer) {
      closed = true;
      try {
        layer.close();
      } catch {
        /* same as above */
      }
    }
  }

  if (closed) {
    // Landed on a leftover vacant slot → keep backing out to skip it (the user still feels one back)
    skipVacantEntry(to.token);
    return;
  }
  if (forward) {
    // Non-confident forward (fromPos=0): landing on a stale overlay entry just wipes the marker to normalize; nothing is closed
    if (to.token !== null && !isActiveToken(to.token)) {
      try {
        window.history.replaceState({ ...(event.state ?? {}), [KEY]: null, [POS_KEY]: to.pos }, "");
      } catch {
        /* ignore */
      }
      lastToken = null;
    }
    return;
  }
  // Back with no closable layer (e.g. backing out of a leftover vacant slot): skip the chain of vacant slots
  skipVacantEntry(to.token);
}

function ensureInstalled(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const entry = currentEntry();
  lastToken = entry.token;
  lastPos = entry.pos;
  lastTokenPopCount = popCount;
  window.addEventListener("popstate", onPopState);
}

/**
 * Whether the current history entry can still be confirmed to belong to the layer for the token:
 *   (a) the entry's KEY is the token (marker intact); or
 *   (b) the entry has no marker (wiped by an external replaceState), but no history traversal has
 *       happened since lastToken=token (popCount unchanged) — the position never moved, so the
 *       entry must be this layer's.
 * (b) keeps "close-panel self-cleanup" and "vacant-slot reuse" valid even after the marker is
 * wiped (otherwise entries would linger/accumulate).
 */
function currentEntryIsOurs(token: number): boolean {
  const cur = currentEntry();
  if (cur.token === token) return true;
  return cur.token === null && lastToken === token && lastTokenPopCount === popCount;
}

/** The current entry is a leftover we pushed whose layer was already released → acquire reuses it (replaceState) instead of pushing a new one. */
function currentEntryIsVacantSlot(): boolean {
  const cur = currentEntry();
  if (cur.token !== null) return !isActiveToken(cur.token);
  return lastToken !== null && !isActiveToken(lastToken) && lastTokenPopCount === popCount;
}

/**
 * Registers an overlay that closes on system back. Call at the moment the small-screen overlay
 * opens (React effect); returns a handle; call release() when the overlay closes. Returns a no-op
 * handle in non-browser environments.
 */
export function acquireOverlayBack(close: () => void): OverlayBackHandle {
  if (typeof window === "undefined" || typeof window.history?.pushState !== "function") {
    return { release() {} };
  }
  ensureInstalled();
  const token = ++seq;
  const layer: Layer = { token, close };
  layers.push(layer);
  const cur = currentEntry();
  // The current entry is a vacant slot left by this mechanism (UI-closed earlier) → reuse it
  // (replaceState) so history doesn't accumulate empty entries; otherwise push a new one. The
  // vacant-slot check includes the "marker wiped externally" case.
  const reuse = currentEntryIsVacantSlot();
  const base = (window.history.state && typeof window.history.state === "object"
    ? window.history.state
    : {}) as Record<string, unknown>;
  if (reuse) {
    pos = cur.pos;
    try {
      window.history.replaceState({ ...base, [KEY]: token, [POS_KEY]: pos }, "");
    } catch {
      /* ignore */
    }
  } else {
    pos = Math.max(pos, cur.pos) + 1;
    try {
      window.history.pushState({ ...base, [KEY]: token, [POS_KEY]: pos }, "");
    } catch {
      /* some environments disable history: this layer degrades to no back-to-close capability */
    }
  }
  lastToken = token;
  lastPos = pos;
  lastTokenPopCount = popCount;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      const idx = layers.findIndex((l) => l.token === token);
      if (idx >= 0) layers.splice(idx, 1);
      // The current entry is still this layer → back out to clear it; if system back already took
      // it away, the condition fails and we skip.
      // Key point 1: use currentEntryIsOurs (including the wiped-marker fallback) — after an
      //   external replaceState wipes the KEY, the old approach (looking only at entry.token)
      //   left entries lingering and accumulating round after round, backing out to an old URL.
      // Key point 2: defer the back to a microtask — when "close old + open new" happens in the
      //   same commit (e.g. tapping a sidebar file on small screens: collapse sidebar + open
      //   right panel simultaneously), the new layer's acquire first reuses this vacant entry via
      //   replaceState; the back must then be cancelled, otherwise it would also undo the new
      //   layer's history entry and back could never close the new layer.
      if (currentEntryIsOurs(token)) {
        queueMicrotask(() => {
          if (!currentEntryIsOurs(token)) return; // vacant slot was reused by a new layer / already taken away
          selfBacks += 1;
          if (selfBackTimer) clearTimeout(selfBackTimer);
          // Defensive timer: if the back produced no popstate in an extreme environment, reset the counter to avoid swallowing later genuine backs
          selfBackTimer = setTimeout(() => {
            selfBackTimer = null;
            selfBacks = 0;
          }, 2000);
          try {
            window.history.back();
          } catch {
            selfBacks = Math.max(0, selfBacks - 1);
          }
        });
      }
    },
  };
}

/** Test/debug accessor: number of currently active layers. */
export function overlayBackDepth(): number {
  return layers.length;
}
