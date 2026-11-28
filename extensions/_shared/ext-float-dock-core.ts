/**
 * _shared/ext-float-dock-core.ts — the sidebar dock block stack's **pure state layer**
 * (zero react import).
 *
 * Split rationale (sidebar unified dock plan §3.8): the aiti-float bundle itself does no
 * react aliasing (zero React references in the artifact), yet its DockStack container
 * needs collapse/order read-write and migration logic — these are pure localStorage +
 * window events, no React; the React bindings (useBlockCollapsed / useDockOrder /
 * DockBody) stay in ext-float-dock.ts (inlined into each extension bundle, react alias
 * → host-shim).
 *
 * Single source of truth = localStorage (converges even with zero shared module
 * instances across bundles/extensions); changes broadcast via window events (event
 * driven, zero polling). Subscribers = the aiti-float DockStack container + DockBody header.
 *
 * Icon rows (v5, plan docs/pi-web-dock-icon-row-plan.md): the position menu / move
 * operations switched from text items to one row of unambiguous icons (icon data in
 * ./dock-icons.ts); this file's positionMenuModel/positionMenuItems produce the unified
 * model and appendDockIconRow serves the DOM side (D2 aiti-float / D3 fallback layer).
 */
import { dockIconOfZone, createDockIconSvg, type DockIconName } from "./dock-icons.ts";

/* ── Sidebar block zone generalization (sidebar unified dock plan §3.8) ──
 * Canonical zone value = `sidebar:<itemKey>` (one block identity per panel; blockKey is
 * the itemKey — collapse/order memory keys land directly on itemKey); the legacy
 * "sidebar-explorer" value stays readable forever (persisted legacy dockpref / panels
 * in the wild). DockStack uses isSidebarDockState for membership. */
export type DockZone = "sidebar-explorer" | "right-panel" | `sidebar:${string}`;
export type PresentState = "closed" | "floating" | `docked:${string}`;

export function sidebarZoneOf(itemKey: string): `sidebar:${string}` {
  return `sidebar:${itemKey}`;
}
/** Whether the present state lands in a sidebar block (canonical sidebar:* or legacy sidebar-explorer). */
export function isSidebarDockState(state: PresentState | string): boolean {
  return state === "docked:sidebar-explorer" || state.startsWith("docked:sidebar:");
}

/* ── Drag-in drop-target resolution (aiti-float-dock-drag-drop-unify-plan §3.1) ──
 * The drop marker is public DOM (whoever owns the berth stamps data-ext-float-dock-zone),
 * while a sidebar zone value is per-panel-private sidebar:<itemKey> — a public drop
 * target can only stamp the wildcard. Marker value = wildcard "sidebar"; on a drag hit
 * the real landing is resolved against the dragging panel's own declared zones. */
export const SIDEBAR_DROP_ZONE = "sidebar";

/** Drop-marker zone → the dragging panel's real landing: a marker inside the panel's
 *  declared zones returns as-is (existing behavior);
 *  wildcard "sidebar" → the panel's first declared sidebar:* zone (legacy
 *  sidebar-explorer accepted too);
 *  returns null when no landing fits (release does not dock; the float window stays put). */
export function resolveDropZone(markerZone: string, declaredZones: readonly string[]): DockZone | null {
  if (!markerZone) return null;
  if (declaredZones.includes(markerZone)) return markerZone as DockZone;
  if (markerZone === SIDEBAR_DROP_ZONE) {
    const hit = declaredZones.find((z) => z === "sidebar-explorer" || z.startsWith("sidebar:"));
    return (hit as DockZone | undefined) ?? null;
  }
  return null;
}

/* ── Sidebar block alignment grouping (v4 addendum design: dock blocks top / bottom aligned) ──
 *  Core blocks (projects, scheduled tasks) align top — pinned to the sidebar's top;
 *  lower-importance blocks (folders, docked panels, message-type) align bottom — pinned
 *  to the sidebar's bottom; an elastic gap sits between the two groups. Alignment is a
 *  declared block property (props.blocks.align / slot item meta.align), not a
 *  user-toggleable state (v1).
 *  DockStack renders groups via splitBlockAlign: effective order kept within a group;
 *  group boundaries are hard sort borders. */
export type BlockAlign = "top" | "bottom";

/** Group by the align property (input order kept = the effective order's within-group
 *  relative order). defaultAlign: the fallback when align is undeclared (resident blocks
 *  default top; dockable items got their default bottom filled at construction). */
export function splitBlockAlign<T extends { align?: BlockAlign }>(entries: T[], defaultAlign: BlockAlign = "top"): { top: T[]; bottom: T[] } {
  const top: T[] = [];
  const bottom: T[] = [];
  for (const e of entries) {
    if ((e.align ?? defaultAlign) === "bottom") bottom.push(e);
    else top.push(e);
  }
  return { top, bottom };
}

/* ── Sidebar block stack: collapse / order / legacy collapse key migration (sidebar unified dock plan §3.1/§3.6) ── */
export const SIDEBAR_COLLAPSE_PREFIX = "pi:sidebar-dock:collapsed:";
export const SIDEBAR_ORDER_KEY = "pi:sidebar-dock:order";
export const SIDEBAR_COLLAPSE_EVENT = "pi:sidebar-dock:collapsed-changed";
export const SIDEBAR_ORDER_EVENT = "pi:sidebar-dock:order-changed";
/** Move up/down requests (emitted by the DockBody ⋮ menu; the DockStack container listens — only the container knows the full stack key set). */
export const SIDEBAR_MOVE_EVENT = "pi:sidebar-dock:move";
/** Drag-reorder landing request (order v2: emitted by the DockBody header's HTML5 DnD; key-set arbitration as above). */
export const SIDEBAR_DROP_EVENT = "pi:sidebar-dock:drop";

export function readBlockCollapsed(blockKey: string): boolean {
  try { return localStorage.getItem(SIDEBAR_COLLAPSE_PREFIX + blockKey) === "1"; } catch { return false; }
}
export function writeBlockCollapsed(blockKey: string, collapsed: boolean): void {
  try { localStorage.setItem(SIDEBAR_COLLAPSE_PREFIX + blockKey, collapsed ? "1" : "0"); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(SIDEBAR_COLLAPSE_EVENT, { detail: { key: blockKey, collapsed } })); } catch { /* ignore */ }
}

/** Seed the default collapsed state (writes only when the block has no collapse record
 *  yet; same pattern as seedDockDefault). Resident blocks shown by default (projects /
 *  folders) thereby get their mandated default of "collapsed/expanded on first
 *  appearance"; after the user manually collapses/expands (writeBlockCollapsed wrote the
 *  key) the user action is respected and never overwritten. */
export function seedBlockCollapsedDefault(blockKey: string, collapsed: boolean): void {
  try {
    const k = SIDEBAR_COLLAPSE_PREFIX + blockKey;
    if (localStorage.getItem(k) === null) localStorage.setItem(k, collapsed ? "1" : "0");
  } catch { /* ignore */ }
}

/* ── Dismissed record (user close, 2026-11-21 ruling: "a closed block stays closed
 *  across refresh")──
 *  User close actions (⋮ Close / TabBar ✕) land in the present state machine's close
 *  branch, which writes 1; an explicit open (non-auto present landing in the sidebar
 *  family) clears it. Restorative auto-dock call sites ("refresh restores default
 *  presence") check this record before presenting, so a closed block is no longer
 *  resurrected by a refresh.
 *  Readers = per-extension auto-dock call points (aiti-sysmon entry, session-manager
 *  Tasks, ...); the sole writer/clearer = the present state machine (aiti-float
 *  dock.ts + localPresent below). */
export const SIDEBAR_DISMISS_PREFIX = "pi:sidebar-dock:dismissed:";
export function readBlockDismissed(blockKey: string): boolean {
  try { return localStorage.getItem(SIDEBAR_DISMISS_PREFIX + blockKey) === "1"; } catch { return false; }
}
export function writeBlockDismissed(blockKey: string, dismissed: boolean): void {
  try {
    if (dismissed) localStorage.setItem(SIDEBAR_DISMISS_PREFIX + blockKey, "1");
    else localStorage.removeItem(SIDEBAR_DISMISS_PREFIX + blockKey);
  } catch { /* ignore */ }
}

export function readDockOrder(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDEBAR_ORDER_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
export function writeDockOrder(order: string[]): void {
  try { localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(order)); } catch { /* ignore */ }
  try { window.dispatchEvent(new Event(SIDEBAR_ORDER_EVENT)); } catch { /* ignore */ }
}

/** Effective order: the user's reorder array first (∩ present keys), the rest stably
 *  appended by priority (default projects0 → tasks1 → files2 → docks3+). */
export function effectiveBlockOrder<T extends { key: string; priority?: number }>(entries: T[], order: string[]): T[] {
  const byKey = new Map(entries.map((e) => [e.key, e] as const));
  const head: T[] = [];
  for (const k of order) {
    const e = byKey.get(k);
    if (e) { head.push(e); byKey.delete(k); }
  }
  const rest = [...byKey.values()];
  const withIdx = rest.map((e, i) => ({ e, i }));
  withIdx.sort((a, b) => (a.e.priority ?? 3) - (b.e.priority ?? 3) || a.i - b.i);
  return [...head, ...withIdx.map((x) => x.e)];
}

/** Compute the full stack key order after a move (delta ±1; neighbor swap), persist and broadcast. */
export function moveBlockKey(key: string, delta: number, allKeys: string[]): void {
  const cur = effectiveBlockOrder(allKeys.map((k) => ({ key: k })), readDockOrder()).map((e) => e.key);
  const idx = cur.indexOf(key);
  if (idx < 0) return;
  const to = idx + delta;
  if (to < 0 || to >= cur.length) return;
  const next = [...cur];
  next.splice(idx, 1);
  next.splice(to, 0, key);
  writeDockOrder(next);
}

/** Drag-reorder landing (v2): move key before/after target (relative order of the other
 *  keys unchanged), persist and broadcast. */
export function moveBlockTo(key: string, target: string, allKeys: string[], before: boolean): void {
  if (key === target) return;
  const cur = effectiveBlockOrder(allKeys.map((k) => ({ key: k })), readDockOrder()).map((e) => e.key);
  const from = cur.indexOf(key);
  const to = cur.indexOf(target);
  if (from < 0 || to < 0) return;
  const next = cur.filter((k) => k !== key);
  let idx = next.indexOf(target);
  if (!before) idx += 1;
  next.splice(idx, 0, key);
  writeDockOrder(next);
}

/** One-time migration of legacy collapse keys (plan §3.1: read the four legacy keys once
 *  and migrate into pi:sidebar-dock:collapsed:*; legacy keys are kept, not deleted — a
 *  rolled-back old host can still read them; no overwrite when the new key exists,
 *  module-level once guard). */
let legacyCollapsedMigrated = false;
export function migrateLegacyCollapseKeys(): void {
  if (legacyCollapsedMigrated || typeof localStorage === "undefined") return;
  legacyCollapsedMigrated = true;
  const legacy: Array<[string, string, (v: string) => boolean]> = [
    // [legacy key, new blockKey, value → collapsed semantics] (the sm projects area
    // writes "1"/"0", host blocks write "true"/"false")
    ["pi-web:sidebar-projects-collapsed", "projects", (v) => v === "1" || v === "true"],
    ["pi-sidebar-tasks-collapsed", "tasks", (v) => v === "true" || v === "1"],
    ["pi-web:sidebar-explorer-dock-collapsed", "docks", (v) => v === "true" || v === "1"],
    // the host saveExplorerOpen stores "expanded" semantics → invert for collapsed
    ["pi-web:file-explorer:open", "files", (v) => v === "false" || v === "0"],
  ];
  for (const [oldKey, blockKey, parse] of legacy) {
    try {
      const oldVal = localStorage.getItem(oldKey);
      if (oldVal === null) continue;
      if (localStorage.getItem(SIDEBAR_COLLAPSE_PREFIX + blockKey) === null) {
        localStorage.setItem(SIDEBAR_COLLAPSE_PREFIX + blockKey, parse(oldVal) ? "1" : "0");
      }
    } catch { /* ignore */ }
  }
}

/* ── dock header toolbar store (v3; two-tier carriage: public service / local fallback) ──
 *
 * Mechanism (plan docs/pi-web-dock-header-toolbar-plan.md §2.3/§2.7):
 *   · Button definitions (actions) are declared by the extension itself (face prop /
 *     service register); DockBody renders them adaptively;
 *   · Command implementations (commands) and state (state) are registered by the content
 *     component (useDockCommands/useDockHeaderState);
 *   · Menu items (menuItems) are registered by content (head/sep/item, rendered into
 *     the ⋮ menu, for complex menus);
 *   · Command miss → pending (TTL 10s) + expand the block; run once when the command
 *     registers.
 *
 * Carriage: on install aiti-float creates the host-level store with this factory (ctx
 * service aiti-float.dock-header + window.__piweFloat.dockHeader core-reserved slot);
 * when the service is absent the _shared layer falls back to a lazy local singleton.
 * Pure logic, zero react (importable directly by server/tests).
 */

export type DockHeaderVisibility = "always" | "expanded";

/** Dock-header button definition (declared by the extension). badge = count badge
 *  (change counts etc.); active = highlighted state; done = green completed state. */
export type DockHeaderAction = {
  id: string;
  title: string;
  icon?: unknown;
  badge?: number | string;
  active?: boolean;
  done?: boolean;
  disabled?: boolean;
  /** Default always: shown both collapsed and expanded; "expanded" shows only while expanded */
  visibility?: DockHeaderVisibility;
  /** Click callback; DockBody passes the raw event (the face can take the button rect from it as a popup anchor) */
  onClick: (ev?: unknown) => void;
};

/** Content-reported state (pure data: scalars/arrays/plain objects — signature compared via JSON). */
export type DockHeaderState = Record<string, unknown>;

/** Command implementation table (id → function); payload can carry anchor rects and similar parameters. */
export type DockHeaderCommands = Record<string, ((payload?: unknown) => void) | undefined>;

/** Icon-row registration item (buttons inside an iconsRow row; icon accepts React
 *  elements — distinguishes from DockIconRowItem's DockIconName). */
export interface MenuIconRowItem {
  key: string;
  icon: unknown;
  label: string;
  run: () => void;
}

/** Extra ⋮ menu items (content-registered, rendered as extension groups after the
 *  "Tools" group).
 *  iconsRow (2026-11-24): a single row of "label left + icon buttons right" (same style
 *  as the v5 icon row), for merging multiple actions of one segment;
 *  items' icon accepts any React element (rendered by the React-side DockBody). */
export type DockMenuItem =
  | { kind: "item"; id?: string; label: string; icon?: unknown; hint?: string; active?: boolean; alwaysRun?: boolean; disabled?: boolean; run: () => void }
  | { kind: "sep"; id?: string }
  | { kind: "head"; label: string; id?: string }
  | { kind: "iconsRow"; id?: string; label?: string; items: MenuIconRowItem[] }
  /** Move-row slot: DockBody inserts the fixed "Move" icon row at this position
   *  (incl. the moveRowPin pin button) and skips the default move row at the end of the
   *  block section (moved-up semantics); without a slot the block section stays as-is. */
  | { kind: "moveRow"; id?: string };

export type DockHeaderRegistration = {
  actions?: DockHeaderAction[] | null;
  commands?: DockHeaderCommands | null;
  state?: DockHeaderState | null;
  menuItems?: DockMenuItem[] | null;
};

export type DockHeaderStore = {
  /** Partial-field merge update (updates only the passed fields); returns an unregister (clears only the fields provided this time). */
  register(key: string, reg: DockHeaderRegistration): () => void;
  /** With a command → run immediately (payload passed through), return true; without → expand the block + pending, return false. */
  request(key: string, id: string, payload?: unknown): boolean;
  actionsOf(key: string): DockHeaderAction[] | null;
  commandsOf(key: string): DockHeaderCommands | null;
  stateOf(key: string): DockHeaderState;
  menuItemsOf(key: string): DockMenuItem[] | null;
  subscribe(key: string, cb: () => void): () => void;
};

/** aiti-float install-complete event (broadcast at the end of install(); service-online re-resolve signal). */
export const FLOAT_INSTALLED_EVENT = "piwe-float-installed";

/** Pending command lifetime (the window where the command registers after the click;
 *  dropped on timeout — avoids accidental execution on a much-later mount). */
export const DOCK_HEADER_PENDING_TTL = 10_000;

function actionSig(list: DockHeaderAction[] | null): string {
  if (!list) return "";
  return list.map((a) => `${a.id}|${a.title}|${a.badge ?? ""}|${a.active ? 1 : 0}|${a.done ? 1 : 0}|${a.disabled ? 1 : 0}|${a.visibility ?? "always"}`).join("§");
}
function menuSig(list: DockMenuItem[] | null): string {
  if (!list) return "";
  return list.map((m) => m.kind === "item"
    ? `i:${m.id ?? m.label}:${m.label}:${m.hint ?? ""}:${m.active ? 1 : 0}:${m.alwaysRun ? 1 : 0}:${m.disabled ? 1 : 0}`
    : m.kind === "head" ? `h:${m.label}`
    : m.kind === "iconsRow" ? `r:${m.label ?? ""}:${m.items.map((i) => i.key).join(",")}`
    : m.kind === "moveRow" ? "mv-row"
    : "s").join("§");
}
function stateSig(s: DockHeaderState): string {
  try { return JSON.stringify(s); } catch { return `keys:${Object.keys(s).length}`; }
}

type DockHeaderKeyState = {
  actions: DockHeaderAction[] | null;
  commands: DockHeaderCommands | null;
  state: DockHeaderState;
  menuItems: DockMenuItem[] | null;
  pending: { id: string; at: number; payload?: unknown } | null;
  sig: { actions: string; state: string; menu: string };
};

export function createDockHeaderStore(): DockHeaderStore {
  const keys = new Map<string, DockHeaderKeyState>();
  const subs = new Map<string, Set<() => void>>();
  const keyState = (k: string): DockHeaderKeyState => {
    let s = keys.get(k);
    if (!s) {
      s = { actions: null, commands: null, state: {}, menuItems: null, pending: null, sig: { actions: "", state: "{}", menu: "" } };
      keys.set(k, s);
    }
    return s;
  };
  const notify = (k: string): void => {
    const set = subs.get(k);
    if (!set) return;
    for (const cb of [...set]) { try { cb(); } catch { /* ignore */ } }
  };
  /** After a command registers, run the queued one (only within TTL and on id hit; cleared after one run). */
  const tryConsumePending = (k: string): void => {
    const s = keyState(k);
    const p = s.pending;
    if (!p) return;
    if (Date.now() - p.at > DOCK_HEADER_PENDING_TTL) { s.pending = null; return; }
    const fn = s.commands?.[p.id];
    if (typeof fn !== "function") return;
    s.pending = null;
    try { fn(p.payload); } catch { /* ignore */ }
  };
  return {
    register(key, reg) {
      const s = keyState(key);
      if ("actions" in reg) {
        const next = reg.actions ?? null;
        s.actions = next;
        const sig = actionSig(next);
        if (sig !== s.sig.actions) { s.sig.actions = sig; notify(key); }
      }
      if ("state" in reg) {
        const next = reg.state ?? {};
        s.state = next; // reference always updated (closures read the latest value)
        const sig = stateSig(next);
        if (sig !== s.sig.state) { s.sig.state = sig; notify(key); }
      }
      if ("menuItems" in reg) {
        const next = reg.menuItems ?? null;
        s.menuItems = next;
        const sig = menuSig(next);
        if (sig !== s.sig.menu) { s.sig.menu = sig; notify(key); }
      }
      if ("commands" in reg) {
        s.commands = reg.commands ?? null;
        tryConsumePending(key);
      }
      return () => {
        const cur = keys.get(key);
        if (!cur) return;
        if ("actions" in reg && cur.actions === (reg.actions ?? null)) {
          cur.actions = null; cur.sig.actions = ""; notify(key);
        }
        if ("menuItems" in reg && cur.menuItems === (reg.menuItems ?? null)) {
          cur.menuItems = null; cur.sig.menu = ""; notify(key);
        }
        if ("commands" in reg && cur.commands === (reg.commands ?? null)) cur.commands = null;
        if ("state" in reg) { cur.state = {}; cur.sig.state = "{}"; notify(key); }
      };
    },
    request(key, id, payload) {
      const s = keyState(key);
      const fn = s.commands?.[id];
      if (typeof fn === "function") { try { fn(payload); } catch { /* ignore */ } return true; }
      s.pending = { id, at: Date.now(), payload };
      try { writeBlockCollapsed(key, false); } catch { /* ignore */ }
      return false;
    },
    actionsOf(key) { return keys.get(key)?.actions ?? null; },
    commandsOf(key) { return keys.get(key)?.commands ?? null; },
    stateOf(key) { return keys.get(key)?.state ?? {}; },
    menuItemsOf(key) { return keys.get(key)?.menuItems ?? null; },
    subscribe(key, cb) {
      let set = subs.get(key);
      if (!set) { set = new Set(); subs.set(key, set); }
      set.add(cb);
      return () => { const cur = subs.get(key); if (!cur) return; cur.delete(cb); if (cur.size === 0) subs.delete(key); };
    },
  };
}

/** Local fallback singleton (used by the _shared layer when the aiti-float service is
 *  absent; module-level = shared within the bundle). */
let localHeaderStore: DockHeaderStore | null = null;
export function localDockHeaderStore(): DockHeaderStore {
  if (!localHeaderStore) localHeaderStore = createDockHeaderStore();
  return localHeaderStore;
}


/* ── Present state machine (present store) — P1-3 sunk from ext-float-dock.ts (plan
 * pi-web-eager-ext-split-plan.md §6 P1-3): pure localStorage + window events, zero react.
 * Sinking rationale: an extension's thin shell (the eager side) only needs the small API
 * layer — usePresent/openFloat/seedDockDefault — and must not drag in DockBody/header UI;
 * the shell imports ext-float-dock-lite (hooks + this layer's re-exports) while the
 * heavy UI stays in ext-float-dock.ts carried by the lazy chunk. aiti-float itself still
 * consumes only this core (the zero-React-references red line stays intact). ── */

const ITEM_KEY_GLOBAL = "__piweFloat";
export const CHANGE_EVENT = "piwe-float-present-change";
const DOCKPREF_KEY = (k: string) => `pi-web:ext-float:dockpref:v1:${k}`;

type FloatApi = {
  present(k: string, mode: "open" | "float" | `dock:${string}` | "close", opts?: { auto?: boolean }): void;
  presented(k: string): PresentState;
  onPresentChange(cb: (detail: { key: string; state: PresentState }) => void): () => void;
  dockPref(k: string): string | null;
  /** "Open in new window" capability registry (panels declare whether they can open a standalone window; the position menu shows/hides the icon accordingly) */
  registerWindowOpener?(k: string, fn: (() => void) | null): void;
  windowOpenerOf?(k: string): (() => void) | null;
};

/** float service probe (also used by ext-float-dock.ts's header store; internal shared exit). */
export function floatApi(): FloatApi | null {
  const api = (window as any)[ITEM_KEY_GLOBAL] as FloatApi | undefined;
  return api && typeof api.present === "function" ? api : null;
}

/* ── Fallback store (aiti-float not installed): no float form; open goes straight to
 * dock (embedding usable) ──
 * ⚠ State must land in localStorage (the cross-bundle single source of truth): this
 * module is inlined by each extension's vite build, so every bundle holds its own module
 * instance — an in-memory Map forks: "open goes through copy A (session-manager's inline
 * copy), close through copy B (aiti-folder's inline copy)": close in copy B sees
 * prev===next and takes the no-op branch without emitting an event → the gate stays
 * floating forever → the panel can't close and the built-in overlay blocks the screen
 * (observed: the folder float-window ghost state).
 * localStorage of the same origin and tab is shared by all bundles; this Map is just a
 * write-through cache; leftovers across refreshes are harmless (closed/docked leftovers
 * agree with the re-open landing; floating only arises when the user explicitly picks
 * float). */
const LOCAL_STATES_KEY = "pi-web:ext-float:localstates:v1";
const LOCAL_STATES_REV_KEY = "pi-web:ext-float:localstates-rev:v1";
function loadLocalStates(): Map<string, PresentState> {
  try {
    const raw = localStorage.getItem(LOCAL_STATES_KEY);
    const obj = raw ? JSON.parse(raw) as Record<string, PresentState> : null;
    return new Map(Object.entries(obj ?? {}));
  } catch { return new Map(); }
}
const localStates = loadLocalStates();
/** Revision stamp this copy has loaded: after another copy writes, rev changes → re-pull
 *  before the next read (write-through, read-through). */
let localStatesRev = "";
try { localStatesRev = localStorage.getItem(LOCAL_STATES_REV_KEY) ?? ""; } catch { /* ignore */ }
function syncLocalStates(): void {
  let rev = "";
  try { rev = localStorage.getItem(LOCAL_STATES_REV_KEY) ?? ""; } catch { /* ignore */ }
  if (rev === localStatesRev) return;
  localStatesRev = rev;
  const loaded = loadLocalStates();
  localStates.clear();
  for (const [lk, lv] of loaded) localStates.set(lk, lv);
}
function persistLocalStates(): void {
  const rev = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
  try {
    localStorage.setItem(LOCAL_STATES_KEY, JSON.stringify(Object.fromEntries(localStates)));
    localStorage.setItem(LOCAL_STATES_REV_KEY, rev);
  } catch { /* ignore */ }
  localStatesRev = rev;
}
const localSubs = new Set<(detail: { key: string; state: PresentState }) => void>();
/** Fallback-layer activate event (same name and semantics as aiti-float dock.ts's
 *  piwe-float-present-activate):
 *  when an already-docked state is opened again, the host's right column brings the
 *  corresponding tab forward — the fallback mode does not miss the "don't raise" fix. */
const ACTIVATE_EVENT = "piwe-float-present-activate";

function localPresent(k: string, mode: "open" | "float" | `dock:${string}` | "close", opts?: { auto?: boolean }) {
  syncLocalStates();
  const prev = localStates.get(k) ?? "closed";
  let next: PresentState = prev;
  if (mode === "open") {
    // open goes straight to dock (this layer's original semantics; no self-overlay
    // modal float window pops when aiti-float is absent):
    // already docked keeps its position (activation is backstopped by the activate
    // broadcast below); a closed state lands by
    // user pref (zone; "float" unrecognized) > extension default position > first
    // declared zone;
    // only with no declarations at all does floating backstop (legacy panels without
    // dock declarations).
    if (prev.startsWith("docked:")) next = prev;
    else {
      const pref = dockPref(k);
      const zones = localZones.get(k) ?? [];
      const zone = pref && pref !== "float" && (zones.includes(pref as DockZone) || isSidebarDockState(`docked:${pref}`))
        ? pref
        : (localDefaults.get(k) ?? zones[0]);
      next = (zone ? `docked:${zone}` : "floating") as PresentState;
    }
  } else if (mode === "float") next = "floating";
  else if (mode === "close") {
    next = "closed";
    writeBlockDismissed(k, true); // programmatic closes recorded too — harmless, explicit reopen clears
  } else if (mode.startsWith("dock:")) {
    const zone = mode.slice(5);
    // same semantics as the float state machine's dock.ts: an explicit user dock
    // memorizes the preference (next open returns there)
    try { localStorage.setItem(DOCKPREF_KEY(k), zone); } catch { /* ignore */ }
    next = `docked:${zone}` as PresentState; // canonical state docked:<zone> (the old implementation mistakenly stored dock:<zone> → gate always false, docked face never rendered)
  }
  // Explicit (non-auto) landing in the sidebar family = user actively bringing the
  // block back → clear the dismissed record (mirrors dock.ts).
  if (!opts?.auto && next !== "closed" && isSidebarDockState(next)) writeBlockDismissed(k, false);
  if (next === prev) {
    // Opening an already-docked state: same semantics as the float state machine —
    // broadcast activate so the host brings it forward.
    // auto passed through (consistent with dock.ts): a restorative re-dock's activate
    // must not raise the host's small-screen drawer.
    if (prev.startsWith("docked:")) {
      try { window.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: { key: k, state: prev, ...(opts?.auto ? { auto: true } : {}) } })); } catch { /* ignore */ }
    }
    return;
  }
  localStates.set(k, next);
  persistLocalStates();
  const detail = { key: k, state: next, ...(opts?.auto ? { auto: true } : {}) };
  for (const cb of localSubs) { try { cb(detail); } catch { /* ignore */ } }
  try { window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail })); } catch { /* ignore */ }
}

/* ── Public API ── */

export function present(k: string, mode: "open" | "float" | `dock:${string}` | "close", opts?: { auto?: boolean }): void {
  const api = floatApi();
  if (api) { api.present(k, mode, opts); return; }
  localPresent(k, mode, opts);
}

export function presentState(k: string): PresentState {
  const api = floatApi();
  if (api) return api.presented(k) ?? "closed";
  syncLocalStates();
  return localStates.get(k) ?? "closed";
}

export function onPresentChange(cb: (detail: { key: string; state: PresentState }) => void): () => void {
  const api = floatApi();
  if (api) return api.onPresentChange(cb);
  localSubs.add(cb);
  return () => localSubs.delete(cb);
}

export function dockPref(k: string): string | null {
  const api = floatApi();
  if (api) return api.dockPref(k) ?? null;
  try { return localStorage.getItem(DOCKPREF_KEY(k)); } catch { return null; }
}

/* ── Action sugar ── */

/** Container flash hint for a repeated open while docked (plan §3.2: don't open a
 *  second one; hint where the panel is).
 *  Targets the data-ext-item attribute on the DockBody root (self-removing CSS class,
 *  zero host logic). */
function flashDockContainer(k: string): void {
  try {
    const el = document.querySelector(`[data-ext-float-dock-body="${k}"]`);
    if (!el) return;
    el.classList.remove("piwe-dock-flash");
    // trigger a reflow to restart the animation
    void (el as HTMLElement).offsetWidth;
    el.classList.add("piwe-dock-flash");
    setTimeout(() => el.classList.remove("piwe-dock-flash"), 2000);
  } catch { /* ignore */ }
}

export function openFloat(k: string) {
  // idempotent open while docked: don't open a second one, flash hint (plan §3.2); the
  // float state machine is idempotent the same way inside
  const st = presentState(k);
  if (st.startsWith("docked:")) flashDockContainer(k);
  present(k, "open");
}

// Fallback command listener: when aiti-float is not installed this layer answers host
// command events (TabBar ✕ etc.);
// when float is present its own listener handles them (this layer does not double-run)
if (typeof window !== "undefined") {
  try {
    window.addEventListener("piwe-float-present-command", ((e: CustomEvent<{ key: string; mode: "open" | "float" | `dock:${string}` | "close" }>) => {
      if (floatApi()) return; // float present → float's listener already handled it
      if (!e.detail || !e.detail.key || !e.detail.mode) return;
      localPresent(e.detail.key, e.detail.mode);
    }) as EventListener);
  } catch { /* ignore */ }
}
export function dockTo(k: string, zone: DockZone) { present(k, `dock:${zone}`); }
/** Dock to a sidebar block (zone = sidebar:<itemKey>; sidebar unified dock plan §3.8). */
export function dockToSidebar(k: string) { present(k, `dock:${sidebarZoneOf(k)}`); }
/** Pull back to the float window (v3 Q1: also remember the float preference — the next
 *  open returns to float; written inside dock.ts present("float")) */
export function undockToFloat(k: string) { present(k, "float"); }
export function closePanel(k: string) { present(k, "close"); }
/** Write the user presence preference directly (zone | "float") without migrating state — the preference applies on the next open. */
export function setDockPref(k: string, pref: "float" | DockZone) {
  const api = floatApi();
  if (api && typeof (api as any).setPref === "function") { (api as any).setPref(k, pref); return; }
  try { localStorage.setItem(DOCKPREF_KEY(k), pref); } catch { /* ignore */ }
}

/** Clear the user presence preference (no state migration). For panels with "close and
 *  forget" semantics (folder block ruling: any close path clears the preference so the
 *  next open/refresh auto-docks back to the default position — avoids being pulled out
 *  to float, closed, then popping up again on refresh). The float state machine's
 *  dockprefOf reads localStorage directly each time with no cache, so deleting the key
 *  takes effect immediately (same key in both float-present and fallback modes). */
export function clearDockPref(k: string): void {
  try { localStorage.removeItem(DOCKPREF_KEY(k)); } catch { /* ignore */ }
}

/** Seed the extension-declared default landing (v3 §2-B implementation fix): writes
 *  dockPref=zone only while the user has no preference yet.
 *  Why not rely on panel attributes alone: the default must apply **at first open**,
 *  while the panel JSX only exists after rendering (before open the state machine cannot
 *  read DOM attributes — chicken and egg), so extensions call this at register time to
 *  prefill. After the user undocks/picks float the preference is overwritten and this
 *  function never overwrites again (user choice respected).
 *  Called automatically by the createDockFaces factory; hand-written integrations call
 *  it once explicitly inside register(). */
export function seedDockDefault(k: string, zone: DockZone) {
  try { if (!localStorage.getItem(DOCKPREF_KEY(k))) localStorage.setItem(DOCKPREF_KEY(k), zone); } catch { /* ignore */ }
  // Default position into the registry (the TabBar ⇱ menu's "default" suffix; v3.1) —
  // no mutual overwrite with declareDockZones:
  // this function only fills default, leaving the zones set untouched.
  const api = floatApi() as any;
  if (api && typeof api.registerDefaultZone === "function") { try { api.registerDefaultZone(k, zone); } catch { /* ignore */ } }
  localDefaults.set(k, zone);
}

/* ── Fallback ⇱ menu: when aiti-float is not installed the host TabBar ⇱ must still get
 *  a menu (when float is present its listener handles it).
 *  Data source = the fallback registry; actions = localPresent (same-state activation is
 *  backstopped by the host's activate listener). ── */
let fbMenuKey: string | null = null;
let fbMenuEl: HTMLElement | null = null;
let fbDismiss: { key: string; at: number } | null = null;

if (typeof window !== "undefined") {
  try {
    window.addEventListener("piwe-float-dock-menu", ((e: CustomEvent<{ key: string; rect?: { left: number; bottom: number } }>) => {
      if (floatApi()) return; // float present → float's listener already handled it
      const k = e.detail?.key;
      if (!k) return;
      // same-key toggle (covers the case of click re-triggering after the anchor
      // button's mousedown dismiss)
      if (fbMenuKey === k || (fbDismiss && fbDismiss.key === k && Date.now() - fbDismiss.at < 350)) {
        if (fbMenuEl) fbMenuEl.remove();
        fbMenuEl = null; fbMenuKey = null;
        return;
      }
      if (fbMenuEl) fbMenuEl.remove();
      const zones = (localZones.get(k)?.length ? localZones.get(k)! : (presentState(k).startsWith("docked:") ? [presentState(k).slice(7) as DockZone] : []));
      const def = localDefaults.get(k);
      const cur = presentState(k);
      const menu = document.createElement("div");
      menu.setAttribute("data-ext-dock-menu", "1");
      menu.style.cssText = "position:fixed;z-index:2147483600;background:var(--bg-panel,#1a1a1a);border:1px solid var(--border,#444);"
        + "border-radius:8px;padding:4px;display:flex;flex-direction:column;gap:2px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:190px;";
      const rect = e.detail?.rect;
      menu.style.left = Math.max(8, (rect?.left ?? window.innerWidth / 2 - 70) - 60) + "px";
      menu.style.top = (rect?.bottom ?? 140) + 4 + "px";
      // v5 icon row (plan §3.4): unified model (float + each dock position), shared DOM
      // row construction
      const items = positionMenuModel(k, zones as DockZone[], def, cur, { onNewWindow: dockWindowOpenerOf(k) });
      appendDockIconRow(menu, items, { label: "停靠方位", onPick: () => { if (fbMenuEl === menu) { fbMenuEl = null; fbMenuKey = null; } } });
      document.body.appendChild(menu);
      fbMenuKey = k;
      fbMenuEl = menu;
      const dismiss = (ev: MouseEvent) => {
        if (menu.contains(ev.target as Node)) return;
        fbDismiss = { key: k, at: Date.now() };
        menu.remove();
        if (fbMenuEl === menu) { fbMenuEl = null; fbMenuKey = null; }
        document.removeEventListener("mousedown", dismiss, true);
      };
      setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
    }) as EventListener);
  } catch { /* ignore */
  }
}

/* ── Position menu (v3 §2-D: DockBody header 📍, one-click re-position while docked) ──
 *  Data source = the zones/defaultZone passed by the caller (an extension knows what it
 *  declared; createDockFaces passes it automatically). The float state machine stores no
 *  DOM attributes, so no global query is involved. */
/** Dock-menu word table (core layer lives in _shared without ctx.t; resolve via the
 *  same localStorage pi-locale source as the host useI18n; en default). */
const DOCK_WORDS: Record<string, { "zh-CN": string; en: string }> = {
  newWindow: { "zh-CN": "新窗口打开", en: "Open in new window" },
  float: { "zh-CN": "浮窗", en: "Float" },
  zoneSidebar: { "zh-CN": "左栏 · 区块", en: "Left · blocks" },
  zoneRight: { "zh-CN": "右栏 · 面板", en: "Right · panels" },
};
export function dockWord(key: keyof typeof DOCK_WORDS): string {
  let loc = "en";
  try { loc = window.localStorage.getItem("pi-locale") || "en"; } catch { /* storage unavailable */ }
  const w = DOCK_WORDS[key];
  return (w as any)[loc === "zh-CN" ? "zh-CN" : "en"] ?? w.en;
}
export const DOCK_ZONE_LABELS: Record<string, string> = {
  "sidebar-explorer": dockWord("zoneSidebar"),
  "right-panel": dockWord("zoneRight"),
};

/** ── Icon-row model (v5, plan docs/pi-web-dock-icon-row-plan.md §3.4) ──────────────────
 *  The D1/D2/D3 position menus and D1's ⋮ "Move" row share one shape (2026-09-15 user
 *  ruling: move returns to a single icon row, with a leading move-diagonal-2 row icon —
 *  the row icon is carried by the React-side DockMenuRow, not in this model).
 *  · active: the current state (highlighted + locked, clicks do nothing) — same
 *    semantics as the old text menu's active;
 *  · isDefault: the extension-declared default position (top-right dot badge; tooltip
 *    suffix " (default)"). */
export interface DockIconRowItem {
  /** Stable key (position key / move-up etc.; the DOM side writes data-ext-dock-icon for e2e assertions) */
  key: string;
  icon: DockIconName;
  /** tooltip / aria-label text */
  label: string;
  active?: boolean;
  isDefault?: boolean;
  run: () => void;
}

/** Position menu item (v5 icon row): `key` = the position key ("float" or a zone value;
 *  the sidebar family collapses into one item). */
export interface PositionMenuItem extends DockIconRowItem {
  /** Position key: "float" or a DockZone (the sidebar family's multiple zones collapse
   *  into "sidebar-explorer") */
  key: string;
  /** Compat field (the old text menu's "default" suffix; the icon row uses the isDefault dot) */
  hint?: string;
}

/** Position menu item builder (v4 unified + v5 iconified): the sidebar-family zones
 *  collapse into a single "Left · blocks" entry
 *  (all blocks in the stack behave identically; the concrete zone value has no
 *  user-facing meaning); active is judged by state family
 *  (compatible with legacy docked:sidebar-explorer). Float and each physical position
 *  get one item per family. */
export function positionMenuItems(k: string, zones: DockZone[], defaultZone: DockZone | undefined, cur: PresentState): PositionMenuItem[] {
  const hasSidebar = zones.some((z) => z === "sidebar-explorer" || z.startsWith("sidebar:"));
  const items: PositionMenuItem[] = [];
  if (hasSidebar) {
    const isDef = defaultZone === "sidebar-explorer" || !!defaultZone?.startsWith("sidebar:");
    items.push({
      key: "sidebar-explorer",
      icon: "panel-left",
      label: DOCK_ZONE_LABELS["sidebar-explorer"],
      hint: isDef ? "默认" : undefined,
      isDefault: isDef,
      active: isSidebarDockState(cur),
      run: () => dockToSidebar(k),
    });
  }
  for (const z of zones) {
    if (z === "sidebar-explorer" || z.startsWith("sidebar:")) continue;
    items.push({
      key: z,
      icon: dockIconOfZone(z),
      label: DOCK_ZONE_LABELS[z] ?? z,
      hint: z === defaultZone ? "默认" : undefined,
      isDefault: z === defaultZone,
      active: cur === `docked:${z}`,
      run: () => dockTo(k, z),
    });
  }
  return items;
}

/** Full position menu model (incl. the float item; order = float → each dock position)
 *  — shared by the three menus D1/D2/D3, eliminating three hand-assembled
 *  "float + zones" lists. run goes through this layer's action sugar (auto-routes to the
 *  api state machine when float is present).
 *  opts.onNewWindow: pass the open function when the panel supports "open in new
 *  window" — that item sorts first (order: new window → float → each dock position);
 *  absent/unregistered → not shown ("some unsupported for now" is decided by capability
 *  registration). */
export function positionMenuModel(k: string, zones: DockZone[], defaultZone: DockZone | undefined, cur: PresentState, opts?: { onNewWindow?: (() => void) | null }): PositionMenuItem[] {
  const newWindow = opts?.onNewWindow ?? dockWindowOpenerOf(k);
  return [
    ...(newWindow ? [{ key: "new-window", icon: "new-window" as const, label: dockWord("newWindow"), run: newWindow }] : []),
    { key: "float", icon: "float", label: dockWord("float"), active: cur === "floating", run: () => undockToFloat(k) },
    ...positionMenuItems(k, zones, defaultZone, cur),
  ];
}

/* ── "Open in new window" capability registry (converged across bundles) ──
 *  On mount/instance creation the panel calls declareDockWindowOpener(k, fn) to declare
 *  support; the position menu model shows/hides glyph B accordingly (the aiti-folder
 *  folder face supports it; files go through the toolbar entry).
 *  float present → stored in float's singleton registry (readable cross-bundle by D2's
 *  TabBar ⇱ menu);
 *  absent → this bundle's local map backstops (D1's inline menu reads same-bundle; D3's
 *  fallback menu cannot read other bundles' registrations, so fallback mode hides the
 *  item — accepted). */
const localWindowOpeners = new Map<string, () => void>();
export function declareDockWindowOpener(k: string, fn: (() => void) | null): void {
  const api = floatApi() as (FloatApi & { registerWindowOpener?: (k2: string, f: (() => void) | null) => void }) | null;
  if (api && typeof api.registerWindowOpener === "function") { try { api.registerWindowOpener(k, fn); } catch { /* ignore */ } }
  if (typeof fn === "function") localWindowOpeners.set(k, fn);
  else localWindowOpeners.delete(k);
}
/** Look up a panel's "open in new window" capability (returns null when unregistered). */
export function dockWindowOpenerOf(k: string): (() => void) | null {
  const api = floatApi() as (FloatApi & { windowOpenerOf?: (k2: string) => (() => void) | null }) | null;
  if (api && typeof api.windowOpenerOf === "function") {
    try { const fn = api.windowOpenerOf(k); if (typeof fn === "function") return fn; } catch { /* ignore */ }
  }
  return localWindowOpeners.get(k) ?? null;
}

/** Icon-row DOM rendering (shared by D2 aiti-float / D3 fallback layer): one row of
 *  "name + right-aligned icon group"
 *  (name 12px dim left; icons 28×28, gap 6, right-aligned; active state highlighted and
 *  locked, default-position dot, hover tooltip).
 *  Without a label only the icon group renders (for pure icon rows). onPick runs before
 *  run when a clickable item is clicked
 *  (consumers use it to close the menu). Returns the row element. */
export function appendDockIconRow(parent: HTMLElement, items: DockIconRowItem[], opts?: { label?: string; onPick?: (it: DockIconRowItem) => void }): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("data-ext-dock-icon-row", "1");
  row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:5px 10px;";
  if (opts?.label) {
    const lab = document.createElement("span");
    lab.setAttribute("data-ext-dock-icon-row-label", "1");
    lab.textContent = opts.label;
    lab.style.cssText = "font-size:12px;color:var(--text-dim,#888);flex-shrink:0;user-select:none;white-space:nowrap;";
    row.appendChild(lab);
  }
  const group = document.createElement("div");
  group.setAttribute("data-ext-dock-icon-group", "1");
  group.style.cssText = "display:flex;gap:6px;margin-left:auto;flex-shrink:0;";
  for (const it of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    const tip = it.isDefault ? `${it.label}（默认）` : it.label;
    btn.title = tip;
    btn.setAttribute("aria-label", tip);
    if (it.active === true || it.active === false) {
      btn.setAttribute("role", "menuitemradio");
      btn.setAttribute("aria-checked", it.active ? "true" : "false");
    } else {
      btn.setAttribute("role", "menuitem");
    }
    btn.setAttribute("data-ext-dock-icon", it.key);
    btn.style.cssText = "position:relative;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;"
      + "border:none;background:none;border-radius:6px;padding:0;font-family:inherit;cursor:pointer;color:var(--text-muted,#888);"
      + (it.active ? "cursor:default;background:var(--bg-selected,#2a2a2a);color:var(--accent,#2563eb);" : "");
    btn.appendChild(createDockIconSvg(it.icon, 16));
    if (!it.active) {
      btn.addEventListener("mouseenter", () => { btn.style.background = "var(--bg-hover,#262626)"; btn.style.color = "var(--text,#ddd)"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "none"; btn.style.color = "var(--text-muted,#888)"; });
      btn.addEventListener("click", () => { opts?.onPick?.(it); it.run(); });
    }
    if (it.isDefault) {
      const dot = document.createElement("span");
      dot.setAttribute("data-ext-dock-icon-default", "1");
      dot.style.cssText = "position:absolute;top:3px;right:3px;width:4px;height:4px;border-radius:50%;background:var(--accent,#2563eb);pointer-events:none;";
      btn.appendChild(dot);
    }
    group.appendChild(btn);
  }
  row.appendChild(group);
  parent.appendChild(row);
  return row;
}
/* ── Central zones/default registration (v3.1): the data source for the TabBar dock tab
 *  ⇱ menu. When a panel's docked face is unmounted (background tab) the menu can only
 *  rely on this; DOM attributes are the fallback (the DockBody root carries the same
 *  attributes too). */
const localZones = new Map<string, DockZone[]>();
const localDefaults = new Map<string, DockZone>();

/** Declare the panel's dockable positions + default position (called once at register;
 *  createDockFaces calls it automatically).
 *  float present → into the state machine's registry; absent → this layer's fallback
 *  table (same source as the fallback ⇱ menu). */
export function declareDockZones(k: string, zones: DockZone[], defaultZone?: DockZone) {
  const api = floatApi() as any;
  if (api && typeof api.registerZones === "function") {
    try { api.registerZones(k, zones); } catch { /* ignore */ }
    if (defaultZone && typeof api.registerDefaultZone === "function") { try { api.registerDefaultZone(k, defaultZone); } catch { /* ignore */ } }
  }
  localZones.set(k, zones.filter(Boolean));
  if (defaultZone) localDefaults.set(k, defaultZone);
}
