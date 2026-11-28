import test from "node:test";
import assert from "node:assert/strict";
import * as gh from "../providers/github/api.ts";
import * as gitee from "../providers/gitee/api.ts";
import * as gl from "../providers/gitlab/api.ts";
import { BUILTIN_PROVIDERS } from "../providers/index.ts";
import { describeProvider } from "../server/contract.ts";

const headers = (h = {}) => new Headers(h);

function fakeHttp(routes, hdrs = {}) {
  const calls = [];
  const pick = (path) => {
    if (path in routes) return routes[path];
    for (const k of Object.keys(routes)) if (k.endsWith("*") && path.startsWith(k.slice(0, -1))) return routes[k];
    return undefined;
  };
  return {
    calls,
    baseUrl: "https://api.example.com",
    async req(path, opts) { calls.push({ path, opts }); return { data: pick(path), status: 200, headers: headers(hdrs) }; },
    async json(path, opts) { calls.push({ path, opts }); return pick(path); },
  };
}

/* ───────── GitHub ───────── */

const ghIssue = {
  id: 10, number: 7, title: "Bug: login", state: "open",
  user: { login: "bob" }, assignee: { login: "alice" }, labels: [{ name: "bug" }],
  body: "body", html_url: "https://github.com/o/r/issues/7",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
};
const ghPr = { id: 11, number: 8, title: "PR", state: "open", pull_request: {} };

test("github listWorkItems filters pull requests and maps fields", async () => {
  const http = fakeHttp({ "/repos/o/r/issues": [ghIssue, ghPr] }, { link: '<https://api.github.com/x?page=2>; rel="next"' });
  const page = await gh.listWorkItems({ token: "t" }, { kind: "repo", id: "o/r", label: "o/r" }, {}, { page: 1, pageSize: 50 }, http);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].key, "7");
  assert.equal(page.items[0].type, "Issue");
  assert.equal(page.items[0].descriptionFormat, "markdown");
  assert.equal(page.items[0].state, "open");
  assert.deepEqual(page.items[0].tags, ["bug"]);
  assert.equal(page.items[0].assignee, "alice");
  assert.equal(page.hasMore, true);
  assert.equal(http.calls[0].path, "/repos/o/r/issues");
});

test("github keyword search uses /search/issues", async () => {
  const http = fakeHttp({ "/search/issues": { total_count: 1, items: [ghIssue] } });
  const page = await gh.listWorkItems({ token: "t" }, { kind: "repo", id: "o/r", label: "o/r" }, { keyword: "login" }, {}, http);
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 1);
  assert.equal(http.calls[0].opts.query.q, "repo:o/r login");
});

test("github repos/branches/namespaces mapping", async () => {
  const repo = {
    full_name: "o/r", name: "r", owner: { login: "o" }, default_branch: "main",
    html_url: "https://github.com/o/r", ssh_url: "git@github.com:o/r.git", clone_url: "https://github.com/o/r.git",
    archived: false, updated_at: "2026-01-01T00:00:00Z",
  };
  const http = fakeHttp({
    "/user": { login: "alice" },
    "/user/orgs": [{ login: "acme" }],
    "/user/repos": [repo],
    "/repos/o/r/branches": [{ name: "main", commit: { sha: "abcdef1234", message: "init" } }, { name: "dev" }],
  });
  const ns = await gh.listNamespaces({ token: "t" }, {}, http);
  assert.deepEqual(ns.items.map((n) => n.id), ["alice", "acme"]);
  const repos = await gh.listRepos({ token: "t" }, undefined, {}, http);
  assert.equal(repos.items[0].path, "o/r");
  assert.equal(repos.items[0].cloneSsh, "git@github.com:o/r.git");
  assert.equal(repos.items[0].namespace, "o");
  const branches = await gh.listBranches({ token: "t" }, repos.items[0], {}, http);
  assert.equal(branches.items[0].default, true);
  assert.equal(branches.items[0].commit.shortId, "abcdef1");
});

/* ───────── Gitee ───────── */

const giteeIssue = {
  id: 1, number: 3, title: "登录失败", state: "open",
  user: { login: "bob" }, assignee: { login: "alice" }, labels: [{ name: "bug" }],
  body: "x", html_url: "https://gitee.com/o/r/issues/3",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
};

test("gitee listWorkItems maps state/labels and filters keyword locally", async () => {
  const http = fakeHttp({ "/repos/o/r/issues": [giteeIssue, { ...giteeIssue, number: 4, title: "other" }] }, { total_count: "2" });
  const page = await gitee.listWorkItems({ token: "t" }, { kind: "repo", id: "o/r", label: "o/r" }, { keyword: "登录" }, {}, http);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].key, "3");
  assert.equal(page.items[0].id, "3");
  assert.equal(page.items[0].state, "open");
  assert.equal(page.total, 2);
  assert.equal(http.calls[0].opts.query.access_token, "t");
});

test("gitee issue number as string code stays a string (no #NaN)", async () => {
  /* real-world Gitee issues carry a string code ("I1Z9AB"-style) in `number`;
   * id/key must keep the code (get/comments key on it) and number stays undefined. */
  const http = fakeHttp({ "/repos/o/r/issues": [{ ...giteeIssue, id: 10423850, number: "I1Z9AB" }] }, { total_count: "1" });
  const page = await gitee.listWorkItems({ token: "t" }, { kind: "repo", id: "o/r", label: "o/r" }, {}, {}, http);
  const it = page.items[0];
  assert.equal(it.id, "I1Z9AB");
  assert.equal(it.key, "I1Z9AB");
  assert.equal(it.number, undefined);
  assert.notEqual(it.key, "NaN");
});

test("gitee repos derive clone URLs and map fields", async () => {
  const http = fakeHttp({
    "/user/repos": [{ id: 1, full_name: "o/r", name: "r", namespace: { path: "o" }, default_branch: "master", html_url: "https://gitee.com/o/r", description: "d" }],
  });
  const page = await gitee.listRepos({ token: "t" }, undefined, {}, http);
  assert.equal(page.items[0].path, "o/r");
  assert.equal(page.items[0].cloneHttp, "https://gitee.com/o/r.git");
  assert.equal(page.items[0].cloneSsh, "git@gitee.com:o/r.git");
  assert.equal(page.items[0].namespace, "o");
});

test("gitee branches mapping", async () => {
  const http = fakeHttp({ "/repos/o/r/branches": [{ name: "master", commit: { sha: "1234567890", message: "m" } }] });
  const page = await gitee.listBranches({ token: "t" }, { id: "o/r", name: "r", path: "o/r", defaultBranch: "master" }, {}, http);
  assert.equal(page.items[0].default, true);
  assert.equal(page.items[0].commit.shortId, "1234567");
});

/* ───────── GitLab ───────── */

const glIssue = {
  id: 1, iid: 5, title: "Bug", state: "opened",
  author: { username: "bob" }, assignee: { username: "alice" },
  labels: ["bug", "p0"], description: "d", web_url: "https://gitlab.com/g/p/-/issues/5",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
};

test("gitlab listWorkItems maps fields and pagination", async () => {
  const http = fakeHttp({ "/projects/g%2Fp/issues": [glIssue] }, { "x-total": "9", "x-total-pages": "2" });
  const page = await gl.listWorkItems({ token: "t" }, { kind: "repo", id: "g/p", label: "g/p" }, {}, { page: 1 }, http);
  assert.equal(page.items[0].key, "5");
  assert.equal(page.items[0].state, "open");
  assert.deepEqual(page.items[0].tags, ["bug", "p0"]);
  assert.equal(page.total, 9);
  assert.equal(page.hasMore, true);
  assert.equal(http.calls[0].path, "/projects/g%2Fp/issues");
});

test("gitlab repos and branches mapping (self-hosted base)", async () => {
  const http = fakeHttp({
    "/projects": [{
      id: 3, path_with_namespace: "g/p", name: "p", namespace: { full_path: "g" },
      default_branch: "main", web_url: "https://gitlab.example/g/p",
      ssh_url_to_repo: "git@gitlab.example:g/p.git", http_url_to_repo: "https://gitlab.example/g/p.git",
      last_activity_at: "2026-01-01T00:00:00Z",
    }],
    "/projects/3/repository/branches": [{ name: "main", default: true, commit: { id: "abcdef123", short_id: "abcdef12", title: "init" } }],
  });
  const page = await gl.listRepos({ token: "t", baseUrl: "https://gitlab.example" }, undefined, {}, http);
  assert.equal(page.items[0].id, "3");
  assert.equal(page.items[0].namespace, "g");
  assert.equal(page.items[0].cloneHttp, "https://gitlab.example/g/p.git");
  assert.equal(gl.webBase({ token: "t", baseUrl: "https://gitlab.example/api/v4" }), "https://gitlab.example");
  assert.equal(gl.apiBase({ baseUrl: "https://gitlab.example" }), "https://gitlab.example/api/v4");
  const branches = await gl.listBranches({ token: "t" }, page.items[0], {}, http);
  assert.equal(branches.items[0].default, true);
});

/* ───────── contract ───────── */

test("builtin providers expose a consistent contract", () => {
  const ids = BUILTIN_PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids, ["yunxiao", "github", "gitee", "gitlab"]);
  for (const p of BUILTIN_PROVIDERS) {
    assert.equal(p.contract, 1);
    assert.ok(p.capabilities.auth.includes("pat"), `${p.id} supports PAT`);
    assert.equal(typeof p.httpFor, "function");
    assert.ok(p.capabilities.workItems, `${p.id} has work items`);
    assert.ok(p.capabilities.code, `${p.id} has code`);
    for (const f of p.capabilities.workItems.filters) {
      assert.ok(["text", "multi", "user", "tags", "bool", "range"].includes(f.kind));
      if (f.kind === "multi") assert.ok(Array.isArray(f.options) && f.options.length > 0);
    }
    if (p.capabilities.code.mergeRequests === "write") assert.equal(typeof p.code.createMR, "function");
    const d = describeProvider(p);
    assert.equal(d.id, p.id);
    assert.equal(d.defaults.branch, "{type}_{id}");
    assert.ok(d.auth.pat.fields.length > 0);
    if (p.auth.oauth?.mode === "client-credentials") assert.ok(d.auth.oauth.clientFields.length >= 2);
    if (p.auth.oauth?.mode === "device-code") assert.ok(d.auth.oauth.clientFields.length >= 1);
  }
});
