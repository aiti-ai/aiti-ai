// 入口：把 createDbgLauncher 挂到全局（兼容经典脚本调用方），同时具名导出供 ESM 页面 import
import { createDbgLauncher } from './launcher.js';
import { VERSION } from './config.js';

export { createDbgLauncher, VERSION };

window.createDbgLauncher = createDbgLauncher;
window.__dbgLauncherVersion = VERSION;
