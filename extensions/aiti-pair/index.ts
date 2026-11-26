/**
 * aiti-pair — device interconnect (pair) panel extension.
 *
 * A very thin shell: the protocol and the widget live entirely in the aiti-devtools public asset
 * pair-client.js (built from bridge core, the single protocol source). This extension only does the
 * pi-web carrier wiring — toolbar button + lazily mounted dialogs float.
 * Reach = the device set of this instance's embedded bridge (same bridge = can message each other;
 * the standalone bridge on 8777 is a separate island).
 *
 * Soft dependency: the aiti-devtools extension asset (/api/extensions/aiti-devtools/pair-client.js).
 * When absent the panel shows onboarding guidance (aiti-devtools not deployed here) instead of crashing.
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

  // lazy-load v2 static entry declaration: ids aligned with the client registerItems (zero flicker across materialization); right-panel dock = doc-center-style two-face shape
  ui: {
    rightFileDock: [{ id: "pair", label: "i18n:it.pair.label" }],
    toolbar: [{ id: "pair", label: "i18n:it.pair.label" }],
    // English manifest-text overrides (name/description/feature labels); zh source lives in the manifest.
    i18n: {
      "zh-CN": {
        "it.pair.label": "设备配对",
        "it.pair.label.2": "设备配对面板",
        "it.pair.label.3": "设备配对",
        "it.pair.title": "设备配对",
        // Panel chrome (dialog header / fallback overlay / soft-dependency errors)
        "it.pair.dialogTitle": "✉ 设备互连",
        "it.pair.dialogSubtitle": "连同一桥即互发",
        "it.pair.close": "关闭",
        "it.pair.dockRight": "停靠到右侧",
        "it.pair.phoneTitle": "设备互连 · 手机接入",
        "it.pair.loadFailed": "pair-client.js 加载失败（aiti-devtools 扩展未部署？）",
        "it.pair.loadNotExposed": "pair-client.js 已加载但未暴露 AitiPair（aiti-devtools 版本过旧？）",
        "ext.displayName": "设备互连（临时聊天 / 互传文件）",
      },
      en: {
        "it.pair.label": "Device pairing",
        "it.pair.label.2": "Device pairing panel",
        "it.pair.label.3": "Device pairing",
        "it.pair.title": "Device pairing",
        // Panel chrome (dialog header / fallback overlay / soft-dependency errors)
        "it.pair.dialogTitle": "✉ Device pairing",
        "it.pair.dialogSubtitle": "Same bridge = direct delivery",
        "it.pair.close": "Close",
        "it.pair.dockRight": "Dock to the right panel",
        "it.pair.phoneTitle": "Device pairing · phone access",
        "it.pair.loadFailed": "pair-client.js failed to load (is the aiti-devtools extension deployed?)",
        "it.pair.loadNotExposed": "pair-client.js loaded but did not expose AitiPair (outdated aiti-devtools?)",
        "ext.displayName": "Device Pairing (temp chat / file transfer)",
      },
    },
  },

  server: {
    startup() {
      console.log("[aiti-pair] ready (thin carrier: widget/protocol come from the aiti-devtools pair-client.js asset)");
    },
    shutdown() {},
    async api() {
      return null; // no server API — the protocol lives in the embedded bridge (/bridge/pair/*)
    },
    async middleware() {
      return { handled: false };
    },
  },
};
