/**
 * aiti-quickstart · quickstart-logic —— 纯逻辑层（零 JSX、零 ctx，可单测）。
 *
 * 内容：widget 元数据常量（manifest 静态条目与 client 注册条目共用同一份，杜绝漂移）、
 * 侧栏引导卡关闭态存取（localStorage）、openQuickstart 的目标 cwd 解析链
 * （URL ?cwd → home 兜底 → null 放弃）。
 */

export const EXT_ID = "aiti-quickstart";
/** client 服务 key：session-manager 编排器消费（renderQuickstart → DockStack filler）。 */
export const SERVICE_KEY = "aiti-quickstart.api";
/** sidebarFooter 条目 id（manifest 静态条目与 client 注册条目必须同 id——接管语义）。 */
export const FOOTER_ITEM_ID = "quickstart-open";
/** 引导卡关闭态（客户端偏好，与 dock 折叠键同范式：pi:<ext>:<purpose>）。 */
export const DISMISS_KEY = "pi:quickstart:sidebar-dismissed";

/** widget 多语标题 key（qs.guideTitle / qs.shortcutsTitle / qs.examplesTitle）。 */
export const WIDGET_TITLE_KEYS: Record<string, string> = {
  guide: "qs.guideTitle",
  shortcuts: "qs.shortcutsTitle",
  examples: "qs.examplesTitle",
};

export interface QuickstartWidgetMeta {
  id: string;
  areas: Array<"top" | "bottom">;
  defaultArea: "top" | "bottom";
  /** 1..8（桌面 8 列 / 手机 4 列，宿主 clamp）。 */
  w: number;
  /** 1..3（宿主 clamp）。 */
  h: number;
  priority: number;
}

/**
 * widget 元数据（manifest ui.newSessionWidgets 静态条目与 client 注册条目共用）。
 * 布局语义见宿主 lib/new-session-widgets.ts（normalizeWidgetItem 越界钳制 + ⚙ 自定义偏好）。
 */
export const WIDGET_METAS: QuickstartWidgetMeta[] = [
  { id: "guide", areas: ["top"], defaultArea: "top", w: 8, h: 2, priority: 0 },
  { id: "shortcuts", areas: ["top"], defaultArea: "top", w: 4, h: 1, priority: 10 },
  { id: "examples", areas: ["bottom"], defaultArea: "bottom", w: 8, h: 1, priority: 20 },
];

/* ── 引导卡关闭态（localStorage 单一事实源；无事件广播——filler 重渲染时现读） ── */

export function readSidebarDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarDismissed(dismissed: boolean): void {
  try {
    if (dismissed) localStorage.setItem(DISMISS_KEY, "1");
    else localStorage.removeItem(DISMISS_KEY);
  } catch {
    /* ignore */
  }
}

/* ── openQuickstart 目标 cwd 解析链 ── */

/**
 * 解析「重返快速上手页」的目标 cwd：
 *   1) URL query `?cwd=`（AppShell 全程维护该参数——会话视图/欢迎页都带）；
 *   2) 兜底 home（宿主共享单例 pi-web.home.ensure() 的结果，由调用方异步取好传入）；
 *   3) 都没有 → null（调用方 toast 提示后放弃，不导航）。
 */
export function resolveQuickstartCwd(search: string, home: string | null): string | null {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(search || "").get("cwd");
  } catch {
    fromUrl = null;
  }
  const cwd = (fromUrl && fromUrl.trim()) || (home && home.trim()) || "";
  return cwd || null;
}

/** 组合 id 判定（宿主插槽 id 形态 = "extId:itemId"）。 */
export function isQuickstartWidgetId(compositeId: string): boolean {
  return typeof compositeId === "string" && compositeId.startsWith(`${EXT_ID}:`);
}
