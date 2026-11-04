// inject 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { VERSION } from './config.js';
import { MINI_DBG_CLIENT } from 'virtual:dbg-client';

export function initInject(ctx) {
  ctx.mountRoot = function () {
      if (!document.body) { document.addEventListener('DOMContentLoaded', ctx.mountRoot); return; }
      document.body.appendChild(ctx.root);
      // 启动即注入：宿主页自身 client + 递归注入所有同源 iframe（子页面一次都被注入，只有宿主有 Inspector 按钮）
      ctx.injectSelfClient();
      ctx.injectAllIframes();
      ctx.watchIframes(); // 持续监听动态添加的 iframe
      }

  ctx.injectSelfClient = function () {
      if (ctx.selfClient) return;
      var fn = new Function('__DBG_POST__', MINI_DBG_CLIENT.replace('__DBG_VERSION__', VERSION));
      fn(function (msg) { ctx.handleClientMessage(msg, 'self'); }); // self client 的消息直接走宿主统一处理
      ctx.selfClient = window.__dbg; // client 执行后 window.__dbg 即宿主页实例
      }

  ctx.injectOneIframe = function (f) {
      if (f === ctx.aiIframe) return;
      if (f.__dbgWatched) return; // 防重复绑定 load
      f.__dbgWatched = true;
      try {
        var doc = f.contentDocument;
        // 无论当前状态都绑定 load：iframe 导航（src 加载）会替换文档，需重新注入 + 重新 observe
        f.addEventListener('load', function () { this.__dbgWatched = false; ctx.injectOneIframe(this); });
        if (!doc || !doc.defaultView || !doc.body) return;
        if (!doc.defaultView.__dbg) {
          var s = doc.createElement('script');
          s.textContent = MINI_DBG_CLIENT.replace('__DBG_VERSION__', VERSION);
          doc.body.appendChild(s);
        }
        ctx.observeDoc(doc); // 链式：观察该 iframe 内部文档，新增子 iframe 自动注入
        ctx.injectAllIframes(doc); // 递归：该 iframe 的子页面
        ctx.sendAiBoot(); // 帧树变化 → 重发 boot（AI 窗下拉刷新 + /bridge/ai/frames 同步）
        ctx.sendAiBoot(); // 帧树变化 → 重发 boot（AI 窗下拉刷新）
      } catch (e) { /* 跨域 iframe 跳过 */ }
      }

  ctx.injectAllIframes = function (rootDoc) {
      rootDoc = rootDoc || document;
      var frames = rootDoc.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) ctx.injectOneIframe(frames[i]);
      }

  ctx.observeDoc = function (doc) {
      if (!doc || doc.__dbgObserved) return;
      doc.__dbgObserved = true;
      var obs = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          for (var i = 0; i < m.addedNodes.length; i++) {
            var n = m.addedNodes[i];
            if (!n || n.nodeType !== 1) continue;
            var frames = (n.tagName === 'IFRAME') ? [n] : (n.querySelectorAll ? n.querySelectorAll('iframe') : []);
            for (var j = 0; j < frames.length; j++) {
              ctx.injectOneIframe(frames[j]);
              try { ctx.observeDoc(frames[j].contentDocument); } catch (e) {} // 链式：观察其内部文档
            }
          }
        });
      });
      obs.observe(doc, { childList: true, subtree: true });
      ctx.iframeObservers.push(obs);
      }

  ctx.watchIframes = function () { ctx.observeDoc(document);   }

  ctx.enterSelfClient = function (mode) { ctx.injectSelfClient(); if (ctx.selfClient) ctx.selfClient.enterInspector(mode);   }

  ctx.exitSelfClient = function () {
      try {
        var sc = ctx.selfClient || window.__dbg; // selfClient 变量可能因 launcher 重建不同步，兜底用 window.__dbg
        if (sc && typeof sc.exitInspector === 'function') sc.exitInspector();
      } catch (e) {}
      document.body.style.cursor = ''; // finally 语义：无论如何清 cursor（防止残留 crosshair 拦截宿主点击）
      }
}
