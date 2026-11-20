// Tests for scripts/check-pi-plugin-pins.mjs — pure decision table + pack closure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrokenImports, parseArgs, planUpdates, resolveRegistry, semverCmp } from "./check-pi-plugin-pins.mjs";

const reg = (versions, latest) => ({ versions: new Set(versions), latest, tarballs: new Map() });

test("parseArgs defaults and validation", () => {
  assert.deepEqual(parseArgs([]), { target: "official", write: false, strict: false, json: false });
  assert.equal(parseArgs(["--target", "staging", "--write", "--strict", "--json"]).target, "staging");
  assert.throws(() => parseArgs(["--target", "aliyun"]), /unknown --target/);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

test("resolveRegistry: official is public, staging needs private config", () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "pins-home-"));
  assert.equal(resolveRegistry("official", {}, emptyHome), "https://registry.npmjs.org/");
  assert.throws(() => resolveRegistry("staging", {}, emptyHome), /staging registry not configured/);
  assert.equal(
    resolveRegistry("staging", { AITI_RELEASE_REDACT: JSON.stringify({ stagingRegistry: "https://npm.example/" }) }, emptyHome),
    "https://npm.example/",
  );
  rmSync(emptyHome, { recursive: true, force: true });
});

test("planUpdates: pin on registry, matching latest and local → ok", () => {
  const rows = planUpdates(
    [{ pkg: "@x/a", version: "1.2.3" }],
    new Map([["@x/a", reg(["1.2.3"], "1.2.3")]]),
    new Map([["@x/a", "1.2.3"]]),
  );
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[0].nextPin, "1.2.3");
});

test("planUpdates: pin missing on the registry → unpublished, next pin = latest", () => {
  const rows = planUpdates(
    [{ pkg: "@x/a", version: "9.9.9" }],
    new Map([["@x/a", reg(["1.2.3"], "1.2.3")]]),
    new Map(),
  );
  assert.equal(rows[0].status, "unpublished");
  assert.equal(rows[0].nextPin, "1.2.3");
});

test("planUpdates: local bump not published yet → pending-release, pin untouched", () => {
  const rows = planUpdates(
    [{ pkg: "@x/a", version: "1.2.2" }],
    new Map([["@x/a", reg(["1.2.2"], "1.2.2")]]),
    new Map([["@x/a", "1.2.3"]]),
  );
  assert.equal(rows[0].status, "pending-release");
  assert.equal(rows[0].nextPin, "1.2.2");
});

test("planUpdates: published local version ahead of the pin → drift to local", () => {
  const rows = planUpdates(
    [{ pkg: "@x/a", version: "1.2.2" }],
    new Map([["@x/a", reg(["1.2.2", "1.2.3"], "1.2.3")]]),
    new Map([["@x/a", "1.2.3"]]),
  );
  assert.equal(rows[0].status, "drift");
  assert.equal(rows[0].nextPin, "1.2.3");
});

test("semverCmp orders releases and prereleases", () => {
  assert.equal(semverCmp("0.1.10", "0.1.9"), 1);
  assert.equal(semverCmp("0.1.9", "0.1.10"), -1);
  assert.equal(semverCmp("1.0.0", "1.0.0"), 0);
  assert.equal(semverCmp("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(semverCmp("0.17.0-aiti.1", "0.17.0"), -1);
});

test("planUpdates: repo version behind the registry → local-stale, follow latest", () => {
  const rows = planUpdates(
    [{ pkg: "@x/a", version: "0.1.1" }],
    new Map([["@x/a", reg(["0.1.1"], "0.1.1")]]),
    new Map([["@x/a", "0.1.0"]]),
  );
  assert.equal(rows[0].status, "local-stale");
  assert.equal(rows[0].nextPin, "0.1.1");
});

test("planUpdates: no local copy → follow registry latest", () => {
  const rows = planUpdates(
    [{ pkg: "@x/a", version: "0.1.7" }],
    new Map([["@x/a", reg(["0.1.7", "0.1.9"], "0.1.9")]]),
    new Map(),
  );
  assert.equal(rows[0].status, "drift");
  assert.equal(rows[0].nextPin, "0.1.9");
});

test("planUpdates: registry lookup failure is reported, not silently ok", () => {
  const rows = planUpdates(
    [{ pkg: "@x/a", version: "1.0.0" }],
    new Map([["@x/a", { error: "boom", versions: new Set(), latest: null, tarballs: new Map() }]]),
    new Map(),
  );
  assert.equal(rows[0].status, "unknown");
});

test("findBrokenImports: dynamic import of an unpacked sibling is caught", () => {
  const files = [
    { path: "src/index.ts", text: 'export const a = 1;\n' },
    { path: "src/recognition.ts", text: 'await import("../lib/recognize.ts");\n' },
  ];
  const problems = findBrokenImports(files);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].spec, "../lib/recognize.ts");
});

test("findBrokenImports: packaged siblings, static imports and require all resolve", () => {
  const files = [
    { path: "src/index.ts", text: 'import { x } from "./ledger.ts";\nimport y from "./types";\nconst z = require("./loose.cjs");\nimport("../lib/recognize.ts");\n' },
    { path: "src/ledger.ts", text: "" },
    { path: "src/types.ts", text: "" },
    { path: "src/loose.cjs", text: "" },
    { path: "lib/recognize.ts", text: "" },
  ];
  assert.deepEqual(findBrokenImports(files), []);
});

test("findBrokenImports: bare package specifiers and binary files are ignored", () => {
  const files = [
    { path: "src/a.ts", text: 'import fs from "node:fs";\nimport x from "@scope/pkg";\n' },
    { path: "dist/bin.js", text: null },
  ];
  assert.deepEqual(findBrokenImports(files), []);
});
