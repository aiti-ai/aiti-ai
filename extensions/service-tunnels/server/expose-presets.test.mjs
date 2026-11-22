import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listExposePresets,
  loadExposePreset,
  saveExposePreset,
  deleteExposePreset,
  saveLastUsedExpose,
  LAST_USED_ID,
} from "./expose-presets.ts";

function makeDir() {
  return mkdtempSync(join(tmpdir(), "pi-expose-presets-"));
}

function baseConfig(overrides = {}) {
  return {
    provider: "basic",
    tunnel: "ngrok",
    protocol: "https",
    mode: "both",
    site: "services",
    serviceBasePath: "/dev",
    tunnelParams: { authtoken: "SECRET-TOKEN-ABCD", region: "jp" },
    providerParams: {},
    ...overrides,
  };
}

test("sensitive values are encrypted at rest and decrypt on load", async () => {
  const dir = makeDir();
  process.env.PI_WEB_EXPOSE_PRESETS_DIR = dir;
  try {
    const { id } = await saveExposePreset("plan", baseConfig());
    // on-disk file must NOT contain the plaintext secret
    const raw = readFileSync(join(dir, "expose-presets.json"), "utf8");
    assert.ok(!raw.includes("SECRET-TOKEN-ABCD"), "plaintext secret leaked to disk");
    assert.ok(/enc:v1:/.test(raw), "sensitive value not encrypted");

    const cfg = loadExposePreset(id);
    assert.equal(cfg?.tunnelParams.authtoken, "SECRET-TOKEN-ABCD");
    assert.equal(cfg?.tunnelParams.region, "jp"); // non-sensitive stays plaintext
    assert.equal(cfg?.serviceBasePath, "/dev");
  } finally {
    delete process.env.PI_WEB_EXPOSE_PRESETS_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list exposes metadata only; load of unknown id → null", async () => {
  const dir = makeDir();
  process.env.PI_WEB_EXPOSE_PRESETS_DIR = dir;
  try {
    const { id } = await saveExposePreset("meta", baseConfig());
    const list = listExposePresets();
    assert.equal(list.presets.length, 1);
    assert.deepEqual(list.presets[0], { id, name: "meta", createdAt: list.presets[0].createdAt, updatedAt: list.presets[0].updatedAt });
    assert.equal(loadExposePreset("nope"), null);
    assert.equal(loadExposePreset(LAST_USED_ID), null); // no last-used yet
  } finally {
    delete process.env.PI_WEB_EXPOSE_PRESETS_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same name upserts (no duplicate); delete works", async () => {
  const dir = makeDir();
  process.env.PI_WEB_EXPOSE_PRESETS_DIR = dir;
  try {
    const first = await saveExposePreset("dup", baseConfig());
    const second = await saveExposePreset("dup", baseConfig({ provider: "portal" }));
    assert.equal(second.id, first.id);
    assert.equal(listExposePresets().presets.length, 1);
    assert.equal(loadExposePreset(first.id)?.provider, "portal");

    assert.equal(deleteExposePreset(first.id), true);
    assert.equal(deleteExposePreset(first.id), false);
    assert.equal(listExposePresets().presets.length, 0);
  } finally {
    delete process.env.PI_WEB_EXPOSE_PRESETS_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("last-used round-trip (incl. empty serviceBasePath) and file permissions", async () => {
  const dir = makeDir();
  process.env.PI_WEB_EXPOSE_PRESETS_DIR = dir;
  try {
    saveLastUsedExpose(baseConfig({ serviceBasePath: "" }));
    await new Promise((r) => setImmediate(r)); // saveLastUsed is fire-and-forget serialized
    const cfg = loadExposePreset(LAST_USED_ID);
    assert.ok(cfg);
    assert.equal(cfg?.provider, "basic");
    assert.equal(cfg?.serviceBasePath, "");
    assert.ok(listExposePresets().lastUsedAt);

    // 0600 on store + key (on platforms supporting chmod)
    if (process.platform !== "win32") {
      const file = join(dir, "expose-presets.json");
      const key = join(dir, ".expose-preset.key");
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(key).mode & 0o777, 0o600);
    }
  } finally {
    delete process.env.PI_WEB_EXPOSE_PRESETS_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent save + last-used do not lose writes", async () => {
  const dir = makeDir();
  process.env.PI_WEB_EXPOSE_PRESETS_DIR = dir;
  try {
    const ops = [];
    for (let i = 0; i < 8; i++) ops.push(saveExposePreset(`plan-${i}`, baseConfig()));
    saveLastUsedExpose(baseConfig());
    await Promise.all(ops);
    await new Promise((r) => setImmediate(r));
    const list = listExposePresets();
    assert.equal(list.presets.length, 8); // all concurrent saves survived
    assert.ok(list.lastUsedAt);
  } finally {
    delete process.env.PI_WEB_EXPOSE_PRESETS_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
