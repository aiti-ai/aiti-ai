/**
 * aiti-models-import · i18n contract test
 *
 * Pins the multilingual surface of the import dialog:
 *   1) every locale (zh-CN / en / zh-TW) exists and carries the extman display name ("n");
 *   2) the three tables share one key set (no locale-only keys, no forgotten translations);
 *   3) per key, the {placeholder} set is identical across locales (a missing {count} would print
 *      raw braces — the classic i18n regression);
 *   4) the en table holds no CJK (public-surface discipline);
 *   5) every key referenced by the client bundle (`t("mi.…")`) and by the server (`msg("mi.srv.…")`,
 *      `imsg("mi.srv.…")` — adapters emit envelopes, the client resolves them via tsrv) exists in the
 *      tables, so a typo can never ship a bare key to the UI.
 *
 * Run: node --test extensions/aiti-models-import/i18n.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ext from "./index.ts";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const LOCALES = ["zh-CN", "en", "zh-TW"];
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

const table = ext.ui.i18n;

function keysOf(locale) {
  return Object.keys(table[locale] || {}).sort();
}

function placeholders(text) {
  return [...String(text).matchAll(/\{([\w.-]+)\}/g)].map((m) => m[1]).sort();
}

/** Walk a directory and collect files by extension. */
function walkFiles(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** Keys referenced through t("…") / msg("…") / imsg("…") literals in a set of files. */
function referencedKeys(files, callRe) {
  const found = new Map();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(callRe)) found.set(m[1], file.replace(ROOT, ""));
  }
  return found;
}

test("i18n: every shipped locale exists and carries the extman display name", () => {
  assert.deepEqual(Object.keys(table).sort(), [...LOCALES].sort());
  for (const loc of LOCALES) {
    assert.equal(typeof table[loc].n, "string", loc + ": missing display name (\"n\")");
    assert.ok(table[loc].n.trim().length > 0, loc + ": empty display name");
  }
});

test("i18n: all locales share one key set", () => {
  const base = keysOf("en");
  assert.ok(base.length > 40, "en table unexpectedly small (" + base.length + " keys)");
  for (const loc of LOCALES) {
    const keys = keysOf(loc);
    const missing = base.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !base.includes(k));
    assert.deepEqual(missing, [], loc + " is missing keys: " + missing.join(", "));
    assert.deepEqual(extra, [], loc + " has keys absent from en: " + extra.join(", "));
  }
});

test("i18n: {placeholder} sets match across locales", () => {
  for (const key of keysOf("en")) {
    const expected = placeholders(table.en[key]);
    for (const loc of LOCALES) {
      assert.deepEqual(placeholders(table[loc][key]), expected, loc + " / " + key + " placeholder mismatch");
    }
  }
});

test("i18n: the en table holds no CJK text", () => {
  const offenders = keysOf("en").filter((k) => CJK.test(table.en[k]));
  assert.deepEqual(offenders, [], "en must stay English: " + offenders.join(", "));
});

test("i18n: client and server reference only defined keys", () => {
  const clientFiles = walkFiles(join(ROOT, "client", "src"), [".ts", ".tsx"]);
  const serverFiles = [
    join(ROOT, "index.ts"),
    join(ROOT, "core.cjs"),
    ...walkFiles(join(ROOT, "sources"), [".cjs"]),
  ];
  const refs = new Map([
    ...referencedKeys(clientFiles, /\bt\(\s*"(mi\.[\w.]+)"/g),
    ...referencedKeys(serverFiles, /\b(?:imsg|core\.msg|msg)\(\s*"(mi\.[\w.]+)"/g),
  ]);
  assert.ok(refs.size > 20, "expected the dialog to reference many keys, found " + refs.size);
  // A trailing dot marks a dynamic prefix (`t("mi.modality." + id)`): require the family to exist.
  const defined = (key) => (key.endsWith(".")
    ? Object.keys(table.en).some((k) => k.startsWith(key) && k !== key)
    : key in table.en);
  const undefinedKeys = [...refs].filter(([key]) => !defined(key)).map(([key, file]) => key + " (" + file + ")");
  assert.deepEqual(undefinedKeys, [], "undefined i18n keys: " + undefinedKeys.join(", "));
});

test("i18n: client bundle carries no hardcoded CJK UI text", () => {
  // The dialog owns all of its copy; any CJK left in the client sources means a string escaped the
  // table (comments are English in this file set, so a plain scan is enough).
  const offenders = [];
  for (const file of walkFiles(join(ROOT, "client", "src"), [".tsx"])) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (CJK.test(line)) offenders.push(file.replace(ROOT, "") + ":" + (i + 1) + "  " + line.trim().slice(0, 80));
    });
  }
  assert.deepEqual(offenders, [], "hardcoded CJK UI text:\n" + offenders.join("\n"));
});
