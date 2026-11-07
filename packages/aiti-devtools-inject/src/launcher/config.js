// 配置（自 dbg-launcher.js 拆分，源区块：配置）
export const VERSION = '0.2.1';
  export const DEFAULTS = {
    endpoint: '',            // AI 桥前缀（aiUrl 为空时的后备，如 'http://localhost:3000/api/dbg'）
    sessionId: '',
    dbgToken: '',
    aiUrl: '',               // AI 聊天界面 iframe 地址；空 = 不创建 AI iframe，走 endpoint/console
    bridgeBase: 'http://localhost:8777/aiti', // MCP 桥地址（页面 client 连接注册；正式路径带 /aiti/ 前缀，nginx location /aiti/ 可代理）
    bridgeToken: 'dev',      // MCP 桥 token
    accent: '#4f46e5',
    iframeWidth: 'min(880px, 92vw)',
    iframeHeight: 'min(560px, 80vh)',
  };
