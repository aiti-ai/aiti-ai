/**
 * server/open-in-file-manager.test.mjs — the "reveal in the OS file manager" command builder.
 *
 * The spawn side cannot be exercised here (it would raise real windows), so the contract pinned
 * down is the part that decides what gets spawned: per-platform command, the entry-vs-folder
 * split, the WSL path translation, and the refusal on a platform without a file manager.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  desktopEnv,
  fileManagerCommand,
  launchFileManager,
  windowsPathForWsl,
  wslDistroName,
} from "./open-in-file-manager.ts";

test("opens a folder with the platform's file manager", () => {
  assert.deepEqual(fileManagerCommand("win32", "D:\\work", true), { command: "explorer.exe", args: ["D:\\work"] });
  assert.deepEqual(fileManagerCommand("darwin", "/work", true), { command: "open", args: ["/work"] });
  assert.deepEqual(fileManagerCommand("linux", "/work", true), { command: "xdg-open", args: ["/work"] });
});

test("reveals an entry: Windows selects it, macOS reveals it, Linux has no select verb", () => {
  assert.deepEqual(fileManagerCommand("win32", "D:\\work\\a.ts", false), {
    command: "explorer.exe",
    args: ["/select,D:\\work\\a.ts"],
  });
  assert.deepEqual(fileManagerCommand("darwin", "/work/a.ts", false), { command: "open", args: ["-R", "/work/a.ts"] });
  // xdg-open cannot select, so the containing folder is what it opens.
  assert.deepEqual(fileManagerCommand("linux", "/work/a.ts", false), { command: "xdg-open", args: ["/work"] });
});

test("reports platforms without a file manager", () => {
  assert.equal(fileManagerCommand("aix", "/work", true), null);
});

test("translates WSL paths to their Windows spelling", () => {
  assert.equal(windowsPathForWsl("/mnt/c/dev", "Ubuntu"), "C:\\dev");
  assert.equal(windowsPathForWsl("/mnt/d/", "Ubuntu"), "D:\\");
  assert.equal(windowsPathForWsl("/home/wind/work", "Ubuntu"), "\\\\wsl$\\Ubuntu\\home\\wind\\work");
  assert.equal(windowsPathForWsl("/", "Ubuntu"), "\\\\wsl$\\Ubuntu\\");
});

test("reads the WSL distro name from the environment", () => {
  assert.equal(wslDistroName({ WSL_DISTRO_NAME: " Ubuntu " }), "Ubuntu");
  assert.equal(wslDistroName({}), "");
});

test("non-Linux platforms need no desktop session probing", () => {
  assert.deepEqual(desktopEnv("win32"), {});
  assert.deepEqual(desktopEnv("darwin"), {});
});

test("refuses to launch on a platform without a file manager", async () => {
  await assert.rejects(
    launchFileManager("/work", true, { platform: "aix", env: {} }),
    /no file manager on platform aix/,
  );
});
