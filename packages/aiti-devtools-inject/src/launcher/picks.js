// picks 子系统（ctx 模式，简化版）：页面错误 + 元素候选 → AI 窗口输入框候选区
//   页面错误（client 错误 hook 上报 dbg_page_error）→ 去重 + 取前 3 个 → postToAi(dbga_ai_error)
//   → pi-web aiti 扩展的候选区（与 inspect 选择的元素同机制，泛化 [xxxN] 占位符）：
//     自动插入输入框 [错误N]、chatInputTop 候选 chip、点击详情、发送时替换为完整错误详情。
//   元素候选（HUD 确认选中 / Inspect 确认 / dbg_ai_picked 转发）→ postToAi(dbg_ai_element)
//   → 扩展候选区 [元素N] + 输入框自动插入。
//   两者都带“缓存 + 定时重发 + 扩展 ack 回执”：扩展（pi-web）在 iframe load 后需动态加载 +
//   React 渲染 + useEffect 注册 onMsg，期间消息会丢——重发直到扩展确认（幂等去重）或消费。
export function initPicks(ctx) {
  // ---- 错误采集（routing.js dbg_page_error 调用；去重 + 只转发前 3 个） ----
  ctx.picksErrSeen = {};   // message 前 80 字符去重
  ctx.picksErrCount = 0;   // 已转发错误数（上限 3）
  ctx.picksPendingErrors = []; // AI 窗口未创建时缓存（页面崩溃早于用户开 💬；窗口 ready 后补发）
  // 打开 AI 窗（清理动作）→ 重置错误去重：client seen + 本侧 picksErrSeen/计数 + 清空待重发缓存；
  // 同消息在“未清理”时去除、清理后再次触发则重新上报（用户期待：点击 AI 图标即清理，下次触发再发）
  ctx.resetErrDedup = function () {
    ctx.picksErrSeen = {};
    ctx.picksErrCount = 0;
    ctx.picksPendingErrors = []; // 清空缓存：清理后旧错误不再定时重发（防“复活”）；下次触发重新上报
    try { if (window.__dbg && window.__dbg.resetErrorDedup) window.__dbg.resetErrorDedup(); } catch (e) {}
  };
  ctx.picksAddError = function (kind, message, stack, frameId) {
    var key = String(message || '').slice(0, 80);
    if (ctx.picksErrSeen[key]) {
      // 同一错误重复触发：候选区不重复转发（去重防风暴），并清掉 pendingErrors 中同 key 的旧错误（防补发/重发"复活"已发送的错误）；FAB 仍闪烁提示
      if (ctx.picksPendingErrors) {
        ctx.picksPendingErrors = ctx.picksPendingErrors.filter(function (e2) {
          return String((e2.payload && e2.payload.message) || '').slice(0, 80) !== key;
        });
      }
      try { if (ctx.fabErrNotify) ctx.fabErrNotify(ctx.picksPendingErrors ? ctx.picksPendingErrors.length : 0); } catch (e) {}
      return;
    }
    ctx.picksErrSeen[key] = 1;
    if (ctx.picksErrCount >= 3) {
      // 候选区已满（前 3 个）——不再转发新错误，但 FAB 仍要闪（用户每次触发都应看到反馈）
      try { if (ctx.fabErrNotify) ctx.fabErrNotify(ctx.picksPendingErrors ? ctx.picksPendingErrors.length : 0); } catch (e) {}
      return; // 只放前 3 个到候选区
    }
    ctx.picksErrCount++;
    // 【归属定死点】同 picksAddElement：错误候选也在生成时刻捕获 selfAiRequested 为 _selfAttrib，
    // 发送（含定时重发）时 postToAi 用 msg._selfAttrib 而非发送时的易变标志（异步时序下已被复位），
    // 避免错误候选在 host-protocol 页被误丢进 host self。
    var msg = {
      type: 'dbg_ai_error',
      _selfAttrib: !!ctx.selfAiRequested,
      payload: {
        kind: kind || 'error',
        message: String(message || ''),
        stack: stack ? String(stack) : null,
        frameId: frameId || null,
        at: new Date().toISOString(),
      },
    };
    if (ctx.aiIframe) {
      // AI 窗口已建：ready 前自动进 aiQueue，load 后 flush；同时保留引用供延迟补发（扩展 React 渲染就绪前消息会丢）
      ctx.postToAi(msg);
      ctx.picksPendingErrors.push(msg);
    } else {
      // AI 窗口未建（用户还没点 💬）——缓存，ensureAi 创建 + load 后补发（见 aiwin.js）
      ctx.picksPendingErrors.push(msg);
    }
    // 保留最近 3 个错误引用（load/showAi 多轮补发用；扩展侧按消息去重，幂等）
    if (ctx.picksPendingErrors.length > 3) ctx.picksPendingErrors.shift();
    // FAB 角标提醒（AI 窗未开时闪；开着则内部自动跳过不打扰）
    try { if (ctx.fabErrNotify) ctx.fabErrNotify(ctx.picksPendingErrors.length); } catch (e) {}
    // 定时重发兜底：扩展（pi-web）在 iframe load 后需动态加载 + React 渲染 + useEffect 注册 onMsg，
    // 期间消息会丢——每 2s 重发一次（扩展侧按消息去重，幂等），直到错误被消费（发送后清除）或超时。
    if (!ctx.picksRetryTimer) {
      ctx.picksRetryTimer = setInterval(function () {
        if (!ctx.picksPendingErrors || !ctx.picksPendingErrors.length) {
          clearInterval(ctx.picksRetryTimer);
          ctx.picksRetryTimer = null;
          return;
        }
        ctx.picksPendingErrors.slice().forEach(function (m) { ctx.postToAi(m); });
      }, 2000);
    }
    ctx.addMsg('sys', '⚠ 页面错误 [' + (kind || 'error') + '] ' + String(message || '').slice(0, 80) + ' → 已放入 AI 输入框候选区（[错误' + ctx.picksErrCount + ']）');
  };

  // ---- 元素候选（HUD 确认选中 / Inspect 确认 / dbg_ai_picked 转发）：缓存 + 定时重发 + ack ----
  // 扩展 onMsg 在 React useEffect 注册，AI 窗刚打开/重载时未就绪 → 消息会丢。
  // 与错误候选同机制：发送即缓存，每 1.5s 重发（扩展侧按事件指纹幂等），收到 ack 停止。
  // 元素点选语义（区别于错误的永久去重）：同一元素重复确认 → 宿主侧合并回同一候选
  // （[元素1] 还是 [元素1]，内容刷新）；msg.fp 为唯一事件指纹（重发 ack 幂等），
  // payload.__elfp 为元素指纹（稳定，合并判定用），ts 供已清除候选的复活判定。
  ctx.picksElSeq = 0;         // 事件序号：同一元素多次确认 → 事件指纹各不相同（ack 独立）
  ctx.picksElLastAt = {};     // 元素指纹 → 上次确认时间（短窗防抖）
  ctx.picksPendingElements = []; // 未 ack 的元素候选（AI 窗未就绪时缓存 + 重发）
  ctx.picksElFp = function (p) {
    if (!p || typeof p !== 'object') return '';
    return String(p.xpath || p.selector || '') + '|' + (p.tag || '') + '|' + String(p.text || '').slice(0, 40);
  };
  // 元素载荷异步补全真实源码路径：payload.framework.react19Chunk/usedAtChunk（chunk 定位）→
  // 经宿主 __dbg.resolveChunkSource（client 同源 sourcemap 解码）还原源文件+行。
  // 目录聚合 chunk（components_03gcaqz._.js 等）chunk 名无法解码，sourcemap 是唯一可靠来源——
  // AI 窗详情/候选显示真实文件路径而非 chunk URL。无宿主 client / 解析失败 → 原样返回（回落）。
  ctx.resolveElLoc = function (payload) {
    var fw = payload && payload.framework;
    if (!fw || typeof fw !== 'object') return Promise.resolve(payload);
    var fc = fw.react19Chunk, uc = fw.usedAtChunk;
    if (!fc && !uc) {
      // 预算耗尽（无 chunk 定位）：先组件函数→真实行号，再降级组件名→文件（无行号）——React 19.2 预算耗尽时 owner-stack 无行号
      if (!fw.file && (fw.fnLocs || fw.component)) {
        var host = null;
        try { host = (window && window.__dbg) ? window.__dbg : null; } catch (e) {}
        if (host && typeof host.resolveFnLine === 'function' && fw.fnLocs) {
          return host.resolveFnLine(fw.fnLocs).then(function (r) {
            if (r && r.file) { fw.file = r.file; fw.line = r.line; fw.column = r.column; payload.file = r.file; payload.line = r.line; return payload; }
            return ctx.resolveElLocCompFallback ? ctx.resolveElLocCompFallback(payload, host) : Promise.resolve(payload);
          });
        }
        return ctx.resolveElLocCompFallback ? ctx.resolveElLocCompFallback(payload, host) : Promise.resolve(payload);
      }
      return Promise.resolve(payload);
    }
    var host = null;
    try { host = (window && window.__dbg && typeof window.__dbg.resolveChunkSource === 'function') ? window.__dbg : null; } catch (e) {}
    if (!host) return Promise.resolve(payload);
    var p1 = host.resolveChunkSource(fc.url, fc.line, fc.column);
    var p2 = uc ? host.resolveChunkSource(uc.url, uc.line, uc.column) : Promise.resolve(null);
    return Promise.all([p1, p2]).then(function (rs) {
      var r = rs[0], u = rs[1];
      if (r && r.file) { fw.file = r.file; fw.line = r.line; fw.column = r.column; }
      if (u && u.file && fw.usedAt) { fw.usedAt.file = u.file; fw.usedAt.line = u.line; }
      if (fw.file !== undefined) payload.file = fw.file;
      if (fw.line !== undefined) payload.line = fw.line;
      if (fw.usedAt) payload.usedAt = fw.usedAt;
      delete fw.react19Chunk; delete fw.usedAtChunk;
      // chunk 解析失败 + 有函数签名/组件名：组件函数→真实行号 → 组件名→文件
      if (!fw.file && (fw.fnLocs || fw.component)) {
        if (host && typeof host.resolveFnLine === 'function' && fw.fnLocs) {
          return host.resolveFnLine(fw.fnLocs).then(function (r) {
            if (r && r.file) { fw.file = r.file; fw.line = r.line; fw.column = r.column; payload.file = r.file; payload.line = r.line; return payload; }
            return ctx.resolveElLocCompFallback ? ctx.resolveElLocCompFallback(payload, host) : Promise.resolve(payload);
          });
        }
        return ctx.resolveElLocCompFallback ? ctx.resolveElLocCompFallback(payload, host) : Promise.resolve(payload);
      }
      return payload;
    });
  };
  // 组件名→文件（无行号）兜底（resolveElLoc 共用）
  ctx.resolveElLocCompFallback = function (payload, host) {
    var fw = payload && payload.framework;
    if (!fw || !fw.component) return Promise.resolve(payload);
    if (host && typeof host.resolveComponentFile === 'function') {
      return host.resolveComponentFile(fw.component).then(function (f) {
        if (f) { fw.file = f; payload.file = f; }
        return payload;
      });
    }
    return Promise.resolve(payload);
  };
  ctx.picksAddElement = function (payload) {
    var fp0 = ctx.picksElFp(payload);
    if (!fp0) return null;
    var last = ctx.picksElLastAt[fp0] || 0;
    if (Date.now() - last < 500) return null; // 同一事件双发（确认同时触发 HUD + 报告）——只发一次
    ctx.picksElLastAt[fp0] = Date.now();
    // 归属在生成时刻定死（selfAiRequested）：宿主顶部自点选→归 host；AI 窗点选/FAB→归 AI。
    // 发送经 resolveElLoc 异步晚于 exit* 复位，必须带上生成时的归属，否则会误路由（见 postToAi）。
    var _selfAttrib = !!ctx.selfAiRequested;
    var _send = function () {
      var pl = Object.assign({}, payload, { __elfp: fp0 });
      var fp = fp0 + '#' + (++ctx.picksElSeq); // 唯一事件指纹：重发按事件幂等
      var msg = { type: 'dbg_ai_element', payload: pl, fp: fp, ts: Date.now(), _selfAttrib: _selfAttrib };
      ctx.picksPendingElements.push(msg);
      if (ctx.picksPendingElements.length > 5) ctx.picksPendingElements.shift();
      ctx.postToAi(msg);
      if (!ctx.picksElRetryTimer) {
        ctx.picksElRetryTimer = setInterval(function () {
          if (!ctx.picksPendingElements || !ctx.picksPendingElements.length) {
            clearInterval(ctx.picksElRetryTimer);
            ctx.picksElRetryTimer = null;
            return;
          }
          ctx.picksPendingElements.slice().forEach(function (m) { ctx.postToAi(m); });
        }, 1500);
      }
    };
    // React 19.2+ chunk 定位 → 先 sourcemap 还原真实源文件再发（候选详情显示真实路径而非 chunk URL）
    ctx.resolveElLoc(payload).then(_send);
    return null; // 异步发送：不返回 fp（全部调用方忽略返回值）
  };
  // 扩展 ack：元素已进候选区/输入框 → 从重发列表移除（全部消费后停定时器）
  ctx.picksElAck = function (fp) {
    if (!fp) return;
    ctx.picksPendingElements = (ctx.picksPendingElements || []).filter(function (m) { return m.fp !== fp; });
    if (!ctx.picksPendingElements.length && ctx.picksElRetryTimer) {
      clearInterval(ctx.picksElRetryTimer);
      ctx.picksElRetryTimer = null;
    }
  };
}
