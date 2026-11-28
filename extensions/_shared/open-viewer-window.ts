/**
 * open-viewer-window — shared implementation of "open in a new window" (aiti-viewer protocol + a
 * large centered window).
 *
 * Users: aiti-editor (file-viewer toolbar) / aiti-folder (folder tree context menu) — both used to
 * inline the same logic (ticket exchange + ready handshake + window.open); now consolidated here so
 * a window-strategy change lands in one place. Imported via relative paths (../../_shared/, same
 * precedent as aiti-editor-inject.mjs); each extension's vite build bundles it itself, no runtime sharing.
 *
 * aiti-viewer protocol (the path never enters a URL):
 *   1. POST /api/files/ticket to exchange for a one-time ticket (TTL 5 minutes);
 *   2. window.open("/viewer") opens a blank window;
 *   3. after the child window loads it sends the opener {source:"aiti-viewer",type:"ready"};
 *   4. this side replies {source:"aiti-viewer",type:"init",ticket} and the child redeems the ticket to open the target.
 * Note: noopener must NOT be passed — the child window needs window.opener for the handshake (same-origin, trusted).
 *
 * Window size: ~90% of the screen's available area, centered (including multi-screen availLeft/Top
 * offsets). Without features the browser opens at the default popup size (measured ~880px, position
 * arbitrary), which is poor for the viewer's large-area reading (full-width md / code / tables) —
 * that was the root cause of the 2026-09-06 "viewer docked left at constrained width".
 * Known edge: Chrome treats height as the outer window frame height (after subtracting the address
 * bar the viewport is slightly smaller than requested, ~85-90% of screen height); width hits
 * exactly. Not compensated (address-bar height varies by browser/zoom; hard-coded offsets are unstable).
 */

/** Compute the window.open features for a new /viewer window: ~90% of the available screen area, centered. */
export function viewerWindowFeatures(): string {
  const scr = window.screen;
  const aw = scr.availWidth || 1280;
  const ah = scr.availHeight || 800;
  const vw = Math.round(aw * 0.9);
  const vh = Math.round(ah * 0.9);
  // availLeft/Top: the current screen's origin in multi-screen setups (missing from TS lib.dom, widely supported at runtime)
  const sl = (scr as unknown as { availLeft?: number }).availLeft ?? 0;
  const st = (scr as unknown as { availTop?: number }).availTop ?? 0;
  const left = sl + Math.max(0, Math.round((aw - vw) / 2));
  const top = st + Math.max(0, Math.round((ah - vh) / 2));
  return `width=${vw},height=${vh},left=${left},top=${top}`;
}

/** Open a standalone viewer window (pi-web /viewer): exchange ticket -> open window -> hand over the ticket in the ready handshake. Fails silently (no caller-UI feedback path). */
export function openViewerWindow(
  apiUrl: (p: string) => string,
  target: { path: string; kind: "file" | "folder"; cwd?: string },
): void {
  try {
    // Ticket type: folder must pass "list" explicitly — the default type="download" runs an isFile
    // check on the target, so folders always 400 "Not a file" (the root cause of aiti-folder opening
    // folders with no response for ages, caught in the 2026-09-06 deep review).
    // list allows directory targets; file uses the default download (consistent with existing aiti-editor behavior).
    const type = target.kind === "folder" ? "list" : undefined;
    fetch(apiUrl("/api/files/ticket"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target.path, ...(type ? { type } : {}), kind: target.kind, cwd: target.cwd }) })
      .then((r) => r.json()).then((d: { ticket?: string }) => {
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
      }).catch(() => { /* noop */ });
  } catch { /* noop */ }
}
