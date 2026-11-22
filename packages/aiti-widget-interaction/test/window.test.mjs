import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractionWidgetWindow } from "../dist/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("window keeps the shell's stderr for diagnostics", { skip: process.platform === "win32" ? "posix shell script fixture" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "widget-window-test-"));
  const fake = join(dir, "fake-widget.sh");
  // `exec` so kill() reaches the long-running child instead of leaving it holding the pipes.
  writeFileSync(fake, '#!/bin/sh\necho "fake widget: page failed to load" >&2\nexec sleep 30\n');
  chmodSync(fake, 0o755);
  const win = new InteractionWidgetWindow({ bin: fake, width: 300, height: 200, title: "fake" });
  try {
    assert.equal(await win.open("http://127.0.0.1:9/x"), true);
    await sleep(300);
    assert.match(win.stderr, /fake widget: page failed to load/);
  } finally {
    await win.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
