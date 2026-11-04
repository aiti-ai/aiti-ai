/**
 * QueueImportButton —— composerTools 插槽入口（输入框下方控制行，与压缩/导入同排）。
 *
 * 队列空时不再让 QueuePanel 孤零零显示上传按钮——导入入口回归底部控制行
 * （复刻 aiti-git-trace TimelineComposerButton 的 32×32 图标按钮形态），始终可用。
 * 点击选 JSON → actions.parseImport（core 纯函数）→ actions.stageImport（弹出
 * 核心恢复对话框）。
 *
 * actions 从 composerTools 插槽 extra.queueActions 取（core 组装；与 queuePanel
 * 共用同一 actions）；extra 未喂时经 "pi-web.composer" 服务兜底（slot extra 回调
 * 解耦方案批次 B，2026-09-16——宿主 extra 已收敛到纯数据）。
 */
import { useRef } from "react";
import { t } from "./host-shim";
import { extSvc } from "./host-shim";
import type { QueuePanelActions } from "./types";

export function QueueImportButton(props: Record<string, unknown>) {
  const actions = (props.queueActions ??
    extSvc<{ get?: (name: string) => unknown }>("pi-web.composer")?.get?.("queueActions")) as QueuePanelActions | undefined;
  const fileRef = useRef<HTMLInputElement>(null);
  const onFile = async (file: File) => {
    if (!actions) return;
    try {
      const entries = actions.parseImport(await file.text());
      if (entries.length === 0) return;
      void actions.stageImport(entries);
    } catch { /* 坏文件静默；stage 失败也静默（恢复对话框由 core 弹） */ }
  };
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void onFile(f);
        }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        title={t("chat.queueImport")}
        aria-label={t("chat.queueImport")}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          width: 32, height: 32, padding: 0,
          background: "none", border: "none", borderRadius: 9,
          color: "var(--text-muted)", cursor: "pointer",
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "none";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </button>
    </>
  );
}
