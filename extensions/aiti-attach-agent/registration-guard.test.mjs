// Tests for the load-time duplicate-registration guard: pi must load the pi-web-bridge
// plugin (TUI /web bridge + aiti_* connector) through exactly one channel.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PI_PLUGIN_NAMES,
  checkDuplicateRegistration,
  defaultSettingsFiles,
  findPluginEntry,
  isGeneratedLegacyDir,
  npmSpecName,
  resolvePluginRoot,
} from "./registration-guard.mjs";

const MARKER = Symbol.for("aiti-ai/pi-web-bridge#registration");

beforeEach(() => {
  delete globalThis[MARKER];
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "pi-registration-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeSettings(dir, packages) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ packages }, null, 2));
  return file;
}

/** Create a plugin dir; `layout` puts the entry file in src/ (package) or dist/ (bundle). */
function writePlugin(dir, { name = "@aiti-ai/pi-web-bridge", private: isPrivate = false, layout = "src" } = {}) {
  mkdirSync(join(dir, layout), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, private: isPrivate, pi: { extensions: ["./a.ts"] } }, null, 2),
  );
  const entry = join(dir, layout, layout === "dist" ? "aiti-devtools-pi.js" : "pi-web-bridge.ts");
  writeFileSync(entry, "// entry\n");
  return { dir, entry, selfUrl: pathToFileURL(entry).href };
}

function npmInstall(agentDir, { name = "@aiti-ai/pi-web-bridge" } = {}) {
  const dir = join(agentDir, "npm", "node_modules", name);
  const pkg = writePlugin(dir, { name });
  return pkg;
}

test("npm specs: version suffix stripped, scoped name kept", () => {
  assert.equal(npmSpecName("npm:@aiti-ai/pi-web-bridge@0.1.2"), "@aiti-ai/pi-web-bridge");
  assert.equal(npmSpecName("npm:@aiti-ai/pi-web-bridge"), "@aiti-ai/pi-web-bridge");
  assert.equal(npmSpecName("npm:pi-web-bridge@1.0.0"), "pi-web-bridge");
  assert.equal(npmSpecName("npm:@aiti-ai/pi-subagents@0.89.0-aiti.1"), "@aiti-ai/pi-subagents");
  assert.ok(PI_PLUGIN_NAMES.has(npmSpecName("npm:@aiti-ai/pi-web-bridge@0.1.2")));
});

test("resolvePluginRoot finds the package root from src/, dist/ and unknown dirs", () => {
  const box = sandbox();
  try {
    const pkg = writePlugin(join(box.root, "pkg"));
    assert.equal(resolvePluginRoot(pkg.entry).dir, pkg.dir);
    const bundled = writePlugin(join(box.root, "bundled"), { layout: "dist" });
    assert.equal(resolvePluginRoot(bundled.entry).dir, bundled.dir);
    const loose = join(box.root, "loose");
    mkdirSync(loose, { recursive: true });
    const strayFile = join(loose, "x.ts");
    writeFileSync(strayFile, "// x\n");
    assert.equal(resolvePluginRoot(strayFile).dir, loose);
    assert.equal(resolvePluginRoot(strayFile).meta, null);
  } finally {
    box.cleanup();
  }
});

test("findPluginEntry: npm spec requires the installed package", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const settings = writeSettings(agentDir, ["npm:pi-mcp-adapter", "npm:@aiti-ai/pi-web-bridge@0.1.2"]);
    assert.equal(findPluginEntry({ settingsFiles: [settings], agentDir }), null, "not installed → stale entry ignored");
    npmInstall(agentDir);
    const hit = findPluginEntry({ settingsFiles: [settings], agentDir });
    assert.equal(hit?.source, "npm:@aiti-ai/pi-web-bridge@0.1.2");
    assert.equal(hit?.dir, null);
  } finally {
    box.cleanup();
  }
});

test("findPluginEntry: local path, relative paths, stale paths", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const pkg = writePlugin(join(box.root, "repo", "pi-plugins", "pi-web-bridge"));
    const settings = writeSettings(agentDir, [join(box.root, "gone"), pkg.dir]);
    assert.equal(findPluginEntry({ settingsFiles: [settings], agentDir })?.dir, pkg.dir);

    const projectDir = join(box.root, "project");
    const local = writePlugin(join(projectDir, "pi-web-bridge"));
    const files = defaultSettingsFiles({ agentDir, cwd: projectDir });
    assert.deepEqual(files, [join(agentDir, "settings.json"), join(projectDir, ".pi", "settings.json")]);
    writeSettings(join(projectDir, ".pi"), ["./pi-web-bridge"]);
    // agent scope comes first: the repo entry still wins while it is listed there
    assert.equal(findPluginEntry({ settingsFiles: files, agentDir })?.dir, pkg.dir);
    writeSettings(agentDir, []);
    const hit = findPluginEntry({ settingsFiles: files, agentDir });
    assert.equal(hit?.dir, local.dir);
    assert.equal(hit?.source, "./pi-web-bridge");
  } finally {
    box.cleanup();
  }
});

test("unrelated packages never count", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const other = writePlugin(join(box.root, "other"), { name: "@aiti-ai/pi-devtools-pi" });
    const settings = writeSettings(agentDir, [
      "npm:pi-mcp-adapter",
      "npm:@aiti-ai/pi-subagents@0.89.0-aiti.1",
      other.dir,
      join(box.root, "does-not-exist"),
    ]);
    assert.equal(findPluginEntry({ settingsFiles: [settings], agentDir }), null);
  } finally {
    box.cleanup();
  }
});

test("only the deploy-generated legacy dir is considered safe to remove", () => {
  const box = sandbox();
  try {
    const generated = writePlugin(join(box.root, "extensions", "pi-web-bridge"), { name: "pi-web-bridge", private: true });
    assert.equal(isGeneratedLegacyDir(generated.dir), true);
    const userOwned = writePlugin(join(box.root, "extensions", "my-ext"), { name: "my-ext" });
    assert.equal(isGeneratedLegacyDir(userOwned.dir), false);
    const published = writePlugin(join(box.root, "extensions", "copy"), { name: "@aiti-ai/pi-web-bridge" });
    assert.equal(isGeneratedLegacyDir(published.dir), false, "a real (non-private) package dir must never be moved");
    assert.equal(isGeneratedLegacyDir(join(box.root, "absent")), false);
  } finally {
    box.cleanup();
  }
});

test("registered package copy registers; a second copy stands down", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const repo = writePlugin(join(box.root, "repo", "pi-plugins", "pi-web-bridge"));
    const legacy = writePlugin(join(agentDir, "extensions", "pi-web-bridge"), { name: "pi-web-bridge", private: true });
    const settingsFiles = [writeSettings(agentDir, [repo.dir])];

    const winner = checkDuplicateRegistration({ selfUrl: repo.selfUrl, settingsFiles, agentDir, env: {} });
    assert.equal(winner.standDown, false);

    const loser = checkDuplicateRegistration({ selfUrl: legacy.selfUrl, settingsFiles, agentDir, env: {} });
    assert.equal(loser.standDown, true);
    assert.equal(loser.winner, repo.dir);
    assert.match(loser.reason, /registered as the pi package/);
  } finally {
    box.cleanup();
  }
});

test("settings order decides between two package copies (load order irrelevant)", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const first = writePlugin(join(box.root, "first"));
    const second = writePlugin(join(box.root, "second"));
    const settingsFiles = [writeSettings(agentDir, [first.dir, second.dir])];

    assert.equal(checkDuplicateRegistration({ selfUrl: second.selfUrl, settingsFiles, agentDir, env: {} }).standDown, true);
    assert.equal(checkDuplicateRegistration({ selfUrl: first.selfUrl, settingsFiles, agentDir, env: {} }).standDown, false);
  } finally {
    box.cleanup();
  }
});

test("npm-installed copy wins over a stray dir; repo copy stands down", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const installed = npmInstall(agentDir);
    const repo = writePlugin(join(box.root, "repo", "pi-plugins", "pi-web-bridge"));
    const settingsFiles = [writeSettings(agentDir, ["npm:@aiti-ai/pi-web-bridge@0.1.2"])];

    assert.equal(checkDuplicateRegistration({ selfUrl: installed.selfUrl, settingsFiles, agentDir, env: {} }).standDown, false);
    const loser = checkDuplicateRegistration({ selfUrl: repo.selfUrl, settingsFiles, agentDir, env: {} });
    assert.equal(loser.standDown, true);
    assert.match(loser.reason, /installed from npm/);
  } finally {
    box.cleanup();
  }
});

test("no settings entry: first loaded copy wins, a second copy stands down", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const a = writePlugin(join(agentDir, "extensions", "pi-web-bridge"), { name: "pi-web-bridge", private: true });
    const b = writePlugin(join(box.root, "elsewhere"));
    const settingsFiles = [writeSettings(agentDir, [])];

    assert.equal(checkDuplicateRegistration({ selfUrl: a.selfUrl, settingsFiles, agentDir, env: {} }).standDown, false);
    const second = checkDuplicateRegistration({ selfUrl: b.selfUrl, settingsFiles, agentDir, env: {} });
    assert.equal(second.standDown, true);
    assert.equal(second.winner, a.dir);
    // same dir again (e.g. /reload) must stay allowed
    assert.equal(checkDuplicateRegistration({ selfUrl: a.selfUrl, settingsFiles, agentDir, env: {} }).standDown, false);
  } finally {
    box.cleanup();
  }
});

test("a standalone connector bundle (no own manifest) is never blocked by a package entry", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const repo = writePlugin(join(box.root, "repo", "pi-plugins", "pi-web-bridge"));
    // packages/aiti-devtools-pi/dist style copy: unrelated package.json, name not ours
    const standaloneDir = join(box.root, "repo", "packages", "aiti-devtools-pi");
    mkdirSync(join(standaloneDir, "dist"), { recursive: true });
    writeFileSync(join(standaloneDir, "package.json"), JSON.stringify({ name: "@aiti-ai/aiti-devtools-pi" }));
    const standaloneFile = join(standaloneDir, "dist", "aiti-devtools-pi.js");
    writeFileSync(standaloneFile, "// bundle\n");
    const settingsFiles = [writeSettings(agentDir, [repo.dir])];

    const r = checkDuplicateRegistration({
      selfUrl: pathToFileURL(standaloneFile).href,
      settingsFiles,
      agentDir,
      env: {},
    });
    assert.equal(r.standDown, false, "tools must never disappear because of a foreign manifest");
    assert.equal(r.selfDir, join(standaloneDir, "dist"));
  } finally {
    box.cleanup();
  }
});

test("marker still keeps a standalone bundle and a package copy to one registration", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const repo = writePlugin(join(box.root, "repo", "pi-plugins", "pi-web-bridge"));
    const standaloneDir = join(box.root, "repo", "packages", "aiti-devtools-pi");
    mkdirSync(join(standaloneDir, "dist"), { recursive: true });
    writeFileSync(join(standaloneDir, "package.json"), JSON.stringify({ name: "@aiti-ai/aiti-devtools-pi" }));
    const standaloneFile = join(standaloneDir, "dist", "aiti-devtools-pi.js");
    writeFileSync(standaloneFile, "// bundle\n");
    const settingsFiles = [writeSettings(agentDir, [repo.dir])];

    const first = checkDuplicateRegistration({ selfUrl: pathToFileURL(standaloneFile).href, settingsFiles, agentDir, env: {} });
    assert.equal(first.standDown, false);
    const second = checkDuplicateRegistration({ selfUrl: repo.selfUrl, settingsFiles, agentDir, env: {} });
    assert.equal(second.standDown, true, "the package copy defers to the already-registered bundle");
    assert.match(second.reason, /already loaded from/);
  } finally {
    box.cleanup();
  }
});

test("a dead owner directory does not block a later copy", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const gone = writePlugin(join(box.root, "gone"));
    const live = writePlugin(join(box.root, "live"));
    const settingsFiles = [writeSettings(agentDir, [])];
    globalThis[MARKER] = { dir: gone.dir };
    rmSync(gone.dir, { recursive: true, force: true });
    assert.equal(checkDuplicateRegistration({ selfUrl: live.selfUrl, settingsFiles, agentDir, env: {} }).standDown, false);
  } finally {
    box.cleanup();
  }
});

test("force env bypasses the guard", () => {
  const box = sandbox();
  try {
    const agentDir = join(box.root, "agent");
    const repo = writePlugin(join(box.root, "repo"));
    const legacy = writePlugin(join(agentDir, "extensions", "pi-web-bridge"), { name: "pi-web-bridge", private: true });
    const settingsFiles = [writeSettings(agentDir, [repo.dir])];
    for (const env of [{ AITI_PLUGIN_DUP_FORCE: "1" }, { AITI_PI_EXT_FORCE: "1" }]) {
      assert.equal(checkDuplicateRegistration({ selfUrl: legacy.selfUrl, settingsFiles, agentDir, env }).standDown, false);
    }
  } finally {
    box.cleanup();
  }
});
