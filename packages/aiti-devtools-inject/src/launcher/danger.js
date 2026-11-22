// danger 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { el } from './dom.js';
import { DANGER_COMMANDS, GESTURE_COMMANDS } from './constants.js';
import { dbgMsg } from './protocol.js';
import { makeCardDrag } from './drag.js';
import { getPhysViewport, placePhysPanel } from './viewport.js';
import { t } from './i18n.js';

export function initDanger(ctx) {
  ctx.handleAiCommand = function (p2) {
      var sendResult = function (ok, result) {
        // 结果回桥统一经 AI 窗（dbg_command_result → AI 窗 BridgeClient → POST /bridge/result）；
        // 历史的 dbg_mcp_result 直连回传（宿主 client 代 POST）已随页面直连形态删除
        ctx.postToAi({ type: 'dbg_command_result', payload: { requestId: p2.requestId, cmdHint: p2.cmd, ok: ok, result: result } });
      };
      // 快照（MCP page_snapshot）：返回基础现场（host 侧数据）
      if (p2.cmd === '__snapshot__') {
        var snap = {
          url: location.href.slice(0, 500),
          targetUrl: (function () { var tw = (ctx.listFrames()[0] || {}).win; return tw && tw.location ? tw.location.href.slice(0, 500) : null; })(),
          selected: ctx.lastPayload ? { tag: ctx.lastPayload.tag, xpath: ctx.lastPayload.xpath } : null,
          conditions: { animSpeed: ctx.optState.animSpeed, netDelay: ctx.optState.netDelay, netOffline: ctx.optState.netOffline, darkMode: ctx.optState.darkMode, timeOffsetMs: ctx.optState.timeOffsetMs },
          errors: ctx.errLog.slice(0, 10), // 页面错误（client 捕获 window.error/unhandledrejection/console.error——含 Vue/React/Next 框架错误）
        };
        sendResult(true, snap);
        return Promise.resolve({ ok: true, result: snap });
      }
      // 浏览器受限操作：弹手势卡，用户真实点击后才执行（transient activation 有时效，每次都要点）
      if (GESTURE_COMMANDS[p2.cmd]) {
        return new Promise(function (resolve) {
          ctx.showGestureCard(p2, function () {
            // 手势完成（宿主有 transient activation）：Browser 命令在宿主执行，否则 target iframe 内无手势会被浏览器拒绝
            var hostResult = ctx.execBrowserInHost(p2.cmd, p2.args);
            if (hostResult) {
              hostResult.then(function (r) {
                sendResult(!r.error, r);
                resolve({ ok: !r.error, result: r });
              });
            } else {
              ctx.execInPage(p2.cmd, p2.args, ctx.frameIdOf(p2.frameId)).then(function (result) {
                sendResult(result.ok, result.result);
                resolve(result);
              });
            }
          }, function () {
            sendResult(false, { error: t('User cancelled the gesture ') + p2.cmd });
            resolve({ ok: false, result: { error: t('User cancelled ') + p2.cmd } });
          });
        });
      }
      // 截屏：显式拦截进 launcher 截屏卡流程（意图卡→可先调整页面→预览确认）——
      //   不在 gesture/danger 列表（页面渲染无需手势）；不拦会漏到 client 同名旧实现（无手势直接 getDisplayMedia → 被拒）
      if (p2.cmd === 'Page.captureScreenshot') {
        return Promise.resolve(ctx.execBrowserInHost(p2.cmd, p2.args)).then(function (r) {
          sendResult(!r.error, r);
          return { ok: !!(r && !r.error), result: r };
        });
      }
      if (DANGER_COMMANDS[p2.cmd] && !ctx.sessionDangerOk) {
        return new Promise(function (resolve) {
          ctx.dangerQueue.push({ p2: p2, resolve: resolve });
          ctx.pumpDangerQueue();
        });
      }
      return ctx.execInPage(p2.cmd, p2.args, ctx.frameIdOf(p2.frameId)).then(function (result) {
        sendResult(result.ok, result.result);
        return result;
      });
      }

  ctx.execBrowserInHost = function (cmd, args) {
      args = args || {};
      if (cmd === 'Browser.copy') {
        return navigator.clipboard.writeText(String(args.text || '')).then(
          function () { return { copied: true }; },
          function (e) { return { error: t('Copy failed: ') + String((e && e.message) || e) }; }
        );
      }
      if (cmd === 'Browser.download') {
        var a = document.createElement('a');
        a.href = args.dataUrl || ('data:text/plain,' + encodeURIComponent(String(args.text || '')));
        a.download = args.name || 'dbg-download.txt';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return Promise.resolve({ downloaded: a.download });
      }
      if (cmd === 'Browser.openWindow') {
        var w = window.open(args.url || 'about:blank', '_blank');
        return Promise.resolve(w ? { opened: true } : { error: t('Popup blocked') });
      }
      // 读剪贴板（同性质受限操作：需 activation + clipboard-read 权限；Chrome 可能再弹一次授权——双重确认）
      if (cmd === 'Browser.paste') {
        if (!(navigator.clipboard && navigator.clipboard.readText)) {
          return Promise.resolve({ error: t('Clipboard read not supported in this browser (no navigator.clipboard.readText)') });
        }
        return navigator.clipboard.readText().then(
          function (text) { return { text: String(text || '').slice(0, 100000) }; },
          function (e) { return { error: t('Clipboard read denied (needs clipboard-read permission): ') + String((e && e.message) || e) }; }
        );
      }
      // 文件选择器（同性质：input.click() 需 activation）：小文本文件直接回内容、小图片转 dataUrl，多选回清单
      if (cmd === 'Browser.pickFile') {
        return new Promise(function (resolveP) {
          var inp = document.createElement('input');
          inp.type = 'file';
          if (args.accept) inp.accept = String(args.accept);
          inp.multiple = !!args.multiple;
          inp.style.display = 'none';
          var done2 = false;
          var finish2 = function (r) { if (done2) return; done2 = true; try { inp.remove(); } catch (e2) {} resolveP(r); };
          inp.onchange = function () {
            var files = Array.prototype.slice.call(inp.files || []);
            if (!files.length) return finish2({ error: t('No file selected') });
            var list = files.map(function (f) { return { name: f.name, size: f.size, type: f.type || '' }; });
            var readFirst = files[0];
            var isText = /^text\//.test(readFirst.type) || /\.(txt|md|json|log|csv|xml|ya?ml|ini|conf|js|ts|css|html?|py|java|c|cpp|go|rs|sh|toml)$/i.test(readFirst.name);
            var isImage = /^image\//.test(readFirst.type);
            if (isText && readFirst.size <= 262144) {
              readFirst.text().then(function (t) { finish2({ files: list, name: readFirst.name, text: t.slice(0, 200000) }); }, function () { finish2({ files: list }); });
            } else if (isImage && readFirst.size <= 3145728) {
              var fr = new FileReader();
              fr.onload = function () { finish2({ files: list, name: readFirst.name, dataUrl: String(fr.result).slice(0, 4194304) }); };
              fr.onerror = function () { finish2({ files: list }); };
              fr.readAsDataURL(readFirst);
            } else {
              finish2({ files: list, note: isImage || readFirst.size > 262144 ? t('File too large/non-text: listing only (for large images/files ask the user to upload manually or pick a smaller one)') : '' });
            }
          };
          // 取消选择：change 不触发——用窗口 focus 兄弟事件兑底太脆；180s 超时由桥侧 SLOW 超时收尾
          document.body.appendChild(inp);
          inp.click();
        });
      }
      // 系统分享面板（需 activation）
      if (cmd === 'Browser.share') {
        if (!navigator.share) return Promise.resolve({ error: t('Web Share not supported in this browser (mobile only)') });
        return navigator.share({ title: args.title, text: args.text, url: args.url }).then(
          function () { return { shared: true }; },
          function (e) { return { error: t('Share cancelled/denied: ') + String((e && e.message) || e) }; }
        );
      }
      if (cmd === 'Browser.fullscreen') {
        var fsEl = (function () { var fr = ctx.listFrames()[parseInt(String(ctx.selFrameId()).slice(1), 10) || 0]; return (fr && fr.el) || document.documentElement; })();
        if (fsEl && fsEl.requestFullscreen) {
          return fsEl.requestFullscreen().then(
            function () { return { fullscreen: true }; },
            function (e) { return { error: t('Fullscreen failed: ') + String((e && e.message) || e) }; }
          );
        }
        return Promise.resolve({ error: t('Fullscreen not supported') });
      }
      // 截屏（CDP 同名命令）：优先 getDisplayMedia（桌面 Chrome：弹选择器选屏幕/窗口/标签页）；
      // 设备/浏览器不支持或权限被拒（PAD/平板、iOS Safari 等）→ DOM 兜底（SVG foreignObject 渲染页面 → canvas，无需权限）。
      // 流程：截 → 弹预览图给用户看（确认才发送）→ 用户确认后结果回 AI；兜底不默默用（预览头/Toast 都明示）。
      if (cmd === 'Page.captureScreenshot') {
        var a2 = args || {};
        var maxW2 = a2.maxWidth || 1280;
        var asPng2 = a2.format !== 'jpeg';
        // DOM 兜底截屏：serialize 页面 → SVG foreignObject → Image → canvas（隐藏调试 UI 只截页面本体）
        var domShot = function (note) {
          return new Promise(function (resolveP) {
            try {
              var launcherEl = ctx.root;
              var prevDisplay = launcherEl ? launcherEl.style.display : null;
              if (launcherEl) launcherEl.style.display = 'none';
              var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
              if (vw < 40 || vh < 40) { resolveP({ error: t('DOM screenshot failed (abnormal viewport size ') + vw + '×' + vh + '）' }); return; }
              var xml = new XMLSerializer().serializeToString(document.documentElement);
              // 防御：页面内容里字面的 `</foreignObject>` 会提前截断外层 SVG 解析 → 只转义它（
              // 不能碰 `</svg>`——页面内联 SVG 图标的真实闭合标签会被误转义导致渲染失败，实测踩过）
              xml = xml.replace(/<\/(foreignObject)(\s*>)/gi, '<\\/$1$2');
              var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + vw + '" height="' + vh + '">' +
                '<foreignObject width="100%" height="100%">' + xml + '</foreignObject></svg>';
              // 已知限制：data URL 基址无效 → 页面相对路径图片（src="/x.png"）在 DOM 截图里加载失败（空白）；绝对 URL 正常
              var img = new Image();
              var restore = function () { if (launcherEl) { if (prevDisplay === null) launcherEl.style.removeProperty('display'); else launcherEl.style.display = prevDisplay; } };
              img.onload = function () {
                restore();
                try {
                  var sc = Math.min(1, maxW2 / vw);
                  var c = document.createElement('canvas');
                  c.width = Math.round(vw * sc); c.height = Math.round(vh * sc);
                  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                  var dataUrl = asPng2 ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', a2.quality || 0.72);
                  resolveP({ dataUrl: dataUrl, width: c.width, height: c.height, format: asPng2 ? 'png' : 'jpeg', bytes: Math.round(dataUrl.length * 3 / 4), mode: note || 'dom' });
                } catch (e2) { resolveP({ error: t('DOM screenshot failed: ') + String((e2 && e2.message) || e2) }); }
              };
              img.onerror = function () { restore(); resolveP({ error: t('DOM screenshot failed (page render to SVG errored)') }); };
              img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            } catch (e3) { resolveP({ error: t('DOM screenshot failed: ') + String((e3 && e3.message) || e3) }); }
          });
        };
        // 截一帧（getDisplayMedia 优先；页面保持焦点 4s 无响应（选择器未弹出/卡死）/被拒/不支持 → DOM 兜底；用户在选窗口时不计时）
        // forceDom=true：跳过 getDisplayMedia（不弹原生选择器，不锁浏览器），直接 DOM 重绘截取
        var captureOnce = function (forceDom) {
          if (forceDom) return domShot(t('dom (page re-render mode)'));
          var md = navigator.mediaDevices || {};
          if (typeof md.getDisplayMedia !== 'function') return domShot(t('dom (no getDisplayMedia)'));
          var gm = { video: { frameRate: 10 } }; // 帧率别太低（1fps 首帧迟迟不来），截一帧够用，提高首帧到达速度
          try { if (a2.preferCurrentTab) gm.preferCurrentTab = true; } catch (e3) {}
          return new Promise(function (resG) {
            var done = false;
            // getDisplayMedia 会弹浏览器选择器（选屏幕/窗口/标签页），用户选择期间页面失焦——
            // 超时只在页面保持焦点时累计（选择器未弹出的异常/卡死兜底），用户在选择器里等待/选择不触发超时，
            // 等用户选完（resolve/reject）才确定成败；resolve 与 done 竞态时停流不处理。
            var hangMs = 4000, focusMs = 0, lastTs = Date.now(), hangIv = null;
            var stopHang = function () { if (hangIv) { clearInterval(hangIv); hangIv = null; } };
            hangIv = setInterval(function () {
              var now = Date.now();
              if (document.hasFocus()) focusMs += now - lastTs; // 页面有焦点才累计（选择器打开时无焦点 → 不累计 → 不超时）
              lastTs = now;
              if (focusMs >= hangMs) { stopHang(); if (!done) { done = true; resG({ hang: true }); } }
            }, 300);
            md.getDisplayMedia(gm).then(function (stream) {
              stopHang();
              if (done) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e2) {} return; }
              done = true;
              resG({ stream: stream });
            }, function (e) {
              stopHang();
              if (done) return;
              done = true;
              resG({ gdmError: e });
            });
          }).then(function (g) {
            if (g && g.hang) return domShot(t('dom (getDisplayMedia no picker/no response)'));
            if (g && g.gdmError) return domShot(t('dom (getDisplayMedia denied: ') + String((g.gdmError && g.gdmError.message) || g.gdmError) + '）');
            var stream = g.stream;
            return new Promise(function (resolveP) {
              var settled = false;
              var finish = function (r) { if (settled) return; settled = true; try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e2) {} resolveP(r); };
              var v = document.createElement('video');
              v.muted = true; v.playsInline = true; v.autoplay = true; // muted+autoplay：Chrome 要求静音才能自动播放，否则帧不加载
              // 黑屏修复：loadeddata 只保证数据就绪，帧未必解码可画——旧逻辑 rAF×2 直接 drawImage 常截到黑帧
              // （frameRate 低时首帧迟迟不来）。先 play，轮询等 currentTime>0（帧真正推进）再 rAF 两帧绘制。
              var drawShot = function () {
                try {
                  var vw2 = v.videoWidth || 0, vh2 = v.videoHeight || 0;
                  if (!vw2 || !vh2) return finish({ error: t('Video stream has no frame size') });
                  var sc = Math.min(1, maxW2 / vw2);
                  var c = document.createElement('canvas');
                  c.width = Math.round(vw2 * sc); c.height = Math.round(vh2 * sc);
                  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
                  var dataUrl = asPng2 ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', a2.quality || 0.72);
                  finish({ dataUrl: dataUrl, width: c.width, height: c.height, format: asPng2 ? 'png' : 'jpeg', bytes: Math.round(dataUrl.length * 3 / 4) });
                } catch (e2) { finish({ error: t('Screenshot failed: ') + String((e2 && e2.message) || e2) }); }
              };
              v.onloadeddata = function () {
                v.play().then(function () {
                  var tries = 0;
                  var pollIv = setInterval(function () {
                    if (settled) { clearInterval(pollIv); return; }
                    tries++;
                    if (v.currentTime > 0 && v.readyState >= 2) {
                      clearInterval(pollIv);
                      requestAnimationFrame(function () { requestAnimationFrame(function () { drawShot(); }); });
                    } else if (tries >= 60) { clearInterval(pollIv); finish({ error: t('Video first-frame timeout') }); }
                  }, 50);
                }, function (e2) { finish({ error: t('Video stream playback failed: ') + String((e2 && e2.message) || e2) }); });
              };
              v.onerror = function () { finish({ error: t('Failed to open video stream') }); };
              v.srcObject = stream;
              setTimeout(function () { finish({ error: t('Screenshot timeout (15s)') }); }, 15000);
            });
          });
        };
        // —— 截屏卡片公共壳：右下角浮动小卡（无遮罩不挡页面、可拖动——点选面板/AI 窗同款） ——
        // 物理适配：placePhysPanel 定位（与问答/确认窗同套视觉坐标算法）；makeCardDrag 头部拖拽
        var buildShotCard = function (titleText, srcIt) {
          var card = el('div', { class: 'dbg-pick-dialog' });
          var head = el('div', { class: 'dbg-pick-head' });
          head.appendChild(el('span', { class: 'dbg-pick-title' }, [titleText]));
          var shotSrc = ctx.agentSrcInfoBtn(srcIt); // ⓘ: source block toggled in the card body
          if (shotSrc) {
            head.appendChild(shotSrc);
            shotSrc.addEventListener('click', function (e) {
              e.stopPropagation();
              // body is built after this head (runShotCard) — look it up on the card at click time
              var b = card.querySelector('.dbg-pick-body');
              if (b) ctx.toggleAgentSrcInfo(shotSrc, b, function () { try { placeShotCard(card, card.__shotW); } catch (e2) {} });
            });
          }
          var timerSpan = el('span', { style: 'font-weight:400;color:#93c5fd;font-size:11px;flex-shrink:0;margin-left:auto' }, ['']);
          head.appendChild(timerSpan);
          card.appendChild(head);
          try { makeCardDrag(head, card); } catch (e5) {} // 拖拽（按住头部非按钮）
          return { card: card, timerSpan: timerSpan };
        };
        // 浮动卡定位（右下角，不居中不遮内容）；visW 可指定（预览图更宽）
        var placeShotCard = function (card, wantW) {
          try {
            var vw = Math.round(getPhysViewport().w) || 360;
            var visW = Math.min(wantW || 400, vw - 24);
            placePhysPanel(card, { visW: visW, visX: Math.max(0, vw - visW - 12), dock: 'bottom', gap: 12, offsetY: 64, minH: 40, maxWidth: visW + 'px', overflowY: 'auto', keyboard: false });
            // 高度自适应兜底：placePhysPanel 按测量时刻定高（图片异步解码会量小 → 按钮被压出可视区）——
            // 改 height:auto + maxHeight 封顶，内容始终完整展示；keyboard:false 防 vV resize 重放把定高写回来
            var vh = Math.round((window.visualViewport && window.visualViewport.height) || window.innerHeight) || 800;
            card.style.height = 'auto';
            card.style.maxHeight = Math.max(240, vh - 88) + 'px';
          } catch (e5) {}
        };
        var startShotCountdown = function (timerSpan, ms, fire) {
          var deadline = Date.now() + ms;
          var iv = setInterval(function () {
            var left = Math.max(0, deadline - Date.now());
            timerSpan.textContent = left > 0 ? ('⏱ ' + Math.ceil(left / 1000) + 's') : '';
            if (left <= 0) { clearInterval(iv); fire(); }
          }, 250);
          return function () { if (iv) { clearInterval(iv); iv = null; } };
        };
        // 统一截屏卡：一张卡贯穿全流程（准备→截屏中→预览），意图说明（reason）全程常驻——
        // 避免旧三窗割裂（准备卡→浏览器选择器→预览卡各弹各的）：选完屏幕/窗口后同一张卡直接出预览。
        // 无遮罩不挡页面、头部可拖动；整卡一个倒计时（默认 280s，可 args.timeout 覆盖，覆盖多轮重拍；服务端安全网同步兜底）
        var runShotCard = function (reason) {
          return new Promise(function (resAll) {
            try {
              var ui = buildShotCard(t('📸 AI wants a screenshot'), p2);
              var card = ui.card, timerSpan = ui.timerSpan;
              var body = el('div', { class: 'dbg-pick-body' });
              card.appendChild(body);
              ctx.root.appendChild(card);
              var visW = Math.min(560, (Math.round(getPhysViewport().w) || 560) - 24); // 预览阶段加宽
              placeShotCard(card, 480);
              var done = false, stopCd = null;
              var finishAll = function (r) {
                if (done) return; done = true;
                if (stopCd) stopCd();
                if (card.parentNode) card.parentNode.removeChild(card);
                if (ctx.shotCardCleanup === cleanupHook) ctx.shotCardCleanup = null; // 幂等：只清自己的钩子
                resAll(r);
              };
              // agent 停止/服务端结算 → routing dbg_mcp_result 调用本钩子收卡（否则卡残留到倒计时结束）
              var cleanupHook = function () { finishAll({ error: t('Cancelled (agent stopped)') }); };
              ctx.shotCardCleanup = cleanupHook;
              // 倒计时可选参数：args.timeout（ms）>0 时覆盖（默认 280s 覆盖多轮重拍；服务端安全网同步为 timeout+30s 兜底）
              var shotCdMs = parseInt(a2.timeout, 10) > 0 ? parseInt(a2.timeout, 10) : 280000;
              stopCd = startShotCountdown(timerSpan, shotCdMs, function () { finishAll({ error: t('Screenshot flow timeout (user didn\'t confirm)') }); });
              var clearBody = function () { while (body.firstChild) body.removeChild(body.firstChild); };
              var reasonLine = function () {
                return el('div', { style: 'font-size:12px;color:#e5e7eb;line-height:1.6;background:rgba(79,70,229,.22);border-radius:8px;padding:7px 10px;margin-bottom:8px;word-break:break-all' },
                  ['🎯 ' + (reason || t('(AI gave no capture reason — cancel and ask the AI to retry with a reason)'))]);
              };
              var mkBtns = function (defs) { // defs: [[文本, class, onclick]]；按钮行在 body 内复用 .dbg-pick-body button 基础样式
                var row = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px' });
                defs.forEach(function (d) {
                  var b = el('button', d[3] ? { class: d[1], style: d[3] } : { class: d[1] }, [d[0]]);
                  b.onclick = d[2]; row.appendChild(b);
                });
                return row;
              };
              // 阶段一：准备（展示意图，可先调整页面）。截取方式 = 页面渲染（无任何系统弹窗）——
              //   旧 getDisplayMedia 原生选择器已移除（与本卡重复且模态锁屏，用户明确不要）
              var renderPrepare = function () {
                clearBody();
                body.appendChild(reasonLine());
                body.appendChild(el('div', { style: 'font-size:11px;color:#94a3b8;line-height:1.6' }, [t('Adjust the page to the desired state first: this card doesn\'t block interaction and can be dragged aside by its title bar. Click "Start screenshot" to capture the current viewport directly (page re-render, no system dialogs; the card auto-hides for the shot).')]));
                body.appendChild(mkBtns([
                  [t('✕ Cancel'), 'dbg-pick-cancel', function () { finishAll({ error: t('User cancelled screenshot') }); }],
                  [t('📸 Start screenshot'), 'dbg-pick-ok', function () { shotOnce(); }],
                ]));
                placeShotCard(card, 480);
              };
              // 阶段二：截屏中（页面重绘瞬间完成，此帧基本一闪而过）
              var renderCapturing = function () {
                clearBody();
                body.appendChild(reasonLine());
                body.appendChild(el('div', { style: 'font-size:11px;color:#94a3b8;line-height:1.6' }, [t('⏳ Capturing current viewport…')]));
                placeShotCard(card, 480);
              };
              // 阶段三：预览确认（🔄 重拍回阶段二 / ✕ 取消 / ✅ 发送）；图加载完成后重新量高定位（placePhysPanel 按当时内容量高）
              var renderPreview = function (r) {
                clearBody();
                body.appendChild(reasonLine());
                var isDom = !!(r.mode && r.mode.indexOf('dom') >= 0);
                if (isDom) body.appendChild(el('div', { style: 'font-size:11px;color:#fbbf24;line-height:1.6;background:rgba(251,191,36,.08);border-radius:6px;padding:6px 8px;margin-bottom:6px' }, [t('⚠ DOM-render screenshot: system screen capture unavailable; this re-renders the page — external images/some styles may differ from the real picture.')]));
                var img = el('img', { src: r.dataUrl, style: 'max-width:100%;max-height:52vh;border-radius:8px;object-fit:contain;background:#fff;display:block' });
                body.appendChild(img);
                // 尺寸保障：图片解码完成 + 双 rAF 后都重新量高定位（placePhysPanel 按当时内容量高，图未撑开时会量小定死）
                var replan = function () { if (!done) placeShotCard(card, visW); };
                if (img.decode) img.decode().then(replan, replan);
                img.addEventListener('load', replan);
                if (img.complete) replan();
                requestAnimationFrame(function () { requestAnimationFrame(replan); });
                body.appendChild(mkBtns([
                  [t('🔄 Retake'), 'dbg-pick-cancel', function () { shotOnce(); }],
                  [t('✕ Cancel'), 'dbg-pick-cancel', function () { finishAll({ error: t('User cancelled sending screenshot') }); }],
                  [t('✅ Send'), 'dbg-ask-send', function () { finishAll({ result: r }); }, 'padding:9px 18px;font-size:14px;font-weight:700'],
                ]));
                placeShotCard(card, visW);
              };
              var shotOnce = function () {
                renderCapturing();
                Promise.resolve(captureOnce(true)).then(function (r) {
                  if (!r || r.error || !r.dataUrl) { finishAll(r && r.error ? r : { error: t('Screenshot failed') }); return; }
                  renderPreview(r);
                });
              };
              renderPrepare();
            } catch (e4) { resAll({ error: t('Failed to show screenshot card: ') + String((e4 && e4.message) || e4) }); }
          });
        };
        var runShot = function () { return runShotCard(a2.reason); };
        var shotP = runShot();
        // 用户可见的结果反馈（成功尺寸 / 失败原因）——兜底不默默用：截完明确告知已回退 DOM 渲染截屏
        shotP.then(function (r) {
          try {
            if (r && r.error) {
              ctx.showPickToast(t('❌ Screenshot failed: ') + String(r.error).slice(0, 120), 10000);
            } else if (r && r.dataUrl) {
              var isDom = !!(r.mode && r.mode.indexOf('dom') >= 0);
              var msg = t('✅ Screenshot taken (') + r.width + '×' + r.height + '）';
              if (isDom) {
                var reason = String(r.mode).replace(/^dom[（(]|）\)$/g, '').trim();
                msg = msg + t('<br>⚠ System screen capture unavailable, fell back to DOM-render screenshot') + (reason ? '（' + reason + '）' : '');
                ctx.showPickToast(msg, 9000);
              } else {
                ctx.showPickToast(msg, 5000);
              }
            }
          } catch (e) {}
        });
        return shotP;
      }
      return null; // play 等需目标文档手势，走 target（可能被浏览器拦截，标注降级）
      }

  ctx.showGestureCard = function (p2, onDone, onCancel) {
      if (!ctx.gestureCard) ctx.buildGestureCard();
      ctx.gestureCard.querySelector('.dbg-gesture-note').textContent = GESTURE_COMMANDS[p2.cmd] || t('Browser-restricted action');
      ctx.bindAgentSrcInfoButton(ctx.gestureCard, p2); // ⓘ per-show bind; sourceless payload removes the button
      ctx.gestureCard.querySelector('.dbg-gesture-cmd').textContent = p2.cmd + ' ' + JSON.stringify(p2.args || {});
      ctx.gestureCard.classList.add('dbg-open');
      ctx.gestureCard.querySelector('.dbg-gesture-ok').onclick = function () {
        ctx.gestureCard.classList.remove('dbg-open');
        ctx.addMsg('sys', t('🖱 User clicked to complete gesture: ') + p2.cmd);
        onDone(); // 宿主执行逻辑在 handleAiCommand 手势分支（execBrowserInHost）
      };
      ctx.gestureCard.querySelector('.dbg-gesture-cancel').onclick = function () {
        ctx.gestureCard.classList.remove('dbg-open');
        ctx.addMsg('sys', t('⛔ User cancelled gesture: ') + p2.cmd);
        onCancel();
      };
      }

  ctx.buildGestureCard = function () {
      ctx.gestureCard = el('div', { class: 'dbg-dialog' });
      var card = el('div', { class: 'dbg-dialog-card dbg-confirm-card' });
      var head = el('div', { class: 'dbg-dialog-head' });
      head.appendChild(el('span', {}, [t('🖱 Needs your real click')]));
      card.appendChild(head);
      try { makeCardDrag(head, card); } catch (e) {} // 拖拽（按住头部非按钮）
      var body = el('div', { class: 'dbg-dialog-body' });
      body.appendChild(el('div', { class: 'dbg-confirm-note dbg-gesture-note' }));
      body.appendChild(el('div', { class: 'dbg-gesture-cmd dbg-pv-kv' }));
      body.appendChild(el('div', { style: 'font-size:11px;color:#6b7280' }, [t('Browser requires a user gesture: AI programmatic execution is blocked — click the button below to complete it.')]));
      card.appendChild(body);
      var foot = el('div', { class: 'dbg-dialog-foot' });
      var cancel = el('button', { class: 'dbg-ghost dbg-gesture-cancel' }, [t('✕ Cancel')]);
      var ok = el('button', { class: 'dbg-primary dbg-gesture-ok' }, [t('✅ Click to complete this action')]);
      foot.appendChild(cancel);
      foot.appendChild(ok);
      card.appendChild(foot);
      ctx.gestureCard.appendChild(card);
      ctx.root.appendChild(ctx.gestureCard);
      }

  ctx.pumpDangerQueue = function () {
      if (ctx.confirmingDanger || !ctx.dangerQueue.length) return;
      ctx.confirmingDanger = true;
      var job = ctx.dangerQueue.shift();
      var p2 = job.p2;
      var finish = function (ok, result) {
        ctx.confirmingDanger = false;
        ctx.postToAi({ type: 'dbg_command_result', payload: { requestId: p2.requestId, cmdHint: p2.cmd, ok: ok, result: result } });
        job.resolve({ ok: ok, result: result });
        ctx.pumpDangerQueue(); // 处理队列中的下一个
      };
      ctx.showDangerConfirm(p2, function () {
        ctx.execInPage(p2.cmd, p2.args).then(function (r) { finish(r.ok, r.result); });
      }, function () { finish(false, { error: t('User denied execution ') + p2.cmd }); });
      }

  ctx.showDangerConfirm = function (p2, onAllow, onDeny) {
      if (!ctx.confirmCard) ctx.buildConfirmCard();
      ctx.confirmCard.querySelector('.dbg-confirm-cmd').textContent = p2.cmd + ' ' + JSON.stringify(p2.args || {});
      ctx.confirmCard.querySelector('.dbg-confirm-note').textContent = DANGER_COMMANDS[p2.cmd] || t('Dangerous action');
      ctx.bindAgentSrcInfoButton(ctx.confirmCard, p2); // ⓘ per-show bind; sourceless payload removes the button
      ctx.confirmCard.classList.add('dbg-open');
      var allowBtn = ctx.confirmCard.querySelector('.dbg-allow');
      var denyBtn = ctx.confirmCard.querySelector('.dbg-deny');
      var rememberBox = ctx.confirmCard.querySelector('.dbg-remember');
      // 无人值守自动接受：optState.dangerAutoOkMs>0 时倒计时，超时未点选 → 自动允许执行（等同点「允许执行」，
      // 走完全相同路径）。仅危险命令卡适用——手势类（Browser.copy/粘贴等）浏览器要求真实点击提供 user activation，
      // 程序化自动点无效（会被浏览器拦截），故不支持自动接受。
      var cdEl = ctx.confirmCard.querySelector('.dbg-confirm-countdown');
      var autoMs = parseInt(ctx.optState.dangerAutoOkMs, 10) || 0;
      var timer = null, deadline = 0;
      var stopCountdown = function () { if (timer) { clearTimeout(timer); timer = null; } if (cdEl) cdEl.style.display = 'none'; };
      if (autoMs > 0 && cdEl) {
        deadline = Date.now() + autoMs;
        cdEl.style.display = 'block';
        var tick = function () {
          var left = Math.max(0, deadline - Date.now());
          cdEl.textContent = t('⏳ Unattended: ') + Math.ceil(left / 1000) + t('s then auto-allow (or click the button below)');
          if (left <= 0) { allowBtn.onclick(true); return; } // 自动允许：与人工点击完全同路径
          timer = setTimeout(tick, 250);
        };
        tick();
      } else if (cdEl) { cdEl.style.display = 'none'; }
      allowBtn.onclick = function (auto) {
        stopCountdown();
        ctx.confirmCard.classList.remove('dbg-open');
        if (rememberBox.checked) { ctx.sessionDangerOk = true; ctx.addMsg('sys', t('🔓 Remembered for this session: dangerous commands no longer confirmed one by one (refresh the page to reset).')); }
        ctx.addMsg('sys', (auto ? t('🤖 Auto-allow on timeout (unattended): ') : t('✅ User allowed: ')) + p2.cmd);
        onAllow();
      };
      denyBtn.onclick = function () {
        stopCountdown();
        ctx.confirmCard.classList.remove('dbg-open');
        ctx.addMsg('sys', t('⛔ User denied: ') + p2.cmd);
        onDeny();
      };
      }

  ctx.buildConfirmCard = function () {
      ctx.confirmCard = el('div', { class: 'dbg-dialog' });
      var card = el('div', { class: 'dbg-dialog-card dbg-confirm-card' });
      var head = el('div', { class: 'dbg-dialog-head' });
      head.appendChild(el('span', {}, [t('⚠ Confirm dangerous action')]));
      card.appendChild(head);
      try { makeCardDrag(head, card); } catch (e) {} // 拖拽（按住头部非按钮）
      var body = el('div', { class: 'dbg-dialog-body' });
      body.appendChild(el('div', { class: 'dbg-confirm-note' }));
      body.appendChild(el('div', { class: 'dbg-confirm-cmd dbg-pv-kv' }));
      body.appendChild(el('div', { class: 'dbg-confirm-countdown', style: 'display:none' }));
      var rememberRow = el('label', { class: 'dbg-chk', style: 'align-self:flex-start' }, []);
      var box = el('input', { type: 'checkbox', class: 'dbg-remember' });
      rememberRow.appendChild(box);
      rememberRow.appendChild(document.createTextNode(t('Remember for this session (no per-command confirm)')));
      body.appendChild(rememberRow);
      card.appendChild(body);
      var foot = el('div', { class: 'dbg-dialog-foot' });
      var deny = el('button', { class: 'dbg-ghost dbg-deny' }, [t('✕ Deny')]);
      var allow = el('button', { class: 'dbg-primary dbg-allow' }, [t('✓ Allow')]);
      foot.appendChild(deny);
      foot.appendChild(allow);
      card.appendChild(foot);
      ctx.confirmCard.appendChild(card);
      ctx.root.appendChild(ctx.confirmCard);
      }
}
