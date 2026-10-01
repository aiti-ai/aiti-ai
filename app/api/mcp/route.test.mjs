import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const root = realpathSync(await mkdtemp(join(tmpdir(), "pi-web-mcp-route-")));
const agentDir = join(root, "agent");
const workspace = join(root, "workspace");
const cwd = join(workspace, "project");
const outside = join(root, "outside");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousDisable = process.env.PI_WEB_DISABLE_MCP;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_WEB_DISABLE_MCP;
await mkdir(agentDir, { recursive: true });
await mkdir(join(cwd, ".pi"), { recursive: true });
await mkdir(outside, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { GET } = await jiti.import("./route.ts");
allowFileRoot(cwd);

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousDisable === undefined) delete process.env.PI_WEB_DISABLE_MCP;
  else process.env.PI_WEB_DISABLE_MCP = previousDisable;
  await rm(root, { recursive: true, force: true });
});

const marker = join(root, "command-ran");
const globalPath = join(agentDir, "mcp.json");
const projectPath = join(cwd, ".pi", "mcp.json");
const settingsPath = join(agentDir, "settings.json");

await writeFile(globalPath, JSON.stringify({
  mcpServers: {
    docs: { url: "https://docs.example.com/mcp" },
    shared: { command: "global-shared" },
  },
}));
await writeFile(projectPath, JSON.stringify({
  mcpServers: {
    repo: { command: "node", args: ["server.js"], env: { TOKEN: `!touch ${marker}`, KEY: "literal-project-secret" } },
    shared: { command: "project-shared" },
  },
}));

async function get(query = "") {
  const response = await GET(new Request(`http://localhost/api/mcp${query}`, { headers: { host: "localhost" } }));
  return { status: response.status, body: await response.json() };
}

function forCwd(path = cwd) {
  return `?cwd=${encodeURIComponent(path)}`;
}

test("without a cwd only the global file is listed", async () => {
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.deepEqual(body.mcp, { available: true });
  assert.deepEqual(body.files.map((file) => [file.scope, file.path]), [["global", globalPath]]);
  assert.deepEqual(body.servers.map((server) => server.name), ["docs", "shared"]);
  assert.equal(body.project, undefined);
});

test("an untrusted project is listed with the command each entry would run, and nothing runs", async () => {
  const { status, body } = await get(forCwd());
  assert.equal(status, 200);
  assert.equal(body.project.cwd, cwd);
  assert.deepEqual(body.project.trust, { requiresTrust: true, trusted: false, decision: null, inherited: false });
  const repo = body.servers.find((server) => server.scope === "project" && server.name === "repo");
  assert.equal(repo.command, "node");
  assert.deepEqual(repo.args, ["server.js"]);
  assert.deepEqual(repo.envNames, ["TOKEN", "KEY"]);
  assert.deepEqual(repo.commandFields, [{ kind: "env", name: "TOKEN" }]);
  assert.equal(body.servers.find((server) => server.scope === "global" && server.name === "shared").shadowedByProject, true);
  assert.ok(!JSON.stringify(body).includes("literal-project-secret"));
  assert.equal(existsSync(marker), false, "the !command never ran");
  // Reading the OAuth state never goes through the SDK's store, which creates the file and a lock.
  assert.deepEqual((await readdir(agentDir)).sort(), ["mcp.json"]);
});

test("the project's trust is read fresh, exact or inherited", async (t) => {
  const store = new ProjectTrustStore(agentDir);
  t.after(() => {
    store.set(cwd, null);
    store.set(workspace, null);
  });
  store.set(cwd, true);
  assert.deepEqual((await get(forCwd())).body.project.trust, {
    requiresTrust: true,
    trusted: true,
    decision: true,
    decisionPath: cwd,
    inherited: false,
  });
  store.set(cwd, null);
  store.set(workspace, true);
  assert.deepEqual((await get(forCwd())).body.project.trust, {
    requiresTrust: true,
    trusted: true,
    decision: true,
    decisionPath: workspace,
    inherited: true,
  });
  store.set(cwd, false);
  assert.equal((await get(forCwd())).body.project.trust.trusted, false);
});

test("a cwd outside the allowed folders, relative, with .., or not a folder is refused", async () => {
  assert.deepEqual(await get(forCwd(outside)), { status: 403, body: { error: "Access denied", reason: "cwd-denied" } });
  assert.deepEqual(await get(forCwd(`${cwd}/../project`)), { status: 403, body: { error: "Access denied", reason: "cwd-denied" } });
  assert.deepEqual(await get("?cwd=project"), { status: 400, body: { error: "cwd must be an absolute path", reason: "cwd-invalid" } });
  assert.deepEqual(await get("?cwd="), { status: 400, body: { error: "cwd must be an absolute path", reason: "cwd-invalid" } });
  assert.deepEqual(await get(forCwd(projectPath)), { status: 400, body: { error: "cwd must be a directory", reason: "cwd-not-directory" } });
});

test("PI_WEB_DISABLE_MCP and -builtin:mcp turn MCP off with a reason, and the servers are still listed", async (t) => {
  t.after(async () => {
    delete process.env.PI_WEB_DISABLE_MCP;
    await rm(settingsPath, { force: true });
  });
  process.env.PI_WEB_DISABLE_MCP = "1";
  let { body } = await get();
  assert.deepEqual(body.mcp, { available: false, reason: "operator-disabled", error: "PI_WEB_DISABLE_MCP is set" });
  assert.deepEqual(body.servers.map((server) => server.name), ["docs", "shared"]);
  delete process.env.PI_WEB_DISABLE_MCP;

  await writeFile(settingsPath, JSON.stringify({ extensions: ["-builtin:mcp", "-builtin:codemode"] }));
  ({ body } = await get());
  assert.deepEqual(body.mcp, {
    available: false,
    reason: "builtin-disabled",
    error: "the extensions setting turns builtin:mcp off",
    settingsPath,
  });
  assert.equal(body.codemode.builtinDisabled, true);
  assert.equal(body.codemode.builtinSettingsPath, settingsPath);
});

test("Code mode reports the global preference and a self-test nobody has run yet", async (t) => {
  t.after(() => rm(settingsPath, { force: true }));
  let { body } = await get();
  assert.deepEqual(body.codemode, { sandbox: { state: "not-checked" }, builtinDisabled: false, preference: "automatic" });

  await writeFile(settingsPath, JSON.stringify({ defaultTools: ["+codemode"] }));
  ({ body } = await get());
  assert.equal(body.codemode.preference, "always");

  await writeFile(settingsPath, "{ not json");
  const response = await get();
  assert.equal(response.status, 200, "an unreadable settings file does not fail the listing");
  assert.equal(response.body.codemode.preference, undefined);
  assert.match(response.body.codemode.preferenceError, /JSON/);
  assert.deepEqual(response.body.servers.map((server) => server.name), ["docs", "shared"]);
});
