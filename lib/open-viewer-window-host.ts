/**
 * open-viewer-window-host — host side of "file tab ⇱ → new window (standalone viewer)".
 * Same protocol as the shared `open-viewer-window.ts` helper in the internal
 * workspace (used by the file-editor and folder extensions):
 *   1. POST /api/files/ticket to redeem a one-time ticket (the path never enters the URL);
 *   2. window.open("/viewer") opens the window (centered on ~90% of the usable screen area);
 *   3. after the child window's ready handshake it sends back the ticket and the child
 *      redeems it to open the target.
 * Must not use noopener — the child window needs window.opener to complete the
 * handshake (same-origin, trusted).
 */

import { apiUrl } from "./base-path.ts";

function viewerWindowFeatures(): string {
  const scr = window.screen;
  const aw = scr.availWidth || 1280;
  const ah = scr.availHeight || 800;
  const vw = Math.round(aw * 0.9);
  const vh = Math.round(ah * 0.9);
  const sl = (scr as unknown as { availLeft?: number }).availLeft ?? 0;
  const st = (scr as unknown as { availTop?: number }).availTop ?? 0;
  const left = sl + Math.max(0, Math.round((aw - vw) / 2));
  const top = st + Math.max(0, Math.round((ah - vh) / 2));
  return `width=${vw},height=${vh},left=${left},top=${top}`;
}

/** Opens a standalone viewer window; fails silently (the menu path has no feedback surface). */
export function openViewerWindowHost(path: string, cwd?: string | null): void {
  try {
    fetch(apiUrl("/api/files/ticket"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, kind: "file", ...(cwd ? { cwd } : {}) }),
    })
      .then((r) => r.json())
      .then((d: { ticket?: string }) => {
        if (!d || !d.ticket) return;
        let win: Window | null = null;
        const onMsg = (ev: MessageEvent) => {
          if (ev.origin !== location.origin || ev.source !== win) return;
          const m: { source?: string; type?: string } = ev.data;
          if (m && m.source === "aiti-viewer" && m.type === "ready" && win && !win.closed) {
            win.postMessage({ source: "aiti-viewer", type: "init", ticket: d.ticket }, location.origin);
            window.removeEventListener("message", onMsg);
          }
        };
        window.addEventListener("message", onMsg);
        win = window.open(apiUrl("/viewer"), "_blank", viewerWindowFeatures());
        if (!win) window.removeEventListener("message", onMsg);
      })
      .catch(() => { /* noop */ });
  } catch { /* noop */ }
}
