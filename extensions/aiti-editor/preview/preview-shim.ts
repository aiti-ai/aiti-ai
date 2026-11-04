/**
 * aiti-editor · HTML 预览上报脚本（iframe → 父页）——**两端共用单一来源**。
 *
 * 服务端（preview 路由）把它注入到服务态文档尾部；客户端快速态把它写进 srcdoc。
 * 两态的父页消费方是同一个 `client/src/html-preview.tsx`（消息 type 常量在此收口）。
 *
 * 职责（只做「观测 + 上报」，不改写被预览页面的行为）：
 *   1. 报错回传：JS error / 资源加载失败 / unhandledrejection / console.error·warn
 *   2. 相对链接改道：票据目录内的 `<a>` 点击 → preventDefault + 上报 rel，由父页在 dock 打开目标文件
 *   3. 表单提交钳制：预览没有同源能力，提交只会把框架刷成白页 → 阻止并提示
 *   4. ready 上报：父页据此判定「文档已装载」（无 ready = 加载失败提示）
 *
 * 安全定位：本脚本运行在 **opaque origin**（srcdoc 的 sandbox 不给 allow-same-origin；
 * 服务态靠响应头 `Content-Security-Policy: sandbox`），拿不到 pi-web 的 DOM/cookie/存储。
 *
 * ⚠ 产物是「一段 JS 源码字符串」，写在 TS 模板串里——生成码内不得出现反引号与 ${
 *   （markdown.ts 曾因模板串转义丢 `\\w` 吃过锚点全丢的亏，此处一律字符串拼接）。
 */

/** iframe → 父页消息 type（三处消费点共用：html-preview.tsx 监听 + 本文生成脚本）。 */
export const PREVIEW_MSG = {
  ready: "aiti-editor-html-ready",
  open: "aiti-editor-html-open",
  report: "aiti-editor-html-report",
} as const;

export interface PreviewShimOpts {
  /**
   * preview 路由基址（`…/preview/<ticket>/`，含尾斜杠）。改道判定是**绝对 href 前缀比较**：
   * 传根相对形态（`/dev/api/…/tk/`）也可，脚本运行时用 document.baseURI 补成绝对；
   * 空串 = 无法改道（票据缺席），站外链接按新标签处理。
   * ⚠ srcdoc 态文档自身 URL 是 about:srcdoc，相对 base 无处解析——调用方必须给带 origin 的绝对形态。
   */
  base: string;
  /** 本文档相对票据目录的路径（"" = 票据入口文件本身） */
  docRel: string;
}

/** 生成上报脚本源码（不含 <script> 标签）。 */
export function buildPreviewShim(opts: PreviewShimOpts): string {
  const base = String(opts && opts.base ? opts.base : "");
  const docRel = String(opts && opts.docRel ? opts.docRel : "");
  const lines = [
    "(function(){",
    "var BASE=" + JSON.stringify(base) + ";",
    "var DOC_REL=" + JSON.stringify(docRel) + ";",
    // BASE 归一：改道判定是绝对 href 前缀比较 → 根相对形态补成绝对；缺尾斜杠补上（否则 rel 多切一段）
    "if(BASE&&BASE.charAt(0)==='/'){try{BASE=new URL(BASE,document.baseURI||location.href).href;}catch(e){}}",
    "if(BASE&&BASE.charAt(BASE.length-1)!=='/')BASE+='/';",
    "var SENT=0, CAP=60;",
    "function short(s){ s=String(s==null?'':s); return s.length>240?s.slice(0,240)+'…':s; }",
    "function safe(x){ if(typeof x==='string')return x; try{return JSON.stringify(x);}catch(e){ try{return String(x);}catch(e2){return '[unprintable]';} } }",
    "function send(type,payload){",
    "  if(SENT>=CAP) return;",
    "  SENT++;",
    "  var m={type:type,docRel:DOC_REL};",
    "  if(payload){for(var k in payload){m[k]=payload[k];}}",
    "  try{parent.postMessage(m,'*');}catch(e){}",
    "}",
    "function jsErr(msg,src,line,col){",
    "  var at='';",
    "  if(src){ var name=String(src).split('/').pop(); at=' ('+name+(line?':'+line:'')+(col?':'+col:'')+')'; }",
    "  send('"+PREVIEW_MSG.report+"',{kind:'error',level:'error',text:short(msg)+at});",
    "}",
    // 1) JS 异常 + 资源加载失败（capture 阶段才收得到 img/link 的 error 事件）
    "window.addEventListener('error',function(e){",
    "  var t=e.target;",
    "  if(t&&t!==window&&t.tagName){",
    "    var u=t.currentSrc||t.src||t.href||'';",
    "    send('"+PREVIEW_MSG.report+"',{kind:'error',level:'error',text:'资源加载失败 <'+String(t.tagName).toLowerCase()+'> '+short(String(u).split('/').pop())});",
    "    return;",
    "  }",
    "  jsErr(e&&e.message?e.message:'脚本执行出错',e&&e.filename,e&&e.lineno,e&&e.colno);",
    "},true);",
    "window.addEventListener('unhandledrejection',function(e){",
    "  jsErr('Promise 未捕获: '+safe(e&&e.reason));",
    "});",
    // 2) console 转发（只报 warn/error——log 不该点亮徽标）
    "(function(){",
    "  if(typeof console==='undefined'||!console.log)return;",
    "  ['error','warn'].forEach(function(lv){",
    "    var orig=console[lv];",
    "    console[lv]=function(){",
    "      var a=Array.prototype.slice.call(arguments).map(safe).join(' ');",
    "      send('"+PREVIEW_MSG.report+"',{kind:'console',level:lv,text:short(a)});",
    "      if(orig){try{orig.apply(console,arguments);}catch(e){}}",
    "    };",
    "  });",
    "})();",
    // 3) 链接：页内锚点放行 → 预览命名空间内改道 dock → 其余交新标签
    "document.addEventListener('click',function(e){",
    "  var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;",
    "  if(!a)return;",
    "  var raw=a.getAttribute('href')||'';",
    "  if(raw.charAt(0)==='#')return;",
    "  var url=null;",
    "  try{url=new URL(a.href,document.baseURI);}catch(err){return;}",
    "  var proto=url.protocol;",
    "  if(proto==='mailto:'||proto==='tel:'||proto==='data:'||proto==='blob:')return;",
    "  if(BASE&&url.href.indexOf(BASE)===0){",
    "    e.preventDefault();",
    "    var rel=url.href.slice(BASE.length).split('#')[0].split('?')[0];",
    "    try{rel=decodeURIComponent(rel);}catch(err){}",
    "    send('"+PREVIEW_MSG.open+"',{rel:rel});",
    "    return;",
    "  }",
    "  a.setAttribute('target','_blank');a.setAttribute('rel','noopener noreferrer');",
    "},true);",
    // 4) 表单提交钳制
    "document.addEventListener('submit',function(e){",
    "  e.preventDefault();",
    "  send('"+PREVIEW_MSG.report+"',{kind:'notice',level:'info',text:'预览内表单提交已阻止（预览无同源能力）'});",
    "},true);",
    // 5) 装载完成上报（DOM 就绪即报，不等图片加载；带标题供父页面包屑）
    "function ready(){send('"+PREVIEW_MSG.ready+"',{title:short(document&&document.title)});}",
    "if(document.readyState==='complete'||document.readyState==='interactive'){ready();}",
    "else{document.addEventListener('DOMContentLoaded',ready);}",
    "})();",
  ];
  return lines.join("\n");
}
