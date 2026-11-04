#!/usr/bin/env node
/**
 * aiti-ui-env · 部署到 ~/.pi/web/extensions/ 和 ~/.pi/web-dev/extensions/
 *
 * 源码在 pi-work pi-web-ext/aiti-ui-env/（权威源码位置）；
 * 部署 = 整目录同步到两个扩展根 + git 提交部署状态。
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 */
import { cpSync, rmSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-ui-env

// 0) 客户端 bundle 构建（client/src/*.tsx → client/aiti-ui-env-client.mjs）
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-ui-env"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-ui-env"),
];

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  rmSync(extDir, { recursive: true, force: true });
  cpSync(root, extDir, { recursive: true, filter: (src) => !src.includes("/tools/") && !src.includes("node_modules") });
  console.log("[deploy] → " + extDir);
}

// vnc-bridge + rdp-bridge（无依赖 Node 脚本）额外拷贝到 dataDir/cache：vncAction/rdpAction 从 cache spawn 它们
// （lib/ 编译产物路径不可靠，cache 固定且属扩展进程可写；数据分层：可再生成 → cache）。
for (const [srcName, dstName] of [
  ["vnc-bridge.mjs", "vnc-bridge.mjs"],
  ["rdp-bridge.mjs", "rdp-bridge.mjs"],
]) {
  const bridgeSrc = resolve(root, "lib", srcName);
  if (!existsSync(bridgeSrc)) { console.log("[deploy] skip " + srcName + "（不存在）"); continue; }
  for (const d of [resolve(homedir(), ".pi", "web", "data", "aiti-ui-env", "cache"), resolve(homedir(), ".pi", "web-dev", "data", "aiti-ui-env", "cache")]) {
    mkdirSync(d, { recursive: true });
    copyFileSync(bridgeSrc, resolve(d, dstName));
    console.log("[deploy] " + dstName + " → " + d);
  }
}

// noVNC 静态（扩展内置 vendor 副本，离线零依赖）→ dataDir/cache/novnc：vnc-bridge serve 用。
// 存在 cache/novnc/vnc.html 且比 vendor 旧（或缺失）时覆盖（幂等，保留用户自定义放前面即可）。
{
  const novncSrc = resolve(root, "lib", "vendor", "novnc");
  if (existsSync(resolve(novncSrc, "vnc.html"))) {
    for (const d of [resolve(homedir(), ".pi", "web", "data", "aiti-ui-env", "cache"), resolve(homedir(), ".pi", "web-dev", "data", "aiti-ui-env", "cache")]) {
      const dst = resolve(d, "novnc");
      mkdirSync(dst, { recursive: true });
      cpSync(novncSrc, dst, { recursive: true });
      console.log("[deploy] novnc (vendor) → " + dst);
    }
  } else {
    console.log("[deploy] noVNC vendor 缺失（lib/vendor/novnc/vnc.html），跳过");
  }
}

// grdpwasm 静态文件（main.wasm + wasm_exec.js + index.html）：从源码目录或常见安装位置拷贝到 dataDir/grdpwasm/
// grdpwasm 是 Go WASM RDP 客户端，主入口 index.html 加载 main.wasm + wasm_exec.js（同源相对路径）
const GRDPWASM_SRC = [
  process.env.UI_ENV_GRDPWASM_DIR || "",
  resolve(homedir(), "grdpwasm", "static"),         // 标准安装位置
  resolve("D:/workspace/grdpwasm/static"),           // Windows 仓库盘常见位置
  resolve(homedir(), "workspace", "grdpwasm", "static"),  // 源码目录
  resolve("/opt", "grdpwasm", "static"),
  resolve("/opt", "grdpwasm"),
  resolve(homedir(), "grdpwasm"),                   // 根目录兜底（部分构建直接把静态放根下）
].filter(Boolean);
let grdpwasmSrcDir = null;
for (const candidate of GRDPWASM_SRC) {
  try {
    if (existsSync(resolve(candidate, "index.html")) && existsSync(resolve(candidate, "main.wasm"))) {
      grdpwasmSrcDir = candidate;
      break;
    }
  } catch { /* ignore */ }
}
// wasm 陈旧守卫：解码器修复只发生在 fork 仓（aiti-aigrdpwasm），主线仓
// static 常落后——若 fork 构建更新，提示先回写再部署（2026-09-15 曾因此
// 把已修复的 wasm 打回旧版，斑块/文字花屏复发）。
{
  const forkWasm = resolve(homedir(), "workspace", "aiti-aigrdpwasm", "static", "main.wasm");
  if (grdpwasmSrcDir && existsSync(forkWasm)) {
    const srcWasm = resolve(grdpwasmSrcDir, "main.wasm");
    if (existsSync(srcWasm) && statSync(forkWasm).mtimeMs > statSync(srcWasm).mtimeMs + 5000) {
      console.warn(`[deploy] ⚠️ fork 仓 main.wasm 比部署源新：先执行` +
        ` cp ${forkWasm} ${srcWasm} 再部署，否则会把旧解码器打回部署目录！`);
    }
  }
}
// 公共查看器资产（canonical 源 = lib/view-common）：拷到 dataDir/cache/view-common，
// 供 VNC view.html 经 <token>/common/* 加载（快捷键条/虚拟键盘/系统键盘/keysym 工具）。
// 路径对齐运行时：index.ts 公共资产路由读 getDataDir()/cache/view-common（数据分层：可再生物 → cache）；
// 写根下旧位置会被 startup 迁移逻辑跳过（cache 已存在），改动不生效。
// 注意：与 grdpwasm 是否安装无关，独立执行——只装 VNC 也能用。
{
  const viewCommonSrc = resolve(root, "lib", "view-common");
  const CANONICAL = ["virtual-keyboard.js", "virtual-keyboard.css", "shortcut-bar.js", "remote-keys.js", "system-keyboard.js",
    "vendor/simple-keyboard.js", "vendor/simple-keyboard.css", "type-text.js"];
  for (const d of [resolve(homedir(), ".pi", "web", "data", "aiti-ui-env"), resolve(homedir(), ".pi", "web-dev", "data", "aiti-ui-env")]) {
    const dst = resolve(d, "cache", "view-common");
    for (const rel of CANONICAL) {
      mkdirSync(resolve(dst, dirname(rel)), { recursive: true });
      copyFileSync(resolve(viewCommonSrc, rel), resolve(dst, rel));
    }
    console.log("[deploy] view-common → " + dst);
  }
}

if (grdpwasmSrcDir) {
  // 回写覆盖 grdpwasm 源目录同名文件：保证 RDP 载体与 VNC 用同一份公共件
  const viewCommonSrc = resolve(root, "lib", "view-common");
  const CANONICAL = ["virtual-keyboard.js", "virtual-keyboard.css", "shortcut-bar.js", "remote-keys.js", "system-keyboard.js",
    "vendor/simple-keyboard.js", "vendor/simple-keyboard.css", "type-text.js"];
  if (resolve(grdpwasmSrcDir) !== viewCommonSrc) {
    for (const rel of CANONICAL) {
      mkdirSync(resolve(grdpwasmSrcDir, dirname(rel)), { recursive: true });
      copyFileSync(resolve(viewCommonSrc, rel), resolve(grdpwasmSrcDir, rel));
    }
    console.log("[deploy] view-common 覆写 grdpwasm 同名文件 ← " + grdpwasmSrcDir);
  }
  const grdpwasmFiles = [
    "index.html", "main.wasm", "wasm_exec.js",
    "vendor/justget.browser.js",
    // 虚拟键盘（simple-keyboard 引擎 + 程序员布局包装器；canonical 在 lib/view-common）
    "vendor/simple-keyboard.js", "vendor/simple-keyboard.css",
    "virtual-keyboard.js", "virtual-keyboard.css",
    // 快捷键条 / 系统键盘 / keysym 工具（公共件，RDP 载体后续接入即用）
    "shortcut-bar.js", "remote-keys.js", "system-keyboard.js",
  ];
  // proxyURL() 补丁：grdpwasm 默认连 ws(s)://host/ws，但本扩展的桥挂在
  // <base>/aiti-ui-env/rdp/ws（dev 还有 /dev 前缀）。部署时幂等替换为从
  // location.pathname 派生 base，保证 WS 打到 middleware 路由下。
  const PROXY_OLD = `function proxyURL() {
      return (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
    }`;
  const PROXY_NEW = `function proxyURL() {
      // 派生当前页面所在 base 路径（如 /aiti-ui-env/rdp 或 /dev/aiti-ui-env/rdp），
      // 让 WS 连接到同 base 下的 /ws （由 pi-web middleware 按 <token> 路由到对应 rdp-bridge）
      const base = location.pathname.endsWith("/index.html")
        ? location.pathname.slice(0, -\"/index.html\".length)
        : location.pathname;
      return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + base;
    }`;
  const patchIndexHtml = (p) => {
    let c;
    try { c = readFileSync(p, "utf8"); } catch { return; }
    let changed = false;
    // proxyURL() 补丁（幂等）：让 WS 打到 middleware 路由下（从 location.pathname 派生 base）
    if (!c.includes("const base = location.pathname.endsWith") && c.includes(PROXY_OLD)) {
      c = c.replace(PROXY_OLD, PROXY_NEW);
      changed = true;
    }
    // 自动连接脚本（幂等，对齐 noVNC 的 autoconnect）：目标不落 URL——rdp-bridge 在 serve 时
    // 已注入 window.__rdpTarget（实例配置），这里读它填表单并自动连接。grdpwasm 的 doConnect()
    // 从表单读 host/port → Go 端拼 wsURL = proxyURL() + "/ws"（已改，不再带 ?target=），
    // 所以填对表单 = WS 与握手都正确。
    if (!c.includes("__rdpAutoConnect")) {
      const ac = `<script id="__rdpAutoConnect">
(function () {
  var t = window.__rdpTarget;
  if (!t || !t.host) return;
  var f = function (id, v) { var e = document.getElementById(id); if (e) e.value = v; };
  f("host", t.host); f("port", String(t.port || "3389"));
  if (t.user) f("user", t.user);
  if (t.password) f("password", t.password);
  if (t.domain) f("domain", t.domain);
  var tried = 0;
  (function poll() {
    // 等 WASM 加载完 rdpConnect 可用后再连（main.wasm 10MB，instantiateStreaming 异步）
    // 密码为空：显示凭据输入框（移除 autoconnect 隐藏），等用户填完点 Connect
    var pwEl = document.getElementById("password");
    if (!pwEl || !pwEl.value) {
      document.documentElement.classList.remove('autoconnect');
      if (++tried > 600) return;
      setTimeout(poll, 200);
      return;
    }
    if (typeof rdpConnect === "function" && typeof toggleConnect === "function") {
      if (typeof connected !== "boolean" || !connected) toggleConnect();
      return;
    }
    if (++tried > 100) return;
    setTimeout(poll, 200);
  })();
})();
</script>`;
      c = c.replace("</body>", ac + "\n</body>");
      changed = true;
    }
    if (changed) writeFileSync(p, c);
  };
  for (const d of [resolve(homedir(), ".pi", "web", "data", "aiti-ui-env"), resolve(homedir(), ".pi", "web-dev", "data", "aiti-ui-env")]) {
    const dstDir = resolve(d, "cache", "grdpwasm"); // 路径对齐运行时 findRdpDist() 候选（configDir/cache/grdpwasm）
    mkdirSync(dstDir, { recursive: true });
    for (const f of grdpwasmFiles) {
      const src = resolve(grdpwasmSrcDir, f);
      const dst = resolve(dstDir, f);
      if (existsSync(src)) {
        try { rmSync(dst, { force: true }); } catch { /* 只读目标文件先删再拷 */ }
        mkdirSync(dirname(dst), { recursive: true }); // vendor/ 子目录
        copyFileSync(src, dst);
        if (f === "index.html") patchIndexHtml(dst);
        console.log(`[deploy] grdpwasm/${f} (${f === "main.wasm" ? "WASM" : "static"}) → ` + dstDir);
      } else {
        console.log(`[deploy] grdpwasm/${f} 跳过（${src} 不存在）`);
      }
    }
  }
} else {
  console.log("[deploy] grdpwasm 静态文件跳过（未在常见位置找到 index.html + main.wasm）");
}

// 部署状态提交（生产根是 git 仓库；失败不影响部署）
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["monitor"], { log: (m2) => console.log(m2) });

deployCommit({ repo: extRepo, name: "aiti-ui-env", paths: ["aiti-ui-env"], log: (m) => console.log("[deploy] " + m) });
console.log("[deploy] 完成。reload: POST /api/extensions/reload");

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack（方案 §3.2：源码+构建工具+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
