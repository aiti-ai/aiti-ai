import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/aiti-dialog.mjs", import.meta.url));

function run(args, { timeoutMs = 15000 } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: "TIMEOUT", stdout, stderr }); }, timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test("unknown kind exits 2", async () => {
  const result = await run(["bogus"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /expected one of/);
});

test("choose without options exits 2", async () => {
  const result = await run(["choose", "--text", "Pick"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /requires --options/);
});

test("--timeout maps to zenity exit 5", async () => {
  const result = await run(["confirm", "--text", "Timeout?", "--no-window", "--timeout", "0.2", "--json"]);
  assert.equal(result.code, 5);
  const envelope = JSON.parse(result.stdout.trim());
  assert.equal(envelope.status, "timeout");
  assert.equal(envelope.timeoutMs, 200);
});

test("--version prints the package version", async () => {
  const result = await run(["--version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^aiti-dialog \d+\.\d+\.\d+/);
});

test("--page must be loopback", async () => {
  const remote = await run(["custom", "--page", "https://example.com/dialog.html", "--no-window", "--timeout", "0.2"]);
  assert.equal(remote.code, 2);
  assert.match(remote.stderr, /loopback-only/);

  const relative = await run(["custom", "--page", "dialog.html", "--no-window", "--timeout", "0.2"]);
  assert.equal(relative.code, 2);
  assert.match(relative.stderr, /absolute loopback URL/);
});

test("--page appends base and token to a loopback page", async () => {
  const result = await run(["custom", "--page", "http://127.0.0.1:9000/dialog.html?theme=dark", "--no-window", "--timeout", "0.2"]);
  assert.equal(result.code, 5); // nobody answers the headless page
  const match = /aiti-dialog: open (\S+)/.exec(result.stderr);
  assert.ok(match, result.stderr);
  const url = new URL(match[1]);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "9000");
  assert.equal(url.searchParams.get("theme"), "dark");
  assert.match(url.searchParams.get("base"), /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok(url.searchParams.get("token"));
});

function daemon(args) {
  const child = spawn(process.execPath, [BIN, "--daemon", "--no-window", "--port", "0", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  const ready = new Promise((resolveReady, rejectReady) => {
    let buffer = "";
    const timer = setTimeout(() => rejectReady(new Error("daemon did not print its address")), 5000);
    child.stdout.on("data", (data) => {
      buffer += data;
      const line = buffer.split("\n").find((entry) => entry.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      resolveReady(JSON.parse(line));
    });
  });
  return { child, ready, exited };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

test("daemon exits after the idle TTL", async () => {
  const instance = daemon(["--ttl", "0.3"]);
  await instance.ready;
  const code = await instance.exited;
  assert.equal(code, 0);
});

test("daemon restarts the idle TTL on activity", async () => {
  const instance = daemon(["--ttl", "0.5"]);
  const info = await instance.ready;
  try {
    await sleep(350);
    const created = await fetch(`${info.baseUrl}interactions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ kind: "confirm", title: "Activity" }),
    });
    assert.equal(created.status, 200);
    await sleep(350); // 700ms total: past the original deadline, inside the restarted one
    assert.equal(instance.child.exitCode, null);
    const code = await instance.exited; // 350ms + 500ms
    assert.equal(code, 0);
  } finally {
    if (instance.child.exitCode === null) instance.child.kill("SIGKILL");
  }
});
