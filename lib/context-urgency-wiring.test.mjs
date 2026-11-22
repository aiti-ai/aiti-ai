import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Wiring assertions for urgency coloring (design: docs/context-compaction-urgency-plan.md §4):
 *  all four consumers must go through lib/context-urgency.ts as the single source,
 *  with the breathing animation landing in globals.css. */
test("context-urgency single source is wired into all four consumers", async () => {
  const appShell = fs.readFileSync(path.join(ROOT, "components/AppShell.tsx"), "utf8");
  const chatWindow = fs.readFileSync(path.join(ROOT, "components/ChatWindow.tsx"), "utf8");
  const chatInput = fs.readFileSync(path.join(ROOT, "components/ChatInput.tsx"), "utf8");
  const globals = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
  const helper = fs.readFileSync(path.join(ROOT, "lib/context-urgency.ts"), "utf8");

  // Helper: four levels + null fallback + exported animation name
  assert.match(helper, /"calm" \| "warn" \| "urgent" \| "critical"/);
  assert.match(helper, /export function contextUrgency/);
  assert.match(helper, /CTX_BREATHE_ANIMATION = "ctx-urgency-breathe"/);

  // Top bar (dome indicator) converges on the helper; thresholds are no longer inlined
  assert.match(appShell, /from "@\/lib\/context-urgency"/);
  assert.match(appShell, /contextUrgency\(contextUsage\?\.contextWindow \? contextUsage\.percent : null\)/);
  assert.doesNotMatch(appShell, /pct > 90\) ctxColor/); // old inline tiering removed

  // Panel: compact-controls registration + context row coloring button
  assert.match(appShell, /onCompactControlsRegister=\{setCompactControls\}/);
  assert.match(chatWindow, /onCompactControlsRegister\?:/);
  assert.match(chatWindow, /export interface CompactControls/);
  assert.match(chatWindow, /onCompactControlsRegister\?\.\(compactControls\)/);

  // ChatInput: contextPercent prop + two button/dot consumers
  assert.match(chatInput, /contextPercent\?: number \| null/);
  assert.match(chatInput, /const ctxUrg = contextUrgency\(contextPercent\)/);
  assert.match(chatInput, /background: idleCtxColor/); // dot on the dialog's compact row

  // Global CSS: keyframes + disabled under reduced-motion
  assert.match(globals, /@keyframes ctx-urgency-breathe/);
  assert.match(globals, /prefers-reduced-motion: reduce/);
});
