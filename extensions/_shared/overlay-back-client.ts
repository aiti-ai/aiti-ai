/**
 * 扩展端「小屏系统返回关闭浮层」接线（宿主退栈服务 `pi-web.overlayBack` 消费薄封装）。
 *
 * 宿主侧：`pi-web/lib/overlay-back.ts`（历史退栈唯一写入口）+ 客户端服务
 * `ctx.getExtService("pi-web.overlayBack")`。扩展**不要**自己监听 popstate（两套栈会互踩）。
 *
 * 用法（React 扩展，二选一）：
 *   // ① 组件挂载即弹（确认框/选择器这类面板本身就是 open 态）
 *   useEffect(() => dismissOnBack(() => extSvc("pi-web.overlayBack"), onClose), []);
 *   // ② 有 open 状态（弹窗常驻渲染 but 条件显示）
 *   useEffect(() => (open ? dismissOnBack(() => extSvc("pi-web.overlayBack"), () => close()) : undefined), [open]);
 *
 * 降级：旧宿主 / 服务缺席 / 桌面（>640px，与全仓移动断点一致）/ 非浏览器 → 返回 no-op，
 * 浏览器返回语义不变。是否注册由小屏判定内置，调用方无需自己 matchMedia。
 * 断点动态重估（与 aiti-float back-layer 同款）：注册期间跨断点（旋转/拉窗）自动 acquire/release，
 * 不会出现「桌面宽度注册的层残留到窄窗口」或「窄窗口开启的弹窗回宽屏后无返回关闭」。
 * 方案：docs/pi-web-mobile-back-dismiss-coverage-plan.md；契约：docs/aiti-web-ext-float-dialogs.md。
 */
export interface OverlayBackHandle {
  release(): void;
}

export interface OverlayBackService {
  acquire(close: () => void): OverlayBackHandle;
}

/** 小屏断点（与宿主 useIsMobile / data-ext-float-full 同款）。 */
export const OVERLAY_BACK_MOBILE_QUERY = "(max-width: 640px)";

/**
 * 注册「系统返回时关闭」层。返回 release（幂等；组件卸载/关闭时调用）。
 * @param getService 取宿主服务（断点重估/重注册时都重新读，兼容懒加载/服务后上线）
 * @param close 返回触发时执行的关闭动作（点 ✕ / 取消 / dismiss 同款）
 */
export function dismissOnBack(
  getService: () => OverlayBackService | null | undefined,
  close: () => void,
): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(OVERLAY_BACK_MOBILE_QUERY);
  let handle: OverlayBackHandle | null = null;
  let released = false;
  const sync = (): void => {
    if (released) return;
    let service: OverlayBackService | null | undefined;
    try {
      service = getService();
    } catch {
      service = null;
    }
    const should = mq.matches && !!service && typeof service.acquire === "function";
    if (should && !handle) {
      try {
        handle = service!.acquire(close);
      } catch {
        handle = null;
      }
    } else if (!should && handle) {
      const prev = handle;
      handle = null;
      try {
        prev.release();
      } catch {
        /* 宿主降级不阻断扩展 */
      }
    }
  };
  sync();
  const onChange = () => sync();
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  else mq.addListener(onChange);
  return () => {
    if (released) return;
    released = true;
    if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", onChange);
    else mq.removeListener(onChange);
    const prev = handle;
    handle = null;
    if (prev) {
      try {
        prev.release();
      } catch {
        /* ignore */
      }
    }
  };
}
