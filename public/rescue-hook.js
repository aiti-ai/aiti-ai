/* Rescue hook — auto-redirect to the rescue page on dev build errors (crash-rescue scenario 3)
 *
 * Trigger condition (the only one): the dev overlay (<nextjs-portal>) appears and its content is a
 * Build Error (a compile-time error such as "Export xxx doesn't exist in target module"). These
 * errors happen before the React tree exists, so global-error.tsx (a render-time boundary) cannot
 * structurally catch them; the rescue exit is /rescue.html (a static page in public/, outside the
 * compile graph).
 *
 * Injection paths (double coverage, idempotent):
 *  ① the app's layout.tsx always loads <script src="/rescue-hook.js" async> — covers the
 *     "page already open, HMR pushes a compile error" scenario (any access path, including direct
 *     port access);
 *  ② nginx /dev location sub_filter injection — covers "fresh load after the build breaks": the
 *     500 error page does not include our layout (the module graph is broken), so only nginx can
 *     inject this hook.
 *
 * Behavior: banner + 30s countdown auto-redirect to /rescue.html?err=<error text>; clicking the
 * button goes immediately or stays on this page; when the overlay disappears (= the AI fixed it,
 * HMR recovered) the banner is withdrawn and the countdown canceled.
 * Event-driven (MutationObserver), zero polling; prod has no dev overlay, so this script is
 * naturally inert. Manual entry (when the hook is absent): visit /dev/rescue.html directly.
 */
(function () {
  "use strict";
  if (window.__aitiRescueHook) return;
  window.__aitiRescueHook = true;

  if (/\/rescue\.html$/.test(location.pathname)) return; // do not inject into the rescue page itself

  // base: /dev/xxx → /dev; /xxx → "" (prod has no basePath)
  var BASE = /^\/dev(?=\/|$)/.test(location.pathname) ? "/dev" : location.pathname.replace(/\/[^\/]*$/, "");

  var COUNTDOWN = 30; // seconds; leaves room for the transient "AI is editing files, fix is imminent" state
  var banner = null, timer = null, left = 0;
  // Persistent memory of "stay on this page": once dismissed, the same error never pops back up
  // (otherwise any DOM change while the overlay is present runs check() → showBanner and the
  // banner immediately returns = effectively unclosable; reported 2026-09-08).
  // Reset when the overlay disappears (error fixed), so the next new error alerts as usual.
  var dismissedErr = null;
  // note: the original top-level RE_BUILD_ERROR variable declaration was removed — it was never
  // referenced by the check flow (matchLine's patterns are what actually gets used)

  // ---- self-contained i18n (en / zh-CN) ----
  // Injected script that must work when the app is broken: inline string table + local locale
  // detection (navigator.language, any zh-* → zh-CN copy); no external i18n assets. T() picks
  // from the dict at call time.
  var STRINGS = {
    en: {
      bannerTitle: "🚑 dev build error — rescue page available",
      stayTooltip: "Stay on this page (this error will not warn again)",
      goRescueBtn: "Go to rescue page",
      stayPage: "Stay on this page",
      countdownSuffix: "s until auto-enter",
      buildErrorFallback: "Build Error (see dev overlay)",
    },
    "zh-CN": {
      bannerTitle: "🚑 dev 编译错误 — 急救页可用",
      stayTooltip: "留在本页（同一条错误不再提醒）",
      goRescueBtn: "进入急救页",
      stayPage: "留在本页",
      countdownSuffix: "s 后自动进入",
      buildErrorFallback: "Build Error（详情见 dev overlay）",
    },
  };
  function T() {
    return STRINGS[(navigator.language || "en").toLowerCase().startsWith("zh") ? "zh-CN" : "en"];
  }

  function removeBanner() {
    if (timer) { clearInterval(timer); timer = null; }
    if (banner) { banner.remove(); banner = null; }
  }

  function goRescue(errText) {
    location.replace(BASE + "/rescue.html?err=" + encodeURIComponent(errText || T().buildErrorFallback));
  }

  function showBanner(errText) {
    if (dismissedErr === errText) return; // user already chose "stay on this page" for this error; do not nag again
    if (banner) {
      // Write only on change: assigning textContent produces a childList mutation even when the
      // value is identical, which re-triggers the light observer below → check() → showBanner →
      // infinite loop locking up the page (hit for real in E2E)
      if (banner._err.textContent !== errText) banner._err.textContent = errText;
      return;
    }
    // Compact card in the top-right corner, not spanning the bottom edge (the previous
    // left:12px;right:12px full-width bottom bar covered the Next.js dev overlay's bottom-left
    // toolbar buttons; reported 2026-09-08); the title bar is draggable.
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;top:12px;right:12px;width:440px;max-width:calc(100vw - 24px);z-index:2147483647;" +
      "background:#1a1a1a;color:#e8e8e8;border:1px solid #f59e0b;border-radius:10px;" +
      "padding:12px 14px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);";
    var title = document.createElement("div");
    title.style.cssText = "font-weight:700;color:#f59e0b;margin-bottom:4px;cursor:move;user-select:none;display:flex;align-items:center;";
    title.textContent = T().bannerTitle;
    // Title-bar dragging (title bar = drag handle; after dragging, position via top/left and stop following the right anchor)
    title.onmousedown = function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var r = banner.getBoundingClientRect();
      var ox = e.clientX - r.left, oy = e.clientY - r.top;
      banner.style.right = "auto";
      banner.style.left = r.left + "px";
      banner.style.top = r.top + "px";
      var move = function (ev) {
        banner.style.left = Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - ox)) + "px";
        banner.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - oy)) + "px";
      };
      var up = function () {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
    var close = document.createElement("button");
    close.textContent = "✕";
    close.title = T().stayTooltip;
    close.style.cssText = "margin-left:auto;background:transparent;color:#9ca3af;border:none;font-size:14px;cursor:pointer;line-height:1;";
    close.onclick = function () { dismissedErr = banner._err.textContent; removeBanner(); };
    title.appendChild(close);
    var err = document.createElement("div");
    err.style.cssText = "color:#9ca3af;margin-bottom:10px;max-height:3.2em;overflow:hidden;word-break:break-all;";
    err.textContent = errText;
    banner._err = err;
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;";
    var go = document.createElement("button");
    go.textContent = T().goRescueBtn;
    go.style.cssText = "background:#f59e0b;color:#1a1a1a;border:none;border-radius:6px;padding:6px 14px;font-weight:600;cursor:pointer;";
    go.onclick = function () { removeBanner(); goRescue(errText); };
    var cd = document.createElement("span");
    cd.style.cssText = "color:#9ca3af;font-size:12px;";
    var stay = document.createElement("button");
    stay.textContent = T().stayPage;
    stay.style.cssText = "background:#333;color:#e8e8e8;border:1px solid #444;border-radius:6px;padding:6px 12px;cursor:pointer;";
    stay.onclick = function () { dismissedErr = errText; removeBanner(); };
    row.appendChild(go); row.appendChild(stay); row.appendChild(cd);
    banner.appendChild(title); banner.appendChild(err); banner.appendChild(row);
    document.documentElement.appendChild(banner);
    left = COUNTDOWN;
    cd.textContent = left + T().countdownSuffix;
    timer = setInterval(function () {
      left -= 1;
      if (left <= 0) { removeBanner(); goRescue(errText); return; }
      cd.textContent = left + T().countdownSuffix;
    }, 1000);
  }

  // Descend into shadow roots to collect text (the dev overlay lives entirely in shadow DOM).
  // Performance gate (learned the hard way): overlay text can contain huge single lines
  // (devtools-inlined minified CSS ~100k chars); use per-node callbacks with a per-node character
  // budget, combined with matchLine's per-line linear scan, to avoid the O(n²) backtracking of
  // running /([^\n]*X[^\n]*)/ against a giant string (a single check froze the main thread for
  // 4-90s in practice).
  // Note: the budget must be per-node — a shared budget lets the portal early in document order
  // (~100k chars) exhaust it, so the real error dialog later in the document gets skipped
  // (false negative, confirmed by audit on 2026-09-06).
  var DEEP_TEXT_BUDGET = 256 * 1024; // at most this many characters scanned per node; the Build Error line never hides deeper
  function deepText(node, cb) {
    if (!node || cb.done) return;
    if (node.nodeType === 3) {
      var s = node.textContent || "";
      if (s) { cb.chars += s.length; cb.lines.push(s); if (cb.chars > DEEP_TEXT_BUDGET) cb.done = true; }
      return;
    }
    if (node.shadowRoot) {
      var sr = node.shadowRoot.childNodes || [];
      for (var i = 0; i < sr.length; i++) deepText(sr[i], cb);
      if (cb.done) return;
    }
    var cn = node.childNodes || [];
    for (var j = 0; j < cn.length; j++) deepText(cn[j], cb);
  }

  // Key point: overlay content renders inside the portal's shadowRoot, and further rendering
  // within the shadow after insertion does NOT trigger the light DOM MutationObserver — we must
  // "discover the portal in light DOM, then attach another observer inside its shadowRoot"
  // (still purely event-driven, zero polling).
  var shadowMo = new MutationObserver(function () { check(); });

  function watchPortalShadows() {
    var portals = document.querySelectorAll("nextjs-portal");
    for (var i = 0; i < portals.length; i++) {
      var p = portals[i];
      if (p.__hookShadowWatched || !p.shadowRoot) continue;
      p.__hookShadowWatched = true;
      shadowMo.observe(p.shadowRoot, { childList: true, subtree: true });
    }
  }

  // Detection scope: scan only the dev overlay containers (role=dialog / data-nextjs-dialog* /
  // nextjs-portal), never the whole page — the app's own chat/session summary text may contain
  // the words "Build Error" (false positives observed). deepText covers both light childNodes and
  // shadowRoot (in Next 16 the Build Error dialog is a light element directly under body; older
  // versions may render inside the portal shadow — support both).
  function matchLine(text) {
    if (!text) return null;
    // Pick the human-readable error line by specificity; lines containing braces are CSS/code-style text, skip them.
    // Semantics aligned with the original: outer loop over patterns (specificity first) × per-line
    // test (linear, no backtracking).
    // Never run /([^\n]*X[^\n]*)/ against the full text — O(n²) backtracking; a single check froze
    // the main thread for 4-90s in practice.
    var lines = text.split("\n");
    var patterns = [/doesn't exist in target module/i, /Failed to compile/i, /Build Error/i];
    var sawAny = false;
    for (var p = 0; p < patterns.length; p++) {
      for (var i = 0; i < lines.length; i++) {
        if (!patterns[p].test(lines[i])) continue;
        sawAny = true;
        var line = lines[i].trim();
        if (/[{}]/.test(line)) break; // first matching line for this pattern is CSS/code-style → try the next pattern
        return line.length > 200 ? line.slice(0, 200) + "…" : line;
      }
    }
    return sawAny ? "Build Error" : null;
  }

  // Re-entry guard + trailing coalescing (defensive; with synchronous single-threaded execution
  // there is currently no re-entry path).
  // Per-node independent scanning: each node gets its own budget (see above) and stops at the
  // first match — a portal early in document order must not cause later dialogs to be skipped.
  var checking = false, pendingCheck = false;
  function check() {
    if (checking) { pendingCheck = true; return; }
    checking = true;
    try {
      watchPortalShadows();
      var nodes = document.querySelectorAll('[role="dialog"], [data-nextjs-dialog], [data-nextjs-dialog-overlay], nextjs-portal');
      if (!nodes.length) { dismissedErr = null; removeBanner(); return; }
      var line = null;
      for (var i = 0; i < nodes.length && !line; i++) {
        var cb = { chars: 0, lines: [], done: false };
        deepText(nodes[i], cb);
        line = matchLine(cb.lines.join("\n"));
      }
      if (line) showBanner(line);
      else { dismissedErr = null; removeBanner(); } // overlay present but not a Build Error (e.g. a Console Error popup) → do not disturb
    } finally {
      checking = false;
      if (pendingCheck) { pendingCheck = false; setTimeout(check, 120); }
    }
  }

  var mo = new MutationObserver(function () { check(); });
  function start() {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    check();
  }
  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });
})();
