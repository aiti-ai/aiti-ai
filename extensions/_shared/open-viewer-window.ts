/**
 * open-viewer-window — 「在新窗口打开」共享实现（aiti-viewer 协议 + 大窗口居中）。
 *
 * 使用方：aiti-editor（文件查看器工具条）/ aiti-folder（文件夹树右键）——两处原本
 * 各自内联同款逻辑（ticket 换票 + ready 握手 + window.open），收敛于此，改窗口策略
 * 一处生效。经相对路径 import（../../_shared/，同 aiti-editor-inject.mjs 先例），
 * 各扩展 vite 构建自行打包，无运行时共享。
 *
 * aiti-viewer 协议（路径不进 URL）：
 *   1. POST /api/files/ticket 换一次性票（TTL 5 分钟）；
 *   2. window.open("/viewer") 开空白窗；
 *   3. 子窗加载后向 opener 发 {source:"aiti-viewer",type:"ready"}；
 *   4. 本侧回 {source:"aiti-viewer",type:"init",ticket}，子窗兑票打开目标。
 * 注意不能带 noopener——子窗需要 window.opener 完成握手（同源可信）。
 *
 * 窗口尺寸：屏幕可用区 ~90% 并居中（含多屏 availLeft/Top 偏移）。不传 features 时
 * 浏览器按默认弹窗尺寸开窗（实测 ~880px 且位置随缘），viewer 大面积查看
 * （md 全宽 / 代码 / 表格）体验差——这是 2026-09-06「viewer 居左受限宽度」的根因。
 * 已知边界：Chrome 把 height 当窗口外框高度（扣掉地址栏后 viewport 略小于请求值，
 * ~85-90% 屏高），宽度精确命中；不再补偿（地址栏高度随浏览器/缩放变化，补死值不稳）。
 */

/** 计算 /viewer 新窗口的 window.open features：屏幕可用区 ~90% 居中。 */
export function viewerWindowFeatures(): string {
  const scr = window.screen;
  const aw = scr.availWidth || 1280;
  const ah = scr.availHeight || 800;
  const vw = Math.round(aw * 0.9);
  const vh = Math.round(ah * 0.9);
  // availLeft/Top：多屏场景当前屏原点（TS lib.dom 未收录，运行时广泛支持）
  const sl = (scr as unknown as { availLeft?: number }).availLeft ?? 0;
  const st = (scr as unknown as { availTop?: number }).availTop ?? 0;
  const left = sl + Math.max(0, Math.round((aw - vw) / 2));
  const top = st + Math.max(0, Math.round((ah - vh) / 2));
  return `width=${vw},height=${vh},left=${left},top=${top}`;
}

/** 打开独立查看窗口（pi-web /viewer）：换票 → 开窗 → ready 握手交票。失败静默（调用方 UI 无感知路径）。 */
export function openViewerWindow(
  apiUrl: (p: string) => string,
  target: { path: string; kind: "file" | "folder"; cwd?: string },
): void {
  try {
    // 换票 type：folder 必须显式传 "list"——缺省 type="download" 会对目标做 isFile 校验，
    // 文件夹恒 400 "Not a file"（aiti-folder 开文件夹长期无响应的根因，2026-09-06 深审逮到）。
    // list 允许目录目标；file 走缺省 download（与既有 aiti-editor 行为一致）。
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
