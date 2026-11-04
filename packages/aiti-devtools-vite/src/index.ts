/**
 * aiti-devtools-vite —— Vite 插件（载体 1）
 *
 * 一个插件 = 应用 dev server 上多挂一套 aiti-devtools：
 *   - /aiti/* 中间件：launcher 注入脚本 + 桥 HTTP API + MCP 端点 + 操作台（与应用同端口同源）
 *   - transformIndexHtml：自动注入 <script src=".../aiti-launcher.js" data-ai-url data-bridge-url>
 *   - 启动时自动注册 MCP 到常见 agent 工具（pi/claude/cursor/windsurf/vscode/zed）
 *
 * 能力全部来自 @aiti-ai/aiti-devtools-core（createBridge / connectBridge / resolveEndpoints / registerMcp）；
 * 本包只做"挂中间件 + 注入 + 启动输出"。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Plugin, ViteDevServer, IndexHtmlTransformContext } from "vite";
import { createBridge, connectBridge, resolveEndpoints, registerMcp, loadAssets, htmlInjectMiddleware, type ResolvedEndpoints, type StaticFile } from "@aiti-ai/aiti-devtools-core";

export interface AitiDevtoolsMcpOptions {
  /** 启动自动注册 MCP 到 agent 工具（默认 true） */
  register?: boolean;
  /** 'auto'=只写已存在的配置文件（默认）；或 ['pi','claude','cursor',…]；false 与 register:false 同义 */
  targets?: string[] | "auto" | false;
  /** 用户直接指定 mcp 配置文件位置（自动识别结构） */
  configPaths?: string[];
  /** 只报告不写 */
  dryRun?: boolean;
}

export interface AitiDevtoolsOptions {
  /** 标识名：MCP 配置条目/日志/来源标注/操作台文案全跟随（默认 'aiti-devtools'；多项目并存改这个） */
  name?: string;
  /** 外部桥地址（可带 /aiti、/bridge、/mcp/mcp 等多余路径，自动协商；空 = 与应用同源） */
  bridgeUrl?: string;
  /** aiti-agent 地址（AI 窗；空 = 同源 cockpit.html） */
  aiUrl?: string;
  /** MCP 注册选项 */
  mcp?: AitiDevtoolsMcpOptions;
  /** 资产目录（默认包内 assets/；调试口子：指仓库 packages/aiti-devtools-inject/dist 看 launcher 即时改动） */
  assetsDir?: string;
  /** 挂载前缀（默认 /aiti） */
  prefix?: string;
  /** 注入 launcher 脚本：true 全部（默认）/ false 关 / { include, exclude } 控制范围 */
  inject?: boolean | { include?: (string | RegExp)[]; exclude?: (string | RegExp)[] };
  /** 桥数据目录（消息 session 等；默认 ~/.pi/aiti-bridge） */
  dataDir?: string;
  /** 日志回调（默认 console.log） */
  log?: (line: string) => void;
}

function hashOf(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 8);
}

function originOf(server: ViteDevServer): string {
  const local = server.resolvedUrls?.local?.[0];
  if (local) return local.replace(/\/+$/, "");
  const addr = server.httpServer?.address();
  const port = typeof addr === "object" && addr ? addr.port : server.config.server.port;
  return `http://localhost:${port ?? 5173}`;
}

function matchPatterns(file: string, patterns?: (string | RegExp)[]): boolean {
  if (!patterns || !patterns.length) return true;
  return patterns.some((p) => (p instanceof RegExp ? p.test(file) : file.includes(p)));
}

export function aitiDevtools(opts: AitiDevtoolsOptions = {}): Plugin {
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/aiti";
  const name = opts.name || "aiti-devtools";
  const log = opts.log || ((l: string) => console.log(l));
  // 桥数据目录：opts.dataDir → AITI_BRIDGE_DATA_DIR（与独立桥同款 env；未设 = ~/.pi/aiti-bridge 原行为）
  const dataDir = opts.dataDir || process.env.AITI_BRIDGE_DATA_DIR || join(homedir(), ".pi", "aiti-bridge");
  const staticFiles = loadAssets(opts.assetsDir);
  const bridge = createBridge(dataDir, { name } as never);

  const printBanner = (server: ViteDevServer, e: ResolvedEndpoints) => {
    const kindLabel = e.kind === "same-origin" ? "同源模式" : "外部桥模式";
    log("");
    log(`[${name}] 🧰 ${name}-vite 已启动（${kindLabel} · name=${name}）`);
    log(`  launcher:  ${e.launcherUrl}`);
    log(`  操作台:    ${e.cockpitUrl}`);
    log(`  MCP:       ${e.mcpUrl}   ← agent 的 mcp 配置 url 指这里`);
    log(`  bridge:    ${e.bridgeBase}`);
    log(`  AI 窗:     ${e.aiUrl}${opts.aiUrl ? "（aiti-agent）" : "（同源 cockpit，可用 aiUrl 指定 aiti-agent）"}`);
    for (const n of e.notes) log(`  · ${n}`);
  };

  const doRegisterMcp = (server: ViteDevServer, e: ResolvedEndpoints) => {
    const m = opts.mcp || {};
    if (m.register === false || m.targets === false) return;
    const r = registerMcp({
      url: e.mcpUrl,
      serverName: name,
      targets: m.targets === false ? undefined : (m.targets || "auto"),
      configPaths: m.configPaths || [],
      projectDir: server.config.root,
      dryRun: !!m.dryRun,
      log,
    });
    log(`[${name}] MCP 注册：${r.summary}`);
    if (r.ok && !r.changed) log(`[${name}]    （全部已是最新，未写盘）`);
  };

  const endpointsFor = (server: ViteDevServer): ResolvedEndpoints =>
    resolveEndpoints({ bridgeUrl: opts.bridgeUrl, aiUrl: opts.aiUrl, serverUrl: originOf(server), prefix });

  const mount = (server: ViteDevServer) => {
    server.middlewares.use(connectBridge(bridge, { prefix, staticFiles }));
    server.httpServer?.once("listening", () => {
      try {
        const e = endpointsFor(server);
        printBanner(server, e);
        doRegisterMcp(server, e);
      } catch (err) {
        log(`[${name}] ⚠ 启动后处理失败：${(err as Error).message}`);
      }
    });
  };

  // HTML 响应注入（SSR 框架兑底：SvelteKit/Astro 等不走 transformIndexHtml → core 的 prepend 注入中间件，零用户文件改动）
  const injectHtml = (server: ViteDevServer) => {
    if (opts.inject === false) return;
    server.middlewares.stack.unshift({ route: "", handle: htmlInjectMiddleware({ prefix, name }) } as never);
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
      const file = (ctx as IndexHtmlTransformContext).filename || (ctx as unknown as { path?: string }).path || "";
      if (cfg.exclude?.length && matchPatterns(file, cfg.exclude)) return html;
      if (cfg.include?.length && !matchPatterns(file, cfg.include)) return html;

      const server = (ctx as unknown as { server?: ViteDevServer }).server;
      const e = endpointsFor(server || ({} as ViteDevServer));
      const launcher = staticFiles["/aiti-launcher.js"];
      const v = launcher?.content ? hashOf(launcher.content) : Date.now().toString(36);

      return [
        {
          tag: "script",
          attrs: {
            src: `${e.origin}${prefix}/aiti-launcher.js?v=${v}`,
            "data-ai-url": e.aiUrl,
            "data-bridge-url": e.bridgeBase,
            "data-name": name,
          },
          injectTo: "head-prepend" as const,
        },
      ];
    },
  };
}

export default aitiDevtools;
