/**
 * ua-parse.js —— User-Agent / Client-Hint parsing (browser + OS + form factor), one algorithm for:
 *   - the bridge (bridge.ts, node) when a client connects without reporting device info
 *   - the page/console side (host-protocol.js `deviceInfo()`) — that asset is a plain <script> IIFE with
 *     no module system, so it carries a verbatim copy; test/ua-parse.test.mjs runs both over the same
 *     corpus and fails on any drift.
 *
 * ⚠ Never use one leftmost-match regex like /(EdgA?|Chrome|Firefox|OPR|Safari|Edge)\/(\d+)/
 *   Chromium derivatives (Edge/Opera/Samsung/Yandex/Vivaldi/DuckDuckGo…) embed `Chrome/<v>` BEFORE their
 *   own token, and regex alternation is position-ordered, not priority-ordered — that exact bug reported
 *   `Edge 157` as `Chrome 157` (UA: "…Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0").
 *
 * Strategy:
 *   1. navigator.userAgentData.brands (UA-CH) first — Chromium derivatives declare themselves explicitly
 *      ("Microsoft Edge", "Opera", "Brave", "Vivaldi"…); only available in secure contexts.
 *   2. Ordered distinctive-token table (most specific first), then the plain Chrome/Firefox/Safari tail.
 *   Version always prefers the UA-string token (full version) over the UA-CH major-only number.
 */

/** UA-CH brand → display name, ordered: the most specific brand wins (Chromium is always present). */
const BRAND_NAMES = [
  [/Microsoft Edge/i, "Edge"],
  [/Opera|Opera GX/i, "Opera"],
  [/Brave/i, "Brave"],
  [/Vivaldi/i, "Vivaldi"],
  [/Samsung Internet/i, "Samsung Internet"],
  [/YaBrowser|Yandex/i, "Yandex"],
  [/DuckDuckGo/i, "DuckDuckGo"],
  [/Google Chrome/i, "Chrome"],
  [/Chromium/i, "Chromium"],
];

/** Distinctive UA tokens, most specific first (a token matches only as `token/`). */
const UA_TOKENS = [
  ["EdgiOS", "Edge"],
  ["EdgA", "Edge"],
  ["Edg", "Edge"],
  ["Edge", "Edge"], // legacy EdgeHTML
  ["OPiOS", "Opera"],
  ["OPR", "Opera"],
  ["SamsungBrowser", "Samsung Internet"],
  ["YaBrowser", "Yandex"],
  ["Vivaldi", "Vivaldi"],
  ["DuckDuckGo", "DuckDuckGo"],
  ["Whale", "Whale"],
  ["Electron", "Electron"],
  ["FxiOS", "Firefox"],
  ["Firefox", "Firefox"],
  ["CriOS", "Chrome"],
  ["Chrome", "Chrome"],
];

/** Version tokens per browser name (first hit wins) — keeps full version instead of UA-CH's major. */
const VERSION_TOKENS = {
  Edge: ["Edg", "EdgA", "EdgiOS", "Edge"],
  Opera: ["OPR", "OPiOS"],
  "Samsung Internet": ["SamsungBrowser"],
  Yandex: ["YaBrowser"],
  Vivaldi: ["Vivaldi"],
  DuckDuckGo: ["DuckDuckGo"],
  Whale: ["Whale"],
  Electron: ["Electron"],
  Firefox: ["Firefox", "FxiOS"],
  Chrome: ["Chrome", "CriOS"],
};

function tokenVersion(ua, tokens) {
  for (const t of tokens || []) {
    const i = ua.indexOf(t + "/");
    if (i < 0) continue;
    const m = ua.slice(i + t.length + 1).match(/^[\d.]+/);
    if (m) return m[0];
  }
  return "";
}

/**
 * @param {string} ua userAgent string
 * @param {{ userAgentData?: { brands?: Array<{brand: string, version: string}> }, maxTouchPoints?: number } | null} [nav]
 *   navigator-like object (browser side) — enables UA-CH and the iPad-on-macOS touch heuristic; null on the server.
 * @returns {{ browser: string, version: string, os: string, osVer: string, deviceType: "desktop"|"mobile"|"tablet", mobile: boolean, source: string }}
 */
export function parseUa(ua, nav) {
  const s = String(ua || "");
  const out = { browser: "?", version: "", os: "?", osVer: "", deviceType: "desktop", mobile: false, source: "" };

  // ---- browser: UA-CH first ----
  try {
    const brands = nav && nav.userAgentData && Array.isArray(nav.userAgentData.brands) ? nav.userAgentData.brands : null;
    if (brands && brands.length) {
      for (const [re, name] of BRAND_NAMES) {
        const hit = brands.filter((b) => b && re.test(String(b.brand)))[0];
        if (!hit) continue;
        out.browser = name;
        out.version = String(hit.version || "");
        out.source = "ua-ch";
        break;
      }
      if (out.browser !== "?" && out.browser !== "Chromium") {
        const full = tokenVersion(s, VERSION_TOKENS[out.browser]);
        if (full) out.version = full;
      }
    }
  } catch (e) {}

  // ---- browser: UA-string fallback / refinement of a generic UA-CH "Chromium" ----
  if (out.browser === "?" || out.browser === "Chromium") {
    for (const [tok, name] of UA_TOKENS) {
      if (s.indexOf(tok + "/") < 0) continue;
      out.browser = name;
      out.version = tokenVersion(s, VERSION_TOKENS[name]);
      if (!out.source) out.source = "ua-string";
      break;
    }
    if (out.browser === "?") {
      const vm = s.match(/Version\/([\d.]+).*Safari/);
      if (vm) { out.browser = "Safari"; out.version = vm[1]; out.source = "ua-string"; }
      else if (/MSIE|Trident/.test(s)) { out.browser = "IE"; const mi = s.match(/rv:([\d.]+)/); out.version = mi ? mi[1] : ""; out.source = "ua-string"; }
    }
  }

  // ---- OS ----
  let ipadLike = false;
  try {
    const touch = nav && typeof nav.maxTouchPoints === "number" ? nav.maxTouchPoints : 0;
    // iPadOS 13+ masquerades as desktop Safari (Macintosh); touch points are the only reliable tell.
    ipadLike = touch > 1 && /Mac OS X/.test(s) && !/Chrome|CriOS|Firefox|FxiOS|Edg|OPR/.test(s);
    if (/Windows Phone/.test(s)) { out.os = "Windows Phone"; }
    else if (/Windows NT/.test(s)) {
      out.os = "Windows";
      out.osVer = /Windows NT 10\.0/.test(s) ? "10/11" : /Windows NT 6\.[123]/.test(s) ? "7/8" : "10/11";
    } else if (/iPhone|iPad|iPod/.test(s)) {
      out.os = "iOS";
      const im = s.match(/OS (\d+[_\d]*)/);
      out.osVer = im ? im[1].replace(/_/g, ".") : "";
    } else if (/Android/.test(s)) {
      out.os = "Android";
      const am = s.match(/Android ([\d.]+)/);
      out.osVer = am ? am[1] : "";
    } else if (/CrOS/.test(s)) {
      out.os = "ChromeOS";
    } else if (ipadLike) {
      out.os = "iOS";
      out.osVer = "";
    } else if (/Mac OS X/.test(s)) {
      out.os = "macOS";
      const mm = s.match(/Mac OS X ([\d_.]+)/);
      out.osVer = mm ? mm[1].replace(/_/g, ".") : "";
    } else if (/Linux|X11/.test(s)) {
      out.os = "Linux";
    }
  } catch (e) {}

  // ---- form factor ----
  out.mobile = /Android|iPhone|iPod|Mobile|Windows Phone|IEMobile/i.test(s) || (out.os === "iOS" && /iPhone|iPod/.test(s));
  const tablet = /iPad|Tablet|Silk|PlayBook/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s)) || ipadLike;
  out.deviceType = tablet ? "tablet" : out.mobile ? "mobile" : "desktop";
  return out;
}
