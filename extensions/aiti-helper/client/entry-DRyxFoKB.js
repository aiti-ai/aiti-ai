let _ctx = null;
function __setCtx(ctx) {
  _ctx = ctx;
}
function extSvc(key) {
  return _ctx?.getExtService?.(key);
}
function regSvc(key, impl) {
  const c2 = _ctx;
  return typeof c2?.registerExtService === "function" ? c2.registerExtService(key, impl) : null;
}
function hostCtx() {
  return _ctx;
}
function c(name) {
  return _ctx?.[name] ?? (() => void 0);
}
const Fragment = typeof Symbol !== "undefined" && Symbol.for ? Symbol.for("react.fragment") : 2763;
function createElement(...args) {
  return c("h").call(null, ...args);
}
function mergeKey(args) {
  const [type, props, key, ...rest] = args;
  if (props && typeof props === "object") {
    const merged = { ...props };
    if (key !== void 0 && key !== null) merged.key = key;
    return [type, merged, ...rest];
  }
  return args;
}
const jsx = (...args) => createElement(...mergeKey(args));
const jsxs = (...args) => {
  const props = args[1];
  const children = props?.children;
  if (Array.isArray(children)) {
    for (const c2 of children) {
      if (c2 && typeof c2 === "object" && c2._store) {
        c2._store.validated = 1;
      }
    }
  }
  return createElement(...mergeKey(args));
};
const useState = (init) => c("useState")(init);
const useEffect = (fn, deps) => c("useEffect")(fn, deps);
const useRef = (v) => c("useRef")(v);
const useCallback = (fn, deps) => c("useCallback")(fn, deps);
function apiUrl(p) {
  const fn = _ctx?.apiUrl;
  return typeof fn === "function" ? fn(p) : p;
}
const EXT_DISPLAY_NAMES = {
  "aiti-acp-agent": { en: "ACP Session Backend", zh: "ACP 会话后端" },
  "aiti-ai-input": { en: "AI Input Enhancer", zh: "AI 输入增强" },
  "aiti-ai-schedule": { en: "AI Schedule", zh: "AI 定时任务" },
  "aiti-ai-speek": { en: "AI Voice Reading", zh: "AI 语音朗读" },
  "aiti-ai-usage": { en: "AI Usage", zh: "AI 用量统计" },
  "aiti-append-system": { en: "Append System Prompt", zh: "追加系统提示词" },
  "aiti-attach-agent": { en: "Attach Session Backend", zh: "附着会话后端" },
  "aiti-channels": { en: "IM Channels", zh: "IM 渠道" },
  "aiti-claude-code-agent": { en: "Claude Code Session Backend", zh: "Claude Code 会话后端" },
  "aiti-cmd": { en: "Command Palette", zh: "命令面板" },
  "aiti-codex-agent": { en: "Codex Session Backend", zh: "Codex 会话后端" },
  "aiti-configs": { en: "Config Versioning & Self-check", zh: "配置版本化 + 崩溃自检" },
  "aiti-cpu-meter": { en: "CPU Meter", zh: "CPU 流畅度仪表" },
  "aiti-crash-fatal": { en: "Crash Drill (dev)", zh: "崩溃演习（开发）" },
  "aiti-cursor-agent": { en: "Cursor Session Backend", zh: "Cursor 会话后端" },
  "aiti-debug-inject": { en: "Remote Debug Inject", zh: "远程调试注入" },
  "aiti-devtools": { en: "Page DevTools", zh: "页面 AI 调试工具" },
  "aiti-devtools-vite": { en: "DevTools Vite Plugin", zh: "DevTools Vite 插件" },
  "aiti-devtools-vue": { en: "DevTools Vue Plugin", zh: "DevTools Vue 插件" },
  "aiti-doc-center": { en: "Doc Center", zh: "文档中心" },
  "aiti-draft-keeper": { en: "Draft Keeper", zh: "草稿保管员" },
  "aiti-echo-agent": { en: "Echo Session Backend", zh: "Echo 会话后端" },
  "aiti-editor": { en: "File Editor", zh: "文件编辑器" },
  "aiti-event-bus": { en: "Page Event Bus", zh: "页面事件总线" },
  "aiti-extman": { en: "Extension Manager", zh: "扩展管理器" },
  "aiti-float": { en: "Dialog Float Enhancer", zh: "弹窗浮动增强器" },
  "aiti-folder": { en: "Folder Browser", zh: "文件夹浏览器" },
  "aiti-git-review": { en: "Git Review", zh: "Git 代码审核" },
  "aiti-git-trace": { en: "AI Change Trace", zh: "AI 变更追踪" },
  "aiti-helper": { en: "AI Helper", zh: "AI 助手入口" },
  "aiti-inject": { en: "Debug Inject FAB", zh: "调试注入按钮" },
  "aiti-mcp-bridge": { en: "MCP Bridge", zh: "MCP 桥" },
  "aiti-model-check": { en: "Model Availability", zh: "模型可用性管理" },
  "aiti-model-wizard": { en: "Model Wizard", zh: "模型添加向导" },
  "aiti-msg-anchor": { en: "Message Anchor Banner", zh: "消息锚点横幅" },
  "aiti-msg-nav": { en: "Message Scroll Nav", zh: "消息滚动导航" },
  "aiti-msg-smart": { en: "Message Intelligence", zh: "消息智能" },
  "aiti-onlyoffice": { en: "OnlyOffice Editor", zh: "OnlyOffice 编辑" },
  "aiti-pi-agent": { en: "pi Session Backend", zh: "pi 会话后端" },
  "aiti-plan-first": { en: "Plan-First Reminder", zh: "方案先行" },
  "aiti-plan-review": { en: "Plan Review", zh: "方案评审" },
  "aiti-prompts": { en: "Prompt Snippets", zh: "Prompt 片段收藏库" },
  "aiti-qoder-agent": { en: "Qoder Session Backend", zh: "Qoder 会话后端" },
  "aiti-queue-keeper": { en: "Queue Keeper", zh: "队列管家" },
  "aiti-sheet-univer": { en: "Excel Editor", zh: "Excel 编辑器" },
  "aiti-subagents": { en: "Subagents", zh: "子代理" },
  "aiti-testagent": { en: "TestAgent · Java Debugging", zh: "TestAgent · Java 后端调试" },
  "aiti-ui-env": { en: "UI Environment", zh: "UI 环境（桌面/无头虚拟屏）" },
  "aiti-word-docx-preview": { en: "Word Preview", zh: "Word 预览" },
  "aiti-word-superdoc": { en: "Word Editor", zh: "Word 编辑" },
  "aiti-zcode-agent": { en: "ZCode Session Backend", zh: "ZCode 会话后端" },
  "demo": { en: "Demo Extension", zh: "示例扩展" },
  "demo-lazy": { en: "Demo Extension (Lazy)", zh: "示例扩展（懒加载）" },
  "devtools-vscode": { en: "VS Code Plugin", zh: "VS Code 插件" },
  "devtools-idea": { en: "IDEA Plugin", zh: "IDEA 插件" },
  "ext-jsx-client": { en: "JSX Client Template", zh: "扩展 JSX 客户端模板" },
  "service-tunnels": { en: "Service Tunnels", zh: "服务隧道" },
  "session-manager": { en: "Session Manager", zh: "会话管理器" },
  "sm-demo-source": { en: "Demo Session Source", zh: "第三方会话源示例" }
};
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
function currentUiLocale() {
  try {
    const v = window.localStorage.getItem("pi-locale");
    if (v === "zh-CN" || v === "en") return v;
  } catch {
  }
  return "en";
}
function extDisplayName(id, fallbackName) {
  const entry = EXT_DISPLAY_NAMES[id];
  if (currentUiLocale() === "zh-CN") return entry && entry.zh || fallbackName || id;
  if (entry) return entry.en;
  return fallbackName && !CJK_RE.test(fallbackName) ? fallbackName : id;
}
const AiBotIconHtml = (size = 16) => {
  const url = apiUrl("/api/extensions/aiti-helper/assets/icons/sparkles.svg");
  return '<span aria-hidden="true" style="display:inline-block;width:' + size + "px;height:" + size + "px;background:currentColor;-webkit-mask:url(" + url + ") center/contain no-repeat;mask:url(" + url + ') center/contain no-repeat"></span>';
};
const AI_BTN_ATTR = "data-aiti-ai-btn";
const HOST_ATTR = "data-aiti-ai-host";
const REMOVE_RE = /\b(remove|delete|del|trash|clear)\b|移除|删除|删掉|移出/i;
function isRemoveAction(btn) {
  const s = ((btn.getAttribute("aria-label") || "") + " " + (btn.getAttribute("title") || "") + " " + (btn.getAttribute("data-tooltip") || "")).trim();
  return !!s && REMOVE_RE.test(s);
}
function findCloseBtn(root) {
  if (!root) return null;
  const candidates = root.querySelectorAll(
    'button[aria-label*="close" i], button[aria-label*="关闭"], button[aria-label*="Close"], button[title*="close" i], button[title*="关闭"], button[title*="Close"], [class*="close" i] button, [class*="Close"] button, button[class*="close" i], button[class*="Close"]'
  );
  let anyExplicitClose = false;
  for (const b of candidates) {
    const rect = b.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      if (isRemoveAction(b)) continue;
      anyExplicitClose = true;
      if (!b.hasAttribute(HOST_ATTR)) return b;
    }
  }
  if (anyExplicitClose) return null;
  for (const b of root.querySelectorAll("button")) {
    if (b.hasAttribute(HOST_ATTR)) continue;
    if (isRemoveAction(b)) continue;
    const t = (b.textContent || "").trim();
    if (t === "×" || t === "✕" || t === "✖") {
      const rect = b.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return b;
    }
  }
  return null;
}
function findDialogPanel(closeBtn) {
  const panel = closeBtn.closest('[role="dialog"], [class*="dialog" i], [class*="Dialog"], [class*="modal" i], [class*="Modal"]');
  if (panel) {
    const r = panel.getBoundingClientRect();
    if (r.width > 50 && r.height > 50) return panel;
  }
  let el = closeBtn.parentElement;
  while (el && el !== document.body) {
    const r = el.getBoundingClientRect();
    if (r.width > 80 && r.height > 60) return el;
    el = el.parentElement;
  }
  return closeBtn.parentElement || closeBtn;
}
function getOwnerExt(el) {
  let cur = el instanceof Element && el.closest ? el : el && el.parentElement || null;
  while (cur && cur !== document.body) {
    const id = cur.getAttribute && cur.getAttribute("data-ext-id");
    if (id) {
      let name = id;
      try {
        const metas = window.__piWebExtUI && window.__piWebExtUI.metas || {};
        if (metas[id] && metas[id].name) name = metas[id].name;
      } catch {
      }
      return { id, name };
    }
    cur = cur.parentElement;
  }
  return { id: "", name: "" };
}
function getDialogContext(panel) {
  const heading = panel.querySelector("h1,h2,h3,[class*='title' i],[class*='Title'],[role='heading']");
  const title = heading ? (heading.textContent || "").trim().slice(0, 80) : "";
  const body = (panel.textContent || "").trim().slice(0, 200);
  const fields = [];
  panel.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]').forEach((el, i) => {
    if (i >= 6) return;
    const label = el.closest("label") ? el.closest("label").textContent.trim().slice(0, 20) : (el.getAttribute("aria-label") || el.getAttribute("data-placeholder") || "").slice(0, 20);
    const val = (el.isContentEditable ? el.innerText || "" : el.value || "").slice(0, 40);
    if (label || val) fields.push((label || "字段" + (i + 1)) + "=" + val);
  });
  return { title, body, fields: fields.join("；") };
}
function injectAt(closeBtn, ext) {
  if (!closeBtn || closeBtn.hasAttribute(HOST_ATTR)) return false;
  if (ext && ext.id === "aiti-helper") {
    closeBtn.setAttribute(HOST_ATTR, "1");
    return false;
  }
  const panel = findDialogPanel(closeBtn);
  closeBtn.setAttribute(HOST_ATTR, "1");
  const aiBtn = document.createElement("button");
  aiBtn.setAttribute(AI_BTN_ATTR, "1");
  aiBtn.innerHTML = AiBotIconHtml(16);
  aiBtn.title = ext && ext.id ? "AI Helper：让 AI 帮我用 " + extDisplayName(ext.id, ext.name || ext.id) + " 处理这个弹窗" : "AI Helper：让 AI 帮我处理这个弹窗";
  aiBtn.style.cssText = "cursor:pointer;border:none;background:none;color:inherit;padding:2px 6px;line-height:1;opacity:.85;display:inline-flex;align-items:center";
  aiBtn.onmouseenter = () => {
    aiBtn.style.opacity = "1";
  };
  aiBtn.onmouseleave = () => {
    aiBtn.style.opacity = ".85";
  };
  aiBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ctxInfo = getDialogContext(panel);
    const extId = ext && ext.id ? ext.id : "";
    const extName = ext && ext.id ? extDisplayName(ext.id, ext.name || null) : "";
    const sysParts = [];
    if (extId) sysParts.push("用户在扩展「" + extName + "」（id=" + extId + "）的弹窗里点了 AI 按钮。请优先按该扩展的 skills（帮助点）帮用户驱动这个扩展。弹窗标题：「" + ctxInfo.title + "」。");
    else sysParts.push("用户在一个弹窗里点了 AI 按钮。弹窗标题：「" + ctxInfo.title + "」。");
    sysParts.push("内容摘要：" + ctxInfo.body);
    if (ctxInfo.fields) sysParts.push("当前表单值：" + ctxInfo.fields);
    sysParts.push("请根据弹窗上下文帮用户处理相关任务；如需操作该弹窗表单可调 self_ui/form_fill 工具。");
    window.__aitiHelperInvoke({
      system: sysParts.join(""),
      placeholder: "告诉 AI 你想让" + (extName || "它") + "做什么…",
      contextLabel: (extName ? extName + " · " : "") + (ctxInfo.title || "弹窗 AI"),
      dialogEl: panel,
      // 供 action:fill 回填弹窗表单
      extId,
      extName
      // 分组高亮本扩展 skills
    });
  };
  try {
    closeBtn.parentNode.insertBefore(aiBtn, closeBtn);
  } catch {
    try {
      closeBtn.parentNode.appendChild(aiBtn);
    } catch {
    }
  }
  return true;
}
function installDialogAiButton() {
  let scanTimer = null;
  const scan = () => {
    const scanRoot = (root) => {
      let closeBtn = findCloseBtn(root);
      let guard = 0;
      while (closeBtn && guard++ < 20) {
        const panel = findDialogPanel(closeBtn);
        if (panel.querySelector("[" + AI_BTN_ATTR + "]")) {
          closeBtn.setAttribute(HOST_ATTR, "1");
        } else {
          injectAt(closeBtn, getOwnerExt(closeBtn));
        }
        closeBtn = findCloseBtn(root);
      }
    };
    document.querySelectorAll("[data-ext-id]").forEach(scanRoot);
    document.querySelectorAll('[role="dialog"], [class*="dialog" i], [class*="Dialog"], [class*="modal" i], [class*="Modal"]').forEach((d) => {
      const r = d.getBoundingClientRect();
      if (r.width > 50 && r.height > 50) scanRoot(d);
    });
  };
  const observer = new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(scan, 500);
  return () => {
    observer.disconnect();
    if (scanTimer) clearTimeout(scanTimer);
  };
}
let realInvoke = null;
let loadingUI = null;
let pendingOpts = null;
function ensureHeavy() {
  if (loadingUI) return;
  loadingUI = import("./helper-app-CkHhH1DE.js").then((m) => {
    realInvoke = m.mountHeavyUI();
    if (pendingOpts) {
      const o = pendingOpts;
      pendingOpts = null;
      realInvoke(o);
    }
    try {
      console.log("[aiti-helper] 重 UI chunk 已加载，弹窗就绪");
    } catch {
    }
  }).catch((err) => {
    loadingUI = null;
    try {
      console.error("[aiti-helper] 重 UI chunk 加载失败（下次 invoke 重试）：", err);
    } catch {
    }
  });
}
function invokeStable(opts = {}) {
  if (realInvoke) return realInvoke(opts);
  pendingOpts = opts;
  ensureHeavy();
  return true;
}
function suggestStable(q) {
  invokeStable({
    system: "用户在聊天输入框打字但没命中收藏命令/prompt。请根据用户输入生成一条有用的简短建议（命令或 prompt 文本），只输出建议内容本身，不加解释。",
    placeholder: "AI 生成中…（基于「" + q + "」）",
    contextLabel: "suggest 兜底：「" + q + "」"
  });
}
function register(ctx) {
  __setCtx(ctx);
  ctx.registerItems?.("toolbar", [{
    id: "aiti-helper-open",
    meta: {
      label: "AI 助手",
      title: "aiti-helper：一句话唤起 AI（帮助点/自由发挥；独立置顶弹窗，可拖拽，有历史）",
      icon: "icons/sparkles.svg",
      onClick: () => window.__aitiHelperInvoke({ placeholder: "描述你想让 AI 做什么…" })
    }
  }]);
  window.__aitiHelperInvoke = invokeStable;
  window.__aitiSuggestAiFallback = suggestStable;
  regSvc?.("aiti-helper.invoke", invokeStable);
  regSvc?.("aiti-helper.suggestFallback", suggestStable);
  const cleanupAiButton = installDialogAiButton();
  try {
    window.__aitiHelperCleanup = cleanupAiButton;
  } catch {
  }
  try {
    console.log("[aiti-helper] 薄 entry 已挂载：稳定 invoke 入口 + 全局弹窗 AI 按钮（重 UI 按需加载）");
  } catch {
  }
}
export {
  Fragment as F,
  useEffect as a,
  useRef as b,
  useCallback as c,
  apiUrl as d,
  jsxs as e,
  extSvc as f,
  extDisplayName as g,
  hostCtx as h,
  jsx as j,
  register as r,
  useState as u
};
