/**
 * Cross-extension service: pick an absolute directory.
 *
 * Consumer: `getExtService("aiti-folder.pick")?.directory({ initialPath })` →
 * Promise<string | null>. The browser is mounted once through the dialogs slot and
 * portaled to <body> so float panels (transform/overflow) cannot clip it.
 */
import { useState, useEffect } from "react";
import { DirectoryPicker } from "./directory-picker";

interface PickRequest {
  initialPath?: string;
  resolve: (path: string | null) => void;
}

let request: PickRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch { /* ignore */ }
  }
}

export function pickDirectory(p: { initialPath?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    request = { initialPath: p.initialPath, resolve };
    emit();
  });
}

function settle(path: string | null): void {
  const req = request;
  request = null;
  emit();
  try { req?.resolve(path); } catch { /* ignore */ }
}

/** Always-mounted host rendered through the dialogs slot. */
export function PickHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  // no active request → render nothing at all: keeping any wrapper mounted
  // leaves an invisible full-screen layer over the page (the "picker cannot be
  // closed / nothing clickable" stuck report).
  if (!request) return null;
  // DirectoryPicker portals its own overlay to <body> — render it bare here.
  // The old centering wrapper (pointerEvents:auto, inset:0) became an EMPTY
  // full-screen shield stacked ABOVE the portaled backdrop (higher z-index):
  // the dialog was visible but every click landed on the shield — nothing
  // clickable, Cancel dead.
  const initialPath = request.initialPath;
  return (
    <DirectoryPicker
      initialPath={initialPath}
      onSelect={(p: string) => settle(p)}
      onCancel={() => settle(null)}
    />
  );
}
