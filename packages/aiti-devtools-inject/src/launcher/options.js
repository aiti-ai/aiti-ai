// options 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { el } from './dom.js';
import { isTouchDevice , isSmallScreen , getPhysViewport, capVisW, positionPhysical } from './viewport.js';
import { OPT_KEY, DEFAULT_RELEASE_KEY } from './constants.js';
import { lsGetJSON, lsSetJSON } from './storage.js';

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
      head.appendChild(el('span', {}, ['⏱ 调速 / 🌐 网络 / ⚠ 错误']));
      var hClose = el('button', {}, ['✕']);
      hClose.addEventListener('click', function () { ctx.speedPanel.classList.remove('dbg-open'); });
      head.appendChild(hClose);
      ctx.speedPanel.appendChild(head);

      var body = el('div', { class: 'dbg-speed-body' });

      // 网络模拟（fetch/XHR 延迟与离线）
      var rowNet = el('div', { class: 'dbg-speed-row' });
      rowNet.appendChild(el('label', {}, ['网络模拟']));
      var netBtns = el('div', { class: 'dbg-seg', 'data-opt': 'net' });
      [[0, '正常'], [500, '500ms'], [1000, '1s'], [2000, '2s']].forEach(function (o) {
        var b = el('button', { 'data-v': String(o[0]) }, [o[1]]);
        if (ctx.optState.netDelay === o[0] && !ctx.optState.netOffline) b.classList.add('dbg-on');
        b.addEventListener('click', function () {
          ctx.optState.netDelay = o[0]; ctx.optState.netOffline = false;
          netBtns.querySelectorAll('button').forEach(function (x) { x.classList.toggle('dbg-on', x === b); });
          ctx.saveOptState(); ctx.applyOptsToTarget();
        });
        netBtns.appendChild(b);
      });
      var offBtn = el('button', { 'data-v': 'off', title: 'fetch 立即失败 / XHR 触发 error（模拟断网）' }, ['📴 离线']);
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
      rowDanger.appendChild(el('label', {}, ['危险命令', '（无人值守）']));
      var dangerBtns = el('div', { class: 'dbg-seg', 'data-opt': 'dangerAutoOkMs' });
      [[0, '手动确认'], [10000, '10s'], [30000, '30s'], [60000, '60s']].forEach(function (o) {
        var b = el('button', { 'data-v': String(o[0]), title: o[0] ? '危险命令确认卡弹出后 ' + (o[0] / 1000) + ' 秒内无人点选 → 自动允许执行（等同点「允许执行」）' : '每次危险命令都等人工点选（默认，最安全）' }, [o[1]]);
        if ((ctx.optState.dangerAutoOkMs || 0) === o[0]) b.classList.add('dbg-on');
        b.addEventListener('click', function () {
          ctx.optState.dangerAutoOkMs = o[0];
          dangerBtns.querySelectorAll('button').forEach(function (x) { x.classList.toggle('dbg-on', x === b); });
          ctx.saveOptState();
          ctx.addMsg('sys', '危险命令：' + (o[0] ? '无响应 ' + (o[0] / 1000) + 's 后自动允许执行（无人值守）' : '每次手动确认'));
        });
        dangerBtns.appendChild(b);
      });
      rowDanger.appendChild(dangerBtns);
      body.appendChild(rowDanger);

      // 强制报错（验证错误上报链路 / 给 AI 造错误场景）
      var rowErr = el('div', { class: 'dbg-speed-row' });
      rowErr.appendChild(el('label', {}, ['强制报错']));
      var errBtns = el('div', { class: 'dbg-seg' });
      [['sync', '⚠ 同步异常'], ['promise', '⚠ Promise'], ['console', '⚠ console.error'], ['resource', '⚠ 资源404']].forEach(function (o) {
        var b = el('button', { title: '在目标页触发 ' + o[1] + '，错误 hook 捕获后上报' }, [o[1]]);
        b.addEventListener('click', function () {
          ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_force_error', payload: { kind: o[0] } });
          ctx.addMsg('sys', '⚡ 已触发强制错误：' + o[1] + '（等待页面错误 hook 上报）');
        });
        errBtns.appendChild(b);
      });
      rowErr.appendChild(errBtns);
      body.appendChild(rowErr);

      // 场景预设：把「不好重现」的条件打包成一键场景
      var rowScene = el('div', { class: 'dbg-speed-row dbg-scene-row' });
      rowScene.appendChild(el('label', {}, ['场景预设']));
      var sceneBtns = el('div', { class: 'dbg-seg' });
      [
        ['mobile', '📱 窄屏375', { viewportW: 375 }],
        ['dark', '🌙 深色', { darkMode: true }],
        ['expired', '⏳ 过期+7天', { timeOffsetMs: 7 * 24 * 3600 * 1000 }],
        ['slow', '🐢 弱网', { netDelay: 500, animSpeed: 0.5 }],
        ['reset', '🔄 重置全部', null],
      ].forEach(function (o) {
        var b = el('button', { title: o[0] === 'reset' ? '恢复所有模拟为默认' : '一键应用场景：' + o[1] }, [o[1]]);
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
            ctx.addMsg('sys', '🔄 已重置全部模拟条件。');
            return;
          }
          Object.assign(ctx.optState, o[2]);
          ctx.saveOptState(); ctx.applyOptsToTarget();
          ctx.syncSpeedPanelUI();
          ctx.addMsg('sys', '🎬 场景已应用：' + o[1] + '（可继续配合网络/错误区微调）');
        });
        sceneBtns.appendChild(b);
      });
      rowScene.appendChild(sceneBtns);
      body.appendChild(rowScene);

      // 现场快照：把出错现场（错误+场景条件+页面状态）打包发给 AI
      var rowSnap = el('div', { class: 'dbg-speed-row' });
      rowSnap.appendChild(el('label', {}, ['现场快照']));
      var snapBtn = el('button', { class: 'dbg-snap-btn', title: '把当前出错现场（错误列表+模拟条件+页面状态）打包发给 AI' }, ['📸 捕获现场发 AI']);
      snapBtn.addEventListener('click', ctx.captureSceneSend);
      rowSnap.appendChild(snapBtn);
      body.appendChild(rowSnap);

      // 放行方案管理（唯一入口）：内置（默认/全放行/全冻结）+ 用户自定义方案（方案名+内容可添加/编辑/删除）
      // 注：原"事件放行"逐类开关行已移除——方案管理（默认放行/自定义方案均可编辑类别）已完全覆盖，避免重复 UI
      var PROFILE_CATS = ['click', 'hover', 'key', 'wheel', 'scroll', 'touch', 'focus'];
      var rowProfile = el('div', { class: 'dbg-speed-row dbg-release-row' });
      rowProfile.appendChild(el('label', {}, ['放行方案']));
      var pfWrap = el('div', { class: 'dbg-rel-wrap' });
      var pfBtns = el('div', { class: 'dbg-seg' });
      ctx.getProfileOrder().forEach(function (name) {
        var b = el('button', { 'data-pf': name }, [ctx.getProfiles()[name].label]);
        b.addEventListener('click', function () {
          var pf = ctx.applyProfile(name);
          ctx.addMsg('sys', '已应用放行方案：' + pf.label + '（' + (pf.release.length ? '放行 ' + pf.release.join('/') : '全部冻结') + '）');
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
      pfEditHeader.appendChild(el('span', {}, ['方案编辑（含默认放行，点击展开）']));
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
        var dSave = el('button', { style: 'border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:1px 8px;cursor:pointer;font:inherit;font-size:10px' }, ['保存']);
        dSave.addEventListener('click', function () {
          dpf.release = PROFILE_CATS.filter(function (c) { return dboxes[c].checked; });
          try { localStorage.setItem(DEFAULT_RELEASE_KEY, JSON.stringify(dpf.release)); } catch (e) {}
          if (ctx.currentProfile === 'default') ctx.applyProfile('default');
          ctx.addMsg('sys', '默认放行已保存：放行 ' + (dpf.release.join('/') || '（无，=全冻结）'));
          rebuildProfileUI();
        });
        dRow.appendChild(dChecks);
        dRow.appendChild(dSave);
        dRow.appendChild(el('span', { style: 'font-size:10px;color:#9ca3af' }, ['固定方案（不可删除）']));
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
          var saveBtn = el('button', { style: 'border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:1px 8px;cursor:pointer;font:inherit;font-size:10px' }, ['保存']);
          saveBtn.addEventListener('click', function () {
            u.label = nameInput.value.trim() || u.label;
            u.release = PROFILE_CATS.filter(function (c) { return pboxes[c].checked; });
            ctx.saveUserProfiles();
            ctx.addMsg('sys', '方案「' + u.label + '」已保存：放行 ' + (u.release.join('/') || '（无，=全冻结）'));
            rebuildProfileUI();
          });
          var delBtn = el('button', { style: 'border:1px solid #fecaca;background:#fee2e2;border-radius:6px;padding:1px 8px;cursor:pointer;font:inherit;font-size:10px;color:#b91c1c' }, ['删除']);
          delBtn.addEventListener('click', function () {
            ctx.removeUserProfile(u.name);
            renderUserProfiles();
            rebuildProfileUI();
            ctx.addMsg('sys', '已删除方案「' + u.label + '」');
          });
          row.appendChild(nameInput);
          row.appendChild(catChecks);
          row.appendChild(saveBtn);
          row.appendChild(delBtn);
          pfEditBody.appendChild(row);
        });
      }
      var addBtn = el('button', { style: 'border:1px solid #a5b4fc;background:#e0e7ff;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit;font-size:11px;color:#4338ca;margin-top:4px' }, ['➕ 添加方案']);
      addBtn.addEventListener('click', function () {
        // 默认名"放行方案N"（从1递增，已有同名则+1）
        var baseName = '放行方案';
        var n = 1;
        var profiles = ctx.getProfiles();
        while (profiles[baseName + n] || ctx.userProfiles.some(function(u){ return u.label === baseName + n; })) n++;
        var label = prompt('新方案名称：', baseName + n);
        if (!label) return;
        var name = ctx.addUserProfile(label);
        renderUserProfiles();
        rebuildProfileUI();
        ctx.addMsg('sys', '已添加方案「' + label + '」（默认全放行，可编辑类别）。');
      });
      pfWrap.appendChild(pfEditWrap);
      pfWrap.appendChild(addBtn);
      var pfTip = el('div', { style: 'font-size:10px;color:#6b7280' }, ['方案 = 放行哪些事件类别（其余冻结）。默认只锁 click/hover；全放行含 click。自定义方案保存后在工具条下拉可选。锁定态按 空格 在默认放行/全部放行之间一键切换（页面弹出菜单不收起）。']);
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
            ctx.addMsg('sys', '已应用放行方案：' + pf.label);
          });
          pfBtns.appendChild(b);
        });
        renderUserProfiles();
      }
      renderUserProfiles();

      // 视口模拟（大屏↔小屏切换）：改 target iframe 宽度，iframe 内媒体查询实时生效
      var rowViewport = el('div', { class: 'dbg-speed-row dbg-release-row' });
      rowViewport.appendChild(el('label', {}, ['视口模拟']));
      var vpWrap = el('div', { class: 'dbg-rel-wrap' });
      var vpBtns = el('div', { class: 'dbg-seg' });
      var vpDefs = [[375, '📱 375'], [414, '414'], [768, '平板768'], [1024, '1024'], [1280, '🖥 1280'], [1440, '1440'], [0, '自适应']];
      var vpCur = el('span', { style: 'font-size:10px;color:#6b7280' }, ['当前 iframe 视口：—']); // 更新为实际值
      vpDefs.forEach(function (o) {
        var b = el('button', { 'data-v': String(o[0]) }, [o[1]]);
        b.addEventListener('click', function () {
          ctx.optState.viewportW = o[0];
          ctx.saveOptState(); ctx.applyOptsToTarget();
          ctx.addMsg('sys', '视口模拟：' + (o[0] ? o[0] + 'px' : '自适应（恢复原宽）') + '（大屏↔小屏切换，媒体查询实时生效）');
        });
        vpBtns.appendChild(b);
      });
      var vpCustom = el('input', { type: 'number', placeholder: '自定义px', style: 'width:74px;border:1px solid #d1d5db;border-radius:6px;padding:2px 6px;font:inherit;font-size:11px' });
      var vpGo = el('button', {}, ['应用']);
      vpGo.addEventListener('click', function () {
        var v = parseInt(vpCustom.value, 10);
        if (v > 0) { ctx.optState.viewportW = v; ctx.saveOptState(); ctx.applyOptsToTarget(); ctx.addMsg('sys', '视口模拟：' + v + 'px'); }
      });
      var vpTouch = el('label', { class: 'dbg-chk', style: 'margin-top:4px', title: '模拟触屏设备特征（pointer:coarse / hover:none）' }, []);
      var vpTouchBox = el('input', { type: 'checkbox' });
      vpTouchBox.checked = !!ctx.optState.simulateTouch;
      vpTouchBox.addEventListener('change', function () {
        ctx.optState.simulateTouch = vpTouchBox.checked;
        ctx.saveOptState(); ctx.applyOptsToTarget();
        ctx.addMsg('sys', '触屏模拟：' + (vpTouchBox.checked ? '开（页面按触屏设备渲染）' : '关'));
      });
      vpTouch.appendChild(vpTouchBox);
      vpTouch.appendChild(document.createTextNode('模拟触屏'));
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
        if (tw && vpCur) vpCur.textContent = '当前 iframe 视口：' + (tw.innerWidth || '—') + 'px';
      }
      setInterval(refreshViewportLabel, 1000);

      // MCP 桥：状态展示 + 手动重连（方案 D 阶段 2：自动连桥后此面板只做状态/重连；token 由 client 自动 claim）
      // 注："📣 告知 AI" 已移除——inject 发出的消息统一带 [发自: pageId · url] 来源标注，无需手动告知
      // MCP 桥：launcher 不负责连桥——所有连接由 AI 窗口负责（AI 窗连桥 + 页面 ↔ AI 窗 postMessage 唯一通道）
      var rowMcp = el('div', { class: 'dbg-speed-row' });
      rowMcp.appendChild(el('label', {}, ['MCP 桥']));
      var mcpWrap = el('div', { class: 'dbg-rel-wrap', style: 'font-size:11px;color:#6b7280' });
      mcpWrap.appendChild(document.createTextNode('🔗 连接由 AI 窗口负责：页面 ↔ AI 窗经 postMessage 交互（唯一通道），桥连接（role=ai）在 AI 窗侧。'));
      rowMcp.appendChild(mcpWrap);
      body.appendChild(rowMcp);

      // 选区工具（#指定 / 👆穿透 / 🖥宿主页；从工具条移入面板，保持工具条精简）
      var rowSelTools = el('div', { class: 'dbg-speed-row' });
      rowSelTools.appendChild(el('label', {}, ['选区工具']));
      var selTools = el('div', { class: 'dbg-seg' });
      var t1 = el('button', { title: '按 CSS 选择器指定选区' }, ['# 指定']); 
      var t2 = el('button', { title: '真实点击穿透：放行一次点击让页面打开菜单/弹层（冻结期间菜单不会消失）' }, ['👆 穿透']);
      var t3 = el('button', { title: '在宿主页自身点选元素（不进入目标 iframe）' }, ['🖥 宿主页']);
      t1.addEventListener('click', function () {
        var s = prompt('输入 CSS 选择器指定选区，例如 .card:nth-child(2)');
        if (s) ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_select', payload: { selector: s } });
      });
      t2.addEventListener('click', function () {
        ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_passthrough_click' });
        ctx.addMsg('sys', '👆 真实点击：放行一次点击（页面菜单/弹层可正常打开，随后恢复冻结）。');
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
      row1.appendChild(el('label', {}, ['动画速度']));
      var animBtns = el('div', { class: 'dbg-seg', 'data-opt': 'animSpeed' });
      [[0, '⏸ 暂停'], [0.1, '0.1x'], [0.25, '0.25x'], [0.5, '0.5x'], [1, '1x']].forEach(function (o) {
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
      row3.appendChild(el('label', {}, ['定时器慢放', '（实验性）']));
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
