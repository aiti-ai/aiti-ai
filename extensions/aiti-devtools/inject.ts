/**
 * aiti-devtools 扩展 · 注入 JS（service-tunnels 响应注入）
 *
 * 机制（注入与端口无关——端口登记完全归 service-tunnels）：
 *   - 配置：全局注入开关（configDir/inject-enabled.json，默认开）——无「端口→注入」清单。
 *   - 注册：startup 时挂 globalThis.__aitiInject（middleware proxy.ts 读，同 globalThis 模式）
 *     / __stInjectRegistry 注入注册点（service-tunnels 能力层）。
 *   - 执行：service-tunnels 转发/公开的 text/html 页面注入 launcher。
 *
 * 安全性：注入由全局开关控制；被注入页面同源（pi-web 域）加载调试器。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// pi-web 自身地址（注入 script/桥用绝对地址——SSE 经 vhost 穿透 rewrite 会缓冲丢帧，必须直连）
// 开发默认 127.0.0.1:3000；部署设置 AITI_BASE_URL=https://<pi-web 域>
// 子路径部署（PI_WEB_BASE_PATH，如 dev 实例的 /dev）：AITI_BASE_URL 常只配域名不带前缀，
// 这里自动补上——否则注入的 launcher 指向根路径实例（如 /dev/ 页面拉到生产的 launcher/aiUrl）
const _base0 = (process.env.AITI_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const _basePath = String(process.env.PI_WEB_BASE_PATH || "").replace(/^\/+|\/+$/g, "");
const BASE = _basePath && !_base0.endsWith("/" + _basePath) ? _base0 + "/" + _basePath : _base0;

// 注入脚本文件哈希：文件内容变化 → 哈希变 → src?v=<hash> 变 → 浏览器强制重新拉取（无需硬刷/清缓存）
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
let _launcherHash = null, _launcherMtime = 0;
function launcherHash() {
  try {
    const p = join(EXT_DIR, "assets", "aiti-launcher.js");
    const st = statSync(p);
    if (st.mtimeMs !== _launcherMtime) {
      _launcherHash = createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);
      _launcherMtime = st.mtimeMs;
    }
    return _launcherHash;
  } catch { return ""; }
}
function injectScriptTag() {
  const h = launcherHash();
  return `<script src="${BASE}/api/extensions/aiti-devtools/aiti-launcher.js${h ? "?v=" + h : ""}" data-bridge-url="${BASE}/api/extensions/aiti-devtools/mcp" defer></script>`;
}

export function createInjector(configDir) {
  void configDir; // 兼容签名保留；注入源不持有任何状态/配置
  const injector = {
    /** UI 显示名（service-tunnels 注入注册点 /status injectSources） */
    label: "AITI 调试器",
    /** 用途说明（配置 UI 展示） */
    description: "向 service-tunnels 代理/公开的页面注入 AITI 调试器（launcher FAB + 页面调试能力）。",
    /** 声明注入片段（是否注入由 service-tunnels 按公开配置的 inject 白名单决定，
     *  本源不做任何开关判定）；GET/HEAD 主页面导航 → 返回片段，其余 null */
    scriptFor(port, url, method) {
      const m = String(method || "GET").toUpperCase();
      if (m !== "GET" && m !== "HEAD") return null;
      return { html: injectScriptTag(), position: "prepend" };
    },
    /** 注入脚本标签（可被替换测试） */
    scriptTag() { return injectScriptTag(); },
    /** launcher 内容哈希（版本号）：assets/aiti-launcher.js 内容变化 → hash 变 → src?v=<hash> 变 → 浏览器强制拉新
     *  供 API launcher-version 使用（浏览器侧注入如 dev-exts/aiti-inject 需在注入前 fetch 此 hash 拼版本号） */
    launcherHash() { return launcherHash(); },
  };

  return { injector };
}
