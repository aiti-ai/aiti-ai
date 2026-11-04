/**
 * aiti-acp-agent · client 公共件（薄壳 entry 与懒 chunk acp-manage 共享）。
 *
 * 薄壳拆分（2026-09-14，方案 pi-web-eager-ext-split-plan.md §5.3）：
 * 弹窗 UI 全部移入 acp-manage.tsx（交互后才 import）；本文件只留壳与重模块
 * 都需要的最小件——item key、开关（openFloat/closePanel）、图标。
 */
import { openFloat, closePanel, sidebarZoneOf } from "../../../_shared/ext-float-dock-lite";

export const ACP_KEY = "aiti-acp-agent:manage";

/** 弹窗开关（模块级共享：toolbar / Backend 选择器旁入口 / dialogs meta.open 都开同一弹窗） */
export function setDialogOpen(v: boolean) {
  if (v) openFloat(ACP_KEY);
  else closePanel(ACP_KEY);
}

/** 浮窗默认落位（zone 规范值 sidebar:<key>）——register 期声明用 */
export function acpDefaultZone(): string {
  return sidebarZoneOf(ACP_KEY);
}

// ---- 图标（lucide plug 风格线条）----
export function PlugIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}
