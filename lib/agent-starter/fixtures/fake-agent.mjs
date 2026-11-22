#!/usr/bin/env node
/**
 * Fake agent used by the agent-starter conformance harness.
 *
 * It speaks a deliberately trivial line protocol (see the `cmd` switch below) so
 * the same transcript can be produced through a direct child process and through
 * the detachable wrapper. Not a test file itself (fixtures/ is excluded from the
 * npm test glob).
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.stdout.write("READY\n");
process.stderr.write("BOOT\n");
if (process.argv.includes("--ignore-sigterm")) {
  process.on("SIGTERM", () => { /* keep running: exercises the SIGKILL grace path */ });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    void handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));

async function handle(line) {
  const [cmd, ...rest] = line.split(" ");
  const arg = rest.join(" ");
  if (cmd === "echo") {
    process.stdout.write(`echo:${arg}\n`);
    return;
  }
  if (cmd === "err") {
    process.stderr.write(`err:${arg}\n`);
    return;
  }
  if (cmd === "env") {
    process.stdout.write(`env:${arg}=${process.env[arg] ?? "<unset>"}\n`);
    return;
  }
  if (cmd === "cwd") {
    process.stdout.write(`cwd:${process.cwd()}\n`);
    return;
  }
  if (cmd === "pid") {
    process.stdout.write(`pid:${process.pid}\n`);
    return;
  }
  if (cmd === "big") {
    process.stdout.write(`${"B".repeat(Number(arg) || 1)}\n`);
    return;
  }
  if (cmd === "lines") {
    const count = Number(arg) || 1;
    for (let i = 0; i < count; i += 1) process.stdout.write(`line:${i}\n`);
    return;
  }
  if (cmd === "sleep") {
    await sleep(Number(arg) || 0);
    process.stdout.write("slept\n");
    return;
  }
  if (cmd === "heartbeat") {
    // heartbeat <count> <intervalMs> — emit count lines, then stay silent
    // (keeps running): drives the wrapper idle-reaper's output-reset path.
    const [count, interval] = rest;
    const total = Number(count) || 1;
    const gap = Number(interval) || 100;
    void (async () => {
      for (let i = 0; i < total; i += 1) {
        await sleep(gap);
        process.stdout.write(`beat:${i}\n`);
      }
    })();
    return;
  }
  if (cmd === "exit") {
    process.exit(Number(arg) || 0);
    return;
  }
  if (cmd === "signal") {
    process.kill(process.pid, "SIGTERM");
    return;
  }
  process.stdout.write(`unknown:${cmd}\n`);
}
