/**
 * aiti-devtools-vite · Astro Integration（官方机制）
 *
 * 用户只需一行：astro.config.mjs → integrations: [aitiAstro()]
 * 内部：
 *   - vite.plugins 挂 aitiDevtools（桥/MCP/launcher 资产在 /aiti/）
 *   - injectScript('head-inline') 自动注入 launcher 脚本（SSR 渲染的 HTML 也注入，无需改任何页面文件）
 */
import { aitiDevtools, type AitiDevtoolsOptions } from "./index.ts";

export interface AitiAstroOptions extends AitiDevtoolsOptions {}

export function aitiAstro(opts: AitiAstroOptions = {}) {
  return {
    name: "aiti-devtools-astro",
    hooks: {
      "astro:config:setup"({ command, updateConfig, injectScript }) {
        if (command !== 'dev') return; // dev-only：astro build 生产产物零注入
        // 挂 vite 插件（桥/MCP/资产）
        updateConfig({
          vite: {
            plugins: [aitiDevtools(opts)],
          },
        });
        // 注入 launcher：动态创建 script 标签（head-inline 注入内联代码，Astro 5 无 head-prepend stage）
        const prefix = opts.prefix || "/aiti";
        const bridgeUrl = opts.bridgeUrl || prefix;
        const aiUrl = opts.aiUrl || prefix + "/cockpit.html";
        const name = opts.name || "aiti-devtools";
        injectScript(
          "head-inline",
          `(function(){var s=document.createElement('script');s.src='${bridgeUrl}/aiti-launcher.js';s.setAttribute('data-ai-url','${aiUrl}');s.setAttribute('data-bridge-url','${bridgeUrl}');s.setAttribute('data-name','${name}');document.head.appendChild(s);})()`,
        );
      },
    },
  };
}

export default aitiAstro;
