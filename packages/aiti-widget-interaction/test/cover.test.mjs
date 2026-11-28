import test from "node:test";
import assert from "node:assert/strict";
import { coverArgs, coverPageUrl } from "../dist/index.js";

test("coverPageUrl carries the style and forwards an explicit page file", () => {
  const url = coverPageUrl({ rect: { x: 0, y: 0, width: 100, height: 100 }, color: "#0a0b0d", opacity: 0.7, pattern: "grid", pageFile: "/tmp/cover.html" });
  // The widget takes `--html <file>[?query]`, so this is a file path plus a query.
  const [file, query] = url.split("?");
  assert.equal(file, "/tmp/cover.html");
  const parsed = new URLSearchParams(query);
  assert.equal(parsed.get("color"), "#0a0b0d");
  assert.equal(parsed.get("opacity"), "0.7");
  assert.equal(parsed.get("pattern"), "grid");

  const defaults = new URLSearchParams(coverPageUrl({ rect: { x: 0, y: 0, width: 1, height: 1 } }).split("?")[1]);
  assert.equal(defaults.get("pattern"), "solid");
  assert.equal(defaults.get("color"), null);
});

test("coverArgs is a click-through, focus-proof, always-on-top window", () => {
  const args = coverArgs({ rect: { x: 120, y: 80, width: 800.4, height: 600.6 }, color: "#000", monitor: { x: 0, y: 0, width: 1366, height: 768 } });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("--width"), "800");
  assert.equal(value("--height"), "601");
  assert.equal(value("--x"), "120");
  assert.equal(value("--y"), "80");
  assert.equal(value("--click-through"), "true");
  assert.equal(value("--focusable"), "false");
  assert.equal(value("--skip-taskbar"), "true");
  assert.equal(value("--always-on-top"), "true");
  assert.equal(value("--all-workspaces"), "true");
  assert.equal(value("--resizable"), "false");
  assert.equal(value("--transparent"), "false"); // opaque by default: no compositor needed
  assert.match(value("--html"), /cover\.html\?/);
  assert.ok(args.includes("--html"));
});

test("coverArgs can opt into an ARGB window", () => {
  const args = coverArgs({ rect: { x: 0, y: 0, width: 10, height: 10 }, transparent: true });
  assert.equal(args[args.indexOf("--transparent") + 1], "true");
});

test("coverArgs clamps the rect into the monitor", () => {
  const args = coverArgs({ rect: { x: 1300, y: 700, width: 400, height: 200 }, monitor: { x: 0, y: 0, width: 1366, height: 768 } });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("--x"), "1300");
  assert.equal(value("--y"), "700");
  assert.equal(value("--width"), "66");
  assert.equal(value("--height"), "68");
});
