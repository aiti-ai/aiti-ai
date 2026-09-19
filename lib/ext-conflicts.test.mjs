/**
 * ext-conflicts -- tests for the generic "conflicting extension" disable mechanism.
 *
 * Semantics: extension manifests declare conflicts (npm package-name identifiers);
 * when assembling the SDK extension load result, any extension whose identifier
 * matches is removed entirely (never initialized). Scoped names (@scope/name) and
 * bare names (name) are distinct package names and never interfere with each other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { disableConflictingExtensions, sourcePackageName, pathScopedPackageName } from "./ext-conflicts.ts";

function fakeExt(path, source, tools = ["subagent"]) {
  return {
    path,
    resolvedPath: path,
    sourceInfo: { path, source, scope: "user", origin: "package", baseDir: "/x" },
    handlers: new Map(),
    tools: new Map(tools.map((name) => [name, { name }])),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

function fakeRegistry(...conflictLists) {
  return { all: () => conflictLists.map((conflicts) => ({ ext: { conflicts } })) };
}

const VANILLA = "/x/node_modules/pi-subagents/index.ts";
const FORK = "/x/node_modules/@aiti-ai/pi-subagents/index.ts";
const OTHER = "/y/other-pkg/index.ts";

test("sourcePackageName parses bare/scoped/versioned/protocol sources", () => {
  assert.equal(sourcePackageName("npm:pi-subagents"), "pi-subagents");
  assert.equal(sourcePackageName("npm:pi-subagents@0.58.0"), "pi-subagents");
  assert.equal(sourcePackageName("npm:@aiti-ai/pi-subagents@0.58.0-aiti.6"), "@aiti-ai/pi-subagents");
  assert.equal(sourcePackageName("git:github.com/user/repo"), "github.com/user/repo");
  assert.equal(sourcePackageName(""), "");
});

test("pathScopedPackageName derives a scoped package name from a path", () => {
  assert.equal(pathScopedPackageName("/x/node_modules/@aiti-ai/pi-subagents/index.ts"), "@aiti-ai/pi-subagents");
  assert.equal(pathScopedPackageName("/x/node_modules/pi-subagents/index.ts"), null);
});

test("declared conflicts remove the vanilla package entirely (never initialized)", () => {
  const base = {
    extensions: [fakeExt(VANILLA, "npm:pi-subagents"), fakeExt(OTHER, "npm:other-pkg", ["read"])],
    errors: [],
    runtime: {},
  };
  const out = disableConflictingExtensions(base, fakeRegistry(["pi-subagents"]));
  assert.equal(out.extensions.length, 1);
  assert.equal(out.extensions[0].sourceInfo.source, "npm:other-pkg");
});

test("a scoped fork is not mistakenly disabled by a bare-name identifier", () => {
  const base = {
    extensions: [
      fakeExt(VANILLA, "npm:pi-subagents"),
      fakeExt(FORK, "npm:@aiti-ai/pi-subagents@0.58.0-aiti.6"),
    ],
    errors: [],
    runtime: {},
  };
  const out = disableConflictingExtensions(base, fakeRegistry(["pi-subagents"]));
  const paths = out.extensions.map((e) => e.path);
  assert.ok(!paths.includes(VANILLA), "vanilla gets disabled");
  assert.ok(paths.includes(FORK), "fork is kept (scoped package name ≠ bare name)");
});

test("path-scoped package names also participate in matching (local npm directory layout)", () => {
  const base = {
    extensions: [fakeExt(VANILLA, "")], // no source
    errors: [],
    runtime: {},
  };
  // VANILLA path has no scoped segment and no source -> no match (conservative, no false positives)
  const out = disableConflictingExtensions(base, fakeRegistry(["pi-subagents"]));
  assert.equal(out.extensions.length, 1);
  // Scoped-path scenario
  const base2 = {
    extensions: [fakeExt("/x/node_modules/@foo/pi-subagents/index.ts", "")],
    errors: [],
    runtime: {},
  };
  const out2 = disableConflictingExtensions(base2, fakeRegistry(["@foo/pi-subagents"]));
  assert.equal(out2.extensions.length, 0, "scoped path matches the identifier → removed");
});

test("no declarations / unavailable registry -> returned unchanged", () => {
  const base = { extensions: [fakeExt(VANILLA, "npm:pi-subagents")], errors: [], runtime: {} };
  assert.equal(disableConflictingExtensions(base, fakeRegistry()), base.extensions.length === 1 ? base : base);
  assert.equal(disableConflictingExtensions(base, undefined), base);
});

test("declarations from multiple extensions are deduplicated and merged", () => {
  const registry = {
    all: () => [
      { ext: { conflicts: ["pi-subagents"] } },
      { ext: { conflicts: ["pi-subagents", "other-conflicting-pkg"] } },
    ],
  };
  const base = {
    extensions: [fakeExt(VANILLA, "npm:pi-subagents"), fakeExt(OTHER, "npm:other-conflicting-pkg", ["read"])],
    errors: [],
    runtime: {},
  };
  const out = disableConflictingExtensions(base, registry);
  assert.equal(out.extensions.length, 0);
});
