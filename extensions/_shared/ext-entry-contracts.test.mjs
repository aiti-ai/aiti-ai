/**
 * ext-entry-contracts.test.mjs — full extension entry contract sweep (covers all official extensions).
 *
 * Regression gate distilled from E2E measurements (2026-11-06):
 *   1. package.json must declare aitiExtProtocol (protocol red line, the in-repo equivalent of the whole-repo check);
 *   2. slot names in registerItems/registerItems?. calls must be valid members of the host's ExtSlotName union
 *      (a misspelled slot = the entry never renders = a dead entry point);
 *   3. features referenced by registerItems must exist in the extension's features declarations (a nonexistent
 *      feature id = a dead card hidden forever — the aiti-app-center feature-gate filter works on this basis);
 *   4. slot keys declared in index.ts's static ui must likewise be valid slot names;
 *
 * Run: node --test extensions/_shared/ext-entry-contracts.test.mjs (from the aiti-ai repo root)
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, "..");
const workRoot = join(extRoot, "..");

/** Mirror of the host's ExtSlotName union (pi-web lib/ext/types.ts; sync here when host slots grow). */
const VALID_SLOTS = new Set([
  "toolbar", "sidebar", "sidebarFooter", "sessionTopbar", "sessionRowActions",
  // topbarMobileLeading (2026-11-23): small-screen leading top-bar actions (host renders only when isMobile,
  // right after the sidebar toggle); first user = session-manager's new-session button
  "topbarMobileLeading",
  "sessionRowLeading", "sessionRowMeta", "sidebarProjects", "sidebarContent",
  "dialogs", "banners", "pages", "chatInputTop", "chatOverlay",
  // commands directory slot: already recorded in the host registry.ts UI_SLOT_KEYS (ec06564a); consumers = aiti-app-center /
  // input command hints; first user aiti-folder (2026-11-15)
  "commands",
  "userMessageActions", "assistantMessageActions", "assistantMessageFooter",
  "fileViewer", "pathPicker", "newSessionBackendOptions", "sessionStats",
  "composerTools", "queuePanel", "recoveryDialog", "workspacePickerActions",
  "newSessionContextTrailing", "modelSelector", "modelSelectorFooter",
  "settingsModels", "settingsAgentsFeature", "settingsAgents", "terminalDock",
  // sessionStatsInline (2026-11-21): inline tail inside the session-info stats button;
  // recorded by the host (types.ts + registry.ts UI_SLOT_KEYS); first user = aiti-sysmon top-bar chips
  "sessionStatsInline",
  "sidebarExplorerDock", "rightFileDock", "sidebarTasks", "composerAffix",
  "modelInfoLead", "compactLead", "sessionRequestCard", "newSessionSelectors",
  "newSessionPreparers", "newSessionWidgets", "newSessionWorkspacePicker",
  // sessionInfoPanel (2026-11-26): session-info popover "remaining quota" block; now a
  // first-class host slot (types.ts + registry.ts) rendered by AppShell's ExtSlot —
  // first user = aiti-provider-usage panel (+ its account-quota details)
  "sessionInfoPanel",
  "noWorkspaceGuide",  // v3 addition: whole-page fresh-first-screen guide replacement slot (consumed by AppShell; first user aiti-quickstart)
]);

function listExts() {
  // the sync-mirror test in the concurrent suite temporarily creates/deletes fixture extension directories — treat ENOENT as vanished and skip
  const dirs = readdirSync(extRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared" && e.name !== "node_modules")
    .map((e) => e.name);
  return dirs.filter((n) => {
    try { return existsSync(join(extRoot, n, "package.json")); } catch { return false; }
  });
}

function* clientFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // assets/ + chunk-*.mjs = vite build artifacts (feature: strings inside vendored libraries
      // cause contract-scan false positives) — contract checks look at hand-written sources only
      if (e.name === "node_modules" || e.name === "dist" || e.name === "vendor" || e.name === "assets") continue;
      yield* clientFiles(p);
    } else if (/\.(tsx?|js|mjs)$/.test(e.name) && !/\.test\.(mjs|js)$/.test(e.name) && !/\.min\.(js|mjs)$/.test(e.name) && !/-chunk-[A-Za-z0-9_-]+\.mjs$/.test(e.name)) {
      // -chunk-<hash>.mjs = vite build artifacts (feature: strings inside vendored libraries cause
      // contract-scan false positives) — contract checks look at hand-written sources only
      yield p;
    }
  }
}

test("every official extension's package.json declares aitiExtProtocol", () => {
  const bad = [];
  for (const name of listExts()) {
    const pkg = JSON.parse(readFileSync(join(extRoot, name, "package.json"), "utf8"));
    if (!/^1\.\d+$/.test(String(pkg.aitiExtProtocol ?? ""))) bad.push(`${name}: ${pkg.aitiExtProtocol ?? "missing"}`);
  }
  assert.deepEqual(bad, [], "extensions with a missing/invalid aitiExtProtocol");
});

test("registerItems slot names are all valid (a misspelling = a dead entry point)", () => {
  const bad = [];
  for (const name of listExts()) {
    const dir = join(extRoot, name);
    for (const f of clientFiles(dir)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bregisterItems\b[\s\S]{0,40}?\(\s*["'`]([a-zA-Z]+)["'`]/g)) {
        if (!VALID_SLOTS.has(m[1])) bad.push(`${name} (${f.split("pi-web-ext/")[1]}): "${m[1]}"`);
      }
    }
  }
  assert.deepEqual(bad, [], "registerItems calls referencing nonexistent slots");
});

test("features referenced by registerItems must exist in the features declarations", () => {
  const bad = [];
  for (const name of listExts()) {
    const dir = join(extRoot, name);
    const indexSrc = existsSync(join(dir, "index.ts")) ? readFileSync(join(dir, "index.ts"), "utf8") : "";
    const declared = new Set([...indexSrc.matchAll(/\{\s*id:\s*["'`]([a-zA-Z0-9._-]+)["'`]/g)].map((m) => m[1]));
    for (const f of clientFiles(dir)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bfeature:\s*["'`]([a-zA-Z0-9._-]+)["'`]/g)) {
        if (!declared.has(m[1])) bad.push(`${name}: feature "${m[1]}" (${f.split("pi-web-ext/")[1]}) not in the features declaration`);
      }
    }
  }
  assert.deepEqual(bad, [], "entries referencing undeclared features");
});

test("slot keys declared in index.ts's static ui are all valid", () => {
  const bad = [];
  for (const name of listExts()) {
    const indexSrc = existsSync(join(extRoot, name, "index.ts")) ? readFileSync(join(extRoot, name, "index.ts"), "utf8") : null;
    if (!indexSrc) continue;
    // Scan only the top-level ui: { ... } block — a whole-file 4-space sweep also hits
    // same-named keys inside agent tool declarations (session_search's promptGuidelines:
    // [...] was flagged as an unknown slot, 2026-11-11)
    const uiBlock = indexSrc.match(/^  ui: \{([\s\S]*?)\n  \},/m)?.[1] ?? "";
    // Non-slot metadata keys inside the ui block (the host's registerDeclaredSlots
    // declares them with no consumer; ai-helper aggregation reads them):
    // i18n/provides/clientDependsOn/clientImmediately are host-filtered whitelist,
    // helpers is aiti-helper aggregation metadata
    const UI_META_KEYS = new Set(["i18n", "provides", "clientDependsOn", "clientImmediately", "helpers"]);
    for (const m of uiBlock.matchAll(/^ {4}([a-zA-Z]+): \[$/gm)) {
      if (!VALID_SLOTS.has(m[1]) && !UI_META_KEYS.has(m[1])) bad.push(`${name}: ui.${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], "static ui declarations using unknown slot keys");
});
