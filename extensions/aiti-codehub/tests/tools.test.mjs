import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTools } from "../server/tools.ts";
import { registry } from "../server/registry.ts";
import { getStore, shutdown, startup } from "../server/runtime.ts";

const root = mkdtempSync(join(tmpdir(), "codehub-tools-"));
startup({
  configDir: join(root, "config"),
  stateDir: join(root, "state"),
  cacheDir: join(root, "cache"),
  services: { provide: () => () => {}, get: () => undefined },
});

registry.register({
  id: "fake",
  label: "Fake",
  contract: 1,
  capabilities: { auth: ["pat"], clone: ["https"], workItems: { scope: "repo", filters: [], comments: true }, code: { namespaces: false, repos: true, branches: true, mergeRequests: false } },
  auth: { pat: { fields: [], validate: async () => ({ provider: "fake", userId: "u", username: "alice" }) } },
  httpFor: () => ({ baseUrl: "", req: async () => ({ data: {}, status: 200, headers: new Headers() }), json: async () => ({}) }),
  workItems: {
    listScopes: async () => ({ items: [], page: 1, pageSize: 50, hasMore: false }),
    list: async (_c, _h, scope) => ({ items: [{ id: "1", key: "1", title: "t", type: "Issue", status: "open", state: "open", tags: [], scope }], page: 1, pageSize: 50, hasMore: false }),
    get: async (_c, _h, scope, id) => ({ id, key: id, title: "t", type: "Issue", status: "open", state: "open", tags: [], scope }),
    comments: async () => [],
  },
  code: {
    listRepos: async () => ({ items: [], page: 1, pageSize: 50, hasMore: false }),
    listBranches: async () => ({ items: [], page: 1, pageSize: 50, hasMore: false }),
  },
});

function tool(name) {
  const t = agentTools({ sessionId: "s", cwd: "/tmp" }).find((x) => x.name === name);
  assert.ok(t, name + " is registered");
  return t;
}

getStore().saveProvider("fake", { authType: "pat", token: "t" });

test("providers tool lists platforms + configured accounts", async () => {
  const r = await tool("aiti_codehub_providers").execute("id", {});
  const data = JSON.parse(r.content[0].text);
  assert.ok(data.platforms.some((p) => p.platform === "fake"));
  const inst = data.instances.find((i) => i.id === "fake");
  assert.ok(inst);
  assert.equal(inst.configured, true);
  assert.equal(inst.platform, "fake");
});

test("workitems tool returns normalized items", async () => {
  const r = await tool("aiti_codehub_workitems").execute("id", { provider: "fake", scopeKind: "repo", scopeId: "o/r", scopeLabel: "o/r" });
  const data = JSON.parse(r.content[0].text);
  assert.equal(data.ok, true);
  assert.equal(data.items[0].key, "1");
});

test("write tools require confirm=true", async () => {
  const branch = await tool("aiti_codehub_branch_create").execute("id", { provider: "fake", scopeId: "o/r", id: "1" });
  assert.equal(branch.isError, true);
  const mr = await tool("aiti_codehub_mr_create").execute("id", { provider: "fake", repoPath: "o/r", sourceBranch: "a", targetBranch: "b", title: "t" });
  assert.equal(mr.isError, true);
});

test("account resolves to the instance and unknown accounts fail", async () => {
  const inst = getStore().createInstance("fake", "Work", { authType: "pat", token: "t" });
  const okRes = await tool("aiti_codehub_workitems").execute("id", { provider: "fake", account: "Work", scopeKind: "repo", scopeId: "o/r", scopeLabel: "o/r" });
  const okData = JSON.parse(okRes.content[0].text);
  assert.equal(okData.ok, true);

  const byId = await tool("aiti_codehub_workitems").execute("id", { provider: inst.id, scopeKind: "repo", scopeId: "o/r", scopeLabel: "o/r" });
  assert.equal(JSON.parse(byId.content[0].text).ok, true);

  const bad = await tool("aiti_codehub_workitems").execute("id", { provider: "fake", account: "nope", scopeKind: "repo", scopeId: "o/r" });
  const badData = JSON.parse(bad.content[0].text);
  assert.equal(badData.ok, false);
  assert.match(badData.error, /unknown account/);
});

test("cleanup", () => {
  shutdown();
  rmSync(root, { recursive: true, force: true });
});
