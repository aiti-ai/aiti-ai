/**
 * 手势原语（拖拽/缩放共用）：pointerdown → move(rAF 合并) → end（up/cancel/blur 必达）。
 * 自 aiti-float 手写版迁移，逻辑一比一；生命周期对齐 launcher drag.js 的教训：
 * window 级 move/up/cancel + blur + lostpointercapture 兜底、rAF 合并写样式、
 * 标题栏阈值（纯点击不被吞）。
 */

export interface GestureOpts {
  /** 移动阈值 px：累计位移超过才算拖动（0 = 立即算） */
  threshold?: number;
  /** pointerdown 过滤（返回 false 不接管，如交互元素上的按下） */
  filter?: (e: PointerEvent) => boolean;
  preventStart?: boolean;
  onStart?: () => void;
  onMove: (dx: number, dy: number) => void;
  onEnd: (moved: boolean) => void;
}

/** 安装手势。返回清理函数（拆除监听 + 冲刷 rAF）。 */
export function attachGesture(handle: HTMLElement, opts: GestureOpts): () => void {
  let pid: number | null = null, sx = 0, sy = 0, moved = false, capped = false, frame = 0;
  let lastEv: PointerEvent | null = null;
  const threshold = opts.threshold || 0;

  const applyMove = () => { if (lastEv) opts.onMove(lastEv.clientX - sx, lastEv.clientY - sy); };
  const finish = (fire: boolean) => {
    if (pid === null) return;
    const wasMoved = moved;
    pid = null;
    if (frame) { // 冲刷末帧（rAF 排队中还没应用的目标值——onEnd 前状态收敛到最终）
      cancelAnimationFrame(frame); frame = 0;
      if (fire && wasMoved && lastEv) applyMove();
    }
    lastEv = null;
    try { opts.onEnd(wasMoved); } catch { /* 扩展面板可能已销毁 */ }
  };
  const onMove = (ev: PointerEvent) => {
    if (pid === null || ev.pointerId !== pid) return;
    if (!moved) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) <= threshold) return;
      moved = true;
      if (!capped) { capped = true; try { handle.setPointerCapture(pid); } catch { /* 合成事件等 */ } }
    }
    try { ev.preventDefault(); } catch { /* passive listener */ }
    lastEv = ev;
    if (frame) return; // rAF 合并：只记最新，每帧应用一次
    frame = requestAnimationFrame(() => { frame = 0; if (lastEv) applyMove(); });
  };
  const onUp = (ev: PointerEvent) => { if (pid !== null && ev.pointerId === pid) finish(true); };
  const onDown = (e: PointerEvent) => {
    if (e.button !== undefined && e.button !== 0) return; // 仅主键/触摸
    if (pid !== null) return; // 手势进行中（多点触控第二指）
    if (opts.filter && !opts.filter(e)) return; // 拖拽把手：交互元素（按钮/输入）上按下不接管
    pid = e.pointerId; sx = e.clientX; sy = e.clientY;
    moved = threshold <= 0; capped = false;
    if (opts.preventStart) { try { e.preventDefault(); } catch { /* ignore */ } }
    try { opts.onStart?.(); } catch { /* ignore */ }
  };
  const onLostCapture = (ev: PointerEvent) => {
    if (ev.target !== handle) return; // 子元素隐式捕获转移，不算结束
    if (pid !== null && ev.pointerId === pid) finish(true);
  };
  const onBlur = () => finish(true);

  handle.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  window.addEventListener("blur", onBlur);
  handle.addEventListener("lostpointercapture", onLostCapture);
  return () => {
    handle.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.removeEventListener("blur", onBlur);
    handle.removeEventListener("lostpointercapture", onLostCapture);
    if (frame) cancelAnimationFrame(frame);
  };
}
