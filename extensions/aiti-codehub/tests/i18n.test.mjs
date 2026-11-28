/**
 * i18n dictionary guard: the three locale tables must stay key-aligned and keep
 * interpolation placeholders consistent (see ui-i18n.ts for the cascade contract).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UI_I18N, YUNXIAO_STATUS_KEY } from "../ui-i18n.ts";

test("i18n: all three locales share the same key set", () => {
  const locales = Object.keys(UI_I18N);
  assert.deepEqual(locales.sort(), ["en", "zh-CN", "zh-TW"]);
  const en = Object.keys(UI_I18N.en).sort();
  for (const locale of locales) {
    assert.deepEqual(Object.keys(UI_I18N[locale]).sort(), en, `${locale} key set diverged`);
  }
  assert.ok(en.length > 300, `expected a full dictionary, got ${en.length} keys`);
});

test("i18n: keys carry the ch. namespace prefix", () => {
  for (const [locale, table] of Object.entries(UI_I18N)) {
    for (const key of Object.keys(table)) {
      assert.ok(key.startsWith("ch."), `${locale}: key lacks the ch. prefix: ${key}`);
    }
  }
});

test("i18n: interpolation placeholders match across locales", () => {
  const placeholders = (s) => (s.match(/\{[\w.-]+\}/g) || []).sort().join(",");
  for (const key of Object.keys(UI_I18N.en)) {
    const perLocale = Object.keys(UI_I18N).map((l) => placeholders(UI_I18N[l][key] ?? ""));
    assert.equal(new Set(perLocale).size, 1, `placeholder mismatch for ${key}: ${perLocale.join(" | ")}`);
  }
});

test("i18n: yunxiao status routing table covers every dictionary status suffix", () => {
  const statusKeys = Object.keys(UI_I18N.en)
    .filter((k) => k.startsWith("ch.prov.filteropt.status."))
    .map((k) => k.slice("ch.prov.filteropt.status.".length));
  assert.deepEqual([...new Set(statusKeys)].sort(), [...new Set(Object.values(YUNXIAO_STATUS_KEY))].sort());
});
