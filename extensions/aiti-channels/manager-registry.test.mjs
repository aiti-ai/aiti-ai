/**
 * aiti-channels · instance registry unit tests (pure fs, temp dataDir).
 *
 * Pins:
 *   1. listInstances merges a stored default entry (acpTcpPort override)
 *      into the implicit default instead of duplicating it.
 *   2. saveInstance replace-or-append keeps OTHER entries intact — in
 *      particular a stored default override survives saving a normal
 *      instance (regression: the override was once wiped by that path).
 *   3. saveInstance("default") stores only override fields and replaces
 *      (never duplicates) a previous stored default entry.
 *   4. deleteInstance keeps a stored default override.
 *
 * Run: node --test extensions/aiti-channels/manager-registry.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setDataDir, listInstances, saveInstance, deleteInstance } = await import("./lib/manager.ts");

const base = { id: "x", name: "X", config: "/tmp/x/config.toml", dataDir: "/tmp/x/data" };
const defSave = { id: "default", name: "默认实例", config: "/home/x/.config/cc-connect.toml", dataDir: "/home/x/.cc-connect", acpTcpPort: 29301 };

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "aiti-cc-registry-"));
  setDataDir(dir);
  return dir;
}

test("registry: stored default override merges into the implicit default", () => {
  const dir = fresh();
  saveInstance({ ...defSave });
  const all = listInstances();
  const def = all.filter((i) => i.id === "default");
  assert.equal(def.length, 1, "exactly one default entry");
  assert.equal(def[0].acpTcpPort, 29301, "override fields present");
  assert.equal(all[0].id, "default", "default listed first");
  rmSync(dir, { recursive: true, force: true });
});

test("registry: saving a normal instance keeps the stored default override", () => {
  const dir = fresh();
  saveInstance({ ...defSave });
  saveInstance({ ...base, id: "atest" });
  const def = listInstances().filter((i) => i.id === "default");
  assert.equal(def.length, 1);
  assert.equal(def[0].acpTcpPort, 29301, "override survived the other save");
  assert.ok(listInstances().some((i) => i.id === "atest"));
  rmSync(dir, { recursive: true, force: true });
});

test("registry: saving default twice replaces instead of duplicating", () => {
  const dir = fresh();
  saveInstance({ ...defSave });
  saveInstance({ ...defSave, acpTcpPort: 29355 });
  const file = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
  const defs = file.filter((i) => i.id === "default");
  assert.equal(defs.length, 1, "single stored default entry");
  assert.equal(defs[0].acpTcpPort, 29355, "latest override wins");
  assert.equal(listInstances().filter((i) => i.id === "default")[0].acpTcpPort, 29355);
  rmSync(dir, { recursive: true, force: true });
});

test("registry: deleteInstance keeps the stored default override", () => {
  const dir = fresh();
  saveInstance({ ...defSave });
  saveInstance({ ...base, id: "atest" });
  deleteInstance("atest");
  const def = listInstances().filter((i) => i.id === "default");
  assert.equal(def.length, 1);
  assert.equal(def[0].acpTcpPort, 29301);
  rmSync(dir, { recursive: true, force: true });
});
