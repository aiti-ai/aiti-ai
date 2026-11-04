#!/usr/bin/env node
/**
 * aiti-devtools 独立桥服务（常驻，不依赖 pi 生命周期）
 *
 *   - 桥端点：/bridge/*（claim/sessions/sse/result/event/agent/tools/call…）+ /mcp*（MCP JSON-RPC，供任何 agent）
 *   - 静态资产：/aiti-launcher.js（页面注入）、/cockpit.html（aiti-cockpit 操作台）、/bridge-client.js
 *   - 页面 <script src="http://<host>:<port>/aiti-launcher.js"> 注入即用（launcher 默认桥 = http://localhost:8777）
 *
 * 用法：
 *   node bin/aiti-bridge.mjs                  # 默认 127.0.0.1:8777，资产取仓库 dist/
 *   node bin/aiti-bridge.mjs --port 20341 --host 0.0.0.0 --assets /path/to/assets
 *   node bin/aiti-bridge.mjs --assets-extra /path/to/client-dir   # 追加挂载（如 aiti-client-opencode.js）
 * 环境变量：AITI_BRIDGE_PORT / AITI_BRIDGE_HOST / AITI_BRIDGE_DATA_DIR（消息 session 存储）
 * stdio shim 注册：--register-shim [targets] / --unregister-shim（固定名 aiti 条目，URL 走 env AITI_BRIDGE_URL）
 */
// core 加载：仓库检出用 src（TS 直跑，改动即生效）；装在 node_modules 里用 dist
// （Node 禁止对 node_modules 下 TS 做 type-stripping，src 路线仅仓库态可用）
const { createBridge, startHttpServer, registerMcp, unregisterMcp, registerAitiShim, unregisterAitiShim } = await (async () => {
  const here0 = dirname(fileURLToPath(import.meta.url));
  const coreDir = resolve(here0, '..', '..', 'aiti-devtools-core');
  const srcTs = resolve(coreDir, 'src', 'index.ts');
  return import(here0.includes('node_modules') || !existsSync(srcTs) ? resolve(coreDir, 'dist', 'index.js') : srcTs);
})();
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))); // packages/aiti-bridge

// ---- 参数解析 ----
function parseArgs(argv) {
  const out = {
    port: parseInt(process.env.AITI_BRIDGE_PORT || '8777', 10), host: process.env.AITI_BRIDGE_HOST || '127.0.0.1',
    assets: null, dataDir: process.env.AITI_BRIDGE_DATA_DIR || null,
    registerMcp: null, // null=不注册；'auto'=auto；数组=显式 targets
    mcpConfig: [], unregisterMcp: false, dryRun: false, name: null, assetsExtra: [],
    registerShim: null, unregisterShim: false, // stdio shim（aiti 条目，env AITI_BRIDGE_URL）
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = parseInt(argv[++i], 10);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--assets') out.assets = argv[++i];
    else if (a === '--assets-extra') out.assetsExtra.push(argv[++i]);
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--register-mcp') {
      const v = argv[i + 1];
      out.registerMcp = v && !v.startsWith('--') ? v.split(',') : 'auto';
      if (out.registerMcp !== 'auto') i++;
    } else if (a === '--mcp-config') out.mcpConfig.push(argv[++i]);
    else if (a === '--unregister-mcp') out.unregisterMcp = true;
    else if (a === '--register-shim') {
      const v = argv[i + 1];
      out.registerShim = v && !v.startsWith('--') ? v.split(',') : 'auto';
      if (out.registerShim !== 'auto') i++;
    } else if (a === '--unregister-shim') out.unregisterShim = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help') { console.log('aiti-devtools 独立桥：--port --host --assets --assets-extra --data-dir --name；MCP 注册：--register-mcp [targets] --mcp-config <path> --unregister-mcp --dry-run；stdio shim（env AITI_BRIDGE_URL 接入，URL 不落配置）：--register-shim [targets] --unregister-shim（详见 bin/aiti-mcp-register.mjs）'); process.exit(0); }
  }
  if (!(out.port > 0 && out.port < 65536)) { console.error('bad port: ' + out.port); process.exit(1); }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const coreRoot = resolve(root, '..', 'aiti-devtools-core');
const assetsDir = opts.assets ? resolve(opts.assets) : resolve(coreRoot, 'assets');
const dataDir = opts.dataDir || join(homedir(), '.pi', 'aiti-bridge');

// ---- 静态资产（路径 → { type, content }；默认 core/assets 构建产物集中地）----
const read = (p, fallback) => { try { return readFileSync(p, 'utf8'); } catch { return fallback || null; } };
const staticFiles = {
  '/aiti-launcher.js': { type: 'application/javascript; charset=utf-8', content: read(join(assetsDir, 'aiti-launcher.js')) },
  '/cockpit.html': { type: 'text/html; charset=utf-8', content: read(join(assetsDir, 'cockpit.html')) },
  '/bridge-client.js': { type: 'application/javascript; charset=utf-8', content: read(join(assetsDir, 'bridge-client.js')) },
  '/aiwin.js': { type: 'application/javascript; charset=utf-8', content: read(join(assetsDir, 'aiwin.js')) }, // AI 窗公共库（浏览器模块）
  '/host-protocol.js': { type: 'application/javascript; charset=utf-8', content: read(join(assetsDir, 'host-protocol.js')) }, // 宿主协议层（浏览器模块）
  '/cdp-core.js': { type: 'application/javascript; charset=utf-8', content: read(join(assetsDir, 'cdp-core.js')) }, // self-exec 执行核心（M1）
};

// --assets-extra <dir>（可多次）：追加挂载目录内全部文件（同名覆盖内置；典型：opencode client 脚本）
for (const dir of opts.assetsExtra) {
  try {
    for (const f of readdirSync(resolve(dir))) {
      const p = join(resolve(dir), f);
      try { if (statSync(p).isFile()) staticFiles['/' + f] = { type: f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8', content: readFileSync(p, 'utf8') }; } catch {}
    }
    console.log('[aiti-bridge] assets-extra: ' + dir + ' 挂载 ' + readdirSync(resolve(dir)).length + ' 项');
  } catch (e) { console.error('[aiti-bridge] assets-extra 目录不可读：' + dir, e.message); }
}

const bridge = createBridge(dataDir);
const http = await startHttpServer(bridge, {
  port: opts.port,
  host: opts.host,
  staticFiles,
  onError: (e) => console.error('[aiti-bridge] error', e),
});

console.log('[aiti-bridge] 桥已启动：' + http.url);
console.log('[aiti-bridge]   页面注入：' + http.url + '/aiti/aiti-launcher.js');
console.log('[aiti-bridge]   操作台：  ' + http.url + '/aiti/cockpit.html');
console.log('[aiti-bridge]   MCP：     ' + http.url + '/aiti/mcp（其他 agent 的 mcp.json 指这里；/aiti/mcp/mcp 旧两遍兼容）');
console.log('[aiti-bridge]   agent REST：' + http.url + '/aiti/bridge/agent/tools/call（pi 扩展直连）');
console.log('[aiti-bridge]   旧路径 /bridge /mcp /aiti-launcher.js 仍兼容');

// ---- MCP 注册（复用 core 公共能力；url = 本桥 /aiti/mcp）----
const mcpUrl = http.url + '/aiti/mcp';
if (opts.registerMcp) {
  console.log('[aiti-bridge] 注册 MCP → ' + mcpUrl);
  const r = registerMcp({
    url: mcpUrl,
    serverName: opts.name || 'aiti-devtools',
    targets: opts.registerMcp,
    configPaths: opts.mcpConfig,
    dryRun: opts.dryRun,
  });
  console.log('[aiti-bridge] ' + r.summary);
}
if (opts.unregisterMcp) {
  const r = unregisterMcp({ serverName: opts.name || 'aiti-devtools', configPaths: opts.mcpConfig, dryRun: opts.dryRun });
  console.log('[aiti-bridge] ' + r.summary);
}

// ---- stdio shim 注册（固定名 aiti，URL 不落配置，agent 启动带 env AITI_BRIDGE_URL）----
const shimPath = resolve(root, 'bin', 'aiti-mcp-shim.cjs');
const shimVersion = (() => {
  try { return parseInt(readFileSync(shimPath, 'utf8').match(/SHIM_VERSION\s*=\s*(\d+)/)?.[1] || '0', 10) || 0; }
  catch { return 0; }
})();
if (opts.registerShim) {
  console.log('[aiti-bridge] 注册 stdio shim（aiti，env AITI_BRIDGE_URL 接入）v' + shimVersion);
  const r = registerAitiShim({
    shimPath, version: shimVersion,
    serverName: opts.name || 'aiti',
    targets: opts.registerShim,
    configPaths: opts.mcpConfig,
    dryRun: opts.dryRun,
  });
  console.log('[aiti-bridge] ' + r.summary);
}
if (opts.unregisterShim) {
  const r = unregisterAitiShim({ serverName: opts.name || 'aiti', configPaths: opts.mcpConfig, dryRun: opts.dryRun });
  console.log('[aiti-bridge] ' + r.summary);
}

process.on('SIGINT', async () => { await http.close(); process.exit(0); });
process.on('SIGTERM', async () => { await http.close(); process.exit(0); });
setInterval(() => {}, 1 << 30);
