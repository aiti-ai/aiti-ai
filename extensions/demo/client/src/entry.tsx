/**
 * demo 扩展 client 入口（组合版）。
 *
 * 这一个 register(ctx) 同时装配两套 UI：
 *   1. 原有自检面板 —— 复用纯 hyperscript 手写的 client/demo-client.mjs（h() 参考写法）。
 *   2. JSX 示例面板 —— client/src/jsx-example.tsx（JSX + TypeScript + npm 依赖）。
 *
 * 证明：扩展 client 既能用手写 h()（零构建直接 serve），也能用 JSX + npm（经
 * esbuild 构建成 client/demo-jsx.mjs）。两条路都通，按需选择。
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 * 部署：node tools/deploy.mjs         （自动先构建再拷贝）
 */

import registerLegacy from "./demo-client.mjs";   // 原有自检（hyperscript 版）
import { __setCtx } from "./host-shim";           // 把 ctx 交给 JSX 侧的宿主桥
import { JsxExamplePanel, JsxToolbarButton, setPanelOpen } from "./jsx-example";
import {
  DockDemoDialog, DockDemoRightTab, DockDemoSidebarSection, DockDemoToolbarButton,
} from "./dock-demo"; // aiti-float dock v0.5.0 试点（双 face + 状态机防双开）
import { seedDockDefault } from "../../../_shared/ext-float-dock";
import { WidgetDemoCard } from "./new-session-widget";

export default function register(ctx: Record<string, unknown>) {
  // v3 §2-B：播种默认落位示范（无偏好时 open 直达右栏；⇲ 后用户偏好优先）
  seedDockDefault("demo:dock", "right-panel");
  // 1) 原有自检所有 slot（hyperscript 写法，保持不变）
  registerLegacy(ctx as Parameters<typeof registerLegacy>[0]);

  // 2) JSX 示例（本文件是 .tsx，以下组件全部用 JSX 渲染）
  __setCtx(ctx); // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）

  function DialogsSlot() {
    // 关闭必须走模块级开关 setPanelOpen(false)——JsxExamplePanel 内部的遮罩/关闭
    // 按钮都调 onClose，onClose 若传空函数则面板关不掉（曾踩坑）。
    return <JsxExamplePanel onClose={() => setPanelOpen(false)} />;
  }

  ctx.registerItems?.("toolbar", [
    { id: "jsx-example", render: JsxToolbarButton, meta: { label: "JSX 示例" } },
    { id: "dock-demo", render: DockDemoToolbarButton, meta: { label: "停靠示例" } },
  ]);
  ctx.registerItems?.("dialogs", [
    { id: "jsx-example", render: DialogsSlot, meta: { label: "JSX 示例面板" } },
    { id: "dock-demo", render: DockDemoDialog, meta: { label: "停靠示例（浮窗态）" } },
  ]);
  // 停靠 faces（dock 方案 §6：同一内容组件注册两处，gate 门控结构性防双开）
  // ⚠ dock item 注册 raw itemId（宿主自动拼 extId:itemId = itemKey）——状态机 key "demo:dock"
  // 的 itemId 段是 "dock"，故此处必须 id: "dock"（原 "dock-demo" 拼后不匹配 → dock tab 从未出现）
  ctx.registerItems?.("rightFileDock", [{ id: "dock", render: DockDemoRightTab, meta: { title: "🧩 停靠示例" } }]);
  ctx.registerItems?.("sidebarExplorerDock", [{ id: "dock", render: DockDemoSidebarSection, meta: { title: "🧩 停靠示例", priority: 4 } }]);
  // 新会话欢迎页小组件（newSessionWidgets）：meta 标注允许区域 + 栅格尺寸（手机 4 列/
  // 桌面 8 列，w4=手机满行/桌面半行）；extra 只喂数据 {cwd,isMobile,area}，用户可在
  // 「自定义小组件」面板排序/跨区移动/隐藏。方案 docs/pi-web-new-session-widgets-plan.md
  ctx.registerItems?.("newSessionWidgets", [
    { id: "widget", render: WidgetDemoCard, meta: { title: "示例小组件", areas: ["top", "bottom"], defaultArea: "bottom", w: 4, h: 1 } },
  ]);
}
