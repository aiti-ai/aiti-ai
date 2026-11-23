/**
 * Locale-probe contract test: the inline <head> script in app/layout.tsx runs before hydration and
 * decides the UI locale, so it must agree with lib/i18n/registry.resolveBrowserLocale — including
 * zh-TW, which used to be silently rewritten to "en" on every hard reload (the probe whitelisted only
 * en / zh-CN, then re-derived from navigator.languages).
 *
 * The script is extracted from the layout source and executed in a sandbox, so the test fails if the
 * inline copy drifts from the registry rules.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const LAYOUT = fileURLToPath(new URL("../../app/layout.tsx", import.meta.url));

/** Pull the locale probe script out of the layout source. */
function probeScript() {
  const src = readFileSync(LAYOUT, "utf8");
  const m = src.match(/\(function\(\)\{try\{var l=localStorage\.getItem\("pi-locale"\)[\s\S]*?\}\)\(\);/);
  assert.ok(m, "locale probe script not found in app/layout.tsx");
  return m[0];
}

/** Run the probe with the given stored preference + navigator languages. */
function probe(stored, languages) {
  const sandbox = {
    localStorage: { getItem: (k) => (k === "pi-locale" ? stored : null) },
    navigator: { languages, language: languages[0] },
    document: { documentElement: {}, set cookie(v) { sandbox.__cookie = v; } },
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(probeScript(), sandbox);
  return { locale: sandbox.window.__PI_LOCALE__, lang: sandbox.document.documentElement.lang, cookie: sandbox.__cookie };
}

test("locale probe: a stored preference wins for every supported locale", () => {
  for (const loc of ["en", "zh-CN", "zh-TW"]) {
    const r = probe(loc, ["en-US", "en"]);
    assert.equal(r.locale, loc, "stored " + loc + " must survive the probe");
    assert.equal(r.lang, loc);
    assert.equal(r.cookie, "pi-locale=" + loc + ";path=/;max-age=31536000;SameSite=Lax");
  }
});

test("locale probe: browser detection mirrors resolveBrowserLocale", () => {
  const cases = [
    [["zh-TW", "en-US"], "zh-TW"],
    [["ZH-tW"], "zh-TW"],
    [["zh-Hant", "en-US"], "zh-TW"],
    [["zh-Hant-HK"], "zh-TW"],
    [["zh-HK"], "zh-TW"],
    [["zh-MO"], "zh-TW"],
    [["zh", "en-US"], "zh-CN"], // bare zh is Simplified
    [["zh-CN", "en-US"], "zh-CN"],
    [["zh-Hans"], "zh-CN"],
    [["en-US", "zh-TW"], "en"], // order wins
    [["fr-FR"], "en"], // unknown → en
  ];
  for (const [langs, expected] of cases) {
    assert.equal(probe(null, langs).locale, expected, "navigator " + langs.join(",") + " → " + expected);
  }
});

test("locale probe: an unsupported stored value falls back to browser detection", () => {
  assert.equal(probe("fr", ["zh-TW"]).locale, "zh-TW");
  assert.equal(probe("", ["en-GB"]).locale, "en");
});
