/**
 * open-viewer-window-host — 宿主侧「文件 tab ⇱ → 新窗口（独立查看器）」。
 * 与 aiti-ai `_shared/open-viewer-window.ts`（aiti-editor/aiti-folder 用）同协议：
 *   1. POST /api/files/ticket 换一次性票（路径不进 URL）；
 *   2. window.open("/viewer") 开窗（屏幕可用区 ~90% 居中）；
 *   3. 子窗 ready 握手后回票，子窗兑票打开目标。
 * 不能带 noopener——子窗需要 window.opener 完成握手（同源可信）。
 */

import { apiUrl } from "./base-path";

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

/** 打开独立查看窗口；失败静默（菜单路径无反馈位）。 */
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
