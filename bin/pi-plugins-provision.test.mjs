"use strict";

// Tests for bin/pi-plugins-provision.js — the policy matrix runs against stub
// SDK hooks and temp-dir fixtures; the real SDK is never imported here.

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionPiPlugins, manifestFingerprint, npmSourceName } from "./pi-plugins-provision.js";

const MANIFEST = {
  plugins: [
    { pkg: "@aiti-ai/pi-models-combo", version: "0.4.12" },
    { pkg: "@aiti-ai/pi-git-trace", version: "0.1.7" },
    { pkg: "@aiti-ai/pi-web-bridge", version: "0.1.0" },
    {
      pkg: "@aiti-ai/pi-plan-sandbox",
      version: "0.1.7",
      auto: false,
      note: "In development; not auto-provisioned.",
    },
  ],
};

const AUTO_SPECS = [
  "@aiti-ai/pi-models-combo@0.4.12",
  "@aiti-ai/pi-git-trace@0.1.7",
  "@aiti-ai/pi-web-bridge@0.1.0",
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugins-provision-test-"));
}

// Stub SDK hooks: records every call; optional configured sources and
// install behaviors for the P1–P4 matrix.
function makeHooks({ configured = [], installImpl, batchImpl } = {}) {
  const calls = { added: [], removed: [], batch: [], installed: [], progress: null };
  const hooks = {
    agentDir: tmpDir(),
    getConfigured: () => (typeof configured === "function" ? configured() : configured),
    addSource: (source) => calls.added.push(source),
    removeSource: (source) => calls.removed.push(source),
    installBatch: async (specs) => {
      calls.batch.push(specs);
      if (batchImpl) return batchImpl(specs);
    },
    install: async (source) => {
      calls.installed.push(source);
      if (installImpl) return installImpl(source);
    },
    onProgress: (cb) => {
      calls.progress = cb;
    },
  };
  return { hooks, calls };
}

async function run({ manifest = MANIFEST, hooks, env = {}, timeoutMs = 5000, ledger } = {}) {
  const pkgDir = tmpDir();
  const manifestPath = path.join(pkgDir, "pi-plugins.manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const ledgerPath = path.join(hooks.agentDir, "pi-plugins.provision.json");
  if (ledger) fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const lines = [];
  const res = await provisionPiPlugins({
    env: { ...env },
    hooks,
    manifestPath,
    ledgerPath,
    timeoutMs,
    log: (line) => lines.push(line),
  });
  const ledgerAfter = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : null;
  return { res, calls: hooks.__calls ?? hooks, ledger: ledgerAfter, lines, ledgerPath };
}

// run() returns hooks via closure; unwrap once for assertions
// (kept simple: run() already exposes `calls` bound to the same hooks object).

test("npmSourceName parses npm sources", () => {
  assert.equal(npmSourceName("npm:@aiti-ai/pi-models-combo@0.4.12"), "@aiti-ai/pi-models-combo");
  assert.equal(npmSourceName("npm:@aiti-ai/pi-models-combo"), "@aiti-ai/pi-models-combo");
  assert.equal(npmSourceName("npm:pi-mcp-adapter@1.0.0"), "pi-mcp-adapter");
  assert.equal(npmSourceName("/home/user/local-pkg"), undefined);
  assert.equal(npmSourceName("./relative/pkg"), undefined);
  assert.equal(npmSourceName("git:github.com/a/b@v1"), undefined);
});

test("skips entirely on AITI_SKIP_PI_PLUGINS=1", async () => {
  const { hooks, calls } = makeHooks();
  const { res } = await run({ hooks, env: { AITI_SKIP_PI_PLUGINS: "1" } });
  assert.equal(res.skipped, "env");
  assert.deepEqual(calls.added, []);
  assert.deepEqual(calls.batch, []);
});

test("skips when the manifest is missing", async () => {
  const { hooks, calls } = makeHooks();
  const { res } = await run({ hooks, manifest: null });
  assert.equal(res.skipped, "manifest");
  assert.deepEqual(calls.added, []);
});

test("skips when the manifest is invalid (plugins not an array)", async () => {
  const { hooks, calls } = makeHooks();
  const { res } = await run({ hooks, manifest: { plugins: "nope" } });
  assert.equal(res.skipped, "manifest");
});

test("excludes auto:false plugins (plan-sandbox)", async () => {
  const { hooks, calls } = makeHooks();
  const { res, ledger } = await run({ hooks });
  assert.equal(res.changed, true);
  for (const spec of AUTO_SPECS) assert.ok(calls.added.includes(spec), `missing ${spec}`);
  assert.ok(!calls.added.some((s) => s.includes("pi-plan-sandbox")), "plan-sandbox must not be provisioned");
  assert.equal(calls.batch.length, 1);
  assert.deepEqual(calls.batch[0], AUTO_SPECS);
  assert.equal(ledger.lastHash, manifestFingerprint(MANIFEST.plugins.filter((p) => p.auto !== false)));
  assert.equal(Object.keys(ledger.owned).length, 3);
});

test("fingerprint match is a no-op", async () => {
  const { hooks, calls } = makeHooks();
  const ownedMap = {};
  for (const spec of AUTO_SPECS) ownedMap[spec.split("@").slice(0, -1).join("@")] = spec;
  const ledgerSeed = { lastHash: manifestFingerprint(MANIFEST.plugins.filter((p) => p.auto !== false)), owned: ownedMap };
  const { res } = await run({ hooks, ledger: ledgerSeed });
  assert.equal(res.fingerprintMatch, true);
  assert.deepEqual(calls.added, []);
  assert.deepEqual(calls.batch, []);
});

test("P1: an existing npm entry of the same name (any version) is left alone", async () => {
  const { hooks, calls } = makeHooks({ configured: ["npm:@aiti-ai/pi-models-combo@9.9.9"] });
  const { res, ledger, lines } = await run({ hooks });
  assert.ok(!calls.added.includes("@aiti-ai/pi-models-combo@0.4.12"), "user's entry must not be touched");
  assert.ok(calls.added.includes("@aiti-ai/pi-git-trace@0.1.7"));
  assert.ok(res.skipped.some((s) => s.includes("pi-models-combo") && s.includes("already provided")));
  assert.ok(lines.some((l) => l.includes("already provided by settings") && l.includes("pi-models-combo")));
  assert.ok(!ledger.owned["@aiti-ai/pi-models-combo"]);
  assert.deepEqual(calls.batch[0], ["@aiti-ai/pi-git-trace@0.1.7", "@aiti-ai/pi-web-bridge@0.1.0"]);
});

test("P1: an existing local-path entry of the same package name is left alone", async () => {
  const local = tmpDir();
  fs.writeFileSync(path.join(local, "package.json"), JSON.stringify({ name: "@aiti-ai/pi-models-combo" }));
  const { hooks, calls } = makeHooks({ configured: [local] });
  const { res, lines } = await run({ hooks });
  assert.ok(!calls.added.includes("@aiti-ai/pi-models-combo@0.4.12"));
  assert.ok(res.skipped.some((s) => s.includes("already provided") && s.includes(local)));
  assert.ok(lines.some((l) => l.includes("already provided by settings") && l.includes(local)));
});

test("P2: an owned entry removed by the user is not re-added", async () => {
  const { hooks, calls } = makeHooks();
  const owned = { "@aiti-ai/pi-models-combo": "@aiti-ai/pi-models-combo@0.4.12" };
  const { res } = await run({ hooks, ledger: { owned } });
  assert.ok(!calls.added.some((s) => s.includes("pi-models-combo")));
  assert.ok(res.skipped.some((s) => s.includes("removed by user") && s.includes("pi-models-combo")));
  // Others still provision.
  assert.ok(calls.added.includes("@aiti-ai/pi-git-trace@0.1.7"));
});

test("P3: owned npm entry follows a new pin (remove old + add new + reinstall)", async () => {
  const { hooks, calls } = makeHooks({ configured: ["npm:@aiti-ai/pi-models-combo@0.4.11"] });
  const owned = { "@aiti-ai/pi-models-combo": "@aiti-ai/pi-models-combo@0.4.11" };
  const manifest = {
    plugins: [
      { pkg: "@aiti-ai/pi-models-combo", version: "0.4.12" },
      { pkg: "@aiti-ai/pi-git-trace", version: "0.1.7" },
      { pkg: "@aiti-ai/pi-web-bridge", version: "0.1.0" },
    ],
  };
  const { res, ledger } = await run({ hooks, ledger: { owned }, manifest });
  assert.deepEqual(calls.removed, ["npm:@aiti-ai/pi-models-combo@0.4.11"]);
  assert.ok(calls.added.includes("@aiti-ai/pi-models-combo@0.4.12"));
  assert.ok(calls.batch[0].includes("@aiti-ai/pi-models-combo@0.4.12"));
  assert.equal(ledger.owned["@aiti-ai/pi-models-combo"], "@aiti-ai/pi-models-combo@0.4.12");
  assert.equal(res.failed.length, 0);
});

test("P3: owned entry replaced by a user's local copy → ownership dropped, no touch", async () => {
  const local = tmpDir();
  fs.writeFileSync(path.join(local, "package.json"), JSON.stringify({ name: "@aiti-ai/pi-models-combo" }));
  const { hooks, calls } = makeHooks({ configured: [local] });
  const owned = { "@aiti-ai/pi-models-combo": "@aiti-ai/pi-models-combo@0.4.11" };
  const { ledger } = await run({ hooks, ledger: { owned } });
  assert.deepEqual(calls.removed, []);
  assert.ok(!calls.added.includes("@aiti-ai/pi-models-combo@0.4.12"));
  assert.ok(!ledger.owned["@aiti-ai/pi-models-combo"], "stale ownership must be dropped");
});

test("batch failure falls back to per-plugin installs; failures recorded but declarations kept", async () => {
  const installedFallback = [];
  const { hooks, calls } = makeHooks({
    batchImpl: () => {
      throw new Error("registry unreachable");
    },
    installImpl: (source) => {
      if (source.includes("pi-web-bridge")) throw new Error("network down");
      installedFallback.push(source);
    },
  });
  const { res, ledger, lines } = await run({ hooks });
  assert.deepEqual(installedFallback.sort(), ["@aiti-ai/pi-git-trace@0.1.7", "@aiti-ai/pi-models-combo@0.4.12"]);
  assert.deepEqual(res.failed, ["@aiti-ai/pi-web-bridge@0.1.0"]);
  // Declarations survive the failure — pi's own reconcile retries later.
  assert.equal(Object.keys(ledger.owned).length, 3);
  assert.ok(lines.some((l) => l.includes("falling back to per-plugin installs")));
});

test("install timeout does not block and keeps declarations", async () => {
  let releaseBatch;
  const gate = new Promise((resolve) => {
    releaseBatch = resolve;
  });
  const { hooks, calls } = makeHooks({ batchImpl: () => gate });
  const { res, ledger, lines } = await run({ hooks, timeoutMs: 50 });
  assert.equal(res.failed.length, 0);
  assert.equal(Object.keys(ledger.owned).length, 3);
  assert.ok(lines.some((l) => l.includes("continuing in the background")));
  releaseBatch(); // let the background install settle; guarded catch absorbs it
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.batch.length, 1);
});

test("AITI_PI_PLUGINS_REGISTRY overrides npm_config_registry", async () => {
  const prev = process.env.npm_config_registry;
  try {
    const { hooks } = makeHooks();
    await run({ hooks, env: { AITI_PI_PLUGINS_REGISTRY: "https://registry.example.com" } });
    assert.equal(process.env.npm_config_registry, "https://registry.example.com");
  } finally {
    if (prev === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = prev;
  }
});

test("progress callback emits start/complete log lines via the SDK events", async () => {
  const { hooks, calls } = makeHooks({
    batchImpl: async (specs) => {
      calls.progress({ type: "start", action: "install", source: specs[0] });
      calls.progress({ type: "complete", action: "install", source: specs[0] });
    },
  });
  const { lines } = await run({ hooks });
  assert.ok(lines.some((l) => l.includes("Installing pi plugin(s)")));
  assert.ok(lines.some((l) => l.includes("Installed pi plugin(s)")));
});
