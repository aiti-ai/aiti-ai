/**
 * aiti-extman dual-source update check — merge matrix unit tests.
 *
 * Pinned behaviour (see docs/aiti-extman-dual-source-update-check.md):
 *   npm x aiti.pw registry are compared independently, newest wins, origin reported;
 *   a registry-only advance must never offer an npm install (it would install the old
 *   version) and must never hide a newer npm release behind a stale catalog.
 *
 * Run: node --test extensions/aiti-extman/updates.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// updates-merge.ts is loaded through jiti (same transformer the host uses for .ts
// extension code), so the test needs neither a build step nor a deployment directory.
const jiti = createJiti(import.meta.url);
const { isSemver, mergeUpdateSources, semverGt } = await jiti.import("./updates-merge.ts");

test("semver compare handles plain, v-prefixed and prerelease versions", () => {
  assert.equal(semverGt("0.4.1", "0.4.0"), true);
  assert.equal(semverGt("v0.4.0", "0.4.0"), false);
  assert.equal(semverGt("1.0.0", "1.0.0-alpha"), true);
  assert.equal(semverGt("1.0.0-alpha.2", "1.0.0-alpha.1"), true);
  assert.equal(semverGt("1.0.0-alpha", "1.0.0-beta"), false);
  assert.equal(semverGt("not-a-version", "1.0.0"), false);
  assert.equal(isSemver("1.2.3"), true);
  assert.equal(isSemver("v1.2.3-beta.1+build"), true);
  assert.equal(isSemver("^1.2.3"), false);
  assert.equal(isSemver(null), false);
});

test("npm ahead: npm source wins and is installable", () => {
  const e = mergeUpdateSources({
    id: "x",
    pkg: "@aiti-ai/x",
    installed: "0.1.0",
    npmLatest: "0.2.0",
    registryVersion: "0.1.5",
    registryDocsUrl: "https://aiti.pw/x.html",
  });
  assert.equal(e.state, "update-available");
  assert.equal(e.source, "npm");
  assert.equal(e.latest, "0.2.0");
  assert.equal(e.installable, "npm:@aiti-ai/x");
  assert.equal(e.npm.hasUpdate, true);
  assert.equal(e.registry.hasUpdate, true);
});

test("registry ahead of npm: unpublished, no npm install button", () => {
  const e = mergeUpdateSources({
    id: "x",
    pkg: "@aiti-ai/x",
    installed: "0.1.0",
    npmLatest: "0.1.0",
    registryVersion: "0.2.0",
  });
  assert.equal(e.state, "unpublished");
  assert.equal(e.source, "registry");
  assert.equal(e.latest, "0.2.0");
  assert.equal(e.installable, null);
  assert.match(e.message, /aiti\.pw lists v0\.2\.0/);
});

test("registry ahead while npm also moved: still unpublished (npm cannot reach it)", () => {
  const e = mergeUpdateSources({
    id: "x",
    pkg: "@aiti-ai/x",
    installed: "0.1.0",
    npmLatest: "0.1.5",
    registryVersion: "0.2.0",
  });
  assert.equal(e.state, "unpublished");
  assert.equal(e.installable, null);
  assert.match(e.message, /npm serves v0\.1\.5/);
});

test("both sources agree: source=both, up to date once installed catches up", () => {
  const up = mergeUpdateSources({ id: "x", pkg: "x", installed: "0.1.0", npmLatest: "0.2.0", registryVersion: "0.2.0" });
  assert.equal(up.source, "both");
  assert.equal(up.state, "update-available");
  assert.equal(up.installable, "npm:x");

  const ok = mergeUpdateSources({ id: "x", pkg: "x", installed: "0.2.0", npmLatest: "0.2.0", registryVersion: "0.2.0" });
  assert.equal(ok.state, "up-to-date");
  assert.equal(ok.hasUpdate, false);
});

test("install newer than both sources: local-ahead, no update", () => {
  const e = mergeUpdateSources({ id: "x", pkg: "x", installed: "0.3.0", npmLatest: "0.2.0", registryVersion: "0.2.0" });
  assert.equal(e.state, "local-ahead");
  assert.equal(e.hasUpdate, false);
  assert.equal(e.localAhead, true);
});

test("stale registry (older than npm) never masks a newer npm release", () => {
  const e = mergeUpdateSources({ id: "x", pkg: "x", installed: "0.1.0", npmLatest: "0.2.0", registryVersion: "0.0.9" });
  assert.equal(e.hasUpdate, true);
  assert.equal(e.source, "npm");
  assert.equal(e.installable, "npm:x");
});

test("git install with advanced remote: update via git, not npm", () => {
  const e = mergeUpdateSources({
    id: "x",
    pkg: "x",
    installed: "0.1.0",
    npmLatest: "0.1.0",
    registryVersion: "0.1.0",
    git: { head: "aaaaaaa1", remote: "bbbbbbb2" },
    gitSource: "https://github.com/owner/repo",
  });
  assert.equal(e.state, "update-available");
  assert.equal(e.hasUpdate, true);
  assert.equal(e.installable, "git:https://github.com/owner/repo");
  assert.equal(e.latest, "0.1.0");
  assert.equal(e.git.hasUpdate, true);
});

test("git install with registry ahead: git source is installable, not unpublished", () => {
  const e = mergeUpdateSources({
    id: "x",
    pkg: "x",
    installed: "0.1.0",
    npmLatest: "0.1.0",
    registryVersion: "0.2.0",
    git: { head: "aaaaaaa1", remote: "aaaaaaa1" },
    gitSource: "git:https://github.com/owner/repo",
  });
  assert.equal(e.state, "update-available");
  assert.equal(e.installable, "git:https://github.com/owner/repo");
});

test("npm failure with no other source is an error, not a silent up-to-date", () => {
  const e = mergeUpdateSources({ id: "x", pkg: "x", installed: "0.1.0", npmLatest: null, npmError: "ENOTFOUND" });
  assert.equal(e.state, "error");
  assert.match(e.message, /npm lookup failed/);
});

test("no npm name and no git source: unsupported with a reason", () => {
  const e = mergeUpdateSources({ id: "x", pkg: null, installed: "0.1.0" });
  assert.equal(e.state, "unsupported");
  assert.match(e.message, /cannot check/);
});

test("registry-only phase reports unknown instead of claiming up to date", () => {
  const e = mergeUpdateSources({ id: "x", pkg: "x", installed: "0.1.0", registryVersion: "0.1.0", partial: true });
  assert.equal(e.state, "unknown");
  assert.equal(e.hasUpdate, false);
  assert.equal(e.localAhead, false);

  const older = mergeUpdateSources({ id: "x", pkg: "x", installed: "0.3.0", registryVersion: "0.2.0", partial: true });
  assert.equal(older.state, "unknown");
  assert.equal(older.localAhead, false);

  const ahead = mergeUpdateSources({ id: "x", pkg: "x", installed: "0.1.0", registryVersion: "0.2.0", partial: true });
  assert.equal(ahead.state, "update-available");
  assert.equal(ahead.latest, "0.2.0");
});

test("PI_OFFLINE short-circuits every verdict to error", () => {
  const e = mergeUpdateSources({ id: "x", pkg: "x", installed: "0.1.0", npmLatest: "0.2.0", offline: true });
  assert.equal(e.state, "error");
  assert.match(e.message, /PI_OFFLINE/);
});

test("registry npm name is used when the install declares none", () => {
  const e = mergeUpdateSources({
    id: "x",
    pkg: null,
    installed: "0.1.0",
    npmLatest: "0.2.0",
    registryNpm: "@aiti-ai/x",
  });
  assert.equal(e.installable, "npm:@aiti-ai/x");
  assert.equal(e.hasUpdate, true);
});

test("installed version unavailable: unsupported, never a false positive", () => {
  const e = mergeUpdateSources({ id: "x", pkg: "x", installed: null, npmLatest: "0.2.0" });
  assert.equal(e.state, "unsupported");
  assert.equal(e.hasUpdate, false);
});
