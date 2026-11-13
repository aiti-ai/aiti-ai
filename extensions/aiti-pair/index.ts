/**
 * aiti-pair —— pair 设备互连面板扩展（方案 docs/aiti-bridge-pair-plan.md §8）
 *
 * 极薄壳：协议与 widget 全在 aiti-devtools 公共资产 pair-client.js（桥 core 构建产物，
 * 协议唯一来源），本扩展只做 pi-web 载体接线——toolbar 按钮 + dialogs 浮窗懒挂载。
 * 可达域 = 本实例内嵌桥的设备集合（连同一个桥即互发；与独立桥 8777 不互通）。
 *
 * 软依赖：aiti-devtools 扩展资产（/api/extensions/aiti-devtools/pair-client.js）。
 * 缺席时面板显示引导（本实例未部署 aiti-devtools）——面板不崩。
 */
export default {
  id: "aiti-pair",
  name: "设备互连（临时聊天 / 互传文件）",
  icon: "icon.svg",
  client: "dist/aiti-pair-client.mjs",

  ai: {
    intro: "AI 能帮我给其他设备（手机/浏览器/agent 会话）发消息、推文件，或查看在线设备",
    skills: "skills",
  },

  server: {
    startup() {
      console.log("[aiti-pair] 就绪（薄载体：widget/协议由 aiti-devtools pair-client.js 公共资产提供）");
    },
    shutdown() {},
    async api() {
      return null; // 无服务端 API——协议全在内嵌桥 /bridge/pair/*
    },
    async middleware() {
      return { handled: false };
    },
  },
};
