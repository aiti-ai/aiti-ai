import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// shared-layer-heal — pure-fs unit tests with temp dirs as the fake repo /
// shared root. cwd is passed explicitly (no chdir), so no global state to reset.

const { healCandidate, syncSharedLayerFromRepo } = await import("./shared-layer-heal.ts");

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "smh-repo-"));
  mkdirSync(join(root, "extensions", "_shared"), { recursive: true });
  writeFileSync(
    join(root, "extensions", "_shared", "package.json"),
    JSON.stringify({ name: "@aiti-ai/ext-shared", version: "9.9.9" }),
  );
  writeFileSync(join(root, "extensions", "_shared", "agent-spawn-env.ts"), "export function newFn() { return 1; }\n");
  writeFileSync(join(root, "extensions", "_shared", "legacy.mjs"), "export const x = 2;\n");
  writeFileSync(join(root, "extensions", "_shared", "legacy.test.mjs"), "import { test } from 'node:test';\n");
  return root;
}

function makeSharedRoot(repoPkgVersion = "9.9.8") {
  const root = mkdtempSync(join(tmpdir(), "smh-root-"));
  const target = join(root, "node_modules", "@aiti-ai", "ext-shared");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "@aiti-ai/ext-shared", version: repoPkgVersion }));
  writeFileSync(join(target, "agent-spawn-env.ts"), "/* stale — no newFn */\n");
  return { root, target };
}

function wireRoots(repo, sharedRootDir) {
  // The heal derives the shared root from extensionsRoot()'s parent; point the
  // extensions root at a dir inside the fake shared root via the env the same
  // way deployments do (PI_WEB_EXTENSIONS_DIR).
  const extDir = join(sharedRootDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  process.env.PI_WEB_EXTENSIONS_DIR = extDir;
  return () => { delete process.env.PI_WEB_EXTENSIONS_DIR; };
}

test("healCandidate: matches module-graph failure patterns only", () => {
  const yes = new Map([
    ["aiti-qoder-agent", "(0 , _agentSpawnEnv.spawnFeatureI18nEn) is not a function"],
    ["aiti-zcode-agent", "Cannot find module './qoder-ide-source.ts'"],
    ["x", "Cannot find module '../shared/thing.mjs'"],
  ]);
  assert.equal(healCandidate(yes), true);
  const no = new Map([
    ["my-ext", "TypeError: wrapper.start is not a function"],
    ["other", "SyntaxError: unexpected token"],
    ["third", "entry id \"x\" does not match directory name"],
  ]);
  assert.equal(healCandidate(no), false);
  assert.equal(healCandidate(new Map()), false);
});

test("syncSharedLayerFromRepo: copies code files over the shared root, skips tests and package.json", () => {
  const repo = makeRepo();
  const { root, target } = makeSharedRoot();
  const unwire = wireRoots(repo, root);
  try {
    const copied = syncSharedLayerFromRepo(repo);
    assert.equal(copied, 2, "two code files (.ts + .mjs); the .test.mjs must not move");
    assert.equal(readFileSync(join(target, "agent-spawn-env.ts"), "utf8"), "export function newFn() { return 1; }\n");
    assert.equal(readFileSync(join(target, "legacy.mjs"), "utf8"), "export const x = 2;\n");
    assert.equal(existsSync(join(target, "legacy.test.mjs")), false, "tests are never copied");
    assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version, "9.9.8", "package.json stays npm-owned");
  } finally {
    unwire();
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncSharedLayerFromRepo: 0 without a repo checkout (install form)", () => {
  const bare = mkdtempSync(join(tmpdir(), "smh-bare-"));
  const { root } = makeSharedRoot();
  const unwire = wireRoots(bare, root);
  try {
    assert.equal(syncSharedLayerFromRepo(bare), 0);
  } finally {
    unwire();
    rmSync(bare, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncSharedLayerFromRepo: 0 when the shared root has no installed copy", () => {
  const repo = makeRepo();
  const root = mkdtempSync(join(tmpdir(), "smh-empty-"));
  const unwire = wireRoots(repo, root);
  try {
    assert.equal(syncSharedLayerFromRepo(repo), 0);
  } finally {
    unwire();
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncSharedLayerFromRepo: 0 when the repo _shared package name mismatches", () => {
  const repo = mkdtempSync(join(tmpdir(), "smh-mismatch-"));
  mkdirSync(join(repo, "extensions", "_shared"), { recursive: true });
  writeFileSync(join(repo, "extensions", "_shared", "package.json"), JSON.stringify({ name: "something-else" }));
  writeFileSync(join(repo, "extensions", "_shared", "evil.ts"), "export {}\n");
  const { root } = makeSharedRoot();
  const unwire = wireRoots(repo, root);
  try {
    assert.equal(syncSharedLayerFromRepo(repo), 0);
  } finally {
    unwire();
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
