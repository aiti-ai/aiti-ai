/**
 * aiti-helper · 全局弹窗 AI 按钮（§4.4：dialog 关闭按钮左边自动插 🤖）—— 纯 TS（DOM 扫描，无 JSX）。
 *
 * 依赖框架级身份标注：pi-web <ExtSlot> 给每个 slot item 包一层 display:contents 的 div，
 * 盖上 data-ext-id/data-ext-slot/data-ext-item（零布局影响，但 DOM 上可反查 owning 扩展）。
 * 因此本扫描器不依赖脆弱的 role=dialog/class~dialog 匹配——扩展弹窗通常是 position:fixed 的裸 div；
 * 改扫 [data-ext-id] 包装器，可靠命中所有扩展弹窗，且能直接拿到 owning 扩展 id →
 * 唤起 ai-helper 时按「本扩展 skills + 通用 skills + 其他扩展」分组展示。
 * 兼容兜底：未盖 data-ext-id 的非扩展弹窗（如 pi-web 内置 dialog）走 role=dialog/class~dialog 扫描。
 */

// 扩展展示名（id → 友好名，与 extman 共用同一张表）
import { extDisplayName } from "../../../_shared/ext-display-names";
import { apiUrl } from "./host-shim";

// AI 星星图标（单源 icons/sparkles.svg，_shared/icons 库经 deploy copyIcons 拷入）——
// assets CSS-mask 渲染（currentColor 继承按钮颜色），与 helper 弹窗内 SparkIcon 同一文件；
// 不再手抄 path（曾因多份手抄出现「缺左下小星」的两种星星）。
const AiBotIconHtml = (size = 16) => {
  const url = apiUrl("/api/extensions/aiti-helper/assets/icons/sparkles.svg");
  return '<span aria-hidden="true" style="display:inline-block;width:' + size + 'px;height:' + size + 'px;background:currentColor;' +
    '-webkit-mask:url(' + url + ') center/contain no-repeat;mask:url(' + url + ') center/contain no-repeat"></span>';
};

const AI_BTN_ATTR = "data-aiti-ai-btn";
const HOST_ATTR = "data-aiti-ai-host";   // 标在 close 按钮上：已挂载过 AI 按钮（防重复注入）

// 判断按钮是否为「移除/删除」类操作（而非弹窗关闭按钮）。
// 列表/行里的 ✕（如模型向导模型列表的「移除模型」、多 key 的「删除此 key」）是删除操作，
// 不该被当成弹窗关闭按钮挂 AI 图标；用 aria-label/title 里的语义词识别，避开误挂。
const REMOVE_RE = /\b(remove|delete|del|trash|clear)\b|移除|删除|删掉|移出/i;
function isRemoveAction(btn: Element): boolean {
  const s = ((btn.getAttribute("aria-label") || "") + " " + (btn.getAttribute("title") || "") + " " + (btn.getAttribute("data-tooltip") || "")).trim();
  return !!s && REMOVE_RE.test(s);
}

// 在 root 子树里找关闭按钮：① aria-label/类名含 close ② 文本是 ×/✕/✖
function findCloseBtn(root: Element | null): HTMLElement | null {
  if (!root) return null;
  const candidates = root.querySelectorAll(
    'button[aria-label*="close" i], button[aria-label*="关闭"], button[aria-label*="Close"], ' +
    // title 只写不读屏（aria-label 缺失）的写法也认：如 aiti-ui-env 关闭按钮 title="关闭" + SVG 图标无文本；
    // 误伤风险已被 isRemoveAction 覆盖（它本就读 title 语义词过滤移除/删除类）。
    'button[title*="close" i], button[title*="关闭"], button[title*="Close"], ' +
    '[class*="close" i] button, [class*="Close"] button, ' +
    'button[class*="close" i], button[class*="Close"]'
  );
  // 显式关闭按钮（aria-label/类名含 close）优先：取第一个可见且未挂过 AI 的返回。
  // 同时记录是否存在「任何可见的显式关闭按钮」（含已挂过）——只要有，就不再兜底扫 ✕ 文本按钮。
  let anyExplicitClose = false;
  for (const b of candidates) {
    const rect = b.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      if (isRemoveAction(b)) continue;   // 移除/删除类按钮不当关闭按钮
      anyExplicitClose = true;
      if (!b.hasAttribute(HOST_ATTR)) return b as HTMLElement;
    }
  }
  // 已有显式关闭按钮（即使已挂过 AI）→ 不再兜底扫 ✕ 文本按钮：
  // 防止把列表/行内的「移除/删除 ✕」误当成弹窗关闭按钮（如模型向导模型列表里的 ✕ 被逐个挂 AI 图标的 bug）。
  if (anyExplicitClose) return null;
  // 兜底：裸 "✕"/"✖" 关闭按钮（无 aria-label/类名）——排除移除/删除类操作按钮
  for (const b of root.querySelectorAll("button")) {
    if (b.hasAttribute(HOST_ATTR)) continue;
    if (isRemoveAction(b)) continue;
    const t = (b.textContent || "").trim();
    if (t === "×" || t === "✕" || t === "✖") {
      const rect = b.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return b as HTMLElement;
    }
  }
  return null;
}

// 找「弹窗面板」元素：从 closeBtn 往上找最近的有盒子的容器（用于抽标题/字段/作 fill 回填目标）。
// 优先 role=dialog / class~dialog~modal；都没有时退到 closeBtn 的最近有盒子的祖先（position:fixed overlay）。
function findDialogPanel(closeBtn: HTMLElement): HTMLElement {
  const panel = closeBtn.closest('[role="dialog"], [class*="dialog" i], [class*="Dialog"], [class*="modal" i], [class*="Modal"]');
  if (panel) { const r = panel.getBoundingClientRect(); if (r.width > 50 && r.height > 50) return panel as HTMLElement; }
  let el: HTMLElement | null = closeBtn.parentElement;
  while (el && el !== document.body) {
    const r = el.getBoundingClientRect();
    if (r.width > 80 && r.height > 60) return el;
    el = el.parentElement;
  }
  return closeBtn.parentElement || closeBtn;
}

// 从一个元素反查 owning 扩展 id/name：closest [data-ext-id]（框架在 ExtSlot 包装层盖的）。
function getOwnerExt(el: Element | null): { id: string; name: string } {
  let cur: Element | null = el instanceof Element && el.closest ? el : (el && el.parentElement) || null;
  while (cur && cur !== document.body) {
    const id = cur.getAttribute && cur.getAttribute("data-ext-id");
    if (id) {
      let name = id;
      try {
        const metas = ((window as any).__piWebExtUI && (window as any).__piWebExtUI.metas) || {};
        if (metas[id] && metas[id].name) name = metas[id].name;
      } catch {}
      return { id, name };
    }
    cur = cur.parentElement;
  }
  return { id: "", name: "" };
}

function getDialogContext(panel: HTMLElement) {
  const heading = panel.querySelector("h1,h2,h3,[class*='title' i],[class*='Title'],[role='heading']");
  const title = heading ? (heading.textContent || "").trim().slice(0, 80) : "";
  const body = (panel.textContent || "").trim().slice(0, 200);
  const fields: string[] = [];
  panel.querySelectorAll("input, textarea, select, [contenteditable=\"true\"], [contenteditable=\"plaintext-only\"], [contenteditable=\"\"]").forEach((el, i) => {
    if (i >= 6) return;
    const label = el.closest("label") ? el.closest("label")!.textContent!.trim().slice(0, 20) : (el.getAttribute("aria-label") || el.getAttribute("data-placeholder") || "").slice(0, 20);
    const val = ((el as any).isContentEditable ? ((el as any).innerText || "") : ((el as any).value || "")).slice(0, 40);
    if (label || val) fields.push((label || "字段" + (i + 1)) + "=" + val);
  });
  return { title, body, fields: fields.join("；") };
}

// 给一个 closeBtn 挂 AI 按钮（ext 可缺：非扩展弹窗也能挂，仅不分组高亮本扩展 skills）
function injectAt(closeBtn: HTMLElement, ext: { id: string; name: string }): boolean {
  if (!closeBtn || closeBtn.hasAttribute(HOST_ATTR)) return false;
  // aiti-helper 自己的 dialog 不挂（它本身就是 AI 入口，再挂会递归唤起自己）
  if (ext && ext.id === "aiti-helper") { closeBtn.setAttribute(HOST_ATTR, "1"); return false; }
  const panel = findDialogPanel(closeBtn);
  closeBtn.setAttribute(HOST_ATTR, "1");

  const aiBtn = document.createElement("button");
  aiBtn.setAttribute(AI_BTN_ATTR, "1");
  aiBtn.innerHTML = AiBotIconHtml(16);
  aiBtn.title = ext && ext.id ? "AI Helper：让 AI 帮我用 " + extDisplayName(ext.id, ext.name || ext.id) + " 处理这个弹窗" : "AI Helper：让 AI 帮我处理这个弹窗";
  aiBtn.style.cssText = "cursor:pointer;border:none;background:none;color:inherit;padding:2px 6px;line-height:1;opacity:.85;display:inline-flex;align-items:center";
  aiBtn.onmouseenter = () => { aiBtn.style.opacity = "1"; };
  aiBtn.onmouseleave = () => { aiBtn.style.opacity = ".85"; };
  aiBtn.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const ctxInfo = getDialogContext(panel);
    const extId = ext && ext.id ? ext.id : "";
    const extName = ext && ext.id ? extDisplayName(ext.id, ext.name || null) : "";
    const sysParts: string[] = [];
    if (extId) sysParts.push("用户在扩展「" + extName + "」（id=" + extId + "）的弹窗里点了 AI 按钮。请优先按该扩展的 skills（帮助点）帮用户驱动这个扩展。弹窗标题：「" + ctxInfo.title + "」。");
    else sysParts.push("用户在一个弹窗里点了 AI 按钮。弹窗标题：「" + ctxInfo.title + "」。");
    sysParts.push("内容摘要：" + ctxInfo.body);
    if (ctxInfo.fields) sysParts.push("当前表单值：" + ctxInfo.fields);
    sysParts.push("请根据弹窗上下文帮用户处理相关任务；如需操作该弹窗表单可调 self_ui/form_fill 工具。");
    (window as any).__aitiHelperInvoke({
      system: sysParts.join(""),
      placeholder: "告诉 AI 你想让" + (extName || "它") + "做什么…",
      contextLabel: (extName ? extName + " · " : "") + (ctxInfo.title || "弹窗 AI"),
      dialogEl: panel,     // 供 action:fill 回填弹窗表单
      extId, extName,      // 分组高亮本扩展 skills
    });
  };

  try {
    closeBtn.parentNode!.insertBefore(aiBtn, closeBtn);
  } catch {
    try { closeBtn.parentNode!.appendChild(aiBtn); } catch {}
  }
  return true;
}

export function installDialogAiButton(): () => void {
  let scanTimer: ReturnType<typeof setTimeout> | null = null;

  const scan = () => {
    // 逐弹窗去重（非逐 wrapper）：一个扩展 wrapper 内可能嵌套多个弹窗（如 aiti-cmd 主面板内嵌
    // 「新建/编辑命令」卡片弹窗），各自都该有自己的 🤖。每次找「第一个未挂载的」关闭按钮，
    // 按其所属弹窗面板查重：面板里已有 🤖 就标记此按钮推进到下一候选，否则注入。
    const scanRoot = (root: Element) => {
      let closeBtn = findCloseBtn(root);
      let guard = 0;
      while (closeBtn && guard++ < 20) {
        const panel = findDialogPanel(closeBtn);
        if (panel.querySelector("[" + AI_BTN_ATTR + "]")) {
          closeBtn.setAttribute(HOST_ATTR, "1");   // 该弹窗已挂过：标记此按钮，findCloseBtn 下轮跳过它
        } else {
          injectAt(closeBtn, getOwnerExt(closeBtn));
        }
        closeBtn = findCloseBtn(root);
      }
    };
    // 1) 扩展弹窗（框架盖了 data-ext-id 的 slot 包装器；display:contents 无盒，扫子树里的 close 按钮）
    document.querySelectorAll("[data-ext-id]").forEach(scanRoot);
    // 2) 兜底：未盖 data-ext-id 的非扩展弹窗（pi-web 内置 dialog 等）
    document.querySelectorAll('[role="dialog"], [class*="dialog" i], [class*="Dialog"], [class*="modal" i], [class*="Modal"]').forEach((d) => {
      const r = d.getBoundingClientRect();
      if (r.width > 50 && r.height > 50) scanRoot(d);
    });
  };

  // 200ms 尾缘节流（非防抖）：首笔变更后 200ms 必扫一次，后续变更在窗口内不再重置——
  // 防抖会被持续 DOM 心跳（顶栏统计/FAB 徽标 ~200ms/次）永远重置，scan 一次都跑不上（饿死），
  // 表现为弹窗 🤖 永远不出现。节流下高频心跳也只是让 scan 以 ≤5 次/s 空跑，扫描本身只是几次 querySelectorAll，开销可忽略。
  const observer = new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(scan, 500);

  return () => { observer.disconnect(); if (scanTimer) clearTimeout(scanTimer); };
}
