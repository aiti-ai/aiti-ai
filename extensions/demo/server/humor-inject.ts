/**
 * demo · 幽默彩蛋注入脚本生成器
 *
 * 通过 service-tunnels 注入注册点（__stInjectRegistry）注册为注入源：
 *   - label: 显示名（配置 UI 里「出处扩展 + 用途」）
 *   - scriptFor: 每次目标页面响应注入时调用 → 服务端从本地缓存随机取一条
 *     幽默话，包成自绘 toast 脚本注入 <head>。每次导航/刷新换一条。
 *
 * toast 自绘（不依赖目标页面 UI 框架）：
 *   - fixed 右下角圆角卡片，标题「🧪 彩蛋」+ 正文 + 关闭按钮
 *   - 每会话只弹一次（sessionStorage 标记），防 ajax/导航重复轰炸
 *   - 5 秒自动消失，点 × 立即消失
 */
export const DEMO_INJECT_LABEL = "🧪 Demo 幽默彩蛋";
export const DEMO_INJECT_DESC = "打开被公开的页面时，右下角随机弹一条程序员幽默话（语料源：hitokoto 一言，本地缓存随机派发）。";

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";




/** 生成注入 HTML（<script> 段）。quote 需 JSON 安全转义。 */
export function humorInjectScript(text, source) {
  const safeText = String(text).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  const safeSource = String(source || "").replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  return `<script>(function(){
  try {
    if (sessionStorage.getItem("__demo_humor_shown")) return;
    var lines = ${JSON.stringify(safeText)};
    var src = ${JSON.stringify(safeSource)};
    function run() {
      if (sessionStorage.getItem("__demo_humor_shown")) return;
      sessionStorage.setItem("__demo_humor_shown","1");
      var colors = ["#7c5cff","#ff5c8a","#5cb8ff","#5cffb0","#ffb85c","#a05cff"];
      var acc = colors[Math.floor(Math.random() * colors.length)];
      var el = document.createElement("div");
      el.setAttribute("data-demo-humor","1");
      el.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483646;max-width:320px;background:rgba(24,24,32,.96);color:#fff;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.35);font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:12px 14px;opacity:0;transform:translateY(10px);transition:opacity .35s,transform .35s;";
      // 全部用 textContent 构建——语料来自第三方（hitokoto），拼 innerHTML 会执行
      // 语料内嵌的 HTML/事件（XSS）。样式固定 cssText，文案全部 textContent。
      var hd = document.createElement("div");
      hd.style.cssText = "display:flex;align-items:center;gap:8px;font-weight:700;font-size:12px;color:" + acc + ";margin-bottom:4px;";
      hd.appendChild(document.createTextNode("🧪 Demo 彩蛋"));
      var close = document.createElement("span");
      close.style.cssText = "font-weight:400;color:rgba(255,255,255,.45);font-size:10px;margin-left:auto;cursor:pointer";
      close.textContent = "✕";
      close.onclick = function(){ if (el.parentNode) el.parentNode.removeChild(el); };
      hd.appendChild(close);
      el.appendChild(hd);
      var body = document.createElement("div");
      body.style.cssText = "color:rgba(255,255,255,.92);word-break:break-word;";
      body.textContent = lines;
      el.appendChild(body);
      if (src) {
        var foot = document.createElement("div");
        foot.style.cssText = "margin-top:6px;font-size:10px;color:rgba(255,255,255,.4)";
        foot.textContent = "来源：" + src;
        el.appendChild(foot);
      }
      var root = document.documentElement || document.body;
      (document.body || root).appendChild(el);
      requestAnimationFrame(function(){ el.style.opacity = "1"; el.style.transform = "translateY(0)"; });
      setTimeout(function(){ if (el.parentNode) { el.style.opacity = "0"; el.style.transform = "translateY(10px)"; setTimeout(function(){ if (el.parentNode) el.parentNode.removeChild(el); }, 380); } }, 12000);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
    else run();
  } catch (e) {}
})();</script>`;
}

/** 开关持久化（demo 容忍读写失败，缺省开）。 */
function flagPath(configDir: string) { return join(configDir, "humor-flag.json"); }

export function setEnabled(configDir: string, on: boolean): void {
  try { writeFileSync(flagPath(configDir), JSON.stringify({ enabled: !!on })); } catch { /* ignore */ }
}

export function isEnabled(configDir: string): boolean {
  try {
    return JSON.parse(readFileSync(flagPath(configDir), "utf8")).enabled !== false;
  } catch { return true; }
}

/** 注册到 service-tunnels 注入注册点（软依赖：无注册点则跳过）。
 *  registry 由 service-tunnels 按需创建（首个 /status/middleware 调用）——
 *  本扩展 startup 可能早于它（字母序 aiti-* < demo < service-tunnels），
 *  注册前重试直到注册点就绪（与 aiti-devtools enrollPorts 同模式）。 */
export function registerHumorInjector(configDir, humorPicker) {
  const tryRegister = (): (() => void) | null => {
    const reg = globalThis.__stInjectRegistry;
    if (!reg || typeof reg.register !== "function") {
      const t = setTimeout(() => tryRegister(), 200);
      (t as unknown as { unref?: () => void }).unref?.();
      return null;
    }
    return reg.register("demo", {
      label: DEMO_INJECT_LABEL,
      description: DEMO_INJECT_DESC,
      /** 任意端口都注入（demo 演示：打开被公开的页面都弹）；开关关 → 不注入。 */
      scriptFor(port, url, method) {
        if (method && method !== "GET") return null;
        if (!isEnabled(configDir)) return null;
        try {
          const pick = humorPicker(configDir);
          return { html: humorInjectScript(pick.text, pick.from ? `${pick.from}（hitokoto）` : "hitokoto"), position: "head" };
        } catch {
          return null;
        }
      },
    });
  };
  return tryRegister();
}
