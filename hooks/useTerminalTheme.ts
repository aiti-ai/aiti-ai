import {
  parseTerminalTheme,
  TERMINAL_THEME_DEFAULT,
  TERMINAL_THEME_EVENT,
  TERMINAL_THEME_STORAGE_KEY,
  type TerminalTheme,
} from "@/lib/terminal-theme";
import { useSyncExternalStore } from "react";

function readStoredTheme(): TerminalTheme {
  try {
    return parseTerminalTheme(window.localStorage.getItem(TERMINAL_THEME_STORAGE_KEY));
  } catch {
    return TERMINAL_THEME_DEFAULT;
  }
}

let theme: TerminalTheme | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): TerminalTheme {
  if (theme === null) theme = readStoredTheme();
  return theme;
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

// Another tab chose; `key` is null when that tab cleared its storage.
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== TERMINAL_THEME_STORAGE_KEY) return;
  syncFromStorage();
}

// The same document chose (an extension's terminal surface writes the key, then
// fires the event; `storage` never fires for a write this document made).
function syncFromStorage(): void {
  const next = readStoredTheme();
  if (next === theme) return;
  theme = next;
  notify();
}

function onLocalChange(): void {
  syncFromStorage();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
    window.addEventListener(TERMINAL_THEME_EVENT, onLocalChange);
    // Nobody listened for another tab's choice meanwhile.
    theme = readStoredTheme();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(TERMINAL_THEME_EVENT, onLocalChange);
    }
  };
}

export function setTerminalTheme(next: TerminalTheme): void {
  if (next === getSnapshot()) return;
  theme = next;
  try {
    window.localStorage.setItem(TERMINAL_THEME_STORAGE_KEY, next);
  } catch {
    // Applies in memory even if the browser cannot save it.
  }
  notify();
  try {
    window.dispatchEvent(new CustomEvent(TERMINAL_THEME_EVENT, { detail: next }));
  } catch {
    // A browser without CustomEvent keeps the in-document listeners stale until a reload.
  }
}

/** Every open terminal shares one choice, kept per browser. */
export function useTerminalTheme(): TerminalTheme {
  return useSyncExternalStore(subscribe, getSnapshot, () => TERMINAL_THEME_DEFAULT);
}
