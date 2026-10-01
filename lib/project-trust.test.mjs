import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getProjectTrustStatus,
  mayReadProjectConfigNow,
  projectTrustReloadOptions,
  trustProject,
} = await jiti.import("./project-trust.ts");

async function createProjectFixture(t) {
  // Real paths: trust.json keys folders by them, and the temp folder is a link on macOS.
  const root = realpathSync(await mkdtemp(join(tmpdir(), "pi-web-project-trust-")));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, agentDir };
}

test("clean projects stay on the normal trusted load path", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: false,
    trusted: true,
    decision: null,
    inherited: false,
  });
  assert.equal(projectTrustReloadOptions(cwd, agentDir), undefined);
});

test("project extensions execute only after the project is trusted", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  const extensionDir = join(cwd, ".pi", "extensions");
  const marker = join(root, "extension-executed");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "probe.js"),
    `import { writeFileSync } from "node:fs";\nexport default () => { writeFileSync(${JSON.stringify(marker)}, "executed"); };\n`,
  );

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: true,
    trusted: false,
    decision: null,
    inherited: false,
  });

  const restrictedLoader = new DefaultResourceLoader({ cwd, agentDir });
  await restrictedLoader.reload(projectTrustReloadOptions(cwd, agentDir));
  assert.equal(existsSync(marker), false);
  assert.equal(restrictedLoader.getExtensions().extensions.length, 0);

  assert.deepEqual(trustProject(cwd, agentDir), {
    requiresTrust: true,
    trusted: true,
    decision: true,
    decisionPath: cwd,
    inherited: false,
  });

  const trustedLoader = new DefaultResourceLoader({ cwd, agentDir });
  await trustedLoader.reload(projectTrustReloadOptions(cwd, agentDir));
  assert.equal(existsSync(marker), true);
  assert.equal(trustedLoader.getExtensions().extensions.length, 1);
});

test("trusting reports the decision it wrote, so a failed read afterwards cannot fail it", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "mcp.json"), "{}");
  const link = join(root, "linked-project");
  await symlink(cwd, link);

  // Every read after the one that checks the folder fails, as a lock held
  // past the store's wait would; the write itself still succeeds.
  const getEntry = ProjectTrustStore.prototype.getEntry;
  let reads = 0;
  ProjectTrustStore.prototype.getEntry = function (...args) {
    reads += 1;
    if (reads > 1) throw new Error("Lock file is already being held");
    return getEntry.apply(this, args);
  };
  t.after(() => {
    ProjectTrustStore.prototype.getEntry = getEntry;
  });
  assert.deepEqual(
    trustProject(link, agentDir),
    { requiresTrust: true, trusted: true, decision: true, decisionPath: cwd, inherited: false },
    "keyed by the real path, as the store writes it",
  );
  assert.equal(reads, 1, "the status was read once, before the write");
  ProjectTrustStore.prototype.getEntry = getEntry;
  assert.equal(new ProjectTrustStore(agentDir).get(cwd), true);
});

test("the reload resolver reads the latest persisted trust decision", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });

  const reloadOptions = projectTrustReloadOptions(cwd, agentDir);
  assert.ok(reloadOptions);
  assert.equal(await reloadOptions.resolveProjectTrust(), false);

  trustProject(cwd, agentDir);
  assert.equal(await reloadOptions.resolveProjectTrust(), true);
});

test("the status tells exact, inherited, refused and missing decisions apart", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  const store = new ProjectTrustStore(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "mcp.json"), "{}");
  const status = () => getProjectTrustStatus(cwd, agentDir);

  assert.deepEqual(status(), { requiresTrust: true, trusted: false, decision: null, inherited: false });
  store.set(cwd, true);
  assert.deepEqual(status(), { requiresTrust: true, trusted: true, decision: true, decisionPath: cwd, inherited: false });
  store.set(cwd, false);
  assert.deepEqual(status(), { requiresTrust: true, trusted: false, decision: false, decisionPath: cwd, inherited: false });
  store.set(cwd, null);
  store.set(root, true);
  assert.deepEqual(status(), { requiresTrust: true, trusted: true, decision: true, decisionPath: root, inherited: true });
  store.set(root, false);
  assert.deepEqual(status(), { requiresTrust: true, trusted: false, decision: false, decisionPath: root, inherited: true });
  store.set(root, true);
  store.set(cwd, false);
  assert.deepEqual(
    status(),
    { requiresTrust: true, trusted: false, decision: false, decisionPath: cwd, inherited: false },
    "an exact false beneath a trusted parent",
  );
});

test("a folder that requires no trust still reports the decision it would inherit", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  const store = new ProjectTrustStore(agentDir);
  store.set(root, true);
  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: false,
    trusted: true,
    decision: true,
    decisionPath: root,
    inherited: true,
  });
  store.set(root, false);
  assert.equal(getProjectTrustStatus(cwd, agentDir).decision, false, "trusted stays true: nothing needs trust yet");
  assert.equal(getProjectTrustStatus(cwd, agentDir).trusted, true);
});

test("a folder opened through a link is trusted exactly, as trust.json keys it by its real path", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  const link = join(root, "linked-project");
  await symlink(cwd, link);
  new ProjectTrustStore(agentDir).set(link, true);
  assert.deepEqual(getProjectTrustStatus(link, agentDir), {
    requiresTrust: true,
    trusted: true,
    decision: true,
    decisionPath: cwd,
    inherited: false,
  });
});

test("an unreadable trust store does not fail a folder that requires no trust", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await writeFile(join(agentDir, "trust.json"), "{ not json");
  const status = getProjectTrustStatus(cwd, agentDir);
  assert.equal(status.requiresTrust, false);
  assert.equal(status.trusted, true);
  assert.equal(status.decision, null);
  assert.match(status.decisionError, /trust\.json/);
  assert.equal(projectTrustReloadOptions(cwd, agentDir), undefined, "session start never reads the store for it");
});

test("the fresh trust read follows the folder's resources and every decision as it changes", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  const store = new ProjectTrustStore(agentDir);
  assert.equal(getProjectTrustStatus(cwd, agentDir).trusted, true, "a folder without project resources needs no trust");
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), false, "but has no project file to read, so none is read");
  store.set(root, true);
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), false, "not even under a trusted parent");
  store.set(root, null);

  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "mcp.json"), "{}");
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), false, "no decision yet");
  store.set(cwd, true);
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), true);
  store.set(cwd, false);
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), false);
  store.set(cwd, null);
  store.set(root, true);
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), true, "inherited from a trusted parent");
  store.set(cwd, false);
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), false, "an exact false beneath a trusted parent");
});

test("an unparsable trust store counts as untrusted, with one warning per error", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  new ProjectTrustStore(agentDir).set(cwd, true);
  await writeFile(join(agentDir, "trust.json"), "{ not json");
  const warn = t.mock.method(console, "warn", () => {});

  assert.equal(mayReadProjectConfigNow(cwd, agentDir), false);
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), false);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /cannot read project trust.*trust\.json/);
  assert.throws(() => getProjectTrustStatus(cwd, agentDir), /trust\.json/, "the status itself still reports the failure");
});

test("a trust store still locked by another process counts as untrusted, with one warning naming it", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  new ProjectTrustStore(agentDir).set(cwd, true);
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), true);
  // proper-lockfile's lock is a directory beside the file; a fresh one is never stale.
  await mkdir(join(agentDir, "trust.json.lock"));
  const warn = t.mock.method(console, "warn", () => {});

  const started = Date.now();
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), false);
  // The store retries synchronously before it gives up; this is what each locked read costs.
  assert.ok(Date.now() - started >= 150, `gave up after ${Date.now() - started} ms`);
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), false);
  assert.equal(warn.mock.callCount(), 1);
  // The lock error itself does not name the file.
  assert.ok(String(warn.mock.calls[0].arguments[0]).includes(join(agentDir, "trust.json")));

  await rm(join(agentDir, "trust.json.lock"), { recursive: true });
  assert.equal(mayReadProjectConfigNow(cwd, agentDir), true, "trusted again once the lock is gone");
});

test("all project resource loaders and reloads enforce project trust", async () => {
  const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const modelsSource = await readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8");
  const skillsSource = await readFile(new URL("./skills-service.ts", import.meta.url), "utf8");
  const skillsInstallSource = await readFile(new URL("../app/api/skills/install/route.ts", import.meta.url), "utf8");
  const pluginsSource = await readFile(new URL("../app/api/plugins/route.ts", import.meta.url), "utf8");

  assert.match(rpcSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(rpcSource, /projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(rpcSource, /resourceLoaderReloadOptions: trustReloadOptions/);
  assert.equal(
    Array.from(rpcSource.matchAll(/this\.syncProjectTrust\(\);\s*await this\.inner\.reload/g)).length,
    2,
  );

  assert.match(modelsSource, /projectTrustReloadOptions\(cwd, agentDir\)/);
  assert.match(modelsSource, /resourceLoaderReloadOptions: trustReloadOptions/);
  assert.match(skillsSource, /loader\.reload\(projectTrustReloadOptions\(cwd, agentDir\)\)/);
  assert.match(pluginsSource, /projectTrusted: projectTrust\.trusted/);
  assert.match(
    skillsInstallSource,
    /getProjectTrustStatus\(cwd, getAgentDir\(\)\)\.trusted/,
  );
  assert.equal(
    Array.from(pluginsSource.matchAll(/projectTrusted: projectTrust\.trusted/g)).length,
    2,
  );
  assert.match(pluginsSource, /scope === "project" && !projectTrust\.trusted/);
});

test("the trust API invalidates cached models and restricted runtimes", async () => {
  const source = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /trustProject\(result\.cwd, agentDir\)/);
  assert.match(source, /invalidateModelsCache\(\)/);
  assert.match(source, /destroyRpcSessionsForCwd\(result\.cwd\)/);
  assert.match(source, /hasBusyRpcSessionForCwd\(result\.cwd\)/);
  assert.match(rpcSource, /trackStartingSession\(sessionCwd\)/);
  assert.match(rpcSource, /realpathSync\(resolvedCwd\)/);
});
