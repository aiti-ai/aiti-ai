// 页面内注入的迷你 __dbg client（真实 JS 文件；构建时由 vite 插件 esbuild 打包成字符串注入）
// 注入方式：宿主自身 new Function('__DBG_POST__', code)（__DBG_POST__ 为自由变量）；同源 iframe 用 <script>.textContent
// 注意：此文件保持单一 IIFE 结构（共享闭包状态），任何改动必须过 21 项自检
/* global __DBG_POST__, __DBG_VERSION__ */

  (function () {
    'use strict';
    // 幂等检查：同版本且关键能力齐全才跳过；旧版残留（缺新能力/退出不清理）→ 清理监听 + 覆盖（防退出后仍可点选）
    if (window.__dbg && window.__dbg.__version__ && typeof window.__dbg.getSelectionPayload === 'function') return;
    if (window.__dbg && window.__dbg.__version__) {
      try { if (typeof window.__dbg.exitInspector === 'function') window.__dbg.exitInspector(); } catch (e) {}
      try { delete window.__dbg; } catch (e) {}
    }

    // hover：标准蓝实线描边，不填充背景（fill 的 rgba(79,70,229,.10) 叠加页面=淡蓝透明罩，用户误认遮罩）
    var OUTLINE_HOVER = '2px solid #4f46e5';
    var OUTLINE_SEL   = '2px dashed #059669';

    // 真实 URL 探测：launcher 注入在顶层时 location.href 即地址栏 URL；
    // 注入在 iframe 内（如 pi-web 预览壳嵌真实站点）时，用户地址栏看到的是外层 URL——
    // 同源可读 window.top/window.parent；跨域读不到则用 document.referrer（跨域 iframe 的 referrer 是外层页 URL）兜底。
    function topUrl() {
      var isTop = false;
      try { isTop = (window.self === window.top); } catch (e) {}
      if (isTop) { try { return (window.location && window.location.href) || ''; } catch (e) {} }
      try { if (window.top && window.top !== window && window.top.location && window.top.location.href) return window.top.location.href; } catch (e) {}
      try { if (window.parent && window.parent !== window && window.parent.location && window.parent.location.href) return window.parent.location.href; } catch (e) {}
      try { var r = document.referrer || ''; if (r) return r; } catch (e) {}
      try { return (window.location && window.location.href) || ''; } catch (e) {}
      return '';
    }

    var state = {
      active: false,
      engaged: false, // 临时选择状态：点击后进入（hover 停用、工具条保留），✓确认/✕取消退出
      hovered: null,
      selected: null,
      hoverOutline: { node: null },
      selOutline: { node: null },
    };

    // ---------- 工具 ----------
    // post 可注入：self 模式（注入宿主页自身）用 __DBG_POST__ 回调；iframe 模式走 parent.postMessage
    var POST = (typeof __DBG_POST__ === 'function') ? __DBG_POST__ : null;
    function post(msg) {
      if (POST) { try { POST({ __dbg: 1, ...msg }); } catch (e) {} return; }
      try {
        window.parent.postMessage(JSON.parse(JSON.stringify({ __dbg: 1, ...msg })), '*');
      } catch (e) {}
    }

    function drawOutline(outline, el, color, bg, marker) {
      if (!outline.node) {
        outline.node = document.createElement('div');
        Object.assign(outline.node.style, {
          position: 'fixed', pointerEvents: 'none', zIndex: 2147483646,
          outline: color, background: bg, borderRadius: '2px', margin: '0',
        });
      }
      var r = el.getBoundingClientRect();
      Object.assign(outline.node.style, {
        left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', outline: color, background: bg,
      });
      if (!outline.node.parentNode) document.body.appendChild(outline.node);
    }
    function clearOutline(outline) {
      if (outline && outline.node && outline.node.parentNode) outline.node.parentNode.removeChild(outline.node);
      if (outline) outline.node = null;
    }

    function xpathOf(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '//*[@id="' + String(el.id).replace(/"/g, '\\"') + '"]';
      var parts = [];
      var node = el;
      while (node && node.nodeType === 1) {
        var idx = 1;
        for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
          if (sib.tagName === node.tagName) idx++;
        }
        parts.unshift(node.tagName.toLowerCase() + '[' + idx + ']');
        node = node.parentElement;
      }
      return '/' + parts.join('/');
    }

    // computedStyles 白名单（§3.7 参考实现：默认值跳过）
    var CSS_WHITELIST = [
      'display', 'position', 'top', 'left', 'width', 'height',
      'padding', 'margin', 'border', 'borderRadius', 'zIndex',
      'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'textAlign',
      'backgroundColor', 'backgroundImage', 'boxShadow', 'opacity', 'overflow',
      'flexDirection', 'alignItems', 'justifyContent', 'gap',
      'gridTemplateColumns', 'gridTemplateRows',
    ];
    var SKIP_DEFAULTS = { initial: 1, inherit: 1, normal: 1, auto: 1, none: 1, '0px': 1 };

    function serialize(el, opts) {
      opts = opts || {};
      var out = { tag: el.tagName.toLowerCase() };
      var r = el.getBoundingClientRect();
      // 视口坐标 rect（CDP Input.dispatchMouseEvent 同系，可直接点元素）+ 文档坐标 docRect（滚动无关，判断页面绝对位置/滚动后仍可定位）
      // + scroll（采样时滚动偏移 = 坐标系上下文标注：docRect = rect + scroll）
      var _sx = window.scrollX || document.documentElement.scrollLeft || document.body.scrollLeft || 0;
      var _sy = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
      out.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      out.docRect = { x: Math.round(r.x + _sx), y: Math.round(r.y + _sy), w: out.rect.w, h: out.rect.h };
      out.scroll = { x: _sx, y: _sy };
      if (opts.attrs) {
        out.attributes = {};
        var attrs = el.attributes;
        for (var i = 0; i < attrs.length && i < 30; i++) {
          out.attributes[attrs[i].name] = String(attrs[i].value).slice(0, 200);
        }
      }
      if (opts.xpath) out.xpath = xpathOf(el);
      if (opts.text) {
        out.text = cleanTextOf(el, 512);
      }
      if (opts.computed) {
        out.computed = {};
        var cs = getComputedStyle(el);
        CSS_WHITELIST.forEach(function (k) {
          var v = cs[k];
          if (v && !SKIP_DEFAULTS[v]) out.computed[k] = String(v).slice(0, 300);
        });
      }
      if (opts.framework) out.framework = fileLocation(el);
      out.frame = { src: topUrl(), url: topUrl().slice(0, 200) };
      return out;
    }

    // ---------- 框架识别（§3.4 四框架 fileLocation） ----------
    function findFiber(el) {
      if (!el) return null;
      var keys = Object.getOwnPropertyNames(el);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return el[k] || null;
      }
      if (el._reactRootContainer && el._reactRootContainer._internalRoot) {
        return el._reactRootContainer._internalRoot.current || null;
      }
      return null;
    }

    function componentNameOf(type) {
      if (!type) return null;
      var n = null;
      if (typeof type === 'function') n = type.displayName || type.name || null;
      else if (typeof type === 'object') {
        n = (type.displayName || (type.render && (type.render.displayName || type.render.name)) ||
             (type.$$typeof ? null : null) || type.name) || null;
      }
      if (!n) return null;
      return cleanComponentName(n);
    }
    // 去 React 钩子推断名后缀（MarkdownBody.useMemo[components] → MarkdownBody），显示更可读
    function cleanComponentName(n) {
      if (!n) return null;
      return String(n).replace(/\.use(Memo|Callback|Effect|Ref|State|Reducer)\s*\[[^\]]*\]$/, '');
    }

    // ---------- React 19.2+ 源码定位（fiber._debugSource 已移除，改读 _debugStack） ----------
    // React 19.2+ 的 jsxDEV 不再收 source 对象，改为在调用处捕获 Error("react-stack-top-frame")：
    //   fiber._debugStack.stack 首帧 = jsx-dev-runtime 内部，第二帧 = JSX 调用点（chunk URL:line:col）；
    //   Next dev(Turbopack) 为 chunk 提供 .map 源映射 → 精确还原源文件+行。
    // 返回 {url, line, column, component}（首个非 react 内部帧 = JSX 调用点）；
    // 首帧 UnknownOwner（预算耗尽）→ 返回 {__unknownOwner:true}（调用方可据此停止向上遍历，防跳远处祖先）。
    function react19StackSrc(err) {
      try {
        var stack = (err && err.stack) || '';
        if (!stack) return null;
        var lines = stack.split('\n');
        // React 19.2 owner-stack 预算（recentlyCreatedOwnerStacks，1e4 次）耗尽后，jsxDEV 给所有新元素
        // 共享模块初始化时捕获的 unknownOwnerDebugStack（首帧 UnknownOwner，后续帧指向 jsx-dev-runtime
        // chunk 内部/模块求值）——这种栈无真实调用点，误当首帧会把 node_modules chunk 报成组件源码。
        // 真实栈首帧必是 exports.jsxDEV；首帧是 UnknownOwner → 整栈无真实定位，返回哨兵。
        var firstFn = null;
        // 归一化 Turbopack 路径转义（$2d=- $2f=/ …）便于匹配 react 内部帧
        var norm = function (s) { return String(s || '').replace(/\$([0-9a-fA-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); }); };
        for (var i = 1; i < lines.length; i++) {
          var ln = lines[i];
          var fn = null, url = null, line = null, col = null;
          var m = null;
          // Firefox: fn@url:line:col  /  @url:line:col
          m = ln.match(/^(?:([^@]*)@)?(.*?):(\d+)(?::(\d+))?$/);
          if (m && m[2]) { fn = m[1]; url = m[2]; line = parseInt(m[3], 10); col = m[4] ? parseInt(m[4], 10) : null; }
          else {
            // Chrome: at fn (url:line:col)  /  at fn@url:line:col（webpack-internal 风格）  /  at url:line:col
            m = ln.match(/^\s*at ([^\s(]+) ?\((.*?):(\d+)(?::(\d+))?\)$/);
            if (m) { fn = m[1]; url = m[2]; line = parseInt(m[3], 10); col = m[4] ? parseInt(m[4], 10) : null; }
            else {
              m = ln.match(/^\s*at (.*?):(\d+)(?::(\d+))?$/);
              if (m) { fn = null; url = m[1]; line = parseInt(m[2], 10); col = m[3] ? parseInt(m[3], 10) : null; }
            }
          }
          if (!url) continue;
          var nu = norm(url);
          var fn0 = (fn || '').replace(/^exports\.|^Object\./, '');
          if (firstFn === null) {
            firstFn = fn0 || '';
            if (/^(UnknownOwner)$/.test(firstFn)) return { __unknownOwner: true }; // 共享栈（预算耗尽）→ 无真实定位
          }
          // react 内部帧跳过：jsx-dev-runtime / jsx-runtime / react-dom / scheduler / next compiled react / turbopack 运行时 / HMR / 栈标记帧
          //   + RSC/SSR 伪帧：about://React/Server（服务端渲染）、react-server-dom-turbopack（RSC 反序列化）、
          //   fakeJSXCallSite（RSC 元素创建）、[root-of-the-server]/server chunks（SSR 根 chunk）——这些不是客户端真实 JSX 调用点
          if (/jsx[-.]dev[-.]runtime|jsx[-.]runtime|\.react-dom|react-dom[./]|scheduler[./]|next[./]dist[./]compiled[./]react[./]|turbopack[./_]|hmr-client|about:\/\/React\/Server|react-server-dom-turbopack|fakeJSXCallSite|root-of-the-server|\.next[-_]dev|server[./_]chunks/.test(nu)) continue;
          if (/^(jsxDEV|jsxs|jsx|createElement|react_stack_bottom_frame|react-stack-top-frame|fakeJSXCallSite)$/.test(fn0)) continue;
          var cname = fn0 || null;
          if (cname && /^(jsxDEV|jsxs|jsx|createElement|React\.createElement)$/.test(cname)) cname = null;
          return { url: url, line: line || 1, column: col || 1, component: cname };
        }
        return null;
      } catch (e) { return null; }
    }

    // Turbopack dev chunk 名 → 源文件路径（同步近似：components_AppShell_tsx_0s7278a._.js → components/AppShell.tsx）；
    // 解析失败返回 null（调用方回退用 chunk URL 原样）。行号需 sourcemap 精确化（react19Chunk 异步补全）。
    function chunkNameToPath(chunkUrl) {
      try {
        var u = String(chunkUrl || '').split('?')[0];
        var base = u.split('/').pop() || '';
        var m = base.match(/^(.+?)_([0-9a-z-]+)\._\.js$/);
        if (!m) return null;
        var segs = m[1].split('_');
        var extSeg = segs.pop() || '';
        if (!/^[a-z]{2,5}$/.test(extSeg)) return null; // 非源码 chunk（目录/工具 chunk）→ 放弃
        var dec = function (s) { return s.replace(/\$([0-9a-fA-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); }); };
        var p = segs.map(dec).join('/') + '.' + extSeg;
        return p || null;
      } catch (e) { return null; }
    }

    // ---- sourcemap v3 解码（VLQ + sections）——把 chunk 位置映射到源文件 ----
    var _SM_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    // 解析结果缓存：同一 map 对象只解析一次（大 map 的 mappings 全量重解析开销可观，confirm 流程同 chunk 查 2 次）
    var _smRowsCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    function smSegFields(seg) {
      var fields = [], pos = 0, result, shift, digit;
      while (pos < seg.length) {
        result = 0; shift = 0;
        do {
          digit = _SM_BASE64.indexOf(seg.charAt(pos++));
          result += ((digit & 31) << shift);
          shift += 5;
        } while (digit & 32);
        var neg = result & 1;
        fields.push(neg ? -(result >>> 1) : (result >>> 1));
      }
      return fields;
    }
    function smParseMappings(mappings) {
      var lines = String(mappings || '').split(';');
      var rows = new Array(lines.length);
      var srcIdx = 0, srcLine = 0, srcCol = 0;
      for (var i = 0; i < lines.length; i++) {
        var segs = lines[i] ? lines[i].split(',') : [];
        var row = null;
        var genCol = 0; // 生成列是每行内增量（行首归零）
        for (var j = 0; j < segs.length; j++) {
          if (!segs[j]) continue;
          var f = smSegFields(segs[j]);
          genCol += f[0];
          if (f.length >= 4) {
            srcIdx += f[1]; srcLine += f[2]; srcCol += f[3];
            if (!row) row = [];
            row.push([genCol, srcIdx, srcLine, srcCol]);
          }
        }
        rows[i] = row;
      }
      return rows;
    }
    function smLookup(mapData, line0, col0) {
      // line0/col0 为 0 基；支持 sections 索引映射
      if (mapData.sections && mapData.sections.length) {
        for (var i = 0; i < mapData.sections.length; i++) {
          var sec = mapData.sections[i];
          var off = sec.offset || { line: 0, column: 0 };
          if (line0 >= off.line && sec.map) {
            var r = smLookup(sec.map, line0 - off.line, col0);
            if (r) return r;
          }
        }
        return null;
      }
      // 解析结果缓存（同 map 只解析一次）；无 WeakMap 环境回退每次都解析
      var rows;
      if (_smRowsCache) {
        rows = _smRowsCache.get(mapData);
        if (!rows) { rows = smParseMappings(mapData.mappings || ''); _smRowsCache.set(mapData, rows); }
      } else {
        rows = smParseMappings(mapData.mappings || '');
      }
      if (line0 < 0 || line0 >= rows.length || !rows[line0]) return null;
      var row = rows[line0], best = null;
      for (var k = 0; k < row.length; k++) { if (row[k][0] <= col0) best = row[k]; else break; }
      if (!best) return null;
      var src = (mapData.sources || [])[best[1]];
      if (!src) return null;
      return { file: src, line: best[2] + 1, column: best[3] + 1 };
    }
    var _chunkMapCache = Object.create(null); // chunkUrl → Promise<mapData|null>
    function fetchChunkMap(chunkUrl) {
      var u = String(chunkUrl).split('#')[0];
      var cached = _chunkMapCache[u];
      if (cached !== undefined) {
        // 失败（null）不永久缓存——重试（页面网络抖动首次拉取失败会让整 chunk 永远解析不出 → 显示 chunk URL）
        return cached.then(function (d) { return d ? d : _doFetchMap(u); });
      }
      _chunkMapCache[u] = _doFetchMap(u);
      return _chunkMapCache[u];
    }
    function _doFetchMap(u) {
      // Turbopack/Next dev 的 stack chunk URL 带 ?id= 查询串，原样拼 .map 会 404——先剥查询串再取；
      // 失败回退原样拼（Vite dev 的 ?t= 时间戳等场景查询串参与寻址）
      return fetch(u.replace(/\?.*$/, '') + '.map', { cache: 'force-cache' })
        .then(function (r) {
          return r.ok ? r.json() : fetch(u + '.map', { cache: 'force-cache' }).then(function (r2) { return r2.ok ? r2.json() : null; });
        })
        .catch(function () { return null; });
    }
    // chunk 位置 → 真实源文件（file:/// 前缀剥离；webpack:// 前缀剥离；[project]/ 前缀剥离）
    // 精确行列未命中时邻域回退（±1 行/列，上限 ±40 行）：React owner-stack 帧（jsxDEV 多行调用的收尾行 }、this),）
    // 常与映射段差几行几列；多行 jsxDEV 调用结尾行（如 }, this)）在 sourcemap 里是空白（只映射开头），
    // 需要更宽的行扫描才能命中同文件邻近映射段。
    function resolveChunkSource(chunkUrl, line, column) {
      return fetchChunkMap(chunkUrl).then(function (mapData) {
        if (!mapData) return null;
        var l0 = Math.max(0, (line || 1) - 1), c0 = Math.max(0, (column || 1) - 1);
        var hit = smLookup(mapData, l0, c0);
        if (!hit) {
          var cands = [[0, 1], [1, 0], [1, 1], [-1, 0], [-1, 1], [2, 0], [2, 1], [-2, 0], [3, 0], [3, 1], [-3, 0], [4, 0], [4, 1], [-4, 0], [0, 2], [0, -1], [0, -2], [0, 3], [0, -3]];
          for (var ci = 0; ci < cands.length && !hit; ci++) {
            var nl = l0 + cands[ci][0], nc = c0 + cands[ci][1];
            if (nl < 0 || nc < 0) continue;
            hit = smLookup(mapData, nl, nc);
          }
        }
        if (!hit) {
          // 更宽行扫描（±40 行，仅精确+近邻都 miss 时）：覆盖多行 jsxDEV 调用收尾行等空白区，
          // 取最近命中（同文件邻近段）——宁可给出真实行也不留 chunk URL
          for (var dist = 5; dist <= 40 && !hit; dist++) {
            if (l0 - dist >= 0) hit = smLookup(mapData, l0 - dist, c0);
            if (!hit) hit = smLookup(mapData, l0 + dist, c0);
          }
        }
        if (!hit) return null;
        var f = String(hit.file || '')
          .replace(/^file:\/\/\//, '/')
          .replace(/^file:\/\//, '')
          .replace(/^webpack:\/\//, '')
          .replace(/^\[project\]\//, '');
        return f ? { file: f, line: hit.line, column: hit.column } : null;
      }).catch(function () { return null; });
    }

    // ---- 组件名 → 源文件（预算耗尽兜底） ----
    // React 19.2 owner-stack 预算（1e4）耗尽后新元素全部 UnknownOwner，元素级行号不可得（React 硬限制）。
    // 但组件名仍可从 fiber 链拿到——扫描已加载 chunks 的 sourcemap sourcesContent，按组件定义模式找归属文件，
    // 至少给用户「文件」（无行号，可打开编辑器定位）。懒构建 + 缓存。
    var _compFileCache = null; // {componentName: file|null}
    var _compFilePatternCache = null; // {name: RegExp}
    function compDefPattern(name) {
      if (_compFilePatternCache && _compFilePatternCache[name]) return _compFilePatternCache[name];
      var n = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var p = new RegExp('function\\s+' + n + '\\b|(?:const|let|var)\\s+' + n + '\\b|' + n + '\\s*=\\s*(?:memo|forwardRef|React\\.memo)|export\\s+default\\s+(?:function|const)\\s+' + n + '\\b');
      if (!_compFilePatternCache) _compFilePatternCache = {};
      _compFilePatternCache[name] = p;
      return p;
    }
    function findComponentInMap(mapData, name) {
      var pat = compDefPattern(name);
      var sections = (mapData && mapData.sections && mapData.sections.length) ? mapData.sections : [{ map: mapData }];
      for (var si = 0; si < sections.length; si++) {
        var sm = (sections[si] && sections[si].map) || {};
        var sources = sm.sources || [];
        var contents = sm.sourcesContent || [];
        for (var j = 0; j < sources.length && j < contents.length; j++) {
          var c = contents[j];
          if (c == null) continue;
          if (pat.test(c)) {
            return String(sources[j]).replace(/^file:\/\/\//, '/').replace(/^file:\/\//, '').replace(/^\[project\]\//, '');
          }
        }
      }
      return null;
    }
    function collectComponentChunkUrls() {
      var urls = [];
      var push = function (u) { if (u && urls.indexOf(u) < 0) urls.push(u); };
      try {
        (performance.getEntriesByType('resource') || []).forEach(function (e) {
          var u = e.name || '';
          if (/\/_next\/static\/chunks\/components_.*\._\.js$/.test(u)) push(u.split('?')[0]);
        });
      } catch (e) {}
      try {
        document.querySelectorAll('script[src]').forEach(function (s) {
          var u = s.src || '';
          if (/\/_next\/static\/chunks\/components_.*\._\.js$/.test(u)) push(u.split('?')[0]);
        });
      } catch (e) {}
      return urls;
    }
    function resolveComponentFile(name) {
      if (!name) return Promise.resolve(null);
      if (_compFileCache && name in _compFileCache) return Promise.resolve(_compFileCache[name]);
      var urls = collectComponentChunkUrls();
      var proms = urls.map(function (u) {
        return fetchChunkMap(u).then(function (md) { return md ? findComponentInMap(md, name) : null; });
      });
      return Promise.all(proms).then(function (results) {
        var f = null;
        for (var i = 0; i < results.length; i++) { if (results[i]) { f = results[i]; break; } }
        if (!_compFileCache) _compFileCache = {};
        _compFileCache[name] = f;
        return f;
      });
    }

    // ---- 预算耗尽兜底（真实行号）：组件函数 toString → 定位 chunk 行 → sourcemap 精确源文件+行 ----
    // React 19.2 owner-stack 预算耗尽时元素级行号不可得，但组件函数对象始终在 fiber 上。
    // 开发构建 chunk 保留可读函数签名（function MarkdownBody({…})），用 toString 前几行的独特子串
    // 定位函数在 chunk 里的行号，再经 sourcemap 还原源文件+行（组件定义行，非 JSX 调用行，但真实可打开）。
    var _chunkTextCache = null; // {url: text}
    function fetchChunkText(url) {
      var u = String(url || '').split('?')[0];
      if (_chunkTextCache && u in _chunkTextCache) return Promise.resolve(_chunkTextCache[u]);
      return fetch(u, { cache: 'force-cache' })
        .then(function (r) { return r.ok ? r.text() : null; })
        .catch(function () { return null; })
        .then(function (t) { if (!_chunkTextCache) _chunkTextCache = {}; _chunkTextCache[u] = t; return t; });
    }
    // 函数 toString → 独特搜索子串候选：函数体多个较长单行（≥20 字符，独特且可单行精确搜索）+ 签名首行。
    // 注意 chunk 保留原始换行/缩进，跨行拼接子串会因换行符匹配不上——必须用单行精确搜索。
    function fnLocSignature(fn) {
      try {
        var src = String(fn);
        var lines = src.split('\n');
        var sig = (lines[0] || '').trim().slice(0, 90);
        var arr = [];
        for (var b = 1; b < lines.length && arr.length < 3; b++) {
          var t = (lines[b] || '').trim();
          if (t.length >= 20) { arr.push(t.slice(0, 90)); }
        }
        if (sig) arr.push(sig);
        return arr;
      } catch (e) { return []; }
    }
    function collectChunkTextUrls() {
      var urls = [];
      var push = function (u) { if (u && urls.indexOf(u) < 0) urls.push(u); };
      try {
        (performance.getEntriesByType('resource') || []).forEach(function (e) {
          var u = e.name || '';
          if (/\/_next\/static\/chunks\/.*\._\.js$/.test(u)) push(u.split('?')[0]);
        });
      } catch (e) {}
      // 优先 components 目录 chunk（应用组件所在地），再补其他
      return urls.sort(function (a, b) {
        var ar = /components_/.test(a) ? 0 : 1, br = /components_/.test(b) ? 0 : 1;
        return ar - br;
      }).slice(0, 15);
    }
    function locateFnSig(text, sig) {
      var idx = text.indexOf(sig);
      if (idx < 0) return null;
      var upTo = text.slice(0, idx);
      var line0 = upTo.split('\n').length - 1;
      return { line1: line0 + 1, col: upTo.split('\n').pop().length };
    }
    // fnLocs: [{name, sigs:[]}]（离元素最近的函数组件在前）→ 真实 {file,line,column}。
    // 鲁棒性：同一 fnLoc 的多个独特行须 ≥2 行解析到同一文件才采信（防通用行跨文件撞车），
    // 否则跳过该 fnLoc 试下一个；跳过 node_modules。
    function resolveFnLine(fnLocs) {
      if (!fnLocs || !fnLocs.length) return Promise.resolve(null);
      var urls = collectChunkTextUrls();
      function resolveFnLoc(fl) {
        var sigs = fl.sigs || [];
        var results = [];
        function nextSig(si) {
          if (si >= sigs.length) return Promise.resolve(results);
          var sig = sigs[si];
          function nextChunk(ui) {
            if (ui >= urls.length) return Promise.resolve(null);
            return fetchChunkText(urls[ui]).then(function (text) {
              var pos = text ? locateFnSig(text, sig) : null;
              if (!pos) return nextChunk(ui + 1);
              return resolveChunkSource(urls[ui], pos.line1, pos.col).then(function (res) {
                if (res && res.file && !/node_modules/.test(res.file)) return res; // 应用文件 → 采用
                return nextChunk(ui + 1); // node_modules/未命中 → 继续
              });
            });
          }
          return nextChunk(0).then(function (res) { results.push(res); return nextSig(si + 1); });
        }
        return nextSig(0).then(function () {
          // 一致性：≥2 行解析到同一文件名才采信
          var counts = {};
          results.forEach(function (r) { if (r && r.file) { var base = r.file.split('/').pop(); counts[base] = (counts[base] || 0) + 1; } });
          var best = null, bestCount = 0;
          for (var k in counts) { if (counts[k] > bestCount) { bestCount = counts[k]; best = k; } }
          if (bestCount >= 2) {
            for (var i = 0; i < results.length; i++) { if (results[i] && results[i].file.split('/').pop() === best) return results[i]; }
          }
          return null; // 无一致确认 → 跳过该 fnLoc
        });
      }
      function step(fi) {
        if (fi >= fnLocs.length) return Promise.resolve(null);
        return resolveFnLoc(fnLocs[fi]).then(function (res) { if (res) return res; return step(fi + 1); });
      }
      return step(0);
    }

    // framework 载荷异步补全：react19Chunk/usedAtChunk（chunk 定位）→ sourcemap 精确源文件+行。
    // 返回复制后的 framework（不改原对象）；无 chunk 字段立即 resolve 原样。
    // 供 confirmSelection（预览）与 AI 点选/候选（dbg_ai_picked → dbg_ai_element）共用——
    // 目录聚合 chunk（components_03gcaqz._.js 之类）chunk 名无法解码，必须 sourcemap 才能还原真实源文件。
    function resolveFrameworkLoc(fl) {
      if (!fl || typeof fl !== 'object') return Promise.resolve(fl);
      var fc = fl.react19Chunk, uc = fl.usedAtChunk;
      if (!fc && !uc) {
        // 预算耗尽（无 chunk 定位）：先组件函数→真实行号，再降级组件名→文件（无行号）
        if (!fl.file && fl.fnLocs) return resolveFnLine(fl.fnLocs).then(function (r) {
          if (r && r.file) { var o = Object.assign({}, fl); o.file = r.file; o.line = r.line; o.column = r.column; return o; }
          if (fl.component) return resolveComponentFile(fl.component).then(function (f) {
            if (f) { var o2 = Object.assign({}, fl); o2.file = f; return o2; }
            return fl;
          });
          return fl;
        });
        if (!fl.file && fl.component) {
          return resolveComponentFile(fl.component).then(function (f) {
            if (f) { var o = Object.assign({}, fl); o.file = f; return o; }
            return fl;
          });
        }
        return Promise.resolve(fl);
      }
      var out = Object.assign({}, fl);
      var p1 = fc ? resolveChunkSource(fc.url, fc.line, fc.column) : Promise.resolve(null);
      var p2 = uc ? resolveChunkSource(uc.url, uc.line, uc.column) : Promise.resolve(null);
      return Promise.all([p1, p2]).then(function (rs) {
        var r = rs[0], u = rs[1];
        if (r && r.file) { out.file = r.file; out.line = r.line; out.column = r.column; }
        if (u && u.file && out.usedAt) out.usedAt = Object.assign({}, out.usedAt, { file: u.file, line: u.line });
        delete out.react19Chunk; delete out.usedAtChunk;
        // chunk 解析失败 + 有函数签名/组件名：组件函数→真实行号 → 组件名→文件
        if (!out.file) {
          if (out.fnLocs) return resolveFnLine(out.fnLocs).then(function (r2) {
            if (r2 && r2.file) { out.file = r2.file; out.line = r2.line; out.column = r2.column; return out; }
            if (out.component) return resolveComponentFile(out.component).then(function (f) { if (f) out.file = f; return out; });
            return out;
          });
          if (out.component) return resolveComponentFile(out.component).then(function (f) { if (f) out.file = f; return out; });
        }
        return out;
      });
    }

    /** vue-inspector 行号查找：BFS 组件子树 vnode，找 el 对应 vnode 的 __v_inspector / data-v-inspector（"相对root路径:行:列"）
     *  vite-plugin-vue-inspector 编译注入 + _interopVNode 运行时从 data-v-inspector 挪到 props.__v_inspector；
     *  Vue DevTools "Open in Editor" 行号即此来源（与 __file 是否注入无关，全环境可用）。
     *  缓存：vnode 重渲染后 el 不变但模板位置不变——WeakMap + TTL 避免 hover 高频重复 BFS */
    var _vInspCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    var _vInspTTL = 2000;
    function findVInspector(comp, el) {
      if (!comp || !comp.subTree || !el) return null;
      if (_vInspCache) {
        try {
          var c = _vInspCache.get(el);
          if (c && Date.now() - c.at < _vInspTTL) return c.insp;
        } catch (e) {}
      }
      var found = null;
      var queue = [comp.subTree], i = 0;
      while (i < queue.length && i < 20000) {
        var n = queue[i++];
        if (!n || typeof n !== 'object') continue;
        if (n.el === el) {
          var p = n.props || {};
          found = p.__v_inspector || p['data-v-inspector'] || null;
          break;
        }
        var ch = n.children;
        if (ch && typeof ch === 'object') {
          if (Array.isArray(ch)) { for (var j = 0; j < ch.length; j++) queue.push(ch[j]); }
          else queue.push(ch);
        }
      }
      if (_vInspCache) {
        try { _vInspCache.set(el, { insp: found, at: Date.now() }); } catch (e) {}
      }
      return found;
    }

    /** 统一输出 {framework, file, line, column, component} —— AI 侧不感知框架差异 */
    function fileLocation(el) {
      if (!el) return null;
      var loc = null;
      // --- React / Next.js：fiber._debugSource（dev 构建才有） ---
      var fiber = findFiber(el);
      if (!fiber) {
        // 向上 5 层找挂载 fiber 的祖先
        var p = el.parentElement, depth = 0;
        while (p && depth < 5 && !fiber) { fiber = findFiber(p); p = p.parentElement; depth++; }
      }
      if (fiber) {
        var fw = (window.next || window.__NEXT_DATA__ || window.__next_f || document.getElementById('__next'))
          ? 'next' : 'react';
        var node = fiber;
        var prodComp = null; // 生产构建（无 _debugSource）兜底：记录组件名
        var nearComp = null; // 最近可读组件名（跳钩子推断名/单小写字母名）——预算耗尽无可定位时的兜底显示
        var uoStreak = 0;    // 连续 UnknownOwner（React 19.2 owner-stack 预算耗尽）计数——超阈值即停，防把远处祖先（如 AppShell）误报为组件
        var fnLocs = null;   // 离元素最近的函数组件 toString 签名（预算耗尽兜底算真实行号用）
        for (var i = 0; node && i < 30; i++) {
          var src = node._debugSource;
          var r19 = null;
          // React 19.2+：_debugSource 已移除，源码信息在 _debugStack（Error，stack 含 JSX 调用帧 → chunk URL:line:col）
          if (!src) {
            r19 = node._debugStack ? react19StackSrc(node._debugStack) : null;
            if (r19 && !r19.__unknownOwner) { src = r19; uoStreak = 0; }
            else { if (++uoStreak > 8) break; } // 预算耗尽（UnknownOwner 共享栈）/无栈/解析失败 → 无真实定位；连续过多即停（防跳远处祖先 AppShell）
          } else {
            uoStreak = 0;
          }
          if (src && src.fileName) {
            // host fiber（type 为字符串）也有 _debugSource，继续向上找真正的组件
            var compFiber = node;
            while (compFiber && typeof compFiber.type !== 'function') compFiber = compFiber.return;
            // 调用位置：向上找渲染当前组件的父组件（return.return 链上第一个 function 组件）的 _debugSource
            var usedAt = null;
            if (compFiber && compFiber.return) {
              var pf = compFiber.return;
              while (pf && typeof pf.type !== 'function') pf = pf.return;
              if (pf && pf._debugSource && pf._debugSource.fileName) {
                usedAt = { file: pf._debugSource.fileName, line: pf._debugSource.lineNumber, component: componentNameOf(pf.type) };
              }
            }
            loc = {
              framework: fw, file: src.fileName, line: src.lineNumber, column: src.columnNumber,
              component: compFiber ? componentNameOf(compFiber.type) : null,
              usedAt: usedAt,
            };
            break;
          } else if (r19 && r19.url) {
            // React 19.2+：file 先取 chunk 名解码路径（同步，无行号——chunk 行号≠源行号）；
            // 精确 文件+行 由 confirm 流程异步 sourcemap 解析（react19Chunk 字段携带 chunk 定位）
            var dec = chunkNameToPath(r19.url);
            loc = {
              framework: fw,
              file: dec || r19.url,
              line: null, column: null,
              component: cleanComponentName(r19.component) || componentNameOf(node.type),
              react19Chunk: { url: r19.url, line: r19.line, column: r19.column },
            };
            // 调用位置：本元素所属组件（return 链第一个 function）的 _debugOwner = 渲染它的父组件；
            // 父组件 fiber 的 _debugStack 含其 JSX 帧（父组件源码位置，异步补精确行列）
            var compFiber2 = node;
            while (compFiber2 && typeof compFiber2.type !== 'function') compFiber2 = compFiber2.return;
            var ow = compFiber2 && compFiber2._debugOwner;
            if (ow) {
              var os = ow._debugStack ? react19StackSrc(ow._debugStack) : null;
              // 仅当父组件定位可恢复（非预算耗尽/非 RSC 伪帧）才记调用位置——否则 usedAt 会变成 about://React/Server 之类的伪 URL
              if (os && os.url && !os.__unknownOwner) {
                var od = chunkNameToPath(os.url);
                loc.usedAt = { file: od || os.url, line: null, component: componentNameOf(ow.type) || os.component };
                loc.usedAtChunk = { url: os.url, line: os.line, column: os.column };
              }
            }
            break;
          }
          // 生产构建：无 _debugSource——记录第一个 function 组件名（后续循环可能拿到祖先的 src，兜底只在最后用）
          if (!prodComp && typeof node.type === 'function') prodComp = componentNameOf(node.type);
          // 最深可读组件名（兜底显示用）：跳钩子推断名（useMemo[…] 等）与单小写字母（如 p）名
          if (typeof node.type === 'function') {
            var _nc = componentNameOf(node.type);
            if (_nc && !/useMemo|useCallback|\.bind|_this\d|^[a-z]{1,3}$/.test(_nc)) nearComp = _nc;
          }
          // 捕获最近 2 个函数组件的 toString 签名（预算耗尽时定位真实行号用；离元素最近优先）
          if (typeof node.type === 'function' && (!fnLocs || fnLocs.length < 2)) {
            var _sigs = fnLocSignature(node.type);
            if (_sigs.length) (fnLocs = fnLocs || []).push({ name: componentNameOf(node.type) || null, sigs: _sigs });
          }
          node = node.return;
        }
        // 生产构建兜底：源码不可得，但组件名/调用链组件名仍在（fiber.return 链第一个 function 组件 = 本组件，再上 = 调用方）
        if (!loc && (nearComp || prodComp)) {
          var pu = null;
          var cur = fiber;
          var seen = false;
          while (cur && cur.return) {
            if (typeof cur.type === 'function') { if (!seen) seen = true; else { pu = { component: componentNameOf(cur.type), file: null, line: null }; break; } }
            cur = cur.return;
          }
          loc = { framework: fw, file: null, line: null, column: null, component: nearComp || prodComp, usedAt: pu, fnLocs: fnLocs || null };
        }
      }
      // --- Vue 3：el.__vueParentComponent.type.__file（dev 构建真实注入） ---
      // 注意：__file 不是总有（部分项目 dev 构建未注入——plugin-vue 与 compiler-sfc 版本不匹配/定制插件），
      //   但组件名（__name/name）与父组件名始终可得——无 __file 时仍输出 framework/component/usedAt（组件名级），file 置 null
      if (!loc && el.__vueParentComponent && el.__vueParentComponent.type) {
        var vp = el.__vueParentComponent.type;
        var vpFile = vp.__file || null;
        var vpName = vp.__name || vp.name || null;
        if (vpFile || vpName) {
          // 行号：vue-inspector 编译注入（vnode.props.__v_inspector = "相对root路径:行:列"——模板元素源码位置），
          //   与 __file 无关全环境可用（无 vue-inspector 的构建则为空——行号不可得）
          var inspLine = null, inspCol = null, inspRel = null;
          try {
            var _insp = findVInspector(el.__vueParentComponent, el);
            if (_insp) {
              var _im = String(_insp).match(/^(.*?):(\d+)(?::(\d+))?$/);
              if (_im && _im[1] && _im[2]) { inspRel = _im[1]; inspLine = parseInt(_im[2], 10); inspCol = _im[3] ? parseInt(_im[3], 10) : null; }
            }
          } catch (e) {}
          // 相对路径 → 绝对：__file 绝对路径末尾匹配相对路径（src/views/...）→ 前缀即项目根；无 __file 时保留相对路径（行号可显示）
          var absFile = vpFile || null;
          if (inspRel) {
            var _rel2 = inspRel.replace(/^\.\//, '');
            if (absFile) {
              if (absFile.slice(-_rel2.length) !== _rel2) {
                var _li = absFile.lastIndexOf('/' + _rel2);
                if (_li >= 0) absFile = absFile.slice(0, _li) + '/' + _rel2;
              }
            } else {
              absFile = inspRel;
            }
          }
          // 调用位置：真实产物无 __usedAt，从父实例推导（渲染本组件的组件 = .parent.type）
          var vu = vp.__usedAt || null;
          if (!vu && el.__vueParentComponent.parent && el.__vueParentComponent.parent.type) {
            var vpt = el.__vueParentComponent.parent.type;
            var vptName = vpt.__name || vpt.name || null;
            if (vpt && (vpt.__file || vptName)) {
              vu = { file: vpt.__file || null, component: vptName, line: null };
            }
          }
          loc = { framework: 'vue', file: absFile, line: inspLine, column: inspCol, component: vpName, usedAt: vu };
        }
      }
      // --- Vue 2：el.__vue__.$options.__file（无 __file 时也给出组件名/父组件名） ---
      if (!loc && el.__vue__ && el.__vue__.$options) {
        var o = el.__vue__.$options;
        var oName = o.name || null;
        if (o.__file || oName) {
          var vu2 = null;
          if (el.__vue__.$parent && el.__vue__.$parent.$options) {
            var op = el.__vue__.$parent.$options;
            var opName = op.name || null;
            if (op.__file || opName) vu2 = { file: op.__file || null, component: opName, line: null };
          }
          loc = { framework: 'vue', file: o.__file || null, component: oName, usedAt: vu2 };
        }
      }
      // --- Svelte 5：el.__svelte_meta.loc（dev 编译器真实装饰） + __svelte_meta.parent（dev_stack） ---
      // 静态 HTML 页：Vite staticLocPlugin 注入的 __svelte_meta.loc 也是同一结构（真实 file/line/column + component）
      if (!loc && el.__svelte_meta && el.__svelte_meta.loc) {
        var sMeta = el.__svelte_meta;
        // 调用位置：旧模拟页手写 __svelte_used_at；真实 Svelte 5 dev 产物用 __svelte_meta.parent（dev_stack）
        // dev_stack 条目 { type:'component', file:<调用方文件>, line, column, componentTag:<组件名>, parent }，
        // 首个 component 条目 = 当前元素所属组件在父模板中的使用位置（根组件元素无条目 → null）
        var su = el.__svelte_used_at || null;
        if (!su && sMeta.parent) {
          var st = sMeta.parent;
          while (st && st.type !== 'component') st = st.parent;
          if (st && st.file) {
            su = { component: st.componentTag || null, file: st.file, line: st.line, column: st.column };
          }
        }
        loc = { framework: 'svelte', file: sMeta.loc.file, line: sMeta.loc.line, column: sMeta.loc.column, component: sMeta.component || null, usedAt: su };
      }
      // --- 通用自定义组件元数据（Preact/Solid/Lit/Alpine 等新框架页手动挂载：__dbg_component，framework 名准确） ---
      //   页面/组件侧挂 {framework:'preact'|'solid'|'lit'|'alpine', file, line, column, component, usedAt}——
      //   未命中真实框架检测时兜底读取（优先真实 React/Vue/Svelte，避免覆盖）；有任意组件信息即用（file 可缺）
      if (!loc && el.__dbg_component && (el.__dbg_component.file || el.__dbg_component.component || el.__dbg_component.usedAt)) {
        var _dc = el.__dbg_component;
        loc = {
          framework: _dc.framework || 'custom',
          file: _dc.file || null,
          line: _dc.line != null ? _dc.line : null,
          column: _dc.column != null ? _dc.column : null,
          component: _dc.component || null,
          usedAt: _dc.usedAt || null,
        };
      }
      return loc;
    }

    // 深度优先遍历前 N 个元素，探测 React fiber / Svelte __svelte_meta 等 DOM 级标记
    // （React DevTools 扩展会在任意页面注入 __REACT_DEVTOOLS_GLOBAL_HOOK__，不能当证据；
    //  真实 React 18/19 挂载后元素上必有 __reactFiber$ 键）
    function probeDomFrameworks() {
      var found = { react: false, svelte: false };
      var stack = [document.body || document.documentElement];
      var count = 0;
      while (stack.length && count < 120) {
        var el = stack.pop();
        if (!el || el.nodeType !== 1) continue;
        count++;
        if (!found.react) {
          var ks = Object.getOwnPropertyNames(el);
          for (var i = 0; i < ks.length; i++) {
            var k = ks[i];
            if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) { found.react = true; break; }
          }
        }
        if (!found.svelte && el.__svelte_meta) found.svelte = true;
        if (found.react && found.svelte) break;
        var kids = el.children;
        for (var j = kids.length - 1; j >= 0; j--) stack.push(kids[j]);
      }
      return found;
    }

    var _fwCache = { t: 0, v: null };
    function detectFrameworks() {
      // 探针有 DOM 遍历成本：hover 高频调用时 1.5s 内复用结果
      var now = Date.now();
      if (_fwCache.v && now - _fwCache.t < 1500) return _fwCache.v;
      var fw = [];
      var w = window;
      var pf = probeDomFrameworks();
      // React 18/19：fiber 键 + 旧版标记；扩展注入的 hook 不作数（任何页面都有）
      if (pf.react || w.React || document.querySelector('[data-reactroot]')) fw.push('react');
      if ((w.Vue && w.Vue.version) || w.__VUE_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-v-app]')) fw.push('vue');
      if (w.next || w.__NEXT_DATA__ || w.__next_f || document.getElementById('__next')) fw.push('next');
      if (pf.svelte) fw.push('svelte'); // Svelte 5 dev：元素上必有 __svelte_meta（含挂载容器下的深层元素）
      _fwCache = { t: now, v: fw };
      return fw;
    }

    // ---------- 选区状态机（hover → step 放大缩小 → confirm） ----------
    function setHovered(el, mouseX, mouseY) {
      if (state.engaged) return; // 点击暂停后 hover 完全停用（工具条不乱跑）
      if (state.hovered === el) return;
      clearOutline(state.hoverOutline);
      state.hovered = el;
      if (!el) return;
      // 不 hover 占满视口的容器（body/html/全宽层）——淡蓝背景盖全窗像遮罩（用户：inspect 打开时浅蓝透明遮罩盖全部内容）
      try {
        var _hr = el.getBoundingClientRect();
        var _hw = (document.documentElement && document.documentElement.clientWidth) || innerWidth;
        var _hh = (document.documentElement && document.documentElement.clientHeight) || innerHeight;
        if (_hr.width > _hw * 0.85 && _hr.height > _hh * 0.85) { state.hovered = null; return; }
      } catch (e) {}
      drawOutline(state.hoverOutline, el, OUTLINE_HOVER, '', 'HOVER'); // 空 bg=不填充（避免淡蓝透明罩叠加页面）
      // 低频回传（只在切换元素时），供宿主工具条显示当前选区标签
      var fl = fileLocation(el);
      var r = el.getBoundingClientRect();
      // 鼠标坐标（HUD/弹窗以鼠标位置为中心——不在元素中心）
      var mx = (typeof mouseX === 'number') ? mouseX : Math.round(r.x + r.width / 2);
      var my = (typeof mouseY === 'number') ? mouseY : Math.round(r.y + r.height / 2);
      var cs = getComputedStyle(el);
      var txt = cleanTextOf(el, 60);
      post({
        type: 'dbg_element_hover',
        payload: {
          tag: el.tagName.toLowerCase(),
          component: fl && fl.component,
          file: fl && fl.file, line: fl && fl.line,
          usedAt: fl && fl.usedAt,
          // 完整 framework（含 react19Chunk/usedAtChunk）：悬停载荷也会成为 lastSelfPayload → 确认发送给 AI 时
          // 经 picksAddElement→resolveElLoc 做 sourcemap 解析，缺了它 chunk URL 就无法还原成真实源文件
          framework: fl,
          frameworks: detectFrameworks(),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          mouseX: mx, mouseY: my, // 鼠标坐标（HUD 以鼠标位置为中心）
          xpath: xpathOf(el), text: txt,
          bg: cs.backgroundColor, color: cs.color, fontSize: cs.fontSize,
        },
      });
    }

    // ---------- 模拟 hover 事件（真实派发，让页面 JS hover 逻辑生效并持久保持） ----------
    // 思路：freezeEvent 冻结矩阵把 mouseout/mouseleave 拦掉（hover 类）→ 页面永远收不到 mouseleave，
    // 所以「临时放行 hover 类拦截 → 真实派发 mouseover/mouseenter 事件序列 → 立即恢复拦截」后，
    // 页面 JS（mouseenter 展开 tooltip/菜单/动画等）真正跑起来，且因 mouseleave 仍被冻结而持久保持 hover 态。
    var _hoverSimEl = null; // 记忆模拟 hover 的目标（退出时对其派发 mouseleave 清除）
    function dispatchHoverEvents(el, enter) {
      if (!el) return;
      // 1. 临时放行 hover 类事件（mouseout/mouseleave 被冻结矩阵拦）→ 派发 → 立即恢复（保持原 released 状态）
      //    仅 Inspector 激活时做放行/恢复；退出后（exitInspector 已 uninstallFreeze）直接派发，避免把冻结重新挂回去
      var needFreeze = !!state.active;
      if (needFreeze) {
        var hadRelease = Object.prototype.hasOwnProperty.call(released, 'hover');
        var oldRelease = released.hover;
        released.hover = Infinity;
        installFreeze();
      }
      try {
        var r = el.getBoundingClientRect();
        var cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
        var opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
        var noBubble = {};
        for (var k in opts) noBubble[k] = opts[k];
        noBubble.bubbles = false;
        if (enter) {
          // 对齐真实指针进入顺序：pointerover → pointerenter → mouseover → mouseenter（React 等常监听 pointer/mouse 双份）
          if (window.PointerEvent) {
            try { el.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (e) {}
            try { el.dispatchEvent(new PointerEvent('pointerenter', noBubble)); } catch (e) {}
          }
          try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
          try { el.dispatchEvent(new MouseEvent('mouseenter', noBubble)); } catch (e) {}
        } else {
          // 退出：pointerout → pointerleave → mouseout → mouseleave（清除 JS hover 态）
          if (window.PointerEvent) {
            try { el.dispatchEvent(new PointerEvent('pointerout', opts)); } catch (e) {}
            try { el.dispatchEvent(new PointerEvent('pointerleave', noBubble)); } catch (e) {}
          }
          try { el.dispatchEvent(new MouseEvent('mouseout', opts)); } catch (e) {}
          try { el.dispatchEvent(new MouseEvent('mouseleave', noBubble)); } catch (e) {}
        }
      } finally {
        if (needFreeze) {
          if (hadRelease) released.hover = oldRelease; else delete released.hover;
          installFreeze();
        }
      }
    }
    function simulateHover(el) {
      var target = el || state.selected || state.hovered;
      if (!target) return { ok: false, error: 'no element' };
      // 切换目标：先清掉上一个模拟 hover 元素（不留双 hover）
      if (_hoverSimEl && _hoverSimEl !== target) dispatchHoverEvents(_hoverSimEl, false);
      dispatchHoverEvents(target, true);
      _hoverSimEl = target;
      return { ok: true, enter: true, tag: target.tagName.toLowerCase() };
    }
    function simulateHoverOff() {
      if (_hoverSimEl) dispatchHoverEvents(_hoverSimEl, false);
      _hoverSimEl = null;
      return { ok: true };
    }

    // AI 点选确认回传的元素载荷（tag/rect/selector/xpath/text/attributes/computed/framework/pageId/url）
    // —— 给 AI 的完整画像：大小尺寸/样式/内容/组件源码与位置/调用代码与位置/网页 url/pageId（MCP 桥操作需要）
    function aiPickPayload(el) {
      var fl = fileLocation(el);
      var r = el.getBoundingClientRect();
      var txt = cleanTextOf(el, 512);
      var cs = getComputedStyle(el);
      var computed = {};
      CSS_WHITELIST.forEach(function (k) {
        var v = cs[k];
        if (v && !SKIP_DEFAULTS[v]) computed[k] = String(v).slice(0, 300);
      });
      var attrs = {};
      var _attrs = el.attributes;
      for (var i = 0; i < _attrs.length && i < 20; i++) attrs[_attrs[i].name] = String(_attrs[i].value).slice(0, 120);
      // 视口坐标 rect（CDP 点击坐标）+ 文档坐标 docRect（= rect + scroll，滚动无关）+ scroll（坐标系上下文标注）
      var _sx2 = window.scrollX || document.documentElement.scrollLeft || document.body.scrollLeft || 0;
      var _sy2 = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
      return {
        tag: el.tagName.toLowerCase(),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        docRect: { x: Math.round(r.x + _sx2), y: Math.round(r.y + _sy2), w: Math.round(r.width), h: Math.round(r.height) },
        scroll: { x: _sx2, y: _sy2 },
        selector: cssSelectorOf(el),
        xpath: xpathOf(el), text: txt,
        attributes: attrs,
        computed: computed,
        framework: fl, component: fl && fl.component, file: fl && fl.file, line: fl && fl.line, usedAt: fl && fl.usedAt,
        // 页面上下文：url/title + pageId（MCP 桥 instanceId/frameId；桥未连时为 null，宿主侧补全）
        frame: { url: topUrl().slice(0, 500), title: (document.title || '').slice(0, 200) },
        pageId: null,
      };
    }

    function cssSelectorOf(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      var parts = [];
      var node = el;
      while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
        var part = node.tagName.toLowerCase();
        if (node.className && typeof node.className === 'string') {
          var cls = node.className.trim().split(/\s+/).slice(0, 3);
          if (cls.length) part += '.' + cls.map(function (c) { return CSS.escape(c); }).join('.');
        }
        var parent = node.parentElement;
        if (parent) {
          var sibs = parent.children;
          if (sibs.length > 1) {
            for (var i = 0; i < sibs.length; i++) { if (sibs[i] === node) { part += ':nth-child(' + (i + 1) + ')'; break; } }
          }
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }

    // 忽略注入元素：launcher 整树（HUD/工具条/fab/AI 窗/提示条/下拉/面板/确认卡等，closest #__dbg_launcher）
    //   + 注入样式标签（__dbg_launcher_css）+ 选区/悬停 outline 框（fixed zIndex 2147483646）+ SCRIPT/STYLE（含注入的 client script）
    // 导航（DOM 树/几何）都可能落到它们上（body 直接子级 #__dbg_launcher / outline div / 页面自身 script）——一律跳过（非可见内容元素）
    function isDbgEl(el) {
      if (!el || el.nodeType !== 1) return false;
      try {
        if (el.closest && el.closest('#__dbg_launcher')) return true;
        if (el.id === '__dbg_launcher_css') return true;
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return true;
        var st = el.style;
        if (st && st.position === 'fixed' && String(st.zIndex) === '2147483646') return true;
      } catch (e) {}
      return false;
    }

    // 文本提取：排除 aiti 自身注入内容（#__dbg_launcher 是 body 直接子级——html/body 的 innerText 会把 HUD/拦截提示条/fab/
    // 工具条等自身 UI 文本当页面内容，AI inspect 时全数看到）。减法实现（cloneNode 全量克隆大页面成本高，hover 高频调用不可用）：
    //   取 el 的 innerText → 若 launcher 在 el 内（html/body 等祖先）则扣掉 launcher 自身文本（innerText 块级连续，是子串）
    function cleanTextOf(el, max) {
      if (isDbgEl(el)) return ''; // aiti 自身元素：无页面文本
      var full = '';
      try { full = (el.innerText || el.textContent || '').trim(); } catch (e) {}
      try {
        if (full) {
          var lr = document.getElementById('__dbg_launcher');
          if (lr && lr !== el && (el === document.body || el === document.documentElement || el.contains(lr))) {
            var lt = (lr.innerText || lr.textContent || '').trim();
            if (lt && full.indexOf(lt) >= 0) {
              full = full.split(lt).join(' ').replace(/\s{2,}/g, ' ').trim();
            }
          }
        }
      } catch (e) {}
      return full.slice(0, max || 512);
    }
    /** 任意字符串去 aiti 自身文本（Runtime.evaluate 的 innerText 类结果；页面文本恰好含相同子串时也会被去掉，可接受） */
    function stripAitiText(s) {
      if (!s || typeof s !== 'string') return s;
      try {
        var lr = document.getElementById('__dbg_launcher');
        if (lr) {
          var lt = (lr.innerText || lr.textContent || '').trim();
          if (lt && s.indexOf(lt) >= 0) s = s.split(lt).join(' ').replace(/\s{2,}/g, ' ').trim();
        }
      } catch (e) {}
      return s;
    }

    // 几何相邻：在页面上找指定方向的最近可见元素（左/右/上/下相邻；跳过注入元素）
    function neighborInDirection(el, dir) {
      var r = el.getBoundingClientRect();
      var best = null, bestScore = Infinity;
      var all = document.querySelectorAll('body *');
      for (var i = 0; i < all.length; i++) {
        var c = all[i];
        if (c === el) continue;
        if (isDbgEl(c)) continue; // 忽略注入元素（launcher/HUD/outline 框等）
        var cr = c.getBoundingClientRect();
        if (cr.width === 0 || cr.height === 0) continue;
        var overY = Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top);
        var overX = Math.min(cr.right, r.right) - Math.max(cr.left, r.left);
        var ok = false, score = Infinity;
        if (dir === 'left' && cr.right <= r.left + 1) { ok = overY > 0; score = r.left - cr.right; }
        else if (dir === 'right' && cr.left >= r.right - 1) { ok = overY > 0; score = cr.left - r.right; }
        else if (dir === 'top' && cr.bottom <= r.top + 1) { ok = overX > 0; score = r.top - cr.bottom; }
        else if (dir === 'bottom' && cr.top >= r.bottom - 1) { ok = overX > 0; score = cr.top - r.bottom; }
        if (ok && score < bestScore) { bestScore = score; best = c; }
      }
      return best;
    }

    function stepSelection(dir) {
      if (!state.active) return;
      var cur = state.selected || state.hovered; // 导航（按钮/键盘）都发生在锁定态：selected 优先；hovered 兜底
      if (isDbgEl(cur)) cur = null; // 保险：选区不可能在注入元素上（点选已排除 launcher UI），异常时兜底
      if (!cur) cur = document.body;
      var next = null;
      if (dir === 'up') { next = cur.parentElement; while (next && isDbgEl(next)) next = next.parentElement; if (!next) next = cur; } // 父级（跳过注入链）
      else if (dir === 'down') { next = cur.firstElementChild; while (next && isDbgEl(next)) next = next.nextElementSibling; if (!next) next = cur; } // 子级（跳过注入元素）
      else if (dir === 'downOrNext') {                                                          // Enter：子级优先，无子级 → 回溯 next（DFS 遍历整树）
        next = cur.firstElementChild;
        while (next && isDbgEl(next)) next = next.nextElementSibling;
        if (!next) {
          var anc = cur;
          while (anc && !anc.nextElementSibling) anc = anc.parentElement;
          next = anc ? anc.nextElementSibling : null;
          while (next && isDbgEl(next)) next = next.nextElementSibling;
          if (!next) next = cur;
        }
      }
      // 平级前后：有平级兄弟走兄弟（跳过注入）；到平级最头/末尾 → 回上级（再按即上级的前后——一路向上快速导航）
      else if (dir === 'prev' || dir === 'left') {
        next = cur.previousElementSibling;
        while (next && isDbgEl(next)) next = next.previousElementSibling;
        if (!next) next = cur.parentElement || cur;
      }
      else if (dir === 'next' || dir === 'right') {
        next = cur.nextElementSibling;
        while (next && isDbgEl(next)) next = next.nextElementSibling;
        if (!next) next = cur.parentElement || cur;
      }
      else if (dir === 'first') { next = cur.firstElementChild; while (next && isDbgEl(next)) next = next.nextElementSibling; if (!next) next = cur; } // 最前（DOM 子级首，跳过注入）
      else if (dir === 'last') { next = cur.lastElementChild; while (next && isDbgEl(next)) next = next.previousElementSibling; if (!next) next = cur; } // 最后（DOM 子级末，跳过注入）
      else if (dir === 'leftN') next = neighborInDirection(cur, 'left') || cur;                 // 页面左边相邻
      else if (dir === 'rightN') next = neighborInDirection(cur, 'right') || cur;               // 页面右边相邻
      else if (dir === 'topN') next = neighborInDirection(cur, 'top') || cur;                   // 页面上边相邻
      else if (dir === 'bottomN') next = neighborInDirection(cur, 'bottom') || cur;             // 页面下边相邻
      if (!next) return;
      // 导航后滚动到可见：DOM 树/几何导航可能到屏外元素（用户看不到）——scrollIntoView 让用户看到它
      // 避让 HUD/工具条：元素在视口外或被底部 HUD/工具条遮挡区 → 滚到居中（上下都不挡）；
      //   已在视口内（未进遮挡区）→ nearest 最小滚动（不打断阅读位置）
      // 注意：宿主选区滚宿主文档、target 选区滚 target 文档（同一份 client，各自文档内 scrollIntoView 生效）
      try {
        var _sv = window.visualViewport && window.visualViewport.height > 0 ? window.visualViewport.height : window.innerHeight;
        if (!_sv || _sv <= 0) _sv = 800;
        var _sr = next.getBoundingClientRect();
        var _reserve = 96; // 底部 HUD/工具条视觉占位估算（HUD ~40-60px + 间距；小屏 HUD 固定底部）
        if (_sr.top < 0 || _sr.bottom > _sv - _reserve) {
          try { next.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
          catch (e) { try { next.scrollIntoView(true); } catch (e2) {} }
        } else {
          next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        }
        // 微调：center 后仍被底部 HUD 挡（极小元素/大 HUD）→ 向上补偿
        try {
          var _r2 = next.getBoundingClientRect();
          var _vh2 = window.visualViewport && window.visualViewport.height > 0 ? window.visualViewport.height : window.innerHeight;
          if (_vh2 > 0 && _r2.bottom > _vh2 - 8) window.scrollBy({ top: _r2.bottom - (_vh2 - 8), behavior: 'smooth' });
        } catch (e) {}
      } catch (e) { try { next.scrollIntoView(true); } catch (e2) {} }
      // 导航 = 选区移动：有 selected（锁定/触屏选中）→ 更新 selected（工具条跟随，AI 命令引用）；
      // 纯 hover 快选（无 selected）→ 移动 hover（HUD 跟随，不进入锁定——鼠标移动仍可自由快选）
      if (state.selected) {
        setTouchSelection(next);
        post({ type: 'dbg_element_hover_refresh', payload: null });
      } else {
        setHovered(next);
      }
    }

    function selectBySelector(selector) {
      if (!state.active) return;
      var el;
      var s = String(selector || '').trim();
      try {
        if (s.indexOf('//') === 0 || s.indexOf('(//') === 0) {
          // xpath path：document.evaluate 定位
          var res = document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          el = res.singleNodeValue || null;
        } else {
          el = document.querySelector(s);
        }
      } catch (e) { el = null; }
      if (el) {
        setTouchSelection(el); // # 选择 = 选中（selected + 高亮 + 工具条显示），AI 命令可引用
        state.engaged = true;
      } else {
        setHovered(null);
      }
      return !!el;
    }

    function confirmSelection(fallback) {
      if (!state.active) return;
      var el = state.hovered || state.selected || fallback;
      if (!el) { post({ type: 'dbg_element_selected', payload: null }); return; }
      // 确认态：selected 固定（虚线 outline），hover 高亮清除
      state.selected = el;
      clearOutline(state.hoverOutline);
      drawOutline(state.selOutline, el, OUTLINE_SEL, 'rgba(5,150,105,.08)', 'SEL');
      var _pl = serialize(el, { attrs: 1, xpath: 1, text: 1, computed: 1, framework: 1 });
      // React 19.2+：chunk 定位 → 异步 sourcemap 解析出精确源文件+行，解析完再发（预览/打开文件用真实路径）
      var _fw = _pl && _pl.framework;
      if (_fw && (_fw.react19Chunk || _fw.usedAtChunk)) {
        resolveFrameworkLoc(_fw).then(function (fw) {
          if (fw && _pl) {
            _pl.framework = fw;
            _pl.file = fw.file; _pl.line = fw.line; _pl.usedAt = fw.usedAt; // 顶层同步（显示层 framework.file 优先，保持一致）
          }
          post({ type: 'dbg_element_selected', payload: _pl });
        });
        return;
      }
      post({ type: 'dbg_element_selected', payload: _pl });
    }

    // ---------- 页面调速/拦截选项（dbg_set_options；独立于 Inspector，退出后保持） ----------
    var OPT = { animSpeed: 1, blockScroll: false, blockWheel: false, slowTimers: 1, darkMode: false, reducedMotion: false, timeOffsetMs: 0, simulateTouch: false };
    var animObs = null;
    // 保存原始定时器函数引用：慢放包装时不放大内部扫描
    var _origSetTimeout = window.setTimeout, _origSetInterval = window.setInterval, _origClearTimeout = window.clearTimeout;

    function applyAnimSpeedOnce() {
      var anims;
      try { anims = document.getAnimations(); } catch (e) { return; }
      anims.forEach(function (a) { try { a.playbackRate = OPT.animSpeed; } catch (e) {} });
    }
    function startAnimWatch() {
      if (animObs) return;
      applyAnimSpeedOnce();
      try {
        animObs = new MutationObserver(function () { applyAnimSpeedOnce(); });
        animObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
      } catch (e) {}
      // 定时兜底（WAAPI 动画创建不触发 DOM 变化）；用原始 setTimeout 防自伤
      var tick = function () { applyAnimSpeedOnce(); _origSetTimeout(tick, 400); };
      _origSetTimeout(tick, 400);
    }
    function stopAnimWatch() {
      if (animObs) { try { animObs.disconnect(); } catch (e) {} animObs = null; }
    }

    function onScrollBlock(e) { e.stopImmediatePropagation(); }
    function onWheelBlock(e) { if (e.cancelable) e.preventDefault(); e.stopImmediatePropagation(); }

    function installTimerSlow() {
      var slow = OPT.slowTimers;
      window.setTimeout = function (fn, delay) { return _origSetTimeout(fn, (delay == null ? 0 : delay) * slow); };
      window.setInterval = function (fn, delay) { return _origSetInterval(fn, (delay == null ? 0 : delay) * slow); };
    }
    function restoreTimerSlow() {
      window.setTimeout = _origSetTimeout;
      window.setInterval = _origSetInterval;
    }

    function applyOptions(opts) {
      var prevAnim = OPT.animSpeed;
      if (opts.animSpeed !== undefined) OPT.animSpeed = opts.animSpeed;
      if (opts.blockScroll !== undefined) OPT.blockScroll = !!opts.blockScroll;
      if (opts.blockWheel !== undefined) OPT.blockWheel = !!opts.blockWheel;
      if (opts.slowTimers !== undefined) OPT.slowTimers = opts.slowTimers;
      if (opts.netDelay !== undefined) NET.delay = opts.netDelay;
      if (opts.netOffline !== undefined) NET.offline = !!opts.netOffline;
      if (opts.darkMode !== undefined) OPT.darkMode = !!opts.darkMode;
      if (opts.reducedMotion !== undefined) OPT.reducedMotion = !!opts.reducedMotion;
      if (opts.timeOffsetMs !== undefined) OPT.timeOffsetMs = opts.timeOffsetMs;
      if (opts.simulateTouch !== undefined) OPT.simulateTouch = !!opts.simulateTouch;
      if (NET.delay > 0 || NET.offline) installNetSim(); // 需要时才劫持
      emulateMedia();     // 深色/减少动效（matchMedia 劫持）
      installTimeOffset(); // 时间偏移（Date 劫持，0 则还原）
      if (OPT.animSpeed !== prevAnim) {
        if (OPT.animSpeed === 1) { stopAnimWatch(); applyAnimSpeedOnce(); } // 恢复原速
        else { applyAnimSpeedOnce(); startAnimWatch(); }
      }
      document[OPT.blockScroll ? 'addEventListener' : 'removeEventListener']('scroll', onScrollBlock, true);
      document[OPT.blockWheel ? 'addEventListener' : 'removeEventListener']('wheel', onWheelBlock, true);
      if (OPT.slowTimers !== 1) installTimerSlow(); else restoreTimerSlow();
    }

    // ---------- 网络模拟（fetch/XHR 劫持：延迟/离线；对应 CDP Network.emulateNetworkConditions） ----------
    var NET = { delay: 0, offline: false };
    var _origFetch = window.fetch;
    var _origXhrOpen = XMLHttpRequest.prototype.open;
    var _origXhrSend = XMLHttpRequest.prototype.send;
    var netSimInstalled = false;

    function installNetSim() {
      if (netSimInstalled) return;
      netSimInstalled = true;
      // fetch：离线立即拒；在线延迟 resolve
      window.fetch = function (input, init) {
        if (NET.offline) return Promise.reject(new TypeError('Failed to fetch（dbg 模拟离线）'));
        if (NET.delay > 0) {
          return _origFetch(input, init).then(function (res) {
            return new Promise(function (resolve) { _origSetTimeout(function () { resolve(res); }, NET.delay); });
          });
        }
        return _origFetch(input, init);
      };
      // XHR：延迟 send；离线触发 error
      XMLHttpRequest.prototype.open = function (m, u) { this.__dbgUrl = String(u); return _origXhrOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        var self = this, args = arguments;
        if (NET.offline) {
          _origSetTimeout(function () {
            try {
              var ev = new ProgressEvent('error');
              self.dispatchEvent(ev);
              if (typeof self.onerror === 'function') self.onerror(ev);
            } catch (e) {}
          }, 50);
          return;
        }
        if (NET.delay > 0) { _origSetTimeout(function () { _origXhrSend.apply(self, args); }, NET.delay); return; }
        _origXhrSend.apply(this, args);
      };
    }

    // ---------- 强制报错（验证错误收集/上报链路 + 给 AI 造错误场景） ----------
    function forceError(kind) {
      var K = kind || 'sync';
      if (K === 'sync') _origSetTimeout(function () { throw new Error('[dbg] 强制同步异常 forced sync error'); }, 100);
      else if (K === 'promise') _origSetTimeout(function () { Promise.reject(new Error('[dbg] 强制未捕获 Promise 拒绝 forced unhandled rejection')); }, 100);
      else if (K === 'console') console.error('[dbg] 强制 console.error forced console error');
      else if (K === 'resource') {
        var img = new Image();
        img.src = '/__dbg_force_404__/' + Date.now() + '.png'; // 404 资源加载失败
        document.body.appendChild(img);
      }
      return K;
    }

    // ---------- 错误 hook：捕获页面错误上报宿主（去重防风暴，§7） ----------
    // 顶层去重状态（跨 installErrorHook 可访问——window.__dbg.resetErrorDedup 引用它；
    // 若定义在 installErrorHook 内则作用域不可达，调用即 ReferenceError 被静默吞掉，实测清理无效）
    var errSeen = {};
    function resetErrDedup() { errSeen = {}; }
    function installErrorHook() {
      if (window.__dbgErrHook) return;
      window.__dbgErrHook = true;
      // 浏览器已知良性错误：ResizeObserver 循环（回调期间容器尺寸又变，通知延迟送达即收敛）
      // 是 Chrome 规范明确可忽略的噪音——多扩展观察同一容器（聊天流式渲染/列表高度变化）时偶发正常，
      // 无任何功能影响。过滤掉：不弹 AI、不占去重位，但保留入 console 环（page_logs 可查，带 [benign] 标记）。
      var BENIGN_ERROR_RE = /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;
      function report(kind, msg, stack) {
        var text = String(msg);
        if (BENIGN_ERROR_RE.test(text)) {
          pushConsoleLog('error', '[benign] ' + text.slice(0, 300));
          return;
        }
        var key = text.slice(0, 80);
        if (errSeen[key]) return; // 同消息只报一次（未清理前）
        errSeen[key] = 1;
        // 统一错误队列：未捕获异常（uncaught/rejection/resource）同时并入 console 日志环形缓冲，
        // 使 AI 消息（dbg_page_error）与 page_logs 查询读到一致的内容。
        // console.error 除外——它已由 installConsoleHook 的 console hook 入队（level=error），避免重复。
        if (kind !== 'console.error') {
          var label = { error: 'uncaught', unhandledrejection: 'rejection', resource: 'resource' }[kind] || kind;
          pushConsoleLog('error', '[' + label + '] ' + String(msg).slice(0, 300));
        }
        post({ type: 'dbg_page_error', payload: { kind: kind, message: String(msg).slice(0, 300), stack: stack ? String(stack).slice(0, 500) : null } });
        // P3：页面错误事件不再由页面直发桥——经 launcher → AI 窗（dbg_bridge_event）→ BridgeClient 上报，与其他事件同链路
      }
      // 脚本执行错误（冒泡）：同源报真实消息；跨源被浏览器遮蔽为 Script error.（尽力补充 filename/行号/资源 URL）
      window.addEventListener('error', function (e) {
        var msg = e.message;
        var meta = '';
        if (msg === 'Script error.') {
          // 跨源脚本：拿不到真实消息——补充能拿到的所有定位信息（浏览器可能仍为空，尽力而为）
          if (e.filename) meta += ' @ ' + e.filename + (e.lineno ? ':' + e.lineno + (e.colno ? ':' + e.colno : '') : '');
          var t = e.target;
          if (t && t.tagName) meta += (meta ? ' · ' : '') + '资源=' + (t.tagName + (t.src || t.href || t.currentSrc ? ' ' + String(t.src || t.href || t.currentSrc).slice(0, 200) : ''));
          if (meta) meta = '（跨源/加载失败被浏览器遮蔽' + meta + '；可检查页面脚本路径是否含部署前缀，如 /dev/）';
        }
        report('error', msg + meta, e.error && e.error.stack);
      });
      // 资源加载失败（script/img/link 404 等）：不冒泡，需 capture 阶段监听；e.target 为触发元素
      window.addEventListener('error', function (e) {
        var t = e.target;
        if (t && t.tagName && (t.src || t.href)) {
          report('resource', '资源加载失败 [' + t.tagName + '] ' + String(t.src || t.href).slice(0, 300));
        }
      }, true);
      window.addEventListener('unhandledrejection', function (e) {
        var r = e.reason;
        report('unhandledrejection', (r && (r.message || String(r))) || 'Promise rejected', r && r.stack);
      });
      var origConsoleError = console.error;
      console.error = function () {
        report('console.error', Array.prototype.map.call(arguments, String).join(' '));
        origConsoleError.apply(console, arguments);
      };
    }

    // ---------- console 日志采集（方案 F-1：全量 log/debug/info/warn/error → 环形缓冲 → 连桥重放/实时批量） ----------
    var CONSOLE_RING = [];   // {ts, level, text, count}（连桥前缓冲 + 连桥重放）
    var consoleDropped = 0;
    var _consoleBatch = [];  // 100ms 聚合批（≤10 条）
    var _consoleTimer = null;
    var _consoleLevels = ['log', 'debug', 'info', 'warn', 'error'];
    var _origConsoles = {};
    function fmtArg(a) {
      if (a == null) return String(a);
      if (typeof a === 'string') return a.slice(0, 300);
      try { var s = JSON.stringify(a); return s && s.length <= 300 ? s : String(a).slice(0, 300); } catch (e) { return String(a).slice(0, 300); }
    }
    function pushConsoleLog(level, text) {
      var now = Date.now();
      var last = CONSOLE_RING[CONSOLE_RING.length - 1];
      // 连续相同（同文本且间隔 < 500ms）→ 合并 count
      if (last && last.level === level && last.text === text && now - last.ts < 500) {
        last.count = (last.count || 1) + 1;
        last.ts = now;
        return;
      }
      var item = { ts: now, level: level, text: String(text).slice(0, 300), count: 1 };
      CONSOLE_RING.push(item);
      if (CONSOLE_RING.length > 200) { CONSOLE_RING.shift(); consoleDropped++; }
      _consoleBatch.push(item);
      if (_consoleBatch.length >= 10) flushConsoleBatch();
      else if (!_consoleTimer) _consoleTimer = _origSetTimeout(flushConsoleBatch, 100);
    }
    function flushConsoleBatch() {
      if (_consoleTimer) { _origClearTimeout(_consoleTimer); _consoleTimer = null; }
      if (!_consoleBatch.length) return;
      // 不再实时上报（方案 F-3：数据留在本地缓冲，page_logs 工具按需拉取）
      _consoleBatch.splice(0);
    }
    function installConsoleHook() {
      if (window.__dbgConsoleHook) return;
      window.__dbgConsoleHook = true;
      // 重入保护：fmtArg 的 JSON.stringify/String() 会触发参数对象的 getter/toString/Symbol.toPrimitive，
      // 若 getter 内部打日志（业务代理/懒加载警告等）会再进本 hook → 同步无限递归 → 主线程卡死（页面冻结）。
      // 重入时跳过采集只透传，递归链立即斩断。
      var _inHook = 0;
      _consoleLevels.forEach(function (lv) {
        _origConsoles[lv] = console[lv];
        console[lv] = function () {
          if (!_inHook) {
            _inHook = 1;
            try {
              var text = Array.prototype.map.call(arguments, fmtArg).join(' ').slice(0, 300);
              pushConsoleLog(lv, text);
            } catch (e) {} // 格式化彻底失败也不影响透传
            _inHook = 0;
          }
          _origConsoles[lv].apply(console, arguments); // 透传原 console，页面行为不变
        };
      });
    }

    // ---------- 网络观察（方案 F-2：XHR/fetch 完成态采集；与 installNetSim 组合顺序无关） ----------
    var NET_RING = [];     // {id, kind:'xhr'|'fetch', method, url, status, statusText, durationMs, size, error, ts}
    var netDropped = 0;
    var _netBatch = [];
    var _netTimer = null;
    function pushNet(item) {
      NET_RING.push(item);
      if (NET_RING.length > 100) { NET_RING.shift(); netDropped++; }
      _netBatch.push(item);
      if (_netBatch.length >= 10) flushNetBatch();
      else if (!_netTimer) _netTimer = _origSetTimeout(flushNetBatch, 100);
    }
    function flushNetBatch() {
      if (_netTimer) { _origClearTimeout(_netTimer); _netTimer = null; }
      if (!_netBatch.length) return;
      // 不再实时上报（方案 F-3：数据留在本地缓冲，page_network 工具按需拉取）
      _netBatch.splice(0);
    }
    function installNetObserver() {
      if (window.__dbgNetObserver) return;
      window.__dbgNetObserver = true;
      // XHR 完成态（包安装时引用——netSim 先装则包 sim 版，顺序无关）
      var _oOpen = XMLHttpRequest.prototype.open, _oSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__dbgNet = { m: m, u: String(u).slice(0, 300), t0: performance.now() }; return _oOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        var self = this, net = this.__dbgNet || { m: '', u: '', t0: performance.now() };
        ['load', 'error', 'abort', 'timeout'].forEach(function (ev) {
          self.addEventListener(ev, function () {
            // 排除 dbg 自身请求（桥上报/扩展资源——否则采集→上报→新请求→再采集的自激循环）
            if (net.u.indexOf('/bridge/') >= 0 || net.u.indexOf('/api/extensions/') >= 0 || net.u.indexOf('__dbg') >= 0) return;
            pushNet({
              id: 'xhr_' + Math.random().toString(36).slice(2, 8), kind: 'xhr', method: net.m, url: net.u,
              status: ev === 'load' ? (self.status || 0) : null, statusText: ev === 'load' ? self.statusText : null,
              durationMs: Math.round(performance.now() - net.t0),
              size: ev === 'load' && self.responseText ? self.responseText.length : null,
              error: ev === 'load' ? null : ev, ts: Date.now(),
            });
          });
        });
        return _oSend.apply(this, arguments);
      };
      // fetch 完成态
      var _of = window.fetch;
      window.fetch = function (input, init) {
        var _m = (init && init.method) || (input && input.method) || 'GET';
        var _u = String((input && input.url) || input).slice(0, 300);
        return _of.apply(this, arguments).then(function (res) {
          // 排除 dbg 自身请求（防自激循环）
          if (_u.indexOf('/bridge/') < 0 && _u.indexOf('/api/extensions/') < 0 && _u.indexOf('__dbg') < 0) {
            pushNet({ id: 'f_' + Math.random().toString(36).slice(2, 8), kind: 'fetch', method: _m, url: _u,
              status: res.status, statusText: res.statusText, durationMs: 0, size: null, error: null, ts: Date.now() });
          }
          return res;
        }, function (err) {
          if (_u.indexOf('/bridge/') < 0 && _u.indexOf('/api/extensions/') < 0 && _u.indexOf('__dbg') < 0) {
            pushNet({ id: 'f_' + Math.random().toString(36).slice(2, 8), kind: 'fetch', method: _m, url: _u,
              status: null, statusText: null, durationMs: 0, size: null, error: 'fetch rejected', ts: Date.now() });
          }
          throw err;
        });
      };
    }


    // ---------- 场景模拟：环境（matchMedia 劫持）+ 时间偏移（Date 劫持） ----------
    var _origMatchMedia = window.matchMedia;
    var _origDate = window.Date;

    function emulateMedia() {
      // 深色/减少动效：JS 侧判断（matchMedia.matches）可模拟；纯 CSS media query 无法强制（P1 用注入样式兜底）
      window.matchMedia = function (query) {
        var m = _origMatchMedia(query);
        var q = String(query);
        var fake = null;
        if (OPT.darkMode && q.indexOf('prefers-color-scheme') >= 0) fake = q.indexOf('dark') >= 0;
        if (OPT.reducedMotion && q.indexOf('prefers-reduced-motion') >= 0) fake = q.indexOf('reduce') >= 0;
        if (OPT.simulateTouch && (q.indexOf('pointer') >= 0 || q.indexOf('hover') >= 0)) {
          // 模拟触屏：pointer:coarse / any-pointer:coarse / hover:none / any-hover:none
          fake = (q.indexOf('coarse') >= 0 || q.indexOf('none') >= 0);
        }
        if (fake === null) return m;
        return {
          matches: fake, media: q, onchange: null,
          addListener: function (f) { m.addListener(f); }, removeListener: function (f) { m.removeListener(f); },
          addEventListener: function (t, f) { m.addEventListener(t, f); }, removeEventListener: function (t, f) { m.removeEventListener(t, f); },
          dispatchEvent: function (e) { return m.dispatchEvent(e); },
        };
      };
      // 深色：color-scheme 影响表单控件/滚动条渲染
      var old = document.getElementById('__dbg_dark__');
      if (OPT.darkMode) {
        if (!old) {
          var st = document.createElement('style');
          st.id = '__dbg_dark__';
          st.textContent = 'html { color-scheme: dark !important; }';
          document.head.appendChild(st);
        }
      } else if (old) { old.remove(); }
    }

    function installTimeOffset() {
      var offset = OPT.timeOffsetMs;
      if (!offset) { window.Date = _origDate; return; }
      window.Date = (function (OrigDate) {
        function DbgDate() {
          var d;
          if (!(this instanceof DbgDate)) return new OrigDate(OrigDate.now() + offset).toString(); // Date() 调用
          if (arguments.length === 0) d = new OrigDate(OrigDate.now() + offset);
          else if (arguments.length === 1) d = new OrigDate(arguments[0]);
          else d = new OrigDate(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6]);
          return d;
        }
        DbgDate.prototype = OrigDate.prototype;
        DbgDate.now = function () { return OrigDate.now() + offset; };
        DbgDate.parse = OrigDate.parse;
        DbgDate.UTC = OrigDate.UTC;
        return DbgDate;
      })(_origDate);
    }

    // ---------- MCP 桥：页面与桥零直接连接（设计决策） ----------
    // 所有桥通信集中在 AI 窗（cockpit / pi-web aiti 扩展 client）：launcher 经 postToAi 把页面事件
    // （page_log/page_network/page_error/open_file/user_answer…）交给 AI 窗，由其 BridgeClient.postEvent 上报桥。
    // 历史 client 直连桥代码（mcpConnect/claim/SSE/postBridge*）已删——直连形态遗留，全形态无人触发。

    // ---------- 事件冻结 → 升级为「锁定 + 事件放行矩阵」 ----------
    // 默认全锁（页面交互收不到任何事件，弹出层保持）；按类别临时放行（click/key/wheel/scroll/hover/touch/focus），
    // 到期自动回锁或持续到手动锁回；✓ 确认在任何状态下可用
    var FROZEN_CATEGORIES = {
      click: ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu'],
      key: ['keydown', 'keyup'],
      wheel: ['wheel'],
      scroll: ['scroll'],
      hover: ['mouseout', 'mouseleave'],
      touch: ['touchstart', 'touchmove', 'touchend'],
      focus: ['focusin', 'focusout'],
    };
    var aiPick = false;    // AI 窗口点选模式：点击回传元素（dbg_ai_picked），可连续选择，不弹窗/不暂停
    var passClick = false; // 真实点击穿透：放行一次 click 让页面交互发生（如打开按钮菜单）
    var inspectorMode = 'mouse'; // 'mouse'（hover+点击确认）| 'touch'（点击=移动选区，✓才确认）
    var released = {};         // category -> until(ts) | Infinity
    var _frozenEvents = [];
    var _releaseTimers = {};
    var _blockReported = {};   // category -> ts（拦截提示防抖：同类事件 2.5s 只提示一次）

    function allFrozenEvents() {
      var list = [];
      Object.keys(FROZEN_CATEGORIES).forEach(function (cat) {
        if (released[cat]) return;
        FROZEN_CATEGORIES[cat].forEach(function (t) { if (list.indexOf(t) < 0) list.push(t); });
      });
      return list;
    }
    function freezeEvent(e) {
      // self 模式（注入宿主页自身）：launcher UI（#__dbg_launcher）放行，工具条始终可用；其余页面元素都可选
      if (e.target && e.target.closest && e.target.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) return;
      // 只冻结鼠标左键（click 冻结）；右键/中键放行（页面右键菜单/中键行为正常）
      if (e.button && e.button !== 0) return;
      // aiti 自身键盘功能（Esc 退出 Inspector / 方向键导航选区）优先于事件冻结——兜底特判：
      // keydown 冻结会连我们自己在 document/window bubble 注册的 Esc 处理一起拦掉（freezeEvent 在
      // window capture + stopImmediatePropagation），导致「按 Esc 退不出 + 误报『keydown 被拦截』」。
      // 正常路径由键盘捕获监听（onKey，注册先于本函数）先行接管并 stopImmediatePropagation；
      // 此特判保证任何注册顺序下 Esc 都不被冻结、不弹拦截提示（事件可冒泡到宿主 hostKey 退出）。
      if (e.type === 'keydown' && e.key === 'Escape') return;
      // capture 阶段最后一个执行者：页面其余监听器全部收不到
      e.stopImmediatePropagation();
      if (e.cancelable) e.preventDefault();
      // 拦截提示：被冻结的页面交互 → 通知宿主底部提示（类别与放行方案维度一致：click/hover/key/wheel/scroll/touch/focus）
      reportBlocked(e);
    }
    /** 拦截提示上报：反查事件类别（FROZEN_CATEGORIES 同源），防抖后 post 宿主显示提示条 */
    function reportBlocked(e) {
      var cat = null;
      for (var c in FROZEN_CATEGORIES) {
        if (FROZEN_CATEGORIES[c].indexOf(e.type) >= 0) { cat = c; break; }
      }
      if (!cat) return;
      var now = Date.now();
      if (_blockReported[cat] && now - _blockReported[cat] < 2500) return;
      _blockReported[cat] = now;
      // 拦截点坐标（鼠标/触摸事件才有；键盘/scroll/focus 无坐标传 null）：
      // 宿主提示条据此闪避——拦截发生在视口下半部 → 提示挪上半屏，反之亦然
      var _mx = null, _my = null;
      if (typeof e.clientX === 'number') { _mx = Math.round(e.clientX); _my = Math.round(e.clientY); }
      else if (e.changedTouches && e.changedTouches[0]) { _mx = Math.round(e.changedTouches[0].clientX); _my = Math.round(e.changedTouches[0].clientY); }
      else if (e.touches && e.touches[0]) { _mx = Math.round(e.touches[0].clientX); _my = Math.round(e.touches[0].clientY); }
      post({ type: 'dbg_event_blocked', payload: { category: cat, type: e.type, mouseX: _mx, mouseY: _my } });
    }
    function installFreeze() {
      uninstallFreeze();
      _frozenEvents = allFrozenEvents();
      _frozenEvents.forEach(function (t) { window.addEventListener(t, freezeEvent, true); });
      ensureUiMousedownGuard(); // launcher UI mousedown 守卫（与放行方案无关，见 uiMousedownGuard）
    }
    function uninstallFreeze() {
      _frozenEvents.forEach(function (t) { window.removeEventListener(t, freezeEvent, true); });
      _frozenEvents = [];
      removeUiMousedownGuard();
    }
    // launcher UI 的 mousedown 守卫：页面菜单/编辑器（session-manager 标签编辑等）用 document **捕获相位** mousedown 关闭
    // （点外部关）。放行方案（尤其全部放行）不应影响 launcher 自身 UI——launcher HUD 在 inspect 模式永远按“默认放行”
    // 处理：mousedown 无条件拦掉（stopImmediatePropagation），页面捕获监听收不到 → 点工具条放行按钮不会关掉刚打开的
    // 页面菜单（用户实测）。挂在 window 捕获相位（先于 document，不依赖注册顺序）。launcher 输入框豁免（需 mousedown 聚焦）；
    // AI 窗/fab/工具条拖动均用 pointerdown，不受影响。
    var _uiMouseBound = false;
    function uiMousedownGuard(e) {
      if (e.target && e.target.closest && e.target.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) {
        if (e.target.closest && e.target.closest('input, textarea, select')) return; // 输入框：放行（聚焦）
        e.stopImmediatePropagation();
        if (e.cancelable) e.preventDefault(); // 焦点保护：防 launcher UI 点击把页面输入框焦点夺走
      }
    }
    function ensureUiMousedownGuard() { if (!_uiMouseBound) { _uiMouseBound = true; window.addEventListener('mousedown', uiMousedownGuard, true); } }
    function removeUiMousedownGuard() { if (_uiMouseBound) { _uiMouseBound = false; window.removeEventListener('mousedown', uiMousedownGuard, true); } }
    /** 放行一组事件类别：durationMs>0 定时回锁；0/Infinity 持续到手动锁回 */
    function releaseEvents(categories, durationMs) {
      var now = Date.now();
      (categories || []).forEach(function (cat) {
        if (FROZEN_CATEGORIES[cat]) released[cat] = (durationMs > 0) ? now + durationMs : Infinity;
      });
      installFreeze();
      if (durationMs > 0) {
        var until = now + durationMs;
        var key = (categories || []).slice().sort().join('+');
        if (_releaseTimers[key]) clearTimeout(_releaseTimers[key]); // clearTimeout 的 id 不变，无需包装
        _releaseTimers[key] = _origSetTimeout(function () {
          (categories || []).forEach(function (cat) { if (released[cat] === until) delete released[cat]; });
          installFreeze();
        }, durationMs);
      }
    }
    function lockEvents() {
      released = {};
      installFreeze();
    }
    /** 放行方案：一次性设置（release 数组 = 放行的类别，其余冻结）——默认方案由 enterInspector 设置 */
    function applyProfile(pf) {
      released = {};
      var rel = (pf && pf.release) || [];
      for (var i = 0; i < rel.length; i++) {
        if (FROZEN_CATEGORIES[rel[i]]) released[rel[i]] = Infinity;
      }
      installFreeze();
      return { name: pf && pf.name, released: Object.keys(released) };
    }
    /** 单类别开关：enabled=true 持续放行，false 立即冻结（用户可控状态，非临时） */
    function toggleEvent(category, enabled) {
      if (!FROZEN_CATEGORIES[category]) return { error: 'unknown category: ' + category };
      if (enabled) released[category] = Infinity;
      else delete released[category];
      installFreeze();
      return { category: category, released: !!released[category] };
    }

    // ---------- 事件 ----------
    var lastMoveX = 0, lastMoveY = 0;
    var _touchBlockHoverUntil = 0; // 触摸点击后一段时间内禁止 hover（tap 合成 mouseover 会圈蓝框）
    var _realMouseEver = false; // 是否见过真实鼠标移动（isTrusted 且 movement>0）——tap 合成 mouseover(movement=0) 不触发 hover
    var _onTouch = function () { _touchBlockHoverUntil = Date.now() + 800; };
    document.addEventListener('touchstart', _onTouch, true);
    document.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch') _onTouch(); }, true);
    function onOver(e) {
      if (state.active && inspectorMode === 'mouse' && !state.engaged) {
        // 触摸点击（tap）后抑制 hover：真机 tap 合成 mouseover（即便 isTouchDevice 漏报）→ 圈蓝框盖整窗
        if (Date.now() < _touchBlockHoverUntil) return;
        // 真机 tap 合成 mouseover(isTrusted=true, 无真实鼠标移动) 不触发 hover；自检 dispatch(isTrusted=false) 放行
        if (e.isTrusted !== false && !_realMouseEver) return;
        var t = e.target;
        if (!t || t === document.body || t === document.documentElement) return; // 不 hover body/html 容器（占满视口 → 淡蓝背景盖全窗）
        if (t.closest && t.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) return;
        setHovered(t, e.clientX, e.clientY);
      }
    }
    function onMouseMove(e) {
      if (e.isTrusted && (e.movementX || e.movementY || e.buttons)) _realMouseEver = true;
      if (!state.active || state.engaged) return;
      if (Math.abs(e.clientX - lastMoveX) + Math.abs(e.clientY - lastMoveY) < 80) return;
      lastMoveX = e.clientX; lastMoveY = e.clientY;
      var el = e.target;
      if (el && el.closest && el.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) return;
      if (state.hovered) post({ type: 'dbg_mouse_move', payload: { mouseX: e.clientX, mouseY: e.clientY } });
    }
    // disabled 元素不派发 click（HTML 规范），Inspector 的 window 捕获 click（onClick）永远收不到 →
    // 点 disabled 按钮（如 aiti-prompts「新建分组」确认钮初始 disabled）不选中、不弹 HUD。
    // 补 pointerdown 捕获检测：目标本身 disabled / aria-disabled / 处于 fieldset[disabled] 内 → 当点击选中
    // （与 onClick 同语义：冻结页面交互、进入/移动选区、AI 点选回传）。pointerdown 同时覆盖桌面与触屏。
    function isDisabledEl(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.disabled === true) return true; // button/input/textarea/select 原生 disabled
      var a = el.getAttribute && el.getAttribute('aria-disabled');
      if (a && a !== 'false' && a !== '') return true;
      try { if (el.closest && el.closest('fieldset[disabled]')) return true; } catch (e) {} // fieldset[disabled] 禁其内全部表单控件
      return false;
    }
    function onPickDisabled(e) {
      if (!state.active) return;
      if (e.button && e.button !== 0) return; // 左键
      var t = e.target;
      if (!t || t.nodeType !== 1) return;
      if (t.closest && t.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) return; // launcher UI 放行
      if (released.click) return; // click 已放行（放行方案）：交给页面，不拦 pointerdown
      if (!isDisabledEl(t)) return; // 只处理 disabled 元素（enabled 走正常 click 路径）
      e.preventDefault();
      e.stopImmediatePropagation(); // 先于 freezeEvent（enterInspector 注册在前）：不弹「被冻结」拦截提示
      if (aiPick) {
        state.engaged = true;
        setTouchSelection(t, e.clientX, e.clientY);
        return;
      }
      if (inspectorMode === 'touch' || state.engaged) {
        if (state.engaged && state.selected === t) { // 已选中点击同一 disabled 元素 → toggle 恢复快选（与 onClick 一致）
          state.engaged = false;
          state.selected = null;
          clearOutline(state.selOutline);
          state.hovered = null;
          setHovered(t);
          post({ type: 'dbg_element_hover_refresh', payload: null });
          return;
        }
        setTouchSelection(t, e.clientX, e.clientY);
      } else {
        state.engaged = true;
        setTouchSelection(t, e.clientX, e.clientY);
      }
    }
    function onClick(e) {
      if (!state.active) return;
      // 只拦截鼠标左键（button=0）：右键（contextmenu）/中键（auxclick）放行给页面（页面右键菜单/中键行为正常）
      if (e.button && e.button !== 0) return;
      // self 模式：点击 launcher UI（fab/AI 窗/工具条/面板）放行，不选中；其余页面元素（含控制按钮）都可选
      if (e.target && e.target.closest && e.target.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) return;
      // click 已放行（事件放行开关）：点击交给页面（按钮可交互），不选中；通知宿主隐藏 HUD——
      // 菜单/弹层正是在点击处弹出，可见 HUD（pointer-events:auto 时代）会盖住并拦截其下方交互（用户实测无法选择菜单项）
      if (released.click) { post({ type: 'dbg_click_released', payload: {} }); return; }
      if (passClick) {
        // 真实点击穿透：放行本次 click（页面打开菜单等逻辑正常发生），短暂后恢复冻结
        passClick = false;
        post({ type: 'dbg_click_released', payload: {} });
        setTimeout(function () { installFreeze(); }, 600);
        return;
      }
      e.preventDefault(); e.stopImmediatePropagation();
      if (aiPick) {
        // AI 窗口点选：点击 = 与外部 Inspector 一致——进入临时选择（工具条弹出跟随选区，可微调）；✓ 确认才回传 AI 窗
        state.engaged = true;
        setTouchSelection(e.target, e.clientX, e.clientY);
        return;
      }
      if (inspectorMode === 'touch' || state.engaged) {
        // 已选中状态下点击同一元素 → 恢复快选（toggle：选中↔快选）
        if (state.engaged && state.selected === e.target) {
          state.engaged = false;
          state.selected = null;
          clearOutline(state.selOutline);
          state.hovered = null;
          setHovered(e.target); // 恢复 hover 高亮 + HUD
          post({ type: 'dbg_element_hover_refresh', payload: null });
          return;
        }
        setTouchSelection(e.target, e.clientX, e.clientY); // 触屏/已进入临时状态：点击 = 移动选区（不弹窗，✓ 才确认）
      } else {
        // 大屏首次点击：进入临时选择状态（不立即弹窗），hover 停用、工具条保留，可继续调整
        state.engaged = true;
        setTouchSelection(e.target, e.clientX, e.clientY);
      }
    }
    function onScroll() { if (state.hovered && !state.engaged) setHovered(state.hovered); } // engaged 后滚动不再重发 hover

    // 触屏选区：点击/step 直接更新 selected（高亮虚线），回传轻量标签更新，不弹窗
    function setTouchSelection(el, mX, mY) {
      if (!el) return;
      state.selected = el;
      state.hovered = el; // 同步 hovered：后续 step（Enter/导航）基于最新选区
      clearOutline(state.hoverOutline);
      drawOutline(state.selOutline, el, OUTLINE_SEL, 'rgba(5,150,105,.08)', 'SEL');
      var fl = fileLocation(el);
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      var txt = cleanTextOf(el, 60);
      post({
        type: 'dbg_element_hover',
        payload: {
          tag: el.tagName.toLowerCase(),
          component: fl && fl.component,
          file: fl && fl.file, line: fl && fl.line,
          usedAt: fl && fl.usedAt,
          // 完整 framework（含 react19Chunk/usedAtChunk）：触屏选区同样会变 lastSelfPayload → 确认发送给 AI 时
          // 经 picksAddElement→resolveElLoc 做 sourcemap 解析；缺了它 chunk URL 无法还原成真实源文件（触屏设备必带）
          framework: fl,
          frameworks: detectFrameworks(),
          touchMode: true, engaged: true, // 点击暂停：工具条显示
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          mouseX: (typeof mX === 'number') ? mX : Math.round(r.x + r.width / 2),
          mouseY: (typeof mY === 'number') ? mY : Math.round(r.y + r.height / 2),
          xpath: xpathOf(el), text: txt,
          bg: cs.backgroundColor, color: cs.color, fontSize: cs.fontSize,
        },
      });
    }

    window.__dbg = {
      __version__: '__DBG_VERSION__',
      resetErrorDedup: function () { try { resetErrDedup(); } catch (e) {} }, // 打开 AI 窗清理 → 同消息下次触发重新上报
      enterInspector: function (mode) {
        if (state.active && inspectorMode === (mode || 'mouse')) return; // 幂等
        if (state.active) window.__dbg.exitInspector(); // 模式切换先退出再进
        state.active = true;
        inspectorMode = mode || 'mouse';
        passClick = false;
        // 默认放行不影响 Inspector 点选的事件（页面交互正常：滚动/键盘/触摸/焦点），只锁 click/hover（防误选中 + 防弹出层消失）
        released = {};
        ['key', 'wheel', 'scroll', 'touch', 'focus'].forEach(function (c) { released[c] = Infinity; });
        if (inspectorMode === 'touch') released.touch = Infinity; // 触屏：放行 touch（tap 需合成 click 供“点击=移动选区”）
        if (inspectorMode === 'mouse') window.addEventListener('mouseover', onOver, true);
        window.addEventListener('mousemove', onMouseMove, true);
        window.addEventListener('pointerdown', onPickDisabled, true); // disabled 元素不派发 click，用 pointerdown 补选（注册先于 installFreeze）
        window.addEventListener('click', onClick, true);
        window.addEventListener('scroll', onScroll, true);
        installFreeze();
        if (inspectorMode !== 'touch'){
          document.body.style.cursor = 'crosshair';
        }
      },
      exitInspector: function () {
        state.active = false;
        state.engaged = false;
        window.removeEventListener('mouseover', onOver, true);
        window.removeEventListener('mousemove', onMouseMove, true);
        window.removeEventListener('pointerdown', onPickDisabled, true);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('scroll', onScroll, true);
        uninstallFreeze(); // 解除冻结
        released = {};
        clearOutline(state.hoverOutline);
        clearOutline(state.selOutline); // 退出时清掉全部选区框（蓝框不残留）
        // 兜底：扫除页面上所有残留的选区框 div（引用丢失/异常时也能清干净）
        try {
          document.querySelectorAll('body > div').forEach(function (n) {
            if (n.style && n.style.position === 'fixed' && n.style.outline && String(n.style.zIndex) === '2147483646') {
              if (n.parentNode) n.parentNode.removeChild(n);
            }
          });
        } catch (e) {}
        state.hovered = null;
        state.selected = null;
        document.body.style.cursor = '';
        try { simulateHoverOff(); } catch (e) {} // 退出 Inspector：对模拟 hover 的目标派发 mouseleave 清除持久态
      },
      simulateHover: simulateHover, // 真实派发 mouseover/mouseenter（页面 JS hover 逻辑生效并持久保持）
      simulateHoverOff: simulateHoverOff,
      fileLocation: fileLocation,
      serialize: serialize,
      detectFrameworks: detectFrameworks,
      // Turbopack chunk 定位 → 源文件（sourcemap，异步）：launcher 候选/点选补全真实源文件路径用（resolveFrameworkLoc 同源）
      resolveChunkSource: resolveChunkSource,
      // 组件名 → 源文件（预算耗尽时无 chunk 定位，按组件名扫 sourcemap sourcesContent 找文件；异步，懒构建缓存）
      resolveComponentFile: resolveComponentFile,
      // 组件函数 toString → 定位 chunk 行 → sourcemap 精确源文件+行（预算耗尽兜底拿真实行号）
      resolveFnLine: resolveFnLine,
      setOptions: applyOptions, // 页面调速/拦截选项（动画减速/事件拦截/定时器慢放）
      resumeHover: function () {
        // 恢复快选：退出临时选择状态（hover 高亮重新生效，选区保留可继续点击切换）
        state.engaged = false;
        return { engaged: state.engaged };
      },
      pauseHover: function () {
        // 暂停点选：等同点击进入临时状态（hover 停用、清 hover 高亮、选区保留）——鼠标进入工具条时自动触发
        state.engaged = true;
        clearOutline(state.hoverOutline);
        state.hovered = null;
        return { engaged: true };
      },
      applyProfile: applyProfile, // 放行方案（工具条多态切换 / 调速面板管理）
      // 当前选区载荷（AI 确认回传用）；__state 调试用——必须挂在 window.__dbg（此前误放 CDP.DOM 表导致
      // ensureClientFresh 幂等检查 getSelectionPayload 失败 → 每次 enterInspector 重注入 → 旧 message 监听残留 →
      // dbg_exec 被旧（空 state）client 先处理返回 null（自检⑤⑫ 失败根因）
      getSelectionPayload: function () { var el = state.selected || state.hovered; return el ? aiPickPayload(el) : null; },
      __state: function () { return { active: state.active, engaged: state.engaged, hasOver: true, hasClick: true }; },
      // 本地缓冲暴露（方案 F-3：page_logs/page_network 工具通过 CDP Runtime.evaluate 按需拉取，不再实时上报）
      __consoleRing: CONSOLE_RING,
      __netRing: NET_RING,
    };

    // ---------- 写入可编辑元素：React 兼容“真实键入”（等价 CDP Input.insertText） ----------
    // contenteditable（富文本/<p> 可编辑块）→ focus + 光标定位 + document.execCommand('insertText')
    //   浏览器原生输入路径触发真实 beforeinput/input(inputType=insertText)，React onChange 正确接收，值不被重置
    // input/textarea → 原生原型 value setter（React 受控 value tracker 同步）+ input/change
    // select → 设值 + change；replace=true 清空现有内容再写入（setValue/type 语义），false 仅光标处插入（insertText 语义）
    function writeEditable(el, text, replace) {
      if (!el) return { ok: false, error: 'no element', tag: null };
      var value = String(text == null ? '' : text);
      var isCE = el.isContentEditable || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT' && el.hasAttribute && el.hasAttribute('contenteditable'));
      if (isCE) {
        try { el.focus(); } catch (e) {}
        try {
          var sel = window.getSelection();
          if (sel) {
            var range = document.createRange();
            range.selectNodeContents(el);
            if (!replace) range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        } catch (e) {}
        var done = false;
        try { done = document.execCommand('insertText', false, value); } catch (e) {}
        if (!done) {
          try { el.textContent = value; } catch (e) {}
          try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' })); }
          catch (e) { try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {} }
        }
        return { ok: true, editable: true, value: (el.innerText != null ? el.innerText : el.textContent || '') };
      }
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        try { el.focus(); } catch (e) {}
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        try { if (desc && desc.set) desc.set.call(el, value); else el.value = value; } catch (e) { try { el.value = value; } catch (e2) {} }
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        return { ok: true, editable: false, value: el.value };
      }
      if (el.tagName === 'SELECT') {
        try { el.value = value; } catch (e) {}
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        return { ok: true, editable: false, value: el.value };
      }
      return { ok: false, error: 'not an editable element（目标非 input/textarea/select/contenteditable）', tag: el.tagName || null };
    }

    // ---------- CDP-like 命令集（浏览器端等价实现，全部纯函数可序列化） ----------
    // 命名对齐 CDP 域：DOM / CSS / Input / Page / Runtime / Storage / Performance
    var EXCLUDED_PROPS = {
      constructor: 1, '__proto__': 1, 'prototype': 1, 'innerHTML': 1, 'outerHTML': 1,
      'hasOwnProperty': 1, 'isPrototypeOf': 1, 'propertyIsEnumerable': 1, 'toString': 1,
      'valueOf': 1, 'toLocaleString': 1, 'onclick': 1, 'onmouseover': 1, 'onload': 1,
    };
    var evalEnabled = true; // 调试会话内默认放行（等价于用户自己在 Console eval）；面板可关；由 dbgToken 认证边界 + eval 审计日志兜底

    function resolveEl(args) {
      var el = null;
      if (args && args.selector) { try { el = document.querySelector(args.selector); } catch (e) {} }
      if (!el && args && args.xpath) {
        try {
          var r = document.evaluate(args.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          el = r.singleNodeValue;
        } catch (e) {}
      }
      if (!el) el = state.selected || state.hovered || null;
      return (el && isDbgEl(el)) ? null : el; // aiti 自身元素不可寻址（inspect/操作排除自身 UI）
    }

    function treeSummary(node, depth) {
      if (!node || depth <= 0) return null;
      if (isDbgEl(node)) return null; // 排除 aiti 自身注入内容（launcher 整树/outline 框/样式）
      var out = {
        tag: node.tagName ? node.tagName.toLowerCase() : '#' + node.nodeName,
        id: node.id || undefined,
        cls: (node.className && typeof node.className === 'string') ? node.className.slice(0, 60) : undefined,
      };
      if (node.children && node.children.length) {
        out.children = [];
        for (var i = 0; i < node.children.length && i < 15; i++) {
          var c = treeSummary(node.children[i], depth - 1);
          if (c) out.children.push(c);
        }
        if (node.children.length > 15) out.children.push({ tag: '…+' + (node.children.length - 15) });
      }
      return out;
    }

    var CDP = {
      DOM: {
        querySelector: function (args) {
          var el = resolveEl(args);
          return el ? serialize(el, { attrs: 1, xpath: 1, text: 1, computed: 1, framework: 1 }) : null;
        },
        querySelectorAll: function (args) {
          if (!args || !args.selector) return [];
          var els = document.querySelectorAll(args.selector);
          var out = [];
          for (var i = 0; i < els.length && out.length < 20; i++) {
            if (isDbgEl(els[i])) continue; // 排除 aiti 自身内容（launcher 整树/outline 框/样式）
            out.push({ tag: els[i].tagName.toLowerCase(), id: els[i].id, cls: els[i].className && String(els[i].className).slice(0, 60), text: cleanTextOf(els[i], 80), xpath: xpathOf(els[i]) });
          }
          return out;
        },
        getBoxModel: function (args) {
          var el = resolveEl(args);
          if (!el) return null;
          var r = el.getBoundingClientRect();
          var cs = getComputedStyle(el);
          return { content: [r.x, r.y, r.width, r.height], right: r.right, bottom: r.bottom, padding: cs.padding, margin: cs.margin, borderWidth: cs.borderWidth, scroll: { x: el.scrollLeft, y: el.scrollTop } };
        },
        getOuterHTML: function (args) { var el = resolveEl(args); return el ? el.outerHTML.slice(0, 8000) : null; },
        getInnerText: function (args) { var el = resolveEl(args); return el ? cleanTextOf(el, 2000) : null; },
        removeNode: function (args) { var el = resolveEl(args); if (!el || !el.parentNode) return false; el.remove(); return true; },
        setAttribute: function (args) { var el = resolveEl(args); if (!el) return false; el.setAttribute(args.name, String(args.value)); return true; },
        removeAttribute: function (args) { var el = resolveEl(args); if (!el) return false; el.removeAttribute(args.name); return true; },
        clearSelection: function () { state.selected = null; clearOutline(state.selOutline); return true; },
        getDocument: function (args) { return treeSummary(document.body, (args && args.depth) || 3); },
      },
      CSS: {
        getComputedStyle: function (args) {
          var el = resolveEl(args);
          if (!el) return null;
          var cs = getComputedStyle(el);
          var out = {};
          var props = (args && args.properties) ? String(args.properties).split(',') : CSS_WHITELIST;
          props.forEach(function (k) { if (cs[k] !== undefined) out[k] = String(cs[k]).slice(0, 300); });
          return out;
        },
        getMatchedRules: function (args) {
          var el = resolveEl(args);
          if (!el) return [];
          var out = [];
          for (var i = 0; i < document.styleSheets.length; i++) {
            var ss = document.styleSheets[i];
            var rules;
            try { rules = ss.cssRules || ss.rules; } catch (e) { continue; } // 跨域样式表
            if (!rules) continue;
            for (var j = 0; j < rules.length; j++) {
              var rule = rules[j];
              if (rule.selectorText && el.matches) {
                var matched = false;
                try { matched = el.matches(rule.selectorText); } catch (e) {}
                if (matched) {
                  out.push({ selector: rule.selectorText, cssText: rule.style ? rule.style.cssText.slice(0, 500) : '', source: (ss.href || 'inline').split('/').pop() });
                }
              }
            }
          }
          return out.slice(0, 20);
        },
        setStyle: function (args) {
          var el = resolveEl(args);
          if (!el) return false;
          var styles = (args && args.styles) || {};
          Object.keys(styles).forEach(function (k) { el.style[k] = String(styles[k]); });
          return serialize(el, { computed: 1 }).computed;
        },
        listStyleSheets: function () {
          var out = [];
          for (var i = 0; i < document.styleSheets.length; i++) {
            var ss = document.styleSheets[i];
            var count = -1;
            try { count = ss.cssRules ? ss.cssRules.length : 0; } catch (e) {}
            out.push({ index: i, href: ss.href || '(inline)', rules: count });
          }
          return out;
        },
        getStyleSheetText: function (args) {
          try {
            var ss = document.styleSheets[args.index];
            if (!ss || !ss.cssRules) return null;
            var parts = [];
            for (var i = 0; i < ss.cssRules.length; i++) parts.push(ss.cssRules[i].cssText);
            return parts.join('\n').slice(0, 8000);
          } catch (e) { return null; }
        },
      },
      Input: {
        click: function (args) { var el = resolveEl(args); if (!el) return false; el.click(); return true; },
        hover: function (args) {
          var el = resolveEl(args); if (!el) return false;
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
          return true;
        },
        focus: function (args) { var el = resolveEl(args); if (!el) return false; el.focus(); return true; },
        blur: function (args) { var el = resolveEl(args); if (!el) return false; el.blur(); return true; },
        setValue: function (args) {
          var el = resolveEl(args); if (!el) return { ok: false, error: '元素未定位' };
          var r = writeEditable(el, (args && args.value !== undefined) ? args.value : '', true);
          return { ok: r.ok, editable: !!r.editable, value: r.value, error: r.error };
        },
        type: function (args) {
          var el = resolveEl(args); if (!el) return { ok: false, error: '元素未定位' };
          var text = (args && args.text !== undefined) ? String(args.text) : '';
          var r = writeEditable(el, text, true);
          return { ok: r.ok, editable: !!r.editable, value: r.value, len: text.length, error: r.error };
        },
        // 对齐 CDP Input.insertText：在光标处插入文本（不替换已有内容）——React 受控/富文本通用
        insertText: function (args) {
          var el = resolveEl(args) || document.activeElement;
          var text = (args && args.text !== undefined) ? String(args.text) : '';
          var r = writeEditable(el, text, false);
          return { ok: r.ok, editable: !!r.editable, value: r.value, error: r.error };
        },
        keyPress: function (args) {
          var el = resolveEl(args) || document.activeElement;
          if (!el) return false;
          var opts = { key: args.key || 'Enter', code: args.code || '', bubbles: true, cancelable: true };
          el.dispatchEvent(new KeyboardEvent('keydown', opts));
          el.dispatchEvent(new KeyboardEvent('keyup', opts));
          return true;
        },
      },
      Page: {
        getMeta: function () {
          return { url: topUrl().slice(0, 2000), title: document.title, readyState: document.readyState, referrer: document.referrer.slice(0, 500), ua: navigator.userAgent.slice(0, 200) };
        },
        scrollTo: function (args) {
          window.scrollTo({ top: (args && args.top) || 0, left: (args && args.left) || 0, behavior: (args && args.behavior) || 'auto' });
          return { top: window.scrollY, left: window.scrollX };
        },
        scrollIntoView: function (args) {
          var el = resolveEl(args); if (!el) return false;
          el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: (args && args.smooth) ? 'smooth' : 'auto' });
          return true;
        },
        reload: function () { location.reload(); return true; },
        navigate: function (args) { if (args && args.url) location.href = args.url; return true; },
        // 截屏：直连路径（无手势卡）兜底——有 activation 就能成（Chrome 桌面），
        // 否则浏览器拒绝 → 提示走 AI 窗手势卡路径（launcher danger.js 同名实现会弹用户确认）
        captureScreenshot: function () {
          // 旧 getDisplayMedia 直连截屏已下线——统一由 launcher 截屏卡流程接管（见 danger.js）
          return Promise.resolve({ error: 'Page.captureScreenshot 已由 launcher 截屏卡接管（意图说明→调整页面→预览确认），此直连路径已停用' });
        },
        // 页面 frame 树（iframe 嵌套）：同域可读 title/url/readyState；跨域仅 iframe 元素属性（src/name）
        getFrameTree: function () {
          function walk(win, path) {
            var doc = null, frames = [];
            try { doc = win.document; } catch (e) {}
            if (doc) {
              var ifr = doc.querySelectorAll('iframe, frame');
              for (var i = 0; i < ifr.length; i++) {
                var f = ifr[i];
                var info = { id: path + '/' + i, name: f.name || '', src: f.src || f.getAttribute('src') || '', title: f.title || '' };
                try {
                  info.sameOrigin = true;
                  info.url = f.contentWindow.location.href.slice(0, 500);
                  try { info.title = f.contentDocument.title; } catch (e2) {}
                  try { info.readyState = f.contentDocument.readyState; } catch (e2) {}
                  var sub = walk(f.contentWindow, info.id);
                  if (sub && sub.length) info.childFrames = sub;
                } catch (e2) { info.sameOrigin = false; }
                frames.push(info);
              }
            }
            return frames;
          }
          return { frameTree: { id: 'frame', url: topUrl().slice(0, 500), title: document.title, readyState: document.readyState, sameOrigin: true, childFrames: walk(window, 'frame') } };
        },
      },
      Runtime: {
        evaluate: function (args) {
          if (!evalEnabled) return { error: 'Runtime.evaluate 已关闭：面板里可重新开启（Runtime.setEvalEnabled {enabled:true}）' };
          // contextId：进 iframe 上下文执行（同域——iframe 索引从 1 开始；跨域返回错误）。顶层不传/0。
          var targetWin = null;
          if (args && args.contextId) {
            var _ifrs = document.querySelectorAll('iframe, frame');
            var _idx = Number(args.contextId) - 1;
            if (_idx < 0 || _idx >= _ifrs.length) return { error: 'contextId ' + args.contextId + ' 越界（共 ' + _ifrs.length + ' 个 iframe；contextId 从 1 开始）' };
            targetWin = _ifrs[_idx].contentWindow;
          }
          try {
            var val = targetWin ? targetWin.eval(String(args.expression)) : eval(String(args.expression));
            // awaitPromise（MCP 标准）：结果若是 Promise → 等待最终值（异步 handler，宿主已支持 Promise 回传）
            if (args && args.awaitPromise && val && typeof val.then === 'function') {
              return val.then(function (v) {
                var out = { type: typeof v, value: (typeof v === 'string' ? stripAitiText(v).slice(0, 2000) : v), awaited: true };
                post({ type: 'dbg_eval_log', payload: { expression: String(args.expression).slice(0, 200), result: JSON.stringify(out).slice(0, 300), ts: new Date().toISOString() } });
                return out;
              }).catch(function (e) { return { error: String((e && e.message) || e) }; });
            }
            // 未 awaitPromise 且结果是 Promise：不能直接回传（postMessage 结构化克隆 Promise 会抛错 → 结果丢失 → 桥超时）
            if (val && typeof val.then === 'function') {
              return { type: 'promise', isPromise: true, value: 'Promise（如需最终结果传 awaitPromise: true）' };
            }
            var out = { type: typeof val, value: (typeof val === 'string' ? stripAitiText(val).slice(0, 2000) : val) };
            // eval 审计：表达式 + 结果摘要上报宿主面板（用户可见）
            post({ type: 'dbg_eval_log', payload: { expression: String(args.expression).slice(0, 200), result: JSON.stringify(out).slice(0, 300), ts: new Date().toISOString() } });
            return out;
          } catch (e) { return { error: String((e && e.message) || e) }; }
        },
        setEvalEnabled: function (args) { evalEnabled = !!(args && args.enabled); return { evalEnabled: evalEnabled }; },
        fetch: function (args) {
          // 在目标页上下文发 JS 请求（同源，无 CORS；受网络模拟影响，体现场景一致性）
          if (!args || !args.url) return { error: '需要 url' };
          var url = args.url, init = args.init || {};
          return window.fetch(url, init).then(function (res) {
            return res.text().then(function (text) {
              return { status: res.status, ok: res.ok, url: String(res.url || url).slice(0, 300), text: text.slice(0, 2000) };
            });
          }).catch(function (e) { return { error: String((e && e.message) || e) }; });
        },
        getProperties: function (args) {
          var el = resolveEl(args);
          if (!el) return null;
          var out = {};
          var names = Object.getOwnPropertyNames(el);
          for (var i = 0; i < names.length && i < 30; i++) {
            var n = names[i];
            if (EXCLUDED_PROPS[n]) continue;
            try {
              var v = el[n];
              out[n] = (typeof v === 'function') ? '[function]' : ((typeof v === 'object' && v !== null) ? '[object]' : String(v).slice(0, 100));
            } catch (e) { out[n] = '[unreadable]'; }
          }
          return out;
        },
      },
      Storage: {
        localStorageGet: function (args) { try { return { key: args.key, value: localStorage.getItem(args.key) }; } catch (e) { return { error: String(e.message) }; } },
        localStorageSet: function (args) { try { localStorage.setItem(args.key, String(args.value)); return true; } catch (e) { return { error: String(e.message) }; } },
        localStorageClear: function () { try { localStorage.clear(); return true; } catch (e) { return { error: String(e.message) }; } },
        sessionStorageGet: function (args) { try { return { key: args.key, value: sessionStorage.getItem(args.key) }; } catch (e) { return { error: String(e.message) }; } },
        cookies: function () { try { return document.cookie.slice(0, 2000); } catch (e) { return ''; } },
      },
      Performance: {
        getEntries: function (args) {
          var n = (args && args.count) ? args.count : 10;
          try {
            return performance.getEntriesByType('resource').slice(-n).map(function (e) {
              return { name: e.name.slice(0, 200), type: e.initiatorType, duration: Math.round(e.duration), size: e.transferSize || e.encodedBodySize || 0 };
            });
          } catch (err) { return []; }
        },
      },
      // 浏览器受限操作（剪贴板/下载/弹窗/全屏/播放）：程序化执行会被浏览器拦截，需用户真实点击（手势桥）
      Browser: {
        copy: function (args) {
          return navigator.clipboard.writeText(String(args.text || '')).then(
            function () { return { copied: true }; },
            function (e) { return { error: '剪贴板被浏览器拦截（需要用户手势）：' + String((e && e.message) || e) }; }
          );
        },
        download: function (args) {
          var a = document.createElement('a');
          a.href = args.dataUrl || ('data:text/plain,' + encodeURIComponent(String(args.text || '')));
          a.download = args.name || 'dbg-download.txt';
          document.body.appendChild(a);
          a.click();
          a.remove();
          return { downloaded: a.download };
        },
        openWindow: function (args) {
          var w = window.open(args.url || 'about:blank', '_blank');
          return w ? { opened: true } : { error: '弹窗被浏览器拦截（需要用户手势）' };
        },
        // 以下三个与宿主手势卡同款（launcher danger.js）：这里仅直连兑底——无 activation 大多被拒，
        // 报错文本引导重试（经 AI 窗转发的路径会弹确认卡，用户点确认后执行）
        paste: function () {
          if (!(navigator.clipboard && navigator.clipboard.readText)) return Promise.resolve({ error: '当前浏览器不支持剪贴板读取' });
          return navigator.clipboard.readText().then(
            function (t) { return { text: String(t || '').slice(0, 100000) }; },
            function (e) { return { error: '剪贴板读取被拒（无用户手势/未授权）：' + String((e && e.message) || e) + '——重试（经 AI 窗路径会弹确认卡）' }; }
          );
        },
        pickFile: function () {
          return Promise.resolve({ error: '文件选择器需用户手势（直连路径不可用）——重试（经 AI 窗路径会弹确认卡，用户点确认后弹选择器）' });
        },
        share: function () {
          if (!navigator.share) return Promise.resolve({ error: '当前浏览器不支持 Web Share' });
          return Promise.resolve({ error: '分享需用户手势（直连路径不可用）——重试（经 AI 窗路径会弹确认卡）' });
        },
        fullscreen: function (args) {
          var el = resolveEl(args) || document.documentElement;
          var p = el.requestFullscreen && el.requestFullscreen();
          if (!p) return { error: '不支持全屏' };
          return p.then(function () { return { fullscreen: true }; }, function (e) { return { error: '全屏被浏览器拦截：' + String((e && e.message) || e) }; });
        },
        play: function (args) {
          var el = resolveEl(args);
          if (!el || !el.play) return { error: '未找到可播放元素' };
          return el.play().then(
            function () { return { playing: true }; },
            function (e) { return { error: '自动播放被浏览器拦截（需要用户手势）：' + String((e && e.message) || e) }; }
          );
        },
      },
    };

    // 旧命令别名（向后兼容）
    var CMD_ALIASES = {
      getInfo: 'DOM.querySelector',
      highlight: 'DOM.querySelector',
      scrollIntoView: 'Page.scrollIntoView',
    };

    // ---------- 宿主命令通道（含 AI 转发的 dbg_exec，全部异步往返） ----------
    // 键盘导航（锁定态 engaged 才拦截）：转发到 host 统一处理（host 调 doNav → postToTarget dbg_step）
    var NAV_KEYS = {
      ArrowUp: 'topN', ArrowDown: 'bottomN', ArrowLeft: 'leftN', ArrowRight: 'rightN',
      PageUp: 'prev', PageDown: 'next', Home: 'first', End: 'last',
      Backspace: 'up', Delete: 'up', Enter: 'downOrNext',
    };
    // 键盘接管（Esc 退出 / 方向键导航选区）：必须 capture 阶段且注册在 freezeEvent 之前——
    // freezeEvent（window capture，enterInspector 时 installFreeze 重注册，排在本监听之后）会
    // stopImmediatePropagation 冻结 keydown；bubble 阶段监听（含宿主 document hostKey）一律收不到，
    // 导致「Esc 退出从未生效 + 误报『keydown 被拦截』」。本监听 capture 先行（注册早于 freezeEvent）
    // + stopImmediatePropagation → freezeEvent 收不到：既不冻结页面也不弹拦截提示。
    // 同时消除默认放行下 hostKey(document bubble) 与本站监听(window bubble) 的双重 Esc/导航处理。
    window.addEventListener('keydown', function (e) {
      if (!state.active) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      var k = e.key;
      if (k === 'Escape') {
        // Inspector 内 Esc 一律退出（提示语「Esc 退出」）：键盘焦点在目标 iframe 时宿主 document 收不到
        // keydown，由 client 转发 host 统一退出——快选态同样接管（否则 iframe 焦点下 Esc 无反应，Inspector 退不出）
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        if (aiPick) post({ type: 'dbg_ai_escape', payload: {} });
        else post({ type: 'dbg_inspect_escape', payload: {} });
        return;
      }
      var dir = NAV_KEYS[k];
      if (!dir) return;
      // 导航优先于页面滚动：Inspector 激活且已有选区（锁定 或 hover 快选/HUD 弹出）时拦截方向键；
      // 无选区（鼠标不在页面元素上）不拦截——页面滚动/页面自身键盘行为保持正常
      if (!state.engaged && !state.hovered) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      // 直接执行（不等 host 往返——target 内的 stepSelection 最快）
      stepSelection(dir);
      // 同时转发到 host（host 可同步工具条标签/HUD/选区状态）
      post({ type: 'dbg_key_nav', payload: { dir: dir } });
    }, true);

    window.addEventListener('message', function (e) {
      var m = e.data;
      if (!m || m.__dbg !== 1) return;
      switch (m.type) {
        case 'dbg_enter_inspector': window.__dbg.enterInspector(m.payload && m.payload.mode); break;
        case 'dbg_exit_inspector':  window.__dbg.exitInspector();  break;
        case 'dbg_set_options':     applyOptions((m.payload && m.payload.opts) || {}); break;
        case 'dbg_force_error':     forceError(m.payload && m.payload.kind); break;
        case 'dbg_simulate_hover':     window.__dbg.simulateHover(); break;
        case 'dbg_simulate_hover_off': window.__dbg.simulateHoverOff(); break;
        case 'dbg_passthrough_click':
          // 真实点击穿透：放行一次 click（先解冻 click，让页面打开菜单），随即恢复冻结
          passClick = true;
          window.removeEventListener('click', freezeEvent, true);
          setTimeout(function () { if (state.active) window.addEventListener('click', freezeEvent, true); }, 600);
          break;
        case 'dbg_release_events':
          // 事件放行矩阵：临时放行一组事件类别（click/key/wheel/scroll/hover/touch/focus），到期自动回锁
          releaseEvents((m.payload && m.payload.categories) || [], (m.payload && m.payload.durationMs) || 0);
          break;
        case 'dbg_lock_events':
          lockEvents(); // 立即锁回全部
          break;
        case 'dbg_toggle_event':
          toggleEvent(m.payload && m.payload.category, m.payload && m.payload.enabled);
          break;
        case 'dbg_resume_hover':
          window.__dbg.resumeHover();
          break;
        case 'dbg_ai_pick':
          aiPick = !!(m.payload && m.payload.active); // onClick/hover 由宿主进入 Inspector 提供
          break;
        case 'dbg_pause_hover':
          window.__dbg.pauseHover();
          break;
        case 'dbg_set_profile':
          applyProfile(m.payload && m.payload.profile);
          break;
        case 'dbg_cancel': {
          // 取消选区：清 selected + 退出临时状态 + 高亮清除（工具条保留可继续点选）
          state.selected = null;
          state.engaged = false;
          state.hovered = null;
          clearOutline(state.selOutline);
          clearOutline(state.hoverOutline);
          post({ type: 'dbg_selection_cancelled', payload: {} });
          break;
        }
        case 'dbg_step':            stepSelection(m.payload && m.payload.dir); break;
        case 'dbg_select':          selectBySelector(m.payload && m.payload.selector); break;
        case 'dbg_ai_confirm': {
          // AI 点选确认：回传当前选区给 AI 窗（累积待发送）+ 恢复 hover（可继续连续选择下一个）
          var aiEl = state.selected || state.hovered;
          if (aiEl) {
            var _ap = aiPickPayload(aiEl);
            // React 19.2+：chunk 定位 → 异步 sourcemap 解析出真实源文件+行再回传（AI 窗详情/候选显示真实路径，
            // 而不是目录聚合 chunk URL——components_03gcaqz._.js 这类名字无法解码，必须 sourcemap 还原）
            if (_ap && _ap.framework && (_ap.framework.react19Chunk || _ap.framework.usedAtChunk)) {
              resolveFrameworkLoc(_ap.framework).then(function (fw) {
                if (fw && _ap) {
                  _ap.framework = fw;
                  _ap.file = fw.file; _ap.line = fw.line; _ap.usedAt = fw.usedAt;
                }
                post({ type: 'dbg_ai_picked', payload: _ap });
              });
            } else {
              post({ type: 'dbg_ai_picked', payload: _ap });
            }
          }
          state.engaged = false;
          clearOutline(state.selOutline);
          // 恢复 hover 快选（工具条隐藏 + 宿主 hover 恢复）——先置空避免 setHovered 同元素短路
          state.hovered = null;
          setHovered(aiEl);
          break;
        }
        case 'dbg_key_nav': {
          // client 转发的键盘导航——同步工具条标签/选区状态
          if (m.payload && m.payload.dir) {
            addMsg('sys', '↩ 导航: ' + m.payload.dir);
          }
          break;
        }
        case 'dbg_current_selector': {
          var curEl = state.selected || state.hovered;
          if (curEl) post({ type: 'dbg_current_selector', payload: { selector: cssSelectorOf(curEl), xpath: xpathOf(curEl) } });
          break;
        }
        case 'dbg_confirm':         confirmSelection(); break;
        case 'dbg_exec': {
          var p = m.payload || {};
          var done = function (ok, result) {
            post({ type: 'dbg_exec_result', payload: { requestId: p.requestId, ok: ok, result: result } });
          };
          try {
            var cmd = CMD_ALIASES[p.cmd] || p.cmd;
            var dot = String(cmd).indexOf('.');
            var domain = dot > 0 ? cmd.slice(0, dot) : '';
            var method = dot > 0 ? cmd.slice(dot + 1) : '';
            var handler = CDP[domain] && CDP[domain][method];
            if (!handler) {
              done(false, { error: 'unknown command: ' + p.cmd + '（可用域：DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser；裸 eval 默认禁用）' });
            } else {
              // 支持 async handler（如 Runtime.fetch）：Promise 结果异步回传
              Promise.resolve(handler(p.args || {})).then(
                function (r) { done(true, r); },
                function (err) { done(false, { error: String((err && err.message) || err) }); }
              );
            }
          } catch (err) { done(false, { error: String((err && err.message) || err) }); }
          break;
        }
      }
    });

    post({ type: 'dbg_iframe_ready', payload: { frameworks: detectFrameworks(), url: topUrl().slice(0, 200) } });
    installErrorHook(); // 错误 hook 注入即生效（上报宿主）
    installConsoleHook(); // console 全量采集（方案 F-1：早期日志缓冲 + 连桥重放）
    installNetObserver(); // 网络完成态采集（方案 F-2：XHR/fetch）
  })();
