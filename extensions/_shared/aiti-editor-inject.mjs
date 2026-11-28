/**
 * aiti-editor injection buffering helper (multi-editor mechanism §1.5) — implementation extensions'
 * clients all go through here.
 *
 * Background: the client load order of aiti-editor and the implementation extensions (aiti-sheet-univer /
 * aiti-word-* etc.) is nondeterministic. Late injections need buffered replay:
 *   - aiti-editor ready (window.__aitiEditor exists) -> register immediately;
 *   - not ready -> the register function is pushed into window.__aitiEditorQueue, flushed once
 *     aiti-editor's setupRegistry mounts, and broadcast via the `aiti-editor:registry-ready` event.
 *
 * Usage (implementation extension client entry):
 *   import { whenAitiEditorReady } from "@aiti-ai/ext-shared/aiti-editor-inject";
 *   whenAitiEditorReady(() => {
 *     window.__aitiEditor.registerEditorProvider({ id: "…", displayName: "…", selector: { extensions: [".xlsx"] },
 *       capabilities: ["preview", "edit"], render(host, ctx) { … return { el, dispose() {} }; } });
 *     window.__aitiEditor.registerContentProvider({ id: "…", write(filePath, data, baseMtimeMs) { … } });
 *   });
 *
 * This file is consumed in the "shared authoritative source + build-time inlining" mode (same as
 * cursor-cli-store): implementation extensions' vite builds bundle this module into their own bundles,
 * zero cross-directory runtime dependency.
 */

/**
 * Run registerNow once aiti-editor is ready (idempotent-safe: runs synchronously immediately when
 * already ready; enqueued when not, replayed once aiti-editor becomes ready). Exceptions are logged
 * only, never propagated (a failed registration must not take down the host page).
 * @param {() => void} registerNow
 */
export function whenAitiEditorReady(registerNow) {
  if (typeof window === "undefined") return;
  if (window.__aitiEditor) {
    try { registerNow(); } catch (e) { console.error("[aiti-editor-inject] registration failed:", e); }
    return;
  }
  if (!Array.isArray(window.__aitiEditorQueue)) window.__aitiEditorQueue = [];
  window.__aitiEditorQueue.push(() => {
    try { registerNow(); } catch (e) { console.error("[aiti-editor-inject] registration failed (replay):", e); }
  });
}

/**
 * Listen for registry readiness (fires once immediately in the already-ready case too). For
 * initialization that must happen after the registry is ready (e.g. reading preferences, fetching
 * candidate lists).
 * @param {() => void} cb
 */
export function onAitiEditorReady(cb) {
  if (typeof window === "undefined") return;
  if (window.__aitiEditor) { try { cb(); } catch (e) { console.error("[aiti-editor-inject]", e); } return; }
  const h = () => { window.removeEventListener("aiti-editor:registry-ready", h); try { cb(); } catch (e) { console.error("[aiti-editor-inject]", e); } };
  window.addEventListener("aiti-editor:registry-ready", h);
}
