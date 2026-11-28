import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "../server/routes.ts";
import { registry } from "../server/registry.ts";
import { shutdown, startup } from "../server/runtime.ts";

const root = mkdtempSync(join(tmpdir(), "codehub-routes-"));
startup({
  configDir: join(root, "config"),
  stateDir: join(root, "state"),
  cacheDir: join(root, "cache"),
  services: { provide: () => () => {}, get: () => undefined },
});

const fakeProvider = {
  id: "fake",
  label: "Fake",
  contract: 1,
  capabilities: {
    auth: ["pat"],
    clone: ["https"],
    workItems: { scope: "repo", comments: true, filters: [{ key: "keyword", kind: "text" }] },
    code: { namespaces: false, repos: true, branches: false, mergeRequests: false },
  },
  auth: {
    pat: {
      fields: [{ key: "token", label: "Token", kind: "password", required: true }],
      validate: async () => ({ provider: "fake", userId: "u", username: "alice", extra: { orgId: "org9" } }),
    },
  },
  httpFor: () => ({ baseUrl: "", req: async () => ({ data: {}, status: 200, headers: new Headers() }), json: async () => ({}) }),
  workItems: {
    listScopes: async () => ({ items: [{ id: "o/r", name: "o/r", path: "o/r" }], page: 1, pageSize: 50, hasMore: false }),
    list: async (_cfg, _http, scope) => ({
      items: [{ id: "1", key: "1", title: "t", type: "Issue", status: "open", state: "open", tags: [], scope }],
      page: 1,
      pageSize: 50,
      total: 1,
      hasMore: false,
    }),
    get: async (_cfg, _http, scope, id) => ({ id, key: id, title: "t", type: "Issue", status: "open", state: "open", tags: [], scope }),
    comments: async () => [{ id: "c", body: "hi" }],
  },
  code: {
    listRepos: async () => ({ items: [{ id: "o/r", name: "r", path: "o/r" }], page: 1, pageSize: 50, hasMore: false }),
    listBranches: async () => ({ items: [], page: 1, pageSize: 50, hasMore: false }),
    listTree: async () => [{ name: "src", path: "src", type: "dir" }, { name: "a.txt", path: "a.txt", type: "file", size: 2 }],
    getFile: async (_c, _h, _r, q) => ({ content: Buffer.from(q.path === "img.png" ? Buffer.from([0x89, 0x50, 0x4e, 0x47]) : "hi").toString("base64"), encoding: "base64", size: q.path === "img.png" ? 4 : 2 }),
    listCommits: async () => ({ items: [{ sha: "abcdef123", shortSha: "abcdef1", title: "t", message: "t" }], page: 1, pageSize: 30, hasMore: false }),
    getCommit: async () => ({ sha: "abcdef123", shortSha: "abcdef1", title: "t", message: "t", files: [{ path: "a.txt", status: "modified", patch: "+hi" }] }),
  },
};
registry.register(fakeProvider);

async function call(method, segments, query = {}, body) {
  const url = new URL("http://127.0.0.1:30142/api/extensions/aiti-codehub/" + segments.join("/"));
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await api(new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }), { path: segments, searchParams: url.searchParams });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

test("GET /config exposes providers and never the token", async () => {
  const { status, data } = await call("GET", ["config"]);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  const fake = data.providers.find((p) => p.id === "fake");
  assert.ok(fake);
  assert.equal(fake.status.hasToken, false);
  assert.equal(data.settings.fake.token, undefined);
  assert.equal(fake.redirectUris.default.includes("/aiti-codehub/oauth/fake"), true);
  assert.equal(typeof fake.redirectUris.default, "string");
});

test("POST /config saves a token and rejects unsafe baseUrl", async () => {
  const saved = await call("POST", ["config"], {}, { provider: "fake", config: { token: "tok", authType: "pat" } });
  assert.equal(saved.status, 200);
  const after = await call("GET", ["config"]);
  const fake = after.data.providers.find((p) => p.id === "fake");
  assert.equal(fake.status.hasToken, true);
  assert.equal(after.data.settings.fake.token, undefined);

  const bad = await call("POST", ["config"], {}, { provider: "fake", config: { baseUrl: "http://evil.example" } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /https/);
});

test("POST /auth/test validates and stores the account + discovered org", async () => {
  const { status, data } = await call("POST", ["auth", "test"], {}, { provider: "fake" });
  assert.equal(status, 200);
  assert.equal(data.account.username, "alice");
  assert.equal(data.orgId, "org9");
});

test("work items: scopes / list / detail / comments", async () => {
  const scopes = await call("GET", ["workitems", "scopes"], { provider: "fake" });
  assert.equal(scopes.status, 200);
  assert.equal(scopes.data.items[0].id, "o/r");

  const list = await call("GET", ["workitems"], { provider: "fake", scopeKind: "repo", scopeId: "o/r", scopeLabel: "o/r" });
  assert.equal(list.status, 200);
  assert.equal(list.data.items[0].key, "1");

  const detail = await call("GET", ["workitems", "1"], { provider: "fake", scopeKind: "repo", scopeId: "o/r", scopeLabel: "o/r" });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.item.id, "1");

  const comments = await call("GET", ["workitems", "1", "comments"], { provider: "fake", scopeKind: "repo", scopeId: "o/r", scopeLabel: "o/r" });
  assert.equal(comments.status, 200);
  assert.equal(comments.data.comments[0].body, "hi");

  const state = await call("GET", ["state"]);
  assert.equal(state.data.recents[0].id, "1");
  assert.equal(state.data.recents[0].scopeId, "o/r");
});

test("state: favorite + usage", async () => {
  const fav = await call("POST", ["state", "favorite"], {}, { provider: "fake", kind: "repos", id: "o/r" });
  assert.equal(fav.data.active, true);
  const usage = await call("POST", ["state", "usage"], {}, { provider: "fake", id: "1", kind: "ai" });
  assert.ok(usage.data.usage.sentToAIAt);
});

test("code: repos", async () => {
  const { status, data } = await call("GET", ["code", "repos"], { provider: "fake" });
  assert.equal(status, 200);
  assert.equal(data.items[0].path, "o/r");
});

test("unknown route / unknown provider", async () => {
  const missing = await call("GET", ["nope"]);
  assert.equal(missing.status, 404);
  const unknown = await call("GET", ["workitems", "scopes"], { provider: "nope" });
  assert.equal(unknown.status, 404);
});

const repoBody = { provider: "fake", repoId: "o/r", repoPath: "o/r", repoName: "r", ref: "main" };

test("code browse: tree / file text / commits / commit", async () => {
  const tree = await call("POST", ["code", "tree"], {}, repoBody);
  assert.equal(tree.status, 200);
  assert.equal(tree.data.entries[0].type, "dir");

  const file = await call("POST", ["code", "file"], {}, { ...repoBody, path: "a.txt" });
  assert.equal(file.status, 200);
  assert.equal(file.data.kind, "text");
  assert.equal(file.data.text, "hi");

  const commits = await call("POST", ["code", "commits"], {}, repoBody);
  assert.equal(commits.data.items[0].shortSha, "abcdef1");

  const commit = await call("POST", ["code", "commit"], {}, { ...repoBody, sha: "abcdef123" });
  assert.equal(commit.data.commit.files[0].path, "a.txt");
});

test("code browse: image blob token + stream; no path in URL", async () => {
  const file = await call("POST", ["code", "file"], {}, { ...repoBody, path: "img.png" });
  assert.equal(file.data.kind, "image");
  assert.ok(file.data.blobToken);
  assert.ok(!String(file.data.blobToken).includes("img"));
  const url = new URL("http://127.0.0.1:30142/code/blob/" + file.data.blobToken);
  const res = await api(new Request(url), { path: ["code", "blob", file.data.blobToken], searchParams: url.searchParams });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...buf], [0x89, 0x50, 0x4e, 0x47]);
});

test("code browse: download ticket", async () => {
  const t = await call("POST", ["code", "blob-ticket"], {}, { ...repoBody, path: "a.txt", items: [{ path: "a.txt", download: true }] });
  assert.equal(t.status, 200);
  assert.equal(t.data.items[0].download, true);
  assert.ok(t.data.items[0].token);
});

test("instances: create / list / per-instance config / rename / delete", async () => {
  const created = await call("POST", ["instances", "create"], {}, { platform: "fake", alias: "Work" });
  assert.equal(created.status, 200);
  const inst = created.data.created;
  assert.equal(inst.id, "fake~work");
  assert.equal(inst.platform, "fake");

  const cfg = await call("GET", ["config"]);
  const ids = cfg.data.instances.map((i) => i.id);
  assert.ok(ids.includes("fake") && ids.includes("fake~work"));
  const work = cfg.data.instances.find((i) => i.id === "fake~work");
  assert.equal(work.alias, "Work");
  assert.equal(work.status.hasToken, false);
  assert.ok(work.capabilities?.code, "instance view merges the platform descriptor");
  assert.equal(work.platformLabel, "Fake");
  assert.equal(work.redirectUris.default.includes("/aiti-codehub/oauth/fake"), true);
  assert.equal(work.redirectUris.default.includes("~"), false);

  // per-instance config: two files, two tokens, both redacted on read
  await call("POST", ["config"], {}, { provider: "fake~work", config: { token: "tok-work", authType: "pat" } });
  await call("POST", ["config"], {}, { provider: "fake", config: { token: "tok-default", authType: "pat" } });
  const after = await call("GET", ["config"]);
  const w = after.data.instances.find((i) => i.id === "fake~work");
  const d = after.data.instances.find((i) => i.id === "fake");
  assert.equal(w.status.hasToken, true);
  assert.equal(d.status.hasToken, true);
  assert.equal(after.data.settings["fake~work"].token, undefined);
  assert.equal(after.data.settings["fake"].token, undefined);

  const ren = await call("POST", ["instances", "rename"], {}, { instance: "fake~work", alias: "Work 2" });
  assert.equal(ren.data.renamed.alias, "Work 2");
  const dup = await call("POST", ["instances", "create"], {}, { platform: "fake", alias: "Work 2" });
  assert.equal(dup.status, 400); // alias conflict -> bad_request (HTTP 400 + message)

  // alias edits go through rename (uniqueness + aliasAuto=false), not a raw config patch
  const aliasSave = await call("POST", ["config"], {}, { provider: "fake", config: { alias: "工作号" } });
  const renamedDefault = aliasSave.data.instances.find((i) => i.id === "fake");
  assert.equal(renamedDefault.alias, "工作号");
  assert.equal(aliasSave.data.settings["fake"].token, undefined);

  const del = await call("POST", ["instances", "delete"], {}, { instance: "fake~work" });
  assert.equal(del.data.removed, true);
  const gone = await call("GET", ["config"]);
  assert.equal(gone.data.instances.some((i) => i.id === "fake~work"), false);
  const notFound = await call("GET", ["code", "repos"], { provider: "fake~work" });
  assert.equal(notFound.status, 404);
});

test("instances: unknown platform, bad alias and account resolution", async () => {
  const unknown = await call("POST", ["instances", "create"], {}, { platform: "nope", alias: "x" });
  assert.equal(unknown.status, 404);
  const created = await call("POST", ["instances", "create"], {}, { platform: "fake", alias: "个人" });
  assert.equal(created.status, 200);
  const id = created.data.created.id;
  assert.match(id, /^fake~inst-/);
  const viaAccount = await call("GET", ["code", "repos"], { provider: "fake", account: "个人" });
  assert.equal(viaAccount.status, 200);
  const missing = await call("GET", ["code", "repos"], { provider: "fake", account: "nope" });
  assert.equal(missing.status, 404);
  assert.equal((await call("POST", ["instances", "delete"], {}, { instance: id })).data.removed, true);
});

test("cleanup", () => {
  shutdown();
  rmSync(root, { recursive: true, force: true });
});
