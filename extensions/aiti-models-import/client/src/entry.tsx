/**
 * aiti-models-import · client 入口
 *
 * register(ctx)：
 *   1. toolbar 按钮（icons/import.svg，手动打开导入弹窗）
 *   2. dialogs 插槽常驻条目（ImportDialogSlot，显隐模块内状态）
 *   3. 首启自动弹：register 时 fetch /status 一次（事件驱动，无轮询）——
 *      firstRun（无 completedAt/dismissedAt）且存在可用来源 → 打开弹窗（只打扰一次）
 */
import { __setCtx } from "./host-shim";
import { ImportDialogSlot, setDialogOpen } from "./import-app";

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx); // 必须在任何 JSX 渲染前

  function ImportButton() {
    return (
      <button type="button" title="从其他 Agent 导入模型配置（codex / zcode / opencode…）"
        onClick={() => setDialogOpen(true)}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, padding: 0, background: "none", borderTop: "none", borderRight: "1px solid var(--border)", color: "var(--text-muted)", cursor: "pointer", fontSize: 15 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m7 10 5 5 5-5" />
          <path d="M12 15V3" />
        </svg>
      </button>
    );
  }

  ctx.registerItems?.("toolbar", [{ id: "aiti-models-import-open", render: ImportButton, meta: { label: "导入模型配置", icon: "icons/import.svg" } }]);
  ctx.registerItems?.("dialogs", [{ id: "aiti-models-import-dialog", render: ImportDialogSlot, meta: { label: "模型配置导入" } }]);

  // 跨扩展打开服务（quickstart 引导卡「从 Agent 导入…」消费；ext-services 拍板正路）。
  // 消费方探测式软依赖：本扩展缺席/旧版无服务 → 对方不渲染入口。
  try {
    ctx.registerExtService?.("aiti-models-import.open", { open: () => setDialogOpen(true) });
  } catch { /* ignore */ }

  // 首启判定：每页面加载至多一次 /status；firstRun 且有可用来源 → 自动弹（关过/导过即不再弹）
  try {
    const base = typeof (ctx as any).apiUrl === "function" ? (ctx as any).apiUrl("/api/extensions/aiti-models-import/status") : "/api/extensions/aiti-models-import/status";
    fetch(base, { cache: "no-store" })
      .then((r) => r.json())
      .then((st) => {
        if (st && st.ok && st.firstRun && Array.isArray(st.sources) && st.sources.some((s: any) => s.available)) {
          setDialogOpen(true);
        }
      })
      .catch(() => { /* 状态不可得就不弹（手动入口仍在） */ });
  } catch { /* 极端环境防御 */ }
}
