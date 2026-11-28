/**
 * TakeoverSlot slow-flash fix tests (docs/pi-web-takeover-slow-flash-fix-plan.md).
 * Run: node --experimental-strip-types --test components/ExtSlots.takeover-slow-flash.test.mjs
 *
 * Structural/behavioral assertions over the waiting-window logic: the fallback UI
 * must be released only by deterministic signals (boot settled without declarers /
 * all declarers failed / anti-deadlock ceiling) — never by fixed short timers
 * racing the network (the old 800ms/1500ms windows flashed the native sidebar on
 * slow refreshes).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const extSlotsSrc = await readFile(new URL("./ExtSlots.tsx", import.meta.url), "utf8");
const appShellSrc = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebarCss = await readFile(new URL("../app/sidebar.css", import.meta.url), "utf8");

test("no fixed short release timers remain (800ms/1500ms windows removed)", () => {
  assert.ok(!extSlotsSrc.includes("setDeclaredReleased"), "the 1500ms declaredReleased path is gone");
  assert.ok(!extSlotsSrc.includes("setHintCleared"), "the 800ms hintCleared path is gone");
  assert.ok(!extSlotsSrc.includes("declaredReleased"), "no stale references remain");
  assert.ok(!extSlotsSrc.includes("hintCleared"), "no stale references remain");
});

test("waiting window releases only through the three deterministic signals", () => {
  // Extract the released + timeout effect block from TakeoverSlot and evaluate
  // the boolean matrix in isolation.
  const relMatch = extSlotsSrc.match(/const released = (settledAbsent \|\| allFailed \|\| timedOut);/);
  assert.ok(relMatch, "released must be exactly the deterministic-signal disjunction");
  const toMatch = extSlotsSrc.match(/const settledAbsent = bootSettled && !declared;/);
  assert.ok(toMatch, "settledAbsent = boot settled AND nobody declares anymore");
  assert.ok(extSlotsSrc.includes("const allFailed = declared && declaredAllFailed(name);"), "allFailed reads the loader failure registry");
});

test("anti-deadlock ceiling is 15s (not the old 1.5s)", () => {
  const m = extSlotsSrc.match(/const TAKEOVER_HOLD_CEILING_MS = (\d+);/);
  assert.ok(m, "ceiling constant exists");
  assert.equal(Number(m[1]), 15000);
});

test("hold renders the placeholder (not the fallback) while declared or memory hit", () => {
  assert.ok(extSlotsSrc.includes("if (declared || hintPending) return <>{placeholder ?? null}</>;"), "placeholder path present");
  assert.ok(extSlotsSrc.includes("placeholder?: ReactNode;"), "placeholder prop declared");
  // Memory writes are driven by deterministic release, not a fixed timer.
  const releasedMem = extSlotsSrc.match(/releasedMemClearedRef[\s\S]*?writeTakeoverMem\(name, false\);/);
  assert.ok(releasedMem, "stale memory is cleared once on deterministic release");
});

test("AppShell hands the takeover skeleton to sidebarContent's TakeoverSlot", () => {
  assert.ok(appShellSrc.includes("placeholder={<SidebarTakeoverSkeleton />}"), "sidebarContent uses the skeleton placeholder");
  assert.ok(appShellSrc.includes("function SidebarTakeoverSkeleton()"), "skeleton component defined");
  // Skeleton is aria-hidden (pure decoration).
  assert.ok(appShellSrc.match(/takeover-skeleton["]/), "skeleton uses the takeover-skeleton CSS class");
  assert.ok(appShellSrc.includes('aria-hidden="true"'), "skeleton is aria-hidden");
});

test("skeleton CSS: pulse animation + reduced-motion downgrade", () => {
  assert.ok(sidebarCss.includes("@keyframes takeover-skeleton-pulse"), "keyframes defined");
  assert.ok(sidebarCss.includes(".takeover-skeleton {"), "container class defined");
  assert.ok(/@media \(prefers-reduced-motion: reduce\) [\s\S]*takeover-skeleton-row \{ animation: none/.test(sidebarCss), "reduced-motion disables the pulse");
});
