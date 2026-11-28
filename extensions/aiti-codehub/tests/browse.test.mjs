import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gh from "../providers/github/api.ts";
import * as gitee from "../providers/gitee/api.ts";
import * as gl from "../providers/gitlab/api.ts";
import * as yx from "../providers/yunxiao/api.ts";
import { findLocalClone, normalizeRemote } from "../server/local.ts";
import { issueBlobToken, resolveBlobToken } from "../server/blob-tokens.ts";

const repo = (provider) => ({
  github: { id: "o/r", name: "r", path: "o/r", defaultBranch: "main" },
  gitee: { id: "o/r", name: "r", path: "o/r", defaultBranch: "master" },
  gitlab: { id: "g/p", name: "p", path: "g/p", defaultBranch: "main" },
  yunxiao: { id: "123", name: "r", path: "g/r", defaultBranch: "master" },
}[provider]);

function fakeHttp(routes) {
  return {
    baseUrl: "https://api.example.com",
    async req(path) { return { data: routes[path], status: 200, headers: new Headers() }; },
    async json(path) { return routes[path]; },
  };
}

test("github tree/file/commits/commit mapping", async () => {
  const http = fakeHttp({
    "/repos/o/r/contents": [{ name: "src", path: "src", type: "dir" }, { name: "a.ts", path: "a.ts", type: "file", size: 10 }],
    "/repos/o/r/contents/a.ts": { name: "a.ts", path: "a.ts", size: 10, content: Buffer.from("hi").toString("base64") + "\n" },
    "/repos/o/r/commits": [{ sha: "abcdef1234", commit: { message: "fix\nbody", author: { name: "a", date: "2026-01-01" } }, parents: [{ sha: "p1" }] }],
    "/repos/o/r/commits/abcdef1234": { sha: "abcdef1234", commit: { message: "fix", author: { name: "a", date: "2026-01-01" } }, stats: { additions: 1, deletions: 0, total: 1 }, files: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+hi" }] },
  });
  assert.equal((await gh.listTree({ token: "t" }, repo("github"), { path: "" }, http))[0].type, "dir");
  const f = await gh.getFile({ token: "t" }, repo("github"), { path: "a.ts" }, http);
  assert.equal(Buffer.from(f.content, "base64").toString(), "hi");
  const c = await gh.listCommits({ token: "t" }, repo("github"), {}, http);
  assert.equal(c.items[0].shortSha, "abcdef1");
  assert.deepEqual(c.items[0].parents, ["p1"]);
  const d = await gh.getCommit({ token: "t" }, repo("github"), { sha: "abcdef1234" }, http);
  assert.equal(d.files[0].path, "a.ts");
  assert.match(d.files[0].patch, /\+hi/);
  assert.equal(d.stats.total, 1);
});

test("gitee tree/file/commits/commit mapping", async () => {
  const http = fakeHttp({
    "/repos/o/r/contents": [{ name: "a", path: "a", type: "file", size: 3 }],
    "/repos/o/r/contents/a": { name: "a", size: 3, content: Buffer.from("hey").toString("base64") },
    "/repos/o/r/commits": [{ sha: "abc1234", commit: { message: "m", author: { name: "a", date: "2026-01-01" } } }],
    "/repos/o/r/commits/abc1234": { sha: "abc1234", commit: { message: "m", author: { name: "a", date: "2026-01-01" } }, files: [{ filename: "a", status: "added", additions: 1, deletions: 0, patch: "+x" }] },
  });
  assert.equal((await gitee.listTree({ token: "t" }, repo("gitee"), {}, http))[0].name, "a");
  assert.equal(Buffer.from((await gitee.getFile({ token: "t" }, repo("gitee"), { path: "a" }, http)).content, "base64").toString(), "hey");
  assert.equal((await gitee.listCommits({ token: "t" }, repo("gitee"), {}, http)).items[0].sha, "abc1234");
  assert.equal((await gitee.getCommit({ token: "t" }, repo("gitee"), { sha: "abc1234" }, http)).files[0].status, "added");
});

test("gitlab tree/file/commits/commit diff mapping", async () => {
  const http = fakeHttp({
    "/projects/g%2Fp/repository/tree": [{ name: "a", path: "a", type: "blob" }, { name: "d", path: "d", type: "tree" }],
    "/projects/g%2Fp/repository/files/a": { file_path: "a", size: 3, encoding: "base64", content: Buffer.from("hey").toString("base64") },
    "/projects/g%2Fp/repository/commits": [{ id: "abcdef123", short_id: "abcdef12", title: "t", message: "t", author_name: "a", authored_date: "2026-01-01" }],
    "/projects/g%2Fp/repository/commits/abcdef123": { id: "abcdef123", short_id: "abcdef12", title: "t", message: "t", author_name: "a", authored_date: "2026-01-01", stats: { additions: 1, deletions: 0, total: 1 } },
    "/projects/g%2Fp/repository/commits/abcdef123/diff": [{ old_path: "a", new_path: "a", new_file: false, deleted_file: false, renamed_file: false, diff: "@@ -1 +1 @@\n+hi" }],
  });
  assert.equal((await gl.listTree({ token: "t" }, repo("gitlab"), {}, http))[1].type, "dir");
  assert.equal(Buffer.from((await gl.getFile({ token: "t" }, repo("gitlab"), { path: "a" }, http)).content, "base64").toString(), "hey");
  assert.equal((await gl.listCommits({ token: "t" }, repo("gitlab"), {}, http)).items[0].shortSha, "abcdef12");
  const d = await gl.getCommit({ token: "t" }, repo("gitlab"), { sha: "abcdef123" }, http);
  assert.equal(d.files[0].path, "a");
  assert.match(d.files[0].patch, /\+hi/);
});

test("yunxiao tree/file/commits/commit+compare mapping", async () => {
  const http = fakeHttp({
    "/oapi/v1/codeup/organizations/o1/repositories/123/files/tree": [{ name: "src", path: "src", type: "tree" }, { name: "a", path: "a", type: "blob" }],
    "/oapi/v1/codeup/organizations/o1/repositories/123/files/a": { content: Buffer.from("hi").toString("base64"), size: 2, fileName: "a.txt" },
    "/oapi/v1/codeup/organizations/o1/repositories/123/commits": [{ id: "abcdef123", shortId: "abcdef12", title: "t", message: "t", authorName: "a", authoredDate: "2026-01-01", parentIds: ["p1"] }],
    "/oapi/v1/codeup/organizations/o1/repositories/123/commits/abcdef123": { id: "abcdef123", shortId: "abcdef12", title: "t", message: "t", authorName: "a", authoredDate: "2026-01-01", parentIds: ["p1"], stats: { additions: 1, deletions: 0, total: 1 } },
    "/oapi/v1/codeup/organizations/o1/repositories/123/compares": { diffs: [{ oldPath: "a", newPath: "a", diff: "@@ -1 +1 @@\n+hi", newFile: false, deletedFile: false, renamedFile: false, isBinary: false }] },
  });
  const cfg = { orgId: "o1", token: "t" };
  assert.equal((await yx.listTree(cfg, repo("yunxiao"), {}, http))[0].type, "dir");
  assert.equal(Buffer.from((await yx.getFile(cfg, repo("yunxiao"), { path: "a" }, http)).content, "base64").toString(), "hi");
  assert.equal((await yx.listCommits(cfg, repo("yunxiao"), {}, http)).items[0].shortSha, "abcdef12");
  const d = await yx.getCommit(cfg, repo("yunxiao"), { sha: "abcdef123" }, http);
  assert.equal(d.files[0].path, "a");
  assert.match(d.files[0].patch, /\+hi/);
});

test("yunxiao repo displayPath strips the org id", async () => {
  const http = fakeHttp({
    "/oapi/v1/codeup/organizations/o1/repositories": [{ id: 1, name: "r", pathWithNamespace: "o1/g/r", webUrl: "https://codeup.aliyun.com/o1/g/r" }],
  });
  const page = await yx.listRepos({ orgId: "o1", token: "t" }, undefined, {}, http);
  assert.equal(page.items[0].path, "o1/g/r");
  assert.equal(page.items[0].displayPath, "g/r");
});

test("local remote normalization + scan", () => {
  assert.equal(normalizeRemote("git@github.com:o/r.git"), "github.com/o/r");
  assert.equal(normalizeRemote("https://github.com/o/r.git"), "github.com/o/r");
  const root = mkdtempSync(join(tmpdir(), "codehub-local-"));
  try {
    const dir = join(root, "repo");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:o/r.git\n');
    const hit = findLocalClone({ repo: { cloneSsh: "git@github.com:o/r.git", path: "o/r" }, roots: [root] });
    assert.equal(hit.found, true);
    assert.equal(hit.path, dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blob tokens are opaque, one-shot lookup with TTL", () => {
  const t = issueBlobToken({ provider: "github", repo: repo("github"), ref: "main", path: "a/b.txt", download: true });
  assert.ok(t.token.length > 20);
  assert.ok(!t.token.includes("a/b"));
  const target = resolveBlobToken(t.token);
  assert.equal(target.path, "a/b.txt");
  assert.equal(resolveBlobToken("nope"), undefined);
});
