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
import { seedDockDefault, declareDockZones, sidebarZoneOf } from "@aiti-ai/ext-shared/ext-float-dock";
import { PANEL_KEY, PROMPT_DOCK_ICON } from "./prompts-app";
import { openFromToolbar, PromptsPanelSlot, PromptsDockLeft, PromptsDockRight, PromptsSaveSlot, PromptsMessageAction, __bindSendChat, __openExternal, setAppCtx } from "./prompts-app";
import { exportPromptsOnClick, ExportPromptsDialog } from "./export-dialog";
import { t as t2, apiUrl as tApiUrl } from "./host-shim";

export default function register(ctx: Record<string, any>) {
  setAppCtx(ctx);   // DI 方案 P2：extSvc 消费用（services 通道）
  __setCtx(ctx);

  // 发送通道绑定（模块级 sendChat；失败经 prompts-app 内 showErr 提示）
  __bindSendChat((text: string, mode: any) => { ctx.sendChatMessage(text, mode); });

  // 懒加载 v2 M3批②：声明式条目（无 render）。userMessageActions 📌 物化前不显示——hover 低频，已记录可接受
  // Lazy-load v2 two-stage entry: the registered label must resolve to the same text as
  // the static ui.toolbar declaration (pp.app.label), otherwise the app-center card's label
  // flips once the client materializes (and the toolbar/dock cards stop deduping).
  // One registerItems call for the whole slot: a second call would register the slot's items
  // incrementally, and the host re-reads (useSyncExternalStore is synchronous) between the two
  // calls — the not-yet-registered static entry would look unmatched (transient mismatch warning
  // and a one-frame double button). Export entry included here for the same reason.
  ctx.registerItems("toolbar", [{
    id: "aiti-prompts-open",
    meta: {
      label: "i18n:pp.app.label",
      title: "i18n:it.open.title",
      icon: "icons/bookmark.svg",
      onClick: () => openFromToolbar(),
    },
  }, {
    // defork B2: the old core "more menu → export" entry. Declarative (no render); the host
    // renders the standard icon button, onClick opens the dialogs item.
    id: "aiti-prompts-export",
    meta: { label: "i18n:it.export.label.2", title: t2("exportPrompts.title"), icon: "icons/import.svg", onClick: exportPromptsOnClick },
  }]);

  // share-sink（aiti-msg-share 拥有契约）：把 Prompt 片段做成分享中心里固定的「收藏」目标。
  // 与 content-share 的 target provider 语义不同——这里只做本地落库，不生成 URL、不做脱敏。
  try {
    (ctx as any).registerTopicItem?.("share-sink", {
      id: "aiti-prompts.prompt",
      order: 20,
      get label() { return t2("share.sink.prompt"); },
      icon: { svg: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>' },
      // A snippet is text: whole sessions/images/files are not prompt material.
      accepts: (payload: any) => {
        if (!payload || typeof payload.text !== "string" || !payload.text.trim()) return false;
        if (payload.kind === "image" || payload.kind === "file") return false;
        return payload.text.length <= 4000;
      },
      async save(payload: any) {
        const text = String(payload?.text || "").trim();
        if (!text) return { ok: false, message: t2("share.sink.prompt.empty") };
        try {
          const r = await fetch(tApiUrl("/api/extensions/aiti-prompts/prompts"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, source: "input", tags: payload.tags ? String(payload.tags).split(/[,，]/).map((x: string) => x.trim()).filter(Boolean) : [] }),
          }).then((x) => x.json());
          if (!r || !r.ok) return { ok: false, message: (r && r.error) || t2("share.sink.prompt.failed") };
          return {
            ok: true,
            message: t2("share.sink.prompt.saved") + String(r.prompt?.name || ""),
            action: { label: t2("share.sink.prompt.open"), run: () => openFromToolbar() },
          };
        } catch (e: any) {
          return { ok: false, message: String(e?.message || e) };
        }
      },
    });
  } catch (e) { /* old host without topic registry */ }

  // 跨扩展打开（plan-first「方案先行」prompt 编辑等）：window.dispatchEvent(new CustomEvent("aiti-prompts-open", { detail }))
  if (typeof window !== "undefined") {
    window.addEventListener("aiti-prompts-open", (e: Event) => { __openExternal((e as CustomEvent).detail || {}); });
  }
  ctx.registerItems("dialogs", [
    { id: "aiti-prompts-panel", render: PromptsPanelSlot },
    { id: "aiti-prompts-save", render: PromptsSaveSlot },
    { id: "aiti-prompts-export", render: ExportPromptsDialog, meta: { label: "i18n:it.export.label" } },
  ]);
  // aiti-float dock v3（P2 批）：收藏库默认左栏（单列收藏流「随手查随手插」）；不接右栏
  // zone 规范值 sidebar:<key>（v4；旧 sidebar-explorer 兼容读）
  seedDockDefault(PANEL_KEY, sidebarZoneOf(PANEL_KEY));
  declareDockZones(PANEL_KEY, [sidebarZoneOf(PANEL_KEY), "right-panel"], sidebarZoneOf(PANEL_KEY));
  // Dock tab label mirrors the toolbar label (same item surfaced in two slots): app-center
  // dedupes cards by (extId,label), so both phases and both slots must agree.
  ctx.registerItems("rightFileDock", [{ id: "panel", render: PromptsDockRight, meta: { title: "i18n:pp.app.label", icon: PROMPT_DOCK_ICON } }]);
  ctx.registerItems("sidebarExplorerDock", [{ id: "panel", render: PromptsDockLeft, meta: { title: "i18n:it.panel.title.2", priority: 3 } }]);
  ctx.registerItems("userMessageActions", [{
    id: "aiti-prompts-save-message",
    render: (props: any) => <PromptsMessageAction text={props && typeof props.text === "string" ? props.text : ""} />,
  }]);
}