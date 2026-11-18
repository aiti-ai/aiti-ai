// Unit tests for service port discovery (esbuild-bundles src/port-scan.ts, then imports it).
// Run: node --test test/port-scan.test.mjs
// 2026-11-14 regression pin: the old deriveRoot regex /code|electron/i never matched VS Code
// forks (Qoder.exe/Cursor.exe/... contain neither) -> root=undefined -> discovery always empty
// -> no port candidates, no injection. anchorIdeRoot anchors on the host's own exe name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
esbuild.buildSync({
  entryPoints: ["src/port-scan.ts"],
  outdir: "dist-test",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  logLevel: "silent",
});

const { anchorIdeRoot } = await import("../dist-test/port-scan.js");

function forkTable(forkExe) {
  // explorer -> fork main process -> fork ext host -> powershell -> node (dev server)
  return new Map([
    [10, { ppid: 1, name: "explorer.exe", cmdline: "" }],
    [100, { ppid: 10, name: forkExe, cmdline: `"${forkExe}"` }],
    [200, { ppid: 100, name: forkExe, cmdline: "--type=utility node.mojom.NodeService" }],
    [300, { ppid: 200, name: forkExe, cmdline: "--inspect-port=0 --type=extensionHost" }],
    [400, { ppid: 300, name: "powershell.exe", cmdline: "powershell" }],
    [500, { ppid: 400, name: "node.exe", cmdline: "node vite" }],
  ]);
}

test("Qoder.exe fork: anchors the main process, not the ext host (old-regex regression pin)", () => {
  const t = forkTable("Qoder.exe");
  assert.equal(anchorIdeRoot(t, "Qoder.exe", 300), 100);
});

test("Cursor.exe / Windsurf.exe / Trae.exe forks behave the same", () => {
  for (const exe of ["Cursor.exe", "Windsurf.exe", "Trae.exe"]) {
    assert.equal(anchorIdeRoot(forkTable(exe), exe, 300), 100, exe);
  }
});

test("Code.exe (real VS Code) behavior unchanged", () => {
  assert.equal(anchorIdeRoot(forkTable("Code.exe"), "Code.exe", 300), 100);
});

test("broken ancestor chain (parent exited) -> anchors last visible ancestor", () => {
  const t = new Map([
    [100, { ppid: 999, name: "Qoder.exe", cmdline: "" }], // 999 not in the table
    [300, { ppid: 100, name: "Qoder.exe", cmdline: "" }],
  ]);
  assert.equal(anchorIdeRoot(t, "Qoder.exe", 300), 100);
});

test("host not in any IDE tree (bare node) -> undefined", () => {
  const t = new Map([
    [300, { ppid: 10, name: "node.exe", cmdline: "" }],
    [10, { ppid: 1, name: "explorer.exe", cmdline: "" }],
  ]);
  assert.equal(anchorIdeRoot(t, "Qoder.exe", 300), undefined);
});

test("highest same-name ancestor wins (multiple windows, same exe/tree)", () => {
  const t = new Map([
    [10, { ppid: 1, name: "explorer.exe", cmdline: "" }],
    [50, { ppid: 10, name: "Qoder.exe", cmdline: "" }],
    [300, { ppid: 50, name: "Qoder.exe", cmdline: "" }],
  ]);
  assert.equal(anchorIdeRoot(t, "Qoder.exe", 300), 50);
});

test("case-insensitive exe name matching", () => {
  const t = new Map([
    [100, { ppid: 1, name: "QODER.EXE", cmdline: "" }],
    [300, { ppid: 100, name: "qoder.exe", cmdline: "" }],
  ]);
  assert.equal(anchorIdeRoot(t, "Qoder.exe", 300), 100);
});
