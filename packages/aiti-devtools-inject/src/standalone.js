// 独立注入入口：<script src="aiti-launcher.js"></script> 即自动启用（任意页面，无需 ESM/构建）
// 与 src/launcher/index.js（ESM 导入）互补：这是打包成单文件 iife 的注入版
// aiUrl 推断：优先 document.currentScript 的 data-ai-url 属性 / window.__AITI_AI_URL；
// 默认取 aiti-launcher.js 同目录的 cockpit.html（独立桥部署：aiti-cockpit 操作台）
import { createDbgLauncher } from './launcher/index.js';
import { VERSION, DEFAULTS } from './launcher/config.js';

(function () {
  // 本脚本的 <script> 元素（同步执行期 currentScript 有效；boot 延迟时也能用）
  const myScript = (function () {
    try {
      if (document.currentScript && document.currentScript.src) return document.currentScript;
      return [...document.querySelectorAll('script')].find((x) => (x.src || '').indexOf('aiti-launcher') >= 0) || null;
    } catch (e) { return null; }
  })();

  // 跨实例接管：已装的是「self 宿主」实例（aiti-devtools 自注入器装的，能力最简：无 FAB/无 AI 窗），
  // 而本脚本是其他来源（无 self 标记，如 dev 页上 aiti-inject 后到的生产 launcher）→ 自毁旧实例、
  // 由本全功能 launcher 接管——恢复 FAB（💬+🎯）与 AI 窗（跨实例调试端点），状态重置（用户要求：
  // 后期被新注入应显示 AI 窗和 inspect 按钮）。同为 self 注入 / 已装全功能实例：不接管（单例让位）。
  // 注意判定用「注入器标记」而非 origin：dev 经 nginx 子路径（host:port/dev）与生产同源同端口，
  // 生产 launcher 挂上来 origin 相同但实例不同——实例身份只有注入器标记知道。
  function takeoverCrossInstance() {
    try {
      if (!myScript || !myScript.src) return false;
      if (myScript.dataset && myScript.dataset.aitiSelfInject === '1') return false; // 同为 self 注入：不接管
      if (window.__dbgLauncherSelfHost !== true) return false; // 已装的是全功能实例：不接管
      const prev = document.getElementById('__dbg_launcher');
      try { if (prev && prev.__dbgLauncher && prev.__dbgLauncher.destroy) prev.__dbgLauncher.destroy(); } catch (e) {}
      if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
      window.__dbgLauncherInstalled = false;
      // 重置按钮态：host-protocol 收到 inspect_off → onInspect(false) → 🎯 回准星
      try { window.postMessage({ __dbg: 1, type: 'dbg_ai_inspect_off', payload: {} }, '*'); } catch (e) {}
      if (window.console && console.info) console.info('[aiti] 跨实例 launcher 接管：已重置同源 self 宿主实例（恢复 FAB/AI 窗）');
      return true;
    } catch (e) { return false; }
  }

  if (window.__dbgLauncherInstalled && !takeoverCrossInstance()) return; // 防重复注入（同一页面多次 <script>）；跨实例接管例外
  window.__dbgLauncherInstalled = true;

  function findScript() {
    if (myScript) return myScript; // 本脚本优先：接管场景下 DOM 里有多个 launcher script，兜底匹配会命中旧的
    try {
      if (document.currentScript && document.currentScript.src) return document.currentScript;
      // defer 执行时 document.currentScript 为 null → 按 src 匹配
      const s = [...document.querySelectorAll('script')].find((x) => (x.src || '').indexOf('aiti-launcher') >= 0);
      return s || null;
    } catch (e) { return null; }
  }

  function aiUrlFromScript() {
    try {
      const s = findScript();
      if (s && s.getAttribute('data-ai-url')) return s.getAttribute('data-ai-url');
      if (window.__AITI_AI_URL) return window.__AITI_AI_URL;
      // 扩展部署：AI 窗 = pi-web 主界面（基于 pi-web 页面 + mcp-bridge 扩展，boot 传调试上下文）
      if (s && s.src && /\/api\/extensions\/aiti-devtools\//.test(s.src)) {
        const idx = s.src.indexOf('/api/extensions/');
        if (idx > 0) return s.src.slice(0, idx) + '/'; // pi-web 根（basePath，如 /dev/ 或 /）
      }
      // 独立部署：同目录 cockpit.html（aiti-cockpit 操作台）
      if (s && s.src) return new URL('cockpit.html', s.src).href;
    } catch (e) {}
    return DEFAULTS.aiUrl || '';
  }

  // 桥地址：data-bridge-url / __AITI_BRIDGE_URL / 扩展部署（script 在 /api/extensions/ 下 → 同目录 mcp）/ 本地桥默认
  function bridgeUrlFromScript() {
    try {
      const s = findScript();
      if (s && s.getAttribute('data-bridge-url')) return s.getAttribute('data-bridge-url');
      if (window.__AITI_BRIDGE_URL) return window.__AITI_BRIDGE_URL;
      if (s && s.src && /\/api\/extensions\//.test(s.src)) return new URL('mcp', s.src).href;
    } catch (e) {}
    return DEFAULTS.bridgeBase;
  }

  // self 宿主页判定：仅当 launcher 是「aiti-devtools 自注入器」安装的（data-aiti-self-inject 标记）
  // ——它明确属于页面所属实例（同实例必然走自注入），此时页面自身即 AI 窗：不预建/恢复 AI 窗、
  // FAB 隐藏。其余一切来源（aiti-inject 跨实例、aiti-debug-inject、service-tunnels 端口注入、
  // 手工标签）一律全功能模式（FAB + AI 窗）＝原行为。
  // 注意不能用 origin 判定：dev 经 nginx 子路径（host:port/dev）与生产同源同端口，生产 launcher
  // 挂上来 origin 相同但实例不同——实例身份只有注入器标记知道。
  function isSelfHostPage() {
    try {
      return !!(myScript && myScript.dataset && myScript.dataset.aitiSelfInject === '1');
    } catch (e) { return false; }
  }

  function boot() {
    try {
      const opts = {
        aiUrl: aiUrlFromScript(),
        bridgeBase: bridgeUrlFromScript(),
        selfHostPage: isSelfHostPage(),
      };
      const inst = window.createDbgLauncher(location.href, opts);
      if (inst === null) { window.__dbgLauncherInstalled = false; return; } // 防嵌套拦截：复位单例锁，后续仍可按需重试（不留下永久死锁）
      window.__dbgLauncherSelfHost = !!opts.selfHostPage; // 记录实例形态：跨实例脚本后到时可判定接管
      if (window.console && console.info) console.info('[aiti] launcher v' + VERSION + ' 已启用（aiUrl=' + opts.aiUrl + ' bridge=' + opts.bridgeBase + (opts.selfHostPage ? ' self宿主' : '') + '）');
    } catch (e) {
      window.__dbgLauncherInstalled = false; // 启动异常：复位单例锁（同上）
      if (window.console) console.error('[aiti] 启动失败：', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
