/**
 * aiti-devtools-webpack —— webpack-dev-server 插件（载体 2）
 *
 * 与 aiti-devtools-vite 同能力、薄载体层：
 *   - devServer.setupMiddlewares 挂 connectBridge（复用 core 的 connect 中间件适配，webpack-dev-server 中间件格式兼容）
 *   - html-webpack-plugin 注入 <script src="/aiti/aiti-launcher.js" data-ai-url data-bridge-url>
 *   - 端口就绪后解析端点 + 自动注册 MCP + 打印启动输出
 *
 * 资产/桥/注册/协商全部来自 @aiti-ai/aiti-devtools-core（loadAssets / createBridge / registerMcp / resolveEndpoints）。
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createBridge, connectBridge, resolveEndpoints, registerMcp, loadAssets } from '@aiti-ai/aiti-devtools-core';

const require = createRequire(import.meta.url);

export class AitiDevtoolsWebpackPlugin {
  constructor(opts = {}) {
    this.opts = opts;
    this.prefix = (opts.prefix || '/aiti').replace(/\/+$/, '') || '/aiti';
    this.name = opts.name || 'aiti-devtools';
    this.log = opts.log || ((l) => console.log(l));
    this.staticFiles = loadAssets(opts.assetsDir);
    this.bridge = createBridge(opts.dataDir || join(homedir(), '.pi', 'aiti-bridge'), { name: this.name });
  }

  apply(compiler) {
    const opts = this.opts;

    // ---- 1. dev server 中间件 + 端口就绪后注册 MCP ----
    compiler.options.devServer = compiler.options.devServer || {};
    const origSetup = compiler.options.devServer.setupMiddlewares;
    compiler.options.devServer.setupMiddlewares = (middlewares, devServer) => {
      middlewares.unshift(connectBridge(this.bridge, { prefix: this.prefix, staticFiles: this.staticFiles }));
      const server = devServer && devServer.server;
      const registerOnce = () => {
        try {
          const addr = server.address && server.address();
          const port = (addr && typeof addr === 'object' && addr.port) || devServer.options?.port || 8080;
          const host = (devServer.options?.host && devServer.options.host !== '0.0.0.0' && devServer.options.host) || 'localhost';
          const e = resolveEndpoints({ bridgeUrl: opts.bridgeUrl, aiUrl: opts.aiUrl, serverUrl: `http://${host}:${port}`, prefix: this.prefix });
          this.printBanner(e, host, port);
          this.doRegisterMcp(e, compiler.context || process.cwd());
        } catch (err) {
          this.log(`[${this.name}] ⚠ 启动后处理失败：${err.message}`);
        }
      };
      if (server && typeof server.once === 'function') server.once('listening', registerOnce);
      else registerOnce();
      return origSetup ? origSetup(middlewares, devServer) : middlewares;
    };

    // ---- 2. HTML 注入（html-webpack-plugin）——仅 dev（webpack build 生产产物不注入）----
    if (opts.inject === false) return;
    const isDev = !!compiler.options.devServer && compiler.options.mode !== 'production';
    if (!isDev) return;
    // html-webpack-plugin 装在使用方项目：从 compiler.context 解析（插件源码位置解析不到）
    const userRequire = createRequire(join(compiler.context || process.cwd(), 'package.json'));
    compiler.hooks.compilation.tap('@aiti-ai/aiti-devtools-webpack', (compilation) => {
      let HtmlWebpackPlugin = null;
      try { HtmlWebpackPlugin = userRequire('html-webpack-plugin'); } catch {}
      if (!HtmlWebpackPlugin || !HtmlWebpackPlugin.getHooks) return;
      const hooks = HtmlWebpackPlugin.getHooks(compilation);
      hooks.alterAssetTagGroups.tapAsync('@aiti-ai/aiti-devtools-webpack', (data, cb) => {
        // dev 模式端口未知 → 相对路径（同源 /aiti/）；bridge/aiUrl 同源相对，用户自定义则绝对
        const bridgeBase = opts.bridgeUrl ? resolveEndpoints({ bridgeUrl: opts.bridgeUrl, aiUrl: '', serverUrl: 'http://localhost', prefix: this.prefix }).bridgeBase : this.prefix;
        const aiUrl = opts.aiUrl || `${this.prefix}/cockpit.html`;
        data.headTags.unshift({
          tagName: 'script',
          closeTag: true,
          attributes: {
            src: `${this.prefix}/aiti-launcher.js`,
            'data-ai-url': aiUrl,
            'data-bridge-url': bridgeBase,
            'data-name': this.name,
          },
        });
        cb(null, data);
      });
    });
  }

  printBanner(e, host, port) {
    const kindLabel = e.kind === 'same-origin' ? '同源模式' : '外部桥模式';
    this.log('');
    this.log(`[${this.name}] 🧰 ${this.name}-webpack 已启动（${kindLabel} · name=${this.name} · ${host}:${port}）`);
    this.log(`  launcher:  ${e.launcherUrl}`);
    this.log(`  操作台:    ${e.cockpitUrl}`);
    this.log(`  MCP:       ${e.mcpUrl}   ← agent 的 mcp 配置 url 指这里`);
    this.log(`  bridge:    ${e.bridgeBase}`);
    this.log(`  AI 窗:     ${e.aiUrl}${this.opts.aiUrl ? '（aiti-agent）' : '（同源 cockpit，可用 aiUrl 指定 aiti-agent）'}`);
    for (const n of e.notes) this.log(`  · ${n}`);
  }

  doRegisterMcp(e, projectDir) {
    const m = this.opts.mcp || {};
    if (m.register === false || m.targets === false) return;
    const r = registerMcp({
      url: e.mcpUrl,
      serverName: this.name,
      targets: m.targets === false ? undefined : (m.targets || 'auto'),
      configPaths: m.configPaths || [],
      projectDir,
      dryRun: !!m.dryRun,
      log: this.log,
    });
    this.log(`[${this.name}] MCP 注册：${r.summary}`);
    if (r.ok && !r.changed) this.log(`[${this.name}]    （全部已是最新，未写盘）`);
  }
}

export default AitiDevtoolsWebpackPlugin;
