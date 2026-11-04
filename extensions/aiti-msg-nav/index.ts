/**
 * aiti-msg-nav · 消息滚动导航（到最早 / 到最新 / 上一个用户输入 / 下一个用户输入）
 *
 * 原为 pi-web 内置的 ScrollToolbar（components/ScrollToolbar.tsx），已整体抽离为
 * 扩展：core 只留一个 chatOverlay 插槽挂载点（消息区覆盖层），全部交互/定位/滚动
 * 逻辑在扩展 client bundle 里，靠两条 DOM 契约工作：
 *   - [data-chat-scroll]        消息滚动容器（core 给消息滚动 div 打的标记）
 *   - [data-chat-msg-role]      消息包装节点（role="user"/"assistant"；用户消息
 *                               即 prev/next 的导航目标）
 * 依赖核心懒分页：滚到顶部触发 sentinel → core 自动加载更早消息并保持视口，扩展
 * 只需滚动到容器顶端并延时重试（不再需要 core 的 setVisibleCount）。
 *
 * 纯前端扩展：无服务端 API。features（extman 可管理）：
 *   - show.toolbar        总开关（关闭 = 不渲染导航条）
 *   - behavior.keepAwake  长按「到最新」保持屏幕常亮（Screen Wake Lock API）
 */
export default {
  id: "aiti-msg-nav",
  name: "消息滚动导航",
  version: "0.1.0",
  icon: "icon.svg",
  client: "dist/aiti-msg-nav-client.mjs",

  ui: {
    clientDependsOn: [],
    i18n: {
      "zh-CN": {
        "nav.earliest": "到最早消息",
        "nav.prevUser": "上一个用户输入",
        "nav.nextUser": "下一个用户输入",
        "nav.latestHint": "到最新消息（长按保持屏幕常亮）",
        "nav.keepAwakeOn": "屏幕保持常亮",
      },
      "en": {
        "nav.earliest": "Jump to earliest message",
        "nav.prevUser": "Previous user message",
        "nav.nextUser": "Next user message",
        "nav.latestHint": "Jump to latest (long-press to keep the screen awake)",
        "nav.keepAwakeOn": "Screen stays awake",
      },
    },
  },

  features: [
    { id: "show.toolbar", label: "显示消息滚动导航条", description: "消息区右侧的到最早/到最新/上一条/下一条按钮列", default: true },
    { id: "behavior.keepAwake", label: "长按『到最新』保持屏幕常亮", description: "agent 运行时长按最底部按钮可让屏幕保持常亮（Screen Wake Lock API，不支持时自动降级）", default: true },
  ],

  server: {},
};