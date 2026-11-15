// options 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { el } from './dom.js';
import { isTouchDevice , isSmallScreen , getPhysViewport, capVisW, positionPhysical } from './viewport.js';
import { OPT_KEY, DEFAULT_RELEASE_KEY } from './constants.js';
import { lsGetJSON, lsSetJSON } from './storage.js';
import { t, getLangPref, setLang } from './i18n.js';

export function initOptions(ctx) {
  ctx.loadOptState = function () { return lsGetJSON(OPT_KEY, {});   }

  ctx.saveOptState = function () { lsSetJSON(OPT_KEY, ctx.optState);   }

  ctx.applyOptsToTarget = function () {
      // 阶段 3：选项应用到当前目标（selFrameId）；视口模拟改目标 iframe 宽度（0 = 默认）
      var frameId = ctx.selFrameId();
      ctx.postToFrame(frameId, { type: 'dbg_set_options', payload: { opts: ctx.optState } });
      if (frameId !== ctx.T_HOST) {
        var fr = ctx.listFrames()[parseInt(String(frameId).slice(1), 10) || 0];
        if (fr && fr.el) {
          if (ctx.optState.viewportW > 0) {
            fr.el.style.setProperty('width', ctx.optState.viewportW + 'px', 'important');
            fr.el.style.flex = 'none'; // 防 flex 容器拉伸（hub iframe 是 flex 子项）
          } else {
            fr.el.style.removeProperty('width');
            fr.el.style.flex = '';
          }
        }
      }
      }

  ctx.toggleSpeedPanel = function () {
      if (!ctx.speedPanel) ctx.buildSpeedPanel();
      ctx.speedPanel.classList.toggle('dbg-open');
      // 小屏：贴底全宽 + counter-zoom（视觉尺寸 = CSS 尺寸，字体可读）+ 盖住工具条（参照 AI 窗）
      if (ctx.speedPanel.classList.contains('dbg-open') && isSmallScreen()) {
        var vp = getPhysViewport();
        var visW = capVisW(vp, 0); // 视觉全宽
        var visH = Math.round(vp.h * 0.92); // 视觉高：92% 屏
        ctx.speedPanel.style.width = visW + 'px';
        ctx.speedPanel.style.right = 'auto'; ctx.speedPanel.style.bottom = 'auto'; ctx.speedPanel.style.left = 'auto';
        ctx.speedPanel.style.maxHeight = (visH * vp.scale / vp.scaleY) + 'px'; // CSS maxHeight = 视觉高换算
        ctx.speedPanel.style.borderRadius = '14px 14px 0 0';
        ctx.speedPanel.style.zIndex = '2147483648'; // 盖住工具条（2147483647）
        positionPhysical(ctx.speedPanel, 0, Math.max(0, vp.h - visH), vp.scale, vp.scaleY); // 贴底 + counter-zoom
      }
      }

  ctx.buildSpeedPanel = function () {
      ctx.speedPanel = el('div', { class: 'dbg-speed' });
      var head = el('div', { class: 'dbg-speed-head' });
      head.appendChild(el('span', {}, [t('⏱ Timing / 🌐 Network / ⚠ Errors')]));
      var hClose = el('button', {}, ['✕']);
      hClose.addEventListener('click', function () { ctx.speedPanel.classList.remove('dbg-open'); });
      head.appendChild(hClose);
      ctx.speedPanel.appendChild(head);

      var body = el('div', { class: 'dbg-speed-body' });

      // 网络模拟（fetch/XHR 延迟与离线）
      var rowNet = el('div', { class: 'dbg-speed-row' });
      rowNet.appendChild(el('label', {}, [t('Network throttle')]));
      var netBtns = el('div', { class: 'dbg-seg', 'data-opt': 'net' });
      [[0, t('Normal')], [500, '500ms'], [1000, '1s'], [2000, '2s']].forEach(function (o) {
        var b = el('button', { 'data-v': String(o[0]) }, [o[1]]);
        if (ctx.optState.netDelay === o[0] && !ctx.optState.netOffline) b.classList.add('dbg-on');
        b.addEventListener('click', function () {
          ctx.optState.netDelay = o[0]; ctx.optState.netOffline = false;
          netBtns.querySelectorAll('button').forEach(function (x) { x.classList.toggle('dbg-on', x === b); });
          ctx.saveOptState(); ctx.applyOptsToTarget();
        });
        netBtns.appendChild(b);
      });
      var offBtn = el('button', { 'data-v': 'off', title: t('fetch fails immediately / XHR fires error (simulate offline)') }, [t('📴 Offline')]);
      if (ctx.optState.netOffline) offBtn.classList.add('dbg-on');
      offBtn.addEventListener('click', function () {
        ctx.optState.netOffline = !ctx.optState.netOffline; if (ctx.optState.netOffline) ctx.optState.netDelay = 0;
        netBtns.querySelectorAll('button').forEach(function (x) { x.classList.toggle('dbg-on', false); });
        offBtn.classList.toggle('dbg-on', ctx.optState.netOffline);
        ctx.saveOptState(); ctx.applyOptsToTarget();
      });
      netBtns.appendChild(offBtn);
      rowNet.appendChild(netBtns);
      body.appendChild(rowNet);

      // 危险命令无人值守：确认卡弹出后无响应 N 秒自动允许执行（reload/删元素/改 localStorage 等）——
      // 适合无人值守/自动化联调；手势类（复制/粘贴等）浏览器要求真实点击，不支持自动接受
      var rowDanger = el('div', { class: 'dbg-speed-row' });
      rowDanger.appendChild(el('label', {}, [t('Dangerous command'), t('(unattended)')]));
      var dangerBtns = el('div', { class: 'dbg-seg', 'data-opt': 'dangerAutoOkMs' });
      [[0, t('Manual confirm')], [10000, '10s'], [30000, '30s'], [60000, '60s']].forEach(function (o) {
        var b = el('button', { 'data-v': String(o[0]), title: o[0] ? t('After a dangerous-command confirm card pops up ') + (o[0] / 1000) + t(' s without a pick → auto-allow (same as clicking Allow)') : t('Wait for manual confirm on every dangerous command (default, safest)') }, [o[1]]);
        if ((ctx.optState.dangerAutoOkMs || 0) === o[0]) b.classList.add('dbg-on');
        b.addEventListener('click', function () {
          ctx.optState.dangerAutoOkMs = o[0];
          dangerBtns.querySelectorAll('button').forEach(function (x) { x.classList.toggle('dbg-on', x === b); });
          ctx.saveOptState();
          ctx.addMsg('sys', t('Dangerous command: ') + (o[0] ? t('no response ') + (o[0] / 1000) + t('s then auto-allow (unattended)') : t('Confirm manually every time')));
        });
        dangerBtns.appendChild(b);
      });
      rowDanger.appendChild(dangerBtns);
      body.appendChild(rowDanger);

      // 强制报错（验证错误上报链路 / 给 AI 造错误场景）
      var rowErr = el('div', { class: 'dbg-speed-row' });
      rowErr.appendChild(el('label', {}, [t('Force error')]));
      var errBtns = el('div', { class: 'dbg-seg' });
      [['sync', t('⚠ Sync error')], ['promise', '⚠ Promise'], ['console', '⚠ console.error'], ['resource', t('⚠ Resource 404')]].forEach(function (o) {
        var b = el('button', { title: t('Trigger on target page ') + o[1] + t(', reported after the error hook captures') }, [o[1]]);
        b.addEventListener('click', function () {
          ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_force_error', payload: { kind: o[0] } });
          ctx.addMsg('sys', t('⚡ Forced error triggered: ') + o[1] + t('(waiting for the page error hook report)'));
        });
        errBtns.appendChild(b);
      });
      rowErr.appendChild(errBtns);
      body.appendChild(rowErr);

      // 场景预设：把「不好重现」的条件打包成一键场景
      var rowScene = el('div', { class: 'dbg-speed-row dbg-scene-row' });
      rowScene.appendChild(el('label', {}, [t('Scenario presets')]));
      var sceneBtns = el('div', { class: 'dbg-seg' });
      [
        ['mobile', t('📱 Narrow 375'), { viewportW: 375 }],
        ['dark', t('🌙 Dark'), { darkMode: true }],
        ['expired', t('⏳ Expired +7d'), { timeOffsetMs: 7 * 24 * 3600 * 1000 }],
        ['slow', t('🐢 Slow network'), { netDelay: 500, animSpeed: 0.5 }],
        ['reset', t('🔄 Reset all'), null],
      ].forEach(function (o) {
        var b = el('button', { title: o[0] === 'reset' ? t('Restore all emulation to defaults') : t('One-click scenarios: ') + o[1] }, [o[1]]);
        b.addEventListener('click', function () {
          if (o[0] === 'reset') {
            // 重置全部模拟条件（保留无人值守设置：安全偏好不随模拟重置清除）
            var keepDangerOk = ctx.optState.dangerAutoOkMs || 0;
            ctx.optState = Object.assign({}, {
              animSpeed: 1, blockScroll: false, blockWheel: false, slowTimers: 1,
              netDelay: 0, netOffline: false, darkMode: false, reducedMotion: false,
              timeOffsetMs: 0, viewportW: 0,
            }, { dangerAutoOkMs: keepDangerOk });
            ctx.saveOptState(); ctx.applyOptsToTarget();
            ctx.syncSpeedPanelUI();
            ctx.addMsg('sys', t('🔄 All emulation flags reset.'));
            return;
          }
          Object.assign(ctx.optState, o[2]);
          ctx.saveOptState(); ctx.applyOptsToTarget();
          ctx.syncSpeedPanelUI();
          ctx.addMsg('sys', t('🎬 Scenario applied: ') + o[1] + t('(can combine with network/error tweaks)'));
        });
        sceneBtns.appendChild(b);
      });
      rowScene.appendChild(sceneBtns);
      body.appendChild(rowScene);

      // 语言切换（i18n，docs/launcher-i18n-plan.md）：跟随浏览器/中文/English，localStorage __dbg_lang；切换后新开面板生效
      var rowLang = el('div', { class: 'dbg-speed-row' });
      rowLang.appendChild(el('label', {}, [t('🌐 Language')]));
      var langSel = el('select', { class: 'dbg-lang-sel', style: 'flex:1;padding:4px 6px;border-radius:6px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.6);color:#e5e7eb;font:inherit;font-size:12px' });
      [['', '🌐 ' + t('Auto (follow browser)')], ['zh', '中文' /* i18n-keep: language endonym */], ['en', 'English']].forEach(function (it) {
        var op = el('option', { value: it[0] }, [it[1]]);
        var pref = getLangPref();
        if (pref === it[0] || (it[0] === '' && (pref === null || pref === undefined))) op.setAttribute('selected', '');
        langSel.appendChild(op);
      });
      langSel.addEventListener('change', function () {
        var v = langSel.value;
        setLang(v === '' ? null : v);
        ctx.addMsg('sys', t('🌐 Language switched (applies to newly opened panels)'));
      });
      rowLang.appendChild(langSel);
      body.appendChild(rowLang);

      // 现场快照：把出错现场（错误+场景条件+页面状态）打包发给 AI
      var rowSnap = el('div', { class: 'dbg-speed-row' });
      rowSnap.appendChild(el('label', {}, [t('Capture snapshot')]));
      var snapBtn = el('button', { class: 'dbg-snap-btn', title: t('Package the current error state (errors + emulation flags + page state) and send to AI') }, [t('📸 Capture state & send to AI')]);
      snapBtn.addEventListener('click', ctx.captureSceneSend);
      rowSnap.appendChild(snapBtn);
      body.appendChild(rowSnap);

      // 放行方案管理（唯一入口）：内置（默认/全放行/全冻结）+ 用户自定义方案（方案名+内容可添加/编辑/删除）
      // 注：原"事件放行"逐类开关行已移除——方案管理（默认放行/自定义方案均可编辑类别）已完全覆盖，避免重复 UI
      var PROFILE_CATS = ['click', 'hover', 'key', 'wheel', 'scroll', 'touch', 'focus'];
      var rowProfile = el('div', { class: 'dbg-speed-row dbg-release-row' });
      rowProfile.appendChild(el('label', {}, [t('Allow plan')]));
      var pfWrap = el('div', { class: 'dbg-rel-wrap' });
      var pfBtns = el('div', { class: 'dbg-seg' });
      ctx.getProfileOrder().forEach(function (name) {
        var b = el('button', { 'data-pf': name }, [ctx.getProfiles()[name].label]);
        b.addEventListener('click', function () {
          var pf = ctx.applyProfile(name);
          ctx.addMsg('sys', t('Allow plan applied: ') + pf.label + '（' + (pf.release.length ? t('Allow ') + pf.release.join('/') : t('Freeze all')) + '）');
        });
        pfBtns.appendChild(b);
      });
      pfWrap.appendChild(pfBtns);
      // 用户自定义方案编辑区：默认收起（多方案不占空间），点击 header 展开/收起
      var pfEditWrap = el('div', { style: 'margin-top:6px;display:flex;flex-direction:column;gap:4px' });
      var pfEditHeader = el('div', { style: 'display:flex;align-items:center;gap:6px;font-size:11px;color:#4f46e5;cursor:pointer;user-select:none;padding:3px 6px;border-radius:6px;background:#eef2ff' }, []);
      var pfArrow = el('span', {}, ['▸']);
      var pfCount = el('span', {}, ['0']);
      pfEditHeader.appendChild(pfArrow);
      pfEditHeader.appendChild(pfCount);
      pfEditHeader.appendChild(el('span', {}, [t('Plan editor (incl. default allow, click to expand)')]));
      var pfEditBody = el('div', { style: 'display:none' }); // 默认收起
      pfEditHeader.addEventListener('click', function () {
        var open = pfEditBody.style.display === 'none';
        pfEditBody.style.display = open ? 'flex' : 'none';
        if (open) { pfEditBody.style.flexDirection = 'column'; pfEditBody.style.gap = '4px'; }
        pfArrow.textContent = open ? '▾' : '▸';
      });
      pfEditWrap.appendChild(pfEditHeader);
      pfEditWrap.appendChild(pfEditBody);
      function renderUserProfiles() {
        pfEditBody.innerHTML = '';
        pfCount.textContent = String(1 + ctx.userProfiles.length); // 含默认放行（可编辑方案总数）
        // 默认放行：固定方案（不可删除/改名），类别可编辑（用户可改放行哪些事件）
        var dpf = ctx.RELEASE_PROFILES.default;
        var dRow = el('div', { style: 'display:flex;align-items:center;gap:4px;flex-wrap:wrap;background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:4px 6px' });
        dRow.appendChild(el('span', { style: 'font-weight:600;color:#4f46e5' }, [dpf.label]));
        var dChecks = el('div', { class: 'dbg-checks' });
        var dboxes = {};
        PROFILE_CATS.forEach(function (cat) {
          var l2 = el('label', {}, []);
          var b2 = el('input', { type: 'checkbox' });
          b2.checked = dpf.release.indexOf(cat) >= 0;
          dboxes[cat] = b2;
          l2.appendChild(b2);
          l2.appendChild(document.createTextNode(cat));
          dChecks.appendChild(l2);
        });
        var dSave = el('button', { style: 'border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:1px 8px;cursor:pointer;font:inherit;font-size:10px' }, [t('Save')]);
        dSave.addEventListener('click', function () {
          dpf.release = PROFILE_CATS.filter(function (c) { return dboxes[c].checked; });
          try { localStorage.setItem(DEFAULT_RELEASE_KEY, JSON.stringify(dpf.release)); } catch (e) {}
          if (ctx.currentProfile === 'default') ctx.applyProfile('default');
          ctx.addMsg('sys', t('Default plan saved: allow ') + (dpf.release.join('/') || t('(none = freeze all)')));
          rebuildProfileUI();
        });
        dRow.appendChild(dChecks);
        dRow.appendChild(dSave);
        dRow.appendChild(el('span', { style: 'font-size:10px;color:#9ca3af' }, [t('Built-in plan (cannot delete)')]));
        pfEditBody.appendChild(dRow);
        // 用户自定义方案（可改名/改类别/删除）
        ctx.userProfiles.forEach(function (u) {
          var row = el('div', { style: 'display:flex;align-items:center;gap:4px;flex-wrap:wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:4px 6px' });
          var nameInput = el('input', { value: u.label, style: 'width:70px;border:1px solid #d1d5db;border-radius:6px;padding:2px 5px;font:inherit;font-size:11px' });
          var catChecks = el('div', { class: 'dbg-checks' });
          var pboxes = {};
          PROFILE_CATS.forEach(function (cat) {
            var label = el('label', {}, []);
            var box = el('input', { type: 'checkbox' });
            box.checked = u.release.indexOf(cat) >= 0;
            pboxes[cat] = box;
            label.appendChild(box);
            label.appendChild(document.createTextNode(cat));
            catChecks.appendChild(label);
          });
          var saveBtn = el('button', { style: 'border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:1px 8px;cursor:pointer;font:inherit;font-size:10px' }, [t('Save')]);
          saveBtn.addEventListener('click', function () {
            u.label = nameInput.value.trim() || u.label;
            u.release = PROFILE_CATS.filter(function (c) { return pboxes[c].checked; });
            ctx.saveUserProfiles();
            ctx.addMsg('sys', t('Plan "') + u.label + t('" saved: allow ') + (u.release.join('/') || t('(none = freeze all)')));
            rebuildProfileUI();
          });
          var delBtn = el('button', { style: 'border:1px solid #fecaca;background:#fee2e2;border-radius:6px;padding:1px 8px;cursor:pointer;font:inherit;font-size:10px;color:#b91c1c' }, [t('Delete')]);
          delBtn.addEventListener('click', function () {
            ctx.removeUserProfile(u.name);
            renderUserProfiles();
            rebuildProfileUI();
            ctx.addMsg('sys', t('Deleted plan "') + u.label + '」');
          });
          row.appendChild(nameInput);
          row.appendChild(catChecks);
          row.appendChild(saveBtn);
          row.appendChild(delBtn);
          pfEditBody.appendChild(row);
        });
      }
      var addBtn = el('button', { style: 'border:1px solid #a5b4fc;background:#e0e7ff;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;color:#4338ca;margin-top:4px' }, [t('➕ Add plan')]);
      addBtn.addEventListener('click', function () {
        // 默认名"放行方案N"（从1递增，已有同名则+1）
        var baseName = t('Allow plan');
        var n = 1;
        var profiles = ctx.getProfiles();
        while (profiles[baseName + n] || ctx.userProfiles.some(function(u){ return u.label === baseName + n; })) n++;
        var label = prompt(t('New plan name: '), baseName + n);
        if (!label) return;
        var name = ctx.addUserProfile(label);
        renderUserProfiles();
        rebuildProfileUI();
        ctx.addMsg('sys', t('Added plan "') + label + t('" (allow-all default, categories editable).'));
      });
      pfWrap.appendChild(pfEditWrap);
      pfWrap.appendChild(addBtn);
      var pfTip = el('div', { style: 'font-size:10px;color:#6b7280' }, [t('A plan = which event categories are allowed (rest frozen). Default locks only click/hover; allow-all includes click. Saved custom plans appear in the toolbar dropdown. While locked, press Space to toggle default-allow/allow-all (page popup menus stay open).')]);
      pfWrap.appendChild(pfTip);
      rowProfile.appendChild(pfWrap);
      body.appendChild(rowProfile);
      function rebuildProfileUI() {
        // 重建面板方案按钮 + 工具条下拉（下次打开时生效）——先刷新面板按钮
        pfBtns.innerHTML = '';
        ctx.getProfileOrder().forEach(function (name) {
          var b = el('button', { 'data-pf': name }, [ctx.getProfiles()[name].label]);
          b.addEventListener('click', function () {
            var pf = ctx.applyProfile(name);
            ctx.addMsg('sys', t('Allow plan applied: ') + pf.label);
          });
          pfBtns.appendChild(b);
        });
        renderUserProfiles();
      }
      renderUserProfiles();

      // 视口模拟（大屏↔小屏切换）：改 target iframe 宽度，iframe 内媒体查询实时生效
      var rowViewport = el('div', { class: 'dbg-speed-row dbg-release-row' });
      rowViewport.appendChild(el('label', {}, [t('Viewport emulation')]));
      var vpWrap = el('div', { class: 'dbg-rel-wrap' });
      var vpBtns = el('div', { class: 'dbg-seg' });
      var vpDefs = [[375, '📱 375'], [414, '414'], [768, t('Tablet 768')], [1024, '1024'], [1280, '🖥 1280'], [1440, '1440'], [0, t('Auto-fit')]];
      var vpCur = el('span', { style: 'font-size:10px;color:#6b7280' }, [t('Current iframe viewport: —')]); // 更新为实际值
      vpDefs.forEach(function (o) {
        var b = el('button', { 'data-v': String(o[0]) }, [o[1]]);
        b.addEventListener('click', function () {
          ctx.optState.viewportW = o[0];
          ctx.saveOptState(); ctx.applyOptsToTarget();
          ctx.addMsg('sys', t('Viewport emulation: ') + (o[0] ? o[0] + 'px' : t('Auto-fit (restore width)')) + t('(large↔small switch, media queries live)'));
        });
        vpBtns.appendChild(b);
      });
      var vpCustom = el('input', { type: 'number', placeholder: t('Custom px'), style: 'width:74px;border:1px solid #d1d5db;border-radius:6px;padding:2px 6px;font:inherit;font-size:11px' });
      var vpGo = el('button', {}, [t('Apply')]);
      vpGo.addEventListener('click', function () {
        var v = parseInt(vpCustom.value, 10);
        if (v > 0) { ctx.optState.viewportW = v; ctx.saveOptState(); ctx.applyOptsToTarget(); ctx.addMsg('sys', t('Viewport emulation: ') + v + 'px'); }
      });
      var vpTouch = el('label', { class: 'dbg-chk', style: 'margin-top:4px', title: t('Emulate touch device traits (pointer:coarse / hover:none)') }, []);
      var vpTouchBox = el('input', { type: 'checkbox' });
      vpTouchBox.checked = !!ctx.optState.simulateTouch;
      vpTouchBox.addEventListener('change', function () {
        ctx.optState.simulateTouch = vpTouchBox.checked;
        ctx.saveOptState(); ctx.applyOptsToTarget();
        ctx.addMsg('sys', t('Touch emulation: ') + (vpTouchBox.checked ? t('On (page renders as touch device)') : t('Off')));
      });
      vpTouch.appendChild(vpTouchBox);
      vpTouch.appendChild(document.createTextNode(t('Emulate touch')));
      vpWrap.appendChild(vpBtns);
      var vpRow2 = el('div', { style: 'display:flex;gap:4px;margin-top:4px;align-items:center' });
      vpRow2.appendChild(vpCustom);
      vpRow2.appendChild(vpGo);
      vpRow2.appendChild(vpTouch);
      vpRow2.appendChild(vpCur);
      vpWrap.appendChild(vpRow2);
      rowViewport.appendChild(vpWrap);
      body.appendChild(rowViewport);
      // 当前视口显示（target iframe innerWidth）
      function refreshViewportLabel() {
        var tw = (ctx.listFrames()[0] || {}).win;
        if (tw && vpCur) vpCur.textContent = t('Current iframe viewport: ') + (tw.innerWidth || '—') + 'px';
      }
      setInterval(refreshViewportLabel, 1000);

      // MCP 桥：状态展示 + 手动重连（方案 D 阶段 2：自动连桥后此面板只做状态/重连；token 由 client 自动 claim）
      // 注："📣 告知 AI" 已移除——inject 发出的消息统一带 [发自: pageId · url] 来源标注，无需手动告知
      // MCP 桥：launcher 不负责连桥——所有连接由 AI 窗口负责（AI 窗连桥 + 页面 ↔ AI 窗 postMessage 唯一通道）
      var rowMcp = el('div', { class: 'dbg-speed-row' });
      rowMcp.appendChild(el('label', {}, [t('MCP bridge')]));
      var mcpWrap = el('div', { class: 'dbg-rel-wrap', style: 'font-size:11px;color:#6b7280' });
      mcpWrap.appendChild(document.createTextNode(t('🔗 Connection handled by the AI window: page ↔ AI window via postMessage (the only channel); the bridge connection (role=ai) lives on the AI window side.')));
      rowMcp.appendChild(mcpWrap);
      body.appendChild(rowMcp);

      // 选区工具（#指定 / 👆穿透 / 🖥宿主页；从工具条移入面板，保持工具条精简）
      var rowSelTools = el('div', { class: 'dbg-speed-row' });
      rowSelTools.appendChild(el('label', {}, [t('Selection tools')]));
      var selTools = el('div', { class: 'dbg-seg' });
      var t1 = el('button', { title: t('Specify selection by CSS selector') }, [t('# Specify')]); 
      var t2 = el('button', { title: t('Real click pass-through: allow one click so the page opens menus/popups (menus won\'t vanish while frozen)') }, [t('👆 Pass-through')]);
      var t3 = el('button', { title: t('Pick elements on the host page itself (skip target iframes)') }, [t('🖥 Host page')]);
      t1.addEventListener('click', function () {
        var s = prompt(t('Type a CSS selector to set the selection, e.g. .card:nth-child(2)'));
        if (s) ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_select', payload: { selector: s } });
      });
      t2.addEventListener('click', function () {
        ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_passthrough_click' });
        ctx.addMsg('sys', t('👆 Real click: allow one click (page menus/popups open normally, then freeze resumes).'));
      });
      t3.addEventListener('click', function () {
        if (ctx.selfClientActive) { ctx.exitSelfClient(); ctx.selfClientActive = false; return; }
        if (ctx.inspectorOn) ctx.exitInspector();
        ctx.enterSelfClient(isTouchDevice() ? 'touch' : 'mouse');
        ctx.selfClientActive = true;
      });
      selTools.appendChild(t1);
      selTools.appendChild(t2);
      selTools.appendChild(t3);
      rowSelTools.appendChild(selTools);
      body.appendChild(rowSelTools);

      // 动画速度（playbackRate）
      var row1 = el('div', { class: 'dbg-speed-row' });
      row1.appendChild(el('label', {}, [t('Animation speed')]));
      var animBtns = el('div', { class: 'dbg-seg', 'data-opt': 'animSpeed' });
      [[0, t('⏸ Pause')], [0.1, '0.1x'], [0.25, '0.25x'], [0.5, '0.5x'], [1, '1x']].forEach(function (o) {
        var b = el('button', { 'data-v': String(o[0]) }, [o[1]]);
        if (ctx.optState.animSpeed === o[0]) b.classList.add('dbg-on');
        b.addEventListener('click', function () {
          ctx.optState.animSpeed = o[0];
          animBtns.querySelectorAll('button').forEach(function (x) { x.classList.toggle('dbg-on', x === b); });
          ctx.saveOptState(); ctx.applyOptsToTarget();
        });
        animBtns.appendChild(b);
      });
      row1.appendChild(animBtns);
      body.appendChild(row1);

      // 注：原"事件拦截"行（blockScroll/blockWheel 拦截滚动/滚轮）已移除——放行方案可冻结 scroll/wheel（等效），避免概念重叠
      // 定时器慢放（实验性）
      var row3 = el('div', { class: 'dbg-speed-row' });
      row3.appendChild(el('label', {}, [t('Timer slowdown'), t('(experimental)')]));
      var timerBtns = el('div', { class: 'dbg-seg', 'data-opt': 'slowTimers' });
      [[1, '1x'], [2, '2x'], [5, '5x']].forEach(function (o) {
        var b = el('button', { 'data-v': String(o[0]) }, [o[1]]);
        if (ctx.optState.slowTimers === o[0]) b.classList.add('dbg-on');
        b.addEventListener('click', function () {
          ctx.optState.slowTimers = o[0];
          timerBtns.querySelectorAll('button').forEach(function (x) { x.classList.toggle('dbg-on', x === b); });
          ctx.saveOptState(); ctx.applyOptsToTarget();
        });
        timerBtns.appendChild(b);
      });
      row3.appendChild(timerBtns);
      body.appendChild(row3);

      ctx.speedPanel.appendChild(body);
      ctx.root.appendChild(ctx.speedPanel);
      }

  ctx.syncSpeedPanelUI = function () {
      if (!ctx.speedPanel) return;
      // data-opt 驱动的同步（不按固定 seg 序号——面板行序调整后序号会错位）：
      // 每个带 data-opt 的 seg 按自身键同步高亮；net 特殊（离线/延迟互斥）
      ctx.speedPanel.querySelectorAll('.dbg-seg[data-opt]').forEach(function (seg) {
        var key = seg.dataset.opt;
        seg.querySelectorAll('button').forEach(function (b) {
          var v = b.dataset.v;
          b.classList.toggle('dbg-on', key === 'net'
            ? (v === 'off' ? ctx.optState.netOffline : (!ctx.optState.netOffline && String(ctx.optState.netDelay) === v))
            : (String(ctx.optState[key]) === v));
        });
      });
      }
}
