// src/index.ts
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { createBridge, connectBridge, resolveEndpoints, registerMcp, loadAssets, htmlInjectMiddleware } from "@aiti-ai/aiti-devtools-core";
function hashOf(content) {
  return createHash("sha1").update(content).digest("hex").slice(0, 8);
}
function originOf(server) {
  const local = server.resolvedUrls?.local?.[0];
  if (local) return local.replace(/\/+$/, "");
  const addr = server.httpServer?.address();
  const port = typeof addr === "object" && addr ? addr.port : server.config.server.port;
  return `http://localhost:${port ?? 5173}`;
}
function matchPatterns(file, patterns) {
  if (!patterns || !patterns.length) return true;
  return patterns.some((p) => p instanceof RegExp ? p.test(file) : file.includes(p));
}
function aitiDevtools(opts = {}) {
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/aiti";
  const name = opts.name || "aiti-devtools";
  const log = opts.log || ((l) => console.log(l));
  const dataDir = opts.dataDir || process.env.AITI_BRIDGE_DATA_DIR || join(homedir(), ".pi", "aiti-bridge");
  const staticFiles = loadAssets(opts.assetsDir);
  const bridge = createBridge(dataDir, { name });
  const printBanner = (server, e) => {
    const kindLabel = e.kind === "same-origin" ? "\u540C\u6E90\u6A21\u5F0F" : "\u5916\u90E8\u6865\u6A21\u5F0F";
    log("");
    log(`[${name}] \u{1F9F0} ${name}-vite \u5DF2\u542F\u52A8\uFF08${kindLabel} \xB7 name=${name}\uFF09`);
    log(`  launcher:  ${e.launcherUrl}`);
    log(`  \u64CD\u4F5C\u53F0:    ${e.cockpitUrl}`);
    log(`  MCP:       ${e.mcpUrl}   \u2190 agent \u7684 mcp \u914D\u7F6E url \u6307\u8FD9\u91CC`);
    log(`  bridge:    ${e.bridgeBase}`);
    log(`  AI \u7A97:     ${e.aiUrl}${opts.aiUrl ? "\uFF08aiti-agent\uFF09" : "\uFF08\u540C\u6E90 cockpit\uFF0C\u53EF\u7528 aiUrl \u6307\u5B9A aiti-agent\uFF09"}`);
    for (const n of e.notes) log(`  \xB7 ${n}`);
  };
  const doRegisterMcp = (server, e) => {
    const m = opts.mcp || {};
    if (m.register === false || m.targets === false) return;
    const r = registerMcp({
      url: e.mcpUrl,
      serverName: name,
      targets: m.targets === false ? void 0 : m.targets || "auto",
      configPaths: m.configPaths || [],
      projectDir: server.config.root,
      dryRun: !!m.dryRun,
      log
    });
    log(`[${name}] MCP \u6CE8\u518C\uFF1A${r.summary}`);
    if (r.ok && !r.changed) log(`[${name}]    \uFF08\u5168\u90E8\u5DF2\u662F\u6700\u65B0\uFF0C\u672A\u5199\u76D8\uFF09`);
  };
  const endpointsFor = (server) => resolveEndpoints({ bridgeUrl: opts.bridgeUrl, aiUrl: opts.aiUrl, serverUrl: originOf(server), prefix });
  const mount = (server) => {
    server.middlewares.use(connectBridge(bridge, { prefix, staticFiles }));
    server.httpServer?.once("listening", () => {
      try {
        const e = endpointsFor(server);
        printBanner(server, e);
        doRegisterMcp(server, e);
      } catch (err) {
        log(`[${name}] \u26A0 \u542F\u52A8\u540E\u5904\u7406\u5931\u8D25\uFF1A${err.message}`);
      }
    });
  };
  const injectHtml = (server) => {
    if (opts.inject === false) return;
    server.middlewares.stack.unshift({ route: "", handle: htmlInjectMiddleware({ prefix, name }) });
  };
  return {
    name: "@aiti-ai/aiti-devtools-vite",
    // dev-only：生产构建（vite build）整个插件不生效——产物零注入
    apply: "serve",
    configureServer(server) {
      injectHtml(server);
      mount(server);
    },
    configurePreviewServer(server) {
      injectHtml(server);
      mount(server);
    },
    transformIndexHtml(html, ctx) {
      const inject = opts.inject === false ? false : true;
      if (!inject) return html;
      const cfg = typeof opts.inject === "object" ? opts.inject : {};
      const file = ctx.filename || ctx.path || "";
      if (cfg.exclude?.length && matchPatterns(file, cfg.exclude)) return html;
      if (cfg.include?.length && !matchPatterns(file, cfg.include)) return html;
      const server = ctx.server;
      const e = endpointsFor(server || {});
      const launcher = staticFiles["/aiti-launcher.js"];
      const v = launcher?.content ? hashOf(launcher.content) : Date.now().toString(36);
      return [
        {
          tag: "script",
          attrs: {
            src: `${e.origin}${prefix}/aiti-launcher.js?v=${v}`,
            "data-ai-url": e.aiUrl,
            "data-bridge-url": e.bridgeBase,
            "data-name": name
          },
          injectTo: "head-prepend"
        }
      ];
    }
  };
}

// src/astro.ts
function aitiAstro(opts = {}) {
  return {
    name: "aiti-devtools-astro",
    hooks: {
      "astro:config:setup"({ command, updateConfig, injectScript }) {
        if (command !== "dev") return;
        updateConfig({
          vite: {
            plugins: [aitiDevtools(opts)]
          }
        });
        const prefix = opts.prefix || "/aiti";
        const bridgeUrl = opts.bridgeUrl || prefix;
        const aiUrl = opts.aiUrl || prefix + "/cockpit.html";
        const name = opts.name || "aiti-devtools";
        injectScript(
          "head-inline",
          `(function(){var s=document.createElement('script');s.src='${bridgeUrl}/aiti-launcher.js';s.setAttribute('data-ai-url','${aiUrl}');s.setAttribute('data-bridge-url','${bridgeUrl}');s.setAttribute('data-name','${name}');document.head.appendChild(s);})()`
        );
      }
    }
  };
}
var astro_default = aitiAstro;
export {
  aitiAstro,
  astro_default as default
};
