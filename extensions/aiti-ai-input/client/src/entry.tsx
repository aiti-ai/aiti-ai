/**
 * AI input（aiti-ai-input）· client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx) 装配（与原手写单文件版一比一）：
 *   - features：读 host 共享 store + 订阅变更（零请求/零轮询）
 *   - initSuggest(ctx.apiUrl)：收藏联想子系统（点按分派注入）
 *   - document capture 三监听（语音检测，在 React 受控 onChange 之前拿原始 inputType）
 *   - chatInputTop 四 slot：感知条 / 占位符 chips / 补全宿主 / 联想宿主
 *   - sessionStats slot：其他辅助 AI 用量统计行（会话统计下拉内，原宿主 AiUsageRows 迁入）
 *   - preSend 钩子：展开 [名称] 占位符 + 清理语音/灰字状态
 *
 * 薄壳拆分（2026-09-14，方案 pi-web-eager-ext-split-plan.md §5.2）：
 *   - L2 录音引擎 → voice-l2.ts（懒 chunk，VoiceAffixButton 首次按住加载）；
 *   - ASR 服务器管理面板 → asr-panel.tsx（懒 chunk，toolbar/extman/dock 面激活加载）；
 *   - 语音流量报表 → usage-report.tsx（懒 chunk，dialogs meta.open / 右栏面激活加载）；
 *   - 本文件只留 register + 轻量 widgets 注册 + 键/开关/一次性偏好清理（eager）。
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 */
import { __setCtx } from "./host-shim";
import {
  AC, BARP,
  onBeforeInput, onCompositionStart, onCompositionEnd,
  setVoicePending, voiceFixReset, acClearGhost, syncAcFeatures, acEnforceMinChars, initSuggest,
} from "./logic";
import { VoiceTagBar, MarksBar, AutocompleteHost, SuggestHost, AuxAiUsageRows, VoiceAffixButton } from "./components";
import { openFloat, closePanel, usePresent, declareDockZones } from "../../../_shared/ext-float-dock-lite";
import { lazyExtView, createLazyModule } from "../../../_shared/ext-lazy";


/* ── 懒模块引用（薄壳拆分 §5.2）：面板/报表首屏不加载，交互时 import ── */
const asrPanelRef = createLazyModule(() => import("./asr-panel"));
const usageReportRef = createLazyModule(() => import("./usage-report"));

// ---- 面板键与开关（eager 侧唯一所有；懒 chunk 反向 import 本模块的常量/开关）----
export const ASR_KEY = "aiti-ai-input:asr";
export const USAGE_KEY = "aiti-ai-input:asr-usage";
export function asrOpenSet(v: boolean) { if (v) openFloat(ASR_KEY); else closePanel(ASR_KEY); }
export function usageOpenSet(v: boolean) { if (v) openFloat(USAGE_KEY); else closePanel(USAGE_KEY); }

/** 一次性清理：本面板曾被 seed 成「默认停靠左栏」，改为默认浮窗（只跑一次，之后手动停靠的选择不覆盖）。 */
export function initAsrDockPref(): void {
  try {
    const flag = "aiti-ai-input:asr:dock-pref-init";
    if (localStorage.getItem(flag)) return;
    localStorage.removeItem(`pi-web:ext-float:dockpref:v1:${ASR_KEY}`);
    localStorage.setItem(flag, "1");
  } catch { /* ignore */ }
}

/** 一次性清理：早期版本给报表 seed 过「默认停靠左栏」偏好（导致默认入左栏且 ✕ 关不掉），
 *  恢复为浮窗（只跑一次；之后用户手动停靠的选择不会被覆盖）。 */
export function initUsageDockPref(): void {
  try {
    const flag = "aiti-ai-input:asr-usage:dock-pref-init";
    if (localStorage.getItem(flag)) return;
    localStorage.removeItem(`pi-web:ext-float:dockpref:v1:${USAGE_KEY}`);
    localStorage.setItem(flag, "1");
  } catch { /* ignore */ }
}

// ---- 常挂插槽懒包装（dialogs/rightFileDock 常挂载；active=false 渲染 null 且不 import）----

export function AsrPanelSlotLazy() {
  const st = usePresent(ASR_KEY);
  return lazyExtView({ active: st === "floating", load: asrPanelRef, pick: "AsrPanelSlot" });
}
export function AsrDockRightLazy() {
  const st = usePresent(ASR_KEY);
  return lazyExtView({ active: st === "docked:right-panel", load: asrPanelRef, pick: "AsrDockRight" });
}
export function UsageReportSlotLazy() {
  const st = usePresent(USAGE_KEY);
  return lazyExtView({ active: st === "floating", load: usageReportRef, pick: "UsageReportSlot" });
}
export function UsageDockRightLazy() {
  const st = usePresent(USAGE_KEY);
  return lazyExtView({ active: st === "docked:right-panel", load: usageReportRef, pick: "UsageDockRight" });
}

export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);
  AC.apiUrl = ctx.apiUrl as (p: string) => string; // 绑定浏览器 basePath 前缀的 API 构造器
  // features：读 host 共享 store（已统一拉取），订阅 host 通知（extman 改 → 重读），零请求/零轮询
  AC.getFeatures = typeof ctx.getFeatures === "function" ? ctx.getFeatures : null;
  AC.onFeatureChange = typeof ctx.onFeatureChange === "function" ? ctx.onFeatureChange : null;
  syncAcFeatures();
  // 🎤 feature 门控在 VoiceAffixButton 组件内自理（onFeatureChange 触发其重渲染即时卸载）
  if (AC.onFeatureChange) (AC.onFeatureChange as (fn: () => void) => void)(() => { syncAcFeatures(); acEnforceMinChars(); });

  // 收藏联想子系统（SUG 闭包 + 点按分派注入 pickPromptUser/pickEmptyUser）
  const sug = initSuggest(AC.apiUrl);

  // 事件监听（capture：在 React 受控 onChange 之前拿到原始 inputType）
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("compositionstart", onCompositionStart, true);
  document.addEventListener("compositionend", onCompositionEnd, true);

  const sugProps = { sug };
  ctx.registerItems?.("chatInputTop", [
    { id: "aiti-ai-input-voice-tag", render: VoiceTagBar },
    { id: "aiti-ai-input-marks", render: MarksBar },
    { id: "aiti-ai-input-autocomplete", render: AutocompleteHost },
    { id: "aiti-ai-input-suggest", render: () => <SuggestHost {...sugProps} /> },
  ]);

  // 输入框右缘 🎤（composerAffix 插槽）：小屏=右端条件组（§十九 v4），大屏=输入框尾部 affix 组
  // （core 两个互斥分支各渲染一次本插槽，不会重复）——「启用语音即恒在」，不与 ×清空互斥。
  // feature 门控（voice.enabled）在组件内自理（onFeatureChange 重渲染即时卸载，S29）；
  // 桌面旧浮层绿圆钮（mountVoiceInlineButton）已退役删除。
  ctx.registerItems?.("composerAffix", [
    { id: "aiti-ai-input-voice-affix", render: VoiceAffixButton },
  ]);

  // 会话统计下拉（宿主 sessionStats 插槽）：其他辅助 AI 用量统计行（本扩展续写/语音场景）
  // 语音识别服务器管理弹窗：toolbar 声明式（宿主自动绘制标准图标按钮 + feature 门控统一过滤）+ dialogs 常挂自控显隐
  // 打开函数：toolbar.enabled 关（工具条 🎙️ 不渲染）也能开面板——extman「打开」走 tryDirectOpen
  // 通道 1（meta.open，最可靠），与按钮 onClick 共用同一逻辑，设计上「禁用只收入口、面板仍可开」。
  const openAsrPanel = () => {
    // 薄壳拆分后 asrOpenSet 就在本模块（原信箱 __aitiAsrOpen + 5×200ms 重试已退役）：
    // openFloat 是纯 JS 状态机调用，不依赖懒 chunk 是否已加载——面板 chunk 由
    // dialogs 插槽的懒包装在 gate 开启后自行加载。
    asrOpenSet(true);
  };
  ctx.registerItems?.("toolbar", [{
    id: "aiti-asr-open",
    feature: "toolbar.enabled", // 顶级总闸：关→宿主统一不渲染顶部 🎙️ 图标（旧 asr.hotwords.panel 已提升换名）
    meta: {
      icon: "icons/mic.svg", label: "语音识别服务器管理", title: "语音识别服务器管理（状态 / 启停 / 热词）",
      open: openAsrPanel,  // extman 直接打开通道（feature 关/图标隐藏也生效）
      onClick: openAsrPanel,
    },
  }]);
  ctx.registerItems?.("dialogs", [{ id: "aiti-asr-panel", render: AsrPanelSlotLazy, meta: { open: openAsrPanel } }]);
  // aiti-float dock v3（P2 批）：ASR 服务器管理默认左栏（feature 行列表窄条）
  // zone 规范值 sidebar:<key>（v4；旧 sidebar-explorer 兼容读）
  // 语音识别引擎：默认**浮窗**（不 seed 停靠位）；左栏/右栏 face 仅供用户手动 ⇱ 停靠
  initAsrDockPref();
  declareDockZones("aiti-ai-input:asr", ["right-panel"]);
  ctx.registerItems?.("rightFileDock", [{ id: "asr", render: AsrDockRightLazy, meta: { title: "语音识别引擎" } }]);
  // 语音流量统计报表（形态对齐 aiti-ai-usage：KPI + 趋势 + 明细 + 估算费用）
  // 默认**浮窗**（不 seed 停靠位 → 不会默认出现在左栏）；左栏/右栏 face 仅供用户手动 ⇱ 停靠
  initUsageDockPref();
  declareDockZones("aiti-ai-input:asr-usage", ["right-panel"]);
  ctx.registerItems?.("dialogs", [{ id: "aiti-asr-usage-report", render: UsageReportSlotLazy, meta: { open: () => usageOpenSet(true) } }]);
  ctx.registerItems?.("rightFileDock", [{ id: "asr-usage", render: UsageDockRightLazy, meta: { title: "语音流量" } }]);
  ctx.registerItems?.("sessionStats", [
    { id: "aiti-ai-input-aux-usage", render: AuxAiUsageRows },
  ]);

  // 发送钩子：仅展开本扩展的 [名称] 占位符；语音经主动修复处理（不再附 [语音输入] 标签）
  ctx.registerChatHook?.({
    preSend: (raw: unknown) => {
      acClearGhost(); // 发送即清 AI 续写灰字 overlay，防残留
      let out = String(raw || "");
      for (const m of BARP.marks) { if (m && m.mark && m.text) out = out.split(m.mark).join(m.text); }
      for (const k in BARP.markMap) { const v = BARP.markMap[k]; if (v && out.indexOf(k) >= 0) out = out.split(k).join(v); }
      setVoicePending(false);
      voiceFixReset();
      return out !== String(raw || "") ? { text: out } : null;
    },
  });

  // 调试日志（devtools 面板可查）：确认检测/附加是否生效
  try { console.log("[AI input] 已就绪：语音来源标记 + AI 行内自动补全 + 收藏联想 suggest（Tab/回车/↑↓，静态优先）"); } catch {}

  // 语音输入 🎤 统一走 composerAffix 行内插槽（小屏右端组 + 大屏输入框尾部 affix 组）——
  // 桌面浮层绿圆钮（旧 mountVoiceInlineButton）退役删除；热重载/旧版本残留按钮摘除即可。
  try { document.getElementById("aiti-voice-inline")?.remove(); } catch {}
}
