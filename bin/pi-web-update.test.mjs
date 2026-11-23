import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOW_SCRIPTS, MANUAL_COMMAND, npmInstallArgs } from "./pi-web-update.js";

test("npmInstallArgs passes an explicit allow-scripts list after the package spec", () => {
  const args = npmInstallArgs("@aiti-ai/pi-web@0.18.0-aiti.1");
  assert.deepEqual(args, [
    "install",
    "-g",
    "@aiti-ai/pi-web@0.18.0-aiti.1",
    `--allow-scripts=${ALLOW_SCRIPTS}`,
  ]);
  // A bare flag would consume the spec (or the next flag) on npm >=11.16.
  assert.ok(!args.includes("--allow-scripts"));
  assert.ok(args[3].startsWith("--allow-scripts="));
  for (const name of ["@aiti-ai/pi-web", "esbuild", "node-pty", "@google/genai", "protobufjs", "unrs-resolver"]) {
    assert.ok(ALLOW_SCRIPTS.split(",").includes(name), `missing ${name} in allowlist`);
  }
  assert.ok(MANUAL_COMMAND.includes(`--allow-scripts=${ALLOW_SCRIPTS}`));
});
