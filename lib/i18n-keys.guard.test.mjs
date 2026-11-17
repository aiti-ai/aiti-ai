// ─────────────────────────────────────────────────────────────────────────────
// i18n guard (i18n-keys-guard)
//
// Background: upstream merges have caused two classes of i18n incidents:
//   1) auto-merge produced **duplicate keys** (chat.followUpHint/steerHint in
//      zh-TW each appeared twice; the later value silently overwrote the
//      earlier one — which side won depended purely on key order, pure luck);
//   2) both sides edited the same key's copy, and conflict resolution took one
//      whole side → **our key's semantics got clobbered by upstream** or
//      upstream's new keys went missing (components showed the raw key).
//
// This guard does three things:
//   1. the three language files have no duplicate keys (duplicate object
//      literal keys smell like a merge incident);
//   2. every t("key") referenced in repo source ⊆ the three-language key set
//      (a key lost in a merge turns red immediately, instead of users seeing
//      a raw key);
//   3. fork-critical semantic keys exist in all three languages (queue/steer
//      and other conflict-prone keys are named one by one).
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import test from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANGS = ["en", "zh-CN", "zh-TW"];
const messageFile = (lang) => join(root, "lib", "i18n", "messages", `${lang}.ts`);

/** Recursively collects source files (skips node_modules/dot dirs/test files/i18n messages themselves) */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if ((entry.endsWith(".tsx") || entry.endsWith(".ts")) && !entry.endsWith(".test.mjs") && !entry.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Parses the key set from a message file (keys are flat "ns.name" form, one per line) */
async function parseKeys(lang) {
  const src = await readFile(messageFile(lang), "utf8");
  const set = new Set();
  const re = /^\s*"([a-zA-Z0-9_.-]+)":/gm;
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  return { set, dupes: findDuplicates(src) };
}

/** Finds duplicate keys line by line (per-line matching tolerates noise inside string values) */
function findDuplicates(src) {
  const seen = new Map();
  const dupes = [];
  const re = /^\s*"([a-zA-Z0-9_.-]+)":/gm;
  let m;
  while ((m = re.exec(src))) {
    if (seen.has(m[1])) dupes.push(m[1]);
    else seen.set(m[1], true);
  }
  return dupes;
}

/** Collects literal t("key") / t('key') references across the repo (strips comments to avoid false positives from example code) */
async function collectUsedKeys() {
  const used = new Map(); // key → first referencing file (for error localization)
  const dirs = ["components", "hooks", "lib", "app"].map((d) => join(root, d));
  const keyRe = /\bt\(\s*["']([a-zA-Z0-9_.-]+)["']/g;
  for (const dir of dirs) {
    for (const f of walk(dir)) {
      if (f.includes(join("lib", "i18n", "messages"))) continue;
      let src = await readFile(f, "utf8");
      src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // strip comments
      let m;
      while ((m = keyRe.exec(src))) {
        if (!used.has(m[1])) used.set(m[1], f.replace(root + "/", ""));
      }
    }
  }
  return used;
}

test("[i18n-guard] the three message files have no duplicate keys (duplicates = merge incident: the later value silently overwrites the earlier)", async () => {
  for (const lang of LANGS) {
    const { dupes } = await parseKeys(lang);
    assert.deepEqual(dupes, [], `${lang}.ts has duplicate keys: ${dupes.join(", ")}\n  → typical auto-merge incident: both sides edited the same key without deduping. Keep the copy that carries our semantics.`);
  }
});

test("[i18n-guard] all t() keys referenced in the repo ⊆ the three-language key set (a lost key = raw key shown in the UI)", async () => {
  const used = await collectUsedKeys();
  assert.ok(used.size > 300, `referenced-key scan found suspiciously few keys (${used.size}); the scan logic or directory layout changed — check this test itself`);
  for (const lang of LANGS) {
    const { set } = await parseKeys(lang);
    const missing = [...used.keys()].filter((k) => !set.has(k));
    assert.deepEqual(missing, [], `${lang}.ts is missing referenced keys:\n${missing.map((k) => `    ${k}  ←  ${used.get(k)}`).join("\n")}\n  → the merge lost keys or key names drifted; restore our keys per merge-notes / add the new upstream keys.`);
  }
});

// Names conflict-prone keys (each has historically been clobbered by upstream
// or has diverged between the two sides):
// the queue/steer system is our queue-keeper semantics; its copy keys must
// survive in all three languages.
const FORK_CRITICAL_KEYS = [
  "chat.steer",
  "chat.followUp",
  "chat.steerHint",
  "chat.steerFromQueueHint",
  "chat.steerNoInput",
  "chat.followUpHint",
  "chat.followUpNoInput",
  // Note: chat.imagesCannotQueue was retired in 2026-09 along with the
  // "images can queue" product decision; no longer pinned
  // Note: chat.queueRecoveryDismiss was retired in 2026-09 when the recovery UI moved
  // out to aiti-recovery (the keys belong to the extension's own three catalogs; core
  // no longer uses them) — no longer pinned
  "chat.minimizeQueue",
  "chat.continueQueueHint",
  "i18n.editAgain",
  "chat.editHereVeilHint",
  "i18n.editFromHere",
  "sidebar.expandSubagents",
  "sidebar.collapseSubagents",
  "sidebar.expandBranches",
  "sidebar.collapseBranches",
  // Mobile composer: the upstream placeholder copy ("Message… Type / for commands,
  // @ for files") wraps on a 375px phone and its second line clips under the 32px
  // textarea. The fork shortened it (2026-11, "Message… / cmds @ files"); if a
  // merge clobbers it back to the long form, this key's presence pin + the
  // length check below both go red.
  "chat.messagePlaceholder",
];

// Mobile-visibility caps for fork-shortened copy (single line on a 375px
// composer, textarea ≈219px wide at 16px font). Upstream copies are longer and
// clip — if a merge restores an upstream-length value the length pin goes red.
const FORK_MAX_KEY_LENGTH = [
  { key: "chat.messagePlaceholder", langs: ["en"], max: 26 }, // "Message… / cmds @ files" = 24
];

test("[i18n-guard] fork-critical semantic keys exist in all three languages (queue/steer/edit-from-here/sidebar collapse — conflict-prone areas named one by one)", async () => {
  for (const lang of LANGS) {
    const { set } = await parseKeys(lang);
    const missing = FORK_CRITICAL_KEYS.filter((k) => !set.has(k));
    assert.deepEqual(missing, [], `${lang}.ts is missing fork-critical keys: ${missing.join(", ")}\n  → these keys' copy has historically been clobbered by upstream versions; restore our semantic copy.`);
  }
});

test("[i18n-guard] fork-shortened copy stays under its mobile single-line cap (upstream copies clip on a 375px composer)", async () => {
  for (const { key, langs, max } of FORK_MAX_KEY_LENGTH) {
    for (const lang of langs) {
      const src = await readFile(messageFile(lang), "utf8");
      const m = src.match(new RegExp(`"${key}":\\s*"([^"]*)"`));
      assert.ok(m, `${lang}.ts lost ${key} entirely (restore the fork copy)`);
      assert.ok(
        m[1].length <= max,
        `${lang} ${key} is ${m[1].length} chars (cap ${max}): "${m[1]}"\n  → upstream-length copy wraps on a phone and the second line clips under the textarea; keep the fork's shortened form or shorten deliberately (and update the cap).`,
      );
    }
  }
});
