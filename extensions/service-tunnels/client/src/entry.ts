/**
 * service-tunnels 客户端入口（register(ctx)）。
 *
 * 装配：
 *   - toolbar：🌐 globe 按钮（原 AppShell 内建 services 按钮规格）→ 打开 ServicesDialog
 *   - dialogs：ServicesDialog（Ports / Self / Users 三页签，功能与 pi-web core 版一致）
 *   - banners：自暴露无认证红色告警（原 SelfExposeAlert）
 *
 * API 走 /api/extensions/service-tunnels/*（宿主 catch-all 分发，DNS-rebinding
 * 门禁由宿主完成）。文件打开经 aiti_open_file postMessage（宿主 AppShell 监听）。
 */
import { __setCtx, openFileInHost } from "./host-shim";
// 库 CATALOG 新域键合并进 I18N（构建期静态；模块副作用——必须先于消费组件求值）
import "./lib-i18n";
import { ST_KEY, ServicesDialog } from "./ServicesDialog";
import { SelfExposeAlert } from "./SelfExposeAlert";
// dock v3（P3 批）：面板显隐收口展示状态机 + 右栏停靠 face
import { usePresent, DockBody, openFloat, closePanel, seedDockDefault } from "../../../_shared/ext-float-dock";

// 对话框开关 + 初始页签（工具栏按钮 / 告警条幅共用）；显隐收口展示状态机
let initialTab: "ports" | "self" | "users" = "ports";
function setDialog(v: boolean, tab: "ports" | "self" | "users" = initialTab) {
  if (v) initialTab = tab;
  if (v) openFloat(ST_KEY); else closePanel(ST_KEY);
}
function openDialog(tab: "ports" | "self" | "users" = "ports") {
  setDialog(true, tab);
}
// 播种默认落位：用户无偏好时 open 直达右栏 tab
try {
  const pk = "pi-web:ext-float:dockpref:v1:" + ST_KEY;
  if (!localStorage.getItem(pk)) localStorage.setItem(pk, "right-panel");
} catch { /* ignore */ }

// 自暴露告警按事件驱动（mount + focus/visibility/online），无需脉冲。

export default function register(ctx: {
  h: unknown;
  useState: unknown;
  useEffect: unknown;
  useRef: unknown;
  useCallback: unknown;
  useMemo: unknown;
  apiUrl: (p: string) => string;
  registerItems: (slot: string, items: Array<{ id: string; render: (props: Record<string, unknown>) => unknown; meta?: Record<string, unknown> }>) => void;
  [key: string]: unknown;
}) {
  // 1) 先把 ctx 交给 shim（react hooks / apiUrl / i18n 委托）
  __setCtx(ctx as Record<string, unknown>);
  const { h, useState, useEffect } = ctx;

  // （原 usePulse 脉冲已移除：自暴露告警改为事件驱动，不再轮询）

  // 2) 工具栏 globe 按钮（原 AppShell services 内建按钮规格）
  function ToolbarButton() {
    // dock v3：开态高亮跟随展示状态机（浮窗/停靠都算开）
    const st = usePresent(ST_KEY);
    const isOpen = st !== "closed";
    return h("button", {
      type: "button",
      title: "服务端口与隧道（发现 / 暴露 / 认证 / 自暴露）",
      "aria-label": "服务端口",
      "aria-haspopup": "dialog",
      "aria-expanded": isOpen,
      onClick: () => (isOpen ? setDialog(false) : openDialog("ports")),
      onMouseEnter: (e) => { if (!isOpen) e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { if (!isOpen) e.currentTarget.style.color = "var(--text-muted)"; },
      style: {
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: isOpen ? "var(--bg-selected)" : "none",
        borderTop: "none", borderRight: "1px solid var(--border)",
        color: isOpen ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      },
    },
      h("svg", {
        width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
      },
        h("circle", { key: "c1", cx: 12, cy: 12, r: 10 }),
        h("line", { key: "l1", x1: 2, y1: 12, x2: 22, y2: 12 }),
        h("path", { key: "p1", d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" }),
      ),
    );
  }

  // 3) ServicesDialog（dialogs 插槽 = 浮窗 face：仅 floating 渲染）
  function DialogsSlot() {
    const st = usePresent(ST_KEY);
    if (st !== "floating") return null;
    return h(ServicesDialog, {
      onClose: () => setDialog(false),
      onOpenFile: (filePath: string, fileName?: string) => openFileInHost(filePath, fileName),
      initialTab,
    });
  }

  // 3.5) 右栏停靠 face（rightFileDock item "ports" → 复合 id = ST_KEY）：仅 docked:right-panel 渲染
  function TunnelDockFace() {
    const st = usePresent(ST_KEY);
    if (st !== "docked:right-panel") return null;
    return h(DockBody, {
      itemKey: ST_KEY, zone: "right-panel", title: "服务端口", chrome: "tab",
      zones: ["right-panel"], defaultZone: "right-panel",
    },
      h(ServicesDialog, {
        embedded: true,
        onClose: () => setDialog(false),
        onOpenFile: (filePath: string, fileName?: string) => openFileInHost(filePath, fileName),
        initialTab: "ports",
      }));
  }

  // 4) 自暴露无认证告警（宿主挂载点 <ExtSlot name="banners">）
  function BannersSlot() {
    return h(SelfExposeAlert, {
      onOpenServices: () => openDialog("self"),
    });
  }

  // 懒加载 v2 M3批②：声明式条目（无 render）。banner（自暴露告警）物化前不显示——低频安全提示，已记录可接受
  ctx.registerItems("toolbar", [{
    id: "ports",
    meta: {
      label: "服务端口",
      title: "服务端口与隧道（发现 / 暴露 / 认证 / 自暴露）",
      icon: { svg: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' },
      onClick: () => openDialog("ports"),
    },
  }]);
  ctx.registerItems("dialogs", [{ id: "ports", render: DialogsSlot }]);
  // aiti-float dock v3（P3 批）：右栏「服务端口」tab
  ctx.registerItems("rightFileDock", [{ id: "ports", render: TunnelDockFace, meta: { title: "服务端口" } }]);
  ctx.registerItems("banners", [{ id: "self-expose-alert", render: BannersSlot }]);
}
