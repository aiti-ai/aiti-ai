"use strict";

// pi-plugins-provision.js — register the bundled first-party pi plugins
// (@aiti-ai/pi-models-combo / pi-git-trace / pi-web-bridge) in the user's pi
// settings via the official package manager, so the very same declarations are
// shared by the pi TUI, pi-web RPC sessions and spawned pi CLI sessions.
//
// Semantics (v4):
// - Runs in the `pi-web start` flow (npm / npx / Docker entries). Maintainer
//   machines manage their plugin copies manually and never go through bin/.
// - npm runs only when needed: first startup (nothing owned yet) or when the
//   manifest pins change (main package upgrade). Every other startup is a
//   fingerprint no-op.
// - Declarations are persisted BEFORE installing (opposite of the official
//   `pi install` order on purpose): when the install fails (offline, registry
//   unreachable) the declaration survives and pi's own startup reconcile
//   retries the install later — the official self-healing path.
// - The provisioner never touches entries it does not own:
//   * an entry that resolves to the same package name (npm: source of any
//     version, or a local path whose package.json name matches) is left alone;
//   * an owned entry the user removed is not re-added until the pins change;
//   * an owned npm entry is rewritten only to follow a new pin (upgrade).
// - plan-sandbox ships in the manifest with auto:false (in development) and is
//   never auto-provisioned.
//
// Env:
// - AITI_SKIP_PI_PLUGINS=1    skip entirely (CI / offline / opt-out)
// - AITI_PI_PLUGINS_REGISTRY  npm registry override for the installs
//
// CLI (Docker build bake): node bin/pi-plugins-provision.js [--pkg-dir <dir>]

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const LEDGER_NAME = "pi-plugins.provision.json";
const MANIFEST_NAME = "pi-plugins.manifest.json";
const DEFAULT_TIMEOUT_MS = 60_000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function manifestFingerprint(plugins) {
  const hash = createHash("sha256");
  for (const p of [...plugins].sort((a, b) => (a.pkg < b.pkg ? -1 : 1))) {
    hash.update(`${p.pkg}@${p.version}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

// "npm:@scope/name@1.2.3" → "@scope/name"; "npm:name@1.2.3" → "name".
// Anything that is not an npm: source returns undefined.
function npmSourceName(source) {
  if (typeof source !== "string" || !source.startsWith("npm:")) return undefined;
  const s = source.slice(4);
  const at = s.lastIndexOf("@");
  return at > 0 ? s.slice(0, at) : s;
}

// Local path entry → the package name declared in its package.json (relative
// entries resolve from the settings directory, i.e. the agent dir). Unreadable
// paths return undefined and are treated as unknown, never matched.
function localSourceName(source, baseDir) {
  if (typeof source !== "string") return undefined;
  if (!(path.isAbsolute(source) || source.startsWith("./") || source.startsWith("../"))) {
    return undefined;
  }
  const resolved = path.isAbsolute(source) ? source : path.resolve(baseDir, source);
  const pkg = readJson(path.join(resolved, "package.json"));
  return pkg && typeof pkg.name === "string" ? pkg.name : undefined;
}

// Real SDK facade. The SDK is ESM-only, hence the dynamic import (bin stays CJS).
// Loaded lazily so tests can inject a stub via options.hooks without the SDK.
async function loadSdkFacade() {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const agentDir = sdk.getAgentDir();
  const settingsManager = sdk.SettingsManager.create(agentDir, agentDir);
  const pm = new sdk.DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager });
  return {
    agentDir,
    getConfigured: () => {
      const packages = settingsManager.getGlobalSettings()?.packages;
      if (!Array.isArray(packages)) return [];
      return packages
        .map((p) => (typeof p === "string" ? p : p && typeof p.source === "string" ? p.source : null))
        .filter(Boolean);
    },
    addSource: (source) => pm.addSourceToSettings(source),
    removeSource: (source) => pm.removeSourceFromSettings(source),
    installBatch: (specs) => pm.installNpmBatch(specs, "user"),
    install: (source) => pm.install(source),
    onProgress: (cb) => pm.setProgressCallback(cb),
  };
}

// Run an install step with a startup timeout: on timeout the step keeps
// running in the background (declarations are already persisted, pi's own
// reconcile self-heals) while `pi-web start` proceeds to boot the server.
async function runInstallStep(fn, timeoutMs, log) {
  const guarded = (async () => {
    await fn();
    return { done: true };
  })().catch((error) => ({ error }));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
  });
  try {
    const out = await Promise.race([guarded, timeout]);
    if (out && out.timeout) {
      log(`[pi-web] pi plugins install exceeded ${Math.round(timeoutMs / 1000)}s — continuing in the background, startup proceeds`);
      return { timeout: true };
    }
    if (out && out.error) throw out.error;
    return { done: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provision the bundled pi plugins. Never throws for expected conditions
 * (missing manifest, offline installs); unexpected errors propagate to the
 * caller, which is expected to warn and continue startup.
 *
 * @param {object} [options]
 * @param {string} [options.pkgDir]        main package dir (manifest location)
 * @param {object} [options.env]           process env (default process.env)
 * @param {(line: string) => void} [options.log]
 * @param {number} [options.timeoutMs]     per-step install timeout (default 60s)
 * @param {object} [options.hooks]         SDK seam for tests
 * @param {string} [options.manifestPath]  override manifest location (tests)
 * @param {string} [options.ledgerPath]    override ledger location (tests)
 * @returns {Promise<object>} summary {ran, changed, provisioned, failed, fingerprintMatch, skipped}
 */
async function provisionPiPlugins(options = {}) {
  const {
    pkgDir = path.join(__dirname, ".."),
    env = process.env,
    log = (line) => process.stderr.write(`${line}\n`),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (env.AITI_SKIP_PI_PLUGINS === "1") return { skipped: "env" };

  if (env.AITI_PI_PLUGINS_REGISTRY) {
    // The SDK spawns npm as a child process; npm reads the registry from env.
    process.env.npm_config_registry = env.AITI_PI_PLUGINS_REGISTRY;
  }

  const manifest = readJson(options.manifestPath || path.join(pkgDir, MANIFEST_NAME));
  const plugins = Array.isArray(manifest?.plugins)
    ? manifest.plugins.filter((p) => p && typeof p.pkg === "string" && typeof p.version === "string")
    : null;
  if (!plugins) {
    log("[pi-web] pi plugins manifest missing or invalid — skipping provision");
    return { skipped: "manifest" };
  }
  const auto = plugins.filter((p) => p.auto !== false);
  if (auto.length === 0) return { skipped: "empty" };

  const hooks = options.hooks || (await loadSdkFacade());
  const ledgerPath = options.ledgerPath || path.join(hooks.agentDir, LEDGER_NAME);
  const ledger = readJson(ledgerPath);
  const fingerprint = manifestFingerprint(auto);
  if (ledger && ledger.lastHash === fingerprint) return { fingerprintMatch: true, ran: false };

  const owned = ledger && ledger.owned && typeof ledger.owned === "object" ? { ...ledger.owned } : {};
  const configured = hooks.getConfigured() || [];
  const nameToSource = new Map();
  for (const source of configured) {
    const name = npmSourceName(source) || localSourceName(source, hooks.agentDir) || null;
    if (name && !nameToSource.has(name)) nameToSource.set(name, source);
  }

  const declared = []; // {name, spec} — declarations to persist (P4 add / P3 rewrite)
  const skipped = [];
  for (const p of auto) {
    const spec = `${p.pkg}@${p.version}`;
    const existing = nameToSource.get(p.pkg);
    if (existing) {
      const existingIsNpm = Boolean(npmSourceName(existing));
      if (existingIsNpm && owned[p.pkg] && existing !== spec) {
        // P3: our own npm entry, pins moved (main package upgrade) → follow.
        try {
          hooks.removeSource(existing);
        } catch (error) {
          log(`[pi-web] pi plugins: failed to remove stale entry ${existing}: ${error.message}`);
        }
        declared.push({ name: p.pkg, spec });
      } else {
        // P1: already provided (user's entry, any version/local copy) — never touch.
        if (!existingIsNpm && owned[p.pkg]) delete owned[p.pkg]; // user switched to a local copy
        skipped.push(`${p.pkg} (already provided: ${existing})`);
        log(`[pi-web] pi plugins: ${p.pkg} already provided by settings (${existing}) — skipping`);
      }
      continue;
    }
    if (owned[p.pkg]) {
      // P2: we added it before and it is gone — the user removed it; do not re-add.
      skipped.push(`${p.pkg} (removed by user; not re-adding)`);
      log(`[pi-web] pi plugins: ${p.pkg} was removed from settings — not re-adding (delete ${ledgerPath} to restore auto-provision)`);
      continue;
    }
    // P4: fresh.
    declared.push({ name: p.pkg, spec });
  }

  // Persist declarations first: they survive install failures and pi's own
  // startup reconcile retries the install (official self-healing path).
  const failures = [];
  for (const d of declared) {
    try {
      hooks.addSource(d.spec);
      owned[d.name] = d.spec;
    } catch (error) {
      log(`[pi-web] pi plugins: failed to persist declaration ${d.spec}: ${error.message}`);
      d.failed = true;
      failures.push(d.spec);
    }
  }

  const installSpecs = declared.filter((d) => !d.failed).map((d) => d.spec);
  if (installSpecs.length > 0) {
    hooks.onProgress?.((event) => {
      if (event && event.type === "error") log(`[pi-web] pi plugins: install error for ${event.source}: ${event.message || "unknown"}`);
    });
    log(`[pi-web] Installing pi plugin(s): ${installSpecs.join(", ")} ...`);
    const t0 = Date.now();
    let outcome;
    try {
      outcome = await runInstallStep(() => hooks.installBatch(installSpecs), timeoutMs, log);
    } catch (batchError) {
      log(`[pi-web] pi plugins batch install failed (${batchError.message}); falling back to per-plugin installs`);
      outcome = { done: false };
    }
    if (outcome.timeout) {
      // Declarations stay; pi's reconcile finishes the install later.
    } else if (!outcome.done) {
      for (const spec of installSpecs) {
        try {
          await runInstallStep(() => hooks.install(spec), timeoutMs, log);
        } catch (error) {
          log(`[pi-web] pi plugins: failed to install ${spec} (declaration kept; pi will retry on next start): ${error.message}`);
          failures.push(spec);
        }
      }
    }
    if (!outcome.timeout && outcome.done) {
      log(`[pi-web] Installed pi plugin(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  }

  writeJsonAtomic(ledgerPath, { lastHash: fingerprint, owned });

  return {
    ran: true,
    changed: declared.length > 0,
    provisioned: declared.map((d) => d.spec),
    failed: failures,
    skipped,
    fingerprintMatch: false,
  };
}

module.exports = { provisionPiPlugins, MANIFEST_NAME, LEDGER_NAME, npmSourceName, localSourceName, manifestFingerprint };

if (require.main === module) {
  const args = process.argv.slice(2);
  let pkgDir = path.join(__dirname, "..");
  const i = args.indexOf("--pkg-dir");
  if (i >= 0 && args[i + 1]) pkgDir = path.resolve(args[i + 1]);
  provisionPiPlugins({ pkgDir })
    .then((res) => {
      if (res.fingerprintMatch) console.log("[pi-web] pi plugins already provisioned (fingerprint match)");
      else if (res.changed) console.log(`[pi-web] pi plugins provisioned: ${res.provisioned.join(", ")}`);
      if (res.failed?.length) {
        console.error(`[pi-web] pi plugins install failures: ${res.failed.join(", ")}`);
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(`[pi-web] pi plugins provision failed: ${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    });
}
