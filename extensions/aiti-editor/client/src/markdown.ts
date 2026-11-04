/**
 * aiti-editor · Markdown 预览/导出 HTML 渲染（自手写版原样搬运）。
 * vendor（marked / github-markdown css / mermaid）走扩展同源资产路由，不走 CDN。
 * gitChanges：源码行变更区间（1 起始、双闭）——预览内按块回算源码行号，命中块高亮，供父窗定位按钮跳转。
 * 围栏渲染（docs/aiti-editor-md-plugins-plan.md M0）：本文件只有**通用壳**（`.md-fence` CSS +
 * 分发脚本）——mermaid 等具体渲染器经 `__aitiEditor.registerMdRenderer` 注册，render 函数在父页，
 * iframe 运行时同源直取（见 md-mermaid.ts）。命不中围栏的文档零注入。
 * 导出离线自包含：render 函数进不了单文件，故 markdownExportHtml 仍自带一份 mermaid 内联脚本。
 */
import { getBase } from "./env.ts";
import { mdSlug } from "./lib.ts";

/**
 * 参与 srcdoc 构建的围栏渲染器描述（md-plugins M0 §3.1）。
 * 只有 `lang` + 已按主题求值的 `css` 需要烤进 srcdoc——`render` 是函数，不可序列化，
 * iframe 运行时经同源 `parent.__aitiEditor.resolveMdRenderers(lang)` 直取直调（方案 §4.1）。
 */
export interface MdFenceDescriptor {
  lang: string;
  css?: string;
}

/** 壳交给渲染器的上下文（渲染器只操作 view 与 actions 插槽，壳负责其余）。 */
export interface MdRenderCtx {
  dark: boolean;
  /** 预览 iframe 文档（同源）：临时节点/对话框挂这里 */
  iframeDoc: Document;
  /** 渲染器自己的资产基址（自托管 vendor：`base + "/assets/…"`） */
  base: string;
  /** 壳头部的操作按钮插槽（渲染器放自己的按钮；插到「源码」切换前用 insertBefore） */
  actions: HTMLElement;
}

/** 围栏渲染器注册项（`__aitiEditor.registerMdRenderer` 的入参）。 */
export interface MdRendererRegistration {
  id: string;
  /** 接管的围栏语言（```<lang>，仅 [\w-]） */
  lang: string;
  displayName?: string;
  /** 缺省 default；内置恒 default 且先注册 ⇒ 同优先级平局内置赢（§5.1） */
  priority?: "default" | "preferred" | "override";
  sourceExt?: string;
  /** 渲染器自己的预览样式（壳之外）；函数形态按主题求值后烤进 srcdoc */
  css?: string | ((dark: boolean) => string);
  /** 自托管资产基址（透传进 ctx.base；缺省 = aiti-editor 资产基址） */
  base?: string;
  /** 渲染：往 view 里写内容；throw/reject → 壳落错误态（文案取 message） */
  render(view: HTMLElement, code: string, ctx: MdRenderCtx): void | Promise<void>;
}

/** 围栏语言 id 合法性（要进 CSS class、正则与 `language-<lang>` class）。 */
export function isFenceLang(lang: any): boolean {
  return typeof lang === "string" && /^[\w-]+$/.test(lang);
}

/** 内容是否含指定语言的围栏（注入门禁：无围栏 → 渲染器代码零注入）。 */
export function hasFenceOf(content: string, lang: string): boolean {
  if (!isFenceLang(lang)) return false;
  return new RegExp("(^|\\n)[ \\t]*```[ \\t]*" + lang + "\\b").test(String(content || ""));
}

/** 本轮真正需要注入的渲染器（描述符 ∩ 内容实际含该围栏；注册序保持）。 */
export function activeFenceRenderers(content: string, renderers?: MdFenceDescriptor[]): MdFenceDescriptor[] {
  const out: MdFenceDescriptor[] = [];
  const seen: Record<string, boolean> = {};
  for (const r of renderers || []) {
    if (!r || !isFenceLang(r.lang) || seen[r.lang]) continue;
    if (!hasFenceOf(content, r.lang)) continue;
    seen[r.lang] = true;
    out.push(r);
  }
  return out;
}

/**
 * 围栏渲染块通用壳 CSS（§3.2：壳=边框/头部条/lang 标签/源码·预览切换/错误态，归内置；
 * 全渲染器统一视觉，渲染器只往 view 与 actions 插槽里放自己的东西）。
 * 仅在有渲染器命中围栏时注入——无图/无数学文档零字节。
 */
export function fenceShellCss(dark: boolean): string {
  const bg = dark ? "#0d1117" : "#fff";
  const fg = dark ? "#c9d1d9" : "#24292f";
  const bd = dark ? "#30363d" : "#d0d7de";
  const ac = dark ? "#58a6ff" : "#0969da";
  const mu = dark ? "#8b949e" : "#57606a";
  const hv = dark ? "#161b22" : "#f6f8fa";
  return `  /* ── 围栏渲染块（壳；视觉对齐 pi-web 图表块）── */
  .md-fence{margin:16px 0;overflow:hidden;border:1px solid ${bd};border-radius:6px;background:${hv}}
  .md-fence-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;border-bottom:1px solid ${bd}}
  .md-fence-lang{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:600;color:${mu}}
  .md-fence-actions{display:flex;gap:6px}
  .md-fbtn{padding:2px 8px;border:1px solid ${bd};border-radius:4px;background:transparent;color:${fg};font-family:inherit;font-size:11px;line-height:1.5;cursor:pointer}
  .md-fbtn:hover{background:${hv}}
  .md-fbtn.is-active{background:${dark ? "rgba(56,139,253,.15)" : "rgba(9,105,218,.1)"};color:${ac}}
  .md-fbtn[hidden]{display:none}
  /* 预览本体 = 真 button（键盘可达 / focus-visible / 高度上限；渲染器可接点击自开查看器） */
  .md-fence-view{display:block;width:100%;padding:12px;border:0;background:transparent;color:inherit;text-align:left;overflow:auto;max-height:min(600px,60vh)}
  .md-fence-view:focus-visible{outline:2px solid ${ac};outline-offset:-2px}
  .md-fence-view.md-fence-loading{min-height:120px}
  .md-fence-error{padding:8px 12px;color:${mu};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .md-fence.is-error .md-fence-view{display:none}
  .md-fence.srcmode .md-fence-view{display:none}
  .md-fence-src{display:none;margin:0;padding:11px 13px;background:${bg};font-size:12.5px;line-height:1.62;overflow:auto}
  .md-fence-src code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:transparent;padding:0;font-size:inherit}
  .md-fence.srcmode .md-fence-src{display:block}
`;
}

/**
 * 围栏分发脚本（iframe 内）：命中语言的围栏 `<pre>` 原位替换为 `.md-fence` 壳（顶层元素数
 * 1:1 保持 → 下方 git 行标注不受影响），再向父页取生效渲染器渲染。
 *
 * 边界：`parent.__aitiEditor` 取不到（父页不可达 / 独立打开该 srcdoc）→ 整块跳过，
 * 围栏保持普通代码块；`render` throw/reject → 壳落错误态（文案取异常 message）。
 */
export function fenceShellScript(dark: boolean, langs: string[]): string {
  const langsJson = JSON.stringify((langs || []).filter(isFenceLang));
  return `  // ── 围栏渲染器（md-plugins M0）：壳归内置（本段），render 函数在父页 ──
  // 函数不可序列化进 srcdoc；srcdoc 与父页同源（无 sandbox），故经 parent.__aitiEditor 直取直调。
  var MD_DARK = ${dark ? "true" : "false"};
  var __mdFence = [];
  (function(){
    var ED = null;
    try { ED = window.parent.__aitiEditor; } catch (e) { return; }
    if (!ED || typeof ED.resolveMdRenderers !== "function") return;
    var langs = ${langsJson};
    var codes = document.querySelectorAll("#content pre > code");
    for (var i = 0; i < codes.length; i++) {
      var lm = (codes[i].className || "").match(/language-([\\w-]+)/);
      if (!lm || langs.indexOf(lm[1]) < 0) continue;
      var r = null;
      try { var q = ED.resolveMdRenderers(lm[1]); r = q && q[0]; } catch (e) { continue; }
      if (!r || typeof r.render !== "function") continue; // 该语言无生效渲染器 → 保持普通代码块
      var pre = codes[i].parentElement;
      var src = (codes[i].textContent || "").replace(/\\n$/, ""); // 同上游 MarkdownBody：去尾换行再交渲染
      var w = document.createElement("div"); w.className = "md-fence";
      var head = document.createElement("div"); head.className = "md-fence-head";
      head.innerHTML = '<span class="md-fence-lang">' + lm[1] + '</span>'
        + '<span class="md-fence-actions">'
        + '<button type="button" class="md-fbtn md-fence-toggle" title="查看源码">源码</button>'
        + '</span>';
      var body = document.createElement("div"); body.className = "md-fence-body";
      // 预览本体用真 <button>（键盘可达 / hover / focus-visible；渲染器可自行接点击开查看器）
      var view = document.createElement("button");
      view.type = "button";
      view.className = "md-fence-view md-fence-loading";
      view.setAttribute("data-md-fence", lm[1]); // 渲染器据此定位自己的块（CSS + 事件委托，先于异步 render 就位）
      view.setAttribute("aria-label", "正在渲染 " + lm[1] + "…");
      var err = document.createElement("div"); err.className = "md-fence-error"; err.hidden = true;
      var srcPre = document.createElement("pre"); srcPre.className = "md-fence-src";
      var srcCode = document.createElement("code"); srcCode.textContent = src;
      srcPre.appendChild(srcCode);
      body.appendChild(view); body.appendChild(err); body.appendChild(srcPre);
      w.appendChild(head); w.appendChild(body);
      pre.replaceWith(w);
      __mdFence.push({ w: w, view: view, err: err, render: r.render, base: r.base || "", code: src, lang: lm[1] });
    }
    for (var k = 0; k < __mdFence.length; k++) __mdFenceRun(__mdFence[k]);
  })();
  function __mdFenceRun(it){
    var settled = false;
    function fail(msg){
      if (settled) return; settled = true;
      it.view.classList.remove("md-fence-loading");
      it.w.classList.add("is-error");
      it.err.textContent = msg || (it.lang + " 渲染失败");
      it.err.hidden = false;
    }
    function ok(){
      if (settled) return; settled = true;
      it.view.classList.remove("md-fence-loading");
      it.w.classList.add("is-ready");
    }
    var ctx = { dark: MD_DARK, iframeDoc: document, base: it.base, actions: it.w.querySelector(".md-fence-actions") };
    try {
      var p = it.render(it.view, it.code, ctx);
      if (p && typeof p.then === "function") p.then(ok, function(e){ fail(e && e.message); });
      else ok();
    } catch (e) { fail(e && e.message); }
  }
  // 壳上的「源码 / 预览」切换（渲染器无感；错误态一样能切回源码）
  document.addEventListener("click", function(e){
    var t = e.target;
    if (!t || !t.closest) return;
    var b = t.closest(".md-fence-toggle");
    if (!b) return;
    var fw = b.closest(".md-fence");
    if (!fw) return;
    var toSrc = !fw.classList.contains("srcmode");
    fw.classList.toggle("srcmode", toSrc);
    b.textContent = toSrc ? "预览" : "源码";
    b.title = toSrc ? "预览图表" : "查看源码";
    b.classList.toggle("is-active", toSrc);
  });
`;
}

/**
 * 预览 iframe 的 srcdoc。
 * `smart=true`（feature editor.mdPreviewSmart，默认开）时预览内点击语义块/代码行会 postMessage
 * `aiti-editor-preview-click` 给父窗，由父窗转交 aiti-msg-smart 弹层引擎（弹层渲染在本文档内）。
 */
export function markdownPreviewHtml(
  content: string,
  dark: boolean,
  gitChanges?: Array<{ start: number; end: number }>,
  smart = true,
  renderers?: MdFenceDescriptor[],
): string {
  const base = getBase();
  const bg = dark ? "#0d1117" : "#fff";
  const fg = dark ? "#c9d1d9" : "#24292f";
  const bd = dark ? "#30363d" : "#d0d7de";
  const ac = dark ? "#58a6ff" : "#0969da";
  const mu = dark ? "#8b949e" : "#57606a";
  const hv = dark ? "#161b22" : "#f6f8fa";
  const lines = content.split("\n");
  const tocItems: { level: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (m) tocItems.push({ level: m[1].length, text: m[2].trim() });
  }
  let tocHtml = "";
  if (tocItems.length > 0) {
    tocHtml = "<div class=\"toc\"><div class=\"toc-title\">## Contents</div>";
    for (const item of tocItems) {
      const anchor = mdSlug(item.text);
      tocHtml += "<div class=\"toc-item\" style=\"padding-left:" + ((item.level - 1) * 16) + "px\"><a href=\"#" + anchor + "\">" + item.text + "</a></div>";
    }
    tocHtml += "</div><hr>";
  }
  // TOC 作为静态标记放 #content 之外——不进 marked 解析流：
  // ① 避免 tocHtml 与正文首行 glue 导致首个标题被吞进 html 块；
  // ② lexer(content) 与 #content 子元素严格 1:1，git 变更块回算才不会失配而放弃标注。
  const escaped = encodeURIComponent(content);
  const changesJson = JSON.stringify(gitChanges && gitChanges.length ? gitChanges : []);
  // 预览 iframe：自托管 vendor（不走 CDN，同源资产路由）
  const cssHref = base + "/assets/vendor/github-markdown.min.css";
  const markedSrc = base + "/assets/vendor/marked.min.js";
  // 围栏渲染器门禁（延续 hasMermaidFence 语义）：命中才注壳 + 注渲染器自己的 css；零命中 = 零注入
  const fenceRs = activeFenceRenderers(content, renderers);
  const fenceLangs = fenceRs.map((r) => r.lang);
  const fenceCss = fenceRs.map((r) => r.css || "").join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${cssHref}">
<style>
  /* 自适应全宽（不限 800px）：独立 viewer 大窗口铺满，窄窗/分栏自然收窄；边距随窗口适度放大 */
  body{max-width:none;margin:0 auto;padding:24px clamp(24px,4vw,64px);background:${bg};color:${fg};font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6}
  .markdown-body{background:${bg};color:${fg}}
  .markdown-body pre{background:${dark?"#161b22":"#f6f8fa"}}
  .markdown-body code{background:${dark?"rgba(110,118,129,0.4)":"rgba(175,184,193,0.2)"}}
  .toc{margin-bottom:20px;padding:12px 16px;background:${dark?"#161b22":"#f6f8fa"};border-radius:8px;border:1px solid ${dark?"#30363d":"#d0d7de"}}
  .toc-title{font-weight:600;margin-bottom:8px;font-size:13px;text-transform:uppercase;color:${dark?"#8b949e":"#57606a"}}
  .toc-item a{color:${dark?"#58a6ff":"#0969da"};text-decoration:none;font-size:13px;line-height:1.8}
  .toc-item a:hover{text-decoration:underline}
  h1,h2,h3,h4,h5,h6{scroll-margin-top:12px}
  /* git 变更块标注：左绿条 + 浅绿底；定位跳转时闪一下 */
  .md-chg{box-shadow:inset 3px 0 0 #22c55e;background:rgba(34,197,94,.07);border-radius:4px}
  .md-chg-flash{animation:mdchg 1.1s ease-out 1}
  @keyframes mdchg{0%{background:rgba(34,197,94,.32)}100%{background:rgba(34,197,94,.07)}}
  /* 弹层主题变量：msg-smart 卡片/按钮读 var(--bg) 等，iframe 内无宿主变量须自带 */
  :root{--bg:${bg};--border:${bd};--accent:${ac};--text-muted:${mu};--bg-hover:${hv}}
  /* 可点击提示：语义块 hover 左侧细条（不换 cursor，避免整篇像链接） */
  #content [data-aiti-blk]:hover{box-shadow:inset 2px 0 0 ${ac}}
  /* 弹层卡片容器点击穿透（msg-smart 在顶层文档注入同款规则；iframe 内须自带）：
     卡片 fixed 会盖住下方 1-2 行，不穿透则被盖住的行点不到 */
  [data-msg-smart-card]{pointer-events:none}
  [data-msg-smart-card] button{pointer-events:auto}
${fenceRs.length ? fenceShellCss(dark) + fenceCss : ""}
  </style></head><body class="markdown-body">${tocHtml}<div id="content"></div>
<script src="${markedSrc}"></script>
<script>
  document.getElementById("content").innerHTML=marked.parse(decodeURIComponent("${escaped}"));
  // 统一标题 id（对齐 TOC 锚点算法），供滚动同步/锚点跳转
  // 模板字符串内须双重转义：否则生成脚本的 \\w 会变成字面量 w，英文/数字锚点全部丢失。
  var slug = function(t){ return String(t).toLowerCase().replace(/[^\\w\\u4e00-\\u9fff]+/g,"-").replace(/^-|-$/g,"") || "section"; };
  document.querySelectorAll("#content h1,#content h2,#content h3,#content h4,#content h5,#content h6").forEach(function(h){
    if (!h.id) h.id = slug(h.textContent.trim());
  });
${fenceRs.length ? fenceShellScript(dark, fenceLangs) : ""}
  // 智能点击上报（aiti-msg-smart 弹层）：点击语义块 / 代码行 → postMessage 给父窗。
  // 消息只带语义（文本 + 源码行区间 + 行号/字符偏移），DOM 元素由父窗按 data-aiti-blk 回查。
  var SMART = ${smart ? "1" : "0"};
  function __aitiNonCollapsed() {
    try { var s2 = window.getSelection(); return !!(s2 && !s2.isCollapsed && s2.rangeCount > 0 && s2.toString().trim()); } catch (e) { return false; }
  }
  // pre 内点击 → 逻辑行号 + 字符偏移（对齐 msg-smart clickedLineInfo：caret 定位，换行行也准）
  function __aitiLineOf(pre, x, y) {
    var txt = pre.textContent || "";
    var lines = txt.split("\\n");
    if (!lines.length) return null;
    var off = -1, row = -1;
    var cfn = document.caretRangeFromPoint
      ? function(a, b){ try { return document.caretRangeFromPoint(a, b); } catch (e) { return null; } }
      : (document.caretPositionFromPoint
        ? function(a, b){ try { var p = document.caretPositionFromPoint(a, b); return p ? p.getRange() : null; } catch (e) { return null; } }
        : null);
    if (cfn) {
      var rg = cfn(x, y);
      if (rg && rg.startContainer && (rg.startContainer === pre || pre.contains(rg.startContainer))) {
        var node = rg.startContainer, o = rg.startOffset, abs = 0, ok = false;
        if (node === pre) { abs = 0; for (var i = 0; i < o && i < pre.childNodes.length; i++) { abs += (pre.childNodes[i].textContent || "").length; } ok = true; }
        else if (node.nodeType === 3) {
          var w = document.createTreeWalker(pre, 4), n = w.nextNode();
          while (n) { if (n === node) { abs += o; ok = true; break; } abs += n.textContent.length; n = w.nextNode(); }
        }
        if (ok) {
          off = abs; row = 0;
          for (var j = 0; j < off && j < txt.length; j++) if (txt.charCodeAt(j) === 10) row++;
        }
      }
    }
    if (row < 0) { row = 0; off = -1; } // 兑底：取不到 caret 就按首行处理
    if (row >= lines.length) return null;
    return { row: row, off: off, text: lines[row] };
  }
  function __aitiPostClick(el, x, y) {
    var blk = el.getAttribute("data-aiti-blk") || "";
    var cs = el.getAttribute("data-code-start");
    var li = cs ? __aitiLineOf(el, x, y) : null;
    if (li && cs) {
      window.parent.postMessage({ type: "aiti-editor-preview-click", blk: blk, kind: "code-line",
        text: li.text, row: li.row, charOffset: li.off,
        srcStart: (+cs) + li.row, srcEnd: (+cs) + li.row }, "*");
      return;
    }
    window.parent.postMessage({ type: "aiti-editor-preview-click", blk: blk, kind: "block",
      text: el.textContent || "", row: null, charOffset: null,
      srcStart: +el.getAttribute("data-src-start"), srcEnd: +el.getAttribute("data-src-end") }, "*");
  }
  // 拦截锚点链接点击：滚到文档内对应标题（不触发父页面导航/AI 窗）
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      var id = a.getAttribute("href").slice(1);
      var el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      if (window.parent) window.parent.postMessage({ type: "aiti-editor-scroll", anchor: id }, "*");
      return;
    }
    if (!SMART || __aitiNonCollapsed()) return; // 划选收尾的 click 不开弹层
    var t = e.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    var blk = t && t.closest ? t.closest("#content [data-aiti-blk]") : null;
    if (blk) __aitiPostClick(blk, e.clientX, e.clientY);
  }, true);
  // 预览滚动 → 按比例通知父窗口（编辑器跟随；连续滑动不跳变）
  var _lastPm = 0;
  window.addEventListener("scroll", function(){
    if (window.__aitiSuppressScroll) return;
    var now = Date.now();
    if (now - _lastPm < 80) return;
    _lastPm = now;
    var el = document.scrollingElement || document.documentElement;
    var max = Math.max(0, el.scrollHeight - window.innerHeight);
    var pct = max > 0 ? window.scrollY / max : 0;
    window.parent.postMessage({ type: "aiti-editor-scroll-pct", pct: pct }, "*");
  }, { passive: true });
  // 预览内选区/点击 → 通知父窗口（@ 提及时识别选区来源：preview）。
  // 消息携带选中文本 + 由 data-src-start/end 反推的源码行区间：父窗用 mouseup 时捕获的存储值，
  // 避免点击 @ 按钮时 iframe 已失焦、getSelection() 为空而只出 @file 无 #Lx。
  function __aitiSelText() {
    var sel = window.getSelection();
    return sel && sel.toString ? sel.toString() : "";
  }
  function __aitiSelLoc() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var node = sel.anchorNode;
    if (node && node.nodeType === 3) node = node.parentNode;
    while (node) {
      if (node.getAttribute && node.getAttribute("data-src-start")) {
        return { start: +node.getAttribute("data-src-start"), end: +node.getAttribute("data-src-end") };
      }
      node = node.parentNode;
    }
    return null;
  }
  function __aitiPostSel() {
    window.parent.postMessage({ type: "aiti-editor-preview-sel", loc: __aitiSelLoc(), text: __aitiSelText() }, "*");
  }
  document.addEventListener("mouseup", __aitiPostSel);
  document.addEventListener("keyup", __aitiPostSel);
  // ── 来源行标注：marked 顶层 token 的 raw 回算源码行区间（始终计算，供 @ 引用/定位恢复行号）──
  // ── git 变更块高亮：与变更区间相交的块附加 .md-chg（有变更才标）──
  // 父窗发 {type:"aiti-editor-chg-goto", idx} 循环滚动到第 idx 个变更块并闪烁
  var chgRanges = ${changesJson};
  var __mdChg = [];
  try {
    var mdSrc = decodeURIComponent("${escaped}");
    var toks = marked.lexer(mdSrc);
    var kids = document.getElementById("content").children;
    var renderable = 0;
    for (var ti = 0; ti < toks.length; ti++) if (toks[ti].type !== "space") renderable++;
    // 顶层 token 与渲染顶层元素应一一对应；不一一对应（如 html 块多子节点）则放弃标注（安全兜底）
    // 行号：逐 token 携带自身换行数推进 lineNum（token.raw 含尾换行，直接 split 会每块多计一行漂移）
    if (renderable === kids.length) {
      var lineNum = 1, ki = 0;
      for (var ti2 = 0; ti2 < toks.length; ti2++) {
        var tk = toks[ti2];
        var rawStr = tk.raw || "";
        var nlRaw = (rawStr.match(/\\n/g) || []).length;
        if (tk.type === "space") { lineNum += nlRaw; continue; }
        var el = kids[ki++];
        var endsNl = rawStr.slice(-1) === "\\n";
        var s = lineNum, e2 = lineNum + nlRaw - (endsNl ? 1 : 0);
        el.setAttribute("data-src-start", s);
        el.setAttribute("data-src-end", e2);
        // 智能点击锚点：data-aiti-blk 供父窗回查元素；代码块额外记录「首行代码对应的源码行」
        // （围栏行不属代码内容 → +1；缩进代码块不加）
        el.setAttribute("data-aiti-blk", ki - 1);
        if (el.tagName === "PRE" && tk.type === "code") {
          var fenced = tk.codeBlockStyle ? tk.codeBlockStyle === "fenced" : /^[ \\t]{0,3}[\\u0060~]{3}/.test(rawStr);
          el.setAttribute("data-code-start", s + (fenced ? 1 : 0));
        }
        for (var ci = 0; ci < chgRanges.length; ci++) {
          if (chgRanges[ci].start <= e2 && chgRanges[ci].end >= s) { el.classList.add("md-chg"); __mdChg.push(el); break; }
        }
        lineNum += nlRaw;
      }
    }
  } catch (err) { /* 标注失败不影响预览 */ }
  window.addEventListener("message", function(ev){
    var m = ev.data;
    if (!m || m.type !== "aiti-editor-chg-goto" || !__mdChg.length) return;
    var el = __mdChg[((m.idx % __mdChg.length) + __mdChg.length) % __mdChg.length];
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("md-chg-flash");
    void el.offsetWidth;
    el.classList.add("md-chg-flash");
  });
</script>
</body></html>`;
}

/** 内容是否含 mermaid 围栏（导出内联 mermaid vendor 的判据；预览侧门禁走 hasFenceOf(lang)） */
export function hasMermaidFence(content: string): boolean {
  return hasFenceOf(content, "mermaid");
}

// 自托管 vendor 文本缓存（导出 HTML/PDF 内联用，不走 CDN）
const _vendorTextCache: Record<string, string> = {};
async function _vendorText(p: string): Promise<string> {
  if (_vendorTextCache[p]) return _vendorTextCache[p];
  const r = await fetch(getBase() + p, { cache: "no-store" });
  if (!r.ok) throw new Error("vendor 加载失败: " + p);
  const t = await r.text();
  _vendorTextCache[p] = t;
  return t;
}

export async function markdownRenderHtml(content: string, dark: boolean, title: string): Promise<string> {
  const bg = dark ? "#0d1117" : "#fff";
  const fg = dark ? "#c9d1d9" : "#24292f";
  const lines = content.split("\n");
  const tocItems: { level: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (m) tocItems.push({ level: m[1].length, text: m[2].trim() });
  }
  let tocHtml = "";
  if (tocItems.length > 0) {
    tocHtml = "<div class=\"toc\"><div class=\"toc-title\">Contents</div>";
    for (const item of tocItems) {
      const anchor = item.text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
      tocHtml += "<div class=\"toc-item\" style=\"padding-left:" + ((item.level - 1) * 16) + "px\"><a href=\"#" + anchor + "\">" + item.text + "</a></div>";
    }
    tocHtml += "</div><hr>";
  }
  // 同预览：TOC 静态标记放 #content 外，正文单独 parse（避免 glue 吞首标题）
  const escaped = encodeURIComponent(content);
  // 导出 HTML：内联自托管 vendor（marked + github-markdown css），文件自包含可离线打开；
  // 含 mermaid 围栏才内联 mermaid.min.js（3.5MB，无图导出零膨胀）
  const withMermaid = hasMermaidFence(content);
  const [gmCss, markedInline, mermaidInline] = await Promise.all([
    _vendorText("/assets/vendor/github-markdown.min.css"),
    _vendorText("/assets/vendor/marked.min.js"),
    withMermaid ? _vendorText("/assets/vendor/mermaid.min.js") : Promise.resolve(""),
  ]);
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + (title || "export") + '</title>'
    + '<style>' + gmCss + '</style>'
    + '<style>body{max-width:860px;margin:0 auto;padding:24px 32px;background:' + bg + ';color:' + fg + ';font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6}'
    + '.markdown-body{background:' + bg + ';color:' + fg + '}'
    + '.markdown-body pre{background:' + (dark ? "#161b22" : "#f6f8fa") + '}'
    + '.markdown-body code{background:' + (dark ? "rgba(110,118,129,0.4)" : "rgba(175,184,193,0.2)") + '}'
    + '.toc{margin-bottom:20px;padding:12px 16px;background:' + (dark ? "#161b22" : "#f6f8fa") + ';border-radius:8px;border:1px solid ' + (dark ? "#30363d" : "#d0d7de") + '}'
    + '.toc-title{font-weight:600;margin-bottom:8px;font-size:13px;text-transform:uppercase;color:' + (dark ? "#8b949e" : "#57606a") + '}'
    + '.toc-item a{color:' + (dark ? "#58a6ff" : "#0969da") + ';text-decoration:none;font-size:13px;line-height:1.8}'
    + '.toc-item a:hover{text-decoration:underline}'
    + '@media print{body{padding:0}.toc{break-after:auto}}'
    + '.md-export-mermaid{padding:12px;overflow:auto}.md-export-mermaid svg{display:block;margin:0 auto;max-width:100%}'
    + '</style></head><body class="markdown-body">' + tocHtml + '<div id="content"></div>'
    + '<script>' + markedInline + '</script>'
    + '<script>document.getElementById("content").innerHTML=marked.parse(decodeURIComponent("' + escaped + '"));<' + '/script>'
    + (withMermaid
      ? '<script>' + mermaidInline + '</script>'
        + '<script>(async function(){'
        + 'try{mermaid.initialize({startOnLoad:false,securityLevel:"strict",suppressErrorRendering:true,theme:' + (dark ? '"dark"' : '"default"') + '});}catch(e){return;}'
        + 'var codes=document.querySelectorAll("#content pre > code");'
        + 'for(var i=0;i<codes.length;i++){var c=codes[i];var m=(c.className||"").match(/language-([\\w-]+)/);'
        + 'if(!m||m[1]!=="mermaid")continue;var pre=c.parentElement,code=c.textContent||"";'
        + 'try{var ok=await mermaid.parse(code,{suppressErrors:true});if(!ok)throw new Error("invalid");'
        + 'var r=await mermaid.render("mdx-mermaid-"+i,code);'
        + 'var div=document.createElement("div");div.className="md-export-mermaid";div.innerHTML=r.svg;pre.replaceWith(div);}catch(e){}}'
        + '})()<' + '/script>'
      : '')
    + '</body></html>';
}
