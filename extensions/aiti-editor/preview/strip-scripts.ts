/**
 * 剥掉 HTML 文档内「作者写的可执行内容」——预览脚本开关的**便利层**。
 *
 * 方案：docs/aiti-editor-html-preview-plan.md §3.3（服务端与客户端共用一份，判据不能两边各写一遍）
 * 诚实定位：真正的安全边界是 **opaque origin**（srcdoc 的 sandbox 不给 allow-same-origin；
 *   服务态靠响应头 `CSP: sandbox`）。正则是「默认不执行」的实现，漏网也拿不到宿主任何东西——
 *   所以它值得简单可读，不值得假装完备。
 */

/** 成对 script（含跨行内容/属性）、自闭合 script、on* 内联事件、javascript: 伪协议（带引号/裸值）。 */
const SCRIPT_PAIR_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const SCRIPT_SELF_RE = /<script\b[^>]*\/>/gi;
const EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL_QUOTED_RE = /=(\s*)(["'])\s*javascript:[^"']*/gi;
const JS_URL_BARE_RE = /=(\s*)javascript:[^\s>]*/gi;

export function stripUserScripts(html: string): { html: string; removed: number } {
  let out = String(html == null ? "" : html);
  let removed = 0;
  const drop = (re: RegExp) => { out = out.replace(re, () => { removed++; return ""; }); };
  drop(SCRIPT_PAIR_RE);
  drop(SCRIPT_SELF_RE);
  drop(EVENT_ATTR_RE);
  // 两条伪协议形态各用一个回调：replace 的第 3 个实参在单捕获组时是**偏移量数字**，共用会把偏移当引号拼回去
  out = out.replace(JS_URL_QUOTED_RE, (_m, sp: string, q: string) => { removed++; return "=" + sp + q + "#"; });
  out = out.replace(JS_URL_BARE_RE, (_m, sp: string) => { removed++; return "=" + sp + "#"; });
  return { html: out, removed };
}
