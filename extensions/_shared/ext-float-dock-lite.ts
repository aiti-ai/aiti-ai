/**
 * _shared/ext-float-dock-lite.ts — dock/present 状态机的 **壳用薄层**（P1-3，方案
 * pi-web-eager-ext-split-plan.md §6 P1-3）。
 *
 * eager 薄壳（拆包扩展 entry）只需要：usePresent/useGate（门控 hooks）+ present
 * 状态机小 API（openFloat/closePanel/seedDockDefault/declareDockZones…）。
 * 本模块 = 这层最小面（hooks 在此、状态机 re-export 自 ext-float-dock-core），
 * **不含 DockBody/头行 UI**——那些留在 ext-float-dock.ts（重模块，随懒 chunk 走）。
 * 拆包扩展的壳 import 本文件，首屏不再连带 17+ KB 的 dock UI 层。
 *
 * 未拆包扩展可继续 import ext-float-dock.ts（全量面，re-export 本模块，行为不变）。
 */
import { useEffect, useState } from "react";
import { presentState, onPresentChange, CHANGE_EVENT } from "./ext-float-dock-core";
import type { PresentState, DockZone } from "./ext-float-dock-core";

// 纯状态层全量转出：壳只 import 本模块即可覆盖 register 期 + 门控 + 开关
export {
  present, presentState, onPresentChange, dockPref,
  openFloat, closePanel, dockTo, dockToSidebar, undockToFloat,
  setDockPref, clearDockPref, seedDockDefault, declareDockZones,
  positionMenuItems, DOCK_ZONE_LABELS,
  sidebarZoneOf, isSidebarDockState,
  type DockZone, type PresentState,
} from "./ext-float-dock-core";

export function usePresent(itemKey: string): PresentState {
  const [state, setState] = useState<PresentState>(() => presentState(itemKey));
  useEffect(() => {
    setState(presentState(itemKey));
    // 双通道订阅（时序免疫，2026-09-12 修「All Sessions 打不开」）：本组件挂载若早于
    // aiti-float install（bundle 就绪顺序竞态），floatApi() 为 null → onPresentChange
    // 订阅落进下方降级 store，此后 __piweFloat 状态机的更新永远收不到 → 面板 gate
    // 恒 closed 打不开。两条状态机（api 状态机与降级 localPresent）都广播同名
    // window CHANGE_EVENT，挂 window 兜底监听即可双向覆盖；api 在场时双通道同值
    // 触发，setState 同值幂等无害。
    const h = ((e: CustomEvent<{ key: string; state: PresentState }>) => {
      if (e.detail?.key === itemKey) setState(e.detail.state);
    }) as EventListener;
    window.addEventListener(CHANGE_EVENT, h);
    const off = onPresentChange((d) => { if (d.key === itemKey) setState(d.state); });
    return () => { window.removeEventListener(CHANGE_EVENT, h); off(); };
  }, [itemKey]);
  return state;
}

/** 渲染门控（结构性防双开）：face="float" → 仅浮窗态渲染；face={dock:zone} → 仅对应嵌入态渲染。 */
export function useGate(itemKey: string, face: "float" | { dock: DockZone }): boolean {
  const state = usePresent(itemKey);
  if (face === "float") return state === "floating";
  return state === `docked:${face.dock}`;
}
