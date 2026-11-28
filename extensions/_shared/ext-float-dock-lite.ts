/**
 * _shared/ext-float-dock-lite.ts — the dock/present state machine's **thin shell layer**
 * (P1-3, plan pi-web-eager-ext-split-plan.md §6 P1-3).
 *
 * An eager thin shell (split-extension entry) only needs: usePresent/useGate (gate
 * hooks) + the present state machine's small API (openFloat/closePanel/seedDockDefault/
 * declareDockZones…).
 * This module = that minimal surface (hooks here; the state machine re-exported from
 * ext-float-dock-core), **without DockBody/header UI** — those stay in
 * ext-float-dock.ts (the heavy module, carried by the lazy chunk).
 * Split extensions' shells import this file, so first paint no longer drags in the
 * 17+ KB dock UI layer.
 *
 * Unsplit extensions can keep importing ext-float-dock.ts (the full surface, which
 * re-exports this module; behavior unchanged).
 */
import { useEffect, useState } from "react";
import { presentState, onPresentChange, CHANGE_EVENT } from "./ext-float-dock-core";
import type { PresentState, DockZone } from "./ext-float-dock-core";

// Full re-export of the pure state layer: importing only this module covers the
// register phase + gating + open/close
export {
  present, presentState, onPresentChange, dockPref,
  openFloat, closePanel, dockTo, dockToSidebar, undockToFloat,
  setDockPref, clearDockPref, seedDockDefault, declareDockZones,
  positionMenuItems, DOCK_ZONE_LABELS,
  sidebarZoneOf, isSidebarDockState,
  type DockZone, type PresentState,
} from "./ext-float-dock-core";

export function usePresent(itemKey: string): PresentState {
  const [state, setState] = useState<PresentState>(() => presentState(itemKey));
  useEffect(() => {
    setState(presentState(itemKey));
    // Two-channel subscription (timing-immune; fixed "All Sessions won't open"
    // 2026-09-12): if this component mounts before aiti-float installs (bundle-readiness
    // order race), floatApi() is null → the onPresentChange subscription lands in the
    // fallback store below, and updates from the __piweFloat state machine would never
    // arrive → the panel gate stays closed and won't open. Both state machines (the api
    // machine and the fallback localPresent) broadcast the same-name window
    // CHANGE_EVENT, so a window backstop listener covers both directions; with the api
    // present the two channels fire the same value and setState is idempotent — harmless.
    const h = ((e: CustomEvent<{ key: string; state: PresentState }>) => {
      if (e.detail?.key === itemKey) setState(e.detail.state);
    }) as EventListener;
    window.addEventListener(CHANGE_EVENT, h);
    const off = onPresentChange((d) => { if (d.key === itemKey) setState(d.state); });
    return () => { window.removeEventListener(CHANGE_EVENT, h); off(); };
  }, [itemKey]);
  return state;
}

/** Render gate (structural double-open prevention): face="float" renders only in the
 *  floating state; face={dock:zone} renders only in the matching docked state. */
export function useGate(itemKey: string, face: "float" | { dock: DockZone }): boolean {
  const state = usePresent(itemKey);
  if (face === "float") return state === "floating";
  return state === `docked:${face.dock}`;
}
