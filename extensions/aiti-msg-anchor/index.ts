/**
 * aiti-msg-anchor · 消息锚点横幅
 *
 * 消息窗顶部常驻一条浮层横幅，展示「生成当前屏幕上内容的那条用户输入」：
 *   每个用户输入与其后的 AI 回复构成一个「回合段」，滚动时横幅跟随当前视口
 *   顶部边界所在的回合段（谁的内容在眼前，就显示谁的输入；锚点输入已可见时
 *   自动隐藏——参考用途：大段输出看不到所属输入时才显示）。
 *
 * 与 aiti-msg-nav 同源的两条 DOM 契约工作（[data-chat-scroll] /
 * [data-chat-msg-role]），纯前端、零服务端 API：
 *   - 滚动跟随 + 懒加载/流式变化（MutationObserver 节流重建位置缓存）
 *   - 点击横幅 → 平滑滚动到该用户输入
 *   - 右上角显示 序号/总数
 *   - 滚动时显示，停止 6s 后淡出；锚点输入已在屏幕内则不显示
 *
 * features（extman 可管理）：
 *   - show.banner       总开关
 *   - display.mode      显示模式（string）：
 *                         current = 当前视口所属的用户输入（默认，滚动跟随）
 *                         first   = 会话第一条输入（固定锚）
 *                         latest  = 最近一条输入（固定锚）
 *                         title   = 会话标题（name，无则显示会话第一条输入）
 *   - display.title     第一行：session 名（无则显示会话第一条输入，默认开）
 *   - display.input     第二行：当前输入（按 display.mode 计算的锚点输入，默认开）
 *   - display.opacity   横幅不透明度（0-100 数字，0=全透明 100=不透明，默认 85）
 *   - text.maxLen       文本截断长度（字符，默认 140）
 */
export default {
  id: "aiti-msg-anchor",
  name: "消息锚点横幅",
  icon: "icon.svg",
  client: "dist/aiti-msg-anchor-client.mjs",

  ui: {
    clientDependsOn: ["aiti-msg-nav"], // 共享同一 chatOverlay 插槽与 DOM 契约（并行预取提示）
    i18n: {
      "zh-CN": {
        "anchor.currentInput": "当前输入",
        "anchor.firstInput": "第一条输入",
        "anchor.latestInput": "最近输入",
        "anchor.sessionTitle": "会话标题",
        "anchor.hint": "点击跳转到该输入",
      },
      "en": {
        "anchor.currentInput": "Current input",
        "anchor.firstInput": "First input",
        "anchor.latestInput": "Latest input",
        "anchor.sessionTitle": "Session title",
        "anchor.hint": "Click to jump to this input",
      },
    },
  },

  features: [
    { id: "show.banner", label: "显示消息锚点横幅", description: "消息区顶部常驻横幅，展示当前视口所属的用户输入", default: true },
    {
      id: "display.mode",
      type: "string",
      label: "显示模式",
      group: "内容",
      description: "current=当前视口所属的用户输入（滚动跟随）；first=会话第一条输入；latest=最近一条输入；title=会话标题",
      value: "current",
      placeholder: "current",
    },
    {
      id: "display.title",
      label: "显示会话标题行",
      group: "内容",
      description: "横幅第一行显示当前会话标题（name，无则显示会话第一条输入）",
      default: true,
    },
    {
      id: "display.input",
      label: "显示当前输入行",
      group: "内容",
      description: "横幅第二行显示当前视口所属的用户输入（display.mode 决定的输入）",
      default: true,
    },
    {
      id: "display.opacity",
      type: "string",
      label: "横幅透明度",
      group: "样式",
      description: "横幅不透明度（0-100 数字：0=全透明，100=不透明；默认 85，能看到但不干扰）",
      value: "85",
      placeholder: "85",
    },
    {
      id: "text.maxLen",
      type: "string",
      label: "文本截断长度",
      group: "内容",
      description: "横幅里用户输入/标题最多显示的字符数（超出省略号；0 或非法值回退 140）",
      value: "140",
      placeholder: "140",
    },
  ],

  server: {},
};
