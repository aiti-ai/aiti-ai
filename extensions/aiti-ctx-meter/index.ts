/**
 * aiti-ctx-meter · 输入区上下文比例条指示器（纯 client，无 server 段）。
 *
 * 方案 docs/aiti-ctx-meter-plan.md：
 *   - compactLead（桌面）：压缩按钮左邻位竖向比例条，显示 context %（extra.context.urgency 着色）
 *   - modelInfoLead（小屏两处，宿主新插槽）：ModelSelector 前同款比例条
 *   - 点击 → extra.openSessionInfo() 打开宿主会话统计面板（token 明细 + 三态压缩按钮）
 *
 * 注：余额/额度展示已统一收归宿主 provider-usage 面板（2026-09-13 去重）；
 * 本扩展不再接管 sessionStats 插槽。
 *
 * 数据全部来自插槽 extra（context/compact/openSessionInfo）——percent 随宿主 state 事件驱动，
 * 宿主只透传零展示逻辑（方案 §4）；压缩三态接缝 = streamingActions 提案压缩子集（方案 §5）。
 */
export default {
  id: "aiti-ctx-meter",
  name: "上下文比例条（context %）",
  icon: "icons/meter-vertical.svg",
  client: "dist/aiti-ctx-meter-client.mjs",
  ui: {
    i18n: {
      en: {
        "meter.none": "No context data yet (idle or external backend)",
        "meter.compacting": "Compacting…",
        "meter.queued": "Compaction queued",
      },
      "zh-CN": {
        "meter.none": "暂无上下文数据（空闲会话或外部后端）",
        "meter.compacting": "压缩中…",
        "meter.queued": "压缩已排队",
      },
    },
  },
};
