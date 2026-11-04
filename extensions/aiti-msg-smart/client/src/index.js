/**
 * aiti-msg-smart client — 消息智能（段落点击识别 → 弹层卡片动作条）
 *
 * 薄宿主扩展点：ctx.registerParagraphClick(handler)（core 广播段落点击事件 + setInline
 * 挂载点）。点击段落 → 弹层卡片，行为/样式对齐剥离前的 core QuoteReplyPopover：
 *   - question 区：每段 → 选项按钮（是/否/A/B/好，X，accent 高亮）或引用回复兜底（摘要）；
 *     多段/首段带选项时追加整段兜底引用
 *   - file 区：提取段落内路径（相对路径拼 cwd）→ /api/files 存在性校验 → 打开/定位两按钮
 *   - provider 区：外部 msg-popover-action 主题 provider（aiti-cmd 命令识别等）
 *   - 复制全文：长段落附加动作
 * 异步（file 校验 / provider 识别）到达后重渲染同一卡片。
 * 「同一时刻只开一个」模块级 state（切段先关旧段、同段再点=关闭 toggle）。
 */
import {
  parseParagraph, formatQuote, summarizeSegment, extractFilePaths,
  extractUrls, mergeExternalRoots, candidatesFromRoots, selfNameCandidates,
} from "./recognize.js";
import { openNewSession } from "../../../_shared/new-session-cwd";

const state = { opening: null };

// ── 渲染上下文（跨文档渲染支持，aiti-editor markdown 预览集成用）──
// 弹层的 DOM 宿主默认是顶层文档/窗口（聊天路径行为零变化）；info.doc / info.win 可把它整体
// 搬到另一个同源文档（如预览 iframe）——弹层渲染进 iframe 内，坐标/滚动跟随/层叠全部自洽，
// 免去跨文档 rect 换算与宿主弹窗 z-index 竞争。同一时刻只开一个弹层（state.opening 模块级
// 单例），rcx 同生命周期；每次 ph 入口按 info 重设，缺省恒回落顶层。
let rcx = { doc: typeof document !== "undefined" ? document : null, win: typeof window !== "undefined" ? window : null };
function setRcx(info) {
  rcx = {
    doc: (info && info.doc) || (typeof document !== "undefined" ? document : null),
    win: (info && info.win) || (typeof window !== "undefined" ? window : null),
  };
}

/** 动作类型 → lucide 线条图标（quote=问题回复 / file=文件 / command=命令；与系统内建同风格） */
function typeIcon(type) {
  const p = type === "quote" ? ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"]
    : type === "file" ? ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 9H8", "M16 13H8", "M16 17H8"]
    : type === "command" ? ["M4 17l6-6-6-6", "M12 19h8"]
    : type === "url" ? ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"] : null;
  if (!p) return null;
  const el = h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, p.map((d, i) => h("path", { key: i, d })));
  if (el._store) el._store.validated = 1;
  return el;
}

function FolderOpenIcon() {
  // 打开状态文件夹（盖掀起），区别于 FolderIcon 的普通文件夹
  return h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
    h("path", { d: "M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" }));
}
function FolderIcon() {
  return h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
    h("path", { d: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" }));
}

// 让 FolderOpenIcon 可用（h 在 register 内定义——延迟到模块加载后设置）
let h = null;
function setH(hh) { h = hh; }

export default function register(ctx) {
  h = ctx.h;
  const { t } = ctx;
  // 客户端 t 查本扩展 manifest ui.i18n 表，未命中返回 key 原文（truthy）——
  // 把「命中值 === key / 非字符串」视为未命中返回空串，让下方 `tr(k) || 中文默认`
  // 兑底生效，避免按钮显示裸 key（files.openFolder 实证）
  const tr = (k) => {
    if (typeof t !== "function") return "";
    const v = t(k);
    return typeof v === "string" && v !== k ? v : "";
  };
  const T = {
    quoteReply: tr("chat.quoteReply") || "引用回复",
    quoteFull: tr("chat.quoteFull") || "引用全文",
    quoteLine: tr("chat.quoteLine") || "引用单句",
    openFile: tr("i18n.openFile") || "打开文件",
    revealDir: tr("export.revealDir") || "定位目录",
    openFolder: tr("files.openFolder") || "打开文件夹", // 右侧 FolderViewer（display-only，不影响 cwd）
    copy: tr("chat.copy") || "复制",
    copied: tr("chat.copied") || "✓ 已复制",
  };

  /**
   * 「定位」= 右侧文件夹面板打开所在目录 **并选中该文件**。
   * 宿主 handleOpenFolder 走 aiti-folder dock 分支时忽略 select（只 present 目录不选中），
   * 选中须自己派发 folder-reveal；面板可能是 present 后才挂载——先写 __piFolderRevealLast
   * 供其挂载时重放（10s 内），与 aiti-editor「在目录打开」同链路。目录只打开自身。
   */
  function openFolderReveal(abs, isDir) {
    const dir = isDir ? abs : abs.split("/").slice(0, -1).join("/");
    if (typeof ctx.openFolder !== "function") {
      try { ctx.revealDir(abs); } catch (e) {} // 旧 host 兜底：左侧文件树 reveal
      return;
    }
    ctx.openFolder(dir, dir.split("/").pop() || abs.split("/").pop(), { select: true });
    if (isDir || !dir) return;
    const detail = { root: dir, target: abs };
    try {
      window.__piFolderRevealLast = { ...detail, ts: Date.now() };
      window.dispatchEvent(new CustomEvent("pi-web:folder-reveal", { detail }));
    } catch (e) {}
  }

  // features 启停（recognizer.*）——统一由 host 维护共享 store（manifest 已一次拉取）；
  // 此处实时读 ctx.getFeatures()，无独立请求/轮询；extman 改后 host patch store，下次读取即新值。
  function featureEnabled(fid) {
    const map = typeof ctx.getFeatures === "function" ? ctx.getFeatures() : {};
    return map[fid] !== false;
  }

  // ── 弹层卡片渲染（对齐剥离前 QuoteReplyPopover 的容器/按钮样式）──
  const cardStyle = {
    display: "flex", flexDirection: "column", gap: 3,
    marginTop: 4, width: "fit-content", maxWidth: "100%",
    background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8,
    padding: 4, boxShadow: "0 4px 14px rgba(0,0,0,0.14)",
  };
  const optionBtnBase = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "3px 9px", fontSize: 12,
    borderWidth: 1, borderStyle: "solid", borderColor: "var(--border)",
    borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap",
    maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis",
    transition: "background 0.12s, border-color 0.12s",
  };
  const actionBtnStyle = {
    display: "inline-flex", alignItems: "center", gap: 4,
    padding: "3px 9px", fontSize: 12,
    color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 10%, transparent)",
    borderWidth: 1, borderStyle: "solid", borderColor: "var(--border)",
    borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap",
    maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis",
  };

  // 锚点 rect：pre（代码/工具调用/结果行）→ 点击行矩形（计算样式实时取行高/内边距，
  //   各处 pre 字号规格不同也精确——与 core useCodeLineClick 同源算法）；
  //   其余（tr）→ 整块矩形。浮层 fixed 钉在锚点下方。
  function lineMetricsOf(el) {
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize) || 12;
    return { lineH: Math.max(1, parseFloat(cs.lineHeight) || Math.round(fs * 1.5)), padTop: parseFloat(cs.paddingTop) || 0 };
  }

  // 判断是否为「行级」可浮层锚点：tr / pre / edit 分栏 diff 格（core 标 data-diff-line）/
  // 思考块内容 div（core ThinkingBlock 标 data-thinking-content，v0.9.0 新思考 UI）
  function isLineEl(el) {
    return !!(el && (el.tagName === "TR" || el.tagName === "PRE" || (el.hasAttribute && (el.hasAttribute("data-diff-line") || el.hasAttribute("data-thinking-content")))));
  }

  // pre 点击行定位：pre-wrap 自动换行时，像素行号会与逻辑行号错位（长行占多视觉行）。
  // 用 caretRangeFromPoint 取点击处文本偏移 → 数 \n 得逻辑行号；失败兑底像素行号。
  // 返回 { row, offset }：offset 供 anchorRect 取该逻辑行真实视觉矩形（换行行也准）。
  function clickedLineInfo(pre, clientX, clientY) {
    const d = rcx.doc || document;
    const caretFn = d.caretRangeFromPoint
      ? (x, y) => { try { return d.caretRangeFromPoint(x, y); } catch (e) { return null; } }
      : (d.caretPositionFromPoint
        ? (x, y) => { try { const p = d.caretPositionFromPoint(x, y); return p ? p.getRange() : null; } catch (e) { return null; } }
        : null);
    if (caretFn) {
      const range = caretFn(clientX, clientY);
      if (range && range.startContainer) {
        const node = range.startContainer;
        const off = range.startOffset;
        if (node === pre || (pre.contains && pre.contains(node))) {
          const offset = charOffsetWithin(pre, node, off);
          if (offset >= 0) {
            const text = pre.textContent || "";
            let line = 0;
            for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
            return { row: line, offset };
          }
        }
      }
    }
    // 兑底：未换行的等宽 pre 仍准确（offset=-1 → anchorRect 走像素路径）
    const rect = pre.getBoundingClientRect();
    const { lineH, padTop } = lineMetricsOf(pre);
    return { row: Math.floor((clientY - rect.top - padTop) / lineH), offset: -1 };
  }

  // 把 (node, offset) 映射成 root 内的绝对字符偏移（跨多个文本节点累加）
  function charOffsetWithin(root, node, offset) {
    if (node === root) {
      let total = 0;
      const kids = root.childNodes;
      for (let i = 0; i < offset && i < kids.length; i++) total += (kids[i].textContent || "").length;
      return total;
    }
    if (node.nodeType !== 3) return -1; // 非文本节点（caret 落元素边界）→ 兑底
    let total = 0;
    const walker = (rcx.doc || document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      if (n === node) return total + offset;
      total += n.textContent.length;
      n = walker.nextNode();
    }
    return -1;
  }

  // 逻辑行（charOffset 所在行，行首→行尾）的视觉矩形：换行行占多视觉行 → union getClientRects
  function lineRectAtOffset(pre, charOffset) {
    const text = pre.textContent || "";
    if (!text || charOffset < 0) return pre.getBoundingClientRect();
    let lineStart = charOffset;
    while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== 10) lineStart--;
    let lineEnd = charOffset;
    while (lineEnd < text.length && text.charCodeAt(lineEnd) !== 10) lineEnd++;
    try {
      const { startNode, startOff, endNode, endOff } = nodeOffsetsFor(pre, lineStart, lineEnd);
      const range = (rcx.doc || document).createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      const rects = range.getClientRects();
      if (rects && rects.length) {
        let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
        for (const r of rects) {
          if (r.top < top) top = r.top;
          if (r.bottom > bottom) bottom = r.bottom;
          if (r.left < left) left = r.left;
          if (r.right > right) right = r.right;
        }
        if (top === Infinity) return pre.getBoundingClientRect();
        return { top, left, bottom, width: right - left, height: Math.max(1, bottom - top) };
      }
    } catch (e) {}
    return pre.getBoundingClientRect();
  }

  // 把 [start, end) 字符偏移映射成 (startNode, startOff, endNode, endOff)
  function nodeOffsetsFor(root, start, end) {
    const walker = (rcx.doc || document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    let cur = 0;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    while (n) {
      const nlen = n.textContent.length;
      if (startNode === null && cur + nlen > start) { startNode = n; startOff = start - cur; }
      if (cur + nlen >= end) { endNode = n; endOff = end - cur; break; }
      cur += nlen;
      n = walker.nextNode();
    }
    if (!startNode) { startNode = root; startOff = Math.min(start, root.childNodes.length); }
    if (!endNode) { endNode = root; endOff = Math.min(end, root.childNodes.length); }
    return { startNode, startOff, endNode, endOff };
  }

  // 锚点 rect：pre（优先用 caret 行矩形，兼容换行；否则像素行）/ data-diff-line（格矩形）/ tr（整块）/
  // data-thinking-content（同 pre 走 caret 行矩形——clickedLineInfo/lineRectAtOffset 只依赖 textContent 与几何，对纯文本 pre-wrap div 通用）
  function anchorRect(el, rowIndex) {
    if (el && el.__aitiClickedOffset != null && el.__aitiClickedOffset >= 0) {
      const r = lineRectAtOffset(el, el.__aitiClickedOffset);
      if (r) return r;
    }
    if (el && el.tagName === "PRE" && rowIndex != null) {
      const r = el.getBoundingClientRect();
      const { lineH, padTop } = lineMetricsOf(el);
      const y = r.top + padTop + rowIndex * lineH;
      return { top: y, left: r.left, bottom: y + lineH, width: r.width };
    }
    return el.getBoundingClientRect();
  }

  // ── 表格行（tr）/ 代码块行（pre）浮层状态：core 把 inline 节点 portal 到 body，扩展需自管定位——
  //    fixed 钉在锚点下方（scroll/resize 时跟随，对齐剥离前 core 的 floatPos 逻辑）。
  const floatState = { info: null, view: null };
  let floatListener = null;
  function removeFloatListener() {
    if (!floatListener) return;
    (rcx.win || window).removeEventListener("scroll", floatListener, true);
    (rcx.win || window).removeEventListener("resize", floatListener);
    floatListener = null;
  }
  function ensureFloatListener() {
    if (floatListener) return;
    const update = () => {
      if (!floatState.info || !floatState.view) return;
      const el = floatState.info.element;
      if (!el || !el.isConnected) return;
      const r = anchorRect(el, floatState.info.rowIndex);
      const top = r.bottom + 4;
      // 代码块行：滚动/缩放后行高亮重算（跟随行；卡片定位与高亮同锚）
      const v = floatState.view;
      if (isLineEl(el) && v.lineHighlight) {
        v.lineHighlight = { left: r.left, top: r.top, width: r.width, height: Math.max(1, r.bottom - r.top) };
      }
      // hover 子句高亮：滚动中鼠标未离开按钮（卡片 fixed 跟随），重算 rect 防脱锚
      if (v.hoverSeg) {
        v.hoverRects = findSegmentRects(el, v.hoverSeg);
      }
      // 滚动只挪卡片位置 + 重绘 overlay（不整卡重建——同 paintOverlay 注释的点击竞态）
      const cardEl = (rcx.doc || document).querySelector("[data-msg-smart-card]");
      if (cardEl && cardEl.style.position === "fixed") {
        placeFixedCard(cardEl, r, floatState.info);
      } else {
        const left = Math.max(8, Math.min(r.left, (rcx.win || window).innerWidth - 240));
        setInlineSafe(floatState.info, buildCardNode(floatState.info, floatState.view, { position: "fixed", top: r.bottom + 4, left, zIndex: 300 }));
      }
      paintOverlay(v);
    };
    floatListener = update;
    (rcx.win || window).addEventListener("scroll", update, true);
    (rcx.win || window).addEventListener("resize", update);
  }

  // 浮层卡片就位：先落锚点下方，再按实测尺寸做视口内钳制（放不下则翻到锚点上方）。
  // 仅 framed（info.doc 指向另一文档，如预览 iframe）启用——iframe 内没有父页那么大的余量，
  // 靠下/靠右的锚点不钳制会被预览区边界裁掉；聊天路径保持原行为不变。
  function placeFixedCard(cardEl, r, info) {
    const framed = !!(info && info.doc && info.doc !== document);
    const vw = (rcx.win || window).innerWidth;
    const vh = (rcx.win || window).innerHeight;
    let left = Math.max(8, Math.min(r.left, vw - 240));
    let top = r.bottom + 4;
    if (framed && cardEl) {
      const cw = cardEl.offsetWidth || 0;
      const ch = cardEl.offsetHeight || 0;
      if (cw) left = Math.max(8, Math.min(left, vw - 8 - cw));
      if (ch && top + ch > vh - 8) {
        const up = r.top - ch - 8;
        top = up >= 8 ? up : Math.max(8, vh - 8 - ch);
      }
    }
    cardEl.style.top = top + "px";
    cardEl.style.left = left + "px";
  }

  // ── 高亮 overlay 独立层：点击行持久高亮（lineHighlight）+ hover 子句高亮（hoverRects）。
  //    必须与卡片 DOM 解耦——hover 高亮若走整卡重渲染，innerHTML 重建会在鼠标悬停按钮瞬间
  //    替换按钮节点，真实点击 mousedown/mouseup 目标被偷换 → click 丢失（划选弹层 url 按钮
  //    点不动的根因，2026-09 CDP 真实输入实测：hover 成功后 click 报 "Element no longer
  //    exists"；对照无 onMouseEnter 的复制按钮 hover+click 全通）。层 fixed 全屏 +
  //    pointer-events none，不挡卡片/页面交互；随弹层 view.close 一并移除。
  const overlayState = { layer: null };
  function ensureOverlayLayer() {
    if (!overlayState.layer || !overlayState.layer.isConnected) {
      const l = (rcx.doc || document).createElement("div");
      l.style.position = "fixed";
      l.style.left = "0"; l.style.top = "0"; l.style.right = "0"; l.style.bottom = "0";
      l.style.pointerEvents = "none";
      l.style.zIndex = "310";
      (rcx.doc || document).body.appendChild(l);
      overlayState.layer = l;
    }
    return overlayState.layer;
  }
  function paintOverlay(view) {
    if (!view || view.closed) return;
    const layer = ensureOverlayLayer();
    const rects = [...(view.lineHighlight ? [view.lineHighlight] : []), ...(view.hoverRects || [])];
    layer.innerHTML = "";
    for (const r of rects) {
      const s = (rcx.doc || document).createElement("span");
      s.style.cssText = "position:fixed;pointer-events:none;z-index:310;outline:2px solid var(--accent);background:color-mix(in srgb, var(--accent) 15%, transparent);border-radius:3px;box-shadow:0 0 0 1px rgba(0,0,0,0.06)";
      s.style.left = r.left + "px"; s.style.top = r.top + "px";
      s.style.width = r.width + "px"; s.style.height = r.height + "px";
      layer.appendChild(s);
    }
  }
  function clearOverlayLayer() {
    if (overlayState.layer) { overlayState.layer.remove(); overlayState.layer = null; }
  }

  // 卡片内容（不含定位包装）；overlayStyle 为 null 时 in-flow 渲染
  function buildCardNode(info, view, overlayStyle) {
    const nodes = [];

    // ── 顶部固定：复制全文 + 引用全文 + 新会话引用（三按钮统一——点击段落/行/划选场景一致，
    //    永远最前，异步识别到达重渲染时位置不跳动）；代码块行 → 复制/引用该行；
    //    「新会话」把 fullText 以 `> ` 逐行引用投到新建会话 composer
    //    （通道收口 _shared/openNewSession，见 docs/pi-web-at-new-session-cwd-plan.md §4.5）
    nodes.push(h("span", { key: "top-actions", style: { display: "flex", flexWrap: "wrap", gap: 4 } },
      h("button", {
        key: "copy-full", type: "button", title: view.isThought ? "复制该行思考" : view.isCode ? "复制该行代码" : view.isSelection ? "复制选中片段" : "复制整段文本", style: actionBtnStyle,
        onClick: (e) => { e.stopPropagation(); try { navigator.clipboard.writeText(view.fullText); } catch (err) {} view.close(); },
      }, "复制"),
      h("button", {
        key: "quote-full", type: "button", title: view.isThought ? "把该行思考引用到输入框" : view.isCode ? "把该行引用到输入框" : view.isSelection ? "把选中片段引用到当前会话输入框" : "把整段引用到输入框", style: actionBtnStyle,
        onClick: (e) => { e.stopPropagation(); view.onPick(formatQuote(view.fullText)); },
      }, "引用"),
      view.onNewSession && h("button", {
        key: "quote-new-session", type: "button", title: "把该内容引用到新建会话的输入框（15 秒内有效）", style: actionBtnStyle,
        onClick: (e) => { e.stopPropagation(); view.onNewSession(formatQuote(view.fullText)); },
      }, "新会话"),
    ));

    // ── question 区（紧跟复制/引用）：每段一行（选项或引用单句摘要）
    // 单段且无选项：引用单句 = 引用全文（顶部已有），跳过避免重复按钮
    for (let i = 0; i < view.segments.length; i++) {
      const seg = view.segments[i];
      if (view.segments.length === 1 && seg.options == null) continue;
      nodes.push(h(SegmentRow, { key: "seg" + i, segment: seg, onPick: view.onPick, T, view }));
    }

    // ── file 区（校验通过才显示；打开 + 定位两按钮）
    if (view.paths.length) {
      nodes.push(h("span", { key: "files", style: { display: "flex", flexWrap: "wrap", gap: 4 } },
        ...view.paths.map(({ path: abs, isDir }) =>
          h("span", { key: abs, style: { display: "inline-flex", flexWrap: "wrap", gap: 4 } },
            !isDir && h("button", {
              key: "open", type: "button",
              onClick: (e) => { e.stopPropagation(); ctx.openFile(abs, abs.split("/").pop() ?? abs); view.close(); },
              title: T.openFile, style: actionBtnStyle,
            }, h(FolderOpenIcon), `${T.openFile}: ${abs.split("/").pop()}`),
            h("button", {
              key: "reveal", type: "button",
              // 定位 → 右侧打开文件浏览器（FolderViewer）并选中本文件（旧版只 revealDir 左侧树：
              // 树以 cwd 为根、cwd 自身无节点，文件在 cwd 根时高亮落空）。
              // label 用文件名而非目录名——同目录多文件时按钮不再长得一样。
              onClick: (e) => {
                e.stopPropagation();
                openFolderReveal(abs, isDir);
                view.close();
              },
              title: isDir ? T.openFolder : `${T.revealDir}: ${abs}`, style: actionBtnStyle,
            }, h(FolderIcon), isDir
              ? `${T.openFolder}: ${abs.split("/").pop()}`
              : `${T.revealDir}: ${abs.split("/").pop()}`),
          ),
        ),
      ));
    }

    // ── provider 区（外部 msg-popover-action：command 等）
    const actionBtns = [...view.providerActions, ...view.extraActions];
    if (actionBtns.length) {
      nodes.push(h("span", { key: "providers", style: { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" } },
        ...actionBtns.map((a) =>
          h("button", {
            key: a.id, type: "button",
            onClick: (e) => { e.stopPropagation(); a.onClick(view.fullText, info.cwd); view.close(); },
            title: a.title,
            // hover 高亮：优先 provider 给的精确匹配文本（match），无则退回 label（截断时可能匹配不到，自然降级不高亮）
            onMouseEnter: (e) => { if (view && view.element) highlightSegment(view, a.match || a.label); },
            onMouseLeave: () => { if (view) clearHighlight(view); },
            style: { ...actionBtnStyle, color: a.danger ? "#ef4444" : a.unavailable ? "var(--text-muted)" : "var(--accent)", borderColor: a.danger ? "#fca5a5" : a.unavailable ? "var(--border)" : undefined, opacity: a.unavailable ? 0.75 : undefined },
          }, typeIcon(a.type), a.unavailable ? " ❌" : null, a.danger ? " ⚠" : null, " " + a.label),
        ),
      ));
    }

    // 关闭按钮（✕）——弹层右上角，沿用剥离前 UI 习惯
    // data-msg-smart-card：外部点击关闭判定标记；hover 卡片暂停自动消失计时
    const card = h("span", {
      "data-msg-smart-card": "1",
      style: { ...cardStyle, ...(overlayStyle || {}) },
      onMouseDown: (e) => e.preventDefault(),
      onClick: (e) => e.stopPropagation(),
      onMouseEnter: () => { if (view.onCardEnter) view.onCardEnter(); },
      onMouseLeave: () => { if (view.onCardLeave) view.onCardLeave(); },
    }, ...nodes);
    // 高亮 overlay 已拆独立层（见 paintOverlay 注释）——卡片只含自身，hover/滚动不再重建整卡
    return card;
  }

  // 当前卡片重渲染引用（click handler 设置；hover 高亮异步触发用）
  let currentRender = null;

  // ── hover 子句高亮：在原文段落 DOM 里定位子句文本 → 矩形 overlay 圈选（不动原文 DOM）──
  function findSegmentRects(el, segText) {
    if (!el || !segText) return [];
    const full = el.textContent || "";
    let idx = full.indexOf(segText);
    let len = segText.length;
    if (idx < 0) { const st = segText.trim(); idx = full.indexOf(st); if (idx < 0) return []; len = st.length; }
    const end = idx + len;
    const walker = (rcx.doc || document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let cur = 0;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    while (node) {
      const nlen = node.textContent.length;
      if (startNode === null && cur + nlen > idx) { startNode = node; startOff = idx - cur; }
      if (cur + nlen >= end) { endNode = node; endOff = end - cur; break; }
      cur += nlen;
      node = walker.nextNode();
    }
    if (!startNode || !endNode) return [];
    try {
      const range = (rcx.doc || document).createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      return Array.from(range.getClientRects());
    } catch { return []; }
  }
  function highlightSegment(view, segText) {
    if (view.closed) return; // 弹层已关闭——不再重渲染复活旧卡片
    view.hoverSeg = segText; // 记录当前 hover 段（滚动重算 rect 用，防脱锚）
    view.hoverRects = findSegmentRects(view.element, segText);
    paintOverlay(view); // 只重绘 overlay 层——整卡重建会偷换正在悬停的按钮节点（见 paintOverlay 注释）
  }
  function clearHighlight(view) {
    if (view.closed) return;
    if (!(view.hoverRects && view.hoverRects.length) && !view.hoverSeg) return;
    view.hoverRects = [];
    view.hoverSeg = null;
    paintOverlay(view);
  }

  // 渲染完整弹层卡片：tr（表格行）/ pre（代码块行）→ fixed 钉在行下方并跟随滚动；p/li → in-flow sibling
  function renderCard(info, view) {
    // info.float：非行级元素也走 fixed 浮层（aiti-editor 预览 iframe 的 setInline 是 body 追加层，
    // in-flow 插入会掉到文档底部）。缺省 false → 聊天 p/li 仍走原 in-flow 兄弟插入。
    const isFloat = isLineEl(info.element) || !!info.float;
    if (isFloat) {
      floatState.info = info;
      floatState.view = view;
      ensureFloatListener();
      const el = info.element;
      const r = anchorRect(el, info.rowIndex);
      const left = Math.max(8, Math.min(r.left, (rcx.win || window).innerWidth - 240));
      // 代码块行/diff 格：点击行持久高亮（复用 overlay 圈选，hover 子句时叠加不互斥）
      if (isLineEl(el)) {
        view.lineHighlight = { left: r.left, top: r.top, width: r.width, height: Math.max(1, r.bottom - r.top) };
      }
      setInlineSafe(info, buildCardNode(info, view, { position: "fixed", top: r.bottom + 4, left, zIndex: 300 }));
      // 挂载后按实测尺寸二次就位（framed 模式钳进 iframe 视口，见 placeFixedCard）
      const cardEl = (rcx.doc || document).querySelector("[data-msg-smart-card]");
      if (cardEl) placeFixedCard(cardEl, r, info);
      paintOverlay(view);
      return;
    }
    setInlineSafe(info, buildCardNode(info, view, null));
    paintOverlay(view);
  }

  function SegmentRow({ segment, onPick, T: TT, view }) {
    // 有选项段 = 选项按钮（引用该段 + 预填）；无选项段 = 「引用单句：摘要」（引用该段本身）
    const options = segment.options ?? [{ label: `${TT.quoteLine}：${summarizeSegment(segment.text)}`, value: "" }];
    // hover 按钮 → 原文高亮圈出对应子句（仅无选项段有意义；选项段 hover 同样高亮段文本）
    const onEnter = (e) => {
      e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
      if (view && view.element) highlightSegment(view, segment.text);
    };
    const onLeave = (e) => {
      e.currentTarget.style.borderColor = "var(--border)";
      if (view) clearHighlight(view);
    };
    return h("span", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
      ...options.map((opt, j) =>
        h("button", {
          key: j, type: "button",
          onClick: (e) => { e.stopPropagation(); onPick(formatQuote(segment.text, opt.value || undefined)); },
          title: segment.text.slice(0, 60),
          style: {
            ...optionBtnBase,
            color: opt.value ? "var(--accent)" : "var(--text-muted)",
            background: opt.value ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "var(--bg-hover)",
          },
          onMouseEnter: onEnter,
          onMouseLeave: onLeave,
        }, opt.label),
      ),
    );
  }

  function setInlineSafe(info, node) {
    try { info.setInline(node); } catch (e) {}
  }

  // 关闭时清浮层引用（tr/pre 卡片）：scroll/resize 监听不再更新已关闭卡片
  function clearFloat() {
    floatState.info = null;
    floatState.view = null;
    removeFloatListener();
  }

  const UNITLESS_STYLE = new Set(["opacity", "zIndex", "flex", "flexGrow", "flexShrink", "order", "lineHeight", "fontWeight", "zoom", "scale", "aspectRatio"]);
  // ── 迷你 React 元素 → DOM（委托场景无 react-dom：buildCardNode 产出的元素树
  //    （{type, props, children}）用 DOM API 重建挂到 body，复用整套卡片/浮层/高亮逻辑）
  function elToDom(node) {
    if (node == null || node === false || node === true) return null;
    const doc = rcx.doc || document;
    if (typeof node === "string" || typeof node === "number") return doc.createTextNode(String(node));
    if (Array.isArray(node)) {
      const frag = doc.createDocumentFragment();
      for (const n of node) { const d = elToDom(n); if (d) frag.appendChild(d); }
      return frag;
    }
    const el = doc.createElement(node.type);
    const props = node.props || {};
    for (const k of Object.keys(props)) {
      if (k === "children" || k === "key") continue;
      const v = props[k];
      if (v == null) continue;
      if (k === "style" && typeof v === "object") {
        for (const sk of Object.keys(v)) {
          let sv = v[sk];
          // React style 数字自动补 px（unitless 属性除外）——DOM 直接赋值需手动补
          if (typeof sv === "number" && !UNITLESS_STYLE.has(sk)) sv = sv + "px";
          try { el.style[sk] = sv; } catch {}
        }
      }
      else if (k === "className") el.className = String(v);
      else if (k.startsWith("on") && typeof v === "function") {
        const ev = k.slice(2).toLowerCase();
        el.addEventListener(ev, v); // 原生事件（stopPropagation/currentTarget 与 React 合成兼容）
      }
      else if (v !== false) { try { el.setAttribute(k, String(v)); } catch {} }
    }
    const kids = props.children;
    const kd = elToDom(kids);
    if (kd) el.appendChild(kd);
    return el;
  }
  // pre 行点击委托层（扩展全权：无 core 行点击挂载）——弹层复用 buildCardNode + elToDom
  let lineClickSeq = 0;
  let paragraphHandler = null;
  // ── 划选互斥守卫：存在非折叠选区 → 本轮是「划选」而非「点击」，点击路径（段落/pre/diff）让行；
  //    选区折叠才是纯点击（todo-upstream T1：有选区 → 选中路径；选区折叠 → 点击路径）
  // winOverride：顶层委托监听（聊天路径）显式传 window——rcx 可能被上一次 framed 弹层
  // 指向 iframe，不能拿 iframe 的选区判断顶层点击。
  function selectionNonCollapsed(winOverride) {
    try {
      const win = winOverride || rcx.win || window;
      const sel = win.getSelection();
      return !!(sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().trim());
    } catch (e) { return false; }
  }

  try {
    document.addEventListener("click", (e) => {
      if (selectionNonCollapsed(window)) return; // 划选结束后的 click 不误触弹层
      // target 可能是文本节点（纯文本 pre 如工具参数/结果）——textNode 无 closest，先取父元素
      let t = e.target;
      if (t && t.nodeType === 3) t = t.parentElement;

      // ── edit 分栏 diff 格（core SplitDiffCellView 根 div 标 data-diff-line）──
      // 每格 = 一行代码（左=旧 / 右=新），点击引用/复制该格文本（行为同 pre 行）
      const diffCell = t && t.closest && t.closest("[data-diff-line]");
      if (diffCell) {
        if (!diffCell.closest("[data-chat-msg-role]")) return; // 只管消息区内的 diff 行（扩展面板同属性元素不劫持）
        if (diffCell.closest(".markdown-user-message")) return;
        const contentEl = diffCell.querySelector("span:last-of-type") || diffCell;
        const lineText = (contentEl.textContent || diffCell.textContent || "").replace(/^\u00a0$/, "").trim();
        if (!lineText || !paragraphHandler) return;
        e.stopPropagation();
        diffCell.__aitiLineId = diffCell.__aitiLineId ?? (++lineClickSeq);
        const r = diffCell.getBoundingClientRect();
        let layer = null;
        const info = {
          text: lineText,
          cwd: undefined,
          rect: { top: r.top, left: r.left, bottom: r.bottom, width: r.width },
          element: diffCell,
          rowIndex: null,
          paragraphId: `diff:${diffCell.__aitiLineId}`,
        setInline: (node) => {
          const d = rcx.doc || document;
          if (!layer) { layer = d.createElement("div"); d.body.appendChild(layer); }
          layer.innerHTML = "";
          const dom = elToDom(node);
          if (dom) layer.appendChild(dom);
        },
        close: () => { if (layer) { layer.remove(); layer = null; } },
      };
      paragraphHandler(info);
      return;
    }

      // ── pre 行点击（工具参数/结果/代码块）+ 思考块行点击 ──
      // 思考块：core ThinkingBlock 内容 div 标 data-thinking-content（v0.9.0 新思考 UI 不走
      // MarkdownBody，core 段落广播覆盖不到）→ 同一委托兑底，行为对齐 pre 行点击
      const lineHost = (t && t.closest && (t.closest("pre") || t.closest("[data-thinking-content]"))) || null;
      if (!lineHost) return;
      if (!lineHost.closest("[data-chat-msg-role]")) return; // 只管消息区内的代码块/思考块：扩展面板里的 pre 不劫持（stopPropagation 会吞宿主点击）
      if (lineHost.closest(".markdown-user-message")) return; // user 消息 pre 不弹层（同段落策略）
      const lines = (lineHost.textContent || "").split("\n");
      // 行号用 caret 定位：pre-wrap + break-all 下长行自动换行，像素行号会与逻辑行错位
      const { row, offset } = clickedLineInfo(lineHost, e.clientX, e.clientY);
      if (row < 0 || row >= lines.length) return;
      const lineText = lines[row].trim();
      if (!lineText) return;
      if (!paragraphHandler) return;
      e.stopPropagation(); // 阻止冒泡到段落点击（li 内 pre）
      lineHost.__aitiLineId = lineHost.__aitiLineId ?? (++lineClickSeq);
      lineHost.__aitiClickedOffset = offset; // anchorRect 据此取该逻辑行真实视觉矩形（换行行也准）
      const rect = lineHost.getBoundingClientRect();
      let layer = lineHost.__aitiLayer;
      const info = {
        text: lineText,
        cwd: undefined,
        rect: { top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width },
        element: lineHost,
        rowIndex: row,
        paragraphId: `${lineHost.tagName === "PRE" ? "code" : "think"}:${lineHost.__aitiLineId}:${row}`,
        setInline: (node) => {
          const d = rcx.doc || document;
          if (!layer) { layer = lineHost.__aitiLayer = d.createElement("div"); d.body.appendChild(layer); }
          layer.innerHTML = "";
          const dom = elToDom(node);
          if (dom) layer.appendChild(dom);
        },
        close: () => {
          if (lineHost.__aitiLayer) { lineHost.__aitiLayer.remove(); lineHost.__aitiLayer = null; }
        },
      };
      paragraphHandler(info);
    }, true);
    // pre 可点击视觉契约（core 无 cursor 挂载，扩展注入）；弹层卡片容器点击穿透：
    //    fixed 卡片悬浮会遮挡锚点行下方 1-2 行（实测反馈「有的行可以点有的行不行」）——
    //    容器 pointer-events:none 仅按钮可点，点被遮挡的行能穿透触发切段开新弹层
    const styleEl = document.createElement("style");
    styleEl.textContent = "pre { cursor: pointer; } [data-diff-line] { cursor: pointer; } [data-thinking-content] { cursor: pointer; } [data-msg-smart-card] { pointer-events: none; } [data-msg-smart-card] button { pointer-events: auto; }";
    document.head.appendChild(styleEl);
  } catch (e) {}

  // 段落点击 handler：同步部分（question/summary）立即渲染，异步部分（file 校验 / provider 识别）到达后重渲染
  if (typeof ctx.registerParagraphClick === "function") {
    // hint：段落 hover 提示文案（core tip 视觉契约的文案来源——原「点击引用回复」）
    const ph = (info) => {
      setRcx(info); // 渲染上下文：info.doc/win 缺省顶层（聊天零变化）
      const { paragraphId, close, text, cwd, messageRole } = info;
      // 能力裁剪（aiti-editor 预览等外部容器用 caps 关掉不适用的识别器；缺失回落 feature 开关）
      const capsOf = (key) => {
        const c = info && info.caps;
        return c && typeof c[key] === "boolean" ? c[key] : featureEnabled("recognizer." + key);
      };
      // 引用装饰（外部容器给引用文本加前缀，如 aiti-editor 的 @<file>#Lx-Ly 源码定位）
      const deco = (s) => (typeof info.decorateQuote === "function" ? info.decorateQuote(s) : s);
      // 划选收尾的 click 不开段落弹层（划选自身 info 走 isSelection 标记放行）；
      // 选区折叠后点击才走这里
      if (selectionNonCollapsed() && !info.isSelection) return;
      // user 消息段落不做识别弹层（core 已不广播；此处兑底防御）——只留固定引用按钮
      if (messageRole === "user") return;
      // 同段再点 = 关闭（toggle）
      if (state.opening && state.opening.pid === paragraphId) {
        state.opening.close();
        state.opening = null;
        clearFloat();
        return;
      }
      // 切段：先关旧段（同一时刻只开一个由本扩展自管）
      if (state.opening) {
        try { state.opening.close(); } catch (e) {}
        state.opening = null;
        clearFloat();
      }
      // 与 inline code 弹层互斥：开段落弹层前先关 code 弹层
      if (inlineCodeState.opening) {
        try { inlineCodeState.opening.close?.(); } catch (e) {}
        inlineCodeState.opening = null;
      }
      // 与划选弹层互斥：开段落弹层前先关选中弹层（同时只开一个；划选自身 info 不关——
      // openSelectionCard 已在其入口关过旧弹层，此处再关会误杀刚建的 layer/range）
      if (!info.isSelection) closeSelectionCard();

      const fullText = text;
      // 「新会话」引用：`> ` 逐行投递到新建会话 composer——通道收口 _shared/openNewSession
      // （pendingComposer 预填 + pi-web:new-session 一步到位；15s 时效/光标在末尾由 core 消费端把关）。
      // 三场景统一（段落点击/行点击/划选）；消息引用无目标目录 → targetDir 空即跳过 CWD 判定
      // （恒保持当前）；cwd 优先 info.cwd（core 广播），缺省 __piWebCwd。
      const onNewSession = (quote) => {
        const cwd2 = cwd || (typeof window !== "undefined" && window.__piWebCwd) || undefined;
        try {
          openNewSession({
            text: deco(quote),
            targetDir: cwd2 || "", // 无目标目录 → resolve 恒返回当前 cwd（零 fetch）
            currentCwd: cwd2,
            apiUrl: (p) => (typeof ctx.apiUrl === "function" ? ctx.apiUrl(p) : p),
          }).catch(() => {});
        } catch (e) {}
        view.close();
      };
      // 引用动作：预填输入框后关闭弹层（按钮区无保留意义）；view 闭包延迟求值（调用时已定义）
      const onPick = (quote) => {
        try { ctx.appendText(deco(quote)); } catch (e) {}
        if (view) view.close();
      };
      const segments = capsOf("question") ? parseParagraph(text) : [];
      // 全空（无任何可渲染内容 + 无外部 provider）→ 关闭
      const view = {
        fullText, onPick, onNewSession, segments,
        paths: [], providerActions: [], extraActions: [], providerPending: 0,
        isCode: !!isLineEl(info.element),
        isThought: !!(info.element && info.element.hasAttribute && info.element.hasAttribute("data-thinking-content")),
        isSelection: !!info.isSelection,
        element: info.element,
        hoverRects: [],
        hoverSeg: null,
        lineHighlight: null,
        closed: false,
        onCardEnter: null, onCardLeave: null,
        // 关闭弹层：清 opening（防 toggle 残留）+ 浮层监听 + 自动消失定时器 + 外部点击监听 + inline 挂载
        close: () => {
          view.closed = true;
          clearDismiss();
          detachOutsideClose();
          if (state.opening && state.opening.pid === paragraphId) state.opening = null;
          clearFloat();
          clearOverlayLayer();
          try { close(); } catch (e) {}
        },
      };

      // ── 自动消失 + 点击外部关闭 ──
      const DISMISS_MS = 10000;
      let dismissTimer = null;
      let outsideHandler = null;
      const clearDismiss = () => { if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; } };
      const armDismiss = () => {
        clearDismiss();
        dismissTimer = setTimeout(() => {
          // 触发瞬间鼠标仍悬停在卡片/按钮上（含卡片重渲染后场景）→ 顺延计时不消失
          if ((rcx.doc || document).querySelector("[data-msg-smart-card]:hover")) { armDismiss(); return; }
          try { view.close(); } catch (e) {}
        }, DISMISS_MS);
      };
      const detachOutsideClose = () => {
        if (outsideHandler) { (rcx.doc || document).removeEventListener("click", outsideHandler, true); outsideHandler = null; }
      };
      view.onCardEnter = clearDismiss; // hover 卡片期间暂停计时
      view.onCardLeave = () => { if (!view.closed) armDismiss(); }; // 离开后重新计时
      // 点弹层与锚点段落以外的区域 → 关闭（段落间切换/toggle 由上方 ph 主逻辑统一处理，这里不抢）
      outsideHandler = (e2) => {
        let t2 = e2.target;
        if (t2 && t2.nodeType === 3) t2 = t2.parentElement;
        if (t2 && t2.closest && t2.closest("[data-msg-smart-card]")) return;
        if (t2 && t2.closest && t2.closest("p,li,tr,h1,h2,h3,h4,h5,h6,pre,[data-thinking-content]")) return;
        try { view.close(); } catch (e) {}
      };
      (rcx.doc || document).addEventListener("click", outsideHandler, true);

      const render = () => renderCard(info, view);
      currentRender = render;

      // file 校验（异步）：相对路径拼 cwd，走 POST /api/files/get 的 probe 模式存在性探测。
      //   probe 命中返回 {exists:true, isDir}（目录/文件一次判明，替代旧 meta/list 双试）；
      //   未命中返回 200 {exists:false}——不产生 4xx（浏览器 console 无噪音），只显示存在的文件按钮。
      //   ~/ 前缀保留交给服务端展开（core /api/files 支持）；./ 剥掉拼 cwd。
      //   主 cwd 未命中 → 跨仓分辨（aiti-git-trace services.trace 服务出口协作）：
      //   AI 把文件写到 cwd 外的仓（如 ~/workspace/pi-web）但消息里只说 docs/x.md 时，
      //   用会话识别仓/workspace 关注路径作为补充分辨基逐根重试。惰性单飞：同一次点击
      //   最多发一次 resolve-roots；未装/禁用 aiti-git-trace → 空数组静默降级（行为与无跨仓分辨一致）。
      if (capsOf("file")) {
        const all = extractFilePaths(text).slice(0, 3);
        if (all.length) {
          // cwd 兜底：段落广播可能不带 cwd（pre/diff 行点击）——落到全局 __piWebCwd
          // （与 onNewSession/划选路径同源），保证相对路径拼接与自引用消歧在行点击场景也可用
          const resCwd = cwd || (typeof window !== "undefined" && window.__piWebCwd) || undefined;
          const absOf = (p) => {
            let q = p;
            if (q.startsWith("./")) q = q.slice(2);
            if (/^[\/\\]/.test(q)) return q;
            // Windows 盘符/UNC 绝对路径原样交服务端（core paths.ts isWindowsAbsolutePath 认 D:/ D:\ \\ //）；
            // 否则会被当相对路径再拼一遍 cwd（“cwd/C:/workspace/…”）探测必 404
            if (/^[A-Za-z]:[\/\\]/.test(q) || q.startsWith("\\\\")) return q;
            if (q.startsWith("~/")) return q; // ~ 由服务端展开（浏览器无 homedir）
            return resCwd ? resCwd.replace(/\/+$/, "") + "/" + q : q;
          };
          const tryType = async (abs) => {
            try {
              // apiUrl 补 basePath——裸 /api/files 在 /dev 等非根 basePath 部署下 404（识别静默失效）
              // 路径走 body，不进 URL；probe=true 未命中返回 200 {exists:false}（无 4xx console 噪音）
              const url = (typeof ctx.apiUrl === "function" ? ctx.apiUrl("/api/files/get") : "/api/files/get");
              const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: abs, type: "meta", probe: true }), cache: "no-store" });
              if (!res.ok) return null;
              const d = await res.json().catch(() => null);
              if (!d || d.exists !== true) return null;
              return { path: abs, isDir: d.isDir === true };
            } catch { return null; }
          };
          let extRootsPromise = null;
          const extRoots = () => {
            if (!extRootsPromise) {
              extRootsPromise = (async () => {
                if (!resCwd || !capsOf("fileExternalRoots")) return [];
                try {
                  // 走本扩展 server api（进程内消费 aiti-git-trace services.trace 出口；
                  // docs/aiti-plan-first-plan.md §3 模式）——客户端不直连兄弟扩展 HTTP
                  const url = (typeof ctx.apiUrl === "function" ? ctx.apiUrl("/api/extensions/aiti-msg-smart/resolve-roots") : "/api/extensions/aiti-msg-smart/resolve-roots");
                  const res = await fetch(url, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ cwd: resCwd, session: info.sessionId || undefined }),
                  });
                  if (!res.ok) return [];
                  const d = await res.json();
                  return mergeExternalRoots(resCwd, d && d.stores, d && d.watchPaths);
                } catch { return []; }
              })();
            }
            return extRootsPromise;
          };
          Promise.all(all.map(async (p) => {
            const direct = await tryType(absOf(p.path));
            if (direct) return direct;
            const roots = await extRoots();
            const candidates = [
              // 1) 外部根拼接（绝对/~ 路径 candidatesFromRoots 返回空，天然跳过）
              ...candidatesFromRoots(p.path, roots),
              // 2) 「自带名字」自引用消歧：路径首段 = 分辨基末段名（cwd 名/外部根名）→
              //    按基的父目录 + 完整 rel 解析——会话在 aiti-ai 里却说 aiti-ai/docs/x.md，
              //    或处理 cwd 外仓时按兄弟仓名引用 pi-web/docs/x.md。主 cwd 与每个外部根都试。
              ...(resCwd ? selfNameCandidates(p.path, resCwd) : []),
              ...roots.flatMap((r) => selfNameCandidates(p.path, r)),
            ];
            // 去重保序（cwd 父目录在 roots 时与外部根拼接结果可能重复，避免重复探测）
            for (const cand of [...new Set(candidates)]) {
              const hit = await tryType(cand);
              if (hit) return hit;
            }
            return null;
          })).then((found) => {
            if (view.closed) return; // 弹层已关闭/切换——晚到的异步结果不再复活旧卡片
            // 按解析后的 abs 去重：同一文件的两种写法（docs/x.md 与自引用 aiti-ai/docs/x.md、
            // 跨仓分辨撞同一目标）会解析到同一路径，不去重则出两组按钮 + React key 重复
            const uniq = [];
            for (const f of found) {
              if (f && !uniq.some((u) => u.path === f.path)) uniq.push(f);
            }
            view.paths = uniq;
            render();
          });
        }
      }
            // ── url（新窗口打开）——同步识别
      if (capsOf("url")) {
        for (const url of extractUrls(text).slice(0, 2)) {
          view.extraActions.push({
            id: "url:" + url, type: "url", label: url.length > 40 ? url.slice(0, 40) + "…" : url,
            title: "新窗口打开链接",
            onClick: () => { try { window.open(url, "_blank", "noopener"); } catch (e) {} },
          });
        }
      }

      // 外部 provider 识别（异步）
      let external = [];
      if (capsOf("providers")) {
        try { external = ctx.getTopicItems ? ctx.getTopicItems("msg-popover-action") : []; } catch (e) {}
      }
      for (const p of external) {
        try {
          const r = p.recognize ? p.recognize(text, { cwd, messageRole, element: info.element }) : null;
          if (r && typeof r.then === "function") {
            view.providerPending++;
            r.then((list) => {
              view.providerPending--;
              if (view.closed) return; // 弹层已关闭/切换——晚到的识别结果不复活旧卡片
              if (Array.isArray(list) && list.length) view.providerActions.push(...list);
              render();
            }).catch(() => { view.providerPending--; });
          } else if (Array.isArray(r) && r.length) {
            view.providerActions.push(...r);
          }
        } catch (e) { /* 单 provider 异常不影响其他 */ }
      }

      state.opening = { pid: paragraphId, close: () => view.close() }; // 走 view.close 保证定时器/外部监听一并清理
      render();
      armDismiss(); // 启动自动消失计时（hover 卡片暂停，动作后 close 自清）
    };
    ph.hint = T.quoteReply;
    // 声明可点击语义块：段落/列表/表格行 + 标题（h1-h6）——core 按声明包装，无需改 core
    ph.tags = ["p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"];
    ctx.registerParagraphClick(ph);
    paragraphHandler = ph; // 委托层复用同一 handler（pre 行点击 → 弹层/高亮/定位全复用）

    // ── 跨扩展出口：本弹层引擎对外部容器开放（aiti-editor markdown 预览等）──
    // 调用方自带 info：{ text, element, doc, win, setInline, close, paragraphId, ... }；
    // doc/win 指向自己的文档时弹层渲染进该文档（坐标/滚动/层叠自洽），缺省顶层。
    // 可选：float（非行级也浮层）/ decorateQuote（引用加前缀）/ caps（能力裁剪）。
    try {
      ctx.registerExtService?.("aiti-msg-smart.popover", {
        version: 1,
        open: (info) => { if (info) ph(info); },
        // 迷你 React 元素树 → DOM（供外部容器的 setInline 使用；按 rcx.doc 创建节点）
        toDom: (node) => elToDom(node),
        close: () => {
          if (state.opening) { try { state.opening.close(); } catch (e) {} state.opening = null; }
          clearFloat();
        },
      });
    } catch (e) {}
  }

  // ── 划选识别（上游 #698 选中分支对话的扩展侧实现，todo-upstream T1）：
  //    消息区 pointerup + 非折叠选区 → 选中片段弹层（复制/引用回复/新会话引用），
  //    与段落点击路径互斥（守卫见上）；纯点击不受影响。
  //    「新会话引用」投递：收口 _shared/openNewSession（pendingComposer + pi-web:new-session
  //    一步到位；core ChatInput 消费 15s 时效防陈文、光标落在末尾）——本扩展不再手写通道。
  const selectionState = { layer: null, range: null, pid: null, scrollHandler: null };
  function closeSelectionCard() {
    if (selectionState.scrollHandler) { window.removeEventListener("scroll", selectionState.scrollHandler, true); window.removeEventListener("resize", selectionState.scrollHandler); selectionState.scrollHandler = null; }
    if (selectionState.layer) { selectionState.layer.remove(); selectionState.layer = null; }
    selectionState.range = null;
    selectionState.pid = null;
  }
  function positionSelectionCard() {
    const { layer, range } = selectionState;
    if (!layer || !range) return;
    let rect;
    try { rect = range.getBoundingClientRect(); } catch (e) { closeSelectionCard(); return; }
    // 选区所在 DOM 已被卸载（virtualized 滚动回收等）→ rect 塔化，直接收摊
    if (!rect || (!rect.width && !rect.height)) { closeSelectionCard(); return; }
    const vw = window.innerWidth;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - 130, vw - 268));
    let top = rect.bottom + 8;
    if (top > window.innerHeight - 130) top = Math.max(8, rect.top - 118); // 底部放不下 → 选区上方
    layer.style.top = `${top}px`;
    layer.style.left = `${left}px`;
  }
  // 划选弹层 = 构造 ph 兼容 info 走段落点击全流程（统一功能：question/file/url/provider
  // 识别全套 + 复制/引用/新会话三按钮 + 统一自动消失/点外关闭/切段互斥/hover 高亮）——
  // 仅三处差异由 info 承载：
  //  - isSelection：ph 入口守卫放行（划选本身有选区）+ 按钮 title 场景化；
  //  - setInline：自管 fixed layer 钉选区下方（renderCard 判非行级元素走 in-flow
  //    setInline 正好落在这里；滚动跟随由 scrollHandler → positionSelectionCard）；
  //  - close：closeSelectionCard（layer 生命周期随弹层，ph 的 view.close 统一触发）。
  function openSelectionCard(text, range, msgEl) {
    setRcx(null); // 划选弹层恒在顶层文档（rcx 可能指向上一次 framed 弹层的 iframe）
    // 弹层同时只开一个：先关现有三类弹层（段落/pre/行内 code/旧选中）
    if (state.opening) { try { state.opening.close(); } catch (e) {} state.opening = null; clearFloat(); }
    if (inlineCodeState.opening) { try { inlineCodeState.opening.close?.(); } catch (e) {} inlineCodeState.opening = null; }
    closeSelectionCard();

    const layer = (rcx.doc || document).createElement("div");
    layer.style.position = "fixed";
    layer.style.zIndex = "300";
    layer.style.maxWidth = "calc(100vw - 16px)";
    layer.style.pointerEvents = "none";
    (rcx.doc || document).body.appendChild(layer);
    selectionState.layer = layer;
    selectionState.range = range.cloneRange();
    selectionState.pid = "selection:" + (++lineClickSeq);

    const info = {
      text,
      cwd: (typeof window !== "undefined" && window.__piWebCwd) || undefined,
      element: msgEl,
      rowIndex: null,
      paragraphId: selectionState.pid,
      isSelection: true,
      messageRole: msgEl && msgEl.dataset ? (msgEl.dataset.chatMsgRole || undefined) : undefined,
      sessionId: undefined,
      setInline: (node) => {
        if (!selectionState.layer) return; // 弹层已被收掉（异步识别晚到/选区失效）——不复活
        layer.innerHTML = "";
        const dom = elToDom(node);
        if (dom) { layer.appendChild(dom); layer.firstChild.style.pointerEvents = "auto"; }
        positionSelectionCard();
      },
      close: () => closeSelectionCard(),
    };
    if (!paragraphHandler) { closeSelectionCard(); return; }
    paragraphHandler(info);
  }
  if (featureEnabled("recognizer.selection")) {
    document.addEventListener("pointerup", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (!selectionNonCollapsed()) return;
      // 点在弹层自身（复制/引用/新会话按钮等）≠ 新划选：卡片 onMouseDown preventDefault
      // 保住了选区（selectionNonCollapsed 仍 true），不排除会重走 openSelectionCard →
      // 旧 layer 被 remove 重建 → click 目标 detach，按钮点了无效（划选弹层按钮失效根因）
      let pt = e.target;
      if (pt && pt.nodeType === 3) pt = pt.parentElement;
      if (pt && pt.closest && pt.closest("[data-msg-smart-card]")) return;
      const sel = window.getSelection();
      const range = sel.getRangeAt(0);
      // 选区须落在消息内容块（core ChatWindow 消息容器的 data-chat-msg-role 标记）内
      const node = range.commonAncestorContainer;
      const rootEl = node.nodeType === 3 ? node.parentElement : node;
      const msgEl = rootEl && rootEl.closest && rootEl.closest("[data-chat-msg-role]");
      if (!msgEl) return;
      const text = sel.toString().replace(/\u00a0/g, " ").trim();
      if (!text) return;
      openSelectionCard(text, range, msgEl);
    }, true);
  }

  // ── user 消息操作区「💬 引用」（userMessageActions slot，与 📌 收藏 同排；不检测，纯引用）
  function UserQuoteFull(props) {
    const text = props.text ?? "";
    if (!text.trim()) return null;
    return h("button", {
      title: "把这条消息引用到输入框",
      onClick: () => { try { ctx.appendText(formatQuote(text)); } catch (e) {} },
      style: {
        display: "flex", alignItems: "center", gap: 4,
        padding: "3px 8px", height: 22,
        background: "none", border: "none", borderRadius: 5,
        color: "var(--text-dim)", cursor: "pointer",
        fontSize: 11, fontWeight: 400, whiteSpace: "nowrap",
        fontFamily: "inherit", transition: "color 0.12s",
      },
      onMouseEnter: (e) => { e.currentTarget.style.color = "var(--accent)"; },
      onMouseLeave: (e) => { e.currentTarget.style.color = "var(--text-dim)"; },
    }, h("span", { key: "icon", style: { display: "inline-flex" } }, typeIcon("quote")), " 引用");
  }
  try { ctx.registerItems("userMessageActions", [{ id: "aiti-msg-smart-quote", render: UserQuoteFull, meta: { label: "引用" } }]); } catch (e) {}

  // ── 内联 code 点击弹层（可扩展主题 inline-code-action）：
  //    行内 <code>（不在 <pre>/代码块内）点击 → 复制代码 + 弹小动作层。
  //    默认「复制」按钮，外部 provider 注册 inline-code-action 主题可添加更多动作。
  //    user 消息的行内 code 同样处理（行为无害，段落本不可点）。
  //    同一时刻只开一个弹层（inlineCodeState，与段落弹层 state.opening 独立不互斥）。
  const inlineCodeState = { opening: null };
  try {
    document.addEventListener("click", (e) => {
      let t = e.target;
      if (t && t.nodeType === 3) t = t.parentElement;
      const el = (t && t.closest && t.closest("code")) || null;
      if (!el) return;
      if (!el.closest("[data-chat-msg-role]")) return; // 只管消息区内的行内代码：扩展面板里的 code（如 aiti-cmd 会话行命令）不劫持，否则 stopPropagation 吞掉整行点击
      if (el.closest("pre") || el.closest(".markdown-code-block")) return;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 200) return;
      e.stopPropagation();
      setRcx(null); // 行内 code 弹层恒在顶层文档（elToDom 走 rcx.doc）

      // toggle：同一 code 再点 → 只关弹层，不重复复制
      const codeId = el.__aitiCodeId || (el.__aitiCodeId = ++lineClickSeq);
      const codePid = "code-inline:" + codeId;
      if (inlineCodeState.opening && inlineCodeState.opening.pid === codePid) {
        try { inlineCodeState.opening.close?.(); } catch (e) {}
        inlineCodeState.opening = null;
        return;
      }
      // 切 code：先关旧的（close 会清定时器/外部点击监听）
      if (inlineCodeState.opening) {
        try { inlineCodeState.opening.close?.(); } catch (e) {}
        inlineCodeState.opening = null;
      }
      // 与段落弹层互斥：开 code 弹层前先关段落弹层（state/clearFloat 为模块级，同注册闭包内可访问）
      if (state.opening) {
        try { state.opening.close(); } catch (e) {}
        state.opening = null;
        clearFloat();
      }
      // 与划选弹层互斥：开 code 弹层前先关选中弹层
      closeSelectionCard();

      // 复制文本（toggle 分支已提前 return，只有新/切 code 才走到这里）
      let copied = false;
      try { navigator.clipboard.writeText(text); copied = true; } catch (err) {}

      // 构建弹层容器
      const layer = (rcx.doc || document).createElement("div");
      layer.style.position = "fixed";
      layer.style.zIndex = "300";
      layer.style.pointerEvents = "none";
      (rcx.doc || document).body.appendChild(layer);

      // 获取外部 provider 动作（inline-code-action 主题）
      const externalActions = [];
      let inlineExternal = [];
      try { inlineExternal = ctx.getTopicItems ? ctx.getTopicItems("inline-code-action") : []; } catch (e) {}
      for (const p of inlineExternal) {
        try {
          const r = p.recognize ? p.recognize(text, { element: el }) : null;
          if (r && typeof r.then === "function") {
            r.then((list) => {
              // 守卫：弹层可能已被关闭（2s 超时/外部点击/切换）——晚到的异步结果不再死渲染
              if (inlineCodeState.opening && inlineCodeState.opening.layer === layer) {
                if (Array.isArray(list) && list.length) { externalActions.push(...list); render(); }
              }
            }).catch(() => {});
          } else if (Array.isArray(r) && r.length) {
            externalActions.push(...r);
          }
        } catch (e) {}
      }

      // 关闭弹层：移除 layer + 清状态 + 取消定时器 + 卸载外部点击监听
      let closeTimer = null;
      let outsideHandler = null;
      const closeLayer = () => {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        if (outsideHandler) { document.removeEventListener("click", outsideHandler, true); outsideHandler = null; }
        try { layer.remove(); } catch (e) {}
        inlineCodeState.opening = null;
      };

      // 构建弹层内容（复用段落卡片的 actionBtnStyle / cardStyle）
      // 函数声明 hoist——closeLayer/closeTimer 为闭包变量，调用时已初始化，无 TDZ
      function render() {
        // 异步 provider 到达动作时：取消自动消失定时器（有动作保持打开）
        if (externalActions.length && closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
        const rect = el.getBoundingClientRect();
        // detached（virtualized 滚动移出 DOM）→ getBoundingClientRect 为 0 矩形，钉鼠标位置兑底
        const detached = !rect.width && !rect.height;
        const top = detached ? e.clientY + 8 : rect.bottom + 4;
        const left = Math.max(8, Math.min(detached ? e.clientX : rect.left, window.innerWidth - 280));
        const nodes = [];

        // 已复制指示 + 复制按钮
        nodes.push(h("button", {
          key: "copy", type: "button",
          onClick: (e2) => { e2.stopPropagation(); try { navigator.clipboard.writeText(text); } catch (err) {} },
          title: T.copy,
          style: { ...actionBtnStyle, color: copied ? "#22c55e" : "var(--accent)", background: "color-mix(in srgb, " + (copied ? "#22c55e" : "var(--accent)") + " 10%, transparent)" },
        }, copied ? T.copied : T.copy));
        // provider 动作
        for (const a of externalActions) {
          nodes.push(h("button", {
            key: a.id, type: "button",
            onClick: (e2) => { e2.stopPropagation(); a.onClick(text, el); closeLayer(); },
            title: a.title || "",
            style: { ...actionBtnStyle, color: a.danger ? "#ef4444" : "var(--accent)", borderColor: a.danger ? "#fca5a5" : "var(--border)" },
          }, typeIcon(a.type || "command"), a.label));
        }

        const card = h("span", {
          style: { ...cardStyle, pointerEvents: "auto" },
          onMouseDown: (e2) => e2.preventDefault(),
          onClick: (e2) => e2.stopPropagation(),
        }, h("span", { style: { display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" } }, ...nodes));

        const dom = elToDom(h("span", { style: { position: "fixed", top, left, zIndex: 300 } }, card));
        layer.innerHTML = "";
        if (dom) layer.appendChild(dom);
      }

      // 外部点击关闭：capture 阶段检测点击是否在弹层外
      outsideHandler = (e2) => {
        if (inlineCodeState.opening && inlineCodeState.opening.layer !== layer) {
          // 弹层已被切走，清理本监听
          document.removeEventListener("click", outsideHandler, true);
          outsideHandler = null;
          return;
        }
        // 点的是弹层内部按钮或容器 → 不关
        if (layer.contains(e2.target)) return;
        closeLayer();
      };
      document.addEventListener("click", outsideHandler, true);

      // 无 provider 动作时 2s 自动消失（hover 弹层/按钮期间顺延不消失）；有动作则保持打开
      const armAutoClose = () => {
        closeTimer = setTimeout(() => {
          if (layer.querySelector(":hover")) { armAutoClose(); return; }
          closeLayer();
        }, 2000);
      };
      if (!externalActions.length) armAutoClose();

      inlineCodeState.opening = { pid: codePid, layer, close: closeLayer };
      render();
    }, true);
  } catch (e) {}
}
