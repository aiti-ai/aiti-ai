/**
 * Guard against upstream re-enabling built-in subagents (internal fork upstream-core plan §0/§1).
 *
 * Background: pi-web/SDK ships built-in subagents (feature/built-in-subagents-testing had it enabled).
 * We use the forked pi-subagents (upstream nicobailon) as the only subagent engine — the two living
 * side by side would cause double subagent tools / dual-engine conflicts. Therefore built-in must be
 * **constantly disabled** (implemented as a code-level return false).
 *
 * Two kinds of guards in this file:
 *  1-3 (settings file CRUD / damaged-file fallback / constant-false semantics, from parallel work)
 *  4 (static assertion: the implementation stays code-level hard-disabled; an upstream merge that
 *     changes it to read the file goes red immediately → restore return false)
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const {
  isBuiltInSubagentsEnabled,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("subagent settings default the built-in extension to disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: false });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
});

test("subagent settings persist both states and preserve unrelated fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true });
  // Fork guard: writes always persist, reads always return false (the fork's pi-subagents is the only subagent engine)
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(first, { version: 1, builtInEnabled: true });

  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting: 3 }));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const second = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(second, { version: 1, builtInEnabled: false, futureSetting: 3 });
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, "{");

  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.throws(() => readSubagentSettings(settingsPath));
  assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath));
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});

test("guard: the built-in subagents hard-disable implementation must not be merged back to file-reading by upstream (fork guard)", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "subagent-settings.ts"),
    "utf8",
  );
  assert.match(
    src,
    /export function isBuiltInSubagentsEnabled\([^)]*\): boolean \{\s*\n\s*return false;/,
    "isBuiltInSubagentsEnabled no longer hardcodes return false — an upstream merge may have introduced a file-reading implementation; " +
      "the fork's only subagent engine is pi-subagents, restore the constant false",
  );
});
