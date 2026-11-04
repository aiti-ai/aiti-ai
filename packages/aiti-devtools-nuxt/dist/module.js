// src/module.ts
import { defineNuxtModule } from "nuxt/kit";
import { aitiDevtools } from "@aiti-ai/aiti-devtools-vite";
var module_default = defineNuxtModule({
  meta: { name: "@aiti-ai/aiti-devtools-nuxt", configKey: "aitiDevtools" },
  setup(options, nuxt) {
    const opts = options || {};
    if (nuxt.options.dev === false) return;
    const prefix = opts.prefix || "/aiti";
    const name = opts.name || "aiti-devtools";
    nuxt.hook("vite:extendConfig", (config) => {
      config.plugins = config.plugins || [];
      config.plugins.push(aitiDevtools(opts));
    });
    if (opts.inject !== false) {
      nuxt.options.app.head = nuxt.options.app.head || {};
      const script = nuxt.options.app.head.script || [];
      if (!script.some((s) => s && (s.src || "").includes("aiti-launcher"))) {
        script.push({
          src: opts.bridgeUrl || `${prefix}/aiti-launcher.js`,
          "data-ai-url": opts.aiUrl || `${prefix}/cockpit.html`,
          "data-bridge-url": opts.bridgeUrl || prefix,
          "data-name": name
        });
      }
      nuxt.options.app.head.script = script;
    }
  }
});
export {
  module_default as default
};
