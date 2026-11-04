/**
 * aiti-client-opencode.js · opencode web UI 的 aiti-devtools AI 窗适配层（浏览器端，vanilla DOM）
 *
 * 加载方式（不 fork web UI）：nginx 反代 sub_filter 往 HTML 壳注入本脚本（桥 /aiti/ 下 serve）；
 * 也可油猴/evaluate 手动注入（测试）。桥地址 = window.__AITI_BRIDGE__ || 脚本 data-bridge || http://127.0.0.1:8777
 *
 * 职责（对齐 pi-web aiti-client / DSH client，协议层复用桥资产 host-protocol.js/bridge-client.js/cdp-core.js）：
 *   1. 连桥 role=ai（onInteraction 本地渲染交互卡；onEvent aiti_consumed 清候选 / user_answer 转候选）
 *   2. 候选条（composer 上方，MutationObserver 保持挂载）：chip = 占位符区 + 描述区（详情弹窗）+ ✕；清空
 *   3. 点候选 → composer（contenteditable）插入短占位符 [元素N]/[回答N]/[错误N]（execCommand insertText）
 *   4. 候选变化 → POST {bridge}/aiti/bridge/picked（{tag,describe,pageId}[]）——插件 messages.transform 消费
 *   5. onEvent 'aiti_consumed'（插件替换成功权威信号）→ 清候选 + 摘 composer 占位符
 *
 * 与 DSH 版差异：无框架 slot——候选条/详情/交互卡全部 body 挂 fixed 层（React SPA 树外，无重渲染冲突）；
 * composer 是 contenteditable（非 textarea），插入用 execCommand。
 */
(function () {
  'use strict';
  if (window.__AITI_OC_CLIENT__) return; // 幂等
  window.__AITI_OC_CLIENT__ = true;

  // ---- 配置：桥地址（优先级：注入方覆盖 > 脚本 data-bridge > 脚本自身 src（同源 /aiti/ 部署）> 默认）----
  // 同源部署（nginx vhost 把 /aiti/ 反代到桥）：脚本从 <origin>/aiti/ 加载 → BASE = <origin>/aiti，
  // 无需任何配置（CSP 由反代剥离）。
  var SCRIPT = document.currentScript;
  function baseFromSrc() {
    // 返回【桥根】（不含 /aiti）：脚本 src 的 pathname 含 /aiti/ 前缀 → 桥根 = origin（同源反代场景）
    try {
      var src = SCRIPT && SCRIPT.src && new URL(SCRIPT.src, location.href);
      if (src && /(^|\/)aiti\//.test(src.pathname.replace(/^\//, ''))) {
        return src.origin; // 同源：origin 即桥根（nginx/proxy 把 /aiti/ 反代到桥）
      }
    } catch (e) {}
    return null;
  }
  var BRIDGE = window.__AITI_BRIDGE__ || (SCRIPT && SCRIPT.dataset.bridge) || baseFromSrc() || 'http://127.0.0.1:8777';
  // BRIDGE 统一视为桥根：已以 /aiti 结尾的不再追加（兼容显式传全路径的场景）
  var BASE = /\/aiti$/.test(String(BRIDGE).replace(/\/+$/, '')) ? String(BRIDGE).replace(/\/+$/, '') : String(BRIDGE).replace(/\/+$/, '') + '/aiti';

  // ---- AI 窗标记（防 launcher 嵌套自毁；本页即 AI 窗，无条件置位）----
  try { window.__AITI_AI_WIN__ = true; } catch (e) {}

  // ---- 样式（一次性注入）----
  if (!document.getElementById('aiti-oc-style')) {
    var st = document.createElement('style');
    st.id = 'aiti-oc-style';
    st.textContent = [
      '.aiti-oc-bar{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 10px;font-size:12px;border-radius:10px 10px 0 0;background:rgba(30,30,30,.92);border:1px solid rgba(255,255,255,.14);border-bottom:none;color:#eee;box-shadow:0 -2px 12px rgba(0,0,0,.25);backdrop-filter:blur(6px);max-width:min(720px,92vw)}',
      '.aiti-oc-chip{display:inline-flex;align-items:center;max-width:100%;background:rgba(80,140,255,.16);border:1px solid rgba(120,160,255,.35);border-radius:6px;padding:1px 2px 1px 0;white-space:nowrap;overflow:hidden}',
      '.aiti-oc-chip.err{background:rgba(255,80,80,.14);border-color:rgba(255,120,120,.4)}',
      '.aiti-oc-tag{padding:0 6px;font-weight:600;cursor:pointer;border-right:1px dashed rgba(255,255,255,.2);user-select:none;flex-shrink:0}',
      '.aiti-oc-tag:hover{text-decoration:underline}',
      '.aiti-oc-desc{padding:0 4px;cursor:pointer;color:#bbb;max-width:220px;text-overflow:ellipsis;overflow:hidden;flex-shrink:1}',
      '.aiti-oc-desc:hover{color:#fff;text-decoration:underline}',
      '.aiti-oc-x{background:none;border:none;color:#999;cursor:pointer;padding:0 3px;font-size:12px;line-height:1}',
      '.aiti-oc-x:hover{color:#ff6b6b}',
      '.aiti-oc-clear{margin-left:auto;padding:1px 8px;font-size:11px;border-radius:4px;cursor:pointer;color:#ff8888;background:transparent;border:1px solid rgba(255,255,255,.18)}',
      '.aiti-oc-clear:hover{background:rgba(255,80,80,.15)}',
      '.aiti-oc-overlay{position:fixed;inset:0;z-index:2147483100;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}',
      '.aiti-oc-dialog{width:400px;max-width:92vw;max-height:80vh;overflow:auto;padding:14px;border-radius:10px;background:#242424;border:1px solid rgba(255,255,255,.15);color:#eee;box-shadow:0 8px 30px rgba(0,0,0,.4);font-size:12px}',
      '.aiti-oc-row{display:flex;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.08);align-items:center;border-radius:4px}',
      '.aiti-oc-row:hover{background:rgba(255,255,255,.06)}',
      '.aiti-oc-rowk{color:#9c9;min-width:64px;font-weight:600;flex-shrink:0}',
      '.aiti-oc-rowv{flex:1;word-break:break-all;font-family:ui-monospace,monospace}',
      '.aiti-oc-ixwrap{position:fixed;right:14px;bottom:14px;z-index:2147483200;display:flex;flex-direction:column;gap:8px;max-width:360px}',
      '.aiti-oc-ixcard{background:#242424;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px 12px;color:#eee;box-shadow:0 6px 24px rgba(0,0,0,.4);font-size:12px}',
      '.aiti-oc-ixk{font-weight:700;font-size:12px;margin-bottom:4px}',
      '.aiti-oc-ixp{margin:2px 0 8px;color:#ccc;white-space:pre-wrap}',
      '.aiti-oc-btn{background:rgba(80,140,255,.25);border:1px solid rgba(120,160,255,.4);color:#fff;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;margin:2px 4px 2px 0}',
      '.aiti-oc-btn:hover{background:rgba(80,140,255,.4)}',
      '.aiti-oc-btn.ghost{background:transparent;border-color:rgba(255,255,255,.2);color:#aaa}',
      '.aiti-oc-btn.ghost:hover{background:rgba(255,255,255,.08)}',
      '.aiti-oc-ixinput{background:#1a1a1a;border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#eee;padding:4px 8px;font-size:12px;min-width:140px}',
    ].join('\n');
    document.head.appendChild(st);
  }

  // ---- host-protocol / bridge-client / cdp-core 加载（window 全局）----
  var hp = null;          // AitiHostProtocol 实例
  var pickedElements = [];
  function loadScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src; s.onload = function () { resolve(true); }; s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }
  function assetUrl(f) { return BASE + '/' + f; }

  // ---- composer（contenteditable）操作 ----
  function composer() { return document.querySelector('form [contenteditable="true"], [contenteditable="true"]'); }
  function insertComposerText(text, append) {
    try {
      var ce = composer(); if (!ce || !text) return false;
      ce.focus();
      var cur = (ce.textContent || '');
      if (cur.indexOf(text) >= 0) return true; // 幂等
      var full = append && cur.trim() ? cur.trim() + ' ' + text : text;
      // 全选替换（append 场景保留原值拼接后整体替换；React 编辑器监听 execCommand 的 input 事件）
      var sel = window.getSelection();
      sel.selectAllChildren(ce);
      document.execCommand('insertText', false, full);
      return true;
    } catch (e) { return false; }
  }
  function stripComposerTags(tags) {
    try {
      var ce = composer(); if (!ce) return;
      var v = ce.textContent || '';
      var next = v;
      (tags || []).forEach(function (t) {
        next = next.split(t).join('').replace(/\s{2,}/g, ' ');
      });
      next = next.trim();
      if (next !== v) { var sel = window.getSelection(); sel.selectAllChildren(ce); document.execCommand('insertText', false, next); }
    } catch (e) {}
  }

  // ---- 候选同步 + 上报（POST /bridge/picked；150ms 防抖）----
  var reportTimer = null;
  // aiti_consumed 已消费的 tag（tombstone：防本地残留候选被再次上报复活）。
  // ⚠ 持久化到 localStorage：AI 窗离线错过 SSE / 刷新后 host-protocol 会从 localStorage 恢复 picked 并上报，
  //   内存 tombstone 拦不住 → 已消费候选复活成僵尸。与 host-protocol 的 picked 持久化同生命周期。
  var CONSUMED_KEY = '__aiti_oc_consumed_tags';
  var consumedTags = (function () {
    try { return JSON.parse(localStorage.getItem(CONSUMED_KEY)) || []; } catch (e) { return []; }
  })();
  function rememberConsumed(tags) {
    tags.forEach(function (t) { if (consumedTags.indexOf(t) < 0) consumedTags.push(t); });
    if (consumedTags.length > 200) consumedTags = consumedTags.slice(-200); // 防无限增长
    try { localStorage.setItem(CONSUMED_KEY, JSON.stringify(consumedTags)); } catch (e) {}
  }

  function reportPickedToHost() {
    if (reportTimer) return;
    reportTimer = setTimeout(function () {
      reportTimer = null;
      try {
        var live = pickedElements.filter(function (el) { return consumedTags.indexOf(el.tag) < 0; });
        if (live.length !== pickedElements.length) { pickedElements = live; renderBar(); }
        var pageId = null;
        for (var i = 0; i < pickedElements.length; i++) if (pickedElements[i] && pickedElements[i].pageId) { pageId = pickedElements[i].pageId; break; }
        if (!pageId && hp && hp.hostIdentity) { try { pageId = (hp.hostIdentity() || {}).pageId || null; } catch (e) {} }
        var payload = pickedElements.map(function (el) {
          return { tag: el.tag || '', pageId: el.pageId || pageId, describe: (hp && hp.describe) ? hp.describe(el, el.pageId || pageId) : String(el.tag || '') };
        });
        fetch(BASE + '/bridge/picked', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidates: payload }) }).catch(function () {});
      } catch (e) {}
    }, 150);
  }
  function syncPicked(list) { pickedElements = list || []; renderBar(); reportPickedToHost(); }

  function initHostProtocol() {
    var w = window;
    if (hp || !w.AitiHostProtocol) return hp;
    hp = w.AitiHostProtocol.create({
      onPicked: syncPicked,
      onBoot: function () {},
      insertPlaceholder: function (el) { insertPlaceholder(el); },
      onUserMessage: function (p) {
        if (!p || p.kind !== 'element_instruction' || !p.text) return;
        insertComposerText(String(p.text), true);
      },
      onInspect: function () {},
      onBridgeEvent: function (type, payload, target) {
        try { if (window.BridgeClient) window.BridgeClient.postEvent(type, payload, (target && target.pageId) || null); } catch (e) {}
      },
    });
    window.__aitiOcHp = hp;
    return hp;
  }

  function insertPlaceholder(el) {
    var tag = (el && el.tag) || ''; if (!tag) return;
    insertComposerText(tag, true);
  }
  function removeOneCandidate(el) {
    try {
      var ce = composer();
      if (hp && hp.removeCandidate) hp.removeCandidate(el); // 内部 setPicked → syncPicked 重渲染
      if (ce) stripComposerTags([el.tag]);
    } catch (e) {}
  }
  function clearAllCandidates() {
    try {
      var tags = pickedElements.map(function (el) { return el.tag; });
      pickedElements.forEach(function (el) { try { if (hp && hp.removeCandidate) hp.removeCandidate(el); } catch (e) {} });
      if (hp && hp.setPicked) hp.setPicked([]); else syncPicked([]);
      stripComposerTags(tags);
    } catch (e) {}
  }

  // ---- 候选条（fixed 层，贴 composer 上方；MutationObserver 保持/跟随位置）----
  var bar = null, barRAF = 0, barObserver = null;
  function ensureBar() {
    if (bar && document.body.contains(bar)) return bar;
    bar = document.createElement('div');
    bar.className = 'aiti-oc-bar';
    document.body.appendChild(bar);
    if (barObserver) barObserver.disconnect();
    barObserver = new MutationObserver(positionBar);
    barObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    return bar;
  }
  function positionBar() {
    if (!bar) return;
    if (!pickedElements.length) { bar.style.display = 'none'; return; }
    var ce = composer();
    var r = ce ? ce.getBoundingClientRect() : null;
    if (!r || r.width < 40) { // composer 不在（首页/会话列表）→ 贴底居中
      bar.style.display = 'flex';
      bar.style.left = '50%'; bar.style.transform = 'translateX(-50%)';
      bar.style.bottom = '70px'; bar.style.right = 'auto'; bar.style.top = 'auto';
      return;
    }
    bar.style.display = 'flex'; bar.style.transform = 'none';
    var left = Math.max(8, r.left);
    var width = Math.min(r.width, Math.min(720, window.innerWidth * 0.92));
    bar.style.left = left + 'px';
    bar.style.width = width + 'px';
    bar.style.bottom = (window.innerHeight - r.top + 4) + 'px';
    bar.style.top = 'auto'; bar.style.right = 'auto';
  }
  function briefText(el) {
    try {
      if (hp && hp.brief) return hp.brief(el);
      if (el && el.kind === 'error') return '⚠ ' + String(el.message || '');
      if (el && el.kind === 'answer') return '💬 ' + String(el.answer || '').slice(0, 40);
      return '<' + (el && el.tag ? String(el.tag).replace(/[\[\]]/g, '') : '?') + '>';
    } catch (e) { return '<' + ((el && el.tag) || '?') + '>'; }
  }
  function renderBar() {
    var b = ensureBar();
    b.innerHTML = '';
    if (!pickedElements.length) { b.style.display = 'none'; return; }
    pickedElements.forEach(function (el, i) {
      var tag = (el && el.tag) || (el.kind === 'answer' ? '[回答' + (i + 1) + ']' : el.kind === 'error' ? '[错误' + (i + 1) + ']' : '[元素' + (i + 1) + ']');
      var chip = document.createElement('span');
      chip.className = 'aiti-oc-chip' + (el && el.kind === 'error' ? ' err' : '');
      var t1 = document.createElement('span'); t1.className = 'aiti-oc-tag'; t1.textContent = tag;
      t1.title = '点击：输入框补占位符（不弹详情）';
      t1.onclick = function (e) { e.stopPropagation(); insertPlaceholder(el); };
      var t2 = document.createElement('span'); t2.className = 'aiti-oc-desc'; t2.textContent = briefText(el);
      t2.title = '点击：补占位符 + 查看详情';
      t2.onclick = function (e) { e.stopPropagation(); insertPlaceholder(el); openDetail(i); };
      var x = document.createElement('button'); x.className = 'aiti-oc-x'; x.textContent = '✕';
      x.title = '清除该候选（同步删输入框里的 ' + tag + '）';
      x.onclick = function (e) { e.stopPropagation(); removeOneCandidate(el); };
      chip.appendChild(t1); chip.appendChild(t2); chip.appendChild(x);
      b.appendChild(chip);
    });
    var clear = document.createElement('button'); clear.className = 'aiti-oc-clear'; clear.textContent = '清空';
    clear.onclick = function (e) { e.stopPropagation(); clearAllCandidates(); };
    b.appendChild(clear);
    positionBar();
  }
  // 位置跟随（事件驱动：scroll/resize → rAF 节流；DOM 布局变化由 ensureBar 的 MutationObserver 兜住）
  var barRAFPending = false;
  function schedulePositionBar() {
    if (!bar || !pickedElements.length || barRAFPending) return;
    barRAFPending = true;
    requestAnimationFrame(function () { barRAFPending = false; positionBar(); });
  }
  window.addEventListener('scroll', schedulePositionBar, true); // capture：捕获内部滚动容器
  window.addEventListener('resize', schedulePositionBar);

  // ---- 详情弹窗（fixed overlay → body）----
  var FIELD_LABELS = [['tag', '标签'], ['text', '文本'], ['xpath', 'xpath'], ['selector', 'selector'], ['rect', '尺寸'], ['docRect', '文档位置'], ['attributes', '属性'], ['computed', '样式'], ['framework', '框架'], ['component', '组件'], ['file', '组件源码'], ['usedAt', '调用位置'], ['frame', '页面']];
  function openDetail(idx) {
    var el = pickedElements[idx]; if (!el) return;
    closeDetail();
    var ov = document.createElement('div'); ov.className = 'aiti-oc-overlay'; ov.id = 'aiti-oc-detail';
    ov.onclick = function (e) { if (e.target === ov) closeDetail(); };
    var dlg = document.createElement('div'); dlg.className = 'aiti-oc-dialog';
    dlg.onclick = function (e) { e.stopPropagation(); };
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px';
    var title = document.createElement('b'); title.textContent = (el.tag || '') + ' 详情'; title.style.fontSize = '13px';
    var closeBtn = document.createElement('button'); closeBtn.className = 'aiti-oc-btn ghost'; closeBtn.textContent = '✕ 关闭'; closeBtn.onclick = closeDetail;
    head.appendChild(title); head.appendChild(closeBtn); dlg.appendChild(head);
    // 信息行（host-protocol detailRows）
    var rowsEl = document.createElement('div'); rowsEl.style.marginBottom = '10px';
    try {
      var pid = null;
      for (var i = 0; i < pickedElements.length; i++) if (pickedElements[i] && pickedElements[i].pageId) { pid = pickedElements[i].pageId; break; }
      var rows = (hp && hp.detailRows) ? (hp.detailRows(el, pid) || []) : [];
      rows.forEach(function (kv) {
        var r = document.createElement('div'); r.className = 'aiti-oc-row';
        var k = document.createElement('span'); k.className = 'aiti-oc-rowk'; k.textContent = String(kv[0]);
        var v = document.createElement('code'); v.className = 'aiti-oc-rowv'; v.textContent = String(kv[1]);
        r.appendChild(k); r.appendChild(v);
        // 文件行：后台打开（经桥 open_file）
        var fi = (hp && hp.rowFileInfo) ? (hp.rowFileInfo(el, kv[0]) || {}) : {};
        if (fi && fi.file) {
          var ob = document.createElement('button'); ob.className = 'aiti-oc-btn ghost'; ob.textContent = '📂 后台打开';
          ob.title = '经桥在后台打开（编辑器由 AITI_OPEN_CMD 环境变量指定，无则系统默认）';
          ob.onclick = function () { try { if (window.BridgeClient) window.BridgeClient.postEvent('open_file', { file: fi.file, line: fi.line }); } catch (e) {} };
          r.appendChild(ob);
        }
        rowsEl.appendChild(r);
      });
    } catch (e) {}
    dlg.appendChild(rowsEl);
    // 字段筛选（元素候选；错误候选给提示）
    if (el.kind === 'error') {
      var p = document.createElement('p'); p.style.cssText = 'margin:8px 0;color:#999';
      p.textContent = '发送时 [错误N] 替换为完整错误详情（类型/消息/堆栈/时间）。';
      dlg.appendChild(p);
    } else {
      var ft = document.createElement('div'); ft.style.borderTop = '1px solid rgba(255,255,255,.1)';
      ft.style.cssText += 'padding:8px 0';
      var fp = document.createElement('p'); fp.style.cssText = 'margin-bottom:6px;color:#bbb'; fp.textContent = '发送给 AI 的字段（勾选）：';
      ft.appendChild(fp);
      if (!el.include) el.include = {};
      var fwrap = document.createElement('div'); fwrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px 12px';
      FIELD_LABELS.forEach(function (fl) {
        var lab = document.createElement('label'); lab.style.cssText = 'display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#bbb';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = el.include[fl[0]] !== false;
        cb.onchange = function () {
          el.include[fl[0]] = cb.checked;
          if (hp && hp.setPicked) hp.setPicked(pickedElements.slice()); else syncPicked(pickedElements.slice());
        };
        lab.appendChild(cb); lab.appendChild(document.createTextNode(fl[1]));
        fwrap.appendChild(lab);
      });
      ft.appendChild(fwrap); dlg.appendChild(ft);
    }
    ov.appendChild(dlg); document.body.appendChild(ov);
  }
  function closeDetail() { var d = document.getElementById('aiti-oc-detail'); if (d) d.remove(); }

  // ---- 交互卡（confirm/choose/input/presence/pick_element；notify 只浮提示）----
  var ixWrap = null; var ixCards = new Map();
  function ensureIxWrap() {
    if (ixWrap && document.body.contains(ixWrap)) return ixWrap;
    ixWrap = document.createElement('div'); ixWrap.className = 'aiti-oc-ixwrap';
    document.body.appendChild(ixWrap);
    return ixWrap;
  }
  function describeAnswer(kind, result) {
    var r = result || {};
    if (r.status === 'rejected') return '✋ 拒绝' + (r.reason ? '：' + r.reason : '');
    if (r.status === 'timeout') return '⏱ 超时（用户无响应）';
    if (r.status === 'error') return '⚠ ' + (r.error || '出错');
    if (kind === 'confirm') return r.approved === false ? '❌ 否' : '✅ 是';
    if (kind === 'choose') { var v = r.value || {}; return (v.custom || v.index === -1) ? '✍️ 都不适合' : String(v.label != null ? v.label : v.index); }
    if (kind === 'input') return String((r.value || {}).text || '');
    if (kind === 'presence') return r.present === false ? '⏳ 稍后' : '🙋 我在';
    if (kind === 'pick_element') { var el = r.result || {}; return '🎯 <' + (el.tag || '?') + '>' + (el.text ? ' ' + String(el.text).trim().slice(0, 30) : ''); }
    return '✅ 已作答';
  }
  function answerInteraction(rid, result) {
    try { window.BridgeClient.postResult(rid, true, result, null); } catch (e) {}
    finishIx(rid, result);
  }
  function finishIx(rid, result) {
    var card = ixCards.get(rid);
    if (!card) return;
    if (card.__timer) clearTimeout(card.__timer);
    if (card.parentNode) card.parentNode.removeChild(card);
    ixCards.delete(rid);
  }
  function renderInteraction(m) {
    var it = (m && m.interaction) || {};
    var rid = m && m.requestId;
    if (!rid || ixCards.has(rid)) return;
    if (it.kind === 'notify') { toastNotify(it); return; }
    var w = ensureIxWrap();
    var card = document.createElement('div'); card.className = 'aiti-oc-ixcard';
    var kindLabel = ({ confirm: '❓ 确认', choose: '🔀 选择', input: '⌨️ 输入', pick_element: '🖱️ 点选', presence: '🙋 在场' })[it.kind] || it.kind || '?';
    var agentLabel = it.agentId || m.agentId || '';
    var k = document.createElement('div'); k.className = 'aiti-oc-ixk';
    k.textContent = kindLabel + (agentLabel ? ' · from ' + agentLabel : '');
    var p = document.createElement('div'); p.className = 'aiti-oc-ixp'; p.textContent = it.prompt || '';
    var row = document.createElement('div'); row.style.marginTop = '4px';
    function mkBtn(text, cls, fn) {
      var b = document.createElement('button'); b.className = 'aiti-oc-btn' + (cls ? ' ' + cls : ''); b.textContent = text; b.onclick = fn; row.appendChild(b); return b;
    }
    if (it.kind === 'confirm') {
      mkBtn('✅ 是', '', function () { answerInteraction(rid, { status: 'answered', approved: true }); });
      mkBtn('❌ 否', '', function () { answerInteraction(rid, { status: 'answered', approved: false }); });
      mkBtn('都不适合', 'ghost', function () { answerInteraction(rid, { status: 'answered', approved: null, custom: true }); });
    } else if (it.kind === 'choose') {
      (it.choices || []).forEach(function (c, i2) { mkBtn(String(c), '', function () { answerInteraction(rid, { status: 'answered', value: { index: i2, label: String(c) } }); }); });
      if (it.rejectable !== false) mkBtn('这些都不适合', 'ghost', function () { answerInteraction(rid, { status: 'answered', value: { index: -1, custom: true } }); });
    } else if (it.kind === 'input') {
      var inp = document.createElement('input'); inp.className = 'aiti-oc-ixinput'; inp.placeholder = it.defaultValue || '输入…';
      var sb = document.createElement('button'); sb.className = 'aiti-oc-btn'; sb.textContent = '发送';
      sb.onclick = function () { answerInteraction(rid, { status: 'answered', value: { text: inp.value } }); };
      inp.onkeydown = function (e) { if (e.key === 'Enter') sb.onclick(); };
      row.appendChild(inp); row.appendChild(sb);
      if (it.rejectable !== false) mkBtn('暂时无法处理', 'ghost', function () { answerInteraction(rid, { status: 'rejected', reason: 'user rejected' }); });
    } else if (it.kind === 'presence') {
      mkBtn('🙋 我在', '', function () { answerInteraction(rid, { status: 'answered', present: true }); });
      mkBtn('稍后', 'ghost', function () { answerInteraction(rid, { status: 'answered', present: false }); });
    } else if (it.kind === 'pick_element') {
      var sp = document.createElement('span'); sp.style.cssText = 'font-size:11px;opacity:.8'; sp.textContent = '请在页面点击元素…';
      row.appendChild(sp);
    }
    if (it.rejectable !== false && ['confirm', 'pick_element'].indexOf(it.kind) >= 0) {
      mkBtn('✋ 拒绝', 'ghost', function () { answerInteraction(rid, { status: 'rejected', reason: 'user rejected' }); });
    }
    var pause = document.createElement('button'); pause.className = 'aiti-oc-btn ghost'; pause.textContent = '⏸'; pause.title = '暂停/继续倒计时';
    pause.onclick = function () { try { window.BridgeClient.postInteraction(rid, 'pause'); } catch (e) {} pause.textContent = '▶'; pause.onclick = function () { try { window.BridgeClient.postInteraction(rid, 'resume'); } catch (e) {} pause.textContent = '⏸'; }; };
    row.appendChild(pause);
    card.appendChild(k); card.appendChild(p); card.appendChild(row);
    // 超时自动移除（服务器 ~60s 强制结算；事件流会送 timeout 结果——这里兜底 75s）
    card.__timer = setTimeout(function () { finishIx(rid, { status: 'timeout' }); }, 75000);
    w.appendChild(card);
    ixCards.set(rid, card);
  }
  function toastNotify(it) {
    var w = ensureIxWrap();
    var card = document.createElement('div'); card.className = 'aiti-oc-ixcard';
    var k = document.createElement('div'); k.className = 'aiti-oc-ixk'; k.textContent = '🔔 通知' + (it.title ? ' · ' + it.title : '');
    var p = document.createElement('div'); p.className = 'aiti-oc-ixp'; p.textContent = it.body || it.prompt || '';
    card.appendChild(k); card.appendChild(p); w.appendChild(card);
    setTimeout(function () { card.remove(); }, 8000);
  }

  // ---- 作答回传转发（launcher 嵌套时 HUD 卡回传经本窗中转；独立窗时本地卡已直答）----
  function launcherHost() {
    if (window.opener && !window.opener.closed) return window.opener;
    if (window.parent !== window) return window.parent;
    return null;
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.__dbg !== 1) return;
    if (m.type === 'dbg_mcp_result' && !m._aiBridge) {
      var p1 = m.payload || {};
      if (p1.requestId && window.BridgeClient) window.BridgeClient.postResult(p1.requestId, p1.ok !== false, p1.result);
    } else if (m.type === 'dbg_mcp_interaction_control') {
      var p2 = m.payload || {};
      if (p2.requestId && window.BridgeClient) window.BridgeClient.postInteraction(p2.requestId, p2.action);
    }
  });

  // ---- 连桥 ----
  function connectBridge() {
    var w = window;
    if (w.BridgeClient && w.BridgeClient.isConnected && w.BridgeClient.isConnected()) return;
    return loadScript(assetUrl('bridge-client.js')).then(function (ok) {
      if (!ok || !w.BridgeClient) { console.error('[aiti-oc] bridge-client.js 加载失败（' + BASE + '）'); return; }
      var common = (hp && hp.bridgeConnectParams) ? hp.bridgeConnectParams() : { role: 'ai', token: 'dev', useForward: true };
      w.BridgeClient.connect(Object.assign({
        base: BASE,
        onStatus: function () {},
        onReady: function () {
          try { hp.resetAiPageReport && hp.resetAiPageReport(); hp.reportAiPage && hp.reportAiPage(BASE); } catch (e) {}
          try { hp.resetSelfPageReport && hp.resetSelfPageReport(); hp.reportSelfPage && hp.reportSelfPage(BASE); } catch (e) {}
          try { hp.reportActive && hp.reportActive(BASE); } catch (e) {}
        },
        onExec: function () {},
        onInteraction: function (m) {
          // 嵌套（launcher iframe/popup）时优先转发给 launcher HUD 渲染；独立窗本地渲染
          var lh = launcherHost();
          if (lh) { try { lh.postMessage({ __dbg: 1, type: 'dbg_mcp_interaction', payload: { requestId: m.requestId, interaction: m.interaction } }, '*'); } catch (e) {} }
          renderInteraction(m); // 本地也渲染（独立窗唯一 UI；嵌套时双渲染可接受，作答幂等）
        },
        onResult: function (m) {
          var lh = launcherHost();
          if (lh) { try { lh.postMessage({ __dbg: 1, _aiBridge: 1, type: 'dbg_mcp_result', payload: { requestId: m.requestId, ok: m.ok, result: m.result } }, '*'); } catch (e) {} }
        },
        onEvent: function (m) {
          var evName = typeof m === 'string' ? m : (m && (m.event || m.type)) || '';
          if (evName === 'aiti_consumed') {
            var tags = (m && m.payload && Array.isArray(m.payload.tags)) ? m.payload.tags.map(String) : null;
            rememberConsumed(tags && tags.length ? tags : pickedElements.map(function (x) { return x.tag; })); // 无 tags 兑底：全记
            clearAllCandidates();
            return;
          }
          if (!m || m.type !== 'user_answer') return;
          var pv = m.payload || {};
          if (pv.status === 'answered') {
            var cand = { kind: pv.kind || 'answer', answer: String(pv.answer || '').trim() };
            if (!cand.answer) return;
            var dup = pickedElements.some(function (x) { return x.answer === cand.answer; });
            if (!dup) {
              var next = pickedElements.concat([cand]);
              if (hp && hp.setPicked) hp.setPicked(next); else syncPicked(next);
              insertPlaceholder(cand);
            }
          }
        },
      }, common));
    });
  }

  // ---- 测试钩子（同 DSH __aitiDshAddCandidate）----
  window.__aitiOcAddCandidate = function (el) {
    try {
      var H = window.__aitiOcHp || hp;
      if (H && H.setPicked) H.setPicked((H.getPicked() || []).concat([el]));
      else syncPicked(pickedElements.concat([el]));
    } catch (e) {}
  };
  window.__aitiOcPicked = function () { return pickedElements; };
  window.__aitiOcInsert = function (tag) { insertComposerText(tag, true); };

  // ---- 候选冷启动恢复（独立标签页 AI 窗）：launcher 开不到本窗（无 postMessage 通道）时，
  //     候选只到桥（launcher 侧上报或其它 AI 窗上报）。连桥后拉一次 /bridge/picked 合并非重复候选。----
  function pullPickedOnce() {
    fetch(BASE + '/bridge/picked').then(function (r) { return r.json(); }).then(function (b) {
      if (!b || !b.ok || !Array.isArray(b.candidates) || !b.candidates.length) return;
      var added = false;
      b.candidates.forEach(function (c) {
        var el = { tag: c.tag || '', kind: (String(c.describe || '').indexOf('⚠') === 0) ? 'error' : 'element', message: String(c.describe || '').replace(/^[^\n]*\n/, '').slice(0, 120), describe: c.describe, pageId: c.pageId };
        if (consumedTags.indexOf(el.tag) >= 0) return; // tombstone：已消费的不再复活
        var dup = pickedElements.some(function (x) { return x.tag === el.tag; });
        if (!dup) { pickedElements.push(el); added = true; }
      });
      if (added) { if (hp && hp.setPicked) hp.setPicked(pickedElements.slice()); else syncPicked(pickedElements.slice()); }
    }).catch(function () {});
  }

  // ---- 启动：host-protocol → 连桥（cdp-core 预载）→ 连上后拉一次候选 ----
  loadScript(assetUrl('host-protocol.js')).then(function (ok) {
    if (!ok || !window.AitiHostProtocol) { console.error('[aiti-oc] host-protocol.js 加载失败（' + BASE + '）'); return null; }
    initHostProtocol();
    try { hp.sendReady(); } catch (e) {}
    void loadScript(assetUrl('cdp-core.js'));
    return connectBridge();
  }).then(function () {
    // 连桥完成后冷启动拉一次桥侧候选（独立窗场景）。
    // ⚠ 不做周期轮询：a) AGENTS 禁轮询；b) 桥侧 picked 由 aiti_consumed 权威清空（core bridge.ts），
    //   周期拉取会在消费竞态窗口内把旧候选复活回本地再上报（僵尸候选死循环）。新候选走 SSE/postMessage。
    setTimeout(pullPickedOnce, 1000);
  });
})();
