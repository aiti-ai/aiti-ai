/**
 * aiti-prompts · client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx) 装配：
 *   - toolbar 📌 按钮
 *   - dialogs：主面板 + 保存弹层
 *   - userMessageActions：用户消息 hover「收藏」扩展点
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 * 部署：node tools/deploy.mjs         （自动先构建再拷贝）
 */
import { __setCtx } from "./host-shim";
import { seedDockDefault, declareDockZones, sidebarZoneOf } from "../../../_shared/ext-float-dock";
import { dockIconDecl } from "../../../_shared/dock-icons";
import { PANEL_KEY } from "./prompts-app";
import { openFromToolbar, PromptsPanelSlot, PromptsDockLeft, PromptsDockRight, PromptsSaveSlot, PromptsMessageAction, __bindSendChat, __openExternal, setAppCtx } from "./prompts-app";
import { exportPromptsOnClick, ExportPromptsDialog } from "./export-dialog";
import { t as t2 } from "./host-shim";

export default function register(ctx: Record<string, any>) {
  setAppCtx(ctx);   // DI 方案 P2：extSvc 消费用（services 通道）
  __setCtx(ctx);

  // 发送通道绑定（模块级 sendChat；失败经 prompts-app 内 showErr 提示）
  __bindSendChat((text: string, mode: any) => { ctx.sendChatMessage(text, mode); });

  // 懒加载 v2 M3批②：声明式条目（无 render）。userMessageActions 📌 物化前不显示——hover 低频，已记录可接受
  ctx.registerItems("toolbar", [{
    id: "aiti-prompts-open",
    meta: {
      label: "i18n:it.open.label",
      title: "i18n:it.open.title",
      icon: "icons/bookmark.svg",
      onClick: () => openFromToolbar(),
    },
  }]);

  // 跨扩展打开（plan-first「方案先行」prompt 编辑等）：window.dispatchEvent(new CustomEvent("aiti-prompts-open", { detail }))
  if (typeof window !== "undefined") {
    window.addEventListener("aiti-prompts-open", (e: Event) => { __openExternal((e as CustomEvent).detail || {}); });
  }
  ctx.registerItems("dialogs", [
    { id: "aiti-prompts-panel", render: PromptsPanelSlot },
    { id: "aiti-prompts-save", render: PromptsSaveSlot },
    { id: "aiti-prompts-export", render: ExportPromptsDialog, meta: { label: "i18n:it.export.label" } },
  ]);
  // defork B2：「导出 Prompts」入口（原 core 更多菜单 export 项外迁）。
  // toolbar 声明式（无 render）：宿主画标准图标按钮，onClick 开 dialogs 弹窗。
  ctx.registerItems("toolbar", [{
    id: "aiti-prompts-export",
    meta: { label: "i18n:it.export.label.2", title: t2("exportPrompts.title"), icon: "icons/import.svg", onClick: exportPromptsOnClick },
  }]);
  // aiti-float dock v3（P2 批）：收藏库默认左栏（单列收藏流「随手查随手插」）；不接右栏
  // zone 规范值 sidebar:<key>（v4；旧 sidebar-explorer 兼容读）
  seedDockDefault(PANEL_KEY, sidebarZoneOf(PANEL_KEY));
  declareDockZones(PANEL_KEY, [sidebarZoneOf(PANEL_KEY), "right-panel"], sidebarZoneOf(PANEL_KEY));
  ctx.registerItems("rightFileDock", [{ id: "panel", render: PromptsDockRight, meta: { title: "i18n:it.panel.title", icon: dockIconDecl("library") } }]);
  ctx.registerItems("sidebarExplorerDock", [{ id: "panel", render: PromptsDockLeft, meta: { title: "i18n:it.panel.title.2", priority: 3 } }]);
  ctx.registerItems("userMessageActions", [{
    id: "aiti-prompts-save-message",
    render: (props: any) => <PromptsMessageAction text={props && typeof props.text === "string" ? props.text : ""} />,
  }]);
}