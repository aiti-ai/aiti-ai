/**
 * aiti-float · client 入口（TypeScript + vite 构建）。
 *
 * register(ctx) 时安装 DOM 级增强器：MutationObserver 扫描 [data-ext-float] 面板 →
 * 接管定位 + 拖拽/缩放手势 + 位置持久化（逻辑见 float.ts / gesture.ts）。
 * v0.5：另注册 DockStack 服务（aiti-float.dockstack）——左栏统一 dock 区块栈容器
 * （sidebar 统一 dock 方案 §3.8；dockstack.ts，ctx hooks 闭包注入，产物零 react 引用）。
 */
import { install, scan, panelCount, dupeCheck, VERSION, setOverlayBackService } from "./float";
import { createDockStackApi } from "./dockstack";
import { createDockHeaderStore } from "../../../_shared/ext-float-dock-core";

export default function register(ctx: Record<string, unknown>): () => void {
  // dock 头工具条 store（v3，方案 pi-web-dock-header-toolbar-plan §2.7）：
  // 先挂 window.__piweFloat.dockHeader（_shared 层的共享通道，core 保留口）再 install——
  // install 末尾广播 piwe-float-installed，订阅方随后读到的即是宿主级服务（跨 bundle 单例）。
  const dockHeader = createDockHeaderStore();
  try {
    const g = ((window as any).__piweFloat ||= {});
    g.dockHeader = dockHeader;
  } catch { /* ignore */ }
  const dispose = install();
  // 小屏系统返回关闭浮窗（方案 docs/pi-web-mobile-back-dismiss-plan.md）：消费宿主退栈服务
  // pi-web.overlayBack。懒加载/旧宿主时序防御：先直读一次，再订阅上/下线补挂（永不各自
  // 监听 popstate——历史退栈唯一写入口在宿主）。旧宿主缺席时静默降级为无返回关闭能力。
  const lookupOverlayBack = () => {
    try {
      return (ctx as { getExtService?: <T>(k: string) => T | undefined })
        .getExtService?.<{ acquire(close: () => void): { release(): void } }>("pi-web.overlayBack") ?? null;
    } catch { return null; }
  };
  setOverlayBackService(lookupOverlayBack());
  let offOverlayBack: (() => void) | undefined;
  try {
    offOverlayBack = (ctx as { onExtServiceChange?: (cb: (key: string, phase: "up" | "down") => void) => () => void })
      .onExtServiceChange?.((key, phase) => {
        if (key !== "pi-web.overlayBack") return;
        setOverlayBackService(phase === "up" ? lookupOverlayBack() : null);
      });
  } catch { /* ignore */ }
  // DockStack 服务（扩展间通信走 ctx.services）：session-manager SidebarContentDock 消费
  try {
    (ctx as { registerExtService?: (k: string, impl: unknown) => () => void })
      .registerExtService?.("aiti-float.dockstack", createDockStackApi(ctx));
  } catch { /* 旧宿主无 services 缺席降级（编排器自带降级路径） */ }
  // 公开服务：dock 头按钮/命令/状态（第三方扩展经 ctx.getExtService 接入；同实现对象）
  try {
    (ctx as { registerExtService?: (k: string, impl: unknown) => () => void })
      .registerExtService?.("aiti-float.dock-header", dockHeader);
  } catch { /* ignore */ }
  // 调试/自检出口（aiti-extman、e2e 用）：window.__AITI_FLOAT__
  try {
    (window as any).__AITI_FLOAT__ = { installed: true, scan, version: VERSION, panels: panelCount, dupeCheck, teardown: dispose };
  } catch { /* ignore */ }
  void ctx;
  return () => {
    try { offOverlayBack?.(); } catch { /* ignore */ }
    dispose();
  };
}