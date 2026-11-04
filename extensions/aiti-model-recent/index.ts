/**
 * aiti-model-recent · 模型选择器「最近使用」扩展（pi-web 去 fork 化 P4）
 *
 * 纯数据提供方扩展（零 UI、零插槽渲染）：core ModelSelector 面板渲染最近使用段时
 * 经 client service 同步取数；pick 入库经 window 事件。localStorage key 与原实现
 * 一致（pi-web:recent-models）——零数据迁移。
 *
 * 契约：docs/pi-web-model-selector-ext-plan.md（M1 组注入 → 本形态：service 数据面）。
 */
export default {
  id: "aiti-model-recent",
  name: "Model Recent",
  version: "0.1.0",
  client: "dist/aiti-model-recent.mjs",
  icon: "icons/clock.svg",
  clientImmediately: true, // service 须在首开模型面板前注册（boot 物化）
  features: [
    {
      id: "modelRecent.enabled",
      type: "boolean",
      label: "最近使用模型",
      placeholder: "模型面板顶部「最近使用」分组；关闭后面板不显示该段（数据保留）",
      enabled: true,
    },
  ],
};
