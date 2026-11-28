/**
 * Per-locale extension metadata resolution: description / tagline fallback chains.
 * Run: node --test extensions/_shared/ext-display-names.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { extDescriptionFor, extSoulFor, ui18nExact } from "./ext-display-names.ts";

test("ui18nExact only honors the exact locale table (no cascade)", () => {
  const i18n = { en: { "ext.description": "EN" }, "zh-CN": { "ext.description": "中文" } }; // zh-CN fixture value is a locale resource on purpose
  assert.equal(ui18nExact(i18n, "en")["ext.description"], "EN");
  assert.equal(ui18nExact(i18n, "zh-CN")["ext.description"], "中文");
  assert.deepEqual(ui18nExact(i18n, "zh-TW"), {});
  assert.deepEqual(ui18nExact(undefined, "en"), {});
});

test("description: ui.i18n override wins over package.json maps and the raw text", () => {
  const ext = {
    description: "raw",
    descriptionI18n: { "zh-CN": "包内中文" }, // locale fixtures below stay Chinese on purpose
    ui: { i18n: { en: { "ext.description": "ui en" }, "zh-CN": { "ext.description": "ui 中文" } } },
  };
  assert.equal(extDescriptionFor(ext, "en"), "ui en");
  assert.equal(extDescriptionFor(ext, "zh-CN"), "ui 中文");
  // No zh-TW table entry -> the package.json map has no zh-TW -> the same-family fallback (zh-CN) is
  // applied by localeText, so the Chinese one-liner survives the exact-match miss.
  assert.equal(extDescriptionFor(ext, "zh-TW"), "包内中文");
});

test("description: falls back through the package.json map, then the raw manifest", () => {
  assert.equal(extDescriptionFor({ description: "raw", descriptionI18n: { "zh-CN": "中文" } }, "zh-CN"), "中文");
  assert.equal(extDescriptionFor({ description: "raw" }, "zh-CN"), "raw");
  assert.equal(extDescriptionFor({}, "en"), "");
  assert.equal(extDescriptionFor(null, "en"), "");
});

test("tagline: ui override -> soulI18n -> bare soul, with language-family fallback", () => {
  const ext = { soul: "中文标语", soulI18n: { en: "EN tagline" } };
  assert.equal(extSoulFor(ext, "en"), "EN tagline");
  assert.equal(extSoulFor(ext, "zh-CN"), "中文标语");
  assert.equal(extSoulFor(ext, "zh-TW"), "中文标语");
  assert.equal(extSoulFor({ soul: "中文标语", soulI18n: { "zh-TW": "繁中" } }, "zh-CN"), "繁中");
  assert.equal(extSoulFor({ soul: "中文标语", ui: { i18n: { en: { "ext.soul": "UI EN" } } } }, "en"), "UI EN");
  assert.equal(extSoulFor({}, "en"), "");
});

test("malformed locale maps never leak non-string values", () => {
  const ext = { description: "raw", descriptionI18n: null, soul: "s", soulI18n: undefined };
  assert.equal(extDescriptionFor(ext, "en"), "raw");
  assert.equal(extSoulFor(ext, "en"), "s");
  assert.equal(extDescriptionFor({ descriptionI18n: { en: 42 } }, "en"), "");
});

test("names: every zh variant keeps the Chinese manifest name instead of degrading to the id", async () => {
  const { extNameFor } = await import("./ext-display-names.ts");
  const ext = { id: "aiti-demo", name: "演示扩展" };
  assert.equal(extNameFor(ext, "zh-CN"), "演示扩展");
  assert.equal(extNameFor(ext, "zh-TW"), "演示扩展");
  assert.equal(extNameFor(ext, "en"), "aiti-demo");
  // en table wins when declared
  assert.equal(extNameFor({ ...ext, ui: { i18n: { en: { "ext.displayName": "Demo" } } } }, "en"), "Demo");
  // a latin name needs no override in en mode
  assert.equal(extNameFor({ id: "x", name: "Demo" }, "en"), "Demo");
});
