/**
 * aiti-session-cards · 会话请求卡扩展（agent 能力 UI 去核化 P1）。
 *
 * 把 pi-web core 的交互元语卡（plan_approval/ask_user/open_url/generic）与工具授权卡外迁为
 * 独立扩展；core 留接缝（sessionRequestCard 插槽 + 三家族派生状态 + 统一作答分派）与极简兜底卡。
 * provider_headers 验证码卡归 aiti-zcode-agent client（谁的能力谁渲染）。
 *
 * 接缝契约：docs/pi-web-agent-capability-ui-ext-plan.md §2.1。
 */
export default {
  id: "aiti-session-cards",
  name: "会话请求卡（审批/问答/授权）",
  icon: "icons/message-square.svg",
  client: "dist/aiti-session-cards.mjs",
  features: [
    {
      id: "sessionCards.enabled",
      type: "boolean",
      label: "完整请求卡 UI",
      placeholder: "方案审批/问答选项/授权选项完整交互；关闭后落宿主极简兜底卡（仍可接受/拒绝）",
      enabled: true,
    },
  ],
};
