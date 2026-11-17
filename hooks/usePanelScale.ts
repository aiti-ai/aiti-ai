"use client";

import { useSyncExternalStore } from "react";

export const PANEL_UI_SCALE_DEFAULT = 100;
export const PANEL_UI_SCALE_MIN = 85;
export const PANEL_UI_SCALE_MAX = 130;
export const PANEL_UI_SCALE_STEP = 5;
export const PANEL_UI_SCALE_STORAGE_KEY = "pi-panel-ui-scale";

/** CSS custom property consumed by the sidebar container and the right-panel
 *  dock/file/folder tab containers (AppShell); 100 → removed (browser default). */
const PANEL_UI_SCALE_CSS_PROPERTY = "--pi-panel-zoom";

function clampPanelUiScale(value: unknown): number {
  const scale = Number(value ?? PANEL_UI_SCALE_DEFAULT);
  if (!Number.isFinite(scale)) return PANEL_UI_SCALE_DEFAULT;
  // Snap to the slider step so hand-edited storage values stay on the published stops.
  const rounded = Math.round(scale / PANEL_UI_SCALE_STEP) * PANEL_UI_SCALE_STEP;
  return Math.max(PANEL_UI_SCALE_MIN, Math.min(PANEL_UI_SCALE_MAX, rounded));
}

function readStoredScale(): number {
  try {
    return clampPanelUiScale(window.localStorage.getItem(PANEL_UI_SCALE_STORAGE_KEY));
  } catch {
    return PANEL_UI_SCALE_DEFAULT;
  }
}

function applyScale(scale: number): void {
  if (typeof document === "undefined") return;
  if (scale === PANEL_UI_SCALE_DEFAULT) document.documentElement.style.removeProperty(PANEL_UI_SCALE_CSS_PROPERTY);
  else document.documentElement.style.setProperty(PANEL_UI_SCALE_CSS_PROPERTY, String(scale / 100));
}

let scale: number | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): number {
  if (typeof window === "undefined") return PANEL_UI_SCALE_DEFAULT;
  if (scale === null) {
    scale = readStoredScale();
    applyScale(scale);
  }
  return scale;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== PANEL_UI_SCALE_STORAGE_KEY) return;
  const next = readStoredScale();
  if (next === getSnapshot()) return;
  scale = next;
  applyScale(next);
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  getSnapshot();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function setPanelUiScale(value: number): void {
  const next = clampPanelUiScale(value);
  if (next === getSnapshot()) return;
  scale = next;
  applyScale(next);
  try {
    if (next === PANEL_UI_SCALE_DEFAULT) window.localStorage.removeItem(PANEL_UI_SCALE_STORAGE_KEY);
    else window.localStorage.setItem(PANEL_UI_SCALE_STORAGE_KEY, String(next));
  } catch {
    // Apply in memory even if the browser cannot save the preference.
  }
  notify();
}

export function usePanelScale() {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => PANEL_UI_SCALE_DEFAULT);
  return { panelUiScale: current, setPanelUiScale };
}
