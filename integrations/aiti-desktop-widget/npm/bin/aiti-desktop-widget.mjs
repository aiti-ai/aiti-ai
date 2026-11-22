#!/usr/bin/env node
import { spawn } from "node:child_process";
import { ensureBinary } from "../index.mjs";

try {
  const bin = await ensureBinary();
  const child = spawn(bin, process.argv.slice(2), {
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
  });
  let forwarded = false;
  const forward = (signal) => {
    if (forwarded) return;
    forwarded = true;
    try {
      child.kill(signal);
    } catch {
      /* child already gone */
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => forward(signal));
  }
  child.on("error", (error) => {
    console.error(`aiti-desktop-widget: failed to start native binary: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      try {
        process.kill(process.pid, signal);
        return;
      } catch {
        /* fall through to exit code */
      }
    }
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(`aiti-desktop-widget: ${error.message}`);
  process.exit(1);
}
