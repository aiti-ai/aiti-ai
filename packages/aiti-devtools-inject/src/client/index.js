// Mini in-page __dbg client (a real JS file; bundled by the vite plugin's esbuild into a string injected at build time)
// Injection: the host itself runs new Function('__DBG_POST__', code) (__DBG_POST__ is a free variable); same-origin iframe uses <script>.textContent
// Note: this file must stay a single IIFE (shared closure state); any change must pass the 21-point self-check
/* global __DBG_POST__, __DBG_VERSION__ */

  (function () {
    'use strict';
    // Idempotency check: skip only if same version and all key capabilities exist; stale old version (missing new capabilities / no cleanup on exit) → clean up listeners + overwrite (prevents picking after exit)
    if (window.__dbg && window.__dbg.__version__ && typeof window.__dbg.getSelectionPayload === 'function') return;
    if (window.__dbg && window.__dbg.__version__) {
      try { if (typeof window.__dbg.exitInspector === 'function') window.__dbg.exitInspector(); } catch (e) {}
      try { delete window.__dbg; } catch (e) {}
    }

    // hover: standard solid blue outline, no background fill (fill's rgba(79,70,229,.10) overlaid on the page = a translucent light-blue veil users mistook for a mask)
    var OUTLINE_HOVER = '2px solid #4f46e5';
    var OUTLINE_SEL   = '2px dashed #059669';

    // Real URL detection: when the launcher is injected at top level, location.href is the address-bar URL;
    // when injected inside an iframe (e.g. pi-web preview shell wrapping a real site), the user's address bar shows the outer URL —
    // same-origin can read window.top/window.parent; cross-origin falls back to document.referrer (a cross-origin iframe's referrer is the outer page URL).
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
      engaged: false, // temporary selection state: entered on click (hover disabled, toolbar kept); ✓ confirms / ✕ cancels and exits
      hovered: null,
      selected: null,
      hoverOutline: { node: null },
      selOutline: { node: null },
    };

    // ---------- Utilities ----------
    // Injectable post: self mode (injected into the host page itself) uses the __DBG_POST__ callback; iframe mode goes through parent.postMessage
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

    // computedStyles whitelist (§3.7 reference implementation: default values skipped)
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
      // viewport-coordinate rect (same coordinate system as CDP Input.dispatchMouseEvent, clicks elements directly) + document-coordinate docRect (scroll-independent, for absolute page position / locating after scrolling)
      // + scroll (scroll offset at sampling time = coordinate-system context note: docRect = rect + scroll)
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

    // ---------- Framework detection (§3.4 four-framework fileLocation) ----------
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
    // Strip React hook-inferred name suffixes (MarkdownBody.useMemo[components] → MarkdownBody) for more readable display
    function cleanComponentName(n) {
      if (!n) return null;
      return String(n).replace(/\.use(Memo|Callback|Effect|Ref|State|Reducer)\s*\[[^\]]*\]$/, '');
    }

    // ---------- React 19.2+ source location (_debugSource removed; read _debugStack instead) ----------
    // In React 19.2+, jsxDEV no longer takes a source object; an Error("react-stack-top-frame") is captured at the call site instead:
    //   fiber._debugStack.stack first frame = inside jsx-dev-runtime, second frame = the JSX call site (chunk URL:line:col);
    //   Next dev (Turbopack) ships .map source maps for chunks → exact source file+line recovery.
    // Returns {url, line, column, component} (first non-react-internal frame = the JSX call site);
    // first frame UnknownOwner (budget exhausted) → returns {__unknownOwner:true} (caller can stop walking up, avoiding distant ancestors).
    function react19StackSrc(err) {
      try {
        var stack = (err && err.stack) || '';
        if (!stack) return null;
        var lines = stack.split('\n');
        // After the React 19.2 owner-stack budget (recentlyCreatedOwnerStacks, 1e4 entries) is exhausted, jsxDEV gives all new elements
        // the unknownOwnerDebugStack captured at module init time (first frame UnknownOwner, later frames pointing inside jsx-dev-runtime
        // chunk internals / module evaluation) — such stacks have no real call site; treating one as the first frame would report node_modules chunks as component sources.
        // A real stack's first frame is always exports.jsxDEV; first frame UnknownOwner → the whole stack has no real location, return the sentinel.
        var firstFn = null;
        // Normalize Turbopack path escaping ($2d=- $2f=/ ...) to ease matching react-internal frames
        var norm = function (s) { return String(s || '').replace(/\$([0-9a-fA-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); }); };
        for (var i = 1; i < lines.length; i++) {
          var ln = lines[i];
          var fn = null, url = null, line = null, col = null;
          var m = null;
          // Firefox: fn@url:line:col  /  @url:line:col
          m = ln.match(/^(?:([^@]*)@)?(.*?):(\d+)(?::(\d+))?$/);
          if (m && m[2]) { fn = m[1]; url = m[2]; line = parseInt(m[3], 10); col = m[4] ? parseInt(m[4], 10) : null; }
          else {
            // Chrome: at fn (url:line:col)  /  at fn@url:line:col (webpack-internal style)  /  at url:line:col
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
            if (/^(UnknownOwner)$/.test(firstFn)) return { __unknownOwner: true }; // shared stack (budget exhausted) → no real location
          }
          // Skip react-internal frames: jsx-dev-runtime / jsx-runtime / react-dom / scheduler / next compiled react / turbopack runtime / HMR / stack-marker frames
          //   + RSC/SSR pseudo frames: about://React/Server (server-side rendering), react-server-dom-turbopack (RSC deserialization),
          //   fakeJSXCallSite (RSC element creation), [root-of-the-server]/server chunks (SSR root chunks) — none are real client-side JSX call sites
          if (/jsx[-.]dev[-.]runtime|jsx[-.]runtime|\.react-dom|react-dom[./]|scheduler[./]|next[./]dist[./]compiled[./]react[./]|turbopack[./_]|hmr-client|about:\/\/React\/Server|react-server-dom-turbopack|fakeJSXCallSite|root-of-the-server|\.next[-_]dev|server[./_]chunks/.test(nu)) continue;
          if (/^(jsxDEV|jsxs|jsx|createElement|react_stack_bottom_frame|react-stack-top-frame|fakeJSXCallSite)$/.test(fn0)) continue;
          var cname = fn0 || null;
          if (cname && /^(jsxDEV|jsxs|jsx|createElement|React\.createElement)$/.test(cname)) cname = null;
          return { url: url, line: line || 1, column: col || 1, component: cname };
        }
        return null;
      } catch (e) { return null; }
    }

    // Turbopack dev chunk name → source file path (sync approximation: components_AppShell_tsx_0s7278a._.js → components/AppShell.tsx);
    // returns null on failure (caller falls back to the chunk URL as-is). Line numbers need sourcemap refinement (completed async via react19Chunk).
    function chunkNameToPath(chunkUrl) {
      try {
        var u = String(chunkUrl || '').split('?')[0];
        var base = u.split('/').pop() || '';
        var m = base.match(/^(.+?)_([0-9a-z-]+)\._\.js$/);
        if (!m) return null;
        var segs = m[1].split('_');
        var extSeg = segs.pop() || '';
        if (!/^[a-z]{2,5}$/.test(extSeg)) return null; // not a source chunk (directory/utility chunk) → give up
        var dec = function (s) { return s.replace(/\$([0-9a-fA-F]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); }); };
        var p = segs.map(dec).join('/') + '.' + extSeg;
        return p || null;
      } catch (e) { return null; }
    }

    // ---- sourcemap v3 decoding (VLQ + sections) — maps chunk positions to source files ----
    var _SM_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    // Parse-result cache: each map object is parsed only once (fully re-parsing a large map's mappings is costly; the confirm flow queries the same chunk twice)
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
        var genCol = 0; // generated column is a per-line delta (reset at line start)
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
      // line0/col0 are 0-based; supports sections index mapping
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
      // Parse-result cache (each map parsed only once); without WeakMap, fall back to parsing every time
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
        // Failures (null) are not cached forever — retry (a first-fetch network hiccup would leave the whole chunk unresolvable forever → the chunk URL gets displayed)
        return cached.then(function (d) { return d ? d : _doFetchMap(u); });
      }
      _chunkMapCache[u] = _doFetchMap(u);
      return _chunkMapCache[u];
    }
    function _doFetchMap(u) {
      // Turbopack/Next dev stack chunk URLs carry a ?id= query; appending .map as-is would 404 — strip the query first;
      // on failure fall back to appending as-is (Vite dev's ?t= timestamps and similar cases where the query participates in addressing)
      return fetch(u.replace(/\?.*$/, '') + '.map', { cache: 'force-cache' })
        .then(function (r) {
          return r.ok ? r.json() : fetch(u + '.map', { cache: 'force-cache' }).then(function (r2) { return r2.ok ? r2.json() : null; });
        })
        .catch(function () { return null; });
    }
    // chunk position → real source file (strip file:/// prefix; strip webpack:// prefix; strip [project]/ prefix)
    // Neighborhood fallback when exact line/col misses (±1 line/col, up to ±40 lines): React owner-stack frames (closing lines of multi-line jsxDEV calls: }, this),)
    // are often a few lines/cols off their mapping segments; the closing line of a multi-line jsxDEV call (e.g. }, this)) is blank in the sourcemap (only the start is mapped),
    // so a wider line scan is needed to hit a nearby mapping segment in the same file.
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
          // Wider line scan (±40 lines, only when both exact and neighborhood miss): covers blank regions like the closing lines of multi-line jsxDEV calls,
          // taking the nearest hit (adjacent segment in the same file) — prefer a real line over leaving a chunk URL
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

    // ---- Component name → source file (budget-exhausted fallback) ----
    // After the React 19.2 owner-stack budget (1e4) is exhausted, all new elements are UnknownOwner and element-level line numbers are unavailable (a hard React limit).
    // But component names are still available from the fiber chain — scan loaded chunks' sourcemap sourcesContent for component-definition patterns to find the owning file,
    // at least giving the user the "file" (no line number, openable in an editor for locating). Lazy-built + cached.
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

    // ---- Budget-exhausted fallback (real line numbers): component fn toString → locate chunk line → sourcemap exact source file+line ----
    // When the React 19.2 owner-stack budget is exhausted, element-level line numbers are unavailable, but the component function object is always on the fiber.
    // Dev-build chunks keep readable function signatures (function MarkdownBody({…})); use unique substrings from the first lines of toString
    // to locate the function's line in the chunk, then recover source file+line via sourcemap (the component definition line, not the JSX call line, but real and openable).
    var _chunkTextCache = null; // {url: text}
    function fetchChunkText(url) {
      var u = String(url || '').split('?')[0];
      if (_chunkTextCache && u in _chunkTextCache) return Promise.resolve(_chunkTextCache[u]);
      return fetch(u, { cache: 'force-cache' })
        .then(function (r) { return r.ok ? r.text() : null; })
        .catch(function () { return null; })
        .then(function (t) { if (!_chunkTextCache) _chunkTextCache = {}; _chunkTextCache[u] = t; return t; });
    }
    // Function toString → unique search-substring candidates: several longer single lines from the body (≥20 chars, unique and exactly searchable within one line) + the signature's first line.
    // Note chunks keep original newlines/indentation; substrings spanning lines fail to match across newlines — must use single-line exact search.
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
      // Prefer components-directory chunks (where app components live), then others
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
    // fnLocs: [{name, sigs:[]}] (function components nearest to the element first) → real {file,line,column}.
    // Robustness: a fnLoc's multiple unique lines must resolve ≥2 of them to the same file to be trusted (guards against generic lines colliding across files),
    // otherwise skip that fnLoc and try the next; skip node_modules.
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
                if (res && res.file && !/node_modules/.test(res.file)) return res; // app file → adopt
                return nextChunk(ui + 1); // node_modules / miss → continue
              });
            });
          }
          return nextChunk(0).then(function (res) { results.push(res); return nextSig(si + 1); });
        }
        return nextSig(0).then(function () {
          // Consistency: trust only when ≥2 lines resolve to the same file name
          var counts = {};
          results.forEach(function (r) { if (r && r.file) { var base = r.file.split('/').pop(); counts[base] = (counts[base] || 0) + 1; } });
          var best = null, bestCount = 0;
          for (var k in counts) { if (counts[k] > bestCount) { bestCount = counts[k]; best = k; } }
          if (bestCount >= 2) {
            for (var i = 0; i < results.length; i++) { if (results[i] && results[i].file.split('/').pop() === best) return results[i]; }
          }
          return null; // no consistent confirmation → skip this fnLoc
        });
      }
      function step(fi) {
        if (fi >= fnLocs.length) return Promise.resolve(null);
        return resolveFnLoc(fnLocs[fi]).then(function (res) { if (res) return res; return step(fi + 1); });
      }
      return step(0);
    }

    // Async framework payload completion: react19Chunk/usedAtChunk (chunk locations) → sourcemap exact source file+line.
    // Returns a copied framework (original object untouched); resolves as-is immediately when there are no chunk fields.
    // Shared by confirmSelection (preview) and AI pick/candidates (dbg_ai_picked → dbg_ai_element) —
    // directory-aggregated chunks (components_03gcaqz._.js and the like) cannot be decoded by name; sourcemap is required to recover the real source file.
    function resolveFrameworkLoc(fl) {
      if (!fl || typeof fl !== 'object') return Promise.resolve(fl);
      var fc = fl.react19Chunk, uc = fl.usedAtChunk;
      if (!fc && !uc) {
        // Budget exhausted (no chunk location): component fn → real line first, then degrade to component name → file (no line number)
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
        // chunk resolution failed + function signature/component name present: component fn → real line → component name → file
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

        /** vue-inspector line lookup: BFS the component subtree vnodes to find the vnode matching el and read its __v_inspector / data-v-inspector ("relative-root-path:line:col")
          *  Injected by vite-plugin-vue-inspector at compile time; _interopVNode moves data-v-inspector into props.__v_inspector at runtime;
          *  Vue DevTools "Open in Editor" line numbers come from this source (independent of __file injection, works in all environments).
          *  Cache: el stays the same across vnode re-renders while the template position is unchanged — WeakMap + TTL avoids repeating the high-frequency BFS on hover */
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

    /** Unified output of {framework, file, line, column, component} — the AI side stays framework-agnostic */
    function fileLocation(el) {
      if (!el) return null;
      var loc = null;
      // --- React / Next.js: fiber._debugSource (dev builds only) ---
      var fiber = findFiber(el);
      if (!fiber) {
        // Walk up at most 5 levels to find an ancestor carrying a mounted fiber
        var p = el.parentElement, depth = 0;
        while (p && depth < 5 && !fiber) { fiber = findFiber(p); p = p.parentElement; depth++; }
      }
      if (fiber) {
        var fw = (window.next || window.__NEXT_DATA__ || window.__next_f || document.getElementById('__next'))
          ? 'next' : 'react';
        var node = fiber;
        var prodComp = null; // production-build (no _debugSource) fallback: records the component name
        var nearComp = null; // nearest readable component name (skips hook-inferred / single-lowercase-letter names) — fallback display when budget exhaustion leaves nothing locatable
        var uoStreak = 0;    // consecutive UnknownOwner count (React 19.2 owner-stack budget exhausted) — stop above the threshold to avoid misreporting distant ancestors (e.g. AppShell) as the component
        var fnLocs = null;   // toString signatures of the function components nearest to the element (used by the budget-exhausted fallback to compute real line numbers)
        for (var i = 0; node && i < 30; i++) {
          var src = node._debugSource;
          var r19 = null;
          // React 19.2+: _debugSource removed; source info lives in _debugStack (an Error whose stack contains the JSX call frame → chunk URL:line:col)
          if (!src) {
            r19 = node._debugStack ? react19StackSrc(node._debugStack) : null;
            if (r19 && !r19.__unknownOwner) { src = r19; uoStreak = 0; }
            else { if (++uoStreak > 8) break; } // budget exhausted (UnknownOwner shared stack) / no stack / parse failure → no real location; stop after too many consecutive (guards against distant ancestor AppShell)
          } else {
            uoStreak = 0;
          }
          if (src && src.fileName) {
            // host fibers (string type) also carry _debugSource; keep walking up for the real component
            var compFiber = node;
            while (compFiber && typeof compFiber.type !== 'function') compFiber = compFiber.return;
            // Used-at location: walk up for the parent rendering this component (first function component on the return chain) and read its _debugSource
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
            // React 19.2+: file first takes the chunk-name-decoded path (sync, no line number — chunk lines ≠ source lines);
            // exact file+line is resolved async via sourcemap in the confirm flow (the react19Chunk field carries the chunk location)
            var dec = chunkNameToPath(r19.url);
            loc = {
              framework: fw,
              file: dec || r19.url,
              line: null, column: null,
              component: cleanComponentName(r19.component) || componentNameOf(node.type),
              react19Chunk: { url: r19.url, line: r19.line, column: r19.column },
            };
            // Used-at location: the owning component's (first function on the return chain) _debugOwner = the parent rendering it;
            // the parent fiber's _debugStack contains its JSX frame (the parent's source position; exact line/col filled in async)
            var compFiber2 = node;
            while (compFiber2 && typeof compFiber2.type !== 'function') compFiber2 = compFiber2.return;
            var ow = compFiber2 && compFiber2._debugOwner;
            if (ow) {
              var os = ow._debugStack ? react19StackSrc(ow._debugStack) : null;
              // Record the used-at location only when the parent's location is recoverable (not budget-exhausted / not an RSC pseudo frame) — otherwise usedAt becomes a fake URL like about://React/Server
              if (os && os.url && !os.__unknownOwner) {
                var od = chunkNameToPath(os.url);
                loc.usedAt = { file: od || os.url, line: null, component: componentNameOf(ow.type) || os.component };
                loc.usedAtChunk = { url: os.url, line: os.line, column: os.column };
              }
            }
            break;
          }
          // Production build: no _debugSource — record the first function component name (later iterations may pick up an ancestor's src; the fallback is applied only at the end)
          if (!prodComp && typeof node.type === 'function') prodComp = componentNameOf(node.type);
          // Deepest readable component name (for fallback display): skip hook-inferred names (useMemo[…] etc.) and single-lowercase-letter names (e.g. p)
          if (typeof node.type === 'function') {
            var _nc = componentNameOf(node.type);
            if (_nc && !/useMemo|useCallback|\.bind|_this\d|^[a-z]{1,3}$/.test(_nc)) nearComp = _nc;
          }
          // Capture toString signatures of the last 2 function components (to locate real lines when the budget is exhausted; nearest to the element first)
          if (typeof node.type === 'function' && (!fnLocs || fnLocs.length < 2)) {
            var _sigs = fnLocSignature(node.type);
            if (_sigs.length) (fnLocs = fnLocs || []).push({ name: componentNameOf(node.type) || null, sigs: _sigs });
          }
          node = node.return;
        }
        // Production-build fallback: source is unavailable, but the component name / call-chain component names remain (first function component on the fiber.return chain = this component, one above = the caller)
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
      // --- Vue 3: el.__vueParentComponent.type.__file (really injected in dev builds) ---
      // Note: __file is not always present (some projects don't inject it in dev builds — plugin-vue/compiler-sfc version mismatch or custom plugins),
      //   but component name (__name/name) and parent component name are always available — without __file still output framework/component/usedAt (name level), file null
      if (!loc && el.__vueParentComponent && el.__vueParentComponent.type) {
        var vp = el.__vueParentComponent.type;
        var vpFile = vp.__file || null;
        var vpName = vp.__name || vp.name || null;
        if (vpFile || vpName) {
          // Line number: injected at compile time by vue-inspector (vnode.props.__v_inspector = "relative-root-path:line:col" — the template element's source position),
          //   independent of __file and available in all environments (empty in builds without vue-inspector — line number unavailable)
          var inspLine = null, inspCol = null, inspRel = null;
          try {
            var _insp = findVInspector(el.__vueParentComponent, el);
            if (_insp) {
              var _im = String(_insp).match(/^(.*?):(\d+)(?::(\d+))?$/);
              if (_im && _im[1] && _im[2]) { inspRel = _im[1]; inspLine = parseInt(_im[2], 10); inspCol = _im[3] ? parseInt(_im[3], 10) : null; }
            }
          } catch (e) {}
          // Relative → absolute: if the relative path (src/views/...) matches the tail of the absolute __file, the prefix is the project root; without __file keep the relative path (line number still displayable)
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
          // Used-at location: real builds have no __usedAt; derive from the parent instance (the component rendering this one = .parent.type)
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
      // --- Vue 2: el.__vue__.$options.__file (component/parent names also given when __file is absent) ---
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
      // --- Svelte 5: el.__svelte_meta.loc (real dev-compiler decoration) + __svelte_meta.parent (dev_stack) ---
      // Static HTML pages: the __svelte_meta.loc injected by Vite staticLocPlugin uses the same structure (real file/line/column + component)
      if (!loc && el.__svelte_meta && el.__svelte_meta.loc) {
        var sMeta = el.__svelte_meta;
        // Used-at location: old mock pages hand-write __svelte_used_at; real Svelte 5 dev output uses __svelte_meta.parent (dev_stack)
        // dev_stack entries are { type:'component', file:<caller file>, line, column, componentTag:<component name>, parent },
        // the first component entry = where this element's owning component is used in the parent template (root component elements have no entry → null)
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
      // --- Generic custom component metadata (pages on newer frameworks like Preact/Solid/Lit/Alpine mount it manually: __dbg_component, accurate framework name) ---
      //   the page/component side attaches {framework:'preact'|'solid'|'lit'|'alpine', file, line, column, component, usedAt} —
      //   read as fallback when real-framework detection misses (real React/Vue/Svelte take priority to avoid overwriting); used whenever any component info exists (file optional)
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

    // DFS the first N elements, probing DOM-level markers such as React fiber / Svelte __svelte_meta
    // (the React DevTools extension injects __REACT_DEVTOOLS_GLOBAL_HOOK__ into any page — not evidence;
    //  after a real React 18/19 mount, elements always carry __reactFiber$ keys)
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
      // The probe costs DOM traversal: reuse the result for 1.5s when hover calls at high frequency
      var now = Date.now();
      if (_fwCache.v && now - _fwCache.t < 1500) return _fwCache.v;
      var fw = [];
      var w = window;
      var pf = probeDomFrameworks();
      // React 18/19: fiber keys + legacy markers; extension-injected hooks don't count (present on any page)
      if (pf.react || w.React || document.querySelector('[data-reactroot]')) fw.push('react');
      if ((w.Vue && w.Vue.version) || w.__VUE_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-v-app]')) fw.push('vue');
      if (w.next || w.__NEXT_DATA__ || w.__next_f || document.getElementById('__next')) fw.push('next');
      if (pf.svelte) fw.push('svelte'); // Svelte 5 dev: elements always carry __svelte_meta (including deep elements under the mount container)
      _fwCache = { t: now, v: fw };
      return fw;
    }

    // ---------- Selection state machine (hover → step in/out → confirm) ----------
    function setHovered(el, mouseX, mouseY) {
      if (state.engaged) return; // after click-pause, hover is fully disabled (the toolbar stays put)
      if (state.hovered === el) return;
      clearOutline(state.hoverOutline);
      state.hovered = el;
      if (!el) return;
      // Don't hover viewport-filling containers (body/html/full-width layers) — a light-blue background covering the whole window looks like a mask (user: when inspect opens, a translucent light-blue veil covers all content)
      try {
        var _hr = el.getBoundingClientRect();
        var _hw = (document.documentElement && document.documentElement.clientWidth) || innerWidth;
        var _hh = (document.documentElement && document.documentElement.clientHeight) || innerHeight;
        if (_hr.width > _hw * 0.85 && _hr.height > _hh * 0.85) { state.hovered = null; return; }
      } catch (e) {}
      drawOutline(state.hoverOutline, el, OUTLINE_HOVER, '', 'HOVER'); // empty bg = no fill (avoids a translucent light-blue veil overlaying the page)
      // Low-frequency report (only when switching elements), for the host toolbar to display the current selection label
      var fl = fileLocation(el);
      var r = el.getBoundingClientRect();
      // Mouse coordinates (HUD/dialog center on the mouse position — not the element center)
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
          // Full framework (including react19Chunk/usedAtChunk): the hover payload also becomes lastSelfPayload → when confirmed and sent to the AI,
          // picksAddElement→resolveElLoc runs sourcemap resolution; without it, chunk URLs cannot be recovered into real source files
          framework: fl,
          frameworks: detectFrameworks(),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          mouseX: mx, mouseY: my, // mouse coordinates (the HUD centers on the mouse position)
          xpath: xpathOf(el), text: txt,
          bg: cs.backgroundColor, color: cs.color, fontSize: cs.fontSize,
        },
      });
    }

    // ---------- Simulated hover events (really dispatched so the page's JS hover logic runs and persists) ----------
    // Idea: the freezeEvent freeze matrix blocks mouseout/mouseleave (hover class) → the page never receives mouseleave,
    // so after "temporarily release hover-class interception → really dispatch the mouseover/mouseenter sequence → immediately re-block",
    // the page's JS (mouseenter-expanding tooltips/menus/animations etc.) actually runs, and the hover state persists because mouseleave stays frozen.
    var _hoverSimEl = null; // remembers the simulated hover target (mouseleave dispatched to it on exit to clear)
    function dispatchHoverEvents(el, enter) {
      if (!el) return;
      // 1. Temporarily release hover-class events (mouseout/mouseleave blocked by the freeze matrix) → dispatch → restore immediately (keeping the original released state)
      //    Release/restore only while the Inspector is active; after exit (exitInspector already ran uninstallFreeze) dispatch directly, avoiding re-installing the freeze
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
          // Match the real pointer-enter order: pointerover → pointerenter → mouseover → mouseenter (React and friends often listen to pointer and mouse both)
          if (window.PointerEvent) {
            try { el.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (e) {}
            try { el.dispatchEvent(new PointerEvent('pointerenter', noBubble)); } catch (e) {}
          }
          try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
          try { el.dispatchEvent(new MouseEvent('mouseenter', noBubble)); } catch (e) {}
        } else {
          // Exit: pointerout → pointerleave → mouseout → mouseleave (clears the page's JS hover state)
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
      // Switching targets: clear the previous simulated hover element first (no double hover)
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

    // Element payload returned on AI pick confirmation (tag/rect/selector/xpath/text/attributes/computed/framework/pageId/url)
    // — a complete picture for the AI: size/dimensions / styles / content / component source & location / calling code & location / page url / pageId (needed for MCP bridge operations)
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
      // viewport-coordinate rect (CDP click coordinates) + document-coordinate docRect (= rect + scroll, scroll-independent) + scroll (coordinate-system context note)
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
        // Page context: url/title + pageId (MCP bridge instanceId/frameId; null when the bridge isn't connected — filled in on the host side)
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

    // Ignore injected elements: the whole launcher tree (HUD/toolbar/fab/AI window/notice bar/dropdowns/panels/confirmation cards etc., closest #__dbg_launcher)
    //   + injected style tag (__dbg_launcher_css) + selection/hover outline boxes (fixed zIndex 2147483646) + SCRIPT/STYLE (including the injected client script)
    // Navigation (DOM tree/geometry) can land on them (body direct children #__dbg_launcher / outline div / the page's own scripts) — always skip (not visible content elements)
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

    // Text extraction: exclude aiti's own injected content (#__dbg_launcher is a direct child of body — html/body's innerText would include HUD/blocked-notice bar/fab/
    // toolbar UI text as page content, all of it visible to AI inspect). Subtractive implementation (cloneNode of a large page is too costly; unusable at hover frequency):
    //   take el's innerText → if the launcher is inside el (html/body and similar ancestors) subtract the launcher's own text (innerText is block-continuous, so it's a substring)
    function cleanTextOf(el, max) {
      if (isDbgEl(el)) return ''; // aiti's own element: no page text
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
    /** Strip aiti's own text from any string (Runtime.evaluate innerText-like results; page text that happens to contain the same substring is removed too — acceptable) */
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

    // Geometric neighbors: find the nearest visible element in the given direction on the page (left/right/up/down neighbor; skip injected elements)
    function neighborInDirection(el, dir) {
      var r = el.getBoundingClientRect();
      var best = null, bestScore = Infinity;
      var all = document.querySelectorAll('body *');
      for (var i = 0; i < all.length; i++) {
        var c = all[i];
        if (c === el) continue;
        if (isDbgEl(c)) continue; // ignore injected elements (launcher/HUD/outline boxes etc.)
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
      var cur = state.selected || state.hovered; // navigation (buttons/keys) happens in the locked state: selected takes priority; hovered as fallback
      if (isDbgEl(cur)) cur = null; // safety: the selection can never sit on an injected element (picking already excludes launcher UI); fallback for anomalies
      if (!cur) cur = document.body;
      var next = null;
      if (dir === 'up') { next = cur.parentElement; while (next && isDbgEl(next)) next = next.parentElement; if (!next) next = cur; } // parent (skipping the injection chain)
      else if (dir === 'down') { next = cur.firstElementChild; while (next && isDbgEl(next)) next = next.nextElementSibling; if (!next) next = cur; } // child (skipping injected elements)
      else if (dir === 'downOrNext') {                                                          // Enter: child first; no child → backtrack to next (DFS over the whole tree)
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
      // Same-level prev/next: walk siblings when they exist (skipping injected); at the level's start/end → step up a level (pressing again moves through the parent's siblings — fast navigation up the tree)
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
      else if (dir === 'first') { next = cur.firstElementChild; while (next && isDbgEl(next)) next = next.nextElementSibling; if (!next) next = cur; } // first (first DOM child, skipping injected)
      else if (dir === 'last') { next = cur.lastElementChild; while (next && isDbgEl(next)) next = next.previousElementSibling; if (!next) next = cur; } // last (last DOM child, skipping injected)
      else if (dir === 'leftN') next = neighborInDirection(cur, 'left') || cur;                 // page-left neighbor
      else if (dir === 'rightN') next = neighborInDirection(cur, 'right') || cur;               // page-right neighbor
      else if (dir === 'topN') next = neighborInDirection(cur, 'top') || cur;                   // page-above neighbor
      else if (dir === 'bottomN') next = neighborInDirection(cur, 'bottom') || cur;             // page-below neighbor
      if (!next) return;
      // Scroll into view after navigation: DOM-tree/geometry navigation may reach off-screen elements (invisible to the user) — scrollIntoView makes it visible
      // Dodge HUD/toolbar: element off-viewport or inside the bottom HUD/toolbar occlusion zone → scroll to center (clear of both);
      //   already in viewport (outside the occlusion zone) → nearest minimal scrolling (doesn't interrupt reading position)
      // Note: a host selection scrolls the host document, a target selection scrolls the target document (same client; scrollIntoView applies within each document)
      try {
        var _sv = window.visualViewport && window.visualViewport.height > 0 ? window.visualViewport.height : window.innerHeight;
        if (!_sv || _sv <= 0) _sv = 800;
        var _sr = next.getBoundingClientRect();
        var _reserve = 96; // estimated visual footprint of the bottom HUD/toolbar (HUD ~40-60px + spacing; HUD fixed to the bottom on small screens)
        if (_sr.top < 0 || _sr.bottom > _sv - _reserve) {
          try { next.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
          catch (e) { try { next.scrollIntoView(true); } catch (e2) {} }
        } else {
          next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        }
        // Fine-tune: still occluded by the bottom HUD after centering (tiny element / large HUD) → compensate upward
        try {
          var _r2 = next.getBoundingClientRect();
          var _vh2 = window.visualViewport && window.visualViewport.height > 0 ? window.visualViewport.height : window.innerHeight;
          if (_vh2 > 0 && _r2.bottom > _vh2 - 8) window.scrollBy({ top: _r2.bottom - (_vh2 - 8), behavior: 'smooth' });
        } catch (e) {}
      } catch (e) { try { next.scrollIntoView(true); } catch (e2) {} }
      // Navigation = selection move: with selected (locked/touch-picked) → update selected (toolbar follows, referenced by AI commands);
      // pure hover quick-select (no selected) → move hover (HUD follows, no locking — mouse movement still allows free quick-select)
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
          // xpath path: locate via document.evaluate
          var res = document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          el = res.singleNodeValue || null;
        } else {
          el = document.querySelector(s);
        }
      } catch (e) { el = null; }
      if (el) {
        setTouchSelection(el); // # select = select it (selected + highlight + toolbar shown); AI commands can reference it
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
      // Confirmed state: selected fixed (dashed outline), hover highlight cleared
      state.selected = el;
      clearOutline(state.hoverOutline);
      drawOutline(state.selOutline, el, OUTLINE_SEL, 'rgba(5,150,105,.08)', 'SEL');
      var _pl = serialize(el, { attrs: 1, xpath: 1, text: 1, computed: 1, framework: 1 });
      // React 19.2+: chunk location → async sourcemap resolution for exact source file+line; post after resolving (preview/open-file use real paths)
      var _fw = _pl && _pl.framework;
      if (_fw && (_fw.react19Chunk || _fw.usedAtChunk)) {
        resolveFrameworkLoc(_fw).then(function (fw) {
          if (fw && _pl) {
            _pl.framework = fw;
            _pl.file = fw.file; _pl.line = fw.line; _pl.usedAt = fw.usedAt; // sync to top level (the display layer prefers framework.file; keep consistent)
          }
          post({ type: 'dbg_element_selected', payload: _pl });
        });
        return;
      }
      post({ type: 'dbg_element_selected', payload: _pl });
    }

    // ---------- Page speed/blocking options (dbg_set_options; independent of the Inspector, persists after exit) ----------
    var OPT = { animSpeed: 1, blockScroll: false, blockWheel: false, slowTimers: 1, darkMode: false, reducedMotion: false, timeOffsetMs: 0, simulateTouch: false };
    var animObs = null;
    // Keep references to the original timer functions: internal scans aren't amplified by the slow-motion wrapper
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
      // Timer-based fallback (WAAPI animation creation doesn't trigger DOM changes); use the original setTimeout to avoid self-interference
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
      if (NET.delay > 0 || NET.offline) installNetSim(); // hijack only when needed
      emulateMedia();     // dark mode / reduced motion (matchMedia hijack)
      installTimeOffset(); // time offset (Date hijack; 0 restores)
      if (OPT.animSpeed !== prevAnim) {
        if (OPT.animSpeed === 1) { stopAnimWatch(); applyAnimSpeedOnce(); } // restore original speed
        else { applyAnimSpeedOnce(); startAnimWatch(); }
      }
      document[OPT.blockScroll ? 'addEventListener' : 'removeEventListener']('scroll', onScrollBlock, true);
      document[OPT.blockWheel ? 'addEventListener' : 'removeEventListener']('wheel', onWheelBlock, true);
      if (OPT.slowTimers !== 1) installTimerSlow(); else restoreTimerSlow();
    }

    // ---------- Network simulation (fetch/XHR hijack: delay/offline; mirrors CDP Network.emulateNetworkConditions) ----------
    var NET = { delay: 0, offline: false };
    var _origFetch = window.fetch;
    var _origXhrOpen = XMLHttpRequest.prototype.open;
    var _origXhrSend = XMLHttpRequest.prototype.send;
    var netSimInstalled = false;

    function installNetSim() {
      if (netSimInstalled) return;
      netSimInstalled = true;
      // fetch: reject immediately when offline; delay resolve when online
      window.fetch = function (input, init) {
        if (NET.offline) return Promise.reject(new TypeError('Failed to fetch（dbg 模拟离线）'));
        if (NET.delay > 0) {
          return _origFetch(input, init).then(function (res) {
            return new Promise(function (resolve) { _origSetTimeout(function () { resolve(res); }, NET.delay); });
          });
        }
        return _origFetch(input, init);
      };
      // XHR: delay send; trigger error when offline
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

    // ---------- Forced errors (validate the error collection/reporting chain + create error scenarios for the AI) ----------
    function forceError(kind) {
      var K = kind || 'sync';
      if (K === 'sync') _origSetTimeout(function () { throw new Error('[dbg] 强制同步异常 forced sync error'); }, 100);
      else if (K === 'promise') _origSetTimeout(function () { Promise.reject(new Error('[dbg] 强制未捕获 Promise 拒绝 forced unhandled rejection')); }, 100);
      else if (K === 'console') console.error('[dbg] 强制 console.error forced console error');
      else if (K === 'resource') {
        var img = new Image();
        img.src = '/__dbg_force_404__/' + Date.now() + '.png'; // 404 resource load failure
        document.body.appendChild(img);
      }
      return K;
    }

    // ---------- Error hook: capture page errors and report to host (dedup anti-storm, §7) ----------
    // Top-level dedup state (accessible across installErrorHook calls — window.__dbg.resetErrorDedup references it;
    // defined inside installErrorHook it would be out of scope and the call would throw a silently swallowed ReferenceError — cleanup verified ineffective that way)
    var errSeen = {};
    function resetErrDedup() { errSeen = {}; }
    function installErrorHook() {
      if (window.__dbgErrHook) return;
      window.__dbgErrHook = true;
      // Known benign browser error: the ResizeObserver loop (container resized again during the callback; the delayed notification converges)
      // is noise Chrome explicitly allows ignoring — occasional occurrences are normal when multiple extensions observe the same container (chat streaming / list height changes),
      // with no functional impact. Filter it out: no AI notification, no dedup slot, but keep it in the console ring (queryable via page_logs, tagged [benign]).
      var BENIGN_ERROR_RE = /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;
      function report(kind, msg, stack) {
        var text = String(msg);
        if (BENIGN_ERROR_RE.test(text)) {
          pushConsoleLog('error', '[benign] ' + text.slice(0, 300));
          return;
        }
        var key = text.slice(0, 80);
        if (errSeen[key]) return; // report the same message only once (until cleanup)
        errSeen[key] = 1;
        // Unified error queue: uncaught exceptions (uncaught/rejection/resource) are also merged into the console log ring buffer,
        // so AI messages (dbg_page_error) and page_logs queries read the same content.
        // console.error is excluded — installConsoleHook's console hook already enqueues it (level=error), avoiding duplicates.
        if (kind !== 'console.error') {
          var label = { error: 'uncaught', unhandledrejection: 'rejection', resource: 'resource' }[kind] || kind;
          pushConsoleLog('error', '[' + label + '] ' + String(msg).slice(0, 300));
        }
        post({ type: 'dbg_page_error', payload: { kind: kind, message: String(msg).slice(0, 300), stack: stack ? String(stack).slice(0, 500) : null } });
        // P3: page error events are no longer posted to the bridge directly from the page — they go through launcher → AI window (dbg_bridge_event) → BridgeClient, the same chain as other events
      }
      // Script execution errors (bubbling): same-origin reports the real message; cross-origin is masked by the browser as Script error. (best-effort supplement of filename/line/resource URL)
      window.addEventListener('error', function (e) {
        var msg = e.message;
        var meta = '';
        if (msg === 'Script error.') {
          // Cross-origin script: the real message is unavailable — append every locatable detail (the browser may still provide nothing; best effort)
          if (e.filename) meta += ' @ ' + e.filename + (e.lineno ? ':' + e.lineno + (e.colno ? ':' + e.colno : '') : '');
          var t = e.target;
          if (t && t.tagName) meta += (meta ? ' · ' : '') + '资源=' + (t.tagName + (t.src || t.href || t.currentSrc ? ' ' + String(t.src || t.href || t.currentSrc).slice(0, 200) : ''));
          if (meta) meta = '（跨源/加载失败被浏览器遮蔽' + meta + '；可检查页面脚本路径是否含部署前缀，如 /dev/）';
        }
        report('error', msg + meta, e.error && e.error.stack);
      });
      // Resource load failures (script/img/link 404 etc.): don't bubble, need capture-phase listening; e.target is the triggering element
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

    // ---------- Console log capture (plan F-1: full log/debug/info/warn/error → ring buffer → replay on bridge connect / real-time batching) ----------
    var CONSOLE_RING = [];   // {ts, level, text, count} (pre-connect buffer + replay on bridge connect)
    var consoleDropped = 0;
    var _consoleBatch = [];  // 100ms aggregation batch (≤10 entries)
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
      // consecutive identical entries (same text within <500ms) → merge into count
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
      // No more real-time reporting (plan F-3: data stays in the local buffer, pulled on demand by the page_logs tool)
      _consoleBatch.splice(0);
    }
    function installConsoleHook() {
      if (window.__dbgConsoleHook) return;
      window.__dbgConsoleHook = true;
      // Re-entrancy guard: fmtArg's JSON.stringify/String() triggers the argument object's getter/toString/Symbol.toPrimitive,
      // and a getter that logs (business proxies/lazy-load warnings etc.) re-enters this hook → synchronous infinite recursion → main-thread deadlock (page freeze).
      // On re-entry, skip capture and pass through only, cutting the recursion chain immediately.
      var _inHook = 0;
      _consoleLevels.forEach(function (lv) {
        _origConsoles[lv] = console[lv];
        console[lv] = function () {
          if (!_inHook) {
            _inHook = 1;
            try {
              var text = Array.prototype.map.call(arguments, fmtArg).join(' ').slice(0, 300);
              pushConsoleLog(lv, text);
            } catch (e) {} // even total formatting failure doesn't affect pass-through
            _inHook = 0;
          }
          _origConsoles[lv].apply(console, arguments); // pass through to the original console; page behavior unchanged
        };
      });
    }

    // ---------- Network observation (plan F-2: XHR/fetch completion capture; composition order with installNetSim doesn't matter) ----------
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
      // No more real-time reporting (plan F-3: data stays in the local buffer, pulled on demand by the page_network tool)
      _netBatch.splice(0);
    }
    function installNetObserver() {
      if (window.__dbgNetObserver) return;
      window.__dbgNetObserver = true;
      // XHR completion (captured by reference at install time — if netSim installed first the sim version gets wrapped; order doesn't matter)
      var _oOpen = XMLHttpRequest.prototype.open, _oSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__dbgNet = { m: m, u: String(u).slice(0, 300), t0: performance.now() }; return _oOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        var self = this, net = this.__dbgNet || { m: '', u: '', t0: performance.now() };
        ['load', 'error', 'abort', 'timeout'].forEach(function (ev) {
          self.addEventListener(ev, function () {
            // Exclude dbg's own requests (bridge reporting/extension resources — otherwise a self-exciting capture → report → new request → capture loop)
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
      // fetch completion
      var _of = window.fetch;
      window.fetch = function (input, init) {
        var _m = (init && init.method) || (input && input.method) || 'GET';
        var _u = String((input && input.url) || input).slice(0, 300);
        return _of.apply(this, arguments).then(function (res) {
          // Exclude dbg's own requests (prevents a self-exciting loop)
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


    // ---------- Scenario simulation: environment (matchMedia hijack) + time offset (Date hijack) ----------
    var _origMatchMedia = window.matchMedia;
    var _origDate = window.Date;

    function emulateMedia() {
      // Dark mode/reduced motion: JS-side checks (matchMedia.matches) can be simulated; pure CSS media queries cannot be forced (P1 falls back to injected styles)
      window.matchMedia = function (query) {
        var m = _origMatchMedia(query);
        var q = String(query);
        var fake = null;
        if (OPT.darkMode && q.indexOf('prefers-color-scheme') >= 0) fake = q.indexOf('dark') >= 0;
        if (OPT.reducedMotion && q.indexOf('prefers-reduced-motion') >= 0) fake = q.indexOf('reduce') >= 0;
        if (OPT.simulateTouch && (q.indexOf('pointer') >= 0 || q.indexOf('hover') >= 0)) {
          // Simulated touch: pointer:coarse / any-pointer:coarse / hover:none / any-hover:none
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
      // Dark mode: color-scheme affects form control/scrollbar rendering
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
          if (!(this instanceof DbgDate)) return new OrigDate(OrigDate.now() + offset).toString(); // Date() call form
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

    // ---------- MCP bridge: zero direct page-to-bridge connection (design decision) ----------
    // All bridge communication is centralized in the AI window (cockpit / pi-web aiti extension client): launcher hands page events
    // (page_log/page_network/page_error/open_file/user_answer…) to the AI window via postToAi; its BridgeClient.postEvent reports to the bridge.
    // Historical direct-to-bridge client code (mcpConnect/claim/SSE/postBridge*) has been removed — a legacy of the direct form, never triggered in any mode.

    // ---------- Event freeze → upgraded to "lock + event release matrix" ----------
    // Everything locked by default (the page receives no interaction events, keeping popup layers intact); temporary release per category (click/key/wheel/scroll/hover/touch/focus),
    // auto re-lock on expiry or sustained until manually locked; ✓ confirm available in any state
    var FROZEN_CATEGORIES = {
      click: ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu'],
      key: ['keydown', 'keyup'],
      wheel: ['wheel'],
      scroll: ['scroll'],
      hover: ['mouseout', 'mouseleave'],
      touch: ['touchstart', 'touchmove', 'touchend'],
      focus: ['focusin', 'focusout'],
    };
    var aiPick = false;    // AI window pick mode: clicks return the element (dbg_ai_picked); continuous picking, no dialog / no pause
    var passClick = false; // real click pass-through: release one click so page interaction happens (e.g. opening a button menu)
    var inspectorMode = 'mouse'; // 'mouse' (hover + click confirm) | 'touch' (click = move selection, ✓ to confirm)
    var released = {};         // category -> until(ts) | Infinity
    var _frozenEvents = [];
    var _releaseTimers = {};
    var _blockReported = {};   // category → ts (blocked-notice debounce: same category notified once per 2.5s)

    function allFrozenEvents() {
      var list = [];
      Object.keys(FROZEN_CATEGORIES).forEach(function (cat) {
        if (released[cat]) return;
        FROZEN_CATEGORIES[cat].forEach(function (t) { if (list.indexOf(t) < 0) list.push(t); });
      });
      return list;
    }
    function freezeEvent(e) {
      // self mode (injected into the host page itself): launcher UI (#__dbg_launcher) released, toolbar always usable; all other page elements are pickable
      if (e.target && e.target.closest && e.target.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) return;
      // Freeze only the left mouse button (click frozen); right/middle buttons released (page context menu / middle-click behavior stays normal)
      if (e.button && e.button !== 0) return;
      // aiti's own keyboard features (Esc exits the Inspector / arrow keys navigate the selection) take precedence over event freezing — defensive special case:
      // keydown freezing would also block our own Esc handlers registered on document/window bubble (freezeEvent runs on
      // window capture + stopImmediatePropagation), causing "Esc can't exit + a false 'keydown blocked' notice".
      // The normal path is the keyboard capture listener (onKey, registered before this function) taking over first and calling stopImmediatePropagation;
      // this special case guarantees Esc is never frozen and never triggers a blocked notice under any registration order (the event can bubble to the host hostKey for exit).
      if (e.type === 'keydown' && e.key === 'Escape') return;
      // Last runner in the capture phase: no other page listeners receive the event
      e.stopImmediatePropagation();
      if (e.cancelable) e.preventDefault();
      // Blocked notice: frozen page interactions → notify the host's bottom notice (categories match the release-profile dimensions: click/hover/key/wheel/scroll/touch/focus)
      reportBlocked(e);
    }
    /** Blocked-notice report: reverse-look-up the event category (same source as FROZEN_CATEGORIES), debounce, then post for the host to show the notice bar */
    function reportBlocked(e) {
      var cat = null;
      for (var c in FROZEN_CATEGORIES) {
        if (FROZEN_CATEGORIES[c].indexOf(e.type) >= 0) { cat = c; break; }
      }
      if (!cat) return;
      var now = Date.now();
      if (_blockReported[cat] && now - _blockReported[cat] < 2500) return;
      _blockReported[cat] = now;
      // Blocked-point coordinates (only mouse/touch events have them; keyboard/scroll/focus pass null):
      // the host notice bar dodges accordingly — a block in the lower half of the viewport moves the notice to the upper half, and vice versa
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
      ensureUiMousedownGuard(); // launcher UI mousedown guard (independent of release profiles, see uiMousedownGuard)
    }
    function uninstallFreeze() {
      _frozenEvents.forEach(function (t) { window.removeEventListener(t, freezeEvent, true); });
      _frozenEvents = [];
      removeUiMousedownGuard();
    }
    // Launcher UI mousedown guard: page menus/editors (e.g. session-manager tab rename) close via
    // document **capture-phase** mousedown listeners (close on outside click). Release profiles
    // (especially full-release) must not let launcher's own UI trigger those listeners: mousedown is
    // always stopped (stopImmediatePropagation) so page capture listeners never see it -> clicking a
    // toolbar release button does not close the page menu that just opened (verified).
    // Bound on window capture phase (runs before document, independent of registration order).
    // stopImmediatePropagation applies unconditionally inside launcher UI; preventDefault applies only
    // while click interception is active (see below). Launcher inputs are exempt (they need focus);
    // AI window/fab/toolbar drags use pointerdown and are unaffected.
    var _uiMouseBound = false;
    function uiMousedownGuard(e) {
      if (!(e.target && e.target.closest && e.target.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings'))) return;
      if (e.target.closest && e.target.closest('input, textarea, select')) return; // inputs: let through (need focus)
      e.stopImmediatePropagation(); // keep page close-on-outside-click listeners off (kept for inspect AND release profiles)
      // preventDefault only while Inspector click interception is actually active (state.active, click not
      // released): protects launcher UI from being picked as the inspect target + keeps page input focus.
      // Release profiles (released.click) / inactive state must not touch the default behavior -- panel
      // bodies need to stay selectable and button clicks need to focus the document (Clipboard API /
      // execCommand both require it; unconditional preventDefault kills selection + copy, verified).
      if (state.active && !released.click && e.cancelable) e.preventDefault();
    }
    function ensureUiMousedownGuard() { if (!_uiMouseBound) { _uiMouseBound = true; window.addEventListener('mousedown', uiMousedownGuard, true); } }
    function removeUiMousedownGuard() { if (_uiMouseBound) { _uiMouseBound = false; window.removeEventListener('mousedown', uiMousedownGuard, true); } }
    /** Release a set of event categories: durationMs>0 re-locks on a timer; 0/Infinity stays released until manually locked */
    function releaseEvents(categories, durationMs) {
      var now = Date.now();
      (categories || []).forEach(function (cat) {
        if (FROZEN_CATEGORIES[cat]) released[cat] = (durationMs > 0) ? now + durationMs : Infinity;
      });
      installFreeze();
      if (durationMs > 0) {
        var until = now + durationMs;
        var key = (categories || []).slice().sort().join('+');
        if (_releaseTimers[key]) clearTimeout(_releaseTimers[key]); // clearTimeout's id is unchanged, no wrapping needed
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
    /** Release profile: set in one shot (release array = the released categories, everything else frozen) — the default profile is set by enterInspector */
    function applyProfile(pf) {
      released = {};
      var rel = (pf && pf.release) || [];
      for (var i = 0; i < rel.length; i++) {
        if (FROZEN_CATEGORIES[rel[i]]) released[rel[i]] = Infinity;
      }
      installFreeze();
      return { name: pf && pf.name, released: Object.keys(released) };
    }
    /** Single-category toggle: enabled=true sustains release, false freezes immediately (user-controlled state, not temporary) */
    function toggleEvent(category, enabled) {
      if (!FROZEN_CATEGORIES[category]) return { error: 'unknown category: ' + category };
      if (enabled) released[category] = Infinity;
      else delete released[category];
      installFreeze();
      return { category: category, released: !!released[category] };
    }

    // ---------- Events ----------
    var lastMoveX = 0, lastMoveY = 0;
    var _touchBlockHoverUntil = 0; // suppress hover for a while after touch taps (tap-synthesized mouseover would draw the blue outline)
    var _realMouseEver = false; // whether a real mouse move has been seen (isTrusted with movement>0) — tap-synthesized mouseover (movement=0) must not trigger hover
    var _onTouch = function () { _touchBlockHoverUntil = Date.now() + 800; };
    document.addEventListener('touchstart', _onTouch, true);
    document.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch') _onTouch(); }, true);
    function onOver(e) {
      if (state.active && inspectorMode === 'mouse' && !state.engaged) {
        // Suppress hover after touch taps: real-device taps synthesize mouseover (even when isTouchDevice under-reports) → a blue outline covering the whole window
        if (Date.now() < _touchBlockHoverUntil) return;
        // real-device tap-synthesized mouseover (isTrusted=true, no real mouse movement) must not trigger hover; self-check dispatch (isTrusted=false) passes through
        if (e.isTrusted !== false && !_realMouseEver) return;
        var t = e.target;
        if (!t || t === document.body || t === document.documentElement) return; // don't hover body/html containers (viewport-filling → a light-blue background covering the whole window)
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
    // Disabled elements don't dispatch click (HTML spec), so the Inspector's window-capture click (onClick) never sees them →
    // clicking a disabled button (e.g. aiti-prompts' "new group" confirm button, initially disabled) neither selects nor pops the HUD.
    // Add a pointerdown capture check: target itself disabled / aria-disabled / inside fieldset[disabled] → treat as a click selection
    // (same semantics as onClick: freeze page interaction, enter/move the selection, return the AI pick). pointerdown covers desktop and touch alike.
    function isDisabledEl(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.disabled === true) return true; // native disabled on button/input/textarea/select
      var a = el.getAttribute && el.getAttribute('aria-disabled');
      if (a && a !== 'false' && a !== '') return true;
      try { if (el.closest && el.closest('fieldset[disabled]')) return true; } catch (e) {} // fieldset[disabled] disables every form control inside it
      return false;
    }
    function onPickDisabled(e) {
      if (!state.active) return;
      if (e.button && e.button !== 0) return; // left button
      var t = e.target;
      if (!t || t.nodeType !== 1) return;
      if (t.closest && t.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) return; // launcher UI released
      if (released.click) return; // click already released (release profile): hand it to the page, don't intercept pointerdown
      if (!isDisabledEl(t)) return; // handle disabled elements only (enabled ones take the normal click path)
      e.preventDefault();
      e.stopImmediatePropagation(); // runs before freezeEvent (enterInspector registered first): no "frozen" blocked notice
      if (aiPick) {
        state.engaged = true;
        setTouchSelection(t, e.clientX, e.clientY);
        return;
      }
      if (inspectorMode === 'touch' || state.engaged) {
        if (state.engaged && state.selected === t) { // clicking the same selected disabled element → toggle back to quick-select (consistent with onClick)
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
      // Intercept only the left mouse button (button=0): right (contextmenu) / middle (auxclick) released to the page (page context menu / middle-click behavior stays normal)
      if (e.button && e.button !== 0) return;
      // self mode: clicks on launcher UI (fab/AI window/toolbar/panels) are released, not selected; all other page elements (including control buttons) are pickable
      if (e.target && e.target.closest && e.target.closest('#__dbg_launcher, .dbg-fab, .dbg-toolbar, .dbg-speed, .dbg-dialog, .dbg-extreme-menu, .dbg-profile-menu, .dbg-tooltip, .dbg-sel-input-row, .dbg-ai-detail-mask, .dbg-ai-win, .dbg-overlay, .dbg-settings')) return;
      // click already released (event release switch): hand clicks to the page (buttons interactive), no selection; notify the host to hide the HUD —
      // menus/popups pop up right at the click point; a visible HUD (from the pointer-events:auto era) would cover and block interactions beneath it (user-verified: menu items couldn't be selected)
      if (released.click) { post({ type: 'dbg_click_released', payload: {} }); return; }
      if (passClick) {
        // Real click pass-through: release this click (page menu-opening logic runs normally), restore the freeze shortly after
        passClick = false;
        post({ type: 'dbg_click_released', payload: {} });
        setTimeout(function () { installFreeze(); }, 600);
        return;
      }
      e.preventDefault(); e.stopImmediatePropagation();
      if (aiPick) {
        // AI window pick: click = same as the external Inspector — enter temporary selection (toolbar pops up following the selection, fine-tunable); only ✓ returns to the AI window
        state.engaged = true;
        setTouchSelection(e.target, e.clientX, e.clientY);
        return;
      }
      if (inspectorMode === 'touch' || state.engaged) {
        // Clicking the same element while selected → back to quick-select (toggle: selected ↔ quick-select)
        if (state.engaged && state.selected === e.target) {
          state.engaged = false;
          state.selected = null;
          clearOutline(state.selOutline);
          state.hovered = null;
          setHovered(e.target); // restore hover highlight + HUD
          post({ type: 'dbg_element_hover_refresh', payload: null });
          return;
        }
        setTouchSelection(e.target, e.clientX, e.clientY); // touch / already in the temporary state: click = move selection (no dialog, ✓ to confirm)
      } else {
        // Large-screen first click: enter the temporary selection state (no dialog immediately), hover disabled, toolbar kept, further adjustment possible
        state.engaged = true;
        setTouchSelection(e.target, e.clientX, e.clientY);
      }
    }
    function onScroll() { if (state.hovered && !state.engaged) setHovered(state.hovered); } // after engaged, scrolling no longer re-posts hover

    // Touch selection: click/step updates selected directly (highlight dashed outline), returns a lightweight label update, no dialog
    function setTouchSelection(el, mX, mY) {
      if (!el) return;
      state.selected = el;
      state.hovered = el; // sync hovered: later steps (Enter/navigation) build on the latest selection
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
          // Full framework (including react19Chunk/usedAtChunk): the touch selection also becomes lastSelfPayload → when confirmed and sent to the AI,
          // picksAddElement→resolveElLoc runs sourcemap resolution; without it, chunk URLs cannot be recovered into real source files (mandatory on touch devices)
          framework: fl,
          frameworks: detectFrameworks(),
          touchMode: true, engaged: true, // click-paused: toolbar shown
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
      resetErrorDedup: function () { try { resetErrDedup(); } catch (e) {} }, // cleared when the AI window opens → the same message reports again on its next occurrence
      enterInspector: function (mode) {
        if (state.active && inspectorMode === (mode || 'mouse')) return; // idempotent
        if (state.active) window.__dbg.exitInspector(); // mode switch: exit first, then enter
        state.active = true;
        inspectorMode = mode || 'mouse';
        passClick = false;
        // By default release events that don't affect Inspector picking (page interaction stays normal: scroll/keyboard/touch/focus); lock only click/hover (prevents accidental picks + popup layers disappearing)
        released = {};
        ['key', 'wheel', 'scroll', 'touch', 'focus'].forEach(function (c) { released[c] = Infinity; });
        if (inspectorMode === 'touch') released.touch = Infinity; // touch: release touch (taps need to synthesize click for "click = move selection")
        if (inspectorMode === 'mouse') window.addEventListener('mouseover', onOver, true);
        window.addEventListener('mousemove', onMouseMove, true);
        window.addEventListener('pointerdown', onPickDisabled, true); // disabled elements don't dispatch click; pointerdown provides picking (registered before installFreeze)
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
        uninstallFreeze(); // unfreeze
        released = {};
        clearOutline(state.hoverOutline);
        clearOutline(state.selOutline); // clear all selection outlines on exit (no leftover blue boxes)
        // Fallback: sweep every leftover selection outline div off the page (cleans up even when references are lost / on anomalies)
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
        try { simulateHoverOff(); } catch (e) {} // Inspector exit: dispatch mouseleave to the simulated hover target to clear the persistent state
      },
      simulateHover: simulateHover, // really dispatches mouseover/mouseenter (page JS hover logic runs and persists)
      simulateHoverOff: simulateHoverOff,
      fileLocation: fileLocation,
      serialize: serialize,
      detectFrameworks: detectFrameworks,
      // Turbopack chunk location → source file (sourcemap, async): completes real source file paths for launcher candidates/picks (same source as resolveFrameworkLoc)
      resolveChunkSource: resolveChunkSource,
      // Component name → source file (no chunk location when the budget is exhausted; scan sourcemap sourcesContent by component name; async, lazily built + cached)
      resolveComponentFile: resolveComponentFile,
      // Component fn toString → locate chunk line → sourcemap exact source file+line (budget-exhausted fallback for real line numbers)
      resolveFnLine: resolveFnLine,
      setOptions: applyOptions, // page speed/blocking options (animation slowdown / event blocking / timer slow-motion)
      resumeHover: function () {
        // Resume quick-select: leave the temporary selection state (hover highlight re-enabled, selection kept for further click toggling)
        state.engaged = false;
        return { engaged: state.engaged };
      },
      pauseHover: function () {
        // Pause picking: equivalent to click-entering the temporary state (hover disabled, hover highlight cleared, selection kept) — triggered automatically when the mouse enters the toolbar
        state.engaged = true;
        clearOutline(state.hoverOutline);
        state.hovered = null;
        return { engaged: true };
      },
      applyProfile: applyProfile, // release profile (toolbar mode switching / speed panel management)
      // Current selection payload (for the AI confirm return); __state is debug-only — it must hang on window.__dbg (it was previously misplaced in the CDP.DOM table, which made
      // ensureClientFresh's idempotency check on getSelectionPayload fail → re-injection on every enterInspector → stale message listeners left behind →
      // dbg_exec handled first by the stale (empty-state) client, returning null (root cause of self-checks ⑤⑫ failing))
      getSelectionPayload: function () { var el = state.selected || state.hovered; return el ? aiPickPayload(el) : null; },
      __state: function () { return { active: state.active, engaged: state.engaged, hasOver: true, hasClick: true }; },
      // Local buffer exposure (plan F-3: page_logs/page_network tools pull on demand via CDP Runtime.evaluate; no more real-time reporting)
      __consoleRing: CONSOLE_RING,
      __netRing: NET_RING,
    };

    // ---------- Writing editable elements: React-compatible "real typing" (equivalent to CDP Input.insertText) ----------
    // contenteditable (rich text / <p> editable blocks) → focus + caret positioning + document.execCommand('insertText')
    //   the browser's native input path fires real beforeinput/input (inputType=insertText); React onChange receives it correctly and the value isn't reset
    // input/textarea → native prototype value setter (syncs React's controlled value tracker) + input/change
    // select → set value + change; replace=true clears existing content then writes (setValue/type semantics), false inserts at the caret only (insertText semantics)
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

    // ---------- CDP-like command set (browser-side equivalents; all pure, serializable functions) ----------
    // Naming aligned to CDP domains: DOM / CSS / Input / Page / Runtime / Storage / Performance
    var EXCLUDED_PROPS = {
      constructor: 1, '__proto__': 1, 'prototype': 1, 'innerHTML': 1, 'outerHTML': 1,
      'hasOwnProperty': 1, 'isPrototypeOf': 1, 'propertyIsEnumerable': 1, 'toString': 1,
      'valueOf': 1, 'toLocaleString': 1, 'onclick': 1, 'onmouseover': 1, 'onload': 1,
    };
    var evalEnabled = true; // enabled by default within the debug session (equivalent to the user evaluating in Console themselves); can be turned off in the panel; backed by the dbgToken auth boundary + eval audit logs

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
      return (el && isDbgEl(el)) ? null : el; // aiti's own elements are not addressable (inspect/operations exclude its own UI)
    }

    function treeSummary(node, depth) {
      if (!node || depth <= 0) return null;
      if (isDbgEl(node)) return null; // exclude aiti's own injected content (whole launcher tree / outline boxes / styles)
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
            if (isDbgEl(els[i])) continue; // exclude aiti's own content (whole launcher tree / outline boxes / styles)
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
            try { rules = ss.cssRules || ss.rules; } catch (e) { continue; } // cross-origin stylesheet
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
        // Aligns with CDP Input.insertText: insert text at the caret (doesn't replace existing content) — works for React controlled inputs / rich text
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
        // Screenshot: direct path (no gesture card) fallback — works when activation exists (Chrome desktop),
        // otherwise the browser rejects → point to the AI window gesture-card path (launcher danger.js's same-named implementation shows a user confirmation)
        captureScreenshot: function () {
          // The old getDisplayMedia direct screenshot path is retired — the launcher screenshot-card flow handles it uniformly (see danger.js)
          return Promise.resolve({ error: 'Page.captureScreenshot 已由 launcher 截屏卡接管（意图说明→调整页面→预览确认），此直连路径已停用' });
        },
        // Page frame tree (nested iframes): same-origin can read title/url/readyState; cross-origin only iframe element attributes (src/name)
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
          // contextId: execute inside an iframe context (same-origin — the iframe index starts at 1; cross-origin returns an error). Top level: omit or 0.
          var targetWin = null;
          if (args && args.contextId) {
            var _ifrs = document.querySelectorAll('iframe, frame');
            var _idx = Number(args.contextId) - 1;
            if (_idx < 0 || _idx >= _ifrs.length) return { error: 'contextId ' + args.contextId + ' 越界（共 ' + _ifrs.length + ' 个 iframe；contextId 从 1 开始）' };
            targetWin = _ifrs[_idx].contentWindow;
          }
          try {
            var val = targetWin ? targetWin.eval(String(args.expression)) : eval(String(args.expression));
            // awaitPromise (MCP standard): if the result is a Promise → wait for the final value (async handler; the host already supports Promise returns)
            if (args && args.awaitPromise && val && typeof val.then === 'function') {
              return val.then(function (v) {
                var out = { type: typeof v, value: (typeof v === 'string' ? stripAitiText(v).slice(0, 2000) : v), awaited: true };
                post({ type: 'dbg_eval_log', payload: { expression: String(args.expression).slice(0, 200), result: JSON.stringify(out).slice(0, 300), ts: new Date().toISOString() } });
                return out;
              }).catch(function (e) { return { error: String((e && e.message) || e) }; });
            }
            // No awaitPromise and the result is a Promise: cannot return it directly (postMessage structured clone throws on Promises → result lost → bridge timeout)
            if (val && typeof val.then === 'function') {
              return { type: 'promise', isPromise: true, value: 'Promise（如需最终结果传 awaitPromise: true）' };
            }
            var out = { type: typeof val, value: (typeof val === 'string' ? stripAitiText(val).slice(0, 2000) : val) };
            // eval audit: expression + result summary reported to the host panel (user-visible)
            post({ type: 'dbg_eval_log', payload: { expression: String(args.expression).slice(0, 200), result: JSON.stringify(out).slice(0, 300), ts: new Date().toISOString() } });
            return out;
          } catch (e) { return { error: String((e && e.message) || e) }; }
        },
        setEvalEnabled: function (args) { evalEnabled = !!(args && args.enabled); return { evalEnabled: evalEnabled }; },
        fetch: function (args) {
          // Send the JS request in the target page's context (same-origin, no CORS; affected by network simulation, preserving scenario fidelity)
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
      // Browser-restricted operations (clipboard/download/popup/fullscreen/play): programmatic execution gets blocked by the browser and needs a real user click (gesture bridge)
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
        // The following three mirror the host gesture cards (launcher danger.js): here only the direct-path fallback — most get rejected without activation,
        // the error text guides a retry (the path forwarded via the AI window shows a confirmation card that executes after the user confirms)
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

    // Legacy command aliases (backward compatibility)
    var CMD_ALIASES = {
      getInfo: 'DOM.querySelector',
      highlight: 'DOM.querySelector',
      scrollIntoView: 'Page.scrollIntoView',
    };

    // ---------- Host command channel (including AI-forwarded dbg_exec; all async round-trips) ----------
    // Keyboard navigation (intercepted only in the locked/engaged state): forwarded to host for unified handling (host calls doNav → postToTarget dbg_step)
    var NAV_KEYS = {
      ArrowUp: 'topN', ArrowDown: 'bottomN', ArrowLeft: 'leftN', ArrowRight: 'rightN',
      PageUp: 'prev', PageDown: 'next', Home: 'first', End: 'last',
      Backspace: 'up', Delete: 'up', Enter: 'downOrNext',
    };
    // Keyboard takeover (Esc exit / arrow-key selection navigation): must be capture-phase and registered before freezeEvent —
    // freezeEvent (window capture; installFreeze re-registers on enterInspector, after this listener) would
    // freeze keydown via stopImmediatePropagation; bubble-phase listeners (including the host document hostKey) would never receive it,
    // causing "Esc exit never works + a false 'keydown blocked' notice". This capture listener runs first (registered earlier than freezeEvent)
    // + stopImmediatePropagation → freezeEvent never sees it: the page isn't frozen and no blocked notice is shown.
    // It also removes the double Esc/navigation handling between hostKey (document bubble) and this page's listener (window bubble) under the default release profile.
    window.addEventListener('keydown', function (e) {
      if (!state.active) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      var k = e.key;
      if (k === 'Escape') {
        // Inside the Inspector, Esc always exits (the hint reads "Esc exits"): when keyboard focus is in the target iframe the host document never receives
        // keydown, so the client forwards to host for a unified exit — the quick-select state is taken over the same way (otherwise Esc does nothing while the iframe has focus and the Inspector can't be exited)
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        if (aiPick) post({ type: 'dbg_ai_escape', payload: {} });
        else post({ type: 'dbg_inspect_escape', payload: {} });
        return;
      }
      var dir = NAV_KEYS[k];
      if (!dir) return;
      // Navigation takes precedence over page scrolling: intercept arrow keys while the Inspector is active and a selection exists (locked or hover quick-select/HUD shown);
      // no selection (mouse not on a page element) → don't intercept — page scrolling / the page's own keyboard behavior stays normal
      if (!state.engaged && !state.hovered) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      // Execute directly (no host round-trip wait — stepSelection inside the target is fastest)
      stepSelection(dir);
      // Also forward to host (the host can sync toolbar label/HUD/selection state)
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
          // Real click pass-through: release one click (unfreeze click first so the page can open menus), then restore the freeze
          passClick = true;
          window.removeEventListener('click', freezeEvent, true);
          setTimeout(function () { if (state.active) window.addEventListener('click', freezeEvent, true); }, 600);
          break;
        case 'dbg_release_events':
          // Event release matrix: temporarily release a set of event categories (click/key/wheel/scroll/hover/touch/focus); auto re-lock on expiry
          releaseEvents((m.payload && m.payload.categories) || [], (m.payload && m.payload.durationMs) || 0);
          break;
        case 'dbg_lock_events':
          lockEvents(); // lock everything back immediately
          break;
        case 'dbg_toggle_event':
          toggleEvent(m.payload && m.payload.category, m.payload && m.payload.enabled);
          break;
        case 'dbg_resume_hover':
          window.__dbg.resumeHover();
          break;
        case 'dbg_ai_pick':
          aiPick = !!(m.payload && m.payload.active); // onClick/hover are provided by the host entering the Inspector
          break;
        case 'dbg_pause_hover':
          window.__dbg.pauseHover();
          break;
        case 'dbg_set_profile':
          applyProfile(m.payload && m.payload.profile);
          break;
        case 'dbg_cancel': {
          // Cancel selection: clear selected + leave the temporary state + clear highlights (toolbar kept for further picking)
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
          // AI pick confirm: return the current selection to the AI window (accumulated pending send) + resume hover (continue picking the next element)
          var aiEl = state.selected || state.hovered;
          if (aiEl) {
            var _ap = aiPickPayload(aiEl);
            // React 19.2+: chunk location → resolve the real source file+line via sourcemap asynchronously before returning (AI window details/candidates show real paths,
            // not directory-aggregated chunk URLs — names like components_03gcaqz._.js cannot be decoded; sourcemap recovery is required)
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
          // Resume hover quick-select (toolbar hidden + host hover restored) — clear first to avoid setHovered short-circuiting on the same element
          state.hovered = null;
          setHovered(aiEl);
          break;
        }
        case 'dbg_key_nav': {
          // Keyboard navigation forwarded by the client — syncs toolbar label / selection state
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
              // Supports async handlers (e.g. Runtime.fetch): Promise results are returned asynchronously
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
    installErrorHook(); // error hook active immediately on injection (reports to host)
    installConsoleHook(); // full console capture (plan F-1: early log buffering + replay on bridge connect)
    installNetObserver(); // network completion capture (plan F-2: XHR/fetch)
  })();
