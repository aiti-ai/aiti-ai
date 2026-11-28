#!/usr/bin/env node
/**
 * Extension global-variable graylist check (DI plan P3, docs/pi-web-ext-dependency-injection-plan.md §8-R1)
 *
 * Usage: node pi-web-ext/_shared/check-ext-globals.mjs [--strict]
 *   Scans pi-web-ext/ sources (excluding node_modules/ai-configs/build artifacts):
 *   1. Server-side `__piWebExt.byId(...)` byId passthrough / `featureValue|featureEnabled|setFeatureFlag` direct calls
 *   2. Client-side `window.__<Name>` / `globalThis.__<Name>` ad-hoc globals
 * Known names go into the graylist (dual-track fallback / core reserved slots / internal shortcuts /
 * framework aggregation); **any newly appearing name fails outright**
 * — red line: new globals are always rejected (AGENTS.md common pitfalls). Convergence progress for
 * existing entries: DI plan §5 ledger.
 * Wired into the unified test entry scripts/test-web-ext.mjs (runs first on every test run; a hit fails the whole round).
 * --strict: dualtrack dual-track fallbacks also count as FAIL (for evaluating fallback retirement progress; off by default).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");

/** ── Graylist: known and documented globals (DI plan §1.2 / §6 / per-extension docs)────────
 *  Categories: core-reserved (§6 exemptions) / dualtrack (old-channel fallback after the P1/P2
 *  migrations, retired once production is synced)
 *  / internal (same-extension internal shortcut, converging to module-level singletons in a later batch) / framework (framework-level aggregation mechanism) */
const GRAY_CLIENT = new Map([
  // core reserved slots (§6)
  ["__piPageEvents", "core-reserved"], ["__piPageEventsClient", "core-reserved (bus-absent fallback)"],
  ["__piWebPendingComposer", "core-reserved"], ["__runningEventsBroker", "core-reserved"],
  ["__PIBASE", "core-reserved"], ["__aitiTraceEmit", "core-reserved (pi extension producer)"],
  ["__aitiInject", "core-reserved (middleware cross-bundle)"],
  // P2 dual-track fallbacks (retired together with the fallback code once production is synced)
  ["__aitiModelCheckOpen", "dualtrack"], ["__aitiModelCheckApp", "dualtrack"],
  ["__aitiModelWizardOpen", "dualtrack"], ["__aitiModelWizardOpenTab", "dualtrack"],
  ["__aitiModelWizardViewParams", "dualtrack"], ["__aitiModelWizardCleanupEdit", "dualtrack"],
  ["__aitiHelperInvoke", "dualtrack"], ["__aitiSuggestAiFallback", "dualtrack"],
  ["__aitiAiScheduleOpen", "dualtrack"], ["__aitiGitReviewOpen", "dualtrack"], ["__aitiGitReviewWork", "dualtrack"],
  ["__aitiCmd", "dualtrack (aiti-cmd.open-session/open-shell service fallback)"],
  ["__piEventBus", "dualtrack (event-bus client slot: topic-subscription wait channel under materialize races, to converge via onExtServiceChange)"],
  // internal shortcuts (produced and consumed by the same extension; converging to module-level singletons in a separate batch, non-blocking)
  ["__aitiEditor", "internal"], ["__aitiCpuMeter", "internal"], ["__speekScrollMode", "internal"],
  ["__speekListForHighlight", "internal"], ["__aitiDocCenterOpen", "internal"],
  ["__aitiAsrOpen", "internal"], ["__aitiConfigsOpen", "internal"], ["__aitiAppendSystemOpen", "internal"],
  ["__aitiGitTraceBanner", "internal"], ["__aitiGitTraceForkDialog", "internal"], ["__aitiGitTraceCtx", "internal"],
  ["__aitiEventBusDisposer", "internal (instance handoff, same pattern as draft-keeper)"],
  ["__aitiCpuMeterOpts", "internal"], ["__AITI_AI_WIN__", "internal (AI window window.open name)"],
  ["__AitiCdpCore", "internal (devtools CDP core)"], ["__dbgLauncherInstalled", "internal (devtools dbg family)"],
  ["__aitiSuppressScroll", "internal"], ["__PIBASE__", "internal (basePath shortcut)"],
  ["__AITI_FLOAT__", "internal (float namespace)"], ["__piweFloat", "internal"], ["__pfFrames", "internal (e2e frame buffer)"],
  ["__draftKeeperDisposer", "internal (instance handoff)"], ["__aitiFolder", "internal"],
  ["__piFolderRevealLast", "internal"], ["__aitiSheetUniverApiUrl", "internal"],
  ["__aitiModelWizardViewParamsInternal", "internal"],
  ["__aitiVoiceInputL2", "internal (ai-input voice L2 singleton)"],
  ["__aitiBridgeProbe", "internal (bridge-probe self-install idempotence guard)"],
  ["__dbgAiHostWin", "internal (devtools AI window opener/parent cache)"],
]);
/** Framework-level aggregation (reads all extensions' declarations: configs.includes / schedules / ai.skills) — mechanism kept, governed by a separate plan */
const GRAY_SERVER_AGG = ["aiti-configs", "aiti-ai-schedule", "aiti-helper"];

const SKIP_DIRS = new Set(["node_modules", "ai-configs", "templates", "sm-demo-source", "_shared", "shared", "demo", "demo-lazy"]);
/** Only scan real extension directories at the top level (excludes backup/tool/shared directories) */
const TOP_SKIP = new Set(["ai-configs", "templates", "sm-demo-source", "_shared", "shared", "demo", "demo-lazy", "tools", "node_modules"]);
const SRC_EXT = /\.(ts|tsx|mjs)$/;

let HAS_SRC = false; // whether the current extension has client/src (if so, client/*.mjs counts as build output and is skipped)
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p); }
    else if (SRC_EXT.test(e.name)) yield p;
  }
}

const violations = [];
const knownHits = { client: 0, server: 0 };
const serverAggHits = new Map();

for (const extDir of readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !TOP_SKIP.has(e.name)).map((e) => join(ROOT, e.name))) {
  const extId = extDir.split(sep).pop();
  try { HAS_SRC = statSync(join(extDir, "client", "src")).isDirectory(); } catch { HAS_SRC = false; }
  for (const file of walk(extDir)) {
    const rel = file.slice(ROOT.length + 1);
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    const isClient = /[\\/]client[\\/]/.test(rel);
    // Build output skipped (source already scanned; minified/internal names inside artifacts are not a new source)
    if (HAS_SRC && isClient && file.endsWith(".mjs") && !rel.includes("src")) continue;
    const lineOf = (idx) => src.slice(0, idx).split("\n").length;
    const lineAt = (re) => { const m = src.match(re); return m ? lineOf(m.index) : 0; };

    // 1) Server side: byId passthrough / feature direct calls (excludes comment lines and fallback-annotated lines)
    if (!isClient && file.endsWith(".ts")) {
      for (const m of src.matchAll(/byId\(/g)) {
        const line = src.slice(0, m.index).split("\n").pop() ?? "";
        const ctxWindow = src.slice(Math.max(0, m.index - 400), m.index + 200);
        if (/双轨|兜底|dualtrack|DI 方案|注释|\/\/.*byId|\.test\.|legacy/.test(line) || /双轨|兜底|dualtrack|DI 方案/.test(ctxWindow)) { knownHits.server++; continue; }
        violations.push(`[server byId] ${rel}:${lineOf(m.index)}  ${line.trim().slice(0, 100)}`);
      }
      for (const m of src.matchAll(/__piWebExt[^;]*?\.(featureValue|featureEnabled|setFeatureFlag|setFeatureValue)\s*\(/g)) {
        const line = src.slice(0, m.index).split("\n").pop() ?? "";
        if (/兜底|dualtrack|DI 方案|写路径|legacy/.test(line)) { knownHits.server++; continue; }
        violations.push(`[server feature direct-call] ${rel}:${lineOf(m.index)}  ${line.trim().slice(0, 100)}`);
      }
    }

    // 2) Client side: window/globalThis.__Name ad-hoc globals
    if (isClient) {
      for (const m of src.matchAll(/(?:window|globalThis)\.__([A-Za-z][A-Za-z0-9_]*)/g)) {
        if (m[1].startsWith("piWeb")) { knownHits.client++; continue; } // core platform globals (__piWeb* naming convention, §6)
        const name = "__" + m[1];
        const cat = GRAY_CLIENT.get(name);
        if (cat) {
          if (STRICT && cat.startsWith("dualtrack")) {
            violations.push(`[strict·dualtrack] ${rel}:${lineOf(m.index)}  ${name} (${cat})`);
          } else {
            knownHits.client++;
          }
          continue;
        }
        violations.push(`[client global·unregistered] ${rel}:${lineOf(m.index)}  ${name} (not in the graylist — new globals are always rejected; if truly needed, document it first and add it to this script's graylist)`);
      }
      for (const m of src.matchAll(/(?:window|globalThis)\.__piWebExt\b/g)) {
        knownHits.client++;
      }
    }

    // 3) Framework aggregation stats (exempt but visible)
    if (!isClient && GRAY_SERVER_AGG.includes(extId)) {
      const c = (src.match(/__piWebExt/g) ?? []).length;
      if (c) serverAggHits.set(rel, c);
    }
    void lineAt;
  }
}

console.log(`[globals] graylist hits: client=${knownHits.client} server(fallback-annotated lines)=${knownHits.server}`);
if (serverAggHits.size) {
  console.log(`[globals] framework aggregation exempt (mechanism kept): ${[...serverAggHits.entries()].map(([f, c]) => `${f}×${c}`).join(", ")}`);
}
if (violations.length) {
  console.error(`\n[globals] ❌ ${violations.length} violation(s) (new byId passthrough / feature direct call / unregistered global):`);
  for (const v of violations.slice(0, 40)) console.error("  " + v);
  if (violations.length > 40) console.error(`  …${violations.length} in total`);
  process.exit(1);
}
console.log("[globals] ✅ no new violations. Existing graylist: docs/pi-web-ext-dependency-injection-plan.md §5/§6.");
