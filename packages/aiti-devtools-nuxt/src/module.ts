/**
 * aiti-devtools-nuxt —— Nuxt module（官方机制）
 *
 * 用户只需一行：nuxt.config.ts → modules: ['@aiti-ai/aiti-devtools-nuxt']（可带 aitiDevtools: {...} 选项）
 * module 内部（无需用户改任何应用文件）：
 *   - vite:extendConfig 挂 aitiDevtools 插件（桥/MCP/launcher 资产在 /aiti/，与应用同源）
 *   - nuxt.options.app.head.script 自动注入 launcher 脚本（SSR 渲染的 HTML 也带）
 *
 * 选项（nuxt.config 的 aitiDevtools 字段）：name / bridgeUrl / aiUrl / mcp / prefix / inject
 */
import { defineNuxtModule } from 'nuxt/kit';
import { aitiDevtools } from '@aiti-ai/aiti-devtools-vite';
import type { AitiDevtoolsOptions } from '@aiti-ai/aiti-devtools-vite';

export default defineNuxtModule<AitiDevtoolsOptions>({
  meta: { name: '@aiti-ai/aiti-devtools-nuxt', configKey: 'aitiDevtools' },
  setup(options, nuxt) {
    const opts: AitiDevtoolsOptions = options || {};
    if (nuxt.options.dev === false) return; // dev-only：生产构建零注入
    const prefix = opts.prefix || '/aiti';
    const name = opts.name || 'aiti-devtools';

    // 1. vite 插件（桥/MCP/资产）
    nuxt.hook('vite:extendConfig', (config) => {
      config.plugins = config.plugins || [];
      config.plugins.push(aitiDevtools(opts));
    });

    // 2. head 注入 launcher（module 自动，SSR 生效）
    if (opts.inject !== false) {
      nuxt.options.app.head = nuxt.options.app.head || {};
      const script = nuxt.options.app.head.script || [];
      if (!script.some((s) => s && (s.src || '').includes('aiti-launcher'))) {
        script.push({
          src: opts.bridgeUrl || `${prefix}/aiti-launcher.js`,
          'data-ai-url': opts.aiUrl || `${prefix}/cockpit.html`,
          'data-bridge-url': opts.bridgeUrl || prefix,
          'data-name': name,
        });
      }
      nuxt.options.app.head.script = script;
    }
  },
});
