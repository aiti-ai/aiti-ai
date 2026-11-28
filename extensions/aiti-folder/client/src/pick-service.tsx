/**
 * Cross-extension service: pick an absolute directory.
 *
 * Consumer: `getExtService("aiti-folder.pick")?.directory({ initialPath })` →
 * Promise<string | null>. The browser is mounted once through the dialogs slot and
 * portaled to <body> so float panels (transform/overflow) cannot clip it.
 */
import { useEffect, useState } from "react";
import { createPortal } from "./host-shim";
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
  // no active request → render nothing at all: keeping the portal wrapper
  // mounted with inset:0 leaves an invisible full-screen overlay that swallows
  // every click on the page after Cancel/Select (the "picker cannot be closed"
  // stuck report). pointer-events:none below is belt-and-braces for the same
  // failure mode during the request→settle transition.
  if (!request) return null;
  const initialPath = request.initialPath;
  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 2147483600, pointerEvents: "none" }}>
      <div style={{ position: "absolute", pointerEvents: "auto", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <DirectoryPicker
          initialPath={initialPath}
          onSelect={(p: string) => settle(p)}
          onCancel={() => settle(null)}
        />
      </div>
    </div>,
    document.body,
  );
}
