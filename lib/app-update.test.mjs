import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getPiWebReleaseUrl, isNewerStableVersion } = await jiti.import("./app-update.ts");

test("detects newer stable Pi Web versions", () => {
  assert.equal(isNewerStableVersion("0.8.8", "0.8.7"), true);
  assert.equal(isNewerStableVersion("0.9.0", "0.8.7"), true);
  assert.equal(isNewerStableVersion("1.0.0", "0.9.9"), true);
});

test("does not report equal, older, or unsupported versions as updates", () => {
  assert.equal(isNewerStableVersion("0.8.7", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.6", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.8-beta.1", "0.8.7"), false);
  assert.equal(isNewerStableVersion("invalid", "0.8.7"), false);
});

test("builds a release link only for stable versions", () => {
  assert.equal(
    getPiWebReleaseUrl("0.8.8"),
    "https://www.npmjs.com/package/@aiti-ai/pi-web/v/0.8.8",
  );
  assert.equal(getPiWebReleaseUrl("0.8.8-beta.1"), null);
});

test("fork build suffix (-aiti.N): dpkg-style ordering — suffix beats bare same core", () => {
  assert.equal(isNewerStableVersion("0.16.0-aiti.1", "0.16.0"), true);
  assert.equal(isNewerStableVersion("0.16.0", "0.16.0-aiti.1"), false);
  assert.equal(isNewerStableVersion("0.16.0-aiti.2", "0.16.0-aiti.1"), true);
  assert.equal(isNewerStableVersion("0.16.0-aiti.1", "0.16.0-aiti.1"), false);
});

test("fork build suffix: upstream core dominates; link keeps the full fork version", () => {
  assert.equal(isNewerStableVersion("0.16.0-aiti.1", "0.15.9"), true);
  assert.equal(isNewerStableVersion("0.16.1", "0.16.0-aiti.3"), true);
  assert.equal(isNewerStableVersion("0.16.0-aiti.3", "0.16.1"), false);
  assert.equal(
    getPiWebReleaseUrl("0.16.0-aiti.1"),
    "https://www.npmjs.com/package/@aiti-ai/pi-web/v/0.16.0-aiti.1",
  );
});
