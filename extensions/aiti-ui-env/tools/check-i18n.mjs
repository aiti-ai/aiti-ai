/**
 * check-i18n — aiti-ui-env i18n table coverage check (zero deps).
 *
 * Why: the panel mixes three sources of copy — client t("<literal>") keys, server
 * tr(locale, "<key>") messages, and manifest `i18n:` prefixes (toolbar/dialog/feature
 * groups). A missing entry silently degrades to English in a Chinese UI or to the raw
 * key in an English one, and that drift is invisible at runtime.
 *
 * Rules:
 *   - every client `t("…")` literal must exist in the en table
 *   - every en table key must resolve in zh-CN (Chinese literals derive identity,
 *     semantic keys need an explicit zh-CN text)
 *   - every server `tr()/trOr()/probeFail()` key must exist in en (dynamic prefixes
 *     and ternary keys are recognised below)
 *
 * Usage: node --experimental-strip-types tools/check-i18n.mjs
 *        (npm run check:i18n)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const { uiI18n } = await import(pathToFileURL(join(root, "lib/i18n.ts")).href);
const en = uiI18n.en;
const zh = uiI18n["zh-CN"];
const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

const problems = [];

// ── 1) client t("<literal>") coverage ────────────────────────────────────────
const clientFiles = ["client/src/ui-env-app.tsx", "client/src/entry.tsx"];
const clientKeys = new Map(); // key → first file:line
for (const file of clientFiles) {
  read(file).split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      const key = m[1].replace(/\\"/g, '"');
      if (!clientKeys.has(key)) clientKeys.set(key, `${file}:${i + 1}`);
    }
  });
}
for (const [key, where] of clientKeys) {
  if (!has(en, key)) problems.push(`client key without en text: ${JSON.stringify(key)} (${where})`);
}

// ── 2) zh-CN coverage for every en key ──────────────────────────────────────
// `feat.*` descriptors are optional in zh-CN: the raw manifest text is already Chinese,
// so zh mode falls back to it (only en needs an explicit entry).
for (const key of Object.keys(en)) {
  if (key.startsWith("feat.")) continue;
  if (!has(zh, key)) problems.push(`en key without zh-CN text: ${JSON.stringify(key)}`);
}

// ── 3) server message keys ──────────────────────────────────────────────────
const declaredFeatures = [...read("index.ts").matchAll(/\{ id: "([\w.-]+)", (?:type: "[a-z]+", )?label:/g)].map((m) => m[1]);
const featureKeys = new Set(declaredFeatures.flatMap((id) => ["feat." + id, "feat." + id + ".desc"]));
const serverFiles = ["lib/env.ts", "lib/win.ts", "lib/mac.ts", "index.ts"];
const serverKeys = new Set();
// dynamic families whose suffixes are enumerated in code rather than written as literals
const dynamicPrefixes = [
  ["srv.dep.", ["Xvfb", "openbox", "picom", "x11vnc", "at-spi-bus-launcher", "xauth", "xdpyinfo", "dbus-daemon", "tint2", "xfce4-terminal", "thunar", "xdotool", "xterm", "obamenu"]],
  ["srv.dep.manual.", ["Xvfb", "openbox", "picom", "x11vnc", "at-spi-bus-launcher", "xauth", "xdpyinfo", "dbus-daemon", "tint2", "xfce4-terminal", "thunar", "xdotool", "xterm", "obamenu"]],
  ["mode.", ["prefer-desktop", "prefer-headless", "always-desktop", "always-headless"]],
];
for (const file of serverFiles) {
  const code = read(file);
  for (const m of code.matchAll(/\btr(?:Or)?\([^,]+,\s*"((?:[^"\\]|\\.)*)"/g)) serverKeys.add(m[1]);
  for (const m of code.matchAll(/\btrOr\([^,]+,\s*[^,]+,\s*"[^"]*",\s*\{[^}]*\}\s*\)/g)) void m;
  for (const m of code.matchAll(/tr\([^,]+,\s*[^,]+ === "([^"]+)"\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) {
    serverKeys.add(m[2]);
    serverKeys.add(m[3]);
  }
  for (const m of code.matchAll(/\bprobeFail\([^,]+,\s*"([^"]+)"/g)) serverKeys.add(m[1].startsWith("srv.probe.") ? m[1] : "srv.probe." + m[1]);
  for (const m of code.matchAll(/(?:probeFail|resolutionKey\s*=)[^\n]*?selfPid \? "([^"]+)" : "([^"]+)"/g)) {
    serverKeys.add("srv.probe." + m[1]);
    serverKeys.add("srv.probe." + m[2]);
  }
  for (const m of code.matchAll(/resolutionKey = "([^"]+)"/g)) serverKeys.add(m[1]);
}
for (const [prefix, suffixes] of dynamicPrefixes) for (const s of suffixes) serverKeys.add(prefix + s);
// manual entries without a translation fall back to the (language-neutral) command list
const optionalManual = new Set(["srv.dep.manual.Xvfb", "srv.dep.manual.at-spi-bus-launcher", "srv.dep.manual.xauth", "srv.dep.manual.xdpyinfo"]);
for (const key of serverKeys) {
  if (key.endsWith(".")) continue; // dynamic prefix captured mid-concatenation ("mode." + id)
  if (optionalManual.has(key)) continue;
  if (!has(en, key)) problems.push(`server key without en text: ${JSON.stringify(key)}`);
}

// ── 4) dead keys (declared but unreferenced) ────────────────────────────────
const referenced = new Set([...clientKeys.keys(), ...serverKeys]);
const referencedPrefixes = ["feat.", "ext.", "it.", "uiEnv."];
const dynamicClasses = [
  (k) => /^srv\.dep\.[^.]*$/.test(k) || /^srv\.dep\.manual\./.test(k) || /^mode\./.test(k) || /^srv\.probe\./.test(k),
];
const dead = Object.keys(en).filter((key) => {
  if (referenced.has(key)) return false;
  if (referencedPrefixes.some((p) => key.startsWith(p))) return false; // consumed through "i18n:" prefixes / feature manifests
  if (featureKeys.has(key)) return false; // declared feature label/description
  if (dynamicClasses.some((fn) => fn(key))) return false;
  return true;
});
for (const key of dead) problems.push(`dead key (declared, never referenced): ${JSON.stringify(key)}`);
for (const key of [...Object.keys(en), ...Object.keys(zh)]) {
  if (key.startsWith("feat.") && !key.startsWith("feat.group.") && !featureKeys.has(key)) {
    problems.push(`dead feature key (no such feature id): ${JSON.stringify(key)}`);
  }
}

if (problems.length) {
  console.error(`[check-i18n] ${problems.length} problem(s):`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`[check-i18n] OK — en ${Object.keys(en).length}, zh-CN ${Object.keys(zh).length}, client keys ${clientKeys.size}, server keys ${serverKeys.size}`);
