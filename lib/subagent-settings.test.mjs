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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const {
  disabledBuiltInSubagents,
  isBuiltInSubagentsEnabled,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
  writeDisabledBuiltInSubagent,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("subagent settings default the built-in extension to disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: false, disabledBuiltIns: [] });
  assert.equal(isBuiltInSubagentsEnabled(), false);
  assert.deepEqual([...disabledBuiltInSubagents(settingsPath)], []);
});

test("subagent settings persist both states and preserve unrelated fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true, disabledBuiltIns: [] });
  // Fork guard: writes always persist, reads always return false (the fork's pi-subagents is the only subagent engine)
  assert.equal(isBuiltInSubagentsEnabled(), false);
  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(first, { version: 1, builtInEnabled: true });

  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting: 3 }));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const second = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(second, { version: 1, builtInEnabled: false, futureSetting: 3 });
});

test("disabling a built-in is a minimal edit of the stored name list", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  writeDisabledBuiltInSubagent("explore", true, settingsPath);
  assert.deepEqual([...disabledBuiltInSubagents(settingsPath)], ["explore"]);
  // The feature switch and any unknown field survive the write.
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1,
    builtInEnabled: true,
    disabledBuiltIns: ["explore"],
  });

  writeDisabledBuiltInSubagent("plan", true, settingsPath);
  writeDisabledBuiltInSubagent("explore", true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, ["explore", "plan"]);

  // A name is matched case-insensitively, and re-enabling one leaves the other.
  writeDisabledBuiltInSubagent("EXPLORE", false, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, ["plan"]);
  writeDisabledBuiltInSubagent("plan", false, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, []);
  // Fork guard: the persisted switch stays true, but reads always report false
  // (the fork's pi-subagents extension is the only subagent engine).
  assert.equal(isBuiltInSubagentsEnabled(), false);

  assert.throws(() => writeDisabledBuiltInSubagent("  ", true, settingsPath));
});

test("a name no built-in claims is kept, and a damaged list is ignored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({
    version: 1,
    disabledBuiltIns: ["from-a-newer-build", 7, " explore ", "Explore", ""],
    futureSetting: 3,
  }));
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, ["from-a-newer-build", "explore"]);

  writeDisabledBuiltInSubagent("explore", false, settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1,
    disabledBuiltIns: ["from-a-newer-build"],
    futureSetting: 3,
  });

  // A switch that changes nothing does not rewrite the file at all.
  const untouched = JSON.stringify({ disabledBuiltIns: ["from-a-newer-build"] });
  await writeFile(settingsPath, untouched);
  writeDisabledBuiltInSubagent("plan", false, settingsPath);
  writeDisabledBuiltInSubagent("From-A-Newer-Build", true, settingsPath);
  assert.equal(await readFile(settingsPath, "utf8"), untouched);

  await writeFile(settingsPath, JSON.stringify({ version: 1, disabledBuiltIns: "explore" }));
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, []);
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, "{");

  assert.equal(isBuiltInSubagentsEnabled(), false);
  assert.throws(() => readSubagentSettings(settingsPath));
  assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath));
  assert.throws(() => writeDisabledBuiltInSubagent("explore", true, settingsPath));
  // Fails open: an unreadable file must not hide the built-in profiles.
  assert.deepEqual([...disabledBuiltInSubagents(settingsPath)], []);
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
