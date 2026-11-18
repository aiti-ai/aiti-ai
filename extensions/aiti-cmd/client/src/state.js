/**
 * aiti-cmd client · app store — the three dialog apps' open/selection state.
 *
 * Replaces the old module-level `{ panelOpen, view, detail }` singleton. Each app owns
 * its own slot in the store; cross-app calls go through openApp(app, payload) so a row
 * in one window can drive another (favorites ▶ → terminal, terminal ★ → favorites).
 *
 * No polling: mutations call notify(); components subscribe and re-render.
 */

export const APPS = /** @type {const} */ (["favorites", "running", "terminal"]);

/** Old single-panel float geometry key (aiti-float persists by `extId:itemId`). */
const FLOAT_LS_PREFIX = "pi-web:ext-float:v1:";
const OLD_FLOAT_KEY = FLOAT_LS_PREFIX + "aiti-cmd:aiti-cmd-panel";
const MIGRATED_FLAG = "aiti-cmd:float-key-migrated";

/** Move the old single-panel geometry onto the running app once (the old panel defaulted to the overview list). */
function migrateFloatGeometry() {
  try {
    if (localStorage.getItem(MIGRATED_FLAG)) return;
    const raw = localStorage.getItem(OLD_FLOAT_KEY);
    if (raw) localStorage.setItem(FLOAT_LS_PREFIX + "aiti-cmd:aiti-cmd-running", raw);
    localStorage.setItem(MIGRATED_FLAG, "1");
  } catch { /* private mode / quota — ignore */ }
}

export function createStore() {
  const state = {
    /** per-app window open flag (apps coexist; the title-bar switcher only raises the target) */
    open: { favorites: false, running: false, terminal: false },
    /** message-recognition command card (aiti-cmd-detail) */
    detail: null,
    detailBusy: false,
    /** favorites app: `focus` = command id to reveal after a save from another surface */
    favorites: { focus: null, create: null },
    /** running app: live | all | history · piView = agent bash live-output sub-view */
    running: { filter: "live", piView: null },
    /** terminal app: the PTY session currently rendered (a dead session keeps its tail output) */
    terminal: { sessionId: null, title: null },
  };
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* one bad listener must not break the rest */ } } };

  const get = () => state;
  const set = (patch) => { Object.assign(state, patch); notify(); };
  const setIn = (app, patch) => { state[app] = { ...state[app], ...patch }; notify(); };

  /** Open (or raise) an app window; payload fields are app-specific. */
  function openApp(app, payload = {}) {
    if (!APPS.includes(app)) return;
    const next = { ...state.open, [app]: true };
    if (app === "terminal" && payload.sessionId !== undefined) {
      state.terminal = { sessionId: payload.sessionId ? String(payload.sessionId) : null, title: payload.title || null };
    }
    if (app === "running") {
      if (payload.filter) state.running = { ...state.running, filter: payload.filter, piView: payload.piView !== undefined ? payload.piView : state.running.piView };
      else if (payload.piView !== undefined) state.running = { ...state.running, piView: payload.piView };
    }
    if (app === "favorites") {
      if (payload.focus !== undefined || payload.create !== undefined) {
        state.favorites = { focus: payload.focus ?? null, create: payload.create ?? null };
      }
    }
    state.open = next;
    notify();
  }
  function closeApp(app) {
    if (!state.open[app]) return;
    state.open = { ...state.open, [app]: false };
    notify();
  }

  /** Focus the target when `from` is given; never closes the others (windows coexist). */
  function go(from, app, payload) {
    if (from && from !== app) closeApp(from);
    openApp(app, payload);
  }

  migrateFloatGeometry();

  return { get, set, setIn, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, openApp, closeApp, go };
}

/** React hook bound to a store instance (components read store.get() each render). */
export function createUseStore(kit, store) {
  return function useStore() {
    const [, force] = kit.useState(0);
    kit.useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
    return store.get();
  };
}
