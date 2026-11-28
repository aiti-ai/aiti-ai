/**
 * ua-parse.test.mjs —— UA / client-hint parsing: corpus expectations + dual-implementation parity.
 *
 * Background: host-protocol.js used a single leftmost-match regex
 * `/(EdgA?|Chrome|Firefox|OPR|Safari|Edge)\/([\d.]+)/`; Chromium derivatives embed `Chrome/<v>` BEFORE their
 * own token, so Edge 157 was reported as Chrome 157 (UA "…Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0").
 *
 * This test pins:
 *   1. expectations for a corpus of real UAs (desktop/mobile/tablet, Edge/Opera/Samsung/Yandex/Firefox/Safari…)
 *   2. parity between the two copies of the algorithm:
 *        - packages/aiti-devtools-core/src/ua-parse.js        (bridge / node)
 *        - packages/aiti-devtools-core/assets/host-protocol.js (browser asset, IIFE copy)
 *      They cannot share a module (the asset has no module system), so drift is caught here instead.
 *   3. UA-CH (navigator.userAgentData.brands) takes precedence over the UA string, and is also used to
 *      refine brands-only majors to the full UA-string version.
 *
 * 用法：node test/ua-parse.test.mjs（assets 版本由 node tools/build-assets.mjs 生成）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseUa } from "../src/ua-parse.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetSrc = readFileSync(resolve(root, "assets/host-protocol.js"), "utf8");

/** Load the browser asset in a bare sandbox just to reach its uaParse copy. */
function loadAssetParser() {
  const g = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: "", origin: "http://t", href: "http://t/" },
    document: { title: "", querySelectorAll: () => [], addEventListener: () => {}, visibilityState: "visible" },
    addEventListener: () => {},
    URL,
  };
  g.window = g;
  const run = new Function("global", "window", "setInterval", "clearInterval", assetSrc + "\n;return window.AitiHostProtocol;");
  const mod = run(g, g, () => 0, () => {});
  assert.equal(typeof mod.uaParse, "function", "host-protocol asset must expose uaParse");
  return mod.uaParse;
}

const assetParse = loadAssetParser();

// The exact UA that was misreported as Chrome (Edge 157 on Linux).
const UA_EDGE_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0";

const CORPUS = [
  { name: "Edge desktop (Linux) — the reported regression", ua: UA_EDGE_LINUX, browser: "Edge", version: "157.0.0.0", os: "Linux", deviceType: "desktop" },
  {
    name: "Edge desktop (Windows)",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0",
    browser: "Edge", version: "157.0.0.0", os: "Windows", osVer: "10/11", deviceType: "desktop",
  },
  {
    name: "Edge Android (EdgA)",
    ua: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 EdgA/125.0.0.0",
    browser: "Edge", version: "125.0.0.0", os: "Android", osVer: "10", deviceType: "mobile",
  },
  {
    name: "Edge iOS (EdgiOS)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 EdgiOS/125.0.0.0",
    browser: "Edge", version: "125.0.0.0", os: "iOS", osVer: "17.0", deviceType: "mobile",
  },
  {
    name: "Opera desktop (OPR)",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0",
    browser: "Opera", version: "110.0.0.0", os: "Windows", deviceType: "desktop",
  },
  {
    name: "Opera Android",
    ua: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 OPR/80.0.0.0",
    browser: "Opera", version: "80.0.0.0", os: "Android", osVer: "13", deviceType: "mobile",
  },
  {
    name: "Samsung Internet",
    ua: "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/125.0.0.0 Mobile Safari/537.36",
    browser: "Samsung Internet", version: "25.0", os: "Android", deviceType: "mobile",
  },
  {
    name: "Yandex Browser",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 YaBrowser/24.7.0.0 Safari/537.36",
    browser: "Yandex", version: "24.7.0.0", os: "Windows", deviceType: "desktop",
  },
  {
    name: "Chrome desktop (Linux)",
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
    browser: "Chrome", version: "157.0.0.0", os: "Linux", deviceType: "desktop",
  },
  {
    name: "Chrome Android",
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
    browser: "Chrome", version: "125.0.0.0", os: "Android", osVer: "14", deviceType: "mobile",
  },
  {
    name: "Firefox desktop",
    ua: "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0",
    browser: "Firefox", version: "129.0", os: "Linux", deviceType: "desktop",
  },
  {
    name: "Firefox Android",
    ua: "Mozilla/5.0 (Android 14; Mobile; rv:129.0) Gecko/129.0 Firefox/129.0",
    browser: "Firefox", version: "129.0", os: "Android", deviceType: "mobile",
  },
  {
    name: "Firefox iOS (FxiOS)",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/129.0 Mobile/15E148 Safari/605.1.15",
    browser: "Firefox", version: "129.0", os: "iOS", osVer: "17.5", deviceType: "mobile",
  },
  {
    name: "Safari macOS",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    browser: "Safari", version: "17.5", os: "macOS", osVer: "10.15.7", deviceType: "desktop",
  },
  {
    name: "Safari iPhone",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    browser: "Safari", version: "17.5", os: "iOS", osVer: "17.5", deviceType: "mobile",
  },
  {
    name: "iPadOS 13+ (desktop UA + touch points)",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    nav: { maxTouchPoints: 5 },
    browser: "Safari", version: "17.5", os: "iOS", osVer: "", deviceType: "tablet",
  },
  { name: "iPad (legacy UA)", ua: "Mozilla/5.0 (iPad; CPU OS 12_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1", browser: "Safari", os: "iOS", deviceType: "tablet" },
  {
    name: "Legacy EdgeHTML",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19041",
    browser: "Edge", version: "18.19041", os: "Windows", deviceType: "desktop",
  },
  {
    name: "Electron app",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) app/1.0.0 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36",
    browser: "Electron", version: "31.0.0", os: "Windows", deviceType: "desktop",
  },
  {
    name: "WeChat (Chromium webview)",
    ua: "Mozilla/5.0 (Linux; Android 13; 2211133C Build/TKQ1) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 MicroMessenger/8.0.40",
    browser: "Chrome", version: "107.0.5304.141", os: "Android", deviceType: "mobile",
  },
];

test("UA corpus: browser / version / os / form factor", () => {
  for (const c of CORPUS) {
    for (const [label, fn] of [["ua-parse.js", parseUa], ["host-protocol.js", assetParse]]) {
      const r = fn(c.ua, c.nav || null);
      const where = c.name + " [" + label + "]";
      assert.equal(r.browser, c.browser, where + " browser");
      if (c.version) assert.equal(r.version, c.version, where + " version");
      assert.equal(r.os, c.os, where + " os");
      if (c.osVer !== undefined) assert.equal(r.osVer, c.osVer, where + " osVer");
      assert.equal(r.deviceType, c.deviceType, where + " deviceType");
    }
  }
});

test("dual implementations stay in parity (ua-parse.js vs host-protocol.js)", () => {
  for (const c of CORPUS) {
    const a = parseUa(c.ua, c.nav || null);
    const b = assetParse(c.ua, c.nav || null);
    assert.deepEqual(a, b, "parity drift for: " + c.name);
  }
  // Edge/Chrome/Opera UAs with no client hints, empty and odd inputs
  for (const ua of ["", "garbage", "Mozilla/5.0", UA_EDGE_LINUX]) {
    assert.deepEqual(parseUa(ua, null), assetParse(ua, null), "parity drift for ua=" + JSON.stringify(ua));
  }
});

test("UA-CH brands win over the UA string (Edge / Opera / Brave / Vivaldi)", () => {
  const UA_CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  const UA_OPERA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0";
  const cases = [
    // brands-version is major-only; the UA-string token (when present) refines it to the full version
    { ua: UA_EDGE_LINUX, brands: [{ brand: "Chromium", version: "157" }, { brand: "Not(A:Brand", version: "24" }, { brand: "Microsoft Edge", version: "157" }], browser: "Edge", version: "157.0.0.0" },
    { ua: UA_OPERA, brands: [{ brand: "Chromium", version: "124" }, { brand: "Opera", version: "110" }], browser: "Opera", version: "110.0.0.0" },
    // Brave/Vivaldi keep the brand version: their UA strings impersonate plain Chrome (no own token)
    { ua: UA_CHROME, brands: [{ brand: "Chromium", version: "126" }, { brand: "Brave", version: "126" }], browser: "Brave", version: "126" },
    { ua: UA_CHROME, brands: [{ brand: "Chromium", version: "126" }, { brand: "Vivaldi", version: "6" }], browser: "Vivaldi", version: "6" },
    { ua: UA_CHROME, brands: [{ brand: "Chromium", version: "126" }, { brand: "Google Chrome", version: "126" }], browser: "Chrome", version: "126.0.0.0" },
    // brands-only Chromium: the UA string is more specific than the generic "Chromium" brand
    { ua: UA_CHROME, brands: [{ brand: "Chromium", version: "126" }], browser: "Chrome", version: "126.0.0.0" },
    { ua: UA_EDGE_LINUX, brands: [{ brand: "Chromium", version: "157" }], browser: "Edge", version: "157.0.0.0" },
  ];
  for (const c of cases) {
    const nav = { userAgentData: { brands: c.brands } };
    const r = parseUa(c.ua, nav);
    assert.equal(r.browser, c.browser, "UA-CH brand → " + c.browser);
    assert.equal(r.version, c.version, "UA-CH brand version → " + c.browser);
    assert.equal(r.source, "ua-ch", "source = ua-ch");
    // parity with the browser asset copy
    assert.deepEqual(assetParse(c.ua, nav), r);
  }
});

test("no UA-CH (insecure context) falls back to the UA string", () => {
  const r = parseUa(UA_EDGE_LINUX, { userAgentData: undefined });
  assert.equal(r.browser, "Edge");
  assert.equal(r.version, "157.0.0.0");
});
