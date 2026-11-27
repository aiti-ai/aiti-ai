/**
 * Cross-extension slot: extra buttons in the commit dialog's message action row.
 *
 * aiti-folder provides the registry service (`aiti-folder.commit-actions`):
 * consumers register a factory that receives the dialog context at render time
 * (message access + checked files + repo root) and return the button props.
 * Factories are re-invoked on every render of an open dialog, so labels can
 * follow the caller's locale and state. Buttons render right-aligned in the
 * action row, before the built-in AI Generate button (the first consumer is
 * aiti-codehub's "Work item" picker).
 */
import { useEffect, useState } from "react";
import { regSvc } from "./host-shim";

export interface CommitActionCtx {
  /** Repo root the dialog commits in. */
  root: string;
  getMessage: () => string;
  /** Update the message (functional updater, same semantics as setState). */
  setMessage: (updater: (m: string) => string) => void;
  /** Currently checked (to-be-committed) file paths. */
  getFiles: () => string[];
}

export interface CommitAction {
  label: string;
  title?: string;
  onClick: (ctx: CommitActionCtx) => void | Promise<void>;
}

export interface CommitActionRegistration {
  /** Stable id (also the DOM key); re-registering replaces. */
  id: string;
  /** Lower renders first (further left). Default 100. */
  order?: number;
  /** Invoked on every render of an open dialog; null hides the button. */
  factory: (ctx: CommitActionCtx) => CommitAction | null;
}

interface Entry {
  id: string;
  order: number;
  factory: CommitActionRegistration["factory"];
}

const registry = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch { /* ignore */ }
  }
}

/** Install the cross-extension registry service (aiti-folder entry calls once). */
export function setupCommitActions(ctx: Record<string, any>): void {
  const svc = {
    register: (r: CommitActionRegistration): (() => void) => {
      registry.set(r.id, { id: r.id, order: r.order ?? 100, factory: r.factory });
      emit();
      return () => {
        registry.delete(r.id);
        emit();
      };
    },
  };
  try { regSvc("aiti-folder.commit-actions", svc); } catch { /* old host */ }
  try { (ctx as any).registerExtService?.("aiti-folder.commit-actions", svc); } catch { /* old host */ }
}

/** Sorted registrations of an open dialog (re-renders on register/unregister). */
export function useCommitActions(): Entry[] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return [...registry.values()].sort((a, b) => a.order - b.order);
}
