/**
 * Cross-extension service: open the commit dialog with a prefilled message.
 *
 * Consumer: `getExtService("aiti-folder.commit")?.open({ cwd, message })` (aiti-codehub
 * uses it for the "write commit box" action). Returns false when the cwd is not a git repository or the
 * git-ops engine is unavailable, so the caller can fall back to the clipboard.
 */
import { useEffect, useState } from "react";
import { apiUrl } from "./host-shim";
import { CommitDialog } from "./git-toolbar";

interface CommitRequest {
  cwd: string;
  message: string;
  dirtyFiles: Array<{ xy: string; path: string }>;
}

let request: CommitRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch { /* ignore */ }
  }
}

async function fetchDirtyFiles(cwd: string): Promise<Array<{ xy: string; path: string }> | null> {
  try {
    const r = await fetch(apiUrl("/api/extensions/aiti-git-ops/git/refs"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || d?.ok === false) return null;
    const files = Array.isArray(d?.dirtyFiles) ? d.dirtyFiles : [];
    return files.map((f: any) => ({ xy: String(f.xy || "  "), path: String(f.path || "") })).filter((f: any) => f.path);
  } catch {
    return null;
  }
}

/** Open the commit dialog; resolves false when the folder cannot accept a commit. */
export async function openCommit(p: { cwd?: string; message: string }): Promise<boolean> {
  const cwd = String(p.cwd || "").trim();
  if (!cwd || !p.message) return false;
  const dirtyFiles = await fetchDirtyFiles(cwd);
  if (!dirtyFiles) return false;
  request = { cwd, message: p.message, dirtyFiles };
  emit();
  return true;
}

export function closeCommit(): void {
  request = null;
  emit();
}

/** Always-mounted host rendered through the dialogs slot. */
export function CommitHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  if (!request) return null;
  const req = request;
  return (
    <CommitDialog
      key={`${req.cwd}:${req.message.length}`}
      root={req.cwd}
      dirtyFiles={req.dirtyFiles}
      initialMessage={req.message}
      onClose={() => closeCommit()}
      onDone={() => closeCommit()}
    />
  );
}
