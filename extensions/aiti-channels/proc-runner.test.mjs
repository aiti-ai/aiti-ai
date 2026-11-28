/**
 * aiti-channels · proc-runner unit tests (pure logic only — no process spawning).
 *
 * Pins:
 *   1. decideRunner matrix: forced override > windows-cim > non-linux plain >
 *      missing systemd-run bin > missing user bus > manager not answering >
 *      systemd-run (Linux default).
 *   2. unitNameFor: prefix + systemd-safe sanitization + length cap.
 *   3. userManagerEnv: explicit uid with existing runtime dir shape is honored
 *      (no filesystem assertions beyond the function's contract on this host).
 *   4. runtime registry: write/read/clear round-trip on a temp dir.
 *
 * Run: node --test extensions/aiti-channels/proc-runner.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { decideRunner, unitNameFor, userManagerEnv, readRuntime, writeRuntime, clearRuntime } = await import("./lib/proc-runner.ts");

test("decideRunner: forced override wins (both directions)", () => {
  assert.equal(decideRunner({ platform: "linux", forced: "plain", hasSystemdRunBin: true, hasUserBus: true, managerAlive: true }).kind, "plain");
  assert.equal(decideRunner({ platform: "darwin", forced: "systemd", hasSystemdRunBin: false, hasUserBus: false, managerAlive: false }).kind, "systemd-run");
  assert.equal(decideRunner({ platform: "win32", forced: "plain", hasSystemdRunBin: false, hasUserBus: false, managerAlive: false }).kind, "plain");
  assert.equal(decideRunner({ platform: "win32", forced: "", hasSystemdRunBin: false, hasUserBus: false, managerAlive: false }).kind, "windows-cim");
});

test("decideRunner: linux default is systemd-run only when fully available", () => {
  const base = { platform: "linux", forced: "" };
  assert.equal(decideRunner({ ...base, hasSystemdRunBin: true, hasUserBus: true, managerAlive: true }).kind, "systemd-run");
  assert.equal(decideRunner({ ...base, hasSystemdRunBin: false, hasUserBus: true, managerAlive: true }).kind, "plain");
  assert.equal(decideRunner({ ...base, hasSystemdRunBin: true, hasUserBus: false, managerAlive: true }).kind, "plain");
  assert.equal(decideRunner({ ...base, hasSystemdRunBin: true, hasUserBus: true, managerAlive: false }).kind, "plain");
});

test("decideRunner: non-linux platforms degrade to plain (except win32 cim)", () => {
  for (const p of ["darwin", "freebsd", "android"]) {
    assert.equal(decideRunner({ platform: p, forced: "", hasSystemdRunBin: true, hasUserBus: true, managerAlive: true }).kind, "plain");
  }
});

test("unitNameFor: prefix + sanitization + length cap", () => {
  assert.equal(unitNameFor("default"), "aiti-cc-default");
  assert.equal(unitNameFor("my-bot.2"), "aiti-cc-my-bot.2");
  // unsafe chars collapse to underscore; spaces/slashes are not systemd-safe
  assert.equal(unitNameFor("a/b c"), "aiti-cc-a_b_c");
  const long = unitNameFor("x".repeat(300));
  assert.ok(long.length <= "aiti-cc-".length + 120);
  assert.ok(long.startsWith("aiti-cc-"));
  assert.equal(unitNameFor(""), "aiti-cc-default");
});

test("userManagerEnv: bus coordinates derive from uid", () => {
  // The function honors XDG_RUNTIME_DIR when it exists; on this dev host the
  // real user runtime dir exists, so the map is populated with both keys.
  const env = userManagerEnv(process.getuid?.());
  if (env.XDG_RUNTIME_DIR) {
    assert.ok(env.DBUS_SESSION_BUS_ADDRESS.includes("unix:path="));
    assert.ok(env.DBUS_SESSION_BUS_ADDRESS.includes("bus"));
  } else {
    assert.deepEqual(env, {});
  }
  // uid without a runtime dir → empty map (degrade to plain runner)
  assert.deepEqual(userManagerEnv(0xdeaad), {});
});

test("runtime registry: write/read/clear round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiti-cc-runtime-test-"));
  try {
    assert.equal(readRuntime(dir), null);
    writeRuntime(dir, { runner: "systemd-run", unit: "aiti-cc-default", startedAt: "2026-11-28T00:00:00Z" });
    const r = readRuntime(dir);
    assert.equal(r?.runner, "systemd-run");
    assert.equal(r?.unit, "aiti-cc-default");
    clearRuntime(dir);
    assert.equal(readRuntime(dir), null);
    // garbage file → null, not throw
    writeRuntime(dir, { runner: "plain", pid: 42, startedAt: "2026-11-28T00:00:00Z" });
    writeFileSync(join(dir, "runtime.json"), "{not json");
    assert.equal(readRuntime(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
