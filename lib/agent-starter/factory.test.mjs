import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_AGENT_STARTER_DIR = mkdtempSync(join(tmpdir(), "pi-starter-factory-"));
process.env.PI_AGENT_STARTER_RUNNER = "plain";

const {
  detachDisabledByEnv,
  getAgentStarters,
  resetAgentStartersForTest,
  selectStarter,
} = await import("./index.ts");
const { DirectStarter } = await import("./direct.ts");

test("selectStarter: detaching is opt-in and switchable per session", async () => {
  const starters = await getAgentStarters();
  assert.ok(starters.wrapper, `wrapper strategy expected (detail: ${starters.detail})`);
  const wrapper = starters.wrapper;

  // A provider that never opted in gets the historical direct strategy, even
  // though a wrapper is available.
  assert.equal(selectStarter(starters, { providerDetachable: undefined }), starters.direct);
  assert.equal(selectStarter(starters, { providerDetachable: false }), starters.direct);
  // Opted in → wrapper.
  assert.equal(selectStarter(starters, { providerDetachable: true }), wrapper);
  // Session-level opt-out wins over the provider opt-in.
  assert.equal(selectStarter(starters, { providerDetachable: true, detach: false }), starters.direct);
});

test("PI_WEB_AGENT_DETACH=0 disables the wrapper family for everyone", async () => {
  const previous = process.env.PI_WEB_AGENT_DETACH;
  process.env.PI_WEB_AGENT_DETACH = "0";
  resetAgentStartersForTest();
  try {
    assert.equal(detachDisabledByEnv(), true);
    const starters = await getAgentStarters();
    assert.equal(starters.wrapper, undefined);
    assert.match(starters.detail, /PI_WEB_AGENT_DETACH/);
    assert.equal(selectStarter(starters, { providerDetachable: true }).kind, "direct");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_AGENT_DETACH;
    else process.env.PI_WEB_AGENT_DETACH = previous;
    resetAgentStartersForTest();
  }
});

test("forced runner selection reaches the wrapper strategy", async () => {
  const previous = process.env.PI_AGENT_STARTER_RUNNER;
  process.env.PI_AGENT_STARTER_RUNNER = "systemd";
  resetAgentStartersForTest();
  try {
    const starters = await getAgentStarters();
    assert.ok(starters.wrapper);
    assert.equal(starters.wrapper.runner, "systemd-run");
  } finally {
    process.env.PI_AGENT_STARTER_RUNNER = previous;
    resetAgentStartersForTest();
  }
});

test("direct starter is the plain node spawn (no marker, no registry)", async () => {
  const direct = new DirectStarter();
  assert.equal(direct.kind, "direct");
  const child = await direct.spawn(process.execPath, ["-e", "process.exit(0)"], {});
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(child.exitCode, 0);
  assert.equal("detachable" in child, false);
});

test("windows runner: Win32_Process.Create is selected on win32", async () => {
  const { probeRunner } = await import("./runner.ts");
  const saved = process.platform;
  const savedRunner = process.env.PI_AGENT_STARTER_RUNNER;
  delete process.env.PI_AGENT_STARTER_RUNNER; // the file forces "plain"; the platform rule needs the default path
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const probe = await probeRunner();
    assert.equal(probe.kind, "windows-cim", "Windows must not fall back to a console-tied detached spawn");
    assert.match(probe.detail, /Win32_Process/);
  } finally {
    Object.defineProperty(process, "platform", { value: saved, configurable: true });
    if (savedRunner === undefined) delete process.env.PI_AGENT_STARTER_RUNNER;
    else process.env.PI_AGENT_STARTER_RUNNER = savedRunner;
    resetAgentStartersForTest();
  }
});
