/**
 * aiti-debug-inject —— 可配置的远程调试注入扩展（极简版）
 *
 * 由 dev-exts/aiti-inject（dev 专用、硬编码生产地址、始终注入）演变成正经扩展：
 *   - 无 toolbar / 无弹窗 / 无自带配置 UI——「就是简单注入 JS」
 *   - 服务地址是一个 string feature（extman 功能管理面板里直接文本框填）——「feature 里有地址配置」
 *   - 默认不启动：一个 boolean feature `inject.enabled`（默认关）
 *   - client 只读两个 feature（enabled + service.url），enabled 开且有地址 → 注入目标 launcher
 *
 * 用途：本实例页面接入目标 pi-web 的桥 → 目标 pi-web 的 agent 调试本实例页面
 *      （「用一个 pi-web 调试另一个」）。
 *
 * 依赖 core 的 string-valued feature 支持（pi-web/lib/ext：ExtFeature.type === "string"）。
 */
export default {
  id: "aiti-debug-inject",
  name: "AITI 远程调试注入（可配置目标 pi-web）",
  version: "0.3.0",
  icon: "icon.svg",
  client: "dist/aiti-debug-inject-client.mjs",

  // 两个 feature：开关（boolean，默认关）+ 服务地址（string，文本框配）。
  // extman 功能管理面板：inject.enabled 是开关；service.url 是输入框（回车/失焦保存）。
  features: [
    {
      id: "service.url",
      type: "string",
      label: "服务地址",
      group: "远程调试注入",
      description: "目标 pi-web 基址（含子路径，如 https://host:port/dev）。配好后打开下面的「启用注入」。",
      placeholder: "https://host:port",
    },
    {
      id: "inject.enabled",
      type: "boolean",
      label: "启用注入",
      group: "远程调试注入",
      description: "打开后把「服务地址」指向的目标 pi-web 的 aiti-devtools launcher 注入本实例页面（默认关闭）。",
      default: false,
    },
  ],

  server: {
    startup() {
      console.log("[aiti-debug-inject] 就绪（纯 client 注入；feature 控制：service.url + inject.enabled）");
    },
    shutdown() {},
    async api() {
      return null; // 无服务端 API——配置全走 extman feature
    },
    async middleware() {
      return { handled: false };
    },
  },
};
